import { spawnSync } from "node:child_process";
import { assertTmuxName, sessionName } from "./tmux-name.js";

/**
 * An internal, EXACT, OWNED tmux client built directly on argv-based `tmux` calls — no third-party
 * library. Every method targets tmux by EXACT identity (`=session`, exact pane ids), never a prefix
 * or substring. Loop sessions are tagged with IMMUTABLE ownership metadata (`@loop-*` user options)
 * that is verified before a session is adopted, captured, exposed, or killed, so a manually created
 * or stale predicted-name session is never adopted or destroyed.
 *
 * WHY NOT A THIRD-PARTY LIBRARY (evidence, 2026-07): the npm `tmux` package is a deprecated npm
 * placeholder ("no longer supported ... to avoid malicious use, npm is hanging on to the package
 * name"); `node-tmux` was last published 2022-05 (~38 downloads/week) and is a thin `spawn("tmux")`
 * wrapper. Neither offers what this slice actually needs — exact `=name` targeting, ownership
 * metadata, duplicate-race adoption, an injectable argv runner, and a private `-S` socket for
 * deterministic tests. A dependency would wrap the same argv calls we already own while adding
 * supply-chain surface to a component that is allowed to KILL sessions. We keep it in-tree.
 *
 * A PRIVATE socket (`-S <path>`) can be injected so tests run against their own tmux server and can
 * NEVER touch the user's default sessions. The argv runner is injectable for pure unit tests.
 */

export const LOOP_OWNER = "loop-orchestrator";

/** The immutable identity metadata every owned session carries. */
export type SessionIdentity = {
  namespace: string;
  project: string;
  run: string;
  /** "team" for the unified team session, or a specific role. */
  role: string;
  topology?: string;
};

export type TmuxResult = { status: number; stdout: string; stderr: string };
export type ArgvRunner = (args: string[], input?: string) => TmuxResult;

export type TmuxClientOptions = {
  /** A private `-S` socket path. Omit to use the default server. Tests ALWAYS pass one. */
  socket?: string;
  /** The `@loop-version` metadata stamp. */
  version?: string;
  /** Injectable argv runner (pure unit tests); defaults to spawning `tmux`. */
  runner?: ArgvRunner;
  /** How long an adopter waits for a concurrent creator to finish (ms). */
  adoptTimeoutMs?: number;
  /** Injectable sleep, so the duplicate-race retry is deterministic (and instant) in tests. */
  sleep?: (ms: number) => void;
  /**
   * Injectable terminal hand-over. The default REPLACES this process's stdio with tmux's, so it can
   * never be exercised by a unit test — tests inject a recorder and assert the exact argv instead.
   */
  attachImpl?: (argv: string[]) => number;
};

/**
 * ONE sentence for one condition. A foreign session is detected on two different paths — at plan time
 * (`loop tmux pre`) and mid-race (a session appears between the check and the create) — and a human
 * must not have to learn that those are the same problem from two different wordings.
 */
export function foreignSessionMessage(session: string): string {
  return `Refusing to use tmux session "${session}": it exists but is not a Loop-owned session (no @loop-owner metadata).`;
}

/** A session with the predicted name exists but is NOT a Loop-owned session. We refuse to adopt,
 *  reuse, or kill it. Carries its own exit-code identity so the CLI can report it precisely. */
export class TmuxConflictError extends Error {
  constructor(readonly session: string) {
    super(foreignSessionMessage(session));
    this.name = "TmuxConflictError";
  }
}

/** tmux is not installed, not reachable, or the viewport is disabled. */
export class TmuxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TmuxUnavailableError";
  }
}

const META_KEYS = ["owner", "namespace", "project", "run", "role", "version", "topology", "ready"] as const;
type MetaKey = (typeof META_KEYS)[number];
const metaOption = (key: MetaKey): string => `@loop-${key}`;

/** A pane to place in the unified team window. */
export type PaneSpec = { name: string; title: string };

export type EnsureOptions = {
  /** One pane per entry, tiled in a single window. Empty → one default pane. */
  panes?: PaneSpec[];
  /** Shell command for the session's first pane (role sessions). Omitted → the user's shell. */
  command?: string;
  width?: number;
  height?: number;
};

export type EnsureResult = {
  name: string;
  /** false when an already-owned session was adopted (idempotence). */
  created: boolean;
  /** role -> pane id. */
  panes: Record<string, string>;
};

export type OwnedSession = {
  name: string;
  id: SessionIdentity;
  /** Every pane in the session is dead (its process exited, `remain-on-exit`) — nothing left to watch. */
  dead: boolean;
  attached: boolean;
  windows: number;
};

/**
 * The complete tmux argv, including which SERVER it talks to.
 *
 * WITHOUT a socket this is bare `tmux <verb>` — the user's DEFAULT tmux server. That is a deliberate
 * interop contract, not an accident: the user's own tooling (`tpre show` → `tmux list-sessions`,
 * `tpre <session>` → `tmux new-session -A -s <session>`) talks to the default server, so Loop's
 * viewports must live there to be listable and attachable with the commands they already use. Moving
 * Loop to a private per-project socket by default would keep every test in this suite green (they all
 * inject their own socket) while making `tpre show` list NOTHING and `tpre <loop-session>` create a
 * new empty session instead of attaching. tests/tmux-compat.test.ts pins this.
 *
 * A private `-S` socket is for TESTS, which must never touch the developer's default server.
 */
export function tmuxArgv(socket: string | undefined, args: string[]): string[] {
  return socket ? ["-S", socket, ...args] : args;
}

function makeRunner(socket?: string): ArgvRunner {
  return (args, input) => {
    // argv-based: no shell is ever involved, so a hostile project/session/title string cannot become
    // a second command. `spawnSync` with an args ARRAY passes each element verbatim to execve.
    const r = spawnSync("tmux", tmuxArgv(socket, args), { input, encoding: "utf8" });
    // status null = tmux binary missing / killed by signal → treat as failure (fail closed).
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

/** Block for `ms` without a busy loop (spawnSync-based client is synchronous by design). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class TmuxClient {
  private run: ArgvRunner;
  private version: string;
  private adoptTimeoutMs: number;
  private sleep: (ms: number) => void;
  private attachImpl: (argv: string[]) => number;
  /** The private `-S` server this client talks to, or undefined for the user's DEFAULT tmux server
   *  (production). Exposed so the default-server interop contract is assertable — see tmuxArgv. */
  readonly socket: string | undefined;

  constructor(opts: TmuxClientOptions = {}) {
    const socket = opts.socket;
    this.socket = socket;
    this.run = opts.runner ?? makeRunner(socket);
    this.version = opts.version ?? "loop";
    this.adoptTimeoutMs = opts.adoptTimeoutMs ?? 3_000;
    this.sleep = opts.sleep ?? sleepSync;
    this.attachImpl = opts.attachImpl ?? ((argv) => spawnSync("tmux", tmuxArgv(socket, argv), { stdio: "inherit" }).status ?? 1);
  }

  /** The injective, tmux-safe session name for an identity. */
  sessionNameFor(id: SessionIdentity): string {
    return sessionName(id.namespace, id.project, id.run, id.role);
  }

  /** Whether the `tmux` binary is present and answers. Distinct from "no sessions". */
  installed(): boolean {
    return this.run(["-V"]).status === 0;
  }

  /** Whether tmux itself is reachable on this (possibly private) server. Distinguished from
   *  "no sessions": a missing server/binary returns false here; an empty server returns true. */
  serverReachable(): boolean {
    // `start-server` succeeds on an empty but reachable server and never errors on an existing one.
    return this.run(["start-server"]).status === 0;
  }

  /** EXACT `has-session -t =name`. Never a prefix/substring match. */
  hasSession(name: string): boolean {
    return this.run(["has-session", "-t", `=${name}`]).status === 0;
  }

  /**
   * Read one `@loop-*` metadata value from a session, or undefined if absent.
   *
   * `show-options`/`set-option`/`capture-pane` do NOT accept the `=name` exact-target prefix in tmux
   * 3.x (they treat it literally), so metadata + capture use the PLAIN session name. That is still an
   * exact identity: our session names are injective (a stable identity-hash suffix) AND contain no
   * tmux target metacharacter (no `.` or `:` — see tmux-name.ts), so a plain name can only resolve to
   * the one session it encodes.
   */
  private meta(name: string, key: MetaKey): string | undefined {
    const r = this.run(["show-options", "-v", "-t", name, metaOption(key)]);
    if (r.status !== 0) return undefined;
    const v = r.stdout.replace(/\n+$/, "");
    return v.length ? v : undefined;
  }

  /** The full identity recorded on a session, or undefined if it is not a valid owned Loop session. */
  identityOf(name: string): SessionIdentity | undefined {
    if (!this.hasSession(name)) return undefined;
    if (this.meta(name, "owner") !== LOOP_OWNER) return undefined; // not ours — never adopt
    const namespace = this.meta(name, "namespace");
    const project = this.meta(name, "project");
    const run = this.meta(name, "run");
    const role = this.meta(name, "role");
    if (!namespace || !project || !run || !role) return undefined; // incomplete metadata → not owned
    return { namespace, project, run, role, topology: this.meta(name, "topology") };
  }

  /** True only when `name` exists, is owner-tagged, and its metadata EXACTLY matches `id`. A stale
   *  predicted-name session (right name, no/wrong metadata) is NOT owned. */
  isOwned(id: SessionIdentity): boolean {
    const actual = this.identityOf(this.sessionNameFor(id));
    return Boolean(
      actual &&
        actual.namespace === id.namespace &&
        actual.project === id.project &&
        actual.run === id.run &&
        actual.role === id.role
    );
  }

  /** True once the creator has finished splitting/titling panes (`@loop-ready`). An adopter waits for
   *  this so it never reads a half-built pane map. */
  private isReady(name: string): boolean {
    return this.meta(name, "ready") === "1";
  }

  /**
   * Create — or idempotently ADOPT — the session for an identity, tagged with immutable ownership
   * metadata. Concurrency-safe:
   *
   *   - Creation and the FULL metadata stamp go out as ONE tmux command list, so a session can never
   *     be observed with the Loop name but no owner tag.
   *   - If a concurrent invocation won the race, `tmux new-session` fails with `duplicate session` and
   *     we RE-CHECK ownership (bounded) instead of failing: the loser adopts the winner's session.
   *     Two `loop tmux new` calls therefore converge on exactly ONE session, both exit 0.
   *   - A session at the predicted name that is NOT Loop-owned is REFUSED (TmuxConflictError), never
   *     adopted and never killed.
   */
  ensureSession(id: SessionIdentity, cwd: string, opts: EnsureOptions = {}): EnsureResult {
    const name = this.sessionNameFor(id);
    assertTmuxName(name);

    if (this.hasSession(name)) {
      if (!this.isOwned(id)) throw new TmuxConflictError(name);
      this.awaitReady(name);
      return { name, created: false, panes: this.panesByRole(name) };
    }

    const panes = opts.panes ?? [];
    const first = panes[0]?.name ?? id.role;
    const create = ["new-session", "-d", "-s", name, "-n", first, "-c", cwd];
    if (opts.width && opts.height) create.push("-x", String(opts.width), "-y", String(opts.height));
    if (opts.command) create.push(opts.command);

    // ONE command list: the session and its ownership stamp become visible together.
    const argv = [...create];
    for (const [key, value] of this.metaPairs(id)) argv.push(";", "set-option", "-t", name, metaOption(key), value);

    const r = this.run(argv);
    if (r.status !== 0) {
      if (/duplicate session/i.test(r.stderr)) {
        // Someone created it between our has-session check and here. If it is OURS, adopt it.
        if (this.awaitOwned(id)) {
          this.awaitReady(name);
          return { name, created: false, panes: this.panesByRole(name) };
        }
        throw new TmuxConflictError(name);
      }
      throw new Error(`tmux new-session failed: ${r.stderr.trim() || r.stdout.trim() || "unknown error"}`);
    }

    // PANE-target commands (`split-window`, `select-layout`) reject the `=name` exact-session prefix —
    // tmux reads it as a literal pane target and answers `can't find pane: =loop-…`. They take the
    // PLAIN name, which is still an exact identity: our names are injective and carry no `.`/`:`.
    for (let i = 1; i < panes.length; i++) {
      this.run(["split-window", "-t", name, "-c", cwd]);
      this.run(["select-layout", "-t", name, "tiled"]);
    }
    if (panes.length > 1) {
      this.run(["select-layout", "-t", name, "tiled"]);
      this.run(["set-option", "-t", name, "pane-border-status", "top"]);
      this.run(["set-option", "-t", name, "pane-border-format", " #{pane_title} "]);
    }
    const map = this.titlePanes(name, panes);
    // Published LAST: an adopter that sees `ready` sees a fully built pane map.
    this.run(["set-option", "-t", name, metaOption("ready"), "1"]);
    return { name, created: true, panes: map };
  }

  private metaPairs(id: SessionIdentity): Array<[MetaKey, string]> {
    const pairs: Array<[MetaKey, string]> = [
      ["owner", LOOP_OWNER],
      ["namespace", id.namespace],
      ["project", id.project],
      ["run", id.run],
      ["role", id.role],
      ["version", this.version]
    ];
    if (id.topology) pairs.push(["topology", id.topology]);
    return pairs;
  }

  /** Poll (bounded) for a concurrent creator's ownership stamp. */
  private awaitOwned(id: SessionIdentity): boolean {
    const deadline = this.adoptTimeoutMs;
    for (let waited = 0; ; waited += 50) {
      if (this.isOwned(id)) return true;
      if (waited >= deadline) return false;
      this.sleep(50);
    }
  }

  /** Poll (bounded) for a concurrent creator to finish building panes. Never fails: the viewport is
   *  observational, so a slow creator degrades to a best-effort pane map, not an error. */
  private awaitReady(name: string): void {
    for (let waited = 0; waited < this.adoptTimeoutMs; waited += 50) {
      if (this.isReady(name)) return;
      this.sleep(50);
    }
  }

  private titlePanes(name: string, panes: PaneSpec[]): Record<string, string> {
    if (!panes.length) return {};
    const ids = this.paneIds(name);
    const map: Record<string, string> = {};
    panes.forEach((pane, i) => {
      const paneId = ids[i];
      if (!paneId) return;
      map[pane.name] = paneId;
      this.run(["select-pane", "-t", paneId, "-T", paneTitleFor(pane)]);
    });
    return map;
  }

  private paneIds(name: string): string[] {
    const r = this.run(["list-panes", "-t", name, "-F", "#{pane_id}"]);
    if (r.status !== 0) return [];
    return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  }

  /**
   * role -> pane id, recovered from the pane titles WE set (`role · title`). A pane we never titled
   * carries tmux's default title — the HOSTNAME — so we require the `·` separator before believing a
   * title names a role. Without that check an untitled pane would register as a role called
   * "my-laptop.local", and the monitor would tail it as if it were an agent.
   */
  panesByRole(name: string): Record<string, string> {
    const r = this.run(["list-panes", "-t", name, "-F", "#{pane_id}\t#{pane_title}"]);
    if (r.status !== 0) return {};
    const map: Record<string, string> = {};
    for (const line of r.stdout.split("\n")) {
      const [paneId, title] = line.split("\t");
      if (!paneId?.startsWith("%") || !title?.includes(PANE_TITLE_SEP)) continue;
      const role = title.split(PANE_TITLE_SEP)[0].trim();
      if (role) map[role] = paneId.trim();
    }
    return map;
  }

  /** Every OWNED session on this server, with identity and liveness. Foreign sessions are skipped. */
  ownedSessions(): OwnedSession[] {
    const r = this.run(["list-sessions", "-F", "#{session_name}\t#{session_attached}\t#{session_windows}"]);
    if (r.status !== 0) return []; // no server / no sessions
    const out: OwnedSession[] = [];
    for (const line of r.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
      const [name, attached, windows] = line.split("\t");
      const id = this.identityOf(name);
      if (!id) continue; // foreign / unowned → never listed, never killed
      out.push({
        name,
        id,
        dead: this.allPanesDead(name),
        attached: attached === "1",
        windows: Number(windows) || 1
      });
    }
    return out;
  }

  /** True when the session exists and EVERY pane in it is dead (process exited under
   *  `remain-on-exit`). Such a session shows only a corpse — nothing is running in it. */
  allPanesDead(name: string): boolean {
    const r = this.run(["list-panes", "-s", "-t", name, "-F", "#{pane_dead}"]);
    if (r.status !== 0) return false;
    const flags = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    return flags.length > 0 && flags.every((f) => f === "1");
  }

  /**
   * Kill ONLY the owned sessions whose metadata EXACTLY matches this (namespace, project, run). A
   * foreign session, a different project/run, a hyphen-boundary decoy, or a stale predicted-name
   * session (no metadata) is left untouched. Returns the exact names killed.
   */
  stopRun(namespace: string, project: string, run: string): string[] {
    const killed: string[] = [];
    for (const { name, id } of this.ownedSessions()) {
      if (id.namespace === namespace && id.project === project && id.run === run) {
        if (this.killSession(name)) killed.push(name);
      }
    }
    return killed;
  }

  /** Kill one session by EXACT name. Returns false when it did not exist. */
  killSession(name: string): boolean {
    return this.run(["kill-session", "-t", `=${name}`]).status === 0;
  }

  /** Capture a pane by EXACT owned session target. Returns undefined when the target is not an owned
   *  Loop session (never screen-scrapes a foreign session). */
  capture(id: SessionIdentity, lines = 200): string | undefined {
    if (!this.isOwned(id)) return undefined;
    const name = this.sessionNameFor(id);
    // `capture-pane` uses the plain (injective, metacharacter-free) name — see `meta()`.
    const r = this.run(["capture-pane", "-p", "-t", name, "-S", `-${lines}`]);
    return r.status === 0 ? r.stdout : undefined;
  }

  /** Capture one pane by EXACT pane id (`%12`). Best-effort: empty string when it is gone. */
  capturePane(paneId: string, lines = 40): string {
    if (!/^%\d+$/.test(paneId)) return "";
    const r = this.run(["capture-pane", "-p", "-t", paneId, "-S", `-${lines}`]);
    return r.status === 0 ? r.stdout : "";
  }

  /** Reflect a short status line into a pane using DISPLAY APIs only (pane title + status line).
   *  We NEVER `send-keys` untrusted text, so a hostile title cannot execute anything. */
  displayInPane(paneId: string, text: string, opts: { title?: boolean } = {}): void {
    if (!/^%\d+$/.test(paneId) || !text) return;
    if (opts.title) this.run(["select-pane", "-t", paneId, "-T", text.slice(0, 60)]);
    this.run(["display-message", "-t", paneId, "-d", "1", text.slice(0, 200)]);
  }

  /**
   * The tmux argv that attaches THIS terminal to a session. Inside tmux, `attach-session` refuses to
   * nest, so we `switch-client` instead. Exported (rather than executed) so the plan can be shown by
   * `loop tmux pre` and asserted in tests without ever taking over a terminal.
   */
  attachArgv(name: string, insideTmux: boolean): string[] {
    return insideTmux ? ["switch-client", "-t", `=${name}`] : ["attach-session", "-t", `=${name}`];
  }

  /** Hand this terminal to tmux. Only ever called on a session we verified is OWNED. */
  attach(name: string, insideTmux: boolean): number {
    return this.attachImpl(this.attachArgv(name, insideTmux));
  }

  /** Tear down the entire private server (tests only — never call against the default server). */
  killServer(): void {
    this.run(["kill-server"]);
  }
}

const PANE_TITLE_SEP = "·";

/** `role · Title`, control-stripped and bounded — this string is a tmux DISPLAY value, never a shell word. */
export function paneTitleFor(pane: PaneSpec): string {
  return `${pane.name} ${PANE_TITLE_SEP} ${pane.title}`.slice(0, 80);
}

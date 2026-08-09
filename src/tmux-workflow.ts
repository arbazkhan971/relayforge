import { tmuxInstalled } from "./tmux.js";
import { foreignSessionMessage, OwnedSession, PaneSpec, SessionIdentity, TmuxClient, TmuxConflictError } from "./tmux-client.js";
import { sessionName } from "./tmux-name.js";
import { resolveRelayForgeEnvironment } from "./identity.js";

/**
 * The tmux USABILITY slice: a small, total, side-effect-explicit workflow over the owned TmuxClient.
 *
 *   loop tmux pre    → planViewport()   READ-ONLY. Says exactly what `new` would do, and why.
 *   loop tmux new    → openViewport()   Create-or-adopt (idempotent), then attach / switch / print.
 *   loop tmux show   → showViewport()   Owned sessions, liveness, panes, optional capture.
 *   loop tmux kill   → killViewport()   Kill only OWNED sessions for a run (or all of a project).
 *   loop tmux prune  → pruneViewport()  Reap dead + orphaned viewports (stale state), safely.
 *
 * Every function is PURE with respect to its inputs: the tmux boundary and the host facts are injected,
 * so the whole decision matrix (no tmux, viewport off, nested tmux, non-TTY, foreign collision, race)
 * is exercised deterministically in tests with a fake runner — no real tmux, no real terminal.
 */

/** Exit codes. Stable, documented, and scriptable — `loop tmux pre` returns the code `new` WOULD return. */
export const TmuxExit = {
  /** Done, or "would work". */
  OK: 0,
  /** Usage / unexpected tmux failure. */
  ERROR: 1,
  /** tmux is not installed, or the viewport is switched off. The loop still runs headless. */
  UNAVAILABLE: 2,
  /** The predicted session name is occupied by a session Loop does not own. We refuse to touch it. */
  CONFLICT: 3,
  /** Nothing to attach to / show. */
  NOT_FOUND: 4
} as const;
export type TmuxExitCode = (typeof TmuxExit)[keyof typeof TmuxExit];

/** The host facts that decide attach vs switch-client vs print-the-command. */
export type ViewportHost = {
  /** The `tmux` binary is on PATH. */
  installed: boolean;
  /** The viewport is switched on (config `defaults.viewport`, env `RELAYFORGE_TMUX` or legacy alias). */
  enabled: boolean;
  /** We are already inside a tmux client → `attach-session` would refuse to nest. */
  insideTmux: boolean;
  /** stdin+stdout are a terminal → we may legitimately hand this terminal to tmux. */
  interactive: boolean;
};

/**
 * The real host facts. `RELAYFORGE_TMUX=off` (legacy: `LOOP_TMUX=off`) can only ever DISABLE the viewport
 * turned off), so a test/CI environment can always guarantee "no tmux sessions" with one env var.
 * `interactive` requires BOTH stdin and stdout to be a TTY: `tmux attach` needs a real terminal, and
 * handing it a pipe fails with "open terminal failed" — we detect that instead of failing.
 */
export function detectHost(opts: { configEnabled?: boolean; env?: NodeJS.ProcessEnv; tty?: boolean } = {}): ViewportHost {
  const env = opts.env ?? process.env;
  const tty = opts.tty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return {
    installed: tmuxInstalled(),
    enabled: resolveRelayForgeEnvironment("TMUX", env) !== "off" && opts.configEnabled !== false,
    insideTmux: Boolean(env.TMUX),
    interactive: tty
  };
}

export type ViewportAction =
  /** Create the session, then take over this terminal. */
  | "create-and-attach"
  /** Adopt the existing owned session, then take over this terminal. */
  | "attach"
  /** Already inside tmux: point THIS client at the session instead of nesting. */
  | "switch-client"
  /** Created/adopted, but we must not seize the terminal (non-interactive, or --no-attach). */
  | "create-detached"
  /** Nothing can be done (no tmux, viewport off, or a foreign session holds the name). */
  | "blocked";

export type ViewportPlan = {
  /** Would `loop tmux new` succeed? */
  ok: boolean;
  /** The exit code `new` would produce. `pre` returns the same code, so scripts can gate on it. */
  code: TmuxExitCode;
  session: string;
  identity: SessionIdentity;
  roles: string[];
  cwd: string;
  /** What currently occupies the predicted name. */
  existing: "none" | "owned" | "foreign";
  action: ViewportAction;
  /** The EXACT tmux argv we would run to hand over the terminal (null when we would not attach). */
  attachArgv: string[] | null;
  /** The command a human can run themselves, when we cannot attach for them. */
  manualCommand: string | null;
  reason: string;
  hint?: string;
};

export type ViewportRequest = {
  identity: SessionIdentity;
  cwd: string;
  /** One tiled pane per role. */
  roles: PaneSpec[];
  /** Set false for `--no-attach` (create/adopt only). */
  attach?: boolean;
};

/** The same next step, whichever path found the foreign session. */
const conflictHint = (session: string): string =>
  `Loop never adopts or kills a session it did not create. Inspect it (tmux attach -t ${session}) and remove it yourself, or use a different --run id.`;

/**
 * READ-ONLY. Decide what `loop tmux new` would do, without touching a single tmux session. This is
 * `loop tmux pre`: the pre-flight. It issues only `has-session` / `show-options` — never `new-session`.
 */
export function planViewport(client: TmuxClient, host: ViewportHost, req: ViewportRequest): ViewportPlan {
  const { identity, cwd } = req;
  const roles = req.roles.map((r) => r.name);
  const session = sessionName(identity.namespace, identity.project, identity.run, identity.role);
  const wantAttach = req.attach !== false;
  const base = { session, identity, roles, cwd, attachArgv: null, manualCommand: null } as const;

  if (!host.installed) {
    return {
      ...base,
      ok: false,
      code: TmuxExit.UNAVAILABLE,
      existing: "none",
      action: "blocked",
      reason: "tmux is not installed on this host.",
      hint: "tmux is an OPTIONAL viewport — RelayForge runs fully headless without it. Install tmux (`brew install tmux` / `sudo apt-get install -y tmux`), or watch the run with `relayforge monitor`."
    };
  }
  if (!host.enabled) {
    return {
      ...base,
      ok: false,
      code: TmuxExit.UNAVAILABLE,
      existing: "none",
      action: "blocked",
      reason: "The tmux viewport is switched off (RELAYFORGE_TMUX=off, legacy LOOP_TMUX=off, or defaults.viewport: off).",
      hint: "Unset RELAYFORGE_TMUX/LOOP_TMUX (or set `defaults.viewport: on` in the selected config) to use the viewport. RelayForge runs headless either way."
    };
  }

  const owned = client.isOwned(identity);
  const exists = owned || client.hasSession(session);
  if (exists && !owned) {
    return {
      ...base,
      ok: false,
      code: TmuxExit.CONFLICT,
      existing: "foreign",
      action: "blocked",
      reason: foreignSessionMessage(session),
      hint: conflictHint(session)
    };
  }

  const manualCommand = `tmux attach -t ${session}`;
  if (!wantAttach) {
    return {
      ...base,
      ok: true,
      code: TmuxExit.OK,
      existing: owned ? "owned" : "none",
      action: "create-detached",
      manualCommand,
      reason: owned
        ? `Session "${session}" already exists and is Loop-owned; --no-attach leaves it detached.`
        : `Would create detached session "${session}" with ${roles.length} pane(s): ${roles.join(", ") || "(none)"}.`
    };
  }
  if (!host.interactive) {
    // Handing a non-TTY to `tmux attach` fails with "open terminal failed". Create/adopt and tell the
    // human the exact command instead — this is what makes `loop tmux new` safe to run from CI or a pipe.
    return {
      ...base,
      ok: true,
      code: TmuxExit.OK,
      existing: owned ? "owned" : "none",
      action: "create-detached",
      manualCommand,
      reason: "Not a terminal (piped or non-interactive), so the session is left detached rather than attached.",
      hint: `Attach from a terminal with: ${manualCommand}`
    };
  }

  const attachArgv = client.attachArgv(session, host.insideTmux);
  return {
    ...base,
    ok: true,
    code: TmuxExit.OK,
    existing: owned ? "owned" : "none",
    action: host.insideTmux ? "switch-client" : owned ? "attach" : "create-and-attach",
    attachArgv,
    manualCommand,
    reason: host.insideTmux
      ? `Already inside tmux — will switch THIS client to "${session}" (attach-session refuses to nest).`
      : owned
        ? `Session "${session}" already exists and is Loop-owned — will attach this terminal to it.`
        : `Will create "${session}" with ${roles.length} pane(s) and attach this terminal to it.`
  };
}

export type OpenResult = ViewportPlan & {
  /** false when an existing owned session was adopted — `loop tmux new` twice creates ONE session. */
  created: boolean;
  /** role -> pane id. */
  panes: Record<string, string>;
  /** Whether this call actually handed the terminal to tmux. */
  attached: boolean;
};

/**
 * `loop tmux new`: create-or-adopt (IDEMPOTENT), then attach / switch-client / leave detached exactly
 * as the plan says. Concurrency-safe — two simultaneous calls converge on ONE session (the loser of the
 * `new-session` race adopts the winner's session; see TmuxClient.ensureSession).
 */
export function openViewport(client: TmuxClient, host: ViewportHost, req: ViewportRequest): OpenResult {
  const plan = planViewport(client, host, req);
  if (!plan.ok) return { ...plan, created: false, panes: {}, attached: false };

  let created = false;
  let panes: Record<string, string> = {};
  try {
    const result = client.ensureSession(req.identity, req.cwd, { panes: req.roles, width: 220, height: 50 });
    created = result.created;
    panes = result.panes;
  } catch (error) {
    if (error instanceof TmuxConflictError) {
      // A foreign session appeared between the plan and the create (TOCTOU) — report it as a conflict,
      // never as a crash, and never adopt it.
      return {
        ...plan,
        ok: false,
        code: TmuxExit.CONFLICT,
        existing: "foreign",
        action: "blocked",
        attachArgv: null,
        reason: error.message,
        hint: conflictHint(plan.session),
        created: false,
        panes: {},
        attached: false
      };
    }
    return {
      ...plan,
      ok: false,
      code: TmuxExit.ERROR,
      action: "blocked",
      attachArgv: null,
      reason: error instanceof Error ? error.message : String(error),
      created: false,
      panes: {},
      attached: false
    };
  }

  if (!plan.attachArgv) return { ...plan, created, panes, attached: false };

  const status = client.attach(plan.session, host.insideTmux);
  return {
    ...plan,
    created,
    panes,
    attached: status === 0,
    code: status === 0 ? TmuxExit.OK : TmuxExit.ERROR,
    ok: status === 0
  };
}

export type SessionView = OwnedSession & {
  /** role -> pane id. */
  panes: Record<string, string>;
  /** The run has no state directory any more — the viewport outlived its run. */
  orphan: boolean;
  /** Captured pane output (only when requested). */
  capture?: string;
};

export type ShowRequest = {
  namespace: string;
  /** Filter to one project. */
  project?: string;
  /** Filter to one run. */
  run?: string;
  /** Capture this many lines from each listed session's active pane. */
  captureLines?: number;
  /** Runs that still have state on disk; anything else is an orphan viewport. Omit to skip the check. */
  knownRuns?: string[];
};

export type ShowReport = {
  ok: boolean;
  code: TmuxExitCode;
  sessions: SessionView[];
  reason?: string;
  hint?: string;
};

/** `loop tmux show`: the owned viewports, their liveness, their panes — and nothing that is not ours. */
export function showViewport(client: TmuxClient, host: ViewportHost, req: ShowRequest): ShowReport {
  if (!host.installed || !host.enabled) {
    return {
      ok: false,
      code: TmuxExit.UNAVAILABLE,
      sessions: [],
      reason: host.installed
        ? "The tmux viewport is switched off (RELAYFORGE_TMUX=off, legacy LOOP_TMUX=off, or defaults.viewport: off)."
        : "tmux is not installed on this host.",
      hint: "RelayForge runs fully headless — use `relayforge monitor` to watch a run without tmux."
    };
  }

  const known = req.knownRuns ? new Set(req.knownRuns) : undefined;
  const sessions = client
    .ownedSessions()
    .filter((s) => s.id.namespace === req.namespace)
    .filter((s) => !req.project || s.id.project === req.project)
    .filter((s) => !req.run || s.id.run === req.run)
    .map((s): SessionView => ({
      ...s,
      panes: client.panesByRole(s.name),
      orphan: known ? !known.has(s.id.run) : false,
      capture: req.captureLines ? client.capture(s.id, req.captureLines) : undefined
    }));

  if (!sessions.length) {
    return {
      ok: false,
      code: TmuxExit.NOT_FOUND,
      sessions: [],
      reason: req.run
        ? `No Loop-owned tmux session for run "${req.run}".`
        : "No Loop-owned tmux sessions are running.",
      hint: "Start one with `relayforge tmux new` (viewport only) or `relayforge run \"<goal>\" --execute`."
    };
  }
  return { ok: true, code: TmuxExit.OK, sessions };
}

export type KillRequest = {
  namespace: string;
  project: string;
  /** Kill this run's sessions. Omit with `all: true` to kill every owned session in the project. */
  run?: string;
  all?: boolean;
};

export type KillReport = { ok: boolean; code: TmuxExitCode; killed: string[]; reason?: string };

/** `loop tmux kill`: kill ONLY metadata-owned sessions. A foreign or stale predicted-name session is
 *  never touched, so this can never take down a session a human created by hand. */
export function killViewport(client: TmuxClient, host: ViewportHost, req: KillRequest): KillReport {
  if (!host.installed || !host.enabled) {
    return { ok: true, code: TmuxExit.OK, killed: [], reason: "tmux viewport unavailable — nothing to kill." };
  }
  if (!req.run && !req.all) {
    return { ok: false, code: TmuxExit.ERROR, killed: [], reason: "Pass --run <id> or --all." };
  }
  const killed = req.run
    ? client.stopRun(req.namespace, req.project, req.run)
    : client
        .ownedSessions()
        .filter((s) => s.id.namespace === req.namespace && s.id.project === req.project)
        .filter((s) => client.killSession(s.name))
        .map((s) => s.name);

  if (!killed.length) {
    return { ok: true, code: TmuxExit.OK, killed, reason: "No Loop-owned sessions matched — nothing killed." };
  }
  return { ok: true, code: TmuxExit.OK, killed };
}

export type PruneRequest = {
  namespace: string;
  project?: string;
  /** True while a run still has live state on disk. An owned viewport for anything else is stale. */
  isRunLive: (run: string) => boolean;
  /** Report what WOULD be pruned without killing anything. */
  dryRun?: boolean;
};

export type PruneCandidate = { session: string; run: string; reason: "dead-panes" | "orphaned-run" };
export type PruneReport = { ok: boolean; code: TmuxExitCode; pruned: PruneCandidate[]; kept: string[]; dryRun: boolean };

/**
 * `loop tmux prune`: reap STALE viewports — a session whose panes have all exited (nothing left to
 * watch), or whose run no longer has state on disk (the viewport outlived its run). Only ever kills
 * metadata-owned sessions, and `--dry-run` shows the exact list first.
 */
export function pruneViewport(client: TmuxClient, host: ViewportHost, req: PruneRequest): PruneReport {
  const dryRun = Boolean(req.dryRun);
  if (!host.installed || !host.enabled) return { ok: true, code: TmuxExit.OK, pruned: [], kept: [], dryRun };

  const pruned: PruneCandidate[] = [];
  const kept: string[] = [];
  for (const s of client.ownedSessions()) {
    if (s.id.namespace !== req.namespace) continue;
    if (req.project && s.id.project !== req.project) continue;
    const reason: PruneCandidate["reason"] | undefined = s.dead
      ? "dead-panes"
      : !req.isRunLive(s.id.run)
        ? "orphaned-run"
        : undefined;
    if (!reason) {
      kept.push(s.name);
      continue;
    }
    if (!dryRun && !client.killSession(s.name)) {
      kept.push(s.name); // the kill failed — report it as kept rather than claiming a prune we did not do
      continue;
    }
    pruned.push({ session: s.name, run: s.id.run, reason });
  }
  return { ok: true, code: TmuxExit.OK, pruned, kept, dryRun };
}

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { LoadedConfig } from "./config/load.js";
import { ProjectConfig, RoleConfig } from "./config/schema.js";
import { buildProviderCommand, commandToShell, shellQuote } from "./providers.js";
import { buildRolePrompt } from "./prompts.js";
import { writeStateFileDurable } from "./runtime.js";
import { PaneSpec, SessionIdentity, TmuxClient } from "./tmux-client.js";
import { isSafeTmuxName, sessionName } from "./tmux-name.js";

/**
 * The tmux VIEWPORT — optional, observational, and never load-bearing for run correctness.
 *
 * Every tmux call in the product goes through the ONE owned boundary (`TmuxClient`): exact `=name`
 * targets, `@loop-*` ownership metadata verified before adopt/capture/kill, argv-only (no shell), and
 * an injectable runner + private `-S` socket so tests never touch the user's tmux server.
 */

export { assertTmuxName, isSafeTmuxName, sessionName, TMUX_NAME_PATTERN } from "./tmux-name.js";
export type { SessionIdentity, OwnedSession, PaneSpec } from "./tmux-client.js";
export { TmuxClient, TmuxConflictError, TmuxUnavailableError, LOOP_OWNER } from "./tmux-client.js";

export type SessionInfo = {
  role: string;
  session: string;
  provider: string;
  promptFile: string;
  status: "started" | "exists" | "skipped";
};

let client: TmuxClient | undefined;

/**
 * The process-wide tmux client. `LOOP_TMUX_SOCKET` points it at a PRIVATE tmux server — which is how
 * the CLI smoke tests drive the real `loop tmux` commands end to end without ever creating a session
 * on the developer's default server.
 */
export function tmuxClient(): TmuxClient {
  if (!client) client = new TmuxClient({ socket: process.env.LOOP_TMUX_SOCKET || undefined });
  return client;
}

/** Test seam: install a fake/private client (and reset with `undefined`). */
export function setTmuxClientForTests(next: TmuxClient | undefined): void {
  client = next;
}

/**
 * Is the OPTIONAL viewport usable at all? `LOOP_TMUX=off` disables it (the test suite sets this so
 * runs never open real sessions), and it is off when tmux is not installed. It can never affect run
 * correctness or `done`.
 */
export function tmuxAvailable(): boolean {
  if (process.env.LOOP_TMUX === "off") return false;
  return tmuxClient().installed();
}

/** Are we running INSIDE a tmux client already? (Then `attach` must become `switch-client`.) */
export function insideTmux(): boolean {
  return Boolean(process.env.TMUX);
}

/** Every OWNED session for a namespace, by exact name. Metadata-gated: a foreign session that merely
 *  starts with `<namespace>-` is NEVER listed (the old prefix filter exposed exactly that). */
export function listSessions(namespace = "loop"): string[] {
  return listOwnedSessions(namespace).map((s) => s.name);
}

/** An owned session plus the identity it was STAMPED with — so a consumer can filter by exact project
 *  or run instead of guessing from the name. Name-substring filters are unsafe: a session for project
 *  `web-api` contains `-web-`, so a substring test for project `web` would happily expose it. */
export type OwnedSessionName = { name: string; project: string; run: string; role: string };

export function listOwnedSessions(namespace = "loop"): OwnedSessionName[] {
  if (!tmuxAvailable()) return [];
  return tmuxClient()
    .ownedSessions()
    .filter((s) => s.id.namespace === namespace)
    .map((s) => ({ name: s.name, project: s.id.project, run: s.id.run, role: s.id.role }));
}

/** Capture a session's active pane. Only owned sessions are captured. */
export function capturePane(session: string, lines = 160): string {
  if (!isSafeTmuxName(session)) throw new Error(`Invalid session name ${JSON.stringify(session)}.`);
  const c = tmuxClient();
  const id = c.identityOf(session);
  if (!id) throw new Error(`No Loop-owned tmux session named "${session}".`);
  return c.capture(id, lines) ?? "";
}

/** Kill every OWNED session for this (namespace, project, run). Never a substring match. */
export function stopRun(namespace: string, project: string, runId: string): string[] {
  if (!tmuxAvailable()) return [];
  return tmuxClient().stopRun(namespace, project, runId);
}

export function paneTitle(title: string): string {
  return title.replace(/[^\w \-/]/g, "").slice(0, 40);
}

/**
 * The unified team viewport: ONE tmux window holding one tiled pane per role, so a human can watch
 * the whole team on one screen. Stamped with ownership metadata and idempotent (a second call adopts
 * the existing session). Best-effort: tmux is OPTIONAL — when it is unavailable or a call fails this
 * returns an empty map and the loop runs fully headless. It never throws.
 */
export function ensureTeamViewport(id: SessionIdentity, cwd: string, roles: PaneSpec[]): Record<string, string> {
  if (!roles.length || !tmuxAvailable()) return {};
  try {
    return tmuxClient().ensureSession(id, cwd, { panes: roles, width: 220, height: 50 }).panes;
  } catch {
    // A conflict, a dead server, or any tmux failure degrades to "no viewport" — never to a failed run.
    return {};
  }
}

/**
 * Strip control characters (newlines, carriage returns, escape sequences, C0/C1) from any text that
 * will be handed to tmux. Defense in depth: we pass argv (never a shell) and only use DISPLAY APIs, so
 * this is belt-and-braces against terminal-escape mischief in an LLM-authored task title.
 */
export function stripControl(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/[;`$&|<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Reflect a short status string into a pane (title + status line). Display only — never `send-keys`. */
export function showInPane(paneId: string, line: string): void {
  const safe = stripControl(line).slice(0, 200);
  if (!safe) return;
  tmuxClient().displayInPane(paneId, safe, { title: true });
}

/** Mirror a chunk of agent output to a pane's status line (display only, control-stripped). */
export function displayInPane(paneId: string, chunk: string): void {
  const line = chunk.split("\n").map((l) => stripControl(l)).filter(Boolean).slice(-1)[0];
  if (!line) return;
  tmuxClient().displayInPane(paneId, line.slice(0, 160));
}

export function capturePaneById(paneId: string, lines = 40): string {
  return tmuxClient().capturePane(paneId, lines);
}

export function killSession(session: string): boolean {
  return isSafeTmuxName(session) ? tmuxClient().killSession(session) : false;
}

export function sessionExists(session: string): boolean {
  return isSafeTmuxName(session) ? tmuxClient().hasSession(session) : false;
}

/**
 * Attach the current terminal to an OWNED tmux session. Throws with actionable guidance when tmux is
 * unavailable or the session is missing/foreign. Inside tmux, switches the client instead of nesting.
 */
export function attachSession(session: string): number {
  if (!isSafeTmuxName(session)) throw new Error(`Invalid session name ${JSON.stringify(session)}.`);
  if (!tmuxAvailable()) {
    throw new Error("tmux is not installed (or LOOP_TMUX=off). tmux is an optional viewport — install it to attach, or use `loop monitor`.");
  }
  const c = tmuxClient();
  if (!c.identityOf(session)) {
    throw new Error(`No Loop-owned tmux session named "${session}". Start a run first, or run \`loop tmux show\` to list live sessions.`);
  }
  return c.attach(session, insideTmux());
}

/**
 * `loop start` — a prompt-only viewport: one OWNED session per role, launching no agent. Agents run
 * exclusively through the safe engine (`loop run --execute`).
 */
export function startProjectSessions(
  loaded: LoadedConfig,
  project: ProjectConfig,
  runId: string,
  options: { execute: boolean; roles?: string[] }
): SessionInfo[] {
  const runDir = resolve(loaded.rootDir, loaded.config.defaults.runDir, runId);
  const promptDir = resolve(runDir, "prompts");
  // PRIVATE (0700): a role prompt is an agent's INSTRUCTIONS. Under the common umask 002 the default
  // would be 0775/0664 — group-writable instructions for a process that edits the repo and spends money.
  mkdirSync(promptDir, { recursive: true, mode: 0o700 });

  const wantedRoles = new Set(options.roles ?? []);
  if (wantedRoles.size) {
    const knownRoles = new Set(project.roles.map((role) => role.name));
    const unknown = [...wantedRoles].filter((role) => !knownRoles.has(role));
    if (unknown.length) {
      throw new Error(`Unknown role(s): ${unknown.join(", ")}. Available roles: ${[...knownRoles].join(", ")}`);
    }
  }
  const roles = project.roles.filter((role) => role.autoStart && (!wantedRoles.size || wantedRoles.has(role.name)));
  return roles.map((role) => startRoleSession(loaded, project, role, runId, promptDir, options.execute));
}

function startRoleSession(
  loaded: LoadedConfig,
  project: ProjectConfig,
  role: RoleConfig,
  runId: string,
  promptDir: string,
  execute: boolean
): SessionInfo {
  const provider = project.providers[role.provider];
  if (!provider) throw new Error(`Role ${role.name} references missing provider ${role.provider}`);

  const namespace = loaded.config.defaults.namespace;
  const id: SessionIdentity = { namespace, project: project.name, run: runId, role: role.name };
  const session = sessionName(namespace, project.name, runId, role.name);
  const promptFile = resolve(promptDir, `${role.name}.md`);
  // 0600, durably and atomically — the orchestrator REFUSES to read a group/other-accessible prompt.
  writeStateFileDurable(promptFile, buildRolePrompt(loaded, project, role, runId));

  if (!tmuxAvailable()) return { role: role.name, session, provider: role.provider, promptFile, status: "skipped" };

  const cwd = resolve(loaded.rootDir, project.workingDir);
  const command = execute
    ? buildExecutableShell(provider, promptFile)
    : `printf '%s\\n' ${shellQuote(`Prompt written to ${promptFile}`)} ${shellQuote(`Run: loop attach ${session}`)}; exec $SHELL -l`;

  const result = tmuxClient().ensureSession(id, cwd, { command, panes: [{ name: role.name, title: paneTitle(role.title) }] });
  return {
    role: role.name,
    session: result.name,
    provider: role.provider,
    promptFile,
    status: result.created ? "started" : "exists"
  };
}

function buildExecutableShell(provider: ProjectConfig["providers"][string], promptFile: string): string {
  const providerCommand = buildProviderCommand(provider, promptFile);
  const command = commandToShell(providerCommand);

  if (provider.promptMode === "stdin") {
    return `bash -lc ${shellQuote(`cat ${shellQuote(promptFile)} | ${command}`)}`;
  }

  return `bash -lc ${shellQuote(`printf 'Prompt: %s\\n' ${shellQuote(promptFile)}; ${command}`)}`;
}

/** Is a tmux server reachable at all (used by `loop doctor` / `loop tmux pre`)? */
export function tmuxServerReachable(): boolean {
  return tmuxAvailable() && tmuxClient().serverReachable();
}

/** True when the `tmux` binary exists on PATH, IGNORING the LOOP_TMUX toggle — so `loop tmux pre` can
 *  tell "tmux is not installed" apart from "you turned the viewport off", which need different fixes. */
export function tmuxInstalled(): boolean {
  return spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
}

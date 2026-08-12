/**
 * Phase 2 wiring helpers (docs/herdr-runtime-parity.md): turn the CLI into a
 * CLIENT of the durable viewport registry. Pure and injectable — every function
 * operates on a ViewportRegistry or plain paths, so nothing here needs tmux.
 *
 * Bookkeeping is intentionally NON-FATAL: callers wrap these in try/catch and a
 * registry failure must never change a tmux command's exit code or behavior.
 */

import { resolve } from "node:path";
import { JsonViewportStorage, VIEWPORT_ID_PATTERN, ViewportRegistry } from "./viewport-registry.js";

export const VIEWPORT_STATE_DIR_NAME = "viewports";
export const VIEWPORT_STALE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Per-run durable state directory for viewport session facts. */
export function viewportStateDir(runsDir: string, runId: string): string {
  return resolve(runsDir, runId, VIEWPORT_STATE_DIR_NAME);
}

/** Open the run's durable registry (JSON files); reads lazily, writes on first put. */
export function openViewportRegistry(runsDir: string, runId: string): ViewportRegistry {
  return new ViewportRegistry({ storage: new JsonViewportStorage(viewportStateDir(runsDir, runId)) });
}

export type RecordOpenedViewportInput = {
  runId: string;
  /** Role/pane names covered by the session (tmux tiled team viewport). */
  roles: readonly string[];
  session: string;
  ownerPid: number;
  /** Agent pid when the run parent knows it; omitted for CLI-recorded sessions. */
  pid?: number;
  createdAt?: number;
};

/** Record one running session fact per role after a viewport is created/reused. */
export function recordOpenedViewport(registry: ViewportRegistry, input: RecordOpenedViewportInput): number {
  assertRoles(input.roles);
  let recorded = 0;
  for (const role of input.roles) {
    registry.record({
      runId: input.runId,
      role,
      sessionName: input.session,
      ownerPid: input.ownerPid,
      pid: input.pid,
      createdAt: input.createdAt ?? Date.now(),
      state: "running"
    });
    recorded += 1;
  }
  return recorded;
}

/** Mark every recorded session of a run as exited (after `tmux kill` or run end). */
export function markRunViewportsExited(registry: ViewportRegistry, runId: string, at: number = Date.now()): number {
  let marked = 0;
  for (const session of registry.list(runId)) {
    if (session.state !== "exited" && registry.updateState(runId, session.role, "exited", at)) marked += 1;
  }
  return marked;
}

/** Prune stale exited viewport facts; returns the number discarded. */
export function pruneRegistryViewports(
  registry: ViewportRegistry,
  maxAgeMs: number = VIEWPORT_STALE_MAX_AGE_MS,
  now: number = Date.now()
): number {
  return registry.pruneByAge(maxAgeMs, now);
}

export type AttachResolution =
  | { kind: "session"; session: string }
  | { kind: "role"; role: string; session: string }
  | { kind: "default"; session: string };

/**
 * Resolve what to attach: an exact role name from durable facts wins over the
 * raw argument; anything else keeps the legacy argument-as-session-name
 * behavior (a fully unknown arg is attached as an exact tmux name).
 */
export function resolveAttach(
  registry: ViewportRegistry,
  opts: { runId: string; arg?: string; defaultSession: string }
): AttachResolution {
  const { runId, arg, defaultSession } = opts;
  if (arg !== undefined && arg.length > 0) {
    // Only role-shaped arguments consult the registry; session names (with
    // colons) and any other string are attached verbatim as exact tmux names.
    if (VIEWPORT_ID_PATTERN.test(arg)) {
      const byRole = registry.resolve(runId, arg);
      if (byRole) return { kind: "role", role: arg, session: byRole.sessionName };
    }
    return { kind: "session", session: arg };
  }
  return { kind: "default", session: defaultSession };
}

function assertRoles(roles: readonly string[]): void {
  if (roles.length > 64) throw new TypeError("too many viewport roles");
  for (const role of roles) {
    if (!/^[A-Za-z0-9._-]{1,128}$/u.test(role)) throw new TypeError(`invalid viewport role ${JSON.stringify(role)}`);
  }
}

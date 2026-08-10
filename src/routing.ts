import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { StateFileRead, readStateFile, writeStateFileDurable } from "./runtime.js";
import { ProjectConfig, ProviderConfig } from "./config/schema.js";
import { normalizeTurn } from "./normalize.js";

/**
 * Provider routing / fallback contract.
 *
 * The PRIMARY implementation executor is Claude Opus (`claude -p`, prompt beginning `/goal`).
 * We switch to a configured Codex/GPT fallback ONLY when Claude reports an EXPLICITLY classified
 * usage/rate/quota limit — never on an auth error, a model error, a failed test, or any other
 * generic failure (those are real outcomes the primary must own). We persist a cooldown so the
 * fallback keeps the run moving, then probe Opus again once the cooldown expires and return to
 * it. A Claude limit-triggered fallback does NOT consume a task's repair budget.
 */

export type ClaudeOutcome = "ok" | "limit" | "error";

/**
 * Parse the COMPLETE, top-level Claude Code stream-JSON records from stdout. Claude Code (run with
 * `--output-format stream-json --verbose`) emits exactly one JSON object per line: `system`,
 * `assistant`, `user`, `result`, and `rate_limit_event` records. Model-authored text only ever
 * appears INSIDE an `assistant` record's string fields, so a fake `rate_limit_error` or a nested
 * `{"type":"result"}` embedded in prose is never a top-level record and cannot spoof this parser.
 * Non-JSON lines, arrays, and stderr are ignored entirely.
 */
export type ClaudeStream = {
  /** The last (terminal) `result` record; the final result always wins. */
  terminal?: { isError: boolean; subtype?: string };
  /** Whether an EXPLICIT top-level usage/rate/quota REJECTION (status "rejected") was seen.
   *  `allowed` / `allowed_warning` telemetry are NOT rejections and are ignored. */
  explicitLimit: boolean;
};

/**
 * Parse Claude stream-JSON via the single shared normalizer (src/normalize.ts). Kept as a thin
 * adapter so callers/tests that only need the terminal + explicit-limit signals do not depend on
 * the full normalized turn shape. There is exactly ONE parser of provider output in the codebase.
 */
export function parseClaudeStream(stdout: string): ClaudeStream {
  const n = normalizeTurn("claude", stdout);
  return {
    terminal: n.hasTerminal ? { isError: !n.success, subtype: n.subtype } : undefined,
    explicitLimit: n.explicitLimit
  };
}

/**
 * Classify a Claude PRIMARY turn for the fallback decision only, via the shared normalizer. The
 * final terminal result wins:
 *  - a terminal SUCCESS is always `ok` and NEVER falls back;
 *  - a FAILED terminal result WITH an explicit top-level usage/rate/quota rejection is `limit` —
 *    the ONLY case that may fall back to Codex/GPT;
 *  - everything else (failed terminal without explicit rejection, missing/torn terminal =
 *    UNCERTAIN, auth/model/context/timeout/529/generic, stderr/model prose) is a generic `error`
 *    that NEVER falls back.
 */
export function classifyOutcome(result: { ok: boolean; code: number | null; stdout: string; stderr: string }): ClaudeOutcome {
  const n = normalizeTurn("claude", result.stdout);
  if (n.success) return "ok";
  if (n.explicitLimit) return "limit";
  return "error";
}

export type ProviderHealth = Record<string, { cooldownUntil: number; reason?: string }>;

export function healthPath(runDir: string): string {
  return resolve(runDir, ".loop_provider_health.json");
}

/**
 * Read provider health, distinguishing ABSENT (no cooldown has ever been marked) from an existing but
 * UNSAFE/corrupt file. The old reader swallowed every error into `{}` — so a symlinked, unreadable, or
 * malformed health file silently became "no provider is in cooldown", which is precisely the state
 * that sends a rate-limited primary straight back into the limit (or hides that we ever fell back).
 */
export function loadHealth(runDir: string): ProviderHealth {
  const path = healthPath(runDir);
  const read = readStateFile(path); // throws UnsafeStateFileError on symlink/nonregular/permissive/wrong-owner/unreadable
  if (read.kind === "absent" || read.data.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.data.toString("utf8"));
  } catch {
    throw new Error(`refusing to use ${path}: provider health is not parseable JSON (malformed or truncated)`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`refusing to use ${path}: provider health is not a JSON object`);
  }
  const out: ProviderHealth = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`refusing to use ${path}: provider health entry ${JSON.stringify(key)} is not an object`);
    }
    const entry = value as Record<string, unknown>;
    if (typeof entry.cooldownUntil !== "number" || !Number.isFinite(entry.cooldownUntil)) {
      throw new Error(`refusing to use ${path}: provider health entry ${JSON.stringify(key)} has an invalid cooldownUntil`);
    }
    if (entry.reason !== undefined && typeof entry.reason !== "string") {
      throw new Error(`refusing to use ${path}: provider health entry ${JSON.stringify(key)} has an invalid reason`);
    }
    out[key] = { cooldownUntil: entry.cooldownUntil, reason: entry.reason as string | undefined };
  }
  return out;
}

export function saveHealth(runDir: string, health: ProviderHealth): void {
  writeStateFileDurable(healthPath(runDir), `${JSON.stringify(health, null, 2)}\n`);
}

export function inCooldown(health: ProviderHealth, providerKey: string, now: number): boolean {
  const entry = health[providerKey];
  return Boolean(entry && entry.cooldownUntil > now);
}

export function markCooldown(health: ProviderHealth, providerKey: string, now: number, seconds: number, reason: string): ProviderHealth {
  return { ...health, [providerKey]: { cooldownUntil: now + seconds * 1000, reason } };
}

/**
 * The ROUTE EPOCH: a durable generation number for "which provider this run is routing to". Every
 * cooldown bumps it, so a settlement carrying an old epoch is a stale-route settlement and the ledger
 * refuses to fold it into this call's accounting (wave-8d audit B3 — a reservation identity that does
 * not pin the route cannot prove WHICH route actually spent the money).
 *
 * It is kept beside the health file rather than inside it so the existing health schema (and its
 * readers) stay untouched.
 */
export function routeEpochPath(runDir: string): string {
  return resolve(runDir, ".loop_route_epoch.json");
}

/**
 * The route-epoch state is CORRUPT: it exists but we cannot prove what generation this run is on.
 *
 * This is never recoverable by "assuming 0". Epoch 0 is the INITIAL state (no cooldown has ever been
 * marked), and a settlement bound to epoch 0 is folded as current. Laundering a corrupt/truncated/
 * swapped file into 0 therefore hands a stale-route settlement exactly the identity it needs to look
 * fresh — and a bump computed from it silently REWINDS the generation (5 → 1), re-validating every
 * settlement the earlier bumps had invalidated. Corruption fails the turn closed instead.
 */
export class RouteEpochCorrupt extends Error {
  constructor(readonly path: string, readonly why: string) {
    super(`route epoch state at ${path} is unusable: ${why} (fail closed — it is NOT epoch 0)`);
    this.name = "RouteEpochCorrupt";
  }
}

const ROUTE_EPOCH_SCHEMA = "loop.route-epoch.v1";
const MAX_ROUTE_EPOCH_BYTES = 64 * 1024; // a route epoch is ~200 bytes; anything larger is not ours

type RouteEpochFile = {
  schema: string;
  runNonce: string;
  epoch: number;
  reason: string;
  ts: string;
  /** Self-checksum over the exact authoritative fields. NOT a secret-keyed MAC (anyone who can write
   *  the file can recompute it) — it exists to catch a TORN/partially-rewritten/hand-edited record
   *  whose JSON still parses, which is the failure a plain schema check cannot see. */
  check: string;
};

function routeEpochCheck(runNonce: string, epoch: number, reason: string, ts: string): string {
  return createHash("sha256").update(`${ROUTE_EPOCH_SCHEMA}\0${runNonce}\0${epoch}\0${reason}\0${ts}`).digest("hex");
}

/**
 * The highest epoch this PROCESS has proven for a given run state file. A durable counter may only go
 * FORWARD: observing a lower one means the file was rolled back, restored from a copy, or swapped for
 * another (older) generation of itself — none of which the on-disk record can self-report, because a
 * stale record is perfectly well-formed. Fail closed on any decrease.
 */
const epochFloor = new Map<string, number>();

/**
 * Read the durable route generation, distinguishing ABSENT (initial: epoch 0) from EVERY corrupt or
 * unsafe existing state — malformed/truncated JSON, an invalid schema, an unreadable file, a symlink,
 * a non-regular file, a permissive mode, another user's file, or a swapped/rolled-back record (wrong
 * run, or an epoch below one we have already proven). Everything except "absent" throws.
 */
export function loadRouteEpoch(runDir: string, runNonce: string): number {
  const path = routeEpochPath(runDir);
  const key = `${path}\0${runNonce}`;
  const floor = epochFloor.get(key) ?? 0;

  let read: StateFileRead;
  try {
    // Rejects a symlink, a directory/FIFO, a hardlink alias, a group/other-accessible mode, another
    // uid's file, and an unreadable file — none of which may be mistaken for "no cooldown yet".
    read = readStateFile(path);
  } catch (error) {
    throw new RouteEpochCorrupt(path, (error as Error).message);
  }
  if (read.kind === "absent") {
    // TRULY absent. That is epoch 0 — but only if we have never proven a higher one for this run: a
    // file that DISAPPEARS after a bump is a rollback, not a fresh run.
    if (floor > 0) throw new RouteEpochCorrupt(path, `the state is gone, but epoch ${floor} was already proven for this run`);
    return 0;
  }
  if (read.data.length === 0) throw new RouteEpochCorrupt(path, "it is empty (a torn create)");
  if (read.data.length > MAX_ROUTE_EPOCH_BYTES) throw new RouteEpochCorrupt(path, `it is ${read.data.length} bytes (limit ${MAX_ROUTE_EPOCH_BYTES})`);
  if (read.data.includes(0)) throw new RouteEpochCorrupt(path, "it contains NUL bytes");

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.data.toString("utf8"));
  } catch {
    throw new RouteEpochCorrupt(path, "it is not parseable JSON (malformed or truncated)");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new RouteEpochCorrupt(path, "it is not a JSON object");
  const f = parsed as Partial<RouteEpochFile>;
  if (f.schema !== ROUTE_EPOCH_SCHEMA) throw new RouteEpochCorrupt(path, `unknown schema ${JSON.stringify(f.schema)}`);
  if (typeof f.runNonce !== "string" || !f.runNonce) throw new RouteEpochCorrupt(path, "it carries no run identity");
  if (typeof f.epoch !== "number" || !Number.isSafeInteger(f.epoch) || f.epoch < 0) throw new RouteEpochCorrupt(path, `invalid epoch ${JSON.stringify(f.epoch)}`);
  if (typeof f.reason !== "string") throw new RouteEpochCorrupt(path, "invalid reason");
  if (typeof f.ts !== "string" || !f.ts) throw new RouteEpochCorrupt(path, "invalid ts");
  if (typeof f.check !== "string" || f.check !== routeEpochCheck(f.runNonce, f.epoch, f.reason, f.ts)) {
    throw new RouteEpochCorrupt(path, "its self-checksum does not match its fields (torn or tampered)");
  }
  // A record from ANOTHER run is a swapped/copied state, never this run's generation.
  if (f.runNonce !== runNonce) {
    throw new RouteEpochCorrupt(path, `it belongs to run ${f.runNonce.slice(0, 12)}, not ${runNonce.slice(0, 12)} (swapped state)`);
  }
  if (f.epoch < floor) throw new RouteEpochCorrupt(path, `epoch ${f.epoch} is BELOW the ${floor} already proven for this run (rolled back)`);
  epochFloor.set(key, f.epoch);
  return f.epoch;
}

/**
 * Durably advance the route generation. Returns the NEW epoch.
 *
 * The current epoch is read STRICTLY first: a corrupt state throws here rather than being laundered
 * into a fresh-looking `1`. The new state is published atomically and both the file and its directory
 * are fsynced, so a crash mid-bump leaves either the old generation or the new one — never a torn
 * record, and never a rename that a power failure can silently undo.
 */
export function bumpRouteEpoch(runDir: string, runNonce: string, reason: string): number {
  const path = routeEpochPath(runDir);
  const next = loadRouteEpoch(runDir, runNonce) + 1; // throws on corruption — never launders it forward
  const ts = new Date().toISOString();
  const body: RouteEpochFile = {
    schema: ROUTE_EPOCH_SCHEMA,
    runNonce,
    epoch: next,
    reason,
    ts,
    check: routeEpochCheck(runNonce, next, reason, ts)
  };
  writeStateFileDurable(path, `${JSON.stringify(body, null, 2)}\n`);
  epochFloor.set(`${path}\0${runNonce}`, next);
  return next;
}

export type ProviderChain = { primary: string; fallback?: string };

/**
 * Resolve the primary/fallback provider keys for a role. Primary is the role's provider. The ONLY
 * permitted fallback is a Codex provider, used solely when the Claude primary reports an explicit
 * usage/rate/quota limit. Precedence:
 *   1. a Codex provider explicitly declared `fallbackFor: <primary>`;
 *   2. otherwise — when the primary is a Claude provider — the first configured Codex provider.
 * Gemini/custom are NEVER silently inferred as a fallback, and a non-Claude primary has no
 * fallback. When no valid Codex fallback exists the chain is primary-only.
 */
export function buildProviderChain(project: ProjectConfig, roleProviderKey: string): ProviderChain {
  const providers = project.providers;
  const primary = roleProviderKey;
  const primaryCfg = providers[primary];
  // A fallback only ever applies to a Claude primary (only Claude reports the usage-limit signal).
  if (primaryCfg?.type !== "claude") return { primary };

  const declared = Object.entries(providers).find(([key, p]) => p.fallbackFor === primary && key !== primary && p.type === "codex")?.[0];
  if (declared) return { primary, fallback: declared };

  const codex = Object.entries(providers).find(([key, p]) => key !== primary && p.type === "codex")?.[0];
  if (codex) return { primary, fallback: codex };
  return { primary };
}

/**
 * Pick the provider key to use RIGHT NOW: the primary unless it is in cooldown, in which case the
 * fallback (if any and not itself in cooldown). Once the primary's cooldown expires it is chosen
 * again — i.e. we automatically return to Opus.
 */
export function chooseActiveProvider(chain: ProviderChain, health: ProviderHealth, now: number): string {
  if (!inCooldown(health, chain.primary, now)) return chain.primary;
  if (chain.fallback && !inCooldown(health, chain.fallback, now)) return chain.fallback;
  return chain.primary;
}

/** Whether a provider config carries a usable command (for chain validity when only one CLI
 *  exists). */
export function providerRunnable(p: ProviderConfig | undefined): boolean {
  return Boolean(p);
}

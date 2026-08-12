/**
 * Durable, injectable viewport-session registry — the Phase 1 "daemon owns the
 * agent terminals" fact layer (see docs/herdr-runtime-parity.md).
 *
 * A ViewportRegistry is a pure bookkeeping service: it RECORDS which terminal
 * sessions belong to which run/role, their semantic state, and their owner, and
 * it lets clients RESOLVE attach targets from durable state after any client
 * death. It never spawns, never kills, and never grants authority — the tmux
 * client and the control plane keep those guarantees. Storage is injectable
 * (in-memory for tests, atomic JSON files for the daemon's state directory).
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const VIEWPORT_SESSION_STATES = ["running", "blocked", "done", "idle", "exited"] as const;
export type ViewportSessionState = (typeof VIEWPORT_SESSION_STATES)[number];

/** One durable, daemon-owned terminal session fact. */
export type ViewportSession = Readonly<{
  runId: string;
  role: string;
  sessionName: string;
  /** The exact tmux socket, when the session uses a private one. */
  socket?: string;
  /** The agent child pid, when known. */
  pid?: number;
  /** The process that created/owns this session (the daemon or run parent). */
  ownerPid: number;
  createdAt: number;
  lastActiveAt: number;
  state: ViewportSessionState;
}>;

export type ViewportStorage = {
  get(runId: string): ViewportSession[];
  put(runId: string, sessions: readonly ViewportSession[]): void;
  delete(runId: string): void;
  /** All run ids currently holding records. */
  runs(): string[];
};

export const VIEWPORT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;
export const VIEWPORT_REGISTRY_MAX_RECORDS = 10_000;

/** Run/role ids are strictly bounded so they are safe as file names and tmux names. */
export function assertValidViewportId(value: string, label: string): asserts value is string {
  if (typeof value !== "string" || !VIEWPORT_ID_PATTERN.test(value)) {
    throw new TypeError(`${label} must match ${VIEWPORT_ID_PATTERN} (got ${JSON.stringify(value)})`);
  }
}

export function isViewportSessionState(value: unknown): value is ViewportSessionState {
  return typeof value === "string" && (VIEWPORT_SESSION_STATES as readonly string[]).includes(value);
}

export class InMemoryViewportStorage implements ViewportStorage {
  protected readonly records = new Map<string, ViewportSession[]>();

  get(runId: string): ViewportSession[] {
    return [...(this.records.get(runId) ?? [])];
  }

  put(runId: string, sessions: readonly ViewportSession[]): void {
    this.records.set(runId, [...sessions]);
  }

  delete(runId: string): void {
    this.records.delete(runId);
  }

  runs(): string[] {
    return [...this.records.keys()];
  }
}

/**
 * One JSON file per run, written atomically (tmp + rename). Reading a missing or
 * malformed file yields an empty list — a damaged fact file never crashes a
 * client, it just means "no durable records yet".
 */
export class JsonViewportStorage implements ViewportStorage {
  constructor(readonly dir: string) {}

  private fileFor(runId: string): string {
    assertValidViewportId(runId, "runId");
    return join(this.dir, `${runId}.json`);
  }

  get(runId: string): ViewportSession[] {
    try {
      const raw = readFileSync(this.fileFor(runId), "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isViewportSessionShape);
    } catch {
      return [];
    }
  }

  put(runId: string, sessions: readonly ViewportSession[]): void {
    mkdirSync(this.dir, { recursive: true });
    const file = this.fileFor(runId);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(sessions, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
  }

  delete(runId: string): void {
    rmSync(this.fileFor(runId), { force: true });
  }

  runs(): string[] {
    let entries: string[] = [];
    try {
      entries = readdirSync(this.dir);
    } catch {
      return [];
    }
    return entries
      .filter((name) => name.endsWith(".json") && !name.endsWith(".tmp"))
      .map((name) => name.slice(0, -".json".length))
      .filter((name) => VIEWPORT_ID_PATTERN.test(name));
  }
}

function isViewportSessionShape(value: unknown): value is ViewportSession {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.runId === "string" &&
    typeof record.role === "string" &&
    typeof record.sessionName === "string" &&
    typeof record.ownerPid === "number" &&
    Number.isInteger(record.ownerPid) &&
    typeof record.createdAt === "number" &&
    Number.isFinite(record.createdAt) &&
    typeof record.lastActiveAt === "number" &&
    Number.isFinite(record.lastActiveAt) &&
    isViewportSessionState(record.state)
  );
}

export type ViewportRegistryOptions = {
  storage?: ViewportStorage;
  /** Injectable clock (ms epoch). Defaults to Date.now. */
  clock?: () => number;
  /** Registry-wide record cap. Defaults to VIEWPORT_REGISTRY_MAX_RECORDS. */
  maxRecords?: number;
};

export class ViewportRegistry {
  readonly storage: ViewportStorage;
  private readonly clock: () => number;
  private readonly maxRecords: number;

  constructor(opts: ViewportRegistryOptions = {}) {
    this.storage = opts.storage ?? new InMemoryViewportStorage();
    this.clock = opts.clock ?? Date.now;
    this.maxRecords = opts.maxRecords ?? VIEWPORT_REGISTRY_MAX_RECORDS;
    if (!Number.isSafeInteger(this.maxRecords) || this.maxRecords < 1) {
      throw new TypeError("maxRecords must be a positive safe integer");
    }
  }

  private normalize(
    input: Omit<ViewportSession, "lastActiveAt" | "state"> & { lastActiveAt?: number; state?: ViewportSessionState }
  ): ViewportSession {
    assertValidViewportId(input.runId, "runId");
    assertValidViewportId(input.role, "role");
    if (typeof input.sessionName !== "string" || input.sessionName.length === 0 || input.sessionName.length > 256) {
      throw new TypeError("sessionName must be a non-empty string up to 256 chars");
    }
    if (!Number.isSafeInteger(input.ownerPid) || input.ownerPid <= 0) throw new TypeError("ownerPid must be a positive integer");
    if (!Number.isFinite(input.createdAt)) throw new TypeError("createdAt must be a finite number");
    if (input.pid !== undefined && (!Number.isSafeInteger(input.pid) || input.pid <= 0)) {
      throw new TypeError("pid must be a positive integer when provided");
    }
    if (input.socket !== undefined && (typeof input.socket !== "string" || input.socket.length === 0)) {
      throw new TypeError("socket must be a non-empty string when provided");
    }
    const state = input.state ?? "running";
    if (!isViewportSessionState(state)) throw new TypeError(`invalid state ${JSON.stringify(state)}`);
    const createdAt = input.createdAt;
    const lastActiveAt = input.lastActiveAt ?? createdAt;
    if (!Number.isFinite(lastActiveAt)) throw new TypeError("lastActiveAt must be a finite number");
    return { ...input, createdAt, lastActiveAt, state };
  }

  /** Idempotent: latest record for (runId, role) wins. */
  record(
    input: Omit<ViewportSession, "lastActiveAt" | "state"> & { lastActiveAt?: number; state?: ViewportSessionState }
  ): ViewportSession {
    const session = this.normalize(input);
    const existing = this.storage.get(session.runId);
    if (!existing.some((item) => item.role === session.role) && this.count() >= this.maxRecords) {
      throw new RangeError(`viewport registry exceeds its ${this.maxRecords} record cap`);
    }
    const updated = [...existing.filter((item) => item.role !== session.role), session];
    this.storage.put(session.runId, updated);
    return session;
  }

  /** Returns false when no record exists for (runId, role). */
  updateState(runId: string, role: string, state: ViewportSessionState, at: number = this.clock()): boolean {
    assertValidViewportId(runId, "runId");
    assertValidViewportId(role, "role");
    if (!isViewportSessionState(state)) throw new TypeError(`invalid state ${JSON.stringify(state)}`);
    const existing = this.storage.get(runId);
    const target = existing.find((item) => item.role === role);
    if (!target) return false;
    this.storage.put(runId, [...existing.filter((item) => item.role !== role), { ...target, state, lastActiveAt: at }]);
    return true;
  }

  resolve(runId: string, role: string): ViewportSession | undefined {
    assertValidViewportId(runId, "runId");
    assertValidViewportId(role, "role");
    return this.storage.get(runId).find((item) => item.role === role);
  }

  list(runId: string): readonly ViewportSession[] {
    assertValidViewportId(runId, "runId");
    return [...this.storage.get(runId)].sort((left, right) => left.createdAt - right.createdAt);
  }

  /** Sessions a client may attach to: known pid, not exited. */
  attachTargets(runId: string, isAlive?: (pid: number) => boolean): readonly ViewportSession[] {
    assertValidViewportId(runId, "runId");
    return this.list(runId).filter(
      (item) => item.pid !== undefined && item.state !== "exited" && (isAlive === undefined || isAlive(item.pid as number))
    );
  }

  /** Reap: exited records idle past maxAgeMs (stale running records stay until state changes). */
  pruneByAge(maxAgeMs: number, now: number = this.clock()): number {
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new TypeError("maxAgeMs must be a non-negative finite number");
    let removed = 0;
    for (const runId of this.storage.runs()) {
      const sessions = this.storage.get(runId);
      const kept = sessions.filter((item) => !(item.state === "exited" && item.lastActiveAt + maxAgeMs < now));
      removed += sessions.length - kept.length;
      if (kept.length === 0) this.storage.delete(runId);
      else this.storage.put(runId, kept);
    }
    return removed;
  }

  remove(runId: string, role?: string): number {
    assertValidViewportId(runId, "runId");
    const existing = this.storage.get(runId);
    if (role === undefined) {
      const count = existing.length;
      this.storage.delete(runId);
      return count;
    }
    assertValidViewportId(role, "role");
    const kept = existing.filter((item) => item.role !== role);
    this.storage.put(runId, kept);
    return existing.length - kept.length;
  }

  count(): number {
    let total = 0;
    for (const runId of this.storage.runs()) total += this.storage.get(runId).length;
    return total;
  }
}

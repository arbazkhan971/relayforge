import {
  appendFileSync,
  closeSync,
  constants as fsConstants,
  chmodSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { canonicalJson, type ControlEvent } from "./control/events.js";
import type { ControlProjection, TaskFact } from "./control/reducer.js";
import { ControlStore, openControlStore } from "./control/store.js";
import { readStateFile } from "./runtime.js";

/**
 * Shared blackboard for the autonomous SME team.
 *
 * Coordination happens through three append-only JSONL logs under `.loop/board/`:
 *  - tasks.jsonl   the work items the orchestrator/PM decomposes a goal into
 *  - events.jsonl  status updates SMEs emit (claimed/done/blocked/needs-review)
 *  - messages.jsonl free-form hand-off notes between roles
 *
 * Append-only JSONL is the safest cross-process format we can get with tmux as the
 * only IPC: every writer only ever appends a single line, and `appendFileSync` opens
 * with O_APPEND so concurrent single-line writes below PIPE_BUF do not interleave on
 * local filesystems. We never rewrite history; the *current* state of a task is the
 * reduction of its event stream. Claims are resolved by "first claim event wins",
 * which is decided when we fold the log — no lock needed for correctness, only a tiny
 * advisory lock for the rare orchestrator-side compaction.
 */

export type TaskStatus =
  | "open"
  | "claimed"
  | "in-progress"
  | "needs-review"
  | "blocked"
  | "done"
  | "rejected"
  | "escalated";

export type BoardTask = {
  id: string;
  title: string;
  /** SME role key this task is assigned to (e.g. "backend", "qa"). */
  assignee: string;
  /** Role that created the task (orchestrator/pm or another SME handing off). */
  createdBy: string;
  description: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
  priority: number;
  createdAt: string;
  /** Files this task expects to touch — used for ownership/contention checks. */
  files?: string[];
};

export type BoardEvent = {
  ts: string;
  role: string;
  taskId: string;
  status: TaskStatus;
  summary?: string;
};

export type BoardMessage = {
  ts: string;
  from: string;
  to: string;
  taskId?: string;
  body: string;
};

export type TaskView = BoardTask & {
  status: TaskStatus;
  claimedBy?: string;
  lastSummary?: string;
  lastUpdate?: string;
  /** How many times this task has failed (blocked/rejected) — drives the repair loop. */
  attempts: number;
};

export type BoardPaths = {
  dir: string;
  tasks: string;
  events: string;
  messages: string;
};

export const CONTROL_AUTHORITY_MARKER = ".control-authority.json";
export const CONTROL_DATABASE_LEAF = "control.db";
export const CONTROL_AUTHORITY_MARKER_MAX_BYTES = 64 * 1024;

const authorityMarkerSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("relayforge-control-authority"),
  mode: z.enum(["fresh", "legacy-import"]),
  runId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  runEpoch: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  storeId: z.string().uuid(),
  database: z.literal(CONTROL_DATABASE_LEAF),
  cutoverHeadSeq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  snapshotSeq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/),
  consumerId: z.literal("control.cutover"),
  consumerGeneration: z.literal(1),
  consumerLastSeq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  cutoverAt: z.string().datetime({ offset: true }),
  legacy: z.strictObject({
    planId: z.string().regex(/^[a-f0-9]{64}$/),
    manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    receiptDigest: z.string().regex(/^[a-f0-9]{64}$/),
    archiveName: z.string().regex(/^legacy-[a-f0-9]{64}$/),
    archiveDigest: z.string().regex(/^[a-f0-9]{64}$/),
    productCutoverAllowed: z.literal(true)
  }).optional()
}).superRefine((marker, context) => {
  if ((marker.mode === "legacy-import") !== (marker.legacy !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "legacy cutover metadata must match the cutover mode" });
  }
  if (marker.cutoverHeadSeq !== marker.snapshotSeq || marker.cutoverHeadSeq !== marker.consumerLastSeq) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "cutover snapshot/cursor must cover the exact cutover head" });
  }
});

export type ControlAuthorityMarker = z.infer<typeof authorityMarkerSchema>;

export class BoardAuthorityError extends Error {
  readonly code = "CONTROL_AUTHORITY_REQUIRED" as const;

  constructor(message: string) {
    super(message);
    this.name = "BoardAuthorityError";
  }
}

type BoundBoardAuthority = {
  marker: ControlAuthorityMarker;
  store: ControlStore;
  token: symbol;
};

const boundAuthorities = new Map<string, BoundBoardAuthority>();

function normalizedBoardDir(boardDir: string): string {
  return resolve(boardDir);
}

export function controlAuthorityMarkerPath(boardDir: string): string {
  return resolve(dirname(normalizedBoardDir(boardDir)), CONTROL_AUTHORITY_MARKER);
}

export function readControlAuthorityMarker(boardDir: string): ControlAuthorityMarker | undefined {
  const path = controlAuthorityMarkerPath(boardDir);
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw new BoardAuthorityError(
      code === "ELOOP"
        ? "control authority marker is a symlink"
        : `control authority marker could not be opened (${code ?? "unknown"})`
    );
  }
  let data: Buffer;
  try {
    // Size is checked on the pinned descriptor before allocation. Allocate one sentinel byte so a
    // file that grows after fstat cannot be accepted as the shorter prefix we initially measured.
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new BoardAuthorityError("control authority marker is not a regular file");
    if (before.nlink !== 1n) throw new BoardAuthorityError("control authority marker does not have exactly one link");
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid !== undefined && Number(before.uid) !== uid) {
      throw new BoardAuthorityError(`control authority marker is owned by uid ${String(before.uid)}, not ${uid}`);
    }
    if ((Number(before.mode) & 0o077) !== 0) throw new BoardAuthorityError("control authority marker is group/other accessible");
    if (before.size > BigInt(CONTROL_AUTHORITY_MARKER_MAX_BYTES)) {
      throw new BoardAuthorityError(`control authority marker exceeds ${CONTROL_AUTHORITY_MARKER_MAX_BYTES} bytes`);
    }
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== Number(before.size)) throw new BoardAuthorityError("control authority marker changed size while it was read");
    const after = fstatSync(fd, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.nlink !== 1n) {
      throw new BoardAuthorityError("control authority marker changed identity while it was read");
    }
    const atPath = lstatSync(path, { bigint: true });
    if (atPath.isSymbolicLink() || atPath.dev !== before.dev || atPath.ino !== before.ino || atPath.nlink !== 1n) {
      throw new BoardAuthorityError("control authority marker pathname changed while it was read");
    }
    data = buffer.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
  try {
    const marker = authorityMarkerSchema.parse(JSON.parse(data.toString("utf8")));
    if (`${canonicalJson(marker)}\n` !== data.toString("utf8")) {
      throw new BoardAuthorityError("control authority marker is not canonical");
    }
    return marker;
  } catch (error) {
    if (error instanceof BoardAuthorityError) throw error;
    throw new BoardAuthorityError(`control authority marker is malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Bind the parent-owned writer after a proven one-way cutover. The returned release is
 * successor-safe: an older handle cannot unbind a newer authority for the same board.
 */
export function bindCanonicalBoardAuthority(boardDir: string, marker: ControlAuthorityMarker, store: ControlStore): () => void {
  const key = normalizedBoardDir(boardDir);
  const parsed = authorityMarkerSchema.parse(marker);
  const durable = readControlAuthorityMarker(key);
  if (!durable || canonicalJson(durable) !== canonicalJson(parsed)) {
    throw new BoardAuthorityError("canonical board binding requires the exact durable cutover marker");
  }
  const identity = store.identity();
  if (identity.storeId !== parsed.storeId || identity.runId !== parsed.runId || identity.runEpoch !== parsed.runEpoch) {
    throw new BoardAuthorityError("canonical board store identity disagrees with the cutover marker");
  }
  if (boundAuthorities.has(key)) throw new BoardAuthorityError("canonical board authority is already bound in this process");
  const token = Symbol(key);
  boundAuthorities.set(key, { marker: parsed, store, token });
  return () => {
    if (boundAuthorities.get(key)?.token === token) boundAuthorities.delete(key);
  };
}

function withCanonicalStore<T>(boardDir: string, operation: (store: ControlStore, marker: ControlAuthorityMarker) => T): T | undefined {
  const key = normalizedBoardDir(boardDir);
  const bound = boundAuthorities.get(key);
  if (bound) return operation(bound.store, bound.marker);
  const marker = readControlAuthorityMarker(key);
  if (!marker) return undefined;
  const store = openControlStore({
    path: resolve(dirname(key), marker.database),
    runId: marker.runId,
    runEpoch: marker.runEpoch,
    create: false,
    recoveryMode: "verify"
  });
  try {
    const identity = store.identity();
    if (identity.storeId !== marker.storeId) throw new BoardAuthorityError("canonical board store identity changed after cutover");
    return operation(store, marker);
  } finally {
    store.close();
  }
}

function requireBoundWriter(boardDir: string): BoundBoardAuthority | undefined {
  const key = normalizedBoardDir(boardDir);
  const bound = boundAuthorities.get(key);
  if (bound) return bound;
  if (readControlAuthorityMarker(key)) {
    throw new BoardAuthorityError("legacy board writes are permanently disabled after control-store cutover; use the active parent writer");
  }
  return undefined;
}

export function boardPaths(boardDir: string): BoardPaths {
  return {
    dir: boardDir,
    tasks: resolve(boardDir, "tasks.jsonl"),
    events: resolve(boardDir, "events.jsonl"),
    messages: resolve(boardDir, "messages.jsonl")
  };
}

export function initBoard(boardDir: string): BoardPaths {
  // A durable marker is a one-way switch. Never recreate or normalize the retired JSONL
  // leaves after cutover; canonical reads are served from ControlStore below.
  if (readControlAuthorityMarker(boardDir)) return boardPaths(boardDir);
  // PRIVATE (0700), explicitly — not "whatever the ambient umask gives us". The board holds the run's
  // money ledger, and a group/other-writable directory lets another account swap the ledger leaf out
  // from under an open transaction. A umask of 002 (common on shared/CI hosts) would otherwise produce
  // a 0775 board, and the ledger rightly refuses to keep accounting there.
  mkdirSync(boardDir, { recursive: true, mode: 0o700 });
  // VERIFY the directory we just "created" is actually ours. `mkdirSync(…, {recursive:true})` succeeds
  // silently when the path already exists — including when it is a SYMLINK to somewhere else, in which
  // case the chmod below would have re-permissioned the attacker's target and every board journal (and
  // the ledger beside them) would have been created inside it.
  const st = lstatSync(boardDir);
  if (st.isSymbolicLink()) throw new Error(`refusing to use board ${boardDir}: it is a symlink`);
  if (!st.isDirectory()) throw new Error(`refusing to use board ${boardDir}: it is not a directory`);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && st.uid !== uid) throw new Error(`refusing to use board ${boardDir}: it is owned by uid ${st.uid}, not ${uid}`);
  chmodSync(boardDir, 0o700); // …and tighten a board an earlier version (or a loose umask) left open
  const paths = boardPaths(boardDir);
  for (const file of [paths.tasks, paths.events, paths.messages]) {
    // `existsSync` FOLLOWS a symlink, so a planted `tasks.jsonl -> /elsewhere` looked "already there"
    // and every later append/read went straight through it. `readStateFile` refuses a symlink, a
    // non-regular file, a hardlink alias, a permissive mode, another uid's file, and an unreadable one
    // — and only a genuinely ABSENT journal is created (exclusively, 0600).
    if (readStateFile(file).kind === "absent") {
      const fd = openSync(file, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
      closeSync(fd);
    }
  }
  return paths;
}

function readJsonl<T>(file: string): T[] {
  const read = readStateFile(file); // absent → empty board; unsafe → fail closed (never read through it)
  if (read.kind === "absent") return [];
  const out: T[] = [];
  for (const line of read.data.toString("utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // A torn/partial line (extremely rare with single-line appends) is skipped
      // rather than crashing the whole board read.
    }
  }
  return out;
}

function appendJsonl(file: string, value: unknown): void {
  appendFileSync(file, `${JSON.stringify(value)}\n`);
}

export function addTask(boardDir: string, task: BoardTask): void {
  const authority = requireBoundWriter(boardDir);
  if (authority) {
    const event: ControlEvent = {
      schemaVersion: 1,
      eventId: `board.task.${randomUUID()}`,
      runId: authority.marker.runId,
      runEpoch: authority.marker.runEpoch,
      taskId: task.id,
      taskGeneration: 1,
      expectedVersion: 0,
      occurredAt: task.createdAt,
      actorKind: "control-plane",
      actorId: task.createdBy,
      sourceKind: null,
      sourceId: null,
      sourceGeneration: null,
      sourceEventId: null,
      type: "task.created",
      payload: {
        title: task.title,
        assignee: task.assignee,
        createdBy: task.createdBy,
        description: task.description,
        acceptanceCriteria: [...task.acceptanceCriteria],
        dependsOn: [...task.dependsOn],
        priority: task.priority,
        createdAt: task.createdAt,
        ...(task.files ? { files: [...task.files] } : {})
      }
    };
    authority.store.append(event);
    return;
  }
  appendJsonl(boardPaths(boardDir).tasks, task);
}

export function addEvent(boardDir: string, event: BoardEvent): void {
  const authority = requireBoundWriter(boardDir);
  if (authority) {
    const projection = authority.store.getProjection();
    const task = projection.tasks[event.taskId];
    if (!task) throw new BoardAuthorityError(`canonical board task ${event.taskId} does not exist`);
    const aggregate = projection.aggregateVersions[`task:${task.id}:${task.generation}`];
    if (!aggregate) throw new BoardAuthorityError(`canonical board task ${event.taskId} aggregate is missing`);
    // The reviewer is recorded as the immutable actor. The v1 reducer uses payload.role as
    // claimant authority, so an acceptance on behalf of the claimant retains that identity.
    const transitionRole = event.status === "done" && task.claimedBy && task.claimedBy !== event.role
      ? task.claimedBy
      : event.role;
    authority.store.append({
      schemaVersion: 1,
      eventId: `board.status.${randomUUID()}`,
      runId: authority.marker.runId,
      runEpoch: authority.marker.runEpoch,
      taskId: task.id,
      taskGeneration: task.generation,
      // Messages, runtime facts, and other task-scoped control events advance the task aggregate
      // without changing the denormalized TaskFact.version. Always fence against the canonical
      // aggregate, otherwise a reviewer message between two status transitions makes the next
      // transition spuriously stale (and strands the repair loop).
      expectedVersion: aggregate.version,
      occurredAt: event.ts,
      actorKind: "control-plane",
      actorId: event.role,
      sourceKind: null,
      sourceId: null,
      sourceGeneration: null,
      sourceEventId: null,
      type: "task.status_changed",
      payload: {
        role: transitionRole,
        status: event.status,
        ...(event.summary === undefined ? {} : { summary: event.summary })
      }
    });
    return;
  }
  appendJsonl(boardPaths(boardDir).events, event);
}

export function addMessage(boardDir: string, message: BoardMessage): void {
  const authority = requireBoundWriter(boardDir);
  if (authority) {
    const projection = authority.store.getProjection();
    const task = message.taskId ? projection.tasks[message.taskId] : undefined;
    if (message.taskId && !task) throw new BoardAuthorityError(`canonical board task ${message.taskId} does not exist`);
    const aggregate = task
      ? projection.aggregateVersions[`task:${task.id}:${task.generation}`]
      : projection.aggregateVersions[`run:${authority.marker.runId}:1`];
    if (!aggregate) throw new BoardAuthorityError("canonical message aggregate is missing");
    const messageId = `board.message.${randomUUID()}`;
    authority.store.append({
      schemaVersion: 1,
      eventId: `board.post.${randomUUID()}`,
      runId: authority.marker.runId,
      runEpoch: authority.marker.runEpoch,
      taskId: task?.id ?? null,
      taskGeneration: task?.generation ?? null,
      expectedVersion: aggregate.version,
      occurredAt: message.ts,
      actorKind: "control-plane",
      actorId: message.from,
      sourceKind: null,
      sourceId: null,
      sourceGeneration: null,
      sourceEventId: null,
      type: "message.posted",
      payload: { messageId, from: message.from, to: message.to, body: message.body }
    });
    return;
  }
  appendJsonl(boardPaths(boardDir).messages, message);
}

export function readTasks(boardDir: string): BoardTask[] {
  const canonical = withCanonicalStore(boardDir, (store) => Object.values(store.getProjection().tasks)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map(taskFactToBoardTask));
  if (canonical) return canonical;
  return readJsonl<BoardTask>(boardPaths(boardDir).tasks);
}

export function readEvents(boardDir: string): BoardEvent[] {
  const canonical = withCanonicalStore(boardDir, (store) => {
    const output: BoardEvent[] = [];
    let afterSeq = 0;
    while (true) {
      const range = store.readRange({ afterSeq, limit: 10_000, runEpoch: store.runEpoch });
      for (const event of range.events) {
        if (event.type !== "task.status_changed") continue;
        output.push({
          ts: event.occurredAt,
          role: event.actorId,
          taskId: event.taskId!,
          status: event.payload.status,
          ...(event.payload.summary === undefined ? {} : { summary: event.payload.summary })
        });
      }
      if (!range.hasMore) return output;
      afterSeq = range.events.at(-1)!.seq;
    }
  });
  if (canonical) return canonical;
  return readJsonl<BoardEvent>(boardPaths(boardDir).events);
}

export function readMessages(boardDir: string): BoardMessage[] {
  const canonical = withCanonicalStore(boardDir, (store) => store.getProjection().messages.map((message) => ({
    ts: message.occurredAt,
    from: message.from,
    to: message.to,
    ...(message.taskId ? { taskId: message.taskId } : {}),
    body: message.body
  })));
  if (canonical) return canonical;
  return readJsonl<BoardMessage>(boardPaths(boardDir).messages);
}

function taskFactToBoardTask(task: TaskFact): BoardTask {
  return {
    id: task.id,
    title: task.title,
    assignee: task.assignee,
    createdBy: task.createdBy,
    description: task.description,
    acceptanceCriteria: [...task.acceptanceCriteria],
    dependsOn: [...task.dependsOn],
    priority: task.priority,
    createdAt: task.createdAt,
    ...(task.files ? { files: [...task.files] } : {})
  };
}

function taskFactToView(task: TaskFact): TaskView {
  return {
    ...taskFactToBoardTask(task),
    status: task.status,
    ...(task.claimedBy ? { claimedBy: task.claimedBy } : {}),
    ...(task.lastSummary ? { lastSummary: task.lastSummary } : {}),
    lastUpdate: task.lastUpdate,
    attempts: task.attempts
  };
}

/**
 * Fold the append-only logs into the current view of every task.
 *
 * Status precedence rules:
 *  - The *first* "claimed" event wins the claim (later claims are ignored).
 *  - After a claim, the latest event from the claiming role advances the status.
 *  - "done"/"rejected"/"blocked" from anyone are honored (PM can reject; QA can block).
 */
export function foldBoard(boardDir: string): TaskView[] {
  const canonical = withCanonicalStore(boardDir, (store) => Object.values(store.getProjection().tasks)
    .map(taskFactToView)
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id)));
  if (canonical) return canonical;
  const tasks = readTasks(boardDir);
  const events = readEvents(boardDir);
  const views = new Map<string, TaskView>();

  for (const task of tasks) {
    views.set(task.id, { ...task, status: "open", attempts: 0 });
  }

  for (const event of events) {
    const view = views.get(event.taskId);
    if (!view) continue;

    if (event.status === "claimed") {
      if (!view.claimedBy) {
        view.claimedBy = event.role;
        view.status = "claimed";
      }
    } else {
      view.status = event.status;
    }
    // Every failure event increments the attempt counter so the repair loop can
    // bound retries and escalate instead of looping forever.
    if (event.status === "blocked" || event.status === "rejected") {
      view.attempts += 1;
    }
    view.lastSummary = event.summary ?? view.lastSummary;
    view.lastUpdate = event.ts;
  }

  return [...views.values()].sort((a, b) => b.priority - a.priority);
}

/** Open tasks assigned to a role that nobody has claimed yet. */
export function openTasksFor(boardDir: string, role: string): TaskView[] {
  return foldBoard(boardDir).filter(
    (task) => task.assignee === role && task.status === "open"
  );
}

/**
 * Tasks assigned to a role that failed but still have repair attempts left. These are
 * re-dispatched (with the failure context injected) so the team self-heals instead of
 * stranding blocked/rejected work.
 */
export function retryableTasksFor(boardDir: string, role: string, maxRepairs: number): TaskView[] {
  // `maxRepairs` is the number of REPAIRS allowed AFTER the initial attempt, so a task may be
  // dispatched up to `1 + maxRepairs` times. `attempts` already counts the initial attempt, so a
  // task is retryable while the repairs used so far (`attempts - 1`) is below `maxRepairs`, i.e.
  // while `attempts <= maxRepairs`.
  return foldBoard(boardDir).filter(
    (task) =>
      task.assignee === role &&
      (task.status === "blocked" || task.status === "rejected") &&
      task.attempts <= maxRepairs
  );
}

const TERMINAL: TaskStatus[] = ["done", "rejected", "escalated"];

export function isComplete(boardDir: string): boolean {
  const views = foldBoard(boardDir);
  if (!views.length) return false;
  return views.every((task) => TERMINAL.includes(task.status));
}

/**
 * Context an SME should see before working a task: messages addressed to it and the
 * results of its upstream dependencies. This is what makes coordination real — it flips
 * the message log from write-only to load-bearing and lets `dependsOn` carry artifacts,
 * not just ordering.
 */
export function gatherContext(boardDir: string, role: string, task: BoardTask, limit = 8): string {
  const inbox = readMessages(boardDir)
    .filter((m) => m.to === role || m.to === "*")
    .filter((m) => !m.taskId || m.taskId === task.id || task.dependsOn.includes(m.taskId))
    .slice(-limit);
  const upstream = foldBoard(boardDir).filter((t) => task.dependsOn.includes(t.id));

  const sections: string[] = [];
  if (inbox.length) {
    sections.push("## Inbox (messages for you)");
    sections.push(...inbox.map((m) => `- from ${m.from}: ${m.body}`));
  }
  if (upstream.length) {
    sections.push("## Upstream results (your dependencies)");
    sections.push(
      ...upstream.map((t) => `- ${t.id} (${t.assignee}, ${t.status}): ${t.lastSummary ?? "—"}`)
    );
  }
  return sections.join("\n");
}

export function boardSummary(boardDir: string): {
  total: number;
  byStatus: Record<string, number>;
  views: TaskView[];
} {
  const views = foldBoard(boardDir);
  const byStatus: Record<string, number> = {};
  for (const view of views) {
    byStatus[view.status] = (byStatus[view.status] ?? 0) + 1;
  }
  return { total: views.length, byStatus, views };
}

/**
 * Compact the event log so it does not grow unbounded across long runs. Folds to the
 * current state and rewrites a minimal event stream. Guarded by an advisory lock so the
 * orchestrator never compacts while it might race its own future appends. SMEs never
 * call this — only the orchestrator between iterations.
 */
export function compactBoard(boardDir: string): void {
  if (readControlAuthorityMarker(boardDir)) {
    throw new BoardAuthorityError("board compaction is permanently disabled after cutover: canonical control events are retained in full");
  }
  const paths = boardPaths(boardDir);
  const lock = resolve(boardDir, ".compact.lock");
  if (existsSync(lock)) return;
  writeFileSync(lock, String(process.pid));
  try {
    const views = foldBoard(boardDir);
    const lines = views
      .filter((view) => view.lastUpdate)
      .map((view) =>
        JSON.stringify({
          ts: view.lastUpdate ?? view.createdAt,
          role: view.claimedBy ?? view.assignee,
          taskId: view.id,
          status: view.status,
          summary: view.lastSummary
        } satisfies BoardEvent)
      );
    const tmp = `${paths.events}.tmp`;
    writeFileSync(tmp, lines.length ? `${lines.join("\n")}\n` : "");
    renameSync(tmp, paths.events);
  } finally {
    try {
      renameSync(lock, `${lock}.done`);
    } catch {
      // best-effort lock release
    }
  }
}

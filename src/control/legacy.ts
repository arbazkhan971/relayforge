import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { z } from "zod";
import {
  canonicalJson,
  controlEventDigest,
  parseControlEvent,
  type ControlEvent,
  type PersistedControlEvent
} from "./events.js";
import { emptyControlProjection, applyControlEvent, ControlReductionError } from "./reducer.js";
import type { AppendResult, ControlStore } from "./store.js";

const LEGACY_SCHEMA_VERSION = 1 as const;
const RECEIPT_SCHEMA_VERSION = 1 as const;
const DEFAULT_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_RECORD_BYTES = 1024 * 1024;
const DEFAULT_MAX_RECORDS = 100_000;
const DEFAULT_LEAF_LIMITS = {
  tasks: 32 * 1024 * 1024,
  events: 64 * 1024 * 1024,
  messages: 64 * 1024 * 1024,
  loopState: 1024 * 1024
} as const;

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const timestamp = z.string().datetime({ offset: true });
const taskStatus = z.enum(["open", "claimed", "in-progress", "needs-review", "blocked", "done", "rejected", "escalated"]);

const legacyTaskSchema = z.strictObject({
  id,
  title: z.string().min(1).max(1_024),
  assignee: id,
  createdBy: id,
  description: z.string().max(64 * 1024),
  acceptanceCriteria: z.array(z.string().min(1).max(8_192)).max(128),
  dependsOn: z.array(id).max(128),
  priority: z.number().int().min(-1_000_000).max(1_000_000),
  createdAt: timestamp,
  files: z.array(z.string().min(1).max(4_096)).max(1_024).optional()
});

const legacyEventSchema = z.strictObject({
  ts: timestamp,
  role: id,
  taskId: id,
  status: taskStatus,
  summary: z.string().max(4_096).optional()
});

const legacyMessageSchema = z.strictObject({
  ts: timestamp,
  from: id,
  to: id.or(z.literal("*")),
  taskId: id.optional(),
  body: z.string().min(1).max(16_384)
});

const legacyLoopStateSchema = z.strictObject({
  runId: id,
  project: id,
  phase: z.enum(["init", "verify-preflight", "dispatch", "review", "post-check", "stopped", "cancelled", "complete"]),
  status: z.enum(["running", "planned", "blocked", "done", "unverified", "stopped", "cancelled"]),
  iteration: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  dispatched: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  accepted: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  rejected: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  escalations: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  repeatFailures: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  unknownCostCalls: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  runBranch: z.string().min(1).max(4_096).optional(),
  lastGreenCommit: z.string().min(1).max(256).optional(),
  lastFailureSignature: z.string().min(1).max(1_024).optional(),
  lastFailureSummary: z.string().min(1).max(4_096).optional(),
  lastStopReason: z.string().min(1).max(4_096).optional(),
  verifyFingerprint: z.string().min(1).max(1_024).optional(),
  startedAt: timestamp,
  updatedAt: timestamp
});

type LegacyTask = z.infer<typeof legacyTaskSchema>;
type LegacyEvent = z.infer<typeof legacyEventSchema>;
type LegacyMessage = z.infer<typeof legacyMessageSchema>;
type LegacyLoopState = z.infer<typeof legacyLoopStateSchema>;

export type LegacyLeafKind = "tasks" | "events" | "messages" | "loopState";

export type LegacySourcePaths = {
  tasks: string;
  events: string;
  messages: string;
  loopState: string;
};

export type LegacyLeafInventory = {
  kind: LegacyLeafKind;
  path: string;
  bytes: number;
  sha256: string;
  dev: string;
  ino: string;
  uid: string;
  mode: number;
  records: number;
  lastCompleteOffset: number;
  recordRanges: Array<{ line: number; start: number; end: number; sha256: string }>;
  tornFinal?: { start: number; end: number; sha256: string };
};

export type LegacyDiagnostic = {
  severity: "disclosure" | "lossy" | "unsupported";
  code: string;
  message: string;
  leaf?: LegacyLeafKind;
  line?: number;
  start?: number;
  end?: number;
};

export type LegacyImportPlan = {
  schemaVersion: typeof LEGACY_SCHEMA_VERSION;
  planId: string;
  runId: string;
  runEpoch: string;
  manifestDigest: string;
  inventory: Record<LegacyLeafKind, LegacyLeafInventory>;
  events: ControlEvent[];
  eventDigests: string[];
  diagnostics: LegacyDiagnostic[];
  appendable: boolean;
  requiresLossAcknowledgement: boolean;
};

export type LegacyImportErrorReason =
  | "MISSING_LEAF"
  | "UNSAFE_LEAF"
  | "LIMIT_EXCEEDED"
  | "MALFORMED_INTERIOR"
  | "UNKNOWN_RECORD"
  | "DUPLICATE_RECORD"
  | "CONFLICTING_RECORD"
  | "IMPOSSIBLE_RECORD"
  | "SOURCE_CHANGED"
  | "RECEIPT_CONFLICT"
  | "IMPORT_UNSUPPORTED";

export class LegacyImportError extends Error {
  readonly code = "RECOVERY_REQUIRED" as const;
  readonly reasonCode: LegacyImportErrorReason;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(reasonCode: LegacyImportErrorReason, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "LegacyImportError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

export type LegacyFaultPoint =
  | "before-inventory"
  | "after-inventory"
  | "before-plan"
  | "after-plan"
  | "before-import"
  | "after-import"
  | "before-receipt"
  | "after-receipt"
  | "before-archive-decision"
  | "after-archive-decision";

export type PlanLegacyImportOptions = {
  paths: LegacySourcePaths;
  runId: string;
  runEpoch: string;
  maxTotalBytes?: number;
  maxRecordBytes?: number;
  maxRecords?: number;
  leafLimits?: Partial<Record<LegacyLeafKind, number>>;
  fault?: (point: LegacyFaultPoint) => void;
};

type ParsedRecord<T> = {
  value: T;
  line: number;
  start: number;
  end: number;
  canonical: string;
  sha256: string;
};

type PinnedLeaf = {
  inventory: LegacyLeafInventory;
  bytes: Buffer;
};

type ParsedLegacy = {
  inventory: Record<LegacyLeafKind, LegacyLeafInventory>;
  tasks: ParsedRecord<LegacyTask>[];
  events: ParsedRecord<LegacyEvent>[];
  messages: ParsedRecord<LegacyMessage>[];
  loopState: ParsedRecord<LegacyLoopState>;
  diagnostics: LegacyDiagnostic[];
};

export type LegacyImportReceipt = {
  schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  planId: string;
  manifestDigest: string;
  runId: string;
  runEpoch: string;
  headBefore: number;
  headAfter: number;
  events: Array<{ eventId: string; seq: number; intentDigest: string; digest: string; recordedAt: string }>;
  inventory: Record<LegacyLeafKind, LegacyLeafInventory>;
  diagnostics: LegacyDiagnostic[];
  lossAcknowledged: boolean;
  archiveDecision: LegacyArchiveDecision;
  createdAt: string;
};

export type LegacyArchiveDecision = {
  decision: "COPY_EXACT_SOURCES_TO_PRIVATE_ARCHIVE";
  archiveName: string;
  manifestDigest: string;
  retainOriginals: true;
  productCutoverAllowed: true;
  reason: string;
};

export type ExecuteLegacyImportOptions = {
  receiptPath: string;
  allowDisclosedLoss?: boolean;
  now?: () => string;
  fault?: (point: LegacyFaultPoint) => void;
};

export type LegacyImportExecution = {
  receipt: LegacyImportReceipt;
  archiveDecision: LegacyArchiveDecision;
  idempotent: boolean;
};

export type LegacyImportStore = Pick<ControlStore, "appendBatch" | "readRange">;

const rangeSchema = z.strictObject({
  line: z.number().int().min(1),
  start: z.number().int().min(0),
  end: z.number().int().min(0),
  sha256: z.string().regex(/^[a-f0-9]{64}$/)
});
const leafInventorySchema = z.strictObject({
  kind: z.enum(["tasks", "events", "messages", "loopState"]),
  path: z.string().min(1).max(16_384),
  bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  dev: z.string().regex(/^\d+$/),
  ino: z.string().regex(/^\d+$/),
  uid: z.string().regex(/^\d+$/),
  mode: z.number().int().min(0).max(0o777),
  records: z.number().int().min(0).max(DEFAULT_MAX_RECORDS),
  lastCompleteOffset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  recordRanges: z.array(rangeSchema).max(DEFAULT_MAX_RECORDS),
  tornFinal: z.strictObject({
    start: z.number().int().min(0),
    end: z.number().int().min(0),
    sha256: z.string().regex(/^[a-f0-9]{64}$/)
  }).optional()
});
const inventorySchema = z.strictObject({
  tasks: leafInventorySchema,
  events: leafInventorySchema,
  messages: leafInventorySchema,
  loopState: leafInventorySchema
});
const diagnosticSchema = z.strictObject({
  severity: z.enum(["disclosure", "lossy", "unsupported"]),
  code: z.string().min(1).max(128),
  message: z.string().min(1).max(4_096),
  leaf: z.enum(["tasks", "events", "messages", "loopState"]).optional(),
  line: z.number().int().min(1).optional(),
  start: z.number().int().min(0).optional(),
  end: z.number().int().min(0).optional()
});
const archiveDecisionSchema = z.strictObject({
  decision: z.literal("COPY_EXACT_SOURCES_TO_PRIVATE_ARCHIVE"),
  archiveName: z.string().regex(/^legacy-[a-f0-9]{64}$/),
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  retainOriginals: z.literal(true),
  productCutoverAllowed: z.literal(true),
  reason: z.string().min(1).max(4_096)
});
const receiptSchema: z.ZodType<LegacyImportReceipt> = z.strictObject({
  schemaVersion: z.literal(RECEIPT_SCHEMA_VERSION),
  planId: z.string().regex(/^[a-f0-9]{64}$/),
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  runId: id,
  runEpoch: id,
  headBefore: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  headAfter: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  events: z.array(z.strictObject({
    eventId: id,
    seq: z.number().int().min(1),
    intentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    recordedAt: timestamp
  })).max(DEFAULT_MAX_RECORDS),
  inventory: inventorySchema,
  diagnostics: z.array(diagnosticSchema).max(DEFAULT_MAX_RECORDS),
  lossAcknowledged: z.boolean(),
  archiveDecision: archiveDecisionSchema,
  createdAt: timestamp
});

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifestDigest(inventory: Record<LegacyLeafKind, LegacyLeafInventory>): string {
  return hashBytes(Buffer.from(canonicalJson(Object.fromEntries(
    (["tasks", "events", "messages", "loopState"] as const).map((kind) => [kind, inventory[kind]])
  )), "utf8"));
}

function legacyEventId(manifest: string, kind: string, start: number, canonical: string): string {
  const digest = hashBytes(Buffer.from(`${manifest}\0${kind}\0${start}\0${canonical}`, "utf8"));
  return `legacy.v1.${kind}.${digest.slice(0, 48)}`;
}

function safeNumber(value: bigint, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new LegacyImportError("LIMIT_EXCEEDED", `${label} is outside the safe integer range`);
  return number;
}

function readPinnedLeaf(kind: LegacyLeafKind, path: string, maxBytes: number): PinnedLeaf {
  const absolute = resolve(path);
  let beforePath: ReturnType<typeof lstatSync>;
  try {
    beforePath = lstatSync(absolute, { bigint: true });
  } catch (error) {
    throw new LegacyImportError("MISSING_LEAF", `legacy ${kind} leaf is missing`, { path: absolute, cause: String(error) });
  }
  const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.nlink !== 1n) {
    throw new LegacyImportError("UNSAFE_LEAF", `legacy ${kind} leaf must be one regular, non-symlink, single-link file`, { path: absolute });
  }
  if (uid !== undefined && beforePath.uid !== uid) throw new LegacyImportError("UNSAFE_LEAF", `legacy ${kind} leaf belongs to another uid`, { path: absolute });
  if ((beforePath.mode & 0o077n) !== 0n) throw new LegacyImportError("UNSAFE_LEAF", `legacy ${kind} leaf permissions expose it to group/other`, { path: absolute });
  const size = safeNumber(beforePath.size, `${kind} size`);
  if (size > maxBytes) throw new LegacyImportError("LIMIT_EXCEEDED", `legacy ${kind} leaf exceeds ${maxBytes} bytes`, { bytes: size });

  let fd: number | undefined;
  try {
    fd = openSync(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd, { bigint: true });
    if (opened.dev !== beforePath.dev || opened.ino !== beforePath.ino) throw new LegacyImportError("SOURCE_CHANGED", `legacy ${kind} identity changed before read`);
    const bytes = readFileSync(fd);
    const afterFd = fstatSync(fd, { bigint: true });
    const afterPath = lstatSync(absolute, { bigint: true });
    if (
      bytes.length !== size ||
      afterFd.dev !== opened.dev || afterFd.ino !== opened.ino || afterFd.size !== opened.size ||
      afterFd.mtimeNs !== opened.mtimeNs || afterFd.ctimeNs !== opened.ctimeNs ||
      afterPath.dev !== opened.dev || afterPath.ino !== opened.ino
    ) {
      throw new LegacyImportError("SOURCE_CHANGED", `legacy ${kind} changed while being inventoried`);
    }
    return {
      bytes,
      inventory: {
        kind,
        path: absolute,
        bytes: bytes.length,
        sha256: hashBytes(bytes),
        dev: opened.dev.toString(),
        ino: opened.ino.toString(),
        uid: opened.uid.toString(),
        mode: Number(opened.mode & 0o777n),
        records: 0,
        lastCompleteOffset: 0,
        recordRanges: []
      }
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseLine<T>(
  kind: LegacyLeafKind,
  bytes: Buffer,
  start: number,
  end: number,
  line: number,
  schema: z.ZodType<T>,
  finalUnterminated: boolean
): ParsedRecord<T> | { torn: true; start: number; end: number; sha256: string } {
  if (end - start > DEFAULT_MAX_RECORD_BYTES) {
    throw new LegacyImportError("LIMIT_EXCEEDED", `legacy ${kind} line ${line} exceeds the record byte limit`, { start, end });
  }
  const slice = bytes.subarray(start, end);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(slice);
  } catch {
    if (finalUnterminated) return { torn: true, start, end, sha256: hashBytes(slice) };
    throw new LegacyImportError("MALFORMED_INTERIOR", `legacy ${kind} line ${line} contains invalid UTF-8`, { start, end });
  }
  if (!text.trim()) throw new LegacyImportError("MALFORMED_INTERIOR", `legacy ${kind} contains an empty record at line ${line}`, { start, end });
  let unknown: unknown;
  try {
    unknown = JSON.parse(text);
  } catch {
    if (finalUnterminated) return { torn: true, start, end, sha256: hashBytes(slice) };
    throw new LegacyImportError("MALFORMED_INTERIOR", `legacy ${kind} line ${line} is malformed JSON`, { start, end });
  }
  let value: T;
  try {
    value = schema.parse(unknown);
  } catch (error) {
    throw new LegacyImportError("UNKNOWN_RECORD", `legacy ${kind} line ${line} violates its closed schema`, {
      start,
      end,
      cause: error instanceof Error ? error.message.slice(0, 2_048) : String(error)
    });
  }
  const canonical = canonicalJson(value);
  return { value, line, start, end, canonical, sha256: hashBytes(slice) };
}

function parseJsonl<T>(kind: "tasks" | "events" | "messages", leaf: PinnedLeaf, schema: z.ZodType<T>, maxRecordBytes: number, maxRecords: number): { records: ParsedRecord<T>[]; diagnostic?: LegacyDiagnostic } {
  const records: ParsedRecord<T>[] = [];
  let start = 0;
  let line = 1;
  let lastCompleteOffset = 0;
  for (let index = 0; index < leaf.bytes.length; index += 1) {
    if (leaf.bytes[index] !== 0x0a) continue;
    if (index - start > maxRecordBytes) throw new LegacyImportError("LIMIT_EXCEEDED", `legacy ${kind} line ${line} exceeds ${maxRecordBytes} bytes`);
    const record = parseLine(kind, leaf.bytes, start, index, line, schema, false);
    if ("torn" in record) throw new LegacyImportError("MALFORMED_INTERIOR", `legacy ${kind} line ${line} is unexpectedly torn`);
    records.push(record);
    if (records.length > maxRecords) throw new LegacyImportError("LIMIT_EXCEEDED", `legacy ${kind} has more than ${maxRecords} records`);
    lastCompleteOffset = index + 1;
    start = index + 1;
    line += 1;
  }

  let diagnostic: LegacyDiagnostic | undefined;
  if (start < leaf.bytes.length) {
    if (leaf.bytes.length - start > maxRecordBytes) throw new LegacyImportError("LIMIT_EXCEEDED", `legacy ${kind} final fragment exceeds ${maxRecordBytes} bytes`);
    const record = parseLine(kind, leaf.bytes, start, leaf.bytes.length, line, schema, true);
    if ("torn" in record) {
      leaf.inventory.tornFinal = { start: record.start, end: record.end, sha256: record.sha256 };
      diagnostic = {
        severity: "unsupported",
        code: "TORN_FINAL_FRAGMENT",
        message: `invalid unterminated final ${kind} fragment was classified as torn and was not imported`,
        leaf: kind,
        line,
        start,
        end: leaf.bytes.length
      };
    } else {
      // A valid JSON value does not become torn merely because the final newline is absent.
      records.push(record);
      lastCompleteOffset = leaf.bytes.length;
    }
  }
  leaf.inventory.records = records.length;
  leaf.inventory.lastCompleteOffset = lastCompleteOffset;
  leaf.inventory.recordRanges = records.map((record) => ({
    line: record.line,
    start: record.start,
    end: record.end,
    sha256: record.sha256
  }));
  return { records, diagnostic };
}

function parseState(leaf: PinnedLeaf): ParsedRecord<LegacyLoopState> {
  if (leaf.bytes.length === 0) throw new LegacyImportError("MALFORMED_INTERIOR", "legacy loop state is empty");
  const record = parseLine("loopState", leaf.bytes, 0, leaf.bytes.length, 1, legacyLoopStateSchema, false);
  if ("torn" in record) throw new LegacyImportError("MALFORMED_INTERIOR", "legacy loop state is torn");
  leaf.inventory.records = 1;
  leaf.inventory.lastCompleteOffset = leaf.bytes.length;
  leaf.inventory.recordRanges = [{ line: 1, start: 0, end: leaf.bytes.length, sha256: record.sha256 }];
  return record;
}

function inspect(options: PlanLegacyImportOptions): ParsedLegacy {
  options.fault?.("before-inventory");
  const limits = { ...DEFAULT_LEAF_LIMITS, ...options.leafLimits };
  const leaves = {
    tasks: readPinnedLeaf("tasks", options.paths.tasks, limits.tasks),
    events: readPinnedLeaf("events", options.paths.events, limits.events),
    messages: readPinnedLeaf("messages", options.paths.messages, limits.messages),
    loopState: readPinnedLeaf("loopState", options.paths.loopState, limits.loopState)
  };
  const total = Object.values(leaves).reduce((sum, leaf) => sum + leaf.bytes.length, 0);
  if (total > (options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES)) {
    throw new LegacyImportError("LIMIT_EXCEEDED", "legacy source set exceeds the total byte limit", { total });
  }
  const maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  const tasks = parseJsonl("tasks", leaves.tasks, legacyTaskSchema, maxRecordBytes, maxRecords);
  const events = parseJsonl("events", leaves.events, legacyEventSchema, maxRecordBytes, maxRecords);
  const messages = parseJsonl("messages", leaves.messages, legacyMessageSchema, maxRecordBytes, maxRecords);
  const loopState = parseState(leaves.loopState);
  const inventory = {
    tasks: leaves.tasks.inventory,
    events: leaves.events.inventory,
    messages: leaves.messages.inventory,
    loopState: leaves.loopState.inventory
  };
  options.fault?.("after-inventory");
  return {
    inventory,
    tasks: tasks.records,
    events: events.records,
    messages: messages.records,
    loopState,
    diagnostics: [tasks.diagnostic, events.diagnostic, messages.diagnostic].filter((value): value is LegacyDiagnostic => value !== undefined)
  };
}

function assertDependencyGraph(tasks: readonly ParsedRecord<LegacyTask>[]): void {
  const ids = new Set(tasks.map((record) => record.value.id));
  for (const record of tasks) {
    for (const dependency of record.value.dependsOn) {
      if (!ids.has(dependency)) throw new LegacyImportError("IMPOSSIBLE_RECORD", `task ${record.value.id} depends on missing task ${dependency}`, { line: record.line });
      if (dependency === record.value.id) throw new LegacyImportError("IMPOSSIBLE_RECORD", `task ${record.value.id} depends on itself`, { line: record.line });
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tasks.map((record) => [record.value.id, record.value]));
  const visit = (taskId: string): void => {
    if (visiting.has(taskId)) throw new LegacyImportError("IMPOSSIBLE_RECORD", `legacy task dependency cycle includes ${taskId}`);
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependency of byId.get(taskId)?.dependsOn ?? []) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const taskId of ids) visit(taskId);
}

function loopDiagnostics(state: LegacyLoopState): LegacyDiagnostic[] {
  const diagnostics: LegacyDiagnostic[] = [{
    severity: "disclosure",
    code: "LEGACY_TASK_REOPEN_IDENTITY_UNAVAILABLE",
    message: "legacy JSONL has no explicit reopen identity; duplicate task IDs are refused rather than assigned an invented generation"
  }];
  if (["blocked", "unverified", "stopped"].includes(state.status)) {
    diagnostics.push({
      severity: "lossy",
      code: "LEGACY_TERMINAL_STATUS_COARSENED",
      message: `legacy run status ${state.status} can only be represented as run.failed in v1`,
      leaf: "loopState"
    });
  }
  return diagnostics;
}

function validateLegacyConsistency(parsed: ParsedLegacy, runId: string): void {
  if (parsed.loopState.value.runId !== runId) {
    throw new LegacyImportError("CONFLICTING_RECORD", "legacy loop state runId does not match the requested run", {
      expected: runId,
      actual: parsed.loopState.value.runId
    });
  }
  const taskIds = new Set<string>();
  for (const record of parsed.tasks) {
    if (taskIds.has(record.value.id)) throw new LegacyImportError("DUPLICATE_RECORD", `duplicate legacy task id ${record.value.id}`, { line: record.line });
    taskIds.add(record.value.id);
  }
  assertDependencyGraph(parsed.tasks);
  const claimed = new Map<string, string>();
  for (const record of parsed.events) {
    if (!taskIds.has(record.value.taskId)) throw new LegacyImportError("IMPOSSIBLE_RECORD", `legacy event references missing task ${record.value.taskId}`, { line: record.line });
    if (record.value.status === "claimed") {
      const prior = claimed.get(record.value.taskId);
      if (prior && prior !== record.value.role) {
        throw new LegacyImportError("CONFLICTING_RECORD", `legacy task ${record.value.taskId} has competing claimants ${prior} and ${record.value.role}`, { line: record.line });
      }
      claimed.set(record.value.taskId, record.value.role);
    }
  }
  for (const record of parsed.messages) {
    if (record.value.taskId && !taskIds.has(record.value.taskId)) {
      throw new LegacyImportError("IMPOSSIBLE_RECORD", `legacy message references missing task ${record.value.taskId}`, { line: record.line });
    }
  }
  const state = parsed.loopState.value;
  if (state.accepted > state.dispatched || state.escalations > state.dispatched) {
    throw new LegacyImportError("IMPOSSIBLE_RECORD", "legacy loop counters contradict dispatched work");
  }
  if (state.status === "done" && state.phase !== "complete") throw new LegacyImportError("IMPOSSIBLE_RECORD", "legacy done run is not in complete phase");
  if (state.status === "cancelled" && state.phase !== "cancelled") throw new LegacyImportError("IMPOSSIBLE_RECORD", "legacy cancelled run is not in cancelled phase");
  if (state.status === "stopped" && state.phase !== "stopped") throw new LegacyImportError("IMPOSSIBLE_RECORD", "legacy stopped run is not in stopped phase");
}

function makeEvent(input: unknown): ControlEvent {
  try {
    return parseControlEvent(input);
  } catch (error) {
    throw new LegacyImportError("IMPORT_UNSUPPORTED", "legacy fact cannot be represented by the current closed event schema", {
      cause: error instanceof Error ? error.message.slice(0, 2_048) : String(error)
    });
  }
}

function makeLegacyEvent(manifest: string, input: Record<string, unknown>): ControlEvent {
  const eventId = input.eventId;
  if (typeof eventId !== "string") throw new LegacyImportError("IMPORT_UNSUPPORTED", "legacy event identity is missing");
  return makeEvent({
    ...input,
    actorKind: "migration",
    actorId: "legacy-import",
    sourceKind: "legacy-jsonl",
    sourceId: manifest,
    sourceGeneration: 1,
    sourceEventId: eventId
  });
}

function buildEvents(parsed: ParsedLegacy, runId: string, runEpoch: string, manifest: string): { events: ControlEvent[]; diagnostics: LegacyDiagnostic[] } {
  const diagnostics = [...parsed.diagnostics, ...loopDiagnostics(parsed.loopState.value), {
    severity: "disclosure" as const,
    code: "CROSS_LOG_ORDER_UNPROVABLE",
    message: "legacy JSONL files have independent physical order; import uses run-start, task, status, message, run-terminal order and does not infer authority from timestamps"
  }, {
    severity: "lossy" as const,
    code: "COMPACTION_HISTORY_UNPROVEN",
    message: "legacy events.jsonl has no compaction receipt, so the manifest cannot prove that pre-compaction claim/attempt history is complete",
    leaf: "events" as const
  }];
  const output: ControlEvent[] = [];
  let runVersion = 0;
  const taskVersions = new Map<string, number>();
  const state = parsed.loopState.value;
  output.push(makeLegacyEvent(manifest, {
    schemaVersion: 1,
    eventId: legacyEventId(manifest, "run-start", parsed.loopState.start, parsed.loopState.canonical),
    runId,
    runEpoch,
    taskId: null,
    taskGeneration: null,
    expectedVersion: runVersion,
    occurredAt: state.startedAt,
    type: "run.started",
    payload: { startedBy: "legacy-import" }
  }));
  runVersion += 1;

  for (const record of parsed.tasks) {
    const task = record.value;
    output.push(makeLegacyEvent(manifest, {
      schemaVersion: 1,
      eventId: legacyEventId(manifest, "task", record.start, record.canonical),
      runId,
      runEpoch,
      taskId: task.id,
      taskGeneration: 1,
      expectedVersion: 0,
      occurredAt: task.createdAt,
      type: "task.created",
      payload: {
        title: task.title,
        assignee: task.assignee,
        createdBy: task.createdBy,
        description: task.description,
        acceptanceCriteria: task.acceptanceCriteria,
        dependsOn: task.dependsOn,
        priority: task.priority,
        createdAt: task.createdAt,
        ...(task.files ? { files: task.files } : {})
      }
    }));
    taskVersions.set(task.id, 1);
  }

  const claimed = new Set<string>();
  for (const record of parsed.events) {
    const fact = record.value;
    if (fact.status !== "claimed" && !claimed.has(fact.taskId) && ["in-progress", "needs-review", "done", "rejected"].includes(fact.status)) {
      diagnostics.push({
        severity: "unsupported",
        code: "COMPACTION_LOSS_DETECTED",
        message: `task ${fact.taskId} reaches ${fact.status} without a retained claim event`,
        leaf: "events",
        line: record.line,
        start: record.start,
        end: record.end
      });
    }
    if (fact.status === "claimed") claimed.add(fact.taskId);
    const version = taskVersions.get(fact.taskId)!;
    output.push(makeLegacyEvent(manifest, {
      schemaVersion: 1,
      eventId: legacyEventId(manifest, "status", record.start, record.canonical),
      runId,
      runEpoch,
      taskId: fact.taskId,
      taskGeneration: 1,
      expectedVersion: version,
      occurredAt: fact.ts,
      type: "task.status_changed",
      payload: { role: fact.role, status: fact.status, ...(fact.summary === undefined ? {} : { summary: fact.summary }) }
    }));
    taskVersions.set(fact.taskId, version + 1);
  }

  for (const record of parsed.messages) {
    const fact = record.value;
    const version = fact.taskId ? taskVersions.get(fact.taskId)! : runVersion;
    const messageId = legacyEventId(manifest, "message-id", record.start, record.canonical);
    output.push(makeLegacyEvent(manifest, {
      schemaVersion: 1,
      eventId: legacyEventId(manifest, "message", record.start, record.canonical),
      runId,
      runEpoch,
      taskId: fact.taskId ?? null,
      taskGeneration: fact.taskId ? 1 : null,
      expectedVersion: version,
      occurredAt: fact.ts,
      type: "message.posted",
      payload: { messageId, from: fact.from, to: fact.to, body: fact.body }
    }));
    if (fact.taskId) taskVersions.set(fact.taskId, version + 1);
    else runVersion += 1;
  }

  output.push(makeLegacyEvent(manifest, {
    schemaVersion: 1,
    eventId: legacyEventId(manifest, "run-checkpoint", parsed.loopState.start, parsed.loopState.canonical),
    runId,
    runEpoch,
    taskId: null,
    taskGeneration: null,
    expectedVersion: runVersion,
    occurredAt: state.updatedAt,
    type: "run.checkpointed",
    payload: {
      project: state.project,
      phase: state.phase,
      status: state.status,
      iteration: state.iteration,
      dispatched: state.dispatched,
      accepted: state.accepted,
      rejected: state.rejected,
      escalations: state.escalations,
      repeatFailures: state.repeatFailures,
      unknownCostCalls: state.unknownCostCalls,
      ...(state.runBranch ? { runBranch: state.runBranch } : {}),
      ...(state.lastGreenCommit ? { lastGreenCommit: state.lastGreenCommit } : {}),
      ...(state.lastFailureSignature ? { lastFailureSignature: state.lastFailureSignature } : {}),
      ...(state.lastFailureSummary ? { lastFailureSummary: state.lastFailureSummary } : {}),
      ...(state.lastStopReason ? { lastStopReason: state.lastStopReason } : {}),
      ...(state.verifyFingerprint ? { verifyFingerprint: state.verifyFingerprint } : {}),
      startedAt: state.startedAt,
      updatedAt: state.updatedAt
    }
  }));
  runVersion += 1;

  let terminal: "run.completed" | "run.failed" | "run.cancelled" | undefined;
  if (state.status === "done") terminal = "run.completed";
  else if (state.status === "cancelled") terminal = "run.cancelled";
  else if (["blocked", "unverified", "stopped"].includes(state.status)) terminal = "run.failed";
  if (terminal) {
    const payload = terminal === "run.completed"
      ? { summary: "legacy run completed" }
      : terminal === "run.cancelled"
        ? { cancelledBy: "legacy-import", ...(state.lastStopReason ? { reason: state.lastStopReason } : {}) }
        : { reasonCode: `legacy_${state.status}`, ...(state.lastFailureSummary || state.lastStopReason ? { summary: state.lastFailureSummary ?? state.lastStopReason } : {}) };
    output.push(makeLegacyEvent(manifest, {
      schemaVersion: 1,
      eventId: legacyEventId(manifest, "run-terminal", parsed.loopState.start, `${parsed.loopState.canonical}\0${terminal}`),
      runId,
      runEpoch,
      taskId: null,
      taskGeneration: null,
      expectedVersion: runVersion,
      occurredAt: state.updatedAt,
      type: terminal,
      payload
    }));
  }
  return { events: output, diagnostics };
}

function characterizeAppendability(events: readonly ControlEvent[], runId: string, runEpoch: string, diagnostics: LegacyDiagnostic[]): boolean {
  let state = emptyControlProjection(runId, runEpoch);
  for (const [index, event] of events.entries()) {
    try {
      const intentDigest = controlEventDigest(event);
      state = applyControlEvent(state, {
        ...event,
        seq: index + 1,
        recordedAt: event.occurredAt,
        intentDigest,
        digest: intentDigest
      });
    } catch (error) {
      if (!(error instanceof ControlReductionError)) throw error;
      diagnostics.push({
        severity: "unsupported",
        code: "CURRENT_REDUCER_CANNOT_REPRESENT_LEGACY_HISTORY",
        message: `event ${event.eventId} is not appendable without inventing or dropping a fact: ${error.message}`
      });
      return false;
    }
  }
  return true;
}

export function planLegacyImport(options: PlanLegacyImportOptions): LegacyImportPlan {
  const parsed = inspect(options);
  options.fault?.("before-plan");
  validateLegacyConsistency(parsed, options.runId);
  const digest = manifestDigest(parsed.inventory);
  const built = buildEvents(parsed, options.runId, options.runEpoch, digest);
  const appendableByReducer = characterizeAppendability(built.events, options.runId, options.runEpoch, built.diagnostics);
  const appendable = appendableByReducer && !built.diagnostics.some((diagnostic) => diagnostic.severity === "unsupported");
  const eventDigests = built.events.map(controlEventDigest);
  const planId = hashBytes(Buffer.from(canonicalJson({
    schemaVersion: LEGACY_SCHEMA_VERSION,
    runId: options.runId,
    runEpoch: options.runEpoch,
    manifestDigest: digest,
    events: built.events.map((event, index) => ({ eventId: event.eventId, digest: eventDigests[index] })),
    diagnostics: built.diagnostics
  }), "utf8"));
  const plan: LegacyImportPlan = {
    schemaVersion: LEGACY_SCHEMA_VERSION,
    planId,
    runId: options.runId,
    runEpoch: options.runEpoch,
    manifestDigest: digest,
    inventory: parsed.inventory,
    events: built.events,
    eventDigests,
    diagnostics: built.diagnostics,
    appendable,
    requiresLossAcknowledgement: built.diagnostics.some((diagnostic) => diagnostic.severity === "lossy")
  };
  options.fault?.("after-plan");
  return plan;
}

function compareInventory(expected: LegacyLeafInventory, actual: LegacyLeafInventory): boolean {
  return expected.kind === actual.kind && expected.path === actual.path && expected.bytes === actual.bytes &&
    expected.sha256 === actual.sha256 && expected.dev === actual.dev && expected.ino === actual.ino &&
    expected.uid === actual.uid && expected.mode === actual.mode;
}

export function revalidateLegacySources(plan: LegacyImportPlan): void {
  for (const kind of ["tasks", "events", "messages", "loopState"] as const) {
    const expected = plan.inventory[kind];
    let current: PinnedLeaf;
    try {
      current = readPinnedLeaf(kind, expected.path, Math.max(expected.bytes, DEFAULT_LEAF_LIMITS[kind]));
    } catch (error) {
      if (error instanceof LegacyImportError && error.reasonCode !== "UNSAFE_LEAF") {
        throw new LegacyImportError("SOURCE_CHANGED", `legacy ${kind} source cannot be revalidated`, { cause: error.message });
      }
      throw error;
    }
    if (!compareInventory(expected, current.inventory)) {
      throw new LegacyImportError("SOURCE_CHANGED", `legacy ${kind} source changed after planning`, {
        expectedSha256: expected.sha256,
        actualSha256: current.inventory.sha256
      });
    }
  }
}

function readPrivateReceipt(path: string): LegacyImportReceipt | undefined {
  try {
    const leaf = readPinnedLeaf("loopState", path, 64 * 1024 * 1024);
    const parsed = receiptSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(leaf.bytes)));
    return parsed;
  } catch (error) {
    if (error instanceof LegacyImportError && error.reasonCode === "MISSING_LEAF") return undefined;
    if (error instanceof LegacyImportError) throw error;
    throw new LegacyImportError("RECEIPT_CONFLICT", "legacy import receipt is malformed or has an unknown schema", {
      cause: error instanceof Error ? error.message.slice(0, 2_048) : String(error)
    });
  }
}

function durableWritePrivate(path: string, value: unknown): void {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = lstatSync(parent, { bigint: true });
  const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || (uid !== undefined && parentStat.uid !== uid) || (parentStat.mode & 0o077n) !== 0n) {
    throw new LegacyImportError("UNSAFE_LEAF", "receipt parent must be a private owned directory", { path: parent });
  }
  const body = `${canonicalJson(value)}\n`;
  if (Buffer.byteLength(body, "utf8") > 64 * 1024 * 1024) throw new LegacyImportError("LIMIT_EXCEEDED", "legacy import receipt exceeds 64 MiB");
  const temporary = `${absolute}.tmp-${process.pid}-${randomUUID()}`;
  let fd: number | undefined;
  let published = false;
  try {
    fd = openSync(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, body, { encoding: "utf8" });
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, absolute);
    published = true;
    const directoryFd = openSync(parent, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (!published) {
      try {
        unlinkSync(temporary);
      } catch {
        // The temporary was never authoritative; a missing leaf needs no recovery action.
      }
    }
  }
}

function assertReceiptMatchesPlan(receipt: LegacyImportReceipt, plan: LegacyImportPlan): void {
  if (receipt.planId !== plan.planId || receipt.manifestDigest !== plan.manifestDigest || receipt.runId !== plan.runId || receipt.runEpoch !== plan.runEpoch) {
    throw new LegacyImportError("RECEIPT_CONFLICT", "legacy import receipt belongs to different source bytes or run identity");
  }
  if (canonicalJson(receipt.inventory) !== canonicalJson(plan.inventory) || receipt.events.length !== plan.events.length) {
    throw new LegacyImportError("RECEIPT_CONFLICT", "legacy import receipt inventory/event count differs from the plan");
  }
  for (const [index, event] of plan.events.entries()) {
    const recorded = receipt.events[index];
    if (!recorded || recorded.eventId !== event.eventId || recorded.intentDigest !== plan.eventDigests[index]) {
      throw new LegacyImportError("RECEIPT_CONFLICT", `legacy import receipt event ${index} differs from the plan`);
    }
  }
  const firstSeq = receipt.events[0]!.seq;
  const lastSeq = receipt.events.at(-1)!.seq;
  if (
    receipt.events.some((event, index) => event.seq !== firstSeq + index) ||
    receipt.headBefore !== firstSeq - 1 ||
    receipt.headAfter !== lastSeq ||
    receipt.lossAcknowledged !== plan.requiresLossAcknowledgement ||
    canonicalJson(receipt.archiveDecision) !== canonicalJson(archiveDecisionForPlan(plan))
  ) {
    throw new LegacyImportError("RECEIPT_CONFLICT", "legacy import receipt sequence boundary or loss acknowledgement is inconsistent");
  }
}

function verifyReceiptEvents(store: LegacyImportStore, receipt: LegacyImportReceipt): void {
  const expected = new Map(receipt.events.map((event) => [event.eventId, event]));
  let cursor = 0;
  while (expected.size > 0) {
    const range = store.readRange({ afterSeq: cursor, limit: 10_000, runEpoch: receipt.runEpoch });
    for (const event of range.events) {
      const receiptEvent = expected.get(event.eventId);
      if (!receiptEvent) continue;
      if (receiptEvent.seq !== event.seq || receiptEvent.intentDigest !== event.intentDigest ||
          receiptEvent.digest !== event.digest || receiptEvent.recordedAt !== event.recordedAt) {
        throw new LegacyImportError("RECEIPT_CONFLICT", `receipt event ${event.eventId} differs from canonical history`);
      }
      expected.delete(event.eventId);
    }
    if (!range.hasMore) break;
    cursor = range.events.at(-1)!.seq;
  }
  if (expected.size > 0) throw new LegacyImportError("RECEIPT_CONFLICT", "receipt names events absent from canonical history", { missing: [...expected.keys()].slice(0, 16) });
}

export function decideLegacyArchive(plan: LegacyImportPlan, receipt: LegacyImportReceipt): LegacyArchiveDecision {
  if (!plan.appendable) {
    throw new LegacyImportError("IMPORT_UNSUPPORTED", "legacy history is not representable by the canonical authority");
  }
  assertReceiptMatchesPlan(receipt, plan);
  revalidateLegacySources(plan);
  return receipt.archiveDecision;
}

function archiveDecisionForPlan(plan: LegacyImportPlan): LegacyArchiveDecision {
  return {
    decision: "COPY_EXACT_SOURCES_TO_PRIVATE_ARCHIVE",
    archiveName: `legacy-${plan.manifestDigest}`,
    manifestDigest: plan.manifestDigest,
    retainOriginals: true,
    productCutoverAllowed: true,
    reason: "canonical import, durable receipt, exact source revalidation, and acknowledged loss make a one-way reader cutover eligible; originals remain retained for recovery proof"
  };
}

function receiptFromResults(plan: LegacyImportPlan, results: readonly AppendResult[], lossAcknowledged: boolean, createdAt: string): LegacyImportReceipt {
  if (results.length !== plan.events.length) throw new LegacyImportError("RECEIPT_CONFLICT", "store returned an incomplete import result set");
  const firstSeq = results[0]!.seq;
  if (results.some((result, index) => result.seq !== firstSeq + index)) {
    throw new LegacyImportError("RECEIPT_CONFLICT", "legacy import events are not one contiguous canonical transaction range");
  }
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    planId: plan.planId,
    manifestDigest: plan.manifestDigest,
    runId: plan.runId,
    runEpoch: plan.runEpoch,
    headBefore: firstSeq - 1,
    headAfter: results.at(-1)!.seq,
    events: results.map((result) => ({
      eventId: result.eventId,
      seq: result.seq,
      intentDigest: result.intentDigest,
      digest: result.digest,
      recordedAt: result.recordedAt
    })),
    inventory: plan.inventory,
    diagnostics: plan.diagnostics,
    lossAcknowledged,
    archiveDecision: archiveDecisionForPlan(plan),
    createdAt
  };
}

export function executeLegacyImport(store: LegacyImportStore, plan: LegacyImportPlan, options: ExecuteLegacyImportOptions): LegacyImportExecution {
  if (!plan.appendable) throw new LegacyImportError("IMPORT_UNSUPPORTED", "legacy plan contains facts the current event/reducer schemas cannot represent", { diagnostics: plan.diagnostics });
  if (plan.requiresLossAcknowledgement && !options.allowDisclosedLoss) {
    throw new LegacyImportError("IMPORT_UNSUPPORTED", "legacy plan discloses history/operational loss and requires explicit acknowledgement", { diagnostics: plan.diagnostics });
  }
  revalidateLegacySources(plan);
  const existing = readPrivateReceipt(options.receiptPath);
  if (existing) {
    assertReceiptMatchesPlan(existing, plan);
    verifyReceiptEvents(store, existing);
    options.fault?.("before-archive-decision");
    const archiveDecision = decideLegacyArchive(plan, existing);
    options.fault?.("after-archive-decision");
    return { receipt: existing, archiveDecision, idempotent: true };
  }

  options.fault?.("before-import");
  const results = store.appendBatch(plan.events);
  options.fault?.("after-import");
  revalidateLegacySources(plan);
  const receipt = receiptFromResults(
    plan,
    results,
    plan.requiresLossAcknowledgement,
    (options.now ?? (() => new Date().toISOString()))()
  );
  options.fault?.("before-receipt");
  const raced = readPrivateReceipt(options.receiptPath);
  if (raced) {
    assertReceiptMatchesPlan(raced, plan);
    verifyReceiptEvents(store, raced);
  } else {
    durableWritePrivate(options.receiptPath, receipt);
  }
  options.fault?.("after-receipt");
  options.fault?.("before-archive-decision");
  const archiveDecision = decideLegacyArchive(plan, raced ?? receipt);
  options.fault?.("after-archive-decision");
  return { receipt: raced ?? receipt, archiveDecision, idempotent: results.every((result) => result.idempotent) };
}

export const legacyImportLimits = {
  maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES,
  maxRecordBytes: DEFAULT_MAX_RECORD_BYTES,
  maxRecords: DEFAULT_MAX_RECORDS,
  leafLimits: DEFAULT_LEAF_LIMITS
} as const;

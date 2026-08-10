import { Buffer } from "node:buffer";
import {
  OBSERVATION_LIMITS,
  OBSERVATION_SCHEMA_VERSION,
  ObservationPageV1Schema,
  ObservationRecordV1Schema,
  PublicObservationV1Schema,
  type ObservationDetailsV1,
  type ObservationPageV1,
  type ObservationRecordV1,
  type ObservationSummaryV1,
  type PublicObservationV1
} from "./types.js";

export type ObservationPrivacyErrorCode =
  | "FORBIDDEN_KEY"
  | "ACCESSOR_PROPERTY"
  | "SYMBOL_PROPERTY"
  | "UNSAFE_PROTOTYPE"
  | "CYCLIC_VALUE"
  | "GRAPH_LIMIT"
  | "INVALID_RECORD"
  | "INVALID_PAGE"
  | "RESPONSE_TOO_LARGE";

export class ObservationPrivacyError extends Error {
  constructor(readonly code: ObservationPrivacyErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ObservationPrivacyError";
  }
}

const forbiddenKeys = new Set([
  "path", "filepath", "filename", "cwd", "worktree", "workspace", "homedir",
  "tmux", "pane", "socket", "terminal", "pty", "nativesessionid", "providersessionid",
  "prompt", "systemprompt", "command", "argv", "args", "environment", "env",
  "secret", "password", "token", "apikey", "credential", "authorization", "cookie",
  "raw", "rawjson", "stdout", "stderr", "toolinput", "tooloutput", "finalanswer"
]);

function normalizedKey(value: string): string {
  return value.replace(/[^A-Za-z0-9]/gu, "").toLowerCase();
}

/**
 * Inspect an untrusted value without invoking getters. Closed schemas remain the primary
 * allowlist; this guard makes privacy failures explicit before a parser can traverse them.
 */
export function assertObservationSafeGraph(value: unknown): void {
  const active = new Set<object>();
  const visited = new Set<object>();
  let nodes = 0;

  const visit = (current: unknown, depth: number, locator: string): void => {
    if (current === null || typeof current !== "object") return;
    if (active.has(current)) throw new ObservationPrivacyError("CYCLIC_VALUE", `cycle at ${locator}`);
    if (visited.has(current)) return;
    active.add(current);
    visited.add(current);
    nodes += 1;
    if (nodes > OBSERVATION_LIMITS.maximumGraphNodes || depth > OBSERVATION_LIMITS.maximumGraphDepth) {
      throw new ObservationPrivacyError("GRAPH_LIMIT", `graph bound exceeded at ${locator}`);
    }
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
      throw new ObservationPrivacyError("UNSAFE_PROTOTYPE", `non-data prototype at ${locator}`);
    }
    if (Object.getOwnPropertySymbols(current).length > 0) {
      throw new ObservationPrivacyError("SYMBOL_PROPERTY", `symbol property at ${locator}`);
    }
    if (Array.isArray(current) && current.length > OBSERVATION_LIMITS.maximumArrayItems) {
      throw new ObservationPrivacyError("GRAPH_LIMIT", `array bound exceeded at ${locator}`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(current);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      const childLocator = `${locator}.${key}`;
      if (forbiddenKeys.has(normalizedKey(key))) {
        throw new ObservationPrivacyError("FORBIDDEN_KEY", `forbidden field ${childLocator}`);
      }
      if (!("value" in descriptor)) throw new ObservationPrivacyError("ACCESSOR_PROPERTY", `accessor at ${childLocator}`);
      visit(descriptor.value, depth + 1, childLocator);
    }
    active.delete(current);
  };

  visit(value, 0, "$");
}

function prefixByUtf8Bytes(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let result = "";
  let bytes = 0;
  for (const scalar of value) {
    const size = Buffer.byteLength(scalar, "utf8");
    if (bytes + size > maximumBytes) break;
    result += scalar;
    bytes += size;
  }
  return result;
}

const ANSI_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/gu;
const CONTROL_SCALAR = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;
const SENSITIVE_ASSIGNMENT = /\b(?:token|secret|password|api[_-]?key|authorization|credential)[A-Za-z0-9_-]*\s*[:=]\s*[^\s,;]+/giu;
const URI = /\b(?:https?|ssh|file):\/\/[^\s<>'"]+/giu;
const SCP_URI = /\b[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s<>'"]+/gu;
const WINDOWS_PATH = /\b[A-Za-z]:\\(?:[^\s<>:"|?*]+\\?)+/gu;
const HOME_PATH = /(^|[\s("'=])~\/(?:[^\s<>"']+)/gu;
const POSIX_PATH = /(^|[\s("'=])\/(?:[^\s<>"']+)/gu;
const LONG_OPAQUE = /\b(?:[a-f0-9]{48,}|[A-Za-z0-9_-]{64,})\b/gu;

export function redactObservationSummary(input: string): ObservationSummaryV1 {
  if (typeof input !== "string") throw new ObservationPrivacyError("INVALID_RECORD", "summary must be text");
  const originalBytes = Buffer.byteLength(input, "utf8");
  const boundedInput = prefixByUtf8Bytes(input, OBSERVATION_LIMITS.maximumSummaryInputBytes);
  let text = boundedInput.normalize("NFC");
  text = text.replace(ANSI_SEQUENCE, "");
  text = text.replace(CONTROL_SCALAR, "");
  text = text.replace(SENSITIVE_ASSIGNMENT, "[credential]");
  text = text.replace(URI, "[url]");
  text = text.replace(SCP_URI, "[url]");
  text = text.replace(WINDOWS_PATH, "[path]");
  text = text.replace(HOME_PATH, "$1[path]");
  text = text.replace(POSIX_PATH, "$1[path]");
  text = text.replace(LONG_OPAQUE, "[opaque]");
  const beforeOutputCap = text;
  text = prefixByUtf8Bytes(text, OBSERVATION_LIMITS.maximumSummaryBytes);
  const retainedBytes = Buffer.byteLength(text, "utf8");
  const truncated = boundedInput !== input || beforeOutputCap !== text;
  const redacted = boundedInput !== input || text !== input;
  return Object.freeze({ text, redacted, truncated, originalBytes, retainedBytes });
}

function cloneDetails(value: ObservationDetailsV1): ObservationDetailsV1 {
  switch (value.kind) {
    case "lifecycle": return Object.freeze({ kind: "lifecycle", activity: value.activity, stateCode: value.stateCode });
    case "progress": return Object.freeze({
      kind: "progress",
      operationCode: value.operationCode,
      ...(value.completed === undefined ? {} : { completed: value.completed }),
      ...(value.total === undefined ? {} : { total: value.total }),
      ...(value.unit === undefined ? {} : { unit: value.unit })
    });
    case "tool": return Object.freeze({
      kind: "tool",
      toolClass: value.toolClass,
      state: value.state,
      ...(value.invocationId === undefined ? {} : { invocationId: value.invocationId })
    });
    case "usage": return Object.freeze({
      kind: "usage",
      inputTokens: value.inputTokens,
      outputTokens: value.outputTokens,
      cachedTokens: value.cachedTokens,
      turnCount: value.turnCount
    });
    case "steering": return Object.freeze({
      kind: "steering",
      commandState: value.commandState,
      pendingCount: value.pendingCount,
      nextBoundary: value.nextBoundary
    });
    case "scm": return Object.freeze({
      kind: "scm",
      factKind: value.factKind,
      stateCode: value.stateCode,
      evidenceCount: value.evidenceCount
    });
    case "verification": return Object.freeze({
      kind: "verification",
      gateCode: value.gateCode,
      outcome: value.outcome,
      completedChecks: value.completedChecks,
      totalChecks: value.totalChecks
    });
    case "artifact": return Object.freeze({
      kind: "artifact",
      artifactClass: value.artifactClass,
      state: value.state,
      ...(value.digest === undefined ? {} : { digest: value.digest }),
      ...(value.bytes === undefined ? {} : { bytes: value.bytes })
    });
    case "source": return Object.freeze({
      kind: "source",
      state: value.state,
      recordCount: value.recordCount,
      byteCount: value.byteCount
    });
    case "loss": return Object.freeze({
      kind: "loss",
      droppedRecords: value.droppedRecords,
      droppedBytes: value.droppedBytes,
      reasonCode: value.reasonCode
    });
  }
}

type ObservationRecordDraftV1 = Omit<ObservationRecordV1, "summary"> & Readonly<{ summary?: string | ObservationSummaryV1 }>;

function explicitRecord(value: ObservationRecordV1, summary: ObservationSummaryV1 | undefined): ObservationRecordV1 {
  const generation = Object.freeze({
    runId: value.generation.runId,
    runEpoch: value.generation.runEpoch,
    ...(value.generation.taskId === undefined ? {} : { taskId: value.generation.taskId }),
    agentId: value.generation.agentId,
    runtimeGeneration: value.generation.runtimeGeneration,
    attemptGeneration: value.generation.attemptGeneration,
    sourceGeneration: value.generation.sourceGeneration
  });
  const loss = value.loss === undefined ? undefined : Object.freeze({
    droppedRecords: value.loss.droppedRecords,
    droppedBytes: value.loss.droppedBytes,
    reasonCode: value.loss.reasonCode
  });
  return Object.freeze({
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    seq: value.seq,
    recordId: value.recordId,
    generation,
    observedAt: value.observedAt,
    recordedAt: value.recordedAt,
    category: value.category,
    phase: value.phase,
    severity: value.severity,
    code: value.code,
    details: cloneDetails(value.details),
    sourceIntegrity: value.sourceIntegrity,
    ...(loss === undefined ? {} : { loss }),
    ...(summary === undefined ? {} : { summary })
  });
}

/** Normalize and privacy-check a record before it crosses the durable observation boundary. */
export function materializeObservationRecord(value: ObservationRecordDraftV1): ObservationRecordV1 {
  assertObservationSafeGraph(value);
  const suppliedSummary = value.summary;
  const summary = suppliedSummary === undefined
    ? undefined
    : redactObservationSummary(typeof suppliedSummary === "string" ? suppliedSummary : suppliedSummary.text);
  const candidate = {
    schemaVersion: value.schemaVersion,
    seq: value.seq,
    recordId: value.recordId,
    generation: value.generation,
    observedAt: value.observedAt,
    recordedAt: value.recordedAt,
    category: value.category,
    phase: value.phase,
    severity: value.severity,
    code: value.code,
    details: value.details,
    sourceIntegrity: value.sourceIntegrity,
    ...(value.loss === undefined ? {} : { loss: value.loss }),
    ...(summary === undefined ? {} : { summary })
  };
  const parsed = ObservationRecordV1Schema.safeParse(candidate);
  if (!parsed.success) throw new ObservationPrivacyError("INVALID_RECORD", parsed.error.issues[0]?.message ?? "record is invalid");
  return explicitRecord(parsed.data, summary);
}

/** Convert an internal record through an explicit public allowlist and re-sanitize its summary. */
export function toPublicObservation(value: unknown): PublicObservationV1 {
  assertObservationSafeGraph(value);
  const parsed = ObservationRecordV1Schema.safeParse(value);
  if (!parsed.success) throw new ObservationPrivacyError("INVALID_RECORD", parsed.error.issues[0]?.message ?? "record is invalid");
  let summary: ObservationSummaryV1 | undefined;
  if (parsed.data.summary !== undefined) {
    const sanitized = redactObservationSummary(parsed.data.summary.text);
    summary = sanitized.text === parsed.data.summary.text
      ? Object.freeze({
          text: parsed.data.summary.text,
          redacted: parsed.data.summary.redacted,
          truncated: parsed.data.summary.truncated,
          originalBytes: parsed.data.summary.originalBytes,
          retainedBytes: parsed.data.summary.retainedBytes
        })
      : Object.freeze({
          text: sanitized.text,
          redacted: true,
          truncated: parsed.data.summary.truncated || sanitized.truncated,
          originalBytes: Math.max(parsed.data.summary.originalBytes, sanitized.originalBytes),
          retainedBytes: sanitized.retainedBytes
        });
  }
  const candidate = explicitRecord(parsed.data, summary);
  const publicRecord = PublicObservationV1Schema.safeParse(candidate);
  if (!publicRecord.success) throw new ObservationPrivacyError("INVALID_RECORD", publicRecord.error.issues[0]?.message ?? "public record is invalid");
  return publicRecord.data;
}

export function serializeObservationPage(value: unknown): string {
  assertObservationSafeGraph(value);
  const parsed = ObservationPageV1Schema.safeParse(value);
  if (!parsed.success) throw new ObservationPrivacyError("INVALID_PAGE", parsed.error.issues[0]?.message ?? "page is invalid");
  const publicRecords = parsed.data.records.map((record) => toPublicObservation(record));
  const page: ObservationPageV1 = {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    runId: parsed.data.runId,
    runEpoch: parsed.data.runEpoch,
    snapshotSeq: parsed.data.snapshotSeq,
    projectionSeq: parsed.data.projectionSeq,
    firstAvailableSeq: parsed.data.firstAvailableSeq,
    nextAfter: parsed.data.nextAfter,
    truncated: parsed.data.truncated,
    droppedRecords: parsed.data.droppedRecords,
    droppedBytes: parsed.data.droppedBytes,
    freshness: parsed.data.freshness,
    records: publicRecords,
    sources: parsed.data.sources.map((source) => Object.freeze({
      agentId: source.agentId,
      runtimeGeneration: source.runtimeGeneration,
      attemptGeneration: source.attemptGeneration,
      sourceGeneration: source.sourceGeneration,
      integrity: source.integrity,
      ...(source.lastObservedAt === undefined ? {} : { lastObservedAt: source.lastObservedAt }),
      droppedRecords: source.droppedRecords,
      droppedBytes: source.droppedBytes
    }))
  };
  const encoded = JSON.stringify(page);
  if (Buffer.byteLength(encoded, "utf8") > OBSERVATION_LIMITS.maximumPageBytes) {
    throw new ObservationPrivacyError("RESPONSE_TOO_LARGE", "observation page exceeds the response byte cap");
  }
  return encoded;
}

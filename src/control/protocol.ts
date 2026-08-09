import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
import { z } from "zod";
import { isValidId } from "../ids.js";
import {
  redactControlValue,
  type ControlJsonValue,
  type DeepRedactionOptions
} from "./redaction.js";

export const CONTROL_PROTOCOL_VERSION = 1;
export const CONTROL_SERVICE = "relayforge-control";
export const CONTROL_HOST = "127.0.0.1";

export const CONTROL_RUN_FILE_MAX_BYTES = 8 * 1024;
export const CONTROL_HEALTH_MAX_BYTES = 4 * 1024;
export const CONTROL_STATUS_MAX_BYTES = 256 * 1024;
export const CONTROL_RUNS_MAX_BYTES = 1024 * 1024;
export const CONTROL_RUN_MAX_BYTES = 256 * 1024;
export const CONTROL_BOARD_MAX_BYTES = 2 * 1024 * 1024;
export const CONTROL_ACTIVITY_MAX_BYTES = 2 * 1024 * 1024;
export const CONTROL_DIAGNOSTICS_MAX_BYTES = 256 * 1024;
export const CONTROL_ERROR_MAX_BYTES = 4 * 1024;

export const CONTROL_MAX_CONNECTIONS = 64;
export const CONTROL_MAX_SSE_CLIENTS = 32;
export const CONTROL_REQUEST_TARGET_MAX_BYTES = 8 * 1024;
export const CONTROL_RELEVANT_HEADERS_MAX_BYTES = 8 * 1024;
export const CONTROL_ADMISSION_TIMEOUT_MS = 5_000;
export const CONTROL_GRACEFUL_DRAIN_TIMEOUT_MS = 5_000;

export const CONTROL_RUNS_DEFAULT_LIMIT = 25;
export const CONTROL_RUNS_MAX_LIMIT = 100;
export const CONTROL_ACTIVITY_DEFAULT_LIMIT = 100;
export const CONTROL_ACTIVITY_MAX_LIMIT = 500;
export const CONTROL_DIAGNOSTIC_DEFAULT_LINES = 160;
export const CONTROL_DIAGNOSTIC_MAX_LINES = 500;
export const CONTROL_PAGE_CURSOR_MAX_LENGTH = 512;

export const CONTROL_SSE_REPLAY_MAX_EVENTS = 1_024;
export const CONTROL_SSE_REPLAY_MAX_BYTES = 4 * 1024 * 1024;
export const CONTROL_SSE_FRAME_MAX_BYTES = 64 * 1024;
export const CONTROL_SSE_DRAIN_TIMEOUT_MS = 5_000;
export const CONTROL_SSE_HEARTBEAT_MS = 15_000;

export const CONTROL_RESPONSE_LIMITS = Object.freeze({
  health: CONTROL_HEALTH_MAX_BYTES,
  status: CONTROL_STATUS_MAX_BYTES,
  runs: CONTROL_RUNS_MAX_BYTES,
  run: CONTROL_RUN_MAX_BYTES,
  board: CONTROL_BOARD_MAX_BYTES,
  activity: CONTROL_ACTIVITY_MAX_BYTES,
  diagnostics: CONTROL_DIAGNOSTICS_MAX_BYTES
});

export type ControlResponseKind = keyof typeof CONTROL_RESPONSE_LIMITS;

const MAX_PID = 2_147_483_647;
const MAX_PUBLIC_TEXT = 4_096;
const MAX_PUBLIC_MESSAGE = 2_048;
const MAX_PROJECTS = 256;
const MAX_SESSIONS_PER_PROJECT = 256;
const MAX_BOARD_TASKS = 4_096;
const MAX_DIAGNOSTIC_CHECKS = 256;

const CanonicalIdSchema = z.string().refine(isValidId, "Invalid canonical identifier.");
const SessionNameSchema = z
  .string()
  .min(1)
  .max(192)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .refine((value) => !value.includes(".."), "Invalid session identifier.");
const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
const InstanceIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
const RunEpochSchema = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/);
const ProcessStartTokenSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[a-z0-9:.-]+$/);
const TimestampSchema = z
  .string()
  .length(24)
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine(isCanonicalUtcTimestamp, "Invalid UTC timestamp.");
const SequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const PublicCodeSchema = z.string().min(1).max(64).regex(/^[a-z][a-z0-9._-]*$/);
const PublicTextSchema = z.string().max(MAX_PUBLIC_TEXT);
const PublicMessageSchema = z.string().min(1).max(MAX_PUBLIC_MESSAGE);
const PageCursorSchema = z
  .string()
  .min(4)
  .max(CONTROL_PAGE_CURSOR_MAX_LENGTH)
  .regex(/^v1\.[A-Za-z0-9_-]+$/);

export const ControlRunFileSchema = z
  .object({
    schemaVersion: z.literal(CONTROL_PROTOCOL_VERSION),
    service: z.literal(CONTROL_SERVICE),
    instanceId: InstanceIdSchema,
    configId: Sha256HexSchema,
    pid: z.number().int().positive().max(MAX_PID),
    processStartToken: ProcessStartTokenSchema,
    host: z.literal(CONTROL_HOST),
    port: z.number().int().min(1).max(65_535),
    startedAt: TimestampSchema
  })
  .strict();

export const ControlHealthSchema = z
  .object({
    schemaVersion: z.literal(CONTROL_PROTOCOL_VERSION),
    service: z.literal(CONTROL_SERVICE),
    instanceId: InstanceIdSchema,
    configId: Sha256HexSchema,
    pid: z.number().int().positive().max(MAX_PID),
    status: z.enum(["ok", "starting"]),
    startedAt: TimestampSchema
  })
  .strict();

export const ControlTaskStatusSchema = z.enum([
  "open",
  "claimed",
  "in-progress",
  "needs-review",
  "blocked",
  "done",
  "rejected",
  "escalated"
]);

export const ControlRunStatusSchema = z.enum([
  "starting",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
  "recovery-required",
  "unknown"
]);

export const ControlSessionStateSchema = z.enum(["running", "exited", "unknown", "probe-failed"]);

export const ControlTaskCountsSchema = z
  .object({
    total: SequenceSchema,
    open: SequenceSchema,
    active: SequenceSchema,
    needsReview: SequenceSchema,
    blocked: SequenceSchema,
    done: SequenceSchema,
    rejected: SequenceSchema,
    escalated: SequenceSchema
  })
  .strict()
  .refine(
    (value) =>
      value.open + value.active + value.needsReview + value.blocked + value.done + value.rejected + value.escalated ===
      value.total,
    "Task counts do not sum to total."
  );

export const ControlRunSummarySchema = z
  .object({
    project: CanonicalIdSchema,
    run: CanonicalIdSchema,
    runEpoch: RunEpochSchema,
    status: ControlRunStatusSchema,
    reason: PublicCodeSchema.nullable(),
    startedAt: TimestampSchema,
    updatedAt: TimestampSchema,
    completedAt: TimestampSchema.nullable(),
    viewSeq: SequenceSchema,
    headSeq: SequenceSchema,
    floorSeq: SequenceSchema,
    stale: z.boolean(),
    tasks: ControlTaskCountsSchema
  })
  .strict()
  .refine((value) => validFreshness(value.floorSeq, value.viewSeq, value.headSeq), "Invalid run freshness cursor.");

export const ControlSessionSummarySchema = z
  .object({
    name: SessionNameSchema,
    project: CanonicalIdSchema,
    run: CanonicalIdSchema,
    role: CanonicalIdSchema,
    state: ControlSessionStateSchema,
    taskId: CanonicalIdSchema.nullable(),
    lastActivity: TimestampSchema.nullable()
  })
  .strict();

export const ControlProjectStatusSchema = z
  .object({
    project: CanonicalIdSchema,
    latestRun: ControlRunSummarySchema.nullable(),
    sessions: z.array(ControlSessionSummarySchema).max(MAX_SESSIONS_PER_PROJECT)
  })
  .strict();

export const ControlStatusSchema = z
  .object({
    schemaVersion: z.literal(CONTROL_PROTOCOL_VERSION),
    service: z.literal(CONTROL_SERVICE),
    instanceId: InstanceIdSchema,
    configId: Sha256HexSchema,
    status: z.literal("ok"),
    startedAt: TimestampSchema,
    projects: z.array(ControlProjectStatusSchema).max(MAX_PROJECTS)
  })
  .strict();

export const ControlRunsSchema = z
  .object({
    schemaVersion: z.literal(CONTROL_PROTOCOL_VERSION),
    project: CanonicalIdSchema,
    runs: z.array(ControlRunSummarySchema).max(CONTROL_RUNS_MAX_LIMIT),
    nextCursor: PageCursorSchema.nullable()
  })
  .strict();

export const ControlRunDetailSchema = z
  .object({
    project: CanonicalIdSchema,
    run: CanonicalIdSchema,
    runEpoch: RunEpochSchema,
    status: ControlRunStatusSchema,
    reason: PublicCodeSchema.nullable(),
    startedAt: TimestampSchema,
    updatedAt: TimestampSchema,
    completedAt: TimestampSchema.nullable(),
    desiredGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    observedGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    viewSeq: SequenceSchema,
    headSeq: SequenceSchema,
    floorSeq: SequenceSchema,
    stale: z.boolean(),
    tasks: ControlTaskCountsSchema
  })
  .strict()
  .refine((value) => validFreshness(value.floorSeq, value.viewSeq, value.headSeq), "Invalid run freshness cursor.");

export const ControlRunSchema = z
  .object({
    schemaVersion: z.literal(CONTROL_PROTOCOL_VERSION),
    run: ControlRunDetailSchema
  })
  .strict();

export const ControlTaskSchema = z
  .object({
    id: CanonicalIdSchema,
    title: PublicTextSchema,
    status: ControlTaskStatusSchema,
    assignee: CanonicalIdSchema,
    claimedBy: CanonicalIdSchema.nullable(),
    priority: z.number().int().min(0).max(100),
    dependsOn: z.array(CanonicalIdSchema).max(256),
    attempts: z.number().int().nonnegative().max(100),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema.nullable(),
    summary: PublicTextSchema.nullable()
  })
  .strict();

export const ControlBoardSchema = z
  .object({
    schemaVersion: z.literal(CONTROL_PROTOCOL_VERSION),
    project: CanonicalIdSchema,
    run: CanonicalIdSchema,
    runEpoch: RunEpochSchema,
    viewSeq: SequenceSchema,
    headSeq: SequenceSchema,
    floorSeq: SequenceSchema,
    stale: z.boolean(),
    tasks: z.array(ControlTaskSchema).max(MAX_BOARD_TASKS),
    counts: ControlTaskCountsSchema
  })
  .strict()
  .refine((value) => validFreshness(value.floorSeq, value.viewSeq, value.headSeq), "Invalid board freshness cursor.");

export const ControlActivityKindSchema = z.enum([
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "task.created",
  "task.claimed",
  "task.started",
  "task.blocked",
  "task.review-requested",
  "task.completed",
  "task.rejected",
  "task.escalated",
  "runtime.probe-failed"
]);

export const ControlActivityEntrySchema = z
  .object({
    seq: SequenceSchema,
    occurredAt: TimestampSchema,
    kind: ControlActivityKindSchema,
    actor: CanonicalIdSchema.nullable(),
    taskId: CanonicalIdSchema.nullable(),
    status: ControlTaskStatusSchema.nullable(),
    summary: PublicTextSchema.nullable()
  })
  .strict();

export const ControlActivitySchema = z
  .object({
    schemaVersion: z.literal(CONTROL_PROTOCOL_VERSION),
    project: CanonicalIdSchema,
    run: CanonicalIdSchema,
    runEpoch: RunEpochSchema,
    viewSeq: SequenceSchema,
    headSeq: SequenceSchema,
    floorSeq: SequenceSchema,
    stale: z.boolean(),
    activity: z.array(ControlActivityEntrySchema).max(CONTROL_ACTIVITY_MAX_LIMIT),
    nextAfter: SequenceSchema.nullable()
  })
  .strict()
  .refine((value) => validFreshness(value.floorSeq, value.viewSeq, value.headSeq), "Invalid activity freshness cursor.")
  .refine(
    (value) => value.activity.every((entry, index) => index === 0 || entry.seq > value.activity[index - 1].seq),
    "Activity sequences must be strictly increasing."
  );

export const ControlDiagnosticCheckSchema = z
  .object({
    code: PublicCodeSchema,
    status: z.enum(["ok", "warn", "fail"]),
    message: PublicMessageSchema,
    fix: PublicMessageSchema.nullable()
  })
  .strict();

export const ControlDiagnosticsSchema = z
  .object({
    schemaVersion: z.literal(CONTROL_PROTOCOL_VERSION),
    project: CanonicalIdSchema,
    run: CanonicalIdSchema,
    runEpoch: RunEpochSchema,
    viewSeq: SequenceSchema,
    headSeq: SequenceSchema,
    floorSeq: SequenceSchema,
    stale: z.boolean(),
    session: SessionNameSchema.nullable(),
    checks: z.array(ControlDiagnosticCheckSchema).max(MAX_DIAGNOSTIC_CHECKS),
    tail: z.array(PublicTextSchema).max(CONTROL_DIAGNOSTIC_MAX_LINES),
    truncated: z.boolean()
  })
  .strict()
  .refine((value) => validFreshness(value.floorSeq, value.viewSeq, value.headSeq), "Invalid diagnostics freshness cursor.");

export const ControlSseNotificationSchema = z
  .object({
    v: z.literal(CONTROL_PROTOCOL_VERSION),
    type: z.literal("control.changed"),
    project: CanonicalIdSchema,
    run: CanonicalIdSchema,
    taskId: CanonicalIdSchema.nullable(),
    runEpoch: RunEpochSchema,
    seq: SequenceSchema,
    headSeq: SequenceSchema,
    viewSeq: SequenceSchema
  })
  .strict()
  .refine((value) => value.seq <= value.headSeq && value.viewSeq <= value.headSeq, "Invalid SSE freshness cursor.");

const ControlReadyFrameSchema = z
  .object({
    v: z.literal(CONTROL_PROTOCOL_VERSION),
    type: z.literal("control.ready"),
    runEpoch: RunEpochSchema,
    floorSeq: SequenceSchema,
    headSeq: SequenceSchema,
    viewSeq: SequenceSchema
  })
  .strict()
  .refine((value) => validFreshness(value.floorSeq, value.viewSeq, value.headSeq), "Invalid ready freshness cursor.");

const ControlResyncFrameSchema = z
  .object({
    v: z.literal(CONTROL_PROTOCOL_VERSION),
    type: z.literal("control.resync-required"),
    reason: z.enum(["epoch", "cursor-expired", "future-cursor", "replay-budget", "schema"]),
    runEpoch: RunEpochSchema,
    floorSeq: SequenceSchema,
    headSeq: SequenceSchema,
    snapshotSeq: SequenceSchema
  })
  .strict();

const ControlSlowClientFrameSchema = z
  .object({
    v: z.literal(CONTROL_PROTOCOL_VERSION),
    type: z.literal("control.slow-client"),
    reason: z.literal("backpressure")
  })
  .strict();

const ControlClosingFrameSchema = z
  .object({
    v: z.literal(CONTROL_PROTOCOL_VERSION),
    type: z.literal("control.closing"),
    reason: z.literal("shutdown")
  })
  .strict();

export const ControlSseControlFrameSchema = z.discriminatedUnion("type", [
  ControlReadyFrameSchema,
  ControlResyncFrameSchema,
  ControlSlowClientFrameSchema,
  ControlClosingFrameSchema
]);

export const ControlErrorCodeSchema = z.enum([
  "INVALID_REQUEST",
  "INVALID_CURSOR",
  "CURSOR_EXPIRED",
  "NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  "NOT_READY",
  "IDENTITY_MISMATCH",
  "RESPONSE_TOO_LARGE",
  "RECOVERY_REQUIRED",
  "CAPACITY_EXCEEDED",
  "INTERNAL_ERROR"
]);

export const ControlErrorDetailsSchema = z
  .object({
    floorSeq: SequenceSchema.optional(),
    headSeq: SequenceSchema.optional(),
    snapshotSeq: SequenceSchema.optional(),
    retryAfterMs: z.number().int().nonnegative().max(60_000).optional(),
    reason: PublicCodeSchema.optional()
  })
  .strict();

export const ControlErrorSchema = z
  .object({
    error: z
      .object({
        code: ControlErrorCodeSchema,
        message: PublicMessageSchema,
        requestId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
        details: ControlErrorDetailsSchema.optional()
      })
      .strict()
  })
  .strict();

export type ControlRunFile = z.infer<typeof ControlRunFileSchema>;
export type ControlHealth = z.infer<typeof ControlHealthSchema>;
export type ControlTaskStatus = z.infer<typeof ControlTaskStatusSchema>;
export type ControlRunStatus = z.infer<typeof ControlRunStatusSchema>;
export type ControlTaskCounts = z.infer<typeof ControlTaskCountsSchema>;
export type ControlRunSummary = z.infer<typeof ControlRunSummarySchema>;
export type ControlSessionSummary = z.infer<typeof ControlSessionSummarySchema>;
export type ControlStatus = z.infer<typeof ControlStatusSchema>;
export type ControlRuns = z.infer<typeof ControlRunsSchema>;
export type ControlRun = z.infer<typeof ControlRunSchema>;
export type ControlTask = z.infer<typeof ControlTaskSchema>;
export type ControlBoard = z.infer<typeof ControlBoardSchema>;
export type ControlActivityEntry = z.infer<typeof ControlActivityEntrySchema>;
export type ControlActivity = z.infer<typeof ControlActivitySchema>;
export type ControlDiagnosticCheck = z.infer<typeof ControlDiagnosticCheckSchema>;
export type ControlDiagnostics = z.infer<typeof ControlDiagnosticsSchema>;
export type ControlSseNotification = z.infer<typeof ControlSseNotificationSchema>;
export type ControlSseControlFrame = z.infer<typeof ControlSseControlFrameSchema>;
export type ControlErrorCode = z.infer<typeof ControlErrorCodeSchema>;
export type ControlErrorDetails = z.infer<typeof ControlErrorDetailsSchema>;
export type ControlError = z.infer<typeof ControlErrorSchema>;

export class ControlProtocolError extends Error {
  readonly code = "INVALID_PROTOCOL";

  constructor(message: string) {
    super(message);
    this.name = "ControlProtocolError";
  }
}

export class ControlPayloadTooLargeError extends Error {
  readonly code = "RESPONSE_TOO_LARGE";

  constructor(
    readonly maxBytes: number,
    readonly actualBytes: number
  ) {
    super(`Control payload is ${actualBytes} bytes; maximum is ${maxBytes}.`);
    this.name = "ControlPayloadTooLargeError";
  }
}

export function parseControlRunFile(value: unknown): ControlRunFile {
  return parseSchema(ControlRunFileSchema, value, "run-file");
}

export function parseControlRunFileJson(raw: string | Uint8Array): ControlRunFile {
  return parseJsonDocument(ControlRunFileSchema, raw, CONTROL_RUN_FILE_MAX_BYTES, "run-file");
}

export function parseControlHealth(value: unknown): ControlHealth {
  return parseSchema(ControlHealthSchema, value, "health response");
}

export function parseControlHealthJson(raw: string | Uint8Array): ControlHealth {
  return parseJsonDocument(ControlHealthSchema, raw, CONTROL_HEALTH_MAX_BYTES, "health response");
}

export function parseControlStatus(value: unknown): ControlStatus {
  return parseSchema(ControlStatusSchema, value, "status response");
}

export function parseControlStatusJson(raw: string | Uint8Array): ControlStatus {
  return parseJsonDocument(ControlStatusSchema, raw, CONTROL_STATUS_MAX_BYTES, "status response");
}

export function parseControlRuns(value: unknown): ControlRuns {
  return parseSchema(ControlRunsSchema, value, "runs response");
}

export function parseControlRunsJson(raw: string | Uint8Array): ControlRuns {
  return parseJsonDocument(ControlRunsSchema, raw, CONTROL_RUNS_MAX_BYTES, "runs response");
}

export function parseControlRun(value: unknown): ControlRun {
  return parseSchema(ControlRunSchema, value, "run response");
}

export function parseControlRunJson(raw: string | Uint8Array): ControlRun {
  return parseJsonDocument(ControlRunSchema, raw, CONTROL_RUN_MAX_BYTES, "run response");
}

export function parseControlBoard(value: unknown): ControlBoard {
  return parseSchema(ControlBoardSchema, value, "board response");
}

export function parseControlBoardJson(raw: string | Uint8Array): ControlBoard {
  return parseJsonDocument(ControlBoardSchema, raw, CONTROL_BOARD_MAX_BYTES, "board response");
}

export function parseControlActivity(value: unknown): ControlActivity {
  return parseSchema(ControlActivitySchema, value, "activity response");
}

export function parseControlActivityJson(raw: string | Uint8Array): ControlActivity {
  return parseJsonDocument(ControlActivitySchema, raw, CONTROL_ACTIVITY_MAX_BYTES, "activity response");
}

export function parseControlDiagnostics(value: unknown): ControlDiagnostics {
  return parseSchema(ControlDiagnosticsSchema, value, "diagnostics response");
}

export function parseControlDiagnosticsJson(raw: string | Uint8Array): ControlDiagnostics {
  return parseJsonDocument(ControlDiagnosticsSchema, raw, CONTROL_DIAGNOSTICS_MAX_BYTES, "diagnostics response");
}

export function parseControlSseNotification(value: unknown): ControlSseNotification {
  return parseSchema(ControlSseNotificationSchema, value, "SSE notification");
}

export function parseControlSseNotificationJson(raw: string | Uint8Array): ControlSseNotification {
  return parseJsonDocument(ControlSseNotificationSchema, raw, CONTROL_SSE_FRAME_MAX_BYTES, "SSE notification");
}

export function parseControlSseControlFrame(value: unknown): ControlSseControlFrame {
  return parseSchema(ControlSseControlFrameSchema, value, "SSE control frame");
}

export function parseControlSseControlFrameJson(raw: string | Uint8Array): ControlSseControlFrame {
  return parseJsonDocument(ControlSseControlFrameSchema, raw, CONTROL_SSE_FRAME_MAX_BYTES, "SSE control frame");
}

export function parseControlError(value: unknown): ControlError {
  return parseSchema(ControlErrorSchema, value, "error response");
}

export function parseControlErrorJson(raw: string | Uint8Array): ControlError {
  return parseJsonDocument(ControlErrorSchema, raw, CONTROL_ERROR_MAX_BYTES, "error response");
}

export type StrictDecimalOptions = {
  name: string;
  minimum?: number;
  maximum?: number;
};

/** Parse a canonical, full-string, non-negative decimal safe integer. */
export function parseStrictDecimal(value: unknown, options: StrictDecimalOptions): number {
  const minimum = options.minimum ?? 0;
  const maximum = options.maximum ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum < 0 || maximum < minimum) {
    throw new RangeError("Invalid strict-decimal bounds.");
  }
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new ControlProtocolError(`${options.name} must be a canonical decimal integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ControlProtocolError(`${options.name} is outside its allowed range.`);
  }
  return parsed;
}

export function parseOptionalDecimal(
  value: string | null | undefined,
  defaultValue: number,
  options: StrictDecimalOptions
): number {
  if (value === null || value === undefined) {
    const minimum = options.minimum ?? 0;
    const maximum = options.maximum ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(defaultValue) || defaultValue < minimum || defaultValue > maximum) {
      throw new RangeError("Default decimal value is outside its allowed range.");
    }
    return defaultValue;
  }
  return parseStrictDecimal(value, options);
}

export function parsePageCursor(value: unknown): string {
  return parseSchema(PageCursorSchema, value, "page cursor");
}

export type SseCursorInput = {
  runEpoch?: string | null;
  after?: string | null;
  lastEventId?: string | null;
};

export type SseCursor = {
  runEpoch: string;
  after: number;
  source: "header" | "query";
};

/** Last-Event-ID is authoritative when present; a malformed header never falls back to `after`. */
export function parseSseCursor(input: SseCursorInput): SseCursor | null {
  const hasHeader = input.lastEventId !== undefined && input.lastEventId !== null;
  const hasQuery = input.after !== undefined && input.after !== null;
  if (!hasHeader && !hasQuery) {
    if (input.runEpoch !== undefined && input.runEpoch !== null) {
      throw new ControlProtocolError("runEpoch requires an SSE cursor.");
    }
    return null;
  }
  const runEpoch = parseSchema(RunEpochSchema, input.runEpoch, "run epoch");
  if (hasHeader) {
    return {
      runEpoch,
      after: parseStrictDecimal(input.lastEventId, { name: "Last-Event-ID" }),
      source: "header"
    };
  }
  return {
    runEpoch,
    after: parseStrictDecimal(input.after, { name: "after" }),
    source: "query"
  };
}

export type SerializedControlJson = {
  value: ControlJsonValue;
  json: string;
  body: Buffer;
  bytes: number;
};

/** Redact, serialize exactly once, then enforce the final UTF-8 byte ceiling. */
export function serializeControlJson(
  value: unknown,
  maxBytes: number,
  redaction: DeepRedactionOptions = {}
): SerializedControlJson {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be a positive safe integer.");
  const publicValue = redactControlValue(value, redaction);
  const json = JSON.stringify(publicValue);
  const body = Buffer.from(json, "utf8");
  if (body.byteLength > maxBytes) throw new ControlPayloadTooLargeError(maxBytes, body.byteLength);
  return { value: publicValue, json, body, bytes: body.byteLength };
}

/** Validate a versioned route DTO before the shared redaction and final-byte gate. */
export function serializeControlResponse(
  kind: ControlResponseKind,
  value: unknown,
  redaction: DeepRedactionOptions = {}
): SerializedControlJson {
  const parsed = parseResponse(kind, value);
  return serializeControlJson(parsed, CONTROL_RESPONSE_LIMITS[kind], redaction);
}

export function makeControlError(
  code: ControlErrorCode,
  message: string,
  requestId: string,
  details?: ControlErrorDetails
): ControlError {
  const error: {
    code: ControlErrorCode;
    message: string;
    requestId: string;
    details?: ControlErrorDetails;
  } = { code, message, requestId };
  if (details !== undefined) error.details = allowlistedErrorDetails(details);
  return parseControlError({ error });
}

export type PublicSessionSummaryInput = ControlSessionSummary;
export type PublicRunSummaryInput = ControlRunSummary;
export type PublicTaskInput = ControlTask;
export type PublicActivityInput = ControlActivityEntry;
export type PublicDiagnosticCheckInput = ControlDiagnosticCheck;

export function toPublicSessionSummary(input: PublicSessionSummaryInput): ControlSessionSummary {
  return parseSchema(
    ControlSessionSummarySchema,
    {
      name: input.name,
      project: input.project,
      run: input.run,
      role: input.role,
      state: input.state,
      taskId: input.taskId,
      lastActivity: input.lastActivity
    },
    "public session summary"
  );
}

export function toPublicRunSummary(input: PublicRunSummaryInput): ControlRunSummary {
  return parseSchema(
    ControlRunSummarySchema,
    {
      project: input.project,
      run: input.run,
      runEpoch: input.runEpoch,
      status: input.status,
      reason: input.reason,
      startedAt: input.startedAt,
      updatedAt: input.updatedAt,
      completedAt: input.completedAt,
      viewSeq: input.viewSeq,
      headSeq: input.headSeq,
      floorSeq: input.floorSeq,
      stale: input.stale,
      tasks: {
        total: input.tasks.total,
        open: input.tasks.open,
        active: input.tasks.active,
        needsReview: input.tasks.needsReview,
        blocked: input.tasks.blocked,
        done: input.tasks.done,
        rejected: input.tasks.rejected,
        escalated: input.tasks.escalated
      }
    },
    "public run summary"
  );
}

export function toPublicTask(input: PublicTaskInput): ControlTask {
  return parseSchema(
    ControlTaskSchema,
    {
      id: input.id,
      title: input.title,
      status: input.status,
      assignee: input.assignee,
      claimedBy: input.claimedBy,
      priority: input.priority,
      dependsOn: input.dependsOn.map((dependency) => dependency),
      attempts: input.attempts,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      summary: input.summary
    },
    "public task"
  );
}

export function toPublicActivity(input: PublicActivityInput): ControlActivityEntry {
  return parseSchema(
    ControlActivityEntrySchema,
    {
      seq: input.seq,
      occurredAt: input.occurredAt,
      kind: input.kind,
      actor: input.actor,
      taskId: input.taskId,
      status: input.status,
      summary: input.summary
    },
    "public activity"
  );
}

export function toPublicDiagnosticCheck(input: PublicDiagnosticCheckInput): ControlDiagnosticCheck {
  return parseSchema(
    ControlDiagnosticCheckSchema,
    {
      code: input.code,
      status: input.status,
      message: input.message,
      fix: input.fix
    },
    "public diagnostic check"
  );
}

function allowlistedErrorDetails(input: ControlErrorDetails): ControlErrorDetails {
  const output: ControlErrorDetails = {};
  if (input.floorSeq !== undefined) output.floorSeq = input.floorSeq;
  if (input.headSeq !== undefined) output.headSeq = input.headSeq;
  if (input.snapshotSeq !== undefined) output.snapshotSeq = input.snapshotSeq;
  if (input.retryAfterMs !== undefined) output.retryAfterMs = input.retryAfterMs;
  if (input.reason !== undefined) output.reason = input.reason;
  return parseSchema(ControlErrorDetailsSchema, output, "error details");
}

function parseResponse(kind: ControlResponseKind, value: unknown): unknown {
  switch (kind) {
    case "health":
      return parseControlHealth(value);
    case "status":
      return parseControlStatus(value);
    case "runs":
      return parseControlRuns(value);
    case "run":
      return parseControlRun(value);
    case "board":
      return parseControlBoard(value);
    case "activity":
      return parseControlActivity(value);
    case "diagnostics":
      return parseControlDiagnostics(value);
  }
}

function parseSchema<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ControlProtocolError(`Invalid ${label}.`);
  return result.data;
}

function parseJsonDocument<T>(
  schema: z.ZodType<T>,
  raw: string | Uint8Array,
  maxBytes: number,
  label: string
): T {
  const bytes = typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.byteLength;
  if (bytes > maxBytes) throw new ControlPayloadTooLargeError(maxBytes, bytes);
  let text: string;
  try {
    text = typeof raw === "string" ? raw : new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new ControlProtocolError(`Invalid ${label} UTF-8.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ControlProtocolError(`Invalid ${label} JSON.`);
  }
  return parseSchema(schema, parsed, label);
}

function validFreshness(floorSeq: number, viewSeq: number, headSeq: number): boolean {
  return floorSeq <= viewSeq && viewSeq <= headSeq;
}

function isCanonicalUtcTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

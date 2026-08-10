import { Buffer } from "node:buffer";
import { z } from "zod";

export const OBSERVATION_SCHEMA_VERSION = 1 as const;

export const OBSERVATION_LIMITS = Object.freeze({
  maximumRecordBytes: 8 * 1024,
  maximumSummaryBytes: 1_024,
  maximumSummaryInputBytes: 32 * 1024,
  maximumPageRecords: 500,
  maximumPageBytes: 2 * 1024 * 1024,
  maximumSourcesPerPage: 256,
  maximumCodeBytes: 64,
  maximumIdentifierBytes: 192,
  maximumGraphDepth: 16,
  maximumGraphNodes: 4_096,
  maximumArrayItems: 1_024
});

export const observationCategories = [
  "runtime",
  "provider",
  "steering",
  "scm",
  "verification",
  "artifact",
  "system"
] as const;
export type ObservationCategory = (typeof observationCategories)[number];

export const observationPhases = [
  "queued",
  "preparing",
  "dispatching",
  "executing",
  "waiting",
  "reviewing",
  "verifying",
  "publishing",
  "settling",
  "completed",
  "failed"
] as const;
export type ObservationPhase = (typeof observationPhases)[number];

export const observationSeverities = ["info", "warning", "error"] as const;
export type ObservationSeverity = (typeof observationSeverities)[number];

export const observationSourceIntegrities = [
  "live",
  "quiescent_final",
  "recovered",
  "replaced",
  "degraded",
  "unknown"
] as const;
export type ObservationSourceIntegrity = (typeof observationSourceIntegrities)[number];

export const observationActivityStates = [
  "idle",
  "waiting_input",
  "dispatching",
  "active",
  "settling",
  "blocked",
  "exited"
] as const;

const CanonicalIdentifierSchema = z.string()
  .min(1)
  .max(OBSERVATION_LIMITS.maximumIdentifierBytes)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const RunEpochSchema = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/u);
const SequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const PositiveGenerationSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const CountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const CodeSchema = z.string()
  .min(1)
  .max(OBSERVATION_LIMITS.maximumCodeBytes)
  .regex(/^[a-z][a-z0-9._-]*$/u);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const TimestampSchema = z.string()
  .length(24)
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine((value) => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value, "timestamp must be canonical UTC");
const ByteBoundedTextSchema = (maximum: number) => z.string().superRefine((value, context) => {
  if (Buffer.byteLength(value, "utf8") > maximum) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `text exceeds ${maximum} UTF-8 bytes` });
  }
});

export const ObservationGenerationV1Schema = z.strictObject({
  runId: CanonicalIdentifierSchema,
  runEpoch: RunEpochSchema,
  taskId: CanonicalIdentifierSchema.optional(),
  agentId: CanonicalIdentifierSchema,
  runtimeGeneration: PositiveGenerationSchema,
  attemptGeneration: PositiveGenerationSchema,
  sourceGeneration: PositiveGenerationSchema
});
export type ObservationGenerationV1 = z.infer<typeof ObservationGenerationV1Schema>;

export const ObservationLossV1Schema = z.strictObject({
  droppedRecords: CountSchema,
  droppedBytes: CountSchema,
  reasonCode: CodeSchema
}).superRefine((value, context) => {
  if (value.droppedRecords === 0 && value.droppedBytes === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["droppedRecords"], message: "loss must report a nonzero count" });
  }
});
export type ObservationLossV1 = z.infer<typeof ObservationLossV1Schema>;

export const ObservationSummaryV1Schema = z.strictObject({
  text: ByteBoundedTextSchema(OBSERVATION_LIMITS.maximumSummaryBytes),
  redacted: z.boolean(),
  truncated: z.boolean(),
  originalBytes: CountSchema,
  retainedBytes: CountSchema
}).superRefine((value, context) => {
  const actual = Buffer.byteLength(value.text, "utf8");
  if (value.retainedBytes !== actual) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["retainedBytes"], message: "retained byte count is not exact" });
  }
  if (value.truncated && value.originalBytes <= value.retainedBytes) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["truncated"], message: "truncated text must have fewer retained bytes" });
  }
});
export type ObservationSummaryV1 = z.infer<typeof ObservationSummaryV1Schema>;

const LifecycleDetailsSchema = z.strictObject({
  kind: z.literal("lifecycle"),
  activity: z.enum(observationActivityStates),
  stateCode: CodeSchema
});
const ProgressDetailsSchema = z.strictObject({
  kind: z.literal("progress"),
  operationCode: CodeSchema,
  completed: CountSchema.optional(),
  total: CountSchema.optional(),
  unit: z.enum(["items", "bytes", "files", "checks", "steps"]).optional()
}).superRefine((value, context) => {
  if ((value.completed === undefined) !== (value.total === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["completed"], message: "progress counts must be supplied together" });
  } else if (value.completed !== undefined && value.total !== undefined && value.completed > value.total) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["completed"], message: "completed progress exceeds total" });
  }
});
const ToolDetailsSchema = z.strictObject({
  kind: z.literal("tool"),
  toolClass: z.enum(["read", "search", "edit", "process", "network", "other"]),
  state: z.enum(["started", "completed", "failed", "cancelled"]),
  invocationId: CanonicalIdentifierSchema.optional()
});
const UsageDetailsSchema = z.strictObject({
  kind: z.literal("usage"),
  inputTokens: CountSchema,
  outputTokens: CountSchema,
  cachedTokens: CountSchema,
  turnCount: CountSchema
});
const SteeringDetailsSchema = z.strictObject({
  kind: z.literal("steering"),
  commandState: z.enum(["pending", "included", "withdrawn", "expired", "refused", "superseded"]),
  pendingCount: CountSchema,
  nextBoundary: z.enum(["current_attempt", "future_attempt", "none"])
});
const ScmDetailsSchema = z.strictObject({
  kind: z.literal("scm"),
  factKind: z.enum(["publication", "pull_request", "ci", "review", "mergeability"]),
  stateCode: CodeSchema,
  evidenceCount: CountSchema
});
const VerificationDetailsSchema = z.strictObject({
  kind: z.literal("verification"),
  gateCode: CodeSchema,
  outcome: z.enum(["pending", "passing", "failing", "cancelled", "unknown"]),
  completedChecks: CountSchema,
  totalChecks: CountSchema
}).superRefine((value, context) => {
  if (value.completedChecks > value.totalChecks) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["completedChecks"], message: "completed checks exceed total checks" });
  }
});
const ArtifactDetailsSchema = z.strictObject({
  kind: z.literal("artifact"),
  artifactClass: z.enum(["prompt", "patch", "review", "verification", "publication"]),
  state: z.enum(["prepared", "verified", "published", "unavailable", "rejected"]),
  digest: DigestSchema.optional(),
  bytes: CountSchema.optional()
});
const SourceDetailsSchema = z.strictObject({
  kind: z.literal("source"),
  state: z.enum(["opened", "advanced", "quiescent", "recovered", "replaced", "degraded", "unavailable"]),
  recordCount: CountSchema,
  byteCount: CountSchema
});
const LossDetailsSchema = z.strictObject({
  kind: z.literal("loss"),
  droppedRecords: CountSchema,
  droppedBytes: CountSchema,
  reasonCode: CodeSchema
}).superRefine((value, context) => {
  if (value.droppedRecords === 0 && value.droppedBytes === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["droppedRecords"], message: "loss details must be nonzero" });
  }
});

export const ObservationDetailsV1Schema = z.discriminatedUnion("kind", [
  LifecycleDetailsSchema,
  ProgressDetailsSchema,
  ToolDetailsSchema,
  UsageDetailsSchema,
  SteeringDetailsSchema,
  ScmDetailsSchema,
  VerificationDetailsSchema,
  ArtifactDetailsSchema,
  SourceDetailsSchema,
  LossDetailsSchema
]);
export type ObservationDetailsV1 = z.infer<typeof ObservationDetailsV1Schema>;

const categoryDetailKinds = {
  runtime: ["lifecycle", "progress", "tool", "source", "loss"],
  provider: ["progress", "tool", "usage", "source", "loss"],
  steering: ["steering"],
  scm: ["scm"],
  verification: ["verification"],
  artifact: ["artifact"],
  system: ["lifecycle", "source", "loss"]
} as const satisfies Readonly<Record<ObservationCategory, readonly ObservationDetailsV1["kind"][]>>;

export const ObservationRecordV1Schema = z.strictObject({
  schemaVersion: z.literal(OBSERVATION_SCHEMA_VERSION),
  seq: SequenceSchema,
  recordId: CanonicalIdentifierSchema,
  generation: ObservationGenerationV1Schema,
  observedAt: TimestampSchema,
  recordedAt: TimestampSchema,
  category: z.enum(observationCategories),
  phase: z.enum(observationPhases),
  severity: z.enum(observationSeverities),
  code: CodeSchema,
  details: ObservationDetailsV1Schema,
  sourceIntegrity: z.enum(observationSourceIntegrities),
  loss: ObservationLossV1Schema.optional(),
  summary: ObservationSummaryV1Schema.optional()
}).superRefine((value, context) => {
  const allowedKinds: readonly ObservationDetailsV1["kind"][] = categoryDetailKinds[value.category];
  if (!allowedKinds.includes(value.details.kind)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["details", "kind"], message: "detail kind is not allowed for the record category" });
  }
  if (Date.parse(value.observedAt) > Date.parse(value.recordedAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["observedAt"], message: "observation time is after durable record time" });
  }
  if (value.details.kind === "loss" && !value.loss) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["loss"], message: "loss details require top-level loss metadata" });
  }
  const encoded = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (encoded > OBSERVATION_LIMITS.maximumRecordBytes) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "observation record exceeds the UTF-8 byte cap" });
  }
});
export type ObservationRecordV1 = z.infer<typeof ObservationRecordV1Schema>;

/** Public records intentionally repeat the exact allowlist instead of extending an internal bag. */
export const PublicObservationV1Schema = z.strictObject({
  schemaVersion: z.literal(OBSERVATION_SCHEMA_VERSION),
  seq: SequenceSchema,
  recordId: CanonicalIdentifierSchema,
  generation: ObservationGenerationV1Schema,
  observedAt: TimestampSchema,
  recordedAt: TimestampSchema,
  category: z.enum(observationCategories),
  phase: z.enum(observationPhases),
  severity: z.enum(observationSeverities),
  code: CodeSchema,
  details: ObservationDetailsV1Schema,
  sourceIntegrity: z.enum(observationSourceIntegrities),
  loss: ObservationLossV1Schema.optional(),
  summary: ObservationSummaryV1Schema.optional()
}).superRefine((value, context) => {
  const internal = ObservationRecordV1Schema.safeParse(value);
  if (!internal.success) {
    for (const issue of internal.error.issues) context.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message });
  }
});
export type PublicObservationV1 = z.infer<typeof PublicObservationV1Schema>;

export const ObservationSourceHealthV1Schema = z.strictObject({
  agentId: CanonicalIdentifierSchema,
  runtimeGeneration: PositiveGenerationSchema,
  attemptGeneration: PositiveGenerationSchema,
  sourceGeneration: PositiveGenerationSchema,
  integrity: z.enum(observationSourceIntegrities),
  lastObservedAt: TimestampSchema.optional(),
  droppedRecords: CountSchema,
  droppedBytes: CountSchema
});
export type ObservationSourceHealthV1 = z.infer<typeof ObservationSourceHealthV1Schema>;

export const ObservationPageV1Schema = z.strictObject({
  schemaVersion: z.literal(OBSERVATION_SCHEMA_VERSION),
  runId: CanonicalIdentifierSchema,
  runEpoch: RunEpochSchema,
  snapshotSeq: SequenceSchema,
  projectionSeq: SequenceSchema,
  firstAvailableSeq: SequenceSchema,
  nextAfter: SequenceSchema,
  truncated: z.boolean(),
  droppedRecords: CountSchema,
  droppedBytes: CountSchema,
  freshness: z.enum(["fresh", "stale", "rebuilding", "unavailable"]),
  records: z.array(PublicObservationV1Schema).max(OBSERVATION_LIMITS.maximumPageRecords),
  sources: z.array(ObservationSourceHealthV1Schema).max(OBSERVATION_LIMITS.maximumSourcesPerPage)
}).superRefine((value, context) => {
  if (value.projectionSeq > value.snapshotSeq) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["projectionSeq"], message: "projection is ahead of the durable snapshot" });
  }
  if (value.firstAvailableSeq > value.snapshotSeq + 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["firstAvailableSeq"], message: "first available sequence is outside the snapshot" });
  }
  let previous = value.firstAvailableSeq === 0 ? -1 : value.firstAvailableSeq - 1;
  for (let index = 0; index < value.records.length; index += 1) {
    const record = value.records[index]!;
    if (record.generation.runId !== value.runId || record.generation.runEpoch !== value.runEpoch) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["records", index, "generation"], message: "record belongs to a different run identity" });
    }
    if (record.seq <= previous || record.seq > value.snapshotSeq) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["records", index, "seq"], message: "record sequence is not strictly ordered within the snapshot" });
    }
    previous = record.seq;
  }
  const lastRecordSeq = value.records.at(-1)?.seq;
  if (lastRecordSeq !== undefined && value.nextAfter !== lastRecordSeq) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["nextAfter"], message: "next cursor does not match the returned page" });
  } else if (lastRecordSeq === undefined && (
    value.nextAfter < Math.max(0, value.firstAvailableSeq - 1) || value.nextAfter > value.snapshotSeq
  )) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["nextAfter"], message: "empty-page cursor is outside the available snapshot" });
  }
  if (value.freshness === "fresh" && value.projectionSeq !== value.snapshotSeq) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["freshness"], message: "fresh projection must equal the durable snapshot" });
  }
  const encoded = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (encoded > OBSERVATION_LIMITS.maximumPageBytes) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "observation page exceeds the UTF-8 byte cap" });
  }
});
export type ObservationPageV1 = z.infer<typeof ObservationPageV1Schema>;

export function parseObservationRecord(value: unknown): ObservationRecordV1 {
  return ObservationRecordV1Schema.parse(value);
}

export function parsePublicObservation(value: unknown): PublicObservationV1 {
  return PublicObservationV1Schema.parse(value);
}

export function parseObservationPage(value: unknown): ObservationPageV1 {
  return ObservationPageV1Schema.parse(value);
}

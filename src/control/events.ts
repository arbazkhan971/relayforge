import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ScmBucketMetaV1Schema,
  ScmCiFactV1Schema,
  ScmMergeabilityFactV1Schema,
  ScmProviderFailureV1Schema,
  ScmProviderLimitsV1Schema,
  ScmPublicationIntentV1Schema,
  ScmPullRequestFactV1Schema,
  ScmPullRequestIdentityV1Schema,
  ScmReviewFactV1Schema
} from "../scm/schema.js";
import { scmPublicationStates } from "../scm/types.js";
import {
  OBSERVATION_SCHEMA_VERSION,
  ObservationRecordV1Schema,
  type ObservationRecordV1
} from "../observability/types.js";
import {
  assertObservationSafeGraph,
  toPublicObservation
} from "../observability/public.js";
import {
  TRANSCRIPT_INGESTOR_LIMITS,
  TranscriptIngestorStateV1Schema,
  transcriptIngestorStateDigest,
  type TranscriptIngestorStateV1
} from "../observability/transcript-ingestor.js";
import {
  MultiRepositoryCanonicalFactV1Schema,
  type MultiRepositoryCanonicalFactV1
} from "../multirepo/orchestration.js";

export const CONTROL_EVENT_SCHEMA_VERSION = 1 as const;
export const CONTROL_REDUCER_VERSION = 1 as const;

const boundedId = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const observationRecordId = z.string()
  .min(1)
  .max(192)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const nonNegative = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const timestamp = z.string().datetime({ offset: true });
const shortText = z.string().max(4_096);
const bodyText = z.string().min(1).max(16_384);
const steeringBodyText = z.string().min(1).refine(
  (value) => [...value].length <= 8_192 && Buffer.byteLength(value, "utf8") <= 16 * 1_024,
  "steering body exceeds 8192 Unicode scalars or 16 KiB UTF-8"
);

// `scm/schema` uses canonicalJson from this module. Lazy bindings keep both public modules usable
// regardless of which one an application imports first, while retaining the SCM module's single
// closed validators instead of maintaining a divergent copy here.
const scmBucketMetaSchema = z.lazy(() => ScmBucketMetaV1Schema);
const scmCiFactSchema = z.lazy(() => ScmCiFactV1Schema);
const scmMergeabilityFactSchema = z.lazy(() => ScmMergeabilityFactV1Schema);
const scmProviderFailureSchema = z.lazy(() => ScmProviderFailureV1Schema);
const scmProviderLimitsSchema = z.lazy(() => ScmProviderLimitsV1Schema);
const scmPublicationIntentSchema = z.lazy(() => ScmPublicationIntentV1Schema);
const scmPullRequestFactSchema = z.lazy(() => ScmPullRequestFactV1Schema);
const scmPullRequestIdentitySchema = z.lazy(() => ScmPullRequestIdentityV1Schema);
const scmReviewFactSchema = z.lazy(() => ScmReviewFactV1Schema);
const transcriptIngestorStateSchema = z.lazy(() => TranscriptIngestorStateV1Schema);
const multiRepositoryFactSchema = z.lazy(() => MultiRepositoryCanonicalFactV1Schema);

export const taskStatuses = [
  "open",
  "claimed",
  "in-progress",
  "needs-review",
  "blocked",
  "done",
  "rejected",
  "escalated"
] as const;
export const taskStatusSchema = z.enum(taskStatuses);
export type ControlTaskStatus = z.infer<typeof taskStatusSchema>;

const taskCreatedPayload = z.strictObject({
  title: z.string().min(1).max(1_024),
  assignee: boundedId,
  createdBy: boundedId,
  description: z.string().max(64 * 1_024),
  acceptanceCriteria: z.array(z.string().min(1).max(8_192)).max(128),
  dependsOn: z.array(boundedId).max(128),
  priority: z.number().int().min(-1_000_000).max(1_000_000),
  createdAt: timestamp,
  files: z.array(z.string().min(1).max(4_096)).max(1_024).optional()
});

const taskStatusPayload = z.strictObject({
  role: boundedId,
  status: taskStatusSchema,
  summary: shortText.optional()
});

const messagePayload = z.strictObject({
  messageId: boundedId,
  from: boundedId,
  to: boundedId.or(z.literal("*")),
  body: bodyText
});

const runStartedPayload = z.strictObject({
  startedBy: boundedId,
  goal: z.string().min(1).max(64 * 1_024).optional(),
  configDigest: digest.optional()
});

const runCompletedPayload = z.strictObject({
  summary: shortText.optional()
});

const runFailedPayload = z.strictObject({
  reasonCode: boundedId,
  summary: shortText.optional()
});

const runCancelledPayload = z.strictObject({
  cancelledBy: boundedId,
  reason: shortText.optional()
});

export const loopPhases = ["init", "verify-preflight", "dispatch", "review", "post-check", "stopped", "cancelled", "complete"] as const;
export const loopStatuses = ["running", "planned", "blocked", "done", "unverified", "stopped", "cancelled"] as const;

const runCheckpointedPayload = z.strictObject({
  project: boundedId,
  phase: z.enum(loopPhases),
  status: z.enum(loopStatuses),
  iteration: nonNegative,
  dispatched: nonNegative,
  accepted: nonNegative,
  rejected: nonNegative,
  escalations: nonNegative,
  repeatFailures: nonNegative,
  unknownCostCalls: nonNegative,
  runBranch: z.string().min(1).max(4_096).optional(),
  lastGreenCommit: z.string().min(1).max(256).optional(),
  lastFailureSignature: z.string().min(1).max(1_024).optional(),
  lastFailureSummary: z.string().min(1).max(4_096).optional(),
  lastStopReason: z.string().min(1).max(4_096).optional(),
  verifyFingerprint: z.string().min(1).max(1_024).optional(),
  startedAt: timestamp,
  updatedAt: timestamp
});

const runtimePayload = z.strictObject({
  sessionId: boundedId,
  sessionGeneration: positive,
  observation: z.enum(["available", "waiting_input", "blocked", "exited", "probe_failed"]),
  launchId: boundedId.optional(),
  reason: shortText.optional()
});

const attemptBase = {
  attemptId: boundedId,
  attemptGeneration: positive,
  sessionId: boundedId,
  sessionGeneration: positive
};

const attemptPreparedPayload = z.strictObject({
  ...attemptBase,
  artifactLocator: z.string().min(1).max(256).regex(/^steering\/prompts\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\.prompt$/),
  promptSha256: digest,
  promptBytes: nonNegative.max(16 * 1024 * 1024),
  rendererVersion: positive,
  captureCutoffSeq: nonNegative,
  steeringCommandIds: z.array(boundedId).max(32)
});

const attemptLaunchPlannedPayload = z.strictObject({
  ...attemptBase,
  launchId: boundedId
});

const attemptStartedPayload = z.strictObject({
  ...attemptBase,
  launchId: boundedId,
  pid: positive,
  processStartToken: z.string().regex(/^[1-9][0-9]{0,31}$/)
});

const attemptExitedPayload = z.strictObject({
  ...attemptBase,
  outcome: z.enum(["succeeded", "failed", "cancelled", "uncertain"]),
  exitCode: z.number().int().min(-1).max(255).optional(),
  summary: shortText.optional()
});

const attemptAbandonedPayload = z.strictObject({
  ...attemptBase,
  reasonCode: z.enum(["OPERATOR_ABANDONED", "VERIFIED_NEVER_STARTED", "ARTIFACT_UNRECOVERABLE"]),
  summary: shortText.optional()
});

const steeringTarget = {
  commandId: boundedId,
  sessionId: boundedId,
  sessionGeneration: positive
};

const steeringAdmittedPayload = z.strictObject({
  ...steeringTarget,
  notBeforeAttemptGeneration: positive,
  kind: z.literal("steer_next_boundary"),
  sourceKind: z.enum(["operator", "review_gate", "verifier", "control_plane"]),
  parentPrincipal: boundedId,
  evidenceRefs: z.array(boundedId).max(32),
  body: steeringBodyText,
  bodySha256: digest,
  createdAt: timestamp,
  expiresAt: timestamp.optional(),
  supersedesCommandId: boundedId.optional()
});

const steeringRefusedPayload = z.strictObject({
  ...steeringTarget,
  bodySha256: digest,
  requestSemanticDigest: digest,
  observedSeq: nonNegative,
  observedActivity: z.enum(["idle", "waiting_input", "dispatching", "active", "settling", "blocked", "exited", "indeterminate"]),
  reasonCode: z.enum([
    "SESSION_BLOCKED",
    "SESSION_EXITED",
    "STALE_GENERATION",
    "TASK_TERMINAL",
    "TARGET_MISMATCH",
    "EXPIRED",
    "UNSUPPORTED_DELIVERY_MODE",
    "INVALID_REQUEST"
  ])
});

const steeringTerminalRefusedPayload = z.strictObject({
  ...steeringTarget,
  requestSemanticDigest: digest,
  observedSeq: nonNegative,
  observedActivity: z.literal("exited"),
  reasonCode: z.literal("TASK_TERMINAL_BEFORE_INCLUSION")
});

const steeringIncludedPayload = z.strictObject({
  ...steeringTarget,
  attemptId: boundedId,
  attemptGeneration: positive,
  promptSha256: digest
});

const steeringWithdrawnPayload = z.strictObject({
  ...steeringTarget,
  reason: shortText.optional()
});

const steeringSupersededPayload = z.strictObject({
  ...steeringTarget,
  byCommandId: boundedId
});

const steeringExpiredPayload = z.strictObject({
  ...steeringTarget
});

const taskReopenedPayload = z.strictObject({
  newGeneration: positive,
  reason: shortText.optional()
});

const scmBucketKinds = ["pull_request", "ci", "review", "mergeability"] as const;
const scmBucketDecisions = ["accept_new", "accept_changed", "accept_refresh", "accept_merged_partial", "preserve", "refuse"] as const;
const scmReactionStates = [
  "pending",
  "command_admitted",
  "included",
  "observation_resolved",
  "superseded",
  "refused",
  "failed_retryable"
] as const;

function scmFactBucketSchema<T extends z.ZodTypeAny>(facts: T) {
  return z.strictObject({ meta: scmBucketMetaSchema, facts }).superRefine((bucket, context) => {
    const candidate = bucket as unknown as { meta: { semanticHash: string }; facts: unknown };
    if (sha256Text(canonicalJson(candidate.facts)) !== candidate.meta.semanticHash) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["meta", "semanticHash"], message: "SCM bucket semantic digest disagrees with facts" });
    }
  });
}

const scmPullRequestBucket = scmFactBucketSchema(scmPullRequestFactSchema);
const scmCiBucket = scmFactBucketSchema(scmCiFactSchema);
const scmReviewBucket = scmFactBucketSchema(scmReviewFactSchema);
const scmMergeabilityBucket = scmFactBucketSchema(scmMergeabilityFactSchema);
const scmAnyBucket = z.union([scmPullRequestBucket, scmCiBucket, scmReviewBucket, scmMergeabilityBucket]);

const scmPublicationRecordedPayload = z.strictObject({
  publication: scmPublicationIntentSchema
});

const scmPublicationStateChangedPayload = z.strictObject({
  publicationId: boundedId,
  publicationGeneration: positive,
  fromState: z.enum(scmPublicationStates),
  toState: z.enum(scmPublicationStates),
  observedRemoteOid: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).nullable().optional(),
  pullRequest: scmPullRequestFactSchema.optional(),
  reasonCode: boundedId.optional()
});

const scmGuards = z.strictObject({
  pullRequest: z.string().min(1).max(1_024).optional(),
  checks: z.string().min(1).max(1_024).optional(),
  reviews: z.string().min(1).max(1_024).optional(),
  mergeability: z.string().min(1).max(1_024).optional()
});

const scmPollStartedPayload = z.strictObject({
  pollId: boundedId,
  pollAttempt: positive.max(1_024),
  publicationId: boundedId,
  publicationGeneration: positive,
  sessionId: boundedId,
  sessionGeneration: positive,
  expectedHeadSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  pullRequest: scmPullRequestIdentitySchema,
  guards: scmGuards,
  forceFullRefresh: z.boolean(),
  limits: scmProviderLimitsSchema
});

const scmBucketOutcome = z.strictObject({
  kind: z.enum(scmBucketKinds),
  decision: z.enum(scmBucketDecisions),
  semanticHash: digest.optional(),
  reasonCode: boundedId.optional(),
  failure: scmProviderFailureSchema.optional()
}).superRefine((outcome, context) => {
  const accepted = outcome.decision.startsWith("accept_");
  if (accepted !== (outcome.semanticHash !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["semanticHash"], message: "accepted SCM outcomes require exactly one semantic digest" });
  }
  if (accepted && (outcome.reasonCode !== undefined || outcome.failure !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "accepted SCM outcomes cannot carry a refusal/failure" });
  }
  if (!accepted && outcome.reasonCode === undefined && outcome.failure === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "preserved/refused SCM outcomes require a reason or failure" });
  }
});

const scmPollCompletedPayload = z.strictObject({
  pollId: boundedId,
  pollAttempt: positive.max(1_024),
  publicationId: boundedId,
  publicationGeneration: positive,
  expectedHeadSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  requestCount: nonNegative.max(10_000),
  decodedBytes: nonNegative.max(256 * 1024 * 1024),
  bucketOutcomes: z.array(scmBucketOutcome).length(4)
}).superRefine((payload, context) => {
  const kinds = payload.bucketOutcomes.map((outcome) => outcome.kind);
  if (new Set(kinds).size !== kinds.length || kinds.some((kind, index) => kind !== scmBucketKinds[index])) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["bucketOutcomes"], message: "SCM bucket outcomes must contain each kind once in canonical order" });
  }
});

const scmPollFailedPayload = z.strictObject({
  pollId: boundedId,
  pollAttempt: positive.max(1_024),
  publicationId: boundedId,
  publicationGeneration: positive,
  expectedHeadSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  failure: scmProviderFailureSchema
});

const scmBucketAcceptedPayload = z.strictObject({
  pollId: boundedId,
  publicationId: boundedId,
  publicationGeneration: positive,
  kind: z.enum(scmBucketKinds),
  decision: z.enum(["accept_new", "accept_changed", "accept_refresh", "accept_merged_partial"]),
  previousSemanticHash: digest.optional(),
  bucket: scmAnyBucket
}).superRefine((payload, context) => {
  const parsed = payload.kind === "pull_request"
    ? scmPullRequestBucket.safeParse(payload.bucket)
    : payload.kind === "ci"
      ? scmCiBucket.safeParse(payload.bucket)
      : payload.kind === "review"
        ? scmReviewBucket.safeParse(payload.bucket)
        : scmMergeabilityBucket.safeParse(payload.bucket);
  if (!parsed.success) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["bucket"], message: `SCM bucket does not match kind ${payload.kind}` });
  }
});

const scmReactionCreatedPayload = z.strictObject({
  reactionKey: digest,
  publicationId: boundedId,
  publicationGeneration: positive,
  headSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  factKind: z.enum(["ci", "review"]),
  evidenceRefs: z.array(digest).min(1).max(32),
  commandId: z.string().uuid({ version: "v7" }),
  sessionId: boundedId,
  sessionGeneration: positive,
  notBeforeAttemptGeneration: positive,
  supersedesCommandId: z.string().uuid({ version: "v7" }).optional(),
  previewSha256: digest,
  preview: steeringBodyText
}).superRefine((payload, context) => {
  if (new Set(payload.evidenceRefs).size !== payload.evidenceRefs.length ||
      payload.evidenceRefs.some((value, index) => index > 0 && payload.evidenceRefs[index - 1]! > value)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["evidenceRefs"], message: "SCM evidence references must be unique and canonically ordered" });
  }
  if (sha256Text(payload.preview) !== payload.previewSha256) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["previewSha256"], message: "SCM reaction preview digest disagrees with text" });
  }
});

const scmReactionTransitionedPayload = z.strictObject({
  reactionKey: digest,
  reactionVersion: nonNegative,
  fromState: z.enum(scmReactionStates),
  toState: z.enum(scmReactionStates),
  commandId: z.string().uuid({ version: "v7" }),
  steeringSeq: positive.optional(),
  reasonCode: boundedId.optional(),
  observationSemanticHash: digest.optional()
});

export type ControlObservationRecordDraft = Omit<ObservationRecordV1, "seq" | "recordedAt">;

const observationRecordDraftSchema: z.ZodType<ControlObservationRecordDraft> = z.unknown().transform((value, context) => {
  try {
    assertObservationSafeGraph(value);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("observation record draft is not an object");
    const input = value as Record<string, unknown>;
    if (Object.hasOwn(input, "seq") || Object.hasOwn(input, "recordedAt")) {
      throw new TypeError("durable observation sequence and record time are store-owned");
    }
    const observedAt = input.observedAt;
    if (typeof observedAt !== "string") throw new TypeError("observation time is missing");
    const parsed = ObservationRecordV1Schema.parse({
      ...input,
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      seq: 0,
      recordedAt: observedAt
    });
    const normalized = toPublicObservation(parsed);
    const { seq: _seq, recordedAt: _recordedAt, ...draft } = normalized;
    return draft;
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : "observation record draft is invalid"
    });
    return z.NEVER;
  }
});

const observationRecordedPayload = z.strictObject({
  record: observationRecordDraftSchema,
  tail: z.strictObject({
    key: boundedId,
    state: z.enum(["partial", "final"])
  }).optional()
});

const observationSourceCheckpointedPayload = z.strictObject({
  previousStateDigest: digest,
  previousState: transcriptIngestorStateSchema.optional(),
  nextState: transcriptIngestorStateSchema,
  nextStateDigest: digest,
  requestSemanticDigest: digest,
  observationRecordIds: z.array(observationRecordId)
    .max(TRANSCRIPT_INGESTOR_LIMITS.maximumRecordsPerPoll),
  observationCount: nonNegative.max(TRANSCRIPT_INGESTOR_LIMITS.maximumRecordsPerPoll)
}).superRefine((payload, context) => {
  if (payload.previousState !== undefined && transcriptIngestorStateDigest(payload.previousState) !== payload.previousStateDigest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["previousStateDigest"], message: "previous observation source state digest disagrees with state" });
  }
  if (transcriptIngestorStateDigest(payload.nextState) !== payload.nextStateDigest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["nextStateDigest"], message: "next observation source state digest disagrees with state" });
  }
  if (payload.observationCount !== payload.observationRecordIds.length ||
      new Set(payload.observationRecordIds).size !== payload.observationRecordIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["observationRecordIds"], message: "observation record identities must be unique and match the declared count" });
  }
});

const multiRepositoryFactPayload = z.strictObject({ fact: multiRepositoryFactSchema });

export const controlActorKinds = ["control-plane", "operator", "agent", "migration", "system", "integration"] as const;
export type ControlActorKind = (typeof controlActorKinds)[number];

const baseShape = {
  schemaVersion: z.literal(CONTROL_EVENT_SCHEMA_VERSION),
  eventId: boundedId,
  runId: boundedId,
  runEpoch: boundedId,
  taskId: boundedId.nullable(),
  taskGeneration: positive.nullable(),
  expectedVersion: nonNegative,
  occurredAt: timestamp,
  actorKind: z.enum(controlActorKinds),
  actorId: boundedId,
  sourceKind: boundedId.nullable(),
  sourceId: boundedId.nullable(),
  sourceGeneration: positive.nullable(),
  sourceEventId: boundedId.nullable()
};

function eventSchema<T extends string, S extends z.ZodType>(type: T, payload: S) {
  return z.strictObject({ ...baseShape, type: z.literal(type), payload });
}

const strictControlEventSchema = z.discriminatedUnion("type", [
  eventSchema("run.started", runStartedPayload),
  eventSchema("run.completed", runCompletedPayload),
  eventSchema("run.failed", runFailedPayload),
  eventSchema("run.cancelled", runCancelledPayload),
  eventSchema("run.checkpointed", runCheckpointedPayload),
  eventSchema("task.created", taskCreatedPayload),
  eventSchema("task.reopened", taskReopenedPayload),
  eventSchema("task.status_changed", taskStatusPayload),
  eventSchema("message.posted", messagePayload),
  eventSchema("runtime.observed", runtimePayload),
  eventSchema("attempt.prompt_prepared", attemptPreparedPayload),
  eventSchema("attempt.launch_planned", attemptLaunchPlannedPayload),
  eventSchema("attempt.started", attemptStartedPayload),
  eventSchema("attempt.exited", attemptExitedPayload),
  eventSchema("attempt.abandoned", attemptAbandonedPayload),
  eventSchema("steering.command_admitted", steeringAdmittedPayload),
  eventSchema("steering.command_refused", steeringRefusedPayload),
  eventSchema("steering.command_terminal_refused", steeringTerminalRefusedPayload),
  eventSchema("steering.command_included", steeringIncludedPayload),
  eventSchema("steering.command_withdrawn", steeringWithdrawnPayload),
  eventSchema("steering.command_superseded", steeringSupersededPayload),
  eventSchema("steering.command_expired", steeringExpiredPayload),
  eventSchema("scm.publication_recorded", scmPublicationRecordedPayload),
  eventSchema("scm.publication_state_changed", scmPublicationStateChangedPayload),
  eventSchema("scm.poll_started", scmPollStartedPayload),
  eventSchema("scm.poll_completed", scmPollCompletedPayload),
  eventSchema("scm.poll_failed", scmPollFailedPayload),
  eventSchema("scm.bucket_accepted", scmBucketAcceptedPayload),
  eventSchema("scm.reaction_created", scmReactionCreatedPayload),
  eventSchema("scm.reaction_transitioned", scmReactionTransitionedPayload),
  eventSchema("observation.source_checkpointed", observationSourceCheckpointedPayload),
  eventSchema("observation.recorded", observationRecordedPayload),
  eventSchema("multirepo.plan_registered", multiRepositoryFactPayload),
  eventSchema("multirepo.scheduler_transitioned", multiRepositoryFactPayload),
  eventSchema("multirepo.worktree_group_recorded", multiRepositoryFactPayload),
  eventSchema("multirepo.worker_settled", multiRepositoryFactPayload),
  eventSchema("multirepo.worktree_commit_intended", multiRepositoryFactPayload),
  eventSchema("multirepo.worktree_head_recorded", multiRepositoryFactPayload),
  eventSchema("multirepo.integration_transitioned", multiRepositoryFactPayload),
  eventSchema("multirepo.local_integration_receipted", multiRepositoryFactPayload),
  eventSchema("multirepo.publication_transitioned", multiRepositoryFactPayload)
]).superRefine((event, context) => {
  const sourceValues = [event.sourceKind, event.sourceId, event.sourceGeneration, event.sourceEventId];
  const present = sourceValues.filter((value) => value !== null).length;
  if (present !== 0 && present !== sourceValues.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "external source identity must be entirely present or entirely null"
    });
  }
  if (event.type.startsWith("multirepo.") && (event.payload as { fact: MultiRepositoryCanonicalFactV1 }).fact.kind !== event.type) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["payload", "fact", "kind"],
      message: "multi-repository control event type must equal its canonical fact kind"
    });
  }
});

/**
 * Legacy in-process callers predate explicit authorship. Parsing normalizes those callers into an
 * explicit daemon/parent identity; the canonical form and every persisted row always contain all
 * actor/source fields. Unknown fields remain rejected by the strict event variants.
 */
export const controlEventSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  return {
    ...input,
    actorKind: input.actorKind ?? "control-plane",
    actorId: input.actorId ?? "parent",
    sourceKind: input.sourceKind ?? null,
    sourceId: input.sourceId ?? null,
    sourceGeneration: input.sourceGeneration ?? null,
    sourceEventId: input.sourceEventId ?? null
  };
}, strictControlEventSchema);

export type ControlEvent = z.infer<typeof controlEventSchema>;
export type ControlEventType = ControlEvent["type"];
export type PersistedControlEvent = ControlEvent & {
  seq: number;
  /** Canonical UTC time allocated by the store, never supplied by an event producer. */
  recordedAt: string;
  /** Digest of the producer-authored, retry-stable event intent. */
  intentDigest: string;
  /** Digest of the canonical persisted event, including recordedAt. */
  digest: string;
};

export function parseControlEvent(value: unknown): ControlEvent {
  return controlEventSchema.parse(value);
}

/** Deterministic JSON for digests and exact retry comparison; arrays retain semantic order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new TypeError("canonical control values must be finite safe integers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`unsupported canonical control value: ${typeof value}`);
}

export function canonicalControlEvent(event: ControlEvent): string {
  return canonicalJson(parseControlEvent(event));
}

export function controlEventDigest(event: ControlEvent): string {
  return createHash("sha256").update(canonicalControlEvent(event), "utf8").digest("hex");
}

export function canonicalPersistedControlEvent(event: ControlEvent, recordedAt: string): string {
  return canonicalJson({ ...parseControlEvent(event), recordedAt });
}

export function persistedControlEventDigest(event: ControlEvent, recordedAt: string): string {
  return createHash("sha256").update(canonicalPersistedControlEvent(event, recordedAt), "utf8").digest("hex");
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export type ObservationCommitSemanticInput = Readonly<{
  previousStateDigest: string;
  nextState: TranscriptIngestorStateV1;
  nextStateDigest: string;
  observations: readonly ControlObservationRecordDraft[];
}>;

/**
 * Bind a source checkpoint to the exact ordered normalized records committed beside it. The
 * digest is deliberately independent of event IDs, event time, and store-owned sequences, so a
 * caller can prove an exact retry after an ambiguous post-commit failure.
 */
export function observationCommitSemanticDigest(input: ObservationCommitSemanticInput): string {
  const previousStateDigest = digest.parse(input.previousStateDigest);
  const nextState = TranscriptIngestorStateV1Schema.parse(input.nextState);
  const nextStateDigest = digest.parse(input.nextStateDigest);
  if (transcriptIngestorStateDigest(nextState) !== nextStateDigest) {
    throw new TypeError("observation commit next-state digest disagrees with state");
  }
  const observations = input.observations.map((record) => observationRecordDraftSchema.parse(record));
  return sha256Text(canonicalJson({
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    previousStateDigest,
    nextState,
    nextStateDigest,
    observations
  }));
}

export type ControlAggregate = {
  kind: "run" | "task" | "session" | "source" | "multirepo";
  id: string;
  generation: number;
  key: string;
};

export function aggregateForEvent(event: ControlEvent): ControlAggregate {
  if (event.type.startsWith("multirepo.")) {
    return {
      kind: "multirepo",
      id: event.runId,
      generation: 1,
      key: `multirepo:${event.runId}:1`
    };
  }
  if (event.type === "observation.source_checkpointed" || event.type === "observation.recorded") {
    const generation = event.type === "observation.source_checkpointed"
      ? event.payload.nextState.generation
      : event.payload.record.generation;
    const id = `${generation.agentId}:${generation.runtimeGeneration}:${generation.attemptGeneration}`;
    return {
      kind: "source",
      id,
      generation: generation.sourceGeneration,
      key: `source:${id}:${generation.sourceGeneration}`
    };
  }
  if (
    event.type === "runtime.observed" ||
    event.type === "steering.command_admitted" ||
    event.type === "steering.command_refused" ||
    event.type === "steering.command_terminal_refused" ||
    event.type === "steering.command_included" ||
    event.type === "steering.command_withdrawn" ||
    event.type === "steering.command_superseded" ||
    event.type === "steering.command_expired"
  ) {
    const generation = event.payload.sessionGeneration;
    return {
      kind: "session",
      id: event.payload.sessionId,
      generation,
      key: `session:${event.payload.sessionId}:${generation}`
    };
  }
  if (event.taskId !== null) {
    if (event.taskGeneration === null) throw new TypeError("task-scoped event requires taskGeneration");
    return {
      kind: "task",
      id: event.taskId,
      generation: event.taskGeneration,
      key: `task:${event.taskId}:${event.taskGeneration}`
    };
  }
  return { kind: "run", id: event.runId, generation: 1, key: `run:${event.runId}:1` };
}

export function assertControlEventScope(event: ControlEvent): void {
  const taskRequired = event.type.startsWith("task.") || event.type.startsWith("attempt.") || event.type.startsWith("steering.") || event.type.startsWith("scm.");
  if (taskRequired && (event.taskId === null || event.taskGeneration === null)) {
    throw new TypeError(`${event.type} requires taskId and taskGeneration`);
  }
  if ((event.taskId === null) !== (event.taskGeneration === null)) {
    throw new TypeError("taskId and taskGeneration must both be present or both be null");
  }
  if (event.type.startsWith("run.") && event.taskId !== null) {
    throw new TypeError(`${event.type} must be run-scoped`);
  }
  if (event.type.startsWith("multirepo.")) {
    const fact = (event.payload as { fact: MultiRepositoryCanonicalFactV1 }).fact;
    if (fact.kind === "multirepo.plan_registered") {
      if (event.taskId !== null || event.taskGeneration !== null) {
        throw new TypeError("multirepo.plan_registered must be run-scoped");
      }
      if (fact.plan.runId !== event.runId || fact.plan.runEpoch !== event.runEpoch) {
        throw new TypeError("multi-repository plan belongs to another run identity");
      }
    } else {
      const factTaskId = fact.kind === "multirepo.scheduler_transitioned" ? fact.event.taskId : fact.taskId;
      const factTaskGeneration = fact.kind === "multirepo.scheduler_transitioned" ? fact.event.taskGeneration : fact.taskGeneration;
      if (event.taskId === null || event.taskGeneration === null || event.taskId !== factTaskId || event.taskGeneration !== factTaskGeneration) {
        throw new TypeError(`${event.type} task fence disagrees with its canonical fact`);
      }
    }
  }
  if (event.type === "observation.source_checkpointed" || event.type === "observation.recorded") {
    const generation = event.type === "observation.source_checkpointed"
      ? event.payload.nextState.generation
      : event.payload.record.generation;
    if (generation.runId !== event.runId || generation.runEpoch !== event.runEpoch) {
      throw new TypeError(`${event.type} generation belongs to another run identity`);
    }
    if ((generation.taskId ?? null) !== event.taskId || (generation.taskId === undefined) !== (event.taskGeneration === null)) {
      throw new TypeError(`${event.type} task scope disagrees with its generation tuple`);
    }
  }
}

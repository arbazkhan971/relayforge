import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  assertControlEventScope,
  canonicalJson,
  controlEventDigest,
  parseControlEvent,
  persistedControlEventDigest,
  sha256Text,
  type PersistedControlEvent
} from "../control/events.js";
import {
  STEERING_REDUCER_VERSION,
  STEERING_SCHEMA_VERSION,
  steeringCommandKinds,
  steeringRefusalReasonCodes,
  steeringSemanticFields,
  steeringSourceKinds,
  type SteeringCommandDraftV1,
  type SteeringCommandV1,
  type SteeringProjection,
  type SteeringRefusalV1,
  type SteeringSemanticComparison,
  type SteeringSemanticField,
  type SteeringTargetV1
} from "./types.js";

export const STEERING_BODY_MAX_SCALARS = 8_192;
export const STEERING_BODY_MAX_BYTES = 16 * 1_024;
export const STEERING_EVIDENCE_MAX_REFS = 32;
export const STEERING_BOUNDARY_MAX_COMMANDS = 32;
export const STEERING_BOUNDARY_MAX_BYTES = 64 * 1_024;

const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;
const boundedIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

export const SteeringBoundedIdSchema = z.string().regex(boundedIdPattern);
export const SteeringCommandIdSchema = z.string().regex(uuidV7Pattern, "command ID must be a canonical lowercase UUIDv7");
export const SteeringSha256Schema = z.string().regex(sha256Pattern);
export const SteeringSequenceSchema = z.number().int().min(0).max(MAX_SEQUENCE);
export const SteeringEventSequenceSchema = z.number().int().min(1).max(MAX_SEQUENCE);
export const SteeringPositiveGenerationSchema = z.number().int().min(1).max(MAX_SEQUENCE);
export const SteeringTimestampSchema = z.string().datetime({ offset: true });

type UnicodeAnalysis = { valid: true; scalars: number } | { valid: false; scalars: number };

function analyzeUnicode(value: string): UnicodeAnalysis {
  let scalars = 0;
  for (let index = 0; index < value.length;) {
    const first = value.charCodeAt(index);
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(index + 1);
      if (!(second >= 0xdc00 && second <= 0xdfff)) return { valid: false, scalars };
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      return { valid: false, scalars };
    }
    const codePoint = value.codePointAt(index)!;
    if (
      (codePoint >= 0xfdd0 && codePoint <= 0xfdef) ||
      (codePoint & 0xffff) === 0xfffe ||
      (codePoint & 0xffff) === 0xffff
    ) {
      return { valid: false, scalars };
    }
    // Prompt text permits ordinary whitespace, but never transport-hostile control scalars.
    if ((codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a) || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return { valid: false, scalars };
    }
    scalars += 1;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return { valid: true, scalars };
}

/** The only semantic normalization P2 performs: CRLF and lone CR become LF. */
export function normalizeSteeringBody(value: string): string {
  if (typeof value !== "string") throw new TypeError("steering body must be a string");
  const normalized = value.replace(/\r\n?/g, "\n");
  const analysis = analyzeUnicode(normalized);
  if (!analysis.valid) throw new TypeError("steering body contains an invalid or disallowed Unicode scalar");
  if (analysis.scalars === 0) throw new TypeError("steering body must not be empty");
  if (analysis.scalars > STEERING_BODY_MAX_SCALARS) {
    throw new TypeError(`steering body exceeds ${STEERING_BODY_MAX_SCALARS} Unicode scalars`);
  }
  if (Buffer.byteLength(normalized, "utf8") > STEERING_BODY_MAX_BYTES) {
    throw new TypeError(`steering body exceeds ${STEERING_BODY_MAX_BYTES} UTF-8 bytes`);
  }
  return normalized;
}

export const SteeringBodySchema = z.preprocess(
  (value) => typeof value === "string" ? value.replace(/\r\n?/g, "\n") : value,
  z.string().superRefine((value, context) => {
    const analysis = analyzeUnicode(value);
    if (!analysis.valid) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "body contains an invalid or disallowed Unicode scalar" });
      return;
    }
    if (analysis.scalars === 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "body must not be empty" });
    }
    if (analysis.scalars > STEERING_BODY_MAX_SCALARS) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `body exceeds ${STEERING_BODY_MAX_SCALARS} Unicode scalars` });
    }
    if (Buffer.byteLength(value, "utf8") > STEERING_BODY_MAX_BYTES) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `body exceeds ${STEERING_BODY_MAX_BYTES} UTF-8 bytes` });
    }
  })
);

const targetShape = {
  runId: SteeringBoundedIdSchema,
  runEpoch: SteeringBoundedIdSchema,
  taskId: SteeringBoundedIdSchema,
  taskGeneration: SteeringPositiveGenerationSchema,
  sessionId: SteeringBoundedIdSchema,
  sessionGeneration: SteeringPositiveGenerationSchema,
  notBeforeAttemptGeneration: SteeringPositiveGenerationSchema
};

export const SteeringTargetV1Schema = z.strictObject(targetShape);

const commandDraftShape = {
  schemaVersion: z.literal(STEERING_SCHEMA_VERSION),
  commandId: SteeringCommandIdSchema,
  ...targetShape,
  kind: z.enum(steeringCommandKinds),
  sourceKind: z.enum(steeringSourceKinds),
  parentPrincipal: SteeringBoundedIdSchema,
  evidenceRefs: z.array(SteeringBoundedIdSchema).max(STEERING_EVIDENCE_MAX_REFS),
  body: SteeringBodySchema,
  createdAt: SteeringTimestampSchema,
  expiresAt: SteeringTimestampSchema.optional(),
  supersedesCommandId: SteeringCommandIdSchema.optional()
};

function validateCommandRelations(
  command: {
    commandId: string;
    evidenceRefs: string[];
    createdAt: string;
    expiresAt?: string;
    supersedesCommandId?: string;
  },
  context: z.RefinementCtx
): void {
  if (new Set(command.evidenceRefs).size !== command.evidenceRefs.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["evidenceRefs"], message: "evidence references must be unique" });
  }
  if (command.supersedesCommandId === command.commandId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["supersedesCommandId"], message: "a command cannot supersede itself" });
  }
  if (command.expiresAt !== undefined && Date.parse(command.expiresAt) <= Date.parse(command.createdAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "expiry must be later than creation" });
  }
}

export const SteeringCommandDraftV1Schema = z.strictObject(commandDraftShape).superRefine(validateCommandRelations);

export const SteeringCommandV1Schema = z.strictObject({
  ...commandDraftShape,
  bodySha256: SteeringSha256Schema
}).superRefine((command, context) => {
  validateCommandRelations(command, context);
  const expected = sha256Text(command.body);
  if (command.bodySha256 !== expected) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["bodySha256"], message: "body digest does not match normalized UTF-8 bytes" });
  }
});

export const SteeringRefusalV1Schema = z.strictObject({
  schemaVersion: z.literal(STEERING_SCHEMA_VERSION),
  commandId: SteeringCommandIdSchema,
  runId: SteeringBoundedIdSchema,
  runEpoch: SteeringBoundedIdSchema,
  taskId: SteeringBoundedIdSchema,
  taskGeneration: SteeringPositiveGenerationSchema,
  sessionId: SteeringBoundedIdSchema,
  sessionGeneration: SteeringPositiveGenerationSchema,
  bodySha256: SteeringSha256Schema,
  requestSemanticDigest: SteeringSha256Schema,
  observedSeq: SteeringSequenceSchema,
  observedActivity: z.enum(["idle", "waiting_input", "dispatching", "active", "settling", "blocked", "exited", "indeterminate"]),
  reasonCode: z.enum(steeringRefusalReasonCodes)
});

export function parseSteeringTarget(value: unknown): SteeringTargetV1 {
  return SteeringTargetV1Schema.parse(value) as SteeringTargetV1;
}

export function parseSteeringCommandDraft(value: unknown): SteeringCommandDraftV1 {
  return SteeringCommandDraftV1Schema.parse(value) as SteeringCommandDraftV1;
}

export function materializeSteeringCommand(value: unknown): SteeringCommandV1 {
  const draft = parseSteeringCommandDraft(value);
  return SteeringCommandV1Schema.parse({ ...draft, bodySha256: sha256Text(draft.body) }) as SteeringCommandV1;
}

export function parseSteeringCommand(value: unknown): SteeringCommandV1 {
  return SteeringCommandV1Schema.parse(value) as SteeringCommandV1;
}

export function parseSteeringRefusal(value: unknown): SteeringRefusalV1 {
  return SteeringRefusalV1Schema.parse(value) as SteeringRefusalV1;
}

/** Canonical semantic value used for global command-ID retry comparison. */
export function steeringCommandSemanticValue(value: unknown): Record<SteeringSemanticField, unknown> {
  const command = parseSteeringCommand(value);
  return {
    schemaVersion: command.schemaVersion,
    commandId: command.commandId,
    runId: command.runId,
    runEpoch: command.runEpoch,
    taskId: command.taskId,
    taskGeneration: command.taskGeneration,
    sessionId: command.sessionId,
    sessionGeneration: command.sessionGeneration,
    notBeforeAttemptGeneration: command.notBeforeAttemptGeneration,
    kind: command.kind,
    sourceKind: command.sourceKind,
    parentPrincipal: command.parentPrincipal,
    evidenceRefs: [...command.evidenceRefs],
    body: command.body,
    bodySha256: command.bodySha256,
    createdAt: command.createdAt,
    expiresAt: command.expiresAt,
    supersedesCommandId: command.supersedesCommandId
  };
}

export function steeringCommandSemanticDigest(value: unknown): string {
  return sha256Text(canonicalJson(steeringCommandSemanticValue(value)));
}

function equalSemanticValue(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return canonicalJson(left) === canonicalJson(right);
}

export function compareSteeringCommandSemantics(original: unknown, candidate: unknown): SteeringSemanticComparison {
  const originalValue = steeringCommandSemanticValue(original);
  const candidateValue = steeringCommandSemanticValue(candidate);
  const originalDigest = sha256Text(canonicalJson(originalValue));
  const candidateDigest = sha256Text(canonicalJson(candidateValue));
  if (originalDigest === candidateDigest) return { result: "exact", digest: originalDigest, changedFields: [] };
  const changedFields = steeringSemanticFields.filter(
    (field) => !equalSemanticValue(originalValue[field], candidateValue[field])
  );
  return { result: "conflict", originalDigest, candidateDigest, changedFields };
}

export function sameSteeringTarget(
  left: Pick<SteeringTargetV1, "runId" | "runEpoch" | "taskId" | "taskGeneration" | "sessionId" | "sessionGeneration">,
  right: Pick<SteeringTargetV1, "runId" | "runEpoch" | "taskId" | "taskGeneration" | "sessionId" | "sessionGeneration">
): boolean {
  return left.runId === right.runId &&
    left.runEpoch === right.runEpoch &&
    left.taskId === right.taskId &&
    left.taskGeneration === right.taskGeneration &&
    left.sessionId === right.sessionId &&
    left.sessionGeneration === right.sessionGeneration;
}

export function createSteeringCommandId(options: { nowMs?: number; random?: Uint8Array } = {}): string {
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > 0xffffffffffff) {
    throw new RangeError("UUIDv7 timestamp must be an integer in the unsigned 48-bit range");
  }
  const entropy = options.random ?? randomBytes(10);
  if (!(entropy instanceof Uint8Array) || entropy.byteLength !== 10) {
    throw new TypeError("UUIDv7 entropy must contain exactly 10 bytes");
  }
  const bytes = new Uint8Array(16);
  let timestamp = BigInt(nowMs);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes.set(entropy, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const persistedMetadataSchema = z.strictObject({
  seq: z.number().int().min(1).max(MAX_SEQUENCE),
  recordedAt: SteeringTimestampSchema,
  intentDigest: SteeringSha256Schema,
  digest: SteeringSha256Schema
});

/** Strictly validates both the public P1 event and its canonical persisted metadata/digests. */
export function parsePersistedControlEvent(value: unknown): PersistedControlEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("persisted control event must be an object");
  }
  const source = value as Record<string, unknown>;
  const metadata = persistedMetadataSchema.parse({
    seq: source.seq,
    recordedAt: source.recordedAt,
    intentDigest: source.intentDigest,
    digest: source.digest
  });
  const eventValue = { ...source };
  delete eventValue.seq;
  delete eventValue.recordedAt;
  delete eventValue.intentDigest;
  delete eventValue.digest;
  for (const field of ["actorKind", "actorId", "sourceKind", "sourceId", "sourceGeneration", "sourceEventId"] as const) {
    if (!Object.hasOwn(eventValue, field)) throw new TypeError(`persisted control event is missing explicit ${field}`);
  }
  const event = parseControlEvent(eventValue);
  assertControlEventScope(event);
  if (controlEventDigest(event) !== metadata.intentDigest) {
    throw new TypeError("persisted control event intent digest mismatch");
  }
  if (persistedControlEventDigest(event, metadata.recordedAt) !== metadata.digest) {
    throw new TypeError("persisted control event digest mismatch");
  }
  return { ...event, ...metadata };
}

const admittedRecordBase = {
  command: SteeringCommandV1Schema,
  admittedSeq: SteeringEventSequenceSchema
};

export const SteeringCommandRecordSchema = z.union([
  z.strictObject({ status: z.literal("pending"), ...admittedRecordBase }),
  z.strictObject({
    status: z.literal("included"),
    ...admittedRecordBase,
    terminalSeq: SteeringEventSequenceSchema,
    attemptId: SteeringBoundedIdSchema,
    attemptGeneration: SteeringPositiveGenerationSchema,
    promptSha256: SteeringSha256Schema
  }),
  z.strictObject({
    status: z.literal("withdrawn"),
    ...admittedRecordBase,
    terminalSeq: SteeringEventSequenceSchema,
    reason: z.string().max(4_096).optional()
  }),
  z.strictObject({
    status: z.literal("superseded"),
    ...admittedRecordBase,
    terminalSeq: SteeringEventSequenceSchema,
    byCommandId: SteeringCommandIdSchema
  }),
  z.strictObject({
    status: z.literal("expired"),
    ...admittedRecordBase,
    terminalSeq: SteeringEventSequenceSchema
  }),
  z.strictObject({
    status: z.literal("refused"),
    refusal: SteeringRefusalV1Schema,
    terminalSeq: SteeringEventSequenceSchema
  }),
  z.strictObject({
    status: z.literal("refused"),
    ...admittedRecordBase,
    terminalSeq: SteeringEventSequenceSchema,
    terminalRefusal: z.strictObject({
      requestSemanticDigest: SteeringSha256Schema,
      observedSeq: SteeringSequenceSchema,
      observedActivity: z.literal("exited"),
      reasonCode: z.literal("TASK_TERMINAL_BEFORE_INCLUSION")
    })
  })
]);

export const SteeringPromptManifestFactSchema = z.strictObject({
  attemptId: SteeringBoundedIdSchema,
  attemptGeneration: SteeringPositiveGenerationSchema,
  runId: SteeringBoundedIdSchema,
  runEpoch: SteeringBoundedIdSchema,
  taskId: SteeringBoundedIdSchema,
  taskGeneration: SteeringPositiveGenerationSchema,
  sessionId: SteeringBoundedIdSchema,
  sessionGeneration: SteeringPositiveGenerationSchema,
  artifactLocator: z.string().min(1).max(256).regex(/^steering\/prompts\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\.prompt$/),
  promptSha256: SteeringSha256Schema,
  promptBytes: SteeringSequenceSchema.max(16 * 1024 * 1024),
  rendererVersion: SteeringPositiveGenerationSchema,
  captureCutoffSeq: SteeringSequenceSchema,
  steeringCommandIds: z.array(SteeringCommandIdSchema).max(STEERING_BOUNDARY_MAX_COMMANDS),
  preparedSeq: SteeringEventSequenceSchema
});

export const SteeringProjectionSchema = z.strictObject({
  schemaVersion: z.literal(STEERING_SCHEMA_VERSION),
  reducerVersion: z.literal(STEERING_REDUCER_VERSION),
  runId: SteeringBoundedIdSchema,
  runEpoch: SteeringBoundedIdSchema,
  observedSeq: SteeringSequenceSchema,
  commands: z.record(SteeringCommandIdSchema, SteeringCommandRecordSchema),
  manifests: z.record(SteeringBoundedIdSchema, SteeringPromptManifestFactSchema)
}).superRefine((projection, context) => {
  for (const [commandId, record] of Object.entries(projection.commands)) {
    const initialRefusal = record.status === "refused" && "refusal" in record;
    const innerId = initialRefusal ? record.refusal.commandId : record.command.commandId;
    if (commandId !== innerId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["commands", commandId], message: "command map key does not match command identity" });
    }
    const latestSeq = record.status === "pending" ? record.admittedSeq : record.terminalSeq;
    if (latestSeq > projection.observedSeq) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["commands", commandId], message: "command sequence exceeds observed sequence" });
    }
    if (record.status !== "pending" && (!initialRefusal) && record.terminalSeq <= record.admittedSeq) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["commands", commandId], message: "terminal sequence must follow admission" });
    }
  }
  for (const [attemptId, manifest] of Object.entries(projection.manifests)) {
    if (attemptId !== manifest.attemptId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["manifests", attemptId], message: "manifest map key does not match attempt identity" });
    }
    if (manifest.preparedSeq > projection.observedSeq || manifest.captureCutoffSeq >= manifest.preparedSeq) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["manifests", attemptId], message: "manifest sequence bounds are invalid" });
    }
    if (new Set(manifest.steeringCommandIds).size !== manifest.steeringCommandIds.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["manifests", attemptId, "steeringCommandIds"], message: "manifest command IDs must be unique" });
    }
  }
});

export function parseSteeringProjection(value: unknown): SteeringProjection {
  return SteeringProjectionSchema.parse(value) as SteeringProjection;
}

import type { PersistedControlEvent } from "../control/events.js";
import type { ActivityState, DerivedActivity } from "../control/reducer.js";

export const STEERING_SCHEMA_VERSION = 1 as const;
export const STEERING_REDUCER_VERSION = 1 as const;

export const steeringCommandKinds = ["steer_next_boundary"] as const;
export type SteeringCommandKind = (typeof steeringCommandKinds)[number];

export const steeringSourceKinds = ["operator", "review_gate", "verifier", "control_plane"] as const;
export type SteeringSourceKind = (typeof steeringSourceKinds)[number];

export const steeringRefusalReasonCodes = [
  "SESSION_BLOCKED",
  "SESSION_EXITED",
  "STALE_GENERATION",
  "TASK_TERMINAL",
  "TARGET_MISMATCH",
  "EXPIRED",
  "UNSUPPORTED_DELIVERY_MODE",
  "INVALID_REQUEST",
  "TASK_TERMINAL_BEFORE_INCLUSION"
] as const;
export type SteeringRefusalReasonCode = (typeof steeringRefusalReasonCodes)[number];

export type SteeringTargetV1 = {
  /** P1's unguessable run epoch is the exact run-generation fence. */
  runId: string;
  runEpoch: string;
  taskId: string;
  taskGeneration: number;
  sessionId: string;
  sessionGeneration: number;
  notBeforeAttemptGeneration: number;
};

export type SteeringCommandDraftV1 = SteeringTargetV1 & {
  schemaVersion: typeof STEERING_SCHEMA_VERSION;
  commandId: string;
  kind: SteeringCommandKind;
  sourceKind: SteeringSourceKind;
  parentPrincipal: string;
  evidenceRefs: string[];
  body: string;
  createdAt: string;
  expiresAt?: string;
  supersedesCommandId?: string;
};

export type SteeringCommandV1 = SteeringCommandDraftV1 & {
  bodySha256: string;
};

export type SteeringRefusalV1 = Omit<SteeringTargetV1, "notBeforeAttemptGeneration"> & {
  schemaVersion: typeof STEERING_SCHEMA_VERSION;
  commandId: string;
  bodySha256: string;
  requestSemanticDigest: string;
  observedSeq: number;
  observedActivity: SteeringActivityState | "indeterminate";
  reasonCode: SteeringRefusalReasonCode;
};

export type SteeringPendingRecord = {
  status: "pending";
  command: SteeringCommandV1;
  admittedSeq: number;
};

export type SteeringIncludedRecord = {
  status: "included";
  command: SteeringCommandV1;
  admittedSeq: number;
  terminalSeq: number;
  attemptId: string;
  attemptGeneration: number;
  promptSha256: string;
};

export type SteeringWithdrawnRecord = {
  status: "withdrawn";
  command: SteeringCommandV1;
  admittedSeq: number;
  terminalSeq: number;
  reason?: string;
};

export type SteeringSupersededRecord = {
  status: "superseded";
  command: SteeringCommandV1;
  admittedSeq: number;
  terminalSeq: number;
  byCommandId: string;
};

export type SteeringExpiredRecord = {
  status: "expired";
  command: SteeringCommandV1;
  admittedSeq: number;
  terminalSeq: number;
};

export type SteeringRefusedRecord = {
  status: "refused";
  refusal: SteeringRefusalV1;
  terminalSeq: number;
};

export type SteeringTerminalRefusedRecord = {
  status: "refused";
  command: SteeringCommandV1;
  admittedSeq: number;
  terminalSeq: number;
  terminalRefusal: {
    requestSemanticDigest: string;
    observedSeq: number;
    observedActivity: "exited";
    reasonCode: "TASK_TERMINAL_BEFORE_INCLUSION";
  };
};

export type SteeringCommandRecord =
  | SteeringPendingRecord
  | SteeringIncludedRecord
  | SteeringWithdrawnRecord
  | SteeringSupersededRecord
  | SteeringExpiredRecord
  | SteeringRefusedRecord
  | SteeringTerminalRefusedRecord;

export type SteeringPromptManifestFact = {
  attemptId: string;
  attemptGeneration: number;
  runId: string;
  runEpoch: string;
  taskId: string;
  taskGeneration: number;
  sessionId: string;
  sessionGeneration: number;
  artifactLocator: string;
  promptSha256: string;
  promptBytes: number;
  rendererVersion: number;
  captureCutoffSeq: number;
  steeringCommandIds: string[];
  preparedSeq: number;
};

export type SteeringProjection = {
  schemaVersion: typeof STEERING_SCHEMA_VERSION;
  reducerVersion: typeof STEERING_REDUCER_VERSION;
  runId: string;
  runEpoch: string;
  observedSeq: number;
  commands: Record<string, SteeringCommandRecord>;
  manifests: Record<string, SteeringPromptManifestFact>;
};

export type SteeringActivityState = ActivityState;
export const steeringActivityStates = [
  "idle",
  "waiting_input",
  "dispatching",
  "active",
  "settling",
  "blocked",
  "exited"
] as const satisfies readonly SteeringActivityState[];
export type SteeringActivityCertainty = "proven" | "indeterminate";
export type SteeringAdmissionDisposition =
  | "initial_boundary_only"
  | "next_boundary"
  | "future_attempt"
  | "refused"
  | "indeterminate";

export type SteeringActivity = DerivedActivity & {
  state: SteeringActivityState;
  certainty: SteeringActivityCertainty;
  admission: SteeringAdmissionDisposition;
  captureEligible: boolean;
  nextAttemptGeneration: number;
  refusalReason?: Extract<SteeringRefusalReasonCode, "SESSION_BLOCKED" | "SESSION_EXITED">;
};

export const steeringLifecycleEventTypes = [
  "attempt.prompt_prepared",
  "steering.command_admitted",
  "steering.command_refused",
  "steering.command_terminal_refused",
  "steering.command_included",
  "steering.command_withdrawn",
  "steering.command_superseded",
  "steering.command_expired"
] as const;
export type SteeringLifecycleEventType = (typeof steeringLifecycleEventTypes)[number];
export type SteeringLifecycleEvent = Extract<PersistedControlEvent, { type: SteeringLifecycleEventType }>;

export const steeringSemanticFields = [
  "schemaVersion",
  "commandId",
  "runId",
  "runEpoch",
  "taskId",
  "taskGeneration",
  "sessionId",
  "sessionGeneration",
  "notBeforeAttemptGeneration",
  "kind",
  "sourceKind",
  "parentPrincipal",
  "evidenceRefs",
  "body",
  "bodySha256",
  "createdAt",
  "expiresAt",
  "supersedesCommandId"
] as const;
export type SteeringSemanticField = (typeof steeringSemanticFields)[number];

export type SteeringSemanticComparison =
  | { result: "exact"; digest: string; changedFields: [] }
  | {
      result: "conflict";
      originalDigest: string;
      candidateDigest: string;
      changedFields: SteeringSemanticField[];
    };

import {
  aggregateForEvent,
  assertControlEventScope,
  canonicalJson,
  sha256Text,
  type ControlTaskStatus,
  type PersistedControlEvent
} from "./events.js";
import type {
  ScmCiFactV1,
  ScmFactBucketV1,
  ScmMergeabilityFactV1,
  ScmObservationGuardsV1,
  ScmProviderFailureV1,
  ScmProviderLimitsV1,
  ScmPublicationIntentV1,
  ScmPublicationState,
  ScmPullRequestFactV1,
  ScmPullRequestIdentityV1,
  ScmReviewFactV1
} from "../scm/types.js";
import {
  applyControlRoomFact,
  emptyControlRoomProjection,
  type ControlRoomAgentRowV1,
  type ControlRoomAttention,
  type ControlRoomProjectionV1
} from "../control-room/projection.js";
import {
  toPublicObservation
} from "../observability/public.js";
import {
  transcriptIngestorStateDigest,
  type TranscriptIngestorStateV1
} from "../observability/transcript-ingestor.js";
import type { ObservationGenerationV1 } from "../observability/types.js";
import {
  projectMultiRepositoryCanonicalFacts,
  type MultiRepositoryCanonicalFactV1,
  type MultiRepositoryCanonicalProjectionV1
} from "../multirepo/orchestration.js";

export type TaskFact = {
  id: string;
  generation: number;
  title: string;
  assignee: string;
  createdBy: string;
  description: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
  priority: number;
  createdAt: string;
  files?: string[];
  status: ControlTaskStatus;
  claimedBy?: string;
  lastSummary?: string;
  lastUpdate: string;
  attempts: number;
  version: number;
  updatedSeq: number;
};

export type MessageFact = {
  messageId: string;
  seq: number;
  taskId?: string;
  taskGeneration?: number;
  from: string;
  to: string;
  body: string;
  occurredAt: string;
};

export type RuntimeFact = {
  sessionId: string;
  sessionGeneration: number;
  taskId?: string;
  taskGeneration?: number;
  observation: "available" | "waiting_input" | "blocked" | "exited" | "probe_failed";
  launchId?: string;
  reason?: string;
  observedAt: string;
  updatedSeq: number;
};

export type AttemptFact = {
  attemptId: string;
  attemptGeneration: number;
  taskId: string;
  taskGeneration: number;
  sessionId: string;
  sessionGeneration: number;
  artifactLocator?: string;
  promptSha256?: string;
  promptBytes?: number;
  rendererVersion?: number;
  captureCutoffSeq?: number;
  steeringCommandIds: string[];
  launchId?: string;
  pid?: number;
  processStartToken?: string;
  state: "prepared" | "active" | "exited" | "abandoned";
  outcome?: "succeeded" | "failed" | "cancelled" | "uncertain";
  exitCode?: number;
  summary?: string;
  abandonReason?: "OPERATOR_ABANDONED" | "VERIFIED_NEVER_STARTED" | "ARTIFACT_UNRECOVERABLE";
  preparedSeq?: number;
  launchPlannedSeq?: number;
  startedSeq?: number;
  exitedSeq?: number;
  abandonedSeq?: number;
};

export type SteeringFact = {
  commandId: string;
  sessionId: string;
  sessionGeneration: number;
  taskId: string;
  taskGeneration: number;
  bodySha256: string;
  requestSemanticDigest?: string;
  observedSeq?: number;
  observedActivity?: "idle" | "waiting_input" | "dispatching" | "active" | "settling" | "blocked" | "exited" | "indeterminate";
  status: "pending" | "included" | "refused" | "withdrawn" | "superseded" | "expired";
  admittedSeq?: number;
  terminalSeq?: number;
  notBeforeAttemptGeneration?: number;
  kind?: "steer_next_boundary";
  sourceKind?: "operator" | "review_gate" | "verifier" | "control_plane";
  parentPrincipal?: string;
  evidenceRefs?: string[];
  body?: string;
  createdAt?: string;
  expiresAt?: string;
  supersedesCommandId?: string;
  reasonCode?: string;
  attemptId?: string;
  attemptGeneration?: number;
  promptSha256?: string;
  byCommandId?: string;
};

export type ScmPublicationFact = {
  publicationId: string;
  generation: number;
  version: number;
  state: ScmPublicationState;
  intent: ScmPublicationIntentV1;
  taskId: string;
  taskGeneration: number;
  observedRemoteOid?: string | null;
  pullRequest?: ScmPullRequestFactV1;
  reasonCode?: string;
  createdSeq: number;
  updatedSeq: number;
};

export type ScmPollBucketOutcomeFact = {
  kind: "pull_request" | "ci" | "review" | "mergeability";
  decision: "accept_new" | "accept_changed" | "accept_refresh" | "accept_merged_partial" | "preserve" | "refuse";
  semanticHash?: string;
  reasonCode?: string;
  failure?: ScmProviderFailureV1;
};

export type ScmPollFact = {
  pollId: string;
  pollAttempt: number;
  publicationId: string;
  publicationGeneration: number;
  taskId: string;
  taskGeneration: number;
  sessionId: string;
  sessionGeneration: number;
  expectedHeadSha: string;
  pullRequest: ScmPullRequestIdentityV1;
  guards: ScmObservationGuardsV1;
  forceFullRefresh: boolean;
  limits: ScmProviderLimitsV1;
  state: "started" | "completed" | "failed";
  requestCount?: number;
  decodedBytes?: number;
  bucketOutcomes?: ScmPollBucketOutcomeFact[];
  acceptedKinds: Array<"pull_request" | "ci" | "review" | "mergeability">;
  failure?: ScmProviderFailureV1;
  nextEligibleAt?: string;
  startedAt: string;
  startedSeq: number;
  terminalSeq?: number;
};

export type ScmObservationBucketsFact = {
  pullRequest?: ScmFactBucketV1<ScmPullRequestFactV1>;
  ci?: ScmFactBucketV1<ScmCiFactV1>;
  review?: ScmFactBucketV1<ScmReviewFactV1>;
  mergeability?: ScmFactBucketV1<ScmMergeabilityFactV1>;
};

export type ScmObservationFact = {
  publicationId: string;
  publicationGeneration: number;
  taskId: string;
  taskGeneration: number;
  headSha: string;
  buckets: ScmObservationBucketsFact;
  updatedSeq: number;
};

export type ScmReactionState =
  | "pending"
  | "command_admitted"
  | "included"
  | "observation_resolved"
  | "superseded"
  | "refused"
  | "failed_retryable";

export type ScmReactionFact = {
  reactionKey: string;
  publicationId: string;
  publicationGeneration: number;
  taskId: string;
  taskGeneration: number;
  headSha: string;
  factKind: "ci" | "review";
  evidenceRefs: string[];
  commandId: string;
  sessionId: string;
  sessionGeneration: number;
  notBeforeAttemptGeneration: number;
  supersedesCommandId?: string;
  previewSha256: string;
  preview: string;
  state: ScmReactionState;
  version: number;
  steeringSeq?: number;
  reasonCode?: string;
  observationSemanticHash?: string;
  createdSeq: number;
  updatedSeq: number;
};

export type ScmControlProjection = {
  schemaVersion: 1;
  publications: Record<string, ScmPublicationFact>;
  polls: Record<string, ScmPollFact>;
  observations: Record<string, ScmObservationFact>;
  reactions: Record<string, ScmReactionFact>;
};

export type ObservationSourceCheckpointFact = {
  sourceKind: string;
  sourceId: string;
  stateDigest: string;
  requestSemanticDigest: string;
  observationRecordIds: string[];
  observationCount: number;
  state: TranscriptIngestorStateV1;
  updatedSeq: number;
};

export type ObservabilityControlProjection = {
  schemaVersion: 1;
  sources: Record<string, ObservationSourceCheckpointFact>;
  room: ControlRoomProjectionV1;
};

export type AggregateVersion = {
  kind: "run" | "task" | "session" | "source" | "multirepo";
  id: string;
  generation: number;
  version: number;
  updatedSeq: number;
};

export type RunFact = {
  status: "started" | "completed" | "failed" | "cancelled";
  startedBy: string;
  goal?: string;
  configDigest?: string;
  startedAt: string;
  terminalAt?: string;
  reasonCode?: string;
  summary?: string;
  cancelledBy?: string;
  checkpoint?: LoopCheckpointFact;
  version: number;
  updatedSeq: number;
};

export type LoopCheckpointFact = {
  project: string;
  phase: "init" | "verify-preflight" | "dispatch" | "review" | "post-check" | "stopped" | "cancelled" | "complete";
  status: "running" | "planned" | "blocked" | "done" | "unverified" | "stopped" | "cancelled";
  iteration: number;
  dispatched: number;
  accepted: number;
  rejected: number;
  escalations: number;
  repeatFailures: number;
  unknownCostCalls: number;
  runBranch?: string;
  lastGreenCommit?: string;
  lastFailureSignature?: string;
  lastFailureSummary?: string;
  lastStopReason?: string;
  verifyFingerprint?: string;
  startedAt: string;
  updatedAt: string;
};

export type ControlProjection = {
  runId: string;
  runEpoch: string;
  headSeq: number;
  run?: RunFact;
  tasks: Record<string, TaskFact>;
  messages: MessageFact[];
  runtimes: Record<string, RuntimeFact>;
  attempts: Record<string, AttemptFact>;
  steering: Record<string, SteeringFact>;
  scm: ScmControlProjection;
  observability: ObservabilityControlProjection;
  multirepo: MultiRepositoryControlProjection;
  aggregateVersions: Record<string, AggregateVersion>;
};

export type MultiRepositoryControlProjection = Readonly<{
  schemaVersion: 1;
  headVersion: number;
  facts: readonly MultiRepositoryCanonicalFactV1[];
  state: MultiRepositoryCanonicalProjectionV1;
}>;

export type ActivityState = "idle" | "waiting_input" | "dispatching" | "active" | "settling" | "blocked" | "exited";

export type DerivedActivity = {
  state: ActivityState;
  reason: string;
  runId: string;
  runEpoch: string;
  sessionId: string;
  sessionGeneration?: number;
  taskId?: string;
  taskGeneration?: number;
  viewSeq: number;
  headSeq: number;
  stale: boolean;
  observedAt?: string;
  ageMs?: number;
};

export class ControlReductionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlReductionError";
  }
}

export function emptyScmControlProjection(): ScmControlProjection {
  return {
    schemaVersion: 1,
    publications: {},
    polls: {},
    observations: {},
    reactions: {}
  };
}

export function observationSourceProjectionKey(generation: ObservationGenerationV1): string {
  return `${generation.agentId}:${generation.runtimeGeneration}:${generation.attemptGeneration}:${generation.sourceGeneration}`;
}

export function emptyObservabilityControlProjection(runId: string, runEpoch: string): ObservabilityControlProjection {
  // P1 intentionally accepted shorter legacy epochs before the public P5 cursor contract existed.
  // Such stores remain replayable, but cannot admit P5 records (their closed generation schema
  // requires a 16-byte epoch). Keep an inert exact-shape room until the run uses a P5-capable epoch.
  const legacyRoom: ControlRoomProjectionV1 = Object.freeze({
    schemaVersion: 1,
    runId,
    runEpoch,
    headSeq: 0,
    firstAvailableSeq: 1,
    observationBytes: 0,
    droppedRecords: 0,
    droppedBytes: 0,
    staleFacts: 0,
    rows: Object.freeze([]),
    observations: Object.freeze([]),
    tailSlots: Object.freeze([])
  });
  return {
    schemaVersion: 1,
    sources: {},
    room: /^[A-Za-z0-9_-]{16,128}$/u.test(runEpoch)
      ? emptyControlRoomProjection(runId, runEpoch)
      : legacyRoom
  };
}

export function emptyMultiRepositoryControlProjection(): MultiRepositoryControlProjection {
  return Object.freeze({
    schemaVersion: 1,
    headVersion: 0,
    facts: Object.freeze([]),
    state: projectMultiRepositoryCanonicalFacts([])
  });
}

export function emptyControlProjection(runId: string, runEpoch: string): ControlProjection {
  return {
    runId,
    runEpoch,
    headSeq: 0,
    tasks: {},
    messages: [],
    runtimes: {},
    attempts: {},
    steering: {},
    scm: emptyScmControlProjection(),
    observability: emptyObservabilityControlProjection(runId, runEpoch),
    multirepo: emptyMultiRepositoryControlProjection(),
    aggregateVersions: {}
  };
}

const allowedTransitions: Record<ControlTaskStatus, ReadonlySet<ControlTaskStatus>> = {
  open: new Set(["claimed", "blocked", "escalated"]),
  claimed: new Set(["in-progress", "needs-review", "blocked", "rejected", "escalated"]),
  "in-progress": new Set(["needs-review", "blocked", "rejected", "escalated"]),
  "needs-review": new Set(["done", "rejected", "blocked", "escalated"]),
  blocked: new Set(["claimed", "in-progress", "escalated"]),
  rejected: new Set(["claimed", "in-progress", "escalated"]),
  done: new Set(),
  escalated: new Set()
};

function cloneProjection(state: ControlProjection): ControlProjection {
  return structuredClone(state);
}

function assertTask(state: ControlProjection, taskId: string, generation: number): TaskFact {
  const task = state.tasks[taskId];
  if (!task) throw new ControlReductionError(`event references missing task ${taskId}`);
  if (task.generation !== generation) {
    throw new ControlReductionError(`task ${taskId} generation ${generation} is stale; current is ${task.generation}`);
  }
  return task;
}

function assertSession(state: ControlProjection, sessionId: string, generation: number): RuntimeFact {
  const runtime = state.runtimes[sessionId];
  if (!runtime) throw new ControlReductionError(`event references missing session ${sessionId}`);
  if (runtime.sessionGeneration !== generation) {
    throw new ControlReductionError(`session ${sessionId} generation ${generation} is stale; current is ${runtime.sessionGeneration}`);
  }
  return runtime;
}

function assertObservationTarget(
  state: ControlProjection,
  generation: ObservationGenerationV1,
  taskId: string | null,
  taskGeneration: number | null
): void {
  if (generation.taskId === undefined || taskId === null || taskGeneration === null || generation.taskId !== taskId) {
    throw new ControlReductionError("durable agent observations require one exact task scope");
  }
  const task = assertTask(state, taskId, taskGeneration);
  const runtime = assertSession(state, generation.agentId, generation.runtimeGeneration);
  if (runtime.taskId !== task.id || runtime.taskGeneration !== task.generation) {
    throw new ControlReductionError(`observation source ${generation.agentId} is not assigned to task ${task.id}`);
  }
  const attempts = Object.values(state.attempts)
    .filter((attempt) => attempt.sessionId === generation.agentId && attempt.sessionGeneration === generation.runtimeGeneration)
    .sort((left, right) => right.attemptGeneration - left.attemptGeneration);
  const current = attempts[0];
  if (!current || current.taskId !== task.id || current.taskGeneration !== task.generation || current.attemptGeneration !== generation.attemptGeneration) {
    throw new ControlReductionError(`observation attempt generation ${generation.attemptGeneration} is stale for ${generation.agentId}`);
  }
}

function assertObservationStateTransition(previous: TranscriptIngestorStateV1, next: TranscriptIngestorStateV1): void {
  if (
    previous.sourceId !== next.sourceId ||
    previous.parserId !== next.parserId ||
    previous.parserVersion !== next.parserVersion ||
    canonicalJson(previous.generation) !== canonicalJson(next.generation)
  ) throw new ControlReductionError("observation source checkpoint changed immutable identity");
  if (
    next.cursor < previous.cursor ||
    next.nextRecordOrdinal < previous.nextRecordOrdinal ||
    next.droppedRecords < previous.droppedRecords ||
    next.droppedBytes < previous.droppedBytes
  ) throw new ControlReductionError("observation source checkpoint regressed monotonic state");
  if (next.cursor === previous.cursor && next.nextRecordOrdinal === previous.nextRecordOrdinal &&
      next.droppedRecords === previous.droppedRecords && next.droppedBytes === previous.droppedBytes &&
      next.quietPolls === previous.quietPolls && next.integrity === previous.integrity &&
      next.lastObservedSize === previous.lastObservedSize && next.discardingOversize === previous.discardingOversize &&
      next.discardedRecordBytes === previous.discardedRecordBytes) {
    throw new ControlReductionError("observation source checkpoint has no durable effect");
  }
}

function taskStatusForControlRoom(task: TaskFact | undefined): ControlRoomAgentRowV1["taskStatus"] {
  if (!task) return "unknown";
  if (task.status === "open") return "planned";
  if (task.status === "done") return "done";
  if (task.status === "blocked" || task.status === "rejected") return "blocked";
  if (task.status === "escalated") return "escalated";
  return "claimed";
}

function attentionForControlRoom(
  activity: ControlRoomAgentRowV1["activity"],
  taskStatus: ControlRoomAgentRowV1["taskStatus"]
): ControlRoomAttention {
  if (activity === "waiting_input") return "needs_input";
  if (activity === "dispatching" || activity === "active") return "working";
  if (activity === "settling") return "settling";
  if (activity === "blocked") return "blocked";
  if (activity === "idle") return "idle";
  if (activity === "exited") {
    if (taskStatus === "done") return "complete";
    if (taskStatus === "blocked" || taskStatus === "escalated") return "failed";
    return "idle";
  }
  return "unknown";
}

function steeringStateForControlRoom(state: ControlProjection, row: ControlRoomAgentRowV1): Pick<ControlRoomAgentRowV1, "steeringState" | "pendingCommands"> {
  const commands = Object.values(state.steering)
    .filter((command) => command.sessionId === row.agentId && command.sessionGeneration === row.runtimeGeneration &&
      command.taskId === row.taskId)
    .sort((left, right) => (right.admittedSeq ?? right.terminalSeq ?? 0) - (left.admittedSeq ?? left.terminalSeq ?? 0));
  const pendingCommands = commands.filter((command) => command.status === "pending").length;
  if (pendingCommands > 0) return { steeringState: "pending", pendingCommands };
  const latest = commands[0];
  if (!latest) return { steeringState: "none", pendingCommands: 0 };
  return {
    steeringState: latest.status === "included" ? "included" : latest.status === "refused" ? "refused" : "none",
    pendingCommands: 0
  };
}

function scmStateForControlRoom(state: ControlProjection, row: ControlRoomAgentRowV1): ControlRoomAgentRowV1["scmState"] {
  if (!row.taskId) return "unknown";
  const publications = Object.values(state.scm.publications)
    .filter((publication) => publication.taskId === row.taskId)
    .sort((left, right) => right.updatedSeq - left.updatedSeq);
  const publication = publications[0];
  if (!publication) return "unpublished";
  if (publication.state === "refused") return "blocked";
  if (publication.state !== "published") return publication.state === "superseded" ? "unknown" : "publishing";
  const observation = state.scm.observations[publication.publicationId];
  const ci = observation?.buckets.ci?.facts;
  const review = observation?.buckets.review?.facts;
  if (review?.decision === "changes_requested") return "changes_requested";
  if (ci?.state === "failing") return "blocked";
  if (!ci || ci.state === "pending" || ci.state === "unknown" || !review) return "ci_pending";
  return ci.state === "passing" && review.decision === "approved" ? "ready" : "unknown";
}

function affectedControlRoomAgents(event: PersistedControlEvent, state: ControlProjection): ReadonlySet<string> {
  if (event.type.startsWith("run.")) return new Set(state.observability.room.rows.map((row) => row.agentId));
  switch (event.type) {
    case "runtime.observed":
    case "attempt.prompt_prepared":
    case "attempt.launch_planned":
    case "attempt.started":
    case "attempt.exited":
    case "attempt.abandoned":
    case "steering.command_admitted":
    case "steering.command_refused":
    case "steering.command_terminal_refused":
    case "steering.command_included":
    case "steering.command_withdrawn":
    case "steering.command_superseded":
    case "steering.command_expired":
      return new Set([event.payload.sessionId]);
  }
  if (event.type === "observation.source_checkpointed") return new Set([event.payload.nextState.generation.agentId]);
  if (event.type === "observation.recorded") return new Set([event.payload.record.generation.agentId]);
  if (event.taskId !== null) {
    return new Set(state.observability.room.rows.filter((row) => row.taskId === event.taskId).map((row) => row.agentId));
  }
  return new Set();
}

function refreshControlRoomAuthority(
  state: ControlProjection,
  event: PersistedControlEvent
): void {
  const affected = affectedControlRoomAgents(event, state);
  const rows = state.observability.room.rows.map((row): ControlRoomAgentRowV1 => {
    if (!affected.has(row.agentId)) return row;
    const runtime = state.runtimes[row.agentId];
    if (!runtime || runtime.sessionGeneration !== row.runtimeGeneration || runtime.taskId !== row.taskId) return row;
    const task = runtime.taskId === undefined ? undefined : state.tasks[runtime.taskId];
    const taskStatus = taskStatusForControlRoom(task);
    const activity = deriveActivity(state, row.agentId, Date.parse(event.recordedAt), event.seq).state;
    const steering = steeringStateForControlRoom(state, row);
    return Object.freeze({
      ...row,
      activity,
      attention: attentionForControlRoom(activity, taskStatus),
      taskStatus,
      ...steering,
      scmState: scmStateForControlRoom(state, row),
      verificationState: row.verificationState,
      lastFactSeq: event.seq,
      lastObservedAt: runtime.observedAt
    });
  });
  state.observability.room = Object.freeze({
    ...state.observability.room,
    headSeq: event.seq,
    rows: Object.freeze(rows)
  });
}

const scmPublicationTransitions: Readonly<Record<ScmPublicationState, ReadonlySet<ScmPublicationState>>> = {
  unpublished: new Set(["push_intent", "refused", "superseded"]),
  push_intent: new Set(["push_ambiguous", "branch_published", "refused", "superseded"]),
  push_ambiguous: new Set(["push_intent", "branch_published", "refused", "superseded"]),
  branch_published: new Set(["pr_intent", "refused", "superseded"]),
  pr_intent: new Set(["pr_ambiguous", "published", "refused", "superseded"]),
  pr_ambiguous: new Set(["pr_intent", "published", "refused", "superseded"]),
  published: new Set(["superseded"]),
  superseded: new Set(),
  refused: new Set()
};

const scmReactionTransitions: Readonly<Record<ScmReactionState, ReadonlySet<ScmReactionState>>> = {
  pending: new Set(["command_admitted", "refused", "superseded", "failed_retryable"]),
  command_admitted: new Set(["included", "refused", "superseded", "failed_retryable"]),
  included: new Set(["observation_resolved", "superseded"]),
  observation_resolved: new Set(),
  superseded: new Set(),
  refused: new Set(),
  failed_retryable: new Set(["command_admitted", "refused", "superseded", "failed_retryable"])
};

function assertScmPublication(state: ControlProjection, publicationId: string, generation: number): ScmPublicationFact {
  const publication = state.scm.publications[publicationId];
  if (!publication) throw new ControlReductionError(`SCM publication ${publicationId} does not exist`);
  if (publication.generation !== generation) {
    throw new ControlReductionError(`SCM publication ${publicationId} generation ${generation} is stale; current is ${publication.generation}`);
  }
  return publication;
}

function scmRepositoryKey(repository: ScmPublicationIntentV1["repository"]): string {
  return `${repository.provider}:${repository.canonicalHost}/${repository.owner}/${repository.name}`;
}

function pullIdentityValue(pull: ScmPullRequestIdentityV1 | ScmPullRequestFactV1): unknown {
  return {
    providerId: pull.providerId,
    number: pull.number,
    url: pull.url,
    repository: pull.repository,
    headRepository: pull.headRepository,
    headRef: pull.headRef,
    headSha: pull.headSha,
    baseRepository: pull.baseRepository,
    baseRef: pull.baseRef,
    baseSha: pull.baseSha
  };
}

function assertPullMatchesPublication(publication: ScmPublicationFact, pull: ScmPullRequestIdentityV1 | ScmPullRequestFactV1): void {
  const intent = publication.intent;
  if (
    scmRepositoryKey(pull.repository) !== scmRepositoryKey(intent.baseRepository) ||
    scmRepositoryKey(pull.headRepository) !== scmRepositoryKey(intent.repository) ||
    pull.headRef !== intent.remoteRef ||
    pull.headSha !== intent.integrationOid ||
    scmRepositoryKey(pull.baseRepository) !== scmRepositoryKey(intent.baseRepository) ||
    pull.baseRef !== intent.baseRef
  ) {
    throw new ControlReductionError(`SCM pull request does not match publication ${publication.publicationId}`);
  }
}

function expectedReactionKey(publication: ScmPublicationFact, input: {
  headSha: string;
  factKind: "ci" | "review";
  evidenceRefs: readonly string[];
}): string {
  if (!publication.pullRequest) throw new ControlReductionError(`SCM publication ${publication.publicationId} has no pull request identity`);
  return sha256Text(canonicalJson({
    schemaVersion: 1,
    repositoryKey: scmRepositoryKey(publication.pullRequest.repository),
    pullRequestNumber: publication.pullRequest.number,
    headSha: input.headSha,
    factKind: input.factKind,
    evidenceIds: [...input.evidenceRefs].sort()
  }));
}

const checkpointCounters = [
  "iteration",
  "dispatched",
  "accepted",
  "rejected",
  "escalations",
  "unknownCostCalls"
] as const satisfies readonly (keyof LoopCheckpointFact)[];

function assertCheckpoint(previous: LoopCheckpointFact | undefined, next: LoopCheckpointFact): void {
  if (Date.parse(next.updatedAt) < Date.parse(next.startedAt)) {
    throw new ControlReductionError("run checkpoint updatedAt precedes startedAt");
  }
  if (next.accepted > next.dispatched || next.escalations > next.dispatched) {
    throw new ControlReductionError("run checkpoint counters contradict dispatched work");
  }
  if ((next.status === "done" && next.phase !== "complete") ||
      (next.status === "cancelled" && next.phase !== "cancelled") ||
      (next.status === "stopped" && next.phase !== "stopped")) {
    throw new ControlReductionError("run checkpoint terminal status and phase disagree");
  }
  if (!previous) return;
  if (previous.project !== next.project || previous.startedAt !== next.startedAt) {
    throw new ControlReductionError("run checkpoint immutable identity changed");
  }
  if (Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)) {
    throw new ControlReductionError("run checkpoint updatedAt regressed");
  }
  if (previous.status !== "running") {
    throw new ControlReductionError("terminal run checkpoint cannot be replaced");
  }
  for (const key of checkpointCounters) {
    if (next[key] < previous[key]) throw new ControlReductionError(`run checkpoint ${key} regressed`);
  }
}

/** Pure, total reducer for one validated persisted event. Invalid histories fail closed. */
export function applyControlEvent(current: ControlProjection, event: PersistedControlEvent): ControlProjection {
  assertControlEventScope(event);
  if (event.runId !== current.runId || event.runEpoch !== current.runEpoch) {
    throw new ControlReductionError("event run identity does not match projection");
  }
  if (event.seq !== current.headSeq + 1) {
    throw new ControlReductionError(`non-contiguous event sequence ${event.seq}; expected ${current.headSeq + 1}`);
  }
  const state = cloneProjection(current);
  const aggregate = aggregateForEvent(event);
  const aggregateVersion = state.aggregateVersions[aggregate.key];
  const actualVersion = aggregateVersion?.version ?? 0;
  if (event.expectedVersion !== actualVersion) {
    throw new ControlReductionError(`aggregate ${aggregate.key} version ${actualVersion}; event expected ${event.expectedVersion}`);
  }

  switch (event.type) {
    case "run.started": {
      if (state.run) throw new ControlReductionError("run lifecycle already started");
      if (event.expectedVersion !== 0) throw new ControlReductionError("run.started must be the first run aggregate event");
      state.run = {
        status: "started",
        startedBy: event.payload.startedBy,
        goal: event.payload.goal,
        configDigest: event.payload.configDigest,
        startedAt: event.occurredAt,
        version: 1,
        updatedSeq: event.seq
      };
      break;
    }
    case "run.completed":
    case "run.failed":
    case "run.cancelled": {
      if (!state.run || state.run.status !== "started") throw new ControlReductionError(`${event.type} requires a nonterminal started run`);
      state.run.status = event.type === "run.completed" ? "completed" : event.type === "run.failed" ? "failed" : "cancelled";
      state.run.terminalAt = event.occurredAt;
      state.run.version = event.expectedVersion + 1;
      state.run.updatedSeq = event.seq;
      if (event.type === "run.completed") state.run.summary = event.payload.summary;
      if (event.type === "run.failed") {
        state.run.reasonCode = event.payload.reasonCode;
        state.run.summary = event.payload.summary;
      }
      if (event.type === "run.cancelled") {
        state.run.cancelledBy = event.payload.cancelledBy;
        state.run.summary = event.payload.reason;
      }
      break;
    }
    case "run.checkpointed": {
      if (!state.run || state.run.status !== "started") {
        throw new ControlReductionError("run.checkpointed requires a nonterminal started run");
      }
      if (event.payload.startedAt !== state.run.startedAt) {
        throw new ControlReductionError("run checkpoint startedAt does not match the run lifecycle");
      }
      assertCheckpoint(state.run.checkpoint, event.payload);
      state.run.checkpoint = structuredClone(event.payload);
      state.run.version = event.expectedVersion + 1;
      state.run.updatedSeq = event.seq;
      break;
    }
    case "task.created": {
      if (state.tasks[event.taskId!]) throw new ControlReductionError(`task ${event.taskId} already exists`);
      const payload = event.payload;
      state.tasks[event.taskId!] = {
        id: event.taskId!,
        generation: event.taskGeneration!,
        ...payload,
        files: payload.files ? [...payload.files] : undefined,
        acceptanceCriteria: [...payload.acceptanceCriteria],
        dependsOn: [...payload.dependsOn],
        status: "open",
        lastUpdate: event.occurredAt,
        attempts: 0,
        version: event.expectedVersion + 1,
        updatedSeq: event.seq
      };
      break;
    }
    case "task.status_changed": {
      const task = assertTask(state, event.taskId!, event.taskGeneration!);
      const nextStatus = event.payload.status;
      if (nextStatus !== task.status && !allowedTransitions[task.status].has(nextStatus)) {
        throw new ControlReductionError(`illegal task transition ${task.status} -> ${nextStatus}`);
      }
      if (nextStatus === "claimed") {
        if (task.claimedBy && task.claimedBy !== event.payload.role) {
          throw new ControlReductionError(`task ${task.id} is already claimed by ${task.claimedBy}`);
        }
        task.claimedBy = event.payload.role;
      } else if (task.claimedBy && event.payload.role !== task.claimedBy && !["blocked", "rejected", "escalated"].includes(nextStatus)) {
        throw new ControlReductionError(`role ${event.payload.role} cannot advance task claimed by ${task.claimedBy}`);
      }
      task.status = nextStatus;
      if (nextStatus === "blocked" || nextStatus === "rejected") task.attempts += 1;
      task.lastSummary = event.payload.summary ?? task.lastSummary;
      task.lastUpdate = event.occurredAt;
      task.version = event.expectedVersion + 1;
      task.updatedSeq = event.seq;
      break;
    }
    case "task.reopened": {
      const task = assertTask(state, event.taskId!, event.taskGeneration!);
      if (task.status !== "done" && task.status !== "escalated") {
        throw new ControlReductionError(`task ${task.id} generation ${task.generation} is not terminal`);
      }
      if (event.payload.newGeneration !== task.generation + 1) {
        throw new ControlReductionError(`task ${task.id} reopen generation must be ${task.generation + 1}`);
      }
      const newGeneration = event.payload.newGeneration;
      task.generation = newGeneration;
      task.status = "open";
      task.claimedBy = undefined;
      task.lastSummary = event.payload.reason;
      task.lastUpdate = event.occurredAt;
      task.attempts = 0;
      task.version = 0;
      task.updatedSeq = event.seq;
      state.aggregateVersions[`task:${task.id}:${newGeneration}`] = {
        kind: "task",
        id: task.id,
        generation: newGeneration,
        version: 0,
        updatedSeq: event.seq
      };
      break;
    }
    case "message.posted": {
      if (event.taskId !== null) assertTask(state, event.taskId, event.taskGeneration!);
      if (state.messages.some((message) => message.messageId === event.payload.messageId)) {
        throw new ControlReductionError(`message ${event.payload.messageId} already exists`);
      }
      state.messages.push({
        messageId: event.payload.messageId,
        seq: event.seq,
        taskId: event.taskId ?? undefined,
        taskGeneration: event.taskGeneration ?? undefined,
        from: event.payload.from,
        to: event.payload.to,
        body: event.payload.body,
        occurredAt: event.occurredAt
      });
      break;
    }
    case "runtime.observed": {
      if (event.taskId !== null) assertTask(state, event.taskId, event.taskGeneration!);
      const prior = state.runtimes[event.payload.sessionId];
      if (prior && event.payload.sessionGeneration < prior.sessionGeneration) {
        throw new ControlReductionError(`stale session generation for ${event.payload.sessionId}`);
      }
      if (prior && event.payload.sessionGeneration > prior.sessionGeneration && prior.observation !== "exited") {
        throw new ControlReductionError(`session ${event.payload.sessionId} generation advanced before exit`);
      }
      if (prior && event.payload.sessionGeneration === prior.sessionGeneration) {
        if (prior.observation === "exited" && event.payload.observation !== "exited") {
          throw new ControlReductionError(`session ${event.payload.sessionId} terminal generation cannot be resurrected`);
        }
        if (prior.taskId !== (event.taskId ?? undefined) || prior.taskGeneration !== (event.taskGeneration ?? undefined)) {
          throw new ControlReductionError(`session ${event.payload.sessionId} generation cannot be retargeted`);
        }
      }
      state.runtimes[event.payload.sessionId] = {
        sessionId: event.payload.sessionId,
        sessionGeneration: event.payload.sessionGeneration,
        taskId: event.taskId ?? undefined,
        taskGeneration: event.taskGeneration ?? undefined,
        observation: event.payload.observation,
        launchId: event.payload.launchId,
        reason: event.payload.reason,
        observedAt: event.occurredAt,
        updatedSeq: event.seq
      };
      break;
    }
    case "attempt.prompt_prepared": {
      assertTask(state, event.taskId!, event.taskGeneration!);
      const runtime = assertSession(state, event.payload.sessionId, event.payload.sessionGeneration);
      if (runtime.taskId !== event.taskId || runtime.taskGeneration !== event.taskGeneration) {
        throw new ControlReductionError(`session ${runtime.sessionId} is not assigned to task ${event.taskId}`);
      }
      if (state.attempts[event.payload.attemptId]) throw new ControlReductionError(`attempt ${event.payload.attemptId} already exists`);
      const priorGenerations = Object.values(state.attempts)
        .filter((attempt) => attempt.taskId === event.taskId && attempt.taskGeneration === event.taskGeneration)
        .map((attempt) => attempt.attemptGeneration);
      const expectedGeneration = Math.max(0, ...priorGenerations) + 1;
      if (event.payload.attemptGeneration !== expectedGeneration) {
        throw new ControlReductionError(`attempt generation ${event.payload.attemptGeneration}; expected ${expectedGeneration}`);
      }
      state.attempts[event.payload.attemptId] = {
        attemptId: event.payload.attemptId,
        attemptGeneration: event.payload.attemptGeneration,
        taskId: event.taskId!,
        taskGeneration: event.taskGeneration!,
        sessionId: event.payload.sessionId,
        sessionGeneration: event.payload.sessionGeneration,
        artifactLocator: event.payload.artifactLocator,
        promptSha256: event.payload.promptSha256,
        promptBytes: event.payload.promptBytes,
        rendererVersion: event.payload.rendererVersion,
        captureCutoffSeq: event.payload.captureCutoffSeq,
        steeringCommandIds: [...event.payload.steeringCommandIds],
        state: "prepared",
        preparedSeq: event.seq
      };
      break;
    }
    case "attempt.launch_planned": {
      const attempt = state.attempts[event.payload.attemptId];
      if (!attempt || attempt.state !== "prepared") throw new ControlReductionError(`attempt ${event.payload.attemptId} is not prepared`);
      if (attempt.launchId !== undefined) throw new ControlReductionError(`attempt ${event.payload.attemptId} already has a launch plan`);
      if (attempt.attemptGeneration !== event.payload.attemptGeneration || attempt.sessionId !== event.payload.sessionId || attempt.sessionGeneration !== event.payload.sessionGeneration) {
        throw new ControlReductionError(`attempt ${event.payload.attemptId} identity mismatch`);
      }
      attempt.launchId = event.payload.launchId;
      attempt.launchPlannedSeq = event.seq;
      break;
    }
    case "attempt.started": {
      const attempt = state.attempts[event.payload.attemptId];
      if (!attempt || attempt.state !== "prepared") throw new ControlReductionError(`attempt ${event.payload.attemptId} is not prepared`);
      if (attempt.attemptGeneration !== event.payload.attemptGeneration || attempt.sessionId !== event.payload.sessionId || attempt.sessionGeneration !== event.payload.sessionGeneration) {
        throw new ControlReductionError(`attempt ${event.payload.attemptId} identity mismatch`);
      }
      if (!attempt.launchId || attempt.launchId !== event.payload.launchId || attempt.launchPlannedSeq === undefined) {
        throw new ControlReductionError(`attempt ${event.payload.attemptId} has no matching durable launch plan`);
      }
      attempt.state = "active";
      attempt.pid = event.payload.pid;
      attempt.processStartToken = event.payload.processStartToken;
      attempt.startedSeq = event.seq;
      break;
    }
    case "attempt.exited": {
      const attempt = state.attempts[event.payload.attemptId];
      if (!attempt || attempt.state !== "active") throw new ControlReductionError(`attempt ${event.payload.attemptId} is not active`);
      if (attempt.attemptGeneration !== event.payload.attemptGeneration || attempt.sessionId !== event.payload.sessionId || attempt.sessionGeneration !== event.payload.sessionGeneration) {
        throw new ControlReductionError(`attempt ${event.payload.attemptId} identity mismatch`);
      }
      attempt.state = "exited";
      attempt.outcome = event.payload.outcome;
      attempt.exitCode = event.payload.exitCode;
      attempt.summary = event.payload.summary;
      attempt.exitedSeq = event.seq;
      break;
    }
    case "attempt.abandoned": {
      const attempt = state.attempts[event.payload.attemptId];
      if (!attempt || attempt.state !== "prepared") throw new ControlReductionError(`attempt ${event.payload.attemptId} is not prepared`);
      if (attempt.attemptGeneration !== event.payload.attemptGeneration || attempt.sessionId !== event.payload.sessionId || attempt.sessionGeneration !== event.payload.sessionGeneration) {
        throw new ControlReductionError(`attempt ${event.payload.attemptId} identity mismatch`);
      }
      attempt.state = "abandoned";
      attempt.abandonReason = event.payload.reasonCode;
      attempt.summary = event.payload.summary;
      attempt.abandonedSeq = event.seq;
      break;
    }
    case "steering.command_admitted": {
      assertTask(state, event.taskId!, event.taskGeneration!);
      const runtime = assertSession(state, event.payload.sessionId, event.payload.sessionGeneration);
      if (runtime.taskId !== event.taskId || runtime.taskGeneration !== event.taskGeneration) {
        throw new ControlReductionError(`session ${runtime.sessionId} is not assigned to task ${event.taskId}`);
      }
      if (state.steering[event.payload.commandId]) throw new ControlReductionError(`steering command ${event.payload.commandId} already exists`);
      state.steering[event.payload.commandId] = {
        commandId: event.payload.commandId,
        sessionId: event.payload.sessionId,
        sessionGeneration: event.payload.sessionGeneration,
        taskId: event.taskId!,
        taskGeneration: event.taskGeneration!,
        bodySha256: event.payload.bodySha256,
        status: "pending",
        admittedSeq: event.seq,
        notBeforeAttemptGeneration: event.payload.notBeforeAttemptGeneration,
        kind: event.payload.kind,
        sourceKind: event.payload.sourceKind,
        parentPrincipal: event.payload.parentPrincipal,
        evidenceRefs: [...event.payload.evidenceRefs],
        body: event.payload.body,
        createdAt: event.payload.createdAt,
        expiresAt: event.payload.expiresAt,
        supersedesCommandId: event.payload.supersedesCommandId
      };
      break;
    }
    case "steering.command_refused": {
      if (state.steering[event.payload.commandId]) throw new ControlReductionError(`steering command ${event.payload.commandId} already exists`);
      state.steering[event.payload.commandId] = {
        commandId: event.payload.commandId,
        sessionId: event.payload.sessionId,
        sessionGeneration: event.payload.sessionGeneration,
        taskId: event.taskId!,
        taskGeneration: event.taskGeneration!,
        bodySha256: event.payload.bodySha256,
        requestSemanticDigest: event.payload.requestSemanticDigest,
        observedSeq: event.payload.observedSeq,
        observedActivity: event.payload.observedActivity,
        status: "refused",
        terminalSeq: event.seq,
        reasonCode: event.payload.reasonCode
      };
      break;
    }
    case "steering.command_terminal_refused": {
      const command = state.steering[event.payload.commandId];
      if (!command || command.status !== "pending") throw new ControlReductionError(`steering command ${event.payload.commandId} is not pending`);
      if (
        command.taskId !== event.taskId ||
        command.taskGeneration !== event.taskGeneration ||
        command.sessionId !== event.payload.sessionId ||
        command.sessionGeneration !== event.payload.sessionGeneration
      ) {
        throw new ControlReductionError(`steering command ${event.payload.commandId} target mismatch`);
      }
      command.status = "refused";
      command.requestSemanticDigest = event.payload.requestSemanticDigest;
      command.observedSeq = event.payload.observedSeq;
      command.observedActivity = event.payload.observedActivity;
      command.reasonCode = event.payload.reasonCode;
      command.terminalSeq = event.seq;
      break;
    }
    case "steering.command_included": {
      const command = state.steering[event.payload.commandId];
      if (!command || command.status !== "pending") throw new ControlReductionError(`steering command ${event.payload.commandId} is not pending`);
      const attempt = state.attempts[event.payload.attemptId];
      if (!attempt || attempt.state !== "prepared" || attempt.promptSha256 !== event.payload.promptSha256 || !attempt.steeringCommandIds.includes(command.commandId)) {
        throw new ControlReductionError(`steering command ${command.commandId} has no matching prepared prompt`);
      }
      command.status = "included";
      command.terminalSeq = event.seq;
      command.attemptId = attempt.attemptId;
      command.attemptGeneration = attempt.attemptGeneration;
      command.promptSha256 = attempt.promptSha256;
      break;
    }
    case "steering.command_withdrawn":
    case "steering.command_superseded":
    case "steering.command_expired": {
      const command = state.steering[event.payload.commandId];
      if (!command || command.status !== "pending") throw new ControlReductionError(`steering command ${event.payload.commandId} is not pending`);
      command.status = event.type === "steering.command_withdrawn" ? "withdrawn" : event.type === "steering.command_superseded" ? "superseded" : "expired";
      command.terminalSeq = event.seq;
      if (event.type === "steering.command_superseded") command.byCommandId = event.payload.byCommandId;
      break;
    }
    case "scm.publication_recorded": {
      const task = assertTask(state, event.taskId!, event.taskGeneration!);
      const intent = event.payload.publication;
      if (intent.runId !== state.runId || intent.runEpoch !== state.runEpoch) {
        throw new ControlReductionError("SCM publication run identity does not match the control store");
      }
      if (intent.publicationId in state.scm.publications) {
        throw new ControlReductionError(`SCM publication ${intent.publicationId} already exists`);
      }
      if (["done", "escalated"].includes(task.status)) {
        throw new ControlReductionError(`terminal task ${task.id} cannot create an SCM publication`);
      }
      state.scm.publications[intent.publicationId] = {
        publicationId: intent.publicationId,
        generation: intent.publicationGeneration,
        version: 0,
        state: "unpublished",
        intent: structuredClone(intent),
        taskId: event.taskId!,
        taskGeneration: event.taskGeneration!,
        createdSeq: event.seq,
        updatedSeq: event.seq
      };
      break;
    }
    case "scm.publication_state_changed": {
      assertTask(state, event.taskId!, event.taskGeneration!);
      const publication = assertScmPublication(state, event.payload.publicationId, event.payload.publicationGeneration);
      if (publication.taskId !== event.taskId || publication.taskGeneration !== event.taskGeneration) {
        throw new ControlReductionError(`SCM publication ${publication.publicationId} task target mismatch`);
      }
      if (publication.state !== event.payload.fromState) {
        throw new ControlReductionError(`SCM publication ${publication.publicationId} state is ${publication.state}; event expected ${event.payload.fromState}`);
      }
      if (!scmPublicationTransitions[publication.state].has(event.payload.toState)) {
        throw new ControlReductionError(`illegal SCM publication transition ${publication.state} -> ${event.payload.toState}`);
      }
      if (event.payload.toState === "branch_published" && event.payload.observedRemoteOid !== publication.intent.integrationOid) {
        throw new ControlReductionError("SCM branch publication requires the exact intended remote OID");
      }
      if (event.payload.toState === "published") {
        if (!event.payload.pullRequest) throw new ControlReductionError("published SCM state requires a pull request fact");
        assertPullMatchesPublication(publication, event.payload.pullRequest);
        if (event.payload.pullRequest.lifecycle !== "open" || event.payload.pullRequest.draft !== publication.intent.draft) {
          throw new ControlReductionError("published SCM pull request lifecycle/draft does not match the intent");
        }
      } else if (event.payload.pullRequest !== undefined) {
        throw new ControlReductionError("SCM pull request facts can only be attached to the published transition");
      }
      if (event.payload.toState === "refused" && event.payload.reasonCode === undefined) {
        throw new ControlReductionError("refused SCM publication requires a reason code");
      }
      publication.state = event.payload.toState;
      publication.version += 1;
      publication.updatedSeq = event.seq;
      if (event.payload.observedRemoteOid !== undefined) publication.observedRemoteOid = event.payload.observedRemoteOid;
      if (event.payload.pullRequest !== undefined) publication.pullRequest = structuredClone(event.payload.pullRequest);
      if (event.payload.reasonCode !== undefined) publication.reasonCode = event.payload.reasonCode;
      break;
    }
    case "scm.poll_started": {
      const task = assertTask(state, event.taskId!, event.taskGeneration!);
      if (["done", "escalated"].includes(task.status)) throw new ControlReductionError(`terminal task ${task.id} cannot start an SCM poll`);
      const runtime = assertSession(state, event.payload.sessionId, event.payload.sessionGeneration);
      if (runtime.taskId !== event.taskId || runtime.taskGeneration !== event.taskGeneration) {
        throw new ControlReductionError(`session ${runtime.sessionId} is not assigned to SCM task ${event.taskId}`);
      }
      const publication = assertScmPublication(state, event.payload.publicationId, event.payload.publicationGeneration);
      if (publication.taskId !== event.taskId || publication.taskGeneration !== event.taskGeneration || publication.state !== "published") {
        throw new ControlReductionError(`SCM publication ${publication.publicationId} is not published for this task generation`);
      }
      if (event.payload.expectedHeadSha !== publication.intent.integrationOid || !publication.pullRequest) {
        throw new ControlReductionError("SCM poll head/publication identity mismatch");
      }
      assertPullMatchesPublication(publication, event.payload.pullRequest);
      if (canonicalJson(pullIdentityValue(event.payload.pullRequest)) !== canonicalJson(pullIdentityValue(publication.pullRequest))) {
        throw new ControlReductionError("SCM poll pull request identity changed");
      }
      const observation = state.scm.observations[publication.publicationId];
      const durableGuards = {
        pullRequest: observation?.buckets.pullRequest,
        checks: observation?.buckets.ci,
        reviews: observation?.buckets.review,
        mergeability: observation?.buckets.mergeability
      };
      for (const [name, guard] of Object.entries(event.payload.guards)) {
        if (guard === undefined) continue;
        const bucket = durableGuards[name as keyof typeof durableGuards];
        if (!bucket || bucket.meta.observedHeadSha !== event.payload.expectedHeadSha || bucket.meta.guard !== guard) {
          throw new ControlReductionError(`SCM poll ${name} guard is not backed by the exact accepted head`);
        }
      }
      const active = Object.values(state.scm.polls).find((poll) =>
        poll.state === "started" && poll.publicationId === publication.publicationId && poll.pollId !== event.payload.pollId
      );
      if (active) throw new ControlReductionError(`SCM publication ${publication.publicationId} already has active poll ${active.pollId}`);
      const prior = state.scm.polls[event.payload.pollId];
      if (prior) {
        if (prior.state === "started") throw new ControlReductionError(`SCM poll ${prior.pollId} is already active`);
        if (event.payload.pollAttempt !== prior.pollAttempt + 1 ||
            prior.publicationId !== publication.publicationId || prior.publicationGeneration !== publication.generation ||
            prior.taskId !== event.taskId || prior.taskGeneration !== event.taskGeneration ||
            prior.sessionId !== runtime.sessionId || prior.sessionGeneration !== runtime.sessionGeneration ||
            prior.expectedHeadSha !== event.payload.expectedHeadSha) {
          throw new ControlReductionError(`SCM poll ${prior.pollId} retry identity/attempt mismatch`);
        }
      } else if (event.payload.pollAttempt !== 1) {
        throw new ControlReductionError(`new SCM poll ${event.payload.pollId} must start at attempt 1`);
      }
      state.scm.polls[event.payload.pollId] = {
        pollId: event.payload.pollId,
        pollAttempt: event.payload.pollAttempt,
        publicationId: publication.publicationId,
        publicationGeneration: publication.generation,
        taskId: event.taskId!,
        taskGeneration: event.taskGeneration!,
        sessionId: runtime.sessionId,
        sessionGeneration: runtime.sessionGeneration,
        expectedHeadSha: event.payload.expectedHeadSha,
        pullRequest: structuredClone(event.payload.pullRequest),
        guards: structuredClone(event.payload.guards),
        forceFullRefresh: event.payload.forceFullRefresh,
        limits: structuredClone(event.payload.limits),
        state: "started",
        acceptedKinds: [],
        startedAt: event.occurredAt,
        startedSeq: event.seq
      };
      break;
    }
    case "scm.poll_completed": {
      const poll = state.scm.polls[event.payload.pollId];
      if (!poll || poll.state !== "started") throw new ControlReductionError(`SCM poll ${event.payload.pollId} is not active`);
      if (poll.pollAttempt !== event.payload.pollAttempt || poll.publicationId !== event.payload.publicationId ||
          poll.publicationGeneration !== event.payload.publicationGeneration || poll.expectedHeadSha !== event.payload.expectedHeadSha ||
          poll.taskId !== event.taskId || poll.taskGeneration !== event.taskGeneration) {
        throw new ControlReductionError(`SCM poll ${event.payload.pollId} completion identity mismatch`);
      }
      if (event.payload.requestCount > poll.limits.maxItemsPerEndpoint + poll.limits.maxPagesPerEndpoint * 16 + 16 ||
          event.payload.decodedBytes > poll.limits.maxDecodedBytesPerPoll) {
        throw new ControlReductionError(`SCM poll ${poll.pollId} exceeded its durable resource budget`);
      }
      poll.state = "completed";
      poll.requestCount = event.payload.requestCount;
      poll.decodedBytes = event.payload.decodedBytes;
      poll.bucketOutcomes = structuredClone(event.payload.bucketOutcomes);
      const retryTimes = event.payload.bucketOutcomes
        .map((outcome) => outcome.failure?.nextEligibleAt)
        .filter((value): value is string => value !== undefined)
        .map((value) => Date.parse(value));
      poll.nextEligibleAt = retryTimes.length > 0 ? new Date(Math.max(...retryTimes)).toISOString() : undefined;
      poll.terminalSeq = event.seq;
      break;
    }
    case "scm.poll_failed": {
      const poll = state.scm.polls[event.payload.pollId];
      if (!poll || poll.state !== "started") throw new ControlReductionError(`SCM poll ${event.payload.pollId} is not active`);
      if (poll.pollAttempt !== event.payload.pollAttempt || poll.publicationId !== event.payload.publicationId ||
          poll.publicationGeneration !== event.payload.publicationGeneration || poll.expectedHeadSha !== event.payload.expectedHeadSha ||
          poll.taskId !== event.taskId || poll.taskGeneration !== event.taskGeneration) {
        throw new ControlReductionError(`SCM poll ${event.payload.pollId} failure identity mismatch`);
      }
      if (event.payload.failure.retryable && event.payload.failure.nextEligibleAt === undefined) {
        throw new ControlReductionError("retryable SCM poll failure requires durable next eligibility time");
      }
      poll.state = "failed";
      poll.failure = structuredClone(event.payload.failure);
      poll.nextEligibleAt = event.payload.failure.nextEligibleAt;
      poll.terminalSeq = event.seq;
      break;
    }
    case "scm.bucket_accepted": {
      assertTask(state, event.taskId!, event.taskGeneration!);
      const publication = assertScmPublication(state, event.payload.publicationId, event.payload.publicationGeneration);
      const poll = state.scm.polls[event.payload.pollId];
      if (!poll || poll.state !== "completed" || poll.publicationId !== publication.publicationId ||
          poll.publicationGeneration !== publication.generation || poll.taskId !== event.taskId || poll.taskGeneration !== event.taskGeneration) {
        throw new ControlReductionError(`SCM accepted bucket has no matching completed poll ${event.payload.pollId}`);
      }
      if (poll.acceptedKinds.includes(event.payload.kind)) {
        throw new ControlReductionError(`SCM poll ${poll.pollId} already accepted ${event.payload.kind}`);
      }
      const outcome = poll.bucketOutcomes?.find((candidate) => candidate.kind === event.payload.kind);
      if (!outcome || outcome.decision !== event.payload.decision || outcome.semanticHash !== event.payload.bucket.meta.semanticHash) {
        throw new ControlReductionError(`SCM ${event.payload.kind} bucket disagrees with poll outcome`);
      }
      if (event.payload.bucket.meta.observedHeadSha !== poll.expectedHeadSha) {
        throw new ControlReductionError(`SCM ${event.payload.kind} bucket observed a different head`);
      }
      let observation = state.scm.observations[publication.publicationId];
      if (!observation || observation.publicationGeneration !== publication.generation || observation.headSha !== poll.expectedHeadSha) {
        observation = {
          publicationId: publication.publicationId,
          publicationGeneration: publication.generation,
          taskId: event.taskId!,
          taskGeneration: event.taskGeneration!,
          headSha: poll.expectedHeadSha,
          buckets: {},
          updatedSeq: event.seq
        };
        state.scm.observations[publication.publicationId] = observation;
      }
      const previous = event.payload.kind === "pull_request" ? observation.buckets.pullRequest
        : event.payload.kind === "ci" ? observation.buckets.ci
          : event.payload.kind === "review" ? observation.buckets.review
            : observation.buckets.mergeability;
      if (event.payload.decision === "accept_new") {
        if (previous !== undefined || event.payload.previousSemanticHash !== undefined) {
          throw new ControlReductionError(`SCM ${event.payload.kind} accept_new has prior facts`);
        }
      } else {
        if (!previous || event.payload.previousSemanticHash !== previous.meta.semanticHash) {
          throw new ControlReductionError(`SCM ${event.payload.kind} prior semantic digest mismatch`);
        }
        if (event.payload.decision === "accept_changed" && previous.meta.semanticHash === event.payload.bucket.meta.semanticHash) {
          throw new ControlReductionError(`SCM ${event.payload.kind} accept_changed did not change facts`);
        }
        if (event.payload.decision === "accept_refresh" && previous.meta.semanticHash !== event.payload.bucket.meta.semanticHash) {
          throw new ControlReductionError(`SCM ${event.payload.kind} accept_refresh changed facts`);
        }
        if (event.payload.decision === "accept_merged_partial" &&
            (previous.meta.completeness !== "complete" || event.payload.bucket.meta.completeness !== "partial")) {
          throw new ControlReductionError(`SCM ${event.payload.kind} partial merge completeness mismatch`);
        }
      }
      if (event.payload.kind === "pull_request") {
        const bucket = event.payload.bucket as ScmFactBucketV1<ScmPullRequestFactV1>;
        assertPullMatchesPublication(publication, bucket.facts);
        if (!publication.pullRequest || canonicalJson(pullIdentityValue(bucket.facts)) !== canonicalJson(pullIdentityValue(publication.pullRequest))) {
          throw new ControlReductionError("SCM observed pull request identity changed from the published aggregate");
        }
        observation.buckets.pullRequest = structuredClone(bucket);
      } else if (event.payload.kind === "ci") {
        observation.buckets.ci = structuredClone(event.payload.bucket as ScmFactBucketV1<ScmCiFactV1>);
      } else if (event.payload.kind === "review") {
        observation.buckets.review = structuredClone(event.payload.bucket as ScmFactBucketV1<ScmReviewFactV1>);
      } else {
        observation.buckets.mergeability = structuredClone(event.payload.bucket as ScmFactBucketV1<ScmMergeabilityFactV1>);
      }
      observation.updatedSeq = event.seq;
      poll.acceptedKinds.push(event.payload.kind);
      break;
    }
    case "scm.reaction_created": {
      const task = assertTask(state, event.taskId!, event.taskGeneration!);
      if (["done", "escalated"].includes(task.status)) throw new ControlReductionError(`terminal task ${task.id} cannot create an SCM reaction`);
      const runtime = assertSession(state, event.payload.sessionId, event.payload.sessionGeneration);
      if (runtime.taskId !== event.taskId || runtime.taskGeneration !== event.taskGeneration) {
        throw new ControlReductionError(`session ${runtime.sessionId} is not assigned to SCM reaction task ${event.taskId}`);
      }
      const publication = assertScmPublication(state, event.payload.publicationId, event.payload.publicationGeneration);
      if (publication.state !== "published" || publication.taskId !== event.taskId || publication.taskGeneration !== event.taskGeneration ||
          publication.intent.integrationOid !== event.payload.headSha) {
        throw new ControlReductionError(`SCM reaction publication/head target mismatch`);
      }
      if (state.scm.reactions[event.payload.reactionKey]) throw new ControlReductionError(`SCM reaction ${event.payload.reactionKey} already exists`);
      if (Object.values(state.scm.reactions).some((reaction) => reaction.commandId === event.payload.commandId)) {
        throw new ControlReductionError(`SCM reaction command ${event.payload.commandId} already exists`);
      }
      const observation = state.scm.observations[publication.publicationId];
      const bucket = event.payload.factKind === "ci" ? observation?.buckets.ci : observation?.buckets.review;
      if (!observation || observation.publicationGeneration !== publication.generation || observation.headSha !== event.payload.headSha || !bucket) {
        throw new ControlReductionError(`SCM reaction has no accepted ${event.payload.factKind} observation`);
      }
      if (event.payload.factKind === "ci") {
        const ci = observation.buckets.ci!;
        if (ci.facts.state !== "failing" || ci.facts.failureFingerprint === undefined ||
            event.payload.evidenceRefs.length !== 1 || event.payload.evidenceRefs[0] !== ci.facts.failureFingerprint) {
          throw new ControlReductionError("SCM CI reaction evidence does not identify the accepted failure");
        }
      } else {
        const unresolved = new Set(observation.buckets.review!.facts.unresolvedSelectedEvidenceIds);
        if (event.payload.evidenceRefs.some((reference) => !unresolved.has(reference))) {
          throw new ControlReductionError("SCM review reaction references evidence outside the accepted unresolved set");
        }
      }
      if (event.payload.reactionKey !== expectedReactionKey(publication, event.payload)) {
        throw new ControlReductionError("SCM reaction key disagrees with its durable identity");
      }
      const active = Object.values(state.scm.reactions).find((reaction) =>
        reaction.publicationId === publication.publicationId && reaction.factKind === event.payload.factKind &&
        !["observation_resolved", "superseded", "refused"].includes(reaction.state)
      );
      if (active) throw new ControlReductionError(`SCM reaction ${active.reactionKey} is still active for ${event.payload.factKind}`);
      state.scm.reactions[event.payload.reactionKey] = {
        reactionKey: event.payload.reactionKey,
        publicationId: publication.publicationId,
        publicationGeneration: publication.generation,
        taskId: event.taskId!,
        taskGeneration: event.taskGeneration!,
        headSha: event.payload.headSha,
        factKind: event.payload.factKind,
        evidenceRefs: [...event.payload.evidenceRefs],
        commandId: event.payload.commandId,
        sessionId: runtime.sessionId,
        sessionGeneration: runtime.sessionGeneration,
        notBeforeAttemptGeneration: event.payload.notBeforeAttemptGeneration,
        supersedesCommandId: event.payload.supersedesCommandId,
        previewSha256: event.payload.previewSha256,
        preview: event.payload.preview,
        state: "pending",
        version: 0,
        createdSeq: event.seq,
        updatedSeq: event.seq
      };
      break;
    }
    case "scm.reaction_transitioned": {
      const reaction = state.scm.reactions[event.payload.reactionKey];
      if (!reaction) throw new ControlReductionError(`SCM reaction ${event.payload.reactionKey} does not exist`);
      if (reaction.taskId !== event.taskId || reaction.taskGeneration !== event.taskGeneration || reaction.commandId !== event.payload.commandId) {
        throw new ControlReductionError(`SCM reaction ${reaction.reactionKey} target mismatch`);
      }
      if (reaction.version !== event.payload.reactionVersion || reaction.state !== event.payload.fromState) {
        throw new ControlReductionError(`SCM reaction ${reaction.reactionKey} state/version fence is stale`);
      }
      if (!scmReactionTransitions[reaction.state].has(event.payload.toState)) {
        throw new ControlReductionError(`illegal SCM reaction transition ${reaction.state} -> ${event.payload.toState}`);
      }
      const command = state.steering[reaction.commandId];
      if (event.payload.toState === "command_admitted") {
        if (!command || command.status !== "pending" || command.admittedSeq !== event.payload.steeringSeq) {
          throw new ControlReductionError("SCM reaction admission transition has no exact pending steering command");
        }
      } else if (event.payload.toState === "included") {
        if (!command || command.status !== "included" || command.terminalSeq !== event.payload.steeringSeq) {
          throw new ControlReductionError("SCM reaction inclusion transition has no exact included steering command");
        }
      } else if (event.payload.toState === "refused" && command) {
        if (command.status !== "refused" || command.terminalSeq !== event.payload.steeringSeq) {
          throw new ControlReductionError("SCM reaction refusal transition disagrees with steering refusal");
        }
      }
      if (["failed_retryable", "superseded", "refused"].includes(event.payload.toState) && event.payload.reasonCode === undefined) {
        throw new ControlReductionError(`SCM reaction ${event.payload.toState} transition requires a reason`);
      }
      if ((event.payload.toState === "observation_resolved") !== (event.payload.observationSemanticHash !== undefined)) {
        throw new ControlReductionError("SCM observation resolution requires exactly one semantic hash");
      }
      reaction.state = event.payload.toState;
      reaction.version += 1;
      reaction.updatedSeq = event.seq;
      reaction.steeringSeq = event.payload.steeringSeq;
      reaction.reasonCode = event.payload.reasonCode;
      reaction.observationSemanticHash = event.payload.observationSemanticHash;
      break;
    }
    case "multirepo.plan_registered":
    case "multirepo.scheduler_transitioned":
    case "multirepo.worktree_group_recorded":
    case "multirepo.worker_settled":
    case "multirepo.worktree_commit_intended":
    case "multirepo.worktree_head_recorded":
    case "multirepo.integration_transitioned":
    case "multirepo.local_integration_receipted":
    case "multirepo.publication_transitioned": {
      const fact = event.payload.fact as MultiRepositoryCanonicalFactV1;
      const facts = Object.freeze([...state.multirepo.facts, structuredClone(fact)]);
      let projected: MultiRepositoryCanonicalProjectionV1;
      try {
        projected = projectMultiRepositoryCanonicalFacts(facts);
      } catch (error) {
        throw new ControlReductionError(error instanceof Error ? error.message : "multi-repository projection failed");
      }
      state.multirepo = Object.freeze({
        schemaVersion: 1,
        headVersion: facts.length,
        facts,
        state: projected
      });
      break;
    }
    case "observation.source_checkpointed": {
      const payload = event.payload;
      const next = payload.nextState;
      const generation = next.generation;
      assertObservationTarget(state, generation, event.taskId, event.taskGeneration);
      if (
        event.actorKind === "agent" ||
        event.sourceKind === null || event.sourceId === null || event.sourceGeneration === null || event.sourceEventId === null ||
        event.sourceId !== next.sourceId || event.sourceGeneration !== generation.sourceGeneration
      ) throw new ControlReductionError("observation source checkpoint lacks exact parent-normalized source identity");
      if (transcriptIngestorStateDigest(next) !== payload.nextStateDigest) {
        throw new ControlReductionError("observation source checkpoint next-state digest mismatch");
      }
      const key = observationSourceProjectionKey(generation);
      const existing = state.observability.sources[key];
      let previous: TranscriptIngestorStateV1;
      if (existing) {
        if (existing.sourceKind !== event.sourceKind || existing.sourceId !== event.sourceId) {
          throw new ControlReductionError("observation source checkpoint changed canonical source identity");
        }
        if (existing.stateDigest !== payload.previousStateDigest) {
          throw new ControlReductionError("observation source checkpoint previous-state fence is stale");
        }
        if (payload.previousState !== undefined && canonicalJson(payload.previousState) !== canonicalJson(existing.state)) {
          throw new ControlReductionError("observation source checkpoint supplied a divergent previous state");
        }
        previous = existing.state;
      } else {
        if (!payload.previousState || transcriptIngestorStateDigest(payload.previousState) !== payload.previousStateDigest) {
          throw new ControlReductionError("first observation source checkpoint requires its exact initial state");
        }
        previous = payload.previousState;
        if (
          previous.cursor !== 0 || previous.nextRecordOrdinal !== 1 || previous.droppedRecords !== 0 || previous.droppedBytes !== 0 ||
          previous.discardingOversize || previous.discardedRecordBytes !== 0
        ) throw new ControlReductionError("first observation source checkpoint must start from a zero cursor");
        const priorGenerations = Object.values(state.observability.sources)
          .map((source) => source.state.generation)
          .filter((candidate) => candidate.agentId === generation.agentId && candidate.runtimeGeneration === generation.runtimeGeneration &&
            candidate.attemptGeneration === generation.attemptGeneration)
          .map((candidate) => candidate.sourceGeneration);
        const expectedGeneration = Math.max(0, ...priorGenerations) + 1;
        if (generation.sourceGeneration !== expectedGeneration) {
          throw new ControlReductionError(`observation source generation ${generation.sourceGeneration}; expected ${expectedGeneration}`);
        }
      }
      if (payload.nextStateDigest === payload.previousStateDigest) {
        throw new ControlReductionError("observation source checkpoint cannot repeat the same state digest");
      }
      assertObservationStateTransition(previous, next);
      state.observability.sources[key] = {
        sourceKind: event.sourceKind,
        sourceId: event.sourceId,
        stateDigest: payload.nextStateDigest,
        requestSemanticDigest: payload.requestSemanticDigest,
        observationRecordIds: [...payload.observationRecordIds],
        observationCount: payload.observationCount,
        state: structuredClone(next),
        updatedSeq: event.seq
      };
      try {
        state.observability.room = applyControlRoomFact(state.observability.room, {
          schemaVersion: 1,
          kind: "source_health",
          seq: event.seq,
          generation,
          observedAt: new Date(event.occurredAt).toISOString(),
          integrity: next.integrity,
          stateCode: `source.${next.integrity}`,
          droppedRecords: next.droppedRecords,
          droppedBytes: next.droppedBytes
        });
      } catch (error) {
        throw new ControlReductionError(error instanceof Error ? error.message : "observation source health projection failed");
      }
      break;
    }
    case "observation.recorded": {
      const generation = event.payload.record.generation;
      assertObservationTarget(state, generation, event.taskId, event.taskGeneration);
      const source = state.observability.sources[observationSourceProjectionKey(generation)];
      if (
        event.actorKind === "agent" || !source ||
        event.sourceKind !== source.sourceKind || event.sourceId !== source.sourceId ||
        event.sourceGeneration !== generation.sourceGeneration || event.sourceEventId === null
      ) throw new ControlReductionError("normalized observation is not bound to its durable source checkpoint");
      try {
        const record = toPublicObservation({
          ...event.payload.record,
          seq: event.seq,
          recordedAt: event.recordedAt
        });
        state.observability.room = applyControlRoomFact(state.observability.room, {
          schemaVersion: 1,
          kind: "observation",
          seq: event.seq,
          record,
          ...(event.payload.tail === undefined ? {} : { tail: event.payload.tail })
        });
      } catch (error) {
        throw new ControlReductionError(error instanceof Error ? error.message : "normalized observation projection failed");
      }
      break;
    }
  }

  state.aggregateVersions[aggregate.key] = {
    kind: aggregate.kind,
    id: aggregate.id,
    generation: aggregate.generation,
    version: event.expectedVersion + 1,
    updatedSeq: event.seq
  };
  state.headSeq = event.seq;
  refreshControlRoomAuthority(state, event);
  return state;
}

export function reduceControlEvents(runId: string, runEpoch: string, events: readonly PersistedControlEvent[], initial?: ControlProjection): ControlProjection {
  let state = initial ? cloneProjection(initial) : emptyControlProjection(runId, runEpoch);
  for (const event of events) state = applyControlEvent(state, event);
  return state;
}

export function deriveActivity(
  projection: ControlProjection,
  sessionId: string,
  now: number,
  headSeq = projection.headSeq
): DerivedActivity {
  const runtime = projection.runtimes[sessionId];
  const task = runtime?.taskId ? projection.tasks[runtime.taskId] : undefined;
  const generationStale = task !== undefined && task.generation !== runtime?.taskGeneration;
  const base = {
    runId: projection.runId,
    runEpoch: projection.runEpoch,
    sessionId,
    sessionGeneration: runtime?.sessionGeneration,
    taskId: runtime?.taskId,
    taskGeneration: runtime?.taskGeneration,
    viewSeq: projection.headSeq,
    headSeq,
    stale: projection.headSeq < headSeq || generationStale,
    observedAt: runtime?.observedAt,
    ageMs: runtime ? Math.max(0, now - Date.parse(runtime.observedAt)) : undefined
  };
  if (projection.run && projection.run.status !== "started") {
    return { ...base, state: "exited", reason: `run ${projection.run.status}` };
  }
  if (!runtime) return { ...base, state: "idle", reason: "no durable session facts" };
  if (generationStale) return { ...base, state: "idle", reason: "session observes a stale task generation" };
  if (runtime.observation === "exited") return { ...base, state: "exited", reason: runtime.reason ?? "session generation exited" };
  if (runtime.observation === "blocked") return { ...base, state: "blocked", reason: runtime.reason ?? "session requires a control-plane decision" };

  if (task?.status === "escalated") return { ...base, state: "exited", reason: "task escalated and this session generation is terminal" };
  if (task?.status === "done") return { ...base, state: "exited", reason: "task completed" };
  if (task?.status === "blocked") return { ...base, state: "blocked", reason: task.lastSummary ?? "task blocked" };

  const attempts = Object.values(projection.attempts)
    .filter((attempt) => attempt.sessionId === sessionId && attempt.sessionGeneration === runtime.sessionGeneration)
    .sort((a, b) => b.attemptGeneration - a.attemptGeneration);
  const latest = attempts[0];
  if (latest?.state === "prepared") return { ...base, state: "dispatching", reason: `attempt ${latest.attemptGeneration} prompt prepared` };
  if (latest?.state === "active") return { ...base, state: "active", reason: `attempt ${latest.attemptGeneration} provider active` };
  const terminalSeq = latest?.state === "exited" ? latest.exitedSeq : latest?.state === "abandoned" ? latest.abandonedSeq : undefined;
  if ((latest?.state === "exited" || latest?.state === "abandoned") && task && !["done", "escalated"].includes(task.status) && !(
    runtime.observation === "waiting_input" && terminalSeq !== undefined && runtime.updatedSeq > terminalSeq
  )) {
    return { ...base, state: "settling", reason: `attempt ${latest.attemptGeneration} exited; parent reconciliation pending` };
  }
  if (runtime.observation === "waiting_input") return { ...base, state: "waiting_input", reason: runtime.reason ?? "safe prompt boundary available" };
  if (runtime.observation === "probe_failed") return { ...base, state: "idle", reason: runtime.reason ?? "runtime probe failed; no executable boundary proven" };
  return {
    ...base,
    state: "idle",
    reason: runtime.taskId ? "task assigned but no safe prompt boundary is proven" : "session available"
  };
}

export function canonicalProjectionValue(projection: ControlProjection): unknown {
  const scm = projection.scm ?? emptyScmControlProjection();
  const observability = projection.observability ?? emptyObservabilityControlProjection(projection.runId, projection.runEpoch);
  const multirepo = projection.multirepo ?? emptyMultiRepositoryControlProjection();
  const hasScmFacts = Object.keys(scm.publications).length > 0 || Object.keys(scm.polls).length > 0 ||
    Object.keys(scm.observations).length > 0 || Object.keys(scm.reactions).length > 0;
  const hasObservabilityFacts = Object.keys(observability.sources).length > 0 || observability.room.observations.length > 0;
  const hasMultiRepositoryFacts = multirepo.headVersion > 0;
  return {
    runId: projection.runId,
    runEpoch: projection.runEpoch,
    headSeq: projection.headSeq,
    run: projection.run,
    tasks: Object.fromEntries(Object.entries(projection.tasks).sort(([a], [b]) => a.localeCompare(b))),
    messages: [...projection.messages].sort((a, b) => a.seq - b.seq),
    runtimes: Object.fromEntries(Object.entries(projection.runtimes).sort(([a], [b]) => a.localeCompare(b))),
    attempts: Object.fromEntries(Object.entries(projection.attempts).sort(([a], [b]) => a.localeCompare(b))),
    steering: Object.fromEntries(Object.entries(projection.steering).sort(([a], [b]) => a.localeCompare(b))),
    ...(hasScmFacts ? {
      scm: {
        schemaVersion: 1,
        publications: Object.fromEntries(Object.entries(scm.publications).sort(([a], [b]) => a.localeCompare(b))),
        polls: Object.fromEntries(Object.entries(scm.polls).sort(([a], [b]) => a.localeCompare(b))),
        observations: Object.fromEntries(Object.entries(scm.observations).sort(([a], [b]) => a.localeCompare(b))),
        reactions: Object.fromEntries(Object.entries(scm.reactions).sort(([a], [b]) => a.localeCompare(b)))
      }
    } : {}),
    ...(hasObservabilityFacts ? {
      observability: {
        schemaVersion: 1,
        sources: Object.fromEntries(Object.entries(observability.sources).sort(([a], [b]) => a.localeCompare(b))),
        room: observability.room
      }
    } : {}),
    ...(hasMultiRepositoryFacts ? {
      multirepo: {
        schemaVersion: 1,
        headVersion: multirepo.headVersion,
        facts: multirepo.facts,
        state: multirepo.state
      }
    } : {}),
    aggregateVersions: Object.fromEntries(Object.entries(projection.aggregateVersions).sort(([a], [b]) => a.localeCompare(b)))
  };
}

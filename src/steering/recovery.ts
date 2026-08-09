import type { AttemptFact, ControlProjection } from "../control/reducer.js";
import {
  PromptArtifactError,
  readVerifiedPromptArtifact
} from "./prompt-manifest.js";
import type {
  SteeringRepository,
  SteeringRepositorySnapshot
} from "./repository.js";
import type {
  SteeringCommandRecord,
  SteeringPromptManifestFact
} from "./types.js";

export const STEERING_SETTLEMENT_CONSUMER_ID = "steering-attempt-settlement-v1";

export type SteeringRecoveryRepository = Pick<SteeringRepository, "runId" | "runEpoch" | "snapshot">;

/**
 * Evidence supplied by the P1 launch supervisor. `absent-proven`, `alive-match`, and
 * `exited-match` are authoritative statements about the exact recorded launch identity; a PID-only
 * liveness probe is not sufficient. Recovery treats a thrown probe or `unavailable` as unknown.
 */
export type LaunchInspection =
  | { readonly state: "absent-proven"; readonly detail?: string }
  | {
      readonly state: "alive-match";
      readonly launchId: string;
      readonly pid: number;
      readonly processStartToken: string;
    }
  | {
      readonly state: "exited-match";
      readonly launchId: string;
      readonly pid: number;
      readonly processStartToken: string;
      readonly exitCode?: number;
      readonly outcome?: "succeeded" | "failed" | "cancelled" | "uncertain";
      readonly summary?: string;
    }
  | { readonly state: "identity-mismatch"; readonly detail: string }
  | { readonly state: "unavailable"; readonly detail: string };

export type LaunchInspectionRequest = {
  readonly runId: string;
  readonly runEpoch: string;
  readonly attemptId: string;
  readonly attemptGeneration: number;
  readonly taskId: string;
  readonly taskGeneration: number;
  readonly sessionId: string;
  readonly sessionGeneration: number;
  /** Undefined for a legacy prepared attempt which has no durable pre-spawn launch intent. */
  readonly launchId?: string;
  /** Present once P1 has durably bound process incarnation identity to the launch. */
  readonly pid?: number;
  readonly processStartToken?: string;
  readonly attemptState: string;
};

export type PreparedRecoveryDecision = "resume" | "abandon";

export type VerifiedRecoveryArtifact = {
  readonly locator: string;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly dev: bigint;
  readonly ino: bigint;
};

export type ArtifactBlockReason =
  | "MANIFEST_MISSING"
  | "MANIFEST_MISMATCH"
  | "ARTIFACT_MISSING"
  | "ARTIFACT_CHANGED"
  | "ARTIFACT_TOO_LARGE"
  | "INVALID_LOCATOR"
  | "UNSAFE_ROOT"
  | "ARTIFACT_EXISTS";

type RecoveryAttemptIdentity = {
  readonly attemptId: string;
  readonly attemptGeneration: number;
  readonly taskId: string;
  readonly taskGeneration: number;
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly preparedSeq: number;
};

type RecoveryPlanBase = RecoveryAttemptIdentity & {
  readonly runId: string;
  readonly runEpoch: string;
  readonly expectedHeadSeq: number;
};

export type AttemptRecoveryPlan =
  | (RecoveryPlanBase & {
      readonly kind: "resume_prepared";
      /** Reuse this durable launch ID when launch intent was already committed. */
      readonly launchId?: string;
      readonly artifact: VerifiedRecoveryArtifact;
      /** A private copy of the exact verified persisted bytes; never reconstructed from commands. */
      readonly content: Buffer;
    })
  | (RecoveryPlanBase & {
      readonly kind: "abandon_prepared";
      readonly eventType: "attempt.abandoned";
      readonly reasonCode: "OPERATOR_ABANDONED" | "VERIFIED_NEVER_STARTED" | "ARTIFACT_UNRECOVERABLE";
      readonly artifact?: VerifiedRecoveryArtifact;
    })
  | (RecoveryPlanBase & {
      readonly kind: "record_started";
      readonly eventType: "attempt.started";
      readonly launch: Extract<LaunchInspection, { state: "alive-match" }>;
      readonly artifact: VerifiedRecoveryArtifact;
    })
  | (RecoveryPlanBase & {
      readonly kind: "record_start_and_exit";
      readonly eventTypes: readonly ["attempt.started", "attempt.exited"];
      readonly launch: Extract<LaunchInspection, { state: "exited-match" }>;
      readonly artifact: VerifiedRecoveryArtifact;
    })
  | (RecoveryPlanBase & {
      readonly kind: "reattach_active";
      readonly launch: Extract<LaunchInspection, { state: "alive-match" }>;
      readonly artifact: VerifiedRecoveryArtifact;
    })
  | (RecoveryPlanBase & {
      readonly kind: "record_active_exit";
      readonly eventType: "attempt.exited";
      readonly launchId: string;
      readonly outcome: "succeeded" | "failed" | "cancelled" | "uncertain";
      readonly exitCode?: number;
      readonly summary?: string;
      readonly artifact: VerifiedRecoveryArtifact;
    })
  | (RecoveryPlanBase & {
      readonly kind: "settle_exited";
      readonly exitedSeq: number;
      readonly consumerId: typeof STEERING_SETTLEMENT_CONSUMER_ID;
      readonly expectedCursorSeq: number;
      readonly artifact: VerifiedRecoveryArtifact;
    })
  | (RecoveryPlanBase & {
      readonly kind: "already_settled";
      readonly exitedSeq: number;
      readonly consumerId: typeof STEERING_SETTLEMENT_CONSUMER_ID;
      readonly artifact: VerifiedRecoveryArtifact;
    })
  | (RecoveryPlanBase & {
      readonly kind: "already_abandoned";
      readonly abandonedSeq: number;
      readonly reasonCode: "OPERATOR_ABANDONED" | "VERIFIED_NEVER_STARTED" | "ARTIFACT_UNRECOVERABLE";
    })
  | (RecoveryPlanBase & {
      readonly kind: "blocked_artifact";
      readonly reasonCode: ArtifactBlockReason;
      readonly detail: string;
    })
  | (RecoveryPlanBase & {
      readonly kind: "blocked_identity";
      readonly reasonCode:
        | "LAUNCH_INSPECTION_UNAVAILABLE"
        | "LAUNCH_IDENTITY_MISMATCH"
        | "SPAWN_WITHOUT_DURABLE_IDENTITY"
        | "ACTIVE_ATTEMPT_MISSING_LAUNCH_ID";
      readonly detail: string;
    })
  | (RecoveryPlanBase & {
      readonly kind: "blocked_schema";
      readonly requiredEvent: "attempt.abandoned" | "attempt.launch_planned" | "attempt.started" | "attempt.exited";
      readonly detail: string;
    });

export type TerminalPendingCommandPlan = {
  readonly kind: "terminal_refusal_required";
  readonly requiredEvent: "steering.command_terminal_refused";
  readonly commandId: string;
  readonly taskId: string;
  readonly taskGeneration: number;
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly reasonCode: "TASK_TERMINAL_BEFORE_INCLUSION";
  readonly observedSeq: number;
  readonly observedActivity: "exited";
};

export type SteeringRecoveryPlan = {
  readonly runId: string;
  readonly runEpoch: string;
  readonly headSeq: number;
  readonly attempts: readonly AttemptRecoveryPlan[];
  /** Pending commands on non-terminal targets. They remain pending and are never replayed here. */
  readonly restoredPendingCommandIds: readonly string[];
  readonly terminalPendingCommands: readonly TerminalPendingCommandPlan[];
};

export type PlanSteeringRecoveryOptions = {
  readonly repository: SteeringRecoveryRepository;
  readonly runDir: string;
  readonly inspectLaunch?: (request: LaunchInspectionRequest) => LaunchInspection;
  readonly decidePrepared?: (
    attempt: Readonly<AttemptFact>,
    context: { readonly taskTerminal: boolean; readonly headSeq: number }
  ) => PreparedRecoveryDecision;
  /** Explicit operator policy; the default is always to remain blocked on artifact failure. */
  readonly decideArtifactFailure?: (
    attempt: Readonly<AttemptFact>,
    failure: { readonly reasonCode: ArtifactBlockReason; readonly detail: string; readonly taskTerminal: boolean }
  ) => "block" | "abandon";
  /** P1 durable settlement cursor. Zero means no exited attempt has been settled. */
  readonly settledThroughSeq?: number;
};

type FutureAttemptFact = AttemptFact;

type VerifiedAttempt = {
  readonly manifest: SteeringPromptManifestFact;
  readonly artifact: VerifiedRecoveryArtifact;
  readonly content: Buffer;
};

type VerificationResult =
  | { readonly ok: true; readonly value: VerifiedAttempt }
  | { readonly ok: false; readonly reasonCode: ArtifactBlockReason; readonly detail: string };

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function manifestMatchesAttempt(manifest: SteeringPromptManifestFact, attempt: AttemptFact): boolean {
  return manifest.attemptId === attempt.attemptId &&
    manifest.attemptGeneration === attempt.attemptGeneration &&
    manifest.taskId === attempt.taskId &&
    manifest.taskGeneration === attempt.taskGeneration &&
    manifest.sessionId === attempt.sessionId &&
    manifest.sessionGeneration === attempt.sessionGeneration &&
    manifest.artifactLocator === attempt.artifactLocator &&
    manifest.promptSha256 === attempt.promptSha256 &&
    manifest.promptBytes === attempt.promptBytes &&
    manifest.rendererVersion === attempt.rendererVersion &&
    manifest.captureCutoffSeq === attempt.captureCutoffSeq &&
    manifest.preparedSeq === attempt.preparedSeq &&
    sameIds(manifest.steeringCommandIds, attempt.steeringCommandIds);
}

function commandMatchesManifest(
  record: SteeringCommandRecord | undefined,
  commandId: string,
  manifest: SteeringPromptManifestFact
): boolean {
  return record?.status === "included" &&
    record.command.commandId === commandId &&
    record.attemptId === manifest.attemptId &&
    record.attemptGeneration === manifest.attemptGeneration &&
    record.promptSha256 === manifest.promptSha256;
}

function verifyAttempt(
  snapshot: SteeringRepositorySnapshot,
  runDir: string,
  attempt: AttemptFact
): VerificationResult {
  const manifest = snapshot.steering.manifests[attempt.attemptId];
  if (!manifest) {
    return { ok: false, reasonCode: "MANIFEST_MISSING", detail: "canonical P2 prompt manifest is missing" };
  }
  const reverseCommandIds = Object.values(snapshot.steering.commands)
    .filter((record): record is Extract<SteeringCommandRecord, { status: "included" }> =>
      record.status === "included" && record.attemptId === attempt.attemptId)
    .map((record) => record.command.commandId)
    .sort();
  if (
    manifest.runId !== snapshot.control.runId ||
    manifest.runEpoch !== snapshot.control.runEpoch ||
    !manifestMatchesAttempt(manifest, attempt) ||
    manifest.steeringCommandIds.some((commandId) =>
      !commandMatchesManifest(snapshot.steering.commands[commandId], commandId, manifest)) ||
    !sameIds([...manifest.steeringCommandIds].sort(), reverseCommandIds)
  ) {
    return { ok: false, reasonCode: "MANIFEST_MISMATCH", detail: "P1 attempt, P2 manifest, and inclusion facts disagree" };
  }
  try {
    const verified = readVerifiedPromptArtifact(
      runDir,
      manifest.artifactLocator,
      manifest.promptBytes,
      manifest.promptSha256
    );
    return {
      ok: true,
      value: {
        manifest,
        artifact: {
          locator: verified.locator,
          path: verified.path,
          bytes: verified.bytes,
          sha256: verified.sha256,
          dev: verified.dev,
          ino: verified.ino
        },
        content: Buffer.from(verified.content)
      }
    };
  } catch (error) {
    if (error instanceof PromptArtifactError) {
      return { ok: false, reasonCode: error.code, detail: error.message };
    }
    return { ok: false, reasonCode: "ARTIFACT_CHANGED", detail: "prompt artifact verification failed" };
  }
}

function identity(snapshot: SteeringRepositorySnapshot, attempt: AttemptFact): RecoveryPlanBase {
  return {
    runId: snapshot.control.runId,
    runEpoch: snapshot.control.runEpoch,
    expectedHeadSeq: snapshot.headSeq,
    attemptId: attempt.attemptId,
    attemptGeneration: attempt.attemptGeneration,
    taskId: attempt.taskId,
    taskGeneration: attempt.taskGeneration,
    sessionId: attempt.sessionId,
    sessionGeneration: attempt.sessionGeneration,
    preparedSeq: attempt.preparedSeq ?? 0
  };
}

function terminalTarget(
  projection: ControlProjection,
  target: { taskId: string; taskGeneration: number; sessionId: string; sessionGeneration: number }
): boolean {
  if (projection.run && projection.run.status !== "started") return true;
  const task = projection.tasks[target.taskId];
  if (!task || task.generation !== target.taskGeneration || task.status === "done" || task.status === "escalated") return true;
  const runtime = projection.runtimes[target.sessionId];
  return !runtime ||
    runtime.sessionGeneration !== target.sessionGeneration ||
    runtime.taskId !== target.taskId ||
    runtime.taskGeneration !== target.taskGeneration ||
    runtime.observation === "exited";
}

function inspect(
  options: PlanSteeringRecoveryOptions,
  snapshot: SteeringRepositorySnapshot,
  attempt: FutureAttemptFact
): LaunchInspection {
  if (!options.inspectLaunch) {
    return { state: "unavailable", detail: "no authoritative P1 launch inspector was supplied" };
  }
  try {
    return options.inspectLaunch({
      runId: snapshot.control.runId,
      runEpoch: snapshot.control.runEpoch,
      attemptId: attempt.attemptId,
      attemptGeneration: attempt.attemptGeneration,
      taskId: attempt.taskId,
      taskGeneration: attempt.taskGeneration,
      sessionId: attempt.sessionId,
      sessionGeneration: attempt.sessionGeneration,
      launchId: attempt.launchId,
      pid: attempt.pid,
      processStartToken: attempt.processStartToken,
      attemptState: attempt.state
    });
  } catch {
    return { state: "unavailable", detail: "P1 launch inspection failed" };
  }
}

function identityBlock(
  base: RecoveryPlanBase,
  reasonCode: Extract<AttemptRecoveryPlan, { kind: "blocked_identity" }>["reasonCode"],
  detail: string
): AttemptRecoveryPlan {
  return { ...base, kind: "blocked_identity", reasonCode, detail };
}

function planPrepared(
  options: PlanSteeringRecoveryOptions,
  snapshot: SteeringRepositorySnapshot,
  attempt: FutureAttemptFact,
  verified: VerifiedAttempt,
  taskIsTerminal: boolean
): AttemptRecoveryPlan {
  const base = identity(snapshot, attempt);
  const observation = inspect(options, snapshot, attempt);
  if (observation.state === "identity-mismatch") {
    return identityBlock(base, "LAUNCH_IDENTITY_MISMATCH", observation.detail);
  }
  if (observation.state === "unavailable") {
    return identityBlock(base, "LAUNCH_INSPECTION_UNAVAILABLE", observation.detail);
  }
  if (observation.state === "alive-match" || observation.state === "exited-match") {
    if (!attempt.launchId || observation.launchId !== attempt.launchId) {
      return identityBlock(base, "SPAWN_WITHOUT_DURABLE_IDENTITY", "a process may exist but the prepared attempt has no matching durable launch identity");
    }
    if (observation.state === "alive-match") {
      return { ...base, kind: "record_started", eventType: "attempt.started", launch: observation, artifact: verified.artifact };
    }
    return {
      ...base,
      kind: "record_start_and_exit",
      eventTypes: ["attempt.started", "attempt.exited"],
      launch: observation,
      artifact: verified.artifact
    };
  }
  const decision = taskIsTerminal
    ? "abandon"
    : options.decidePrepared?.(attempt, { taskTerminal: false, headSeq: snapshot.headSeq }) ?? "resume";
  if (decision === "abandon") {
    return {
      ...base,
      kind: "abandon_prepared",
      eventType: "attempt.abandoned",
      reasonCode: taskIsTerminal ? "VERIFIED_NEVER_STARTED" : "OPERATOR_ABANDONED",
      artifact: verified.artifact
    };
  }
  return {
    ...base,
    kind: "resume_prepared",
    launchId: attempt.launchId,
    artifact: verified.artifact,
    content: Buffer.from(verified.content)
  };
}

function planActive(
  options: PlanSteeringRecoveryOptions,
  snapshot: SteeringRepositorySnapshot,
  attempt: FutureAttemptFact,
  verified: VerifiedAttempt
): AttemptRecoveryPlan {
  const base = identity(snapshot, attempt);
  if (!attempt.launchId) {
    return identityBlock(base, "ACTIVE_ATTEMPT_MISSING_LAUNCH_ID", "active attempt has no canonical launch ID");
  }
  const observation = inspect(options, snapshot, attempt);
  if (observation.state === "identity-mismatch") {
    return identityBlock(base, "LAUNCH_IDENTITY_MISMATCH", observation.detail);
  }
  if (observation.state === "unavailable") {
    return identityBlock(base, "LAUNCH_INSPECTION_UNAVAILABLE", observation.detail);
  }
  if (observation.state === "alive-match") {
    if (
      observation.launchId !== attempt.launchId ||
      observation.pid !== attempt.pid ||
      observation.processStartToken !== attempt.processStartToken
    ) {
      return identityBlock(base, "LAUNCH_IDENTITY_MISMATCH", "launch inspector returned another launch ID");
    }
    return { ...base, kind: "reattach_active", launch: observation, artifact: verified.artifact };
  }
  if (observation.state === "exited-match" && observation.launchId !== attempt.launchId) {
    return identityBlock(base, "LAUNCH_IDENTITY_MISMATCH", "launch inspector returned another launch ID");
  }
  if (
    observation.state === "exited-match" &&
    (observation.pid !== attempt.pid || observation.processStartToken !== attempt.processStartToken)
  ) {
    return identityBlock(base, "LAUNCH_IDENTITY_MISMATCH", "exited launch incarnation differs from the recorded active process");
  }
  return {
    ...base,
    kind: "record_active_exit",
    eventType: "attempt.exited",
    launchId: attempt.launchId,
    outcome: observation.state === "exited-match" ? observation.outcome ?? "uncertain" : "uncertain",
    exitCode: observation.state === "exited-match" ? observation.exitCode : undefined,
    summary: observation.state === "exited-match" ? observation.summary : "launch is authoritatively absent during recovery",
    artifact: verified.artifact
  };
}

function planExited(
  snapshot: SteeringRepositorySnapshot,
  attempt: AttemptFact,
  verified: VerifiedAttempt,
  settledThroughSeq: number
): AttemptRecoveryPlan {
  const base = identity(snapshot, attempt);
  if (!attempt.exitedSeq) {
    return {
      ...base,
      kind: "blocked_schema",
      requiredEvent: "attempt.exited",
      detail: "exited attempt is missing its canonical exit sequence"
    };
  }
  if (attempt.exitedSeq <= settledThroughSeq) {
    return {
      ...base,
      kind: "already_settled",
      exitedSeq: attempt.exitedSeq,
      consumerId: STEERING_SETTLEMENT_CONSUMER_ID,
      artifact: verified.artifact
    };
  }
  return {
    ...base,
    kind: "settle_exited",
    exitedSeq: attempt.exitedSeq,
    consumerId: STEERING_SETTLEMENT_CONSUMER_ID,
    expectedCursorSeq: settledThroughSeq,
    artifact: verified.artifact
  };
}

function planAttempt(
  options: PlanSteeringRecoveryOptions,
  snapshot: SteeringRepositorySnapshot,
  attempt: AttemptFact,
  settledThroughSeq: number
): AttemptRecoveryPlan {
  const base = identity(snapshot, attempt);
  if (attempt.state === "abandoned") {
    if (!attempt.abandonedSeq || !attempt.abandonReason) {
      return {
        ...base,
        kind: "blocked_schema",
        requiredEvent: "attempt.abandoned",
        detail: "abandoned attempt is missing its canonical terminal fact"
      };
    }
    return {
      ...base,
      kind: "already_abandoned",
      abandonedSeq: attempt.abandonedSeq,
      reasonCode: attempt.abandonReason
    };
  }
  const verification = verifyAttempt(snapshot, options.runDir, attempt);
  if (!verification.ok) {
    const taskIsTerminal = terminalTarget(snapshot.control, attempt);
    if (
      attempt.state === "prepared" &&
      options.decideArtifactFailure?.(attempt, { ...verification, taskTerminal: taskIsTerminal }) === "abandon"
    ) {
      const observation = inspect(options, snapshot, attempt);
      if (observation.state === "absent-proven") {
        return {
          ...base,
          kind: "abandon_prepared",
          eventType: "attempt.abandoned",
          reasonCode: "ARTIFACT_UNRECOVERABLE"
        };
      }
      return identityBlock(
        base,
        observation.state === "identity-mismatch" ? "LAUNCH_IDENTITY_MISMATCH" :
          observation.state === "unavailable" ? "LAUNCH_INSPECTION_UNAVAILABLE" :
            "SPAWN_WITHOUT_DURABLE_IDENTITY",
        observation.state === "identity-mismatch" || observation.state === "unavailable"
          ? observation.detail
          : "artifact cannot be abandoned while a matching or untracked process may exist"
      );
    }
    return { ...base, kind: "blocked_artifact", reasonCode: verification.reasonCode, detail: verification.detail };
  }
  const future = attempt as FutureAttemptFact;
  if (future.state === "prepared") {
    return planPrepared(
      options,
      snapshot,
      future,
      verification.value,
      terminalTarget(snapshot.control, attempt)
    );
  }
  if (future.state === "active") return planActive(options, snapshot, future, verification.value);
  if (future.state === "exited") return planExited(snapshot, attempt, verification.value, settledThroughSeq);
  return {
    ...base,
    kind: "blocked_schema",
    requiredEvent: "attempt.launch_planned",
    detail: "attempt state is not understood by this recovery reducer"
  };
}

function pendingPlans(snapshot: SteeringRepositorySnapshot): {
  restoredPendingCommandIds: string[];
  terminalPendingCommands: TerminalPendingCommandPlan[];
} {
  const restoredPendingCommandIds: string[] = [];
  const terminalPendingCommands: TerminalPendingCommandPlan[] = [];
  const pending = Object.entries(snapshot.steering.commands)
    .filter((entry): entry is [string, Extract<SteeringCommandRecord, { status: "pending" }>] => entry[1].status === "pending")
    .sort(([leftId, left], [rightId, right]) => left.admittedSeq - right.admittedSeq || leftId.localeCompare(rightId));
  for (const [commandId, record] of pending) {
    const target = record.command;
    if (!terminalTarget(snapshot.control, target)) {
      restoredPendingCommandIds.push(commandId);
      continue;
    }
    terminalPendingCommands.push({
      kind: "terminal_refusal_required",
      requiredEvent: "steering.command_terminal_refused",
      commandId,
      taskId: target.taskId,
      taskGeneration: target.taskGeneration,
      sessionId: target.sessionId,
      sessionGeneration: target.sessionGeneration,
      reasonCode: "TASK_TERMINAL_BEFORE_INCLUSION",
      observedSeq: snapshot.headSeq,
      observedActivity: "exited"
    });
  }
  return { restoredPendingCommandIds, terminalPendingCommands };
}

export function planSteeringRecovery(options: PlanSteeringRecoveryOptions): SteeringRecoveryPlan {
  const settledThroughSeq = options.settledThroughSeq ?? 0;
  if (!Number.isSafeInteger(settledThroughSeq) || settledThroughSeq < 0) {
    throw new TypeError("settlement cursor must be a non-negative safe integer");
  }
  const snapshot = options.repository.snapshot();
  if (snapshot.control.runId !== options.repository.runId || snapshot.control.runEpoch !== options.repository.runEpoch) {
    throw new TypeError("recovery repository changed run identity");
  }
  if (settledThroughSeq > snapshot.headSeq) throw new TypeError("settlement cursor is ahead of canonical history");
  const attempts = Object.values(snapshot.control.attempts)
    .sort((left, right) =>
      left.taskId.localeCompare(right.taskId) ||
      left.taskGeneration - right.taskGeneration ||
      left.attemptGeneration - right.attemptGeneration ||
      left.attemptId.localeCompare(right.attemptId))
    .map((attempt) => planAttempt(options, snapshot, attempt, settledThroughSeq));
  return {
    runId: snapshot.control.runId,
    runEpoch: snapshot.control.runEpoch,
    headSeq: snapshot.headSeq,
    attempts,
    ...pendingPlans(snapshot)
  };
}

import { isValidId } from "../ids.js";
import {
  sanitizeControlText,
  type DeepRedactionOptions
} from "../control/redaction.js";
import {
  ControlViewError,
  readControlViewSnapshot,
  type ControlViewSource
} from "../control/views.js";
import type { AttemptFact, ControlProjection, SteeringFact } from "../control/reducer.js";
import {
  deriveSteeringActivity,
  SteeringActivityError
} from "../steering/activity.js";
import {
  steeringRefusalReasonCodes,
  steeringSourceKinds,
  type SteeringActivity,
  type SteeringActivityState,
  type SteeringRefusalReasonCode,
  type SteeringSourceKind
} from "../steering/types.js";

export const STEERING_DASHBOARD_SCHEMA_VERSION = 1 as const;
export const STEERING_DASHBOARD_MAX_COMMANDS = 512;
export const STEERING_DASHBOARD_PREVIEW_MAX_BYTES = 512;
export const STEERING_DASHBOARD_REASON_MAX_BYTES = 512;
export const STEERING_DASHBOARD_MAX_BYTES = 1024 * 1024;

const dashboardAttemptStates = ["prepared", "active", "exited", "abandoned"] as const;
const dashboardAttemptOutcomes = ["succeeded", "failed", "cancelled", "uncertain"] as const;

export const steeringActivityLabels = Object.freeze({
  idle: "Idle",
  waiting_input: "Waiting for next prompt",
  dispatching: "Preparing attempt",
  active: "Active",
  settling: "Reconciling",
  blocked: "Blocked",
  exited: "Exited"
} satisfies Record<SteeringActivityState, string>);

export type SteeringBoundaryReason =
  | "initial-boundary-not-proven"
  | "safe-prompt-boundary"
  | "prepared-prompt-immutable"
  | "provider-attempt-active"
  | "reconciliation-pending"
  | "session-blocked"
  | "session-exited"
  | "activity-indeterminate";

export type SteeringDashboardQueue = {
  pendingCount: number;
  oldestPendingAgeMs: number | null;
  nextEligibleAttemptGeneration: number | null;
  boundaryReason: SteeringBoundaryReason;
};

export type SteeringDashboardSession = {
  sessionId: string;
  sessionGeneration: number;
  taskId: string | null;
  taskGeneration: number | null;
  activity: SteeringActivityState;
  activityLabel: string;
  certainty: SteeringActivity["certainty"];
  reason: string;
  observedAt: string | null;
  observedAgeMs: number | null;
  observedSeq: number;
  headSeq: number;
  stale: boolean;
  queue: SteeringDashboardQueue;
};

export type SteeringDashboardAttempt = {
  attemptId: string;
  attemptGeneration: number;
  promptSha256: string;
  includedSeq: number;
  state: AttemptFact["state"];
  preparedSeq: number;
  launchPlannedSeq: number | null;
  providerStartedSeq: number | null;
  providerExitedSeq: number | null;
  providerExitCode: number | null;
  outcome: AttemptFact["outcome"] | null;
  abandonedSeq: number | null;
};

export type SteeringDashboardCommand = {
  commandId: string;
  status: SteeringFact["status"];
  statusLabel: "Pending" | "Included" | "Refused" | "Withdrawn" | "Superseded" | "Expired";
  statusDetail: string;
  sourceKind: SteeringSourceKind | null;
  admittedSeq: number | null;
  admittedAt: string | null;
  terminalSeq: number | null;
  sessionId: string;
  sessionGeneration: number;
  taskId: string;
  taskGeneration: number;
  notBeforeAttemptGeneration: number | null;
  eligibleAttemptGeneration: number | null;
  bodySha256: string;
  preview: string | null;
  reasonCode: SteeringRefusalReasonCode | null;
  supersededByCommandId: string | null;
  attempt: SteeringDashboardAttempt | null;
};

export type SteeringDashboardData = {
  schemaVersion: typeof STEERING_DASHBOARD_SCHEMA_VERSION;
  project: string;
  run: string;
  runEpoch: string;
  observedSeq: number;
  headSeq: number;
  floorSeq: number;
  stale: boolean;
  queue: {
    pendingCount: number;
    oldestPendingAgeMs: number | null;
  };
  sessions: SteeringDashboardSession[];
  commandCount: number;
  commandsTruncated: boolean;
  commands: SteeringDashboardCommand[];
};

export type BuildSteeringDashboardDataInput = {
  project: string;
  source: ControlViewSource;
  nowMs: number;
  redaction?: DeepRedactionOptions;
  /** A smaller deterministic test/UI page bound; production can never exceed the hard cap. */
  maxCommands?: number;
};

/**
 * Build a bounded, observational P2 view from one coherent P1 read snapshot. This function never
 * scans prompt artifacts or canonical history, never opens a writer, and fails closed when a
 * lifecycle link or generation is inconsistent with the materialized authority.
 */
export function buildSteeringDashboardData(input: BuildSteeringDashboardDataInput): SteeringDashboardData {
  if (!isValidId(input.project)) throw new ControlViewError("INVALID_INPUT", "The steering project identifier is invalid.");
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
    throw new ControlViewError("INVALID_INPUT", "The steering view clock is invalid.");
  }
  const maxCommands = input.maxCommands ?? STEERING_DASHBOARD_MAX_COMMANDS;
  if (!Number.isSafeInteger(maxCommands) || maxCommands < 1 || maxCommands > STEERING_DASHBOARD_MAX_COMMANDS) {
    throw new ControlViewError("INVALID_INPUT", "The steering command view bound is invalid.");
  }

  const snapshot = readControlViewSnapshot(input.source);
  const projection = snapshot.projection;
  const sessions = buildSessions(projection, snapshot.headSeq, input.nowMs, input.redaction);
  const activityBySession = new Map(sessions.map((session) => [session.sessionId, session]));
  const allCommands = Object.entries(projection.steering).map(([key, command]) => {
    if (key !== command.commandId) throw inconsistent("A steering projection key does not match its command identity.");
    return buildCommand(command, projection, activityBySession.get(command.sessionId), input.nowMs, input.redaction);
  });
  allCommands.sort(compareCommandOrder);

  const pending = allCommands.filter((command) => command.status === "pending");
  const selected = selectCommands(allCommands, maxCommands);
  const oldestPendingAgeMs = oldestAge(pending.map((command) => command.admittedAt), input.nowMs);

  return {
    schemaVersion: STEERING_DASHBOARD_SCHEMA_VERSION,
    project: input.project,
    run: snapshot.sourceRunId,
    runEpoch: snapshot.sourceRunEpoch,
    observedSeq: projection.headSeq,
    headSeq: snapshot.headSeq,
    floorSeq: snapshot.floorSeq,
    stale: projection.headSeq < snapshot.headSeq,
    queue: { pendingCount: pending.length, oldestPendingAgeMs },
    sessions,
    commandCount: allCommands.length,
    commandsTruncated: selected.length < allCommands.length,
    commands: selected
  };
}

function buildSessions(
  projection: ControlProjection,
  headSeq: number,
  nowMs: number,
  redaction: DeepRedactionOptions | undefined
): SteeringDashboardSession[] {
  const result: SteeringDashboardSession[] = [];
  const runtimes = Object.entries(projection.runtimes).sort(([left], [right]) => left.localeCompare(right));
  for (const [runtimeKey, runtime] of runtimes) {
    const sessionId = requireId(runtime.sessionId, "steering session");
    if (runtimeKey !== sessionId) throw inconsistent("A runtime projection key does not match its session identity.");
    const sessionGeneration = requireGeneration(runtime.sessionGeneration, "steering session generation");
    const taskId = runtime.taskId === undefined ? null : requireId(runtime.taskId, "steering task");
    const taskGeneration = runtime.taskGeneration === undefined ? null : requireGeneration(runtime.taskGeneration, "steering task generation");
    if ((taskId === null) !== (taskGeneration === null)) throw inconsistent(`Session ${sessionId} has a half-scoped task target.`);
    if (taskId !== null && projection.tasks[taskId]?.id !== taskId) throw inconsistent(`Session ${sessionId} references an inconsistent task identity.`);
    const observedAt = requireTimestamp(runtime.observedAt, "steering session observation time");
    let activity: SteeringActivity;
    try {
      activity = deriveSteeringActivity(projection, { sessionId, nowMs, headSeq });
    } catch (error) {
      if (error instanceof SteeringActivityError) {
        throw inconsistent(`Steering activity for session ${sessionId} is inconsistent.`, error);
      }
      throw error;
    }
    if (
      activity.sessionGeneration !== sessionGeneration ||
      activity.taskId !== runtime.taskId ||
      activity.taskGeneration !== runtime.taskGeneration
    ) {
      throw inconsistent(`Steering activity for session ${sessionId} lost its exact generation target.`);
    }
    if (
      activity.observedAt === undefined ||
      requireTimestamp(activity.observedAt, "derived steering observation time") !== observedAt ||
      activity.ageMs === undefined ||
      !Number.isSafeInteger(activity.ageMs) ||
      activity.ageMs < 0
    ) {
      throw inconsistent(`Steering activity for session ${sessionId} has invalid observation freshness.`);
    }
    const pending = Object.values(projection.steering).filter(
      (command) =>
        command.status === "pending" &&
        command.sessionId === sessionId &&
        command.sessionGeneration === sessionGeneration &&
        command.taskId === runtime.taskId &&
        command.taskGeneration === runtime.taskGeneration
    );
    const nextEligible = pending.length === 0 || activity.admission === "refused" || activity.admission === "indeterminate"
      ? null
      : Math.max(
        activity.nextAttemptGeneration,
        Math.min(...pending.map((command) => requireGeneration(command.notBeforeAttemptGeneration, "pending command attempt fence")))
      );
    result.push({
      sessionId,
      sessionGeneration,
      taskId,
      taskGeneration,
      activity: activity.state,
      activityLabel: steeringActivityLabels[activity.state],
      certainty: activity.certainty,
      reason: sanitizeText(activity.reason, STEERING_DASHBOARD_REASON_MAX_BYTES, redaction),
      observedAt,
      observedAgeMs: activity.ageMs,
      observedSeq: activity.viewSeq,
      headSeq: activity.headSeq,
      stale: activity.stale,
      queue: {
        pendingCount: pending.length,
        oldestPendingAgeMs: oldestAge(pending.map((command) => command.createdAt ?? null), nowMs),
        nextEligibleAttemptGeneration: nextEligible,
        boundaryReason: boundaryReason(activity)
      }
    });
  }
  return result;
}

function buildCommand(
  command: SteeringFact,
  projection: ControlProjection,
  session: SteeringDashboardSession | undefined,
  nowMs: number,
  redaction: DeepRedactionOptions | undefined
): SteeringDashboardCommand {
  requireId(command.commandId, "steering command");
  requireId(command.sessionId, "steering session");
  requireId(command.taskId, "steering task");
  const sessionGeneration = requireGeneration(command.sessionGeneration, "steering session generation");
  const taskGeneration = requireGeneration(command.taskGeneration, "steering task generation");
  requireSha256(command.bodySha256, "steering body digest");
  if (!(["pending", "included", "refused", "withdrawn", "superseded", "expired"] as const).includes(command.status)) {
    throw inconsistent(`Steering command ${command.commandId} has an unknown lifecycle state.`);
  }
  const admittedSeq = optionalSequence(command.admittedSeq, "steering admission sequence");
  const terminalSeq = optionalSequence(command.terminalSeq, "steering terminal sequence");
  if (admittedSeq !== null && admittedSeq > projection.headSeq || terminalSeq !== null && terminalSeq > projection.headSeq) {
    throw inconsistent(`Steering command ${command.commandId} refers beyond the projected head.`);
  }
  if (admittedSeq !== null && terminalSeq !== null && terminalSeq <= admittedSeq) {
    throw inconsistent(`Steering command ${command.commandId} has a non-forward terminal sequence.`);
  }
  if (command.status === "pending" && (admittedSeq === null || terminalSeq !== null)) {
    throw inconsistent(`Pending steering command ${command.commandId} has an invalid lifecycle sequence.`);
  }
  if (command.status !== "pending" && command.status !== "refused" && (admittedSeq === null || terminalSeq === null)) {
    throw inconsistent(`Terminal steering command ${command.commandId} is missing a lifecycle sequence.`);
  }
  if (command.status === "refused" && terminalSeq === null) {
    throw inconsistent(`Refused steering command ${command.commandId} is missing its refusal sequence.`);
  }

  const sourceKind = command.sourceKind === undefined ? null : requireSourceKind(command.sourceKind);
  const admittedAt = command.createdAt === undefined ? null : requireTimestamp(command.createdAt, "steering admission time");
  const notBefore = command.notBeforeAttemptGeneration === undefined
    ? null
    : requireGeneration(command.notBeforeAttemptGeneration, "steering attempt fence");
  const body = command.body === undefined ? null : sanitizeText(command.body, STEERING_DASHBOARD_PREVIEW_MAX_BYTES, redaction);
  const initialRefusal = command.status === "refused" && admittedSeq === null;
  if (initialRefusal) {
    if (sourceKind !== null || admittedAt !== null || notBefore !== null || body !== null) {
      throw inconsistent(`Initially refused steering command ${command.commandId} contains an invented admission fact.`);
    }
  } else if (sourceKind === null || admittedAt === null || notBefore === null || body === null) {
    throw inconsistent(`Admitted steering command ${command.commandId} is missing immutable display facts.`);
  }

  const reasonCode = command.reasonCode === undefined ? null : requireRefusalReason(command.reasonCode);
  if ((command.status === "refused") !== (reasonCode !== null)) {
    throw inconsistent(`Steering command ${command.commandId} has an inconsistent refusal reason.`);
  }
  const supersededBy = command.byCommandId === undefined ? null : requireId(command.byCommandId, "replacement command");
  if ((command.status === "superseded") !== (supersededBy !== null)) {
    throw inconsistent(`Steering command ${command.commandId} has an inconsistent replacement link.`);
  }
  if (supersededBy !== null && projection.steering[supersededBy] === undefined) {
    throw inconsistent(`Steering command ${command.commandId} refers to a missing replacement command.`);
  }

  const sessionNextGeneration = command.status === "pending" ? matchingNextGeneration(command, session) : null;
  const eligibleAttemptGeneration = sessionNextGeneration === null ? null : Math.max(notBefore!, sessionNextGeneration);
  const attempt = command.status === "included" ? buildAttemptLink(command, projection) : null;
  if (command.status !== "included" && (command.attemptId !== undefined || command.attemptGeneration !== undefined || command.promptSha256 !== undefined)) {
    throw inconsistent(`Non-included steering command ${command.commandId} has an attempt binding.`);
  }

  const labels = lifecycleLabels(command.status, eligibleAttemptGeneration, attempt, reasonCode, supersededBy, session?.queue.boundaryReason);
  return {
    commandId: command.commandId,
    status: command.status,
    statusLabel: labels.label,
    statusDetail: labels.detail,
    sourceKind,
    admittedSeq,
    admittedAt,
    terminalSeq,
    sessionId: command.sessionId,
    sessionGeneration,
    taskId: command.taskId,
    taskGeneration,
    notBeforeAttemptGeneration: notBefore,
    eligibleAttemptGeneration,
    bodySha256: command.bodySha256,
    preview: body,
    reasonCode,
    supersededByCommandId: supersededBy,
    attempt
  };
}

function buildAttemptLink(command: SteeringFact, projection: ControlProjection): SteeringDashboardAttempt {
  const attemptId = requireId(command.attemptId, "included attempt");
  const attemptGeneration = requireGeneration(command.attemptGeneration, "included attempt generation");
  const promptSha256 = requireSha256(command.promptSha256, "included prompt digest");
  const includedSeq = requireSequence(command.terminalSeq, "steering inclusion sequence");
  const attempt = projection.attempts[attemptId];
  if (
    !attempt ||
    attempt.attemptId !== attemptId ||
    attempt.attemptGeneration !== attemptGeneration ||
    attempt.taskId !== command.taskId ||
    attempt.taskGeneration !== command.taskGeneration ||
    attempt.sessionId !== command.sessionId ||
    attempt.sessionGeneration !== command.sessionGeneration ||
    attempt.promptSha256 !== promptSha256 ||
    !Array.isArray(attempt.steeringCommandIds) ||
    !attempt.steeringCommandIds.includes(command.commandId)
  ) {
    throw inconsistent(`Included steering command ${command.commandId} has no exact attempt binding.`);
  }
  const preparedSeq = requireSequence(attempt.preparedSeq, "attempt preparation sequence");
  if (preparedSeq >= includedSeq) {
    throw inconsistent(`Included steering command ${command.commandId} precedes its prompt manifest.`);
  }
  const launchPlannedSeq = optionalSequence(attempt.launchPlannedSeq, "attempt launch-plan sequence");
  const startedSeq = optionalSequence(attempt.startedSeq, "provider start sequence");
  const exitedSeq = optionalSequence(attempt.exitedSeq, "provider exit sequence");
  const abandonedSeq = optionalSequence(attempt.abandonedSeq, "attempt abandonment sequence");
  for (const sequence of [launchPlannedSeq, startedSeq, exitedSeq, abandonedSeq]) {
    if (sequence !== null && sequence > projection.headSeq) {
      throw inconsistent(`Attempt ${attemptId} refers beyond the projected head.`);
    }
  }
  if (startedSeq !== null && (launchPlannedSeq === null || startedSeq <= launchPlannedSeq)) {
    throw inconsistent(`Attempt ${attemptId} has an invalid provider-start lineage.`);
  }
  if (exitedSeq !== null && (startedSeq === null || exitedSeq <= startedSeq)) {
    throw inconsistent(`Attempt ${attemptId} has an invalid provider-exit lineage.`);
  }
  if (launchPlannedSeq !== null && launchPlannedSeq <= includedSeq) {
    throw inconsistent(`Attempt ${attemptId} has a launch plan that precedes steering inclusion.`);
  }
  if (abandonedSeq !== null && (startedSeq !== null || abandonedSeq <= includedSeq)) {
    throw inconsistent(`Attempt ${attemptId} has an invalid abandonment lineage.`);
  }
  const exitCode = attempt.exitCode ?? null;
  if (exitCode !== null && (!Number.isInteger(exitCode) || exitCode < -1 || exitCode > 255)) {
    throw inconsistent(`Attempt ${attemptId} has an invalid provider exit code.`);
  }
  if (!(dashboardAttemptStates as readonly string[]).includes(attempt.state)) {
    throw inconsistent(`Attempt ${attemptId} has an unknown lifecycle state.`);
  }
  if (attempt.outcome !== undefined && !(dashboardAttemptOutcomes as readonly string[]).includes(attempt.outcome)) {
    throw inconsistent(`Attempt ${attemptId} has an unknown provider outcome.`);
  }
  switch (attempt.state) {
    case "prepared":
      if (startedSeq !== null || exitedSeq !== null || abandonedSeq !== null || attempt.outcome !== undefined || exitCode !== null) {
        throw inconsistent(`Prepared attempt ${attemptId} contains terminal provider facts.`);
      }
      break;
    case "active":
      if (startedSeq === null || exitedSeq !== null || abandonedSeq !== null || attempt.outcome !== undefined || exitCode !== null) {
        throw inconsistent(`Active attempt ${attemptId} has an inconsistent provider lifecycle.`);
      }
      break;
    case "exited":
      if (startedSeq === null || exitedSeq === null || abandonedSeq !== null || attempt.outcome === undefined) {
        throw inconsistent(`Exited attempt ${attemptId} is missing provider exit facts.`);
      }
      break;
    case "abandoned":
      if (startedSeq !== null || exitedSeq !== null || abandonedSeq === null || attempt.outcome !== undefined || exitCode !== null) {
        throw inconsistent(`Abandoned attempt ${attemptId} has an inconsistent provider lifecycle.`);
      }
      break;
  }
  return {
    attemptId,
    attemptGeneration,
    promptSha256,
    includedSeq,
    state: attempt.state,
    preparedSeq,
    launchPlannedSeq,
    providerStartedSeq: startedSeq,
    providerExitedSeq: exitedSeq,
    providerExitCode: exitCode,
    outcome: attempt.outcome ?? null,
    abandonedSeq
  };
}

function lifecycleLabels(
  status: SteeringFact["status"],
  eligibleAttemptGeneration: number | null,
  attempt: SteeringDashboardAttempt | null,
  reasonCode: SteeringRefusalReasonCode | null,
  supersededBy: string | null,
  boundary: SteeringBoundaryReason | undefined
): { label: SteeringDashboardCommand["statusLabel"]; detail: string } {
  switch (status) {
    case "pending":
      return eligibleAttemptGeneration === null
        ? { label: "Pending", detail: `Pending; no eligible prompt boundary (${boundary ?? "activity-indeterminate"})` }
        : { label: "Pending", detail: `Pending; eligible for attempt ${eligibleAttemptGeneration}` };
    case "included":
      return { label: "Included", detail: `Included in attempt ${attempt!.attemptGeneration}; prompt sha256:${attempt!.promptSha256}` };
    case "refused":
      return { label: "Refused", detail: `Refused; reason ${reasonCode}` };
    case "withdrawn":
      return { label: "Withdrawn", detail: "Withdrawn while pending" };
    case "superseded":
      return { label: "Superseded", detail: `Superseded by ${supersededBy}` };
    case "expired":
      return { label: "Expired", detail: "Expired before inclusion" };
  }
}

function matchingNextGeneration(command: SteeringFact, session: SteeringDashboardSession | undefined): number | null {
  if (
    session === undefined ||
    session.sessionGeneration !== command.sessionGeneration ||
    session.taskId !== command.taskId ||
    session.taskGeneration !== command.taskGeneration
  ) {
    throw inconsistent(`Pending steering command ${command.commandId} has no exact live queue target.`);
  }
  return session.queue.nextEligibleAttemptGeneration;
}

function selectCommands(commands: SteeringDashboardCommand[], maximum: number): SteeringDashboardCommand[] {
  if (commands.length <= maximum) return commands;
  const pending = commands.filter((command) => command.status === "pending");
  const selected = pending.slice(0, maximum);
  if (selected.length < maximum) {
    const terminal = commands.filter((command) => command.status !== "pending").sort(compareCommandOrder).reverse();
    selected.push(...terminal.slice(0, maximum - selected.length));
  }
  return selected.sort(compareCommandOrder);
}

function compareCommandOrder(left: SteeringDashboardCommand, right: SteeringDashboardCommand): number {
  const leftSeq = left.admittedSeq ?? left.terminalSeq ?? Number.MAX_SAFE_INTEGER;
  const rightSeq = right.admittedSeq ?? right.terminalSeq ?? Number.MAX_SAFE_INTEGER;
  return leftSeq - rightSeq || left.commandId.localeCompare(right.commandId);
}

function oldestAge(values: readonly (string | null)[], nowMs: number): number | null {
  let oldest: number | undefined;
  for (const value of values) {
    if (value === null) continue;
    const timestamp = Date.parse(requireTimestamp(value, "pending command time"));
    if (oldest === undefined || timestamp < oldest) oldest = timestamp;
  }
  if (oldest === undefined) return null;
  const age = Math.max(0, nowMs - oldest);
  if (!Number.isSafeInteger(age)) throw inconsistent("A pending steering age exceeds the safe integer range.");
  return age;
}

function boundaryReason(activity: SteeringActivity): SteeringBoundaryReason {
  if (activity.certainty === "indeterminate") return "activity-indeterminate";
  switch (activity.state) {
    case "idle": return "initial-boundary-not-proven";
    case "waiting_input": return "safe-prompt-boundary";
    case "dispatching": return "prepared-prompt-immutable";
    case "active": return "provider-attempt-active";
    case "settling": return "reconciliation-pending";
    case "blocked": return "session-blocked";
    case "exited": return "session-exited";
  }
}

function sanitizeText(text: string, maximum: number, redaction: DeepRedactionOptions | undefined): string {
  const configured = redaction?.limits?.maxStringBytes;
  const maxStringBytes = configured === undefined ? maximum : Math.min(maximum, configured);
  return sanitizeControlText(text, {
    ...redaction,
    limits: { ...redaction?.limits, maxStringBytes }
  });
}

function requireSourceKind(value: string): SteeringSourceKind {
  if (!(steeringSourceKinds as readonly string[]).includes(value)) {
    throw inconsistent("A steering command has an unknown source kind.");
  }
  return value as SteeringSourceKind;
}

function requireRefusalReason(value: string): SteeringRefusalReasonCode {
  if (!(steeringRefusalReasonCodes as readonly string[]).includes(value)) {
    throw inconsistent("A steering refusal has an unknown reason code.");
  }
  return value as SteeringRefusalReasonCode;
}

function requireId(value: string | undefined, label: string): string {
  if (value === undefined || !isValidId(value)) throw inconsistent(`${label} identifier is invalid.`);
  return value;
}

function requireSha256(value: string | undefined, label: string): string {
  if (value === undefined || !/^[a-f0-9]{64}$/u.test(value)) throw inconsistent(`${label} is invalid.`);
  return value;
}

function requireTimestamp(value: string, label: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw inconsistent(`${label} is invalid.`);
  return new Date(parsed).toISOString();
}

function requireSequence(value: number | undefined, label: string): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) throw inconsistent(`${label} is invalid.`);
  return value;
}

function optionalSequence(value: number | undefined, label: string): number | null {
  return value === undefined ? null : requireSequence(value, label);
}

function requireGeneration(value: number | undefined, label: string): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) throw inconsistent(`${label} is invalid.`);
  return value;
}

function inconsistent(message: string, cause?: unknown): ControlViewError {
  const error = new ControlViewError("INCONSISTENT_SNAPSHOT", message);
  if (cause !== undefined) Object.defineProperty(error, "cause", { value: cause, configurable: true });
  return error;
}

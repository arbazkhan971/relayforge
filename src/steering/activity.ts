import type { AttemptFact, ControlProjection, DerivedActivity } from "../control/reducer.js";
import type { SteeringActivity, SteeringActivityState } from "./types.js";

export class SteeringActivityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SteeringActivityError";
  }
}

export type DeriveSteeringActivityOptions = {
  sessionId: string;
  nowMs: number;
  headSeq?: number;
};

function assertSequence(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new SteeringActivityError(`${label} must be a non-negative safe integer`);
}

function latestAttemptForSession(
  projection: ControlProjection,
  sessionId: string,
  sessionGeneration: number,
  taskId: string | undefined,
  taskGeneration: number | undefined
): { latest?: AttemptFact; nextGeneration: number } {
  const attempts = Object.values(projection.attempts).filter(
    (attempt) => attempt.sessionId === sessionId && attempt.sessionGeneration === sessionGeneration
  );
  const generations = new Set<number>();
  let liveCount = 0;
  for (const attempt of attempts) {
    if (!Number.isSafeInteger(attempt.attemptGeneration) || attempt.attemptGeneration < 1) {
      throw new SteeringActivityError(`attempt ${attempt.attemptId} has an invalid generation`);
    }
    if (generations.has(attempt.attemptGeneration)) {
      throw new SteeringActivityError(`session ${sessionId} has duplicate attempt generation ${attempt.attemptGeneration}`);
    }
    generations.add(attempt.attemptGeneration);
    if (attempt.taskId !== taskId || attempt.taskGeneration !== taskGeneration) {
      throw new SteeringActivityError(`attempt ${attempt.attemptId} does not match its session task target`);
    }
    if (!(["prepared", "active", "exited", "abandoned"] as const).includes(attempt.state)) {
      throw new SteeringActivityError(`attempt ${attempt.attemptId} has an unknown state`);
    }
    if (attempt.state !== "exited" && attempt.state !== "abandoned") liveCount += 1;
  }
  if (liveCount > 1) throw new SteeringActivityError(`session ${sessionId} has multiple live attempts`);
  attempts.sort((left, right) => right.attemptGeneration - left.attemptGeneration || left.attemptId.localeCompare(right.attemptId));
  const latest = attempts[0];
  if (latest) {
    for (const attempt of attempts.slice(1)) {
      if (attempt.state !== "exited" && attempt.state !== "abandoned") {
        throw new SteeringActivityError(`older attempt ${attempt.attemptId} remains live after a newer generation`);
      }
    }
  }
  const nextGeneration = (latest?.attemptGeneration ?? 0) + 1;
  if (!Number.isSafeInteger(nextGeneration)) throw new SteeringActivityError("next attempt generation exceeds the safe integer range");
  return { latest, nextGeneration };
}

function finish(
  base: Omit<DerivedActivity, "state" | "reason"> & { nextAttemptGeneration: number },
  state: SteeringActivityState,
  reason: string,
  certainty: SteeringActivity["certainty"] = "proven"
): SteeringActivity {
  switch (state) {
    case "idle":
      return {
        ...base,
        state,
        reason,
        certainty,
        admission: certainty === "proven" ? "initial_boundary_only" : "indeterminate",
        captureEligible: false
      };
    case "waiting_input":
      return {
        ...base,
        state,
        reason,
        certainty,
        admission: "next_boundary",
        captureEligible: certainty === "proven"
      };
    case "dispatching":
    case "active":
    case "settling":
      return {
        ...base,
        state,
        reason,
        certainty,
        admission: "future_attempt",
        captureEligible: false
      };
    case "blocked":
      return {
        ...base,
        state,
        reason,
        certainty,
        admission: "refused",
        captureEligible: false,
        refusalReason: "SESSION_BLOCKED"
      };
    case "exited":
      return {
        ...base,
        state,
        reason,
        certainty,
        admission: "refused",
        captureEligible: false,
        refusalReason: "SESSION_EXITED"
      };
  }
}

/**
 * Pure P2 activity projection. It consumes only the public P1 projection and never trusts a
 * mutable adapter/UI activity label. `probe_failed` remains idle-but-indeterminate, so callers
 * cannot mistake an observation failure for a safe boundary or an exit.
 */
export function deriveSteeringActivity(
  projection: ControlProjection,
  options: DeriveSteeringActivityOptions
): SteeringActivity {
  assertSequence(projection.headSeq, "projection head sequence");
  const headSeq = options.headSeq ?? projection.headSeq;
  assertSequence(headSeq, "authority head sequence");
  if (headSeq < projection.headSeq) {
    throw new SteeringActivityError("authority head sequence cannot precede the projected view");
  }
  if (!Number.isFinite(options.nowMs)) throw new SteeringActivityError("activity clock must be finite");

  const runtime = projection.runtimes[options.sessionId];
  if (!runtime && Object.values(projection.attempts).some((attempt) => attempt.sessionId === options.sessionId)) {
    throw new SteeringActivityError(`session ${options.sessionId} has attempts but no durable runtime fact`);
  }
  if (runtime && !Number.isFinite(Date.parse(runtime.observedAt))) {
    throw new SteeringActivityError(`session ${options.sessionId} has an invalid observation timestamp`);
  }
  const task = runtime?.taskId === undefined ? undefined : projection.tasks[runtime.taskId];
  const generationStale = task !== undefined && task.generation !== runtime?.taskGeneration;
  if (runtime?.taskId !== undefined && !task) {
    throw new SteeringActivityError(`session ${options.sessionId} references a missing task ${runtime.taskId}`);
  }
  if ((runtime?.taskId === undefined) !== (runtime?.taskGeneration === undefined)) {
    throw new SteeringActivityError(`session ${options.sessionId} has a half-scoped task target`);
  }

  const attemptResult = runtime
    ? latestAttemptForSession(
      projection,
      options.sessionId,
      runtime.sessionGeneration,
      runtime.taskId,
      runtime.taskGeneration
    )
    : { latest: undefined, nextGeneration: 1 };
  const base = {
    runId: projection.runId,
    runEpoch: projection.runEpoch,
    sessionId: options.sessionId,
    sessionGeneration: runtime?.sessionGeneration,
    taskId: runtime?.taskId,
    taskGeneration: runtime?.taskGeneration,
    viewSeq: projection.headSeq,
    headSeq,
    stale: projection.headSeq < headSeq || generationStale,
    observedAt: runtime?.observedAt,
    ageMs: runtime ? Math.max(0, options.nowMs - Date.parse(runtime.observedAt)) : undefined,
    nextAttemptGeneration: attemptResult.nextGeneration
  };

  if (projection.run) {
    switch (projection.run.status) {
      case "started":
        break;
      case "completed":
      case "failed":
      case "cancelled":
        return finish(base, "exited", `run ${projection.run.status}`);
      default:
        throw new SteeringActivityError("run has an unknown lifecycle status");
    }
  }
  if (!runtime) return finish(base, "idle", "no durable session facts");
  if (!Number.isSafeInteger(runtime.sessionGeneration) || runtime.sessionGeneration < 1) {
    throw new SteeringActivityError(`session ${options.sessionId} has an invalid generation`);
  }
  if (generationStale) {
    return finish(base, "idle", "session observes a stale task generation", "indeterminate");
  }
  if (task && ![
    "open",
    "claimed",
    "in-progress",
    "needs-review",
    "blocked",
    "done",
    "rejected",
    "escalated"
  ].includes(task.status)) {
    throw new SteeringActivityError(`task ${task.id} has an unknown status`);
  }

  switch (runtime.observation) {
    case "exited":
      return finish(base, "exited", runtime.reason ?? "session generation exited");
    case "blocked":
      return finish(base, "blocked", runtime.reason ?? "session requires a control-plane decision");
    case "available":
    case "waiting_input":
    case "probe_failed":
      break;
    default:
      throw new SteeringActivityError(`session ${options.sessionId} has an unknown runtime observation`);
  }

  if (task?.status === "done") return finish(base, "exited", "task completed");
  if (task?.status === "escalated") return finish(base, "exited", "task escalated and this session generation is terminal");
  if (task?.status === "blocked") return finish(base, "blocked", task.lastSummary ?? "task blocked");

  const latest = attemptResult.latest;
  if (latest?.state === "prepared") {
    return finish(base, "dispatching", `attempt ${latest.attemptGeneration} prompt prepared`);
  }
  if (latest?.state === "active") {
    return finish(base, "active", `attempt ${latest.attemptGeneration} provider active`);
  }
  const terminalSeq = latest?.state === "exited" ? latest.exitedSeq : latest?.state === "abandoned" ? latest.abandonedSeq : undefined;
  if ((latest?.state === "exited" || latest?.state === "abandoned") && !(
    runtime.observation === "waiting_input" &&
    terminalSeq !== undefined &&
    runtime.updatedSeq > terminalSeq
  )) {
    return finish(base, "settling", `attempt ${latest.attemptGeneration} exited; parent reconciliation pending`);
  }
  if (runtime.observation === "waiting_input") {
    return finish(base, "waiting_input", runtime.reason ?? "safe prompt boundary available");
  }
  if (runtime.observation === "probe_failed") {
    return finish(base, "idle", runtime.reason ?? "runtime probe failed; no executable boundary proven", "indeterminate");
  }
  return finish(
    base,
    "idle",
    runtime.taskId ? "task assigned but no safe prompt boundary is proven" : "session available"
  );
}

export function canCaptureSteering(activity: SteeringActivity): boolean {
  return activity.state === "waiting_input" && activity.certainty === "proven" && activity.captureEligible;
}

export function canAdmitSteeringForFutureAttempt(activity: SteeringActivity): boolean {
  return activity.admission === "next_boundary" || activity.admission === "future_attempt";
}

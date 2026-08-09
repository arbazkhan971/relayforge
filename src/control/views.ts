import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
import { isValidId } from "../ids.js";
import { projectMultiRepositoryCanonicalFacts } from "../multirepo/orchestration.js";
import type { PersistedControlEvent } from "./events.js";
import { deriveActivity, type ControlProjection, type RunFact, type TaskFact } from "./reducer.js";
import type { EventRange } from "./store.js";
import {
  CONTROL_ACTIVITY_DEFAULT_LIMIT,
  CONTROL_ACTIVITY_MAX_LIMIT,
  CONTROL_DIAGNOSTIC_DEFAULT_LINES,
  CONTROL_DIAGNOSTIC_MAX_LINES,
  CONTROL_PROTOCOL_VERSION,
  CONTROL_RUNS_DEFAULT_LIMIT,
  CONTROL_RUNS_MAX_LIMIT,
  CONTROL_SERVICE,
  ControlProtocolError,
  parseControlActivity,
  parseControlBoard,
  parseControlDiagnostics,
  parseControlRun,
  parseControlRuns,
  parseControlStatus,
  parsePageCursor,
  toPublicActivity,
  toPublicDiagnosticCheck,
  toPublicRunSummary,
  toPublicSessionSummary,
  toPublicTask,
  type ControlActivity,
  type ControlActivityEntry,
  type ControlBoard,
  type ControlDiagnosticCheck,
  type ControlDiagnostics,
  type ControlRun,
  type ControlRunStatus,
  type ControlRunSummary,
  type ControlRuns,
  type ControlSessionSummary,
  type ControlStatus,
  type ControlTask,
  type ControlTaskCounts
} from "./protocol.js";

/** A bounded scan keeps activity projection finite even when many canonical events are private. */
export const CONTROL_ACTIVITY_SCAN_MAX_EVENTS = 10_000;

export type ControlViewErrorCode =
  | "INVALID_INPUT"
  | "INVALID_CURSOR"
  | "IDENTITY_MISMATCH"
  | "INCONSISTENT_SNAPSHOT"
  | "RUN_NOT_STARTED"
  | "RUN_NOT_FOUND"
  | "SESSION_NOT_FOUND"
  | "SESSION_OWNERSHIP_MISMATCH";

export class ControlViewError extends Error {
  constructor(
    readonly code: ControlViewErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ControlViewError";
  }
}

/** The narrow, read-only part of ControlStore consumed by the adapter. */
export type ControlViewSource = {
  readonly runId: string;
  readonly runEpoch: string;
  getProjection(): ControlProjection;
  head(): { runId: string; runEpoch: string; floorSeq: number; headSeq: number };
  readRange(options: { afterSeq: number; limit?: number; runEpoch?: string }): EventRange;
};

export type ControlViewSnapshot = {
  readonly sourceRunId: string;
  readonly sourceRunEpoch: string;
  readonly projection: ControlProjection;
  readonly floorSeq: number;
  readonly headSeq: number;
};

export type OwnedControlSession = {
  readonly name: string;
  readonly project: string;
  readonly run: string;
  readonly role: string;
  readonly sessionGeneration: number;
  readonly taskId: string | null;
};

export type ControlProjectViewSource = {
  readonly project: string;
  readonly runs: readonly ControlViewSource[];
  readonly sessions?: readonly OwnedControlSession[];
};

export type ControlDiagnosticCaptureRequest = {
  readonly project: string;
  readonly run: string;
  readonly session: string;
  readonly sessionGeneration: number;
  readonly taskId: string | null;
  readonly lines: number;
};

export type ControlDiagnosticCaptureResult = {
  readonly tail: readonly string[];
  readonly truncated?: boolean;
  readonly checks?: readonly ControlDiagnosticCheck[];
};

export type ControlDiagnosticCapture = (request: ControlDiagnosticCaptureRequest) => ControlDiagnosticCaptureResult;

type Freshness = {
  viewSeq: number;
  headSeq: number;
  floorSeq: number;
  stale: boolean;
};

export type ControlRunsCursorKey = {
  project: string;
  startedAt: string;
  run: string;
  runEpoch: string;
};

export type MultiRepositoryTaskControlView = Readonly<{
  taskId: string;
  taskGeneration: number;
  state: "waiting" | "active" | "completed" | "cancelled" | "failed" | "uncertain";
  providerId: string;
  repositoryIds: readonly string[];
  dependencies: readonly string[];
  leaseState: "admitted" | "dispatched" | "uncertain" | null;
  attemptId: string | null;
  worktreeState: "creating" | "ready" | "rolling_back" | "reclaiming" | "recovery_required" | "reclaimed" | null;
  workerSettled: boolean;
  integrationState: "planning" | "preparing" | "prepared" | "verifying" | "verified" | "applying" | "applied" | "compensating" | "compensated" | "recovery_required" | null;
  publicationState: "publishing" | "partial" | "published" | "recovery_required" | null;
  recoveryReason: string | null;
}>;

/** Closed read-only P6 view derived only from the replayed canonical run projection. */
export type MultiRepositoryControlView = Readonly<{
  schemaVersion: 1;
  project: string;
  run: string;
  runEpoch: string;
  configured: boolean;
  planDigest: string | null;
  headVersion: number;
  viewSeq: number;
  headSeq: number;
  floorSeq: number;
  stale: boolean;
  repositories: readonly Readonly<{
    repositoryId: string;
    defaultBranch: string;
    protectedBranches: readonly string[];
  }>[];
  dagLayers: readonly (readonly string[])[];
  tasks: readonly MultiRepositoryTaskControlView[];
  recoveryRequired: boolean;
}>;

export function buildMultiRepositoryControlView(input: {
  project: string;
  run: string;
  source: ControlViewSource;
}): MultiRepositoryControlView {
  requirePublicId(input.project, "project");
  assertRequestedRun(input.run, input.source);
  const snapshot = readControlViewSnapshot(input.source);
  requireRunFact(snapshot.projection);
  const multi = snapshot.projection.multirepo;
  if (multi.schemaVersion !== 1 || multi.headVersion !== multi.facts.length) {
    throw new ControlViewError("INCONSISTENT_SNAPSHOT", "The multi-repository projection head is inconsistent.");
  }
  // Replay on the read boundary. A source that hands this view stale/tampered derived state cannot
  // make it plausible merely by supplying a matching object shape.
  const canonical = projectMultiRepositoryCanonicalFacts(multi.facts);
  const plan = canonical.plan;
  const freshness = freshnessFor(snapshot);
  const tasks = Object.values(canonical.scheduler.tasks)
    .sort((left, right) => compareText(left.taskId, right.taskId))
    .map((task): MultiRepositoryTaskControlView => {
      const integrationFact = [...multi.facts].reverse().find((fact) =>
        fact.kind === "multirepo.integration_transitioned" && fact.taskId === task.taskId && fact.taskGeneration === task.taskGeneration
      );
      const publicationFact = [...multi.facts].reverse().find((fact) =>
        fact.kind === "multirepo.publication_transitioned" && fact.taskId === task.taskId && fact.taskGeneration === task.taskGeneration
      );
      const integration = integrationFact?.kind === "multirepo.integration_transitioned"
        ? canonical.integrations[integrationFact.event.transactionId]
        : undefined;
      const publication = publicationFact?.kind === "multirepo.publication_transitioned"
        ? canonical.publications[publicationFact.event.transactionId]
        : undefined;
      const worktree = canonical.worktreeGroups[task.taskId];
      const reasons = [
        task.state === "uncertain" ? task.lease?.uncertainReason ?? "scheduler-uncertain" : undefined,
        worktree?.state === "recovery_required" ? worktree.issueCodes.join(",") || "worktree-recovery-required" : undefined,
        integration?.state === "recovery_required" ? integration.recoveryReason ?? "integration-recovery-required" : undefined,
        publication?.state === "recovery_required" ? publication.recoveryReason ?? "publication-recovery-required" : undefined
      ].filter((value): value is string => Boolean(value));
      return Object.freeze({
        taskId: task.taskId,
        taskGeneration: task.taskGeneration,
        state: task.state,
        providerId: task.providerId,
        repositoryIds: Object.freeze([...task.repositoryIds]),
        dependencies: Object.freeze([...task.dependencies]),
        leaseState: task.lease?.state ?? null,
        attemptId: task.lease?.attemptId ?? null,
        worktreeState: worktree?.state ?? null,
        workerSettled: canonical.workers[task.taskId] !== undefined,
        integrationState: integration?.state ?? null,
        publicationState: publication?.state ?? null,
        recoveryReason: reasons.length === 0 ? null : truncateString(reasons.join(";"), 4_096)
      });
    });
  return Object.freeze({
    schemaVersion: 1,
    project: input.project,
    run: snapshot.sourceRunId,
    runEpoch: snapshot.sourceRunEpoch,
    configured: plan !== undefined,
    planDigest: plan?.planDigest ?? null,
    headVersion: multi.headVersion,
    viewSeq: freshness.viewSeq,
    headSeq: freshness.headSeq,
    floorSeq: freshness.floorSeq,
    stale: freshness.stale,
    repositories: Object.freeze((plan?.registry.repositories ?? []).map((repository) => Object.freeze({
      repositoryId: repository.repositoryId,
      defaultBranch: repository.defaultBranch,
      protectedBranches: Object.freeze([...repository.protectedBranches])
    }))),
    dagLayers: Object.freeze((plan?.dag.layers ?? []).map((layer) => Object.freeze([...layer]))),
    tasks: Object.freeze(tasks),
    recoveryRequired: tasks.some((task) => task.recoveryReason !== null)
  });
}

/** Read projection first and head second, so an intervening commit is represented as stale. */
export function readControlViewSnapshot(source: ControlViewSource): ControlViewSnapshot {
  requirePublicId(source.runId, "source run");
  requireRunEpoch(source.runEpoch);

  // Store errors intentionally cross this boundary unchanged. In particular, a recovery-required
  // read must never become a plausible empty DTO.
  const projection = source.getProjection();
  const head = source.head();
  if (
    projection.runId !== source.runId ||
    projection.runEpoch !== source.runEpoch ||
    head.runId !== source.runId ||
    head.runEpoch !== source.runEpoch
  ) {
    throw new ControlViewError("IDENTITY_MISMATCH", "The read source returned a different run identity.");
  }
  requireSequence(projection.headSeq, "projection head");
  requireSequence(head.headSeq, "durable head");
  requireSequence(head.floorSeq, "retained floor");
  if (projection.headSeq > head.headSeq || head.floorSeq > projection.headSeq) {
    throw new ControlViewError("INCONSISTENT_SNAPSHOT", "The projection freshness cursor is inconsistent.");
  }
  return {
    sourceRunId: source.runId,
    sourceRunEpoch: source.runEpoch,
    projection,
    floorSeq: head.floorSeq,
    headSeq: head.headSeq
  };
}

export function buildControlStatus(input: {
  instanceId: string;
  configId: string;
  startedAt: string;
  projects: readonly ControlProjectViewSource[];
  now: number;
}): ControlStatus {
  requireNow(input.now);
  const projects = [...input.projects]
    .sort((a, b) => compareText(a.project, b.project))
    .map((project, index, all) => {
      requirePublicId(project.project, "project");
      if (index > 0 && all[index - 1]!.project === project.project) {
        throw new ControlViewError("INVALID_INPUT", "Duplicate project read source.");
      }
      const snapshots = readProjectSnapshots(project);
      const summaries = summariesForSnapshots(project.project, snapshots);
      const sessions = mapOwnedSessions(project.project, snapshots, project.sessions ?? [], input.now);
      return {
        project: project.project,
        latestRun: summaries[0] ?? null,
        sessions
      };
    });

  return parseControlStatus({
    schemaVersion: CONTROL_PROTOCOL_VERSION,
    service: CONTROL_SERVICE,
    instanceId: input.instanceId,
    configId: input.configId,
    status: "ok",
    startedAt: canonicalTimestamp(input.startedAt, "service start"),
    projects
  });
}

export function buildControlRuns(input: {
  project: string;
  sources: readonly ControlViewSource[];
  limit?: number;
  cursor?: string | null;
}): ControlRuns {
  requirePublicId(input.project, "project");
  const limit = boundedInteger(input.limit ?? CONTROL_RUNS_DEFAULT_LIMIT, 1, CONTROL_RUNS_MAX_LIMIT, "run page limit");
  const snapshots = readSnapshots(input.sources);
  const summaries = summariesForSnapshots(input.project, snapshots);
  let start = 0;
  if (input.cursor !== undefined && input.cursor !== null) {
    const key = decodeRunCursor(input.cursor);
    if (key.project !== input.project) throw new ControlViewError("INVALID_CURSOR", "The run cursor belongs to another project.");
    const found = summaries.findIndex(
      (summary) =>
        summary.startedAt === key.startedAt && summary.run === key.run && summary.runEpoch === key.runEpoch
    );
    if (found < 0) throw new ControlViewError("INVALID_CURSOR", "The run cursor does not identify this result set.");
    start = found + 1;
  }
  const page = summaries.slice(start, start + limit);
  const last = page.at(-1);
  const nextCursor = start + page.length < summaries.length && last
    ? encodeRunCursor({ project: input.project, startedAt: last.startedAt, run: last.run, runEpoch: last.runEpoch })
    : null;
  return parseControlRuns({
    schemaVersion: CONTROL_PROTOCOL_VERSION,
    project: input.project,
    runs: page,
    nextCursor
  });
}

export function buildControlRun(input: { project: string; run: string; source: ControlViewSource }): ControlRun {
  requirePublicId(input.project, "project");
  assertRequestedRun(input.run, input.source);
  const snapshot = readControlViewSnapshot(input.source);
  const summary = mapRunSummary(input.project, snapshot);
  const run = requireRunFact(snapshot.projection);
  return parseControlRun({
    schemaVersion: CONTROL_PROTOCOL_VERSION,
    run: {
      project: summary.project,
      run: summary.run,
      runEpoch: summary.runEpoch,
      status: summary.status,
      reason: summary.reason,
      startedAt: summary.startedAt,
      updatedAt: summary.updatedAt,
      completedAt: summary.completedAt,
      desiredGeneration: run.version,
      observedGeneration: run.version,
      viewSeq: summary.viewSeq,
      headSeq: summary.headSeq,
      floorSeq: summary.floorSeq,
      stale: summary.stale,
      tasks: summary.tasks
    }
  });
}

export function buildControlBoard(input: { project: string; run: string; source: ControlViewSource }): ControlBoard {
  requirePublicId(input.project, "project");
  assertRequestedRun(input.run, input.source);
  const snapshot = readControlViewSnapshot(input.source);
  requireRunFact(snapshot.projection);
  const tasks = Object.values(snapshot.projection.tasks)
    .sort((a, b) => compareText(a.id, b.id))
    .map(mapTask);
  const freshness = freshnessFor(snapshot);
  return parseControlBoard({
    schemaVersion: CONTROL_PROTOCOL_VERSION,
    project: input.project,
    run: snapshot.sourceRunId,
    runEpoch: snapshot.sourceRunEpoch,
    viewSeq: freshness.viewSeq,
    headSeq: freshness.headSeq,
    floorSeq: freshness.floorSeq,
    stale: freshness.stale,
    tasks,
    counts: countTasks(snapshot.projection)
  });
}

export function buildControlActivity(input: {
  project: string;
  run: string;
  source: ControlViewSource;
  after?: number;
  limit?: number;
}): ControlActivity {
  requirePublicId(input.project, "project");
  assertRequestedRun(input.run, input.source);
  const after = boundedInteger(input.after ?? 0, 0, Number.MAX_SAFE_INTEGER, "activity cursor");
  const limit = boundedInteger(input.limit ?? CONTROL_ACTIVITY_DEFAULT_LIMIT, 1, CONTROL_ACTIVITY_MAX_LIMIT, "activity limit");

  // Read a bounded canonical range first. A later projection/head read can only advance; that
  // advance becomes either staleness or an explicit nextAfter cursor, never an omitted success.
  const range = input.source.readRange({
    afterSeq: after,
    limit: CONTROL_ACTIVITY_SCAN_MAX_EVENTS,
    runEpoch: input.source.runEpoch
  });
  validateEventRange(input.source, range, after);
  const snapshot = readControlViewSnapshot(input.source);
  requireRunFact(snapshot.projection);
  if (range.headSeq > snapshot.headSeq || range.floorSeq > snapshot.projection.headSeq) {
    throw new ControlViewError("INCONSISTENT_SNAPSHOT", "The activity range and projection cursors disagree.");
  }

  const mapped = range.events
    .map((event) => mapActivityEvent(event, snapshot.sourceRunId, snapshot.sourceRunEpoch))
    .filter((entry): entry is ControlActivityEntry => entry !== null);
  const activity = mapped.slice(0, limit);
  const lastReturned = activity.at(-1)?.seq;
  const lastScanned = range.events.at(-1)?.seq ?? after;
  const moreMapped = mapped.length > activity.length;
  const moreCanonical = range.hasMore || range.headSeq < snapshot.headSeq;
  const nextAfter = moreMapped
    ? lastReturned ?? lastScanned
    : moreCanonical
      ? lastScanned
      : null;
  const freshness = freshnessFor(snapshot);
  return parseControlActivity({
    schemaVersion: CONTROL_PROTOCOL_VERSION,
    project: input.project,
    run: snapshot.sourceRunId,
    runEpoch: snapshot.sourceRunEpoch,
    viewSeq: freshness.viewSeq,
    headSeq: freshness.headSeq,
    floorSeq: freshness.floorSeq,
    stale: freshness.stale,
    activity,
    nextAfter
  });
}

export function buildControlDiagnostics(input: {
  project: string;
  run: string;
  source: ControlViewSource;
  sessions: readonly OwnedControlSession[];
  session?: string | null;
  lines?: number;
  checks?: readonly ControlDiagnosticCheck[];
  capture?: ControlDiagnosticCapture;
  now: number;
}): ControlDiagnostics {
  requirePublicId(input.project, "project");
  assertRequestedRun(input.run, input.source);
  requireNow(input.now);
  const lines = boundedInteger(
    input.lines ?? CONTROL_DIAGNOSTIC_DEFAULT_LINES,
    0,
    CONTROL_DIAGNOSTIC_MAX_LINES,
    "diagnostic line limit"
  );
  const snapshot = readControlViewSnapshot(input.source);
  const run = requireRunFact(snapshot.projection);
  const freshness = freshnessFor(snapshot);
  let captureResult: ControlDiagnosticCaptureResult = { tail: [] };

  if (input.session !== undefined && input.session !== null) {
    const ownership = authorizeDiagnosticSession(
      input.project,
      snapshot,
      input.sessions,
      input.session
    );
    if (!input.capture) throw new ControlViewError("INVALID_INPUT", "Diagnostic capture callback is required for a session tail.");
    // Authorization is complete before this callback can observe the requested session name.
    captureResult = input.capture({
      project: ownership.project,
      run: ownership.run,
      session: ownership.name,
      sessionGeneration: ownership.sessionGeneration,
      taskId: ownership.taskId,
      lines
    });
  } else if (input.capture) {
    throw new ControlViewError("INVALID_INPUT", "Diagnostic capture requires an exact session.");
  }

  if (!captureResult || !Array.isArray(captureResult.tail)) {
    throw new ControlViewError("INVALID_INPUT", "Diagnostic capture returned an invalid bounded result.");
  }
  const rawTail = captureResult.tail;
  if (!rawTail.every((line) => typeof line === "string")) {
    throw new ControlViewError("INVALID_INPUT", "Diagnostic capture returned a non-string line.");
  }
  const keptTail = lines === 0 ? [] : rawTail.slice(-lines);
  const tail = keptTail.map((line) => truncateString(line, 4_096));
  const checks = diagnosticChecks(
    run,
    snapshot,
    input.session ?? null,
    input.now,
    [...(input.checks ?? []), ...(captureResult.checks ?? [])]
  );
  return parseControlDiagnostics({
    schemaVersion: CONTROL_PROTOCOL_VERSION,
    project: input.project,
    run: snapshot.sourceRunId,
    runEpoch: snapshot.sourceRunEpoch,
    viewSeq: freshness.viewSeq,
    headSeq: freshness.headSeq,
    floorSeq: freshness.floorSeq,
    stale: freshness.stale,
    session: input.session ?? null,
    checks,
    tail,
    truncated: Boolean(captureResult.truncated) || rawTail.length > tail.length
  });
}

export function authorizeDiagnosticSession(
  project: string,
  snapshot: ControlViewSnapshot,
  sessions: readonly OwnedControlSession[],
  requestedSession: string
): OwnedControlSession {
  requirePublicId(project, "project");
  requireSessionName(requestedSession);
  const candidates = sessions.filter((session) => session.name === requestedSession);
  if (candidates.length === 0) throw new ControlViewError("SESSION_NOT_FOUND", "The diagnostic session is not owned by this service.");
  if (candidates.length !== 1) throw new ControlViewError("SESSION_OWNERSHIP_MISMATCH", "The diagnostic session ownership is ambiguous.");
  const ownership = candidates[0]!;
  validateOwnedSession(ownership);
  if (ownership.project !== project || ownership.run !== snapshot.sourceRunId) {
    throw new ControlViewError("SESSION_OWNERSHIP_MISMATCH", "The diagnostic session belongs to another project or run.");
  }
  const runtime = snapshot.projection.runtimes[requestedSession];
  if (!runtime) throw new ControlViewError("SESSION_OWNERSHIP_MISMATCH", "No durable runtime fact proves session ownership.");
  if (
    runtime.sessionId !== ownership.name ||
    runtime.sessionGeneration !== ownership.sessionGeneration ||
    (runtime.taskId ?? null) !== ownership.taskId
  ) {
    throw new ControlViewError("SESSION_OWNERSHIP_MISMATCH", "The diagnostic session stamp is stale or targets another task.");
  }
  return {
    name: ownership.name,
    project: ownership.project,
    run: ownership.run,
    role: ownership.role,
    sessionGeneration: ownership.sessionGeneration,
    taskId: ownership.taskId
  };
}

export function encodeControlRunsCursor(key: ControlRunsCursorKey): string {
  requirePublicId(key.project, "cursor project");
  requirePublicId(key.run, "cursor run");
  requireRunEpoch(key.runEpoch);
  const startedAt = canonicalTimestamp(key.startedAt, "cursor start");
  return parsePageCursor(`v1.${Buffer.from(`${key.project}\0${startedAt}\0${key.run}\0${key.runEpoch}`, "utf8").toString("base64url")}`);
}

export function decodeControlRunsCursor(cursor: string): ControlRunsCursorKey {
  return decodeRunCursor(cursor);
}

function readProjectSnapshots(project: ControlProjectViewSource): ControlViewSnapshot[] {
  return readSnapshots(project.runs);
}

function readSnapshots(sources: readonly ControlViewSource[]): ControlViewSnapshot[] {
  const snapshots = sources.map(readControlViewSnapshot);
  const identities = new Set<string>();
  for (const snapshot of snapshots) {
    const identity = `${snapshot.sourceRunId}\0${snapshot.sourceRunEpoch}`;
    if (identities.has(identity)) throw new ControlViewError("INVALID_INPUT", "Duplicate run read source.");
    identities.add(identity);
  }
  return snapshots;
}

function summariesForSnapshots(project: string, snapshots: readonly ControlViewSnapshot[]): ControlRunSummary[] {
  return snapshots
    .map((snapshot) => mapRunSummary(project, snapshot))
    .sort(compareRunSummaries);
}

function mapRunSummary(project: string, snapshot: ControlViewSnapshot): ControlRunSummary {
  const run = requireRunFact(snapshot.projection);
  const freshness = freshnessFor(snapshot);
  const startedAt = canonicalTimestamp(run.startedAt, "run start");
  const completedAt = run.terminalAt ? canonicalTimestamp(run.terminalAt, "run completion") : null;
  return toPublicRunSummary({
    project,
    run: snapshot.sourceRunId,
    runEpoch: snapshot.sourceRunEpoch,
    status: mapRunStatus(run),
    reason: mapRunReason(run),
    startedAt,
    updatedAt: latestProjectionTimestamp(snapshot.projection, startedAt),
    completedAt,
    viewSeq: freshness.viewSeq,
    headSeq: freshness.headSeq,
    floorSeq: freshness.floorSeq,
    stale: freshness.stale,
    tasks: countTasks(snapshot.projection)
  });
}

function mapRunStatus(run: RunFact): ControlRunStatus {
  switch (run.status) {
    case "started":
      return "running";
    case "completed":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

function mapRunReason(run: RunFact): string | null {
  if (run.status === "failed") return normalizePublicCode(run.reasonCode ?? "run-failed", "run-failed");
  if (run.status === "cancelled") return "run-cancelled";
  return null;
}

function mapTask(task: TaskFact): ControlTask {
  requirePublicId(task.id, "task");
  requirePublicId(task.assignee, "task assignee");
  if (task.claimedBy !== undefined) requirePublicId(task.claimedBy, "task claimant");
  const dependsOn = task.dependsOn.map((dependency) => requirePublicId(dependency, "task dependency"));
  return toPublicTask({
    id: task.id,
    title: truncateString(task.title, 4_096),
    status: task.status,
    assignee: task.assignee,
    claimedBy: task.claimedBy ?? null,
    priority: Math.min(100, Math.max(0, task.priority)),
    dependsOn,
    attempts: Math.min(100, task.attempts),
    createdAt: canonicalTimestamp(task.createdAt, "task creation"),
    updatedAt: canonicalTimestamp(task.lastUpdate, "task update"),
    summary: task.lastSummary === undefined ? null : truncateString(task.lastSummary, 4_096)
  });
}

function countTasks(projection: ControlProjection): ControlTaskCounts {
  const counts: ControlTaskCounts = {
    total: 0,
    open: 0,
    active: 0,
    needsReview: 0,
    blocked: 0,
    done: 0,
    rejected: 0,
    escalated: 0
  };
  for (const task of Object.values(projection.tasks)) {
    counts.total += 1;
    switch (task.status) {
      case "open":
        counts.open += 1;
        break;
      case "claimed":
      case "in-progress":
        counts.active += 1;
        break;
      case "needs-review":
        counts.needsReview += 1;
        break;
      case "blocked":
        counts.blocked += 1;
        break;
      case "done":
        counts.done += 1;
        break;
      case "rejected":
        counts.rejected += 1;
        break;
      case "escalated":
        counts.escalated += 1;
        break;
    }
  }
  return counts;
}

function mapOwnedSessions(
  project: string,
  snapshots: readonly ControlViewSnapshot[],
  sessions: readonly OwnedControlSession[],
  now: number
): ControlSessionSummary[] {
  const byRun = new Map(snapshots.map((snapshot) => [snapshot.sourceRunId, snapshot]));
  const names = new Set<string>();
  return [...sessions]
    .sort((a, b) => compareText(a.name, b.name) || compareText(a.run, b.run))
    .map((ownership) => {
      validateOwnedSession(ownership);
      if (ownership.project !== project) {
        throw new ControlViewError("SESSION_OWNERSHIP_MISMATCH", "A status session belongs to another project.");
      }
      const uniqueness = `${ownership.run}\0${ownership.name}`;
      if (names.has(uniqueness)) throw new ControlViewError("SESSION_OWNERSHIP_MISMATCH", "Duplicate session ownership stamp.");
      names.add(uniqueness);
      const snapshot = byRun.get(ownership.run);
      if (!snapshot) throw new ControlViewError("RUN_NOT_FOUND", "A session refers to a run that is not loaded.");
      authorizeDiagnosticSession(project, snapshot, [ownership], ownership.name);
      const runtime = snapshot.projection.runtimes[ownership.name]!;
      const activity = deriveActivity(snapshot.projection, ownership.name, now, snapshot.headSeq);
      return toPublicSessionSummary({
        name: ownership.name,
        project,
        run: ownership.run,
        role: ownership.role,
        state: runtime.observation === "probe_failed" ? "probe-failed" : activity.state === "exited" ? "exited" : "running",
        taskId: ownership.taskId,
        lastActivity: canonicalTimestamp(runtime.observedAt, "session activity")
      });
    });
}

function mapActivityEvent(
  event: PersistedControlEvent,
  runId: string,
  runEpoch: string
): ControlActivityEntry | null {
  if (event.runId !== runId || event.runEpoch !== runEpoch) {
    throw new ControlViewError("IDENTITY_MISMATCH", "An activity event belongs to another run.");
  }
  const common = {
    seq: event.seq,
    occurredAt: canonicalTimestamp(event.occurredAt, "event occurrence")
  };
  switch (event.type) {
    case "run.started":
      return toPublicActivity({
        seq: common.seq,
        occurredAt: common.occurredAt,
        kind: "run.started",
        actor: publicIdOrNull(event.payload.startedBy),
        taskId: null,
        status: null,
        summary: null
      });
    case "run.completed":
      return toPublicActivity({
        seq: common.seq,
        occurredAt: common.occurredAt,
        kind: "run.completed",
        actor: null,
        taskId: null,
        status: null,
        summary: optionalSummary(event.payload.summary)
      });
    case "run.failed":
      return toPublicActivity({
        seq: common.seq,
        occurredAt: common.occurredAt,
        kind: "run.failed",
        actor: null,
        taskId: null,
        status: null,
        summary: optionalSummary(event.payload.summary)
      });
    case "run.cancelled":
      return toPublicActivity({
        seq: common.seq,
        occurredAt: common.occurredAt,
        kind: "run.cancelled",
        actor: publicIdOrNull(event.payload.cancelledBy),
        taskId: null,
        status: null,
        summary: optionalSummary(event.payload.reason)
      });
    case "task.created":
      return toPublicActivity({
        seq: common.seq,
        occurredAt: common.occurredAt,
        kind: "task.created",
        actor: publicIdOrNull(event.payload.createdBy),
        taskId: requireEventTaskId(event),
        status: "open",
        summary: truncateString(event.payload.title, 4_096)
      });
    case "task.status_changed": {
      const kind = statusActivityKind(event.payload.status);
      if (kind === null) return null;
      return toPublicActivity({
        seq: common.seq,
        occurredAt: common.occurredAt,
        kind,
        actor: publicIdOrNull(event.payload.role),
        taskId: requireEventTaskId(event),
        status: event.payload.status,
        summary: optionalSummary(event.payload.summary)
      });
    }
    case "runtime.observed":
      if (event.payload.observation !== "probe_failed") return null;
      return toPublicActivity({
        seq: common.seq,
        occurredAt: common.occurredAt,
        kind: "runtime.probe-failed",
        actor: null,
        taskId: event.taskId === null ? null : requirePublicId(event.taskId, "activity task"),
        status: null,
        summary: "Runtime probe failed."
      });
    case "message.posted":
    case "run.checkpointed":
    case "task.reopened":
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
    case "scm.publication_recorded":
    case "scm.publication_state_changed":
    case "scm.poll_started":
    case "scm.poll_completed":
    case "scm.poll_failed":
    case "scm.bucket_accepted":
    case "scm.reaction_created":
    case "scm.reaction_transitioned":
    case "observation.source_checkpointed":
    case "observation.recorded":
    case "multirepo.plan_registered":
    case "multirepo.scheduler_transitioned":
    case "multirepo.worktree_group_recorded":
    case "multirepo.worker_settled":
    case "multirepo.worktree_commit_intended":
    case "multirepo.worktree_head_recorded":
    case "multirepo.integration_transitioned":
    case "multirepo.local_integration_receipted":
    case "multirepo.publication_transitioned":
      return null;
  }
}

function statusActivityKind(status: TaskFact["status"]): ControlActivityEntry["kind"] | null {
  switch (status) {
    case "open":
      return null;
    case "claimed":
      return "task.claimed";
    case "in-progress":
      return "task.started";
    case "blocked":
      return "task.blocked";
    case "needs-review":
      return "task.review-requested";
    case "done":
      return "task.completed";
    case "rejected":
      return "task.rejected";
    case "escalated":
      return "task.escalated";
  }
}

function diagnosticChecks(
  run: RunFact,
  snapshot: ControlViewSnapshot,
  session: string | null,
  now: number,
  supplied: readonly ControlDiagnosticCheck[]
): ControlDiagnosticCheck[] {
  const freshness = freshnessFor(snapshot);
  const checks: ControlDiagnosticCheck[] = [
    toPublicDiagnosticCheck({
      code: "store-view",
      status: freshness.stale ? "warn" : "ok",
      message: freshness.stale ? "The materialized view trails the durable event head." : "The materialized view matches the durable event head.",
      fix: freshness.stale ? "Retry the request; if the view remains stale, run the local control-store recovery check." : null
    }),
    toPublicDiagnosticCheck({
      code: "run-lifecycle",
      status: run.status === "failed" ? "fail" : run.status === "cancelled" ? "warn" : "ok",
      message: run.status === "failed" ? "The run ended in failure." : run.status === "cancelled" ? "The run was cancelled." : `The run is ${run.status}.`,
      fix: run.status === "failed" ? "Inspect the allowlisted activity and local operator logs, correct the failed gate, then start a new run." : run.status === "cancelled" ? "Start a new run if the cancelled work should resume." : null
    })
  ];
  if (session !== null) {
    const runtime = snapshot.projection.runtimes[session]!;
    const activity = deriveActivity(snapshot.projection, session, now, snapshot.headSeq);
    checks.push(toPublicDiagnosticCheck({
      code: "session-runtime",
      status: runtime.observation === "probe_failed" ? "warn" : "ok",
      message: runtime.observation === "probe_failed"
        ? "The latest session runtime probe failed."
        : `The latest owned session observation is ${activity.ageMs ?? 0} ms old.`,
      fix: runtime.observation === "probe_failed"
        ? "Inspect the exact local session, restore the runtime probe, and retry diagnostics."
        : null
    }));
  }
  for (const check of supplied) checks.push(toPublicDiagnosticCheck(check));
  checks.sort((a, b) => compareText(a.code, b.code));
  for (let index = 1; index < checks.length; index += 1) {
    if (checks[index - 1]!.code === checks[index]!.code) {
      throw new ControlViewError("INVALID_INPUT", "Diagnostic check codes must be unique.");
    }
  }
  return checks;
}

function validateEventRange(source: ControlViewSource, range: EventRange, after: number): void {
  if (range.runEpoch !== source.runEpoch || range.afterSeq !== after) {
    throw new ControlViewError("IDENTITY_MISMATCH", "The activity range belongs to another cursor or run epoch.");
  }
  requireSequence(range.floorSeq, "activity floor");
  requireSequence(range.headSeq, "activity head");
  if (range.floorSeq > range.headSeq && range.headSeq !== 0) {
    throw new ControlViewError("INCONSISTENT_SNAPSHOT", "The activity range freshness cursor is inconsistent.");
  }
  let prior = after;
  for (const event of range.events) {
    requireSequence(event.seq, "activity event sequence");
    if (event.seq <= prior || event.seq > range.headSeq) {
      throw new ControlViewError("INCONSISTENT_SNAPSHOT", "The activity range is not strictly ordered.");
    }
    prior = event.seq;
  }
  if (range.hasMore && range.events.length === 0) {
    throw new ControlViewError("INCONSISTENT_SNAPSHOT", "The activity range claims an empty continuation.");
  }
}

function freshnessFor(snapshot: ControlViewSnapshot): Freshness {
  return {
    viewSeq: snapshot.projection.headSeq,
    headSeq: snapshot.headSeq,
    floorSeq: snapshot.floorSeq,
    stale: snapshot.projection.headSeq < snapshot.headSeq
  };
}

function latestProjectionTimestamp(projection: ControlProjection, startedAt: string): string {
  let latest = startedAt;
  const consider = (value: string | undefined, label: string): void => {
    if (value === undefined) return;
    const timestamp = canonicalTimestamp(value, label);
    if (timestamp > latest) latest = timestamp;
  };
  consider(projection.run?.terminalAt, "run terminal");
  for (const task of Object.values(projection.tasks)) consider(task.lastUpdate, "task update");
  for (const message of projection.messages) consider(message.occurredAt, "message occurrence");
  for (const runtime of Object.values(projection.runtimes)) consider(runtime.observedAt, "runtime observation");
  return latest;
}

function requireRunFact(projection: ControlProjection): RunFact {
  if (!projection.run) throw new ControlViewError("RUN_NOT_STARTED", "The run has no durable lifecycle start fact.");
  return projection.run;
}

function assertRequestedRun(run: string, source: ControlViewSource): void {
  requirePublicId(run, "requested run");
  if (run !== source.runId) {
    throw new ControlViewError("RUN_NOT_FOUND", "The requested run is not the exact loaded run.");
  }
}

function validateOwnedSession(session: OwnedControlSession): void {
  requireSessionName(session.name);
  requirePublicId(session.project, "session project");
  requirePublicId(session.run, "session run");
  requirePublicId(session.role, "session role");
  boundedInteger(session.sessionGeneration, 1, Number.MAX_SAFE_INTEGER, "session generation");
  if (session.taskId !== null) requirePublicId(session.taskId, "session task");
}

function requireEventTaskId(event: PersistedControlEvent): string {
  if (event.taskId === null) throw new ControlViewError("INCONSISTENT_SNAPSHOT", "A task activity event has no task identity.");
  return requirePublicId(event.taskId, "activity task");
}

function optionalSummary(value: string | undefined): string | null {
  return value === undefined ? null : truncateString(value, 4_096);
}

function compareRunSummaries(a: ControlRunSummary, b: ControlRunSummary): number {
  return compareText(b.startedAt, a.startedAt) || compareText(a.run, b.run) || compareText(a.runEpoch, b.runEpoch);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function encodeRunCursor(key: ControlRunsCursorKey): string {
  return encodeControlRunsCursor(key);
}

function decodeRunCursor(cursor: string): ControlRunsCursorKey {
  try {
    const parsed = parsePageCursor(cursor);
    const encoded = parsed.slice(3);
    const body = Buffer.from(encoded, "base64url");
    if (body.toString("base64url") !== encoded) throw new Error("non-canonical base64url");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    const parts = text.split("\0");
    if (parts.length !== 4) throw new Error("wrong cursor field count");
    const [project, startedAt, run, runEpoch] = parts as [string, string, string, string];
    requirePublicId(project, "cursor project");
    requirePublicId(run, "cursor run");
    requireRunEpoch(runEpoch);
    return { project, startedAt: canonicalTimestamp(startedAt, "cursor start"), run, runEpoch };
  } catch (error) {
    if (error instanceof ControlViewError && error.code !== "INVALID_INPUT") throw error;
    if (error instanceof ControlProtocolError || error instanceof Error) {
      throw new ControlViewError("INVALID_CURSOR", "The run page cursor is invalid.");
    }
    throw error;
  }
}

function normalizePublicCode(value: string, fallback: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, 64);
  return /^[a-z][a-z0-9._-]*$/.test(normalized) ? normalized : fallback;
}

function canonicalTimestamp(value: string, label: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new ControlViewError("INVALID_INPUT", `Invalid ${label} timestamp.`);
  return parsed.toISOString();
}

function requirePublicId(value: unknown, label: string): string {
  if (!isValidId(value)) throw new ControlViewError("INVALID_INPUT", `Invalid public ${label} identity.`);
  return value;
}

function requireRunEpoch(value: unknown): string {
  if (typeof value !== "string" || value.length < 16 || value.length > 128 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ControlViewError("INVALID_INPUT", "Invalid public run epoch.");
  }
  return value;
}

function requireSessionName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 192 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ||
    value.includes("..")
  ) {
    throw new ControlViewError("INVALID_INPUT", "Invalid public session identity.");
  }
  return value;
}

function publicIdOrNull(value: string): string | null {
  return isValidId(value) ? value : null;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ControlViewError("INVALID_INPUT", `Invalid ${label}.`);
  }
  return value;
}

function requireSequence(value: number, label: string): void {
  boundedInteger(value, 0, Number.MAX_SAFE_INTEGER, label);
}

function requireNow(value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new ControlViewError("INVALID_INPUT", "Invalid injected clock value.");
}

function truncateString(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(0, maximum);
}

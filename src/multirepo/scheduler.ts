import { createHash } from "node:crypto";
import { parseMultiRepoSchedulerEvent, type MultiRepoSchedulerEventV1 } from "./events.js";

export const MULTIREPO_SCHEDULER_LIMITS = Object.freeze({ agingIntervalSeq: 32, maximumAgingBoost: 2_048 });

type RegisteredEvent = Extract<MultiRepoSchedulerEventV1, { type: "scheduler.task_registered" }>;
type LeaseGrantedEvent = Extract<MultiRepoSchedulerEventV1, { type: "scheduler.lease_granted" }>;

export type SchedulerLeaseV1 = Readonly<Omit<LeaseGrantedEvent, "schemaVersion" | "seq" | "eventId" | "occurredAt" | "taskId" | "taskGeneration" | "type" | "expectedVersion" | "repositoryIds"> & {
  repositoryIds: readonly string[];
  state: "admitted" | "dispatched" | "uncertain";
  processIdentity?: string;
  uncertainReason?: string;
}>;

export type SchedulerTaskProjectionV1 = Readonly<{
  taskId: string;
  taskGeneration: number;
  version: number;
  repositorySetId: string;
  repositoryIds: readonly string[];
  providerId: string;
  dependencies: readonly string[];
  priority: number;
  state: "waiting" | "active" | "completed" | "cancelled" | "failed" | "uncertain";
  dirty: boolean;
  dirtySinceSeq?: number;
  processing?: Readonly<{ reconcileId: string; ownerId: string; startedSeq: number }>;
  lease?: SchedulerLeaseV1;
  lastEventSeq: number;
}>;

export type MultiRepoSchedulerProjectionV1 = Readonly<{
  schemaVersion: 1;
  headSeq: number;
  tasks: Readonly<Record<string, SchedulerTaskProjectionV1>>;
  seenEventIds: Readonly<Record<string, string>>;
}>;

export type MultiRepoSchedulerErrorCode = "INVALID_EVENT" | "SEQUENCE_CONFLICT" | "EVENT_ID_CONFLICT" | "STALE_GENERATION" | "STALE_VERSION" | "INVALID_TRANSITION" | "LEASE_CONFLICT";
export class MultiRepoSchedulerError extends Error {
  constructor(readonly code: MultiRepoSchedulerErrorCode, message: string) { super(`${code}: ${message}`); this.name = "MultiRepoSchedulerError"; }
}

function eventDigest(event: MultiRepoSchedulerEventV1): string { return createHash("sha256").update(JSON.stringify(event)).digest("hex"); }
function emptyProjection(): MultiRepoSchedulerProjectionV1 { return Object.freeze({ schemaVersion: 1, headSeq: 0, tasks: Object.freeze({}), seenEventIds: Object.freeze({}) }); }

function registeredTask(event: RegisteredEvent): SchedulerTaskProjectionV1 {
  if (new Set(event.repositoryIds).size !== event.repositoryIds.length || new Set(event.dependencies).size !== event.dependencies.length || event.dependencies.includes(event.taskId)) throw new MultiRepoSchedulerError("INVALID_EVENT", "registered task repeats a repository/dependency or depends on itself");
  return Object.freeze({ taskId: event.taskId, taskGeneration: event.taskGeneration, version: 1, repositorySetId: event.repositorySetId, repositoryIds: Object.freeze([...event.repositoryIds]), providerId: event.providerId, dependencies: Object.freeze([...event.dependencies]), priority: event.priority, state: "waiting", dirty: true, dirtySinceSeq: event.seq, lastEventSeq: event.seq });
}

function requireTask(projection: MultiRepoSchedulerProjectionV1, event: MultiRepoSchedulerEventV1): SchedulerTaskProjectionV1 {
  const task = projection.tasks[event.taskId];
  if (task === undefined) throw new MultiRepoSchedulerError("INVALID_TRANSITION", `task ${event.taskId} is not registered`);
  if (task.taskGeneration !== event.taskGeneration) throw new MultiRepoSchedulerError("STALE_GENERATION", "task generation differs");
  return task;
}

function requireVersion(task: SchedulerTaskProjectionV1, expectedVersion: number): void {
  if (task.version !== expectedVersion) throw new MultiRepoSchedulerError("STALE_VERSION", `expected task version ${expectedVersion}, current ${task.version}`);
}

function withTask(projection: MultiRepoSchedulerProjectionV1, event: MultiRepoSchedulerEventV1, task: SchedulerTaskProjectionV1): MultiRepoSchedulerProjectionV1 {
  return Object.freeze({ schemaVersion: 1, headSeq: event.seq, tasks: Object.freeze({ ...projection.tasks, [task.taskId]: task }), seenEventIds: Object.freeze({ ...projection.seenEventIds, [event.eventId]: eventDigest(event) }) });
}

export function applyMultiRepoSchedulerEvent(current: MultiRepoSchedulerProjectionV1, raw: unknown): MultiRepoSchedulerProjectionV1 {
  let event: MultiRepoSchedulerEventV1;
  try { event = parseMultiRepoSchedulerEvent(raw); } catch (error) { throw new MultiRepoSchedulerError("INVALID_EVENT", error instanceof Error ? error.message : "invalid event"); }
  const digest = eventDigest(event); const priorDigest = current.seenEventIds[event.eventId];
  if (priorDigest !== undefined) {
    if (priorDigest !== digest) throw new MultiRepoSchedulerError("EVENT_ID_CONFLICT", `event ID ${event.eventId} has divergent content`);
    return current;
  }
  if (event.seq !== current.headSeq + 1) throw new MultiRepoSchedulerError("SEQUENCE_CONFLICT", `event sequence ${event.seq} does not follow ${current.headSeq}`);
  if (event.type === "scheduler.task_registered") {
    const existing = current.tasks[event.taskId];
    if (existing !== undefined) throw new MultiRepoSchedulerError(existing.taskGeneration === event.taskGeneration ? "INVALID_TRANSITION" : "STALE_GENERATION", "task is already registered");
    return withTask(current, event, registeredTask(event));
  }
  const task = requireTask(current, event);
  let next: SchedulerTaskProjectionV1;
  switch (event.type) {
    case "scheduler.task_dirtied": {
      if (["completed", "cancelled"].includes(task.state)) throw new MultiRepoSchedulerError("INVALID_TRANSITION", "terminal task cannot become dirty");
      next = Object.freeze({ ...task, version: task.version + 1, dirty: true, dirtySinceSeq: task.dirtySinceSeq ?? event.seq, lastEventSeq: event.seq }); break;
    }
    case "scheduler.reconcile_started": {
      requireVersion(task, event.expectedVersion);
      if (!task.dirty || task.processing !== undefined || ["completed", "cancelled"].includes(task.state)) throw new MultiRepoSchedulerError("INVALID_TRANSITION", "task is not eligible to begin reconciliation");
      next = Object.freeze({ ...task, version: task.version + 1, dirty: false, dirtySinceSeq: undefined, processing: Object.freeze({ reconcileId: event.reconcileId, ownerId: event.ownerId, startedSeq: event.seq }), lastEventSeq: event.seq }); break;
    }
    case "scheduler.reconcile_finished": {
      requireVersion(task, event.expectedVersion);
      if (task.processing?.reconcileId !== event.reconcileId || task.processing.ownerId !== event.ownerId) throw new MultiRepoSchedulerError("INVALID_TRANSITION", "reconcile finish does not match the processing owner");
      next = Object.freeze({ ...task, version: task.version + 1, processing: undefined, lastEventSeq: event.seq }); break;
    }
    case "scheduler.lease_granted": {
      requireVersion(task, event.expectedVersion);
      if (task.lease !== undefined || task.state !== "waiting" || event.repositorySetId !== task.repositorySetId || event.providerId !== task.providerId || JSON.stringify(event.repositoryIds) !== JSON.stringify(task.repositoryIds) || Date.parse(event.expiresAt) <= Date.parse(event.issuedAt)) throw new MultiRepoSchedulerError("LEASE_CONFLICT", "lease does not match an admissible task");
      const { schemaVersion: _schema, seq: _seq, eventId: _id, occurredAt: _at, taskId: _task, taskGeneration: _generation, type: _type, expectedVersion: _version, ...lease } = event;
      next = Object.freeze({ ...task, version: task.version + 1, state: "active", lease: Object.freeze({ ...lease, repositoryIds: Object.freeze([...lease.repositoryIds]), state: "admitted" }), lastEventSeq: event.seq }); break;
    }
    case "scheduler.dispatch_acknowledged": {
      requireVersion(task, event.expectedVersion);
      if (task.lease?.leaseToken !== event.leaseToken || task.lease.state !== "admitted") throw new MultiRepoSchedulerError("LEASE_CONFLICT", "dispatch acknowledgement does not match an admitted lease");
      next = Object.freeze({ ...task, version: task.version + 1, lease: Object.freeze({ ...task.lease, state: "dispatched", processIdentity: event.processIdentity }), lastEventSeq: event.seq }); break;
    }
    case "scheduler.lease_heartbeat": {
      requireVersion(task, event.expectedVersion);
      if (task.lease?.leaseToken !== event.leaseToken || task.lease.ownerIncarnation !== event.ownerIncarnation || task.lease.state === "uncertain" || Date.parse(event.expiresAt) <= Date.parse(task.lease.expiresAt)) throw new MultiRepoSchedulerError("LEASE_CONFLICT", "heartbeat does not extend the exact live lease");
      next = Object.freeze({ ...task, version: task.version + 1, lease: Object.freeze({ ...task.lease, expiresAt: event.expiresAt }), lastEventSeq: event.seq }); break;
    }
    case "scheduler.lease_uncertain": {
      requireVersion(task, event.expectedVersion);
      if (task.lease?.leaseToken !== event.leaseToken) throw new MultiRepoSchedulerError("LEASE_CONFLICT", "uncertain transition does not match lease");
      next = Object.freeze({ ...task, version: task.version + 1, state: "uncertain", lease: Object.freeze({ ...task.lease, state: "uncertain", uncertainReason: event.reasonCode }), lastEventSeq: event.seq }); break;
    }
    case "scheduler.lease_released": {
      requireVersion(task, event.expectedVersion);
      if (task.lease?.leaseToken !== event.leaseToken || task.lease.state === "uncertain") throw new MultiRepoSchedulerError("LEASE_CONFLICT", "release does not match an exactly settled lease");
      const state = event.outcome === "completed" ? "completed" : event.outcome === "cancelled" ? "cancelled" : event.outcome === "failed" ? "failed" : "waiting";
      next = Object.freeze({ ...task, version: task.version + 1, state, lease: undefined, dirty: event.outcome === "retry" ? true : task.dirty, dirtySinceSeq: event.outcome === "retry" ? event.seq : task.dirtySinceSeq, lastEventSeq: event.seq }); break;
    }
    case "scheduler.task_cancelled": {
      requireVersion(task, event.expectedVersion);
      if (task.lease !== undefined || ["completed", "cancelled"].includes(task.state)) throw new MultiRepoSchedulerError("INVALID_TRANSITION", "only an unleased nonterminal task can be cancelled");
      next = Object.freeze({ ...task, version: task.version + 1, state: "cancelled", dirty: false, dirtySinceSeq: undefined, lastEventSeq: event.seq }); break;
    }
  }
  return withTask(current, event, next);
}

export function reduceMultiRepoSchedulerEvents(events: readonly unknown[]): MultiRepoSchedulerProjectionV1 {
  return events.reduce<MultiRepoSchedulerProjectionV1>(applyMultiRepoSchedulerEvent, emptyProjection());
}

export function emptyMultiRepoSchedulerProjection(): MultiRepoSchedulerProjectionV1 { return emptyProjection(); }

export function chooseNextReconciliation(projection: MultiRepoSchedulerProjectionV1): SchedulerTaskProjectionV1 | undefined {
  return Object.values(projection.tasks).filter((task) => task.dirty && task.processing === undefined && !["completed", "cancelled"].includes(task.state)).sort((left, right) => {
    const leftAge = Math.min(MULTIREPO_SCHEDULER_LIMITS.maximumAgingBoost, Math.floor((projection.headSeq - (left.dirtySinceSeq ?? projection.headSeq)) / MULTIREPO_SCHEDULER_LIMITS.agingIntervalSeq));
    const rightAge = Math.min(MULTIREPO_SCHEDULER_LIMITS.maximumAgingBoost, Math.floor((projection.headSeq - (right.dirtySinceSeq ?? projection.headSeq)) / MULTIREPO_SCHEDULER_LIMITS.agingIntervalSeq));
    return (right.priority + rightAge) - (left.priority + leftAge) || (left.dirtySinceSeq ?? 0) - (right.dirtySinceSeq ?? 0) || left.taskId.localeCompare(right.taskId);
  })[0];
}

export type SchedulerConcurrencyLimits = Readonly<{ global: number; perProvider: number; perRepository: number; perTask: number }>;
export type SchedulerAdmissionBlockReason = "TASK_TERMINAL" | "TASK_UNCERTAIN" | "TASK_ALREADY_LEASED" | "DEPENDENCY_PENDING" | "REPOSITORY_SET_MISMATCH" | "ROLE_SCOPE" | "PROVIDER_SCOPE" | "BUDGET_UNAVAILABLE" | "GLOBAL_CAPACITY" | "PROVIDER_CAPACITY" | "REPOSITORY_CAPACITY" | "TASK_CAPACITY";
export type SchedulerAdmissionDecision = Readonly<{ admitted: true; event: Extract<MultiRepoSchedulerEventV1, { type: "scheduler.lease_granted" }> }> | Readonly<{ admitted: false; reasonCode: SchedulerAdmissionBlockReason; detail: string }>;

export function decideSchedulerAdmission(input: Readonly<{
  projection: MultiRepoSchedulerProjectionV1;
  taskId: string;
  expectedVersion: number;
  repositorySetId: string;
  roleRepositoryIds: readonly string[];
  providerRepositoryIds: readonly string[];
  budgetAvailable: boolean;
  limits: SchedulerConcurrencyLimits;
  lease: Readonly<{ eventId: string; occurredAt: string; leaseToken: string; leaseVersion: number; attemptId: string; ownerId: string; ownerIncarnation: string; issuedAt: string; expiresAt: string }>;
}>): SchedulerAdmissionDecision {
  const task = input.projection.tasks[input.taskId];
  if (task === undefined || ["completed", "cancelled", "failed"].includes(task.state)) return Object.freeze({ admitted: false, reasonCode: "TASK_TERMINAL", detail: "task is absent or terminal" });
  if (task.state === "uncertain" || task.lease?.state === "uncertain") return Object.freeze({ admitted: false, reasonCode: "TASK_UNCERTAIN", detail: "task has an uncertain lease" });
  if (task.lease !== undefined) return Object.freeze({ admitted: false, reasonCode: "TASK_ALREADY_LEASED", detail: "task already has a live lease" });
  if (task.version !== input.expectedVersion) throw new MultiRepoSchedulerError("STALE_VERSION", "admission expected version differs");
  for (const dependency of task.dependencies) if (input.projection.tasks[dependency]?.state !== "completed") return Object.freeze({ admitted: false, reasonCode: "DEPENDENCY_PENDING", detail: `dependency ${dependency} is not completed` });
  if (input.repositorySetId !== task.repositorySetId) return Object.freeze({ admitted: false, reasonCode: "REPOSITORY_SET_MISMATCH", detail: "repository-set digest differs" });
  const role = new Set(input.roleRepositoryIds); const provider = new Set(input.providerRepositoryIds);
  if (task.repositoryIds.some((id) => !role.has(id))) return Object.freeze({ admitted: false, reasonCode: "ROLE_SCOPE", detail: "task exceeds role repository capability" });
  if (task.repositoryIds.some((id) => !provider.has(id))) return Object.freeze({ admitted: false, reasonCode: "PROVIDER_SCOPE", detail: "task exceeds provider repository capability" });
  if (!input.budgetAvailable) return Object.freeze({ admitted: false, reasonCode: "BUDGET_UNAVAILABLE", detail: "budget is unavailable" });
  for (const [name, value] of Object.entries(input.limits)) if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) throw new RangeError(`invalid ${name} concurrency limit`);
  const leases = Object.values(input.projection.tasks).filter((candidate) => candidate.lease !== undefined).map((candidate) => candidate.lease!);
  if (leases.length >= input.limits.global) return Object.freeze({ admitted: false, reasonCode: "GLOBAL_CAPACITY", detail: "global concurrency is full" });
  if (leases.filter((lease) => lease.providerId === task.providerId).length >= input.limits.perProvider) return Object.freeze({ admitted: false, reasonCode: "PROVIDER_CAPACITY", detail: `provider ${task.providerId} is full` });
  if (task.repositoryIds.some((id) => leases.filter((lease) => lease.repositoryIds.includes(id)).length >= input.limits.perRepository)) return Object.freeze({ admitted: false, reasonCode: "REPOSITORY_CAPACITY", detail: "a repository concurrency limit is full" });
  if (leases.filter((lease) => lease.attemptId === input.lease.attemptId).length >= input.limits.perTask) return Object.freeze({ admitted: false, reasonCode: "TASK_CAPACITY", detail: "task attempt concurrency is full" });
  const event = parseMultiRepoSchedulerEvent({ schemaVersion: 1, seq: input.projection.headSeq + 1, eventId: input.lease.eventId, occurredAt: input.lease.occurredAt, taskId: task.taskId, taskGeneration: task.taskGeneration, type: "scheduler.lease_granted", expectedVersion: task.version, leaseToken: input.lease.leaseToken, leaseVersion: input.lease.leaseVersion, attemptId: input.lease.attemptId, repositorySetId: task.repositorySetId, providerId: task.providerId, repositoryIds: task.repositoryIds, ownerId: input.lease.ownerId, ownerIncarnation: input.lease.ownerIncarnation, issuedAt: input.lease.issuedAt, expiresAt: input.lease.expiresAt }) as Extract<MultiRepoSchedulerEventV1, { type: "scheduler.lease_granted" }>;
  return Object.freeze({ admitted: true, event });
}

export function decideExpiredLease(input: Readonly<{ projection: MultiRepoSchedulerProjectionV1; taskId: string; now: string; ownerStatus: "dead" | "alive" | "unknown"; eventId: string; occurredAt: string }>): MultiRepoSchedulerEventV1 | undefined {
  const task = input.projection.tasks[input.taskId]; const lease = task?.lease;
  if (task === undefined || lease === undefined || Date.parse(lease.expiresAt) > Date.parse(input.now) || lease.state === "uncertain") return undefined;
  if (input.ownerStatus === "dead" && lease.state === "admitted") return parseMultiRepoSchedulerEvent({ schemaVersion: 1, seq: input.projection.headSeq + 1, eventId: input.eventId, occurredAt: input.occurredAt, taskId: task.taskId, taskGeneration: task.taskGeneration, type: "scheduler.lease_released", expectedVersion: task.version, leaseToken: lease.leaseToken, outcome: "retry", evidenceDigest: createHash("sha256").update(`expired\0${lease.leaseToken}\0dead`).digest("hex") });
  return parseMultiRepoSchedulerEvent({ schemaVersion: 1, seq: input.projection.headSeq + 1, eventId: input.eventId, occurredAt: input.occurredAt, taskId: task.taskId, taskGeneration: task.taskGeneration, type: "scheduler.lease_uncertain", expectedVersion: task.version, leaseToken: lease.leaseToken, reasonCode: input.ownerStatus === "alive" ? "EXPIRED_OWNER_ALIVE" : "OWNER_UNKNOWN" });
}

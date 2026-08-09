import { z } from "zod";
import { isValidId } from "../ids.js";

const Id = z.string().refine(isValidId, "invalid canonical identifier");
const Sha = z.string().regex(/^[a-f0-9]{64}$/u);
const Token = z.string().regex(/^[a-f0-9]{64}$/u);
const Seq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Timestamp = z.string().length(24).refine((value) => {
  const time = Date.parse(value); return !Number.isNaN(time) && new Date(time).toISOString() === value;
}, "invalid canonical timestamp");

const Envelope = {
  schemaVersion: z.literal(1),
  seq: Seq,
  eventId: Id,
  occurredAt: Timestamp,
  taskId: Id,
  taskGeneration: Version
};

const Lease = {
  leaseToken: Token,
  leaseVersion: Version,
  attemptId: Id,
  repositorySetId: Sha,
  providerId: Id,
  repositoryIds: z.array(Id).min(1).max(32),
  ownerId: Id,
  ownerIncarnation: z.string().min(1).max(256).regex(/^[A-Za-z0-9:._-]+$/u),
  issuedAt: Timestamp,
  expiresAt: Timestamp
};

export const MultiRepoSchedulerEventV1Schema = z.discriminatedUnion("type", [
  z.strictObject({ ...Envelope, type: z.literal("scheduler.task_registered"), repositorySetId: Sha, repositoryIds: z.array(Id).min(1).max(32), providerId: Id, dependencies: z.array(Id).max(256), priority: z.number().int().min(-1_000).max(1_000) }),
  z.strictObject({ ...Envelope, type: z.literal("scheduler.task_dirtied"), reasonCode: z.enum(["REGISTERED", "DEPENDENCY_CHANGED", "CAPACITY_CHANGED", "LEASE_CHANGED", "EXTERNAL_FACT", "RETRY"]) }),
  z.strictObject({ ...Envelope, type: z.literal("scheduler.reconcile_started"), reconcileId: Id, ownerId: Id, expectedVersion: Version }),
  z.strictObject({ ...Envelope, type: z.literal("scheduler.reconcile_finished"), reconcileId: Id, ownerId: Id, expectedVersion: Version }),
  z.strictObject({ ...Envelope, type: z.literal("scheduler.lease_granted"), expectedVersion: Version, ...Lease }),
  z.strictObject({ ...Envelope, type: z.literal("scheduler.dispatch_acknowledged"), expectedVersion: Version, leaseToken: Token, processIdentity: z.string().min(1).max(512) }),
  z.strictObject({ ...Envelope, type: z.literal("scheduler.lease_heartbeat"), expectedVersion: Version, leaseToken: Token, ownerIncarnation: Lease.ownerIncarnation, expiresAt: Timestamp }),
  z.strictObject({ ...Envelope, type: z.literal("scheduler.lease_uncertain"), expectedVersion: Version, leaseToken: Token, reasonCode: z.enum(["EXPIRED_OWNER_ALIVE", "OWNER_UNKNOWN", "PROCESS_IDENTITY_UNKNOWN", "SETTLEMENT_UNKNOWN"]) }),
  z.strictObject({ ...Envelope, type: z.literal("scheduler.lease_released"), expectedVersion: Version, leaseToken: Token, outcome: z.enum(["completed", "retry", "cancelled", "failed"]), evidenceDigest: Sha }),
  z.strictObject({ ...Envelope, type: z.literal("scheduler.task_cancelled"), expectedVersion: Version, reasonCode: Id })
]);

export type MultiRepoSchedulerEventV1 = z.infer<typeof MultiRepoSchedulerEventV1Schema>;

export function parseMultiRepoSchedulerEvent(value: unknown): MultiRepoSchedulerEventV1 {
  const parsed = MultiRepoSchedulerEventV1Schema.safeParse(value);
  if (!parsed.success) throw new Error(`INVALID_SCHEDULER_EVENT: ${parsed.error.issues[0]?.message ?? "invalid event"}`);
  return parsed.data;
}

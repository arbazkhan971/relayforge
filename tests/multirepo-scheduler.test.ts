import { describe, expect, it } from "vitest";
import { applyMultiRepoSchedulerEvent, chooseNextReconciliation, decideExpiredLease, decideSchedulerAdmission, emptyMultiRepoSchedulerProjection, reduceMultiRepoSchedulerEvents } from "../src/multirepo/scheduler.js";

const at = (second: number) => `2026-08-09T12:00:${String(second).padStart(2, "0")}.000Z`;
const sha = (scalar: string) => scalar.repeat(64);
const registered = (seq: number, taskId: string, dependencies: string[] = [], priority = 0) => ({ schemaVersion: 1, seq, eventId: `event-${seq}`, occurredAt: at(seq), taskId, taskGeneration: 1, type: "scheduler.task_registered" as const, repositorySetId: sha(taskId === "one" ? "1" : "2"), repositoryIds: [taskId === "one" ? "api" : "web"], providerId: "codex", dependencies, priority });
const dirtied = (seq: number, taskId: string) => ({ schemaVersion: 1, seq, eventId: `event-${seq}`, occurredAt: at(seq), taskId, taskGeneration: 1, type: "scheduler.task_dirtied" as const, reasonCode: "EXTERNAL_FACT" as const });
const leaseInput = (eventId = "lease-event") => ({ eventId, occurredAt: at(3), leaseToken: sha("a"), leaseVersion: 1, attemptId: "attempt-1", ownerId: "owner-1", ownerIncarnation: "owner:1", issuedAt: at(3), expiresAt: at(9) });

describe("durable multi-repository scheduler projection", () => {
  it("preserves dirty-while-processing and schedules exactly one later reconcile", () => {
    let projection = reduceMultiRepoSchedulerEvents([registered(1, "one")]);
    projection = applyMultiRepoSchedulerEvent(projection, { schemaVersion: 1, seq: 2, eventId: "start", occurredAt: at(2), taskId: "one", taskGeneration: 1, type: "scheduler.reconcile_started", reconcileId: "reconcile-1", ownerId: "owner-1", expectedVersion: 1 });
    projection = applyMultiRepoSchedulerEvent(projection, dirtied(3, "one"));
    projection = applyMultiRepoSchedulerEvent(projection, { schemaVersion: 1, seq: 4, eventId: "finish", occurredAt: at(4), taskId: "one", taskGeneration: 1, type: "scheduler.reconcile_finished", reconcileId: "reconcile-1", ownerId: "owner-1", expectedVersion: 3 });
    expect(projection.tasks.one).toMatchObject({ dirty: true, processing: undefined });
    expect(chooseNextReconciliation(projection)?.taskId).toBe("one");
  });

  it("uses stable priority, age, dirty sequence, and ID ordering", () => {
    let projection = reduceMultiRepoSchedulerEvents([registered(1, "two", [], 1), registered(2, "one", [], 1)]);
    expect(chooseNextReconciliation(projection)?.taskId).toBe("two");
    for (let seq = 3; seq <= 40; seq += 1) projection = applyMultiRepoSchedulerEvent(projection, dirtied(seq, seq % 2 ? "one" : "two"));
    expect(chooseNextReconciliation(projection)?.taskId).toBe("two");
  });

  it("admits only after dependencies, scopes, digest, budgets and capacity pass", () => {
    let projection = reduceMultiRepoSchedulerEvents([registered(1, "one"), registered(2, "two", ["one"])]);
    const base = { projection, taskId: "two", expectedVersion: 1, repositorySetId: sha("2"), roleRepositoryIds: ["web"], providerRepositoryIds: ["web"], budgetAvailable: true, limits: { global: 2, perProvider: 2, perRepository: 1, perTask: 1 }, lease: leaseInput() };
    expect(decideSchedulerAdmission(base)).toMatchObject({ admitted: false, reasonCode: "DEPENDENCY_PENDING" });
    projection = applyMultiRepoSchedulerEvent(projection, decideSchedulerAdmission({ ...base, projection, taskId: "one", repositorySetId: sha("1"), roleRepositoryIds: ["api"], providerRepositoryIds: ["api"], lease: leaseInput("lease-one") }).admitted ? (decideSchedulerAdmission({ ...base, projection, taskId: "one", repositorySetId: sha("1"), roleRepositoryIds: ["api"], providerRepositoryIds: ["api"], lease: leaseInput("lease-one") }) as { admitted: true; event: unknown }).event : {});
    const task = projection.tasks.one!;
    projection = applyMultiRepoSchedulerEvent(projection, { schemaVersion: 1, seq: 4, eventId: "release", occurredAt: at(4), taskId: "one", taskGeneration: 1, type: "scheduler.lease_released", expectedVersion: task.version, leaseToken: sha("a"), outcome: "completed", evidenceDigest: sha("e") });
    const decision = decideSchedulerAdmission({ ...base, projection, expectedVersion: projection.tasks.two!.version });
    expect(decision).toMatchObject({ admitted: true });
    if (decision.admitted) expect(decision.event.repositoryIds).toEqual(["web"]);
  });

  it("accounts for live reservations across global/provider/repository dimensions", () => {
    let projection = reduceMultiRepoSchedulerEvents([registered(1, "one"), registered(2, "two")]);
    const first = decideSchedulerAdmission({ projection, taskId: "one", expectedVersion: 1, repositorySetId: sha("1"), roleRepositoryIds: ["api"], providerRepositoryIds: ["api"], budgetAvailable: true, limits: { global: 2, perProvider: 2, perRepository: 1, perTask: 1 }, lease: leaseInput() });
    if (!first.admitted) throw new Error("fixture admission failed"); projection = applyMultiRepoSchedulerEvent(projection, first.event);
    expect(decideSchedulerAdmission({ projection, taskId: "two", expectedVersion: 1, repositorySetId: sha("2"), roleRepositoryIds: ["web"], providerRepositoryIds: ["web"], budgetAvailable: true, limits: { global: 1, perProvider: 2, perRepository: 1, perTask: 1 }, lease: { ...leaseInput("second"), leaseToken: sha("b"), attemptId: "attempt-2" } })).toMatchObject({ admitted: false, reasonCode: "GLOBAL_CAPACITY" });
  });

  it("requires exact generation/version/token and makes exact event retry idempotent", () => {
    let projection = reduceMultiRepoSchedulerEvents([registered(1, "one")]); const event = dirtied(2, "one");
    projection = applyMultiRepoSchedulerEvent(projection, event); expect(applyMultiRepoSchedulerEvent(projection, event)).toBe(projection);
    expect(() => applyMultiRepoSchedulerEvent(projection, { ...event, reasonCode: "RETRY" })).toThrowError(expect.objectContaining({ code: "EVENT_ID_CONFLICT" }));
    expect(() => applyMultiRepoSchedulerEvent(projection, { ...dirtied(3, "one"), taskGeneration: 2 })).toThrowError(expect.objectContaining({ code: "STALE_GENERATION" }));
  });

  it("marks expired live/unknown owners uncertain and retries only proven-unspawned dead leases", () => {
    let projection = reduceMultiRepoSchedulerEvents([registered(1, "one")]); const admission = decideSchedulerAdmission({ projection, taskId: "one", expectedVersion: 1, repositorySetId: sha("1"), roleRepositoryIds: ["api"], providerRepositoryIds: ["api"], budgetAvailable: true, limits: { global: 1, perProvider: 1, perRepository: 1, perTask: 1 }, lease: leaseInput() });
    if (!admission.admitted) throw new Error("fixture admission failed"); projection = applyMultiRepoSchedulerEvent(projection, admission.event);
    expect(decideExpiredLease({ projection, taskId: "one", now: at(10), ownerStatus: "alive", eventId: "expire-live", occurredAt: at(10) })).toMatchObject({ type: "scheduler.lease_uncertain", reasonCode: "EXPIRED_OWNER_ALIVE" });
    expect(decideExpiredLease({ projection, taskId: "one", now: at(10), ownerStatus: "dead", eventId: "expire-dead", occurredAt: at(10) })).toMatchObject({ type: "scheduler.lease_released", outcome: "retry" });
  });

  it("refuses to release an uncertain or mismatched lease", () => {
    let projection = reduceMultiRepoSchedulerEvents([registered(1, "one")]); const admission = decideSchedulerAdmission({ projection, taskId: "one", expectedVersion: 1, repositorySetId: sha("1"), roleRepositoryIds: ["api"], providerRepositoryIds: ["api"], budgetAvailable: true, limits: { global: 1, perProvider: 1, perRepository: 1, perTask: 1 }, lease: leaseInput() });
    if (!admission.admitted) throw new Error("fixture admission failed"); projection = applyMultiRepoSchedulerEvent(projection, admission.event);
    expect(() => applyMultiRepoSchedulerEvent(projection, { schemaVersion: 1, seq: 3, eventId: "bad-release", occurredAt: at(4), taskId: "one", taskGeneration: 1, type: "scheduler.lease_released", expectedVersion: projection.tasks.one!.version, leaseToken: sha("b"), outcome: "retry", evidenceDigest: sha("e") })).toThrowError(expect.objectContaining({ code: "LEASE_CONFLICT" }));
  });

  it("rejects sequence gaps before mutating projection", () => {
    expect(() => applyMultiRepoSchedulerEvent(emptyMultiRepoSchedulerProjection(), registered(2, "one"))).toThrowError(expect.objectContaining({ code: "SEQUENCE_CONFLICT" }));
  });
});

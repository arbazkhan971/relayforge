import { createHash } from "node:crypto";
import { z } from "zod";

export type MultiRepoPublicationEntryPlanV1 = Readonly<{
  repositoryId: string;
  publicationId: string;
  candidateOid: string;
  localIntegrationRef: string;
  remoteName: string;
  expectedPushUrl: string;
  remoteRef: string;
  expectedRemoteOid: string | null;
  baseRef: string;
  title: string;
  body: string;
}>;

export type MultiRepoPublicationPlanV1 = Readonly<{
  schemaVersion: 1;
  transactionId: string;
  repositorySetId: string;
  localIntegrationReceiptDigest: string;
  policyApproved: boolean;
  entries: readonly MultiRepoPublicationEntryPlanV1[];
}>;

export type MultiRepoPublicationEntryV1 = Readonly<{
  plan: MultiRepoPublicationEntryPlanV1;
  branch?: Readonly<{ remoteOid: string; completedBy: "existing" | "push" | "reconciled" }>;
  pullRequest?: Readonly<{ artifactId: string; url: string; completedBy: "existing" | "create" | "reconciled" }>;
  crossLink?: Readonly<{ digest: string; completedBy: "existing" | "update" | "reconciled" }>;
  lastFailure?: Readonly<{ code: string; retryable: boolean }>;
}>;

export type MultiRepoPublicationProjectionV1 = Readonly<{
  schemaVersion: 1;
  plan: MultiRepoPublicationPlanV1;
  version: number;
  state: "publishing" | "partial" | "published" | "recovery_required";
  entries: readonly MultiRepoPublicationEntryV1[];
  eventIds: Readonly<Record<string, string>>;
  recoveryReason?: string;
}>;

type BaseEvent = Readonly<{ schemaVersion: 1; eventId: string; transactionId: string; expectedVersion: number }>;
export type MultiRepoPublicationEventV1 =
  | (BaseEvent & Readonly<{ type: "publication.created"; plan: MultiRepoPublicationPlanV1 }>)
  | (BaseEvent & Readonly<{ type: "publication.branch_recorded"; repositoryId: string; remoteOid: string; completedBy: "existing" | "push" | "reconciled" }>)
  | (BaseEvent & Readonly<{ type: "publication.pr_recorded"; repositoryId: string; artifactId: string; url: string; completedBy: "existing" | "create" | "reconciled" }>)
  | (BaseEvent & Readonly<{ type: "publication.crosslink_recorded"; repositoryId: string; digest: string; completedBy: "existing" | "update" | "reconciled" }>)
  | (BaseEvent & Readonly<{ type: "publication.retryable_failure"; repositoryId: string; operation: "branch" | "pr" | "crosslink"; code: string }>)
  | (BaseEvent & Readonly<{ type: "publication.recovery_required"; repositoryId: string; operation: "branch" | "pr" | "crosslink"; code: string }>)
  | (BaseEvent & Readonly<{ type: "publication.completed" }>);

const canonicalIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const oidSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const boundedCodeSchema = z.string().min(1).max(512);
const publicationEntryPlanSchema = z.strictObject({
  repositoryId: canonicalIdSchema,
  publicationId: canonicalIdSchema,
  candidateOid: oidSchema,
  localIntegrationRef: z.string().min(1).max(512),
  remoteName: z.string().min(1).max(256).regex(/^[A-Za-z0-9._-]+$/u),
  expectedPushUrl: z.string().url().max(4_096),
  remoteRef: z.string().min(1).max(512),
  expectedRemoteOid: oidSchema.nullable(),
  baseRef: z.string().min(1).max(512),
  title: z.string().max(512),
  body: z.string().max(16 * 1024)
});
const publicationPlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  transactionId: canonicalIdSchema,
  repositorySetId: digestSchema,
  localIntegrationReceiptDigest: digestSchema,
  policyApproved: z.literal(true),
  entries: z.array(publicationEntryPlanSchema).min(1).max(32)
});
const publicationEventBaseSchema = {
  schemaVersion: z.literal(1),
  eventId: canonicalIdSchema,
  transactionId: canonicalIdSchema,
  expectedVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
};

/** Closed wire schema used by the run ControlStore; transition semantics remain reducer-owned. */
export const MultiRepoPublicationEventV1Schema = z.discriminatedUnion("type", [
  z.strictObject({ ...publicationEventBaseSchema, type: z.literal("publication.created"), plan: publicationPlanSchema }),
  z.strictObject({ ...publicationEventBaseSchema, type: z.literal("publication.branch_recorded"), repositoryId: canonicalIdSchema, remoteOid: oidSchema, completedBy: z.enum(["existing", "push", "reconciled"]) }),
  z.strictObject({ ...publicationEventBaseSchema, type: z.literal("publication.pr_recorded"), repositoryId: canonicalIdSchema, artifactId: z.string().min(1).max(512), url: z.string().url().max(4_096), completedBy: z.enum(["existing", "create", "reconciled"]) }),
  z.strictObject({ ...publicationEventBaseSchema, type: z.literal("publication.crosslink_recorded"), repositoryId: canonicalIdSchema, digest: digestSchema, completedBy: z.enum(["existing", "update", "reconciled"]) }),
  z.strictObject({ ...publicationEventBaseSchema, type: z.literal("publication.retryable_failure"), repositoryId: canonicalIdSchema, operation: z.enum(["branch", "pr", "crosslink"]), code: boundedCodeSchema }),
  z.strictObject({ ...publicationEventBaseSchema, type: z.literal("publication.recovery_required"), repositoryId: canonicalIdSchema, operation: z.enum(["branch", "pr", "crosslink"]), code: boundedCodeSchema }),
  z.strictObject({ ...publicationEventBaseSchema, type: z.literal("publication.completed") })
]);

export function parseMultiRepoPublicationEvent(value: unknown): MultiRepoPublicationEventV1 {
  return MultiRepoPublicationEventV1Schema.parse(value) as MultiRepoPublicationEventV1;
}

export type PublicationEffectResult<T> =
  | Readonly<{ state: "completed"; value: T; completedBy: "existing" | "create" | "push" | "update" | "reconciled" }>
  | Readonly<{ state: "retry"; code: string }>
  | Readonly<{ state: "recovery_required"; code: string }>;

export interface MultiRepoPublicationAdapter {
  publishBranch(plan: MultiRepoPublicationEntryPlanV1): Promise<PublicationEffectResult<Readonly<{ remoteOid: string }>>>;
  ensurePullRequest(plan: MultiRepoPublicationEntryPlanV1): Promise<PublicationEffectResult<Readonly<{ artifactId: string; url: string }>>>;
  ensureCrossLinks(input: Readonly<{ entry: MultiRepoPublicationEntryPlanV1; artifacts: readonly Readonly<{ repositoryId: string; artifactId: string; url: string }>[] }>): Promise<PublicationEffectResult<Readonly<{ digest: string }>>>;
}

export class MultiRepoPublicationError extends Error {
  constructor(readonly code: "INVALID_PLAN" | "STALE_VERSION" | "EVENT_ID_CONFLICT" | "INVALID_TRANSITION", message: string) { super(`${code}: ${message}`); this.name = "MultiRepoPublicationError"; }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u; const SHA = /^[a-f0-9]{64}$/u; const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function id(transactionId: string, version: number, action: string): string { return `mp-${createHash("sha256").update(transactionId).update("\0").update(String(version)).update("\0").update(action).digest("hex").slice(0, 48)}`; }

function validatePlan(plan: MultiRepoPublicationPlanV1): MultiRepoPublicationPlanV1 {
  if (plan.schemaVersion !== 1 || !ID.test(plan.transactionId) || !SHA.test(plan.repositorySetId) || !SHA.test(plan.localIntegrationReceiptDigest) || plan.policyApproved !== true || plan.entries.length < 1 || plan.entries.length > 32) throw new MultiRepoPublicationError("INVALID_PLAN", "publication requires an approved, receipt-bound, bounded vector");
  const sorted = [...plan.entries].sort((left, right) => left.repositoryId.localeCompare(right.repositoryId));
  if (sorted.some((entry, index) => entry !== plan.entries[index]) || new Set(sorted.map((entry) => entry.repositoryId)).size !== sorted.length || new Set(sorted.map((entry) => entry.publicationId)).size !== sorted.length) throw new MultiRepoPublicationError("INVALID_PLAN", "publication entries must be uniquely sorted");
  for (const entry of sorted) if (!ID.test(entry.repositoryId) || !ID.test(entry.publicationId) || !OID.test(entry.candidateOid) || !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(entry.localIntegrationRef) || !/^[A-Za-z0-9._-]+$/u.test(entry.remoteName) || !URL.canParse(entry.expectedPushUrl) || !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(entry.remoteRef) || (entry.expectedRemoteOid !== null && !OID.test(entry.expectedRemoteOid)) || Buffer.byteLength(entry.title, "utf8") > 512 || Buffer.byteLength(entry.body, "utf8") > 16 * 1024) throw new MultiRepoPublicationError("INVALID_PLAN", `publication entry ${entry.repositoryId} is invalid`);
  return Object.freeze({ ...plan, entries: Object.freeze(plan.entries.map((entry) => Object.freeze({ ...entry }))) });
}

export function createMultiRepoPublicationEvent(plan: MultiRepoPublicationPlanV1): MultiRepoPublicationEventV1 {
  const value = validatePlan(plan); return Object.freeze({ schemaVersion: 1, eventId: id(value.transactionId, 0, "create"), transactionId: value.transactionId, expectedVersion: 0, type: "publication.created", plan: value });
}

function replace(entries: readonly MultiRepoPublicationEntryV1[], repositoryId: string, update: (entry: MultiRepoPublicationEntryV1) => MultiRepoPublicationEntryV1): readonly MultiRepoPublicationEntryV1[] {
  let seen = false; const result = entries.map((entry) => entry.plan.repositoryId === repositoryId ? (seen = true, update(entry)) : entry); if (!seen) throw new MultiRepoPublicationError("INVALID_TRANSITION", "publication event references unknown repository"); return Object.freeze(result);
}

export function applyMultiRepoPublicationEvent(current: MultiRepoPublicationProjectionV1 | undefined, event: MultiRepoPublicationEventV1): MultiRepoPublicationProjectionV1 {
  if (current === undefined) {
    if (event.type !== "publication.created" || event.expectedVersion !== 0) throw new MultiRepoPublicationError("INVALID_TRANSITION", "first publication event must create the plan");
    return Object.freeze({ schemaVersion: 1, plan: event.plan, version: 1, state: "publishing", entries: Object.freeze(event.plan.entries.map((plan) => Object.freeze({ plan }))), eventIds: Object.freeze({ [event.eventId]: hash(event) }) });
  }
  const previous = current.eventIds[event.eventId]; if (previous !== undefined) { if (previous !== hash(event)) throw new MultiRepoPublicationError("EVENT_ID_CONFLICT", "publication event ID diverged"); return current; }
  if (event.transactionId !== current.plan.transactionId || event.expectedVersion !== current.version) throw new MultiRepoPublicationError("STALE_VERSION", "publication version differs");
  if (["published", "recovery_required"].includes(current.state)) throw new MultiRepoPublicationError("INVALID_TRANSITION", "publication is terminal");
  let entries = current.entries; let state = current.state; let recoveryReason = current.recoveryReason;
  switch (event.type) {
    case "publication.created": throw new MultiRepoPublicationError("INVALID_TRANSITION", "publication already exists");
    case "publication.branch_recorded": entries = replace(entries, event.repositoryId, (entry) => event.remoteOid === entry.plan.candidateOid ? Object.freeze({ ...entry, branch: Object.freeze({ remoteOid: event.remoteOid, completedBy: event.completedBy }), lastFailure: undefined }) : (() => { throw new MultiRepoPublicationError("INVALID_TRANSITION", "published branch differs from candidate"); })()); break;
    case "publication.pr_recorded": entries = replace(entries, event.repositoryId, (entry) => entry.branch === undefined ? (() => { throw new MultiRepoPublicationError("INVALID_TRANSITION", "PR requires a published branch"); })() : Object.freeze({ ...entry, pullRequest: Object.freeze({ artifactId: event.artifactId, url: event.url, completedBy: event.completedBy }), lastFailure: undefined })); break;
    case "publication.crosslink_recorded": entries = replace(entries, event.repositoryId, (entry) => entry.pullRequest === undefined ? (() => { throw new MultiRepoPublicationError("INVALID_TRANSITION", "cross-link requires a PR"); })() : Object.freeze({ ...entry, crossLink: Object.freeze({ digest: event.digest, completedBy: event.completedBy }), lastFailure: undefined })); break;
    case "publication.retryable_failure": entries = replace(entries, event.repositoryId, (entry) => Object.freeze({ ...entry, lastFailure: Object.freeze({ code: event.code, retryable: true }) })); state = "partial"; break;
    case "publication.recovery_required": entries = replace(entries, event.repositoryId, (entry) => Object.freeze({ ...entry, lastFailure: Object.freeze({ code: event.code, retryable: false }) })); state = "recovery_required"; recoveryReason = `${event.repositoryId}:${event.operation}:${event.code}`; break;
    case "publication.completed": if (entries.some((entry) => entry.branch === undefined || entry.pullRequest === undefined || entry.crossLink === undefined)) throw new MultiRepoPublicationError("INVALID_TRANSITION", "publication vector is incomplete"); state = "published"; break;
  }
  return Object.freeze({ ...current, version: current.version + 1, state, entries, ...(recoveryReason === undefined ? {} : { recoveryReason }), eventIds: Object.freeze({ ...current.eventIds, [event.eventId]: hash(event) }) });
}

function eventBase(projection: MultiRepoPublicationProjectionV1, action: string): BaseEvent { return Object.freeze({ schemaVersion: 1, eventId: id(projection.plan.transactionId, projection.version, action), transactionId: projection.plan.transactionId, expectedVersion: projection.version }); }
function effectEvent(projection: MultiRepoPublicationProjectionV1, repositoryId: string, operation: "branch" | "pr" | "crosslink", result: PublicationEffectResult<unknown>): MultiRepoPublicationEventV1 | undefined {
  if (result.state === "retry") return Object.freeze({ ...eventBase(projection, `${operation}:retry:${repositoryId}`), type: "publication.retryable_failure", repositoryId, operation, code: result.code });
  if (result.state === "recovery_required") return Object.freeze({ ...eventBase(projection, `${operation}:recovery:${repositoryId}`), type: "publication.recovery_required", repositoryId, operation, code: result.code });
  return undefined;
}

/** Perform one idempotent remote step; callers durably CAS-append the returned event before retry. */
export async function reconcileMultiRepoPublicationOnce(projection: MultiRepoPublicationProjectionV1, adapter: MultiRepoPublicationAdapter): Promise<MultiRepoPublicationEventV1 | undefined> {
  if (["published", "recovery_required"].includes(projection.state)) return undefined;
  const branch = projection.entries.find((entry) => entry.branch === undefined);
  if (branch !== undefined) {
    const result = await adapter.publishBranch(branch.plan); const failure = effectEvent(projection, branch.plan.repositoryId, "branch", result); if (failure) return failure;
    if (result.state !== "completed" || !("remoteOid" in result.value)) throw new MultiRepoPublicationError("INVALID_TRANSITION", "branch adapter result is invalid");
    const completedBy = result.completedBy === "existing" ? "existing" : result.completedBy === "reconciled" ? "reconciled" : "push";
    return Object.freeze({ ...eventBase(projection, `branch:${branch.plan.repositoryId}`), type: "publication.branch_recorded", repositoryId: branch.plan.repositoryId, remoteOid: result.value.remoteOid, completedBy });
  }
  const pullRequest = projection.entries.find((entry) => entry.pullRequest === undefined);
  if (pullRequest !== undefined) {
    const result = await adapter.ensurePullRequest(pullRequest.plan); const failure = effectEvent(projection, pullRequest.plan.repositoryId, "pr", result); if (failure) return failure;
    if (result.state !== "completed" || !("artifactId" in result.value) || !("url" in result.value)) throw new MultiRepoPublicationError("INVALID_TRANSITION", "PR adapter result is invalid");
    const completedBy = result.completedBy === "existing" ? "existing" : result.completedBy === "reconciled" ? "reconciled" : "create";
    return Object.freeze({ ...eventBase(projection, `pr:${pullRequest.plan.repositoryId}`), type: "publication.pr_recorded", repositoryId: pullRequest.plan.repositoryId, artifactId: result.value.artifactId, url: result.value.url, completedBy });
  }
  const artifacts = Object.freeze(projection.entries.map((entry) => Object.freeze({ repositoryId: entry.plan.repositoryId, artifactId: entry.pullRequest!.artifactId, url: entry.pullRequest!.url })));
  const crossLink = projection.entries.find((entry) => entry.crossLink === undefined);
  if (crossLink !== undefined) {
    const result = await adapter.ensureCrossLinks({ entry: crossLink.plan, artifacts }); const failure = effectEvent(projection, crossLink.plan.repositoryId, "crosslink", result); if (failure) return failure;
    if (result.state !== "completed" || !("digest" in result.value) || !SHA.test(result.value.digest)) throw new MultiRepoPublicationError("INVALID_TRANSITION", "cross-link adapter result is invalid");
    const completedBy = result.completedBy === "existing" ? "existing" : result.completedBy === "reconciled" ? "reconciled" : "update";
    return Object.freeze({ ...eventBase(projection, `crosslink:${crossLink.plan.repositoryId}`), type: "publication.crosslink_recorded", repositoryId: crossLink.plan.repositoryId, digest: result.value.digest, completedBy });
  }
  return Object.freeze({ ...eventBase(projection, "complete"), type: "publication.completed" });
}

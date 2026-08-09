import { createHash } from "node:crypto";
import { z } from "zod";
import {
  applyRepositoryCandidate,
  compensateRepositoryCandidate,
  prepareRepositoryCandidate,
  type MultiRepoGitRunner,
  type RepositoryCandidateV1,
  type RepositoryCasResult,
  type RepositoryCompensationResult
} from "./git-transaction.js";
import { RepositoryIdentityV1Schema, type RepositoryIdentityV1 } from "./domain.js";
import {
  executeCombinedVerification,
  materializeCombinedVerificationPlan,
  type CandidateVerificationObserver,
  type CombinedVerificationExecutor,
  type CombinedVerificationOutcome
} from "./verification.js";
import { createCombinedVerificationReceipt, type CombinedVerificationReceiptV1 } from "./receipt.js";

export type MultiRepoIntegrationState = "planning" | "preparing" | "prepared" | "verifying" | "verified" | "applying" | "applied" | "compensating" | "compensated" | "recovery_required";

export type MultiRepoIntegrationEntryPlanV1 = Readonly<{
  repository: RepositoryIdentityV1;
  targetRef: string;
  expectedOid: string;
  childOid: string;
  canonicalWorkspacePath: string;
  message: string;
}>;

export type MultiRepoIntegrationPlanV1 = Readonly<{
  schemaVersion: 1;
  transactionId: string;
  repositorySetId: string;
  entries: readonly MultiRepoIntegrationEntryPlanV1[];
  verifyCommands: readonly string[];
  verifyEnvironment: Readonly<Record<string, string>>;
}>;

export type MultiRepoIntegrationEntryProjectionV1 = Readonly<{
  plan: MultiRepoIntegrationEntryPlanV1;
  candidate?: RepositoryCandidateV1;
  applyResult?: RepositoryCasResult;
  compensationResult?: RepositoryCompensationResult;
}>;

export type MultiRepoIntegrationProjectionV1 = Readonly<{
  schemaVersion: 1;
  transactionId: string;
  repositorySetId: string;
  version: number;
  state: MultiRepoIntegrationState;
  plan: MultiRepoIntegrationPlanV1;
  entries: readonly MultiRepoIntegrationEntryProjectionV1[];
  verification?: CombinedVerificationReceiptV1;
  recoveryReason?: string;
  eventIds: Readonly<Record<string, string>>;
}>;

type IntegrationEventBase = Readonly<{ schemaVersion: 1; eventId: string; transactionId: string; expectedVersion: number }>;
export type MultiRepoIntegrationEventV1 =
  | (IntegrationEventBase & Readonly<{ type: "integration.created"; plan: MultiRepoIntegrationPlanV1 }>)
  | (IntegrationEventBase & Readonly<{ type: "integration.candidate_prepared"; repositoryId: string; candidate: RepositoryCandidateV1 }>)
  | (IntegrationEventBase & Readonly<{ type: "integration.prepared" }>)
  | (IntegrationEventBase & Readonly<{ type: "integration.verification_started" }>)
  | (IntegrationEventBase & Readonly<{ type: "integration.verified"; receipt: CombinedVerificationReceiptV1 }>)
  | (IntegrationEventBase & Readonly<{ type: "integration.applying_started" }>)
  | (IntegrationEventBase & Readonly<{ type: "integration.entry_applied"; repositoryId: string; result: Extract<RepositoryCasResult, { state: "applied" | "already_applied" }> }>)
  | (IntegrationEventBase & Readonly<{ type: "integration.compensation_started"; reasonCode: string }>)
  | (IntegrationEventBase & Readonly<{ type: "integration.entry_compensated"; repositoryId: string; result: Extract<RepositoryCompensationResult, { state: "compensated" | "already_compensated" }> }>)
  | (IntegrationEventBase & Readonly<{ type: "integration.applied" }>)
  | (IntegrationEventBase & Readonly<{ type: "integration.compensated" }>)
  | (IntegrationEventBase & Readonly<{ type: "integration.recovery_required"; reasonCode: string; repositoryId?: string; observedOid?: string | null }>);

const canonicalId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const boundedText = z.string().max(16 * 1024);
const environment = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u), z.string().max(16 * 1024));

const integrationEntryPlanSchema = z.strictObject({
  repository: RepositoryIdentityV1Schema,
  targetRef: z.string().min(1).max(512),
  expectedOid: oid,
  childOid: oid,
  canonicalWorkspacePath: z.string().min(1).max(4_096),
  message: z.string().min(1).max(8 * 1024)
});

const integrationPlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  transactionId: canonicalId,
  repositorySetId: sha,
  entries: z.array(integrationEntryPlanSchema).min(1).max(32),
  verifyCommands: z.array(z.string().min(1).max(4_096)).min(1).max(64),
  verifyEnvironment: environment
});

const candidateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  repositoryId: canonicalId,
  targetRef: z.string().min(1).max(512),
  expectedOid: oid,
  childOid: oid,
  candidateOid: oid,
  treeOid: oid,
  parents: z.tuple([oid, oid])
});

const appliedResultSchema = z.strictObject({
  state: z.enum(["applied", "already_applied"]),
  observedOid: oid
});

const compensationResultSchema = z.strictObject({
  state: z.enum(["compensated", "already_compensated"]),
  observedOid: oid
});

const verificationReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  transactionId: canonicalId,
  repositorySetId: sha,
  manifestDigest: sha,
  verifiedAt: z.string().datetime({ offset: true }),
  resultDigests: z.array(sha).max(64),
  receiptDigest: sha
});

const integrationEventBaseSchema = {
  schemaVersion: z.literal(1),
  eventId: canonicalId,
  transactionId: canonicalId,
  expectedVersion: version
};

/** Closed wire schema used by the run ControlStore; semantic transitions remain reducer-owned. */
export const MultiRepoIntegrationEventV1Schema = z.discriminatedUnion("type", [
  z.strictObject({ ...integrationEventBaseSchema, type: z.literal("integration.created"), plan: integrationPlanSchema }),
  z.strictObject({ ...integrationEventBaseSchema, type: z.literal("integration.candidate_prepared"), repositoryId: canonicalId, candidate: candidateSchema }),
  z.strictObject({ ...integrationEventBaseSchema, type: z.literal("integration.prepared") }),
  z.strictObject({ ...integrationEventBaseSchema, type: z.literal("integration.verification_started") }),
  z.strictObject({ ...integrationEventBaseSchema, type: z.literal("integration.verified"), receipt: verificationReceiptSchema }),
  z.strictObject({ ...integrationEventBaseSchema, type: z.literal("integration.applying_started") }),
  z.strictObject({ ...integrationEventBaseSchema, type: z.literal("integration.entry_applied"), repositoryId: canonicalId, result: appliedResultSchema }),
  z.strictObject({ ...integrationEventBaseSchema, type: z.literal("integration.compensation_started"), reasonCode: boundedText }),
  z.strictObject({ ...integrationEventBaseSchema, type: z.literal("integration.entry_compensated"), repositoryId: canonicalId, result: compensationResultSchema }),
  z.strictObject({ ...integrationEventBaseSchema, type: z.literal("integration.applied") }),
  z.strictObject({ ...integrationEventBaseSchema, type: z.literal("integration.compensated") }),
  z.strictObject({
    ...integrationEventBaseSchema,
    type: z.literal("integration.recovery_required"),
    reasonCode: boundedText,
    repositoryId: canonicalId.optional(),
    observedOid: oid.nullable().optional()
  })
]);

export function parseMultiRepoIntegrationEvent(value: unknown): MultiRepoIntegrationEventV1 {
  return MultiRepoIntegrationEventV1Schema.parse(value) as MultiRepoIntegrationEventV1;
}

export type MultiRepoIntegrationErrorCode = "INVALID_PLAN" | "STALE_VERSION" | "EVENT_ID_CONFLICT" | "INVALID_TRANSITION" | "AUTHORITY_MISSING";
export class MultiRepoIntegrationError extends Error {
  constructor(readonly code: MultiRepoIntegrationErrorCode, message: string) { super(`${code}: ${message}`); this.name = "MultiRepoIntegrationError"; }
}

export interface MultiRepoIntegrationAuthority {
  /** Must prove all repository integration leases are held in this exact sorted order. */
  assertHeld(sortedRepositoryIds: readonly string[]): void;
}

export type MultiRepoIntegrationDependencies = Readonly<{
  authority: MultiRepoIntegrationAuthority;
  verificationObserver: CandidateVerificationObserver;
  verificationExecutor: CombinedVerificationExecutor;
  verifiedAt(): string;
  gitRunner?: MultiRepoGitRunner;
}>;

function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function eventId(transactionId: string, version: number, action: string): string { return `mi-${createHash("sha256").update(transactionId).update("\0").update(String(version)).update("\0").update(action).digest("hex").slice(0, 48)}`; }
function base(projection: MultiRepoIntegrationProjectionV1, action: string): IntegrationEventBase { return Object.freeze({ schemaVersion: 1, eventId: eventId(projection.transactionId, projection.version, action), transactionId: projection.transactionId, expectedVersion: projection.version }); }

function validatePlan(input: MultiRepoIntegrationPlanV1): MultiRepoIntegrationPlanV1 {
  if (input.schemaVersion !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input.transactionId) || !/^[a-f0-9]{64}$/u.test(input.repositorySetId) || input.entries.length < 1 || input.entries.length > 32) throw new MultiRepoIntegrationError("INVALID_PLAN", "transaction identity or vector shape is invalid");
  const sorted = [...input.entries].sort((left, right) => left.repository.repositoryId.localeCompare(right.repository.repositoryId));
  if (sorted.some((entry, index) => entry !== input.entries[index]) || new Set(sorted.map((entry) => entry.repository.repositoryId)).size !== sorted.length) throw new MultiRepoIntegrationError("INVALID_PLAN", "transaction entries must be unique and sorted by repository ID");
  materializeCombinedVerificationPlan({ transactionId: input.transactionId, repositorySetId: input.repositorySetId, entries: input.entries.map((entry) => ({ repositoryId: entry.repository.repositoryId, canonicalWorkspacePath: entry.canonicalWorkspacePath, targetRef: entry.targetRef, expectedOid: entry.expectedOid, childOid: entry.childOid, candidateOid: entry.expectedOid, treeOid: entry.expectedOid })), commands: input.verifyCommands, environment: input.verifyEnvironment });
  return Object.freeze({ ...input, entries: Object.freeze(input.entries.map((entry) => Object.freeze({ ...entry }))), verifyCommands: Object.freeze([...input.verifyCommands]), verifyEnvironment: Object.freeze({ ...input.verifyEnvironment }) });
}

export function createMultiRepoIntegrationEvent(plan: MultiRepoIntegrationPlanV1): MultiRepoIntegrationEventV1 {
  const validated = validatePlan(plan);
  return Object.freeze({ schemaVersion: 1, eventId: eventId(plan.transactionId, 0, "create"), transactionId: plan.transactionId, expectedVersion: 0, type: "integration.created", plan: validated });
}

function eventDigest(event: MultiRepoIntegrationEventV1): string { return hash(event); }
function replaceEntry(entries: readonly MultiRepoIntegrationEntryProjectionV1[], repositoryId: string, update: (entry: MultiRepoIntegrationEntryProjectionV1) => MultiRepoIntegrationEntryProjectionV1): readonly MultiRepoIntegrationEntryProjectionV1[] {
  let found = false; const next = entries.map((entry) => entry.plan.repository.repositoryId === repositoryId ? (found = true, update(entry)) : entry);
  if (!found) throw new MultiRepoIntegrationError("INVALID_TRANSITION", `unknown repository entry ${repositoryId}`);
  return Object.freeze(next);
}

export function applyMultiRepoIntegrationEvent(current: MultiRepoIntegrationProjectionV1 | undefined, event: MultiRepoIntegrationEventV1): MultiRepoIntegrationProjectionV1 {
  if (current === undefined) {
    if (event.type !== "integration.created" || event.expectedVersion !== 0) throw new MultiRepoIntegrationError("INVALID_TRANSITION", "first integration event must create version zero");
    return Object.freeze({ schemaVersion: 1, transactionId: event.transactionId, repositorySetId: event.plan.repositorySetId, version: 1, state: "preparing", plan: event.plan, entries: Object.freeze(event.plan.entries.map((plan) => Object.freeze({ plan }))), eventIds: Object.freeze({ [event.eventId]: eventDigest(event) }) });
  }
  const prior = current.eventIds[event.eventId];
  if (prior !== undefined) {
    if (prior !== eventDigest(event)) throw new MultiRepoIntegrationError("EVENT_ID_CONFLICT", "integration event ID has divergent content");
    return current;
  }
  if (event.transactionId !== current.transactionId || event.expectedVersion !== current.version) throw new MultiRepoIntegrationError("STALE_VERSION", "integration identity or expected version differs");
  let state = current.state; let entries = current.entries; let verification = current.verification; let recoveryReason = current.recoveryReason;
  switch (event.type) {
    case "integration.created": throw new MultiRepoIntegrationError("INVALID_TRANSITION", "integration is already created");
    case "integration.candidate_prepared":
      if (state !== "preparing") throw new MultiRepoIntegrationError("INVALID_TRANSITION", "candidate can only be recorded while preparing");
      entries = replaceEntry(entries, event.repositoryId, (entry) => {
        if (entry.candidate !== undefined && hash(entry.candidate) !== hash(event.candidate)) throw new MultiRepoIntegrationError("INVALID_TRANSITION", "repository already has a divergent candidate");
        if (event.candidate.repositoryId !== entry.plan.repository.repositoryId || event.candidate.targetRef !== entry.plan.targetRef || event.candidate.expectedOid !== entry.plan.expectedOid || event.candidate.childOid !== entry.plan.childOid) throw new MultiRepoIntegrationError("INVALID_TRANSITION", "candidate differs from immutable entry plan");
        return Object.freeze({ ...entry, candidate: event.candidate });
      }); break;
    case "integration.prepared":
      if (state !== "preparing" || entries.some((entry) => entry.candidate === undefined)) throw new MultiRepoIntegrationError("INVALID_TRANSITION", "full vector is not prepared");
      state = "prepared"; break;
    case "integration.verification_started":
      if (state !== "prepared") throw new MultiRepoIntegrationError("INVALID_TRANSITION", "verification can only start from prepared"); state = "verifying"; break;
    case "integration.verified":
      if (state !== "verifying" || event.receipt.transactionId !== current.transactionId || event.receipt.repositorySetId !== current.repositorySetId) throw new MultiRepoIntegrationError("INVALID_TRANSITION", "verified receipt identity differs");
      state = "verified"; verification = event.receipt; break;
    case "integration.applying_started":
      if (state !== "verified" || verification === undefined) throw new MultiRepoIntegrationError("INVALID_TRANSITION", "apply requires durable verification"); state = "applying"; break;
    case "integration.entry_applied":
      if (state !== "applying") throw new MultiRepoIntegrationError("INVALID_TRANSITION", "entry apply result is out of phase");
      entries = replaceEntry(entries, event.repositoryId, (entry) => {
        if (entry.candidate === undefined || event.result.observedOid !== entry.candidate.candidateOid) throw new MultiRepoIntegrationError("INVALID_TRANSITION", "apply receipt differs from candidate");
        return Object.freeze({ ...entry, applyResult: event.result });
      }); break;
    case "integration.compensation_started":
      if (state !== "applying" || !entries.some((entry) => entry.applyResult?.state === "applied" || entry.applyResult?.state === "already_applied")) throw new MultiRepoIntegrationError("INVALID_TRANSITION", "compensation requires a partially applied vector");
      state = "compensating"; recoveryReason = event.reasonCode; break;
    case "integration.entry_compensated":
      if (state !== "compensating") throw new MultiRepoIntegrationError("INVALID_TRANSITION", "compensation result is out of phase");
      entries = replaceEntry(entries, event.repositoryId, (entry) => Object.freeze({ ...entry, compensationResult: event.result })); break;
    case "integration.applied":
      if (state !== "applying" || entries.some((entry) => entry.applyResult === undefined)) throw new MultiRepoIntegrationError("INVALID_TRANSITION", "full vector is not applied"); state = "applied"; break;
    case "integration.compensated":
      if (state !== "compensating" || entries.some((entry) => entry.applyResult !== undefined && entry.compensationResult === undefined)) throw new MultiRepoIntegrationError("INVALID_TRANSITION", "partial vector is not fully compensated"); state = "compensated"; break;
    case "integration.recovery_required":
      if (["applied", "compensated"].includes(state)) throw new MultiRepoIntegrationError("INVALID_TRANSITION", "terminal integration cannot become uncertain"); state = "recovery_required"; recoveryReason = event.reasonCode; break;
  }
  return Object.freeze({ ...current, version: current.version + 1, state, entries, ...(verification === undefined ? {} : { verification }), ...(recoveryReason === undefined ? {} : { recoveryReason }), eventIds: Object.freeze({ ...current.eventIds, [event.eventId]: eventDigest(event) }) });
}

export function reduceMultiRepoIntegrationEvents(events: readonly MultiRepoIntegrationEventV1[]): MultiRepoIntegrationProjectionV1 {
  let projection: MultiRepoIntegrationProjectionV1 | undefined;
  for (const event of events) projection = applyMultiRepoIntegrationEvent(projection, event);
  if (projection === undefined) throw new MultiRepoIntegrationError("INVALID_TRANSITION", "integration history is empty");
  return projection;
}

function requireAuthority(projection: MultiRepoIntegrationProjectionV1, authority: MultiRepoIntegrationAuthority): void {
  const repositories = projection.entries.map((entry) => entry.plan.repository.repositoryId);
  try { authority.assertHeld(repositories); } catch (error) { throw new MultiRepoIntegrationError("AUTHORITY_MISSING", error instanceof Error ? error.message : "repository integration authority is absent"); }
}

function recoveryEvent(projection: MultiRepoIntegrationProjectionV1, reasonCode: string, repositoryId?: string, observedOid?: string | null): MultiRepoIntegrationEventV1 {
  return Object.freeze({ ...base(projection, `recovery:${reasonCode}:${repositoryId ?? "vector"}`), type: "integration.recovery_required", reasonCode, ...(repositoryId === undefined ? {} : { repositoryId }), ...(observedOid === undefined ? {} : { observedOid }) });
}

/** Execute at most one idempotent external action and return exactly one event for durable CAS append. */
export async function reconcileMultiRepoIntegrationOnce(projection: MultiRepoIntegrationProjectionV1, dependencies: MultiRepoIntegrationDependencies): Promise<MultiRepoIntegrationEventV1 | undefined> {
  if (["applied", "compensated", "recovery_required"].includes(projection.state)) return undefined;
  requireAuthority(projection, dependencies.authority);
  if (projection.state === "preparing") {
    const entry = projection.entries.find((item) => item.candidate === undefined);
    if (entry === undefined) return Object.freeze({ ...base(projection, "prepared"), type: "integration.prepared" });
    try {
      const candidate = prepareRepositoryCandidate({ repository: entry.plan.repository, targetRef: entry.plan.targetRef, expectedOid: entry.plan.expectedOid, childOid: entry.plan.childOid, message: entry.plan.message, ...(dependencies.gitRunner === undefined ? {} : { runner: dependencies.gitRunner }) });
      return Object.freeze({ ...base(projection, `candidate:${entry.plan.repository.repositoryId}`), type: "integration.candidate_prepared", repositoryId: entry.plan.repository.repositoryId, candidate });
    } catch (error) { return recoveryEvent(projection, error instanceof Error ? error.message.slice(0, 128) : "PREPARATION_FAILED", entry.plan.repository.repositoryId); }
  }
  if (projection.state === "prepared") return Object.freeze({ ...base(projection, "verification-start"), type: "integration.verification_started" });
  if (projection.state === "verifying") {
    const candidates = projection.entries.map((entry) => {
      if (entry.candidate === undefined) throw new MultiRepoIntegrationError("INVALID_TRANSITION", "verifying vector lacks a candidate");
      return { repositoryId: entry.plan.repository.repositoryId, canonicalWorkspacePath: entry.plan.canonicalWorkspacePath, targetRef: entry.candidate.targetRef, expectedOid: entry.candidate.expectedOid, childOid: entry.candidate.childOid, candidateOid: entry.candidate.candidateOid, treeOid: entry.candidate.treeOid };
    });
    const plan = materializeCombinedVerificationPlan({ transactionId: projection.transactionId, repositorySetId: projection.repositorySetId, entries: candidates, commands: projection.plan.verifyCommands, environment: projection.plan.verifyEnvironment });
    let outcome: CombinedVerificationOutcome;
    try { outcome = await executeCombinedVerification({ plan, environment: projection.plan.verifyEnvironment, observer: dependencies.verificationObserver, executor: dependencies.verificationExecutor }); }
    catch (error) { return recoveryEvent(projection, error instanceof Error ? error.message.slice(0, 128) : "VERIFICATION_FAILED"); }
    if (outcome.state !== "verified") return recoveryEvent(projection, outcome.reasonCode ?? "VERIFICATION_FAILED");
    const receipt = createCombinedVerificationReceipt(outcome, dependencies.verifiedAt());
    return Object.freeze({ ...base(projection, "verified"), type: "integration.verified", receipt });
  }
  if (projection.state === "verified") return Object.freeze({ ...base(projection, "applying-start"), type: "integration.applying_started" });
  if (projection.state === "applying") {
    const entry = projection.entries.find((item) => item.applyResult === undefined);
    if (entry === undefined) return Object.freeze({ ...base(projection, "applied"), type: "integration.applied" });
    const candidate = entry.candidate!;
    const result = applyRepositoryCandidate(entry.plan.repository, candidate, dependencies.gitRunner);
    if (result.state === "applied" || result.state === "already_applied") return Object.freeze({ ...base(projection, `applied:${entry.plan.repository.repositoryId}`), type: "integration.entry_applied", repositoryId: entry.plan.repository.repositoryId, result });
    const priorApplied = projection.entries.some((item) => item.applyResult !== undefined);
    if (priorApplied && result.state === "refused") return Object.freeze({ ...base(projection, `compensate:${entry.plan.repository.repositoryId}`), type: "integration.compensation_started", reasonCode: result.reasonCode });
    if ("reasonCode" in result) return recoveryEvent(projection, result.reasonCode, entry.plan.repository.repositoryId, result.observedOid);
    throw new MultiRepoIntegrationError("INVALID_TRANSITION", "unrecognized repository apply result");
  }
  if (projection.state === "compensating") {
    const entry = [...projection.entries].reverse().find((item) => item.applyResult !== undefined && item.compensationResult === undefined);
    if (entry === undefined) return Object.freeze({ ...base(projection, "compensated"), type: "integration.compensated" });
    const result = compensateRepositoryCandidate(entry.plan.repository, entry.candidate!, dependencies.gitRunner);
    if (result.state === "compensated" || result.state === "already_compensated") return Object.freeze({ ...base(projection, `compensated:${entry.plan.repository.repositoryId}`), type: "integration.entry_compensated", repositoryId: entry.plan.repository.repositoryId, result });
    if ("reasonCode" in result) return recoveryEvent(projection, result.reasonCode, entry.plan.repository.repositoryId, result.observedOid);
    throw new MultiRepoIntegrationError("INVALID_TRANSITION", "unrecognized repository compensation result");
  }
  return undefined;
}

import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { runGit } from "../git.js";
import { isValidId } from "../ids.js";
import { validateProvisionSpecs, type ProvisionSpec } from "../provision.js";
import {
  assertRepositoryScope,
  materializeRepositoryRegistry,
  RepositoryIdentityV1Schema,
  type RepositoryDefinitionV1,
  type RepositoryIdentityResolver,
  type RepositoryIdentityV1,
  type RepositoryRegistryV1
} from "./domain.js";
import {
  materializeMultiRepositoryDag,
  MultiRepositoryTaskV1Schema,
  type MaterializedMultiRepositoryTaskV1,
  type MultiRepositoryDagV1,
  type MultiRepositoryTaskV1
} from "./dag.js";
import { MultiRepoSchedulerEventV1Schema, type MultiRepoSchedulerEventV1 } from "./events.js";
import {
  applyMultiRepoSchedulerEvent,
  decideSchedulerAdmission,
  emptyMultiRepoSchedulerProjection,
  type MultiRepoSchedulerProjectionV1,
  type SchedulerConcurrencyLimits,
  type SchedulerLeaseV1
} from "./scheduler.js";
import {
  applyMultiRepoIntegrationEvent,
  createMultiRepoIntegrationEvent,
  reconcileMultiRepoIntegrationOnce,
  MultiRepoIntegrationEventV1Schema,
  type MultiRepoIntegrationAuthority,
  type MultiRepoIntegrationDependencies,
  type MultiRepoIntegrationEventV1,
  type MultiRepoIntegrationPlanV1,
  type MultiRepoIntegrationProjectionV1
} from "./integration.js";
import {
  applyMultiRepoPublicationEvent,
  createMultiRepoPublicationEvent,
  reconcileMultiRepoPublicationOnce,
  MultiRepoPublicationEventV1Schema,
  type MultiRepoPublicationAdapter,
  type MultiRepoPublicationEventV1,
  type MultiRepoPublicationPlanV1,
  type MultiRepoPublicationProjectionV1
} from "./publication.js";
import {
  assertReadyWorktreeGroupExact,
  prepareWorktreeGroup,
  readWorktreeGroupReceipt,
  reclaimWorktreeGroup,
  worktreeGroupStates,
  type ReadyWorktreeGroupMember,
  type WorktreeGroupAuthority,
  type WorktreeGroupOptions,
  type WorktreeGroupReceipt,
  type WorktreeGroupResult
} from "./worktrees.js";

export const MULTIREPO_ORCHESTRATION_SCHEMA_VERSION = 1 as const;
export const MULTIREPO_ORCHESTRATION_LIMITS = Object.freeze({
  maximumTransitionsPerTask: 512,
  maximumWorkerSummaryBytes: 8 * 1024,
  maximumJournalFacts: 200_000,
  maximumRunEpochBytes: 256
});

const SHA256 = /^[a-f0-9]{64}$/u;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export type MultiRepositoryOrchestrationErrorCode =
  | "INVALID_PLAN"
  | "CANONICAL_IDENTITY_MISMATCH"
  | "CANONICAL_HISTORY_CORRUPT"
  | "CANONICAL_APPEND_FAILED"
  | "CAPABILITY_REFUSED"
  | "ADMISSION_REFUSED"
  | "WORKTREE_RECOVERY_REQUIRED"
  | "WORKER_RECOVERY_REQUIRED"
  | "INTEGRATION_RECOVERY_REQUIRED"
  | "PUBLICATION_RECOVERY_REQUIRED";

export class MultiRepositoryOrchestrationError extends Error {
  constructor(
    readonly code: MultiRepositoryOrchestrationErrorCode,
    message: string,
    readonly authorityMustRemainHeld = false,
    options?: ErrorOptions
  ) {
    super(`${code}: ${message}`, options);
    this.name = "MultiRepositoryOrchestrationError";
  }
}

/** A benign global-head race. Journal adapters must never use this for IO/integrity uncertainty. */
export class MultiRepositoryCanonicalJournalConflictError extends Error {
  readonly code = "STALE_CONTROL_HEAD" as const;
  constructor(message = "canonical ControlStore head advanced") {
    super(`STALE_CONTROL_HEAD: ${message}`);
    this.name = "MultiRepositoryCanonicalJournalConflictError";
  }
}

export type MultiRepositoryTaskEntryPlanV1 = Readonly<{
  repositoryId: string;
  branch: string;
  targetRef: string;
  provision?: readonly ProvisionSpec[];
}>;

export type MultiRepositoryPublicationEntryConfigV1 = Readonly<{
  repositoryId: string;
  publicationId: string;
  remoteName: string;
  expectedPushUrl: string;
  remoteRef: string;
  expectedRemoteOid: string | null;
  baseRef: string;
  title: string;
  body: string;
}>;

export type MultiRepositoryTaskExecutionV1 = Readonly<{
  taskId: string;
  priority: number;
  entries: readonly MultiRepositoryTaskEntryPlanV1[];
  verifyCommands: readonly string[];
  verifyEnvironment: Readonly<Record<string, string>>;
  commitMessage: string;
  publication?: Readonly<{
    policyApproved: boolean;
    entries: readonly MultiRepositoryPublicationEntryConfigV1[];
  }>;
}>;

export type MultiRepositoryCapabilityPlanV1 = Readonly<{
  roles: Readonly<Record<string, readonly string[]>>;
  providers: Readonly<Record<string, readonly string[]>>;
}>;

export type MultiRepositoryRunRequestV1 = Readonly<{
  schemaVersion: typeof MULTIREPO_ORCHESTRATION_SCHEMA_VERSION;
  runId: string;
  runEpoch: string;
  workspaceRoot: string;
  execute: boolean;
  repositoryDefinitions: readonly RepositoryDefinitionV1[];
  tasks: readonly MultiRepositoryTaskV1[];
  executions: readonly MultiRepositoryTaskExecutionV1[];
  capabilities: MultiRepositoryCapabilityPlanV1;
}>;

export type MaterializedMultiRepositoryRunPlanV1 = Readonly<{
  schemaVersion: typeof MULTIREPO_ORCHESTRATION_SCHEMA_VERSION;
  runId: string;
  runEpoch: string;
  workspaceRoot: string;
  registry: RepositoryRegistryV1;
  dag: MultiRepositoryDagV1;
  executions: readonly MultiRepositoryTaskExecutionV1[];
  capabilities: MultiRepositoryCapabilityPlanV1;
  planDigest: string;
}>;

export type MultiRepositoryWorkerMemberV1 = Readonly<{
  repositoryId: string;
  path: string;
  branch: string;
  anchorOid: string;
}>;

export type MultiRepositoryWorkerRequestV1 = Readonly<{
  schemaVersion: 1;
  runId: string;
  runEpoch: string;
  taskId: string;
  taskGeneration: number;
  attemptId: string;
  leaseToken: string;
  repositorySetId: string;
  members: readonly MultiRepositoryWorkerMemberV1[];
}>;

export type MultiRepositoryWorkerSettlementV1 = Readonly<{
  schemaVersion: 1;
  processIdentity: string;
  /** Durable P4 ledger settlement record for the exact physical provider call. */
  settlementCallId: string;
  outputDigest: string;
  summary: string;
  transportTrusted: boolean;
  scopeTrusted: boolean;
  scopeReaped: boolean;
  settlementTrusted: boolean;
}>;

export interface ContainedMultiRepositoryWorker {
  /**
   * The callback is the launch gate: the implementation must invoke it after the child has entered
   * its sole contained scope but before provider exec. A callback throw must close the gate and
   * prove the child empty; it must never be converted into a best-effort launch.
   */
  run(
    request: MultiRepositoryWorkerRequestV1,
    acknowledgeDispatch: (processIdentity: string) => void
  ): Promise<MultiRepositoryWorkerSettlementV1>;
  /** Reconcile a previously acknowledged child without launching a replacement. */
  recover?(
    request: MultiRepositoryWorkerRequestV1,
    processIdentity: string
  ): Promise<MultiRepositoryWorkerSettlementV1 | undefined>;
  /** Prove a canonical admitted-but-unacknowledged lease never crossed the provider exec gate. */
  proveUnspawned?(request: MultiRepositoryWorkerRequestV1): Promise<boolean>;
}

export interface MultiRepositoryIntegrationAuthorityHandle extends MultiRepoIntegrationAuthority {
  release(): void | Promise<void>;
}

export interface MultiRepositoryIntegrationAuthorityManager {
  /** Acquires every repository integration mutex in the supplied ascending RepositoryId order. */
  acquire(
    sortedRepositoryIds: readonly string[],
    fence: Readonly<{ runId: string; runEpoch: string; taskId: string; taskGeneration: number; leaseToken: string }>
  ): MultiRepositoryIntegrationAuthorityHandle | Promise<MultiRepositoryIntegrationAuthorityHandle>;
}

export type MultiRepositoryCanonicalPlanFactV1 = Readonly<{
  schemaVersion: 1;
  kind: "multirepo.plan_registered";
  factId: string;
  plan: MaterializedMultiRepositoryRunPlanV1;
}>;

export type MultiRepositoryCanonicalSchedulerFactV1 = Readonly<{
  schemaVersion: 1;
  kind: "multirepo.scheduler_transitioned";
  factId: string;
  event: MultiRepoSchedulerEventV1;
}>;

export type MultiRepositoryCanonicalWorktreeFactV1 = Readonly<{
  schemaVersion: 1;
  kind: "multirepo.worktree_group_recorded";
  factId: string;
  taskId: string;
  taskGeneration: number;
  leaseToken: string;
  groupRoot: string;
  groupId: string;
  repositorySetId: string;
  state: WorktreeGroupReceipt["state"];
  receiptDigest: string;
  members: readonly MultiRepositoryWorkerMemberV1[];
  issueCodes: readonly string[];
}>;

export type MultiRepositoryCanonicalWorkerFactV1 = Readonly<{
  schemaVersion: 1;
  kind: "multirepo.worker_settled";
  factId: string;
  taskId: string;
  taskGeneration: number;
  attemptId: string;
  leaseToken: string;
  settlement: MultiRepositoryWorkerSettlementV1;
}>;

export type MultiRepositoryCanonicalCommitIntentFactV1 = Readonly<{
  schemaVersion: 1;
  kind: "multirepo.worktree_commit_intended";
  factId: string;
  taskId: string;
  taskGeneration: number;
  attemptId: string;
  leaseToken: string;
  repositoryId: string;
  branchRef: string;
  expectedOid: string;
  treeOid: string;
  message: string;
}>;

export type MultiRepositoryCanonicalHeadFactV1 = Readonly<{
  schemaVersion: 1;
  kind: "multirepo.worktree_head_recorded";
  factId: string;
  taskId: string;
  taskGeneration: number;
  attemptId: string;
  leaseToken: string;
  repositoryId: string;
  branchRef: string;
  expectedOid: string;
  childOid: string;
  treeOid: string;
}>;

export type MultiRepositoryCanonicalIntegrationFactV1 = Readonly<{
  schemaVersion: 1;
  kind: "multirepo.integration_transitioned";
  factId: string;
  taskId: string;
  taskGeneration: number;
  leaseToken: string;
  event: MultiRepoIntegrationEventV1;
}>;

export type MultiRepositoryCanonicalLocalReceiptFactV1 = Readonly<{
  schemaVersion: 1;
  kind: "multirepo.local_integration_receipted";
  factId: string;
  taskId: string;
  taskGeneration: number;
  leaseToken: string;
  transactionId: string;
  repositorySetId: string;
  verificationReceiptDigest: string;
  appliedEntriesDigest: string;
  receiptDigest: string;
}>;

export type MultiRepositoryCanonicalPublicationFactV1 = Readonly<{
  schemaVersion: 1;
  kind: "multirepo.publication_transitioned";
  factId: string;
  taskId: string;
  taskGeneration: number;
  event: MultiRepoPublicationEventV1;
}>;

export type MultiRepositoryCanonicalFactV1 =
  | MultiRepositoryCanonicalPlanFactV1
  | MultiRepositoryCanonicalSchedulerFactV1
  | MultiRepositoryCanonicalWorktreeFactV1
  | MultiRepositoryCanonicalWorkerFactV1
  | MultiRepositoryCanonicalCommitIntentFactV1
  | MultiRepositoryCanonicalHeadFactV1
  | MultiRepositoryCanonicalIntegrationFactV1
  | MultiRepositoryCanonicalLocalReceiptFactV1
  | MultiRepositoryCanonicalPublicationFactV1;

const canonicalIdSchema = z.string().refine(isValidId, "invalid canonical identifier");
const canonicalDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const canonicalOidSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const canonicalVersionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const canonicalLeaseSchema = z.string().min(16).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const canonicalPathSchema = z.string().min(1).max(4_096);
const canonicalRefSchema = z.string().min(1).max(512);
const provisionSpecSchema = z.strictObject({
  path: canonicalPathSchema,
  requiredExecutables: z.array(canonicalPathSchema).max(64).optional()
});
const repositorySetSchema = z.strictObject({
  schemaVersion: z.literal(1),
  repositoryIds: z.array(canonicalIdSchema).min(1).max(32),
  repositorySetId: canonicalDigestSchema
});
const materializedTaskSchema = MultiRepositoryTaskV1Schema.extend({ repositorySet: repositorySetSchema }).strict();
const registrySchema = z.strictObject({
  schemaVersion: z.literal(1),
  repositories: z.array(RepositoryIdentityV1Schema).min(1).max(64)
});
const dagSchema = z.strictObject({
  schemaVersion: z.literal(1),
  tasks: z.array(materializedTaskSchema).min(1).max(4_096),
  order: z.array(canonicalIdSchema).min(1).max(4_096),
  layers: z.array(z.array(canonicalIdSchema).min(1).max(4_096)).min(1).max(256),
  dependents: z.record(canonicalIdSchema, z.array(canonicalIdSchema).max(4_096)),
  depthByTask: z.record(canonicalIdSchema, z.number().int().nonnegative().max(256)),
  edgeCount: z.number().int().nonnegative().max(16_384)
});
const taskEntryPlanSchema = z.strictObject({
  repositoryId: canonicalIdSchema,
  branch: canonicalRefSchema,
  targetRef: canonicalRefSchema,
  provision: z.array(provisionSpecSchema).max(128).optional()
});
const publicationEntryConfigSchema = z.strictObject({
  repositoryId: canonicalIdSchema,
  publicationId: canonicalIdSchema,
  remoteName: z.string().min(1).max(256),
  expectedPushUrl: z.string().url().max(4_096),
  remoteRef: canonicalRefSchema,
  expectedRemoteOid: canonicalOidSchema.nullable(),
  baseRef: canonicalRefSchema,
  title: z.string().max(512),
  body: z.string().max(16 * 1024)
});
const executionSchema = z.strictObject({
  taskId: canonicalIdSchema,
  priority: z.number().int().min(-1_000).max(1_000),
  entries: z.array(taskEntryPlanSchema).min(1).max(32),
  verifyCommands: z.array(z.string().min(1).max(4_096)).min(1).max(64),
  verifyEnvironment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u), z.string().max(16 * 1024)),
  commitMessage: z.string().min(1).max(8 * 1024),
  publication: z.strictObject({ policyApproved: z.literal(true), entries: z.array(publicationEntryConfigSchema).min(1).max(32) }).optional()
});
const capabilityPlanSchema = z.strictObject({
  roles: z.record(canonicalIdSchema, z.array(canonicalIdSchema).min(1).max(64)),
  providers: z.record(canonicalIdSchema, z.array(canonicalIdSchema).min(1).max(64))
});
const materializedPlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: canonicalIdSchema,
  runEpoch: z.string().min(1).max(MULTIREPO_ORCHESTRATION_LIMITS.maximumRunEpochBytes),
  workspaceRoot: canonicalPathSchema,
  registry: registrySchema,
  dag: dagSchema,
  executions: z.array(executionSchema).min(1).max(4_096),
  capabilities: capabilityPlanSchema,
  planDigest: canonicalDigestSchema
});
const workerMemberSchema = z.strictObject({
  repositoryId: canonicalIdSchema,
  path: canonicalPathSchema,
  branch: canonicalRefSchema,
  anchorOid: canonicalOidSchema
});
const settlementSchema = z.strictObject({
  schemaVersion: z.literal(1),
  processIdentity: z.string().min(1).max(512),
  settlementCallId: z.string().min(1).max(512),
  outputDigest: canonicalDigestSchema,
  summary: z.string().max(MULTIREPO_ORCHESTRATION_LIMITS.maximumWorkerSummaryBytes),
  transportTrusted: z.boolean(),
  scopeTrusted: z.boolean(),
  scopeReaped: z.boolean(),
  settlementTrusted: z.boolean()
});
const factEnvelopeSchema = { schemaVersion: z.literal(1), factId: canonicalIdSchema };

/** Closed durable P6 fact schema. Unknown nested fields are refused before ControlStore append. */
export const MultiRepositoryCanonicalFactV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({ ...factEnvelopeSchema, kind: z.literal("multirepo.plan_registered"), plan: materializedPlanSchema }),
  z.strictObject({ ...factEnvelopeSchema, kind: z.literal("multirepo.scheduler_transitioned"), event: MultiRepoSchedulerEventV1Schema }),
  z.strictObject({ ...factEnvelopeSchema, kind: z.literal("multirepo.worktree_group_recorded"), taskId: canonicalIdSchema, taskGeneration: canonicalVersionSchema, leaseToken: canonicalLeaseSchema, groupRoot: canonicalPathSchema, groupId: canonicalIdSchema, repositorySetId: canonicalDigestSchema, state: z.enum(worktreeGroupStates), receiptDigest: canonicalDigestSchema, members: z.array(workerMemberSchema).max(32), issueCodes: z.array(canonicalIdSchema).max(128) }),
  z.strictObject({ ...factEnvelopeSchema, kind: z.literal("multirepo.worker_settled"), taskId: canonicalIdSchema, taskGeneration: canonicalVersionSchema, attemptId: canonicalIdSchema, leaseToken: canonicalLeaseSchema, settlement: settlementSchema }),
  z.strictObject({ ...factEnvelopeSchema, kind: z.literal("multirepo.worktree_commit_intended"), taskId: canonicalIdSchema, taskGeneration: canonicalVersionSchema, attemptId: canonicalIdSchema, leaseToken: canonicalLeaseSchema, repositoryId: canonicalIdSchema, branchRef: canonicalRefSchema, expectedOid: canonicalOidSchema, treeOid: canonicalOidSchema, message: z.string().min(1).max(8 * 1024) }),
  z.strictObject({ ...factEnvelopeSchema, kind: z.literal("multirepo.worktree_head_recorded"), taskId: canonicalIdSchema, taskGeneration: canonicalVersionSchema, attemptId: canonicalIdSchema, leaseToken: canonicalLeaseSchema, repositoryId: canonicalIdSchema, branchRef: canonicalRefSchema, expectedOid: canonicalOidSchema, childOid: canonicalOidSchema, treeOid: canonicalOidSchema }),
  z.strictObject({ ...factEnvelopeSchema, kind: z.literal("multirepo.integration_transitioned"), taskId: canonicalIdSchema, taskGeneration: canonicalVersionSchema, leaseToken: canonicalLeaseSchema, event: MultiRepoIntegrationEventV1Schema }),
  z.strictObject({ ...factEnvelopeSchema, kind: z.literal("multirepo.local_integration_receipted"), taskId: canonicalIdSchema, taskGeneration: canonicalVersionSchema, leaseToken: canonicalLeaseSchema, transactionId: canonicalIdSchema, repositorySetId: canonicalDigestSchema, verificationReceiptDigest: canonicalDigestSchema, appliedEntriesDigest: canonicalDigestSchema, receiptDigest: canonicalDigestSchema }),
  z.strictObject({ ...factEnvelopeSchema, kind: z.literal("multirepo.publication_transitioned"), taskId: canonicalIdSchema, taskGeneration: canonicalVersionSchema, event: MultiRepoPublicationEventV1Schema })
]);

export function parseMultiRepositoryCanonicalFact(value: unknown): MultiRepositoryCanonicalFactV1 {
  return MultiRepositoryCanonicalFactV1Schema.parse(value) as MultiRepositoryCanonicalFactV1;
}

export type MultiRepositoryCanonicalJournalSnapshotV1 = Readonly<{
  schemaVersion: 1;
  runId: string;
  runEpoch: string;
  /** Exact global ControlStore head used by appendBatchIf. */
  controlHeadSeq: number;
  /** Exact P6 aggregate version; unlike controlHeadSeq it equals facts.length. */
  headVersion: number;
  facts: readonly MultiRepositoryCanonicalFactV1[];
}>;

/**
 * Product implementations must back this contract with the already-open run ControlStore. A JSON
 * file, a second SQLite handle, an in-memory queue, or a socket peer is not canonical authority.
 */
export interface MultiRepositoryCanonicalJournalV1 {
  read(): MultiRepositoryCanonicalJournalSnapshotV1;
  append(input: Readonly<{
    expectedControlHeadSeq: number;
    expectedHeadVersion: number;
    fact: MultiRepositoryCanonicalFactV1;
  }>): MultiRepositoryCanonicalJournalSnapshotV1;
}

export type MultiRepositoryTaskOutcomeV1 = Readonly<{
  taskId: string;
  taskGeneration: number;
  state: "planned" | "applied" | "published" | "publication_partial" | "recovery_required";
  transactionId?: string;
  localIntegrationReceiptDigest?: string;
  reason?: string;
}>;

export type MultiRepositoryRunOutcomeV1 = Readonly<{
  schemaVersion: 1;
  runId: string;
  runEpoch: string;
  planDigest: string;
  state: "planned" | "done" | "blocked" | "recovery_required";
  tasks: readonly MultiRepositoryTaskOutcomeV1[];
  reason?: string;
}>;

export type MultiRepositoryOrchestrationDependencies = Readonly<{
  resolveRepositoryIdentity: RepositoryIdentityResolver;
  journal: MultiRepositoryCanonicalJournalV1;
  worker: ContainedMultiRepositoryWorker;
  integrationAuthority: MultiRepositoryIntegrationAuthorityManager;
  integration: Omit<MultiRepoIntegrationDependencies, "authority">;
  publicationAdapter?: MultiRepoPublicationAdapter;
  concurrency: SchedulerConcurrencyLimits;
  ownerId: string;
  ownerIncarnation: string;
  now?: () => Date;
  randomToken?: () => string;
}>;

export type MultiRepositoryCanonicalProjectionV1 = Readonly<{
  schemaVersion: 1;
  plan?: MaterializedMultiRepositoryRunPlanV1;
  scheduler: MultiRepoSchedulerProjectionV1;
  worktreeGroups: Readonly<Record<string, MultiRepositoryCanonicalWorktreeFactV1>>;
  workers: Readonly<Record<string, MultiRepositoryCanonicalWorkerFactV1>>;
  commitIntents: Readonly<Record<string, MultiRepositoryCanonicalCommitIntentFactV1>>;
  heads: Readonly<Record<string, MultiRepositoryCanonicalHeadFactV1>>;
  integrations: Readonly<Record<string, MultiRepoIntegrationProjectionV1>>;
  localReceipts: Readonly<Record<string, MultiRepositoryCanonicalLocalReceiptFactV1>>;
  publications: Readonly<Record<string, MultiRepoPublicationProjectionV1>>;
  seenFactIds: Readonly<Record<string, string>>;
}>;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

function digest(domain: string, value: unknown): string {
  return createHash("sha256").update(domain).update("\0").update(canonical(value)).digest("hex");
}

function boundedTimestamp(value: Date): string {
  const result = value.toISOString();
  if (Number.isNaN(value.getTime())) throw new MultiRepositoryOrchestrationError("INVALID_PLAN", "clock returned an invalid timestamp");
  return result;
}

function frozenStrings(values: readonly string[]): readonly string[] {
  return Object.freeze([...values]);
}

function cloneExecution(value: MultiRepositoryTaskExecutionV1): MultiRepositoryTaskExecutionV1 {
  return Object.freeze({
    ...value,
    entries: Object.freeze(value.entries.map((entry) => Object.freeze({
      ...entry,
      ...(entry.provision === undefined ? {} : { provision: Object.freeze(entry.provision.map((spec) => Object.freeze({
        ...spec,
        ...(spec.requiredExecutables === undefined ? {} : { requiredExecutables: frozenStrings(spec.requiredExecutables) })
      }))) })
    }))),
    verifyCommands: frozenStrings(value.verifyCommands),
    verifyEnvironment: Object.freeze({ ...value.verifyEnvironment }),
    ...(value.publication === undefined ? {} : {
      publication: Object.freeze({
        policyApproved: value.publication.policyApproved,
        entries: Object.freeze(value.publication.entries.map((entry) => Object.freeze({ ...entry })))
      })
    })
  });
}

function validateExecution(
  task: MaterializedMultiRepositoryTaskV1,
  raw: MultiRepositoryTaskExecutionV1,
  registry: RepositoryRegistryV1
): MultiRepositoryTaskExecutionV1 {
  if (
    raw.taskId !== task.taskId ||
    !Number.isSafeInteger(raw.priority) ||
    raw.priority < -1_000 ||
    raw.priority > 1_000 ||
    raw.entries.length !== task.repositoryIds.length ||
    raw.verifyCommands.length < 1 ||
    raw.verifyCommands.length > 64 ||
    Buffer.byteLength(raw.commitMessage, "utf8") < 1 ||
    Buffer.byteLength(raw.commitMessage, "utf8") > 8 * 1024 ||
    raw.commitMessage.includes("\0")
  ) {
    throw new MultiRepositoryOrchestrationError("INVALID_PLAN", `execution plan for ${task.taskId} is incomplete or outside its bound`);
  }
  const entriesById = new Map(raw.entries.map((entry) => [entry.repositoryId, entry]));
  if (entriesById.size !== raw.entries.length || task.repositoryIds.some((repositoryId) => !entriesById.has(repositoryId))) {
    throw new MultiRepositoryOrchestrationError("INVALID_PLAN", `execution repository vector differs for ${task.taskId}`);
  }
  const repositories = new Map(registry.repositories.map((repository) => [repository.repositoryId, repository]));
  for (const repositoryId of task.repositoryIds) {
    const entry = entriesById.get(repositoryId)!;
    const repository = repositories.get(repositoryId)!;
    const targetBranch = entry.targetRef.startsWith("refs/heads/") ? entry.targetRef.slice("refs/heads/".length) : "";
    if (
      !validBranch(entry.branch) || !validBranch(targetBranch) || targetBranch === repository.defaultBranch ||
      repository.protectedBranches.includes(targetBranch) || entry.branch === targetBranch
    ) {
      throw new MultiRepositoryOrchestrationError("INVALID_PLAN", `task ${task.taskId} must target a distinct non-protected integration branch of ${repositoryId}`);
    }
    const provisionIssues = validateProvisionSpecs(entry.provision ?? []);
    if (provisionIssues.length > 0) {
      throw new MultiRepositoryOrchestrationError("INVALID_PLAN", `task ${task.taskId} provisioning for ${repositoryId} is invalid: ${provisionIssues[0]!.message}`);
    }
  }
  if (raw.verifyCommands.some((command) => typeof command !== "string" || Buffer.byteLength(command, "utf8") < 1 || Buffer.byteLength(command, "utf8") > 4_096 || command.includes("\0"))) {
    throw new MultiRepositoryOrchestrationError("INVALID_PLAN", `verification command for ${task.taskId} is outside its closed byte bound`);
  }
  const environment = Object.entries(raw.verifyEnvironment);
  if (environment.length > 128 || environment.some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(key) || Buffer.byteLength(value, "utf8") > 16 * 1024 || value.includes("\0"))) {
    throw new MultiRepositoryOrchestrationError("INVALID_PLAN", `verification environment for ${task.taskId} is invalid`);
  }
  if (raw.publication !== undefined) {
    const publicationIds = raw.publication.entries.map((entry) => entry.repositoryId);
    if (
      raw.publication.policyApproved !== true || publicationIds.length !== task.repositoryIds.length ||
      new Set(publicationIds).size !== publicationIds.length || task.repositoryIds.some((id) => !publicationIds.includes(id))
    ) {
      throw new MultiRepositoryOrchestrationError("INVALID_PLAN", `publication vector differs for ${task.taskId}`);
    }
    for (const entry of raw.publication.entries) {
      if (
        !isValidId(entry.publicationId) || !/^[A-Za-z0-9._-]+$/u.test(entry.remoteName) ||
        !URL.canParse(entry.expectedPushUrl) ||
        !entry.remoteRef.startsWith("refs/heads/") || !validBranch(entry.remoteRef.slice("refs/heads/".length)) ||
        (entry.expectedRemoteOid !== null && !OID.test(entry.expectedRemoteOid)) ||
        Buffer.byteLength(entry.title, "utf8") > 512 || Buffer.byteLength(entry.body, "utf8") > 16 * 1024
      ) {
        throw new MultiRepositoryOrchestrationError("INVALID_PLAN", `publication entry for ${entry.repositoryId} is invalid`);
      }
    }
  }
  return cloneExecution(raw);
}

function validBranch(value: string): boolean {
  return Boolean(value) && Buffer.byteLength(value, "utf8") <= 512 && !value.startsWith("-") && !value.startsWith("/") &&
    !value.endsWith("/") && !value.endsWith(".") && !value.includes("..") && !value.includes("@{") &&
    !value.includes("//") && !/[~^:?*\[\\\]\u0000-\u0020\u007f]/u.test(value);
}

function pathsOverlap(left: string, right: string): boolean {
  const relation = relative(left, right);
  return relation === "" || (relation !== ".." && !relation.startsWith("../") && !isAbsolute(relation));
}

/** Validate registry, complete DAG, capability scopes, and task execution vectors before mutation. */
export function materializeMultiRepositoryRunPlan(
  request: MultiRepositoryRunRequestV1,
  resolveIdentity: RepositoryIdentityResolver
): MaterializedMultiRepositoryRunPlanV1 {
  if (
    request.schemaVersion !== 1 ||
    !isValidId(request.runId) ||
    typeof request.runEpoch !== "string" ||
    Buffer.byteLength(request.runEpoch, "utf8") < 1 ||
    Buffer.byteLength(request.runEpoch, "utf8") > MULTIREPO_ORCHESTRATION_LIMITS.maximumRunEpochBytes ||
    !isAbsolute(request.workspaceRoot)
  ) {
    throw new MultiRepositoryOrchestrationError("INVALID_PLAN", "run identity or private workspace root is invalid");
  }
  const workspaceRoot = resolve(request.workspaceRoot);
  const registry = materializeRepositoryRegistry(request.repositoryDefinitions, resolveIdentity);
  if (registry.repositories.some((repository) => pathsOverlap(repository.canonicalRoot, workspaceRoot) || pathsOverlap(workspaceRoot, repository.canonicalRoot))) {
    throw new MultiRepositoryOrchestrationError("INVALID_PLAN", "private worktree workspace overlaps a configured repository root");
  }
  const dag = materializeMultiRepositoryDag(registry, request.tasks);
  if (request.executions.length !== dag.tasks.length || new Set(request.executions.map((item) => item.taskId)).size !== request.executions.length) {
    throw new MultiRepositoryOrchestrationError("INVALID_PLAN", "task execution plans must map one-to-one onto the DAG");
  }
  const rawByTask = new Map(request.executions.map((item) => [item.taskId, item]));
  const executions = dag.tasks.map((task) => {
    const raw = rawByTask.get(task.taskId);
    if (raw === undefined) throw new MultiRepositoryOrchestrationError("INVALID_PLAN", `task ${task.taskId} has no execution plan`);
    const roleRepositoryIds = request.capabilities.roles[task.roleId];
    const providerRepositoryIds = request.capabilities.providers[task.providerId];
    if (roleRepositoryIds === undefined || providerRepositoryIds === undefined) {
      throw new MultiRepositoryOrchestrationError("CAPABILITY_REFUSED", `task ${task.taskId} references an unknown role/provider capability`);
    }
    try {
      assertRepositoryScope(task.repositorySet, { repositoryIds: roleRepositoryIds }, { repositoryIds: providerRepositoryIds });
    } catch (error) {
      throw new MultiRepositoryOrchestrationError("CAPABILITY_REFUSED", `task ${task.taskId} exceeds its configured repository capability`, false, { cause: error });
    }
    return validateExecution(task, raw, registry);
  });
  const repositoryIds = new Set(registry.repositories.map((repository) => repository.repositoryId));
  const validateCapabilities = (kind: "role" | "provider", input: Readonly<Record<string, readonly string[]>>): Readonly<Record<string, readonly string[]>> => Object.freeze(Object.fromEntries(Object.entries(input).map(([key, value]) => {
    if (!isValidId(key) || value.length < 1 || value.length > 64 || new Set(value).size !== value.length || value.some((repositoryId) => !repositoryIds.has(repositoryId))) {
      throw new MultiRepositoryOrchestrationError("CAPABILITY_REFUSED", `${kind} ${key} has an invalid or unknown repository capability`);
    }
    return [key, frozenStrings(value)];
  })));
  const capabilities = Object.freeze({
    roles: validateCapabilities("role", request.capabilities.roles),
    providers: validateCapabilities("provider", request.capabilities.providers)
  });
  const core = {
    schemaVersion: 1 as const,
    runId: request.runId,
    runEpoch: request.runEpoch,
    workspaceRoot,
    registry,
    dag,
    executions: Object.freeze(executions),
    capabilities
  };
  return Object.freeze({ ...core, planDigest: digest("relayforge-multirepo-run-plan-v1", core) });
}

function emptyCanonicalProjection(): MultiRepositoryCanonicalProjectionV1 {
  return Object.freeze({
    schemaVersion: 1,
    scheduler: emptyMultiRepoSchedulerProjection(),
    worktreeGroups: Object.freeze({}),
    workers: Object.freeze({}),
    commitIntents: Object.freeze({}),
    heads: Object.freeze({}),
    integrations: Object.freeze({}),
    localReceipts: Object.freeze({}),
    publications: Object.freeze({}),
    seenFactIds: Object.freeze({})
  });
}

function factDigest(fact: MultiRepositoryCanonicalFactV1): string {
  return digest("relayforge-multirepo-canonical-fact-v1", fact);
}

function taskRepositoryKey(taskId: string, repositoryId: string): string {
  return `${taskId}\0${repositoryId}`;
}

function validateFactEnvelope(fact: MultiRepositoryCanonicalFactV1): void {
  if (!fact || typeof fact !== "object" || fact.schemaVersion !== 1 || !isValidId(fact.factId)) {
    throw new MultiRepositoryOrchestrationError("CANONICAL_HISTORY_CORRUPT", "canonical multi-repository fact envelope is invalid");
  }
}

/** Strictly replay named P6 facts. Unknown, divergent, stale, or cross-fenced history is refused. */
export function projectMultiRepositoryCanonicalFacts(
  facts: readonly MultiRepositoryCanonicalFactV1[]
): MultiRepositoryCanonicalProjectionV1 {
  if (!Array.isArray(facts) || facts.length > MULTIREPO_ORCHESTRATION_LIMITS.maximumJournalFacts) {
    throw new MultiRepositoryOrchestrationError("CANONICAL_HISTORY_CORRUPT", "canonical fact history exceeds its closed bound");
  }
  let projection = emptyCanonicalProjection();
  for (const rawFact of facts) {
    let fact: MultiRepositoryCanonicalFactV1;
    try {
      fact = parseMultiRepositoryCanonicalFact(rawFact);
    } catch (error) {
      throw new MultiRepositoryOrchestrationError("CANONICAL_HISTORY_CORRUPT", "canonical multi-repository fact violates its closed schema", false, { cause: error });
    }
    validateFactEnvelope(fact);
    const factHash = factDigest(fact);
    const prior = projection.seenFactIds[fact.factId];
    if (prior !== undefined) {
      if (prior !== factHash) throw new MultiRepositoryOrchestrationError("CANONICAL_HISTORY_CORRUPT", `fact ID ${fact.factId} has divergent content`);
      continue;
    }
    let plan = projection.plan;
    let scheduler = projection.scheduler;
    let worktreeGroups = projection.worktreeGroups;
    let workers = projection.workers;
    let commitIntents = projection.commitIntents;
    let heads = projection.heads;
    let integrations = projection.integrations;
    let localReceipts = projection.localReceipts;
    let publications = projection.publications;
    switch (fact.kind) {
      case "multirepo.plan_registered":
        if (plan !== undefined || fact.plan.planDigest !== digest("relayforge-multirepo-run-plan-v1", {
          schemaVersion: fact.plan.schemaVersion,
          runId: fact.plan.runId,
          runEpoch: fact.plan.runEpoch,
          workspaceRoot: fact.plan.workspaceRoot,
          registry: fact.plan.registry,
          dag: fact.plan.dag,
          executions: fact.plan.executions,
          capabilities: fact.plan.capabilities
        })) {
          throw new MultiRepositoryOrchestrationError("CANONICAL_HISTORY_CORRUPT", "canonical run plan is duplicated or its digest is invalid");
        }
        plan = fact.plan;
        break;
      case "multirepo.scheduler_transitioned":
        if (plan === undefined) throw new MultiRepositoryOrchestrationError("CANONICAL_HISTORY_CORRUPT", "scheduler fact precedes the run plan");
        scheduler = applyMultiRepoSchedulerEvent(scheduler, fact.event);
        break;
      case "multirepo.worktree_group_recorded": {
        const task = scheduler.tasks[fact.taskId];
        if (task?.taskGeneration !== fact.taskGeneration || task.lease?.leaseToken !== fact.leaseToken || task.repositorySetId !== fact.repositorySetId) {
          throw new MultiRepositoryOrchestrationError("CANONICAL_HISTORY_CORRUPT", "worktree-group fact is not fenced by the exact scheduler lease");
        }
        worktreeGroups = Object.freeze({ ...worktreeGroups, [fact.taskId]: fact });
        break;
      }
      case "multirepo.worker_settled": {
        const task = scheduler.tasks[fact.taskId];
        const lease = task?.lease;
        if (task?.taskGeneration !== fact.taskGeneration || lease?.leaseToken !== fact.leaseToken || lease?.attemptId !== fact.attemptId) {
          throw new MultiRepositoryOrchestrationError("CANONICAL_HISTORY_CORRUPT", "worker settlement is not fenced by the exact scheduler lease");
        }
        workers = Object.freeze({ ...workers, [fact.taskId]: fact });
        break;
      }
      case "multirepo.worktree_commit_intended": {
        const task = scheduler.tasks[fact.taskId];
        const lease = task?.lease;
        if (task?.taskGeneration !== fact.taskGeneration || lease?.leaseToken !== fact.leaseToken || lease?.attemptId !== fact.attemptId) {
          throw new MultiRepositoryOrchestrationError("CANONICAL_HISTORY_CORRUPT", "worktree commit intent is not fenced by the exact scheduler lease");
        }
        const key = taskRepositoryKey(fact.taskId, fact.repositoryId);
        const existing = commitIntents[key];
        if (existing !== undefined && factDigest(existing) !== factHash) throw new MultiRepositoryOrchestrationError("CANONICAL_HISTORY_CORRUPT", "repository has divergent commit intents");
        commitIntents = Object.freeze({ ...commitIntents, [key]: fact });
        break;
      }
      case "multirepo.worktree_head_recorded": {
        const key = taskRepositoryKey(fact.taskId, fact.repositoryId);
        const intent = commitIntents[key];
        if (
          intent === undefined || intent.taskGeneration !== fact.taskGeneration || intent.leaseToken !== fact.leaseToken ||
          intent.expectedOid !== fact.expectedOid || intent.treeOid !== fact.treeOid || intent.branchRef !== fact.branchRef
        ) {
          throw new MultiRepositoryOrchestrationError("CANONICAL_HISTORY_CORRUPT", "worktree head fact differs from its durable commit intent");
        }
        heads = Object.freeze({ ...heads, [key]: fact });
        break;
      }
      case "multirepo.integration_transitioned": {
        const task = scheduler.tasks[fact.taskId];
        if (task?.taskGeneration !== fact.taskGeneration || task.lease?.leaseToken !== fact.leaseToken) {
          throw new MultiRepositoryOrchestrationError("CANONICAL_HISTORY_CORRUPT", "integration fact is not fenced by the exact scheduler lease");
        }
        const current = integrations[fact.event.transactionId];
        const next = applyMultiRepoIntegrationEvent(current, fact.event);
        integrations = Object.freeze({ ...integrations, [fact.event.transactionId]: next });
        break;
      }
      case "multirepo.local_integration_receipted": {
        const integration = integrations[fact.transactionId];
        if (integration?.state !== "applied" || integration.repositorySetId !== fact.repositorySetId || integration.verification?.receiptDigest !== fact.verificationReceiptDigest) {
          throw new MultiRepositoryOrchestrationError("CANONICAL_HISTORY_CORRUPT", "local integration receipt does not bind an applied verified vector");
        }
        const expected = localIntegrationReceiptDigest(fact.transactionId, fact.repositorySetId, fact.verificationReceiptDigest, fact.appliedEntriesDigest);
        if (expected !== fact.receiptDigest) throw new MultiRepositoryOrchestrationError("CANONICAL_HISTORY_CORRUPT", "local integration receipt digest differs");
        localReceipts = Object.freeze({ ...localReceipts, [fact.taskId]: fact });
        break;
      }
      case "multirepo.publication_transitioned": {
        const current = publications[fact.event.transactionId];
        const next = applyMultiRepoPublicationEvent(current, fact.event);
        const receipt = localReceipts[fact.taskId];
        if (receipt === undefined || next.plan.localIntegrationReceiptDigest !== receipt.receiptDigest) {
          throw new MultiRepositoryOrchestrationError("CANONICAL_HISTORY_CORRUPT", "publication is not bound to the task local-integration receipt");
        }
        publications = Object.freeze({ ...publications, [fact.event.transactionId]: next });
        break;
      }
    }
    projection = Object.freeze({
      schemaVersion: 1,
      ...(plan === undefined ? {} : { plan }),
      scheduler,
      worktreeGroups,
      workers,
      commitIntents,
      heads,
      integrations,
      localReceipts,
      publications,
      seenFactIds: Object.freeze({ ...projection.seenFactIds, [fact.factId]: factHash })
    });
  }
  return projection;
}

function readCanonical(
  journal: MultiRepositoryCanonicalJournalV1,
  plan: MaterializedMultiRepositoryRunPlanV1
): Readonly<{ snapshot: MultiRepositoryCanonicalJournalSnapshotV1; projection: MultiRepositoryCanonicalProjectionV1 }> {
  let snapshot: MultiRepositoryCanonicalJournalSnapshotV1;
  try {
    snapshot = journal.read();
  } catch (error) {
    throw new MultiRepositoryOrchestrationError("CANONICAL_HISTORY_CORRUPT", "canonical journal could not be read", true, { cause: error });
  }
  if (
    snapshot.schemaVersion !== 1 || snapshot.runId !== plan.runId || snapshot.runEpoch !== plan.runEpoch ||
    !Number.isSafeInteger(snapshot.controlHeadSeq) || snapshot.controlHeadSeq < 0 ||
    !Number.isSafeInteger(snapshot.headVersion) || snapshot.headVersion < 0 || snapshot.headVersion !== snapshot.facts.length
  ) {
    throw new MultiRepositoryOrchestrationError("CANONICAL_IDENTITY_MISMATCH", "canonical journal identity/head differs from this exact run", true);
  }
  const projection = projectMultiRepositoryCanonicalFacts(snapshot.facts);
  if (projection.plan !== undefined && projection.plan.planDigest !== plan.planDigest) {
    throw new MultiRepositoryOrchestrationError("CANONICAL_IDENTITY_MISMATCH", "canonical multi-repository plan differs from the current immutable plan", true);
  }
  return Object.freeze({ snapshot, projection });
}

function appendCanonical(
  journal: MultiRepositoryCanonicalJournalV1,
  plan: MaterializedMultiRepositoryRunPlanV1,
  fact: MultiRepositoryCanonicalFactV1
): Readonly<{ snapshot: MultiRepositoryCanonicalJournalSnapshotV1; projection: MultiRepositoryCanonicalProjectionV1 }> {
  for (let conflict = 0; conflict < 16; conflict += 1) {
    const before = readCanonical(journal, plan);
    const priorDigest = before.projection.seenFactIds[fact.factId];
    if (priorDigest !== undefined) {
      if (priorDigest !== factDigest(fact)) throw new MultiRepositoryOrchestrationError("CANONICAL_HISTORY_CORRUPT", `fact ID ${fact.factId} already has divergent content`, true);
      return before;
    }
    let after: MultiRepositoryCanonicalJournalSnapshotV1;
    try {
      after = journal.append({
        expectedControlHeadSeq: before.snapshot.controlHeadSeq,
        expectedHeadVersion: before.snapshot.headVersion,
        fact
      });
    } catch (error) {
      if (error instanceof MultiRepositoryCanonicalJournalConflictError) continue;
      throw new MultiRepositoryOrchestrationError("CANONICAL_APPEND_FAILED", `canonical append failed for ${fact.kind}; all authority must remain held`, true, { cause: error });
    }
    if (
      after.runId !== plan.runId || after.runEpoch !== plan.runEpoch || after.schemaVersion !== 1 ||
      after.controlHeadSeq !== before.snapshot.controlHeadSeq + 1 ||
      after.headVersion !== before.snapshot.headVersion + 1 || after.facts.length !== after.headVersion ||
      after.facts.slice(0, -1).some((item, index) => factDigest(item) !== factDigest(before.snapshot.facts[index]!)) ||
      factDigest(after.facts.at(-1)!) !== factDigest(fact)
    ) {
      throw new MultiRepositoryOrchestrationError("CANONICAL_APPEND_FAILED", "canonical append receipt did not prove the exact fact, aggregate version, global head, and prefix", true);
    }
    return Object.freeze({ snapshot: after, projection: projectMultiRepositoryCanonicalFacts(after.facts) });
  }
  throw new MultiRepositoryOrchestrationError("CANONICAL_APPEND_FAILED", `canonical ControlStore head remained contended while appending ${fact.kind}; all authority must remain held`, true);
}

function factId(prefix: string, ...values: readonly unknown[]): string {
  return `${prefix}-${digest(`relayforge-${prefix}-fact-id-v1`, values).slice(0, 48)}`;
}

function taskById(plan: MaterializedMultiRepositoryRunPlanV1, taskId: string): MaterializedMultiRepositoryTaskV1 {
  const task = plan.dag.tasks.find((item) => item.taskId === taskId);
  if (task === undefined) throw new MultiRepositoryOrchestrationError("INVALID_PLAN", `unknown task ${taskId}`);
  return task;
}

function executionById(plan: MaterializedMultiRepositoryRunPlanV1, taskId: string): MultiRepositoryTaskExecutionV1 {
  const execution = plan.executions.find((item) => item.taskId === taskId);
  if (execution === undefined) throw new MultiRepositoryOrchestrationError("INVALID_PLAN", `missing execution ${taskId}`);
  return execution;
}

function ensurePrivateWorkspace(path: string): string {
  const root = resolve(path);
  if (!isAbsolute(root)) throw new MultiRepositoryOrchestrationError("INVALID_PLAN", "workspace root must be absolute");
  if (!lstatOrUndefined(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || realpathSync.native(root) !== root || (process.geteuid && stat.uid !== process.geteuid())) {
    throw new MultiRepositoryOrchestrationError("INVALID_PLAN", "multi-repository workspace root is not a private physical directory");
  }
  return root;
}

function lstatOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path); } catch { return undefined; }
}

function worktreeOptions(
  plan: MaterializedMultiRepositoryRunPlanV1,
  task: MaterializedMultiRepositoryTaskV1,
  execution: MultiRepositoryTaskExecutionV1,
  lease: SchedulerLeaseV1
): WorktreeGroupOptions {
  const registry = new Map(plan.registry.repositories.map((item) => [item.repositoryId, item]));
  const byId = new Map(execution.entries.map((item) => [item.repositoryId, item]));
  const groupId = `group-${factId("g", task.taskId, task.taskGeneration, lease.attemptId).slice(2, 34)}`;
  const authority: WorktreeGroupAuthority = Object.freeze({
    taskId: task.taskId,
    taskGeneration: task.taskGeneration,
    attemptId: lease.attemptId,
    leaseToken: lease.leaseToken
  });
  return Object.freeze({
    groupId,
    groupRoot: resolve(plan.workspaceRoot, groupId),
    repositorySet: task.repositorySet,
    authority,
    entries: Object.freeze(task.repositoryIds.map((repositoryId) => {
      const configured = byId.get(repositoryId)!;
      return Object.freeze({
        repository: registry.get(repositoryId)!,
        branch: configured.branch,
        ...(configured.provision === undefined ? {} : { provision: configured.provision })
      });
    }))
  });
}

function workerMembers(result: WorktreeGroupResult): readonly MultiRepositoryWorkerMemberV1[] {
  return Object.freeze(result.members.map((member) => Object.freeze({
    repositoryId: member.repositoryId,
    path: member.path,
    branch: member.branch,
    anchorOid: member.anchorOid
  })));
}

function worktreeFact(
  task: MaterializedMultiRepositoryTaskV1,
  lease: SchedulerLeaseV1,
  result: WorktreeGroupResult
): MultiRepositoryCanonicalWorktreeFactV1 {
  const members = workerMembers(result);
  return Object.freeze({
    schemaVersion: 1,
    kind: "multirepo.worktree_group_recorded",
    factId: factId("mrw", task.taskId, task.taskGeneration, lease.leaseToken, result.receipt.state, result.receipt.receiptDigest),
    taskId: task.taskId,
    taskGeneration: task.taskGeneration,
    leaseToken: lease.leaseToken,
    groupRoot: result.receipt.groupRoot,
    groupId: result.receipt.groupId,
    repositorySetId: task.repositorySet.repositorySetId,
    state: result.receipt.state,
    receiptDigest: result.receipt.receiptDigest,
    members,
    issueCodes: frozenStrings(result.issues.map((issue) => issue.code))
  });
}

function assertExactReadyGroup(fact: MultiRepositoryCanonicalWorktreeFactV1): void {
  let receipt: WorktreeGroupReceipt;
  try { receipt = assertReadyWorktreeGroupExact(fact.groupRoot); }
  catch (error) { throw new MultiRepositoryOrchestrationError("WORKTREE_RECOVERY_REQUIRED", "worktree-group receipt cannot be re-opened exactly", true, { cause: error }); }
  const receiptMembers = receipt.entries.map((entry) => [entry.repository.repositoryId, entry.destination, entry.branch, entry.anchorOid]);
  const factMembers = fact.members.map((member) => [member.repositoryId, member.path, member.branch, member.anchorOid]);
  if (
    receipt.state !== "ready" || receipt.receiptDigest !== fact.receiptDigest ||
    receipt.groupId !== fact.groupId || receipt.repositorySetId !== fact.repositorySetId ||
    receipt.authority.taskId !== fact.taskId || receipt.authority.taskGeneration !== fact.taskGeneration ||
    receipt.authority.leaseToken !== fact.leaseToken ||
    JSON.stringify(receiptMembers) !== JSON.stringify(factMembers)
  ) {
    throw new MultiRepositoryOrchestrationError("WORKTREE_RECOVERY_REQUIRED", "worktree-group receipt changed after canonical readiness", true);
  }
}

function workerRequest(
  plan: MaterializedMultiRepositoryRunPlanV1,
  task: MaterializedMultiRepositoryTaskV1,
  lease: SchedulerLeaseV1,
  worktree?: MultiRepositoryCanonicalWorktreeFactV1
): MultiRepositoryWorkerRequestV1 {
  return Object.freeze({
    schemaVersion: 1,
    runId: plan.runId,
    runEpoch: plan.runEpoch,
    taskId: task.taskId,
    taskGeneration: task.taskGeneration,
    attemptId: lease.attemptId,
    leaseToken: lease.leaseToken,
    repositorySetId: task.repositorySet.repositorySetId,
    members: Object.freeze((worktree?.members ?? []).map((member) => Object.freeze({ ...member })))
  });
}

function schedulerFact(event: MultiRepoSchedulerEventV1): MultiRepositoryCanonicalSchedulerFactV1 {
  return Object.freeze({ schemaVersion: 1, kind: "multirepo.scheduler_transitioned", factId: event.eventId, event });
}

function schedulerEventBase(
  projection: MultiRepoSchedulerProjectionV1,
  task: MaterializedMultiRepositoryTaskV1,
  type: string,
  occurredAt: string
): Readonly<{ schemaVersion: 1; seq: number; eventId: string; occurredAt: string; taskId: string; taskGeneration: number }> {
  return Object.freeze({
    schemaVersion: 1,
    seq: projection.headSeq + 1,
    eventId: factId("mrs", task.taskId, task.taskGeneration, projection.headSeq + 1, type),
    occurredAt,
    taskId: task.taskId,
    taskGeneration: task.taskGeneration
  });
}

function appendScheduler(
  dependencies: MultiRepositoryOrchestrationDependencies,
  plan: MaterializedMultiRepositoryRunPlanV1,
  event: MultiRepoSchedulerEventV1
): MultiRepositoryCanonicalProjectionV1 {
  return appendCanonical(dependencies.journal, plan, schedulerFact(event)).projection;
}

function markLeaseUncertain(
  dependencies: MultiRepositoryOrchestrationDependencies,
  plan: MaterializedMultiRepositoryRunPlanV1,
  task: MaterializedMultiRepositoryTaskV1,
  projection: MultiRepositoryCanonicalProjectionV1,
  lease: SchedulerLeaseV1,
  reasonCode: "PROCESS_IDENTITY_UNKNOWN" | "SETTLEMENT_UNKNOWN"
): MultiRepositoryCanonicalProjectionV1 {
  const scheduled = projection.scheduler.tasks[task.taskId];
  if (scheduled?.lease?.state === "uncertain") return projection;
  if (scheduled?.lease?.leaseToken !== lease.leaseToken) {
    throw new MultiRepositoryOrchestrationError("CANONICAL_HISTORY_CORRUPT", "cannot mark a different scheduler lease uncertain", true);
  }
  const event = Object.freeze({
    ...schedulerEventBase(projection.scheduler, task, "uncertain", boundedTimestamp((dependencies.now ?? (() => new Date()))())),
    type: "scheduler.lease_uncertain" as const,
    expectedVersion: scheduled.version,
    leaseToken: lease.leaseToken,
    reasonCode
  });
  return appendScheduler(dependencies, plan, event);
}

function settlementShapeValid(value: MultiRepositoryWorkerSettlementV1, processIdentity: string): boolean {
  return value.schemaVersion === 1 && value.processIdentity === processIdentity && Boolean(value.processIdentity) &&
    Buffer.byteLength(value.settlementCallId, "utf8") >= 1 && Buffer.byteLength(value.settlementCallId, "utf8") <= 512 &&
    SHA256.test(value.outputDigest) && Buffer.byteLength(value.summary, "utf8") <= MULTIREPO_ORCHESTRATION_LIMITS.maximumWorkerSummaryBytes &&
    typeof value.transportTrusted === "boolean" && typeof value.scopeTrusted === "boolean" &&
    typeof value.scopeReaped === "boolean" && typeof value.settlementTrusted === "boolean";
}

function validateSettlement(value: MultiRepositoryWorkerSettlementV1, processIdentity: string): void {
  if (!settlementShapeValid(value, processIdentity) || !value.transportTrusted || !value.scopeTrusted || !value.scopeReaped || !value.settlementTrusted) {
    throw new MultiRepositoryOrchestrationError("WORKER_RECOVERY_REQUIRED", "worker transport/scope/settlement evidence is incomplete or untrusted", true);
  }
}

function gitRequired(cwd: string, args: readonly string[], message: string): string {
  const result = runGit(cwd, [...args]);
  if (!result.ok) throw new MultiRepositoryOrchestrationError("WORKTREE_RECOVERY_REQUIRED", `${message}: ${result.err || "Git command failed"}`, true);
  return result.out;
}

function verifyCommittedHead(
  member: MultiRepositoryWorkerMemberV1,
  intent: MultiRepositoryCanonicalCommitIntentFactV1,
  childOid: string
): string {
  const head = gitRequired(member.path, ["rev-parse", "--verify", "HEAD^{commit}"], `cannot observe ${member.repositoryId} HEAD`);
  const branch = gitRequired(member.path, ["symbolic-ref", "-q", "HEAD"], `cannot observe ${member.repositoryId} branch`);
  const tree = gitRequired(member.path, ["rev-parse", "--verify", `${childOid}^{tree}`], `cannot observe ${member.repositoryId} tree`);
  const parentLine = gitRequired(member.path, ["rev-list", "--parents", "-n", "1", childOid], `cannot observe ${member.repositoryId} parents`);
  const status = gitRequired(member.path, ["status", "--porcelain", "--untracked-files=all"], `cannot observe ${member.repositoryId} status`);
  if (head !== childOid || branch !== intent.branchRef || tree !== intent.treeOid || parentLine !== `${childOid} ${intent.expectedOid}` || status !== "") {
    throw new MultiRepositoryOrchestrationError("WORKTREE_RECOVERY_REQUIRED", `committed worktree identity differs for ${member.repositoryId}`, true);
  }
  return tree;
}

function ensureCommitIntent(
  dependencies: MultiRepositoryOrchestrationDependencies,
  plan: MaterializedMultiRepositoryRunPlanV1,
  task: MaterializedMultiRepositoryTaskV1,
  execution: MultiRepositoryTaskExecutionV1,
  lease: SchedulerLeaseV1,
  member: MultiRepositoryWorkerMemberV1,
  projection: MultiRepositoryCanonicalProjectionV1
): MultiRepositoryCanonicalProjectionV1 {
  const key = taskRepositoryKey(task.taskId, member.repositoryId);
  if (projection.commitIntents[key] !== undefined) return projection;
  const head = gitRequired(member.path, ["rev-parse", "--verify", "HEAD^{commit}"], `cannot observe ${member.repositoryId} pre-commit HEAD`);
  const branchRef = gitRequired(member.path, ["symbolic-ref", "-q", "HEAD"], `cannot observe ${member.repositoryId} work branch`);
  if (head !== member.anchorOid) throw new MultiRepositoryOrchestrationError("WORKTREE_RECOVERY_REQUIRED", `worker moved ${member.repositoryId} HEAD before parent commit intent`, true);
  const status = gitRequired(member.path, ["status", "--porcelain", "--untracked-files=all"], `cannot observe ${member.repositoryId} changes`);
  if (status === "") throw new MultiRepositoryOrchestrationError("WORKER_RECOVERY_REQUIRED", `worker produced no change in authorized repository ${member.repositoryId}`, false);
  gitRequired(member.path, ["add", "--all"], `cannot stage ${member.repositoryId} changes`);
  const treeOid = gitRequired(member.path, ["write-tree"], `cannot materialize ${member.repositoryId} tree`);
  if (!OID.test(treeOid)) throw new MultiRepositoryOrchestrationError("WORKTREE_RECOVERY_REQUIRED", `Git returned an invalid tree for ${member.repositoryId}`, true);
  const fact: MultiRepositoryCanonicalCommitIntentFactV1 = Object.freeze({
    schemaVersion: 1,
    kind: "multirepo.worktree_commit_intended",
    factId: factId("mrc", task.taskId, task.taskGeneration, lease.leaseToken, member.repositoryId, member.anchorOid, treeOid, execution.commitMessage),
    taskId: task.taskId,
    taskGeneration: task.taskGeneration,
    attemptId: lease.attemptId,
    leaseToken: lease.leaseToken,
    repositoryId: member.repositoryId,
    branchRef,
    expectedOid: member.anchorOid,
    treeOid,
    message: execution.commitMessage
  });
  return appendCanonical(dependencies.journal, plan, fact).projection;
}

function ensureHeadRecorded(
  dependencies: MultiRepositoryOrchestrationDependencies,
  plan: MaterializedMultiRepositoryRunPlanV1,
  task: MaterializedMultiRepositoryTaskV1,
  lease: SchedulerLeaseV1,
  member: MultiRepositoryWorkerMemberV1,
  projection: MultiRepositoryCanonicalProjectionV1
): MultiRepositoryCanonicalProjectionV1 {
  const key = taskRepositoryKey(task.taskId, member.repositoryId);
  const intent = projection.commitIntents[key];
  if (intent === undefined) throw new MultiRepositoryOrchestrationError("CANONICAL_HISTORY_CORRUPT", `commit intent missing for ${member.repositoryId}`, true);
  const recorded = projection.heads[key];
  if (recorded !== undefined) {
    verifyCommittedHead(member, intent, recorded.childOid);
    return projection;
  }
  const observedHead = gitRequired(member.path, ["rev-parse", "--verify", "HEAD^{commit}"], `cannot observe ${member.repositoryId} commit result`);
  let childOid: string;
  if (observedHead === intent.expectedOid) {
    childOid = gitRequired(member.path, ["commit-tree", intent.treeOid, "-p", intent.expectedOid, "-m", intent.message], `cannot create ${member.repositoryId} child commit`);
    if (!OID.test(childOid)) throw new MultiRepositoryOrchestrationError("WORKTREE_RECOVERY_REQUIRED", `invalid child commit for ${member.repositoryId}`, true);
    gitRequired(member.path, ["update-ref", intent.branchRef, childOid, intent.expectedOid], `cannot CAS ${member.repositoryId} private work branch`);
  } else {
    childOid = observedHead;
  }
  const treeOid = verifyCommittedHead(member, intent, childOid);
  const fact: MultiRepositoryCanonicalHeadFactV1 = Object.freeze({
    schemaVersion: 1,
    kind: "multirepo.worktree_head_recorded",
    factId: factId("mrh", task.taskId, task.taskGeneration, lease.leaseToken, member.repositoryId, childOid),
    taskId: task.taskId,
    taskGeneration: task.taskGeneration,
    attemptId: lease.attemptId,
    leaseToken: lease.leaseToken,
    repositoryId: member.repositoryId,
    branchRef: intent.branchRef,
    expectedOid: intent.expectedOid,
    childOid,
    treeOid
  });
  return appendCanonical(dependencies.journal, plan, fact).projection;
}

function integrationPlan(
  plan: MaterializedMultiRepositoryRunPlanV1,
  task: MaterializedMultiRepositoryTaskV1,
  execution: MultiRepositoryTaskExecutionV1,
  lease: SchedulerLeaseV1,
  worktree: MultiRepositoryCanonicalWorktreeFactV1,
  projection: MultiRepositoryCanonicalProjectionV1
): MultiRepoIntegrationPlanV1 {
  const repositories = new Map(plan.registry.repositories.map((item) => [item.repositoryId, item]));
  const executionEntries = new Map(execution.entries.map((item) => [item.repositoryId, item]));
  const members = new Map(worktree.members.map((item) => [item.repositoryId, item]));
  return Object.freeze({
    schemaVersion: 1,
    transactionId: `txn-${digest("relayforge-multirepo-transaction-id-v1", [plan.runId, plan.runEpoch, task.taskId, task.taskGeneration, lease.leaseToken]).slice(0, 48)}`,
    repositorySetId: task.repositorySet.repositorySetId,
    entries: Object.freeze([...task.repositoryIds].sort((left, right) => left.localeCompare(right)).map((repositoryId) => {
      const head = projection.heads[taskRepositoryKey(task.taskId, repositoryId)];
      if (head === undefined) throw new MultiRepositoryOrchestrationError("CANONICAL_HISTORY_CORRUPT", `candidate head missing for ${repositoryId}`, true);
      const configured = executionEntries.get(repositoryId)!;
      return Object.freeze({
        repository: repositories.get(repositoryId)!,
        targetRef: configured.targetRef,
        expectedOid: head.expectedOid,
        childOid: head.childOid,
        canonicalWorkspacePath: members.get(repositoryId)!.path,
        message: execution.commitMessage
      });
    })),
    verifyCommands: execution.verifyCommands,
    verifyEnvironment: execution.verifyEnvironment
  });
}

function integrationFact(
  task: MaterializedMultiRepositoryTaskV1,
  lease: SchedulerLeaseV1,
  event: MultiRepoIntegrationEventV1
): MultiRepositoryCanonicalIntegrationFactV1 {
  return Object.freeze({
    schemaVersion: 1,
    kind: "multirepo.integration_transitioned",
    factId: event.eventId,
    taskId: task.taskId,
    taskGeneration: task.taskGeneration,
    leaseToken: lease.leaseToken,
    event
  });
}

function localIntegrationReceiptDigest(
  transactionId: string,
  repositorySetId: string,
  verificationReceiptDigest: string,
  appliedEntriesDigest: string
): string {
  return digest("relayforge-local-integration-receipt-v1", [transactionId, repositorySetId, verificationReceiptDigest, appliedEntriesDigest]);
}

function localReceiptFact(
  task: MaterializedMultiRepositoryTaskV1,
  lease: SchedulerLeaseV1,
  projection: MultiRepoIntegrationProjectionV1
): MultiRepositoryCanonicalLocalReceiptFactV1 {
  if (projection.state !== "applied" || projection.verification === undefined || projection.entries.some((entry) => entry.applyResult === undefined)) {
    throw new MultiRepositoryOrchestrationError("INTEGRATION_RECOVERY_REQUIRED", "only a fully applied verified vector can receive a local receipt", true);
  }
  const appliedEntriesDigest = digest("relayforge-local-integration-applied-entries-v1", projection.entries.map((entry) => [
    entry.plan.repository.repositoryId,
    entry.candidate?.candidateOid,
    entry.applyResult?.state,
    entry.applyResult?.observedOid
  ]));
  const receiptDigest = localIntegrationReceiptDigest(projection.transactionId, projection.repositorySetId, projection.verification.receiptDigest, appliedEntriesDigest);
  return Object.freeze({
    schemaVersion: 1,
    kind: "multirepo.local_integration_receipted",
    factId: factId("mrr", task.taskId, task.taskGeneration, lease.leaseToken, receiptDigest),
    taskId: task.taskId,
    taskGeneration: task.taskGeneration,
    leaseToken: lease.leaseToken,
    transactionId: projection.transactionId,
    repositorySetId: projection.repositorySetId,
    verificationReceiptDigest: projection.verification.receiptDigest,
    appliedEntriesDigest,
    receiptDigest
  });
}

function publicationPlan(
  task: MaterializedMultiRepositoryTaskV1,
  execution: MultiRepositoryTaskExecutionV1,
  receipt: MultiRepositoryCanonicalLocalReceiptFactV1,
  integration: MultiRepoIntegrationProjectionV1
): MultiRepoPublicationPlanV1 | undefined {
  if (execution.publication === undefined) return undefined;
  const candidates = new Map(integration.entries.map((entry) => [entry.plan.repository.repositoryId, entry.candidate!.candidateOid]));
  const localRefs = new Map(integration.entries.map((entry) => [entry.plan.repository.repositoryId, entry.plan.targetRef]));
  return Object.freeze({
    schemaVersion: 1,
    transactionId: integration.transactionId,
    repositorySetId: task.repositorySet.repositorySetId,
    localIntegrationReceiptDigest: receipt.receiptDigest,
    policyApproved: execution.publication.policyApproved,
    entries: Object.freeze([...execution.publication.entries]
      .sort((left, right) => left.repositoryId.localeCompare(right.repositoryId))
      .map((entry) => Object.freeze({ ...entry, candidateOid: candidates.get(entry.repositoryId)!, localIntegrationRef: localRefs.get(entry.repositoryId)! })))
  });
}

function publicationFact(
  task: MaterializedMultiRepositoryTaskV1,
  event: MultiRepoPublicationEventV1
): MultiRepositoryCanonicalPublicationFactV1 {
  return Object.freeze({
    schemaVersion: 1,
    kind: "multirepo.publication_transitioned",
    factId: event.eventId,
    taskId: task.taskId,
    taskGeneration: task.taskGeneration,
    event
  });
}

function orderedTasks(plan: MaterializedMultiRepositoryRunPlanV1): readonly MaterializedMultiRepositoryTaskV1[] {
  const byId = new Map(plan.dag.tasks.map((task) => [task.taskId, task]));
  const execution = new Map(plan.executions.map((item) => [item.taskId, item]));
  return Object.freeze(plan.dag.layers.flatMap((layer) => [...layer]
    .sort((left, right) => execution.get(right)!.priority - execution.get(left)!.priority || left.localeCompare(right))
    .map((taskId) => byId.get(taskId)!)));
}

function assertInitialIntegrationTargets(plan: MaterializedMultiRepositoryRunPlanV1): void {
  const repositories = new Map(plan.registry.repositories.map((repository) => [repository.repositoryId, repository]));
  for (const execution of plan.executions) {
    for (const entry of execution.entries) {
      const repository = repositories.get(entry.repositoryId)!;
      const target = runGit(repository.canonicalRoot, ["rev-parse", "--verify", `${entry.targetRef}^{commit}`]);
      const base = runGit(repository.canonicalRoot, ["rev-parse", "--verify", `refs/heads/${repository.defaultBranch}^{commit}`]);
      if (!target.ok || !base.ok || !OID.test(target.out) || target.out !== base.out) {
        throw new MultiRepositoryOrchestrationError("INVALID_PLAN", `integration target ${entry.targetRef} for ${entry.repositoryId} must initially exist at the exact configured base anchor`);
      }
    }
  }
}

function registerPlanAndTasks(
  dependencies: MultiRepositoryOrchestrationDependencies,
  plan: MaterializedMultiRepositoryRunPlanV1
): MultiRepositoryCanonicalProjectionV1 {
  let current = readCanonical(dependencies.journal, plan).projection;
  if (current.plan === undefined) {
    const fact: MultiRepositoryCanonicalPlanFactV1 = Object.freeze({
      schemaVersion: 1,
      kind: "multirepo.plan_registered",
      factId: factId("mrp", plan.runId, plan.runEpoch, plan.planDigest),
      plan
    });
    current = appendCanonical(dependencies.journal, plan, fact).projection;
  }
  const now = dependencies.now ?? (() => new Date());
  for (const task of orderedTasks(plan)) {
    if (current.scheduler.tasks[task.taskId] !== undefined) continue;
    const execution = executionById(plan, task.taskId);
    const event = Object.freeze({
      ...schedulerEventBase(current.scheduler, task, "register", boundedTimestamp(now())),
      type: "scheduler.task_registered" as const,
      repositorySetId: task.repositorySet.repositorySetId,
      repositoryIds: [...task.repositoryIds],
      providerId: task.providerId,
      dependencies: [...task.dependencies],
      priority: execution.priority
    });
    current = appendScheduler(dependencies, plan, event);
  }
  return current;
}

function leaseToken(dependencies: MultiRepositoryOrchestrationDependencies): string {
  const value = dependencies.randomToken?.() ?? randomBytes(32).toString("hex");
  if (!SHA256.test(value)) throw new MultiRepositoryOrchestrationError("INVALID_PLAN", "lease token source returned a non-canonical token");
  return value;
}

function admitTask(
  dependencies: MultiRepositoryOrchestrationDependencies,
  plan: MaterializedMultiRepositoryRunPlanV1,
  task: MaterializedMultiRepositoryTaskV1,
  projection: MultiRepositoryCanonicalProjectionV1
): MultiRepositoryCanonicalProjectionV1 {
  let current = projection;
  const now = dependencies.now ?? (() => new Date());
  const existing = current.scheduler.tasks[task.taskId];
  if (existing === undefined) throw new MultiRepositoryOrchestrationError("CANONICAL_HISTORY_CORRUPT", `scheduler task ${task.taskId} is absent`, true);
  if (existing.state === "completed") return current;
  if (existing.lease !== undefined) return current;
  const reconcileId = factId("reconcile", task.taskId, task.taskGeneration, existing.version);
  const startedAt = boundedTimestamp(now());
  const started = Object.freeze({
    ...schedulerEventBase(current.scheduler, task, "reconcile-start", startedAt),
    type: "scheduler.reconcile_started" as const,
    reconcileId,
    ownerId: dependencies.ownerId,
    expectedVersion: existing.version
  });
  current = appendScheduler(dependencies, plan, started);
  const active = current.scheduler.tasks[task.taskId]!;
  const issued = now();
  const expires = new Date(issued.getTime() + 15 * 60_000);
  const token = leaseToken(dependencies);
  const attemptId = factId("attempt", task.taskId, task.taskGeneration, active.version, token);
  const decision = decideSchedulerAdmission({
    projection: current.scheduler,
    taskId: task.taskId,
    expectedVersion: active.version,
    repositorySetId: task.repositorySet.repositorySetId,
    roleRepositoryIds: plan.capabilities.roles[task.roleId]!,
    providerRepositoryIds: plan.capabilities.providers[task.providerId]!,
    budgetAvailable: true,
    limits: dependencies.concurrency,
    lease: {
      eventId: factId("mrs", task.taskId, task.taskGeneration, current.scheduler.headSeq + 1, "lease"),
      occurredAt: boundedTimestamp(issued),
      leaseToken: token,
      leaseVersion: 1,
      attemptId,
      ownerId: dependencies.ownerId,
      ownerIncarnation: dependencies.ownerIncarnation,
      issuedAt: boundedTimestamp(issued),
      expiresAt: boundedTimestamp(expires)
    }
  });
  if (!decision.admitted) throw new MultiRepositoryOrchestrationError("ADMISSION_REFUSED", `${task.taskId}: ${decision.reasonCode}: ${decision.detail}`);
  current = appendScheduler(dependencies, plan, decision.event);
  const leased = current.scheduler.tasks[task.taskId]!;
  const finished = Object.freeze({
    ...schedulerEventBase(current.scheduler, task, "reconcile-finish", boundedTimestamp(now())),
    type: "scheduler.reconcile_finished" as const,
    reconcileId,
    ownerId: dependencies.ownerId,
    expectedVersion: leased.version
  });
  return appendScheduler(dependencies, plan, finished);
}

async function ensureWorkerSettled(
  dependencies: MultiRepositoryOrchestrationDependencies,
  plan: MaterializedMultiRepositoryRunPlanV1,
  task: MaterializedMultiRepositoryTaskV1,
  lease: SchedulerLeaseV1,
  worktree: MultiRepositoryCanonicalWorktreeFactV1,
  projection: MultiRepositoryCanonicalProjectionV1
): Promise<MultiRepositoryCanonicalProjectionV1> {
  const request = workerRequest(plan, task, lease, worktree);
  const existing = projection.workers[task.taskId];
  if (existing !== undefined) {
    try { validateSettlement(existing.settlement, existing.settlement.processIdentity); }
    catch (error) {
      markLeaseUncertain(dependencies, plan, task, projection, lease, "SETTLEMENT_UNKNOWN");
      throw error;
    }
    return projection;
  }
  let current = projection;
  const schedulerTask = current.scheduler.tasks[task.taskId]!;
  const acknowledgedIdentity = schedulerTask.lease?.processIdentity;
  let settlement: MultiRepositoryWorkerSettlementV1;
  if (acknowledgedIdentity !== undefined) {
    const recovered = await dependencies.worker.recover?.(request, acknowledgedIdentity);
    if (recovered === undefined) {
      markLeaseUncertain(dependencies, plan, task, current, lease, "SETTLEMENT_UNKNOWN");
      throw new MultiRepositoryOrchestrationError("WORKER_RECOVERY_REQUIRED", `cannot settle previously dispatched worker ${acknowledgedIdentity}`, true);
    }
    settlement = recovered;
  } else {
    let processIdentity: string | undefined;
    try {
      settlement = await dependencies.worker.run(request, (identity) => {
        if (processIdentity !== undefined || !identity || Buffer.byteLength(identity, "utf8") > 512) {
          throw new MultiRepositoryOrchestrationError("WORKER_RECOVERY_REQUIRED", "worker dispatch acknowledgement is duplicated or invalid", true);
        }
        const taskProjection = current.scheduler.tasks[task.taskId]!;
        const event = Object.freeze({
          ...schedulerEventBase(current.scheduler, task, "dispatch", boundedTimestamp((dependencies.now ?? (() => new Date()))())),
          type: "scheduler.dispatch_acknowledged" as const,
          expectedVersion: taskProjection.version,
          leaseToken: lease.leaseToken,
          processIdentity: identity
        });
        current = appendScheduler(dependencies, plan, event);
        processIdentity = identity;
      });
    } catch (error) {
      if (error instanceof MultiRepositoryOrchestrationError && (error.code === "CANONICAL_APPEND_FAILED" || error.code === "CANONICAL_HISTORY_CORRUPT")) throw error;
      markLeaseUncertain(dependencies, plan, task, current, lease, processIdentity === undefined ? "PROCESS_IDENTITY_UNKNOWN" : "SETTLEMENT_UNKNOWN");
      throw new MultiRepositoryOrchestrationError("WORKER_RECOVERY_REQUIRED", "worker launch/settlement failed and the exact lease is now uncertain", true, { cause: error });
    }
    if (processIdentity === undefined) {
      markLeaseUncertain(dependencies, plan, task, current, lease, "PROCESS_IDENTITY_UNKNOWN");
      throw new MultiRepositoryOrchestrationError("WORKER_RECOVERY_REQUIRED", "worker returned without a canonical pre-exec dispatch acknowledgement", true);
    }
  }
  const exactProcessIdentity = acknowledgedIdentity ?? settlement.processIdentity;
  if (!settlementShapeValid(settlement, exactProcessIdentity)) {
    markLeaseUncertain(dependencies, plan, task, current, lease, "SETTLEMENT_UNKNOWN");
    throw new MultiRepositoryOrchestrationError("WORKER_RECOVERY_REQUIRED", "worker settlement evidence has an invalid closed shape", true);
  }
  const fact: MultiRepositoryCanonicalWorkerFactV1 = Object.freeze({
    schemaVersion: 1,
    kind: "multirepo.worker_settled",
    factId: factId("mrworker", task.taskId, task.taskGeneration, lease.leaseToken, settlement.processIdentity, settlement.settlementCallId, settlement.outputDigest),
    taskId: task.taskId,
    taskGeneration: task.taskGeneration,
    attemptId: lease.attemptId,
    leaseToken: lease.leaseToken,
    settlement
  });
  current = appendCanonical(dependencies.journal, plan, fact).projection;
  try { validateSettlement(settlement, exactProcessIdentity); }
  catch (error) {
    markLeaseUncertain(dependencies, plan, task, current, lease, "SETTLEMENT_UNKNOWN");
    throw error;
  }
  return current;
}

async function runIntegration(
  dependencies: MultiRepositoryOrchestrationDependencies,
  plan: MaterializedMultiRepositoryRunPlanV1,
  task: MaterializedMultiRepositoryTaskV1,
  lease: SchedulerLeaseV1,
  execution: MultiRepositoryTaskExecutionV1,
  worktree: MultiRepositoryCanonicalWorktreeFactV1,
  projection: MultiRepositoryCanonicalProjectionV1
): Promise<Readonly<{ canonical: MultiRepositoryCanonicalProjectionV1; integration: MultiRepoIntegrationProjectionV1; authority: MultiRepositoryIntegrationAuthorityHandle }>> {
  const requestedPlan = integrationPlan(plan, task, execution, lease, worktree, projection);
  const sortedIds = requestedPlan.entries.map((entry) => entry.repository.repositoryId);
  const authority = await dependencies.integrationAuthority.acquire(sortedIds, {
    runId: plan.runId,
    runEpoch: plan.runEpoch,
    taskId: task.taskId,
    taskGeneration: task.taskGeneration,
    leaseToken: lease.leaseToken
  });
  let current = projection;
  let integration = current.integrations[requestedPlan.transactionId];
  if (integration === undefined) {
    current = appendCanonical(dependencies.journal, plan, integrationFact(task, lease, createMultiRepoIntegrationEvent(requestedPlan))).projection;
    integration = current.integrations[requestedPlan.transactionId]!;
  } else if (digest("relayforge-multirepo-integration-plan-v1", integration.plan) !== digest("relayforge-multirepo-integration-plan-v1", requestedPlan)) {
    throw new MultiRepositoryOrchestrationError("CANONICAL_IDENTITY_MISMATCH", "persisted integration plan differs from the current candidate vector", true);
  }
  for (let transition = 0; transition < MULTIREPO_ORCHESTRATION_LIMITS.maximumTransitionsPerTask; transition += 1) {
    if (["applied", "compensated", "recovery_required"].includes(integration.state)) return Object.freeze({ canonical: current, integration, authority });
    const event = await reconcileMultiRepoIntegrationOnce(integration, { ...dependencies.integration, authority });
    if (event === undefined) return Object.freeze({ canonical: current, integration, authority });
    current = appendCanonical(dependencies.journal, plan, integrationFact(task, lease, event)).projection;
    integration = current.integrations[requestedPlan.transactionId]!;
  }
  throw new MultiRepositoryOrchestrationError("INTEGRATION_RECOVERY_REQUIRED", "integration transition bound was exceeded", true);
}

async function runPublication(
  dependencies: MultiRepositoryOrchestrationDependencies,
  plan: MaterializedMultiRepositoryRunPlanV1,
  task: MaterializedMultiRepositoryTaskV1,
  publicationPlanValue: MultiRepoPublicationPlanV1,
  projection: MultiRepositoryCanonicalProjectionV1
): Promise<Readonly<{ canonical: MultiRepositoryCanonicalProjectionV1; publication: MultiRepoPublicationProjectionV1 }>> {
  if (dependencies.publicationAdapter === undefined) throw new MultiRepositoryOrchestrationError("PUBLICATION_RECOVERY_REQUIRED", "publication was requested but no canonical SCM publication adapter is attached", true);
  let current = projection;
  let publication = current.publications[publicationPlanValue.transactionId];
  if (publication === undefined) {
    current = appendCanonical(dependencies.journal, plan, publicationFact(task, createMultiRepoPublicationEvent(publicationPlanValue))).projection;
    publication = current.publications[publicationPlanValue.transactionId]!;
  } else if (
    digest("relayforge-multirepo-publication-plan-v1", publication.plan) !==
    digest("relayforge-multirepo-publication-plan-v1", publicationPlanValue)
  ) {
    throw new MultiRepositoryOrchestrationError(
      "CANONICAL_IDENTITY_MISMATCH",
      "persisted publication plan differs from the exact local-integration receipt and reviewed publication policy",
      true
    );
  }
  for (let transition = 0; transition < MULTIREPO_ORCHESTRATION_LIMITS.maximumTransitionsPerTask; transition += 1) {
    if (["published", "recovery_required"].includes(publication.state)) return Object.freeze({ canonical: current, publication });
    const event = await reconcileMultiRepoPublicationOnce(publication, dependencies.publicationAdapter);
    if (event === undefined) return Object.freeze({ canonical: current, publication });
    current = appendCanonical(dependencies.journal, plan, publicationFact(task, event)).projection;
    publication = current.publications[publicationPlanValue.transactionId]!;
    if (event.type === "publication.retryable_failure") return Object.freeze({ canonical: current, publication });
  }
  throw new MultiRepositoryOrchestrationError("PUBLICATION_RECOVERY_REQUIRED", "publication transition bound was exceeded", true);
}

function appliedIntegrationForReceipt(
  task: MaterializedMultiRepositoryTaskV1,
  receipt: MultiRepositoryCanonicalLocalReceiptFactV1,
  projection: MultiRepositoryCanonicalProjectionV1,
  lease?: SchedulerLeaseV1
): MultiRepoIntegrationProjectionV1 {
  const integration = projection.integrations[receipt.transactionId];
  if (
    receipt.taskId !== task.taskId || receipt.taskGeneration !== task.taskGeneration ||
    receipt.repositorySetId !== task.repositorySet.repositorySetId ||
    (lease !== undefined && receipt.leaseToken !== lease.leaseToken) ||
    integration === undefined || integration.state !== "applied" ||
    integration.repositorySetId !== receipt.repositorySetId ||
    integration.verification?.receiptDigest !== receipt.verificationReceiptDigest
  ) {
    throw new MultiRepositoryOrchestrationError(
      "CANONICAL_HISTORY_CORRUPT",
      `task ${task.taskId} local-integration receipt is not fenced by its exact task, lease, repository set, and applied verification`,
      true
    );
  }
  return integration;
}

function publicationCompletionEvidenceDigest(
  receipt: MultiRepositoryCanonicalLocalReceiptFactV1,
  publication: MultiRepoPublicationProjectionV1
): string {
  if (publication.state !== "published" || publication.plan.localIntegrationReceiptDigest !== receipt.receiptDigest) {
    throw new MultiRepositoryOrchestrationError(
      "PUBLICATION_RECOVERY_REQUIRED",
      "scheduler completion requires a terminal publication bound to the exact local-integration receipt",
      true
    );
  }
  return digest("relayforge-multirepo-task-publication-completion-v1", {
    localIntegrationReceiptDigest: receipt.receiptDigest,
    publication
  });
}

function releaseLeaseEvent(
  projection: MultiRepositoryCanonicalProjectionV1,
  task: MaterializedMultiRepositoryTaskV1,
  lease: SchedulerLeaseV1,
  outcome: "completed" | "retry" | "cancelled" | "failed",
  evidenceDigest: string,
  occurredAt: string
): MultiRepoSchedulerEventV1 {
  const current = projection.scheduler.tasks[task.taskId]!;
  return Object.freeze({
    ...schedulerEventBase(projection.scheduler, task, "release", occurredAt),
    type: "scheduler.lease_released" as const,
    expectedVersion: current.version,
    leaseToken: lease.leaseToken,
    outcome,
    evidenceDigest
  });
}

async function finishIntegratedTask(
  dependencies: MultiRepositoryOrchestrationDependencies,
  plan: MaterializedMultiRepositoryRunPlanV1,
  task: MaterializedMultiRepositoryTaskV1,
  execution: MultiRepositoryTaskExecutionV1,
  lease: SchedulerLeaseV1,
  worktree: MultiRepositoryCanonicalWorktreeFactV1,
  receipt: MultiRepositoryCanonicalLocalReceiptFactV1,
  integration: MultiRepoIntegrationProjectionV1,
  projection: MultiRepositoryCanonicalProjectionV1,
  heldAuthority?: MultiRepositoryIntegrationAuthorityHandle
): Promise<Readonly<{ canonical: MultiRepositoryCanonicalProjectionV1; outcome: MultiRepositoryTaskOutcomeV1 }>> {
  let current = projection;
  const repositoryIds = Object.freeze(integration.entries
    .map((entry) => entry.plan.repository.repositoryId)
    .sort((left, right) => left.localeCompare(right)));

  if (worktree.state !== "reclaimed") {
    // A restart may observe the durable local receipt before the prior parent released its Git
    // integration locks. Re-acquisition is the proof that the predecessor is gone; it also reclaims
    // only stale, identity-pinned locks. No provider or parent Git mutation occurs before this gate.
    const authority = heldAuthority ?? await dependencies.integrationAuthority.acquire(repositoryIds, {
      runId: plan.runId,
      runEpoch: plan.runEpoch,
      taskId: task.taskId,
      taskGeneration: task.taskGeneration,
      leaseToken: lease.leaseToken
    });
    authority.assertHeld(repositoryIds);
    await authority.release();

    const options = worktreeOptions(plan, task, execution, lease);
    const durableWorktreeReceipt = readWorktreeGroupReceipt(worktree.groupRoot);
    const reclaimed = reclaimWorktreeGroup({ ...options, fault: undefined });
    if (durableWorktreeReceipt.receiptDigest !== worktree.receiptDigest || reclaimed.status !== "reclaimed") {
      current = appendCanonical(dependencies.journal, plan, worktreeFact(task, lease, reclaimed)).projection;
      return Object.freeze({ canonical: current, outcome: Object.freeze({
        taskId: task.taskId,
        taskGeneration: task.taskGeneration,
        state: "recovery_required",
        transactionId: integration.transactionId,
        localIntegrationReceiptDigest: receipt.receiptDigest,
        reason: reclaimed.issues.map((issue) => issue.code).join(",") || "WORKTREE_RECLAIM_UNCERTAIN"
      }) });
    }
    current = appendCanonical(dependencies.journal, plan, worktreeFact(task, lease, reclaimed)).projection;
  } else if (heldAuthority !== undefined) {
    heldAuthority.assertHeld(repositoryIds);
    await heldAuthority.release();
  }

  const publicationPlanValue = publicationPlan(task, execution, receipt, integration);
  if (publicationPlanValue === undefined) {
    current = appendScheduler(dependencies, plan, releaseLeaseEvent(
      current,
      task,
      lease,
      "completed",
      receipt.receiptDigest,
      boundedTimestamp((dependencies.now ?? (() => new Date()))())
    ));
    return Object.freeze({ canonical: current, outcome: Object.freeze({
      taskId: task.taskId,
      taskGeneration: task.taskGeneration,
      state: "applied",
      transactionId: integration.transactionId,
      localIntegrationReceiptDigest: receipt.receiptDigest
    }) });
  }

  const publicationResult = await runPublication(dependencies, plan, task, publicationPlanValue, current);
  current = publicationResult.canonical;
  if (publicationResult.publication.state === "published") {
    current = appendScheduler(dependencies, plan, releaseLeaseEvent(
      current,
      task,
      lease,
      "completed",
      publicationCompletionEvidenceDigest(receipt, publicationResult.publication),
      boundedTimestamp((dependencies.now ?? (() => new Date()))())
    ));
    return Object.freeze({ canonical: current, outcome: Object.freeze({
      taskId: task.taskId,
      taskGeneration: task.taskGeneration,
      state: "published",
      transactionId: integration.transactionId,
      localIntegrationReceiptDigest: receipt.receiptDigest
    }) });
  }
  return Object.freeze({ canonical: current, outcome: Object.freeze({
    taskId: task.taskId,
    taskGeneration: task.taskGeneration,
    state: publicationResult.publication.state === "partial" ? "publication_partial" : "recovery_required",
    transactionId: integration.transactionId,
    localIntegrationReceiptDigest: receipt.receiptDigest,
    reason: publicationResult.publication.recoveryReason ?? publicationResult.publication.state
  }) });
}

async function executeTask(
  dependencies: MultiRepositoryOrchestrationDependencies,
  plan: MaterializedMultiRepositoryRunPlanV1,
  task: MaterializedMultiRepositoryTaskV1,
  initial: MultiRepositoryCanonicalProjectionV1
): Promise<Readonly<{ canonical: MultiRepositoryCanonicalProjectionV1; outcome: MultiRepositoryTaskOutcomeV1 }>> {
  let current = admitTask(dependencies, plan, task, initial);
  let scheduled = current.scheduler.tasks[task.taskId]!;
  const execution = executionById(plan, task.taskId);
  if (scheduled.state === "completed") {
    const receipt = current.localReceipts[task.taskId];
    if (receipt === undefined) {
      throw new MultiRepositoryOrchestrationError("CANONICAL_HISTORY_CORRUPT", `completed task ${task.taskId} has no local-integration receipt`, true);
    }
    const integration = appliedIntegrationForReceipt(task, receipt, current);
    const requestedPublication = publicationPlan(task, execution, receipt, integration);
    if (requestedPublication === undefined) {
      return Object.freeze({ canonical: current, outcome: Object.freeze({ taskId: task.taskId, taskGeneration: task.taskGeneration, state: "applied", transactionId: receipt.transactionId, localIntegrationReceiptDigest: receipt.receiptDigest }) });
    }
    const publication = current.publications[requestedPublication.transactionId];
    if (
      publication?.state !== "published" ||
      digest("relayforge-multirepo-publication-plan-v1", publication.plan) !==
      digest("relayforge-multirepo-publication-plan-v1", requestedPublication)
    ) {
      throw new MultiRepositoryOrchestrationError(
        "CANONICAL_HISTORY_CORRUPT",
        `completed task ${task.taskId} does not have its exact terminal publication`,
        true
      );
    }
    return Object.freeze({ canonical: current, outcome: Object.freeze({ taskId: task.taskId, taskGeneration: task.taskGeneration, state: "published", transactionId: receipt.transactionId, localIntegrationReceiptDigest: receipt.receiptDigest }) });
  }
  let lease = scheduled.lease;
  if (lease === undefined || lease.state === "uncertain") throw new MultiRepositoryOrchestrationError("ADMISSION_REFUSED", `task ${task.taskId} does not hold an exact live lease`, true);
  if (
    lease.processIdentity === undefined &&
    (lease.ownerId !== dependencies.ownerId || lease.ownerIncarnation !== dependencies.ownerIncarnation)
  ) {
    const unspawned = await dependencies.worker.proveUnspawned?.(workerRequest(plan, task, lease));
    if (unspawned !== true) {
      markLeaseUncertain(dependencies, plan, task, current, lease, "PROCESS_IDENTITY_UNKNOWN");
      throw new MultiRepositoryOrchestrationError("WORKER_RECOVERY_REQUIRED", `prior admitted lease for ${task.taskId} cannot be proven unspawned`, true);
    }
    current = appendScheduler(dependencies, plan, releaseLeaseEvent(
      current,
      task,
      lease,
      "retry",
      digest("relayforge-unspawned-lease-proof-v1", [lease.leaseToken, lease.ownerId, lease.ownerIncarnation]),
      boundedTimestamp((dependencies.now ?? (() => new Date()))())
    ));
    current = admitTask(dependencies, plan, task, current);
    scheduled = current.scheduler.tasks[task.taskId]!;
    lease = scheduled.lease;
    if (lease === undefined || lease.state === "uncertain") throw new MultiRepositoryOrchestrationError("ADMISSION_REFUSED", `replacement lease for ${task.taskId} was not durably admitted`, true);
  }
  const options = worktreeOptions(plan, task, execution, lease);
  const persistedReceipt = current.localReceipts[task.taskId];
  if (persistedReceipt !== undefined) {
    const integration = appliedIntegrationForReceipt(task, persistedReceipt, current, lease);
    const worktree = current.worktreeGroups[task.taskId];
    if (
      worktree === undefined || worktree.taskGeneration !== task.taskGeneration ||
      worktree.leaseToken !== lease.leaseToken || worktree.repositorySetId !== task.repositorySet.repositorySetId
    ) {
      throw new MultiRepositoryOrchestrationError("CANONICAL_HISTORY_CORRUPT", `task ${task.taskId} local receipt has no exact worktree lifecycle`, true);
    }
    return finishIntegratedTask(dependencies, plan, task, execution, lease, worktree, persistedReceipt, integration, current);
  }
  let worktree = current.worktreeGroups[task.taskId];
  if (worktree === undefined) {
    const result = prepareWorktreeGroup(options);
    current = appendCanonical(dependencies.journal, plan, worktreeFact(task, lease, result)).projection;
    worktree = current.worktreeGroups[task.taskId]!;
    if (result.status !== "ready") return Object.freeze({ canonical: current, outcome: Object.freeze({ taskId: task.taskId, taskGeneration: task.taskGeneration, state: "recovery_required", reason: result.issues.map((issue) => issue.code).join(",") || "WORKTREE_RECOVERY_REQUIRED" }) });
  } else {
    assertExactReadyGroup(worktree);
  }
  current = await ensureWorkerSettled(dependencies, plan, task, lease, worktree, current);
  for (const member of worktree.members) {
    current = ensureCommitIntent(dependencies, plan, task, execution, lease, member, current);
    current = ensureHeadRecorded(dependencies, plan, task, lease, member, current);
  }
  const integrationResult = await runIntegration(dependencies, plan, task, lease, execution, worktree, current);
  current = integrationResult.canonical;
  const integration = integrationResult.integration;
  if (integration.state !== "applied") {
    if (integration.state === "compensated") await integrationResult.authority.release();
    return Object.freeze({ canonical: current, outcome: Object.freeze({ taskId: task.taskId, taskGeneration: task.taskGeneration, state: "recovery_required", transactionId: integration.transactionId, reason: integration.recoveryReason ?? integration.state }) });
  }
  const existingReceipt = current.localReceipts[task.taskId];
  const receipt = existingReceipt ?? localReceiptFact(task, lease, integration);
  if (existingReceipt === undefined) current = appendCanonical(dependencies.journal, plan, receipt).projection;
  return finishIntegratedTask(dependencies, plan, task, execution, lease, worktree, receipt, integration, current, integrationResult.authority);
}

/**
 * Compose P6 under one already-open canonical writer. This function never opens SQLite, launches a
 * process except through the injected contained worker/verifier, scans for repositories, or moves
 * an integration ref before a durable verified vector exists.
 */
export async function runMultiRepositoryOrchestration(
  request: MultiRepositoryRunRequestV1,
  dependencies: MultiRepositoryOrchestrationDependencies
): Promise<MultiRepositoryRunOutcomeV1> {
  const plan = materializeMultiRepositoryRunPlan(request, dependencies.resolveRepositoryIdentity);
  if (readCanonical(dependencies.journal, plan).projection.plan === undefined) assertInitialIntegrationTargets(plan);
  let projection = registerPlanAndTasks(dependencies, plan);
  if (!request.execute) {
    return Object.freeze({
      schemaVersion: 1,
      runId: plan.runId,
      runEpoch: plan.runEpoch,
      planDigest: plan.planDigest,
      state: "planned",
      tasks: Object.freeze(orderedTasks(plan).map((task) => Object.freeze({ taskId: task.taskId, taskGeneration: task.taskGeneration, state: "planned" as const })))
    });
  }
  // The reviewed plan and scheduler tasks are canonical before the first P6 filesystem mutation.
  ensurePrivateWorkspace(plan.workspaceRoot);
  const outcomes: MultiRepositoryTaskOutcomeV1[] = [];
  for (const task of orderedTasks(plan)) {
    const result = await executeTask(dependencies, plan, task, projection);
    projection = result.canonical;
    outcomes.push(result.outcome);
    if (result.outcome.state === "recovery_required" || result.outcome.state === "publication_partial") {
      return Object.freeze({
        schemaVersion: 1,
        runId: plan.runId,
        runEpoch: plan.runEpoch,
        planDigest: plan.planDigest,
        state: result.outcome.state === "recovery_required" ? "recovery_required" : "blocked",
        tasks: Object.freeze(outcomes),
        reason: result.outcome.reason ?? result.outcome.state
      });
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    runId: plan.runId,
    runEpoch: plan.runEpoch,
    planDigest: plan.planDigest,
    state: "done",
    tasks: Object.freeze(outcomes)
  });
}

/** Test/support helper for exact worker manifests; source roots are intentionally absent. */
export function authorizedWorkerMembers(
  members: readonly ReadyWorktreeGroupMember[]
): readonly MultiRepositoryWorkerMemberV1[] {
  return Object.freeze(members.map((member) => Object.freeze({
    repositoryId: member.repositoryId,
    path: member.path,
    branch: member.branch,
    anchorOid: member.anchorOid
  })));
}

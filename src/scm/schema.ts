import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../control/events.js";
import {
  SCM_PROVIDER_LIMITS,
  SCM_SCHEMA_VERSION,
  scmCapabilityNames,
  scmCheckBuckets,
  scmCiStates,
  scmCompletenessKinds,
  scmEvidenceKinds,
  scmMergeabilityStates,
  scmProviderKinds,
  scmReviewDecisions,
  type ScmBucketMetaV1,
  type ScmCiFactV1,
  type ScmEvidenceV1,
  type ScmFactBucketV1,
  type ScmMergeabilityFactV1,
  type ScmNormalizedCheckV1,
  type ScmProviderFailureV1,
  type ScmProviderLimitsV1,
  type ScmPublicationIntentV1,
  type ScmPullRequestFactV1,
  type ScmPullRequestIdentityV1,
  type ScmRepositoryIdV1,
  type ScmReviewFactV1
} from "./types.js";

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const boundedIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const repositoryPartPattern = /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/u;
const remoteNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const objectIdPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const hostPattern = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;

export const ScmBoundedIdSchema = z.string().regex(boundedIdPattern);
export const ScmDigestSchema = z.string().regex(sha256Pattern);
export const ScmObjectIdSchema = z.string().regex(objectIdPattern, "Git object ID must be 40 or 64 lowercase hexadecimal characters");
export const ScmPositiveIntegerSchema = z.number().int().min(1).max(MAX_SAFE);
export const ScmNonNegativeIntegerSchema = z.number().int().min(0).max(MAX_SAFE);
export const ScmCanonicalTimestampSchema = z.string().superRefine((value, context) => {
  if (!value.endsWith("Z") || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "timestamp must be canonical UTC" });
  }
});

export function canonicalizeScmHost(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError("SCM host must be a non-empty unpadded string");
  }
  if (!hostPattern.test(value)) throw new TypeError("SCM host must be a canonical lowercase DNS authority without a port or path");
  let parsed: URL;
  try {
    parsed = new URL(`https://${value}/`);
  } catch {
    throw new TypeError("SCM host is invalid");
  }
  if (parsed.hostname !== value || parsed.host !== value || parsed.username || parsed.password || parsed.port) {
    throw new TypeError("SCM host is not canonical");
  }
  return value;
}

export const ScmCanonicalHostSchema = z.string().superRefine((value, context) => {
  try { canonicalizeScmHost(value); } catch (error) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: (error as Error).message });
  }
});

export function isValidScmBranchRef(value: string): boolean {
  if (!value.startsWith("refs/heads/") || value.length > 512) return false;
  const branch = value.slice("refs/heads/".length);
  if (!branch || branch.startsWith("/") || branch.endsWith("/") || branch.startsWith(".") || branch.endsWith(".")) return false;
  if (branch.includes("//") || branch.includes("..") || branch.includes("@{") || branch.endsWith(".lock")) return false;
  if (/[\x00-\x20\x7f~^:?*\\[]/u.test(branch)) return false;
  return branch.split("/").every((component) => component.length > 0 && !component.startsWith(".") && !component.endsWith("."));
}

export const ScmBranchRefSchema = z.string().superRefine((value, context) => {
  if (!isValidScmBranchRef(value)) context.addIssue({ code: z.ZodIssueCode.custom, message: "branch ref is not a canonical refs/heads/... ref" });
});

export const ScmRepositoryIdV1Schema = z.strictObject({
  schemaVersion: z.literal(SCM_SCHEMA_VERSION),
  provider: z.enum(scmProviderKinds),
  canonicalHost: ScmCanonicalHostSchema,
  owner: z.string().regex(repositoryPartPattern),
  name: z.string().regex(repositoryPartPattern)
});

const remoteExpectationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("absent") }),
  z.strictObject({ kind: z.literal("oid"), oid: ScmObjectIdSchema })
]);

export const ScmPublicationIntentV1Schema = z.strictObject({
  schemaVersion: z.literal(SCM_SCHEMA_VERSION),
  publicationId: ScmBoundedIdSchema,
  publicationGeneration: ScmPositiveIntegerSchema,
  attempt: ScmPositiveIntegerSchema,
  runId: ScmBoundedIdSchema,
  runEpoch: ScmBoundedIdSchema,
  repository: ScmRepositoryIdV1Schema,
  integrationRef: ScmBranchRefSchema,
  integrationOid: ScmObjectIdSchema,
  localExpectedOid: ScmObjectIdSchema,
  remoteName: z.string().regex(remoteNamePattern),
  remoteRef: ScmBranchRefSchema,
  expectedRemote: remoteExpectationSchema,
  baseRepository: ScmRepositoryIdV1Schema,
  baseRef: ScmBranchRefSchema,
  titleSha256: ScmDigestSchema,
  bodySha256: ScmDigestSchema,
  draft: z.boolean(),
  createdAt: ScmCanonicalTimestampSchema
}).superRefine((intent, context) => {
  if (intent.integrationOid !== intent.localExpectedOid) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["localExpectedOid"], message: "local ref expectation must equal the reviewed integration OID" });
  }
  if (intent.remoteRef === intent.baseRef && scmRepositoryKey(intent.repository) === scmRepositoryKey(intent.baseRepository)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["remoteRef"], message: "publication head and base refs must differ" });
  }
});

const pullRequestIdentityShape = {
  providerId: ScmBoundedIdSchema,
  number: ScmPositiveIntegerSchema,
  url: z.string().url().max(4_096),
  repository: ScmRepositoryIdV1Schema,
  headRepository: ScmRepositoryIdV1Schema,
  headRef: ScmBranchRefSchema,
  headSha: ScmObjectIdSchema,
  baseRepository: ScmRepositoryIdV1Schema,
  baseRef: ScmBranchRefSchema,
  baseSha: ScmObjectIdSchema
};

export const ScmPullRequestIdentityV1Schema = z.strictObject(pullRequestIdentityShape).superRefine((pullRequest, context) => {
  try {
    parseScmHttpsUrl(pullRequest.url, pullRequest.repository.canonicalHost);
  } catch (error) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: (error as Error).message });
  }
});

export const ScmPullRequestFactV1Schema = z.strictObject({
  ...pullRequestIdentityShape,
  lifecycle: z.enum(["open", "closed", "merged"]),
  draft: z.boolean(),
  resourceVersion: z.string().min(1).max(512).optional()
}).superRefine((pullRequest, context) => {
  try { parseScmHttpsUrl(pullRequest.url, pullRequest.repository.canonicalHost); } catch (error) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: (error as Error).message });
  }
  if (pullRequest.lifecycle !== "open" && pullRequest.draft) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["draft"], message: "a terminal pull request cannot remain draft" });
  }
});

export const ScmNormalizedCheckV1Schema = z.strictObject({
  key: ScmDigestSchema,
  providerCheckId: ScmBoundedIdSchema,
  providerRunId: ScmBoundedIdSchema,
  name: z.string().min(1).max(512),
  workflow: z.string().min(1).max(512).optional(),
  event: z.string().min(1).max(128).optional(),
  required: z.boolean(),
  bucket: z.enum(scmCheckBuckets),
  status: z.string().min(1).max(128),
  conclusion: z.string().min(1).max(128).optional(),
  attempt: ScmPositiveIntegerSchema,
  startedAt: ScmCanonicalTimestampSchema,
  completedAt: ScmCanonicalTimestampSchema.optional(),
  url: z.string().url().max(4_096).optional(),
  detail: z.string().max(4_096).optional()
}).superRefine((check, context) => {
  if (check.detail !== undefined && Buffer.byteLength(check.detail, "utf8") > 4_096) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["detail"], message: "check detail exceeds 4096 UTF-8 bytes" });
  }
});

export const ScmCiFactV1Schema = z.strictObject({
  state: z.enum(scmCiStates),
  checks: z.array(ScmNormalizedCheckV1Schema).max(SCM_PROVIDER_LIMITS.maxItemsPerEndpoint),
  requiredCheckCount: ScmNonNegativeIntegerSchema,
  failureFingerprint: ScmDigestSchema.optional(),
  conflicts: z.array(ScmDigestSchema).max(SCM_PROVIDER_LIMITS.maxItemsPerEndpoint)
}).superRefine((facts, context) => {
  const keys = facts.checks.map((check) => check.key);
  if (new Set(keys).size !== keys.length || keys.some((key, index) => index > 0 && keys[index - 1]! > key)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["checks"], message: "checks must have unique keys in canonical order" });
  }
  if (facts.requiredCheckCount !== facts.checks.filter((check) => check.required).length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["requiredCheckCount"], message: "required check count disagrees with checks" });
  }
  if (new Set(facts.conflicts).size !== facts.conflicts.length || facts.conflicts.some((key, index) => index > 0 && facts.conflicts[index - 1]! > key)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["conflicts"], message: "check conflicts must be unique and canonically ordered" });
  }
  if ((facts.state === "failing") !== (facts.failureFingerprint !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["failureFingerprint"], message: "failure fingerprint must exist exactly for failing CI" });
  }
});

export const ScmEvidenceV1Schema = z.strictObject({
  evidenceId: ScmDigestSchema,
  providerEvidenceId: ScmBoundedIdSchema,
  kind: z.enum(scmEvidenceKinds),
  authorKind: z.enum(["human", "bot", "unknown"]),
  authorId: ScmBoundedIdSchema,
  createdAt: ScmCanonicalTimestampSchema,
  updatedAt: ScmCanonicalTimestampSchema,
  resolved: z.boolean(),
  selected: z.boolean(),
  body: z.string().max(SCM_PROVIDER_LIMITS.maxEvidenceBodyBytes),
  bodySha256: ScmDigestSchema,
  originalBytes: ScmNonNegativeIntegerSchema,
  retainedBytes: ScmNonNegativeIntegerSchema,
  truncated: z.boolean(),
  sanitized: z.boolean(),
  url: z.string().url().max(4_096).optional()
}).superRefine((evidence, context) => {
  const bytes = Buffer.byteLength(evidence.body, "utf8");
  if (bytes > SCM_PROVIDER_LIMITS.maxEvidenceBodyBytes) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["body"], message: "evidence body exceeds its UTF-8 byte ceiling" });
  }
  if (bytes !== evidence.retainedBytes) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["retainedBytes"], message: "retained byte count disagrees with evidence body" });
  }
  const digest = createHash("sha256").update(evidence.body, "utf8").digest("hex");
  if (digest !== evidence.bodySha256) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["bodySha256"], message: "evidence body digest disagrees with retained text" });
  }
  if (Date.parse(evidence.updatedAt) < Date.parse(evidence.createdAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["updatedAt"], message: "evidence update precedes creation" });
  }
});

export const ScmReviewFactV1Schema = z.strictObject({
  decision: z.enum(scmReviewDecisions),
  humanApprovals: ScmNonNegativeIntegerSchema,
  evidence: z.array(ScmEvidenceV1Schema).max(SCM_PROVIDER_LIMITS.maxItemsPerEndpoint),
  unresolvedSelectedEvidenceIds: z.array(ScmDigestSchema).max(SCM_PROVIDER_LIMITS.maxItemsPerEndpoint),
  conflicts: z.array(ScmDigestSchema).max(SCM_PROVIDER_LIMITS.maxItemsPerEndpoint)
}).superRefine((facts, context) => {
  const evidenceIds = facts.evidence.map((evidence) => evidence.evidenceId);
  if (new Set(evidenceIds).size !== evidenceIds.length || evidenceIds.some((id, index) => index > 0 && evidenceIds[index - 1]! > id)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["evidence"], message: "evidence must have unique IDs in canonical order" });
  }
  const expectedUnresolved = facts.evidence
    .filter((evidence) => evidence.selected && !evidence.resolved && evidence.authorKind === "human")
    .map((evidence) => evidence.evidenceId)
    .sort();
  if (canonicalJson(expectedUnresolved) !== canonicalJson(facts.unresolvedSelectedEvidenceIds)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["unresolvedSelectedEvidenceIds"], message: "unresolved evidence index disagrees with evidence facts" });
  }
  if (new Set(facts.conflicts).size !== facts.conflicts.length || facts.conflicts.some((id, index) => index > 0 && facts.conflicts[index - 1]! > id)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["conflicts"], message: "review conflicts must be unique and canonically ordered" });
  }
});

export const ScmMergeabilityFactV1Schema = z.strictObject({
  state: z.enum(scmMergeabilityStates),
  blockers: z.array(ScmBoundedIdSchema).max(128)
}).superRefine((facts, context) => {
  if (new Set(facts.blockers).size !== facts.blockers.length || facts.blockers.some((id, index) => index > 0 && facts.blockers[index - 1]! > id)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["blockers"], message: "mergeability blockers must be unique and canonically ordered" });
  }
});

export const ScmBucketMetaV1Schema = z.strictObject({
  completeness: z.enum(scmCompletenessKinds),
  observedHeadSha: ScmObjectIdSchema,
  observedAt: ScmCanonicalTimestampSchema,
  freshUntil: ScmCanonicalTimestampSchema,
  semanticHash: ScmDigestSchema,
  guard: z.string().min(1).max(1_024).optional(),
  cursor: z.string().min(1).max(1_024).optional()
}).superRefine((meta, context) => {
  if (Date.parse(meta.freshUntil) < Date.parse(meta.observedAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["freshUntil"], message: "freshness deadline precedes observation" });
  }
});

export const ScmProviderLimitsV1Schema = z.strictObject({
  requestTimeoutMs: z.number().int().min(1).max(SCM_PROVIDER_LIMITS.requestTimeoutMs),
  maxPagesPerEndpoint: z.number().int().min(1).max(SCM_PROVIDER_LIMITS.maxPagesPerEndpoint),
  maxItemsPerPage: z.number().int().min(1).max(SCM_PROVIDER_LIMITS.maxItemsPerPage),
  maxItemsPerEndpoint: z.number().int().min(1).max(SCM_PROVIDER_LIMITS.maxItemsPerEndpoint),
  maxDecodedBytesPerRequest: z.number().int().min(1).max(SCM_PROVIDER_LIMITS.maxDecodedBytesPerRequest),
  maxDecodedBytesPerPoll: z.number().int().min(1).max(SCM_PROVIDER_LIMITS.maxDecodedBytesPerPoll),
  maxEvidenceBodyBytes: z.number().int().min(1).max(SCM_PROVIDER_LIMITS.maxEvidenceBodyBytes),
  maxEvidencePreviewBytes: z.number().int().min(1).max(SCM_PROVIDER_LIMITS.maxEvidencePreviewBytes),
  maxFailureLogBytes: z.number().int().min(1).max(SCM_PROVIDER_LIMITS.maxFailureLogBytes),
  maxFailureLogsBytes: z.number().int().min(1).max(SCM_PROVIDER_LIMITS.maxFailureLogsBytes),
  maxConcurrentPerRepository: z.number().int().min(1).max(SCM_PROVIDER_LIMITS.maxConcurrentPerRepository),
  maxConcurrentPerRun: z.number().int().min(1).max(SCM_PROVIDER_LIMITS.maxConcurrentPerRun)
}).superRefine((limits, context) => {
  if (limits.maxItemsPerEndpoint > limits.maxPagesPerEndpoint * limits.maxItemsPerPage) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["maxItemsPerEndpoint"], message: "item ceiling exceeds the page budget" });
  }
  if (limits.maxDecodedBytesPerRequest > limits.maxDecodedBytesPerPoll) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["maxDecodedBytesPerRequest"], message: "request byte ceiling exceeds poll ceiling" });
  }
  if (limits.maxFailureLogBytes > limits.maxFailureLogsBytes) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["maxFailureLogBytes"], message: "single log ceiling exceeds aggregate log ceiling" });
  }
  if (limits.maxConcurrentPerRepository > limits.maxConcurrentPerRun) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["maxConcurrentPerRepository"], message: "repository concurrency exceeds run concurrency" });
  }
});

export const ScmProviderFailureV1Schema = z.strictObject({
  kind: z.enum(["cancelled", "timeout", "network", "rate_limited", "auth", "permission", "schema", "pagination", "budget_exceeded", "provider"]),
  retryable: z.boolean(),
  code: ScmBoundedIdSchema,
  diagnostic: z.string().max(4_096),
  nextEligibleAt: ScmCanonicalTimestampSchema.optional()
}).superRefine((failure, context) => {
  if (failure.kind === "rate_limited" && failure.nextEligibleAt === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["nextEligibleAt"], message: "rate-limit failures require durable eligibility time" });
  }
  if (["auth", "permission", "schema"].includes(failure.kind) && failure.retryable) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["retryable"], message: "auth, permission and schema failures cannot hot-loop" });
  }
});

export function parseScmRepositoryId(value: unknown): ScmRepositoryIdV1 {
  return ScmRepositoryIdV1Schema.parse(value) as ScmRepositoryIdV1;
}

export function parseScmPublicationIntent(value: unknown): ScmPublicationIntentV1 {
  return ScmPublicationIntentV1Schema.parse(value) as ScmPublicationIntentV1;
}

export function parseScmPullRequestIdentity(value: unknown): ScmPullRequestIdentityV1 {
  return ScmPullRequestIdentityV1Schema.parse(value) as ScmPullRequestIdentityV1;
}

export function parseScmPullRequestFact(value: unknown): ScmPullRequestFactV1 {
  return ScmPullRequestFactV1Schema.parse(value) as ScmPullRequestFactV1;
}

export function parseScmBucketMeta(value: unknown): ScmBucketMetaV1 {
  return ScmBucketMetaV1Schema.parse(value) as ScmBucketMetaV1;
}

export function parseScmProviderLimits(value: unknown): ScmProviderLimitsV1 {
  return ScmProviderLimitsV1Schema.parse(value) as ScmProviderLimitsV1;
}

export function parseScmProviderFailure(value: unknown): ScmProviderFailureV1 {
  return ScmProviderFailureV1Schema.parse(value) as ScmProviderFailureV1;
}

export function parseScmCiFact(value: unknown): ScmCiFactV1 {
  return ScmCiFactV1Schema.parse(value) as ScmCiFactV1;
}

export function parseScmReviewFact(value: unknown): ScmReviewFactV1 {
  return ScmReviewFactV1Schema.parse(value) as ScmReviewFactV1;
}

export function parseScmMergeabilityFact(value: unknown): ScmMergeabilityFactV1 {
  return ScmMergeabilityFactV1Schema.parse(value) as ScmMergeabilityFactV1;
}

export function parseScmNormalizedCheck(value: unknown): ScmNormalizedCheckV1 {
  return ScmNormalizedCheckV1Schema.parse(value) as ScmNormalizedCheckV1;
}

export function parseScmEvidence(value: unknown): ScmEvidenceV1 {
  return ScmEvidenceV1Schema.parse(value) as ScmEvidenceV1;
}

export function parseScmFactBucket<T>(value: unknown, factSchema: z.ZodType<T>): ScmFactBucketV1<T> {
  const parsed = z.strictObject({ meta: ScmBucketMetaV1Schema, facts: factSchema }).parse(value) as ScmFactBucketV1<T>;
  if (parsed.meta.semanticHash !== scmSemanticDigest(parsed.facts)) {
    throw new TypeError("SCM fact bucket semantic hash disagrees with normalized facts");
  }
  return parsed;
}

export function materializeScmFactBucket<T>(input: Readonly<{
  completeness: ScmBucketMetaV1["completeness"];
  observedHeadSha: string;
  observedAt: string;
  freshUntil: string;
  facts: unknown;
  guard?: string;
  cursor?: string;
}>, factSchema: z.ZodType<T>): ScmFactBucketV1<T> {
  const facts = factSchema.parse(input.facts);
  return parseScmFactBucket({
    meta: {
      completeness: input.completeness,
      observedHeadSha: input.observedHeadSha,
      observedAt: input.observedAt,
      freshUntil: input.freshUntil,
      semanticHash: scmSemanticDigest(facts),
      ...(input.guard === undefined ? {} : { guard: input.guard }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor })
    },
    facts
  }, factSchema);
}

export function scmRepositoryKey(value: ScmRepositoryIdV1): string {
  const repository = ScmRepositoryIdV1Schema.parse(value);
  return `${repository.provider}:${repository.canonicalHost}/${repository.owner}/${repository.name}`;
}

export function sameScmRepository(left: ScmRepositoryIdV1, right: ScmRepositoryIdV1): boolean {
  return scmRepositoryKey(left) === scmRepositoryKey(right);
}

export function scmSemanticDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function parseScmHttpsUrl(value: string, canonicalHost: string): string {
  const host = canonicalizeScmHost(canonicalHost);
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new TypeError("SCM URL is invalid"); }
  if (parsed.protocol !== "https:" || parsed.hostname !== host || parsed.host !== host) {
    throw new TypeError("SCM URL must use HTTPS on the configured canonical host");
  }
  if (parsed.username || parsed.password || parsed.port || parsed.hash || parsed.search) {
    throw new TypeError("SCM URL must not contain credentials, a port, query or fragment");
  }
  if (!parsed.pathname.startsWith("/") || parsed.pathname.includes("//") || /[\x00-\x1f\x7f]/u.test(parsed.pathname)) {
    throw new TypeError("SCM URL path is not canonical");
  }
  const canonical = `https://${host}${parsed.pathname}`;
  if (value !== canonical) throw new TypeError("SCM URL must already be canonical");
  return canonical;
}

export function assertScmCapabilities(value: readonly string[]): readonly (typeof scmCapabilityNames)[number][] {
  const parsed = z.array(z.enum(scmCapabilityNames)).min(1).max(scmCapabilityNames.length).parse(value);
  if (new Set(parsed).size !== parsed.length) throw new TypeError("SCM capabilities must be unique");
  return Object.freeze([...parsed].sort());
}

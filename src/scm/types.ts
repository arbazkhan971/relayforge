/** Provider-neutral P3 SCM contracts. These values are data only; credentials are never represented. */

export const SCM_SCHEMA_VERSION = 1 as const;

export const scmProviderKinds = ["github"] as const;
export type ScmProviderKind = (typeof scmProviderKinds)[number];

export const scmCapabilityNames = ["scm.read", "scm.publish_branch", "scm.write_pr"] as const;
export type ScmCapabilityName = (typeof scmCapabilityNames)[number];

export const scmPublicationStates = [
  "unpublished",
  "push_intent",
  "push_ambiguous",
  "branch_published",
  "pr_intent",
  "pr_ambiguous",
  "published",
  "superseded",
  "refused"
] as const;
export type ScmPublicationState = (typeof scmPublicationStates)[number];

export const scmCiStates = ["unknown", "pending", "passing", "failing"] as const;
export type ScmCiState = (typeof scmCiStates)[number];

export const scmCheckBuckets = ["unknown", "pending", "passing", "failing", "skipping", "cancelled"] as const;
export type ScmCheckBucket = (typeof scmCheckBuckets)[number];

export const scmReviewDecisions = ["unknown", "pending", "approved", "changes_requested", "dismissed"] as const;
export type ScmReviewDecision = (typeof scmReviewDecisions)[number];

export const scmMergeabilityStates = ["unknown", "mergeable", "conflicting", "blocked", "unstable"] as const;
export type ScmMergeabilityState = (typeof scmMergeabilityStates)[number];

export const scmCompletenessKinds = ["complete", "partial"] as const;
export type ScmCompleteness = (typeof scmCompletenessKinds)[number];

export type ScmRepositoryIdV1 = Readonly<{
  schemaVersion: typeof SCM_SCHEMA_VERSION;
  provider: ScmProviderKind;
  canonicalHost: string;
  owner: string;
  name: string;
}>;

export type ScmRemoteExpectationV1 =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "oid"; oid: string }>;

export type ScmPublicationIntentV1 = Readonly<{
  schemaVersion: typeof SCM_SCHEMA_VERSION;
  publicationId: string;
  publicationGeneration: number;
  attempt: number;
  runId: string;
  runEpoch: string;
  repository: ScmRepositoryIdV1;
  integrationRef: string;
  integrationOid: string;
  localExpectedOid: string;
  remoteName: string;
  remoteRef: string;
  expectedRemote: ScmRemoteExpectationV1;
  baseRepository: ScmRepositoryIdV1;
  baseRef: string;
  titleSha256: string;
  bodySha256: string;
  draft: boolean;
  createdAt: string;
}>;

export type ScmPullRequestIdentityV1 = Readonly<{
  providerId: string;
  number: number;
  url: string;
  repository: ScmRepositoryIdV1;
  headRepository: ScmRepositoryIdV1;
  headRef: string;
  headSha: string;
  baseRepository: ScmRepositoryIdV1;
  baseRef: string;
  baseSha: string;
}>;

export type ScmPullRequestFactV1 = ScmPullRequestIdentityV1 & Readonly<{
  lifecycle: "open" | "closed" | "merged";
  draft: boolean;
  resourceVersion?: string;
}>;

export type ScmNormalizedCheckV1 = Readonly<{
  key: string;
  providerCheckId: string;
  providerRunId: string;
  name: string;
  workflow?: string;
  event?: string;
  required: boolean;
  bucket: ScmCheckBucket;
  status: string;
  conclusion?: string;
  attempt: number;
  startedAt: string;
  completedAt?: string;
  url?: string;
  detail?: string;
}>;

export type ScmCiFactV1 = Readonly<{
  state: ScmCiState;
  checks: readonly ScmNormalizedCheckV1[];
  requiredCheckCount: number;
  failureFingerprint?: string;
  conflicts: readonly string[];
}>;

export const scmEvidenceKinds = ["review_body", "review_thread", "inline_comment", "issue_comment", "check_log"] as const;
export type ScmEvidenceKind = (typeof scmEvidenceKinds)[number];

export type ScmEvidenceV1 = Readonly<{
  evidenceId: string;
  providerEvidenceId: string;
  kind: ScmEvidenceKind;
  authorKind: "human" | "bot" | "unknown";
  authorId: string;
  createdAt: string;
  updatedAt: string;
  resolved: boolean;
  selected: boolean;
  body: string;
  bodySha256: string;
  originalBytes: number;
  retainedBytes: number;
  truncated: boolean;
  sanitized: boolean;
  url?: string;
}>;

export type ScmReviewFactV1 = Readonly<{
  decision: ScmReviewDecision;
  humanApprovals: number;
  evidence: readonly ScmEvidenceV1[];
  unresolvedSelectedEvidenceIds: readonly string[];
  conflicts: readonly string[];
}>;

export type ScmMergeabilityFactV1 = Readonly<{
  state: ScmMergeabilityState;
  blockers: readonly string[];
}>;

export type ScmBucketMetaV1 = Readonly<{
  completeness: ScmCompleteness;
  observedHeadSha: string;
  observedAt: string;
  freshUntil: string;
  semanticHash: string;
  guard?: string;
  cursor?: string;
}>;

export type ScmFactBucketV1<T> = Readonly<{
  meta: ScmBucketMetaV1;
  facts: T;
}>;

export type ScmProviderFailureKind =
  | "cancelled"
  | "timeout"
  | "network"
  | "rate_limited"
  | "auth"
  | "permission"
  | "schema"
  | "pagination"
  | "budget_exceeded"
  | "provider";

export type ScmProviderFailureV1 = Readonly<{
  kind: ScmProviderFailureKind;
  retryable: boolean;
  code: string;
  diagnostic: string;
  nextEligibleAt?: string;
}>;

export type ScmFetchResultV1<T> =
  | Readonly<{ fetched: true; bucket: ScmFactBucketV1<T>; notModified: boolean }>
  | Readonly<{ fetched: false; failure: ScmProviderFailureV1 }>;

export type ScmProviderLimitsV1 = Readonly<{
  requestTimeoutMs: number;
  maxPagesPerEndpoint: number;
  maxItemsPerPage: number;
  maxItemsPerEndpoint: number;
  maxDecodedBytesPerRequest: number;
  maxDecodedBytesPerPoll: number;
  maxEvidenceBodyBytes: number;
  maxEvidencePreviewBytes: number;
  maxFailureLogBytes: number;
  maxFailureLogsBytes: number;
  maxConcurrentPerRepository: number;
  maxConcurrentPerRun: number;
}>;

export const SCM_PROVIDER_LIMITS: ScmProviderLimitsV1 = Object.freeze({
  requestTimeoutMs: 30_000,
  maxPagesPerEndpoint: 20,
  maxItemsPerPage: 100,
  maxItemsPerEndpoint: 2_000,
  maxDecodedBytesPerRequest: 4 * 1024 * 1024,
  maxDecodedBytesPerPoll: 16 * 1024 * 1024,
  maxEvidenceBodyBytes: 64 * 1024,
  maxEvidencePreviewBytes: 256 * 1024,
  maxFailureLogBytes: 64 * 1024,
  maxFailureLogsBytes: 256 * 1024,
  maxConcurrentPerRepository: 4,
  maxConcurrentPerRun: 8
});

export type ScmObservationGuardsV1 = Readonly<{
  pullRequest?: string;
  checks?: string;
  reviews?: string;
  mergeability?: string;
}>;

export type ScmObservationRequestV1 = Readonly<{
  repository: ScmRepositoryIdV1;
  pullRequest: ScmPullRequestIdentityV1;
  expectedHeadSha: string;
  guards: ScmObservationGuardsV1;
  forceFullRefresh: boolean;
  limits: ScmProviderLimitsV1;
  signal: AbortSignal;
}>;

export type ScmObservationResultV1 = Readonly<{
  pullRequest: ScmFetchResultV1<ScmPullRequestFactV1>;
  ci: ScmFetchResultV1<ScmCiFactV1>;
  review: ScmFetchResultV1<ScmReviewFactV1>;
  mergeability: ScmFetchResultV1<ScmMergeabilityFactV1>;
  requestCount: number;
  decodedBytes: number;
}>;

export type ScmPullRequestLookupRequestV1 = Readonly<{
  repository: ScmRepositoryIdV1;
  headRepository: ScmRepositoryIdV1;
  headRef: string;
  baseRepository: ScmRepositoryIdV1;
  baseRef: string;
  limits: ScmProviderLimitsV1;
  signal: AbortSignal;
}>;

export type ScmPullRequestLookupResultV1 =
  | Readonly<{ fetched: true; complete: boolean; candidates: readonly ScmPullRequestFactV1[] }>
  | Readonly<{ fetched: false; failure: ScmProviderFailureV1 }>;

export type ScmCreatePullRequestRequestV1 = Readonly<{
  publicationId: string;
  repository: ScmRepositoryIdV1;
  headRepository: ScmRepositoryIdV1;
  headRef: string;
  headSha: string;
  baseRepository: ScmRepositoryIdV1;
  baseRef: string;
  title: string;
  body: string;
  draft: boolean;
  signal: AbortSignal;
}>;

export type ScmCreatePullRequestResultV1 =
  | Readonly<{ outcome: "created"; pullRequest: ScmPullRequestFactV1 }>
  | Readonly<{ outcome: "ambiguous"; diagnostic: string }>
  | Readonly<{ outcome: "failed"; failure: ScmProviderFailureV1 }>;

/** Adapters close over host-scoped credentials; secret material cannot enter this contract. */
export interface ScmProviderV1 {
  readonly provider: ScmProviderKind;
  readonly capabilities: readonly ScmCapabilityName[];
  observe(request: ScmObservationRequestV1): Promise<ScmObservationResultV1>;
  lookupPullRequests(request: ScmPullRequestLookupRequestV1): Promise<ScmPullRequestLookupResultV1>;
  createPullRequest(request: ScmCreatePullRequestRequestV1): Promise<ScmCreatePullRequestResultV1>;
}

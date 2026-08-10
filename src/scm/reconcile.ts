import { z } from "zod";
import {
  scmPublicationStates,
  type ScmCiFactV1,
  type ScmFactBucketV1,
  type ScmFetchResultV1,
  type ScmMergeabilityFactV1,
  type ScmPublicationIntentV1,
  type ScmPublicationState,
  type ScmPullRequestFactV1,
  type ScmPullRequestLookupResultV1,
  type ScmReviewFactV1
} from "./types.js";
import {
  ScmCanonicalTimestampSchema,
  ScmObjectIdSchema,
  parseScmBucketMeta,
  parseScmCiFact,
  parseScmMergeabilityFact,
  parseScmPublicationIntent,
  parseScmPullRequestFact,
  parseScmReviewFact,
  sameScmRepository
} from "./schema.js";

export class ScmDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScmDecisionError";
  }
}

export class ScmFenceError extends ScmDecisionError {
  constructor(
    readonly code: "STALE_GENERATION" | "STALE_VERSION",
    readonly expected: number,
    readonly current: number
  ) {
    super(`${code}: expected ${expected}, current ${current}`);
    this.name = "ScmFenceError";
  }
}

const legalPublicationTransitions: Readonly<Record<ScmPublicationState, readonly ScmPublicationState[]>> = Object.freeze({
  unpublished: ["push_intent", "refused", "superseded"],
  push_intent: ["push_ambiguous", "branch_published", "refused", "superseded"],
  push_ambiguous: ["push_intent", "branch_published", "refused", "superseded"],
  branch_published: ["pr_intent", "refused", "superseded"],
  pr_intent: ["pr_ambiguous", "published", "refused", "superseded"],
  pr_ambiguous: ["pr_intent", "published", "refused", "superseded"],
  published: ["superseded"],
  superseded: [],
  refused: []
});

export function transitionScmPublication(current: ScmPublicationState, next: ScmPublicationState): ScmPublicationState {
  z.enum(scmPublicationStates).parse(current);
  z.enum(scmPublicationStates).parse(next);
  if (!legalPublicationTransitions[current].includes(next)) {
    throw new ScmDecisionError(`illegal SCM publication transition ${current} -> ${next}`);
  }
  return next;
}

export type ScmPublicationAggregateV1 = Readonly<{
  publicationId: string;
  generation: number;
  version: number;
  state: ScmPublicationState;
  intent: ScmPublicationIntentV1;
}>;

export function createScmPublicationAggregate(intentValue: ScmPublicationIntentV1): ScmPublicationAggregateV1 {
  const intent = parseScmPublicationIntent(intentValue);
  return Object.freeze({
    publicationId: intent.publicationId,
    generation: intent.publicationGeneration,
    version: 0,
    state: "unpublished",
    intent
  });
}

/** Apply one publication fact under explicit aggregate generation/version fences. */
export function applyScmPublicationTransition(
  aggregate: ScmPublicationAggregateV1,
  request: Readonly<{
    publicationId: string;
    generation: number;
    expectedVersion: number;
    nextState: ScmPublicationState;
  }>
): ScmPublicationAggregateV1 {
  const canonical = createScmPublicationAggregate(aggregate.intent);
  if (
    aggregate.publicationId !== canonical.publicationId ||
    aggregate.generation !== canonical.generation ||
    !Number.isSafeInteger(aggregate.version) ||
    aggregate.version < 0 ||
    !scmPublicationStates.includes(aggregate.state)
  ) throw new ScmDecisionError("publication aggregate identity or version is invalid");
  if (request.publicationId !== aggregate.publicationId) throw new ScmDecisionError("publication transition targets a different aggregate");
  if (!Number.isSafeInteger(request.generation) || request.generation < 1) throw new ScmDecisionError("publication transition generation is invalid");
  if (!Number.isSafeInteger(request.expectedVersion) || request.expectedVersion < 0) throw new ScmDecisionError("publication transition expected version is invalid");
  if (request.generation !== aggregate.generation) throw new ScmFenceError("STALE_GENERATION", request.generation, aggregate.generation);
  if (request.expectedVersion !== aggregate.version) throw new ScmFenceError("STALE_VERSION", request.expectedVersion, aggregate.version);
  const state = transitionScmPublication(aggregate.state, request.nextState);
  return Object.freeze({ ...aggregate, state, version: aggregate.version + 1 });
}

export type ScmRemoteRefObservation =
  | Readonly<{ kind: "observed"; oid: string | null }>
  | Readonly<{ kind: "unknown"; reasonCode: string }>;

export type ScmPushRecoveryDecision =
  | Readonly<{ action: "record_branch_published"; observedOid: string }>
  | Readonly<{ action: "retry_push"; expectedRemoteOid: string | null; intendedOid: string }>
  | Readonly<{ action: "wait"; reasonCode: string }>
  | Readonly<{ action: "refuse"; reasonCode: "REMOTE_REF_DIVERGED"; observedOid: string | null }>;

/** Reconcile an ambiguous/preflight push without ever converting absence-of-proof into absence. */
export function decidePushRecovery(intentValue: ScmPublicationIntentV1, observation: ScmRemoteRefObservation): ScmPushRecoveryDecision {
  const intent = parseScmPublicationIntent(intentValue);
  if (observation.kind === "unknown") {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(observation.reasonCode)) throw new ScmDecisionError("remote-ref failure code is invalid");
    return Object.freeze({ action: "wait", reasonCode: observation.reasonCode });
  }
  if (observation.oid !== null) ScmObjectIdSchema.parse(observation.oid);
  if (observation.oid === intent.integrationOid) {
    return Object.freeze({ action: "record_branch_published", observedOid: observation.oid });
  }
  const expected = intent.expectedRemote.kind === "absent" ? null : intent.expectedRemote.oid;
  if (observation.oid === expected) {
    return Object.freeze({ action: "retry_push", expectedRemoteOid: expected, intendedOid: intent.integrationOid });
  }
  return Object.freeze({ action: "refuse", reasonCode: "REMOTE_REF_DIVERGED", observedOid: observation.oid });
}

function exactPullRequest(intent: ScmPublicationIntentV1, candidate: ScmPullRequestFactV1): boolean {
  return (
    candidate.lifecycle === "open" &&
    candidate.draft === intent.draft &&
    sameScmRepository(candidate.repository, intent.baseRepository) &&
    sameScmRepository(candidate.headRepository, intent.repository) &&
    candidate.headRef === intent.remoteRef &&
    candidate.headSha === intent.integrationOid &&
    sameScmRepository(candidate.baseRepository, intent.baseRepository) &&
    candidate.baseRef === intent.baseRef
  );
}

function relatedPullRequest(intent: ScmPublicationIntentV1, candidate: ScmPullRequestFactV1): boolean {
  return sameScmRepository(candidate.headRepository, intent.repository) && candidate.headRef === intent.remoteRef;
}

export type ScmPullRequestRecoveryDecision =
  | Readonly<{ action: "adopt"; pullRequest: ScmPullRequestFactV1 }>
  | Readonly<{ action: "retry_create" }>
  | Readonly<{ action: "wait"; reasonCode: string }>
  | Readonly<{ action: "refuse"; reasonCode: "AMBIGUOUS_PULL_REQUEST" | "PULL_REQUEST_IDENTITY_MISMATCH"; candidateProviderIds: readonly string[] }>;

/** Adopt only one exact open PR. Partial lookup or divergent related candidates can never authorize create/adopt. */
export function decidePullRequestRecovery(
  intentValue: ScmPublicationIntentV1,
  lookup: ScmPullRequestLookupResultV1
): ScmPullRequestRecoveryDecision {
  const intent = parseScmPublicationIntent(intentValue);
  if (!lookup.fetched) return Object.freeze({ action: "wait", reasonCode: lookup.failure.code });
  if (!lookup.complete) return Object.freeze({ action: "wait", reasonCode: "PARTIAL_PULL_REQUEST_LOOKUP" });
  const candidates = lookup.candidates.map(parseScmPullRequestFact);
  const related = candidates.filter((candidate) => relatedPullRequest(intent, candidate));
  const exact = related.filter((candidate) => exactPullRequest(intent, candidate));
  if (exact.length === 1 && related.length === 1) return Object.freeze({ action: "adopt", pullRequest: exact[0]! });
  const candidateProviderIds = related.map((candidate) => candidate.providerId).sort();
  if (exact.length > 1 || related.length > 1) {
    return Object.freeze({ action: "refuse", reasonCode: "AMBIGUOUS_PULL_REQUEST", candidateProviderIds });
  }
  if (related.length === 1) {
    return Object.freeze({ action: "refuse", reasonCode: "PULL_REQUEST_IDENTITY_MISMATCH", candidateProviderIds });
  }
  return Object.freeze({ action: "retry_create" });
}

export type ScmBucketUpdateDecision =
  | Readonly<{ action: "accept_new" | "accept_changed" | "accept_refresh" }>
  | Readonly<{ action: "preserve"; reasonCode: "FETCH_FAILED" | "OLDER_OBSERVATION" }>
  | Readonly<{ action: "merge_required"; reasonCode: "PARTIAL_CANNOT_REPLACE_COMPLETE" }>
  | Readonly<{ action: "refuse"; reasonCode: "HEAD_MISMATCH" | "SAME_TIME_CONFLICT" | "NOT_MODIFIED_CHANGED" | "NOT_MODIFIED_WITHOUT_BASE" }>;

/** Pure acceptance guard; kind-specific partial merging happens before a resulting bucket is appended. */
export function decideBucketUpdate<T>(input: Readonly<{
  expectedHeadSha: string;
  previous?: ScmFactBucketV1<T>;
  result: ScmFetchResultV1<T>;
}>): ScmBucketUpdateDecision {
  ScmObjectIdSchema.parse(input.expectedHeadSha);
  if (!input.result.fetched) return Object.freeze({ action: "preserve", reasonCode: "FETCH_FAILED" });
  const next = input.result.bucket;
  if (next.meta.observedHeadSha !== input.expectedHeadSha) return Object.freeze({ action: "refuse", reasonCode: "HEAD_MISMATCH" });
  const previous = input.previous;
  if (!previous || previous.meta.observedHeadSha !== input.expectedHeadSha) {
    if (input.result.notModified) return Object.freeze({ action: "refuse", reasonCode: "NOT_MODIFIED_WITHOUT_BASE" });
    return Object.freeze({ action: "accept_new" });
  }
  const priorTime = Date.parse(ScmCanonicalTimestampSchema.parse(previous.meta.observedAt));
  const nextTime = Date.parse(ScmCanonicalTimestampSchema.parse(next.meta.observedAt));
  if (nextTime < priorTime) return Object.freeze({ action: "preserve", reasonCode: "OLDER_OBSERVATION" });
  if (nextTime === priorTime && next.meta.semanticHash !== previous.meta.semanticHash) {
    return Object.freeze({ action: "refuse", reasonCode: "SAME_TIME_CONFLICT" });
  }
  if (input.result.notModified && next.meta.semanticHash !== previous.meta.semanticHash) {
    return Object.freeze({ action: "refuse", reasonCode: "NOT_MODIFIED_CHANGED" });
  }
  if (next.meta.completeness === "partial" && previous.meta.completeness === "complete") {
    return Object.freeze({ action: "merge_required", reasonCode: "PARTIAL_CANNOT_REPLACE_COMPLETE" });
  }
  if (next.meta.semanticHash === previous.meta.semanticHash) return Object.freeze({ action: "accept_refresh" });
  return Object.freeze({ action: "accept_changed" });
}

export const scmReadinessBlockers = [
  "PUBLICATION_NOT_PUBLISHED",
  "PUBLICATION_GENERATION_STALE",
  "TASK_GENERATION_STALE",
  "PR_FACTS_MISSING",
  "PR_FACTS_STALE",
  "PR_FACTS_PARTIAL",
  "PR_IDENTITY_MISMATCH",
  "PR_NOT_OPEN",
  "PR_DRAFT",
  "CI_FACTS_MISSING",
  "CI_FACTS_STALE",
  "CI_FACTS_PARTIAL",
  "CI_NOT_PASSING",
  "REQUIRED_CHECKS_MISSING",
  "REVIEW_FACTS_MISSING",
  "REVIEW_FACTS_STALE",
  "REVIEW_FACTS_PARTIAL",
  "REVIEW_POLICY_UNSATISFIED",
  "UNRESOLVED_FEEDBACK",
  "MERGEABILITY_FACTS_MISSING",
  "MERGEABILITY_FACTS_STALE",
  "MERGEABILITY_FACTS_PARTIAL",
  "NOT_MERGEABLE"
] as const;
export type ScmReadinessBlocker = (typeof scmReadinessBlockers)[number];

export type ScmReadinessInputV1 = Readonly<{
  now: string;
  publicationState: ScmPublicationState;
  intent: ScmPublicationIntentV1;
  expectedPublicationGeneration: number;
  currentPublicationGeneration: number;
  expectedTaskGeneration: number;
  currentTaskGeneration: number;
  pullRequest?: ScmFactBucketV1<ScmPullRequestFactV1>;
  ci?: ScmFactBucketV1<ScmCiFactV1>;
  review?: ScmFactBucketV1<ScmReviewFactV1>;
  mergeability?: ScmFactBucketV1<ScmMergeabilityFactV1>;
  policy: Readonly<{
    minimumHumanApprovals: number;
    requireRequiredChecks: boolean;
  }>;
}>;

function bucketBaseBlockers<T>(
  bucket: ScmFactBucketV1<T> | undefined,
  nowMs: number,
  expectedHead: string,
  missing: ScmReadinessBlocker,
  stale: ScmReadinessBlocker,
  partial: ScmReadinessBlocker,
  blockers: Set<ScmReadinessBlocker>
): boolean {
  if (!bucket) {
    blockers.add(missing);
    return false;
  }
  const meta = parseScmBucketMeta(bucket.meta);
  if (meta.observedHeadSha !== expectedHead || Date.parse(meta.observedAt) > nowMs) {
    blockers.add(stale);
    return false;
  }
  if (Date.parse(meta.freshUntil) < nowMs) blockers.add(stale);
  if (meta.completeness !== "complete") blockers.add(partial);
  return true;
}

export function deriveScmReadiness(input: ScmReadinessInputV1): Readonly<{
  ready: boolean;
  blockers: readonly ScmReadinessBlocker[];
}> {
  const intent = parseScmPublicationIntent(input.intent);
  z.enum(scmPublicationStates).parse(input.publicationState);
  const nowMs = Date.parse(ScmCanonicalTimestampSchema.parse(input.now));
  for (const value of [input.expectedPublicationGeneration, input.currentPublicationGeneration, input.expectedTaskGeneration, input.currentTaskGeneration]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new ScmDecisionError("readiness generations must be positive safe integers");
  }
  if (!Number.isSafeInteger(input.policy.minimumHumanApprovals) || input.policy.minimumHumanApprovals < 0) {
    throw new ScmDecisionError("minimum human approvals is invalid");
  }
  const blockers = new Set<ScmReadinessBlocker>();
  if (input.publicationState !== "published") blockers.add("PUBLICATION_NOT_PUBLISHED");
  if (input.expectedPublicationGeneration !== input.currentPublicationGeneration) blockers.add("PUBLICATION_GENERATION_STALE");
  if (input.expectedTaskGeneration !== input.currentTaskGeneration) blockers.add("TASK_GENERATION_STALE");

  if (bucketBaseBlockers(input.pullRequest, nowMs, intent.integrationOid, "PR_FACTS_MISSING", "PR_FACTS_STALE", "PR_FACTS_PARTIAL", blockers)) {
    const pullRequest = parseScmPullRequestFact(input.pullRequest!.facts);
    if (
      !sameScmRepository(pullRequest.repository, intent.baseRepository) ||
      !sameScmRepository(pullRequest.headRepository, intent.repository) ||
      pullRequest.headRef !== intent.remoteRef ||
      pullRequest.headSha !== intent.integrationOid ||
      !sameScmRepository(pullRequest.baseRepository, intent.baseRepository) ||
      pullRequest.baseRef !== intent.baseRef
    ) blockers.add("PR_IDENTITY_MISMATCH");
    if (pullRequest.lifecycle !== "open") blockers.add("PR_NOT_OPEN");
    if (pullRequest.draft) blockers.add("PR_DRAFT");
  }

  if (bucketBaseBlockers(input.ci, nowMs, intent.integrationOid, "CI_FACTS_MISSING", "CI_FACTS_STALE", "CI_FACTS_PARTIAL", blockers)) {
    const ci = parseScmCiFact(input.ci!.facts);
    if (ci.state !== "passing" || ci.conflicts.length > 0) blockers.add("CI_NOT_PASSING");
    if (input.policy.requireRequiredChecks && ci.requiredCheckCount === 0) blockers.add("REQUIRED_CHECKS_MISSING");
  }

  if (bucketBaseBlockers(input.review, nowMs, intent.integrationOid, "REVIEW_FACTS_MISSING", "REVIEW_FACTS_STALE", "REVIEW_FACTS_PARTIAL", blockers)) {
    const review = parseScmReviewFact(input.review!.facts);
    if (
      review.decision === "changes_requested" ||
      review.conflicts.length > 0 ||
      review.humanApprovals < input.policy.minimumHumanApprovals ||
      (input.policy.minimumHumanApprovals > 0 && review.decision !== "approved")
    ) {
      blockers.add("REVIEW_POLICY_UNSATISFIED");
    }
    if (review.unresolvedSelectedEvidenceIds.length > 0) blockers.add("UNRESOLVED_FEEDBACK");
  }

  if (bucketBaseBlockers(input.mergeability, nowMs, intent.integrationOid, "MERGEABILITY_FACTS_MISSING", "MERGEABILITY_FACTS_STALE", "MERGEABILITY_FACTS_PARTIAL", blockers)) {
    const mergeability = parseScmMergeabilityFact(input.mergeability!.facts);
    if (mergeability.state !== "mergeable" || mergeability.blockers.length > 0) blockers.add("NOT_MERGEABLE");
  }

  const ordered = scmReadinessBlockers.filter((blocker) => blockers.has(blocker));
  return Object.freeze({ ready: ordered.length === 0, blockers: Object.freeze(ordered) });
}

export const scmReactionStates = [
  "pending",
  "command_admitted",
  "included",
  "observation_resolved",
  "superseded",
  "refused",
  "failed_retryable"
] as const;
export type ScmReactionState = (typeof scmReactionStates)[number];

export type ScmReactionDecision =
  | Readonly<{ action: "create_pending" }>
  | Readonly<{ action: "reuse"; state: ScmReactionState }>
  | Readonly<{ action: "supersede"; reasonCode: "HEAD_ADVANCED" | "GENERATION_ADVANCED" }>
  | Readonly<{ action: "refuse"; reasonCode: "TASK_TERMINAL" | "P2_INELIGIBLE" }>;

/** Fence a reaction to the observed head and both task/publication generations before P2 admission. */
export function decideScmReaction(input: Readonly<{
  existingState?: ScmReactionState;
  reactionHeadSha: string;
  currentHeadSha: string;
  reactionTaskGeneration: number;
  currentTaskGeneration: number;
  reactionPublicationGeneration: number;
  currentPublicationGeneration: number;
  taskTerminal: boolean;
  p2Eligible: boolean;
}>): ScmReactionDecision {
  ScmObjectIdSchema.parse(input.reactionHeadSha);
  ScmObjectIdSchema.parse(input.currentHeadSha);
  for (const generation of [
    input.reactionTaskGeneration,
    input.currentTaskGeneration,
    input.reactionPublicationGeneration,
    input.currentPublicationGeneration
  ]) {
    if (!Number.isSafeInteger(generation) || generation < 1) throw new ScmDecisionError("reaction generations must be positive safe integers");
  }
  if (input.reactionHeadSha !== input.currentHeadSha) return Object.freeze({ action: "supersede", reasonCode: "HEAD_ADVANCED" });
  if (input.reactionTaskGeneration !== input.currentTaskGeneration || input.reactionPublicationGeneration !== input.currentPublicationGeneration) {
    return Object.freeze({ action: "supersede", reasonCode: "GENERATION_ADVANCED" });
  }
  if (input.existingState !== undefined) {
    z.enum(scmReactionStates).parse(input.existingState);
    return Object.freeze({ action: "reuse", state: input.existingState });
  }
  if (input.taskTerminal) return Object.freeze({ action: "refuse", reasonCode: "TASK_TERMINAL" });
  if (!input.p2Eligible) return Object.freeze({ action: "refuse", reasonCode: "P2_INELIGIBLE" });
  return Object.freeze({ action: "create_pending" });
}

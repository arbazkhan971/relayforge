import { describe, expect, it } from "vitest";
import {
  applyScmPublicationTransition,
  createScmPublicationAggregate,
  decideBucketUpdate,
  decidePullRequestRecovery,
  decidePushRecovery,
  decideScmReaction,
  deriveScmReadiness,
  ScmDecisionError,
  ScmFenceError,
  transitionScmPublication,
  type ScmReadinessInputV1
} from "../src/scm/reconcile.js";
import {
  SCM_SCHEMA_VERSION,
  type ScmBucketMetaV1,
  type ScmFactBucketV1,
  type ScmPublicationIntentV1,
  type ScmPullRequestFactV1,
  type ScmRepositoryIdV1
} from "../src/scm/types.js";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const BASE = "c".repeat(40);
const HASH = "d".repeat(64);
const OBSERVED = "2026-08-09T12:00:00.000Z";
const NOW = "2026-08-09T12:30:00.000Z";
const FRESH = "2026-08-09T13:00:00.000Z";

const HEAD_REPOSITORY: ScmRepositoryIdV1 = {
  schemaVersion: SCM_SCHEMA_VERSION,
  provider: "github",
  canonicalHost: "github.example.com",
  owner: "relayforge",
  name: "project"
};
const BASE_REPOSITORY: ScmRepositoryIdV1 = { ...HEAD_REPOSITORY, owner: "upstream" };

function intent(overrides: Partial<ScmPublicationIntentV1> = {}): ScmPublicationIntentV1 {
  return {
    schemaVersion: 1,
    publicationId: "publication-1",
    publicationGeneration: 1,
    attempt: 1,
    runId: "run-1",
    runEpoch: "epoch-1",
    repository: HEAD_REPOSITORY,
    integrationRef: "refs/heads/loop/project/run/integration",
    integrationOid: HEAD,
    localExpectedOid: HEAD,
    remoteName: "origin",
    remoteRef: "refs/heads/relayforge/run-1",
    expectedRemote: { kind: "absent" },
    baseRepository: BASE_REPOSITORY,
    baseRef: "refs/heads/main",
    titleSha256: HASH,
    bodySha256: "e".repeat(64),
    draft: false,
    createdAt: OBSERVED,
    ...overrides
  };
}

function pullRequest(overrides: Partial<ScmPullRequestFactV1> = {}): ScmPullRequestFactV1 {
  return {
    providerId: "pr-7",
    number: 7,
    url: "https://github.example.com/upstream/project/pull/7",
    repository: BASE_REPOSITORY,
    headRepository: HEAD_REPOSITORY,
    headRef: "refs/heads/relayforge/run-1",
    headSha: HEAD,
    baseRepository: BASE_REPOSITORY,
    baseRef: "refs/heads/main",
    baseSha: BASE,
    lifecycle: "open",
    draft: false,
    ...overrides
  };
}

function meta(overrides: Partial<ScmBucketMetaV1> = {}): ScmBucketMetaV1 {
  return {
    completeness: "complete",
    observedHeadSha: HEAD,
    observedAt: OBSERVED,
    freshUntil: FRESH,
    semanticHash: HASH,
    ...overrides
  };
}

function bucket<T>(facts: T, overrides: Partial<ScmBucketMetaV1> = {}): ScmFactBucketV1<T> {
  return { meta: meta(overrides), facts };
}

const failure = {
  kind: "network" as const,
  retryable: true,
  code: "NETWORK",
  diagnostic: "network unavailable"
};

function readyInput(): ScmReadinessInputV1 {
  return {
    now: NOW,
    publicationState: "published",
    intent: intent(),
    expectedPublicationGeneration: 1,
    currentPublicationGeneration: 1,
    expectedTaskGeneration: 2,
    currentTaskGeneration: 2,
    pullRequest: bucket(pullRequest()),
    ci: bucket({
      state: "passing",
      checks: [{
        key: "1".repeat(64),
        providerCheckId: "check-1",
        providerRunId: "run-1",
        name: "required",
        required: true,
        bucket: "passing",
        status: "completed",
        conclusion: "success",
        attempt: 1,
        startedAt: OBSERVED,
        completedAt: OBSERVED
      }],
      requiredCheckCount: 1,
      conflicts: []
    }),
    review: bucket({ decision: "approved", humanApprovals: 1, evidence: [], unresolvedSelectedEvidenceIds: [], conflicts: [] }),
    mergeability: bucket({ state: "mergeable", blockers: [] }),
    policy: { minimumHumanApprovals: 1, requireRequiredChecks: true }
  };
}

describe("P3 pure SCM publication and recovery kernels", () => {
  it("permits only explicit monotonic publication transitions", () => {
    expect(transitionScmPublication("unpublished", "push_intent")).toBe("push_intent");
    expect(transitionScmPublication("push_intent", "push_ambiguous")).toBe("push_ambiguous");
    expect(transitionScmPublication("push_ambiguous", "branch_published")).toBe("branch_published");
    expect(transitionScmPublication("branch_published", "pr_intent")).toBe("pr_intent");
    expect(transitionScmPublication("pr_intent", "pr_ambiguous")).toBe("pr_ambiguous");
    expect(transitionScmPublication("pr_ambiguous", "published")).toBe("published");
    expect(transitionScmPublication("published", "superseded")).toBe("superseded");
    expect(() => transitionScmPublication("unpublished", "published")).toThrow(ScmDecisionError);
    expect(() => transitionScmPublication("refused", "push_intent")).toThrow(/illegal SCM publication transition/i);
  });

  it("fences publication transitions by aggregate generation and version", () => {
    const initial = createScmPublicationAggregate(intent());
    const begun = applyScmPublicationTransition(initial, {
      publicationId: initial.publicationId,
      generation: 1,
      expectedVersion: 0,
      nextState: "push_intent"
    });
    expect(initial).toMatchObject({ state: "unpublished", version: 0 });
    expect(begun).toMatchObject({ state: "push_intent", version: 1 });
    try {
      applyScmPublicationTransition(begun, {
        publicationId: begun.publicationId,
        generation: 2,
        expectedVersion: 1,
        nextState: "branch_published"
      });
      throw new Error("expected stale generation");
    } catch (error) {
      expect(error).toBeInstanceOf(ScmFenceError);
      expect(error).toMatchObject({ code: "STALE_GENERATION", expected: 2, current: 1 });
    }
    expect(() => applyScmPublicationTransition(begun, {
      publicationId: begun.publicationId,
      generation: 1,
      expectedVersion: 0,
      nextState: "branch_published"
    })).toThrow(/STALE_VERSION/);
  });

  it("reconciles an absent-lease push across exact, absent, unknown, and divergent outcomes", () => {
    expect(decidePushRecovery(intent(), { kind: "observed", oid: HEAD })).toEqual({ action: "record_branch_published", observedOid: HEAD });
    expect(decidePushRecovery(intent(), { kind: "observed", oid: null })).toEqual({ action: "retry_push", expectedRemoteOid: null, intendedOid: HEAD });
    expect(decidePushRecovery(intent(), { kind: "unknown", reasonCode: "NETWORK" })).toEqual({ action: "wait", reasonCode: "NETWORK" });
    expect(decidePushRecovery(intent(), { kind: "observed", oid: OLD })).toEqual({ action: "refuse", reasonCode: "REMOTE_REF_DIVERGED", observedOid: OLD });
  });

  it("honors a non-absent expected remote OID as an exact update lease", () => {
    const update = intent({ expectedRemote: { kind: "oid", oid: OLD } });
    expect(decidePushRecovery(update, { kind: "observed", oid: OLD })).toEqual({ action: "retry_push", expectedRemoteOid: OLD, intendedOid: HEAD });
    expect(decidePushRecovery(update, { kind: "observed", oid: null })).toMatchObject({ action: "refuse", reasonCode: "REMOTE_REF_DIVERGED" });
  });

  it("adopts exactly one matching open PR and refuses partial or ambiguous identity", () => {
    const exact = pullRequest();
    expect(decidePullRequestRecovery(intent(), { fetched: true, complete: true, candidates: [exact] })).toEqual({ action: "adopt", pullRequest: exact });
    expect(decidePullRequestRecovery(intent(), { fetched: true, complete: true, candidates: [] })).toEqual({ action: "retry_create" });
    expect(decidePullRequestRecovery(intent(), { fetched: true, complete: false, candidates: [exact] })).toEqual({ action: "wait", reasonCode: "PARTIAL_PULL_REQUEST_LOOKUP" });
    expect(decidePullRequestRecovery(intent(), { fetched: false, failure })).toEqual({ action: "wait", reasonCode: "NETWORK" });
    expect(decidePullRequestRecovery(intent(), {
      fetched: true,
      complete: true,
      candidates: [pullRequest({ baseRef: "refs/heads/release" })]
    })).toMatchObject({ action: "refuse", reasonCode: "PULL_REQUEST_IDENTITY_MISMATCH" });
    expect(decidePullRequestRecovery(intent(), {
      fetched: true,
      complete: true,
      candidates: [exact, pullRequest({ providerId: "pr-8", number: 8, url: "https://github.example.com/upstream/project/pull/8" })]
    })).toMatchObject({ action: "refuse", reasonCode: "AMBIGUOUS_PULL_REQUEST", candidateProviderIds: ["pr-7", "pr-8"] });
  });

  it("does not let unrelated foreign/fork branch strings interfere with exact PR recovery", () => {
    const unrelated = pullRequest({
      providerId: "foreign",
      number: 9,
      url: "https://github.example.com/upstream/project/pull/9",
      headRepository: { ...HEAD_REPOSITORY, owner: "someone-else" }
    });
    expect(decidePullRequestRecovery(intent(), { fetched: true, complete: true, candidates: [unrelated] })).toEqual({ action: "retry_create" });
  });

  it("preserves prior bucket truth on failures/older data and refuses identity ambiguity", () => {
    const previous = bucket({ value: "old" });
    expect(decideBucketUpdate({ expectedHeadSha: HEAD, previous, result: { fetched: false, failure } })).toEqual({ action: "preserve", reasonCode: "FETCH_FAILED" });
    expect(decideBucketUpdate({
      expectedHeadSha: HEAD,
      previous,
      result: { fetched: true, notModified: false, bucket: bucket({ value: "older" }, { observedAt: "2026-08-09T11:59:00.000Z", semanticHash: "1".repeat(64) }) }
    })).toEqual({ action: "preserve", reasonCode: "OLDER_OBSERVATION" });
    expect(decideBucketUpdate({
      expectedHeadSha: HEAD,
      previous,
      result: { fetched: true, notModified: false, bucket: bucket({ value: "foreign" }, { observedHeadSha: OLD }) }
    })).toEqual({ action: "refuse", reasonCode: "HEAD_MISMATCH" });
    expect(decideBucketUpdate({
      expectedHeadSha: HEAD,
      previous,
      result: { fetched: true, notModified: false, bucket: bucket({ value: "conflict" }, { semanticHash: "1".repeat(64) }) }
    })).toEqual({ action: "refuse", reasonCode: "SAME_TIME_CONFLICT" });
  });

  it("distinguishes safe refresh/change from partial merge and impossible 304 changes", () => {
    const previous = bucket({ value: "old" });
    expect(decideBucketUpdate({
      expectedHeadSha: HEAD,
      previous,
      result: { fetched: true, notModified: true, bucket: bucket({ value: "old" }, { observedAt: "2026-08-09T12:01:00.000Z" }) }
    })).toEqual({ action: "accept_refresh" });
    expect(decideBucketUpdate({
      expectedHeadSha: HEAD,
      previous,
      result: { fetched: true, notModified: false, bucket: bucket({ value: "new" }, { observedAt: "2026-08-09T12:01:00.000Z", semanticHash: "1".repeat(64) }) }
    })).toEqual({ action: "accept_changed" });
    expect(decideBucketUpdate({
      expectedHeadSha: HEAD,
      previous,
      result: { fetched: true, notModified: false, bucket: bucket({ value: "partial" }, { observedAt: "2026-08-09T12:01:00.000Z", semanticHash: "1".repeat(64), completeness: "partial" }) }
    })).toEqual({ action: "merge_required", reasonCode: "PARTIAL_CANNOT_REPLACE_COMPLETE" });
    expect(decideBucketUpdate({
      expectedHeadSha: HEAD,
      previous,
      result: { fetched: true, notModified: true, bucket: bucket({ value: "impossible" }, { observedAt: "2026-08-09T12:01:00.000Z", semanticHash: "1".repeat(64) }) }
    })).toEqual({ action: "refuse", reasonCode: "NOT_MODIFIED_CHANGED" });
    expect(decideBucketUpdate({
      expectedHeadSha: HEAD,
      result: { fetched: true, notModified: true, bucket: bucket({ value: "no-base" }) }
    })).toEqual({ action: "refuse", reasonCode: "NOT_MODIFIED_WITHOUT_BASE" });
    expect(decideBucketUpdate({
      expectedHeadSha: HEAD,
      previous,
      result: { fetched: true, notModified: false, bucket: bucket({ value: "old" }, { observedAt: "2026-08-09T12:01:00.000Z", completeness: "partial" }) }
    })).toEqual({ action: "merge_required", reasonCode: "PARTIAL_CANNOT_REPLACE_COMPLETE" });
  });
});

describe("P3 fail-closed ready-to-merge derivation", () => {
  it("reports ready only for exact current complete fresh passing facts", () => {
    expect(deriveScmReadiness(readyInput())).toEqual({ ready: true, blockers: [] });
  });

  it.each([
    ["PUBLICATION_NOT_PUBLISHED", (value: any) => { value.publicationState = "pr_intent"; }],
    ["PUBLICATION_GENERATION_STALE", (value: any) => { value.currentPublicationGeneration = 2; }],
    ["TASK_GENERATION_STALE", (value: any) => { value.currentTaskGeneration = 3; }],
    ["PR_FACTS_MISSING", (value: any) => { delete value.pullRequest; }],
    ["PR_FACTS_STALE", (value: any) => { value.pullRequest.meta.freshUntil = OBSERVED; }],
    ["PR_FACTS_PARTIAL", (value: any) => { value.pullRequest.meta.completeness = "partial"; }],
    ["PR_IDENTITY_MISMATCH", (value: any) => { value.pullRequest.facts.headSha = OLD; }],
    ["PR_NOT_OPEN", (value: any) => { value.pullRequest.facts.lifecycle = "merged"; }],
    ["PR_DRAFT", (value: any) => { value.pullRequest.facts.draft = true; }],
    ["CI_FACTS_MISSING", (value: any) => { delete value.ci; }],
    ["CI_FACTS_STALE", (value: any) => { value.ci.meta.observedHeadSha = OLD; }],
    ["CI_FACTS_PARTIAL", (value: any) => { value.ci.meta.completeness = "partial"; }],
    ["CI_NOT_PASSING", (value: any) => { value.ci.facts.state = "unknown"; }],
    ["REQUIRED_CHECKS_MISSING", (value: any) => { value.ci.facts.requiredCheckCount = 0; value.ci.facts.checks = []; }],
    ["REVIEW_FACTS_MISSING", (value: any) => { delete value.review; }],
    ["REVIEW_FACTS_STALE", (value: any) => { value.review.meta.freshUntil = OBSERVED; }],
    ["REVIEW_FACTS_PARTIAL", (value: any) => { value.review.meta.completeness = "partial"; }],
    ["REVIEW_POLICY_UNSATISFIED", (value: any) => { value.review.facts.humanApprovals = 0; value.review.facts.decision = "changes_requested"; }],
    ["UNRESOLVED_FEEDBACK", (value: any) => {
      value.review.facts.evidence = [{
        evidenceId: HASH,
        providerEvidenceId: "comment-1",
        kind: "inline_comment",
        authorKind: "human",
        authorId: "reviewer",
        createdAt: OBSERVED,
        updatedAt: OBSERVED,
        resolved: false,
        selected: true,
        body: "",
        bodySha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        originalBytes: 0,
        retainedBytes: 0,
        truncated: false,
        sanitized: false
      }];
      value.review.facts.unresolvedSelectedEvidenceIds = [HASH];
    }],
    ["MERGEABILITY_FACTS_MISSING", (value: any) => { delete value.mergeability; }],
    ["MERGEABILITY_FACTS_STALE", (value: any) => { value.mergeability.meta.freshUntil = OBSERVED; }],
    ["MERGEABILITY_FACTS_PARTIAL", (value: any) => { value.mergeability.meta.completeness = "partial"; }],
    ["NOT_MERGEABLE", (value: any) => { value.mergeability.facts.state = "conflicting"; }]
  ])("blocks on %s", (blocker, mutate) => {
    const candidate = structuredClone(readyInput());
    mutate(candidate);
    const result = deriveScmReadiness(candidate);
    expect(result.ready).toBe(false);
    expect(result.blockers).toContain(blocker);
  });

  it("treats the exact freshness deadline as fresh and returns blockers in stable order", () => {
    const candidate = structuredClone(readyInput());
    candidate.now = FRESH;
    candidate.publicationState = "push_ambiguous";
    candidate.currentTaskGeneration = 3;
    const result = deriveScmReadiness(candidate);
    expect(result.blockers.slice(0, 2)).toEqual(["PUBLICATION_NOT_PUBLISHED", "TASK_GENERATION_STALE"]);
    expect(result.blockers).not.toContain("CI_FACTS_STALE");
  });

  it("never lets requested changes pass merely because the policy requires zero approvals", () => {
    const candidate = structuredClone(readyInput());
    candidate.policy.minimumHumanApprovals = 0;
    candidate.review!.facts.decision = "changes_requested";
    expect(deriveScmReadiness(candidate)).toMatchObject({ ready: false, blockers: expect.arrayContaining(["REVIEW_POLICY_UNSATISFIED"]) });
  });
});

describe("P3 feedback reaction fencing", () => {
  const base = {
    reactionHeadSha: HEAD,
    currentHeadSha: HEAD,
    reactionTaskGeneration: 2,
    currentTaskGeneration: 2,
    reactionPublicationGeneration: 1,
    currentPublicationGeneration: 1,
    taskTerminal: false,
    p2Eligible: true
  } as const;

  it("creates one pending reaction and reuses its durable state after restart", () => {
    expect(decideScmReaction(base)).toEqual({ action: "create_pending" });
    expect(decideScmReaction({ ...base, existingState: "command_admitted" })).toEqual({ action: "reuse", state: "command_admitted" });
  });

  it("supersedes stale head/generation before considering an existing reaction", () => {
    expect(decideScmReaction({ ...base, currentHeadSha: OLD, existingState: "pending" })).toEqual({ action: "supersede", reasonCode: "HEAD_ADVANCED" });
    expect(decideScmReaction({ ...base, currentTaskGeneration: 3 })).toEqual({ action: "supersede", reasonCode: "GENERATION_ADVANCED" });
  });

  it("refuses terminal tasks or ineligible P2 activity", () => {
    expect(decideScmReaction({ ...base, taskTerminal: true })).toEqual({ action: "refuse", reasonCode: "TASK_TERMINAL" });
    expect(decideScmReaction({ ...base, p2Eligible: false })).toEqual({ action: "refuse", reasonCode: "P2_INELIGIBLE" });
    expect(() => decideScmReaction({ ...base, currentTaskGeneration: 0 })).toThrow(/positive safe integers/i);
  });
});

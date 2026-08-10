import { describe, expect, it } from "vitest";
import {
  SCM_PROVIDER_LIMITS,
  SCM_SCHEMA_VERSION,
  type ScmPublicationIntentV1,
  type ScmPullRequestFactV1,
  type ScmRepositoryIdV1
} from "../src/scm/types.js";
import {
  ScmObjectIdSchema,
  ScmMergeabilityFactV1Schema,
  assertScmCapabilities,
  canonicalizeScmHost,
  isValidScmBranchRef,
  materializeScmFactBucket,
  parseScmFactBucket,
  parseScmHttpsUrl,
  parseScmProviderFailure,
  parseScmProviderLimits,
  parseScmPublicationIntent,
  parseScmPullRequestFact,
  parseScmRepositoryId,
  sameScmRepository,
  scmRepositoryKey
} from "../src/scm/schema.js";

const SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const DIGEST = "c".repeat(64);
const REPOSITORY: ScmRepositoryIdV1 = {
  schemaVersion: SCM_SCHEMA_VERSION,
  provider: "github",
  canonicalHost: "github.example.com",
  owner: "relay-forge",
  name: "control-plane"
};
const BASE_REPOSITORY: ScmRepositoryIdV1 = { ...REPOSITORY, owner: "upstream" };

function intent(overrides: Partial<ScmPublicationIntentV1> = {}): ScmPublicationIntentV1 {
  return {
    schemaVersion: 1,
    publicationId: "publication-1",
    publicationGeneration: 1,
    attempt: 1,
    runId: "run-1",
    runEpoch: "epoch-1",
    repository: REPOSITORY,
    integrationRef: "refs/heads/loop/project/run/integration",
    integrationOid: SHA,
    localExpectedOid: SHA,
    remoteName: "origin",
    remoteRef: "refs/heads/relayforge/run-1",
    expectedRemote: { kind: "absent" },
    baseRepository: BASE_REPOSITORY,
    baseRef: "refs/heads/main",
    titleSha256: DIGEST,
    bodySha256: "d".repeat(64),
    draft: true,
    createdAt: "2026-08-09T12:00:00.000Z",
    ...overrides
  };
}

function pullRequest(overrides: Partial<ScmPullRequestFactV1> = {}): ScmPullRequestFactV1 {
  return {
    providerId: "pr-node-17",
    number: 17,
    url: "https://github.example.com/upstream/control-plane/pull/17",
    repository: BASE_REPOSITORY,
    headRepository: REPOSITORY,
    headRef: "refs/heads/relayforge/run-1",
    headSha: SHA,
    baseRepository: BASE_REPOSITORY,
    baseRef: "refs/heads/main",
    baseSha: BASE_SHA,
    lifecycle: "open",
    draft: true,
    resourceVersion: "W/etag-1",
    ...overrides
  };
}

describe("P3 SCM strict domain contracts", () => {
  it("parses one canonical repository identity and derives an unambiguous key", () => {
    expect(parseScmRepositoryId(REPOSITORY)).toEqual(REPOSITORY);
    expect(scmRepositoryKey(REPOSITORY)).toBe("github:github.example.com/relay-forge/control-plane");
    expect(sameScmRepository(REPOSITORY, { ...REPOSITORY })).toBe(true);
    expect(sameScmRepository(REPOSITORY, BASE_REPOSITORY)).toBe(false);
  });

  it.each([
    { ...REPOSITORY, provider: "gitlab" },
    { ...REPOSITORY, canonicalHost: "GitHub.Example.com" },
    { ...REPOSITORY, canonicalHost: "https://github.example.com" },
    { ...REPOSITORY, canonicalHost: "github.example.com:443" },
    { ...REPOSITORY, canonicalHost: "github.example.com/path" },
    { ...REPOSITORY, owner: "../upstream" },
    { ...REPOSITORY, owner: "UpperCase" },
    { ...REPOSITORY, name: ".hidden" },
    { ...REPOSITORY, extra: true }
  ])("rejects noncanonical or unknown repository identity %#", (candidate) => {
    expect(() => parseScmRepositoryId(candidate)).toThrow();
  });

  it("strictly parses canonical hosts, HTTPS URLs, and branch refs", () => {
    expect(canonicalizeScmHost("ghe.internal")).toBe("ghe.internal");
    expect(parseScmHttpsUrl("https://ghe.internal/org/repo/pull/1", "ghe.internal")).toBe("https://ghe.internal/org/repo/pull/1");
    expect(isValidScmBranchRef("refs/heads/relayforge/run-1")).toBe(true);
    for (const invalid of [
      "main",
      "refs/tags/main",
      "refs/heads/",
      "refs/heads/.hidden",
      "refs/heads/a..b",
      "refs/heads/a.lock",
      "refs/heads/a@{b",
      "refs/heads/a b",
      "refs/heads/a\\b",
      "refs/heads/a[b"
    ]) expect(isValidScmBranchRef(invalid), invalid).toBe(false);
    for (const invalid of [
      "http://ghe.internal/org/repo",
      "https://other.internal/org/repo",
      "https://user@ghe.internal/org/repo",
      "https://ghe.internal:443/org/repo",
      "https://ghe.internal/org/repo?q=secret",
      "https://ghe.internal/org/repo#fragment"
    ]) expect(() => parseScmHttpsUrl(invalid, "ghe.internal"), invalid).toThrow();
  });

  it("accepts SHA-1/SHA-256 object identities and rejects moving names or uppercase", () => {
    expect(ScmObjectIdSchema.parse("a".repeat(40))).toHaveLength(40);
    expect(ScmObjectIdSchema.parse("b".repeat(64))).toHaveLength(64);
    for (const invalid of ["main", "A".repeat(40), "a".repeat(39), "a".repeat(41), "g".repeat(40)]) {
      expect(() => ScmObjectIdSchema.parse(invalid)).toThrow();
    }
  });

  it("binds publication intent to the reviewed local OID and distinct exact refs", () => {
    expect(parseScmPublicationIntent(intent())).toEqual(intent());
    expect(() => parseScmPublicationIntent(intent({ localExpectedOid: BASE_SHA }))).toThrow(/reviewed integration OID/i);
    expect(() => parseScmPublicationIntent(intent({ repository: BASE_REPOSITORY, remoteRef: "refs/heads/main" }))).toThrow(/head and base refs must differ/i);
    expect(() => parseScmPublicationIntent({ ...intent(), unknown: "field" })).toThrow();
  });

  it("supports exact fork identity but refuses foreign URL authority and terminal drafts", () => {
    expect(parseScmPullRequestFact(pullRequest())).toEqual(pullRequest());
    expect(() => parseScmPullRequestFact(pullRequest({ url: "https://evil.example/upstream/control-plane/pull/17" }))).toThrow(/canonical host/i);
    expect(() => parseScmPullRequestFact(pullRequest({ lifecycle: "merged", draft: true }))).toThrow(/cannot remain draft/i);
  });

  it("allows provider resource limits only at or below the audited ceilings", () => {
    expect(parseScmProviderLimits(SCM_PROVIDER_LIMITS)).toEqual(SCM_PROVIDER_LIMITS);
    for (const key of Object.keys(SCM_PROVIDER_LIMITS) as (keyof typeof SCM_PROVIDER_LIMITS)[]) {
      expect(() => parseScmProviderLimits({ ...SCM_PROVIDER_LIMITS, [key]: SCM_PROVIDER_LIMITS[key] + 1 }), key).toThrow();
    }
    expect(() => parseScmProviderLimits({ ...SCM_PROVIDER_LIMITS, maxItemsPerPage: 1 })).toThrow(/item ceiling exceeds the page budget/i);
    expect(parseScmProviderLimits({ ...SCM_PROVIDER_LIMITS, maxItemsPerEndpoint: 20 })).toMatchObject({ maxItemsPerEndpoint: 20 });
  });

  it("keeps auth/schema failures non-spinning and rate-limit eligibility durable", () => {
    expect(parseScmProviderFailure({
      kind: "rate_limited",
      retryable: true,
      code: "RATE_LIMIT",
      diagnostic: "provider quota unavailable",
      nextEligibleAt: "2026-08-09T12:05:00.000Z"
    }).kind).toBe("rate_limited");
    expect(() => parseScmProviderFailure({ kind: "rate_limited", retryable: true, code: "RATE_LIMIT", diagnostic: "wait" })).toThrow(/eligibility/i);
    expect(() => parseScmProviderFailure({ kind: "auth", retryable: true, code: "AUTH", diagnostic: "token secret must not be included" })).toThrow(/hot-loop/i);
  });

  it("materializes and verifies fact-bucket semantic identity instead of trusting a supplied hash", () => {
    const bucket = materializeScmFactBucket({
      completeness: "complete",
      observedHeadSha: SHA,
      observedAt: "2026-08-09T12:00:00.000Z",
      freshUntil: "2026-08-09T12:05:00.000Z",
      facts: { state: "mergeable", blockers: [] }
    }, ScmMergeabilityFactV1Schema);
    expect(bucket.meta.semanticHash).toMatch(/^[a-f0-9]{64}$/);
    expect(parseScmFactBucket(bucket, ScmMergeabilityFactV1Schema)).toEqual(bucket);
    expect(() => parseScmFactBucket({ ...bucket, meta: { ...bucket.meta, semanticHash: DIGEST } }, ScmMergeabilityFactV1Schema)).toThrow(/semantic hash/i);
  });

  it("requires unique known capabilities and returns deterministic ordering", () => {
    expect(assertScmCapabilities(["scm.write_pr", "scm.read"])).toEqual(["scm.read", "scm.write_pr"]);
    expect(() => assertScmCapabilities(["scm.read", "scm.read"])).toThrow(/unique/i);
    expect(() => assertScmCapabilities(["scm.merge"])).toThrow();
  });
});

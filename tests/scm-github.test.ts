import { afterEach, describe, expect, it } from "vitest";
import {
  createGithubScmProvider,
  type GithubTransport
} from "../src/scm/github.js";
import {
  SCM_PROVIDER_LIMITS,
  type ScmCreatePullRequestRequestV1,
  type ScmObservationRequestV1,
  type ScmProviderLimitsV1,
  type ScmPullRequestIdentityV1,
  type ScmPullRequestLookupRequestV1,
  type ScmRepositoryIdV1
} from "../src/scm/types.js";
import {
  startFakeGithubServer,
  type FakeGithubHandler,
  type FakeGithubRequest,
  type FakeGithubServer
} from "./fixtures/scm-github/fake-server.js";

const HOST = "github.example.com";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const NOW = "2026-08-09T12:00:00.000Z";
const servers: FakeGithubServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

function repository(owner = "upstream"): ScmRepositoryIdV1 {
  return { schemaVersion: 1, provider: "github", canonicalHost: HOST, owner, name: "project" };
}

const BASE_REPOSITORY = repository();
const HEAD_REPOSITORY = repository("relayforge");

function pull(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7001,
    number: 7,
    html_url: `https://${HOST}/upstream/project/pull/7`,
    state: "open",
    merged: false,
    merged_at: null,
    draft: false,
    mergeable: true,
    mergeable_state: "clean",
    head: { ref: "relayforge/run-1", sha: HEAD, repo: { full_name: "relayforge/project", name: "project", owner: { login: "relayforge" } } },
    base: { ref: "main", sha: BASE, repo: { full_name: "upstream/project", name: "project", owner: { login: "upstream" } } },
    ...overrides
  };
}

function pullIdentity(): ScmPullRequestIdentityV1 {
  return {
    providerId: "7001",
    number: 7,
    url: `https://${HOST}/upstream/project/pull/7`,
    repository: BASE_REPOSITORY,
    headRepository: HEAD_REPOSITORY,
    headRef: "refs/heads/relayforge/run-1",
    headSha: HEAD,
    baseRepository: BASE_REPOSITORY,
    baseRef: "refs/heads/main",
    baseSha: BASE
  };
}

function limits(overrides: Partial<ScmProviderLimitsV1> = {}): ScmProviderLimitsV1 {
  return { ...SCM_PROVIDER_LIMITS, ...overrides };
}

function observation(overrides: Partial<ScmObservationRequestV1> = {}): ScmObservationRequestV1 {
  return {
    repository: BASE_REPOSITORY,
    pullRequest: pullIdentity(),
    expectedHeadSha: HEAD,
    guards: {},
    forceFullRefresh: false,
    limits: limits(),
    signal: new AbortController().signal,
    ...overrides
  };
}

function lookup(overrides: Partial<ScmPullRequestLookupRequestV1> = {}): ScmPullRequestLookupRequestV1 {
  return {
    repository: BASE_REPOSITORY,
    headRepository: HEAD_REPOSITORY,
    headRef: "refs/heads/relayforge/run-1",
    baseRepository: BASE_REPOSITORY,
    baseRef: "refs/heads/main",
    limits: limits(),
    signal: new AbortController().signal,
    ...overrides
  };
}

function createRequest(overrides: Partial<ScmCreatePullRequestRequestV1> = {}): ScmCreatePullRequestRequestV1 {
  return {
    publicationId: "publication-1",
    repository: BASE_REPOSITORY,
    headRepository: HEAD_REPOSITORY,
    headRef: "refs/heads/relayforge/run-1",
    headSha: HEAD,
    baseRepository: BASE_REPOSITORY,
    baseRef: "refs/heads/main",
    title: "RelayForge change",
    body: "Bounded pull request body",
    draft: false,
    signal: new AbortController().signal,
    ...overrides
  };
}

function checkRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 101,
    name: "build",
    status: "completed",
    conclusion: "failure",
    run_attempt: 1,
    started_at: NOW,
    completed_at: NOW,
    details_url: `https://${HOST}/upstream/project/actions/runs/101`,
    log_url: `https://${HOST}/api/v3/logs/101`,
    check_suite: { id: 501 },
    app: { slug: "github-actions" },
    output: { title: "Build failed", summary: "compiler error" },
    ...overrides
  };
}

function graphqlThreads(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [{
              id: "thread-1",
              isResolved: false,
              comments: {
                nodes: [{
                  id: "comment-node-201",
                  databaseId: 201,
                  body: "Please add a regression test.",
                  url: `https://${HOST}/upstream/project/pull/7#discussion_r201`,
                  createdAt: NOW,
                  updatedAt: NOW,
                  author: { login: "reviewer", __typename: "User" }
                }],
                pageInfo: { hasNextPage: false }
              }
            }],
            pageInfo: { hasNextPage: false, endCursor: null },
            ...overrides
          }
        }
      }
    }
  };
}

function defaultHandler(options: {
  checkRuns?: unknown[];
  statuses?: unknown[];
  pull?: Record<string, unknown>;
  logBody?: string;
} = {}): FakeGithubHandler {
  return (request) => {
    const path = request.path;
    const etag = `"${path.split("?")[0]}"`;
    if (request.headers["if-none-match"] === etag) return { status: 304, headers: { etag } };
    if (path === "/api/v3/repos/upstream/project/pulls/7") return { json: options.pull ?? pull(), headers: { etag } };
    if (path.includes("/protection/required_status_checks")) return { json: { contexts: ["build"] }, headers: { etag } };
    if (path.includes("/check-runs")) return { json: { total_count: (options.checkRuns ?? [checkRun()]).length, check_runs: options.checkRuns ?? [checkRun()] }, headers: { etag } };
    if (path.includes("/statuses")) return { json: options.statuses ?? [], headers: { etag } };
    if (path.endsWith("/pulls/7/reviews?per_page=100")) return {
      json: [{ id: 301, state: "CHANGES_REQUESTED", body: "Please fix the race.", submitted_at: NOW, user: { login: "reviewer", type: "User" }, html_url: `https://${HOST}/upstream/project/pull/7#pullrequestreview-301` }],
      headers: { etag }
    };
    if (path.endsWith("/pulls/7/comments?per_page=100")) return {
      json: [{ id: 201, body: "Please add a regression test.", created_at: NOW, updated_at: NOW, user: { login: "reviewer", type: "User" }, html_url: `https://${HOST}/upstream/project/pull/7#discussion_r201` }],
      headers: { etag }
    };
    if (path.endsWith("/issues/7/comments?per_page=100")) return {
      json: [{ id: 401, body: "automation note", created_at: NOW, updated_at: NOW, user: { login: "ci[bot]", type: "Bot" }, html_url: `https://${HOST}/upstream/project/issues/7#issuecomment-401` }],
      headers: { etag }
    };
    if (path === "/api/graphql") return { json: graphqlThreads() };
    if (path === "/api/v3/logs/101") return { body: options.logBody ?? `old-prefix-${"x".repeat(32)}\u001b[31mFAIL\n` };
    return { status: 404, json: { message: "not found" } };
  };
}

async function server(handler: FakeGithubHandler): Promise<FakeGithubServer> {
  const value = await startFakeGithubServer(handler);
  servers.push(value);
  return value;
}

describe("P3 bounded GitHub adapter", () => {
  it("normalizes PR, CI, review/thread/comment, mergeability, and one bounded new failure tail", async () => {
    const fake = await server(defaultHandler());
    const provider = createGithubScmProvider({ canonicalHost: HOST, transport: fake.transport, now: () => new Date(NOW) });
    const result = await provider.observe(observation({
      limits: limits({ maxFailureLogBytes: 20, maxFailureLogsBytes: 40 })
    }));
    expect(result.pullRequest).toMatchObject({ fetched: true, bucket: { facts: { number: 7, headSha: HEAD, lifecycle: "open" } } });
    expect(result.ci).toMatchObject({
      fetched: true,
      bucket: { meta: { completeness: "complete" }, facts: { state: "failing", requiredCheckCount: 1 } }
    });
    expect(result.review).toMatchObject({
      fetched: true,
      bucket: { facts: { decision: "changes_requested", humanApprovals: 0 } }
    });
    expect(result.mergeability).toMatchObject({ fetched: true, bucket: { facts: { state: "mergeable", blockers: [] } } });
    if (result.review.fetched) {
      const kinds = result.review.bucket.facts.evidence.map((item) => item.kind);
      expect(kinds).toEqual(expect.arrayContaining(["review_body", "review_thread", "inline_comment", "issue_comment", "check_log"]));
      const log = result.review.bucket.facts.evidence.find((item) => item.kind === "check_log")!;
      expect(log.retainedBytes).toBeLessThanOrEqual(20);
      expect(log.body).toContain("FAI");
      expect(log.body).not.toContain("\u001b");
      expect(log.sanitized).toBe(true);
    }
    expect(result.requestCount).toBe(fake.requests.length);
    expect(result.decodedBytes).toBeGreaterThan(0);
    expect(fake.requests.filter((request) => request.path === "/api/v3/logs/101")).toHaveLength(1);
    expect(fake.requests.every((request) => request.headers.authorization === undefined)).toBe(true);
  });

  it("deduplicates reruns and maps unknown provider enums to unknown instead of success", async () => {
    const fake = await server(defaultHandler({
      checkRuns: [
        checkRun({ id: 100, conclusion: "failure", started_at: "2026-08-09T11:00:00.000Z", check_suite: { id: 500 } }),
        checkRun({ id: 101, conclusion: "success", started_at: NOW, check_suite: { id: 501 }, log_url: undefined }),
        checkRun({ id: 102, name: "future-state", status: "teleported", conclusion: "quantum", check_suite: { id: 502 }, log_url: undefined })
      ]
    }));
    const provider = createGithubScmProvider({ canonicalHost: HOST, transport: fake.transport, now: () => new Date(NOW) });
    const result = await provider.observe(observation());
    expect(result.ci).toMatchObject({ fetched: true, bucket: { facts: { state: "passing" } } });
    if (result.ci.fetched) {
      expect(result.ci.bucket.facts.checks.find((item) => item.name === "build")).toMatchObject({ bucket: "passing", providerCheckId: "101" });
      expect(result.ci.bucket.facts.checks.find((item) => item.name === "future-state")).toMatchObject({ bucket: "unknown" });
    }
  });

  it("fetches logs only once for the same failing fingerprint and again after the fingerprint changes", async () => {
    let checkId = 101;
    const fake = await server((request) => defaultHandler({ checkRuns: [checkRun({ id: checkId, check_suite: { id: checkId + 400 }, log_url: `https://${HOST}/api/v3/logs/${checkId}` })] })(request));
    const provider = createGithubScmProvider({ canonicalHost: HOST, transport: fake.transport, now: () => new Date(NOW) });
    const first = await provider.observe(observation());
    const repeated = await provider.observe(observation());
    expect(fake.requests.filter((request) => request.path.startsWith("/api/v3/logs/"))).toHaveLength(1);
    expect(first.review.fetched && repeated.review.fetched).toBe(true);
    if (first.review.fetched && repeated.review.fetched) {
      expect(repeated.review.bucket.facts.evidence.some((item) => item.kind === "check_log")).toBe(true);
    }
    checkId = 102;
    await provider.observe(observation({ forceFullRefresh: true }));
    expect(fake.requests.filter((request) => request.path.startsWith("/api/v3/logs/"))).toHaveLength(2);
  });

  it("walks every lookup page and includes the last page deterministically", async () => {
    const fake = await server((request) => {
      if (request.path.includes("page=2")) {
        return { json: [pull({ id: 7002, number: 2, html_url: `https://${HOST}/upstream/project/pull/2` })] };
      }
      return {
        json: [pull()],
        headers: { link: `<https://${HOST}/api/v3/lookup?page=2>; rel="next"` }
      };
    });
    const provider = createGithubScmProvider({ canonicalHost: HOST, transport: fake.transport });
    const result = await provider.lookupPullRequests(lookup());
    expect(result).toMatchObject({ fetched: true, complete: true });
    if (result.fetched) expect(result.candidates.map((candidate) => candidate.number)).toEqual([2, 7]);
    expect(fake.requests).toHaveLength(2);
  });

  it.each([
    {
      name: "cycle",
      link: `<https://${HOST}/api/v3/page-two>; rel="next"`,
      secondLink: `<https://${HOST}/api/v3/page-two>; rel="next"`
    },
    {
      name: "foreign host",
      link: `<https://attacker.invalid/steal?page=2>; rel="next"`,
      secondLink: undefined
    }
  ])("stops a $name pagination link, retains known items, and never leaves the host", async ({ link, secondLink }) => {
    const fake = await server((request) => request.path === "/api/v3/page-two"
      ? { json: [pull({ id: 7002, number: 2, html_url: `https://${HOST}/upstream/project/pull/2` })], ...(secondLink ? { headers: { link: secondLink } } : {}) }
      : { json: [pull()], headers: { link } });
    const provider = createGithubScmProvider({ canonicalHost: HOST, transport: fake.transport });
    const result = await provider.lookupPullRequests(lookup());
    expect(result).toMatchObject({ fetched: true, complete: false });
    if (result.fetched) expect(result.candidates.map((candidate) => candidate.number)).toContain(7);
    expect(fake.requests.some((request) => request.path.startsWith("/steal"))).toBe(false);
    expect(fake.requests.length).toBeLessThanOrEqual(2);
  });

  it("enforces page-item and decoded-response ceilings", async () => {
    const itemFake = await server(() => ({ json: [pull(), pull({ id: 7002, number: 2, html_url: `https://${HOST}/upstream/project/pull/2` })] }));
    const itemProvider = createGithubScmProvider({ canonicalHost: HOST, transport: itemFake.transport });
    const itemResult = await itemProvider.lookupPullRequests(lookup({
      limits: limits({ maxPagesPerEndpoint: 1, maxItemsPerPage: 1, maxItemsPerEndpoint: 1 })
    }));
    expect(itemResult).toEqual({ fetched: true, complete: false, candidates: [] });

    const byteFake = await server(() => ({ json: [pull()] }));
    const byteProvider = createGithubScmProvider({ canonicalHost: HOST, transport: byteFake.transport });
    const byteResult = await byteProvider.lookupPullRequests(lookup({
      limits: limits({ maxDecodedBytesPerRequest: 128, maxDecodedBytesPerPoll: 128 })
    }));
    expect(byteResult).toMatchObject({ fetched: false, failure: { kind: "budget_exceeded", code: "GITHUB_RESPONSE_BYTES" } });
  });

  it("enforces the page ceiling while retaining the bounded first page", async () => {
    const fake = await server(() => ({
      json: [pull()],
      headers: { link: `<https://${HOST}/api/v3/never-requested?page=2>; rel="next"` }
    }));
    const provider = createGithubScmProvider({ canonicalHost: HOST, transport: fake.transport });
    const result = await provider.lookupPullRequests(lookup({
      limits: limits({ maxPagesPerEndpoint: 1, maxItemsPerPage: 1, maxItemsPerEndpoint: 1 })
    }));
    expect(result).toMatchObject({ fetched: true, complete: false, candidates: [{ number: 7 }] });
    expect(fake.requests).toHaveLength(1);
  });

  it("never exceeds the aggregate decoded-byte ceiling across an observation", async () => {
    const fake = await server(defaultHandler());
    const provider = createGithubScmProvider({ canonicalHost: HOST, transport: fake.transport, now: () => new Date(NOW) });
    const result = await provider.observe(observation({
      limits: limits({ maxDecodedBytesPerRequest: 600, maxDecodedBytesPerPoll: 700 })
    }));
    expect(result.decodedBytes).toBeLessThanOrEqual(700);
    expect(result.pullRequest).toMatchObject({ fetched: true });
    expect(result.mergeability).toMatchObject({ fetched: false, failure: { kind: "budget_exceeded" } });
    expect(result.ci).not.toMatchObject({ fetched: true, bucket: { facts: { state: "passing" } } });
  });

  it("classifies malformed and truncated JSON without exposing response content", async () => {
    const secret = "ghp_super_secret_value";
    const fake = await server(() => ({ body: `[{"id":"${secret}"`, headers: { "content-type": "application/json" } }));
    const provider = createGithubScmProvider({ canonicalHost: HOST, transport: fake.transport });
    const result = await provider.lookupPullRequests(lookup());
    expect(result).toMatchObject({ fetched: false, failure: { kind: "schema", code: "GITHUB_JSON", retryable: false } });
    if (!result.fetched) expect(result.failure.diagnostic).not.toContain(secret);
  });

  it("propagates cancellation and enforces the per-request timeout", async () => {
    const waitingTransport: GithubTransport = (request) => new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new Error("credential=should-not-leak")), { once: true });
    });
    const provider = createGithubScmProvider({ canonicalHost: HOST, transport: waitingTransport });
    const controller = new AbortController();
    const pending = provider.lookupPullRequests(lookup({ signal: controller.signal }));
    controller.abort(new Error("caller secret"));
    await expect(pending).resolves.toMatchObject({ fetched: false, failure: { kind: "cancelled", code: "GITHUB_CANCELLED" } });
    await expect(provider.lookupPullRequests(lookup({ limits: limits({ requestTimeoutMs: 5 }) }))).resolves.toMatchObject({
      fetched: false,
      failure: { kind: "timeout", code: "GITHUB_TIMEOUT", retryable: true }
    });
  });

  it.each([
    { status: 429, headers: { "retry-after": "120" }, expectedAt: "2026-08-09T12:02:00.000Z" },
    { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Date.parse(NOW) / 1_000 + 90) }, expectedAt: "2026-08-09T12:01:30.000Z" }
  ])("normalizes rate limiting for HTTP $status with a bounded retry hint", async ({ status, headers, expectedAt }) => {
    const fake = await server(() => ({ status, headers, json: { message: "token ghp_must_not_leak" } }));
    const provider = createGithubScmProvider({ canonicalHost: HOST, transport: fake.transport, now: () => new Date(NOW) });
    const result = await provider.lookupPullRequests(lookup());
    expect(result).toMatchObject({
      fetched: false,
      failure: { kind: "rate_limited", code: "GITHUB_RATE_LIMIT", retryable: true, nextEligibleAt: expectedAt }
    });
    if (!result.fetched) expect(result.failure.diagnostic).not.toContain("ghp_must_not_leak");
  });

  it.each([
    { status: 401, kind: "auth", code: "GITHUB_AUTH" },
    { status: 403, kind: "permission", code: "GITHUB_PERMISSION" }
  ])("redacts HTTP $status authentication/permission failures", async ({ status, kind, code }) => {
    const fake = await server(() => ({ status, json: { message: "authorization Bearer ghp_must_not_leak" } }));
    const provider = createGithubScmProvider({ canonicalHost: HOST, transport: fake.transport });
    const result = await provider.lookupPullRequests(lookup());
    expect(result).toMatchObject({ fetched: false, failure: { kind, code, retryable: false } });
    if (!result.fetched) expect(JSON.stringify(result.failure)).not.toContain("ghp_must_not_leak");
  });

  it("uses ETags inside max age and forces unconditional refresh after max age", async () => {
    let nowMs = Date.parse(NOW);
    const fake = await server(defaultHandler());
    const provider = createGithubScmProvider({
      canonicalHost: HOST,
      transport: fake.transport,
      now: () => new Date(nowMs),
      maxGuardAgeMs: 1_000
    });
    const first = await provider.observe(observation());
    expect(first.pullRequest.fetched && first.ci.fetched && first.review.fetched && first.mergeability.fetched).toBe(true);
    if (!first.pullRequest.fetched || !first.ci.fetched || !first.review.fetched || !first.mergeability.fetched) return;
    const guards = {
      pullRequest: first.pullRequest.bucket.meta.guard,
      checks: first.ci.bucket.meta.guard,
      reviews: first.review.bucket.meta.guard,
      mergeability: first.mergeability.bucket.meta.guard
    };

    nowMs += 100;
    const conditionalStart = fake.requests.length;
    const second = await provider.observe(observation({ guards }));
    expect(second.pullRequest).toMatchObject({ fetched: true, notModified: true });
    expect(second.ci).toMatchObject({ fetched: true, notModified: true });
    expect(second.mergeability).toMatchObject({ fetched: true, notModified: true });
    const conditionalRest = fake.requests.slice(conditionalStart).filter((request) => request.path !== "/api/graphql");
    expect(conditionalRest.length).toBeGreaterThan(0);
    expect(conditionalRest.every((request) => request.headers["if-none-match"] !== undefined)).toBe(true);

    nowMs += 1_001;
    const forcedStart = fake.requests.length;
    await provider.observe(observation({ guards }));
    const forcedRest = fake.requests.slice(forcedStart).filter((request) => request.path !== "/api/graphql");
    expect(forcedRest.length).toBeGreaterThan(0);
    expect(forcedRest.every((request) => request.headers["if-none-match"] === undefined)).toBe(true);
  });

  it("retains a known failure when a later check page fails and never reports a partial pass", async () => {
    const baseHandler = defaultHandler();
    const fake = await server((request) => {
      if (request.path.includes("/check-runs") && request.path.includes("page=2")) return { status: 500, json: { message: "later page failed" } };
      if (request.path.includes("/check-runs")) {
        return {
          json: { total_count: 2, check_runs: [checkRun()] },
          headers: { link: `<https://${HOST}/api/v3/check-page?page=2>; rel="next"` }
        };
      }
      if (request.path === "/api/v3/check-page?page=2") return { status: 500, json: { message: "later page failed" } };
      return baseHandler(request);
    });
    const provider = createGithubScmProvider({ canonicalHost: HOST, transport: fake.transport, now: () => new Date(NOW) });
    const result = await provider.observe(observation());
    expect(result.ci).toMatchObject({
      fetched: true,
      bucket: { meta: { completeness: "partial" }, facts: { state: "failing" } }
    });
  });

  it("marks unknown mergeability and oversized/control-shaped evidence non-authoritative", async () => {
    const huge = `${"x".repeat(80)}\u0000tail`;
    const baseHandler = defaultHandler({ pull: pull({ mergeable: null, mergeable_state: "future_state" }) });
    const fake = await server((request) => request.path.endsWith("/pulls/7/comments?per_page=100")
      ? { json: [{ id: 201, body: huge, created_at: NOW, updated_at: NOW, user: { login: "reviewer", type: "User" } }] }
      : baseHandler(request));
    const provider = createGithubScmProvider({ canonicalHost: HOST, transport: fake.transport, now: () => new Date(NOW) });
    const result = await provider.observe(observation({
      limits: limits({ maxEvidenceBodyBytes: 16, maxEvidencePreviewBytes: 256 })
    }));
    expect(result.mergeability).toMatchObject({ fetched: true, bucket: { meta: { completeness: "partial" }, facts: { state: "unknown" } } });
    if (result.review.fetched) {
      const comment = result.review.bucket.facts.evidence.find((item) => item.kind === "inline_comment")!;
      expect(comment.retainedBytes).toBeLessThanOrEqual(16);
      expect(comment.body).not.toContain("\u0000");
      expect(comment.truncated).toBe(true);
      expect(comment.sanitized).toBe(true);
    }
  });

  it("creates only an exact pull request and treats write uncertainty or mismatch as ambiguous", async () => {
    const fake = await server((request) => request.method === "POST"
      ? { status: 201, json: pull() }
      : { status: 404 });
    const provider = createGithubScmProvider({ canonicalHost: HOST, transport: fake.transport });
    const created = await provider.createPullRequest(createRequest());
    expect(created).toMatchObject({ outcome: "created", pullRequest: { number: 7, headSha: HEAD, baseSha: BASE } });
    const post = fake.requests.find((request) => request.method === "POST")!;
    expect(JSON.parse(post.body.toString("utf8"))).toEqual({
      title: "RelayForge change",
      body: "Bounded pull request body",
      head: "relayforge:relayforge/run-1",
      base: "main",
      draft: false
    });
    expect(post.headers.authorization).toBeUndefined();

    const mismatchFake = await server(() => ({ status: 201, json: pull({ head: { ref: "other", sha: HEAD, repo: { full_name: "relayforge/project", name: "project", owner: { login: "relayforge" } } } }) }));
    const mismatchProvider = createGithubScmProvider({ canonicalHost: HOST, transport: mismatchFake.transport });
    await expect(mismatchProvider.createPullRequest(createRequest())).resolves.toMatchObject({ outcome: "ambiguous" });

    const uncertainFake = await server(() => ({ status: 422, json: { message: "already exists" } }));
    const uncertainProvider = createGithubScmProvider({ canonicalHost: HOST, transport: uncertainFake.transport });
    await expect(uncertainProvider.createPullRequest(createRequest())).resolves.toMatchObject({ outcome: "ambiguous" });
  });
});

import { describe, expect, it } from "vitest";
import { createGithubPullRequestBodyCrossLinkWriter } from "../src/scm/github-crosslinks.js";
import type { GithubTransport, GithubTransportRequest } from "../src/scm/github.js";
import type { ScmMultiRepoCrossLinkRequestV1 } from "../src/scm/multirepo-bridge.js";
import type { ScmRepositoryBindingV1 } from "../src/scm/product-policy.js";
import { SCM_PROVIDER_LIMITS } from "../src/scm/types.js";

const OID = "a".repeat(40);
const repository = Object.freeze({
  schemaVersion: 1 as const,
  provider: "github" as const,
  canonicalHost: "github.com",
  owner: "relayforge",
  name: "worker"
});
const baseRepository = Object.freeze({ ...repository, owner: "upstream" });
const binding: ScmRepositoryBindingV1 = Object.freeze({
  schemaVersion: 1,
  repositoryKey: "worker",
  repository,
  baseRepository,
  repositoryRoot: "/tmp",
  remoteName: "origin",
  expectedPushUrl: "https://github.com/relayforge/worker.git",
  baseRef: "refs/heads/main",
  credentialEnv: "GITHUB_TOKEN",
  capabilities: Object.freeze(["scm.publish_branch", "scm.read", "scm.write_pr"]),
  limits: SCM_PROVIDER_LIMITS,
  allowFileRemote: false
});

function request(signal = new AbortController().signal): ScmMultiRepoCrossLinkRequestV1 {
  return {
    entry: {
      repositoryId: "worker",
      publicationId: "publication-worker",
      candidateOid: OID,
      localIntegrationRef: "refs/heads/integration/worker",
      remoteName: "origin",
      expectedPushUrl: binding.expectedPushUrl,
      remoteRef: "refs/heads/relayforge/run-1",
      expectedRemoteOid: null,
      baseRef: "refs/heads/main",
      title: "RelayForge change",
      body: "Original bounded body"
    },
    publication: {
      publicationId: "publication-worker",
      generation: 1,
      version: 7,
      state: "published",
      intent: {
        schemaVersion: 1,
        publicationId: "publication-worker",
        publicationGeneration: 1,
        attempt: 1,
        runId: "run-1",
        runEpoch: "epoch-1",
        repository,
        integrationRef: "refs/heads/integration/worker",
        integrationOid: OID,
        localExpectedOid: OID,
        remoteName: "origin",
        remoteRef: "refs/heads/relayforge/run-1",
        expectedRemote: { kind: "absent" },
        baseRepository,
        baseRef: "refs/heads/main",
        titleSha256: "b".repeat(64),
        bodySha256: "c".repeat(64),
        draft: false,
        createdAt: "2026-08-09T12:00:00.000Z"
      },
      taskId: "task-1",
      taskGeneration: 1,
      observedRemoteOid: OID,
      pullRequest: {
        providerId: "pr-7",
        number: 7,
        url: "https://github.com/upstream/worker/pull/7",
        repository: baseRepository,
        headRepository: repository,
        headRef: "refs/heads/relayforge/run-1",
        headSha: OID,
        baseRepository,
        baseRef: "refs/heads/main",
        baseSha: "d".repeat(40),
        lifecycle: "open",
        draft: false
      },
      createdSeq: 4,
      updatedSeq: 8
    },
    binding,
    artifacts: Object.freeze([
      Object.freeze({ repositoryId: "api", artifactId: "pr-4", url: "https://github.com/upstream/api/pull/4" }),
      Object.freeze({ repositoryId: "worker", artifactId: "pr-7", url: "https://github.com/upstream/worker/pull/7" })
    ]),
    signal
  };
}

function pull(body: string, identity: Partial<{ number: number; sha: string }> = {}): unknown {
  return {
    number: identity.number ?? 7,
    body,
    head: { sha: identity.sha ?? OID, ref: "relayforge/run-1", repo: { full_name: "relayforge/worker" } },
    base: { ref: "main", repo: { full_name: "upstream/worker" } }
  };
}

function desiredBody(): string {
  return "Original bounded body\n\n<!-- relayforge-crosslinks-v1 -->\nRelated RelayForge changes:\n" +
    "- api: https://github.com/upstream/api/pull/4\n" +
    "- worker: https://github.com/upstream/worker/pull/7\n" +
    "<!-- /relayforge-crosslinks-v1 -->\n";
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("GitHub PR-body cross-link authority", () => {
  it("reuses an exact existing block without a mutation", async () => {
    const calls: GithubTransportRequest[] = [];
    const transport: GithubTransport = async (value) => {
      calls.push(value);
      return json(pull(desiredBody()));
    };
    const result = await createGithubPullRequestBodyCrossLinkWriter({ transports: { worker: transport } })
      .ensureCrossLinks(request());
    expect(result).toMatchObject({ state: "completed", completedBy: "existing", value: { digest: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
    expect(calls[0]!.url).toBe("https://api.github.com/repos/upstream/worker/pulls/7");
  });

  it("bounds an ambiguous PATCH to one exact reconciliation GET", async () => {
    const calls: GithubTransportRequest[] = [];
    let remoteBody = "Original bounded body";
    const transport: GithubTransport = async (value) => {
      calls.push(value);
      if (value.method === "GET") return json(pull(remoteBody));
      remoteBody = JSON.parse(Buffer.from(value.body!).toString("utf8")).body as string;
      return json({ message: "response lost" }, 503);
    };
    const result = await createGithubPullRequestBodyCrossLinkWriter({ transports: { worker: transport } })
      .ensureCrossLinks(request());
    expect(result).toMatchObject({ state: "completed", completedBy: "reconciled" });
    expect(calls.map((call) => call.method)).toEqual(["GET", "PATCH", "GET"]);
    expect(remoteBody).toBe(desiredBody());
    expect(JSON.stringify(calls)).not.toContain("authorization");
  });

  it("fails closed on identity drift, cancellation, and oversized remote bodies", async () => {
    const identityWriter = createGithubPullRequestBodyCrossLinkWriter({
      transports: { worker: async () => json(pull("body", { sha: "f".repeat(40) })) }
    });
    await expect(identityWriter.ensureCrossLinks(request())).resolves.toMatchObject({ state: "recovery_required", code: "GITHUB_CROSSLINK_IDENTITY" });

    const controller = new AbortController();
    controller.abort();
    await expect(identityWriter.ensureCrossLinks(request(controller.signal))).resolves.toMatchObject({ state: "retry", code: "GITHUB_CROSSLINK_CANCELLED" });

    const largeWriter = createGithubPullRequestBodyCrossLinkWriter({
      transports: { worker: async () => json(pull("x".repeat(64 * 1024 + 1))) }
    });
    await expect(largeWriter.ensureCrossLinks(request())).resolves.toMatchObject({ state: "recovery_required", code: "GITHUB_CROSSLINK_BODY_LIMIT" });
  });
});

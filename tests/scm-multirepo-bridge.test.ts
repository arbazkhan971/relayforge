import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseControlEvent } from "../src/control/events.js";
import { openControlStore, type ControlStore } from "../src/control/store.js";
import {
  applyMultiRepoPublicationEvent,
  createMultiRepoPublicationEvent,
  reconcileMultiRepoPublicationOnce,
  type MultiRepoPublicationPlanV1,
  type MultiRepoPublicationProjectionV1
} from "../src/multirepo/publication.js";
import { createParentSteeringService } from "../src/steering/service.js";
import { createParentScmLifecycle } from "../src/scm/lifecycle.js";
import { createScmMultiRepoPublicationBridge, type ScmMultiRepoCrossLinkWriterV1 } from "../src/scm/multirepo-bridge.js";
import type { ScmGitCommandRunner } from "../src/scm/publish.js";
import type { ScmRepositoryBindingV1 } from "../src/scm/product-policy.js";
import { SCM_PROVIDER_LIMITS, type ScmProviderV1, type ScmPullRequestFactV1 } from "../src/scm/types.js";

const NOW = "2026-08-09T12:00:00.000Z";
const OID = "a".repeat(40);
const roots: string[] = [];
const stores: ControlStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) try { store.close(); } catch { /* closed */ }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "relayforge-scm-mr-")));
  roots.push(root);
  const store = openControlStore({ path: join(root, "control.sqlite"), runId: "run-1", runEpoch: "epoch-1", now: () => NOW });
  stores.push(store);
  store.append(parseControlEvent({
    schemaVersion: 1, eventId: "task-created", runId: "run-1", runEpoch: "epoch-1",
    taskId: "task-1", taskGeneration: 1, expectedVersion: 0, occurredAt: NOW, type: "task.created",
    payload: { title: "Multi repo publish", assignee: "backend", createdBy: "parent", description: "Publish vector", acceptanceCriteria: ["PR"], dependsOn: [], priority: 1, createdAt: NOW }
  }));
  const repository = Object.freeze({ schemaVersion: 1 as const, provider: "github" as const, canonicalHost: "github.example.com", owner: "relayforge", name: "api" });
  const baseRepository = Object.freeze({ ...repository, owner: "upstream" });
  const binding: ScmRepositoryBindingV1 = Object.freeze({
    schemaVersion: 1,
    repositoryKey: "api",
    repository,
    baseRepository,
    repositoryRoot: root,
    remoteName: "origin",
    expectedPushUrl: "https://github.example.com/relayforge/api.git",
    baseRef: "refs/heads/main",
    credentialEnv: "TEST_TOKEN",
    capabilities: Object.freeze(["scm.publish_branch", "scm.read", "scm.write_pr"]),
    limits: SCM_PROVIDER_LIMITS,
    allowFileRemote: false
  });
  let remotePublished = false;
  const runner: ScmGitCommandRunner = {
    async run(request) {
      if (request.args[0] === "rev-parse" && request.args[1] === "--show-toplevel") return { disposition: "exited", exitCode: 0, stdout: `${root}\n`, stderr: "" };
      if (request.args[0] === "remote") return { disposition: "exited", exitCode: 0, stdout: `${binding.expectedPushUrl}\n`, stderr: "" };
      if (request.args[0] === "rev-parse") return { disposition: "exited", exitCode: 0, stdout: `${OID}\n`, stderr: "" };
      if (request.args[0] === "cat-file") return { disposition: "exited", exitCode: 0, stdout: "", stderr: "" };
      if (request.args[0] === "ls-remote") return { disposition: "exited", exitCode: 0, stdout: remotePublished ? `${OID}\trefs/heads/relayforge/api\n` : "", stderr: "" };
      if (request.args[0] === "push") { remotePublished = true; return { disposition: "exited", exitCode: 0, stdout: "ok\n", stderr: "" }; }
      throw new Error(`unexpected Git argv ${request.args.join(" ")}`);
    }
  };
  let pull: ScmPullRequestFactV1 | undefined;
  let creates = 0;
  const provider: ScmProviderV1 = {
    provider: "github",
    capabilities: Object.freeze(["scm.read", "scm.write_pr"]),
    async observe() { throw new Error("not used"); },
    async lookupPullRequests() { return { fetched: true, complete: true, candidates: pull ? [pull] : [] }; },
    async createPullRequest() {
      creates += 1;
      pull = {
        providerId: "pr-12", number: 12, url: "https://github.example.com/upstream/api/pull/12",
        repository: baseRepository, headRepository: repository, headRef: "refs/heads/relayforge/api", headSha: OID,
        baseRepository, baseRef: "refs/heads/main", baseSha: "b".repeat(40), lifecycle: "open", draft: false
      };
      return { outcome: "created", pullRequest: pull };
    }
  };
  const lifecycle = createParentScmLifecycle({
    store, binding, provider, gitRunner: runner, actorId: "scm-parent", now: () => new Date(NOW),
    steering: createParentSteeringService({ store, authority: { principal: "scm-parent", sourceKind: "review_gate" }, now: () => new Date(NOW) })
  });
  return { store, binding, lifecycle, creates: () => creates };
}

function plan(binding: ScmRepositoryBindingV1): MultiRepoPublicationPlanV1 {
  return {
    schemaVersion: 1,
    transactionId: "txn-1",
    repositorySetId: sha("set"),
    localIntegrationReceiptDigest: sha("receipt"),
    policyApproved: true,
    entries: [{
      repositoryId: "api",
      publicationId: "publish-api",
      candidateOid: OID,
      localIntegrationRef: "refs/heads/integration/api",
      remoteName: binding.remoteName,
      expectedPushUrl: binding.expectedPushUrl,
      remoteRef: "refs/heads/relayforge/api",
      expectedRemoteOid: null,
      baseRef: "main",
      title: "Publish API",
      body: "Related PR: https://github.example.com/upstream/api/pull/12"
    }]
  };
}

async function finish(projection: MultiRepoPublicationProjectionV1, adapter: ReturnType<typeof createScmMultiRepoPublicationBridge>) {
  let current = projection;
  for (let count = 0; count < 8 && current.state !== "published" && current.state !== "recovery_required"; count += 1) {
    const event = await reconcileMultiRepoPublicationOnce(current, adapter);
    if (!event) break;
    current = applyMultiRepoPublicationEvent(current, event);
  }
  return current;
}

describe("P6 to canonical SCM publication bridge", () => {
  it("keeps P6 branch/PR/cross-link steps ordered while P3 owns each remote side effect", async () => {
    const value = setup();
    const crossLinkWriter: ScmMultiRepoCrossLinkWriterV1 = {
      async ensureCrossLinks(request) {
        expect(request.publication.state).toBe("published");
        expect(request.artifacts).toEqual([{ repositoryId: "api", artifactId: "pr-12", url: "https://github.example.com/upstream/api/pull/12" }]);
        return { state: "completed", value: { digest: sha(request.artifacts) }, completedBy: "update" };
      }
    };
    const adapter = createScmMultiRepoPublicationBridge({
      contexts: { api: { lifecycle: value.lifecycle, binding: value.binding, taskId: "task-1", taskGeneration: 1, signal: new AbortController().signal } },
      crossLinkWriter
    });
    const initial = applyMultiRepoPublicationEvent(undefined, createMultiRepoPublicationEvent(plan(value.binding)));
    const branchEvent = await reconcileMultiRepoPublicationOnce(initial, adapter);
    expect(branchEvent).toMatchObject({ type: "publication.branch_recorded", completedBy: "reconciled" });
    expect(value.store.getProjection().scm.publications["publish-api"]).toMatchObject({ state: "branch_published" });
    expect(value.creates()).toBe(0);
    const completed = await finish(applyMultiRepoPublicationEvent(initial, branchEvent!), adapter);
    expect(completed.state).toBe("published");
    expect(value.creates()).toBe(1);
    expect(value.store.getProjection().scm.publications["publish-api"]).toMatchObject({ state: "published" });
  });

  it("fails closed when cross-link authority is absent or plan identity differs", async () => {
    const value = setup();
    const adapter = createScmMultiRepoPublicationBridge({
      contexts: { api: { lifecycle: value.lifecycle, binding: value.binding, taskId: "task-1", taskGeneration: 1, signal: new AbortController().signal } }
    });
    const completed = await finish(applyMultiRepoPublicationEvent(undefined, createMultiRepoPublicationEvent(plan(value.binding))), adapter);
    expect(completed).toMatchObject({ state: "recovery_required", recoveryReason: "api:crosslink:SCM_CROSSLINK_CAPABILITY_MISSING" });
    await expect(adapter.publishBranch({ ...plan(value.binding).entries[0]!, expectedPushUrl: "https://github.example.com/relayforge/other.git" }))
      .rejects.toMatchObject({ code: "PLAN_MISMATCH" });
  });
});

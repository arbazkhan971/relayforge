import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseControlEvent } from "../src/control/events.js";
import { openControlStore, type ControlStore } from "../src/control/store.js";
import { createParentSteeringService } from "../src/steering/service.js";
import { createParentScmLifecycle } from "../src/scm/lifecycle.js";
import { SCM_PROVIDER_LIMITS, type ScmProviderV1, type ScmPullRequestFactV1, type ScmRepositoryIdV1 } from "../src/scm/types.js";
import type { ScmRepositoryBindingV1 } from "../src/scm/product-policy.js";

const NOW = "2026-08-09T12:00:00.000Z";
const roots: string[] = [];
const stores: ControlStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    try { store.close(); } catch { /* restart tests close early */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Fixture = Readonly<{
  root: string;
  local: string;
  remote: string;
  storePath: string;
  oid: string;
  binding: ScmRepositoryBindingV1;
}>;

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "relayforge-scm-lifecycle-")));
  roots.push(root);
  const local = join(root, "local");
  const remote = join(root, "remote.git");
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  execFileSync("git", ["init", local], { stdio: "ignore" });
  git(local, ["config", "user.email", "relayforge@example.invalid"]);
  git(local, ["config", "user.name", "RelayForge Test"]);
  writeFileSync(join(local, "README.md"), "immutable candidate\n", { encoding: "utf8", mode: 0o600 });
  git(local, ["add", "README.md"]);
  git(local, ["commit", "-m", "candidate"]);
  const oid = git(local, ["rev-parse", "HEAD"]);
  git(local, ["update-ref", "refs/heads/integration", oid]);
  const pushUrl = pathToFileURL(realpathSync(remote)).href;
  git(local, ["remote", "add", "origin", pushUrl]);
  const repository: ScmRepositoryIdV1 = Object.freeze({ schemaVersion: 1, provider: "github", canonicalHost: "github.example.com", owner: "relayforge", name: "project" });
  const baseRepository: ScmRepositoryIdV1 = Object.freeze({ ...repository, owner: "upstream" });
  return Object.freeze({
    root,
    local: realpathSync(local),
    remote: realpathSync(remote),
    storePath: join(root, "control.sqlite"),
    oid,
    binding: Object.freeze({
      schemaVersion: 1,
      repositoryKey: "repo-project",
      repository,
      baseRepository,
      repositoryRoot: realpathSync(local),
      remoteName: "origin",
      expectedPushUrl: pushUrl,
      baseRef: "refs/heads/main",
      credentialEnv: "TEST_TOKEN",
      capabilities: Object.freeze(["scm.publish_branch", "scm.read", "scm.write_pr"]),
      limits: SCM_PROVIDER_LIMITS,
      allowFileRemote: true
    })
  });
}

function open(fx: Fixture, fault?: Parameters<typeof openControlStore>[0]["fault"]): ControlStore {
  const store = openControlStore({ path: fx.storePath, runId: "run-1", runEpoch: "epoch-1", now: () => NOW, ...(fault ? { fault } : {}) });
  stores.push(store);
  return store;
}

function seed(store: ControlStore): void {
  if (store.getProjection().tasks["task-1"]) return;
  store.append(parseControlEvent({
    schemaVersion: 1,
    eventId: "task-created",
    runId: "run-1",
    runEpoch: "epoch-1",
    taskId: "task-1",
    taskGeneration: 1,
    expectedVersion: 0,
    occurredAt: NOW,
    type: "task.created",
    payload: {
      title: "Publish candidate",
      assignee: "backend",
      createdBy: "parent",
      description: "Publish an immutable candidate.",
      acceptanceCriteria: ["remote receipt"],
      dependsOn: [],
      priority: 1,
      createdAt: NOW
    }
  }));
}

function pull(fx: Fixture): ScmPullRequestFactV1 {
  return {
    providerId: "pr-7",
    number: 7,
    url: "https://github.example.com/upstream/project/pull/7",
    repository: fx.binding.baseRepository,
    headRepository: fx.binding.repository,
    headRef: "refs/heads/relayforge/run-1",
    headSha: fx.oid,
    baseRepository: fx.binding.baseRepository,
    baseRef: fx.binding.baseRef,
    baseSha: "b".repeat(40),
    lifecycle: "open",
    draft: false
  };
}

function provider(fx: Fixture, behavior: {
  pull?: ScmPullRequestFactV1;
  ambiguousCreate?: boolean;
  creates?: number;
}): ScmProviderV1 {
  return {
    provider: "github",
    capabilities: Object.freeze(["scm.read", "scm.write_pr"]),
    async observe() { throw new Error("not used by publication tests"); },
    async lookupPullRequests() {
      return { fetched: true, complete: true, candidates: behavior.pull ? [behavior.pull] : [] };
    },
    async createPullRequest() {
      behavior.creates = (behavior.creates ?? 0) + 1;
      behavior.pull = pull(fx);
      return behavior.ambiguousCreate
        ? { outcome: "ambiguous", diagnostic: "response lost" }
        : { outcome: "created", pullRequest: behavior.pull };
    }
  };
}

function lifecycle(fx: Fixture, store: ControlStore, value: ScmProviderV1) {
  return createParentScmLifecycle({
    store,
    binding: fx.binding,
    provider: value,
    steering: createParentSteeringService({ store, authority: { principal: "scm-parent", sourceKind: "review_gate" }, now: () => new Date(NOW) }),
    actorId: "scm-parent",
    now: () => new Date(NOW)
  });
}

function request(fx: Fixture) {
  return {
    taskId: "task-1",
    taskGeneration: 1,
    repositoryKey: fx.binding.repositoryKey,
    publicationId: "publication-1",
    publicationGeneration: 1,
    attempt: 1,
    integrationRef: "refs/heads/integration",
    integrationOid: fx.oid,
    localExpectedOid: fx.oid,
    remoteName: "origin",
    remoteRef: "refs/heads/relayforge/run-1",
    expectedRemote: { kind: "absent" as const },
    baseRef: fx.binding.baseRef,
    title: "RelayForge candidate",
    body: "Bounded publication body",
    draft: false,
    signal: new AbortController().signal
  };
}

describe("parent SCM publication lifecycle", () => {
  it("records intent, leases the exact remote ref, creates one PR and survives store restart", async () => {
    const fx = fixture();
    const store = open(fx);
    seed(store);
    const behavior: { pull?: ScmPullRequestFactV1; creates?: number } = {};
    const result = await lifecycle(fx, store, provider(fx, behavior)).publish(request(fx));
    expect(result).toMatchObject({ status: "published", publication: { state: "published", observedRemoteOid: fx.oid } });
    expect(behavior.creates).toBe(1);
    expect(git(fx.local, ["ls-remote", "--refs", "origin", "refs/heads/relayforge/run-1"])).toContain(fx.oid);
    store.close();
    const restarted = open(fx);
    expect(restarted.getProjection().scm.publications["publication-1"]).toMatchObject({ state: "published", pullRequest: { providerId: "pr-7" } });
    const retried = await lifecycle(fx, restarted, provider(fx, behavior)).publish(request(fx));
    expect(retried.status).toBe("published");
    expect(behavior.creates).toBe(1);
  });

  it("reconciles a crash after the push but before its canonical state transition", async () => {
    const fx = fixture();
    let crash = true;
    const store = open(fx, (point, event) => {
      if (crash && point === "before-commit" && event?.type === "scm.publication_state_changed" && event.payload.toState === "branch_published") {
        crash = false;
        throw new Error("simulated parent crash before branch receipt commit");
      }
    });
    seed(store);
    const behavior: { pull?: ScmPullRequestFactV1; creates?: number } = {};
    await expect(lifecycle(fx, store, provider(fx, behavior)).publish(request(fx))).rejects.toThrow("simulated parent crash");
    expect(git(fx.local, ["ls-remote", "--refs", "origin", "refs/heads/relayforge/run-1"])).toContain(fx.oid);
    expect(store.getProjection().scm.publications["publication-1"]).toMatchObject({ state: "push_intent" });
    store.close();
    const restarted = open(fx);
    const recovered = await lifecycle(fx, restarted, provider(fx, behavior)).publish(request(fx));
    expect(recovered.status).toBe("published");
    expect(behavior.creates).toBe(1);
  });

  it("reconciles an ambiguous PR create after restart without creating a duplicate", async () => {
    const fx = fixture();
    const store = open(fx);
    seed(store);
    const behavior: { pull?: ScmPullRequestFactV1; ambiguousCreate?: boolean; creates?: number } = { ambiguousCreate: true };
    const first = await lifecycle(fx, store, provider(fx, behavior)).publish(request(fx));
    expect(first).toMatchObject({ status: "ambiguous", publication: { state: "pr_ambiguous" } });
    expect(behavior.creates).toBe(1);
    store.close();
    behavior.ambiguousCreate = false;
    const restarted = open(fx);
    const recovered = await lifecycle(fx, restarted, provider(fx, behavior)).publish(request(fx));
    expect(recovered.status).toBe("published");
    expect(behavior.creates).toBe(1);
  });

  it("stops at the branch boundary when used by the multi-repository saga", async () => {
    const fx = fixture();
    const store = open(fx);
    seed(store);
    const behavior: { pull?: ScmPullRequestFactV1; creates?: number } = {};
    const parent = lifecycle(fx, store, provider(fx, behavior));
    const branch = await parent.publishBranch(request(fx));
    expect(branch).toMatchObject({ status: "branch_published", remoteOid: fx.oid });
    expect(behavior.creates ?? 0).toBe(0);
    expect(store.getProjection().scm.publications["publication-1"]).toMatchObject({ state: "branch_published" });
  });

  it("refuses divergent retry identity before any second remote side effect", async () => {
    const fx = fixture();
    const store = open(fx);
    seed(store);
    const behavior: { pull?: ScmPullRequestFactV1; ambiguousCreate?: boolean; creates?: number } = { ambiguousCreate: true };
    await lifecycle(fx, store, provider(fx, behavior)).publish(request(fx));
    await expect(lifecycle(fx, store, provider(fx, behavior)).publish({ ...request(fx), title: "divergent title" }))
      .rejects.toMatchObject({ code: "PUBLICATION_CONFLICT" });
    expect(behavior.creates).toBe(1);
  });
});

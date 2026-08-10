import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectSchema } from "../src/config/schema.js";
import { parseControlEvent, type ControlEvent } from "../src/control/events.js";
import { openControlStore, type ControlStore } from "../src/control/store.js";
import { createParentScmProductAuthority } from "../src/scm/product-authority.js";
import { createParentSteeringService } from "../src/steering/service.js";
import {
  startFakeGithubServer,
  type FakeGithubServer
} from "./fixtures/scm-github/fake-server.js";

const NOW = "2026-08-09T12:00:00.000Z";
const EPOCH = "epoch_1234567890123456";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const roots: string[] = [];
const stores: ControlStore[] = [];
const servers: FakeGithubServer[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) try { store.close(); } catch { /* restart closed it */ }
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

function project() {
  return ProjectSchema.parse({
    name: "product",
    providers: { worker: { type: "custom", command: "/usr/bin/false", args: [] } },
    repositories: [{ name: "api", path: "api", defaultBranch: "main", protectedBranches: ["main"] }],
    scm: {
      repositories: [{
        repository: "api",
        canonicalHost: "github.example.com",
        owner: "relayforge",
        name: "project",
        baseOwner: "upstream",
        baseName: "project",
        expectedPushUrl: "https://github.example.com/relayforge/project.git",
        baseRef: "refs/heads/main",
        credentialEnv: "RELAYFORGE_GITHUB_TOKEN"
      }],
      crossLinks: { mode: "pull-request-body" }
    },
    multiRepository: {
      providerRepositories: { worker: ["api"] },
      tasks: [{
        id: "ship-api",
        role: "implementer",
        provider: "worker",
        repositories: ["api"],
        entries: [{ repository: "api", branch: "rf-api", targetRef: "refs/heads/integration" }],
        verifyCommands: ["true"],
        commitMessage: "ship api",
        publication: {
          policyApproved: true,
          entries: [{
            repository: "api",
            publicationId: "publication-api",
            remoteName: "origin",
            expectedPushUrl: "https://github.example.com/relayforge/project.git",
            remoteRef: "refs/heads/relayforge/run-1",
            expectedRemoteOid: null,
            baseRef: "refs/heads/main",
            title: "Ship API",
            body: "Bounded body"
          }]
        }
      }]
    },
    roles: [{ name: "implementer", title: "Implementer", provider: "worker", repositories: ["api"] }],
    loops: [{ name: "delivery", orchestrator: "implementer", reviewer: "implementer" }]
  });
}

async function github(): Promise<FakeGithubServer> {
  const server = await startFakeGithubServer((request) => {
    const path = request.path;
    const etag = `"${path.split("?")[0]}"`;
    if (path === "/api/v3/repos/upstream/project/pulls/7") return {
      json: {
        id: 7001,
        number: 7,
        html_url: "https://github.example.com/upstream/project/pull/7",
        state: "open",
        merged: false,
        merged_at: null,
        draft: false,
        mergeable: true,
        mergeable_state: "clean",
        head: { ref: "relayforge/run-1", sha: HEAD, repo: { full_name: "relayforge/project", name: "project", owner: { login: "relayforge" } } },
        base: { ref: "main", sha: BASE, repo: { full_name: "upstream/project", name: "project", owner: { login: "upstream" } } }
      },
      headers: { etag }
    };
    if (path.includes("/protection/required_status_checks")) return { json: { contexts: ["build"] }, headers: { etag } };
    if (path.includes("/check-runs")) return {
      json: {
        total_count: 1,
        check_runs: [{
          id: 101,
          name: "build",
          status: "completed",
          conclusion: "failure",
          run_attempt: 1,
          started_at: NOW,
          completed_at: NOW,
          details_url: "https://github.example.com/upstream/project/actions/runs/101",
          log_url: "https://github.example.com/api/v3/logs/101",
          check_suite: { id: 501 },
          app: { slug: "github-actions" },
          output: { title: "Build failed", summary: "compiler error" }
        }]
      },
      headers: { etag }
    };
    if (path.includes("/statuses")) return { json: [], headers: { etag } };
    if (path.endsWith("/pulls/7/reviews?per_page=100")) return {
      json: [{
        id: 301,
        state: "CHANGES_REQUESTED",
        body: "Please add the missing regression test.",
        submitted_at: NOW,
        user: { login: "reviewer", type: "User" },
        html_url: "https://github.example.com/upstream/project/pull/7#pullrequestreview-301"
      }],
      headers: { etag }
    };
    if (path.endsWith("/pulls/7/comments?per_page=100") || path.endsWith("/issues/7/comments?per_page=100")) {
      return { json: [], headers: { etag } };
    }
    if (path === "/api/graphql") return {
      json: { data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }
    };
    if (path === "/api/v3/logs/101") return { body: "FAIL expected true to be false\n" };
    return { status: 404, json: { message: "not found" } };
  });
  servers.push(server);
  return server;
}

function open(path: string): ControlStore {
  const store = openControlStore({ path, runId: "run-1", runEpoch: EPOCH, now: () => NOW });
  stores.push(store);
  return store;
}

function publicationEvents(store: ControlStore): ControlEvent[] {
  const taskVersion = store.getProjection().aggregateVersions["task:ship-api:1"]!.version;
  const repository = { schemaVersion: 1 as const, provider: "github" as const, canonicalHost: "github.example.com", owner: "relayforge", name: "project" };
  const baseRepository = { ...repository, owner: "upstream" };
  const intent = {
    schemaVersion: 1 as const,
    publicationId: "publication-api",
    publicationGeneration: 1,
    attempt: 1,
    runId: store.runId,
    runEpoch: store.runEpoch,
    repository,
    integrationRef: "refs/heads/integration",
    integrationOid: HEAD,
    localExpectedOid: HEAD,
    remoteName: "origin",
    remoteRef: "refs/heads/relayforge/run-1",
    expectedRemote: { kind: "absent" as const },
    baseRepository,
    baseRef: "refs/heads/main",
    titleSha256: sha("Ship API"),
    bodySha256: sha("Bounded body"),
    draft: false,
    createdAt: NOW
  };
  const pullRequest = {
    providerId: "7001",
    number: 7,
    url: "https://github.example.com/upstream/project/pull/7",
    repository: baseRepository,
    headRepository: repository,
    headRef: intent.remoteRef,
    headSha: HEAD,
    baseRepository,
    baseRef: intent.baseRef,
    baseSha: BASE,
    lifecycle: "open" as const,
    draft: false
  };
  const base = {
    schemaVersion: 1 as const,
    runId: store.runId,
    runEpoch: store.runEpoch,
    taskId: "ship-api",
    taskGeneration: 1,
    occurredAt: NOW,
    actorKind: "integration" as const,
    actorId: "test-parent",
    sourceKind: null,
    sourceId: null,
    sourceGeneration: null,
    sourceEventId: null
  };
  return [
    parseControlEvent({ ...base, eventId: "publication-recorded", expectedVersion: taskVersion, type: "scm.publication_recorded", payload: { publication: intent } }),
    parseControlEvent({ ...base, eventId: "publication-push-intent", expectedVersion: taskVersion + 1, type: "scm.publication_state_changed", payload: { publicationId: intent.publicationId, publicationGeneration: 1, fromState: "unpublished", toState: "push_intent" } }),
    parseControlEvent({ ...base, eventId: "publication-branch", expectedVersion: taskVersion + 2, type: "scm.publication_state_changed", payload: { publicationId: intent.publicationId, publicationGeneration: 1, fromState: "push_intent", toState: "branch_published", observedRemoteOid: HEAD } }),
    parseControlEvent({ ...base, eventId: "publication-pr-intent", expectedVersion: taskVersion + 3, type: "scm.publication_state_changed", payload: { publicationId: intent.publicationId, publicationGeneration: 1, fromState: "branch_published", toState: "pr_intent" } }),
    parseControlEvent({ ...base, eventId: "publication-published", expectedVersion: taskVersion + 4, type: "scm.publication_state_changed", payload: { publicationId: intent.publicationId, publicationGeneration: 1, fromState: "pr_intent", toState: "published", pullRequest } })
  ];
}

function authority(
  root: string,
  store: ControlStore,
  server: FakeGithubServer,
  clocks: Readonly<{
    now?: () => Date;
    monotonicNowMs?: () => number;
    pollIntervalMs?: number;
  }> = {}
) {
  const steering = createParentSteeringService({
    store,
    authority: { principal: "scm-parent", sourceKind: "review_gate" },
    now: clocks.now ?? (() => new Date(NOW))
  });
  return createParentScmProductAuthority({
    project: project(),
    configRoot: root,
    store,
    steering,
    actorId: "scm-parent",
    environment: { RELAYFORGE_GITHUB_TOKEN: "test-token" },
    transports: { api: server.transport },
    now: clocks.now ?? (() => new Date(NOW)),
    ...(clocks.monotonicNowMs === undefined ? {} : { monotonicNowMs: clocks.monotonicNowMs }),
    pollIntervalMs: clocks.pollIntervalMs ?? 60_000
  });
}

describe("parent SCM product authority", () => {
  it("seeds exact shared targets, automatically polls a published artifact, and resumes after restart", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "relayforge-scm-authority-")));
    roots.push(root);
    mkdirSync(join(root, "api"));
    const path = join(root, "control.sqlite");
    const fake = await github();
    const store = open(path);
    const first = authority(root, store, fake);
    expect(store.getProjection()).toMatchObject({
      tasks: { "ship-api": { generation: 1, assignee: "implementer" } }
    });
    expect(Object.values(store.getProjection().runtimes)).toEqual([
      expect.objectContaining({ taskId: "ship-api", taskGeneration: 1, observation: "available" })
    ]);
    store.appendBatch(publicationEvents(store));
    await first.pollPublishedNow();
    const projection = store.getProjection();
    expect(Object.values(projection.scm.polls)).toEqual([
      expect.objectContaining({ publicationId: "publication-api", state: "completed", pollAttempt: 1 })
    ]);
    expect(Object.values(projection.scm.reactions).map((reaction) => reaction.state))
      .toEqual(expect.arrayContaining(["command_admitted"]));
    expect(Object.values(projection.steering)).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: "ship-api", status: "pending", sourceKind: "review_gate" })
    ]));
    await first.closeAndDrain();
    store.close();

    const restarted = open(path);
    const second = authority(root, restarted, fake);
    await second.pollPublishedNow();
    expect(Object.values(restarted.getProjection().scm.polls)[0]).toMatchObject({ pollAttempt: 2, state: "completed" });
    expect(Object.values(restarted.getProjection().steering)).toHaveLength(Object.values(projection.steering).length);
    await second.closeAndDrain();
  });

  it("uses exact monotonic cadence boundaries and is immune to event-clock jumps", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "relayforge-scm-cadence-")));
    roots.push(root);
    mkdirSync(join(root, "api"));
    const path = join(root, "control.sqlite");
    const fake = await github();
    const store = open(path);
    let cadence = 10_000;
    const interval = 60_000;
    const wallClock = vi.spyOn(Date, "now").mockReturnValue(new Date(NOW).getTime());
    const current = authority(root, store, fake, {
      now: () => new Date(NOW),
      monotonicNowMs: () => cadence,
      pollIntervalMs: interval
    });
    store.appendBatch(publicationEvents(store));

    await current.pollPublishedNow();
    expect(Object.values(store.getProjection().scm.polls)).toHaveLength(1);

    // Arbitrary ambient wall-clock movement cannot make a process-local cadence interval elapse.
    wallClock.mockReturnValue(new Date("2099-12-31T23:59:59.000Z").getTime());
    cadence += interval - 1;
    await current.pollPublishedNow();
    expect(Object.values(store.getProjection().scm.polls)).toHaveLength(1);
    expect(Object.values(store.getProjection().scm.polls)[0]).toMatchObject({ pollAttempt: 1 });

    // The exact monotonic boundary is eligible even when the ambient wall clock jumps backwards.
    wallClock.mockReturnValue(new Date("2000-01-01T00:00:00.000Z").getTime());
    cadence += 1;
    await current.pollPublishedNow();
    expect(Object.values(store.getProjection().scm.polls)).toHaveLength(1);
    expect(Object.values(store.getProjection().scm.polls)[0]).toMatchObject({ pollAttempt: 2 });
    await current.closeAndDrain();

    // Cadence state is deliberately process-local: restart immediately reconciles durable facts.
    store.close();
    const restarted = open(path);
    const next = authority(root, restarted, fake, {
      now: () => new Date(NOW),
      monotonicNowMs: () => cadence,
      pollIntervalMs: interval
    });
    await next.pollPublishedNow();
    expect(Object.values(restarted.getProjection().scm.polls)).toHaveLength(1);
    expect(Object.values(restarted.getProjection().scm.polls)[0]).toMatchObject({ pollAttempt: 3 });
    await next.closeAndDrain();
  });
});

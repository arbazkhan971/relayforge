import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  MultiRepositoryCanonicalJournalConflictError,
  MultiRepositoryOrchestrationError,
  materializeMultiRepositoryRunPlan,
  projectMultiRepositoryCanonicalFacts,
  runMultiRepositoryOrchestration,
  type ContainedMultiRepositoryWorker,
  type MaterializedMultiRepositoryRunPlanV1,
  type MultiRepositoryCanonicalFactV1,
  type MultiRepositoryCanonicalJournalSnapshotV1,
  type MultiRepositoryCanonicalJournalV1,
  type MultiRepositoryOrchestrationDependencies,
  type MultiRepositoryRunRequestV1,
  type MultiRepositoryWorkerRequestV1,
  type MultiRepositoryWorkerSettlementV1
} from "../src/multirepo/orchestration.js";
import type { RepositoryDefinitionV1, RepositoryIdentityResolver } from "../src/multirepo/domain.js";
import type { MultiRepoPublicationAdapter } from "../src/multirepo/publication.js";

const roots: string[] = [];
const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "multirepo-contained-worker.mjs");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

type RepositoryFixture = Readonly<{
  id: string;
  root: string;
  defaultBranch: string;
  baseOid: string;
  integrationRef: string;
}>;

function repository(parent: string, id: string, defaultBranch: string): RepositoryFixture {
  const root = join(parent, id);
  execFileSync("mkdir", ["-p", root]);
  git(root, "init", "-b", defaultBranch);
  git(root, "config", "user.name", "RelayForge Test");
  git(root, "config", "user.email", "relayforge@example.invalid");
  writeFileSync(join(root, "base.txt"), `${id} base\n`, "utf8");
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  const baseOid = git(root, "rev-parse", "HEAD");
  const integrationRef = `refs/heads/relayforge/integration/${id}`;
  git(root, "update-ref", integrationRef, baseOid);
  return Object.freeze({ id, root: realpathSync(root), defaultBranch, baseOid, integrationRef });
}

type Fixture = Readonly<{
  root: string;
  repositories: readonly RepositoryFixture[];
  request: MultiRepositoryRunRequestV1;
  resolveIdentity: RepositoryIdentityResolver;
}>;

function setup(execute = true, publish = true): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "relayforge-multirepo-orchestration-")));
  roots.push(root);
  chmodSync(root, 0o700);
  const repositoryParent = join(root, "repositories");
  execFileSync("mkdir", ["-p", repositoryParent]);
  const repositories = [
    repository(repositoryParent, "api", "main"),
    repository(repositoryParent, "web", "trunk"),
    repository(repositoryParent, "secret", "main")
  ];
  const definitions: RepositoryDefinitionV1[] = repositories.map((item) => ({
    schemaVersion: 1,
    repositoryId: item.id,
    configuredPath: item.root,
    defaultBranch: item.defaultBranch,
    protectedBranches: [item.defaultBranch]
  }));
  const resolveIdentity: RepositoryIdentityResolver = (definition) => {
    const repositoryValue = repositories.find((item) => item.id === definition.repositoryId)!;
    const rootStat = statSync(repositoryValue.root);
    const common = realpathSync(git(repositoryValue.root, "rev-parse", "--path-format=absolute", "--git-common-dir"));
    const commonStat = statSync(common);
    return {
      canonicalRoot: repositoryValue.root,
      rootDevice: rootStat.dev,
      rootInode: rootStat.ino,
      gitCommonDirDevice: commonStat.dev,
      gitCommonDirInode: commonStat.ino
    };
  };
  const publication = publish ? {
    policyApproved: true,
    entries: ["api", "web"].map((repositoryId) => ({
      repositoryId,
      publicationId: `publish-${repositoryId}`,
      remoteName: "origin",
      expectedPushUrl: "https://github.com/example/project.git",
      remoteRef: `refs/heads/relayforge/publication/${repositoryId}`,
      expectedRemoteOid: null,
      baseRef: repositories.find((item) => item.id === repositoryId)!.defaultBranch,
      title: `Update ${repositoryId}`,
      body: "Coordinated multi-repository change"
    }))
  } : undefined;
  const request: MultiRepositoryRunRequestV1 = {
    schemaVersion: 1,
    runId: "run-multirepo",
    runEpoch: sha("run-epoch"),
    workspaceRoot: join(root, "private-workspaces"),
    execute,
    repositoryDefinitions: definitions,
    tasks: [{
      schemaVersion: 1,
      taskId: "feature-one",
      taskGeneration: 1,
      roleId: "engineer",
      providerId: "codex",
      repositoryIds: ["api", "web"],
      dependencies: []
    }],
    executions: [{
      taskId: "feature-one",
      priority: 10,
      entries: ["api", "web"].map((repositoryId) => ({
        repositoryId,
        branch: `relayforge/run-multirepo/${repositoryId}`,
        targetRef: repositories.find((item) => item.id === repositoryId)!.integrationRef
      })),
      verifyCommands: ["verify-combined"],
      verifyEnvironment: { RELAYFORGE_TEST: "1" },
      commitMessage: "relayforge: coordinated child vector",
      ...(publication === undefined ? {} : { publication })
    }],
    capabilities: {
      roles: { engineer: ["api", "web"] },
      providers: { codex: ["api", "web"] }
    }
  };
  return Object.freeze({ root, repositories: Object.freeze(repositories), request, resolveIdentity });
}

class CanonicalJournal implements MultiRepositoryCanonicalJournalV1 {
  readonly facts: MultiRepositoryCanonicalFactV1[] = [];
  controlHeadSeq = 7;
  conflictOnce = false;
  failKind?: MultiRepositoryCanonicalFactV1["kind"];
  failWhen?: (fact: MultiRepositoryCanonicalFactV1) => boolean;

  constructor(readonly runId: string, readonly runEpoch: string) {}

  read(): MultiRepositoryCanonicalJournalSnapshotV1 {
    return Object.freeze({
      schemaVersion: 1,
      runId: this.runId,
      runEpoch: this.runEpoch,
      controlHeadSeq: this.controlHeadSeq,
      headVersion: this.facts.length,
      facts: Object.freeze([...this.facts])
    });
  }

  append(input: Readonly<{ expectedControlHeadSeq: number; expectedHeadVersion: number; fact: MultiRepositoryCanonicalFactV1 }>): MultiRepositoryCanonicalJournalSnapshotV1 {
    if (this.conflictOnce) {
      this.conflictOnce = false;
      this.controlHeadSeq += 1; // another canonical aggregate advanced, P6 did not
      throw new MultiRepositoryCanonicalJournalConflictError();
    }
    if (input.expectedControlHeadSeq !== this.controlHeadSeq || input.expectedHeadVersion !== this.facts.length) {
      throw new MultiRepositoryCanonicalJournalConflictError();
    }
    if (input.fact.kind === this.failKind || this.failWhen?.(input.fact)) throw new Error("injected durable append failure");
    this.facts.push(input.fact);
    this.controlHeadSeq += 1;
    return this.read();
  }
}

/** Node 24+ stabilized the flag as `--permission`; earlier majors use `--experimental-permission`. */
function nodePermissionFlag(): string {
  const major = Number(process.versions.node.split(".")[0] ?? 0);
  return major >= 24 ? "--permission" : "--experimental-permission";
}

function containedWorker(onRequest?: (request: MultiRepositoryWorkerRequestV1) => void): ContainedMultiRepositoryWorker {
  return {
    async run(request, acknowledgeDispatch): Promise<MultiRepositoryWorkerSettlementV1> {
      onRequest?.(request);
      const processIdentity = `permission-scope:${sha(request.leaseToken).slice(0, 24)}`;
      acknowledgeDispatch(processIdentity);
      const readable = [fixturePath, ...request.members.map((member) => member.path)];
      const writable = request.members.map((member) => member.path);
      const result = spawnSync(process.execPath, [
        nodePermissionFlag(),
        ...readable.map((path) => `--allow-fs-read=${path}`),
        ...writable.map((path) => `--allow-fs-write=${path}`),
        fixturePath,
        ...request.members.map((member) => member.path)
      ], { encoding: "utf8", env: Object.freeze({ PATH: process.env.PATH ?? "" }) });
      const ok = result.status === 0 && result.signal === null;
      return Object.freeze({
        schemaVersion: 1,
        processIdentity,
        settlementCallId: `settlement-${request.attemptId}`,
        outputDigest: sha(`${result.stdout}\0${result.stderr}\0${result.status}`),
        summary: ok ? result.stdout.trim() : `${result.stderr}\n${result.stdout}`.trim(),
        transportTrusted: ok,
        scopeTrusted: ok,
        scopeReaped: true,
        settlementTrusted: ok
      });
    }
  };
}

function dependencies(
  value: Fixture,
  journal: CanonicalJournal,
  worker: ContainedMultiRepositoryWorker = containedWorker()
): MultiRepositoryOrchestrationDependencies {
  return {
    resolveRepositoryIdentity: value.resolveIdentity,
    journal,
    worker,
    integrationAuthority: {
      acquire(ids) {
        const exact = [...ids];
        expect(exact).toEqual([...exact].sort((left, right) => left.localeCompare(right)));
        let released = false;
        return {
          assertHeld(requested) {
            if (released || JSON.stringify(requested) !== JSON.stringify(exact)) throw new Error("integration authority differs");
          },
          release() { released = true; }
        };
      }
    },
    integration: {
      verificationObserver: {
        observe(entry) {
          const status = git(entry.canonicalWorkspacePath, "status", "--porcelain", "--untracked-files=all");
          return { candidateOid: entry.candidateOid, treeOid: entry.treeOid, clean: status === "", identityExact: true };
        }
      },
      verificationExecutor: {
        async run(request) {
          const combined = request.entries.map((entry) => `${entry.repositoryId}:${readFileSync(join(entry.canonicalWorkspacePath, `worker-${entry.repositoryId}.txt`), "utf8").trim()}`).join("|");
          return { ok: true, code: 0, outputDigest: sha(combined), outputBytes: Buffer.byteLength(combined), fingerprint: sha(request.manifestDigest), transportTrusted: true, scopeTrusted: true };
        }
      },
      verifiedAt: () => "2026-08-09T12:30:00.000Z"
    },
    publicationAdapter: {
      async publishBranch(plan) { return { state: "completed", value: { remoteOid: plan.candidateOid }, completedBy: "push" }; },
      async ensurePullRequest(plan) { return { state: "completed", value: { artifactId: `pr-${plan.repositoryId}`, url: `https://example.invalid/${plan.repositoryId}` }, completedBy: "create" }; },
      async ensureCrossLinks({ artifacts }) { return { state: "completed", value: { digest: sha(JSON.stringify(artifacts)) }, completedBy: "update" }; }
    },
    concurrency: { global: 2, perProvider: 2, perRepository: 1, perTask: 1 },
    ownerId: "owner-one",
    ownerIncarnation: "owner:one",
    now: () => new Date("2026-08-09T12:00:00.000Z"),
    randomToken: () => sha("lease-token")
  };
}

function publicationHarness(options: Readonly<{ retryFirstBranch?: boolean }> = {}): Readonly<{
  adapter: MultiRepoPublicationAdapter;
  calls: { branch: number; pullRequest: number; crossLink: number };
  effects: { branches: Set<string>; pullRequests: Set<string>; crossLinks: Set<string> };
}> {
  const calls = { branch: 0, pullRequest: 0, crossLink: 0 };
  const effects = {
    branches: new Set<string>(),
    pullRequests: new Set<string>(),
    crossLinks: new Set<string>()
  };
  let retryFirstBranch = options.retryFirstBranch === true;
  const adapter: MultiRepoPublicationAdapter = {
    async publishBranch(plan) {
      calls.branch += 1;
      if (retryFirstBranch) {
        retryFirstBranch = false;
        return { state: "retry", code: "REMOTE_TEMPORARY" };
      }
      const existing = effects.branches.has(plan.repositoryId);
      effects.branches.add(plan.repositoryId);
      return { state: "completed", value: { remoteOid: plan.candidateOid }, completedBy: existing ? "reconciled" : "push" };
    },
    async ensurePullRequest(plan) {
      calls.pullRequest += 1;
      const existing = effects.pullRequests.has(plan.repositoryId);
      effects.pullRequests.add(plan.repositoryId);
      return {
        state: "completed",
        value: { artifactId: `pr-${plan.repositoryId}`, url: `https://example.invalid/${plan.repositoryId}` },
        completedBy: existing ? "reconciled" : "create"
      };
    },
    async ensureCrossLinks({ entry, artifacts }) {
      calls.crossLink += 1;
      const existing = effects.crossLinks.has(entry.repositoryId);
      effects.crossLinks.add(entry.repositoryId);
      return {
        state: "completed",
        value: { digest: sha(JSON.stringify(artifacts)) },
        completedBy: existing ? "reconciled" : "update"
      };
    }
  };
  return Object.freeze({ adapter, calls, effects });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("canonical multi-repository orchestration", () => {
  it("lands a contained two-repository vector, hides the third repository, and publishes separately", async () => {
    const value = setup();
    const journal = new CanonicalJournal(value.request.runId, value.request.runEpoch);
    journal.conflictOnce = true;
    let manifest: MultiRepositoryWorkerRequestV1 | undefined;
    const outcome = await runMultiRepositoryOrchestration(value.request, dependencies(value, journal, containedWorker((request) => { manifest = request; })));

    expect(outcome.state).toBe("done");
    expect(outcome.tasks).toEqual([expect.objectContaining({ taskId: "feature-one", state: "published" })]);
    expect(manifest?.members.map((member) => member.repositoryId)).toEqual(["api", "web"]);
    expect(JSON.stringify(manifest)).not.toContain(value.repositories[2]!.root);
    expect(readFileSync(join(value.repositories[2]!.root, "base.txt"), "utf8")).toBe("secret base\n");
    expect(() => readFileSync(join(value.repositories[2]!.root, "worker-secret.txt"), "utf8")).toThrow();

    for (const repositoryValue of value.repositories.slice(0, 2)) {
      expect(git(repositoryValue.root, "rev-parse", repositoryValue.integrationRef)).not.toBe(repositoryValue.baseOid);
      expect(git(repositoryValue.root, "rev-parse", `refs/heads/${repositoryValue.defaultBranch}`)).toBe(repositoryValue.baseOid);
      expect(git(repositoryValue.root, "status", "--porcelain", "--untracked-files=all")).toBe("");
    }
    const projection = projectMultiRepositoryCanonicalFacts(journal.facts);
    expect(projection.scheduler.tasks["feature-one"]).toMatchObject({ state: "completed", lease: undefined });
    expect(Object.values(projection.integrations)[0]).toMatchObject({ state: "applied" });
    expect(Object.values(projection.publications)[0]).toMatchObject({ state: "published" });
    expect(projection.worktreeGroups["feature-one"]).toMatchObject({ state: "reclaimed" });
  });

  it("dry-runs a durable plan without worktrees, workers, integration refs, or publication", async () => {
    const value = setup(false, false);
    const journal = new CanonicalJournal(value.request.runId, value.request.runEpoch);
    let workerCalls = 0;
    const worker = containedWorker(() => { workerCalls += 1; });
    const outcome = await runMultiRepositoryOrchestration(value.request, dependencies(value, journal, worker));
    expect(outcome.state).toBe("planned");
    expect(workerCalls).toBe(0);
    expect(existsSync(value.request.workspaceRoot)).toBe(false);
    expect(journal.facts.map((fact) => fact.kind)).toEqual(["multirepo.plan_registered", "multirepo.scheduler_transitioned"]);
    for (const repositoryValue of value.repositories) {
      expect(git(repositoryValue.root, "rev-parse", repositoryValue.integrationRef)).toBe(repositoryValue.baseOid);
    }
  });

  it("refuses unauthorized repository scope before the first canonical or Git mutation", () => {
    const value = setup();
    const request = { ...value.request, capabilities: { roles: { engineer: ["api"] }, providers: { codex: ["api", "web"] } } };
    const journal = new CanonicalJournal(value.request.runId, value.request.runEpoch);
    expect(() => materializeMultiRepositoryRunPlan(request, value.resolveIdentity)).toThrowError(expect.objectContaining({ code: "CAPABILITY_REFUSED" }));
    expect(journal.facts).toHaveLength(0);
    for (const repositoryValue of value.repositories) expect(git(repositoryValue.root, "rev-parse", repositoryValue.integrationRef)).toBe(repositoryValue.baseOid);
  });

  it("retains authority and never launches a worker when canonical worktree readiness cannot append", async () => {
    const value = setup();
    const journal = new CanonicalJournal(value.request.runId, value.request.runEpoch);
    journal.failKind = "multirepo.worktree_group_recorded";
    let workerCalls = 0;
    await expect(runMultiRepositoryOrchestration(value.request, dependencies(value, journal, containedWorker(() => { workerCalls += 1; })))).rejects.toMatchObject({
      code: "CANONICAL_APPEND_FAILED",
      authorityMustRemainHeld: true
    });
    expect(workerCalls).toBe(0);
    for (const repositoryValue of value.repositories) expect(git(repositoryValue.root, "rev-parse", repositoryValue.integrationRef)).toBe(repositoryValue.baseOid);
  });

  it("recovers a settled contained worker without launching a replacement after its fact append was lost", async () => {
    const value = setup(true, false);
    const journal = new CanonicalJournal(value.request.runId, value.request.runEpoch);
    journal.failKind = "multirepo.worker_settled";
    const delegate = containedWorker();
    let remembered: MultiRepositoryWorkerSettlementV1 | undefined;
    let launches = 0;
    let recoveries = 0;
    const worker: ContainedMultiRepositoryWorker = {
      async run(request, acknowledge) {
        launches += 1;
        remembered = await delegate.run(request, acknowledge);
        return remembered;
      },
      async recover(_request, processIdentity) {
        recoveries += 1;
        return remembered?.processIdentity === processIdentity ? remembered : undefined;
      }
    };
    await expect(runMultiRepositoryOrchestration(value.request, dependencies(value, journal, worker))).rejects.toMatchObject({
      code: "CANONICAL_APPEND_FAILED",
      authorityMustRemainHeld: true
    });
    journal.failKind = undefined;
    const outcome = await runMultiRepositoryOrchestration(value.request, dependencies(value, journal, worker));
    expect(outcome.state).toBe("done");
    expect(launches).toBe(1);
    expect(recoveries).toBe(1);
  });

  it("refuses a replaced receipted worktree before restart recovery, provider launch, or parent Git", async () => {
    const value = setup(true, false);
    const journal = new CanonicalJournal(value.request.runId, value.request.runEpoch);
    journal.failKind = "multirepo.worker_settled";
    let launches = 0;
    const worker = containedWorker(() => { launches += 1; });
    await expect(runMultiRepositoryOrchestration(value.request, dependencies(value, journal, worker))).rejects.toMatchObject({
      code: "CANONICAL_APPEND_FAILED",
      authorityMustRemainHeld: true
    });
    expect(launches).toBe(1);

    const recorded = projectMultiRepositoryCanonicalFacts(journal.facts).worktreeGroups["feature-one"]!;
    const member = recorded.members[0]!;
    const displaced = `${member.path}.displaced`;
    renameSync(member.path, displaced);
    mkdirSync(member.path, { mode: 0o700 });
    journal.failKind = undefined;

    await expect(runMultiRepositoryOrchestration(value.request, dependencies(value, journal, worker))).rejects.toMatchObject({
      code: "WORKTREE_RECOVERY_REQUIRED",
      authorityMustRemainHeld: true
    });
    expect(launches).toBe(1);
    expect(existsSync(displaced)).toBe(true);
    for (const repositoryValue of value.repositories) {
      expect(git(repositoryValue.root, "rev-parse", repositoryValue.integrationRef)).toBe(repositoryValue.baseOid);
    }
  });

  it("re-observes an already-applied repository CAS after a crash before its canonical event", async () => {
    const value = setup(true, false);
    const journal = new CanonicalJournal(value.request.runId, value.request.runEpoch);
    let injected = false;
    journal.failWhen = (fact) => {
      if (!injected && fact.kind === "multirepo.integration_transitioned" && fact.event.type === "integration.entry_applied") {
        injected = true;
        return true;
      }
      return false;
    };
    await expect(runMultiRepositoryOrchestration(value.request, dependencies(value, journal))).rejects.toMatchObject({
      code: "CANONICAL_APPEND_FAILED",
      authorityMustRemainHeld: true
    });
    expect(git(value.repositories[0]!.root, "rev-parse", value.repositories[0]!.integrationRef)).not.toBe(value.repositories[0]!.baseOid);
    expect(git(value.repositories[1]!.root, "rev-parse", value.repositories[1]!.integrationRef)).toBe(value.repositories[1]!.baseOid);

    journal.failWhen = undefined;
    const outcome = await runMultiRepositoryOrchestration(value.request, dependencies(value, journal));
    expect(outcome.state).toBe("done");
    const integration = Object.values(projectMultiRepositoryCanonicalFacts(journal.facts).integrations)[0]!;
    expect(integration.entries[0]!.applyResult?.state).toBe("already_applied");
    expect(integration.state).toBe("applied");
  });

  it("reconciles a publication effect after its canonical append crashes and completes the scheduler only afterward", async () => {
    const value = setup(true, true);
    const journal = new CanonicalJournal(value.request.runId, value.request.runEpoch);
    const publication = publicationHarness();
    let workerLaunches = 0;
    const base = dependencies(value, journal, containedWorker(() => { workerLaunches += 1; }));
    const runtime = { ...base, publicationAdapter: publication.adapter };
    let crash = true;
    journal.failWhen = (fact) => {
      if (crash && fact.kind === "multirepo.publication_transitioned" && fact.event.type === "publication.branch_recorded") {
        crash = false;
        return true;
      }
      return false;
    };

    await expect(runMultiRepositoryOrchestration(value.request, runtime)).rejects.toMatchObject({
      code: "CANONICAL_APPEND_FAILED",
      authorityMustRemainHeld: true
    });
    const interrupted = projectMultiRepositoryCanonicalFacts(journal.facts);
    expect(interrupted.scheduler.tasks["feature-one"]).toMatchObject({ state: "active" });
    expect(interrupted.scheduler.tasks["feature-one"]?.lease).toBeDefined();
    expect(interrupted.worktreeGroups["feature-one"]).toMatchObject({ state: "reclaimed" });
    expect(Object.values(interrupted.publications)[0]).toMatchObject({ state: "publishing" });
    expect(publication.effects.branches).toEqual(new Set(["api"]));
    expect(workerLaunches).toBe(1);

    journal.failWhen = undefined;
    const outcome = await runMultiRepositoryOrchestration(value.request, runtime);
    expect(outcome).toMatchObject({ state: "done", tasks: [{ state: "published" }] });
    expect(workerLaunches).toBe(1);
    expect(publication.calls).toEqual({ branch: 3, pullRequest: 2, crossLink: 2 });
    expect(publication.effects.branches).toEqual(new Set(["api", "web"]));
    expect(publication.effects.pullRequests).toEqual(new Set(["api", "web"]));
    expect(publication.effects.crossLinks).toEqual(new Set(["api", "web"]));

    const completed = projectMultiRepositoryCanonicalFacts(journal.facts);
    expect(Object.values(completed.publications)[0]?.entries[0]?.branch?.completedBy).toBe("reconciled");
    expect(completed.scheduler.tasks["feature-one"]).toMatchObject({ state: "completed", lease: undefined });
    const publicationCompletedIndex = journal.facts.findIndex((fact) =>
      fact.kind === "multirepo.publication_transitioned" && fact.event.type === "publication.completed"
    );
    const schedulerCompletedIndex = journal.facts.findIndex((fact) =>
      fact.kind === "multirepo.scheduler_transitioned" &&
      fact.event.type === "scheduler.lease_released" && fact.event.outcome === "completed"
    );
    expect(publicationCompletedIndex).toBeGreaterThan(-1);
    expect(schedulerCompletedIndex).toBeGreaterThan(publicationCompletedIndex);
  });

  it("retains the exact task lease across retryable publication partial and resumes without another worker or remote effect", async () => {
    const value = setup(true, true);
    const journal = new CanonicalJournal(value.request.runId, value.request.runEpoch);
    const publication = publicationHarness({ retryFirstBranch: true });
    let workerLaunches = 0;
    const base = dependencies(value, journal, containedWorker(() => { workerLaunches += 1; }));
    const runtime = { ...base, publicationAdapter: publication.adapter };

    const first = await runMultiRepositoryOrchestration(value.request, runtime);
    expect(first).toMatchObject({ state: "blocked", tasks: [{ state: "publication_partial" }] });
    const partial = projectMultiRepositoryCanonicalFacts(journal.facts);
    const retainedLease = partial.scheduler.tasks["feature-one"]?.lease;
    expect(partial.scheduler.tasks["feature-one"]).toMatchObject({ state: "active" });
    expect(retainedLease).toBeDefined();
    expect(partial.worktreeGroups["feature-one"]).toMatchObject({ state: "reclaimed" });
    expect(Object.values(partial.publications)[0]).toMatchObject({ state: "partial" });
    expect(publication.effects.branches.size).toBe(0);
    expect(workerLaunches).toBe(1);

    const second = await runMultiRepositoryOrchestration(value.request, runtime);
    expect(second).toMatchObject({ state: "done", tasks: [{ state: "published" }] });
    expect(workerLaunches).toBe(1);
    expect(publication.calls).toEqual({ branch: 3, pullRequest: 2, crossLink: 2 });
    expect(publication.effects.branches).toEqual(new Set(["api", "web"]));
    expect(publication.effects.pullRequests).toEqual(new Set(["api", "web"]));
    expect(publication.effects.crossLinks).toEqual(new Set(["api", "web"]));
    const completed = projectMultiRepositoryCanonicalFacts(journal.facts);
    expect(completed.scheduler.tasks["feature-one"]).toMatchObject({ state: "completed", lease: undefined });
    expect(completed.scheduler.tasks["feature-one"]?.version).toBeGreaterThan(partial.scheduler.tasks["feature-one"]!.version);
  });

  it("completes a local-only task after reclamation and replays it without another worker", async () => {
    const value = setup(true, false);
    const journal = new CanonicalJournal(value.request.runId, value.request.runEpoch);
    let workerLaunches = 0;
    const runtime = dependencies(value, journal, containedWorker(() => { workerLaunches += 1; }));

    const first = await runMultiRepositoryOrchestration(value.request, runtime);
    const second = await runMultiRepositoryOrchestration(value.request, runtime);
    expect(first).toMatchObject({ state: "done", tasks: [{ state: "applied" }] });
    expect(second).toMatchObject({ state: "done", tasks: [{ state: "applied" }] });
    expect(workerLaunches).toBe(1);
    const projection = projectMultiRepositoryCanonicalFacts(journal.facts);
    expect(Object.keys(projection.publications)).toHaveLength(0);
    expect(projection.worktreeGroups["feature-one"]).toMatchObject({ state: "reclaimed" });
    expect(projection.scheduler.tasks["feature-one"]).toMatchObject({ state: "completed", lease: undefined });
  });

  it("rejects an unapproved publication vector during pure plan validation", () => {
    const value = setup(true, true);
    const request: MultiRepositoryRunRequestV1 = {
      ...value.request,
      executions: value.request.executions.map((execution) => ({
        ...execution,
        publication: execution.publication === undefined ? undefined : { ...execution.publication, policyApproved: false }
      }))
    };
    expect(() => materializeMultiRepositoryRunPlan(request, value.resolveIdentity)).toThrowError(expect.objectContaining({ code: "INVALID_PLAN" }));
    for (const repositoryValue of value.repositories) expect(git(repositoryValue.root, "rev-parse", repositoryValue.integrationRef)).toBe(repositoryValue.baseOid);
  });

  it("rejects a divergent immutable plan on restart", async () => {
    const value = setup(false, false);
    const journal = new CanonicalJournal(value.request.runId, value.request.runEpoch);
    await runMultiRepositoryOrchestration(value.request, dependencies(value, journal));
    const changed = {
      ...value.request,
      executions: value.request.executions.map((execution) => ({ ...execution, commitMessage: "different reviewed plan" }))
    };
    await expect(runMultiRepositoryOrchestration(changed, dependencies(value, journal))).rejects.toBeInstanceOf(MultiRepositoryOrchestrationError);
    await expect(runMultiRepositoryOrchestration(changed, dependencies(value, journal))).rejects.toMatchObject({ code: "CANONICAL_IDENTITY_MISMATCH", authorityMustRemainHeld: true });
  });
});

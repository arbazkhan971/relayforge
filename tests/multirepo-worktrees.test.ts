import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  materializeRepositorySet,
  type RepositoryIdentityV1,
  type RepositorySetV1
} from "../src/multirepo/domain.js";
import {
  WORKTREE_GROUP_RECEIPT_LEAF,
  WorktreeGroupError,
  WorktreeGroupInterruptedError,
  assertReadyWorktreeGroupExact,
  prepareWorktreeGroup,
  readWorktreeGroupReceipt,
  reclaimWorktreeGroup,
  reconcileWorktreeGroup,
  type WorktreeGroupOptions,
  type WorktreeGroupResult
} from "../src/multirepo/worktrees.js";
import { registerOwnedTemp } from "./global-teardown.js";

const hardenedGitConfig = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "diff.external=",
  "-c", "credential.helper=",
  "-c", "core.pager=cat"
];

const roots: string[] = [];

type RepositoryFixture = Readonly<{
  id: string;
  root: string;
  defaultBranch: string;
  anchor: string;
  identity: RepositoryIdentityV1;
}>;

type GroupFixture = Readonly<{
  root: string;
  groupRoot: string;
  repositories: readonly RepositoryFixture[];
  repositorySet: RepositorySetV1;
}>;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...hardenedGitConfig, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", GIT_EXTERNAL_DIFF: "" }
  }).trim();
}

function ref(cwd: string, name: string): string | undefined {
  const result = spawnSync("git", [...hardenedGitConfig, "rev-parse", "--verify", `${name}^{commit}`], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", GIT_EXTERNAL_DIFF: "" }
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function makeRepository(parent: string, id: string, defaultBranch: string): RepositoryFixture {
  const root = resolve(parent, id);
  mkdirSync(root, { mode: 0o700 });
  git(root, "init", "-q", "-b", defaultBranch);
  git(root, "config", "user.name", "RelayForge Worktree Test");
  git(root, "config", "user.email", "relayforge@example.invalid");
  writeFileSync(join(root, ".gitignore"), ".toolchain/\n");
  writeFileSync(join(root, "README.md"), `# ${id}\n`);
  git(root, "add", ".gitignore", "README.md");
  git(root, "commit", "-qm", `baseline ${id}`);
  git(root, "branch", "integration");

  const tool = join(root, ".toolchain", "bin", "relay-tool");
  mkdirSync(resolve(tool, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(tool, `#!/bin/sh\nprintf '${id}\\n'\n`, { mode: 0o755 });
  chmodSync(tool, 0o755);

  const canonicalRoot = realpathSync.native(root);
  const common = realpathSync.native(git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  const rootMetadata = lstatSync(canonicalRoot);
  const commonMetadata = lstatSync(common);
  const anchor = git(root, "rev-parse", `${defaultBranch}^{commit}`);
  return Object.freeze({
    id,
    root: canonicalRoot,
    defaultBranch,
    anchor,
    identity: Object.freeze({
      schemaVersion: 1,
      repositoryId: id,
      canonicalRoot,
      rootDevice: rootMetadata.dev,
      rootInode: rootMetadata.ino,
      gitCommonDirDevice: commonMetadata.dev,
      gitCommonDirInode: commonMetadata.ino,
      defaultBranch,
      protectedBranches: Object.freeze([defaultBranch, "integration"])
    })
  });
}

function fixture(defaultBranches: readonly string[]): GroupFixture {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "loop-multirepo-worktrees-")));
  roots.push(root);
  registerOwnedTemp(root);
  chmodSync(root, 0o700);
  const repositoryParent = join(root, "repositories");
  const groupParent = join(root, "groups");
  mkdirSync(repositoryParent, { mode: 0o700 });
  mkdirSync(groupParent, { mode: 0o700 });
  const ids = ["alpha", "beta", "gamma"].slice(0, defaultBranches.length);
  const repositories = ids.map((id, index) => makeRepository(repositoryParent, id!, defaultBranches[index]!));
  const repositorySet = materializeRepositorySet(
    { schemaVersion: 1, repositories: repositories.map((entry) => entry.identity) },
    repositories.map((entry) => entry.id)
  );
  return Object.freeze({ root, groupRoot: join(groupParent, "group-one"), repositories, repositorySet });
}

function options(value: GroupFixture): WorktreeGroupOptions {
  return Object.freeze({
    groupId: "group-one",
    groupRoot: value.groupRoot,
    repositorySet: value.repositorySet,
    authority: Object.freeze({
      taskId: "task-one",
      taskGeneration: 1,
      attemptId: "attempt-one",
      leaseToken: "lease-token-00000001"
    }),
    entries: Object.freeze(value.repositories.map((repository) => Object.freeze({
      repository: repository.identity,
      branch: `relayforge/group-one/${repository.id}`,
      provision: Object.freeze([Object.freeze({
        path: ".toolchain",
        requiredExecutables: Object.freeze(["bin/relay-tool"])
      })])
    })))
  });
}

function entry(result: WorktreeGroupResult, id: string) {
  const found = result.receipt.entries.find((candidate) => candidate.repository.repositoryId === id);
  if (found === undefined) throw new Error(`missing receipt entry ${id}`);
  return found;
}

function expectProtectedRefsUnchanged(repository: RepositoryFixture): void {
  expect(git(repository.root, "rev-parse", `${repository.defaultBranch}^{commit}`)).toBe(repository.anchor);
  expect(git(repository.root, "rev-parse", "integration^{commit}")).toBe(repository.anchor);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("multi-repository worktree readiness groups", () => {
  it("creates and provisions two exact repositories with different default branches before readiness", () => {
    const value = fixture(["main", "develop"]);
    const request = options(value);
    const result = prepareWorktreeGroup(request);

    expect(result.status).toBe("ready");
    expect(result.members.map((member) => member.repositoryId)).toEqual(["alpha", "beta"]);
    expect(new Set(result.members.map((member) => member.path)).size).toBe(2);
    expect(readWorktreeGroupReceipt(value.groupRoot)).toEqual(result.receipt);
    const receiptBytes = readFileSync(join(value.groupRoot, WORKTREE_GROUP_RECEIPT_LEAF), "utf8");
    expect(assertReadyWorktreeGroupExact(value.groupRoot)).toEqual(result.receipt);
    expect(readFileSync(join(value.groupRoot, WORKTREE_GROUP_RECEIPT_LEAF), "utf8")).toBe(receiptBytes);
    expect(statSync(join(value.groupRoot, WORKTREE_GROUP_RECEIPT_LEAF)).mode & 0o777).toBe(0o600);
    expect(statSync(value.groupRoot).mode & 0o777).toBe(0o700);

    for (const [index, member] of result.members.entries()) {
      const repository = value.repositories[index]!;
      expect(member.path).toBe(join(value.groupRoot, repository.id));
      expect(member.anchorOid).toBe(repository.anchor);
      expect(git(member.path, "rev-parse", "HEAD^{commit}")).toBe(repository.anchor);
      expectProtectedRefsUnchanged(repository);
      expect(ref(repository.root, `refs/heads/${member.branch}`)).toBe(repository.anchor);
      expect(readFileSync(join(member.path, ".toolchain", "bin", "relay-tool"), "utf8")).toContain(repository.id);
      expect(statSync(join(member.path, ".toolchain", "bin", "relay-tool")).mode & 0o111).not.toBe(0);
      expect(git(repository.root, "status", "--porcelain", "--untracked-files=all")).toBe("");
    }
  });

  it("reclaims three repositories in reverse order, including an advanced private work branch", () => {
    const value = fixture(["main", "develop", "trunk"]);
    const request = options(value);
    const ready = prepareWorktreeGroup(request);
    const beta = ready.members[1]!;
    writeFileSync(join(beta.path, "feature.txt"), "accepted evidence\n");
    git(beta.path, "add", "feature.txt");
    git(beta.path, "commit", "-qm", "private worktree result");
    const privateHead = git(beta.path, "rev-parse", "HEAD^{commit}");
    expect(privateHead).not.toBe(value.repositories[1]!.anchor);

    const order: string[] = [];
    const reclaimed = reclaimWorktreeGroup({
      ...request,
      fault(point, repositoryId) {
        if (point === "before-cleanup-entry" && repositoryId !== undefined) order.push(repositoryId);
      }
    });

    expect(reclaimed.status).toBe("reclaimed");
    expect(reclaimed.issues).toEqual([]);
    expect(order).toEqual(["gamma", "beta", "alpha"]);
    for (const repository of value.repositories) {
      expect(existsSync(join(value.groupRoot, repository.id))).toBe(false);
      expect(ref(repository.root, `refs/heads/relayforge/group-one/${repository.id}`)).toBeUndefined();
      expectProtectedRefsUnchanged(repository);
    }
  });

  it("rejects duplicate branch labels before creating the group or moving any ref", () => {
    const value = fixture(["main", "develop"]);
    const request = options(value);
    const duplicate = {
      ...request,
      entries: request.entries.map((candidate) => ({ ...candidate, branch: "relayforge/shared-branch" }))
    };

    expect(() => prepareWorktreeGroup(duplicate)).toThrowError(expect.objectContaining({ code: "INVALID_PLAN" }));
    expect(existsSync(value.groupRoot)).toBe(false);
    for (const repository of value.repositories) {
      expectProtectedRefsUnchanged(repository);
      expect(ref(repository.root, "refs/heads/relayforge/shared-branch")).toBeUndefined();
    }
  });

  it("rolls a partial creation failure back in reverse without moving default refs", () => {
    const value = fixture(["main", "develop", "trunk"]);
    const request = options(value);
    const cleanupOrder: string[] = [];
    const result = prepareWorktreeGroup({
      ...request,
      fault(point, repositoryId) {
        if (point === "before-create" && repositoryId === "beta") throw new Error("injected second-repository create failure");
        if (point === "before-cleanup-entry" && repositoryId !== undefined) cleanupOrder.push(repositoryId);
      }
    });

    expect(result.status).toBe("reclaimed");
    expect(result.issues.map((candidate) => candidate.code)).toContain("CREATE_FAILED");
    expect(cleanupOrder).toEqual(["gamma", "beta", "alpha"]);
    for (const repository of value.repositories) {
      expect(existsSync(join(value.groupRoot, repository.id))).toBe(false);
      expect(ref(repository.root, `refs/heads/relayforge/group-one/${repository.id}`)).toBeUndefined();
      expectProtectedRefsUnchanged(repository);
    }
  });

  it("rolls every created member back when provisioning changes after preflight", () => {
    const value = fixture(["main", "develop"]);
    const request = options(value);
    const result = prepareWorktreeGroup({
      ...request,
      fault(point, repositoryId) {
        if (point === "before-provision" && repositoryId === "beta") {
          rmSync(join(value.repositories[1]!.root, ".toolchain"), { recursive: true, force: true });
        }
      }
    });

    expect(result.status).toBe("reclaimed");
    expect(result.issues.map((candidate) => candidate.code)).toContain("PROVISION_FAILED");
    for (const repository of value.repositories) {
      expect(existsSync(join(value.groupRoot, repository.id))).toBe(false);
      expect(ref(repository.root, `refs/heads/relayforge/group-one/${repository.id}`)).toBeUndefined();
      expectProtectedRefsUnchanged(repository);
    }
  });

  it.each([
    ["dirty", "WORKTREE_DIRTY"],
    ["locked", "WORKTREE_LOCKED"],
    ["replaced", "DESTINATION_REPLACED"],
    ["stale", "WORKTREE_STALE"]
  ] as const)("preserves a %s member and returns typed recovery_required", (kind, expectedIssue) => {
    const value = fixture(["main", "develop"]);
    const request = options(value);
    const betaDestination = join(value.groupRoot, "beta");
    const displaced = `${betaDestination}.receipted`;
    const result = prepareWorktreeGroup({
      ...request,
      fault(point, repositoryId) {
        if (point !== "after-created-receipt" || repositoryId !== "beta") return;
        if (kind === "dirty") writeFileSync(join(betaDestination, "untracked.txt"), "preserve me\n");
        if (kind === "locked") git(value.repositories[1]!.root, "worktree", "lock", "--reason", "test", betaDestination);
        if (kind === "replaced") {
          renameSync(betaDestination, displaced);
          mkdirSync(betaDestination, { mode: 0o700 });
        }
        if (kind === "stale") {
          rmSync(betaDestination, { recursive: true, force: true });
          git(value.repositories[1]!.root, "worktree", "prune", "--expire", "now");
        }
        throw new Error(`injected ${kind} rollback condition`);
      }
    });

    expect(result.status).toBe("recovery_required");
    expect(result.issues.map((candidate) => candidate.code)).toContain(expectedIssue);
    expect(entry(result, "beta").state).toBe("preserved");
    expect(ref(value.repositories[1]!.root, "refs/heads/relayforge/group-one/beta")).toBe(value.repositories[1]!.anchor);
    expect(ref(value.repositories[0]!.root, "refs/heads/relayforge/group-one/alpha")).toBeUndefined();
    expectProtectedRefsUnchanged(value.repositories[0]!);
    expectProtectedRefsUnchanged(value.repositories[1]!);
    if (kind === "dirty" || kind === "locked") expect(existsSync(betaDestination)).toBe(true);
    if (kind === "replaced") {
      expect(existsSync(betaDestination)).toBe(true);
      expect(existsSync(displaced)).toBe(true);
    }
    if (kind === "stale") expect(existsSync(betaDestination)).toBe(false);
  });

  it("adopts an exact unreceipted git-add result after a simulated process crash", () => {
    const value = fixture(["main", "develop"]);
    const request = options(value);
    expect(() => prepareWorktreeGroup({
      ...request,
      fault(point, repositoryId) {
        if (point === "after-worktree-add" && repositoryId === "beta") {
          throw new WorktreeGroupInterruptedError("crash after git worktree add");
        }
      }
    })).toThrow(WorktreeGroupInterruptedError);

    const interrupted = readWorktreeGroupReceipt(value.groupRoot);
    expect(interrupted.state).toBe("creating");
    expect(interrupted.entries.map((candidate) => candidate.state)).toEqual(["provisioned", "planned"]);
    expect(existsSync(join(value.groupRoot, "beta", ".git"))).toBe(true);

    const resumed = reconcileWorktreeGroup(request);
    expect(resumed.status).toBe("ready");
    expect(resumed.receipt.entries.map((candidate) => candidate.state)).toEqual(["ready", "ready"]);
    for (const repository of value.repositories) {
      expect(ref(repository.root, `refs/heads/relayforge/group-one/${repository.id}`)).toBe(repository.anchor);
      expectProtectedRefsUnchanged(repository);
    }
  });

  it("re-provisions a durably provisioned member on restart before exposing readiness", () => {
    const value = fixture(["main", "develop"]);
    const request = options(value);
    expect(() => prepareWorktreeGroup({
      ...request,
      fault(point, repositoryId) {
        if (point === "after-provisioned-receipt" && repositoryId === "beta") {
          throw new WorktreeGroupInterruptedError("crash after provisioning receipt");
        }
      }
    })).toThrow(WorktreeGroupInterruptedError);

    const targetTool = join(value.groupRoot, "beta", ".toolchain", "bin", "relay-tool");
    writeFileSync(targetTool, "#!/bin/sh\nprintf 'tampered-but-ignored\\n'\n", { mode: 0o755 });
    const resumed = reconcileWorktreeGroup(request);

    expect(resumed.status).toBe("ready");
    expect(readFileSync(targetTool, "utf8")).toBe(
      readFileSync(join(value.repositories[1]!.root, ".toolchain", "bin", "relay-tool"), "utf8")
    );
    expect(resumed.receipt.entries.map((candidate) => candidate.state)).toEqual(["ready", "ready"]);
  });

  it("resumes exact reverse reclamation after a crash between worktree removal and branch CAS", () => {
    const value = fixture(["main", "develop"]);
    const request = options(value);
    expect(prepareWorktreeGroup(request).status).toBe("ready");

    expect(() => reclaimWorktreeGroup({
      ...request,
      fault(point, repositoryId) {
        if (point === "after-worktree-remove" && repositoryId === "beta") {
          throw new WorktreeGroupInterruptedError("crash before private branch deletion");
        }
      }
    })).toThrow(WorktreeGroupInterruptedError);

    const interrupted = readWorktreeGroupReceipt(value.groupRoot);
    expect(interrupted.entries.map((candidate) => candidate.state)).toEqual(["ready", "reclaiming"]);
    expect(existsSync(join(value.groupRoot, "beta"))).toBe(false);
    expect(ref(value.repositories[1]!.root, "refs/heads/relayforge/group-one/beta")).toBe(value.repositories[1]!.anchor);

    const resumed = reclaimWorktreeGroup(request);
    expect(resumed.status).toBe("reclaimed");
    expect(resumed.issues).toEqual([]);
    for (const repository of value.repositories) {
      expect(ref(repository.root, `refs/heads/relayforge/group-one/${repository.id}`)).toBeUndefined();
      expectProtectedRefsUnchanged(repository);
    }
  });

  it("durably resumes automatic rollback with its original failure and anchor policy", () => {
    const value = fixture(["main", "develop"]);
    const request = options(value);
    expect(() => prepareWorktreeGroup({
      ...request,
      fault(point, repositoryId) {
        if (point === "before-create" && repositoryId === "beta") {
          throw new Error("injected beta creation failure");
        }
        if (point === "after-worktree-remove" && repositoryId === "alpha") {
          throw new WorktreeGroupInterruptedError("crash during automatic reverse rollback");
        }
      }
    })).toThrow(WorktreeGroupInterruptedError);

    const interrupted = readWorktreeGroupReceipt(value.groupRoot);
    expect(interrupted.state).toBe("rolling_back");
    expect(interrupted.cleanupKind).toBe("rollback");
    expect(interrupted.issues.map((candidate) => candidate.code)).toContain("CREATE_FAILED");
    expect(interrupted.entries.map((candidate) => candidate.state)).toEqual(["reclaiming", "reclaimed"]);
    expect(existsSync(join(value.groupRoot, "alpha"))).toBe(false);
    expect(ref(value.repositories[0]!.root, "refs/heads/relayforge/group-one/alpha")).toBe(value.repositories[0]!.anchor);

    const resumed = reconcileWorktreeGroup(request);
    expect(resumed.status).toBe("reclaimed");
    expect(resumed.receipt.cleanupKind).toBe("rollback");
    expect(resumed.issues.map((candidate) => candidate.code)).toContain("CREATE_FAILED");
    for (const repository of value.repositories) {
      expect(ref(repository.root, `refs/heads/relayforge/group-one/${repository.id}`)).toBeUndefined();
      expectProtectedRefsUnchanged(repository);
    }
  });

  it("turns replacement discovered by restart reconciliation into durable recovery_required", () => {
    const value = fixture(["main", "develop"]);
    const request = options(value);
    const ready = prepareWorktreeGroup(request);
    const beta = ready.members[1]!;
    const displaced = `${beta.path}.original`;
    renameSync(beta.path, displaced);
    mkdirSync(beta.path, { mode: 0o700 });

    const reconciled = reconcileWorktreeGroup(request);
    expect(reconciled.status).toBe("recovery_required");
    expect(reconciled.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "DESTINATION_REPLACED", repositoryId: "beta" })
    ]));
    expect(entry(reconciled, "beta").state).toBe("preserved");
    expect(existsSync(beta.path)).toBe(true);
    expect(existsSync(displaced)).toBe(true);
    expectProtectedRefsUnchanged(value.repositories[1]!);
  });

  it("refuses a mismatched restart request without touching the receipted group", () => {
    const value = fixture(["main", "develop"]);
    const request = options(value);
    const ready = prepareWorktreeGroup(request);
    const changed: WorktreeGroupOptions = {
      ...request,
      entries: request.entries.map((candidate, index) => index === 1
        ? { ...candidate, branch: "relayforge/group-one/beta-other" }
        : candidate)
    };

    expect(() => reconcileWorktreeGroup(changed)).toThrowError(expect.objectContaining({ code: "RECEIPT_MISMATCH" }));
    expect(readWorktreeGroupReceipt(value.groupRoot)).toEqual(ready.receipt);
    expect(ref(value.repositories[1]!.root, "refs/heads/relayforge/group-one/beta")).toBe(value.repositories[1]!.anchor);
    expect(ref(value.repositories[1]!.root, "refs/heads/relayforge/group-one/beta-other")).toBeUndefined();
  });

  it("exposes stable typed errors for callers", () => {
    const value = fixture(["main"]);
    const request = options(value);
    git(value.repositories[0]!.root, "branch", "relayforge/group-one/alpha");
    try {
      prepareWorktreeGroup(request);
      throw new Error("expected branch conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(WorktreeGroupError);
      expect(error).toEqual(expect.objectContaining({ code: "BRANCH_CONFLICT", repositoryId: "alpha" }));
    }
    expect(existsSync(value.groupRoot)).toBe(false);
  });
});

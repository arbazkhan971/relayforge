import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildScmPushPlan,
  createScmGitCommandRunner,
  publishScmBranch,
  ScmGitPublisherError,
  type ScmGitCommandRequest,
  type ScmGitCommandResult,
  type ScmGitCommandRunner
} from "../src/scm/publish.js";
import { SCM_SCHEMA_VERSION, type ScmPublicationIntentV1, type ScmRepositoryIdV1 } from "../src/scm/types.js";

const INTEGRATION_REF = "refs/heads/relayforge/local/integration";
const REMOTE_REF = "refs/heads/relayforge/run-1";
const HASH = "d".repeat(64);
const created: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [
    "-c", "core.hooksPath=/dev/null",
    "-c", "credential.helper=",
    "-c", "protocol.file.allow=always",
    ...args
  ], { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
}

type Fixture = Readonly<{
  root: string;
  repository: string;
  remote: string;
  remoteUrl: string;
  initialOid: string;
}>;

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "relayforge-scm-publish-"));
  created.push(root);
  const repository = join(root, "repository");
  const remote = join(root, "remote.git");
  execFileSync("git", ["init", "-q", repository]);
  execFileSync("git", ["init", "--bare", "-q", remote]);
  git(repository, "config", "user.email", "relayforge@example.invalid");
  git(repository, "config", "user.name", "RelayForge Test");
  writeFileSync(join(repository, "base.txt"), "base\n");
  git(repository, "add", "base.txt");
  git(repository, "commit", "-q", "-m", "base");
  git(repository, "branch", "-M", "main");
  const initialOid = git(repository, "rev-parse", "HEAD");
  git(repository, "update-ref", INTEGRATION_REF, initialOid);
  const remoteUrl = pathToFileURL(realpathSync(remote)).href;
  git(repository, "remote", "add", "origin", remoteUrl);
  return Object.freeze({ root, repository: realpathSync(repository), remote: realpathSync(remote), remoteUrl, initialOid });
}

afterEach(() => {
  while (created.length > 0) {
    const path = created.pop()!;
    rmSync(path, { recursive: true, force: true });
  }
});

const HEAD_REPOSITORY: ScmRepositoryIdV1 = Object.freeze({
  schemaVersion: SCM_SCHEMA_VERSION,
  provider: "github",
  canonicalHost: "github.example.com",
  owner: "relayforge",
  name: "project"
});
const BASE_REPOSITORY: ScmRepositoryIdV1 = Object.freeze({ ...HEAD_REPOSITORY, owner: "upstream" });

function intent(oid: string, overrides: Partial<ScmPublicationIntentV1> = {}): ScmPublicationIntentV1 {
  return {
    schemaVersion: SCM_SCHEMA_VERSION,
    publicationId: "publication-1",
    publicationGeneration: 1,
    attempt: 1,
    runId: "run-1",
    runEpoch: "epoch-1",
    repository: HEAD_REPOSITORY,
    integrationRef: INTEGRATION_REF,
    integrationOid: oid,
    localExpectedOid: oid,
    remoteName: "origin",
    remoteRef: REMOTE_REF,
    expectedRemote: { kind: "absent" },
    baseRepository: BASE_REPOSITORY,
    baseRef: "refs/heads/main",
    titleSha256: HASH,
    bodySha256: "e".repeat(64),
    draft: false,
    createdAt: "2026-08-09T12:00:00.000Z",
    ...overrides
  };
}

function makeCommit(repository: string, parent: string, message: string): string {
  const tree = git(repository, "rev-parse", `${parent}^{tree}`);
  return git(repository, "commit-tree", tree, "-p", parent, "-m", message);
}

function remoteOid(value: Fixture): string | null {
  const output = git(value.repository, "ls-remote", "--refs", "origin", REMOTE_REF);
  return output ? output.split(/\s+/u)[0]! : null;
}

class RecordingRunner implements ScmGitCommandRunner {
  readonly requests: ScmGitCommandRequest[] = [];
  constructor(
    private readonly delegate = createScmGitCommandRunner(),
    private readonly onPush?: (request: ScmGitCommandRequest) => Promise<ScmGitCommandResult>
  ) {}

  async run(request: ScmGitCommandRequest): Promise<ScmGitCommandResult> {
    this.requests.push(request);
    if (request.args[0] === "push" && this.onPush) return await this.onPush(request);
    return await this.delegate.run(request);
  }
}

describe("leased SCM branch publication", () => {
  it("builds an immutable-OID, exact-ref force-with-lease argv plan", () => {
    const oid = "a".repeat(40);
    expect(buildScmPushPlan(intent(oid)).args).toEqual([
      "push",
      "--porcelain",
      "--no-progress",
      "--no-verify",
      "--receive-pack=git-receive-pack",
      `--force-with-lease=${REMOTE_REF}:`,
      "origin",
      `${oid}:${REMOTE_REF}`
    ]);
    expect(buildScmPushPlan(intent(oid, { expectedRemote: { kind: "oid", oid: "b".repeat(40) } })).args[5])
      .toBe(`--force-with-lease=${REMOTE_REF}:${"b".repeat(40)}`);
  });

  it("publishes an absent remote ref without moving any local ref or checkout", async () => {
    const value = fixture();
    const mainBefore = git(value.repository, "rev-parse", "refs/heads/main");
    const integrationBefore = git(value.repository, "rev-parse", INTEGRATION_REF);
    const runner = new RecordingRunner();

    await expect(publishScmBranch({
      intent: intent(value.initialOid),
      repositoryRoot: value.repository,
      expectedPushUrl: value.remoteUrl,
      allowFileRemote: true,
      runner
    })).resolves.toEqual({ state: "branch_published", observedOid: value.initialOid, completedBy: "push" });

    expect(remoteOid(value)).toBe(value.initialOid);
    expect(git(value.repository, "rev-parse", "refs/heads/main")).toBe(mainBefore);
    expect(git(value.repository, "rev-parse", INTEGRATION_REF)).toBe(integrationBefore);
    const push = runner.requests.find((request) => request.args[0] === "push")!;
    expect(push.args.at(-1)).toBe(`${value.initialOid}:${REMOTE_REF}`);
    expect(push.args).not.toContain("--force");
  });

  it("updates only when the existing remote OID matches the reviewed expectation", async () => {
    const value = fixture();
    await publishScmBranch({ intent: intent(value.initialOid), repositoryRoot: value.repository, expectedPushUrl: value.remoteUrl, allowFileRemote: true });
    const next = makeCommit(value.repository, value.initialOid, "reviewed-next");
    git(value.repository, "update-ref", INTEGRATION_REF, next, value.initialOid);

    await expect(publishScmBranch({
      intent: intent(next, { expectedRemote: { kind: "oid", oid: value.initialOid }, attempt: 2 }),
      repositoryRoot: value.repository,
      expectedPushUrl: value.remoteUrl,
      allowFileRemote: true
    })).resolves.toEqual({ state: "branch_published", observedOid: next, completedBy: "push" });
    expect(remoteOid(value)).toBe(next);
  });

  it("refuses a concurrent remote advance and preserves the foreign OID", async () => {
    const value = fixture();
    await publishScmBranch({ intent: intent(value.initialOid), repositoryRoot: value.repository, expectedPushUrl: value.remoteUrl, allowFileRemote: true });
    const intended = makeCommit(value.repository, value.initialOid, "intended");
    const foreign = makeCommit(value.repository, value.initialOid, "foreign");
    git(value.repository, "update-ref", INTEGRATION_REF, intended, value.initialOid);
    git(value.repository, "push", "--force", "origin", `${foreign}:${REMOTE_REF}`);

    await expect(publishScmBranch({
      intent: intent(intended, { expectedRemote: { kind: "oid", oid: value.initialOid }, attempt: 2 }),
      repositoryRoot: value.repository,
      expectedPushUrl: value.remoteUrl,
      allowFileRemote: true
    })).resolves.toEqual({ state: "refused", reasonCode: "REMOTE_REF_DIVERGED", observedRemoteOid: foreign });
    expect(remoteOid(value)).toBe(foreign);
  });

  it("rejects a local integration ref that moved after review before any push", async () => {
    const value = fixture();
    const reviewed = makeCommit(value.repository, value.initialOid, "reviewed");
    await expect(publishScmBranch({
      intent: intent(reviewed),
      repositoryRoot: value.repository,
      expectedPushUrl: value.remoteUrl,
      allowFileRemote: true
    })).rejects.toMatchObject<Partial<ScmGitPublisherError>>({ code: "LOCAL_REF_MISMATCH" });
    expect(remoteOid(value)).toBeNull();
  });

  it("adopts an exact already-published OID without issuing another push", async () => {
    const value = fixture();
    git(value.repository, "push", "origin", `${value.initialOid}:${REMOTE_REF}`);
    const runner = new RecordingRunner();
    await expect(publishScmBranch({
      intent: intent(value.initialOid),
      repositoryRoot: value.repository,
      expectedPushUrl: value.remoteUrl,
      allowFileRemote: true,
      runner
    })).resolves.toEqual({ state: "branch_published", observedOid: value.initialOid, completedBy: "already_published" });
    expect(runner.requests.some((request) => request.args[0] === "push")).toBe(false);
  });

  it("reconciles a successful remote effect even when the push outcome is reported as timed out", async () => {
    const value = fixture();
    const delegate = createScmGitCommandRunner();
    const runner = new RecordingRunner(delegate, async (request) => {
      await delegate.run(request);
      return { disposition: "timed_out", exitCode: null, stdout: "", stderr: "" };
    });
    await expect(publishScmBranch({
      intent: intent(value.initialOid),
      repositoryRoot: value.repository,
      expectedPushUrl: value.remoteUrl,
      allowFileRemote: true,
      runner
    })).resolves.toEqual({
      state: "branch_published",
      observedOid: value.initialOid,
      completedBy: "post_push_reconciliation"
    });
  });

  it("reports a reaped timeout with an unchanged exact remote as safely retryable ambiguity", async () => {
    const value = fixture();
    const runner = new RecordingRunner(createScmGitCommandRunner(), async () => ({
      disposition: "timed_out", exitCode: null, stdout: "", stderr: ""
    }));
    await expect(publishScmBranch({
      intent: intent(value.initialOid),
      repositoryRoot: value.repository,
      expectedPushUrl: value.remoteUrl,
      allowFileRemote: true,
      runner
    })).resolves.toEqual({
      state: "push_ambiguous",
      reasonCode: "PUSH_TIMED_OUT_REMOTE_UNCHANGED",
      observedRemoteOid: null,
      safeToRetry: true
    });
    expect(remoteOid(value)).toBeNull();
  });

  it("rejects multiple push URLs rather than choosing one implicitly", async () => {
    const value = fixture();
    const second = join(value.root, "second.git");
    execFileSync("git", ["init", "--bare", "-q", second]);
    git(value.repository, "remote", "set-url", "--add", "--push", "origin", pathToFileURL(realpathSync(second)).href);
    await expect(publishScmBranch({
      intent: intent(value.initialOid),
      repositoryRoot: value.repository,
      expectedPushUrl: value.remoteUrl,
      allowFileRemote: true
    })).rejects.toMatchObject<Partial<ScmGitPublisherError>>({ code: "REMOTE_IDENTITY_MISMATCH" });
    expect(remoteOid(value)).toBeNull();
  });

  it("rejects noncanonical roots and credential-bearing/network-mismatched URLs", async () => {
    const value = fixture();
    await expect(publishScmBranch({
      intent: intent(value.initialOid),
      repositoryRoot: `${value.repository}/..`,
      expectedPushUrl: value.remoteUrl,
      allowFileRemote: true
    })).rejects.toMatchObject<Partial<ScmGitPublisherError>>({ code: "INVALID_REQUEST" });
    await expect(publishScmBranch({
      intent: intent(value.initialOid),
      repositoryRoot: value.repository,
      expectedPushUrl: "https://token@github.example.com/relayforge/project.git"
    })).rejects.toMatchObject<Partial<ScmGitPublisherError>>({ code: "INVALID_REQUEST" });
    await expect(publishScmBranch({
      intent: intent(value.initialOid),
      repositoryRoot: value.repository,
      expectedPushUrl: "https://other.example.com/relayforge/project.git"
    })).rejects.toMatchObject<Partial<ScmGitPublisherError>>({ code: "INVALID_REQUEST" });
  });

  it("cancels before remote mutation and returns a non-retryable unknown observation", async () => {
    const value = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(publishScmBranch({
      intent: intent(value.initialOid),
      repositoryRoot: value.repository,
      expectedPushUrl: value.remoteUrl,
      allowFileRemote: true,
      signal: controller.signal
    })).rejects.toMatchObject<Partial<ScmGitPublisherError>>({ code: "REPOSITORY_IDENTITY_MISMATCH" });
    expect(remoteOid(value)).toBeNull();
  });
});

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyMultiRepoIntegrationEvent, createMultiRepoIntegrationEvent, reconcileMultiRepoIntegrationOnce, type MultiRepoIntegrationDependencies, type MultiRepoIntegrationPlanV1, type MultiRepoIntegrationProjectionV1 } from "../src/multirepo/integration.js";

const roots: string[] = []; const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function git(cwd: string, ...args: string[]): string { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
function repo(repositoryId: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `relayforge-integration-${repositoryId}-`))); roots.push(root); git(root, "init", "-b", "main"); git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@example.invalid"); writeFileSync(join(root, "base.txt"), "base\n"); git(root, "add", "."); git(root, "commit", "-m", "base"); const expectedOid = git(root, "rev-parse", "HEAD"); git(root, "checkout", "--detach"); writeFileSync(join(root, `${repositoryId}.txt`), `${repositoryId}\n`); git(root, "add", "."); git(root, "commit", "-m", "child"); const childOid = git(root, "rev-parse", "HEAD"); git(root, "checkout", "main"); const rootStat = statSync(root); const common = realpathSync(git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")); const commonStat = statSync(common); return { repositoryId, root, expectedOid, childOid, identity: { schemaVersion: 1 as const, repositoryId, canonicalRoot: root, rootDevice: rootStat.dev, rootInode: rootStat.ino, gitCommonDirDevice: commonStat.dev, gitCommonDirInode: commonStat.ino, defaultBranch: "main", protectedBranches: ["main"] } };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup(): { plan: MultiRepoIntegrationPlanV1; repos: ReturnType<typeof repo>[] } { const repos = [repo("api"), repo("web")]; return { repos, plan: { schemaVersion: 1, transactionId: "txn-1", repositorySetId: sha("set"), entries: repos.map((item) => ({ repository: item.identity, targetRef: "refs/heads/main", expectedOid: item.expectedOid, childOid: item.childOid, canonicalWorkspacePath: item.root, message: `integrate ${item.repositoryId}` })), verifyCommands: ["combined-test"], verifyEnvironment: { PATH: "/bin" } } }; }
function deps(): MultiRepoIntegrationDependencies { return { authority: { assertHeld(ids) { expect(ids).toEqual([...ids].sort()); } }, verificationObserver: { observe(entry) { return { candidateOid: entry.candidateOid, treeOid: entry.treeOid, clean: true, identityExact: true }; } }, verificationExecutor: { async run() { return { ok: true, code: 0, outputDigest: sha("output"), outputBytes: 6, fingerprint: sha("fingerprint"), transportTrusted: true, scopeTrusted: true }; } }, verifiedAt: () => "2026-08-09T12:00:00.000Z" }; }
async function step(projection: MultiRepoIntegrationProjectionV1, dependencies = deps()): Promise<MultiRepoIntegrationProjectionV1> { const event = await reconcileMultiRepoIntegrationOnce(projection, dependencies); if (event === undefined) return projection; return applyMultiRepoIntegrationEvent(projection, event); }

describe("multi-repository integration reconciler", () => {
  it("prepares, verifies, and CAS-applies the complete vector", async () => {
    const value = setup(); let projection = applyMultiRepoIntegrationEvent(undefined, createMultiRepoIntegrationEvent(value.plan));
    for (let count = 0; count < 10 && projection.state !== "applied"; count += 1) projection = await step(projection);
    expect(projection.state).toBe("applied"); expect(projection.verification?.receiptDigest).toMatch(/^[a-f0-9]{64}$/u);
    for (const [index, repository] of value.repos.entries()) expect(git(repository.root, "rev-parse", "refs/heads/main")).toBe(projection.entries[index]!.candidate!.candidateOid);
  });

  it("recovers idempotently when apply succeeds but its event is lost", async () => {
    const value = setup(); let projection = applyMultiRepoIntegrationEvent(undefined, createMultiRepoIntegrationEvent(value.plan));
    while (projection.state !== "applying") projection = await step(projection);
    const lost = await reconcileMultiRepoIntegrationOnce(projection, deps()); expect(lost?.type).toBe("integration.entry_applied");
    const retry = await reconcileMultiRepoIntegrationOnce(projection, deps()); expect(retry).toMatchObject({ type: "integration.entry_applied", result: { state: "already_applied" } });
    projection = applyMultiRepoIntegrationEvent(projection, retry!); expect(projection.entries[0]!.applyResult?.state).toBe("already_applied");
  });

  it("compensates earlier CAS changes in reverse when a later ref moved", async () => {
    const value = setup(); let projection = applyMultiRepoIntegrationEvent(undefined, createMultiRepoIntegrationEvent(value.plan));
    while (projection.state !== "applying") projection = await step(projection);
    projection = await step(projection); const web = value.repos[1]!; const tree = git(web.root, "rev-parse", `${web.expectedOid}^{tree}`); const external = git(web.root, "commit-tree", tree, "-p", web.expectedOid, "-m", "external"); git(web.root, "update-ref", "refs/heads/main", external, web.expectedOid);
    projection = await step(projection); expect(projection.state).toBe("compensating");
    projection = await step(projection); projection = await step(projection); expect(projection.state).toBe("compensated");
    expect(git(value.repos[0]!.root, "rev-parse", "refs/heads/main")).toBe(value.repos[0]!.expectedOid); expect(git(web.root, "rev-parse", "refs/heads/main")).toBe(external);
  });

  it("enters recovery-required when external movement prevents compensation", async () => {
    const value = setup(); let projection = applyMultiRepoIntegrationEvent(undefined, createMultiRepoIntegrationEvent(value.plan)); while (projection.state !== "applying") projection = await step(projection); projection = await step(projection);
    const api = value.repos[0]!; const apiCandidate = projection.entries[0]!.candidate!.candidateOid; const apiTree = git(api.root, "rev-parse", `${apiCandidate}^{tree}`); const apiExternal = git(api.root, "commit-tree", apiTree, "-p", apiCandidate, "-m", "external-api"); git(api.root, "update-ref", "refs/heads/main", apiExternal, apiCandidate);
    const web = value.repos[1]!; const webTree = git(web.root, "rev-parse", `${web.expectedOid}^{tree}`); const webExternal = git(web.root, "commit-tree", webTree, "-p", web.expectedOid, "-m", "external-web"); git(web.root, "update-ref", "refs/heads/main", webExternal, web.expectedOid);
    projection = await step(projection); projection = await step(projection); expect(projection).toMatchObject({ state: "recovery_required", recoveryReason: "EXTERNAL_MOVE" }); expect(git(api.root, "rev-parse", "refs/heads/main")).toBe(apiExternal);
  });

  it("requires sorted repository authority before every effect", async () => {
    const value = setup(); const projection = applyMultiRepoIntegrationEvent(undefined, createMultiRepoIntegrationEvent(value.plan));
    await expect(reconcileMultiRepoIntegrationOnce(projection, { ...deps(), authority: { assertHeld() { throw new Error("lease lost"); } } })).rejects.toMatchObject({ code: "AUTHORITY_MISSING" });
    for (const repository of value.repos) expect(git(repository.root, "rev-parse", "refs/heads/main")).toBe(repository.expectedOid);
  });

  it("rejects divergent event replay and unsorted plans", () => {
    const value = setup(); const created = createMultiRepoIntegrationEvent(value.plan); const projection = applyMultiRepoIntegrationEvent(undefined, created); expect(applyMultiRepoIntegrationEvent(projection, created)).toBe(projection);
    expect(() => createMultiRepoIntegrationEvent({ ...value.plan, entries: [...value.plan.entries].reverse() })).toThrowError(expect.objectContaining({ code: "INVALID_PLAN" }));
  });
});

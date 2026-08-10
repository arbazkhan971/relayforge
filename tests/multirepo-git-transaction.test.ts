import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyRepositoryCandidate, compensateRepositoryCandidate, observeRepositoryRef, prepareRepositoryCandidate } from "../src/multirepo/git-transaction.js";
import type { RepositoryIdentityV1 } from "../src/multirepo/domain.js";

const roots: string[] = [];
function git(cwd: string, ...args: string[]): string { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
function repository(): { root: string; identity: RepositoryIdentityV1; anchor: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "relayforge-multirepo-git-")));
  roots.push(root);
  git(root, "init", "-b", "main"); git(root, "config", "user.name", "RelayForge Test"); git(root, "config", "user.email", "test@example.invalid");
  writeFileSync(join(root, "value.txt"), "base\n"); git(root, "add", "value.txt"); git(root, "commit", "-m", "base");
  const anchor = git(root, "rev-parse", "HEAD");
  const common = realpathSync(git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  const rootStat = statSync(root); const commonStat = statSync(common);
  return { root, anchor, identity: { schemaVersion: 1, repositoryId: `repo${roots.length}`, canonicalRoot: root, rootDevice: rootStat.dev, rootInode: rootStat.ino, gitCommonDirDevice: commonStat.dev, gitCommonDirInode: commonStat.ino, defaultBranch: "main", protectedBranches: ["main"] } };
}
function child(root: string, anchor: string, file: string, content: string): string {
  git(root, "checkout", "--detach", anchor); writeFileSync(join(root, file), content); git(root, "add", file); git(root, "commit", "-m", `child ${file}`);
  const result = git(root, "rev-parse", "HEAD"); git(root, "checkout", "main"); return result;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("multi-repository Git transaction primitives", () => {
  it("prepares an exact two-parent candidate without moving the target ref", () => {
    const value = repository(); const childOid = child(value.root, value.anchor, "feature.txt", "feature\n");
    const candidate = prepareRepositoryCandidate({ repository: value.identity, targetRef: "refs/heads/main", expectedOid: value.anchor, childOid, message: "integrate feature" });
    expect(git(value.root, "rev-parse", "refs/heads/main")).toBe(value.anchor);
    expect(git(value.root, "rev-list", "--parents", "-n", "1", candidate.candidateOid)).toBe(`${candidate.candidateOid} ${value.anchor} ${childOid}`);
    expect(git(value.root, "show", `${candidate.candidateOid}:feature.txt`)).toBe("feature");
  });

  it("applies via exact compare-and-swap and is retry-idempotent", () => {
    const value = repository(); const childOid = child(value.root, value.anchor, "feature.txt", "feature\n");
    const candidate = prepareRepositoryCandidate({ repository: value.identity, targetRef: "refs/heads/main", expectedOid: value.anchor, childOid, message: "integrate" });
    expect(applyRepositoryCandidate(value.identity, candidate)).toEqual({ state: "applied", observedOid: candidate.candidateOid });
    expect(applyRepositoryCandidate(value.identity, candidate)).toEqual({ state: "already_applied", observedOid: candidate.candidateOid });
  });

  it("refuses external movement and never overwrites it", () => {
    const value = repository(); const childOid = child(value.root, value.anchor, "feature.txt", "feature\n");
    const candidate = prepareRepositoryCandidate({ repository: value.identity, targetRef: "refs/heads/main", expectedOid: value.anchor, childOid, message: "integrate" });
    const external = child(value.root, value.anchor, "external.txt", "external\n"); git(value.root, "update-ref", "refs/heads/main", external, value.anchor);
    expect(applyRepositoryCandidate(value.identity, candidate)).toEqual({ state: "refused", reasonCode: "REF_MOVED", observedOid: external });
    expect(git(value.root, "rev-parse", "refs/heads/main")).toBe(external);
  });

  it("compensates only an unchanged applied candidate", () => {
    const value = repository(); const childOid = child(value.root, value.anchor, "feature.txt", "feature\n");
    const candidate = prepareRepositoryCandidate({ repository: value.identity, targetRef: "refs/heads/main", expectedOid: value.anchor, childOid, message: "integrate" });
    expect(applyRepositoryCandidate(value.identity, candidate).state).toBe("applied");
    expect(compensateRepositoryCandidate(value.identity, candidate)).toEqual({ state: "compensated", observedOid: value.anchor });
    expect(compensateRepositoryCandidate(value.identity, candidate)).toEqual({ state: "already_compensated", observedOid: value.anchor });
  });

  it("preserves a later external move instead of compensating over it", () => {
    const value = repository(); const childOid = child(value.root, value.anchor, "feature.txt", "feature\n");
    const candidate = prepareRepositoryCandidate({ repository: value.identity, targetRef: "refs/heads/main", expectedOid: value.anchor, childOid, message: "integrate" });
    expect(applyRepositoryCandidate(value.identity, candidate).state).toBe("applied");
    const tree = git(value.root, "rev-parse", `${candidate.candidateOid}^{tree}`);
    const external = git(value.root, "commit-tree", tree, "-p", candidate.candidateOid, "-m", "external");
    git(value.root, "update-ref", "refs/heads/main", external, candidate.candidateOid);
    expect(compensateRepositoryCandidate(value.identity, candidate)).toEqual({ state: "refused", reasonCode: "EXTERNAL_MOVE", observedOid: external });
  });

  it("rejects conflicts and identity replacement before a ref mutation", () => {
    const value = repository();
    const left = child(value.root, value.anchor, "value.txt", "left\n");
    const right = child(value.root, value.anchor, "value.txt", "right\n");
    git(value.root, "update-ref", "refs/heads/main", left, value.anchor);
    expect(() => prepareRepositoryCandidate({ repository: value.identity, targetRef: "refs/heads/main", expectedOid: left, childOid: right, message: "conflict" })).toThrowError(expect.objectContaining({ code: "MERGE_CONFLICT" }));
    const wrong = { ...value.identity, rootInode: value.identity.rootInode + 1 };
    expect(observeRepositoryRef(wrong, "refs/heads/main")).toEqual(expect.objectContaining({ state: "unknown", reasonCode: "IDENTITY_MISMATCH" }));
  });
});

import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { runGit } from "../git.js";
import type { RepositoryIdentityV1 } from "./domain.js";

export const MULTIREPO_GIT_LIMITS = Object.freeze({ maximumMessageBytes: 8 * 1024 });

export type MultiRepoGitErrorCode =
  | "INVALID_REQUEST"
  | "REPOSITORY_IDENTITY_MISMATCH"
  | "REF_OBSERVATION_FAILED"
  | "EXPECTED_REF_MISMATCH"
  | "OBJECT_MISSING"
  | "NO_CHANGES"
  | "MERGE_CONFLICT"
  | "CANDIDATE_INVALID";

export class MultiRepoGitError extends Error {
  constructor(readonly code: MultiRepoGitErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "MultiRepoGitError";
  }
}

export type MultiRepoGitCommandResult = Readonly<{ ok: boolean; out: string; err: string }>;
export interface MultiRepoGitRunner { run(cwd: string, args: readonly string[]): MultiRepoGitCommandResult }

const defaultRunner: MultiRepoGitRunner = Object.freeze({
  run(cwd: string, args: readonly string[]) { return runGit(cwd, [...args]); }
});

export type RepositoryCandidateRequest = Readonly<{
  repository: RepositoryIdentityV1;
  targetRef: string;
  expectedOid: string;
  childOid: string;
  message: string;
  runner?: MultiRepoGitRunner;
}>;

export type RepositoryCandidateV1 = Readonly<{
  schemaVersion: 1;
  repositoryId: string;
  targetRef: string;
  expectedOid: string;
  childOid: string;
  candidateOid: string;
  treeOid: string;
  parents: readonly [string, string];
}>;

export type RepositoryRefObservation = Readonly<{
  repositoryId: string;
  targetRef: string;
  state: "observed";
  oid: string | null;
}> | Readonly<{
  repositoryId: string;
  targetRef: string;
  state: "unknown";
  reasonCode: "IDENTITY_MISMATCH" | "READ_FAILED";
}>;

export type RepositoryCasResult =
  | Readonly<{ state: "applied" | "already_applied"; observedOid: string }>
  | Readonly<{ state: "refused"; reasonCode: "REF_MOVED"; observedOid: string | null }>
  | Readonly<{ state: "recovery_required"; reasonCode: "IDENTITY_MISMATCH" | "OUTCOME_UNKNOWN"; observedOid?: string | null }>;

export type RepositoryCompensationResult =
  | Readonly<{ state: "compensated" | "already_compensated"; observedOid: string }>
  | Readonly<{ state: "refused"; reasonCode: "EXTERNAL_MOVE"; observedOid: string | null }>
  | Readonly<{ state: "recovery_required"; reasonCode: "IDENTITY_MISMATCH" | "OUTCOME_UNKNOWN"; observedOid?: string | null }>;

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const REF = /^refs\/heads\/(?![.-])(?:[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]|[A-Za-z0-9])$/u;

function requireOid(value: string, name: string): string {
  if (!OID.test(value)) throw new MultiRepoGitError("INVALID_REQUEST", `${name} is not a full object ID`);
  return value;
}

function requireRef(value: string): string {
  if (!REF.test(value) || value.includes("..") || value.includes("//") || value.includes("@{") || value.endsWith(".lock")) {
    throw new MultiRepoGitError("INVALID_REQUEST", "target ref is not a canonical local branch ref");
  }
  return value;
}

function verifyRepository(repository: RepositoryIdentityV1, runner: MultiRepoGitRunner): string {
  if (!isAbsolute(repository.canonicalRoot)) throw new MultiRepoGitError("INVALID_REQUEST", "repository root must be absolute");
  let canonical: string;
  try {
    canonical = realpathSync(repository.canonicalRoot);
    const root = lstatSync(canonical);
    if (!root.isDirectory() || root.dev !== repository.rootDevice || root.ino !== repository.rootInode) throw new Error("root identity");
  } catch {
    throw new MultiRepoGitError("REPOSITORY_IDENTITY_MISMATCH", `repository root changed for ${repository.repositoryId}`);
  }
  if (canonical !== repository.canonicalRoot) throw new MultiRepoGitError("REPOSITORY_IDENTITY_MISMATCH", "repository root is no longer canonical");
  const common = runner.run(canonical, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.ok || !isAbsolute(common.out)) throw new MultiRepoGitError("REPOSITORY_IDENTITY_MISMATCH", "Git common directory cannot be resolved");
  try {
    const commonPath = realpathSync(resolve(common.out));
    const stat = lstatSync(commonPath);
    if (!stat.isDirectory() || stat.dev !== repository.gitCommonDirDevice || stat.ino !== repository.gitCommonDirInode) throw new Error("common identity");
  } catch {
    throw new MultiRepoGitError("REPOSITORY_IDENTITY_MISMATCH", "Git common directory identity changed");
  }
  return canonical;
}

function resolveCommit(cwd: string, oid: string, runner: MultiRepoGitRunner): string {
  const result = runner.run(cwd, ["rev-parse", "--verify", "--end-of-options", `${oid}^{commit}`]);
  if (!result.ok || result.out !== oid) throw new MultiRepoGitError("OBJECT_MISSING", `commit ${oid} is absent or not canonical`);
  return oid;
}

function readRef(cwd: string, targetRef: string, runner: MultiRepoGitRunner): string | null {
  const result = runner.run(cwd, ["show-ref", "--verify", "--hash", targetRef]);
  if (!result.ok) return null;
  if (!OID.test(result.out)) throw new MultiRepoGitError("REF_OBSERVATION_FAILED", "target ref returned a non-canonical object ID");
  return result.out;
}

export function observeRepositoryRef(
  repository: RepositoryIdentityV1,
  targetRef: string,
  runner: MultiRepoGitRunner = defaultRunner
): RepositoryRefObservation {
  let cwd: string;
  try { cwd = verifyRepository(repository, runner); }
  catch (error) {
    if (error instanceof MultiRepoGitError && error.code === "REPOSITORY_IDENTITY_MISMATCH") return Object.freeze({ repositoryId: repository.repositoryId, targetRef, state: "unknown", reasonCode: "IDENTITY_MISMATCH" });
    throw error;
  }
  try {
    const oid = readRef(cwd, requireRef(targetRef), runner);
    return Object.freeze({ repositoryId: repository.repositoryId, targetRef, state: "observed", oid });
  } catch {
    return Object.freeze({ repositoryId: repository.repositoryId, targetRef, state: "unknown", reasonCode: "READ_FAILED" });
  }
}

/** Create an immutable two-parent candidate object without checking out or moving any ref. */
export function prepareRepositoryCandidate(request: RepositoryCandidateRequest): RepositoryCandidateV1 {
  const runner = request.runner ?? defaultRunner;
  const cwd = verifyRepository(request.repository, runner);
  const targetRef = requireRef(request.targetRef);
  const expectedOid = resolveCommit(cwd, requireOid(request.expectedOid, "expected OID"), runner);
  const childOid = resolveCommit(cwd, requireOid(request.childOid, "child OID"), runner);
  if (expectedOid === childOid) throw new MultiRepoGitError("NO_CHANGES", "child and expected commits are identical");
  if (Buffer.byteLength(request.message, "utf8") < 1 || Buffer.byteLength(request.message, "utf8") > MULTIREPO_GIT_LIMITS.maximumMessageBytes || request.message.includes("\0")) {
    throw new MultiRepoGitError("INVALID_REQUEST", "candidate message is outside the closed byte bound");
  }
  const before = readRef(cwd, targetRef, runner);
  if (before !== expectedOid) throw new MultiRepoGitError("EXPECTED_REF_MISMATCH", `target ref is ${before ?? "absent"}, expected ${expectedOid}`);
  const mergeTree = runner.run(cwd, ["merge-tree", "--write-tree", expectedOid, childOid]);
  if (!mergeTree.ok) throw new MultiRepoGitError("MERGE_CONFLICT", "candidate merge has conflicts or could not be constructed");
  const treeOid = mergeTree.out.split("\n", 1)[0]?.trim() ?? "";
  if (!OID.test(treeOid)) throw new MultiRepoGitError("CANDIDATE_INVALID", "merge-tree did not return an immutable tree object");
  const commit = runner.run(cwd, ["commit-tree", treeOid, "-p", expectedOid, "-p", childOid, "-m", request.message]);
  if (!commit.ok || !OID.test(commit.out)) throw new MultiRepoGitError("CANDIDATE_INVALID", "candidate commit could not be constructed");
  const candidateOid = commit.out;
  const parents = runner.run(cwd, ["rev-list", "--parents", "-n", "1", candidateOid]);
  if (!parents.ok || parents.out !== `${candidateOid} ${expectedOid} ${childOid}`) {
    throw new MultiRepoGitError("CANDIDATE_INVALID", "candidate parent shape differs from the reviewed vector");
  }
  const candidateTree = runner.run(cwd, ["rev-parse", "--verify", "--end-of-options", `${candidateOid}^{tree}`]);
  if (!candidateTree.ok || candidateTree.out !== treeOid) throw new MultiRepoGitError("CANDIDATE_INVALID", "candidate tree differs from the prepared merge tree");
  const after = readRef(cwd, targetRef, runner);
  if (after !== expectedOid) throw new MultiRepoGitError("EXPECTED_REF_MISMATCH", "target ref moved while the candidate was prepared");
  return Object.freeze({ schemaVersion: 1, repositoryId: request.repository.repositoryId, targetRef, expectedOid, childOid, candidateOid, treeOid, parents: Object.freeze([expectedOid, childOid]) as readonly [string, string] });
}

/** Apply only when the target is still exactly the reviewed anchor; reconcile ambiguous failures. */
export function applyRepositoryCandidate(
  repository: RepositoryIdentityV1,
  candidate: RepositoryCandidateV1,
  runner: MultiRepoGitRunner = defaultRunner
): RepositoryCasResult {
  let cwd: string;
  try { cwd = verifyRepository(repository, runner); }
  catch { return Object.freeze({ state: "recovery_required", reasonCode: "IDENTITY_MISMATCH" }); }
  if (candidate.repositoryId !== repository.repositoryId) throw new MultiRepoGitError("INVALID_REQUEST", "candidate repository identity differs");
  requireRef(candidate.targetRef); requireOid(candidate.expectedOid, "expected OID"); resolveCommit(cwd, candidate.candidateOid, runner);
  const observed = readRef(cwd, candidate.targetRef, runner);
  if (observed === candidate.candidateOid) return Object.freeze({ state: "already_applied", observedOid: observed });
  if (observed !== candidate.expectedOid) return Object.freeze({ state: "refused", reasonCode: "REF_MOVED", observedOid: observed });
  const update = runner.run(cwd, ["update-ref", candidate.targetRef, candidate.candidateOid, candidate.expectedOid]);
  const reconciled = observeRepositoryRef(repository, candidate.targetRef, runner);
  if (reconciled.state === "unknown") return Object.freeze({ state: "recovery_required", reasonCode: "OUTCOME_UNKNOWN" });
  if (reconciled.oid === candidate.candidateOid) return Object.freeze({ state: "applied", observedOid: candidate.candidateOid });
  if (reconciled.oid !== candidate.expectedOid || !update.ok) return Object.freeze({ state: "refused", reasonCode: "REF_MOVED", observedOid: reconciled.oid });
  return Object.freeze({ state: "recovery_required", reasonCode: "OUTCOME_UNKNOWN", observedOid: reconciled.oid });
}

/** Compensate only a ref still exactly at the candidate RelayForge proved it applied. */
export function compensateRepositoryCandidate(
  repository: RepositoryIdentityV1,
  candidate: RepositoryCandidateV1,
  runner: MultiRepoGitRunner = defaultRunner
): RepositoryCompensationResult {
  let cwd: string;
  try { cwd = verifyRepository(repository, runner); }
  catch { return Object.freeze({ state: "recovery_required", reasonCode: "IDENTITY_MISMATCH" }); }
  const observed = readRef(cwd, candidate.targetRef, runner);
  if (observed === candidate.expectedOid) return Object.freeze({ state: "already_compensated", observedOid: observed });
  if (observed !== candidate.candidateOid) return Object.freeze({ state: "refused", reasonCode: "EXTERNAL_MOVE", observedOid: observed });
  const update = runner.run(cwd, ["update-ref", candidate.targetRef, candidate.expectedOid, candidate.candidateOid]);
  const reconciled = observeRepositoryRef(repository, candidate.targetRef, runner);
  if (reconciled.state === "unknown") return Object.freeze({ state: "recovery_required", reasonCode: "OUTCOME_UNKNOWN" });
  if (reconciled.oid === candidate.expectedOid) return Object.freeze({ state: "compensated", observedOid: candidate.expectedOid });
  if (reconciled.oid !== candidate.candidateOid || !update.ok) return Object.freeze({ state: "refused", reasonCode: "EXTERNAL_MOVE", observedOid: reconciled.oid });
  return Object.freeze({ state: "recovery_required", reasonCode: "OUTCOME_UNKNOWN", observedOid: reconciled.oid });
}

export function createMultiRepoGitRunner(): MultiRepoGitRunner { return defaultRunner; }

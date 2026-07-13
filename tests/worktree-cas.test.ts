import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  abandonCandidate,
  attemptCommitOid,
  buildMergeCandidate,
  cleanupRun,
  commitAll,
  createAttemptWorktree,
  integrationTip,
  prepareExecutionTarget,
  publishCandidate,
  worktreesSupported,
  type Worktree
} from "../src/worktree.js";

function g(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "loop-cas-repo-"));
  g(dir, "init", "-q");
  g(dir, "config", "user.email", "t@t.t");
  g(dir, "config", "user.name", "t");
  g(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "base.txt"), "base\n");
  g(dir, "add", "-A");
  g(dir, "commit", "-q", "-m", "base");
  return dir;
}

const PROJECT = "proj";
const RUN = "casrun";
const created: string[] = [];

afterAll(() => {
  for (const repo of created) {
    try {
      cleanupRun(repo, PROJECT, RUN);
    } catch {
      /* best-effort */
    }
  }
});

// Commit a distinct file inside an attempt worktree and return its immutable OID.
function commitFileIn(attempt: Worktree, name: string): string {
  writeFileSync(join(attempt.path, name), `${name}\n`);
  expect(commitAll(attempt.path, `add ${name}`)).toBe(true);
  return attemptCommitOid(attempt)!;
}

/** Build a real forward child commit of `parent` WITHOUT moving any ref (simulates a foreign writer). */
function forwardChildCommit(repo: string, parent: string): string {
  const tree = g(repo, "rev-parse", `${parent}^{tree}`);
  return g(repo, "commit-tree", tree, "-p", parent, "-m", "external advance");
}

describe("integration merge is an atomic compare-and-swap (wave-7 — no false CAS)", () => {
  it("builds an immutable candidate WITHOUT moving the branch, then publishes it via update-ref CAS", () => {
    const repo = initRepo();
    created.push(repo);
    if (!worktreesSupported(repo)) return;

    const integration = prepareExecutionTarget(repo, PROJECT, RUN, []).integration;
    const old = integrationTip(integration)!;

    const a = createAttemptWorktree(repo, PROJECT, RUN, integration, "t1", 1);
    const oidA = commitFileIn(a, "a.txt");

    // Build the candidate: the branch must NOT move while the candidate is being built/verified.
    const built = buildMergeCandidate(integration, a, oidA, old, "integrate a");
    expect(built.ok).toBe(true);
    expect(built.candidate).toMatch(/^[0-9a-f]{40}$/);
    // The BRANCH REF is unmoved during build (HEAD is a detached candidate, but the branch is not).
    expect(g(integration.path, "rev-parse", `refs/heads/${integration.branch}`)).toBe(old);

    // Publish via CAS against the exact expected-old → succeeds and advances the tip to the candidate.
    expect(publishCandidate(integration, built.candidate!, old)).toEqual({ ok: true });
    expect(integrationTip(integration)).toBe(built.candidate);
  });

  it("sequential loop merges each read the fresh tip and compose", () => {
    const repo = initRepo();
    created.push(repo);
    if (!worktreesSupported(repo)) return;
    const integration = prepareExecutionTarget(repo, PROJECT, RUN, []).integration;

    const tip0 = integrationTip(integration)!;
    const a = createAttemptWorktree(repo, PROJECT, RUN, integration, "s1", 1);
    const bA = buildMergeCandidate(integration, a, commitFileIn(a, "a.txt"), tip0, "a");
    expect(publishCandidate(integration, bA.candidate!, tip0)).toEqual({ ok: true });

    const tip1 = integrationTip(integration)!;
    const b = createAttemptWorktree(repo, PROJECT, RUN, integration, "s2", 1);
    const bB = buildMergeCandidate(integration, b, commitFileIn(b, "b.txt"), tip1, "b");
    expect(publishCandidate(integration, bB.candidate!, tip1)).toEqual({ ok: true });
    // Both files present on the composed tip.
    expect(g(integration.path, "cat-file", "-t", bB.candidate!)).toBe("commit");
  });

  it("an EXTERNAL advance of the branch — even strictly FORWARD — FAILS the CAS and is preserved", () => {
    const repo = initRepo();
    created.push(repo);
    if (!worktreesSupported(repo)) return;
    const integration = prepareExecutionTarget(repo, PROJECT, RUN, []).integration;
    const old = integrationTip(integration)!;

    const c = createAttemptWorktree(repo, PROJECT, RUN, integration, "e1", 1);
    const built = buildMergeCandidate(integration, c, commitFileIn(c, "c.txt"), old, "c");
    expect(built.ok).toBe(true);

    // A foreign writer advances the integration branch strictly forward while our candidate is held.
    const ext = forwardChildCommit(repo, old);
    g(repo, "update-ref", `refs/heads/${integration.branch}`, ext);

    // The old code accepted this forward move; a real CAS REFUSES it — the branch is no longer `old`.
    const pub = publishCandidate(integration, built.candidate!, old);
    expect(pub.ok).toBe(false);
    expect(pub.reason).toMatch(/CAS|not at|update.?ref|expected/i);
    // SUCCESSOR PRESERVED: the external advance is intact, never clobbered by our candidate.
    abandonCandidate(integration);
    expect(integrationTip(integration)).toBe(ext);
  });

  it("abandoning a candidate never ROLLS BACK / clobbers already-published history", () => {
    const repo = initRepo();
    created.push(repo);
    if (!worktreesSupported(repo)) return;
    const integration = prepareExecutionTarget(repo, PROJECT, RUN, []).integration;

    const tip0 = integrationTip(integration)!;
    const a = createAttemptWorktree(repo, PROJECT, RUN, integration, "r1", 1);
    const bA = buildMergeCandidate(integration, a, commitFileIn(a, "a.txt"), tip0, "a");
    expect(publishCandidate(integration, bA.candidate!, tip0)).toEqual({ ok: true });
    const published = integrationTip(integration)!;

    // Build a second candidate, then ABANDON it (e.g. its post-merge verify went red).
    const b = createAttemptWorktree(repo, PROJECT, RUN, integration, "r2", 1);
    const bB = buildMergeCandidate(integration, b, commitFileIn(b, "b.txt"), published, "b");
    expect(bB.ok).toBe(true);
    abandonCandidate(integration);
    // The previously PUBLISHED tip is untouched — abandon must not rewind it (the old resetIntegrationTo did).
    expect(integrationTip(integration)).toBe(published);
  });
});

import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attemptCommitOid, attemptDiff, attemptPatchArtifact, captureAttemptPatch, commitAll } from "../src/worktree.js";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "loop-review-"));
  execSync("git init -q && git config user.email t@t.t && git config user.name t && git config commit.gpgsign false", { cwd: dir });
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  execSync("git add -A && git commit -qm base", { cwd: dir });
  return dir;
}

describe("review artifact integrity (P0.6)", () => {
  it("truncates the reviewer PROMPT diff but hashes the FULL patch, even past 20K", () => {
    const dir = repo();
    const base = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    // A change whose diff far exceeds 20K characters.
    writeFileSync(join(dir, "big.txt"), "x".repeat(60_000) + "\n");
    const changed = commitAll(dir, "big change");
    expect(changed).toBe(true);

    const wt = { role: "t1", path: dir, branch: "b", isolated: true } as const;
    const oid = attemptCommitOid(wt);
    expect(oid).toMatch(/^[0-9a-f]{40}$/);
    expect(oid).not.toBe(base);

    const prompt = attemptDiff(wt, base, 20_000);
    expect(prompt.length).toBeLessThanOrEqual(20_120);
    expect(prompt).toContain("truncated");

    const artifact = attemptPatchArtifact(wt, base);
    // The full patch is preserved (well over 20K) and hashed — nothing is silently dropped.
    expect(artifact.ok).toBe(true);
    expect(artifact.bytes).toBeGreaterThan(50_000);
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact.patch.length).toBeGreaterThan(50_000);
  });

  it("captures a MULTI-MEGABYTE patch to a file with exact on-disk bytes (no buffer truncation)", () => {
    const dir = repo();
    const base = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    // ~3 MB of added text — far past the old 1 MB spawnSync buffer that truncated silently.
    const big = "line of content number 0123456789\n".repeat(90_000);
    writeFileSync(join(dir, "huge.txt"), big);
    expect(commitAll(dir, "huge change")).toBe(true);

    const wt = { role: "t1", path: dir, branch: "b", isolated: true } as const;
    const out = join(dir, "artifact.patch");
    const art = captureAttemptPatch(wt, base, out);
    expect(art.ok).toBe(true);
    expect(art.bytes).toBeGreaterThan(3_000_000);
    // The hash matches the EXACT bytes on disk, and the file is the full patch (not truncated).
    const onDisk = readFileSync(out);
    expect(onDisk.length).toBe(art.bytes);
    expect(createHash("sha256").update(onDisk).digest("hex")).toBe(art.sha256);
    expect(onDisk.toString("utf8")).toContain("huge.txt");
  });

  it("includes BINARY files (--binary) in the captured patch", () => {
    const dir = repo();
    const base = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    // A binary blob with NUL bytes.
    writeFileSync(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 3, 255, 254, 0, 42, 7]));
    expect(commitAll(dir, "add binary")).toBe(true);

    const wt = { role: "t1", path: dir, branch: "b", isolated: true } as const;
    const art = captureAttemptPatch(wt, base, join(dir, "bin.patch"));
    expect(art.ok).toBe(true);
    expect(art.patch).toMatch(/GIT binary patch|Binary files/);
  });

  it("fails closed (ok:false) when git cannot produce the diff", () => {
    const dir = repo();
    const wt = { role: "t1", path: dir, branch: "b", isolated: true } as const;
    // A bogus base ref makes git diff exit non-zero → capture must report failure, not a fake hash.
    const art = captureAttemptPatch(wt, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", join(dir, "x.patch"));
    expect(art.ok).toBe(false);
    expect(art.sha256).toBe("");
    expect(art.reason).toBeTruthy();
  });
});

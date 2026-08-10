import { mkdtempSync, symlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertId, isValidId, containedJoin, assertRealContained, containsSymlink, markOwned, isOwned } from "../src/ids.js";
import { integrationBranchName, worktreeRoot } from "../src/worktree.js";
import { sessionName } from "../src/tmux.js";
import { RootConfigSchema } from "../src/config/schema.js";

const ATTACKS = [
  "..",
  ".",
  "../etc",
  "a/../../b",
  "foo/bar",
  "foo\\bar",
  "a b",
  "a;rm -rf /",
  "a\nb",
  "a\tb",
  "/abs",
  "-flag",
  ".hidden",
  "a$(whoami)",
  "a`id`",
  "x".repeat(65)
];

describe("strict identifier parser (reject, never sanitize)", () => {
  it("accepts canonical ids", () => {
    for (const ok of ["run-20260101T000000", "demo-product", "planner", "t1", "loop.delivery", "a_b-c.d"]) {
      expect(isValidId(ok)).toBe(true);
      expect(assertId("run", ok)).toBe(ok);
    }
  });

  it("rejects every traversal / control / separator / metacharacter attack", () => {
    for (const bad of ATTACKS) {
      expect(isValidId(bad), `should reject ${JSON.stringify(bad)}`).toBe(false);
      expect(() => assertId("run", bad)).toThrow();
    }
  });
});

describe("safe contained joins", () => {
  it("keeps joins inside the root and rejects escapes", () => {
    const root = "/srv/runs";
    expect(containedJoin(root, "a", "b")).toBe(resolve(root, "a/b"));
    expect(() => containedJoin(root, "..", "etc")).toThrow(/escapes/);
    expect(() => containedJoin(root, "/abs")).toThrow(/Absolute/);
  });

  it("refuses a path reached through a symlink out of the root", () => {
    const base = mkdtempSync(join(tmpdir(), "loop-sym-"));
    const root = join(base, "root");
    const outside = join(base, "outside");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const link = join(root, "link");
    symlinkSync(outside, link, "dir");
    expect(containsSymlink(join(link, "child"))).toBe(true);
    expect(() => assertRealContained(root, join(link, "child"))).toThrow(/outside/);
  });
});

describe("ownership manifests", () => {
  it("only reports directories the loop created as owned", () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-own-"));
    expect(isOwned(dir)).toBe(false);
    markOwned(dir, { runId: "r1" });
    expect(isOwned(dir)).toBe(true);
  });
});

describe("identifiers flow into derived paths/refs safely", () => {
  it("branch names are built from validated project/run ids and reject bad ones", () => {
    expect(integrationBranchName("demo", "run-1")).toBe("loop/demo/run-1/integration");
    expect(() => integrationBranchName("demo", "../evil")).toThrow();
    expect(() => worktreeRoot("/repo", "demo", "a;b")).toThrow();
  });

  it("session names never contain shell/tmux metacharacters", () => {
    const s = sessionName("loop", "demo", "run-1", "team");
    expect(/^[A-Za-z0-9_.:-]+$/.test(s)).toBe(true);
  });
});

describe("config schema is strict and id-validated", () => {
  const base = {
    version: 1,
    projects: [
      {
        name: "demo",
        providers: { agent: { type: "custom", command: "x" } },
        roles: [{ name: "dev", title: "Dev", provider: "agent" }]
      }
    ]
  };

  it("accepts a clean config", () => {
    expect(RootConfigSchema.safeParse(base).success).toBe(true);
  });

  it("rejects an unknown top-level key (strict)", () => {
    expect(RootConfigSchema.safeParse({ ...base, bogus: 1 }).success).toBe(false);
  });

  it("rejects a project name that is not a canonical id", () => {
    const bad = { ...base, projects: [{ ...base.projects[0], name: "../evil" }] };
    expect(RootConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a role name with a path separator", () => {
    const bad = { ...base, projects: [{ ...base.projects[0], roles: [{ name: "a/b", title: "X", provider: "agent" }] }] };
    expect(RootConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects the removed unsafe safetyMode: full-auto", () => {
    const bad = { ...base, projects: [{ ...base.projects[0], safetyMode: "full-auto" }] };
    expect(RootConfigSchema.safeParse(bad).success).toBe(false);
  });
});

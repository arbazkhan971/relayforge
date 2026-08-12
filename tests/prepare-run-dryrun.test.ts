import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";
import { disposePreparedRun, prepareRun } from "../src/orchestrator.js";
import { registerOwnedTemp } from "./global-teardown.js";

function fixture(root: string, providerType = "codex"): ReturnType<typeof loadConfig> {
  writeFileSync(join(root, "loop.config.yaml"), `version: 1
defaults:
  runDir: .loop/runs
  viewport: false
projects:
  - name: demo
    workingDir: .
    providers:
      backend: { type: ${providerType}, model: gpt-5.4 }
    roles:
      - { name: be1, title: Backend engineer, provider: backend }
    loops:
      - { name: loop, orchestrator: be1, reviewer: be1 }
`);
  return loadConfig(join(root, "loop.config.yaml"));
}

describe("plan-only dry-run without a money ledger", () => {
  it("prepares a durable plan run on any host (macOS included)", () => {
    const root = mkdtempSync(join(tmpdir(), "rf-dryrun-"));
    registerOwnedTemp(root);
    writeFileSync(join(root, "README.md"), "fixture\n");
    const loaded = fixture(root);
    const project = loaded.config.projects[0]!;

    // execute=false: the legacy default always opened the money ledger, which macOS cannot pin
    // (/proc/self/fd anchor) and which a plan does not use — nothing launches, no money moves.
    const ctx = prepareRun(loaded, project, "dry-run-1", "ship it", undefined, false);
    try {
      expect(ctx.runId).toBe("dry-run-1");
      expect(ctx.goal).toBe("ship it");
      expect(resolve(ctx.boardDir)).toContain("dry-run-1");
      // A plan-only dry-run must never REQUIRE a ledger: hosts that cannot pin one (darwin) get
      // `undefined` here; Linux hosts still write one. Either way prepareRun must not throw.
      expect(ctx.ledger === undefined || typeof ctx.ledger === "object").toBe(true);
    } finally {
      disposePreparedRun(ctx);
    }
  });

  it("keeps the execute contract unchanged: execute=true requires the strong ledger", () => {
    const root = mkdtempSync(join(tmpdir(), "rf-dryrun-exec-"));
    registerOwnedTemp(root);
    writeFileSync(join(root, "README.md"), "fixture\n");
    const loaded = fixture(root);
    const project = loaded.config.projects[0]!;
    if (process.platform === "linux") {
      const ctx = prepareRun(loaded, project, "exec-run-1", "ship it", undefined, true);
      try {
        expect(ctx.ledger !== undefined).toBe(true); // never elided for execute
      } finally {
        disposePreparedRun(ctx);
      }
    } else {
      // Hosts that cannot pin a ledger keep FAILING CLOSED for execute — before returning.
      expect(() => prepareRun(loaded, project, "exec-run-1", "ship it", undefined, true)).toThrow(/pinned-directory anchor/u);
    }
  });
});

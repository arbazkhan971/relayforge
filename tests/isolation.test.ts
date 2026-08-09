import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";
import { disposePreparedRun, prepareRun } from "../src/orchestrator.js";
import { integrationBranchName } from "../src/worktree.js";
import { sessionName } from "../src/tmux.js";

const CONFIG = `version: 1
defaults:
  runDir: .loop/runs
projects:
  - name: alpha
    workingDir: .
    providers: { agent: { type: custom, command: node } }
    roles: [{ name: dev, title: Dev, provider: agent }]
  - name: beta
    workingDir: .
    providers: { agent: { type: custom, command: node } }
    roles: [{ name: dev, title: Dev, provider: agent }]
`;

describe("two projects with the same run id stay isolated", () => {
  it("separate run state dir, integration branch, and tmux session per project", () => {
    const root = mkdtempSync(join(tmpdir(), "loop-iso-"));
    writeFileSync(join(root, "loop.config.yaml"), CONFIG);
    const loaded = loadConfig(join(root, "loop.config.yaml"));
    const [alpha, beta] = loaded.config.projects;
    const runId = "run-shared";

    const a = prepareRun(loaded, alpha, runId, "goal");
    const alphaRunDir = a.runDir;
    const alphaBoardDir = a.boardDir;
    disposePreparedRun(a);
    const b = prepareRun(loaded, beta, runId, "goal");

    // Distinct on-disk run state (state, board, logs).
    expect(alphaRunDir).not.toBe(b.runDir);
    expect(alphaRunDir).toContain(`${join("runs", "alpha")}`);
    expect(b.runDir).toContain(`${join("runs", "beta")}`);
    expect(alphaBoardDir).not.toBe(b.boardDir);

    // Distinct integration branch names.
    expect(integrationBranchName("alpha", runId)).toBe("loop/alpha/run-shared/integration");
    expect(integrationBranchName("beta", runId)).toBe("loop/beta/run-shared/integration");
    expect(integrationBranchName("alpha", runId)).not.toBe(integrationBranchName("beta", runId));

    // Distinct tmux sessions.
    expect(sessionName("loop", "alpha", runId, "team")).not.toBe(sessionName("loop", "beta", runId, "team"));
    disposePreparedRun(b);
  });
});

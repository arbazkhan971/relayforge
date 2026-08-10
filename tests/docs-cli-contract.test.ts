import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(repoRoot, "src/cli.ts");
const tsxPath = resolve(repoRoot, "node_modules/tsx/dist/cli.mjs");

function help(args: readonly string[]): string {
  const result = spawnSync(process.execPath, [tsxPath, cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" }
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe("documented CLI contracts", () => {
  it("keeps steering examples aligned with the executable help surface", () => {
    const admit = help(["steer", "admit", "--help"]);
    const withdraw = help(["steer", "withdraw", "--help"]);
    const docs = ["README.md", "docs/autonomous-team.md", "docs/session-steering.md"]
      .map((file) => readFileSync(resolve(repoRoot, file), "utf8"))
      .join("\n");

    for (const flag of [
      "--project",
      "--run",
      "--run-epoch",
      "--command-id",
      "--task-id",
      "--task-generation",
      "--session-id",
      "--session-generation",
      "--not-before-attempt",
      "--body"
    ]) {
      expect(admit).toContain(flag);
      expect(docs).toContain(flag);
    }
    expect(admit).not.toContain("--generation <");
    expect(admit).not.toContain("--text");
    expect(withdraw).not.toContain("--generation");
    expect(withdraw).not.toContain("--text");
    expect(docs).not.toContain("relayforge steer admit --generation");
    expect(docs).not.toContain("relayforge steer admit --text");
  });

  it("documents logs as a tmux-session command, never a run-scoped command", () => {
    const logs = help(["logs", "--help"]);
    const readme = readFileSync(resolve(repoRoot, "README.md"), "utf8");

    expect(logs).toMatch(/Usage: relayforge logs \[options\] <session>/u);
    expect(logs).toContain("--lines <count>");
    expect(logs).not.toContain("--run");
    expect(readme).toContain("relayforge logs <owned-tmux-session> --lines 160");
    expect(readme).not.toMatch(/relayforge logs[^\n]*--run/u);
  });
});

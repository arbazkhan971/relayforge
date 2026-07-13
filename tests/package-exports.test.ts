import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Node only permits self-referencing a package by name when it declares "exports",
 * so resolving "loop-orchestrator/..." from inside the repo exercises the real
 * package resolver — the same code path a consumer hits after `npm install`.
 */
function resolveFromNode(specifier: string): { ok: boolean; code: string; stderr: string } {
  try {
    const stdout = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", `import.meta.resolve(${JSON.stringify(specifier)})`],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { ok: true, code: "", stderr: stdout };
  } catch (err) {
    const stderr = String((err as { stderr?: Buffer | string }).stderr ?? "");
    const match = /ERR_[A-Z_]+/.exec(stderr);
    return { ok: false, code: match?.[0] ?? "", stderr };
  }
}

describe("package exports map", () => {
  beforeAll(() => {
    if (!existsSync(resolve(repoRoot, "dist/index.js"))) {
      execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
    }
  }, 120_000);

  it("exposes the public root API", async () => {
    expect(resolveFromNode("loop-orchestrator").ok).toBe(true);

    const mod = await import(resolve(repoRoot, "dist/index.js"));
    expect(typeof mod).toBe("object");
    expect(Object.keys(mod).length).toBeGreaterThan(0);
  });

  it("exposes the CLI entry", () => {
    expect(resolveFromNode("loop-orchestrator/cli").ok).toBe(true);
  });

  it.each([
    "loop-orchestrator/attest",
    "loop-orchestrator/ledger",
    "loop-orchestrator/settlement-kernel",
    "loop-orchestrator/dist/attest.js",
    "loop-orchestrator/dist/ledger.js",
    "loop-orchestrator/src/ledger.ts",
    "loop-orchestrator/orchestrator",
    "loop-orchestrator/money",
  ])("blocks the internal subpath %s", (specifier) => {
    const result = resolveFromNode(specifier);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("ERR_PACKAGE_PATH_NOT_EXPORTED");
  });

  it("keeps the bin entry runnable", () => {
    const binPath = resolve(repoRoot, "dist/cli.js");
    expect(existsSync(binPath)).toBe(true);

    const stdout = execFileSync(process.execPath, [binPath, "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(stdout).toContain("Usage:");
  });
});

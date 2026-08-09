import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getCachedLinuxVerifierCgroupRuntime } from "../src/cgroup-delegation-linux.js";
import { parseVerifierCgroupJournalLine, VERIFIER_CGROUP_UNAVAILABLE_REASONS } from "../src/cgroup-delegation.js";
import {
  disposePreparedRun,
  prepareRun,
  runMultiRepositoryVerification
} from "../src/orchestrator.js";
import { setTrustedRunner } from "../src/sandbox.js";
import { loadConfig } from "../src/config/load.js";
import { setupRepo } from "./e2e-harness.js";
import { registerOwnedTemp } from "./global-teardown.js";

describe("P6 canonical verifier authority", () => {
  it("has no independent raw child or sandbox authority in the product P6 runtime", () => {
    const source = readFileSync(resolve(process.cwd(), "src/multirepo/runtime.ts"), "utf8");
    expect(source).not.toMatch(/\brunHeadlessChild\b/u);
    expect(source).not.toMatch(/\bcontainCommand\b/u);
    expect(source).toContain("context.runVerification");
  });

  it("uses the production verifier jail when available and otherwise proves a zero-exec refusal", async () => {
    setTrustedRunner(false);
    const { repoDir } = setupRepo();
    const loaded = loadConfig(join(repoDir, "loop.config.yaml"));
    const ctx = prepareRun(loaded, loaded.config.projects[0]!, "p6-verifier-authority", "verify through the canonical jail");
    const marker = join(repoDir, "p6-verifier-ran");
    try {
      const runtime = await getCachedLinuxVerifierCgroupRuntime();
      ctx.verifierCgroupRuntime = runtime;
      const result = await runMultiRepositoryVerification(ctx, {
        transactionId: "transaction-one",
        commandIndex: 0,
        command: `printf canonical-p6-verifier && printf ran > ${JSON.stringify(marker)}`,
        workCwd: repoDir,
        workspaceRoots: [repoDir],
        environment: { RELAYFORGE_REPOSITORY_COUNT: "2" }
      });
      if (!runtime.capability.available) {
        expect(VERIFIER_CGROUP_UNAVAILABLE_REASONS).toContain(runtime.capability.reasonCode);
        expect(result).toMatchObject({ ok: false, transportTrusted: false, scopeTrusted: false });
        expect(existsSync(marker)).toBe(false);
      } else {
        expect(result).toMatchObject({ ok: true, code: 0, transportTrusted: true, scopeTrusted: true });
        expect(readFileSync(marker, "utf8")).toBe("ran");
        const records = readFileSync(ctx.scopesPath, "utf8").trim().split("\n");
        expect(records).toHaveLength(1);
        const parsed = parseVerifierCgroupJournalLine(records[0]!);
        expect(parsed.kind).toBe("v2");
        if (parsed.kind === "v2") expect(parsed.record.attemptId).toMatch(/^verify-mr-[a-f0-9]{32}$/u);
      }
    } finally {
      disposePreparedRun(ctx);
      setTrustedRunner(false);
    }
  }, 60_000);

  it("mounts the exact two-repository verification vector after the /tmp shadow while a third root stays absent", async () => {
    setTrustedRunner(false);
    const { repoDir } = setupRepo();
    const loaded = loadConfig(join(repoDir, "loop.config.yaml"));
    const ctx = prepareRun(loaded, loaded.config.projects[0]!, "p6-verifier-vector", "verify an exact repository vector");
    const vectorRoot = mkdtempSync(join(tmpdir(), "relayforge-p6-verifier-vector-"));
    registerOwnedTemp(vectorRoot);
    const alpha = resolve(vectorRoot, "alpha");
    const beta = resolve(vectorRoot, "beta");
    const gamma = resolve(vectorRoot, "gamma");
    for (const root of [alpha, beta, gamma]) mkdirSync(root, { mode: 0o700 });
    writeFileSync(resolve(alpha, "candidate.txt"), "alpha\n", { mode: 0o600 });
    writeFileSync(resolve(beta, "candidate.txt"), "beta\n", { mode: 0o600 });
    writeFileSync(resolve(gamma, "host-secret"), "third\n", { mode: 0o600 });
    try {
      const runtime = await getCachedLinuxVerifierCgroupRuntime();
      expect(runtime.capability.available, runtime.capability.detail).toBe(true);
      if (!runtime.capability.available) return;
      ctx.verifierCgroupRuntime = runtime;
      const result = await runMultiRepositoryVerification(ctx, {
        transactionId: "transaction-vector",
        commandIndex: 0,
        command: [
          'test "$(cat "$RELAYFORGE_REPO_0_PATH/candidate.txt")" = alpha',
          'test "$(cat "$RELAYFORGE_REPO_1_PATH/candidate.txt")" = beta',
          'printf build-output > "$RELAYFORGE_REPO_1_PATH/.verification-cache"',
          'test ! -e "$UNDECLARED_REPOSITORY_PATH/host-secret"'
        ].join(" && "),
        workCwd: alpha,
        workspaceRoots: [alpha, beta],
        environment: {
          RELAYFORGE_REPO_0_PATH: alpha,
          RELAYFORGE_REPO_1_PATH: beta,
          UNDECLARED_REPOSITORY_PATH: gamma
        }
      });
      expect(result).toMatchObject({ ok: true, code: 0, transportTrusted: true, scopeTrusted: true });
      expect(readFileSync(resolve(beta, ".verification-cache"), "utf8")).toBe("build-output");
      expect(readFileSync(resolve(gamma, "host-secret"), "utf8")).toBe("third\n");
    } finally {
      disposePreparedRun(ctx);
      setTrustedRunner(false);
    }
  }, 60_000);
});

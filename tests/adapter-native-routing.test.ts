import { chmodSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getShippedAdapterDescriptor } from "../src/adapters/bootstrap.js";
import { containedAdapterProbeConfigurationSha256 } from "../src/adapters/contained-evidence.js";
import { defineAdapterAvailability } from "../src/adapters/registry.js";
import { inspectAdapterRuntimeFile } from "../src/adapters/runtime.js";
import type { AdapterAvailability, CapabilityEvidenceSetInput } from "../src/adapters/types.js";
import { RootConfigSchema, type RoleConfig } from "../src/config/schema.js";
import { initCostLedger } from "../src/cost.js";
import { LEDGER_LEAF } from "../src/ledger.js";
import {
  disposePreparedRun,
  prepareRun,
  runRoutedTurn,
  type LoopRunState,
  type RunContext
} from "../src/orchestrator.js";
import { setTrustedRunner } from "../src/sandbox.js";
import { detectScopeCapability } from "../src/scope.js";
import { requestCancel } from "../src/runtime.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_FIXTURE = resolve(HERE, "fixtures/adapters/native-provider.mjs");
const PI_HELPER = resolve(HERE, "../assets/pi-relayforge-reviewer.mjs");
const HASH = "a".repeat(64);
const SCOPE = detectScopeCapability();

function capabilities(type: "opencode" | "pi" | "grok"): CapabilityEvidenceSetInput {
  const descriptor = getShippedAdapterDescriptor(type);
  return Object.fromEntries(Object.entries(descriptor.capabilityPolicy).map(([name, policy]) => [
    name,
    policy === "unsupported"
      ? { status: "unsupported", source: "native-contract", detail: `${name} is outside the characterized contract` }
      : { status: "proven", source: "behavioral-probe", detail: `${name} passed the contained fixture` }
  ])) as CapabilityEvidenceSetInput;
}

function availability(type: "opencode" | "pi" | "grok", executablePath: string): AdapterAvailability {
  const descriptor = getShippedAdapterDescriptor(type);
  return defineAdapterAvailability(descriptor, {
    status: "available",
    binding: {
      adapterId: descriptor.id,
      contractVersion: descriptor.contractVersion,
      normalizer: { ...descriptor.normalizer }
    },
    executable: inspectAdapterRuntimeFile(type, executablePath, true),
    trustedHelpers: type === "pi"
      ? [inspectAdapterRuntimeFile("pi-relayforge-reviewer.mjs", PI_HELPER)]
      : type === "grok"
        ? [inspectAdapterRuntimeFile("grok-egress-relay.mjs", resolve(HERE, "../assets/grok-egress-relay.mjs"))]
        : [],
    observedExecutableVersion: type === "opencode" ? "1.18.15" : type === "pi" ? "0.84.1" : "1.0.0",
    supportedExecutableRange: { ...descriptor.compatibility.executableVersion },
    wireVersion: descriptor.compatibility.wireVersions[0]!,
    behavioralChecks: descriptor.compatibility.behavioralProbe.requiredChecks.map((check) => ({
      check,
      outcome: "passed" as const,
      evidenceSha256: HASH
    })),
    capabilities: capabilities(type),
    probedAt: "2026-08-09T00:00:00.000Z",
    consultedConfigSha256: containedAdapterProbeConfigurationSha256(type, process.env)
  });
}

function state(): LoopRunState {
  return {
    runId: "native-run",
    project: "native",
    phase: "dispatch",
    status: "running",
    iteration: 1,
    dispatched: 0,
    accepted: 0,
    rejected: 0,
    escalations: 0,
    repeatFailures: 0,
    unknownCostCalls: 0,
    startedAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z"
  };
}

function harness(type: "opencode" | "pi" | "grok"): { ctx: RunContext; role: RoleConfig } {
  const rootDir = mkdtempSync(join(tmpdir(), `relayforge-native-${type}-`));
  const executablePath = join(rootDir, type);
  copyFileSync(SOURCE_FIXTURE, executablePath);
  chmodSync(executablePath, 0o700);
  const config = RootConfigSchema.parse({
    version: 1,
    defaults: { runDir: ".loop/runs" },
    projects: [{
      name: "native",
      workingDir: ".",
      providers: { native: { type } },
      roles: [{ name: "builder", title: "Builder", provider: "native" }],
      loops: [{
        name: "delivery",
        orchestrator: "builder",
        reviewer: "builder",
        budgetUsd: 1,
        maxCostPerCallUsd: 1,
        allowUnknownCostCalls: 0
      }]
    }]
  });
  const loaded = { config, path: join(rootDir, "loop.config.yaml"), rootDir };
  writeFileSync(loaded.path, "version: 1\n", { mode: 0o600 });
  const project = config.projects[0]!;
  const ctx = prepareRun(loaded, project, "native-run", "native protocol");
  initCostLedger(ctx.boardDir);
  ctx.adapterAvailability = { native: availability(type, executablePath) };
  return { ctx, role: project.roles[0]! };
}

describe.skipIf(!SCOPE.strong)("native structured provider routed E2E", () => {
  it.each([
    ["opencode", "native acp result"],
    ["pi", "native pi result"],
    ["grok", "native grok result"]
  ] as const)("routes %s through the single contained transcript and settlement path", async (type, expected) => {
    setTrustedRunner(true);
    const { ctx, role } = harness(type);
    try {
      const result = await runRoutedTurn(
        ctx,
        role,
        "implementer",
        "perform the task",
        { file: join(ctx.promptDir, "system.md"), text: "standing system prompt" },
        ctx.cwd,
        "",
        state(),
        "task-1",
        1
      );
      expect(result.ok).toBe(true);
      expect(result.normalized).toMatchObject({ provider: type, success: true, finalText: expected, explicitLimit: false });
      expect(result.adapterResult).toMatchObject({ status: "success", finalText: expected });
      expect(result.transcriptDurable).toBe(true);
      expect(result.settlementCallId).toBeTruthy();
      expect(ctx.ledger.settlementOf(result.settlementCallId!).costTrusted).toBe(true);
    } finally {
      disposePreparedRun(ctx);
      setTrustedRunner(false);
    }
  }, 30_000);

  it("rejects missing compatibility evidence before a reservation exists", async () => {
    setTrustedRunner(true);
    const { ctx, role } = harness("opencode");
    ctx.adapterAvailability = {};
    try {
      await expect(runRoutedTurn(
        ctx,
        role,
        "implementer",
        "perform the task",
        { file: join(ctx.promptDir, "system.md"), text: "standing system prompt" },
        ctx.cwd,
        "",
        state(),
        "task-1",
        1
      )).rejects.toThrow(/unavailable before reservation/);
      expect(readFileSync(join(ctx.boardDir, LEDGER_LEAF), "utf8")).not.toContain('"type":"reserve"');
    } finally {
      disposePreparedRun(ctx);
      setTrustedRunner(false);
    }
  });

  it.each(["opencode", "pi", "grok"] as const)("sends one cooperative native cancel to %s before scope fallback", async (type) => {
    setTrustedRunner(true);
    const { ctx, role } = harness(type);
    const cancel = setTimeout(() => requestCancel(ctx.runDir, "native cancellation test"), 250);
    try {
      const result = await runRoutedTurn(
        ctx,
        role,
        "implementer",
        "long turn",
        { file: join(ctx.promptDir, "system.md"), text: "standing system prompt" },
        ctx.cwd,
        "",
        state(),
        "task-cancel",
        1
      );
      expect(result.ok).toBe(false);
      expect(result.adapterResult).toMatchObject({ status: "cancelled" });
      expect(result.uncertainReason).toContain("cancelled");
      expect(result.scopeTrusted).toBe(true);
    } finally {
      clearTimeout(cancel);
      disposePreparedRun(ctx);
      setTrustedRunner(false);
    }
  }, 30_000);
});

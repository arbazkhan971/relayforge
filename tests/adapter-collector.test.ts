import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { getShippedAdapterDescriptor } from "../src/adapters/bootstrap.js";
import {
  collectContainedAdapterEvidence,
  type ContainedAdapterProbeResult
} from "../src/adapters/contained-evidence-collector.js";
import {
  containedAdapterCheckNames,
  containedAdapterProbeEnvironment,
  canonicalContainedAdapterEvidenceJson,
  canonicalContainedOpenCodeConfigContent,
  containedAdapterProbeConfigurationSha256,
  containedAdapterRuntimeIdentitySha256,
  readContainedAdapterEvidenceFile,
  type ContainedNativeAdapterId
} from "../src/adapters/contained-evidence.js";
import { defineAdapterAvailability } from "../src/adapters/registry.js";
import { inspectAdapterRuntimeFile } from "../src/adapters/runtime.js";
import type { AdapterCapabilityName, CapabilityEvidenceSetInput } from "../src/adapters/types.js";
import {
  allocateContainedCharacterizationRoot,
  assertContainedExecutablePin,
  CHARACTERIZATION_OWNER_MARKER,
  CHARACTERIZATION_ROOT_PREFIX,
  characterizationDirectoryPrefix,
  characterizationRootPrefix,
  collectProductionContainedAdapterEvidence,
  CONTAINED_WORKSPACE_MAX_AGGREGATE_BYTES,
  CONTAINED_WORKSPACE_MAX_DEPTH,
  CONTAINED_WORKSPACE_MAX_ENTRIES,
  CONTAINED_WORKSPACE_MAX_FILE_BYTES,
  CONTAINED_WORKSPACE_MAX_RELATIVE_PATH_BYTES,
  ContainedAdapterCharacterizationUnavailable,
  isCharacterizationOwnerAlive,
  observeContainedOpenCodeSessionCreate,
  observeContainedPiStateAndStats,
  parseCharacterizationDirectoryOwner,
  pinContainedExecutable,
  pinContainedEvidenceRepository,
  piReviewerToolTitleMatchesTarget,
  reconcileDeadCharacterizationRoots,
  snapshotContainedWorkspace
} from "../src/adapters/contained-evidence-production.js";
import { runGit } from "../src/git.js";
import { detectScopeCapability } from "../src/scope.js";

const NONCE = "b".repeat(64);
const NOW = new Date("2026-08-09T15:00:00.000Z");
const roots: string[] = [];
const SCOPE = detectScopeCapability();

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function privateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "relayforge-collector-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function initCleanGitRepo(root: string): string {
  const init = runGit(root, ["init", "--quiet"]);
  if (!init.ok) throw new Error(init.err);
  runGit(root, ["config", "user.email", "test@relayforge.local"]);
  runGit(root, ["config", "user.name", "RelayForge Test"]);
  writeFileSync(join(root, "TRACKED.md"), "clean checkout\n", { mode: 0o600 });
  runGit(root, ["add", "TRACKED.md"]);
  const commit = runGit(root, ["commit", "--quiet", "-m", "baseline"]);
  if (!commit.ok) throw new Error(commit.err);
  const head = runGit(root, ["rev-parse", "HEAD"]);
  if (!head.ok) throw new Error(head.err);
  return head.out;
}

function capabilityEvidence(adapterId: ContainedNativeAdapterId): CapabilityEvidenceSetInput {
  const descriptor = getShippedAdapterDescriptor(adapterId);
  return Object.fromEntries((Object.entries(descriptor.capabilityPolicy) as [AdapterCapabilityName, string][]).map(([name, requirement]) => [
    name,
    requirement === "unsupported"
      ? { status: "unsupported", source: "native-contract", detail: `${name} unsupported` }
      : requirement === "required" || name === "inner-read-only"
        ? { status: "proven", source: "behavioral-probe", detail: `${name} proven` }
        : { status: "unknown", reason: "not-advertised", detail: `${name} unknown` }
  ])) as CapabilityEvidenceSetInput;
}

function proof(adapterId: ContainedNativeAdapterId, root: string, environment?: Readonly<Record<string, string | undefined>>): ContainedAdapterProbeResult {
  const descriptor = getShippedAdapterDescriptor(adapterId);
  const executablePath = join(root, adapterId);
  writeFileSync(executablePath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const executable = inspectAdapterRuntimeFile(adapterId, executablePath, true);
  const helpers = adapterId === "pi" || adapterId === "grok"
    ? (() => {
        const helperName = adapterId === "pi" ? "pi-relayforge-reviewer.mjs" : "grok-egress-relay.mjs";
        const helperPath = join(root, helperName);
        writeFileSync(helperPath, "export {};\n", { mode: 0o600 });
        return [inspectAdapterRuntimeFile(helperName, helperPath)];
      })()
    : [];
  const configurationSha256 = containedAdapterProbeConfigurationSha256(adapterId, environment);
  const behavioralChecks = descriptor.compatibility.behavioralProbe.requiredChecks.map((check) => ({
    check,
    outcome: "passed" as const,
    evidenceSha256: sha(`${adapterId}:behavior:${check}`)
  }));
  const availability = defineAdapterAvailability(descriptor, {
    status: "available",
    binding: { adapterId, contractVersion: descriptor.contractVersion, normalizer: { ...descriptor.normalizer } },
    executable,
    trustedHelpers: helpers,
    observedExecutableVersion: descriptor.compatibility.executableVersion.minInclusive,
    supportedExecutableRange: { ...descriptor.compatibility.executableVersion },
    wireVersion: descriptor.compatibility.wireVersions[0]!,
    behavioralChecks,
    capabilities: capabilityEvidence(adapterId),
    probedAt: NOW.toISOString(),
    consultedConfigSha256: configurationSha256
  });
  if (availability.status !== "available") throw new Error("fixture availability");
  const behavioral = Object.fromEntries(behavioralChecks.map((check) => [check.check, check.evidenceSha256]));
  const checks = Object.fromEntries(containedAdapterCheckNames[adapterId].map((name) => [name, {
    passed: true as const,
    evidenceSha256: name === "promptCompleted"
      ? behavioral["prompt-roundtrip"]!
      : name === "cancellationSettled"
        ? behavioral.cancellation!
        : name === "reviewerWriteDenied"
          ? behavioral["read-only-denial"] ?? sha(`${adapterId}:reviewer`)
          : name === "configurationIsolated"
            ? behavioral["configuration-isolation"]!
            : name === "networkToolPolicyEnforced"
              ? behavioral["network-tool-policy"]!
              : name === "unapprovedUploadDenied"
                ? behavioral["unapproved-upload-denial"]!
                : sha(`${adapterId}:check:${name}`)
  }])) as ContainedAdapterProbeResult["checks"];
  return {
    availability,
    containment: {
      backend: "linux-cgroup-v2",
      scopeId: `probe:${adapterId}`,
      normalExitReapedSha256: sha(`${adapterId}:normal-reaped`),
      cancellationReapedSha256: sha(`${adapterId}:cancel-reaped`)
    },
    settlement: {
      callId: `probe:${adapterId}:call`,
      terminal: true,
      costAuthority: "unknown",
      receiptDigest: sha(`${adapterId}:settlement`)
    },
    checks
  };
}

describe("contained adapter configuration hash parity", () => {
  it("collector, required-real consumer, and receipt extractor independently agree from OPENAI_API_KEY", async () => {
    const root = privateRoot();
    const ambient = { OPENAI_API_KEY: "fixture-openai-key-for-hash-parity" };
    const controlled = containedAdapterProbeEnvironment("opencode", ambient);
    const fromAmbient = containedAdapterProbeConfigurationSha256("opencode", ambient);
    const fromControlled = containedAdapterProbeConfigurationSha256("opencode", controlled);
    // Extractor/consumer path: ambient credential only.
    expect(fromAmbient).toBe(fromControlled);
    expect(fromAmbient).toMatch(/^[a-f0-9]{64}$/u);

    const outputPath = join(root, "hash-parity.json");
    const value = proof("opencode", root, ambient);
    const collected = await collectContainedAdapterEvidence({
      adapterId: "opencode",
      outputPath,
      commitSha: "a".repeat(40),
      jobNonce: NONCE,
      authority: { collect: async () => value },
      environment: ambient,
      now: NOW
    });
    // Required-real / receipt-extractor style re-derivation from OPENAI_API_KEY only.
    const reread = readContainedAdapterEvidenceFile(outputPath, {
      adapterId: "opencode",
      commitSha: "a".repeat(40),
      jobNonce: NONCE,
      configurationSha256: containedAdapterProbeConfigurationSha256("opencode", ambient),
      now: NOW,
      allowedRoot: root
    });
    expect(reread.configurationSha256).toBe(fromAmbient);
    expect(reread.receiptDigest).toBe(collected.receiptDigest);
    expect(reread.availability.consultedConfigSha256).toBe(fromAmbient);
  });

  it("adversarial: non-canonical OPENCODE_CONFIG_CONTENT key order still yields one controlled hash", () => {
    const apiKey = "fixture-canonical-opencode-key";
    const canonical = canonicalContainedOpenCodeConfigContent(apiKey);
    // Same semantic recipe with reordered object keys (non-canonical representation).
    const reordered = JSON.stringify({
      lsp: false,
      formatter: false,
      provider: { openai: { options: { apiKey } } },
      model: "openai/gpt-5.2-codex",
      share: "disabled",
      autoupdate: false,
      $schema: "https://opencode.ai/config.json"
    });
    expect(reordered).not.toBe(canonical);
    const fromAmbient = containedAdapterProbeConfigurationSha256("opencode", { OPENAI_API_KEY: apiKey });
    const fromReordered = containedAdapterProbeConfigurationSha256("opencode", { OPENCODE_CONFIG_CONTENT: reordered });
    const fromCanonicalContent = containedAdapterProbeConfigurationSha256("opencode", { OPENCODE_CONFIG_CONTENT: canonical });
    expect(fromAmbient).toBe(fromReordered);
    expect(fromAmbient).toBe(fromCanonicalContent);
    // Expansion always re-emits the single controlled representation.
    expect(containedAdapterProbeEnvironment("opencode", { OPENCODE_CONFIG_CONTENT: reordered }).OPENCODE_CONFIG_CONTENT).toBe(canonical);
  });
});

describe("contained adapter evidence collector finalizer", () => {
  it.skipIf(!SCOPE.strong)("runs the production OpenCode entrypoint and emits one canonical private receipt", async () => {
    const root = privateRoot();
    const checkout = join(root, "checkout");
    const runner = join(root, "runner");
    const bin = join(root, "bin");
    mkdirSync(checkout, { mode: 0o700 });
    mkdirSync(runner, { mode: 0o700 });
    mkdirSync(bin, { mode: 0o700 });
    const commitSha = initCleanGitRepo(checkout);
    const executable = join(bin, "opencode");
    writeFileSync(executable, readFileSync(new URL("fixtures/adapters/opencode-production.mjs", import.meta.url)), { mode: 0o700 });
    const outputPath = join(runner, "production.json");
    const source = { PATH: bin, OPENAI_API_KEY: "fixture-openai-key" };
    const beforeTemporaryRoots = new Set(
      readdirSync(runner).filter((name) => name.startsWith("rf-contained-opencode-"))
    );
    const collected = await collectProductionContainedAdapterEvidence({
      adapterId: "opencode",
      outputPath,
      commitSha,
      jobNonce: NONCE,
      repositoryRoot: checkout,
      paidProbeAuthorized: true,
      characterizationRoot: runner,
      environment: source,
      forbiddenSentinels: ["fixture-openai-key"]
    });
    expect(statSync(outputPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(outputPath, "utf8")).not.toContain("fixture-openai-key");
    expect(readFileSync(outputPath, "utf8")).toBe(`${canonicalContainedAdapterEvidenceJson(collected)}\n`);
    // Consumer re-derives the controlled hash from OPENAI_API_KEY alone (no OPENCODE_CONFIG_CONTENT).
    const reread = readContainedAdapterEvidenceFile(outputPath, {
      adapterId: "opencode",
      commitSha,
      jobNonce: NONCE,
      configurationSha256: containedAdapterProbeConfigurationSha256("opencode", source),
      now: new Date(collected.collectedAt),
      allowedRoot: runner
    });
    expect(reread.receiptDigest).toBe(collected.receiptDigest);
    expect(reread.availability.status).toBe("available");
    expect(reread.containment.backend).toBe("linux-cgroup-v2");
    expect(reread.settlement.terminal).toBe(true);
    expect(reread.checks.reviewerWriteDenied.evidenceSha256).toBe(
      reread.availability.status === "available"
        ? reread.availability.behavioralChecks.find((check) => check.check === "read-only-denial")?.evidenceSha256
        : undefined
    );
    // Terminal settlement/evidence receipt binds runtime + controlled config + every check digest.
    const expectedRuntime = containedAdapterRuntimeIdentitySha256(
      reread.runtime.executable,
      reread.runtime.trustedHelpers,
      reread.configurationSha256
    );
    expect(reread.settlement.receiptDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(reread.settlement.receiptDigest).not.toBe(reread.receiptDigest);
    // Check digests are distinct and bound into both envelope receipt and availability behavioral checks.
    const checkDigests = Object.values(reread.checks).map((check) => check.evidenceSha256);
    expect(new Set(checkDigests).size).toBe(checkDigests.length);
    expect(reread.configurationSha256).toBe(containedAdapterProbeConfigurationSha256("opencode", source));
    expect(reread.availability.consultedConfigSha256).toBe(reread.configurationSha256);
    expect(expectedRuntime).toMatch(/^[a-f0-9]{64}$/u);
    expect(readdirSync(runner).filter(
      (name) => name.startsWith("rf-contained-opencode-") && !beforeTemporaryRoots.has(name)
    )).toEqual([]);
    // Product checkout remains the same clean commit.
    expect(pinContainedEvidenceRepository(checkout, commitSha).commitSha).toBe(commitSha);
  }, 60_000);

  function productionLayout(fixtureApiKey?: string): Readonly<{
    root: string;
    checkout: string;
    runner: string;
    bin: string;
    commitSha: string;
    source: Readonly<Record<string, string>>;
  }> {
    const root = privateRoot();
    const checkout = join(root, "checkout");
    const runner = join(root, "runner");
    const bin = join(root, "bin");
    mkdirSync(checkout, { mode: 0o700 });
    mkdirSync(runner, { mode: 0o700 });
    mkdirSync(bin, { mode: 0o700 });
    const commitSha = initCleanGitRepo(checkout);
    writeFileSync(join(bin, "opencode"), readFileSync(new URL("fixtures/adapters/opencode-production.mjs", import.meta.url)), { mode: 0o700 });
    return {
      root,
      checkout,
      runner,
      bin,
      commitSha,
      source: { PATH: bin, OPENAI_API_KEY: fixtureApiKey ?? "fixture-openai-key" }
    };
  }

  it("keeps production grok characterization explicitly unavailable", async () => {
    const root = privateRoot();
    const checkout = join(root, "checkout");
    const runner = join(root, "runner");
    const bin = join(root, "bin");
    mkdirSync(checkout, { mode: 0o700 });
    mkdirSync(runner, { mode: 0o700 });
    mkdirSync(bin, { mode: 0o700 });
    const commitSha = initCleanGitRepo(checkout);
    writeFileSync(join(bin, "grok"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const outputPath = join(runner, "grok-production.json");
    await expect(collectProductionContainedAdapterEvidence({
      adapterId: "grok",
      outputPath,
      commitSha,
      jobNonce: NONCE,
      repositoryRoot: checkout,
      paidProbeAuthorized: true,
      characterizationRoot: runner,
      environment: { PATH: bin, XAI_API_KEY: "fixture-grok-key" }
    })).rejects.toBeInstanceOf(ContainedAdapterCharacterizationUnavailable);
    expect(existsSync(outputPath)).toBe(false);
  });

  function piProductionLayout(fixtureApiKey?: string): Readonly<{
    root: string;
    checkout: string;
    runner: string;
    bin: string;
    commitSha: string;
    source: Readonly<Record<string, string>>;
  }> {
    const root = privateRoot();
    const checkout = join(root, "checkout");
    const runner = join(root, "runner");
    const bin = join(root, "bin");
    mkdirSync(checkout, { mode: 0o700 });
    mkdirSync(runner, { mode: 0o700 });
    mkdirSync(bin, { mode: 0o700 });
    const commitSha = initCleanGitRepo(checkout);
    writeFileSync(join(bin, "pi"), readFileSync(new URL("fixtures/adapters/pi-production.mjs", import.meta.url)), { mode: 0o700 });
    return {
      root,
      checkout,
      runner,
      bin,
      commitSha,
      source: { PATH: bin, ANTHROPIC_API_KEY: fixtureApiKey ?? "fixture-pi-key" }
    };
  }

  it.skipIf(!SCOPE.strong)("runs the production Pi entrypoint and emits one canonical private receipt", async () => {
    const layout = piProductionLayout();
    const outputPath = join(layout.runner, "pi-production.json");
    const beforeTemporaryRoots = new Set(
      readdirSync(layout.runner).filter((name) => name.startsWith(characterizationRootPrefix("pi")))
    );
    const collected = await collectProductionContainedAdapterEvidence({
      adapterId: "pi",
      outputPath,
      commitSha: layout.commitSha,
      jobNonce: NONCE,
      repositoryRoot: layout.checkout,
      paidProbeAuthorized: true,
      characterizationRoot: layout.runner,
      environment: layout.source,
      forbiddenSentinels: ["fixture-pi-key"]
    });
    expect(statSync(outputPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(outputPath, "utf8")).not.toContain("fixture-pi-key");
    expect(readFileSync(outputPath, "utf8")).toBe(`${canonicalContainedAdapterEvidenceJson(collected)}\n`);
    const reread = readContainedAdapterEvidenceFile(outputPath, {
      adapterId: "pi",
      commitSha: layout.commitSha,
      jobNonce: NONCE,
      configurationSha256: containedAdapterProbeConfigurationSha256("pi", layout.source),
      now: new Date(collected.collectedAt),
      allowedRoot: layout.runner
    });
    expect(reread.receiptDigest).toBe(collected.receiptDigest);
    expect(reread.availability.status).toBe("available");
    expect(reread.containment.backend).toBe("linux-cgroup-v2");
    expect(reread.settlement.terminal).toBe(true);
    expect(Object.keys(reread.checks).sort()).toEqual([
      "cancellationSettled",
      "promptCompleted",
      "replayMatched",
      "reviewerWriteDenied",
      "scopeEmpty",
      "stateAndStatsCompleted"
    ]);
    expect(reread.runtime.trustedHelpers).toHaveLength(1);
    expect(reread.runtime.trustedHelpers[0]?.runtimeName).toBe("pi-relayforge-reviewer.mjs");
    expect(reread.checks.reviewerWriteDenied.evidenceSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(reread.checks.stateAndStatsCompleted.evidenceSha256).toMatch(/^[a-f0-9]{64}$/u);
    const expectedRuntime = containedAdapterRuntimeIdentitySha256(
      reread.runtime.executable,
      reread.runtime.trustedHelpers,
      reread.configurationSha256
    );
    expect(reread.settlement.receiptDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(reread.settlement.receiptDigest).not.toBe(reread.receiptDigest);
    const checkDigests = Object.values(reread.checks).map((check) => check.evidenceSha256);
    expect(new Set(checkDigests).size).toBe(checkDigests.length);
    expect(reread.configurationSha256).toBe(containedAdapterProbeConfigurationSha256("pi", layout.source));
    expect(reread.availability.consultedConfigSha256).toBe(reread.configurationSha256);
    expect(expectedRuntime).toMatch(/^[a-f0-9]{64}$/u);
    expect(readdirSync(layout.runner).filter(
      (name) => name.startsWith(characterizationRootPrefix("pi")) && !beforeTemporaryRoots.has(name)
    )).toEqual([]);
    expect(pinContainedEvidenceRepository(layout.checkout, layout.commitSha, "pi").commitSha).toBe(layout.commitSha);
  }, 60_000);

  it.skipIf(!SCOPE.strong)("removes private run state and emits nothing when Pi handshake fails", async () => {
    const layout = piProductionLayout("fixture-fail-handshake");
    const outputPath = join(layout.runner, "pi-failed.json");
    const before = new Set(readdirSync(layout.runner).filter((name) => name.startsWith(characterizationRootPrefix("pi"))));
    await expect(collectProductionContainedAdapterEvidence({
      adapterId: "pi",
      outputPath,
      commitSha: layout.commitSha,
      jobNonce: NONCE,
      repositoryRoot: layout.checkout,
      paidProbeAuthorized: true,
      characterizationRoot: layout.runner,
      environment: layout.source,
      forbiddenSentinels: ["fixture-fail-handshake"]
    })).rejects.toBeInstanceOf(ContainedAdapterCharacterizationUnavailable);
    expect(existsSync(outputPath)).toBe(false);
    expect(readdirSync(layout.runner).filter(
      (name) => name.startsWith(characterizationRootPrefix("pi")) && !before.has(name)
    )).toEqual([]);
  }, 30_000);

  it.skipIf(!SCOPE.strong)("refuses Pi worker no-write probes that create a new file", async () => {
    const layout = piProductionLayout("fixture-worker-write-new");
    const outputPath = join(layout.runner, "pi-worker-write.json");
    await expect(collectProductionContainedAdapterEvidence({
      adapterId: "pi",
      outputPath,
      commitSha: layout.commitSha,
      jobNonce: NONCE,
      repositoryRoot: layout.checkout,
      paidProbeAuthorized: true,
      characterizationRoot: layout.runner,
      environment: layout.source
    })).rejects.toThrow(/mutated the characterization workspace|no-write/i);
    expect(existsSync(outputPath)).toBe(false);
  }, 60_000);

  it.skipIf(!SCOPE.strong)("refuses Pi worker no-write probes that mutate an existing file", async () => {
    const layout = piProductionLayout("fixture-worker-mutate");
    const outputPath = join(layout.runner, "pi-worker-mutate.json");
    await expect(collectProductionContainedAdapterEvidence({
      adapterId: "pi",
      outputPath,
      commitSha: layout.commitSha,
      jobNonce: NONCE,
      repositoryRoot: layout.checkout,
      paidProbeAuthorized: true,
      characterizationRoot: layout.runner,
      environment: layout.source
    })).rejects.toThrow(/mutated the characterization workspace|no-write/i);
    expect(existsSync(outputPath)).toBe(false);
  }, 60_000);

  it.skipIf(!SCOPE.strong)("adversarial: refuses Pi ordinary-route replay no-write probes that create a new file", async () => {
    const layout = piProductionLayout("fixture-replay-write");
    const outputPath = join(layout.runner, "pi-replay-write.json");
    await expect(collectProductionContainedAdapterEvidence({
      adapterId: "pi",
      outputPath,
      commitSha: layout.commitSha,
      jobNonce: NONCE,
      repositoryRoot: layout.checkout,
      paidProbeAuthorized: true,
      characterizationRoot: layout.runner,
      environment: layout.source
    })).rejects.toThrow(/mutated the characterization workspace|no-write|ordinary availability replay/i);
    expect(existsSync(outputPath)).toBe(false);
  }, 60_000);

  it("Pi reviewer exact-path match accepts real-shaped args.path and rejects opaque/unrelated titles", () => {
    const workspaceRoot = "/tmp/rf-contained-pi-1.abc-xyz/workspace";
    const targetPath = `${workspaceRoot}/reviewer-target.txt`;
    // Absolute path from real-shaped Pi args.path succeeds.
    expect(piReviewerToolTitleMatchesTarget(targetPath, targetPath, workspaceRoot)).toBe(true);
    // Relative path resolves against the characterization workspace.
    expect(piReviewerToolTitleMatchesTarget("reviewer-target.txt", targetPath, workspaceRoot)).toBe(true);
    expect(piReviewerToolTitleMatchesTarget("./reviewer-target.txt", targetPath, workspaceRoot)).toBe(true);
    // Opaque IDs and missing titles never match, even when the ID embeds the basename.
    expect(piReviewerToolTitleMatchesTarget(undefined, targetPath, workspaceRoot)).toBe(false);
    expect(piReviewerToolTitleMatchesTarget("", targetPath, workspaceRoot)).toBe(false);
    expect(piReviewerToolTitleMatchesTarget("call_a1b2c3d4e5f60718", targetPath, workspaceRoot)).toBe(false);
    expect(piReviewerToolTitleMatchesTarget("reviewer-write-reviewer-target.txt-opaque", targetPath, workspaceRoot)).toBe(false);
    // Wrong basename / unrelated path fail closed.
    expect(piReviewerToolTitleMatchesTarget("something.txt", targetPath, workspaceRoot)).toBe(false);
    expect(piReviewerToolTitleMatchesTarget(".", targetPath, workspaceRoot)).toBe(false);
    expect(piReviewerToolTitleMatchesTarget(`${workspaceRoot}/other.txt`, targetPath, workspaceRoot)).toBe(false);
    expect(piReviewerToolTitleMatchesTarget("/etc/passwd", targetPath, workspaceRoot)).toBe(false);
  });

  it.skipIf(!SCOPE.strong)("refuses Pi synthetic unrelated reviewer tool failure without named-target correlation", async () => {
    const layout = piProductionLayout("fixture-reviewer-unrelated");
    const outputPath = join(layout.runner, "pi-reviewer-unrelated.json");
    await expect(collectProductionContainedAdapterEvidence({
      adapterId: "pi",
      outputPath,
      commitSha: layout.commitSha,
      jobNonce: NONCE,
      repositoryRoot: layout.checkout,
      paidProbeAuthorized: true,
      characterizationRoot: layout.runner,
      environment: layout.source
    })).rejects.toThrow(/correlated|lifecycle|named mutation|unavailable/i);
    expect(existsSync(outputPath)).toBe(false);
  }, 60_000);

  it.skipIf(!SCOPE.strong)("refuses Pi adversarial generic write reviewer events without exact target path", async () => {
    const layout = piProductionLayout("fixture-reviewer-generic-write");
    const outputPath = join(layout.runner, "pi-reviewer-generic-write.json");
    await expect(collectProductionContainedAdapterEvidence({
      adapterId: "pi",
      outputPath,
      commitSha: layout.commitSha,
      jobNonce: NONCE,
      repositoryRoot: layout.checkout,
      paidProbeAuthorized: true,
      characterizationRoot: layout.runner,
      environment: layout.source
    })).rejects.toThrow(/correlated|lifecycle|named mutation|unavailable/i);
    expect(existsSync(outputPath)).toBe(false);
  }, 60_000);

  it.skipIf(!SCOPE.strong)("refuses Pi opaque toolCallId reviewer failures that lack path-bearing args", async () => {
    const layout = piProductionLayout("fixture-reviewer-opaque-id");
    const outputPath = join(layout.runner, "pi-reviewer-opaque-id.json");
    await expect(collectProductionContainedAdapterEvidence({
      adapterId: "pi",
      outputPath,
      commitSha: layout.commitSha,
      jobNonce: NONCE,
      repositoryRoot: layout.checkout,
      paidProbeAuthorized: true,
      characterizationRoot: layout.runner,
      environment: layout.source
    })).rejects.toThrow(/correlated|lifecycle|named mutation|unavailable/i);
    expect(existsSync(outputPath)).toBe(false);
  }, 60_000);

  it.skipIf(!SCOPE.strong)("accepts Pi reviewer denial when real-shaped relative args.path resolves to the exact target", async () => {
    const layout = piProductionLayout("fixture-reviewer-relative-path");
    const outputPath = join(layout.runner, "pi-reviewer-relative-path.json");
    const beforeTemporaryRoots = new Set(
      readdirSync(layout.runner).filter((name) => name.startsWith(characterizationRootPrefix("pi")))
    );
    const collected = await collectProductionContainedAdapterEvidence({
      adapterId: "pi",
      outputPath,
      commitSha: layout.commitSha,
      jobNonce: NONCE,
      repositoryRoot: layout.checkout,
      paidProbeAuthorized: true,
      characterizationRoot: layout.runner,
      environment: layout.source,
      forbiddenSentinels: ["fixture-reviewer-relative-path"]
    });
    expect(collected.adapterId).toBe("pi");
    expect(collected.availability.status).toBe("available");
    expect(collected.checks.reviewerWriteDenied.evidenceSha256).toMatch(/^[a-f0-9]{64}$/u);
    const reread = readContainedAdapterEvidenceFile(outputPath, {
      adapterId: "pi",
      commitSha: layout.commitSha,
      jobNonce: NONCE,
      configurationSha256: containedAdapterProbeConfigurationSha256("pi", layout.source),
      now: new Date(collected.collectedAt),
      allowedRoot: layout.runner
    });
    expect(reread.receiptDigest).toBe(collected.receiptDigest);
    expect(reread.checks.reviewerWriteDenied.evidenceSha256).toBe(collected.checks.reviewerWriteDenied.evidenceSha256);
    expect(readdirSync(layout.runner).filter(
      (name) => name.startsWith(characterizationRootPrefix("pi")) && !beforeTemporaryRoots.has(name)
    )).toEqual([]);
  }, 60_000);

  it.skipIf(!SCOPE.strong)("refuses Pi empty successful terminals as prompt-roundtrip proof", async () => {
    const layout = piProductionLayout("fixture-empty-success");
    const outputPath = join(layout.runner, "pi-empty-success.json");
    await expect(collectProductionContainedAdapterEvidence({
      adapterId: "pi",
      outputPath,
      commitSha: layout.commitSha,
      jobNonce: NONCE,
      repositoryRoot: layout.checkout,
      paidProbeAuthorized: true,
      characterizationRoot: layout.runner,
      environment: layout.source
    })).rejects.toThrow(/assistant output|prompt-roundtrip|unproven/i);
    expect(existsSync(outputPath)).toBe(false);
  }, 60_000);

  it.skipIf(!SCOPE.strong)("refuses Pi when get_state is omitted", async () => {
    const layout = piProductionLayout("fixture-omit-state");
    const outputPath = join(layout.runner, "pi-omit-state.json");
    await expect(collectProductionContainedAdapterEvidence({
      adapterId: "pi",
      outputPath,
      commitSha: layout.commitSha,
      jobNonce: NONCE,
      repositoryRoot: layout.checkout,
      paidProbeAuthorized: true,
      characterizationRoot: layout.runner,
      environment: layout.source
    })).rejects.toBeInstanceOf(ContainedAdapterCharacterizationUnavailable);
    expect(existsSync(outputPath)).toBe(false);
  }, 60_000);

  it.skipIf(!SCOPE.strong)("refuses Pi when pre-turn get_session_stats is omitted", async () => {
    const layout = piProductionLayout("fixture-omit-stats");
    const outputPath = join(layout.runner, "pi-omit-stats.json");
    await expect(collectProductionContainedAdapterEvidence({
      adapterId: "pi",
      outputPath,
      commitSha: layout.commitSha,
      jobNonce: NONCE,
      repositoryRoot: layout.checkout,
      paidProbeAuthorized: true,
      characterizationRoot: layout.runner,
      environment: layout.source
    })).rejects.toBeInstanceOf(ContainedAdapterCharacterizationUnavailable);
    expect(existsSync(outputPath)).toBe(false);
  }, 60_000);

  it.skipIf(!SCOPE.strong)("refuses Pi version substitution outside the characterized range", async () => {
    const layout = piProductionLayout("fixture-wrong-version");
    const outputPath = join(layout.runner, "pi-wrong-version.json");
    await expect(collectProductionContainedAdapterEvidence({
      adapterId: "pi",
      outputPath,
      commitSha: layout.commitSha,
      jobNonce: NONCE,
      repositoryRoot: layout.checkout,
      paidProbeAuthorized: true,
      characterizationRoot: layout.runner,
      environment: layout.source
    })).rejects.toThrow(/version|characterized range|unavailable/i);
    expect(existsSync(outputPath)).toBe(false);
  }, 30_000);

  it("adversarial: Pi executable pin revalidation fails closed after version substitution", () => {
    const root = privateRoot();
    const executable = join(root, "pi");
    writeFileSync(executable, "#!/bin/sh\necho 0.84.1\n", { mode: 0o700 });
    const pin = pinContainedExecutable("pi", executable);
    for (const label of [
      "before version probe",
      "after version probe",
      "after worker prompt",
      "after reviewer denial",
      "after cancellation",
      "before availability derivation",
      "after ordinary replay",
      "before terminal evidence receipt",
      "after characterization authority",
      "after evidence receipt emission"
    ] as const) {
      expect(assertContainedExecutablePin(pin, label, "pi").identity).toBe(pin.evidence.identity);
    }
    writeFileSync(executable, "#!/bin/sh\necho TOCTOU\n", { mode: 0o700 });
    expect(() => assertContainedExecutablePin(pin, "before terminal evidence receipt", "pi")).toThrow(/substituted|unreadable/i);
  });

  it("refuses Pi state/statistics inference without a durable transcript", () => {
    expect(() => observeContainedPiStateAndStats({
      stateRequestId: "state-1",
      statisticsBeforeRequestId: "stats-1"
    })).toThrow(/durable transcript|state\/statistics|invent readiness/i);
  });

  it.skipIf(!SCOPE.strong)("removes private run state and emits nothing when OpenCode handshake fails", async () => {
    const layout = productionLayout("fixture-fail-handshake");
    const outputPath = join(layout.runner, "failed-production.json");
    const before = new Set(readdirSync(layout.runner).filter((name) => name.startsWith("rf-contained-opencode-")));
    await expect(collectProductionContainedAdapterEvidence({
      adapterId: "opencode",
      outputPath,
      commitSha: layout.commitSha,
      jobNonce: NONCE,
      repositoryRoot: layout.checkout,
      paidProbeAuthorized: true,
      characterizationRoot: layout.runner,
      environment: layout.source,
      forbiddenSentinels: ["fixture-fail-handshake"]
    })).rejects.toBeInstanceOf(ContainedAdapterCharacterizationUnavailable);
    expect(existsSync(outputPath)).toBe(false);
    expect(readdirSync(layout.runner).filter(
      (name) => name.startsWith("rf-contained-opencode-") && !before.has(name)
    )).toEqual([]);
  }, 30_000);

  it.skipIf(!SCOPE.strong)("refuses worker no-write probes that create a new file", async () => {
    const layout = productionLayout("fixture-worker-write-new");
    const outputPath = join(layout.runner, "worker-write.json");
    await expect(collectProductionContainedAdapterEvidence({
      adapterId: "opencode",
      outputPath,
      commitSha: layout.commitSha,
      jobNonce: NONCE,
      repositoryRoot: layout.checkout,
      paidProbeAuthorized: true,
      characterizationRoot: layout.runner,
      environment: layout.source
    })).rejects.toThrow(/mutated the characterization workspace|no-write/i);
    expect(existsSync(outputPath)).toBe(false);
  }, 60_000);

  it.skipIf(!SCOPE.strong)("refuses worker no-write probes that mutate an existing file", async () => {
    const layout = productionLayout("fixture-worker-mutate");
    const outputPath = join(layout.runner, "worker-mutate.json");
    await expect(collectProductionContainedAdapterEvidence({
      adapterId: "opencode",
      outputPath,
      commitSha: layout.commitSha,
      jobNonce: NONCE,
      repositoryRoot: layout.checkout,
      paidProbeAuthorized: true,
      characterizationRoot: layout.runner,
      environment: layout.source
    })).rejects.toThrow(/mutated the characterization workspace|no-write/i);
    expect(existsSync(outputPath)).toBe(false);
  }, 60_000);

  it.skipIf(!SCOPE.strong)("adversarial: refuses ordinary-route replay no-write probes that create a new file", async () => {
    const layout = productionLayout("fixture-replay-write");
    const outputPath = join(layout.runner, "replay-write.json");
    await expect(collectProductionContainedAdapterEvidence({
      adapterId: "opencode",
      outputPath,
      commitSha: layout.commitSha,
      jobNonce: NONCE,
      repositoryRoot: layout.checkout,
      paidProbeAuthorized: true,
      characterizationRoot: layout.runner,
      environment: layout.source
    })).rejects.toThrow(/mutated the characterization workspace|no-write|ordinary availability replay/i);
    expect(existsSync(outputPath)).toBe(false);
  }, 60_000);

  it.skipIf(!SCOPE.strong)("refuses synthetic unrelated reviewer permission without named-target correlation", async () => {
    const layout = productionLayout("fixture-reviewer-unrelated");
    const outputPath = join(layout.runner, "reviewer-unrelated.json");
    await expect(collectProductionContainedAdapterEvidence({
      adapterId: "opencode",
      outputPath,
      commitSha: layout.commitSha,
      jobNonce: NONCE,
      repositoryRoot: layout.checkout,
      paidProbeAuthorized: true,
      characterizationRoot: layout.runner,
      environment: layout.source
    })).rejects.toThrow(/correlated|lifecycle|named mutation|unavailable/i);
    expect(existsSync(outputPath)).toBe(false);
  }, 60_000);

  it.skipIf(!SCOPE.strong)("refuses adversarial generic 'write file' reviewer events without target basename", async () => {
    const layout = productionLayout("fixture-reviewer-generic-write");
    const outputPath = join(layout.runner, "reviewer-generic-write.json");
    await expect(collectProductionContainedAdapterEvidence({
      adapterId: "opencode",
      outputPath,
      commitSha: layout.commitSha,
      jobNonce: NONCE,
      repositoryRoot: layout.checkout,
      paidProbeAuthorized: true,
      characterizationRoot: layout.runner,
      environment: layout.source
    })).rejects.toThrow(/correlated|lifecycle|named mutation|unavailable/i);
    expect(existsSync(outputPath)).toBe(false);
  }, 60_000);

  it.skipIf(!SCOPE.strong)("refuses empty successful terminals as prompt-roundtrip proof", async () => {
    const layout = productionLayout("fixture-empty-success");
    const outputPath = join(layout.runner, "empty-success.json");
    await expect(collectProductionContainedAdapterEvidence({
      adapterId: "opencode",
      outputPath,
      commitSha: layout.commitSha,
      jobNonce: NONCE,
      repositoryRoot: layout.checkout,
      paidProbeAuthorized: true,
      characterizationRoot: layout.runner,
      environment: layout.source
    })).rejects.toThrow(/assistant output|prompt-roundtrip|unproven/i);
    expect(existsSync(outputPath)).toBe(false);
  }, 60_000);

  it.skipIf(!SCOPE.strong)("refuses when session/new is omitted (session-create never observed)", async () => {
    const layout = productionLayout("fixture-omit-session-create");
    const outputPath = join(layout.runner, "omit-session.json");
    await expect(collectProductionContainedAdapterEvidence({
      adapterId: "opencode",
      outputPath,
      commitSha: layout.commitSha,
      jobNonce: NONCE,
      repositoryRoot: layout.checkout,
      paidProbeAuthorized: true,
      characterizationRoot: layout.runner,
      environment: layout.source
    })).rejects.toBeInstanceOf(ContainedAdapterCharacterizationUnavailable);
    expect(existsSync(outputPath)).toBe(false);
  }, 60_000);

  it("rejects post-version executable substitution", () => {
    const root = privateRoot();
    const executable = join(root, "opencode");
    writeFileSync(executable, "#!/bin/sh\necho 1.18.15\n", { mode: 0o700 });
    const pin = pinContainedExecutable("opencode", executable);
    writeFileSync(executable, "#!/bin/sh\necho substituted\n", { mode: 0o700 });
    expect(() => assertContainedExecutablePin(pin, "after version probe")).toThrow(/substituted/i);
  });

  it("adversarial: pin revalidation fails closed after every labeled characterization stage", () => {
    const root = privateRoot();
    const executable = join(root, "opencode");
    writeFileSync(executable, "#!/bin/sh\necho 1.18.15\n", { mode: 0o700 });
    const pin = pinContainedExecutable("opencode", executable);
    // Same pin must revalidate across the production labels.
    for (const label of [
      "before version probe",
      "after version probe",
      "after worker prompt",
      "after reviewer denial",
      "after cancellation",
      "before availability derivation",
      "after ordinary replay",
      "before terminal evidence receipt",
      "after characterization authority",
      "after evidence receipt emission"
    ] as const) {
      expect(assertContainedExecutablePin(pin, label).identity).toBe(pin.evidence.identity);
    }
    writeFileSync(executable, "#!/bin/sh\necho TOCTOU\n", { mode: 0o700 });
    expect(() => assertContainedExecutablePin(pin, "before terminal evidence receipt")).toThrow(/substituted|unreadable/i);
  });

  it("rejects non-Git, dirty, and wrong-HEAD repository pins", () => {
    const nonGit = privateRoot();
    expect(() => pinContainedEvidenceRepository(nonGit, "a".repeat(40))).toThrow(/not a Git|git/i);

    const dirty = privateRoot();
    const commitSha = initCleanGitRepo(dirty);
    writeFileSync(join(dirty, "dirt.txt"), "dirty\n", { mode: 0o600 });
    expect(() => pinContainedEvidenceRepository(dirty, commitSha)).toThrow(/clean/i);

    const wrong = privateRoot();
    initCleanGitRepo(wrong);
    expect(() => pinContainedEvidenceRepository(wrong, "a".repeat(40))).toThrow(/does not equal|commitSha/i);
  });

  it("exports exact workspace inventory ceilings", () => {
    expect(CONTAINED_WORKSPACE_MAX_DEPTH).toBe(32);
    expect(CONTAINED_WORKSPACE_MAX_ENTRIES).toBe(4_096);
    expect(CONTAINED_WORKSPACE_MAX_FILE_BYTES).toBe(1_048_576);
    expect(CONTAINED_WORKSPACE_MAX_AGGREGATE_BYTES).toBe(16_777_216);
    expect(CONTAINED_WORKSPACE_MAX_RELATIVE_PATH_BYTES).toBe(1_024);
  });

  it("snapshots clean fixture workspaces with directories and deterministic canonical comparison", () => {
    const root = privateRoot();
    initCleanGitRepo(root);
    mkdirSync(join(root, "empty-dir"), { mode: 0o700 });
    mkdirSync(join(root, "nested"), { mode: 0o700 });
    writeFileSync(join(root, "nested", "note.txt"), "nested\n", { mode: 0o600 });
    const first = snapshotContainedWorkspace(root);
    const second = snapshotContainedWorkspace(root);
    expect(canonicalContainedAdapterEvidenceJson(first)).toBe(canonicalContainedAdapterEvidenceJson(second));
    expect(first.entries.some((entry) => entry.kind === "directory" && entry.relativePath === "empty-dir")).toBe(true);
    expect(first.entries.some((entry) => entry.kind === "file" && entry.relativePath === "TRACKED.md" && entry.sha256)).toBe(true);
    // Root .git is skipped; nested inventory still includes ordinary paths.
    expect(first.entries.some((entry) => entry.relativePath === ".git" || entry.relativePath.startsWith(".git/"))).toBe(false);
  });

  it("detects empty-directory and mode mutations", () => {
    const root = privateRoot();
    initCleanGitRepo(root);
    mkdirSync(join(root, "empty-dir"), { mode: 0o700 });
    const baseline = snapshotContainedWorkspace(root);
    writeFileSync(join(root, "empty-dir", "appeared.txt"), "x\n", { mode: 0o600 });
    expect(canonicalContainedAdapterEvidenceJson(snapshotContainedWorkspace(root)))
      .not.toBe(canonicalContainedAdapterEvidenceJson(baseline));
    rmSync(join(root, "empty-dir", "appeared.txt"));
    chmodSync(join(root, "empty-dir"), 0o755);
    expect(canonicalContainedAdapterEvidenceJson(snapshotContainedWorkspace(root)))
      .not.toBe(canonicalContainedAdapterEvidenceJson(baseline));
  });

  it("does not skip nested .git paths (only the fixture repository root .git)", () => {
    const root = privateRoot();
    initCleanGitRepo(root);
    mkdirSync(join(root, "vendor", ".git"), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, "vendor", ".git", "HEAD"), "ref: refs/heads/main\n", { mode: 0o600 });
    const snap = snapshotContainedWorkspace(root);
    expect(snap.entries.some((entry) => entry.relativePath === "vendor/.git")).toBe(true);
    expect(snap.entries.some((entry) => entry.relativePath === "vendor/.git/HEAD")).toBe(true);
  });

  it("refuses symlinks, FIFOs, and hardlinks that weaken identity", () => {
    const root = privateRoot();
    initCleanGitRepo(root);
    writeFileSync(join(root, "target.txt"), "t\n", { mode: 0o600 });
    symlinkSync("target.txt", join(root, "link.txt"));
    expect(() => snapshotContainedWorkspace(root)).toThrow(/symlink/i);
    rmSync(join(root, "link.txt"));

    const fifoRoot = privateRoot();
    initCleanGitRepo(fifoRoot);
    const fifo = spawnSync("mkfifo", [join(fifoRoot, "pipe.fifo")], { encoding: "utf8" });
    if (fifo.status === 0) {
      expect(() => snapshotContainedWorkspace(fifoRoot)).toThrow(/FIFO|special|unknown|refused/i);
    }

    const hardRoot = privateRoot();
    initCleanGitRepo(hardRoot);
    writeFileSync(join(hardRoot, "a.txt"), "shared\n", { mode: 0o600 });
    let hardlinked = false;
    try {
      linkSync(join(hardRoot, "a.txt"), join(hardRoot, "b.txt"));
      hardlinked = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "ENOSYS" && code !== "EOPNOTSUPP") throw error;
    }
    if (hardlinked) {
      expect(() => snapshotContainedWorkspace(hardRoot)).toThrow(/hardlink/i);
    }
  });

  it("enforces exact and +1 inventory caps for depth, entries, file size, aggregate, and path bytes", () => {
    // Depth: exactly max depth of directories is accepted; one deeper refuses.
    const depthRoot = privateRoot();
    initCleanGitRepo(depthRoot);
    let cursor = depthRoot;
    for (let depth = 1; depth <= CONTAINED_WORKSPACE_MAX_DEPTH; depth += 1) {
      cursor = join(cursor, `d${depth}`);
      mkdirSync(cursor, { mode: 0o700 });
    }
    expect(() => snapshotContainedWorkspace(depthRoot)).not.toThrow();
    mkdirSync(join(cursor, "too-deep"), { mode: 0o700 });
    expect(() => snapshotContainedWorkspace(depthRoot)).toThrow(new RegExp(`depth exceeds ${CONTAINED_WORKSPACE_MAX_DEPTH}`));

    // Entries: max entries accepted; +1 refused. Root TRACKED.md + .git skipped → fill to limit.
    const entryRoot = privateRoot();
    initCleanGitRepo(entryRoot);
    // TRACKED.md is 1 file entry. Fill remaining with files under files/.
    mkdirSync(join(entryRoot, "files"), { mode: 0o700 });
    // entries so far after fill: directory "files" + TRACKED.md + N files
    const already = 2; // TRACKED.md + files/
    for (let index = 0; index < CONTAINED_WORKSPACE_MAX_ENTRIES - already; index += 1) {
      writeFileSync(join(entryRoot, "files", `f${index}.txt`), "x", { mode: 0o600 });
    }
    expect(() => snapshotContainedWorkspace(entryRoot)).not.toThrow();
    writeFileSync(join(entryRoot, "files", "overflow.txt"), "y", { mode: 0o600 });
    expect(() => snapshotContainedWorkspace(entryRoot)).toThrow(new RegExp(`entry count exceeds ${CONTAINED_WORKSPACE_MAX_ENTRIES}`));

    // Individual file size: exact max accepted, +1 refused.
    const fileRoot = privateRoot();
    initCleanGitRepo(fileRoot);
    writeFileSync(join(fileRoot, "exact.bin"), Buffer.alloc(CONTAINED_WORKSPACE_MAX_FILE_BYTES, 1), { mode: 0o600 });
    expect(() => snapshotContainedWorkspace(fileRoot)).not.toThrow();
    writeFileSync(join(fileRoot, "exact.bin"), Buffer.alloc(CONTAINED_WORKSPACE_MAX_FILE_BYTES + 1, 1), { mode: 0o600 });
    expect(() => snapshotContainedWorkspace(fileRoot)).toThrow(new RegExp(`${CONTAINED_WORKSPACE_MAX_FILE_BYTES}`));

    // Aggregate: keep individual files under the per-file cap but exceed aggregate by 1.
    const aggRoot = privateRoot();
    initCleanGitRepo(aggRoot);
    const chunk = CONTAINED_WORKSPACE_MAX_FILE_BYTES;
    const trackedBytes = Buffer.byteLength("clean checkout\n", "utf8");
    let written = trackedBytes;
    let fileIndex = 0;
    while (written + chunk <= CONTAINED_WORKSPACE_MAX_AGGREGATE_BYTES) {
      writeFileSync(join(aggRoot, `chunk-${fileIndex}.bin`), Buffer.alloc(chunk, 2), { mode: 0o600 });
      written += chunk;
      fileIndex += 1;
    }
    const remain = CONTAINED_WORKSPACE_MAX_AGGREGATE_BYTES - written;
    if (remain > 0) {
      writeFileSync(join(aggRoot, `chunk-rem.bin`), Buffer.alloc(remain, 3), { mode: 0o600 });
      written += remain;
    }
    expect(written).toBe(CONTAINED_WORKSPACE_MAX_AGGREGATE_BYTES);
    expect(() => snapshotContainedWorkspace(aggRoot)).not.toThrow();
    writeFileSync(join(aggRoot, "overflow-agg.bin"), Buffer.alloc(1, 4), { mode: 0o600 });
    expect(() => snapshotContainedWorkspace(aggRoot)).toThrow(new RegExp(`${CONTAINED_WORKSPACE_MAX_AGGREGATE_BYTES}`));

    // Relative path bytes: short segments so absolute paths stay under PATH_MAX/NAME_MAX.
    const pathRoot = privateRoot();
    initCleanGitRepo(pathRoot);
    const segment = "p".repeat(32);
    let pathCursor = pathRoot;
    let relative = "";
    while (Buffer.byteLength(relative === "" ? segment : `${relative}/${segment}`, "utf8") < CONTAINED_WORKSPACE_MAX_RELATIVE_PATH_BYTES - 40) {
      relative = relative === "" ? segment : `${relative}/${segment}`;
      pathCursor = join(pathCursor, segment);
      mkdirSync(pathCursor, { mode: 0o700 });
    }
    const remaining = CONTAINED_WORKSPACE_MAX_RELATIVE_PATH_BYTES - Buffer.byteLength(relative, "utf8") - 1;
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(255);
    const exactLeaf = "e".repeat(remaining);
    writeFileSync(join(pathCursor, exactLeaf), "ok\n", { mode: 0o600 });
    expect(Buffer.byteLength(`${relative}/${exactLeaf}`, "utf8")).toBe(CONTAINED_WORKSPACE_MAX_RELATIVE_PATH_BYTES);
    expect(() => snapshotContainedWorkspace(pathRoot)).not.toThrow();
    rmSync(join(pathCursor, exactLeaf));
    // +1 over the relative-path cap (still within NAME_MAX when remaining+1 <= 255).
    const overLeaf = "e".repeat(remaining + 1);
    writeFileSync(join(pathCursor, overLeaf), "bad\n", { mode: 0o600 });
    expect(() => snapshotContainedWorkspace(pathRoot)).toThrow(new RegExp(`${CONTAINED_WORKSPACE_MAX_RELATIVE_PATH_BYTES}`));
  }, 120_000);

  it("refuses session-create inference from ACP reservation grammar alone", () => {
    expect(() => observeContainedOpenCodeSessionCreate({
      events: [],
      // No durable transcript and no normalized session-created event.
      newSessionRequestId: "reserved-session-id"
    })).toThrow(/session-create was not observed|reservation grammar/i);

    // Normalized session-created event is accepted.
    const observed = observeContainedOpenCodeSessionCreate({
      events: [{
        kind: "session",
        sessionId: "sess-1",
        state: "created",
        frame: { sha256: "a".repeat(64), index: 0, offset: 0, bytes: 1, terminated: true }
      }]
    });
    expect(observed).toMatchObject({ sessionId: "sess-1", source: "normalized-event" });
  });

  it("reconciles exact dead-owner characterization remnants under the private parent", () => {
    const root = privateRoot();
    // Legacy unmarked remnant without owner encoding is reclaimed.
    const remnant = join(root, `${CHARACTERIZATION_ROOT_PREFIX}dead`);
    mkdirSync(remnant, { mode: 0o700 });
    writeFileSync(join(remnant, "stale.txt"), "stale\n", { mode: 0o600 });
    const removed = reconcileDeadCharacterizationRoots(root);
    expect(removed).toContain(remnant);
    expect(existsSync(remnant)).toBe(false);

    // Marked dead owner is reclaimed.
    const marked = join(root, `${CHARACTERIZATION_ROOT_PREFIX}1.0-deadmark`);
    mkdirSync(marked, { mode: 0o700 });
    writeFileSync(join(marked, CHARACTERIZATION_OWNER_MARKER), "1:0\n", { mode: 0o600 });
    expect(reconcileDeadCharacterizationRoots(root)).toContain(marked);
    expect(existsSync(marked)).toBe(false);
  });

  it("preserves a live unmarked allocation and reclaims a dead named remnant (F5)", () => {
    const root = privateRoot();
    let ownerToken: string;
    try {
      const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const fields = close >= 0 ? stat.slice(close + 2).split(/\s+/u) : [];
      ownerToken = `${process.pid}:${fields[19] ?? "0"}`;
    } catch {
      ownerToken = `${process.pid}:0`;
    }
    expect(isCharacterizationOwnerAlive(ownerToken)).toBe(true);
    const liveName = `${characterizationDirectoryPrefix(ownerToken)}unmarked`;
    const live = join(root, liveName);
    mkdirSync(live, { mode: 0o700 });
    writeFileSync(join(live, "payload.txt"), "live\n", { mode: 0o600 });
    // No owner marker — concurrent reconciler must still preserve live owner from the directory name.
    expect(reconcileDeadCharacterizationRoots(root)).not.toContain(live);
    expect(existsSync(live)).toBe(true);

    // Dead owner encoded in name, unmarked — reclaimed.
    const deadName = `${CHARACTERIZATION_ROOT_PREFIX}1.0-deadunmarked`;
    const dead = join(root, deadName);
    mkdirSync(dead, { mode: 0o700 });
    expect(parseCharacterizationDirectoryOwner(deadName)).toBe("1:0");
    expect(isCharacterizationOwnerAlive("1:0")).toBe(false);
    expect(reconcileDeadCharacterizationRoots(root)).toContain(dead);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });

  it("allocation installs an O_EXCL marker and survives concurrent reconciliation during the pre-marker seam", () => {
    const root = privateRoot();
    let sawSeam = false;
    const allocated = allocateContainedCharacterizationRoot(root, {
      afterDirectoryBeforeMarker: (directory, ownerToken) => {
        sawSeam = true;
        expect(existsSync(join(directory, CHARACTERIZATION_OWNER_MARKER))).toBe(false);
        expect(isCharacterizationOwnerAlive(ownerToken)).toBe(true);
        // Same-process concurrent reconciler must not delete the live unmarked allocation.
        const removed = reconcileDeadCharacterizationRoots(root);
        expect(removed).not.toContain(directory);
        expect(existsSync(directory)).toBe(true);
        // Separate child process reconciler (two-process characterization of the race window).
        const distModule = join(process.cwd(), "dist/adapters/contained-evidence-production.js");
        if (existsSync(distModule)) {
          const childScript = join(root, "reconcile-child.mjs");
          writeFileSync(childScript, `
            import { reconcileDeadCharacterizationRoots } from ${JSON.stringify(distModule)};
            const removed = reconcileDeadCharacterizationRoots(${JSON.stringify(root)});
            process.stdout.write(JSON.stringify(removed));
          `, { mode: 0o600 });
          const child = spawnSync(process.execPath, [childScript], {
            encoding: "utf8",
            cwd: process.cwd(),
            env: process.env
          });
          expect(child.status, child.stderr).toBe(0);
          const childRemoved = JSON.parse(child.stdout || "[]") as string[];
          expect(childRemoved).not.toContain(directory);
          expect(existsSync(directory)).toBe(true);
        }
      }
    });
    expect(sawSeam).toBe(true);
    expect(existsSync(join(allocated, CHARACTERIZATION_OWNER_MARKER))).toBe(true);
    expect(readdirSync(root).some((name) => name.startsWith(CHARACTERIZATION_ROOT_PREFIX))).toBe(true);
    // Dead remnant still reclaimed after live allocation is marked.
    const dead = join(root, `${CHARACTERIZATION_ROOT_PREFIX}9.9-stale`);
    mkdirSync(dead, { mode: 0o700 });
    expect(reconcileDeadCharacterizationRoots(root)).toContain(dead);
    expect(existsSync(allocated)).toBe(true);
    rmSync(allocated, { recursive: true, force: true });
  });

  it("refuses paid characterization without explicit authorization", async () => {
    const root = privateRoot();
    const commitSha = initCleanGitRepo(root);
    await expect(collectProductionContainedAdapterEvidence({
      adapterId: "opencode",
      outputPath: join(root, "unauth.json"),
      commitSha,
      jobNonce: NONCE,
      repositoryRoot: root,
      // @ts-expect-error intentional missing authorization
      paidProbeAuthorized: false,
      characterizationRoot: root,
      environment: { PATH: root, OPENAI_API_KEY: "x" }
    })).rejects.toThrow(/paidProbeAuthorized|authorization/i);
  });

  it("keeps the checked-in entrypoint narrow and out of GitHub persistence channels", () => {
    const source = readFileSync(new URL("../scripts/collect-contained-adapter-evidence.mjs", import.meta.url), "utf8");
    expect(source).toContain("collectProductionContainedAdapterEvidence");
    expect(source).toContain("--commit-sha");
    expect(source).toContain("--job-nonce");
    expect(source).toContain("--authorize-paid-probe");
    expect(source).toContain("RUNNER_TEMP");
    expect(source).toContain("paidProbeAuthorized: true");
    expect(source).not.toMatch(/GITHUB_ENV|GITHUB_OUTPUT|upload-artifact|save-state/u);
    expect(source).not.toMatch(/\bspawn(?:Sync)?\s*\(|\bexecFile(?:Sync)?\s*\(\s*[^"']*(?:opencode|pi|grok)/u);
  });

  it.each(["opencode", "pi", "grok"] as const)("writes one canonical private %s receipt and re-reads it", async (adapterId) => {
    const root = privateRoot();
    const outputPath = join(root, `${adapterId}.json`);
    const value = proof(adapterId, root);
    const collected = await collectContainedAdapterEvidence({
      adapterId,
      outputPath,
      commitSha: "a".repeat(40),
      jobNonce: NONCE,
      authority: { collect: async () => value },
      forbiddenSentinels: ["SENTINEL-secret-prompt-or-token"],
      now: NOW
    });
    expect(statSync(outputPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(outputPath, "utf8")).not.toContain("SENTINEL-secret-prompt-or-token");
    expect(readContainedAdapterEvidenceFile(outputPath, {
      adapterId,
      commitSha: "a".repeat(40),
      jobNonce: NONCE,
      configurationSha256: containedAdapterProbeConfigurationSha256(adapterId),
      now: NOW,
      allowedRoot: root
    })).toEqual(collected);
  });

  it("leaves no file when production authority, schema, or runtime revalidation fails", async () => {
    const root = privateRoot();
    const failedAuthority = join(root, "authority.json");
    await expect(collectContainedAdapterEvidence({
      adapterId: "opencode",
      outputPath: failedAuthority,
      commitSha: "a".repeat(40),
      jobNonce: NONCE,
      authority: { collect: async () => { throw new Error("transport failed"); } },
      now: NOW
    })).rejects.toThrow(/transport failed/);
    expect(existsSync(failedAuthority)).toBe(false);

    const malformed = proof("opencode", root);
    const malformedPath = join(root, "malformed.json");
    await expect(collectContainedAdapterEvidence({
      adapterId: "opencode",
      outputPath: malformedPath,
      commitSha: "a".repeat(40),
      jobNonce: NONCE,
      authority: { collect: async () => ({ ...malformed, settlement: { ...malformed.settlement, terminal: false as true } }) },
      now: NOW
    })).rejects.toThrow(/terminal/u);
    expect(existsSync(malformedPath)).toBe(false);

    const replaced = proof("opencode", root);
    const replacedPath = join(root, "replaced.json");
    await expect(collectContainedAdapterEvidence({
      adapterId: "opencode",
      outputPath: replacedPath,
      commitSha: "a".repeat(40),
      jobNonce: NONCE,
      authority: {
        collect: async () => {
          writeFileSync(replaced.availability.executable.canonicalPath, "#!/bin/sh\nexit 3\n", { mode: 0o700 });
          return replaced;
        }
      },
      now: NOW
    })).rejects.toThrow(/changed/u);
    expect(existsSync(replacedPath)).toBe(false);
  });

  it("never overwrites an existing output", async () => {
    const root = privateRoot();
    const outputPath = join(root, "existing.json");
    writeFileSync(outputPath, "operator-owned\n", { mode: 0o600 });
    const value = proof("opencode", root);
    await expect(collectContainedAdapterEvidence({
      adapterId: "opencode",
      outputPath,
      commitSha: "a".repeat(40),
      jobNonce: NONCE,
      authority: { collect: async () => value },
      now: NOW
    })).rejects.toThrow();
    expect(readFileSync(outputPath, "utf8")).toBe("operator-owned\n");
  });

  it("refuses secret or prompt sentinel disclosure before creating a file", async () => {
    const root = privateRoot();
    const outputPath = join(root, "secret.json");
    const value = proof("opencode", root);
    const leaked = {
      ...value,
      availability: {
        ...value.availability,
        capabilities: {
          ...value.availability.capabilities,
          steering: { status: "unknown", reason: "not-probed", detail: "credential-SENTINEL-123" }
        }
      }
    } as ContainedAdapterProbeResult;
    await expect(collectContainedAdapterEvidence({
      adapterId: "opencode",
      outputPath,
      commitSha: "a".repeat(40),
      jobNonce: NONCE,
      authority: { collect: async () => leaked },
      forbiddenSentinels: ["credential-SENTINEL-123"],
      now: NOW
    })).rejects.toThrow(/sentinel/u);
    expect(existsSync(outputPath)).toBe(false);
  });

  it("captures collectedAt after a slow authority so the receipt is not already expired", async () => {
    const root = privateRoot();
    const outputPath = join(root, "slow.json");
    const value = proof("opencode", root);
    const started = Date.now();
    const collected = await collectContainedAdapterEvidence({
      adapterId: "opencode",
      outputPath,
      commitSha: "a".repeat(40),
      jobNonce: NONCE,
      authority: {
        collect: async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return value;
        }
      }
    });
    const collectedMs = Date.parse(collected.collectedAt);
    expect(collectedMs).toBeGreaterThanOrEqual(started + 40);
    expect(Date.parse(collected.expiresAt) - collectedMs).toBe(5 * 60 * 1_000);
  });
});

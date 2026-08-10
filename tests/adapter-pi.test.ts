import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { BoundedJsonlFramer, type CodecFrame, type NormalizedAdapterEvent } from "../src/adapters/codec.js";
import {
  PI_RPC_WIRE_VERSION,
  PiCancelStateMachine,
  PiRpcTurnCodec,
  decodePiSessionStatsResponse,
  decodePiStateResponse,
  derivePiTurnUsage,
  serializePiGetSessionStats,
  serializePiGetState,
  serializePiPrompt
} from "../src/adapters/pi-rpc.js";
import {
  PI_AUDITED_VERSION,
  PI_REVIEWER_HELPER_RUNTIME,
  PI_REVIEWER_TOOLS,
  PI_WORKER_TOOLS,
  buildPiInvocationArguments,
  evaluatePiProbe,
  piAdapterDescriptor,
  type PiProbeObservation
} from "../src/adapters/builtins/pi.js";
import { evaluateAdapterRole } from "../src/adapters/registry.js";
import {
  containedAdapterProbeConfigurationSha256,
  readContainedAdapterEvidenceFile
} from "../src/adapters/contained-evidence.js";
import {
  PI_ADAPTER_SUCCESS_RECORDS,
  PI_PROBE_END_STATS_RESPONSE,
  PI_PROBE_GENERATION,
  PI_PROBE_SESSION,
  PI_PROBE_START_STATS_RESPONSE,
  PI_PROBE_STATE_RESPONSE,
  piAdapterTranscript
} from "./fixtures/adapters/pi/probe.js";

function frame(record: Readonly<Record<string, unknown>>, index = 0, offset = 0): CodecFrame {
  return { raw: Buffer.from(JSON.stringify(record)), index, offset, terminated: true };
}

function decodedProbe() {
  const state = decodePiStateResponse(frame(PI_PROBE_STATE_RESPONSE), "state-probe-1");
  const statistics = decodePiSessionStatsResponse(
    frame(PI_PROBE_START_STATS_RESPONSE),
    "stats-start-1",
    PI_PROBE_SESSION,
    PI_PROBE_GENERATION
  );
  if (state.status === "invalid" || statistics.status === "invalid") throw new Error("invalid test probe fixture");
  return { state, statistics };
}

const SHA = "c".repeat(64);
const CONFIG_SHA = "d".repeat(64);
const PROBED_AT = "2026-08-09T00:00:00.000Z";

function completeProbe(overrides: Partial<PiProbeObservation> = {}): PiProbeObservation {
  const decoded = decodedProbe();
  const behavioralEvidenceSha256 = Object.fromEntries(
    piAdapterDescriptor.compatibility.behavioralProbe.requiredChecks.map((check) => [check, SHA])
  );
  behavioralEvidenceSha256["state-query"] = decoded.state.frame.sha256;
  behavioralEvidenceSha256["statistics-query"] = decoded.statistics.frame.sha256;
  return {
    executable: {
      canonicalPath: "/usr/local/bin/pi",
      identity: "dev:1:ino:3:sha256:pi",
      version: PI_AUDITED_VERSION
    },
    reviewerHelper: {
      canonicalPath: "/package/assets/pi-relayforge-reviewer.mjs",
      identity: "sha256:reviewer-helper"
    },
    wireVersion: PI_RPC_WIRE_VERSION,
    state: { value: decoded.state.value, frameSha256: decoded.state.frame.sha256 },
    statistics: decoded.statistics.value,
    behavioralEvidenceSha256,
    capabilities: {
      modelDiscovery: true,
      sessionCreate: true,
      sessionResume: true,
      streaming: true,
      cancellation: true,
      usage: true,
      cost: true,
      context: true,
      steering: true,
      innerReadOnly: true
    },
    probedAt: PROBED_AT,
    consultedConfigSha256: CONFIG_SHA,
    ...overrides
  };
}

function runTurn(records: readonly Readonly<Record<string, unknown>>[]) {
  const events: NormalizedAdapterEvent[] = [];
  const codec = new PiRpcTurnCodec({
    promptRequestId: "prompt-adapter-1",
    sessionId: PI_PROBE_SESSION,
    onEvent: (event) => events.push(event)
  });
  const framer = new BoundedJsonlFramer((accepted) => codec.push(accepted), {
    maxFrameBytes: 64 * 1024,
    maxTotalBytes: 1024 * 1024,
    maxFrames: 1024
  });
  const transcript = piAdapterTranscript(records);
  for (let offset = 0; offset < transcript.length; offset += 5) {
    framer.push(transcript.subarray(offset, Math.min(transcript.length, offset + 5)));
  }
  framer.finish();
  return { events, result: codec.finish(), fatal: framer.fatal() };
}

function assertDeepFrozenData(value: unknown, seen = new Set<unknown>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value as Record<string, unknown>)) {
    expect(typeof child).not.toBe("function");
    assertDeepFrozenData(child, seen);
  }
}

describe("Pi native RPC descriptor and invocation policy", () => {
  it("is immutable/data-only and binds exact Pi 0.84.1 RPC identities", () => {
    expect(piAdapterDescriptor).toMatchObject({
      id: "pi",
      providerId: "pi",
      transportKind: "rpc-jsonl",
      runtimeIdentity: {
        executable: "pi",
        trustedHelpers: [PI_REVIEWER_HELPER_RUNTIME],
        resolution: "canonical-installed-only"
      },
      compatibility: {
        executableVersion: { minInclusive: "0.84.1", maxExclusive: "0.84.2" },
        wireVersions: ["pi-rpc-v1"]
      },
      invocationPolicy: {
        promptTransport: "stdin-jsonl",
        systemPromptChannel: "separate"
      },
      codec: { id: "pi-rpc-jsonl", version: 1 },
      normalizer: { id: "pi-rpc-v1-0.84.1", version: 1 }
    });
    expect(piAdapterDescriptor.capabilityPolicy["rate-limits"]).toBe("unsupported");
    expect(piAdapterDescriptor.capabilityPolicy.attachments).toBe("unsupported");
    expect(piAdapterDescriptor.roles.reviewer).toMatchObject({
      outerSandbox: "required",
      filesystem: "read-only",
      innerReadOnly: "required"
    });
    assertDeepFrozenData(piAdapterDescriptor);
  });

  it("emits exact ambient-isolation and role-tool arguments with no task/prompt bytes", () => {
    const common = [
      "--mode",
      "rpc",
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--session-dir",
      "/scope/session"
    ];
    const worker = buildPiInvocationArguments({ role: "worker", sessionDirectory: "/scope/session", model: "provider/model" });
    expect(worker).toEqual([...common, "--tools", "read,bash,edit,write", "--model", "provider/model"]);
    expect(PI_WORKER_TOOLS).toEqual(["read", "bash", "edit", "write"]);
    expect(Object.isFrozen(worker)).toBe(true);

    const reviewer = buildPiInvocationArguments({
      role: "reviewer",
      sessionDirectory: "/scope/session",
      reviewerHelperPath: "/package/assets/pi-relayforge-reviewer.mjs"
    });
    expect(reviewer).toEqual([
      ...common,
      "--extension",
      "/package/assets/pi-relayforge-reviewer.mjs",
      "--tools",
      "relayforge_read,relayforge_list"
    ]);
    expect(PI_REVIEWER_TOOLS).toEqual(["relayforge_read", "relayforge_list"]);
    expect(reviewer.join("\n")).not.toContain("task payload");
    expect(reviewer.join("\n")).not.toContain("system prompt");
  });

  it("rejects relative/missing paths, NULs, unknown roles, and unbounded models", () => {
    for (const action of [
      () => buildPiInvocationArguments({ role: "worker", sessionDirectory: "relative" }),
      () => buildPiInvocationArguments({ role: "reviewer", sessionDirectory: "/session" }),
      () => buildPiInvocationArguments({ role: "reviewer", sessionDirectory: "/session", reviewerHelperPath: "relative" }),
      () => buildPiInvocationArguments({ role: "worker", sessionDirectory: "/bad\0dir" }),
      () => buildPiInvocationArguments({ role: "worker", sessionDirectory: "/session", model: "x".repeat(257) }),
      () => buildPiInvocationArguments({ role: "admin" as never, sessionDirectory: "/session" })
    ]) expect(action).toThrow();
  });

  it("contains no launch, timer, filesystem, sandbox, ledger, or settlement authority", async () => {
    const source = await readFile(new URL("../src/adapters/builtins/pi.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/node:(?:child_process|fs)|\bspawn(?:Sync)?\s*\(|\bexecFile(?:Sync)?\s*\(/);
    expect(source).not.toMatch(/\bsetTimeout\b|\bsleep\s*\(/);
    expect(source).not.toMatch(/from\s+["'][^"']*(?:sandbox|ledger|settlement|orchestrator)[^"']*["']/);
    expect(source).not.toMatch(/\bnpx\b|\bpnpm\s+dlx\b|\bbunx\b/);
  });
});

describe("Pi read-only reviewer helper", () => {
  it("registers exactly two bounded read-only tools and imports no mutation/process APIs", async () => {
    const helperUrl = new URL("../assets/pi-relayforge-reviewer.mjs", import.meta.url);
    const source = await readFile(helperUrl, "utf8");
    expect(source).not.toMatch(/child_process|\bspawn\s*\(|\bexecFile\s*\(/);
    expect(source).not.toMatch(/\bwriteFile\b|\bappendFile\b|\btruncate\b|\bunlink\b|\brename\b|\bmkdir\b|\brm\s*\(/);
    const loaded = await import(helperUrl.href) as { default: (api: { registerTool(tool: unknown): void }) => void };
    const tools: Array<Record<string, unknown>> = [];
    loaded.default({ registerTool: (tool) => tools.push(tool as Record<string, unknown>) });
    expect(tools.map((tool) => tool.name)).toEqual(PI_REVIEWER_TOOLS);
    expect(tools.every((tool) => typeof tool.execute === "function")).toBe(true);
    expect(tools.every((tool) => (tool.parameters as Record<string, unknown>).additionalProperties === false)).toBe(true);
  });

  it("reads/lists inside the workspace but rejects traversal and symlink escape", async () => {
    const base = await mkdtemp(join(tmpdir(), "relayforge-pi-reviewer-"));
    const workspace = join(base, "workspace");
    const outside = join(base, "outside.txt");
    await mkdir(workspace);
    await writeFile(join(workspace, "inside.txt"), "inside contents", { mode: 0o600 });
    await writeFile(outside, "outside secret", { mode: 0o600 });
    await symlink(outside, join(workspace, "escape"));
    try {
      const helperUrl = new URL("../assets/pi-relayforge-reviewer.mjs", import.meta.url);
      const loaded = await import(helperUrl.href) as { default: (api: { registerTool(tool: unknown): void }) => void };
      const tools: Array<Record<string, unknown>> = [];
      loaded.default({ registerTool: (tool) => tools.push(tool as Record<string, unknown>) });
      const read = tools.find((tool) => tool.name === "relayforge_read")!.execute as Function;
      const list = tools.find((tool) => tool.name === "relayforge_list")!.execute as Function;
      await expect(read("call-1", { path: "inside.txt" }, undefined, undefined, { cwd: workspace })).resolves.toMatchObject({
        content: [{ type: "text", text: "inside contents" }],
        details: { path: "inside.txt", bytes: 15 }
      });
      await expect(list("call-2", { path: "." }, undefined, undefined, { cwd: workspace })).resolves.toMatchObject({
        details: { entries: 2 }
      });
      await expect(read("call-3", { path: "../outside.txt" }, undefined, undefined, { cwd: workspace })).rejects.toThrow(/escapes/);
      await expect(read("call-4", { path: "escape" }, undefined, undefined, { cwd: workspace })).rejects.toThrow(/escapes/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("Pi RPC mapping and behavioral readiness", () => {
  it("serializes state/stats/prompt as exact request-ID-bound JSONL with no readiness delay", () => {
    expect(serializePiGetState("state-probe-1").toString()).toBe('{"id":"state-probe-1","type":"get_state"}\n');
    expect(serializePiGetSessionStats("stats-start-1").toString()).toBe('{"id":"stats-start-1","type":"get_session_stats"}\n');
    expect(serializePiPrompt({ requestId: "prompt-adapter-1", message: "task payload" }).toString()).toBe(
      '{"id":"prompt-adapter-1","type":"prompt","message":"task payload"}\n'
    );
  });

  it("maps prompt events only after correlated acceptance and requires agent_settled", () => {
    const normalized = runTurn(PI_ADAPTER_SUCCESS_RECORDS);
    expect(normalized.fatal).toBeUndefined();
    expect(normalized.result).toMatchObject({ status: "success", finalText: "read-only result", explicitLimit: false });
    expect(normalized.events.map((event) => event.kind)).toEqual([
      "session",
      "diagnostic",
      "assistant-delta",
      "assistant-final",
      "diagnostic",
      "session"
    ]);
    expect(runTurn(PI_ADAPTER_SUCCESS_RECORDS.slice(0, -1)).result).toMatchObject({ status: "uncertain", code: "missing-terminal" });
  });

  it("derives per-turn statistics only for one session generation and preserves unknown context", () => {
    const start = decodePiSessionStatsResponse(frame(PI_PROBE_START_STATS_RESPONSE), "stats-start-1", PI_PROBE_SESSION, PI_PROBE_GENERATION);
    const end = decodePiSessionStatsResponse(frame(PI_PROBE_END_STATS_RESPONSE), "stats-end-1", PI_PROBE_SESSION, PI_PROBE_GENERATION);
    if (start.status === "invalid" || end.status === "invalid") throw new Error("invalid stats fixture");
    expect("contextUsed" in start.value).toBe(false);
    expect(derivePiTurnUsage(start.value, end.value)).toEqual({
      source: "session-statistics",
      cumulative: false,
      inputTokens: 40,
      outputTokens: 10,
      cachedReadTokens: 10,
      cachedWriteTokens: 1,
      totalTokens: 61,
      costUsd: 0.30000000000000004,
      contextUsed: 70,
      contextSize: 200_000
    });
    expect(derivePiTurnUsage(start.value, { ...end.value, sessionGeneration: PI_PROBE_GENERATION + 1 })).toBeUndefined();
  });

  it("never maps quota-looking prompt failures or assistant text to fallback authority", () => {
    expect(runTurn([{
      id: "prompt-adapter-1",
      type: "response",
      command: "prompt",
      success: false,
      error: "rate quota usage limit"
    }]).result).toMatchObject({ status: "failure", explicitLimit: false });
  });

  it("sends one correlated abort and distinguishes cancelled/completed/escalated races", () => {
    const cancelled = new PiCancelStateMachine("abort-1");
    expect(cancelled.request()).toMatchObject({ accepted: true, snapshot: { phase: "sent", sendCount: 1 } });
    expect(cancelled.request()).toMatchObject({ accepted: true, snapshot: { sendCount: 1 } });
    expect(cancelled.observeTerminal("cancelled")).toMatchObject({ phase: "terminal-cancelled" });
    const completed = new PiCancelStateMachine("abort-2");
    completed.request();
    expect(completed.observeTerminal("success")).toMatchObject({ phase: "completion-won" });
    const hung = new PiCancelStateMachine("abort-3");
    hung.request();
    expect(hung.expire()).toMatchObject({ phase: "escalation-required" });
  });
});

describe("Pi compatibility and required-real gate", () => {
  it("accepts only exact version/wire plus frame-bound state and statistics handshakes", () => {
    const available = evaluatePiProbe(completeProbe());
    expect(available).toMatchObject({ status: "available", observedExecutableVersion: "0.84.1", wireVersion: "pi-rpc-v1" });
    expect(Object.isFrozen(available)).toBe(true);
    expect(evaluateAdapterRole(piAdapterDescriptor, available, "worker")).toMatchObject({ status: "eligible" });
    expect(evaluateAdapterRole(piAdapterDescriptor, available, "reviewer")).toMatchObject({ status: "eligible" });
  });

  it("keeps worker eligibility but refuses reviewer when the restricted helper was not behaviorally proven", () => {
    const evidence = completeProbe();
    const availability = evaluatePiProbe(completeProbe({
      capabilities: { ...evidence.capabilities!, innerReadOnly: false }
    }));
    expect(availability.status).toBe("available");
    expect(evaluateAdapterRole(piAdapterDescriptor, availability, "worker")).toMatchObject({ status: "eligible" });
    expect(evaluateAdapterRole(piAdapterDescriptor, availability, "reviewer")).toMatchObject({
      status: "unavailable",
      refusal: { code: "inner-read-only-unproven", missingCapabilities: ["inner-read-only"] }
    });
  });

  it("returns typed unavailability for identity/version/wire/state/stats/capability near misses", () => {
    const full = completeProbe();
    const missingCheck = { ...full.behavioralEvidenceSha256 };
    delete missingCheck.cancellation;
    const cases: Array<[PiProbeObservation, string]> = [
      [completeProbe({ executable: undefined }), "executable-missing"],
      [completeProbe({ executable: { ...full.executable!, canonicalPath: "relative/pi" } }), "executable-identity-changed"],
      [completeProbe({ reviewerHelper: undefined }), "executable-identity-changed"],
      [completeProbe({ executable: { ...full.executable!, version: "v0.84.1" } }), "version-unparseable"],
      [completeProbe({ executable: { ...full.executable!, version: "0.84.0" } }), "version-unsupported"],
      [completeProbe({ executable: { ...full.executable!, version: "0.84.2" } }), "version-unsupported"],
      [completeProbe({ wireVersion: undefined }), "handshake-failed"],
      [completeProbe({ wireVersion: "pi-rpc-v2" }), "wire-unsupported"],
      [completeProbe({ state: undefined }), "handshake-failed"],
      [completeProbe({ statistics: undefined }), "handshake-failed"],
      [completeProbe({ state: { ...full.state!, value: { ...full.state!.value, isStreaming: true } } }), "protocol-drift"],
      [completeProbe({ statistics: { ...full.statistics!, sessionId: "foreign" } }), "protocol-drift"],
      [completeProbe({ state: { ...full.state!, frameSha256: "e".repeat(64) } }), "protocol-drift"],
      [completeProbe({ behavioralEvidenceSha256: missingCheck }), "handshake-failed"],
      [completeProbe({ capabilities: { ...full.capabilities!, usage: false } }), "required-capability-missing"]
    ];
    for (const [observation, code] of cases) {
      expect(evaluatePiProbe(observation)).toMatchObject({ status: "unavailable", reason: { code } });
    }
  });

  it("does not accept version/help output without live state and statistics exchanges", () => {
    const full = completeProbe();
    expect(evaluatePiProbe({
      executable: full.executable,
      reviewerHelper: full.reviewerHelper,
      wireVersion: PI_RPC_WIRE_VERSION,
      probedAt: PROBED_AT,
      consultedConfigSha256: CONFIG_SHA
    })).toMatchObject({
      status: "unavailable",
      reason: { code: "handshake-failed" },
      missingEvidence: [{ kind: "behavioral-check", detail: "Missing get_state response evidence" }]
    });
  });

  it("requires parent-contained real-host evidence when RELAYFORGE_TEST_REQUIRE_PI=1; never skips or directly spawns", () => {
    const required = process.env.RELAYFORGE_TEST_REQUIRE_PI === "1";
    const evidenceFile = process.env.RELAYFORGE_TEST_PI_CONTAINED_EVIDENCE_FILE;
    if (!required) {
      expect(evaluatePiProbe({ probedAt: PROBED_AT, consultedConfigSha256: CONFIG_SHA })).toMatchObject({
        status: "unavailable",
        reason: { code: "executable-missing" }
      });
      return;
    }
    const commitSha = process.env.GITHUB_SHA ?? process.env.RELAYFORGE_TEST_EVIDENCE_COMMIT_SHA;
    const jobNonce = process.env.RELAYFORGE_TEST_EVIDENCE_JOB_NONCE;
    if (!evidenceFile || !commitSha || !jobNonce) {
      throw new Error(
        "RELAYFORGE_TEST_REQUIRE_PI=1 requires a same-job RELAYFORGE_TEST_PI_CONTAINED_EVIDENCE_FILE, checkout SHA, and RELAYFORGE_TEST_EVIDENCE_JOB_NONCE from the parent-owned collector; direct spawn and readiness-delay fallbacks are forbidden."
      );
    }
    const evidence = readContainedAdapterEvidenceFile(evidenceFile, {
      adapterId: "pi",
      commitSha,
      jobNonce,
      configurationSha256: containedAdapterProbeConfigurationSha256("pi"),
      now: new Date(),
      allowedRoot: dirname(evidenceFile)
    });
    expect(evaluateAdapterRole(piAdapterDescriptor, evidence.availability, "reviewer").status).toBe("eligible");
    expect(Object.keys(evidence.checks).sort()).toEqual([
      "cancellationSettled",
      "promptCompleted",
      "replayMatched",
      "reviewerWriteDenied",
      "scopeEmpty",
      "stateAndStatsCompleted"
    ]);
  });
});

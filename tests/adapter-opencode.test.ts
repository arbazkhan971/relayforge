import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { AcpCancelStateMachine, AcpV1TurnCodec, decodeAcpInitializeResponse } from "../src/adapters/acp-v1.js";
import { BoundedJsonlFramer, type NormalizedAdapterEvent } from "../src/adapters/codec.js";
import {
  OPENCODE_ACP_WIRE_VERSION,
  OPENCODE_AUDITED_VERSION,
  OPENCODE_CONFIG_CONTENT_ENV,
  OPENCODE_RELAYFORGE_AGENT,
  buildOpenCodeConfigOverlay,
  evaluateOpenCodeProbe,
  opencodeAdapterDescriptor,
  serializeOpenCodePermissionResponse,
  type OpenCodeProbeObservation
} from "../src/adapters/builtins/opencode.js";
import { evaluateAdapterRole } from "../src/adapters/registry.js";
import {
  containedAdapterProbeConfigurationSha256,
  readContainedAdapterEvidenceFile
} from "../src/adapters/contained-evidence.js";
import {
  OPENCODE_INITIALIZE_RESPONSE,
  OPENCODE_NO_USAGE_RECORDS,
  OPENCODE_PERMISSION_REQUEST,
  OPENCODE_PROMPT_ID,
  OPENCODE_SESSION_ID,
  OPENCODE_SUCCESS_RECORDS,
  opencodeTranscript
} from "./fixtures/adapters/opencode/transcripts.js";

function run(records: readonly Readonly<Record<string, unknown>>[]) {
  const events: NormalizedAdapterEvent[] = [];
  const codec = new AcpV1TurnCodec({
    sessionId: OPENCODE_SESSION_ID,
    promptRequestId: OPENCODE_PROMPT_ID,
    onEvent: (event) => events.push(event)
  });
  const framer = new BoundedJsonlFramer((frame) => codec.push(frame), {
    maxFrameBytes: 64 * 1024,
    maxTotalBytes: 1024 * 1024,
    maxFrames: 1024
  });
  const transcript = opencodeTranscript(records);
  for (let offset = 0; offset < transcript.length; offset += 7) {
    framer.push(transcript.subarray(offset, Math.min(transcript.length, offset + 7)));
  }
  framer.finish();
  return { events, result: codec.finish(), fatal: framer.fatal() };
}

function frame(record: Readonly<Record<string, unknown>>) {
  return { raw: Buffer.from(JSON.stringify(record)), offset: 0, index: 0, terminated: true } as const;
}

const SHA = "a".repeat(64);
const CONFIG_SHA = "b".repeat(64);
const PROBED_AT = "2026-08-09T00:00:00.000Z";

function completeProbe(overrides: Partial<OpenCodeProbeObservation> = {}): OpenCodeProbeObservation {
  const behavioralEvidenceSha256 = Object.fromEntries(
    opencodeAdapterDescriptor.compatibility.behavioralProbe.requiredChecks.map((check) => [check, SHA])
  );
  return {
    executable: {
      canonicalPath: "/usr/local/bin/opencode",
      identity: "dev:1:ino:2:sha256:characterized",
      version: OPENCODE_AUDITED_VERSION
    },
    wireVersion: OPENCODE_ACP_WIRE_VERSION,
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
      attachments: true,
      innerReadOnly: true
    },
    probedAt: PROBED_AT,
    consultedConfigSha256: CONFIG_SHA,
    ...overrides
  };
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

describe("OpenCode native ACP descriptor", () => {
  it("is immutable/data-only and fixes the canonical installed `opencode acp` recipe", () => {
    expect(opencodeAdapterDescriptor).toMatchObject({
      id: "opencode",
      providerId: "opencode",
      transportKind: "acp-v1",
      runtimeIdentity: {
        kind: "installed-executable",
        executable: "opencode",
        trustedHelpers: [],
        resolution: "canonical-installed-only"
      },
      invocationPolicy: {
        fixedArguments: ["acp"],
        allowedEnvironmentNames: ["OPENCODE_CONFIG_CONTENT"],
        promptTransport: "stdio-jsonrpc",
        systemPromptChannel: "separate"
      },
      codec: { id: "acp-v1", version: 1 },
      normalizer: { id: "opencode-acp-v1-1.18.15", version: 1 }
    });
    expect(opencodeAdapterDescriptor.compatibility).toMatchObject({
      executableVersion: { minInclusive: "1.18.15", maxExclusive: "1.18.16" },
      wireVersions: ["1"]
    });
    expect(opencodeAdapterDescriptor.capabilityPolicy["rate-limits"]).toBe("unsupported");
    expect(opencodeAdapterDescriptor.roles.reviewer).toMatchObject({
      outerSandbox: "required",
      filesystem: "read-only",
      innerReadOnly: "required"
    });
    assertDeepFrozenData(opencodeAdapterDescriptor);
  });

  it("imports no process, filesystem, shell, sandbox, ledger, or settlement authority", () => {
    const source = readFileSync(new URL("../src/adapters/builtins/opencode.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/node:(?:child_process|fs)|\bspawn(?:Sync)?\s*\(|\bexecFile(?:Sync)?\s*\(/);
    expect(source).not.toMatch(/from\s+["'][^"']*(?:sandbox|ledger|settlement|orchestrator)[^"']*["']/);
    expect(source).not.toMatch(/\bnpx\b|\bpnpm\s+dlx\b|\bbunx\b/);
  });
});

describe("OpenCode parent-controlled inline configuration", () => {
  it("preserves safe user configuration but deterministically owns the session agent and role policy", () => {
    const existing = JSON.stringify({
      theme: "dark",
      provider: { local: { npm: "example" } },
      agent: {
        user: { prompt: "keep me" },
        relayforge: { prompt: "attacker override", permission: { edit: "allow" } }
      },
      default_agent: "user"
    });
    const overlay = buildOpenCodeConfigOverlay({ role: "reviewer", systemPrompt: "Standing reviewer rules", existingConfigContent: existing });
    expect(Object.isFrozen(overlay)).toBe(true);
    expect(Object.keys(overlay)).toEqual([OPENCODE_CONFIG_CONTENT_ENV]);
    const parsed = JSON.parse(overlay.OPENCODE_CONFIG_CONTENT);
    expect(parsed.theme).toBe("dark");
    expect(parsed.provider.local.npm).toBe("example");
    expect(parsed.agent.user.prompt).toBe("keep me");
    expect(parsed.default_agent).toBe(OPENCODE_RELAYFORGE_AGENT);
    expect(parsed.agent.relayforge).toEqual({
      description: "RelayForge parent-controlled session agent",
      mode: "primary",
      prompt: "Standing reviewer rules",
      permission: {
        edit: "deny",
        bash: "deny",
        task: "deny",
        webfetch: "deny",
        external_directory: "deny"
      }
    });
  });

  it("keeps worker mutation choices mediated and never enables an automatic bypass", () => {
    const overlay = buildOpenCodeConfigOverlay({ role: "worker", systemPrompt: "Worker rules" });
    const config = JSON.parse(overlay.OPENCODE_CONFIG_CONTENT);
    expect(config.agent.relayforge.permission).toEqual({
      edit: "ask",
      bash: "ask",
      task: "ask",
      webfetch: "ask",
      external_directory: "deny"
    });
    expect(JSON.stringify(config)).not.toContain('"allow"');
  });

  it("rejects malformed, oversized, ambiguous, and prototype-shaped config instead of weakening the overlay", () => {
    for (const existingConfigContent of ["[]", "null", "not-json", '{"agent":[]}', '{"__proto__":{"polluted":true}}']) {
      expect(() => buildOpenCodeConfigOverlay({ role: "reviewer", systemPrompt: "rules", existingConfigContent })).toThrow();
    }
    expect(() => buildOpenCodeConfigOverlay({ role: "reviewer", systemPrompt: "bad\0prompt" })).toThrow(/NUL-free/);
    expect(() => buildOpenCodeConfigOverlay({ role: "reviewer", systemPrompt: "x".repeat(4 * 1024 * 1024 + 1) })).toThrow(/byte limit/);
  });
});

describe("OpenCode ACP usage, permissions, and cancellation", () => {
  it("accepts only the correlated audited ACP v1 initialize response", () => {
    expect(decodeAcpInitializeResponse(frame(OPENCODE_INITIALIZE_RESPONSE), "initialize-1")).toMatchObject({
      status: "valid",
      value: { protocolVersion: "1", agentName: "OpenCode", agentVersion: "1.18.15" }
    });
    expect(decodeAcpInitializeResponse(frame({ ...OPENCODE_INITIALIZE_RESPONSE, id: "foreign" }), "initialize-1")).toMatchObject({
      status: "invalid",
      code: "foreign-correlation"
    });
    expect(decodeAcpInitializeResponse(frame({
      ...OPENCODE_INITIALIZE_RESPONSE,
      result: { ...OPENCODE_INITIALIZE_RESPONSE.result, protocolVersion: 2 }
    }), "initialize-1")).toMatchObject({ status: "invalid", code: "wire-unsupported" });
  });

  it("maps tokens/cache/context/cost with native provenance and preserves absent usage as unknown", () => {
    const mapped = run(OPENCODE_SUCCESS_RECORDS);
    expect(mapped.fatal).toBeUndefined();
    expect(mapped.result).toMatchObject({
      status: "success",
      finalText: "inspected without writing",
      explicitLimit: false,
      usage: {
        source: "terminal-response",
        inputTokens: 40,
        outputTokens: 10,
        thoughtTokens: 5,
        cachedReadTokens: 20,
        cachedWriteTokens: 2,
        totalTokens: 77
      }
    });
    expect(mapped.events.filter((event) => event.kind === "usage").map((event) => event.usage)).toEqual([
      {
        source: "usage-update",
        cumulative: true,
        contextUsed: 75,
        contextSize: 200_000,
        costUsd: 0.125
      },
      {
        source: "terminal-response",
        cumulative: false,
        inputTokens: 40,
        outputTokens: 10,
        thoughtTokens: 5,
        cachedReadTokens: 20,
        cachedWriteTokens: 2,
        totalTokens: 77
      }
    ]);

    const absent = run(OPENCODE_NO_USAGE_RECORDS);
    expect(absent.result).toMatchObject({ status: "success", explicitLimit: false });
    expect("usage" in absent.result).toBe(false);
    expect(absent.events.some((event) => event.kind === "usage")).toBe(false);
  });

  it("never turns context pressure or quota-looking provider prose into fallback authority", () => {
    expect(run([
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: OPENCODE_SESSION_ID, update: { sessionUpdate: "usage_update", used: 100, size: 100 } }
      },
      { jsonrpc: "2.0", id: OPENCODE_PROMPT_ID, result: { stopReason: "refusal" } }
    ]).result).toMatchObject({ status: "failure", explicitLimit: false });
    expect(run([{
      jsonrpc: "2.0",
      id: OPENCODE_PROMPT_ID,
      error: { code: -32000, message: "quota rate limit exceeded" }
    }]).result).toMatchObject({ status: "failure", explicitLimit: false });
  });

  it("fails closed on malformed accounting and foreign permission correlation", () => {
    expect(run([
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: OPENCODE_SESSION_ID,
          update: { sessionUpdate: "usage_update", used: 2, size: 1, cost: { amount: -1, currency: "USD" } }
        }
      },
      { jsonrpc: "2.0", id: OPENCODE_PROMPT_ID, result: { stopReason: "end_turn" } }
    ]).result).toMatchObject({ status: "uncertain", code: "malformed-accounting", explicitLimit: false });
    expect(run([
      { ...OPENCODE_PERMISSION_REQUEST, params: { ...OPENCODE_PERMISSION_REQUEST.params, sessionId: "foreign" } },
      { jsonrpc: "2.0", id: OPENCODE_PROMPT_ID, result: { stopReason: "end_turn" } }
    ]).result).toMatchObject({ status: "uncertain", code: "foreign-correlation" });
  });

  it("rejects reviewer permissions and selects only an explicit worker option", () => {
    expect(serializeOpenCodePermissionResponse({
      requestId: "permission-1",
      role: "reviewer",
      decision: { outcome: "selected", optionId: "allow-once" }
    }).toString()).toBe('{"jsonrpc":"2.0","id":"permission-1","result":{"outcome":{"outcome":"cancelled"}}}\n');
    expect(serializeOpenCodePermissionResponse({
      requestId: "permission-1",
      role: "worker",
      decision: { outcome: "selected", optionId: "allow-once" }
    }).toString()).toBe('{"jsonrpc":"2.0","id":"permission-1","result":{"outcome":{"outcome":"selected","optionId":"allow-once"}}}\n');
    expect(serializeOpenCodePermissionResponse({
      requestId: "permission-1",
      role: "worker",
      decision: { outcome: "rejected" }
    }).toString()).toBe('{"jsonrpc":"2.0","id":"permission-1","result":{"outcome":{"outcome":"cancelled"}}}\n');
    expect(() => serializeOpenCodePermissionResponse({
      requestId: "",
      role: "worker",
      decision: { outcome: "selected", optionId: "allow-once" }
    })).toThrow();
  });

  it("sends session/cancel once and distinguishes cancellation, completion, and escalation races", () => {
    const cancelled = new AcpCancelStateMachine(OPENCODE_SESSION_ID);
    const first = cancelled.request();
    expect(first.accepted).toBe(true);
    expect(first.outbound?.toString()).toBe(`{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"${OPENCODE_SESSION_ID}"}}\n`);
    expect(cancelled.request()).toMatchObject({ accepted: true, snapshot: { sendCount: 1 } });
    expect(cancelled.observeTerminal("cancelled")).toMatchObject({ phase: "terminal-cancelled", sendCount: 1 });

    const completed = new AcpCancelStateMachine(OPENCODE_SESSION_ID);
    completed.request();
    expect(completed.observeTerminal("success")).toMatchObject({ phase: "completion-won", terminalOutcome: "success" });

    const hung = new AcpCancelStateMachine(OPENCODE_SESSION_ID);
    hung.request();
    expect(hung.expire()).toMatchObject({ phase: "escalation-required", sendCount: 1 });
  });
});

describe("OpenCode compatibility and required-real gate", () => {
  it("accepts only complete exact-version, ACP-v1, contained behavioral evidence", () => {
    const available = evaluateOpenCodeProbe(completeProbe());
    expect(available).toMatchObject({
      status: "available",
      observedExecutableVersion: "1.18.15",
      wireVersion: "1"
    });
    expect(Object.isFrozen(available)).toBe(true);
    expect(evaluateAdapterRole(opencodeAdapterDescriptor, available, "worker")).toMatchObject({ status: "eligible" });
    expect(evaluateAdapterRole(opencodeAdapterDescriptor, available, "reviewer")).toMatchObject({ status: "eligible" });
  });

  it("keeps a worker available but refuses reviewer mode when inner read-only evidence is absent", () => {
    const availability = evaluateOpenCodeProbe(completeProbe({
      capabilities: { ...completeProbe().capabilities!, innerReadOnly: false }
    }));
    expect(availability.status).toBe("available");
    expect(evaluateAdapterRole(opencodeAdapterDescriptor, availability, "worker")).toMatchObject({ status: "eligible" });
    expect(evaluateAdapterRole(opencodeAdapterDescriptor, availability, "reviewer")).toMatchObject({
      status: "unavailable",
      refusal: { code: "inner-read-only-unproven", missingCapabilities: ["inner-read-only"] }
    });
  });

  it("returns stable typed unavailability for every version/handshake/capability near miss", () => {
    const complete = completeProbe();
    const withoutCheck = { ...complete.behavioralEvidenceSha256 };
    delete withoutCheck["prompt-roundtrip"];
    const cases: Array<[OpenCodeProbeObservation, string]> = [
      [completeProbe({ executable: undefined }), "executable-missing"],
      [completeProbe({ executable: { ...complete.executable!, canonicalPath: "relative/opencode" } }), "executable-identity-changed"],
      [completeProbe({ executable: { ...complete.executable!, identity: "" } }), "executable-identity-changed"],
      [completeProbe({ executable: { ...complete.executable!, version: "v1.18.15" } }), "version-unparseable"],
      [completeProbe({ executable: { ...complete.executable!, version: "1.18.14" } }), "version-unsupported"],
      [completeProbe({ executable: { ...complete.executable!, version: "1.18.16" } }), "version-unsupported"],
      [completeProbe({ wireVersion: undefined }), "handshake-failed"],
      [completeProbe({ wireVersion: "2" }), "wire-unsupported"],
      [completeProbe({ behavioralEvidenceSha256: withoutCheck }), "handshake-failed"],
      [completeProbe({ capabilities: { ...complete.capabilities!, cancellation: false } }), "required-capability-missing"]
    ];
    for (const [observation, code] of cases) {
      expect(evaluateOpenCodeProbe(observation)).toMatchObject({ status: "unavailable", reason: { code } });
    }
  });

  it("does not accept executable version/help evidence without a contained ACP loopback handshake", () => {
    const availability = evaluateOpenCodeProbe({
      executable: completeProbe().executable,
      probedAt: PROBED_AT,
      consultedConfigSha256: CONFIG_SHA
    });
    expect(availability).toMatchObject({
      status: "unavailable",
      reason: { code: "handshake-failed" },
      missingEvidence: expect.arrayContaining([{ kind: "contained-loopback", detail: "No contained ACP initialize response" }])
    });
  });

  it("requires parent-contained real-host evidence when RELAYFORGE_TEST_REQUIRE_OPENCODE=1; never skips or directly spawns", () => {
    const required = process.env.RELAYFORGE_TEST_REQUIRE_OPENCODE === "1";
    const evidenceFile = process.env.RELAYFORGE_TEST_OPENCODE_CONTAINED_EVIDENCE_FILE;
    if (!required) {
      expect(evaluateOpenCodeProbe({ probedAt: PROBED_AT, consultedConfigSha256: CONFIG_SHA })).toMatchObject({
        status: "unavailable",
        reason: { code: "executable-missing" }
      });
      return;
    }
    const commitSha = process.env.GITHUB_SHA ?? process.env.RELAYFORGE_TEST_EVIDENCE_COMMIT_SHA;
    const jobNonce = process.env.RELAYFORGE_TEST_EVIDENCE_JOB_NONCE;
    if (!evidenceFile || !commitSha || !jobNonce) {
      throw new Error(
        "RELAYFORGE_TEST_REQUIRE_OPENCODE=1 requires a same-job RELAYFORGE_TEST_OPENCODE_CONTAINED_EVIDENCE_FILE, checkout SHA, and RELAYFORGE_TEST_EVIDENCE_JOB_NONCE from the parent-owned collector; direct spawn fallback is forbidden."
      );
    }
    const evidence = readContainedAdapterEvidenceFile(evidenceFile, {
      adapterId: "opencode",
      commitSha,
      jobNonce,
      configurationSha256: containedAdapterProbeConfigurationSha256("opencode"),
      now: new Date(),
      allowedRoot: dirname(evidenceFile)
    });
    expect(evaluateAdapterRole(opencodeAdapterDescriptor, evidence.availability, "reviewer").status).toBe("eligible");
    expect(Object.keys(evidence.checks).sort()).toEqual([
      "cancellationSettled",
      "promptCompleted",
      "replayMatched",
      "reviewerWriteDenied",
      "scopeEmpty"
    ]);
  });
});

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GROK_ACP_WIRE_VERSION,
  GROK_AUDITED_BUILD_COMMIT,
  GROK_AUDITED_VERSION,
  GROK_FIXED_SAFETY_ENVIRONMENT,
  buildGrokInvocationArguments,
  buildGrokPrivateEnvironment,
  evaluateGrokProbe,
  grokAdapterDescriptor,
  type GrokProbeObservation
} from "../src/adapters/builtins/grok.js";
import {
  createGrokAcpTurnCodec,
  decodeGrokInitializeResponse,
  grokInitializeMeta,
  grokSessionMeta
} from "../src/adapters/grok-acp.js";
import { serializeAcpInitialize, serializeAcpNewSession } from "../src/adapters/acp-v1.js";
import { BoundedJsonlFramer, type CodecFrame, type NormalizedAdapterEvent } from "../src/adapters/codec.js";
import { evaluateAdapterRole } from "../src/adapters/registry.js";
import {
  GROK_EGRESS_POLICY_SHA256,
  GROK_EGRESS_RELAY_RUNTIME,
  grokEgressDenialEvidenceSha256
} from "../src/adapters/grok-egress-contract.js";
import {
  containedAdapterProbeConfigurationSha256,
  readContainedAdapterEvidenceFile
} from "../src/adapters/contained-evidence.js";
import {
  GROK_FIXTURE_PROMPT_ID,
  GROK_FIXTURE_SESSION_ID,
  GROK_INITIALIZE_RESPONSE,
  GROK_SUCCESS_RECORDS,
  grokTranscript
} from "./fixtures/adapters/grok.js";

const PROBED_AT = "2026-08-09T00:00:00.000Z";
const CONFIG_SHA = "0".repeat(64);
const SHA = "a".repeat(64);

function frame(value: Readonly<Record<string, unknown>>): CodecFrame {
  return Object.freeze({ raw: Buffer.from(JSON.stringify(value)), offset: 0, index: 0, terminated: true });
}

function completeProbe(overrides: Partial<GrokProbeObservation> = {}): GrokProbeObservation {
  const egressEvidence = {
    policySha256: GROK_EGRESS_POLICY_SHA256,
    probeReceiptSha256: "c".repeat(64),
    decisionLogSha256: "d".repeat(64),
    socketIdentitySha256: "e".repeat(64),
    cleanupSha256: "f".repeat(64)
  };
  const safetyEvidence = {
    configurationIsolationSha256: "b".repeat(64),
    networkToolPolicySha256: egressEvidence.probeReceiptSha256,
    unapprovedUploadDenialSha256: grokEgressDenialEvidenceSha256(egressEvidence)
  };
  return {
    executable: {
      canonicalPath: "/usr/local/bin/grok",
      identity: "rf-v1:grok-characterized",
      version: GROK_AUDITED_VERSION,
      buildCommit: GROK_AUDITED_BUILD_COMMIT,
      channel: "stable"
    },
    trustedHelper: {
      canonicalPath: "/usr/local/lib/relayforge/grok-egress-relay.mjs",
      identity: "rf-v1:grok-egress-relay-characterized"
    },
    wireVersion: GROK_ACP_WIRE_VERSION,
    handshake: { grokShell: true, agentVersion: GROK_AUDITED_VERSION },
    apiKeyConfigured: true,
    behavioralEvidenceSha256: {
      ...Object.fromEntries(grokAdapterDescriptor.compatibility.behavioralProbe.requiredChecks.map((check) => [check, SHA])),
      "configuration-isolation": safetyEvidence.configurationIsolationSha256,
      "network-tool-policy": safetyEvidence.networkToolPolicySha256,
      "unapproved-upload-denial": safetyEvidence.unapprovedUploadDenialSha256
    },
    safetyEvidence,
    egressEvidence,
    capabilities: {
      modelDiscovery: true,
      sessionCreate: true,
      sessionResume: true,
      streaming: true,
      cancellation: true,
      usage: false,
      cost: false,
      context: true,
      steering: true,
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

function runTurn(records = GROK_SUCCESS_RECORDS) {
  const events: NormalizedAdapterEvent[] = [];
  const codec = createGrokAcpTurnCodec({
    sessionId: GROK_FIXTURE_SESSION_ID,
    promptRequestId: GROK_FIXTURE_PROMPT_ID,
    onEvent: (event) => events.push(event)
  });
  const framer = new BoundedJsonlFramer((value) => codec.push(value), {
    maxFrameBytes: 64 * 1024,
    maxTotalBytes: 1024 * 1024,
    maxFrames: 1024
  });
  const transcript = grokTranscript(records);
  for (let offset = 0; offset < transcript.length; offset += 5) {
    framer.push(transcript.subarray(offset, Math.min(transcript.length, offset + 5)));
  }
  framer.finish();
  return { events, result: codec.finish(), fatal: framer.fatal() };
}

describe("Grok native ACP descriptor and codec", () => {
  it("is immutable data and fixes the canonical installed runtime contract", () => {
    expect(grokAdapterDescriptor).toMatchObject({
      id: "grok",
      providerId: "grok",
      transportKind: "acp-v1",
      runtimeIdentity: { executable: "grok", trustedHelpers: [GROK_EGRESS_RELAY_RUNTIME], resolution: "canonical-installed-only" },
      compatibility: {
        executableVersion: { minInclusive: "1.0.0", maxExclusive: "1.0.1" },
        wireVersions: ["1"]
      },
      invocationPolicy: {
        allowedEnvironmentNames: ["XAI_API_KEY"],
        promptTransport: "stdio-jsonrpc",
        systemPromptChannel: "separate"
      },
      codec: { id: "acp-v1", version: 1 },
      normalizer: { id: "grok-acp-v1-1.0.0", version: 1 }
    });
    expect(grokAdapterDescriptor.roles.reviewer).toMatchObject({
      outerSandbox: "required",
      filesystem: "read-only",
      innerReadOnly: "required"
    });
    assertDeepFrozenData(grokAdapterDescriptor);
  });

  it("imports no process, filesystem, sandbox, ledger or settlement authority", () => {
    const source = readFileSync(new URL("../src/adapters/builtins/grok.ts", import.meta.url), "utf8");
    const protocol = readFileSync(new URL("../src/adapters/grok-acp.ts", import.meta.url), "utf8");
    for (const text of [source, protocol]) {
      expect(text).not.toMatch(/node:child_process|node:fs|sandbox|settlement-kernel|ledger|spawn\s*\(/);
    }
  });

  it("constructs the exact no-leader/no-upload recipe without trust escapes", () => {
    expect(buildGrokInvocationArguments({ role: "worker", model: "grok-4.5" })).toEqual([
      "--no-auto-update", "--disable-web-search", "--no-subagents", "--no-memory",
      "--permission-mode", "default", "agent", "--no-leader", "--model", "grok-4.5", "stdio"
    ]);
    expect(buildGrokInvocationArguments({ role: "reviewer" })).toEqual([
      "--no-auto-update", "--disable-web-search", "--no-subagents", "--no-memory",
      "--permission-mode", "plan", "agent", "--no-leader", "stdio"
    ]);
    const env = buildGrokPrivateEnvironment("/run/private/grok");
    expect(env).toMatchObject({ HOME: "/run/private/grok/home", GROK_HOME: "/run/private/grok/grok-home", ...GROK_FIXED_SAFETY_ENVIRONMENT });
    expect(() => buildGrokInvocationArguments({ role: "worker", model: "x".repeat(257) })).toThrow(/bounded/);
    expect(() => buildGrokPrivateEnvironment("relative/grok")).toThrow(/absolute/);
    expect(JSON.stringify({ args: buildGrokInvocationArguments({ role: "worker" }), env })).not.toMatch(
      /always-approve|yolo|plugin-dir|leader-socket|agent-profile|xai-api-base-url|cli-chat-proxy-base-url|serve|headless/
    );
  });

  it("serializes bounded startup and standing-prompt metadata on ACP, never argv", () => {
    const initialize = JSON.parse(serializeAcpInitialize({
      requestId: "init",
      clientName: "relayforge",
      clientVersion: "1.0.0-rc.1",
      meta: grokInitializeMeta()
    }).toString());
    expect(initialize.params._meta).toEqual({
      startupHints: { nonInteractive: true, skipGitStatus: true, skipProjectLayout: true },
      clientType: "relayforge",
      clientVersion: "1.0.0-rc.1"
    });
    const session = JSON.parse(serializeAcpNewSession({
      requestId: "new",
      cwd: "/workspace",
      meta: grokSessionMeta("standing instructions")
    }).toString());
    expect(session.params._meta).toEqual({ systemPromptOverride: "standing instructions" });
    expect(buildGrokInvocationArguments({ role: "worker" }).join(" ")).not.toContain("standing instructions");
    expect(() => grokSessionMeta("x".repeat(4 * 1024 * 1024 + 1))).toThrow(/bounded/);
    expect(() => grokSessionMeta("bad\0prompt")).toThrow(/NUL-free/);
  });

  it("requires the Grok-specific identity inside the standard ACP v1 initialize", () => {
    expect(decodeGrokInitializeResponse(frame(GROK_INITIALIZE_RESPONSE), "grok-initialize-1")).toMatchObject({
      status: "valid",
      value: { protocolVersion: "1", grokShell: true, agentVersion: "1.0.0" }
    });
    const foreign = structuredClone(GROK_INITIALIZE_RESPONSE) as Record<string, any>;
    foreign.result._meta.grokShell = false;
    expect(decodeGrokInitializeResponse(frame(foreign), "grok-initialize-1")).toMatchObject({ status: "invalid", code: "malformed-result" });
    expect(decodeGrokInitializeResponse(frame(GROK_INITIALIZE_RESPONSE), "foreign")).toMatchObject({ status: "invalid", code: "foreign-correlation" });
  });

  it("normalizes real-dialect ACP records and keeps missing accounting unknown", () => {
    const { events, result, fatal } = runTurn();
    expect(fatal).toBeUndefined();
    expect(result).toMatchObject({ status: "success", finalText: "contained Grok result", explicitLimit: false });
    expect(result).not.toHaveProperty("usage");
    expect(events.map((event) => event.kind)).toEqual(["assistant-delta", "assistant-final"]);

    const foreign = structuredClone(GROK_SUCCESS_RECORDS) as Array<Record<string, any>>;
    foreign[0]!.params.sessionId = "foreign";
    expect(runTurn(foreign).result).toMatchObject({ status: "uncertain", code: "foreign-correlation" });
    expect(runTurn([...GROK_SUCCESS_RECORDS, GROK_SUCCESS_RECORDS[1]!]).result).toMatchObject({ status: "uncertain", code: "duplicate-terminal" });
  });
});

describe("Grok behavioral availability", () => {
  it("requires exact build, auth, ACP behavior, privacy evidence and role proof", () => {
    const available = evaluateGrokProbe(completeProbe());
    expect(available).toMatchObject({ status: "available", observedExecutableVersion: "1.0.0", wireVersion: "1" });
    expect(evaluateAdapterRole(grokAdapterDescriptor, available, "worker")).toMatchObject({ status: "eligible" });
    expect(evaluateAdapterRole(grokAdapterDescriptor, available, "reviewer")).toMatchObject({ status: "eligible" });

    const cases: readonly [GrokProbeObservation, string][] = [
      [completeProbe({ executable: undefined }), "executable-missing"],
      [completeProbe({ executable: { ...completeProbe().executable!, buildCommit: "aaaaaaaaaa" } }), "version-unsupported"],
      [completeProbe({ apiKeyConfigured: false }), "auth-required"],
      [completeProbe({ wireVersion: "2" }), "wire-unsupported"],
      [completeProbe({ handshake: { grokShell: false, agentVersion: "1.0.0" } }), "protocol-drift"],
      [completeProbe({ trustedHelper: undefined }), "containment-incompatible"],
      [completeProbe({ egressEvidence: undefined }), "containment-incompatible"],
      [completeProbe({ safetyEvidence: undefined }), "containment-incompatible"],
      [completeProbe({ safetyEvidence: { configurationIsolationSha256: "b".repeat(64), networkToolPolicySha256: "b".repeat(64), unapprovedUploadDenialSha256: "b".repeat(64) } }), "containment-incompatible"],
      [completeProbe({ behavioralEvidenceSha256: {} }), "handshake-failed"]
    ];
    for (const [observation, code] of cases) {
      expect(evaluateGrokProbe(observation)).toMatchObject({ status: "unavailable", reason: { code } });
    }
  });

  it("fails reviewer eligibility when native write denial is not proven", () => {
    const observation = completeProbe({ capabilities: { ...completeProbe().capabilities!, innerReadOnly: undefined } });
    const availability = evaluateGrokProbe(observation);
    expect(availability.status).toBe("available");
    expect(evaluateAdapterRole(grokAdapterDescriptor, availability, "worker")).toMatchObject({ status: "eligible" });
    expect(evaluateAdapterRole(grokAdapterDescriptor, availability, "reviewer")).toMatchObject({
      status: "unavailable",
      refusal: { code: "inner-read-only-unproven" }
    });
  });
});

describe("required real Grok characterization", () => {
  it("requires parent-contained evidence when RELAYFORGE_TEST_REQUIRE_GROK=1; never directly spawns", () => {
    const required = process.env.RELAYFORGE_TEST_REQUIRE_GROK === "1";
    const evidenceFile = process.env.RELAYFORGE_TEST_GROK_CONTAINED_EVIDENCE_FILE;
    if (!required) {
      expect(evaluateGrokProbe({ probedAt: PROBED_AT, consultedConfigSha256: CONFIG_SHA })).toMatchObject({
        status: "unavailable",
        reason: { code: "executable-missing" }
      });
      return;
    }
    const commitSha = process.env.GITHUB_SHA ?? process.env.RELAYFORGE_TEST_EVIDENCE_COMMIT_SHA;
    const jobNonce = process.env.RELAYFORGE_TEST_EVIDENCE_JOB_NONCE;
    if (!evidenceFile || !commitSha || !jobNonce) {
      throw new Error(
        "RELAYFORGE_TEST_REQUIRE_GROK=1 requires a same-job RELAYFORGE_TEST_GROK_CONTAINED_EVIDENCE_FILE, checkout SHA, and RELAYFORGE_TEST_EVIDENCE_JOB_NONCE from the parent-owned production collector; direct spawn fallback is forbidden."
      );
    }
    const evidence = readContainedAdapterEvidenceFile(evidenceFile, {
      adapterId: "grok",
      commitSha,
      jobNonce,
      configurationSha256: containedAdapterProbeConfigurationSha256("grok"),
      now: new Date(),
      allowedRoot: dirname(evidenceFile)
    });
    expect(evaluateAdapterRole(grokAdapterDescriptor, evidence.availability, "reviewer").status).toBe("eligible");
    expect(Object.keys(evidence.checks).sort()).toEqual([
      "cancellationSettled",
      "configurationIsolated",
      "networkToolPolicyEnforced",
      "promptCompleted",
      "replayMatched",
      "reviewerWriteDenied",
      "scopeEmpty",
      "unapprovedUploadDenied"
    ]);
  });
});

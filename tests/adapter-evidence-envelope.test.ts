import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTAINED_ADAPTER_EVIDENCE_MAX_BYTES,
  canonicalContainedAdapterEvidenceJson,
  containedAdapterCheckNames,
  containedAdapterEvidenceReceiptDigest,
  parseContainedAdapterEvidence,
  readContainedAdapterEvidenceFile,
  type ContainedAdapterEvidenceExpectation,
  type ContainedAdapterEvidenceV1,
  type ContainedNativeAdapterId
} from "../src/adapters/contained-evidence.js";
import { getShippedAdapterDescriptor } from "../src/adapters/bootstrap.js";
import { defineAdapterAvailability } from "../src/adapters/registry.js";
import { inspectAdapterRuntimeFile } from "../src/adapters/runtime.js";
import type {
  AdapterAvailability,
  AdapterCapabilityName,
  BehavioralProbeCheck,
  CapabilityEvidenceSetInput,
  RuntimeFileEvidence
} from "../src/adapters/types.js";

const COMMIT = "a".repeat(40);
const NONCE = "b".repeat(64);
const CONFIG = "c".repeat(64);
const NOW = "2026-08-09T15:00:00.000Z";
const COLLECTED = "2026-08-09T14:59:30.000Z";
const EXPIRES = "2026-08-09T15:03:30.000Z";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

function privateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "relayforge-evidence-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function runtimeFiles(adapterId: ContainedNativeAdapterId): Readonly<{
  root: string;
  executable: RuntimeFileEvidence;
  helpers: readonly RuntimeFileEvidence[];
}> {
  const root = privateRoot();
  const executablePath = join(root, adapterId);
  writeFileSync(executablePath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const executable = inspectAdapterRuntimeFile(adapterId, executablePath, true);
  if (adapterId !== "pi" && adapterId !== "grok") return { root, executable, helpers: [] };
  const helperName = adapterId === "pi" ? "pi-relayforge-reviewer.mjs" : "grok-egress-relay.mjs";
  const helperPath = join(root, helperName);
  writeFileSync(helperPath, "export {};\n", { mode: 0o600 });
  return {
    root,
    executable,
    helpers: [inspectAdapterRuntimeFile(helperName, helperPath)]
  };
}

function capabilities(adapterId: ContainedNativeAdapterId): CapabilityEvidenceSetInput {
  const descriptor = getShippedAdapterDescriptor(adapterId);
  return Object.fromEntries((Object.entries(descriptor.capabilityPolicy) as [AdapterCapabilityName, string][]).map(([name, requirement]) => {
    if (requirement === "unsupported") {
      return [name, { status: "unsupported", source: "native-contract", detail: `${name} is unsupported` }];
    }
    if (name === "inner-read-only" || requirement === "required") {
      return [name, { status: "proven", source: "behavioral-probe", detail: `${name} was proven` }];
    }
    return [name, { status: "unknown", reason: "not-advertised", detail: `${name} was not advertised` }];
  })) as CapabilityEvidenceSetInput;
}

function availability(
  adapterId: ContainedNativeAdapterId,
  executable: RuntimeFileEvidence,
  helpers: readonly RuntimeFileEvidence[]
): Extract<AdapterAvailability, { status: "available" }> {
  const descriptor = getShippedAdapterDescriptor(adapterId);
  const behavioralChecks = descriptor.compatibility.behavioralProbe.requiredChecks.map((check) => ({
    check,
    outcome: "passed" as const,
    evidenceSha256: sha(`${adapterId}:behavior:${check}`)
  }));
  return defineAdapterAvailability(descriptor, {
    status: "available",
    binding: {
      adapterId,
      contractVersion: descriptor.contractVersion,
      normalizer: { ...descriptor.normalizer }
    },
    executable,
    trustedHelpers: helpers,
    observedExecutableVersion: descriptor.compatibility.executableVersion.minInclusive,
    supportedExecutableRange: { ...descriptor.compatibility.executableVersion },
    wireVersion: descriptor.compatibility.wireVersions[0]!,
    behavioralChecks,
    capabilities: capabilities(adapterId),
    probedAt: COLLECTED,
    consultedConfigSha256: CONFIG
  }) as Extract<AdapterAvailability, { status: "available" }>;
}

function mutableEnvelope(adapterId: ContainedNativeAdapterId): { root: string; value: Record<string, any> } {
  const runtime = runtimeFiles(adapterId);
  const available = availability(adapterId, runtime.executable, runtime.helpers);
  const behavioral = Object.fromEntries(available.behavioralChecks.map((entry) => [entry.check, entry.evidenceSha256])) as Partial<Record<BehavioralProbeCheck, string>>;
  const checks = Object.fromEntries(containedAdapterCheckNames[adapterId].map((name) => {
    const evidenceSha256 = name === "promptCompleted"
      ? behavioral["prompt-roundtrip"]!
      : name === "cancellationSettled"
        ? behavioral.cancellation!
        : name === "reviewerWriteDenied" && behavioral["read-only-denial"]
          ? behavioral["read-only-denial"]
          : name === "configurationIsolated"
            ? behavioral["configuration-isolation"]!
            : name === "networkToolPolicyEnforced"
              ? behavioral["network-tool-policy"]!
              : name === "unapprovedUploadDenied"
                ? behavioral["unapproved-upload-denial"]!
          : sha(`${adapterId}:conformance:${name}`);
    return [name, { passed: true, evidenceSha256 }];
  }));
  const value: Record<string, any> = {
    schemaVersion: 1,
    adapterId,
    commitSha: COMMIT,
    jobNonce: NONCE,
    collectedAt: COLLECTED,
    expiresAt: EXPIRES,
    configurationSha256: CONFIG,
    availability: available,
    runtime: { executable: runtime.executable, trustedHelpers: runtime.helpers },
    containment: {
      backend: "linux-cgroup-v2",
      scopeId: `probe:${adapterId}:normal-and-cancel`,
      normalExitReapedSha256: sha(`${adapterId}:normal-reap`),
      cancellationReapedSha256: sha(`${adapterId}:cancel-reap`)
    },
    settlement: {
      callId: `probe:${adapterId}:call`,
      terminal: true,
      costAuthority: "unknown",
      receiptDigest: sha(`${adapterId}:ledger-settlement`)
    },
    checks
  };
  value.receiptDigest = containedAdapterEvidenceReceiptDigest(value);
  return { root: runtime.root, value };
}

function expectation(adapterId: ContainedNativeAdapterId): ContainedAdapterEvidenceExpectation {
  return { adapterId, commitSha: COMMIT, jobNonce: NONCE, configurationSha256: CONFIG, now: NOW };
}

function reseal(value: Record<string, any>): Record<string, any> {
  const { receiptDigest: _discarded, ...payload } = value;
  return { ...payload, receiptDigest: containedAdapterEvidenceReceiptDigest(payload) };
}

function writeEnvelope(root: string, value: unknown, name = "evidence.json"): string {
  const path = join(root, name);
  writeFileSync(path, `${canonicalContainedAdapterEvidenceJson(value)}\n`, { mode: 0o600, flag: "wx" });
  return path;
}

describe("contained adapter evidence v1", () => {
  it.each(["opencode", "pi", "grok"] as const)("accepts and deeply freezes an exact fresh %s envelope", (adapterId) => {
    const { value } = mutableEnvelope(adapterId);
    const parsed = parseContainedAdapterEvidence(value, expectation(adapterId));
    expect(parsed).toMatchObject({ adapterId, schemaVersion: 1, configurationSha256: CONFIG });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.checks)).toBe(true);
  });

  it("rejects unknown, missing and malformed exact fields", () => {
    const { value } = mutableEnvelope("opencode");
    expect(() => parseContainedAdapterEvidence(reseal({ ...value, extra: true }), expectation("opencode"))).toThrow(/exactly/u);
    const { settlement: _missing, ...withoutSettlement } = value;
    expect(() => parseContainedAdapterEvidence(reseal(withoutSettlement), expectation("opencode"))).toThrow(/exactly/u);
    expect(() => parseContainedAdapterEvidence(reseal({ ...value, schemaVersion: 2 }), expectation("opencode"))).toThrow(/schemaVersion/u);
  });

  it("binds the exact adapter, checkout, nonce and configuration", () => {
    const { value } = mutableEnvelope("opencode");
    for (const [field, expected] of [
      ["adapterId", expectation("pi")],
      ["commitSha", { ...expectation("opencode"), commitSha: "d".repeat(40) }],
      ["jobNonce", { ...expectation("opencode"), jobNonce: "d".repeat(64) }],
      ["configurationSha256", { ...expectation("opencode"), configurationSha256: "d".repeat(64) }]
    ] as const) {
      expect(() => parseContainedAdapterEvidence(value, expected as ContainedAdapterEvidenceExpectation), field).toThrow();
    }
  });

  it("rejects bad outer receipts and all freshness boundary failures", () => {
    const { value } = mutableEnvelope("opencode");
    expect(() => parseContainedAdapterEvidence({ ...value, receiptDigest: "d".repeat(64) }, expectation("opencode"))).toThrow(/receiptDigest/u);
    for (const timestamps of [
      { collectedAt: "2026-08-09T15:00:31.000Z" },
      { expiresAt: COLLECTED },
      { expiresAt: "2026-08-09T15:04:31.000Z" },
      { collectedAt: "2026-08-09T14:50:00.000Z", expiresAt: "2026-08-09T14:55:00.000Z" },
      { collectedAt: "2026-08-09" }
    ]) {
      expect(() => parseContainedAdapterEvidence(reseal({ ...value, ...timestamps }), expectation("opencode"))).toThrow();
    }
  });

  it("rejects unavailable/role-ineligible and runtime-divergent evidence", () => {
    const { value } = mutableEnvelope("opencode");
    expect(() => parseContainedAdapterEvidence(reseal({ ...value, availability: { ...value.availability, status: "unavailable" } }), expectation("opencode"))).toThrow();
    const innerReadOnlyMissing = {
      ...value.availability,
      capabilities: {
        ...value.availability.capabilities,
        "inner-read-only": { status: "unknown", reason: "not-probed", detail: "not proven" }
      }
    };
    expect(() => parseContainedAdapterEvidence(reseal({ ...value, availability: innerReadOnlyMissing }), expectation("opencode"))).toThrow(/reviewer/u);
    expect(() => parseContainedAdapterEvidence(reseal({
      ...value,
      runtime: { ...value.runtime, executable: { ...value.runtime.executable, identity: "rf-v1:changed" } }
    }), expectation("opencode"))).toThrow(/runtime identity/u);
  });

  it("requires exact strong containment, distinct reap proof and terminal trusted/unknown settlement", () => {
    const { value } = mutableEnvelope("opencode");
    const cases = [
      { containment: { ...value.containment, backend: "pgid" } },
      { containment: { ...value.containment, cancellationReapedSha256: value.containment.normalExitReapedSha256 } },
      { settlement: { ...value.settlement, terminal: false } },
      { settlement: { ...value.settlement, costAuthority: "fallback" } }
    ];
    for (const change of cases) expect(() => parseContainedAdapterEvidence(reseal({ ...value, ...change }), expectation("opencode"))).toThrow();
  });

  it("requires the exact adapter check set, distinct evidence, and behavioral overlap", () => {
    const { value } = mutableEnvelope("grok");
    const { networkToolPolicyEnforced: _missing, ...missing } = value.checks;
    expect(() => parseContainedAdapterEvidence(reseal({ ...value, checks: missing }), expectation("grok"))).toThrow(/exactly/u);
    expect(() => parseContainedAdapterEvidence(reseal({
      ...value,
      checks: { ...value.checks, promptCompleted: value.checks.cancellationSettled }
    }), expectation("grok"))).toThrow();
    expect(() => parseContainedAdapterEvidence(reseal({
      ...value,
      checks: { ...value.checks, promptCompleted: { passed: true, evidenceSha256: sha("foreign-prompt") } }
    }), expectation("grok"))).toThrow(/promptCompleted/u);
    expect(() => parseContainedAdapterEvidence(reseal({
      ...value,
      checks: { ...value.checks, unapprovedUploadDenied: { passed: true, evidenceSha256: sha("foreign-upload") } }
    }), expectation("grok"))).toThrow(/unapprovedUploadDenied/u);
  });

  it("reads only a canonical private 0600 file under a private root and re-stats runtimes", () => {
    const { root, value } = mutableEnvelope("pi");
    const path = writeEnvelope(root, value);
    expect(readContainedAdapterEvidenceFile(path, { ...expectation("pi"), allowedRoot: root }).adapterId).toBe("pi");

    const loose = join(root, "loose.json");
    writeFileSync(loose, `${canonicalContainedAdapterEvidenceJson(value)}\n`, { mode: 0o644 });
    expect(() => readContainedAdapterEvidenceFile(loose, { ...expectation("pi"), allowedRoot: root })).toThrow(/0600/u);
  });

  it("rejects non-canonical/duplicate JSON and oversized files before trusting fields", () => {
    const { root, value } = mutableEnvelope("opencode");
    const duplicate = join(root, "duplicate.json");
    const canonical = canonicalContainedAdapterEvidenceJson(value);
    writeFileSync(duplicate, `${canonical.replace('"adapterId":"opencode"', '"adapterId":"opencode","adapterId":"opencode"')}\n`, { mode: 0o600 });
    expect(() => readContainedAdapterEvidenceFile(duplicate, { ...expectation("opencode"), allowedRoot: root })).toThrow(/canonical/u);

    const oversized = join(root, "oversized.json");
    writeFileSync(oversized, "x".repeat(CONTAINED_ADAPTER_EVIDENCE_MAX_BYTES + 1), { mode: 0o600 });
    expect(() => readContainedAdapterEvidenceFile(oversized, { ...expectation("opencode"), allowedRoot: root })).toThrow(/256 KiB/u);
  });

  it("rejects executable/helper replacement between collection and consumption", () => {
    const { root, value } = mutableEnvelope("pi");
    const path = writeEnvelope(root, value);
    writeFileSync(value.runtime.trustedHelpers[0].canonicalPath, "export const changed = true;\n", { mode: 0o600 });
    expect(() => readContainedAdapterEvidenceFile(path, { ...expectation("pi"), allowedRoot: root })).toThrow(/changed after collection/u);
  });

  it("rejects evidence outside its private root and a non-private parent", () => {
    const { root, value } = mutableEnvelope("opencode");
    const other = privateRoot();
    const path = writeEnvelope(other, value);
    expect(() => readContainedAdapterEvidenceFile(path, { ...expectation("opencode"), allowedRoot: root })).toThrow(/escapes/u);
    chmodSync(other, 0o755);
    expect(() => readContainedAdapterEvidenceFile(path, { ...expectation("opencode"), allowedRoot: other })).toThrow(/private/u);
  });
});

import { describe, expect, it } from "vitest";
import {
  ADAPTER_DESCRIPTOR_LIMITS,
  AdapterRegistryError,
  defineAdapterAvailability,
  defineAdapterDescriptor,
  evaluateAdapterRole
} from "../src/adapters/registry.js";
import {
  adapterCapabilityNames,
  type AdapterAvailabilityInput,
  type AdapterDescriptor,
  type AdapterDescriptorInput,
  type CapabilityEvidenceSetInput,
  type CapabilityPolicyInput
} from "../src/adapters/types.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const NOW = "2026-08-09T00:00:00.000Z";

function capabilityPolicy(overrides: Partial<CapabilityPolicyInput> = {}): CapabilityPolicyInput {
  return {
    "model-discovery": "optional",
    "session-create": "required",
    "session-resume": "optional",
    streaming: "required",
    cancellation: "optional",
    usage: "optional",
    cost: "optional",
    context: "optional",
    "rate-limits": "unsupported",
    steering: "optional",
    attachments: "unsupported",
    "inner-read-only": "optional",
    ...overrides
  };
}

function descriptorInput(overrides: Partial<AdapterDescriptorInput> = {}): AdapterDescriptorInput {
  return {
    schemaVersion: 1,
    contractVersion: 1,
    id: "pi-rpc",
    providerId: "pi",
    transportKind: "rpc-jsonl",
    runtimeIdentity: {
      kind: "installed-executable",
      executable: "pi",
      trustedHelpers: ["relayforge-pi-reviewer"],
      resolution: "canonical-installed-only"
    },
    compatibility: {
      executableVersion: { scheme: "semver", minInclusive: "0.84.0", maxExclusive: "0.85.0" },
      wireVersions: ["pi-rpc-v1"],
      behavioralProbe: {
        id: "pi-rpc-probe",
        version: 1,
        requiredChecks: ["executable-version", "transport-handshake", "state-query", "statistics-query"]
      }
    },
    invocationPolicy: {
      fixedArguments: ["--mode", "rpc", "--no-tools"],
      controlledOptions: [{ name: "session-dir", kind: "session-directory", required: true }],
      allowedEnvironmentNames: ["PI_API_KEY"],
      promptTransport: "stdin-jsonl",
      systemPromptChannel: "separate"
    },
    capabilityPolicy: capabilityPolicy(),
    codec: { id: "pi-rpc-jsonl", version: 1 },
    normalizer: { id: "pi-rpc-v1", version: 1 },
    roles: {
      worker: {
        status: "enabled",
        outerSandbox: "required",
        filesystem: "workspace-write",
        innerReadOnly: "not-required",
        requiredCapabilities: ["session-create", "streaming"]
      },
      reviewer: {
        status: "enabled",
        outerSandbox: "required",
        filesystem: "read-only",
        innerReadOnly: "required",
        requiredCapabilities: ["session-create", "streaming", "cancellation", "inner-read-only"]
      }
    },
    ...overrides
  };
}

function capabilityEvidence(
  overrides: Partial<Record<(typeof adapterCapabilityNames)[number], unknown>> = {}
): CapabilityEvidenceSetInput {
  const values = Object.fromEntries(adapterCapabilityNames.map((name) => {
    if (name === "rate-limits" || name === "attachments") {
      return [name, { status: "unsupported", source: "native-contract", detail: `${name} is not exposed` }];
    }
    if (name === "session-create" || name === "streaming") {
      return [name, { status: "proven", source: "behavioral-probe", detail: `${name} check passed` }];
    }
    return [name, { status: "unknown", reason: "not-probed", detail: `${name} was not required by this probe` }];
  }));
  return { ...values, ...overrides } as CapabilityEvidenceSetInput;
}

function availableInput(descriptor: AdapterDescriptor, capabilities = capabilityEvidence()): AdapterAvailabilityInput {
  return {
    status: "available",
    binding: {
      adapterId: descriptor.id,
      contractVersion: descriptor.contractVersion,
      normalizer: { ...descriptor.normalizer }
    },
    executable: {
      runtimeName: "pi",
      canonicalPath: "/usr/local/bin/pi",
      identity: "posix:1:200"
    },
    trustedHelpers: [{
      runtimeName: "relayforge-pi-reviewer",
      canonicalPath: "/usr/local/libexec/relayforge-pi-reviewer",
      identity: "sha256:reviewer-helper"
    }],
    observedExecutableVersion: "0.84.1",
    supportedExecutableRange: { ...descriptor.compatibility.executableVersion },
    wireVersion: "pi-rpc-v1",
    // Deliberately reverse the probe order; validated evidence is canonicalized to descriptor order.
    behavioralChecks: [...descriptor.compatibility.behavioralProbe.requiredChecks].reverse().map((check, index) => ({
      check,
      outcome: "passed" as const,
      evidenceSha256: index % 2 === 0 ? HASH_A : HASH_B
    })),
    capabilities,
    probedAt: NOW,
    consultedConfigSha256: HASH_A
  };
}

function unavailableInput(descriptor: AdapterDescriptor): AdapterAvailabilityInput {
  return {
    status: "unavailable",
    binding: {
      adapterId: descriptor.id,
      contractVersion: descriptor.contractVersion,
      normalizer: { ...descriptor.normalizer }
    },
    reason: {
      code: "executable-missing",
      detail: "The canonical pi runtime was not found.",
      retry: "after-install"
    },
    missingEvidence: [{ kind: "executable-identity", detail: "pi could not be resolved" }],
    probedAt: NOW,
    consultedConfigSha256: HASH_A
  };
}

function expectCode(action: () => unknown, code: AdapterRegistryError["code"]): void {
  try {
    action();
    throw new Error("expected AdapterRegistryError");
  } catch (error) {
    expect(error).toBeInstanceOf(AdapterRegistryError);
    expect((error as AdapterRegistryError).code).toBe(code);
  }
}

function expectFrozenTree(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const nested of Object.values(value)) expectFrozenTree(nested);
}

function expectDataOnly(value: unknown): void {
  expect(typeof value).not.toBe("function");
  if (value === null || typeof value !== "object") return;
  for (const nested of Object.values(value)) expectDataOnly(nested);
}

describe("adapter descriptor closed schema", () => {
  it("returns a deeply frozen, JSON-replayable, data-only descriptor", () => {
    const descriptor = defineAdapterDescriptor(descriptorInput());
    expectFrozenTree(descriptor);
    expectDataOnly(descriptor);
    expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor);
    expect(() => ((descriptor.invocationPolicy.fixedArguments as string[])[0] = "run")).toThrow();
    expect(() => ((descriptor.roles.reviewer as { status: string }).status = "unavailable")).toThrow();
  });

  it("rejects unknown root and nested authority-bearing fields", () => {
    const root = { ...descriptorInput(), spawn: () => undefined };
    const runtime = {
      ...descriptorInput(),
      runtimeIdentity: { ...descriptorInput().runtimeIdentity, command: "/bin/pi" }
    };
    const invocation = {
      ...descriptorInput(),
      invocationPolicy: { ...descriptorInput().invocationPolicy, shell: true, outputLimit: Number.MAX_SAFE_INTEGER }
    };
    for (const value of [root, runtime, invocation]) expectCode(() => defineAdapterDescriptor(value), "INVALID_DESCRIPTOR");
  });

  it("rejects getters before invoking them and rejects functions as data", () => {
    let invoked = false;
    const malicious = descriptorInput() as unknown as Record<string, unknown>;
    Object.defineProperty(malicious, "providerId", {
      enumerable: true,
      get() {
        invoked = true;
        throw new Error("getter ran");
      }
    });
    expectCode(() => defineAdapterDescriptor(malicious), "INVALID_DESCRIPTOR");
    expect(invoked).toBe(false);

    expectCode(() => defineAdapterDescriptor({
      ...descriptorInput(),
      invocationPolicy: { ...descriptorInput().invocationPolicy, fixedArguments: [() => undefined] }
    }), "INVALID_DESCRIPTOR");
  });

  it("forbids paths, shells, and package runners as runtime identities", () => {
    for (const executable of ["/usr/bin/pi", "../pi", "npx", "npm", "bash", "pwsh"]) {
      expectCode(() => defineAdapterDescriptor({
        ...descriptorInput(),
        runtimeIdentity: { ...descriptorInput().runtimeIdentity, executable }
      }), "INVALID_DESCRIPTOR");
    }
  });

  it("enforces descriptor byte/count bounds without truncation", () => {
    const exactArgument = "a".repeat(ADAPTER_DESCRIPTOR_LIMITS.maxArgumentBytes);
    expect(defineAdapterDescriptor({
      ...descriptorInput(),
      invocationPolicy: { ...descriptorInput().invocationPolicy, fixedArguments: [exactArgument] }
    }).invocationPolicy.fixedArguments[0]).toHaveLength(ADAPTER_DESCRIPTOR_LIMITS.maxArgumentBytes);

    expectCode(() => defineAdapterDescriptor({
      ...descriptorInput(),
      invocationPolicy: { ...descriptorInput().invocationPolicy, fixedArguments: [`${exactArgument}a`] }
    }), "INVALID_DESCRIPTOR");
    expectCode(() => defineAdapterDescriptor({ ...descriptorInput(), id: `a${"b".repeat(64)}` }), "INVALID_DESCRIPTOR");
    expectCode(() => defineAdapterDescriptor({
      ...descriptorInput(),
      compatibility: {
        ...descriptorInput().compatibility,
        wireVersions: Array.from({ length: ADAPTER_DESCRIPTOR_LIMITS.maxWireVersions + 1 }, (_, index) => `v${index}`)
      }
    }), "INVALID_DESCRIPTOR");
  });

  it("requires bounded behavioral compatibility, not version text alone", () => {
    const variants = [
      { requiredChecks: ["executable-version"] },
      { requiredChecks: ["transport-handshake"] },
      { requiredChecks: ["executable-version", "transport-handshake", "transport-handshake"] },
      { requiredChecks: ["executable-version", "transport-handshake", "future-probe"] }
    ];
    for (const behavioralProbe of variants) {
      expectCode(() => defineAdapterDescriptor({
        ...descriptorInput(),
        compatibility: {
          ...descriptorInput().compatibility,
          behavioralProbe: { id: "probe", version: 1, ...behavioralProbe } as never
        }
      }), "INVALID_DESCRIPTOR");
    }
  });

  it("separates ACP wire v1 from artifact versions and enforces transport prompt shape", () => {
    const acp: AdapterDescriptorInput = {
      ...descriptorInput(),
      transportKind: "acp-v1",
      compatibility: { ...descriptorInput().compatibility, wireVersions: ["2"] },
      invocationPolicy: { ...descriptorInput().invocationPolicy, promptTransport: "stdio-jsonrpc" }
    };
    expectCode(() => defineAdapterDescriptor(acp), "INVALID_DESCRIPTOR");
    expectCode(() => defineAdapterDescriptor({
      ...descriptorInput(),
      invocationPolicy: { ...descriptorInput().invocationPolicy, promptTransport: "stdin-text" }
    }), "INVALID_DESCRIPTOR");
  });

  it("requires a complete capability policy and coherent worker/reviewer restrictions", () => {
    const missing = { ...capabilityPolicy() } as Record<string, unknown>;
    delete missing.usage;
    const extra = { ...capabilityPolicy(), arbitrary: "optional" };
    const wrongReviewer = {
      ...descriptorInput().roles,
      reviewer: { ...descriptorInput().roles.reviewer, filesystem: "workspace-write" }
    };
    const unsupportedRequired = {
      ...descriptorInput().roles,
      worker: { ...descriptorInput().roles.worker, requiredCapabilities: ["rate-limits"] }
    };
    for (const value of [
      { ...descriptorInput(), capabilityPolicy: missing },
      { ...descriptorInput(), capabilityPolicy: extra },
      { ...descriptorInput(), roles: wrongReviewer },
      { ...descriptorInput(), roles: unsupportedRequired }
    ]) {
      expectCode(() => defineAdapterDescriptor(value), "INVALID_DESCRIPTOR");
    }
  });
});

describe("closed compatibility and capability evidence", () => {
  it("accepts complete evidence, canonicalizes probe order, and freezes a defensive copy", () => {
    const descriptor = defineAdapterDescriptor(descriptorInput());
    const input = availableInput(descriptor);
    const availability = defineAdapterAvailability(descriptor, input);
    expect(availability.status).toBe("available");
    if (availability.status !== "available") throw new Error("unreachable");
    expect(availability.behavioralChecks.map((entry) => entry.check)).toEqual(
      descriptor.compatibility.behavioralProbe.requiredChecks
    );
    expect(availability.capabilities.usage.status).toBe("unknown");
    expect("usd" in availability.capabilities.usage).toBe(false);
    expectFrozenTree(availability);

    (input.behavioralChecks as Array<{ evidenceSha256: string }>)[0]!.evidenceSha256 = "c".repeat(64);
    expect(availability.behavioralChecks.some((entry) => entry.evidenceSha256 === "c".repeat(64))).toBe(false);
  });

  it("requires exactly one explicit state for every capability", () => {
    const descriptor = defineAdapterDescriptor(descriptorInput());
    const missing = { ...capabilityEvidence() } as Record<string, unknown>;
    delete missing.cost;
    const extra = { ...capabilityEvidence(), shellAccess: { status: "proven", source: "behavioral-probe", detail: "bad" } };
    const booleanState = { ...capabilityEvidence(), usage: true };
    const authorityField = {
      ...capabilityEvidence(),
      usage: { status: "unknown", reason: "not-probed", detail: "unknown", usd: 0 }
    };
    for (const capabilities of [missing, extra, booleanState, authorityField]) {
      expectCode(() => defineAdapterAvailability(descriptor, {
        ...(availableInput(descriptor) as Record<string, unknown>),
        capabilities
      }), "INVALID_EVIDENCE");
    }
  });

  it("keeps evidence provenance closed and enforces UTF-8 detail bounds", () => {
    const descriptor = defineAdapterDescriptor(descriptorInput());
    const invalidUnsupportedSource = capabilityEvidence({
      attachments: { status: "unsupported", source: "behavioral-probe", detail: "absence guessed from a probe" }
    });
    expectCode(() => defineAdapterAvailability(descriptor, availableInput(descriptor, invalidUnsupportedSource)), "INVALID_EVIDENCE");

    const exactDetail = "😀".repeat(ADAPTER_DESCRIPTOR_LIMITS.maxEvidenceDetailBytes / 4);
    const exact = defineAdapterAvailability(descriptor, availableInput(descriptor, capabilityEvidence({
      usage: { status: "unknown", reason: "not-probed", detail: exactDetail }
    })));
    expect(exact.status === "available" && Buffer.byteLength(exact.capabilities.usage.detail, "utf8")).toBe(
      ADAPTER_DESCRIPTOR_LIMITS.maxEvidenceDetailBytes
    );
    expectCode(() => defineAdapterAvailability(descriptor, availableInput(descriptor, capabilityEvidence({
      usage: { status: "unknown", reason: "not-probed", detail: `${exactDetail}😀` }
    }))), "INVALID_EVIDENCE");
  });

  it("will not mark an adapter available without globally required capability proof", () => {
    const descriptor = defineAdapterDescriptor(descriptorInput());
    for (const evidence of [
      { status: "unknown", reason: "probe-inconclusive", detail: "no terminal" },
      { status: "unsupported", source: "native-contract", detail: "missing" }
    ]) {
      expectCode(() => defineAdapterAvailability(descriptor, availableInput(descriptor, capabilityEvidence({
        "session-create": evidence
      }))), "INVALID_EVIDENCE");
    }
  });

  it("rejects false availability from unsupported versions, wires, helpers, or partial handshakes", () => {
    const descriptor = defineAdapterDescriptor(descriptorInput());
    const base = availableInput(descriptor) as Record<string, unknown>;
    const checks = (base.behavioralChecks as unknown[]).slice(1);
    const variants: Record<string, unknown>[] = [
      { ...base, observedExecutableVersion: "0.85.0" },
      { ...base, wireVersion: "pi-rpc-v2" },
      { ...base, trustedHelpers: [] },
      { ...base, behavioralChecks: checks },
      { ...base, consultedConfigSha256: "not-a-hash" },
      { ...base, probedAt: "2026-99-99T00:00:00.000Z" }
    ];
    for (const value of variants) expectCode(() => defineAdapterAvailability(descriptor, value), "INVALID_EVIDENCE");
  });

  it("rejects evidence for the wrong descriptor, contract, or normalizer", () => {
    const descriptor = defineAdapterDescriptor(descriptorInput());
    const base = availableInput(descriptor) as Record<string, unknown>;
    for (const binding of [
      { ...(base.binding as object), adapterId: "another" },
      { ...(base.binding as object), contractVersion: 2 },
      { ...(base.binding as { normalizer: object }), normalizer: { id: "other", version: 1 } }
    ]) {
      expectCode(() => defineAdapterAvailability(descriptor, { ...base, binding }), "INVALID_EVIDENCE");
    }
  });

  it("preserves unavailable evidence as a discriminated, immutable reason", () => {
    const descriptor = defineAdapterDescriptor(descriptorInput());
    const availability = defineAdapterAvailability(descriptor, unavailableInput(descriptor));
    expect(availability).toMatchObject({
      status: "unavailable",
      reason: { code: "executable-missing", retry: "after-install" },
      missingEvidence: [{ kind: "executable-identity" }]
    });
    expect("capabilities" in availability).toBe(false);
    expectFrozenTree(availability);
  });

  it("round-trips evidence without changing parser or capability meaning", () => {
    const descriptor = defineAdapterDescriptor(descriptorInput());
    const first = defineAdapterAvailability(descriptor, availableInput(descriptor));
    const replayed = defineAdapterAvailability(descriptor, JSON.parse(JSON.stringify(first)));
    expect(replayed).toEqual(first);
  });
});

describe("role policy", () => {
  it("treats role eligibility as a sandbox requirement, never as containment proof", () => {
    const descriptor = defineAdapterDescriptor(descriptorInput());
    const capabilities = capabilityEvidence({
      cancellation: { status: "proven", source: "behavioral-probe", detail: "abort confirmed" },
      "inner-read-only": { status: "proven", source: "behavioral-probe", detail: "write denied" }
    });
    const availability = defineAdapterAvailability(descriptor, availableInput(descriptor, capabilities));
    expect(evaluateAdapterRole(descriptor, availability, "worker")).toEqual({
      status: "eligible",
      role: "worker",
      outerSandbox: "required",
      filesystem: "workspace-write",
      innerReadOnly: "not-required",
      requiredCapabilities: ["session-create", "streaming"]
    });
    expect(evaluateAdapterRole(descriptor, availability, "reviewer")).toMatchObject({
      status: "eligible",
      role: "reviewer",
      outerSandbox: "required",
      filesystem: "read-only",
      innerReadOnly: "required"
    });
  });

  it("refuses reviewer policy instead of silently dropping missing cancellation/read-only proof", () => {
    const descriptor = defineAdapterDescriptor(descriptorInput());
    const availability = defineAdapterAvailability(descriptor, availableInput(descriptor));
    expect(evaluateAdapterRole(descriptor, availability, "worker").status).toBe("eligible");
    expect(evaluateAdapterRole(descriptor, availability, "reviewer")).toEqual({
      status: "unavailable",
      role: "reviewer",
      refusal: {
        code: "inner-read-only-unproven",
        detail: "Required capability evidence is not proven: cancellation, inner-read-only.",
        missingCapabilities: ["cancellation", "inner-read-only"]
      }
    });
  });

  it("propagates compatibility unavailability before considering role capabilities", () => {
    const descriptor = defineAdapterDescriptor(descriptorInput());
    const unavailable = defineAdapterAvailability(descriptor, unavailableInput(descriptor));
    expect(evaluateAdapterRole(descriptor, unavailable, "reviewer")).toMatchObject({
      status: "unavailable",
      refusal: { code: "adapter-unavailable", missingCapabilities: [] }
    });
  });

  it("honors an explicit static role refusal", () => {
    const descriptor = defineAdapterDescriptor(descriptorInput({
      roles: {
        ...descriptorInput().roles,
        reviewer: {
          status: "unavailable",
          refusal: { code: "role-unsupported", detail: "No provider-native reviewer policy exists." }
        }
      }
    }));
    const availability = defineAdapterAvailability(descriptor, availableInput(descriptor));
    expect(evaluateAdapterRole(descriptor, availability, "reviewer")).toEqual({
      status: "unavailable",
      role: "reviewer",
      refusal: {
        code: "role-unsupported",
        detail: "No provider-native reviewer policy exists.",
        missingCapabilities: []
      }
    });
  });
});

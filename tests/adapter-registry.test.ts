import { describe, expect, it } from "vitest";
import {
  ADAPTER_DESCRIPTOR_LIMITS,
  AdapterRegistryError,
  createAdapterRegistry,
  createAdapterReplayBinding,
  defineAdapterDescriptor,
  isExecutableVersionSupported,
  parseNativeSessionId
} from "../src/adapters/registry.js";
import {
  ADAPTER_CONTRACT_VERSION,
  ADAPTER_DESCRIPTOR_SCHEMA_VERSION,
  adapterCapabilityNames,
  type AdapterDescriptorInput,
  type CapabilityPolicyInput
} from "../src/adapters/types.js";

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

function descriptor(id = "opencode", providerId = "opencode"): AdapterDescriptorInput {
  return {
    schemaVersion: ADAPTER_DESCRIPTOR_SCHEMA_VERSION,
    contractVersion: ADAPTER_CONTRACT_VERSION,
    id,
    providerId,
    transportKind: "acp-v1",
    runtimeIdentity: {
      kind: "installed-executable",
      executable: "opencode",
      trustedHelpers: [],
      resolution: "canonical-installed-only"
    },
    compatibility: {
      executableVersion: { scheme: "semver", minInclusive: "1.18.0", maxExclusive: "1.19.0" },
      wireVersions: ["1"],
      behavioralProbe: {
        id: "opencode-acp-probe",
        version: 1,
        requiredChecks: ["executable-version", "transport-handshake", "session-create"]
      }
    },
    invocationPolicy: {
      fixedArguments: ["acp"],
      controlledOptions: [{ name: "inline-policy", kind: "inline-config", required: true }],
      allowedEnvironmentNames: ["OPENCODE_CONFIG_CONTENT"],
      promptTransport: "stdio-jsonrpc",
      systemPromptChannel: "separate"
    },
    capabilityPolicy: capabilityPolicy(),
    codec: { id: "acp-v1", version: 1 },
    normalizer: { id: "opencode-acp-v1", version: 1 },
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
    }
  };
}

function expectRegistryCode(action: () => unknown, code: AdapterRegistryError["code"]): void {
  try {
    action();
    throw new Error("expected AdapterRegistryError");
  } catch (error) {
    expect(error).toBeInstanceOf(AdapterRegistryError);
    expect((error as AdapterRegistryError).code).toBe(code);
  }
}

describe("immutable adapter registry", () => {
  it("sorts its snapshot deterministically and provides stable lookups", () => {
    const registry = createAdapterRegistry([
      descriptor("zeta", "shared-provider"),
      descriptor("alpha", "shared-provider")
    ]);

    expect(registry.ids).toEqual(["alpha", "zeta"]);
    expect(registry.get("alpha").providerId).toBe("shared-provider");
    expect(registry.maybeGet("missing")).toBeUndefined();
    expect(registry.has("zeta")).toBe(true);
    expect(registry.forProvider("shared-provider").map((entry) => entry.id)).toEqual(["alpha", "zeta"]);
    expect(registry.forProvider("missing")).toEqual([]);
  });

  it("rejects duplicate adapter IDs even when the descriptor objects differ", () => {
    expectRegistryCode(
      () => createAdapterRegistry([descriptor("same", "provider-a"), descriptor("same", "provider-b")]),
      "DUPLICATE_ADAPTER"
    );
  });

  it("enforces the global registry cardinality bound before accepting descriptors", () => {
    const exact = Array.from({ length: ADAPTER_DESCRIPTOR_LIMITS.maxDescriptors }, (_, index) =>
      descriptor(`adapter-${index}`, "provider")
    );
    expect(createAdapterRegistry(exact).descriptors).toHaveLength(ADAPTER_DESCRIPTOR_LIMITS.maxDescriptors);
    expectRegistryCode(
      () => createAdapterRegistry([...exact, descriptor("one-too-many", "provider")]),
      "INVALID_DESCRIPTOR"
    );
  });

  it("rejects unknown IDs with a stable typed error and never guesses", () => {
    const registry = createAdapterRegistry([descriptor()]);
    expectRegistryCode(() => registry.get("open-code"), "UNKNOWN_ADAPTER");
    expectRegistryCode(() => registry.resolveReplay({
      adapterId: "open-code",
      contractVersion: 1,
      transportKind: "acp-v1",
      wireVersion: "1",
      codec: { id: "acp-v1", version: 1 },
      normalizer: { id: "opencode-acp-v1", version: 1 }
    }), "UNKNOWN_ADAPTER");
  });

  it("has no mutation/registration surface and exposes frozen snapshots", () => {
    const registry = createAdapterRegistry([descriptor()]);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.descriptors)).toBe(true);
    expect(Object.isFrozen(registry.ids)).toBe(true);
    expect("register" in registry).toBe(false);
    expect(() => (registry.descriptors as unknown[]).push(descriptor())).toThrow();
    expect(() => (registry.ids as unknown[]).push("pi")).toThrow();
  });

  it("defensively copies descriptor input before retaining it", () => {
    const input = descriptor();
    const fixedArguments = input.invocationPolicy.fixedArguments as string[];
    const requiredChecks = input.compatibility.behavioralProbe.requiredChecks as string[];
    const registry = createAdapterRegistry([input]);

    fixedArguments[0] = "run";
    requiredChecks[0] = "accounting";

    expect(registry.get("opencode").invocationPolicy.fixedArguments).toEqual(["acp"]);
    expect(registry.get("opencode").compatibility.behavioralProbe.requiredChecks[0]).toBe("executable-version");
  });

  it("resolves replay only when every recorded parser identity is exact", () => {
    const registry = createAdapterRegistry([descriptor()]);
    const selected = registry.get("opencode");
    const binding = createAdapterReplayBinding(selected, "1");
    expect(registry.resolveReplay(binding)).toBe(selected);
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding.codec)).toBe(true);

    const mutations = [
      { ...binding, contractVersion: 2 },
      { ...binding, transportKind: "rpc-jsonl" },
      { ...binding, wireVersion: "2" },
      { ...binding, codec: { ...binding.codec, version: 2 } },
      { ...binding, normalizer: { ...binding.normalizer, id: "generic" } }
    ];
    for (const mutation of mutations) {
      expectRegistryCode(() => registry.resolveReplay(mutation as never), "REPLAY_BINDING_MISMATCH");
    }
    expectRegistryCode(() => createAdapterReplayBinding(selected, "2"), "REPLAY_BINDING_MISMATCH");
  });

  it("accepts multiple descriptors for one provider but keeps adapter identity distinct", () => {
    const acp = descriptor("provider-acp", "provider");
    const legacy: AdapterDescriptorInput = {
      ...descriptor("provider-legacy", "provider"),
      transportKind: "oneshot-jsonl",
      compatibility: {
        ...descriptor().compatibility,
        wireVersions: ["legacy-jsonl-v1"]
      },
      invocationPolicy: {
        ...descriptor().invocationPolicy,
        fixedArguments: ["--json"],
        promptTransport: "stdin-text"
      }
    };
    const registry = createAdapterRegistry([legacy, acp]);
    expect(registry.forProvider("provider").map((entry) => entry.id)).toEqual(["provider-acp", "provider-legacy"]);
  });
});

describe("version and identity helpers", () => {
  it("applies exact inclusive/exclusive semver boundaries and prerelease precedence", () => {
    const range = defineAdapterDescriptor(descriptor()).compatibility.executableVersion;
    expect(isExecutableVersionSupported("1.18.0", range)).toBe(true);
    expect(isExecutableVersionSupported("1.18.99", range)).toBe(true);
    expect(isExecutableVersionSupported("1.19.0-beta.1", range)).toBe(true);
    expect(isExecutableVersionSupported("1.17.99", range)).toBe(false);
    expect(isExecutableVersionSupported("1.19.0", range)).toBe(false);
    expect(isExecutableVersionSupported("v1.18.15", range)).toBe(false);
    expect(isExecutableVersionSupported("1.18", range)).toBe(false);
  });

  it("brands only bounded, canonical native session IDs", () => {
    expect(parseNativeSessionId("session:abc/turn-1")).toBe("session:abc/turn-1");
    for (const value of ["", "../session", " session", "session\0evil", "a".repeat(513), 42]) {
      expectRegistryCode(() => parseNativeSessionId(value), "INVALID_EVIDENCE");
    }
  });

  it("exports one complete closed capability vocabulary", () => {
    expect(adapterCapabilityNames).toHaveLength(12);
    expect(new Set(adapterCapabilityNames).size).toBe(adapterCapabilityNames.length);
    expect(adapterCapabilityNames).toContain("inner-read-only");
    expect(adapterCapabilityNames).toContain("rate-limits");
  });
});

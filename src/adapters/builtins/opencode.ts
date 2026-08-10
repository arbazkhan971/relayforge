import {
  defineAdapterAvailability,
  defineAdapterDescriptor,
  isExecutableVersionSupported
} from "../registry.js";
import {
  ADAPTER_CONTRACT_VERSION,
  ADAPTER_DESCRIPTOR_SCHEMA_VERSION,
  type AdapterAvailability,
  type AdapterCapabilityName,
  type AdapterDescriptor,
  type BehavioralProbeCheck,
  type CapabilityEvidence,
  type CapabilityEvidenceSetInput
} from "../types.js";
import { boundedIdentifier, serializeJsonLine } from "../codec.js";

export const OPENCODE_AUDITED_VERSION = "1.18.15" as const;
export const OPENCODE_ACP_WIRE_VERSION = "1" as const;
export const OPENCODE_CONFIG_CONTENT_ENV = "OPENCODE_CONFIG_CONTENT" as const;
export const OPENCODE_RELAYFORGE_AGENT = "relayforge" as const;

/**
 * Immutable native OpenCode ACP descriptor.
 *
 * It describes only the fixed `acp` argv fragment. It does not resolve or
 * launch the executable, choose containment, read files, or settle evidence.
 */
export const opencodeAdapterDescriptor: AdapterDescriptor = defineAdapterDescriptor({
  schemaVersion: ADAPTER_DESCRIPTOR_SCHEMA_VERSION,
  contractVersion: ADAPTER_CONTRACT_VERSION,
  id: "opencode",
  providerId: "opencode",
  transportKind: "acp-v1",
  runtimeIdentity: {
    kind: "installed-executable",
    executable: "opencode",
    trustedHelpers: [],
    resolution: "canonical-installed-only"
  },
  compatibility: {
    executableVersion: {
      scheme: "semver",
      minInclusive: OPENCODE_AUDITED_VERSION,
      maxExclusive: "1.18.16"
    },
    wireVersions: [OPENCODE_ACP_WIRE_VERSION],
    behavioralProbe: {
      id: "opencode-acp-1.18.15",
      version: 1,
      requiredChecks: [
        "executable-version",
        "transport-handshake",
        "framing",
        "session-create",
        "prompt-roundtrip",
        "cancellation",
        "read-only-denial",
        "accounting"
      ]
    }
  },
  invocationPolicy: {
    fixedArguments: ["acp"],
    controlledOptions: [
      { name: "inline-policy", kind: "inline-config", required: true },
      { name: "model", kind: "model", required: false },
      { name: "mode", kind: "mode", required: false }
    ],
    allowedEnvironmentNames: [OPENCODE_CONFIG_CONTENT_ENV],
    promptTransport: "stdio-jsonrpc",
    systemPromptChannel: "separate"
  },
  capabilityPolicy: {
    "model-discovery": "optional",
    "session-create": "required",
    "session-resume": "optional",
    streaming: "required",
    cancellation: "required",
    usage: "optional",
    cost: "optional",
    context: "optional",
    "rate-limits": "unsupported",
    steering: "optional",
    attachments: "optional",
    "inner-read-only": "optional"
  },
  codec: { id: "acp-v1", version: 1 },
  normalizer: { id: "opencode-acp-v1-1.18.15", version: 1 },
  roles: {
    worker: {
      status: "enabled",
      outerSandbox: "required",
      filesystem: "workspace-write",
      innerReadOnly: "not-required",
      requiredCapabilities: ["session-create", "streaming", "cancellation"]
    },
    reviewer: {
      status: "enabled",
      outerSandbox: "required",
      filesystem: "read-only",
      innerReadOnly: "required",
      requiredCapabilities: ["session-create", "streaming", "cancellation", "inner-read-only"]
    }
  }
});

export type OpenCodeRole = "worker" | "reviewer";

export type OpenCodeConfigOverlayInput = Readonly<{
  role: OpenCodeRole;
  systemPrompt: string;
  /** Existing OPENCODE_CONFIG_CONTENT. Unknown safe keys are retained. */
  existingConfigContent?: string;
}>;

const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_CONFIG_DEPTH = 32;
const MAX_CONFIG_NODES = 20_000;
const FORBIDDEN_CONFIG_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function configObject(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function validateConfigTree(value: unknown): void {
  let nodes = 0;
  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_CONFIG_NODES) throw new TypeError("OpenCode inline configuration is too complex");
    if (depth > MAX_CONFIG_DEPTH) throw new TypeError("OpenCode inline configuration is too deeply nested");
    if (current === null || typeof current === "string" || typeof current === "boolean") return;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new TypeError("OpenCode inline configuration contains a non-finite number");
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
      return;
    }
    if (typeof current !== "object") throw new TypeError("OpenCode inline configuration contains a non-JSON value");
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      if (FORBIDDEN_CONFIG_KEYS.has(key)) throw new TypeError(`OpenCode inline configuration key ${JSON.stringify(key)} is forbidden`);
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
}

function parseExistingConfig(content: string | undefined): Record<string, unknown> {
  if (content === undefined || content.trim() === "") return {};
  if (content.includes("\0")) throw new TypeError("OpenCode inline configuration must be NUL-free");
  if (Buffer.byteLength(content, "utf8") > MAX_CONFIG_BYTES) throw new TypeError("OpenCode inline configuration exceeds the byte limit");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new TypeError("OpenCode inline configuration must be valid JSON");
  }
  const root = configObject(parsed, "OpenCode inline configuration");
  validateConfigTree(root);
  return root;
}

const WORKER_PERMISSION = Object.freeze({
  edit: "ask",
  bash: "ask",
  task: "ask",
  webfetch: "ask",
  external_directory: "deny"
});

const REVIEWER_PERMISSION = Object.freeze({
  edit: "deny",
  bash: "deny",
  task: "deny",
  webfetch: "deny",
  external_directory: "deny"
});

/**
 * Build the sole parent-controlled environment overlay for `opencode acp`.
 * The reserved RelayForge agent always wins over same-named user data; all
 * unrelated, JSON-safe inline configuration is preserved.
 */
export function buildOpenCodeConfigOverlay(input: OpenCodeConfigOverlayInput): Readonly<Record<typeof OPENCODE_CONFIG_CONTENT_ENV, string>> {
  if (input.role !== "worker" && input.role !== "reviewer") throw new TypeError("OpenCode role must be worker or reviewer");
  if (typeof input.systemPrompt !== "string" || input.systemPrompt.includes("\0")) {
    throw new TypeError("OpenCode system prompt must be a NUL-free string");
  }
  if (Buffer.byteLength(input.systemPrompt, "utf8") > MAX_CONFIG_BYTES) throw new TypeError("OpenCode system prompt exceeds the byte limit");
  const existing = parseExistingConfig(input.existingConfigContent);
  const existingAgents = existing.agent === undefined ? {} : configObject(existing.agent, "OpenCode inline configuration agent");
  const permission = input.role === "reviewer" ? REVIEWER_PERMISSION : WORKER_PERMISSION;
  const config = {
    ...existing,
    agent: {
      ...existingAgents,
      [OPENCODE_RELAYFORGE_AGENT]: {
        description: "RelayForge parent-controlled session agent",
        mode: "primary",
        prompt: input.systemPrompt,
        permission
      }
    },
    default_agent: OPENCODE_RELAYFORGE_AGENT
  };
  const serialized = JSON.stringify(config);
  if (Buffer.byteLength(serialized, "utf8") > MAX_CONFIG_BYTES) throw new TypeError("OpenCode inline configuration exceeds the byte limit");
  return Object.freeze({ [OPENCODE_CONFIG_CONTENT_ENV]: serialized });
}

export type OpenCodePermissionDecision =
  | Readonly<{ outcome: "selected"; optionId: string }>
  | Readonly<{ outcome: "rejected" }>;

/**
 * Serialize a permission response without ever treating a callback as
 * containment. Reviewer requests and missing/failed worker selection are
 * rejected using ACP's cancelled outcome; only an explicit worker option can
 * be selected.
 */
export function serializeOpenCodePermissionResponse(input: Readonly<{
  requestId: string;
  role: OpenCodeRole;
  decision: OpenCodePermissionDecision;
}>): Buffer {
  const requestId = boundedIdentifier(input.requestId, "requestId");
  if (!requestId) throw new TypeError("requestId must be a bounded non-empty identifier");
  if (input.role !== "worker" && input.role !== "reviewer") throw new TypeError("OpenCode role must be worker or reviewer");
  const canSelect = input.role === "worker" && input.decision.outcome === "selected";
  const outcome = canSelect
    ? { outcome: "selected", optionId: boundedIdentifier(input.decision.optionId, "optionId") }
    : { outcome: "cancelled" };
  if (canSelect && !outcome.optionId) throw new TypeError("optionId must be a bounded non-empty identifier");
  return serializeJsonLine({ jsonrpc: "2.0", id: requestId, result: { outcome } });
}

export type OpenCodeNegotiatedCapabilities = Readonly<{
  modelDiscovery?: boolean;
  sessionCreate: boolean;
  sessionResume?: boolean;
  streaming: boolean;
  cancellation: boolean;
  usage?: boolean;
  cost?: boolean;
  context?: boolean;
  steering?: boolean;
  attachments?: boolean;
  innerReadOnly?: boolean;
}>;

export type OpenCodeProbeObservation = Readonly<{
  executable?: Readonly<{
    canonicalPath: string;
    identity: string;
    version: string;
  }>;
  wireVersion?: string;
  /** Hashes of externally observed, parent-contained behavioral exchanges. */
  behavioralEvidenceSha256?: Partial<Readonly<Record<BehavioralProbeCheck, string>>>;
  capabilities?: OpenCodeNegotiatedCapabilities;
  probedAt: string;
  consultedConfigSha256: string;
}>;

function probeBinding() {
  return {
    adapterId: opencodeAdapterDescriptor.id,
    contractVersion: opencodeAdapterDescriptor.contractVersion,
    normalizer: { ...opencodeAdapterDescriptor.normalizer }
  } as const;
}

function unavailable(
  input: OpenCodeProbeObservation,
  code: "executable-missing" | "executable-identity-changed" | "version-unparseable" | "version-unsupported" | "handshake-failed" | "wire-unsupported" | "required-capability-missing" | "protocol-drift",
  detail: string,
  retry: "after-install" | "after-provider-update" | "after-config-change" | "transient",
  missingEvidence: readonly Readonly<{
    kind: "executable-identity" | "executable-version" | "behavioral-check" | "wire-version" | "capability" | "contained-loopback";
    detail: string;
  }>[]
): AdapterAvailability {
  return defineAdapterAvailability(opencodeAdapterDescriptor, {
    status: "unavailable",
    binding: probeBinding(),
    reason: { code, detail, retry },
    missingEvidence,
    ...(input.executable?.version === undefined ? {} : { observedExecutableVersion: input.executable.version }),
    ...(input.wireVersion === undefined ? {} : { observedWireVersion: input.wireVersion }),
    probedAt: input.probedAt,
    consultedConfigSha256: input.consultedConfigSha256
  });
}

function capabilityEvidence(
  value: boolean | undefined,
  detail: string,
  provenSource: "behavioral-probe" | "protocol-negotiation" | "native-contract" = "protocol-negotiation",
  unsupportedSource: "protocol-negotiation" | "native-contract" = "protocol-negotiation"
): CapabilityEvidence {
  if (value === true) return Object.freeze({ status: "proven", source: provenSource, detail });
  if (value === false) return Object.freeze({ status: "unsupported", source: unsupportedSource, detail });
  return Object.freeze({ status: "unknown", reason: "not-advertised", detail });
}

function capabilityEvidenceSet(capabilities: OpenCodeNegotiatedCapabilities): CapabilityEvidenceSetInput {
  return {
    "model-discovery": capabilityEvidence(capabilities.modelDiscovery, "OpenCode ACP model option support"),
    "session-create": capabilityEvidence(capabilities.sessionCreate, "OpenCode ACP session/new"),
    "session-resume": capabilityEvidence(capabilities.sessionResume, "OpenCode ACP session resume capability"),
    streaming: capabilityEvidence(capabilities.streaming, "OpenCode ACP session/update stream"),
    cancellation: capabilityEvidence(capabilities.cancellation, "OpenCode ACP session/cancel"),
    usage: capabilityEvidence(capabilities.usage, "OpenCode ACP usage updates or terminal usage", "native-contract", "native-contract"),
    cost: capabilityEvidence(capabilities.cost, "OpenCode ACP usage cost field", "native-contract", "native-contract"),
    context: capabilityEvidence(capabilities.context, "OpenCode ACP context used/size", "native-contract", "native-contract"),
    "rate-limits": {
      status: "unsupported",
      source: "native-contract",
      detail: "OpenCode ACP usage/context is never provider limit authority"
    },
    steering: capabilityEvidence(capabilities.steering, "OpenCode ACP mode or prompt steering"),
    attachments: capabilityEvidence(capabilities.attachments, "OpenCode ACP image/content capability"),
    "inner-read-only": capabilityEvidence(
      capabilities.innerReadOnly,
      "Parent-controlled OpenCode deny-mutation overlay",
      "behavioral-probe",
      "native-contract"
    )
  };
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA256 = /^[a-f0-9]{64}$/;

/**
 * Convert parent-produced probe observations into the registry's typed
 * availability evidence. This function performs no I/O and never upgrades a
 * version string, help output, or usage record into behavioral authority.
 */
export function evaluateOpenCodeProbe(input: OpenCodeProbeObservation): AdapterAvailability {
  if (!input.executable) {
    return unavailable(input, "executable-missing", "Canonical installed OpenCode executable was not resolved.", "after-install", [
      { kind: "executable-identity", detail: "No canonical opencode executable identity" }
    ]);
  }
  if (
    (!input.executable.canonicalPath.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(input.executable.canonicalPath)) ||
    input.executable.identity.length === 0 ||
    input.executable.identity.length > 512
  ) {
    return unavailable(input, "executable-identity-changed", "OpenCode executable identity evidence is missing or non-canonical.", "transient", [
      { kind: "executable-identity", detail: "Canonical path and bounded file identity are both required" }
    ]);
  }
  if (!SEMVER.test(input.executable.version)) {
    return unavailable(input, "version-unparseable", "OpenCode executable version is not canonical semver.", "after-provider-update", [
      { kind: "executable-version", detail: "Canonical semver was not observed" }
    ]);
  }
  if (!isExecutableVersionSupported(input.executable.version, opencodeAdapterDescriptor.compatibility.executableVersion)) {
    return unavailable(input, "version-unsupported", "OpenCode executable version is outside the characterized range.", "after-provider-update", [
      { kind: "executable-version", detail: "Observed version is outside 1.18.15..<1.18.16" }
    ]);
  }
  if (input.wireVersion === undefined) {
    return unavailable(input, "handshake-failed", "Contained OpenCode ACP initialize did not produce a wire version.", "transient", [
      { kind: "contained-loopback", detail: "No contained ACP initialize response" },
      { kind: "wire-version", detail: "No negotiated ACP wire version" }
    ]);
  }
  if (input.wireVersion !== OPENCODE_ACP_WIRE_VERSION) {
    return unavailable(input, "wire-unsupported", "OpenCode negotiated an unsupported ACP wire version.", "after-provider-update", [
      { kind: "wire-version", detail: "Only stable ACP v1 is supported" }
    ]);
  }
  const behavioral = input.behavioralEvidenceSha256 ?? {};
  const missingChecks = opencodeAdapterDescriptor.compatibility.behavioralProbe.requiredChecks.filter(
    (check) => !SHA256.test(behavioral[check] ?? "")
  );
  if (missingChecks.length > 0) {
    return unavailable(input, "handshake-failed", "OpenCode version text did not have a complete contained behavioral handshake.", "transient", missingChecks.map(
      (check) => ({ kind: "behavioral-check" as const, detail: `Missing or malformed evidence for ${check}` })
    ));
  }
  if (!input.capabilities) {
    return unavailable(input, "required-capability-missing", "OpenCode ACP capabilities were not observed.", "transient", [
      { kind: "capability", detail: "No negotiated capability evidence" }
    ]);
  }
  const requiredCapabilities = (Object.entries(opencodeAdapterDescriptor.capabilityPolicy) as [AdapterCapabilityName, string][])
    .filter(([, requirement]) => requirement === "required")
    .map(([name]) => name);
  const capabilitiesByName: Partial<Record<AdapterCapabilityName, boolean | undefined>> = {
    "session-create": input.capabilities.sessionCreate,
    streaming: input.capabilities.streaming,
    cancellation: input.capabilities.cancellation
  };
  const missingCapabilities = requiredCapabilities.filter((name) => capabilitiesByName[name] !== true);
  if (missingCapabilities.length > 0) {
    return unavailable(input, "required-capability-missing", "OpenCode ACP omitted a required capability.", "after-provider-update", missingCapabilities.map(
      (capability) => ({ kind: "capability" as const, detail: `Required capability ${capability} was not proven` })
    ));
  }
  const checks = opencodeAdapterDescriptor.compatibility.behavioralProbe.requiredChecks.map((check) => ({
    check,
    outcome: "passed" as const,
    evidenceSha256: behavioral[check]!
  }));
  return defineAdapterAvailability(opencodeAdapterDescriptor, {
    status: "available",
    binding: probeBinding(),
    executable: {
      runtimeName: opencodeAdapterDescriptor.runtimeIdentity.executable,
      canonicalPath: input.executable.canonicalPath,
      identity: input.executable.identity
    },
    trustedHelpers: [],
    observedExecutableVersion: input.executable.version,
    supportedExecutableRange: { ...opencodeAdapterDescriptor.compatibility.executableVersion },
    wireVersion: input.wireVersion,
    behavioralChecks: checks,
    capabilities: capabilityEvidenceSet(input.capabilities),
    probedAt: input.probedAt,
    consultedConfigSha256: input.consultedConfigSha256
  });
}

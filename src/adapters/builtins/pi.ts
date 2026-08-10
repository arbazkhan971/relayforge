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
import {
  PI_RPC_WIRE_VERSION,
  type PiSessionStatsSnapshot,
  type PiStateEvidence
} from "../pi-rpc.js";

export const PI_AUDITED_VERSION = "0.84.1" as const;
export const PI_REVIEWER_HELPER_RUNTIME = "pi-relayforge-reviewer.mjs" as const;

const PI_COMMON_ARGUMENTS = Object.freeze([
  "--mode",
  "rpc",
  "--no-tools",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files"
] as const);

export const PI_WORKER_TOOLS = Object.freeze(["read", "bash", "edit", "write"] as const);
export const PI_REVIEWER_TOOLS = Object.freeze(["relayforge_read", "relayforge_list"] as const);

/** Pure description of the characterized Pi 0.84.1 native RPC contract. */
export const piAdapterDescriptor: AdapterDescriptor = defineAdapterDescriptor({
  schemaVersion: ADAPTER_DESCRIPTOR_SCHEMA_VERSION,
  contractVersion: ADAPTER_CONTRACT_VERSION,
  id: "pi",
  providerId: "pi",
  transportKind: "rpc-jsonl",
  runtimeIdentity: {
    kind: "installed-executable",
    executable: "pi",
    trustedHelpers: [PI_REVIEWER_HELPER_RUNTIME],
    resolution: "canonical-installed-only"
  },
  compatibility: {
    executableVersion: {
      scheme: "semver",
      minInclusive: PI_AUDITED_VERSION,
      maxExclusive: "0.84.2"
    },
    wireVersions: [PI_RPC_WIRE_VERSION],
    behavioralProbe: {
      id: "pi-rpc-0.84.1",
      version: 1,
      requiredChecks: [
        "executable-version",
        "transport-handshake",
        "framing",
        "state-query",
        "statistics-query",
        "prompt-roundtrip",
        "cancellation",
        "accounting"
      ]
    }
  },
  invocationPolicy: {
    fixedArguments: PI_COMMON_ARGUMENTS,
    controlledOptions: [
      { name: "session-dir", kind: "session-directory", required: true },
      { name: "role-tool-policy", kind: "inline-config", required: true },
      { name: "standing-system-prompt", kind: "inline-config", required: true },
      { name: "model", kind: "model", required: false }
    ],
    allowedEnvironmentNames: [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY"
    ],
    promptTransport: "stdin-jsonl",
    systemPromptChannel: "separate"
  },
  capabilityPolicy: {
    "model-discovery": "optional",
    "session-create": "required",
    "session-resume": "optional",
    streaming: "required",
    cancellation: "required",
    usage: "required",
    cost: "required",
    context: "optional",
    "rate-limits": "unsupported",
    steering: "optional",
    attachments: "unsupported",
    "inner-read-only": "optional"
  },
  codec: { id: "pi-rpc-jsonl", version: 1 },
  normalizer: { id: "pi-rpc-v1-0.84.1", version: 1 },
  roles: {
    worker: {
      status: "enabled",
      outerSandbox: "required",
      filesystem: "workspace-write",
      innerReadOnly: "not-required",
      requiredCapabilities: ["session-create", "streaming", "cancellation", "usage", "cost"]
    },
    reviewer: {
      status: "enabled",
      outerSandbox: "required",
      filesystem: "read-only",
      innerReadOnly: "required",
      requiredCapabilities: ["session-create", "streaming", "cancellation", "usage", "cost", "inner-read-only"]
    }
  }
});

export type PiAdapterRole = "worker" | "reviewer";

export type PiInvocationInput = Readonly<{
  role: PiAdapterRole;
  sessionDirectory: string;
  /** Canonical parent-resolved path matching PI_REVIEWER_HELPER_RUNTIME. */
  reviewerHelperPath?: string;
  /** Parent-owned standing instructions, carried on Pi's dedicated system-prompt channel. */
  systemPrompt?: string;
  model?: string;
}>;

function absolutePath(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    value.includes("\0") ||
    (!value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value))
  ) {
    throw new TypeError(`${name} must be a bounded absolute NUL-free path`);
  }
  return value;
}

function modelName(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.includes("\0")) {
    throw new TypeError("model must be a bounded non-empty NUL-free string");
  }
  return value;
}

function systemPrompt(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value, "utf8") > 4 * 1024 * 1024) {
    throw new TypeError("systemPrompt must be bounded and NUL-free");
  }
  return value;
}

/**
 * Expand the descriptor's fixed recipe with parent-controlled path/model
 * values and an exact role tool policy. No task or standing-prompt bytes are
 * placed in argv; those remain on the JSONL protocol channel.
 */
export function buildPiInvocationArguments(input: PiInvocationInput): readonly string[] {
  if (input.role !== "worker" && input.role !== "reviewer") throw new TypeError("Pi role must be worker or reviewer");
  const args = [...PI_COMMON_ARGUMENTS, "--session-dir", absolutePath(input.sessionDirectory, "sessionDirectory")];
  if (input.role === "worker") {
    args.push("--tools", PI_WORKER_TOOLS.join(","));
  } else {
    args.push(
      "--extension",
      absolutePath(input.reviewerHelperPath, "reviewerHelperPath"),
      "--tools",
      PI_REVIEWER_TOOLS.join(",")
    );
  }
  if (input.systemPrompt !== undefined) args.push("--append-system-prompt", systemPrompt(input.systemPrompt));
  if (input.model !== undefined) args.push("--model", modelName(input.model));
  return Object.freeze(args);
}

export type PiNegotiatedCapabilities = Readonly<{
  modelDiscovery?: boolean;
  sessionCreate: boolean;
  sessionResume?: boolean;
  streaming: boolean;
  cancellation: boolean;
  usage: boolean;
  cost: boolean;
  context?: boolean;
  steering?: boolean;
  innerReadOnly?: boolean;
}>;

export type PiProbeObservation = Readonly<{
  executable?: Readonly<{
    canonicalPath: string;
    identity: string;
    version: string;
  }>;
  reviewerHelper?: Readonly<{
    canonicalPath: string;
    identity: string;
  }>;
  wireVersion?: string;
  /** Decoded from the exact correlated get_state response. */
  state?: Readonly<{
    value: PiStateEvidence;
    frameSha256: string;
  }>;
  /** Decoded from the exact correlated get_session_stats response. */
  statistics?: PiSessionStatsSnapshot;
  behavioralEvidenceSha256?: Partial<Readonly<Record<BehavioralProbeCheck, string>>>;
  capabilities?: PiNegotiatedCapabilities;
  probedAt: string;
  consultedConfigSha256: string;
}>;

function binding() {
  return {
    adapterId: piAdapterDescriptor.id,
    contractVersion: piAdapterDescriptor.contractVersion,
    normalizer: { ...piAdapterDescriptor.normalizer }
  } as const;
}

type PiUnavailableCode =
  | "executable-missing"
  | "executable-identity-changed"
  | "version-unparseable"
  | "version-unsupported"
  | "handshake-failed"
  | "wire-unsupported"
  | "required-capability-missing"
  | "protocol-drift";

type PiMissingEvidence = Readonly<{
  kind: "executable-identity" | "executable-version" | "trusted-helper-identity" | "behavioral-check" | "wire-version" | "capability";
  detail: string;
}>;

function unavailable(
  input: PiProbeObservation,
  code: PiUnavailableCode,
  detail: string,
  retry: "after-install" | "after-provider-update" | "after-config-change" | "transient",
  missingEvidence: readonly PiMissingEvidence[]
): AdapterAvailability {
  return defineAdapterAvailability(piAdapterDescriptor, {
    status: "unavailable",
    binding: binding(),
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
  provenSource: "behavioral-probe" | "native-contract" = "behavioral-probe",
  unsupportedSource: "protocol-negotiation" | "native-contract" = "native-contract"
): CapabilityEvidence {
  if (value === true) return Object.freeze({ status: "proven", source: provenSource, detail });
  if (value === false) return Object.freeze({ status: "unsupported", source: unsupportedSource, detail });
  return Object.freeze({ status: "unknown", reason: "not-probed", detail });
}

function capabilities(input: PiNegotiatedCapabilities): CapabilityEvidenceSetInput {
  return {
    "model-discovery": capabilityEvidence(input.modelDiscovery, "Pi model/state query support"),
    "session-create": capabilityEvidence(input.sessionCreate, "Pi explicit session directory and state identity"),
    "session-resume": capabilityEvidence(input.sessionResume, "Pi session resume support"),
    streaming: capabilityEvidence(input.streaming, "Pi prompt events through native RPC JSONL"),
    cancellation: capabilityEvidence(input.cancellation, "Pi correlated abort response and cancelled settlement"),
    usage: capabilityEvidence(input.usage, "Pi get_session_stats token counters"),
    cost: capabilityEvidence(input.cost, "Pi get_session_stats cumulative cost"),
    context: capabilityEvidence(input.context, "Pi optional contextUsage snapshot", "native-contract"),
    "rate-limits": {
      status: "unsupported",
      source: "native-contract",
      detail: "Pi RPC error text and statistics never authorize provider fallback"
    },
    steering: capabilityEvidence(input.steering, "Pi steer/follow-up RPC commands", "native-contract"),
    attachments: {
      status: "unsupported",
      source: "native-contract",
      detail: "The characterized Pi RPC prompt contract is text-only"
    },
    "inner-read-only": capabilityEvidence(input.innerReadOnly, "Zero built-ins plus the RelayForge read-only helper")
  };
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA256 = /^[a-f0-9]{64}$/;

function canonicalIdentity(value: Readonly<{ canonicalPath: string; identity: string }>): boolean {
  return (
    (value.canonicalPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value.canonicalPath)) &&
    value.canonicalPath.length <= 4_096 &&
    !value.canonicalPath.includes("\0") &&
    value.identity.length > 0 &&
    value.identity.length <= 512
  );
}

/**
 * Validate externally produced, parent-contained Pi probe evidence. Readiness
 * exists only after correlated state and statistics responses; this module has
 * no timer, startup delay, process launch, or fallback path.
 */
export function evaluatePiProbe(input: PiProbeObservation): AdapterAvailability {
  if (!input.executable) {
    return unavailable(input, "executable-missing", "Canonical installed Pi executable was not resolved.", "after-install", [
      { kind: "executable-identity", detail: "No canonical pi executable identity" }
    ]);
  }
  if (!canonicalIdentity(input.executable)) {
    return unavailable(input, "executable-identity-changed", "Pi executable identity evidence is missing or non-canonical.", "transient", [
      { kind: "executable-identity", detail: "Canonical path and bounded file identity are required" }
    ]);
  }
  if (!input.reviewerHelper || !canonicalIdentity(input.reviewerHelper)) {
    return unavailable(input, "executable-identity-changed", "The shipped Pi reviewer helper identity was not proven.", "after-config-change", [
      { kind: "trusted-helper-identity", detail: `Missing canonical ${PI_REVIEWER_HELPER_RUNTIME} identity` }
    ]);
  }
  if (!SEMVER.test(input.executable.version)) {
    return unavailable(input, "version-unparseable", "Pi executable version is not canonical semver.", "after-provider-update", [
      { kind: "executable-version", detail: "Canonical semver was not observed" }
    ]);
  }
  if (!isExecutableVersionSupported(input.executable.version, piAdapterDescriptor.compatibility.executableVersion)) {
    return unavailable(input, "version-unsupported", "Pi executable version is outside the characterized range.", "after-provider-update", [
      { kind: "executable-version", detail: "Observed version is outside 0.84.1..<0.84.2" }
    ]);
  }
  if (input.wireVersion === undefined) {
    return unavailable(input, "handshake-failed", "Pi RPC did not complete its state/statistics behavioral handshake.", "transient", [
      { kind: "wire-version", detail: "No proven native RPC wire contract" }
    ]);
  }
  if (input.wireVersion !== PI_RPC_WIRE_VERSION) {
    return unavailable(input, "wire-unsupported", "Pi reported an unsupported RPC wire contract.", "after-provider-update", [
      { kind: "wire-version", detail: `Only ${PI_RPC_WIRE_VERSION} is supported` }
    ]);
  }
  if (!input.state) {
    return unavailable(input, "handshake-failed", "Pi readiness requires a correlated get_state response.", "transient", [
      { kind: "behavioral-check", detail: "Missing get_state response evidence" }
    ]);
  }
  if (!input.statistics) {
    return unavailable(input, "handshake-failed", "Pi readiness requires a correlated get_session_stats response.", "transient", [
      { kind: "behavioral-check", detail: "Missing get_session_stats response evidence" }
    ]);
  }
  if (
    input.state.value.sessionId !== input.statistics.sessionId ||
    input.state.value.isStreaming ||
    input.state.value.isCompacting
  ) {
    return unavailable(input, "protocol-drift", "Pi state/statistics handshake is foreign or not idle.", "transient", [
      { kind: "behavioral-check", detail: "State and statistics must bind one idle session" }
    ]);
  }
  const evidence = input.behavioralEvidenceSha256 ?? {};
  if (
    evidence["state-query"] !== input.state.frameSha256 ||
    evidence["statistics-query"] !== input.statistics.frame.sha256
  ) {
    return unavailable(input, "protocol-drift", "Pi state/statistics frame hashes do not match the probe evidence.", "transient", [
      { kind: "behavioral-check", detail: "State/statistics observations must bind exact frames" }
    ]);
  }
  const missingChecks = piAdapterDescriptor.compatibility.behavioralProbe.requiredChecks.filter(
    (check) => !SHA256.test(evidence[check] ?? "")
  );
  if (missingChecks.length > 0) {
    return unavailable(input, "handshake-failed", "Pi version text did not have a complete behavioral handshake.", "transient", missingChecks.map(
      (check) => ({ kind: "behavioral-check" as const, detail: `Missing or malformed evidence for ${check}` })
    ));
  }
  if (!input.capabilities) {
    return unavailable(input, "required-capability-missing", "Pi RPC capabilities were not observed.", "transient", [
      { kind: "capability", detail: "No Pi capability evidence" }
    ]);
  }
  const byName: Partial<Record<AdapterCapabilityName, boolean | undefined>> = {
    "session-create": input.capabilities.sessionCreate,
    streaming: input.capabilities.streaming,
    cancellation: input.capabilities.cancellation,
    usage: input.capabilities.usage,
    cost: input.capabilities.cost
  };
  const required = (Object.entries(piAdapterDescriptor.capabilityPolicy) as [AdapterCapabilityName, string][])
    .filter(([, requirement]) => requirement === "required")
    .map(([name]) => name);
  const missingCapabilities = required.filter((name) => byName[name] !== true);
  if (missingCapabilities.length > 0) {
    return unavailable(input, "required-capability-missing", "Pi RPC omitted a required capability.", "after-provider-update", missingCapabilities.map(
      (capability) => ({ kind: "capability" as const, detail: `Required capability ${capability} was not proven` })
    ));
  }
  const checks = piAdapterDescriptor.compatibility.behavioralProbe.requiredChecks.map((check) => ({
    check,
    outcome: "passed" as const,
    evidenceSha256: evidence[check]!
  }));
  return defineAdapterAvailability(piAdapterDescriptor, {
    status: "available",
    binding: binding(),
    executable: {
      runtimeName: piAdapterDescriptor.runtimeIdentity.executable,
      canonicalPath: input.executable.canonicalPath,
      identity: input.executable.identity
    },
    trustedHelpers: [{
      runtimeName: PI_REVIEWER_HELPER_RUNTIME,
      canonicalPath: input.reviewerHelper.canonicalPath,
      identity: input.reviewerHelper.identity
    }],
    observedExecutableVersion: input.executable.version,
    supportedExecutableRange: { ...piAdapterDescriptor.compatibility.executableVersion },
    wireVersion: input.wireVersion,
    behavioralChecks: checks,
    capabilities: capabilities(input.capabilities),
    probedAt: input.probedAt,
    consultedConfigSha256: input.consultedConfigSha256
  });
}

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
  GROK_EGRESS_POLICY_SHA256,
  GROK_EGRESS_RELAY_RUNTIME,
  grokEgressDenialEvidenceSha256,
  type GrokEgressEvidenceBinding
} from "../grok-egress-contract.js";

export const GROK_AUDITED_VERSION = "1.0.0" as const;
export const GROK_AUDITED_BUILD_COMMIT = "3cd0d0cbce" as const;
export const GROK_ACP_WIRE_VERSION = "1" as const;
export const GROK_AUTH_ENV = "XAI_API_KEY" as const;

/** Fixed parser-level controls. No task, standing prompt, endpoint or trust decision is in argv. */
export const GROK_FIXED_ARGUMENTS = Object.freeze([
  "--no-auto-update",
  "--disable-web-search",
  "--no-subagents",
  "--no-memory",
  "agent",
  "--no-leader",
  "stdio"
] as const);

export const GROK_FIXED_SAFETY_ENVIRONMENT = Object.freeze({
  GROK_TELEMETRY_ENABLED: "false",
  GROK_TELEMETRY_TRACE_UPLOAD: "false",
  GROK_FEEDBACK_ENABLED: "false",
  GROK_TRACE_UPLOAD: "false",
  GROK_INSTRUMENTATION: "disabled",
  OTEL_SDK_DISABLED: "true",
  DISABLE_TELEMETRY: "1",
  DISABLE_FEEDBACK_COMMAND: "1",
  GROK_DISABLE_AUTOUPDATER: "1",
  GROK_PROMPT_SUGGESTIONS: "false",
  GROK_TURN_SUMMARY: "0"
} as const);

/** Pure description of the characterized stable Grok Build native ACP contract. */
export const grokAdapterDescriptor: AdapterDescriptor = defineAdapterDescriptor({
  schemaVersion: ADAPTER_DESCRIPTOR_SCHEMA_VERSION,
  contractVersion: ADAPTER_CONTRACT_VERSION,
  id: "grok",
  providerId: "grok",
  transportKind: "acp-v1",
  runtimeIdentity: {
    kind: "installed-executable",
    executable: "grok",
    trustedHelpers: [GROK_EGRESS_RELAY_RUNTIME],
    resolution: "canonical-installed-only"
  },
  compatibility: {
    executableVersion: {
      scheme: "semver",
      minInclusive: GROK_AUDITED_VERSION,
      maxExclusive: "1.0.1"
    },
    wireVersions: [GROK_ACP_WIRE_VERSION],
    behavioralProbe: {
      id: "grok-acp-1.0.0-3cd0d0cbce",
      version: 1,
      requiredChecks: [
        "executable-version",
        "transport-handshake",
        "framing",
        "session-create",
        "prompt-roundtrip",
        "cancellation",
        "read-only-denial",
        "accounting",
        "configuration-isolation",
        "network-tool-policy",
        "unapproved-upload-denial"
      ]
    }
  },
  invocationPolicy: {
    fixedArguments: GROK_FIXED_ARGUMENTS,
    controlledOptions: [
      { name: "private-state-directory", kind: "session-directory", required: true },
      { name: "role-permission-mode", kind: "mode", required: true },
      { name: "standing-system-prompt", kind: "inline-config", required: true },
      { name: "model", kind: "model", required: false }
    ],
    allowedEnvironmentNames: [GROK_AUTH_ENV],
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
    attachments: "unsupported",
    "inner-read-only": "optional"
  },
  codec: { id: "acp-v1", version: 1 },
  normalizer: { id: "grok-acp-v1-1.0.0", version: 1 },
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

export type GrokAdapterRole = "worker" | "reviewer";

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
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 256 || value.includes("\0")) {
    throw new TypeError("model must be a bounded non-empty NUL-free string");
  }
  return value;
}

/** Expand only the role/model slots in the closed invocation recipe. */
export function buildGrokInvocationArguments(input: Readonly<{
  role: GrokAdapterRole;
  model?: string;
}>): readonly string[] {
  if (input.role !== "worker" && input.role !== "reviewer") {
    throw new TypeError("Grok role must be worker or reviewer");
  }
  const args = [
    "--no-auto-update",
    "--disable-web-search",
    "--no-subagents",
    "--no-memory",
    "--permission-mode",
    input.role === "reviewer" ? "plan" : "default",
    "agent",
    "--no-leader"
  ];
  if (input.model !== undefined) args.push("--model", modelName(input.model));
  args.push("stdio");
  return Object.freeze(args);
}

/**
 * Construct the private first-party-derived Grok process environment overlay.
 * The caller owns directory creation and containment; this pure function never
 * consults or mutates the filesystem.
 */
export function buildGrokPrivateEnvironment(stateDirectory: string): Readonly<Record<string, string>> {
  const root = absolutePath(stateDirectory, "stateDirectory").replace(/[\\/]$/, "");
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const child = (name: string) => `${root}${separator}${name}`;
  return Object.freeze({
    HOME: child("home"),
    USERPROFILE: child("home"),
    GROK_HOME: child("grok-home"),
    TMPDIR: child("tmp"),
    TMP: child("tmp"),
    TEMP: child("tmp"),
    XDG_CONFIG_HOME: child("xdg-config"),
    XDG_CACHE_HOME: child("xdg-cache"),
    XDG_DATA_HOME: child("xdg-data"),
    ...GROK_FIXED_SAFETY_ENVIRONMENT
  });
}

export type GrokNegotiatedCapabilities = Readonly<{
  modelDiscovery?: boolean;
  sessionCreate: boolean;
  sessionResume?: boolean;
  streaming: boolean;
  cancellation: boolean;
  usage?: boolean;
  cost?: boolean;
  context?: boolean;
  steering?: boolean;
  innerReadOnly?: boolean;
}>;

export type GrokSafetyEvidence = Readonly<{
  configurationIsolationSha256: string;
  networkToolPolicySha256: string;
  unapprovedUploadDenialSha256: string;
}>;

export type GrokProbeObservation = Readonly<{
  executable?: Readonly<{
    canonicalPath: string;
    identity: string;
    version: string;
    buildCommit: string;
    channel: string;
  }>;
  trustedHelper?: Readonly<{
    canonicalPath: string;
    identity: string;
  }>;
  wireVersion?: string;
  handshake?: Readonly<{
    grokShell: boolean;
    agentVersion: string;
  }>;
  apiKeyConfigured: boolean;
  behavioralEvidenceSha256?: Partial<Readonly<Record<BehavioralProbeCheck, string>>>;
  safetyEvidence?: GrokSafetyEvidence;
  egressEvidence?: GrokEgressEvidenceBinding;
  capabilities?: GrokNegotiatedCapabilities;
  probedAt: string;
  consultedConfigSha256: string;
}>;

function binding() {
  return {
    adapterId: grokAdapterDescriptor.id,
    contractVersion: grokAdapterDescriptor.contractVersion,
    normalizer: { ...grokAdapterDescriptor.normalizer }
  } as const;
}

type GrokUnavailableCode =
  | "executable-missing"
  | "executable-identity-changed"
  | "version-unparseable"
  | "version-unsupported"
  | "handshake-failed"
  | "wire-unsupported"
  | "required-capability-missing"
  | "auth-required"
  | "config-invalid"
  | "containment-incompatible"
  | "protocol-drift";

type GrokMissingEvidence = Readonly<{
  kind: "executable-identity" | "executable-version" | "behavioral-check" | "wire-version" | "capability" | "authentication" | "configuration";
  detail: string;
}>;

function unavailable(
  input: GrokProbeObservation,
  code: GrokUnavailableCode,
  detail: string,
  retry: "after-install" | "after-auth" | "after-config-change" | "after-provider-update" | "transient",
  missingEvidence: readonly GrokMissingEvidence[]
): AdapterAvailability {
  return defineAdapterAvailability(grokAdapterDescriptor, {
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

function canonicalIdentity(value: Readonly<{ canonicalPath: string; identity: string }>): boolean {
  return (
    (value.canonicalPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value.canonicalPath)) &&
    value.canonicalPath.length <= 4_096 &&
    !value.canonicalPath.includes("\0") &&
    value.identity.length > 0 &&
    value.identity.length <= 512
  );
}

function capabilityEvidence(
  value: boolean | undefined,
  detail: string,
  source: "behavioral-probe" | "protocol-negotiation" | "native-contract" = "protocol-negotiation"
): CapabilityEvidence {
  if (value === true) return Object.freeze({ status: "proven", source, detail });
  if (value === false) return Object.freeze({ status: "unsupported", source: source === "behavioral-probe" ? "native-contract" : source, detail });
  return Object.freeze({ status: "unknown", reason: "not-advertised", detail });
}

function capabilityEvidenceSet(input: GrokNegotiatedCapabilities): CapabilityEvidenceSetInput {
  return {
    "model-discovery": capabilityEvidence(input.modelDiscovery, "Grok initialize modelState", "protocol-negotiation"),
    "session-create": capabilityEvidence(input.sessionCreate, "Grok ACP session/new", "behavioral-probe"),
    "session-resume": capabilityEvidence(input.sessionResume, "Grok ACP load/resume capability", "protocol-negotiation"),
    streaming: capabilityEvidence(input.streaming, "Grok ACP session/update stream", "behavioral-probe"),
    cancellation: capabilityEvidence(input.cancellation, "Grok ACP session/cancel", "behavioral-probe"),
    usage: capabilityEvidence(input.usage, "Grok ACP usage evidence", "native-contract"),
    cost: capabilityEvidence(input.cost, "Grok ACP cost evidence", "native-contract"),
    context: capabilityEvidence(input.context, "Grok ACP context evidence", "native-contract"),
    "rate-limits": {
      status: "unsupported",
      source: "native-contract",
      detail: "Grok ACP errors and usage never authorize paid fallback"
    },
    steering: capabilityEvidence(input.steering, "Grok ACP session prompt/commands", "native-contract"),
    attachments: {
      status: "unsupported",
      source: "protocol-negotiation",
      detail: "The characterized Grok initialize reports image/audio prompt support false"
    },
    "inner-read-only": capabilityEvidence(input.innerReadOnly, "Grok plan policy plus contained write denial", "behavioral-probe")
  };
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const BUILD_COMMIT = /^[a-f0-9]{10,40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

/**
 * Validate parent-produced, contained Grok characterization evidence. This is
 * deliberately pure and cannot start a process or infer privacy from flags.
 */
export function evaluateGrokProbe(input: GrokProbeObservation): AdapterAvailability {
  if (!input.executable) {
    return unavailable(input, "executable-missing", "Canonical installed Grok executable was not resolved.", "after-install", [
      { kind: "executable-identity", detail: "No canonical grok executable identity" }
    ]);
  }
  if (!canonicalIdentity(input.executable)) {
    return unavailable(input, "executable-identity-changed", "Grok executable identity evidence is missing or non-canonical.", "transient", [
      { kind: "executable-identity", detail: "Canonical path and bounded content identity are required" }
    ]);
  }
  if (!SEMVER.test(input.executable.version) || !BUILD_COMMIT.test(input.executable.buildCommit) || input.executable.channel.length === 0) {
    return unavailable(input, "version-unparseable", "Grok version JSON is malformed or incomplete.", "after-provider-update", [
      { kind: "executable-version", detail: "Canonical semver, build commit and channel are required" }
    ]);
  }
  if (
    !isExecutableVersionSupported(input.executable.version, grokAdapterDescriptor.compatibility.executableVersion) ||
    input.executable.buildCommit !== GROK_AUDITED_BUILD_COMMIT ||
    input.executable.channel !== "stable"
  ) {
    return unavailable(input, "version-unsupported", "Grok executable version/build/channel is outside the characterized stable contract.", "after-provider-update", [
      { kind: "executable-version", detail: `Only stable ${GROK_AUDITED_VERSION} build ${GROK_AUDITED_BUILD_COMMIT} is characterized` }
    ]);
  }
  if (!input.apiKeyConfigured) {
    return unavailable(input, "auth-required", "Grok support is API-key-only; ambient subscription or managed configuration is not reused.", "after-auth", [
      { kind: "authentication", detail: `${GROK_AUTH_ENV} was not present in the controlled probe environment` }
    ]);
  }
  if (input.wireVersion === undefined || !input.handshake) {
    return unavailable(input, "handshake-failed", "Contained Grok ACP initialize evidence is missing.", "transient", [
      { kind: "wire-version", detail: "No negotiated ACP wire version" },
      { kind: "behavioral-check", detail: "No Grok-specific initialize metadata" }
    ]);
  }
  if (input.wireVersion !== GROK_ACP_WIRE_VERSION) {
    return unavailable(input, "wire-unsupported", "Grok negotiated an unsupported ACP wire version.", "after-provider-update", [
      { kind: "wire-version", detail: "Only stable ACP v1 is supported" }
    ]);
  }
  if (!input.handshake.grokShell || input.handshake.agentVersion !== GROK_AUDITED_VERSION) {
    return unavailable(input, "protocol-drift", "ACP initialize did not identify the characterized Grok shell contract.", "after-provider-update", [
      { kind: "behavioral-check", detail: "Expected _meta.grokShell=true and agentVersion=1.0.0" }
    ]);
  }
  if (!input.trustedHelper || !canonicalIdentity(input.trustedHelper)) {
    return unavailable(input, "containment-incompatible", "The parent-owned Grok egress relay identity is missing or non-canonical.", "after-install", [
      { kind: "executable-identity", detail: "Exact grok-egress-relay.mjs runtime evidence is required" }
    ]);
  }
  const egress = input.egressEvidence;
  const egressHashes = egress ? [
    egress.policySha256,
    egress.probeReceiptSha256,
    egress.decisionLogSha256,
    egress.socketIdentitySha256,
    egress.cleanupSha256
  ] : [];
  if (
    !egress ||
    egress.policySha256 !== GROK_EGRESS_POLICY_SHA256 ||
    egressHashes.some((hash) => !SHA256.test(hash)) ||
    new Set(egressHashes).size !== egressHashes.length
  ) {
    return unavailable(input, "containment-incompatible", "Grok egress evidence does not bind the shipped proxy policy, active probe, decision log, socket and cleanup.", "after-config-change", [
      { kind: "behavioral-check", detail: "Exact parent-owned Grok egress enforcement evidence is required" }
    ]);
  }
  const safety = input.safetyEvidence;
  const safetyHashes = safety ? [
    safety.configurationIsolationSha256,
    safety.networkToolPolicySha256,
    safety.unapprovedUploadDenialSha256
  ] : [];
  if (safetyHashes.length !== 3 || safetyHashes.some((hash) => !SHA256.test(hash)) || new Set(safetyHashes).size !== 3) {
    return unavailable(input, "containment-incompatible", "Grok privacy readiness requires distinct exact configuration, network/tool and no-upload observations.", "after-config-change", [
      { kind: "configuration", detail: "Private empty HOME/GROK_HOME was not proven" },
      { kind: "behavioral-check", detail: "Fixed network/tool policy was not proven" },
      { kind: "behavioral-check", detail: "Unapproved telemetry/trace/code upload denial was not proven" }
    ]);
  }
  const behavioral = input.behavioralEvidenceSha256 ?? {};
  const missingChecks = grokAdapterDescriptor.compatibility.behavioralProbe.requiredChecks.filter(
    (check) => !SHA256.test(behavioral[check] ?? "")
  );
  if (missingChecks.length > 0) {
    return unavailable(input, "handshake-failed", "Grok version/initialize output did not have a complete contained behavioral probe.", "transient", missingChecks.map(
      (check) => ({ kind: "behavioral-check" as const, detail: `Missing or malformed evidence for ${check}` })
    ));
  }
  if (
    safety && (
      behavioral["configuration-isolation"] !== safety.configurationIsolationSha256 ||
      behavioral["network-tool-policy"] !== safety.networkToolPolicySha256 ||
      behavioral["unapproved-upload-denial"] !== safety.unapprovedUploadDenialSha256 ||
      safety.networkToolPolicySha256 !== egress.probeReceiptSha256 ||
      safety.unapprovedUploadDenialSha256 !== grokEgressDenialEvidenceSha256(egress)
    )
  ) {
    return unavailable(input, "containment-incompatible", "Grok safety observations do not bind the exact behavioral availability checks.", "after-config-change", [
      { kind: "behavioral-check", detail: "Configuration, network/tool and upload-denial hashes must match the availability probe" }
    ]);
  }
  if (!input.capabilities) {
    return unavailable(input, "required-capability-missing", "Grok ACP capabilities were not observed.", "transient", [
      { kind: "capability", detail: "No negotiated/behavioral capability evidence" }
    ]);
  }
  const byName: Partial<Record<AdapterCapabilityName, boolean | undefined>> = {
    "session-create": input.capabilities.sessionCreate,
    streaming: input.capabilities.streaming,
    cancellation: input.capabilities.cancellation
  };
  const required = (Object.entries(grokAdapterDescriptor.capabilityPolicy) as [AdapterCapabilityName, string][])
    .filter(([, requirement]) => requirement === "required")
    .map(([name]) => name);
  const missingCapabilities = required.filter((name) => byName[name] !== true);
  if (missingCapabilities.length > 0) {
    return unavailable(input, "required-capability-missing", "Grok ACP omitted a required capability.", "after-provider-update", missingCapabilities.map(
      (capability) => ({ kind: "capability" as const, detail: `Required capability ${capability} was not proven` })
    ));
  }
  const checks = grokAdapterDescriptor.compatibility.behavioralProbe.requiredChecks.map((check) => ({
    check,
    outcome: "passed" as const,
    evidenceSha256: behavioral[check]!
  }));
  return defineAdapterAvailability(grokAdapterDescriptor, {
    status: "available",
    binding: binding(),
    executable: {
      runtimeName: grokAdapterDescriptor.runtimeIdentity.executable,
      canonicalPath: input.executable.canonicalPath,
      identity: input.executable.identity
    },
    trustedHelpers: [{
      runtimeName: GROK_EGRESS_RELAY_RUNTIME,
      canonicalPath: input.trustedHelper.canonicalPath,
      identity: input.trustedHelper.identity
    }],
    observedExecutableVersion: input.executable.version,
    supportedExecutableRange: { ...grokAdapterDescriptor.compatibility.executableVersion },
    wireVersion: input.wireVersion,
    behavioralChecks: checks,
    capabilities: capabilityEvidenceSet(input.capabilities),
    probedAt: input.probedAt,
    consultedConfigSha256: input.consultedConfigSha256
  });
}

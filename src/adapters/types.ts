/**
 * Pure, data-only contracts for shipped provider adapters.
 *
 * This module intentionally has no runtime imports. In particular, an adapter
 * descriptor is not a launcher: it cannot carry callbacks, shell commands,
 * filesystem policy, output limits, or settlement authority. The central
 * transport interprets these immutable descriptions.
 */

export const ADAPTER_DESCRIPTOR_SCHEMA_VERSION = 1 as const;
export const ADAPTER_CONTRACT_VERSION = 1 as const;

export const adapterTransportKinds = [
  "oneshot-jsonl",
  "oneshot-text",
  "rpc-jsonl",
  "acp-v1",
  "app-server-jsonrpc"
] as const;
export type AdapterTransportKind = (typeof adapterTransportKinds)[number];

export const promptTransportKinds = [
  "stdin-text",
  "stdin-jsonl",
  "stdio-jsonrpc",
  "argv-legacy"
] as const;
export type PromptTransportKind = (typeof promptTransportKinds)[number];

export const systemPromptChannelKinds = ["separate", "combined", "unsupported"] as const;
export type SystemPromptChannelKind = (typeof systemPromptChannelKinds)[number];

/** Closed in v1: additions require a descriptor-schema version change. */
export const adapterCapabilityNames = [
  "model-discovery",
  "session-create",
  "session-resume",
  "streaming",
  "cancellation",
  "usage",
  "cost",
  "context",
  "rate-limits",
  "steering",
  "attachments",
  "inner-read-only"
] as const;
export type AdapterCapabilityName = (typeof adapterCapabilityNames)[number];

export const capabilityRequirementKinds = ["required", "optional", "unsupported"] as const;
export type CapabilityRequirement = (typeof capabilityRequirementKinds)[number];
export type CapabilityPolicy = Readonly<Record<AdapterCapabilityName, CapabilityRequirement>>;
export type CapabilityPolicyInput = Readonly<Record<AdapterCapabilityName, CapabilityRequirement>>;

export const capabilityEvidenceSources = [
  "behavioral-probe",
  "protocol-negotiation",
  "native-contract"
] as const;
export type CapabilityEvidenceSource = (typeof capabilityEvidenceSources)[number];

export const capabilityUnknownReasons = [
  "not-advertised",
  "probe-inconclusive",
  "malformed-evidence",
  "not-probed"
] as const;
export type CapabilityUnknownReason = (typeof capabilityUnknownReasons)[number];

export type ProvenCapabilityEvidence = Readonly<{
  status: "proven";
  source: CapabilityEvidenceSource;
  /** A bounded stable fact, never provider prose. */
  detail: string;
}>;

export type UnsupportedCapabilityEvidence = Readonly<{
  status: "unsupported";
  source: Extract<CapabilityEvidenceSource, "protocol-negotiation" | "native-contract">;
  detail: string;
}>;

export type UnknownCapabilityEvidence = Readonly<{
  status: "unknown";
  reason: CapabilityUnknownReason;
  detail: string;
}>;

export type CapabilityEvidence =
  | ProvenCapabilityEvidence
  | UnsupportedCapabilityEvidence
  | UnknownCapabilityEvidence;

/** Every key is mandatory; capability absence can never disappear in serialization. */
export type CapabilityEvidenceSet = Readonly<Record<AdapterCapabilityName, CapabilityEvidence>>;
export type CapabilityEvidenceSetInput = Readonly<Record<AdapterCapabilityName, CapabilityEvidence>>;

export const behavioralProbeChecks = [
  "executable-version",
  "transport-handshake",
  "framing",
  "session-create",
  "prompt-roundtrip",
  "state-query",
  "statistics-query",
  "cancellation",
  "read-only-denial",
  "accounting",
  "configuration-isolation",
  "network-tool-policy",
  "unapproved-upload-denial"
] as const;
export type BehavioralProbeCheck = (typeof behavioralProbeChecks)[number];

export const controlledOptionKinds = [
  "model",
  "mode",
  "effort",
  "session-directory",
  "inline-config"
] as const;
export type ControlledOptionKind = (typeof controlledOptionKinds)[number];

export const adapterRoleNames = ["worker", "reviewer"] as const;
export type AdapterRoleName = (typeof adapterRoleNames)[number];

export const adapterRoleRefusalCodes = [
  "role-unsupported",
  "adapter-unavailable",
  "required-capability-unproven",
  "inner-read-only-unproven",
  "compatibility-evidence-mismatch"
] as const;
export type AdapterRoleRefusalCode = (typeof adapterRoleRefusalCodes)[number];

export const adapterUnavailableReasonCodes = [
  "executable-missing",
  "executable-identity-changed",
  "version-unparseable",
  "version-unsupported",
  "handshake-failed",
  "wire-unsupported",
  "required-capability-missing",
  "role-unsupported",
  "auth-required",
  "config-invalid",
  "containment-incompatible",
  "protocol-drift"
] as const;
export type AdapterUnavailableReasonCode = (typeof adapterUnavailableReasonCodes)[number];

export const adapterRetryKinds = [
  "never",
  "after-install",
  "after-auth",
  "after-config-change",
  "after-provider-update",
  "transient"
] as const;
export type AdapterRetryKind = (typeof adapterRetryKinds)[number];

export const adapterMissingEvidenceKinds = [
  "executable-identity",
  "executable-version",
  "trusted-helper-identity",
  "behavioral-check",
  "wire-version",
  "capability",
  "authentication",
  "contained-loopback",
  "configuration"
] as const;
export type AdapterMissingEvidenceKind = (typeof adapterMissingEvidenceKinds)[number];

declare const adapterIdBrand: unique symbol;
declare const providerIdBrand: unique symbol;
declare const nativeSessionIdBrand: unique symbol;
declare const runtimeNameBrand: unique symbol;

export type AdapterId = string & { readonly [adapterIdBrand]: "AdapterId" };
export type ProviderId = string & { readonly [providerIdBrand]: "ProviderId" };
export type NativeSessionId = string & { readonly [nativeSessionIdBrand]: "NativeSessionId" };
export type RuntimeName = string & { readonly [runtimeNameBrand]: "RuntimeName" };

export type ExecutableVersionRange = Readonly<{
  scheme: "semver";
  minInclusive: string;
  maxExclusive: string;
}>;
export type ExecutableVersionRangeInput = Readonly<{
  scheme: "semver";
  minInclusive: string;
  maxExclusive: string;
}>;

export type BehavioralProbePolicy = Readonly<{
  id: string;
  version: number;
  /** The central probe runner supplies the timeout and byte limits. */
  requiredChecks: readonly BehavioralProbeCheck[];
}>;
export type BehavioralProbePolicyInput = Readonly<{
  id: string;
  version: number;
  requiredChecks: readonly BehavioralProbeCheck[];
}>;

export type AdapterCompatibilityPolicy = Readonly<{
  executableVersion: ExecutableVersionRange;
  /** Native/negotiated wire values, not SDK or schema artifact versions. */
  wireVersions: readonly string[];
  behavioralProbe: BehavioralProbePolicy;
}>;
export type AdapterCompatibilityPolicyInput = Readonly<{
  executableVersion: ExecutableVersionRangeInput;
  wireVersions: readonly string[];
  behavioralProbe: BehavioralProbePolicyInput;
}>;

export type AdapterRuntimeIdentity = Readonly<{
  kind: "installed-executable";
  /** A logical executable name only; paths and command overrides are forbidden. */
  executable: RuntimeName;
  trustedHelpers: readonly RuntimeName[];
  resolution: "canonical-installed-only";
}>;
export type AdapterRuntimeIdentityInput = Readonly<{
  kind: "installed-executable";
  executable: string;
  trustedHelpers: readonly string[];
  resolution: "canonical-installed-only";
}>;

export type ControlledOptionSlot = Readonly<{
  name: string;
  kind: ControlledOptionKind;
  required: boolean;
}>;
export type ControlledOptionSlotInput = Readonly<{
  name: string;
  kind: ControlledOptionKind;
  required: boolean;
}>;

export type AdapterInvocationPolicy = Readonly<{
  /** Structured argv fragments, interpreted without a shell by the parent launcher. */
  fixedArguments: readonly string[];
  controlledOptions: readonly ControlledOptionSlot[];
  allowedEnvironmentNames: readonly string[];
  promptTransport: PromptTransportKind;
  systemPromptChannel: SystemPromptChannelKind;
}>;
export type AdapterInvocationPolicyInput = Readonly<{
  fixedArguments: readonly string[];
  controlledOptions: readonly ControlledOptionSlotInput[];
  allowedEnvironmentNames: readonly string[];
  promptTransport: PromptTransportKind;
  systemPromptChannel: SystemPromptChannelKind;
}>;

export type EnabledAdapterRolePolicy = Readonly<{
  status: "enabled";
  /** Provider-native controls supplement this mandatory outer boundary. */
  outerSandbox: "required";
  filesystem: "workspace-write" | "read-only";
  innerReadOnly: "required" | "not-required";
  requiredCapabilities: readonly AdapterCapabilityName[];
}>;

export type UnavailableAdapterRolePolicy = Readonly<{
  status: "unavailable";
  refusal: Readonly<{
    code: AdapterRoleRefusalCode;
    detail: string;
  }>;
}>;

export type AdapterRolePolicy = EnabledAdapterRolePolicy | UnavailableAdapterRolePolicy;
export type AdapterRolePolicyInput = AdapterRolePolicy;

export type AdapterRolePolicies = Readonly<{
  worker: AdapterRolePolicy;
  reviewer: AdapterRolePolicy;
}>;
export type AdapterRolePoliciesInput = Readonly<{
  worker: AdapterRolePolicyInput;
  reviewer: AdapterRolePolicyInput;
}>;

export type AdapterCodecIdentity = Readonly<{
  id: string;
  version: number;
}>;
export type AdapterCodecIdentityInput = Readonly<{
  id: string;
  version: number;
}>;

export type AdapterNormalizerIdentity = Readonly<{
  id: string;
  version: number;
}>;
export type AdapterNormalizerIdentityInput = Readonly<{
  id: string;
  version: number;
}>;

export type AdapterDescriptor = Readonly<{
  schemaVersion: typeof ADAPTER_DESCRIPTOR_SCHEMA_VERSION;
  contractVersion: typeof ADAPTER_CONTRACT_VERSION;
  id: AdapterId;
  providerId: ProviderId;
  transportKind: AdapterTransportKind;
  runtimeIdentity: AdapterRuntimeIdentity;
  compatibility: AdapterCompatibilityPolicy;
  invocationPolicy: AdapterInvocationPolicy;
  capabilityPolicy: CapabilityPolicy;
  codec: AdapterCodecIdentity;
  normalizer: AdapterNormalizerIdentity;
  roles: AdapterRolePolicies;
}>;

export type AdapterDescriptorInput = Readonly<{
  schemaVersion: typeof ADAPTER_DESCRIPTOR_SCHEMA_VERSION;
  contractVersion: typeof ADAPTER_CONTRACT_VERSION;
  id: string;
  providerId: string;
  transportKind: AdapterTransportKind;
  runtimeIdentity: AdapterRuntimeIdentityInput;
  compatibility: AdapterCompatibilityPolicyInput;
  invocationPolicy: AdapterInvocationPolicyInput;
  capabilityPolicy: CapabilityPolicyInput;
  codec: AdapterCodecIdentityInput;
  normalizer: AdapterNormalizerIdentityInput;
  roles: AdapterRolePoliciesInput;
}>;

export type RuntimeFileEvidence = Readonly<{
  runtimeName: RuntimeName;
  canonicalPath: string;
  /** Parent-produced stable identity token, revalidated immediately before launch. */
  identity: string;
}>;
export type RuntimeFileEvidenceInput = Readonly<{
  runtimeName: string;
  canonicalPath: string;
  identity: string;
}>;

export type BehavioralCheckEvidence = Readonly<{
  check: BehavioralProbeCheck;
  outcome: "passed";
  evidenceSha256: string;
}>;
export type BehavioralCheckEvidenceInput = Readonly<{
  check: BehavioralProbeCheck;
  outcome: "passed";
  evidenceSha256: string;
}>;

export type AdapterEvidenceBinding = Readonly<{
  adapterId: AdapterId;
  contractVersion: typeof ADAPTER_CONTRACT_VERSION;
  normalizer: AdapterNormalizerIdentity;
}>;
export type AdapterEvidenceBindingInput = Readonly<{
  adapterId: string;
  contractVersion: number;
  normalizer: AdapterNormalizerIdentityInput;
}>;

export type AvailableAdapterEvidence = Readonly<{
  status: "available";
  binding: AdapterEvidenceBinding;
  executable: RuntimeFileEvidence;
  trustedHelpers: readonly RuntimeFileEvidence[];
  observedExecutableVersion: string;
  supportedExecutableRange: ExecutableVersionRange;
  wireVersion: string;
  behavioralChecks: readonly BehavioralCheckEvidence[];
  capabilities: CapabilityEvidenceSet;
  probedAt: string;
  /** Hash of every adapter-consulted configuration value. */
  consultedConfigSha256: string;
}>;

export type AvailableAdapterEvidenceInput = Readonly<{
  status: "available";
  binding: AdapterEvidenceBindingInput;
  executable: RuntimeFileEvidenceInput;
  trustedHelpers: readonly RuntimeFileEvidenceInput[];
  observedExecutableVersion: string;
  supportedExecutableRange: ExecutableVersionRangeInput;
  wireVersion: string;
  behavioralChecks: readonly BehavioralCheckEvidenceInput[];
  capabilities: CapabilityEvidenceSetInput;
  probedAt: string;
  consultedConfigSha256: string;
}>;

export type MissingAdapterEvidence = Readonly<{
  kind: AdapterMissingEvidenceKind;
  detail: string;
}>;
export type MissingAdapterEvidenceInput = Readonly<{
  kind: AdapterMissingEvidenceKind;
  detail: string;
}>;

export type UnavailableAdapterEvidence = Readonly<{
  status: "unavailable";
  binding: AdapterEvidenceBinding;
  reason: Readonly<{
    code: AdapterUnavailableReasonCode;
    detail: string;
    retry: AdapterRetryKind;
  }>;
  missingEvidence: readonly MissingAdapterEvidence[];
  observedExecutableVersion?: string;
  observedWireVersion?: string;
  probedAt: string;
  consultedConfigSha256: string;
}>;

export type UnavailableAdapterEvidenceInput = Readonly<{
  status: "unavailable";
  binding: AdapterEvidenceBindingInput;
  reason: Readonly<{
    code: AdapterUnavailableReasonCode;
    detail: string;
    retry: AdapterRetryKind;
  }>;
  missingEvidence: readonly MissingAdapterEvidenceInput[];
  observedExecutableVersion?: string;
  observedWireVersion?: string;
  probedAt: string;
  consultedConfigSha256: string;
}>;

export type AdapterAvailability = AvailableAdapterEvidence | UnavailableAdapterEvidence;
export type AdapterAvailabilityInput = AvailableAdapterEvidenceInput | UnavailableAdapterEvidenceInput;

export type AdapterReplayBinding = Readonly<{
  adapterId: AdapterId;
  contractVersion: typeof ADAPTER_CONTRACT_VERSION;
  transportKind: AdapterTransportKind;
  wireVersion: string;
  codec: AdapterCodecIdentity;
  normalizer: AdapterNormalizerIdentity;
}>;
export type AdapterReplayBindingInput = Readonly<{
  adapterId: string;
  contractVersion: number;
  transportKind: AdapterTransportKind;
  wireVersion: string;
  codec: AdapterCodecIdentityInput;
  normalizer: AdapterNormalizerIdentityInput;
}>;

export type EligibleAdapterRoleDecision = Readonly<{
  status: "eligible";
  role: AdapterRoleName;
  outerSandbox: "required";
  filesystem: "workspace-write" | "read-only";
  innerReadOnly: "required" | "not-required";
  requiredCapabilities: readonly AdapterCapabilityName[];
}>;

export type UnavailableAdapterRoleDecision = Readonly<{
  status: "unavailable";
  role: AdapterRoleName;
  refusal: Readonly<{
    code: AdapterRoleRefusalCode;
    detail: string;
    missingCapabilities: readonly AdapterCapabilityName[];
  }>;
}>;

export type AdapterRoleDecision = EligibleAdapterRoleDecision | UnavailableAdapterRoleDecision;

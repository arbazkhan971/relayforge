import {
  ADAPTER_CONTRACT_VERSION,
  ADAPTER_DESCRIPTOR_SCHEMA_VERSION,
  adapterCapabilityNames,
  adapterMissingEvidenceKinds,
  adapterRetryKinds,
  adapterRoleNames,
  adapterRoleRefusalCodes,
  adapterTransportKinds,
  adapterUnavailableReasonCodes,
  behavioralProbeChecks,
  capabilityEvidenceSources,
  capabilityRequirementKinds,
  capabilityUnknownReasons,
  controlledOptionKinds,
  promptTransportKinds,
  systemPromptChannelKinds,
  type AdapterAvailability,
  type AdapterAvailabilityInput,
  type AdapterCapabilityName,
  type AdapterDescriptor,
  type AdapterDescriptorInput,
  type AdapterEvidenceBinding,
  type AdapterId,
  type AdapterReplayBinding,
  type AdapterReplayBindingInput,
  type AdapterRoleDecision,
  type AdapterRoleName,
  type AdapterRolePolicy,
  type AvailableAdapterEvidence,
  type BehavioralProbeCheck,
  type CapabilityEvidence,
  type CapabilityEvidenceSet,
  type CapabilityPolicy,
  type ControlledOptionKind,
  type ExecutableVersionRange,
  type AdapterMissingEvidenceKind,
  type AdapterRoleRefusalCode,
  type NativeSessionId,
  type ProviderId,
  type RuntimeFileEvidence,
  type RuntimeName,
  type UnavailableAdapterEvidence
} from "./types.js";

/** These are descriptor metadata limits, not provider-output or process limits. */
export const ADAPTER_DESCRIPTOR_LIMITS = Object.freeze({
  maxDescriptors: 64,
  maxIdBytes: 64,
  maxRuntimeNameBytes: 128,
  maxVersionBytes: 128,
  maxWireVersions: 8,
  maxFixedArguments: 64,
  maxArgumentBytes: 4_096,
  maxArgumentsTotalBytes: 32_768,
  maxControlledOptions: 16,
  maxEnvironmentNames: 64,
  maxProbeChecks: 16,
  maxEvidenceDetailBytes: 2_048,
  maxPathBytes: 4_096,
  maxIdentityBytes: 512,
  maxMissingEvidence: 32,
  maxNativeSessionIdBytes: 512
});

export const adapterRegistryErrorCodes = [
  "INVALID_DESCRIPTOR",
  "DUPLICATE_ADAPTER",
  "UNKNOWN_ADAPTER",
  "INVALID_EVIDENCE",
  "REPLAY_BINDING_MISMATCH"
] as const;
export type AdapterRegistryErrorCode = (typeof adapterRegistryErrorCodes)[number];

export class AdapterRegistryError extends Error {
  readonly code: AdapterRegistryErrorCode;
  readonly adapterId?: string;

  constructor(code: AdapterRegistryErrorCode, message: string, adapterId?: string) {
    super(message);
    this.name = "AdapterRegistryError";
    this.code = code;
    this.adapterId = adapterId;
  }
}

const transportKinds = new Set<string>(adapterTransportKinds);
const promptKinds = new Set<string>(promptTransportKinds);
const systemPromptKinds = new Set<string>(systemPromptChannelKinds);
const capabilityNames = new Set<string>(adapterCapabilityNames);
const capabilityRequirements = new Set<string>(capabilityRequirementKinds);
const capabilitySources = new Set<string>(capabilityEvidenceSources);
const unknownReasons = new Set<string>(capabilityUnknownReasons);
const probeChecks = new Set<string>(behavioralProbeChecks);
const optionKinds = new Set<string>(controlledOptionKinds);
const roleNames = new Set<string>(adapterRoleNames);
const roleRefusalCodes = new Set<string>(adapterRoleRefusalCodes);
const unavailableReasonCodes = new Set<string>(adapterUnavailableReasonCodes);
const retryKinds = new Set<string>(adapterRetryKinds);
const missingEvidenceKinds = new Set<string>(adapterMissingEvidenceKinds);
const forbiddenRuntimeNames = new Set([
  "bash",
  "bunx",
  "cmd",
  "env",
  "npm",
  "npx",
  "pnpm",
  "powershell",
  "pwsh",
  "sh",
  "yarn"
]);

function fail(code: AdapterRegistryErrorCode, path: string, message: string, adapterId?: string): never {
  throw new AdapterRegistryError(code, `${path}: ${message}`, adapterId);
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function assertWellFormedUnicode(value: string, code: AdapterRegistryErrorCode, path: string, adapterId?: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail(code, path, "contains an unpaired high surrogate", adapterId);
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail(code, path, "contains an unpaired low surrogate", adapterId);
    }
  }
}

function boundedString(
  value: unknown,
  path: string,
  options: { min?: number; max: number; pattern?: RegExp; noNul?: boolean },
  code: AdapterRegistryErrorCode,
  adapterId?: string
): string {
  if (typeof value !== "string") fail(code, path, "must be a string", adapterId);
  assertWellFormedUnicode(value, code, path, adapterId);
  const bytes = utf8Bytes(value);
  if (bytes < (options.min ?? 1) || bytes > options.max) {
    fail(code, path, `must be ${(options.min ?? 1)}..${options.max} UTF-8 bytes`, adapterId);
  }
  if (options.noNul !== false && value.includes("\0")) fail(code, path, "must not contain NUL", adapterId);
  if (options.pattern && !options.pattern.test(value)) fail(code, path, "has an invalid format", adapterId);
  return value;
}

function exactObject(
  value: unknown,
  allowedKeys: readonly string[],
  path: string,
  code: AdapterRegistryErrorCode,
  adapterId?: string
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(code, path, "must be a plain object", adapterId);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code, path, "must be a plain data object", adapterId);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail(code, path, "must not contain symbol keys", adapterId);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor.get || descriptor.set) fail(code, `${path}.${key}`, "accessors are not allowed", adapterId);
  }
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!allowedKeys.includes(key)) fail(code, `${path}.${key}`, "is not allowed by the closed schema", adapterId);
  }
  for (const key of allowedKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(code, `${path}.${key}`, "is required", adapterId);
  }
  return value as Record<string, unknown>;
}

function exactObjectWithOptional(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  path: string,
  code: AdapterRegistryErrorCode,
  adapterId?: string
): Record<string, unknown> {
  const obj = exactObjectShape(value, [...requiredKeys, ...optionalKeys], path, code, adapterId);
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) fail(code, `${path}.${key}`, "is required", adapterId);
  }
  return obj;
}

function exactObjectShape(
  value: unknown,
  allowedKeys: readonly string[],
  path: string,
  code: AdapterRegistryErrorCode,
  adapterId?: string
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(code, path, "must be a plain object", adapterId);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code, path, "must be a plain data object", adapterId);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail(code, path, "must not contain symbol keys", adapterId);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor.get || descriptor.set) fail(code, `${path}.${key}`, "accessors are not allowed", adapterId);
  }
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) fail(code, `${path}.${key}`, "is not allowed by the closed schema", adapterId);
  }
  return value as Record<string, unknown>;
}

function enumValue<T extends string>(
  value: unknown,
  values: ReadonlySet<string>,
  path: string,
  code: AdapterRegistryErrorCode,
  adapterId?: string
): T {
  if (typeof value !== "string" || !values.has(value)) fail(code, path, "has an unsupported value", adapterId);
  return value as T;
}

function positiveVersion(value: unknown, path: string, code: AdapterRegistryErrorCode, adapterId?: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(code, path, "must be a positive safe integer", adapterId);
  return value as number;
}

function bool(value: unknown, path: string, code: AdapterRegistryErrorCode, adapterId?: string): boolean {
  if (typeof value !== "boolean") fail(code, path, "must be a boolean", adapterId);
  return value;
}

function array(value: unknown, path: string, code: AdapterRegistryErrorCode, adapterId?: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(code, path, "must be an array", adapterId);
  return value;
}

function unique<T>(values: readonly T[], path: string, code: AdapterRegistryErrorCode, adapterId?: string): void {
  if (new Set(values).size !== values.length) fail(code, path, "must contain unique values", adapterId);
}

function parseId(value: unknown, path: string, code: AdapterRegistryErrorCode, adapterId?: string): string {
  return boundedString(value, path, {
    max: ADAPTER_DESCRIPTOR_LIMITS.maxIdBytes,
    pattern: /^[a-z][a-z0-9._-]*$/
  }, code, adapterId);
}

function parseRuntimeName(value: unknown, path: string, code: AdapterRegistryErrorCode, adapterId?: string): RuntimeName {
  const name = boundedString(value, path, {
    max: ADAPTER_DESCRIPTOR_LIMITS.maxRuntimeNameBytes,
    pattern: /^[A-Za-z0-9][A-Za-z0-9._+-]*$/
  }, code, adapterId);
  if (forbiddenRuntimeNames.has(name.toLowerCase())) {
    fail(code, path, "must name an installed provider runtime, not a shell or package runner", adapterId);
  }
  return name as RuntimeName;
}

type ParsedSemver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly (number | string)[];
};

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseSemver(value: unknown, path: string, code: AdapterRegistryErrorCode, adapterId?: string): ParsedSemver {
  const text = boundedString(value, path, { max: ADAPTER_DESCRIPTOR_LIMITS.maxVersionBytes }, code, adapterId);
  const match = SEMVER_PATTERN.exec(text);
  if (!match) fail(code, path, "must be a canonical semantic version", adapterId);
  const core = [match[1], match[2], match[3]].map(Number);
  if (core.some((part) => !Number.isSafeInteger(part))) fail(code, path, "semantic-version component is too large", adapterId);
  const prerelease = match[4]
    ? match[4].split(".").map((part) => /^\d+$/.test(part) ? Number(part) : part)
    : [];
  if (prerelease.some((part) => typeof part === "number" && !Number.isSafeInteger(part))) {
    fail(code, path, "semantic-version prerelease component is too large", adapterId);
  }
  return { major: core[0]!, minor: core[1]!, patch: core[2]!, prerelease };
}

function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined || right === undefined) return left === undefined ? -1 : 1;
    if (left === right) continue;
    if (typeof left === "number" && typeof right === "number") return left < right ? -1 : 1;
    if (typeof left === "number") return -1;
    if (typeof right === "number") return 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

function versionRange(
  value: unknown,
  path: string,
  code: AdapterRegistryErrorCode,
  adapterId?: string
): ExecutableVersionRange {
  const obj = exactObject(value, ["scheme", "minInclusive", "maxExclusive"], path, code, adapterId);
  if (obj.scheme !== "semver") fail(code, `${path}.scheme`, "must be semver", adapterId);
  const minInclusive = boundedString(obj.minInclusive, `${path}.minInclusive`, { max: ADAPTER_DESCRIPTOR_LIMITS.maxVersionBytes }, code, adapterId);
  const maxExclusive = boundedString(obj.maxExclusive, `${path}.maxExclusive`, { max: ADAPTER_DESCRIPTOR_LIMITS.maxVersionBytes }, code, adapterId);
  const min = parseSemver(minInclusive, `${path}.minInclusive`, code, adapterId);
  const max = parseSemver(maxExclusive, `${path}.maxExclusive`, code, adapterId);
  if (compareSemver(min, max) >= 0) fail(code, path, "minInclusive must be lower than maxExclusive", adapterId);
  return { scheme: "semver", minInclusive, maxExclusive };
}

export function isExecutableVersionSupported(version: string, range: ExecutableVersionRange): boolean {
  try {
    const observed = parseSemver(version, "version", "INVALID_EVIDENCE");
    const min = parseSemver(range.minInclusive, "range.minInclusive", "INVALID_EVIDENCE");
    const max = parseSemver(range.maxExclusive, "range.maxExclusive", "INVALID_EVIDENCE");
    return compareSemver(observed, min) >= 0 && compareSemver(observed, max) < 0;
  } catch (error) {
    if (error instanceof AdapterRegistryError) return false;
    throw error;
  }
}

function readonlyCopy<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) readonlyCopy(nested);
    Object.freeze(value);
  }
  return value;
}

function stringArray(
  value: unknown,
  path: string,
  options: { maxItems: number; maxItemBytes: number; pattern?: RegExp; allowEmptyItem?: boolean; uniqueItems?: boolean },
  code: AdapterRegistryErrorCode,
  adapterId?: string
): readonly string[] {
  const values = array(value, path, code, adapterId);
  if (values.length > options.maxItems) fail(code, path, `must contain at most ${options.maxItems} items`, adapterId);
  const parsed = values.map((item, index) => boundedString(item, `${path}[${index}]`, {
    min: options.allowEmptyItem ? 0 : 1,
    max: options.maxItemBytes,
    pattern: options.pattern
  }, code, adapterId));
  if (options.uniqueItems !== false) unique(parsed, path, code, adapterId);
  return parsed;
}

function capabilityNameArray(
  value: unknown,
  path: string,
  code: AdapterRegistryErrorCode,
  adapterId?: string
): readonly AdapterCapabilityName[] {
  const values = array(value, path, code, adapterId);
  if (values.length > adapterCapabilityNames.length) fail(code, path, "contains too many capabilities", adapterId);
  const parsed = values.map((item, index) => enumValue<AdapterCapabilityName>(item, capabilityNames, `${path}[${index}]`, code, adapterId));
  unique(parsed, path, code, adapterId);
  return parsed;
}

function capabilityPolicy(value: unknown, path: string, adapterId: string): CapabilityPolicy {
  const obj = exactObject(value, adapterCapabilityNames, path, "INVALID_DESCRIPTOR", adapterId);
  const policy = Object.fromEntries(adapterCapabilityNames.map((name) => [
    name,
    enumValue(obj[name], capabilityRequirements, `${path}.${name}`, "INVALID_DESCRIPTOR", adapterId)
  ])) as Record<AdapterCapabilityName, "required" | "optional" | "unsupported">;
  return policy;
}

function descriptorIdentity(value: unknown, path: string, adapterId: string): { id: string; version: number } {
  const obj = exactObject(value, ["id", "version"], path, "INVALID_DESCRIPTOR", adapterId);
  return {
    id: parseId(obj.id, `${path}.id`, "INVALID_DESCRIPTOR", adapterId),
    version: positiveVersion(obj.version, `${path}.version`, "INVALID_DESCRIPTOR", adapterId)
  };
}

function rolePolicy(value: unknown, role: AdapterRoleName, policy: CapabilityPolicy, adapterId: string): AdapterRolePolicy {
  const path = `descriptor.roles.${role}`;
  const shaped = exactObjectShape(
    value,
    ["status", "outerSandbox", "filesystem", "innerReadOnly", "requiredCapabilities", "refusal"],
    path,
    "INVALID_DESCRIPTOR",
    adapterId
  );
  if (shaped.status === "unavailable") {
    const obj = exactObject(value, ["status", "refusal"], path, "INVALID_DESCRIPTOR", adapterId);
    const refusal = exactObject(obj.refusal, ["code", "detail"], `${path}.refusal`, "INVALID_DESCRIPTOR", adapterId);
    return {
      status: "unavailable" as const,
      refusal: {
        code: enumValue<AdapterRoleRefusalCode>(refusal.code, roleRefusalCodes, `${path}.refusal.code`, "INVALID_DESCRIPTOR", adapterId),
        detail: boundedString(refusal.detail, `${path}.refusal.detail`, { max: ADAPTER_DESCRIPTOR_LIMITS.maxEvidenceDetailBytes }, "INVALID_DESCRIPTOR", adapterId)
      }
    };
  }
  const obj = exactObject(
    value,
    ["status", "outerSandbox", "filesystem", "innerReadOnly", "requiredCapabilities"],
    path,
    "INVALID_DESCRIPTOR",
    adapterId
  );
  if (obj.status !== "enabled") fail("INVALID_DESCRIPTOR", `${path}.status`, "must be enabled or unavailable", adapterId);
  if (obj.outerSandbox !== "required") fail("INVALID_DESCRIPTOR", `${path}.outerSandbox`, "must require the parent-owned sandbox", adapterId);
  const expectedFilesystem = role === "reviewer" ? "read-only" : "workspace-write";
  if (obj.filesystem !== expectedFilesystem) {
    fail("INVALID_DESCRIPTOR", `${path}.filesystem`, `must be ${expectedFilesystem}`, adapterId);
  }
  if (obj.innerReadOnly !== "required" && obj.innerReadOnly !== "not-required") {
    fail("INVALID_DESCRIPTOR", `${path}.innerReadOnly`, "must be required or not-required", adapterId);
  }
  if (role === "worker" && obj.innerReadOnly !== "not-required") {
    fail("INVALID_DESCRIPTOR", `${path}.innerReadOnly`, "worker policy cannot require reviewer inner read-only", adapterId);
  }
  const requiredCapabilities = capabilityNameArray(obj.requiredCapabilities, `${path}.requiredCapabilities`, "INVALID_DESCRIPTOR", adapterId);
  for (const capability of requiredCapabilities) {
    if (policy[capability] === "unsupported") {
      fail("INVALID_DESCRIPTOR", `${path}.requiredCapabilities`, `cannot require unsupported capability ${capability}`, adapterId);
    }
  }
  const hasInnerReadOnly = requiredCapabilities.includes("inner-read-only");
  if ((obj.innerReadOnly === "required") !== hasInnerReadOnly) {
    fail("INVALID_DESCRIPTOR", path, "innerReadOnly and the inner-read-only capability requirement must agree", adapterId);
  }
  return {
    status: "enabled" as const,
    outerSandbox: "required" as const,
    filesystem: expectedFilesystem,
    innerReadOnly: obj.innerReadOnly,
    requiredCapabilities
  };
}

/** Validate, copy, and recursively freeze a shipped data descriptor. */
export function defineAdapterDescriptor(value: AdapterDescriptorInput | unknown): AdapterDescriptor {
  const obj = exactObject(
    value,
    [
      "schemaVersion",
      "contractVersion",
      "id",
      "providerId",
      "transportKind",
      "runtimeIdentity",
      "compatibility",
      "invocationPolicy",
      "capabilityPolicy",
      "codec",
      "normalizer",
      "roles"
    ],
    "descriptor",
    "INVALID_DESCRIPTOR"
  );
  const id = parseId(obj.id, "descriptor.id", "INVALID_DESCRIPTOR");
  if (obj.schemaVersion !== ADAPTER_DESCRIPTOR_SCHEMA_VERSION) {
    fail("INVALID_DESCRIPTOR", "descriptor.schemaVersion", `must be ${ADAPTER_DESCRIPTOR_SCHEMA_VERSION}`, id);
  }
  if (obj.contractVersion !== ADAPTER_CONTRACT_VERSION) {
    fail("INVALID_DESCRIPTOR", "descriptor.contractVersion", `must be ${ADAPTER_CONTRACT_VERSION}`, id);
  }
  const providerId = parseId(obj.providerId, "descriptor.providerId", "INVALID_DESCRIPTOR", id);
  const transportKind = enumValue<AdapterDescriptor["transportKind"]>(
    obj.transportKind,
    transportKinds,
    "descriptor.transportKind",
    "INVALID_DESCRIPTOR",
    id
  );

  const runtime = exactObject(
    obj.runtimeIdentity,
    ["kind", "executable", "trustedHelpers", "resolution"],
    "descriptor.runtimeIdentity",
    "INVALID_DESCRIPTOR",
    id
  );
  if (runtime.kind !== "installed-executable") fail("INVALID_DESCRIPTOR", "descriptor.runtimeIdentity.kind", "must be installed-executable", id);
  if (runtime.resolution !== "canonical-installed-only") {
    fail("INVALID_DESCRIPTOR", "descriptor.runtimeIdentity.resolution", "must be canonical-installed-only", id);
  }
  const executable = parseRuntimeName(runtime.executable, "descriptor.runtimeIdentity.executable", "INVALID_DESCRIPTOR", id);
  const trustedHelpers = stringArray(runtime.trustedHelpers, "descriptor.runtimeIdentity.trustedHelpers", {
    maxItems: 8,
    maxItemBytes: ADAPTER_DESCRIPTOR_LIMITS.maxRuntimeNameBytes,
    pattern: /^[A-Za-z0-9][A-Za-z0-9._+-]*$/
  }, "INVALID_DESCRIPTOR", id).map((helper, index) =>
    parseRuntimeName(helper, `descriptor.runtimeIdentity.trustedHelpers[${index}]`, "INVALID_DESCRIPTOR", id)
  );
  if (trustedHelpers.includes(executable)) {
    fail("INVALID_DESCRIPTOR", "descriptor.runtimeIdentity.trustedHelpers", "must not repeat the provider executable", id);
  }

  const compatibilityObject = exactObject(
    obj.compatibility,
    ["executableVersion", "wireVersions", "behavioralProbe"],
    "descriptor.compatibility",
    "INVALID_DESCRIPTOR",
    id
  );
  const executableVersion = versionRange(compatibilityObject.executableVersion, "descriptor.compatibility.executableVersion", "INVALID_DESCRIPTOR", id);
  const wireVersions = stringArray(compatibilityObject.wireVersions, "descriptor.compatibility.wireVersions", {
    maxItems: ADAPTER_DESCRIPTOR_LIMITS.maxWireVersions,
    maxItemBytes: ADAPTER_DESCRIPTOR_LIMITS.maxVersionBytes
  }, "INVALID_DESCRIPTOR", id);
  if (wireVersions.length === 0) fail("INVALID_DESCRIPTOR", "descriptor.compatibility.wireVersions", "must not be empty", id);
  if (transportKind === "acp-v1" && (wireVersions.length !== 1 || wireVersions[0] !== "1")) {
    fail("INVALID_DESCRIPTOR", "descriptor.compatibility.wireVersions", "ACP v1 descriptors must support exactly negotiated wire version 1", id);
  }
  const probe = exactObject(
    compatibilityObject.behavioralProbe,
    ["id", "version", "requiredChecks"],
    "descriptor.compatibility.behavioralProbe",
    "INVALID_DESCRIPTOR",
    id
  );
  const probeId = parseId(probe.id, "descriptor.compatibility.behavioralProbe.id", "INVALID_DESCRIPTOR", id);
  const probeVersion = positiveVersion(probe.version, "descriptor.compatibility.behavioralProbe.version", "INVALID_DESCRIPTOR", id);
  const checksRaw = array(probe.requiredChecks, "descriptor.compatibility.behavioralProbe.requiredChecks", "INVALID_DESCRIPTOR", id);
  if (checksRaw.length === 0 || checksRaw.length > ADAPTER_DESCRIPTOR_LIMITS.maxProbeChecks) {
    fail("INVALID_DESCRIPTOR", "descriptor.compatibility.behavioralProbe.requiredChecks", `must contain 1..${ADAPTER_DESCRIPTOR_LIMITS.maxProbeChecks} checks`, id);
  }
  const requiredChecks = checksRaw.map((check, index) => enumValue<BehavioralProbeCheck>(
    check,
    probeChecks,
    `descriptor.compatibility.behavioralProbe.requiredChecks[${index}]`,
    "INVALID_DESCRIPTOR",
    id
  ));
  unique(requiredChecks, "descriptor.compatibility.behavioralProbe.requiredChecks", "INVALID_DESCRIPTOR", id);
  if (!requiredChecks.includes("executable-version")) {
    fail("INVALID_DESCRIPTOR", "descriptor.compatibility.behavioralProbe.requiredChecks", "must include executable-version", id);
  }
  if (!requiredChecks.includes("transport-handshake")) {
    fail("INVALID_DESCRIPTOR", "descriptor.compatibility.behavioralProbe.requiredChecks", "must include transport-handshake", id);
  }

  const invocation = exactObject(
    obj.invocationPolicy,
    ["fixedArguments", "controlledOptions", "allowedEnvironmentNames", "promptTransport", "systemPromptChannel"],
    "descriptor.invocationPolicy",
    "INVALID_DESCRIPTOR",
    id
  );
  const fixedArguments = stringArray(invocation.fixedArguments, "descriptor.invocationPolicy.fixedArguments", {
    maxItems: ADAPTER_DESCRIPTOR_LIMITS.maxFixedArguments,
    maxItemBytes: ADAPTER_DESCRIPTOR_LIMITS.maxArgumentBytes,
    allowEmptyItem: true,
    uniqueItems: false
  }, "INVALID_DESCRIPTOR", id);
  const argumentsTotalBytes = fixedArguments.reduce((total, argument) => total + utf8Bytes(argument), 0);
  if (argumentsTotalBytes > ADAPTER_DESCRIPTOR_LIMITS.maxArgumentsTotalBytes) {
    fail("INVALID_DESCRIPTOR", "descriptor.invocationPolicy.fixedArguments", "exceeds the aggregate byte limit", id);
  }
  const controlledRaw = array(invocation.controlledOptions, "descriptor.invocationPolicy.controlledOptions", "INVALID_DESCRIPTOR", id);
  if (controlledRaw.length > ADAPTER_DESCRIPTOR_LIMITS.maxControlledOptions) {
    fail("INVALID_DESCRIPTOR", "descriptor.invocationPolicy.controlledOptions", "contains too many option slots", id);
  }
  const controlledOptions = controlledRaw.map((entry, index) => {
    const path = `descriptor.invocationPolicy.controlledOptions[${index}]`;
    const option = exactObject(entry, ["name", "kind", "required"], path, "INVALID_DESCRIPTOR", id);
    return {
      name: parseId(option.name, `${path}.name`, "INVALID_DESCRIPTOR", id),
      kind: enumValue<ControlledOptionKind>(option.kind, optionKinds, `${path}.kind`, "INVALID_DESCRIPTOR", id),
      required: bool(option.required, `${path}.required`, "INVALID_DESCRIPTOR", id)
    };
  });
  unique(controlledOptions.map((option) => option.name), "descriptor.invocationPolicy.controlledOptions.name", "INVALID_DESCRIPTOR", id);
  const allowedEnvironmentNames = stringArray(
    invocation.allowedEnvironmentNames,
    "descriptor.invocationPolicy.allowedEnvironmentNames",
    { maxItems: ADAPTER_DESCRIPTOR_LIMITS.maxEnvironmentNames, maxItemBytes: 128, pattern: /^[A-Z][A-Z0-9_]*$/ },
    "INVALID_DESCRIPTOR",
    id
  );
  const promptTransport = enumValue<AdapterDescriptor["invocationPolicy"]["promptTransport"]>(
    invocation.promptTransport,
    promptKinds,
    "descriptor.invocationPolicy.promptTransport",
    "INVALID_DESCRIPTOR",
    id
  );
  const systemPromptChannel = enumValue<AdapterDescriptor["invocationPolicy"]["systemPromptChannel"]>(
    invocation.systemPromptChannel,
    systemPromptKinds,
    "descriptor.invocationPolicy.systemPromptChannel",
    "INVALID_DESCRIPTOR",
    id
  );
  if ((transportKind === "acp-v1" || transportKind === "app-server-jsonrpc") && promptTransport !== "stdio-jsonrpc") {
    fail("INVALID_DESCRIPTOR", "descriptor.invocationPolicy.promptTransport", `${transportKind} requires stdio-jsonrpc`, id);
  }
  if (transportKind === "rpc-jsonl" && promptTransport !== "stdin-jsonl") {
    fail("INVALID_DESCRIPTOR", "descriptor.invocationPolicy.promptTransport", "rpc-jsonl requires stdin-jsonl", id);
  }

  const policy = capabilityPolicy(obj.capabilityPolicy, "descriptor.capabilityPolicy", id);
  const codec = descriptorIdentity(obj.codec, "descriptor.codec", id);
  const normalizer = descriptorIdentity(obj.normalizer, "descriptor.normalizer", id);
  const rolesObject = exactObject(obj.roles, ["worker", "reviewer"], "descriptor.roles", "INVALID_DESCRIPTOR", id);
  const roles = {
    worker: rolePolicy(rolesObject.worker, "worker", policy, id),
    reviewer: rolePolicy(rolesObject.reviewer, "reviewer", policy, id)
  };

  const descriptor: AdapterDescriptor = {
    schemaVersion: ADAPTER_DESCRIPTOR_SCHEMA_VERSION,
    contractVersion: ADAPTER_CONTRACT_VERSION,
    id: id as AdapterId,
    providerId: providerId as ProviderId,
    transportKind,
    runtimeIdentity: {
      kind: "installed-executable",
      executable,
      trustedHelpers,
      resolution: "canonical-installed-only"
    },
    compatibility: {
      executableVersion,
      wireVersions,
      behavioralProbe: { id: probeId, version: probeVersion, requiredChecks }
    },
    invocationPolicy: {
      fixedArguments,
      controlledOptions,
      allowedEnvironmentNames,
      promptTransport,
      systemPromptChannel
    },
    capabilityPolicy: policy,
    codec,
    normalizer,
    roles
  };
  return readonlyCopy(descriptor);
}

function sha256(value: unknown, path: string, code: AdapterRegistryErrorCode, adapterId: string): string {
  return boundedString(value, path, { max: 64, pattern: /^[a-f0-9]{64}$/ }, code, adapterId);
}

function canonicalTimestamp(value: unknown, path: string, code: AdapterRegistryErrorCode, adapterId: string): string {
  const timestamp = boundedString(value, path, { max: 24, pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/ }, code, adapterId);
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    fail(code, path, "must be a canonical UTC timestamp", adapterId);
  }
  return timestamp;
}

function evidenceBinding(value: unknown, descriptor: AdapterDescriptor, path: string): AdapterEvidenceBinding {
  const adapterId = descriptor.id;
  const obj = exactObject(value, ["adapterId", "contractVersion", "normalizer"], path, "INVALID_EVIDENCE", adapterId);
  if (obj.adapterId !== descriptor.id) fail("INVALID_EVIDENCE", `${path}.adapterId`, `must be ${descriptor.id}`, adapterId);
  if (obj.contractVersion !== descriptor.contractVersion) {
    fail("INVALID_EVIDENCE", `${path}.contractVersion`, `must be ${descriptor.contractVersion}`, adapterId);
  }
  const normalizerObject = exactObject(obj.normalizer, ["id", "version"], `${path}.normalizer`, "INVALID_EVIDENCE", adapterId);
  if (normalizerObject.id !== descriptor.normalizer.id || normalizerObject.version !== descriptor.normalizer.version) {
    fail("INVALID_EVIDENCE", `${path}.normalizer`, "does not match the descriptor", adapterId);
  }
  return {
    adapterId: descriptor.id,
    contractVersion: descriptor.contractVersion,
    normalizer: { ...descriptor.normalizer }
  };
}

function runtimeFileEvidence(value: unknown, expected: RuntimeName, path: string, adapterId: string): RuntimeFileEvidence {
  const obj = exactObject(value, ["runtimeName", "canonicalPath", "identity"], path, "INVALID_EVIDENCE", adapterId);
  if (obj.runtimeName !== expected) fail("INVALID_EVIDENCE", `${path}.runtimeName`, `must be ${expected}`, adapterId);
  const canonicalPath = boundedString(obj.canonicalPath, `${path}.canonicalPath`, { max: ADAPTER_DESCRIPTOR_LIMITS.maxPathBytes }, "INVALID_EVIDENCE", adapterId);
  if (!canonicalPath.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(canonicalPath)) {
    fail("INVALID_EVIDENCE", `${path}.canonicalPath`, "must be absolute", adapterId);
  }
  const identity = boundedString(obj.identity, `${path}.identity`, { max: ADAPTER_DESCRIPTOR_LIMITS.maxIdentityBytes }, "INVALID_EVIDENCE", adapterId);
  return { runtimeName: expected, canonicalPath, identity };
}

function capabilityEvidence(value: unknown, name: AdapterCapabilityName, adapterId: string): CapabilityEvidence {
  const path = `availability.capabilities.${name}`;
  const shaped = exactObjectShape(value, ["status", "source", "reason", "detail"], path, "INVALID_EVIDENCE", adapterId);
  if (shaped.status === "proven") {
    const obj = exactObject(value, ["status", "source", "detail"], path, "INVALID_EVIDENCE", adapterId);
    return {
      status: "proven",
      source: enumValue(obj.source, capabilitySources, `${path}.source`, "INVALID_EVIDENCE", adapterId),
      detail: boundedString(obj.detail, `${path}.detail`, { max: ADAPTER_DESCRIPTOR_LIMITS.maxEvidenceDetailBytes }, "INVALID_EVIDENCE", adapterId)
    };
  }
  if (shaped.status === "unsupported") {
    const obj = exactObject(value, ["status", "source", "detail"], path, "INVALID_EVIDENCE", adapterId);
    const source = enumValue(obj.source, capabilitySources, `${path}.source`, "INVALID_EVIDENCE", adapterId);
    if (source === "behavioral-probe") fail("INVALID_EVIDENCE", `${path}.source`, "unsupported must come from negotiation or a native contract", adapterId);
    return {
      status: "unsupported",
      source: source as "protocol-negotiation" | "native-contract",
      detail: boundedString(obj.detail, `${path}.detail`, { max: ADAPTER_DESCRIPTOR_LIMITS.maxEvidenceDetailBytes }, "INVALID_EVIDENCE", adapterId)
    };
  }
  if (shaped.status === "unknown") {
    const obj = exactObject(value, ["status", "reason", "detail"], path, "INVALID_EVIDENCE", adapterId);
    return {
      status: "unknown",
      reason: enumValue(obj.reason, unknownReasons, `${path}.reason`, "INVALID_EVIDENCE", adapterId),
      detail: boundedString(obj.detail, `${path}.detail`, { max: ADAPTER_DESCRIPTOR_LIMITS.maxEvidenceDetailBytes }, "INVALID_EVIDENCE", adapterId)
    };
  }
  fail("INVALID_EVIDENCE", `${path}.status`, "must be proven, unsupported, or unknown", adapterId);
}

function capabilityEvidenceSet(value: unknown, descriptor: AdapterDescriptor): CapabilityEvidenceSet {
  const adapterId = descriptor.id;
  const obj = exactObject(value, adapterCapabilityNames, "availability.capabilities", "INVALID_EVIDENCE", adapterId);
  const result = Object.fromEntries(adapterCapabilityNames.map((name) => [name, capabilityEvidence(obj[name], name, adapterId)])) as Record<AdapterCapabilityName, CapabilityEvidence>;
  for (const name of adapterCapabilityNames) {
    const requirement = descriptor.capabilityPolicy[name];
    const evidence = result[name];
    if (requirement === "required" && evidence.status !== "proven") {
      fail("INVALID_EVIDENCE", `availability.capabilities.${name}`, "is required and must be proven", adapterId);
    }
    if (requirement === "unsupported" && evidence.status !== "unsupported") {
      fail("INVALID_EVIDENCE", `availability.capabilities.${name}`, "is declared unsupported and must remain explicit", adapterId);
    }
  }
  return result;
}

/** Validate and freeze compatibility evidence against one exact descriptor version. */
export function defineAdapterAvailability(
  descriptor: AdapterDescriptor,
  value: AdapterAvailabilityInput | unknown
): AdapterAvailability {
  const adapterId = descriptor.id;
  const shaped = exactObjectShape(
    value,
    [
      "status",
      "binding",
      "executable",
      "trustedHelpers",
      "observedExecutableVersion",
      "supportedExecutableRange",
      "wireVersion",
      "behavioralChecks",
      "capabilities",
      "reason",
      "missingEvidence",
      "observedWireVersion",
      "probedAt",
      "consultedConfigSha256"
    ],
    "availability",
    "INVALID_EVIDENCE",
    adapterId
  );
  if (shaped.status === "available") {
    const obj = exactObject(
      value,
      [
        "status",
        "binding",
        "executable",
        "trustedHelpers",
        "observedExecutableVersion",
        "supportedExecutableRange",
        "wireVersion",
        "behavioralChecks",
        "capabilities",
        "probedAt",
        "consultedConfigSha256"
      ],
      "availability",
      "INVALID_EVIDENCE",
      adapterId
    );
    const binding = evidenceBinding(obj.binding, descriptor, "availability.binding");
    const executable = runtimeFileEvidence(obj.executable, descriptor.runtimeIdentity.executable, "availability.executable", adapterId);
    const helpersRaw = array(obj.trustedHelpers, "availability.trustedHelpers", "INVALID_EVIDENCE", adapterId);
    if (helpersRaw.length !== descriptor.runtimeIdentity.trustedHelpers.length) {
      fail("INVALID_EVIDENCE", "availability.trustedHelpers", "must bind every trusted helper exactly once", adapterId);
    }
    const trustedHelpers = helpersRaw.map((helper, index) => runtimeFileEvidence(
      helper,
      descriptor.runtimeIdentity.trustedHelpers[index]!,
      `availability.trustedHelpers[${index}]`,
      adapterId
    ));
    const observedExecutableVersion = boundedString(obj.observedExecutableVersion, "availability.observedExecutableVersion", { max: ADAPTER_DESCRIPTOR_LIMITS.maxVersionBytes }, "INVALID_EVIDENCE", adapterId);
    parseSemver(observedExecutableVersion, "availability.observedExecutableVersion", "INVALID_EVIDENCE", adapterId);
    if (!isExecutableVersionSupported(observedExecutableVersion, descriptor.compatibility.executableVersion)) {
      fail("INVALID_EVIDENCE", "availability.observedExecutableVersion", "is outside the descriptor's supported range", adapterId);
    }
    const supportedExecutableRange = versionRange(obj.supportedExecutableRange, "availability.supportedExecutableRange", "INVALID_EVIDENCE", adapterId);
    if (
      supportedExecutableRange.minInclusive !== descriptor.compatibility.executableVersion.minInclusive ||
      supportedExecutableRange.maxExclusive !== descriptor.compatibility.executableVersion.maxExclusive
    ) {
      fail("INVALID_EVIDENCE", "availability.supportedExecutableRange", "does not match the descriptor", adapterId);
    }
    const wireVersion = boundedString(obj.wireVersion, "availability.wireVersion", { max: ADAPTER_DESCRIPTOR_LIMITS.maxVersionBytes }, "INVALID_EVIDENCE", adapterId);
    if (!descriptor.compatibility.wireVersions.includes(wireVersion)) {
      fail("INVALID_EVIDENCE", "availability.wireVersion", "is not supported by the descriptor", adapterId);
    }
    const checksRaw = array(obj.behavioralChecks, "availability.behavioralChecks", "INVALID_EVIDENCE", adapterId);
    if (checksRaw.length !== descriptor.compatibility.behavioralProbe.requiredChecks.length) {
      fail("INVALID_EVIDENCE", "availability.behavioralChecks", "must contain every required behavioral check exactly once", adapterId);
    }
    const checksByName = new Map<BehavioralProbeCheck, { check: BehavioralProbeCheck; outcome: "passed"; evidenceSha256: string }>();
    for (const [index, raw] of checksRaw.entries()) {
      const path = `availability.behavioralChecks[${index}]`;
      const checkObject = exactObject(raw, ["check", "outcome", "evidenceSha256"], path, "INVALID_EVIDENCE", adapterId);
      const check = enumValue<BehavioralProbeCheck>(checkObject.check, probeChecks, `${path}.check`, "INVALID_EVIDENCE", adapterId);
      if (!descriptor.compatibility.behavioralProbe.requiredChecks.includes(check)) {
        fail("INVALID_EVIDENCE", `${path}.check`, "is not required by this descriptor", adapterId);
      }
      if (checksByName.has(check)) fail("INVALID_EVIDENCE", `${path}.check`, "is duplicated", adapterId);
      if (checkObject.outcome !== "passed") fail("INVALID_EVIDENCE", `${path}.outcome`, "must be passed for available evidence", adapterId);
      checksByName.set(check, { check, outcome: "passed", evidenceSha256: sha256(checkObject.evidenceSha256, `${path}.evidenceSha256`, "INVALID_EVIDENCE", adapterId) });
    }
    const behavioralChecks = descriptor.compatibility.behavioralProbe.requiredChecks.map((check) => {
      const evidence = checksByName.get(check);
      if (!evidence) fail("INVALID_EVIDENCE", "availability.behavioralChecks", `is missing ${check}`, adapterId);
      return evidence;
    });
    const capabilities = capabilityEvidenceSet(obj.capabilities, descriptor);
    const available: AvailableAdapterEvidence = {
      status: "available",
      binding,
      executable,
      trustedHelpers,
      observedExecutableVersion,
      supportedExecutableRange,
      wireVersion,
      behavioralChecks,
      capabilities,
      probedAt: canonicalTimestamp(obj.probedAt, "availability.probedAt", "INVALID_EVIDENCE", adapterId),
      consultedConfigSha256: sha256(obj.consultedConfigSha256, "availability.consultedConfigSha256", "INVALID_EVIDENCE", adapterId)
    };
    return readonlyCopy(available);
  }

  if (shaped.status !== "unavailable") fail("INVALID_EVIDENCE", "availability.status", "must be available or unavailable", adapterId);
  const obj = exactObjectWithOptional(
    value,
    ["status", "binding", "reason", "missingEvidence", "probedAt", "consultedConfigSha256"],
    ["observedExecutableVersion", "observedWireVersion"],
    "availability",
    "INVALID_EVIDENCE",
    adapterId
  );
  const binding = evidenceBinding(obj.binding, descriptor, "availability.binding");
  const reasonObject = exactObject(obj.reason, ["code", "detail", "retry"], "availability.reason", "INVALID_EVIDENCE", adapterId);
  const missingRaw = array(obj.missingEvidence, "availability.missingEvidence", "INVALID_EVIDENCE", adapterId);
  if (missingRaw.length > ADAPTER_DESCRIPTOR_LIMITS.maxMissingEvidence) {
    fail("INVALID_EVIDENCE", "availability.missingEvidence", "contains too many entries", adapterId);
  }
  const missingEvidence = missingRaw.map((entry, index) => {
    const path = `availability.missingEvidence[${index}]`;
    const missing = exactObject(entry, ["kind", "detail"], path, "INVALID_EVIDENCE", adapterId);
    return {
      kind: enumValue<AdapterMissingEvidenceKind>(missing.kind, missingEvidenceKinds, `${path}.kind`, "INVALID_EVIDENCE", adapterId),
      detail: boundedString(missing.detail, `${path}.detail`, { max: ADAPTER_DESCRIPTOR_LIMITS.maxEvidenceDetailBytes }, "INVALID_EVIDENCE", adapterId)
    };
  });
  const observedExecutableVersion = obj.observedExecutableVersion === undefined
    ? undefined
    : boundedString(obj.observedExecutableVersion, "availability.observedExecutableVersion", { max: ADAPTER_DESCRIPTOR_LIMITS.maxVersionBytes }, "INVALID_EVIDENCE", adapterId);
  const observedWireVersion = obj.observedWireVersion === undefined
    ? undefined
    : boundedString(obj.observedWireVersion, "availability.observedWireVersion", { max: ADAPTER_DESCRIPTOR_LIMITS.maxVersionBytes }, "INVALID_EVIDENCE", adapterId);
  const unavailable: UnavailableAdapterEvidence = {
    status: "unavailable",
    binding,
    reason: {
      code: enumValue(reasonObject.code, unavailableReasonCodes, "availability.reason.code", "INVALID_EVIDENCE", adapterId),
      detail: boundedString(reasonObject.detail, "availability.reason.detail", { max: ADAPTER_DESCRIPTOR_LIMITS.maxEvidenceDetailBytes }, "INVALID_EVIDENCE", adapterId),
      retry: enumValue(reasonObject.retry, retryKinds, "availability.reason.retry", "INVALID_EVIDENCE", adapterId)
    },
    missingEvidence,
    ...(observedExecutableVersion === undefined ? {} : { observedExecutableVersion }),
    ...(observedWireVersion === undefined ? {} : { observedWireVersion }),
    probedAt: canonicalTimestamp(obj.probedAt, "availability.probedAt", "INVALID_EVIDENCE", adapterId),
    consultedConfigSha256: sha256(obj.consultedConfigSha256, "availability.consultedConfigSha256", "INVALID_EVIDENCE", adapterId)
  };
  return readonlyCopy(unavailable);
}

export function parseNativeSessionId(value: unknown): NativeSessionId {
  return boundedString(value, "nativeSessionId", {
    max: ADAPTER_DESCRIPTOR_LIMITS.maxNativeSessionIdBytes,
    pattern: /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/
  }, "INVALID_EVIDENCE") as NativeSessionId;
}

export function createAdapterReplayBinding(descriptor: AdapterDescriptor, wireVersion: string): AdapterReplayBinding {
  if (!descriptor.compatibility.wireVersions.includes(wireVersion)) {
    fail("REPLAY_BINDING_MISMATCH", "replay.wireVersion", `unsupported wire version ${JSON.stringify(wireVersion)}`, descriptor.id);
  }
  return readonlyCopy({
    adapterId: descriptor.id,
    contractVersion: descriptor.contractVersion,
    transportKind: descriptor.transportKind,
    wireVersion,
    codec: { ...descriptor.codec },
    normalizer: { ...descriptor.normalizer }
  });
}

export function evaluateAdapterRole(
  descriptor: AdapterDescriptor,
  availability: AdapterAvailability,
  role: AdapterRoleName
): AdapterRoleDecision {
  if (!roleNames.has(role)) fail("INVALID_EVIDENCE", "role", "has an unsupported value", descriptor.id);
  if (
    availability.binding.adapterId !== descriptor.id ||
    availability.binding.contractVersion !== descriptor.contractVersion ||
    availability.binding.normalizer.id !== descriptor.normalizer.id ||
    availability.binding.normalizer.version !== descriptor.normalizer.version
  ) {
    return readonlyCopy({
      status: "unavailable" as const,
      role,
      refusal: {
        code: "compatibility-evidence-mismatch" as const,
        detail: "Compatibility evidence does not bind the selected adapter contract and normalizer.",
        missingCapabilities: []
      }
    });
  }
  if (availability.status === "unavailable") {
    return readonlyCopy({
      status: "unavailable" as const,
      role,
      refusal: {
        code: "adapter-unavailable" as const,
        detail: `${availability.reason.code}: ${availability.reason.detail}`,
        missingCapabilities: []
      }
    });
  }
  const policy = descriptor.roles[role];
  if (policy.status === "unavailable") {
    return readonlyCopy({
      status: "unavailable" as const,
      role,
      refusal: { ...policy.refusal, missingCapabilities: [] }
    });
  }
  const missingCapabilities = policy.requiredCapabilities.filter(
    (capability) => availability.capabilities[capability].status !== "proven"
  );
  if (missingCapabilities.length > 0) {
    return readonlyCopy({
      status: "unavailable" as const,
      role,
      refusal: {
        code: missingCapabilities.includes("inner-read-only")
          ? "inner-read-only-unproven" as const
          : "required-capability-unproven" as const,
        detail: `Required capability evidence is not proven: ${missingCapabilities.join(", ")}.`,
        missingCapabilities
      }
    });
  }
  return readonlyCopy({
    status: "eligible" as const,
    role,
    outerSandbox: policy.outerSandbox,
    filesystem: policy.filesystem,
    innerReadOnly: policy.innerReadOnly,
    requiredCapabilities: [...policy.requiredCapabilities]
  });
}

function replayMismatch(descriptor: AdapterDescriptor, binding: AdapterReplayBindingInput): string | undefined {
  if (binding.contractVersion !== descriptor.contractVersion) return "contractVersion";
  if (binding.transportKind !== descriptor.transportKind) return "transportKind";
  if (!descriptor.compatibility.wireVersions.includes(binding.wireVersion)) return "wireVersion";
  if (binding.codec.id !== descriptor.codec.id || binding.codec.version !== descriptor.codec.version) return "codec";
  if (binding.normalizer.id !== descriptor.normalizer.id || binding.normalizer.version !== descriptor.normalizer.version) return "normalizer";
  return undefined;
}

/** Immutable registry: there is deliberately no runtime register/mutate method. */
export class AdapterRegistry {
  readonly descriptors: readonly AdapterDescriptor[];
  readonly ids: readonly AdapterId[];
  readonly #byId: ReadonlyMap<string, AdapterDescriptor>;

  constructor(values: readonly (AdapterDescriptorInput | AdapterDescriptor)[]) {
    if (!Array.isArray(values)) fail("INVALID_DESCRIPTOR", "registry", "must be an array");
    if (values.length > ADAPTER_DESCRIPTOR_LIMITS.maxDescriptors) {
      fail("INVALID_DESCRIPTOR", "registry", `must contain at most ${ADAPTER_DESCRIPTOR_LIMITS.maxDescriptors} descriptors`);
    }
    const byId = new Map<string, AdapterDescriptor>();
    for (const value of values) {
      const descriptor = defineAdapterDescriptor(value);
      if (byId.has(descriptor.id)) {
        fail("DUPLICATE_ADAPTER", "registry", `duplicate adapter ID ${JSON.stringify(descriptor.id)}`, descriptor.id);
      }
      byId.set(descriptor.id, descriptor);
    }
    const descriptors = [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
    this.descriptors = readonlyCopy(descriptors);
    this.ids = readonlyCopy(descriptors.map((descriptor) => descriptor.id));
    this.#byId = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
    Object.freeze(this);
  }

  has(id: string): boolean {
    return this.#byId.has(id);
  }

  get(id: string): AdapterDescriptor {
    const descriptor = this.#byId.get(id);
    if (!descriptor) fail("UNKNOWN_ADAPTER", "registry", `unknown adapter ID ${JSON.stringify(id)}`, id);
    return descriptor;
  }

  maybeGet(id: string): AdapterDescriptor | undefined {
    return this.#byId.get(id);
  }

  forProvider(providerId: string): readonly AdapterDescriptor[] {
    return readonlyCopy(this.descriptors.filter((descriptor) => descriptor.providerId === providerId));
  }

  resolveReplay(binding: AdapterReplayBindingInput): AdapterDescriptor {
    const descriptor = this.get(binding.adapterId);
    const mismatch = replayMismatch(descriptor, binding);
    if (mismatch) {
      fail("REPLAY_BINDING_MISMATCH", `replay.${mismatch}`, "does not match the shipped descriptor", descriptor.id);
    }
    return descriptor;
  }
}

export function createAdapterRegistry(values: readonly (AdapterDescriptorInput | AdapterDescriptor)[]): AdapterRegistry {
  return new AdapterRegistry(values);
}

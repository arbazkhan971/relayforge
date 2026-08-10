import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  getShippedAdapterDescriptor,
  shippedAdapterConfigSha256,
  type ShippedAdapterId
} from "./bootstrap.js";
import { defineAdapterAvailability, evaluateAdapterRole } from "./registry.js";
import { inspectAdapterRuntimeFile, sameRuntimeFileEvidence } from "./runtime.js";
import type { AdapterAvailability, RuntimeFileEvidence } from "./types.js";

export const CONTAINED_ADAPTER_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const CONTAINED_ADAPTER_EVIDENCE_MAX_BYTES = 256 * 1024;
export const CONTAINED_ADAPTER_EVIDENCE_MAX_AGE_MS = 5 * 60 * 1_000;
export const CONTAINED_ADAPTER_EVIDENCE_CLOCK_SKEW_MS = 30 * 1_000;
export const CONTAINED_ADAPTER_PROBE_POLICY_ID = "relayforge-contained-adapter-probe-v1" as const;

export const containedNativeAdapterIds = Object.freeze(["opencode", "pi", "grok"] as const);
export type ContainedNativeAdapterId = (typeof containedNativeAdapterIds)[number];

/**
 * One canonical controlled OpenCode inline-config representation.
 * Collector, consumer, and production characterization all expand through this recipe so
 * configurationSha256 never depends on ambient key order or a pre-expanded variant.
 */
export function canonicalContainedOpenCodeConfigContent(apiKey: string): string {
  if (typeof apiKey !== "string" || apiKey.length === 0 || apiKey.includes("\0") || Buffer.byteLength(apiKey, "utf8") > 64 * 1024) {
    throw new TypeError("contained adapter opencode requires bounded OPENAI_API_KEY");
  }
  // Fixed insertion order is part of the controlled representation; never re-sort at the wire.
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    model: "openai/gpt-5.2-codex",
    provider: { openai: { options: { apiKey } } },
    formatter: false,
    lsp: false
  });
}

function extractOpenCodeApiKeyFromConfigContent(content: string): string | undefined {
  if (typeof content !== "string" || content.length === 0 || content.includes("\0") || Buffer.byteLength(content, "utf8") > 64 * 1024) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(content) as {
      provider?: { openai?: { options?: { apiKey?: unknown } } };
    };
    const apiKey = parsed?.provider?.openai?.options?.apiKey;
    if (typeof apiKey !== "string" || apiKey.length === 0 || apiKey.includes("\0") || Buffer.byteLength(apiKey, "utf8") > 64 * 1024) {
      return undefined;
    }
    return apiKey;
  } catch {
    return undefined;
  }
}

/**
 * Build the one credential/config environment a production characterization is allowed to expose.
 * The returned object deliberately contains no ambient PATH, HOME or sibling-provider credential;
 * the provider builder adds only its fixed private state and role policy.
 */
export function containedAdapterProbeEnvironment(
  adapterId: ContainedNativeAdapterId,
  source: Readonly<Record<string, string | undefined>> = process.env
): Readonly<Record<string, string>> {
  const required = (name: string): string => {
    const value = source[name];
    if (typeof value !== "string" || value.length === 0 || value.includes("\0") || Buffer.byteLength(value, "utf8") > 64 * 1024) {
      throw new TypeError(`contained adapter ${adapterId} requires bounded ${name}`);
    }
    return value;
  };
  if (adapterId === "opencode") {
    // Prefer ambient credential expansion. A pre-expanded OPENCODE_CONFIG_CONTENT is accepted only
    // when it carries the same openai apiKey so collector/consumer re-emit the canonical recipe.
    const ambientKey = source.OPENAI_API_KEY;
    if (typeof ambientKey === "string" && ambientKey.length > 0 && !ambientKey.includes("\0") && Buffer.byteLength(ambientKey, "utf8") <= 64 * 1024) {
      return Object.freeze({ OPENCODE_CONFIG_CONTENT: canonicalContainedOpenCodeConfigContent(ambientKey) });
    }
    const fromContent = extractOpenCodeApiKeyFromConfigContent(source.OPENCODE_CONFIG_CONTENT ?? "");
    if (fromContent !== undefined) {
      return Object.freeze({ OPENCODE_CONFIG_CONTENT: canonicalContainedOpenCodeConfigContent(fromContent) });
    }
    throw new TypeError("contained adapter opencode requires bounded OPENAI_API_KEY");
  }
  if (adapterId === "pi") return Object.freeze({ ANTHROPIC_API_KEY: required("ANTHROPIC_API_KEY") });
  return Object.freeze({ XAI_API_KEY: required("XAI_API_KEY") });
}

export const containedAdapterCheckNames = Object.freeze({
  opencode: Object.freeze([
    "promptCompleted",
    "cancellationSettled",
    "reviewerWriteDenied",
    "scopeEmpty",
    "replayMatched"
  ] as const),
  pi: Object.freeze([
    "promptCompleted",
    "cancellationSettled",
    "reviewerWriteDenied",
    "scopeEmpty",
    "replayMatched",
    "stateAndStatsCompleted"
  ] as const),
  grok: Object.freeze([
    "promptCompleted",
    "cancellationSettled",
    "reviewerWriteDenied",
    "scopeEmpty",
    "replayMatched",
    "configurationIsolated",
    "networkToolPolicyEnforced",
    "unapprovedUploadDenied"
  ] as const)
});

export type ContainedAdapterCheckName =
  (typeof containedAdapterCheckNames)[ContainedNativeAdapterId][number];

export type ContainedAdapterCheckEvidence = Readonly<{
  passed: true;
  evidenceSha256: string;
}>;

export type ContainedAdapterEvidenceV1 = Readonly<{
  schemaVersion: typeof CONTAINED_ADAPTER_EVIDENCE_SCHEMA_VERSION;
  adapterId: ContainedNativeAdapterId;
  commitSha: string;
  jobNonce: string;
  collectedAt: string;
  expiresAt: string;
  configurationSha256: string;
  availability: AdapterAvailability;
  runtime: Readonly<{
    executable: RuntimeFileEvidence;
    trustedHelpers: readonly RuntimeFileEvidence[];
  }>;
  containment: Readonly<{
    backend: "linux-cgroup-v2";
    scopeId: string;
    normalExitReapedSha256: string;
    cancellationReapedSha256: string;
  }>;
  settlement: Readonly<{
    callId: string;
    terminal: true;
    costAuthority: "trusted" | "unknown";
    receiptDigest: string;
  }>;
  checks: Readonly<Record<ContainedAdapterCheckName, ContainedAdapterCheckEvidence>>;
  receiptDigest: string;
}>;

export type ContainedAdapterEvidenceExpectation = Readonly<{
  adapterId: ContainedNativeAdapterId;
  commitSha: string;
  jobNonce: string;
  configurationSha256: string;
  now: Date | string;
}>;

export type ContainedAdapterEvidenceFileExpectation = ContainedAdapterEvidenceExpectation & Readonly<{
  /** Evidence files must be direct or nested descendants of this private absolute directory. */
  allowedRoot: string;
}>;

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const BOUNDED_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const MAX_ID_BYTES = 128;
const MAX_PATH_BYTES = 4_096;
const MAX_CHECKS = 16;

function fail(message: string): never {
  throw new TypeError(`contained adapter evidence: ${message}`);
}

function plainExactObject(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${name} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail(`${name} must not contain symbol keys`);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.get || descriptor.set) fail(`${name} must not contain accessors`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${name} must contain exactly ${expected.join(", ")}`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || Buffer.byteLength(value, "utf8") > maxBytes) {
    fail(`${name} must be a bounded non-empty NUL-free string`);
  }
  return value;
}

function digest(value: unknown, name: string): string {
  const result = string(value, name, 64);
  if (!SHA256.test(result)) fail(`${name} must be a lowercase SHA-256 digest`);
  return result;
}

function commitSha(value: unknown, name: string): string {
  const result = string(value, name, 64);
  if (!COMMIT_SHA.test(result)) fail(`${name} must be a lowercase Git object ID`);
  return result;
}

function boundedId(value: unknown, name: string): string {
  const result = string(value, name, MAX_ID_BYTES);
  if (!BOUNDED_ID.test(result)) fail(`${name} contains unsupported characters`);
  return result;
}

function canonicalTimestamp(value: unknown, name: string): { value: string; milliseconds: number } {
  const result = string(value, name, 64);
  const milliseconds = Date.parse(result);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== result) {
    fail(`${name} must be a canonical UTC timestamp`);
  }
  return { value: result, milliseconds };
}

function expectationTimestamp(value: Date | string): number {
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail("expectation.now must be a valid timestamp");
  return milliseconds;
}

/** Deterministic JSON used for the content receipt; object keys are byte-sorted. */
export function canonicalContainedAdapterEvidenceJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("receipt values must use finite safe integers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalContainedAdapterEvidenceJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const entries = Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalContainedAdapterEvidenceJson(object[key])}`);
    return `{${entries.join(",")}}`;
  }
  fail(`receipt contains unsupported ${typeof value} value`);
}

export function containedAdapterEvidenceReceiptDigest(
  value: Omit<ContainedAdapterEvidenceV1, "receiptDigest"> | Record<string, unknown>
): string {
  return createHash("sha256").update(canonicalContainedAdapterEvidenceJson(value), "utf8").digest("hex");
}

/** Content-bound identity carried by every native call settlement; paths never stand alone as proof. */
export function containedAdapterRuntimeIdentitySha256(
  executable: RuntimeFileEvidence,
  trustedHelpers: readonly RuntimeFileEvidence[] = [],
  configurationSha256?: string
): string {
  return createHash("sha256").update(canonicalContainedAdapterEvidenceJson({
    executable,
    trustedHelpers,
    ...(configurationSha256 === undefined ? {} : { configurationSha256 })
  }), "utf8").digest("hex");
}

/**
 * Expand ambient credentials into the closed probe environment when possible.
 * Collector, required-real consumer, and receipt extractor all call this so they independently
 * agree on the controlled OpenCode hash derived from OPENAI_API_KEY (and peer keys for pi/grok).
 *
 * OpenCode always re-emits one canonical OPENCODE_CONFIG_CONTENT recipe (from OPENAI_API_KEY or
 * by extracting the apiKey from a pre-expanded OPENCODE_CONFIG_CONTENT). Non-canonical key order
 * or equivalent semantic variants therefore hash identically. Environments that cannot be
 * expanded fail closed by returning the input unchanged for non-OpenCode adapters only.
 */
export function resolveContainedAdapterProbeEnvironment(
  adapterId: ContainedNativeAdapterId,
  environment: Readonly<Record<string, string | undefined>> = process.env
): Readonly<Record<string, string | undefined>> {
  try {
    return containedAdapterProbeEnvironment(adapterId, environment);
  } catch {
    return environment;
  }
}

/**
 * Public, secret-safe identity of the collector's closed role/prompt/config recipe. Both the
 * collector and its same-job consumer derive this value independently from the descriptor and
 * controlled environment; neither transports configuration authority in the evidence file.
 *
 * For OpenCode, ambient OPENAI_API_KEY (or a pre-expanded OPENCODE_CONFIG_CONTENT carrying the
 * same apiKey) is re-emitted as the single canonical controlled config representation before
 * hashing so collector, required-real consumer, and receipt extractor agree without transporting
 * the expanded config through the evidence file.
 */
export function containedAdapterProbeConfigurationSha256(
  adapterId: ContainedNativeAdapterId,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  model?: string
): string {
  const controlled = resolveContainedAdapterProbeEnvironment(adapterId, environment);
  const descriptor = getShippedAdapterDescriptor(adapterId);
  const base = shippedAdapterConfigSha256({ adapterId, environment: controlled, ...(model === undefined ? {} : { model }) });
  return createHash("sha256").update(canonicalContainedAdapterEvidenceJson({
    policyId: CONTAINED_ADAPTER_PROBE_POLICY_ID,
    base,
    adapterId,
    contractVersion: descriptor.contractVersion,
    transportKind: descriptor.transportKind,
    wireVersion: descriptor.compatibility.wireVersions[0],
    behavioralProbe: descriptor.compatibility.behavioralProbe,
    invocationPolicy: descriptor.invocationPolicy,
    roles: descriptor.roles,
    probes: {
      worker: "bounded-no-write-conformance-v1",
      reviewer: "bounded-mutation-denial-v1",
      cancellation: "correlated-cancel-v1"
    }
  }), "utf8").digest("hex");
}

function runtimeEvidence(value: unknown, name: string): RuntimeFileEvidence {
  const object = plainExactObject(value, ["runtimeName", "canonicalPath", "identity"], name);
  const runtimeName = string(object.runtimeName, `${name}.runtimeName`, 128);
  const canonicalPath = string(object.canonicalPath, `${name}.canonicalPath`, MAX_PATH_BYTES);
  if (!isAbsolute(canonicalPath)) fail(`${name}.canonicalPath must be absolute`);
  const identity = string(object.identity, `${name}.identity`, 512);
  return Object.freeze({ runtimeName: runtimeName as RuntimeFileEvidence["runtimeName"], canonicalPath, identity });
}

function sameRuntimeList(left: readonly RuntimeFileEvidence[], right: readonly RuntimeFileEvidence[]): boolean {
  return left.length === right.length && left.every((entry, index) => sameRuntimeFileEvidence(entry, right[index]!));
}

function requiredChecks(adapterId: ContainedNativeAdapterId, value: unknown): Readonly<Record<string, ContainedAdapterCheckEvidence>> {
  const names = containedAdapterCheckNames[adapterId];
  if (names.length > MAX_CHECKS) fail("the shipped check policy exceeds the envelope limit");
  const object = plainExactObject(value, names, "checks");
  const entries = names.map((name) => {
    const check = plainExactObject(object[name], ["passed", "evidenceSha256"], `checks.${name}`);
    if (check.passed !== true) fail(`checks.${name}.passed must be true`);
    return [name, Object.freeze({ passed: true as const, evidenceSha256: digest(check.evidenceSha256, `checks.${name}.evidenceSha256`) })] as const;
  });
  const checkDigests = entries.map(([, check]) => check.evidenceSha256);
  if (new Set(checkDigests).size !== checkDigests.length) fail("every conformance check must carry distinct evidence");
  return Object.freeze(Object.fromEntries(entries));
}

function assertBehavioralCheckBinding(
  availability: Extract<AdapterAvailability, { status: "available" }>,
  checks: Readonly<Record<string, ContainedAdapterCheckEvidence>>
): void {
  const behavioral = new Map(availability.behavioralChecks.map((entry) => [entry.check, entry.evidenceSha256]));
  if (behavioral.get("prompt-roundtrip") !== checks.promptCompleted?.evidenceSha256) {
    fail("promptCompleted evidence does not bind the availability prompt-roundtrip check");
  }
  if (behavioral.get("cancellation") !== checks.cancellationSettled?.evidenceSha256) {
    fail("cancellationSettled evidence does not bind the availability cancellation check");
  }
  if (behavioral.has("read-only-denial") && behavioral.get("read-only-denial") !== checks.reviewerWriteDenied?.evidenceSha256) {
    fail("reviewerWriteDenied evidence does not bind the availability read-only-denial check");
  }
  if (availability.binding.adapterId === "grok") {
    const safetyBindings = [
      ["configuration-isolation", "configurationIsolated"],
      ["network-tool-policy", "networkToolPolicyEnforced"],
      ["unapproved-upload-denial", "unapprovedUploadDenied"]
    ] as const;
    for (const [behavioralName, envelopeName] of safetyBindings) {
      if (behavioral.get(behavioralName) !== checks[envelopeName]?.evidenceSha256) {
        fail(`${envelopeName} evidence does not bind the Grok availability ${behavioralName} check`);
      }
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Validate one in-memory v1 receipt against the exact checkout, job, configuration and current time.
 * This is deliberately total and performs no process launch or settlement operation.
 */
export function parseContainedAdapterEvidence(
  value: unknown,
  expectation: ContainedAdapterEvidenceExpectation
): ContainedAdapterEvidenceV1 {
  if (!containedNativeAdapterIds.includes(expectation.adapterId)) fail("expectation.adapterId is not a native shipped adapter");
  const expectedCommit = commitSha(expectation.commitSha, "expectation.commitSha");
  const expectedNonce = digest(expectation.jobNonce, "expectation.jobNonce");
  const expectedConfig = digest(expectation.configurationSha256, "expectation.configurationSha256");
  const now = expectationTimestamp(expectation.now);
  const object = plainExactObject(value, [
    "schemaVersion",
    "adapterId",
    "commitSha",
    "jobNonce",
    "collectedAt",
    "expiresAt",
    "configurationSha256",
    "availability",
    "runtime",
    "containment",
    "settlement",
    "checks",
    "receiptDigest"
  ], "envelope");
  if (object.schemaVersion !== CONTAINED_ADAPTER_EVIDENCE_SCHEMA_VERSION) fail("unsupported schemaVersion");
  if (object.adapterId !== expectation.adapterId) fail("adapterId does not match the expected adapter");
  const adapterId = object.adapterId as ContainedNativeAdapterId;
  if (commitSha(object.commitSha, "commitSha") !== expectedCommit) fail("commitSha does not match the checkout");
  if (digest(object.jobNonce, "jobNonce") !== expectedNonce) fail("jobNonce does not match the current job");
  if (digest(object.configurationSha256, "configurationSha256") !== expectedConfig) fail("configurationSha256 does not match the selected config");

  const collectedAt = canonicalTimestamp(object.collectedAt, "collectedAt");
  const expiresAt = canonicalTimestamp(object.expiresAt, "expiresAt");
  if (collectedAt.milliseconds > now + CONTAINED_ADAPTER_EVIDENCE_CLOCK_SKEW_MS) fail("collectedAt is in the future");
  if (expiresAt.milliseconds <= collectedAt.milliseconds) fail("expiresAt must be later than collectedAt");
  if (expiresAt.milliseconds - collectedAt.milliseconds > CONTAINED_ADAPTER_EVIDENCE_MAX_AGE_MS) fail("evidence lifetime exceeds five minutes");
  if (now >= expiresAt.milliseconds) fail("evidence is expired");

  const descriptor = getShippedAdapterDescriptor(adapterId);
  const availability = defineAdapterAvailability(descriptor, object.availability);
  if (availability.status !== "available") fail("availability must be available");
  if (availability.consultedConfigSha256 !== expectedConfig) fail("availability is bound to a different configuration");
  if (evaluateAdapterRole(descriptor, availability, "reviewer").status !== "eligible") {
    fail("reviewer role is not eligible under the proven capability evidence");
  }

  const runtimeObject = plainExactObject(object.runtime, ["executable", "trustedHelpers"], "runtime");
  const executable = runtimeEvidence(runtimeObject.executable, "runtime.executable");
  if (!Array.isArray(runtimeObject.trustedHelpers)) fail("runtime.trustedHelpers must be an array");
  if (runtimeObject.trustedHelpers.length !== descriptor.runtimeIdentity.trustedHelpers.length) {
    fail("runtime.trustedHelpers does not match the descriptor");
  }
  const trustedHelpers = runtimeObject.trustedHelpers.map((entry, index) => runtimeEvidence(entry, `runtime.trustedHelpers[${index}]`));
  if (!sameRuntimeFileEvidence(executable, availability.executable) || !sameRuntimeList(trustedHelpers, availability.trustedHelpers)) {
    fail("runtime identity does not exactly match availability");
  }

  const containmentObject = plainExactObject(object.containment, [
    "backend",
    "scopeId",
    "normalExitReapedSha256",
    "cancellationReapedSha256"
  ], "containment");
  if (containmentObject.backend !== "linux-cgroup-v2") fail("containment.backend must be linux-cgroup-v2");
  const containment = Object.freeze({
    backend: "linux-cgroup-v2" as const,
    scopeId: boundedId(containmentObject.scopeId, "containment.scopeId"),
    normalExitReapedSha256: digest(containmentObject.normalExitReapedSha256, "containment.normalExitReapedSha256"),
    cancellationReapedSha256: digest(containmentObject.cancellationReapedSha256, "containment.cancellationReapedSha256")
  });
  if (containment.normalExitReapedSha256 === containment.cancellationReapedSha256) {
    fail("ordinary-exit and cancellation reaping require distinct evidence");
  }

  const settlementObject = plainExactObject(object.settlement, ["callId", "terminal", "costAuthority", "receiptDigest"], "settlement");
  if (settlementObject.terminal !== true) fail("settlement.terminal must be true");
  if (settlementObject.costAuthority !== "trusted" && settlementObject.costAuthority !== "unknown") {
    fail("settlement.costAuthority must be trusted or unknown");
  }
  const settlement = Object.freeze({
    callId: boundedId(settlementObject.callId, "settlement.callId"),
    terminal: true as const,
    costAuthority: settlementObject.costAuthority,
    receiptDigest: digest(settlementObject.receiptDigest, "settlement.receiptDigest")
  });

  const checks = requiredChecks(adapterId, object.checks);
  assertBehavioralCheckBinding(availability, checks);
  const recordedReceipt = digest(object.receiptDigest, "receiptDigest");
  const { receiptDigest: _discarded, ...receiptValue } = object;
  const expectedReceipt = containedAdapterEvidenceReceiptDigest(receiptValue);
  if (recordedReceipt !== expectedReceipt) fail("receiptDigest does not bind the canonical envelope");

  return deepFreeze({
    schemaVersion: CONTAINED_ADAPTER_EVIDENCE_SCHEMA_VERSION,
    adapterId,
    commitSha: expectedCommit,
    jobNonce: expectedNonce,
    collectedAt: collectedAt.value,
    expiresAt: expiresAt.value,
    configurationSha256: expectedConfig,
    availability,
    runtime: { executable, trustedHelpers },
    containment,
    settlement,
    checks,
    receiptDigest: recordedReceipt
  } as ContainedAdapterEvidenceV1);
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertPrivateDirectory(path: string): string {
  if (!isAbsolute(path) || Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES || path.includes("\0")) {
    fail("allowedRoot must be a bounded absolute path");
  }
  const canonical = realpathSync(path);
  const stat = statSync(canonical);
  if (!stat.isDirectory()) fail("allowedRoot must be a directory");
  if ((stat.mode & 0o077) !== 0) fail("allowedRoot must be private to its owner");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) fail("allowedRoot must be owned by the current user");
  return canonical;
}

/**
 * Read one canonical, private, immutable-during-read evidence file and immediately re-stat every
 * executable/helper identity before returning it. Symlinks, hardlinks, loose modes and stale files
 * fail closed.
 */
export function readContainedAdapterEvidenceFile(
  path: string,
  expectation: ContainedAdapterEvidenceFileExpectation
): ContainedAdapterEvidenceV1 {
  if (!isAbsolute(path) || path.includes("\0") || Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES) {
    fail("evidence path must be a bounded absolute path");
  }
  const root = assertPrivateDirectory(expectation.allowedRoot);
  const resolved = resolve(path);
  if (!isWithin(root, resolved)) fail("evidence path escapes allowedRoot");
  const parent = realpathSync(dirname(resolved));
  if (!isWithin(root, parent)) fail("evidence parent escapes allowedRoot");
  const link = lstatSync(resolved);
  if (link.isSymbolicLink()) fail("evidence path must not be a symlink");
  if (realpathSync(resolved) !== resolved) fail("evidence path must be canonical");

  const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    const plain = fstatSync(fd);
    if (!plain.isFile()) fail("evidence must be a regular file");
    if (plain.nlink !== 1) fail("evidence must have exactly one hard link");
    if ((plain.mode & 0o777) !== 0o600) fail("evidence mode must be exactly 0600");
    if (typeof process.getuid === "function" && plain.uid !== process.getuid()) fail("evidence must be owned by the current user");
    if (plain.size > CONTAINED_ADAPTER_EVIDENCE_MAX_BYTES) fail("evidence exceeds 256 KiB");
    const bytes = Buffer.alloc(plain.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) fail("evidence was truncated while reading");
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      fail("evidence identity changed while reading");
    }
    const text = bytes.toString("utf8");
    if (Buffer.from(text, "utf8").length !== bytes.length || text.includes("\0")) fail("evidence must be valid NUL-free UTF-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      fail("evidence is not JSON");
    }
    if (`${canonicalContainedAdapterEvidenceJson(parsed)}\n` !== text) {
      fail("evidence must be one canonical JSON record");
    }
    const envelope = parseContainedAdapterEvidence(parsed, expectation);
    const currentExecutable = inspectAdapterRuntimeFile(
      envelope.runtime.executable.runtimeName,
      envelope.runtime.executable.canonicalPath,
      true
    );
    if (!sameRuntimeFileEvidence(currentExecutable, envelope.runtime.executable)) fail("executable identity changed after collection");
    for (const helper of envelope.runtime.trustedHelpers) {
      const currentHelper = inspectAdapterRuntimeFile(helper.runtimeName, helper.canonicalPath);
      if (!sameRuntimeFileEvidence(currentHelper, helper)) fail("trusted helper identity changed after collection");
    }
    return envelope;
  } finally {
    closeSync(fd);
  }
}

export function isContainedNativeAdapterId(value: ShippedAdapterId | string): value is ContainedNativeAdapterId {
  return containedNativeAdapterIds.includes(value as ContainedNativeAdapterId);
}

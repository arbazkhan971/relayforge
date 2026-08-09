import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";
import { canonicalContainedAdapterEvidenceJson } from "./contained-evidence.js";
import {
  GROK_EGRESS_POLICY_SHA256,
  GROK_EGRESS_POLICY_VERSION
} from "./grok-egress-contract.js";
import { inspectAdapterRuntimeFile } from "./runtime.js";
import type { RuntimeFileEvidence } from "./types.js";

export const GROK_EGRESS_PROBE_SCHEMA_VERSION = 1 as const;
export const GROK_EGRESS_RELAY_PORT = 43_829 as const;
export const GROK_EGRESS_PROBE_MAX_BYTES = 32 * 1_024;
export const grokEgressProbeCheckNames = Object.freeze([
  "approvedConnect",
  "canaryDenied",
  "directIpv4Denied",
  "directIpv6Denied",
  "dnsDenied",
  "hostLoopbackDenied",
  "unixCanaryDenied"
] as const);

export type GrokEgressProbeCheckName = (typeof grokEgressProbeCheckNames)[number];
export type GrokEgressProbeCheck = Readonly<{
  passed: true;
  observation: string;
  evidenceSha256: string;
}>;
export type GrokEgressProbeReport = Readonly<{
  schemaVersion: typeof GROK_EGRESS_PROBE_SCHEMA_VERSION;
  policyVersion: typeof GROK_EGRESS_POLICY_VERSION;
  policySha256: string;
  checks: Readonly<Record<GrokEgressProbeCheckName, GrokEgressProbeCheck>>;
  receiptDigest: string;
}>;

const SHA256 = /^[a-f0-9]{64}$/u;
const OBSERVATIONS = Object.freeze({
  approvedConnect: new Set(["http-200"]),
  canaryDenied: new Set(["http-403"]),
  directIpv4Denied: new Set(["ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL"]),
  directIpv6Denied: new Set(["ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL"]),
  dnsDenied: new Set(["EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"]),
  hostLoopbackDenied: new Set(["ECONNREFUSED", "EADDRNOTAVAIL"]),
  unixCanaryDenied: new Set(["http-403"])
} satisfies Record<GrokEgressProbeCheckName, ReadonlySet<string>>);

function fail(message: string): never {
  throw new TypeError(`Grok egress probe: ${message}`);
}

function exactObject(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${name} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail(`${name} must not contain symbols`);
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

function boundedString(value: unknown, name: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || Buffer.byteLength(value, "utf8") > maxBytes) {
    fail(`${name} must be a bounded string`);
  }
  return value;
}

export function grokEgressRelayPath(): string {
  return fileURLToPath(new URL("../../assets/grok-egress-relay.mjs", import.meta.url));
}

export function inspectGrokEgressRelay(): RuntimeFileEvidence {
  return inspectAdapterRuntimeFile("grok-egress-relay.mjs", grokEgressRelayPath());
}

function port(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1_024 || value > 65_535) fail(`${name} must be a closed unprivileged TCP port`);
  return value;
}

function socket(value: string): string {
  if (!isAbsolute(value) || value.includes("\0") || Buffer.byteLength(value, "utf8") > 4_096) {
    fail("socketPath must be a bounded absolute path");
  }
  return value;
}

export function buildGrokEgressProbeCommand(input: Readonly<{
  socketPath: string;
  hostSentinelPort: number;
}>): Readonly<{ command: string; args: readonly string[] }> {
  return Object.freeze({
    command: process.execPath,
    args: Object.freeze([
      grokEgressRelayPath(),
      "probe",
      "--socket", socket(input.socketPath),
      "--relay-port", String(GROK_EGRESS_RELAY_PORT),
      "--host-sentinel-port", String(port(input.hostSentinelPort, "hostSentinelPort"))
    ])
  });
}

export function buildGrokEgressProviderCommand(input: Readonly<{
  socketPath: string;
  providerCommand: string;
  providerArgs: readonly string[];
}>): Readonly<{ command: string; args: readonly string[] }> {
  if (!isAbsolute(input.providerCommand) || input.providerCommand.includes("\0") || Buffer.byteLength(input.providerCommand, "utf8") > 4_096) {
    fail("providerCommand must be a bounded absolute path");
  }
  if (input.providerArgs.length > 128 || input.providerArgs.some((arg) => typeof arg !== "string" || arg.includes("\0") || Buffer.byteLength(arg, "utf8") > 64 * 1_024)) {
    fail("providerArgs must be bounded and NUL-free");
  }
  return Object.freeze({
    command: process.execPath,
    args: Object.freeze([
      grokEgressRelayPath(),
      "exec",
      "--socket", socket(input.socketPath),
      "--relay-port", String(GROK_EGRESS_RELAY_PORT),
      "--",
      input.providerCommand,
      ...input.providerArgs
    ])
  });
}

export function parseGrokEgressProbeReport(value: string | unknown): GrokEgressProbeReport {
  let candidate = value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") === 0 || Buffer.byteLength(value, "utf8") > GROK_EGRESS_PROBE_MAX_BYTES) {
      fail("serialized report is empty or over bound");
    }
    try {
      candidate = JSON.parse(value) as unknown;
    } catch {
      fail("serialized report is not JSON");
    }
  }
  const object = exactObject(candidate, ["schemaVersion", "policyVersion", "policySha256", "checks", "receiptDigest"], "report");
  if (object.schemaVersion !== GROK_EGRESS_PROBE_SCHEMA_VERSION) fail("schemaVersion is unsupported");
  if (object.policyVersion !== GROK_EGRESS_POLICY_VERSION || object.policySha256 !== GROK_EGRESS_POLICY_SHA256) {
    fail("policy identity does not match the shipped closed policy");
  }
  const checksObject = exactObject(object.checks, grokEgressProbeCheckNames, "checks");
  const checks = {} as Record<GrokEgressProbeCheckName, GrokEgressProbeCheck>;
  for (const name of grokEgressProbeCheckNames) {
    const check = exactObject(checksObject[name], ["passed", "observation", "evidenceSha256"], `checks.${name}`);
    if (check.passed !== true) fail(`checks.${name}.passed must be true`);
    const observation = boundedString(check.observation, `checks.${name}.observation`, 128);
    if (!OBSERVATIONS[name].has(observation)) fail(`checks.${name}.observation is not a closed success outcome`);
    const evidenceSha256 = boundedString(check.evidenceSha256, `checks.${name}.evidenceSha256`, 64);
    const expected = createHash("sha256").update(`${GROK_EGRESS_POLICY_VERSION}:${name}:${observation}`).digest("hex");
    if (!SHA256.test(evidenceSha256) || evidenceSha256 !== expected) fail(`checks.${name}.evidenceSha256 is invalid`);
    checks[name] = Object.freeze({ passed: true, observation, evidenceSha256 });
  }
  const payload = Object.freeze({
    schemaVersion: GROK_EGRESS_PROBE_SCHEMA_VERSION,
    policyVersion: GROK_EGRESS_POLICY_VERSION,
    policySha256: GROK_EGRESS_POLICY_SHA256,
    checks: Object.freeze(checks)
  });
  const receiptDigest = boundedString(object.receiptDigest, "receiptDigest", 64);
  const expectedReceipt = createHash("sha256").update(canonicalContainedAdapterEvidenceJson(payload)).digest("hex");
  if (!SHA256.test(receiptDigest) || receiptDigest !== expectedReceipt) fail("receiptDigest does not bind the report");
  return Object.freeze({ ...payload, receiptDigest });
}

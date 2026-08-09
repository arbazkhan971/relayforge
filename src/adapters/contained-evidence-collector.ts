import { closeSync, constants, fsyncSync, openSync, realpathSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  CONTAINED_ADAPTER_EVIDENCE_MAX_AGE_MS,
  CONTAINED_ADAPTER_EVIDENCE_MAX_BYTES,
  CONTAINED_ADAPTER_EVIDENCE_SCHEMA_VERSION,
  canonicalContainedAdapterEvidenceJson,
  containedAdapterEvidenceReceiptDigest,
  containedAdapterProbeConfigurationSha256,
  parseContainedAdapterEvidence,
  type ContainedAdapterCheckEvidence,
  type ContainedAdapterCheckName,
  type ContainedAdapterEvidenceV1,
  type ContainedNativeAdapterId
} from "./contained-evidence.js";
import { inspectAdapterRuntimeFile, sameRuntimeFileEvidence } from "./runtime.js";
import type { AdapterAvailability } from "./types.js";

export type ContainedAdapterProbeResult = Readonly<{
  availability: Extract<AdapterAvailability, { status: "available" }>;
  containment: ContainedAdapterEvidenceV1["containment"];
  settlement: ContainedAdapterEvidenceV1["settlement"];
  checks: Readonly<Record<ContainedAdapterCheckName, ContainedAdapterCheckEvidence>>;
}>;

/**
 * Narrow process authority supplied by the orchestrator. Implementations must use the production
 * contained transcript/replay/ledger path and return only content digests. This boundary deliberately
 * exposes neither spawn nor a transport handle to the collector or its callers.
 */
export type ContainedAdapterProbeAuthority = Readonly<{
  collect(input: Readonly<{
    adapterId: ContainedNativeAdapterId;
    configurationSha256: string;
  }>): Promise<ContainedAdapterProbeResult>;
}>;

export type CollectContainedAdapterEvidenceInput = Readonly<{
  adapterId: ContainedNativeAdapterId;
  outputPath: string;
  commitSha: string;
  jobNonce: string;
  authority: ContainedAdapterProbeAuthority;
  environment?: Readonly<Record<string, string | undefined>>;
  /** Exact prompt/credential canaries that must not appear in the serialized receipt. */
  forbiddenSentinels?: readonly string[];
  now?: Date;
}>;

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
    if (written <= 0) throw new Error("contained adapter evidence write made no progress");
    offset += written;
  }
}

function privateCanonicalParent(path: string): string {
  if (!isAbsolute(path) || path.includes("\0") || Buffer.byteLength(path, "utf8") > 4_096) {
    throw new TypeError("contained adapter evidence output must be a bounded absolute path");
  }
  const parent = realpathSync(dirname(path));
  const info = statSync(parent);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
    throw new TypeError("contained adapter evidence output parent must be a private owned directory");
  }
  if (resolve(path) !== path || dirname(path) !== parent) {
    throw new TypeError("contained adapter evidence output must use a canonical direct path");
  }
  return parent;
}

function revalidateRuntime(availability: Extract<AdapterAvailability, { status: "available" }>): void {
  const executable = inspectAdapterRuntimeFile(
    availability.executable.runtimeName,
    availability.executable.canonicalPath,
    true
  );
  if (!sameRuntimeFileEvidence(executable, availability.executable)) {
    throw new Error("contained adapter executable changed before evidence emission");
  }
  for (const helper of availability.trustedHelpers) {
    const current = inspectAdapterRuntimeFile(helper.runtimeName, helper.canonicalPath);
    if (!sameRuntimeFileEvidence(current, helper)) {
      throw new Error(`contained adapter helper ${helper.runtimeName} changed before evidence emission`);
    }
  }
}

/**
 * Collect and atomically emit one short-lived evidence receipt. A failed authority, malformed proof,
 * runtime replacement, short write, fsync failure or schema mismatch leaves no output file.
 *
 * Timestamps are taken only after the authority returns so a slow probe cannot emit already-expired
 * evidence. `now` is reserved for deterministic tests and is still applied after the probe.
 */
export async function collectContainedAdapterEvidence(
  input: CollectContainedAdapterEvidenceInput
): Promise<ContainedAdapterEvidenceV1> {
  const parent = privateCanonicalParent(input.outputPath);
  const configurationSha256 = containedAdapterProbeConfigurationSha256(input.adapterId, input.environment ?? process.env);
  const proof = await input.authority.collect({ adapterId: input.adapterId, configurationSha256 });
  // Capture the validity window after the probe completes so a multi-minute characterization cannot
  // emit a receipt whose expiresAt is already in the past relative to emission.
  const collectedAt = input.now ?? new Date();
  if (!Number.isFinite(collectedAt.getTime())) throw new TypeError("contained adapter collection time is invalid");
  revalidateRuntime(proof.availability);

  const payload = {
    schemaVersion: CONTAINED_ADAPTER_EVIDENCE_SCHEMA_VERSION,
    adapterId: input.adapterId,
    commitSha: input.commitSha,
    jobNonce: input.jobNonce,
    collectedAt: collectedAt.toISOString(),
    expiresAt: new Date(collectedAt.getTime() + CONTAINED_ADAPTER_EVIDENCE_MAX_AGE_MS).toISOString(),
    configurationSha256,
    availability: proof.availability,
    runtime: {
      executable: proof.availability.executable,
      trustedHelpers: proof.availability.trustedHelpers
    },
    containment: proof.containment,
    settlement: proof.settlement,
    checks: proof.checks
  } as const;
  const candidate = {
    ...payload,
    receiptDigest: containedAdapterEvidenceReceiptDigest(payload)
  };
  const envelope = parseContainedAdapterEvidence(candidate, {
    adapterId: input.adapterId,
    commitSha: input.commitSha,
    jobNonce: input.jobNonce,
    configurationSha256,
    now: collectedAt
  });
  const bytes = Buffer.from(`${canonicalContainedAdapterEvidenceJson(envelope)}\n`, "utf8");
  if (bytes.length > CONTAINED_ADAPTER_EVIDENCE_MAX_BYTES) {
    throw new TypeError("contained adapter evidence exceeds its byte bound");
  }
  for (const sentinel of input.forbiddenSentinels ?? []) {
    if (typeof sentinel !== "string" || sentinel.length === 0 || sentinel.includes("\0") || Buffer.byteLength(sentinel, "utf8") > 64 * 1024) {
      throw new TypeError("contained adapter evidence sentinel must be bounded and NUL-free");
    }
    if (bytes.includes(Buffer.from(sentinel, "utf8"))) {
      throw new Error("contained adapter evidence contains a forbidden prompt or credential sentinel");
    }
  }

  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(input.outputPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    writeAll(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    const dirFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
    return envelope;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (created) {
      try {
        unlinkSync(input.outputPath);
      } catch {
        // The original collection/write error remains authoritative.
      }
    }
    throw error;
  }
}

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
  type Stats
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";
import { parseScopeId, reapProofOf } from "../attest.js";
import {
  inspectProcessIncarnation,
  type ProcessIncarnationInspection
} from "../control/process-identity.js";
import type { LedgerAttestedSettlement, LedgerHandle } from "../ledger.js";
import type {
  MultiRepositoryWorkerRequestV1,
  MultiRepositoryWorkerSettlementV1
} from "./orchestration.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_TRANSCRIPT_BYTES = 128 * 1024 * 1024;
const MAX_TRANSCRIPT_ENTRIES = 4096;
const MAX_RECOVERY_DIRECTORY_ENTRIES = 4096;

export type MultiRepositoryWorkerReceiptPublishPoint =
  | "after-temp-fsync"
  | "after-link"
  | "after-unlink-before-dir-fsync";

export class MultiRepositoryWorkerRecoveryError extends Error {
  readonly code = "WORKER_RECOVERY_REQUIRED" as const;
  constructor(message: string, options?: ErrorOptions) {
    super(`WORKER_RECOVERY_REQUIRED: ${message}`, options);
    this.name = "MultiRepositoryWorkerRecoveryError";
  }
}

export type MultiRepositoryWorkerCallCandidate = Readonly<{
  providerKey: string;
  routeTag: "primary" | "fallback";
  callId: string;
}>;

const SettlementSchema = z.object({
  schemaVersion: z.literal(1),
  processIdentity: z.string().min(1).max(512),
  settlementCallId: z.string().min(1).max(512),
  outputDigest: z.string().regex(SHA256),
  summary: z.string().max(8 * 1024),
  transportTrusted: z.literal(true),
  scopeTrusted: z.literal(true),
  scopeReaped: z.literal(true),
  settlementTrusted: z.literal(true)
}).strict();

const ReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  recoveryKey: z.string().regex(SHA256),
  runId: z.string().min(1).max(256),
  runEpoch: z.string().min(1).max(256),
  taskId: z.string().min(1).max(128),
  taskGeneration: z.number().int().min(1),
  attemptId: z.string().min(1).max(256),
  leaseToken: z.string().min(1).max(512),
  repositorySetId: z.string().regex(SHA256),
  processIdentity: z.string().min(1).max(512),
  providerKey: z.string().min(1).max(128),
  routeTag: z.enum(["primary", "fallback"]),
  settlementCallId: z.string().min(1).max(512),
  ledgerEpoch: z.string().min(1).max(256),
  providerKind: z.string().min(1).max(128),
  scopeBackend: z.enum(["pgid", "cgroup2"]),
  scopeId: z.string().min(1).max(1024),
  scopeReapProof: z.string().min(1).max(2048),
  transcriptLeaf: z.string().min(1).max(255).regex(/^[^/\\\u0000]+$/u),
  transcriptDev: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
  transcriptIno: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
  transcriptSha256: z.string().regex(SHA256),
  transcriptBytes: z.number().int().min(0).max(MAX_TRANSCRIPT_BYTES),
  terminalSha256: z.string().regex(SHA256),
  terminalBytes: z.number().int().min(1).max(MAX_TRANSCRIPT_BYTES),
  terminalOffset: z.number().int().min(0).max(MAX_TRANSCRIPT_BYTES),
  protocolResultSha256: z.string().regex(SHA256),
  settlement: SettlementSchema,
  receiptDigest: z.string().regex(SHA256)
}).strict();

type WorkerRecoveryReceipt = z.infer<typeof ReceiptSchema>;

export type MultiRepositoryWorkerRecoveryLedger = Pick<LedgerHandle, "attestedSettlementOf">;

export type MultiRepositoryWorkerRecoveryStore = Readonly<{
  recoveryKey(request: MultiRepositoryWorkerRequestV1): string;
  candidates(request: MultiRepositoryWorkerRequestV1, providerKeys: readonly string[]): readonly MultiRepositoryWorkerCallCandidate[];
  record(
    request: MultiRepositoryWorkerRequestV1,
    processIdentity: string,
    callId: string,
    transcriptPath: string,
    providerKeys: readonly string[]
  ): MultiRepositoryWorkerSettlementV1;
  recover(
    request: MultiRepositoryWorkerRequestV1,
    processIdentity: string,
    providerKeys: readonly string[]
  ): MultiRepositoryWorkerSettlementV1 | undefined;
}>;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalRequest(request: MultiRepositoryWorkerRequestV1): string {
  return JSON.stringify([
    request.schemaVersion,
    request.runId,
    request.runEpoch,
    request.taskId,
    request.taskGeneration,
    request.attemptId,
    request.leaseToken,
    request.repositorySetId,
    request.members.map((member) => [member.repositoryId, member.path, member.branch, member.anchorOid])
  ]);
}

export function multiRepositoryWorkerRecoveryKey(request: MultiRepositoryWorkerRequestV1): string {
  return sha256(canonicalRequest(request));
}

export function multiRepositoryWorkerCallId(
  recoveryKey: string,
  providerKey: string,
  routeTag: "primary" | "fallback"
): string {
  if (!SHA256.test(recoveryKey)) throw new MultiRepositoryWorkerRecoveryError("worker recovery key is invalid");
  if (!providerKey || Buffer.byteLength(providerKey, "utf8") > 128) throw new MultiRepositoryWorkerRecoveryError("worker recovery provider key is invalid");
  return `mr-${recoveryKey}-${sha256(`${providerKey}\0${routeTag}`).slice(0, 24)}`;
}

export function multiRepositoryWorkerCallCandidates(
  request: MultiRepositoryWorkerRequestV1,
  providerKeys: readonly string[]
): readonly MultiRepositoryWorkerCallCandidate[] {
  if (providerKeys.length < 1 || providerKeys.length > 64 || new Set(providerKeys).size !== providerKeys.length) {
    throw new MultiRepositoryWorkerRecoveryError("worker recovery provider candidates are empty, duplicated, or excessive");
  }
  const key = multiRepositoryWorkerRecoveryKey(request);
  return Object.freeze(providerKeys.flatMap((providerKey) => (["primary", "fallback"] as const).map((routeTag) => Object.freeze({
    providerKey,
    routeTag,
    callId: multiRepositoryWorkerCallId(key, providerKey, routeTag)
  }))));
}

function privateDirectory(path: string, create: boolean): string {
  if (create && !existsSync(path)) mkdirSync(path, { mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || realpathSync.native(path) !== resolve(path)) {
    throw new MultiRepositoryWorkerRecoveryError(`recovery directory ${path} is not exact and private`);
  }
  return resolve(path);
}

function parseProcessIdentity(value: string): Readonly<{ pid: number; token: string }> {
  const match = /^pid:([1-9][0-9]*):(.+)$/u.exec(value);
  const pid = match ? Number(match[1]) : Number.NaN;
  if (!match || !Number.isSafeInteger(pid) || pid < 1 || pid > 2_147_483_647 || Buffer.byteLength(match[2]!, "utf8") > 512) {
    throw new MultiRepositoryWorkerRecoveryError("acknowledged process identity is invalid");
  }
  return Object.freeze({ pid, token: match[2]! });
}

function assertPredecessorStopped(
  processIdentity: string,
  inspect: (pid: number, token: string) => ProcessIncarnationInspection
): void {
  const identity = parseProcessIdentity(processIdentity);
  const state = inspect(identity.pid, identity.token);
  if (state.state === "alive-match") throw new MultiRepositoryWorkerRecoveryError(`acknowledged predecessor pid ${identity.pid} is still alive`);
  if (state.state === "unavailable") throw new MultiRepositoryWorkerRecoveryError(`acknowledged predecessor liveness is unavailable: ${state.detail}`);
}

function protocolResultSha256(evidence: LedgerAttestedSettlement): string {
  const payload = evidence.payload;
  return sha256(JSON.stringify([
    "success",
    payload.providerKind,
    payload.terminalSha256,
    payload.terminalBytes,
    payload.terminalOffset
  ]));
}

function settlementFrom(
  processIdentity: string,
  callId: string,
  evidence: LedgerAttestedSettlement
): MultiRepositoryWorkerSettlementV1 {
  return Object.freeze({
    schemaVersion: 1,
    processIdentity,
    settlementCallId: callId,
    outputDigest: evidence.payload.transcriptSha256,
    summary: `provider completion ${evidence.payload.transcriptSha256.slice(0, 16)} (${evidence.payload.providerKind})`,
    transportTrusted: true,
    scopeTrusted: true,
    scopeReaped: true,
    settlementTrusted: true
  });
}

function validateEvidence(
  request: MultiRepositoryWorkerRequestV1,
  processIdentity: string,
  candidate: MultiRepositoryWorkerCallCandidate,
  evidence: LedgerAttestedSettlement
): void {
  const payload = evidence.payload;
  if (payload.kind !== "accounted-terminal") throw new MultiRepositoryWorkerRecoveryError("worker call has no accounted terminal settlement");
  if (
    payload.runNonce !== request.runEpoch || evidence.bind.runNonce !== request.runEpoch ||
    payload.callId !== candidate.callId || evidence.bind.callId !== candidate.callId ||
    payload.provider !== candidate.providerKey || evidence.bind.provider !== candidate.providerKey ||
    payload.attempt !== request.taskGeneration || evidence.bind.attempt !== request.taskGeneration ||
    payload.callNonce !== evidence.bind.callNonce || payload.reservationId !== evidence.bind.reservationId ||
    payload.routeEpoch !== evidence.bind.routeEpoch || payload.model !== evidence.bind.model
  ) {
    throw new MultiRepositoryWorkerRecoveryError("ledger settlement does not belong to the exact worker attempt");
  }
  if (payload.ledgerEpoch.length < 1 || payload.transcriptBytes < 0 || payload.transcriptBytes > MAX_TRANSCRIPT_BYTES) {
    throw new MultiRepositoryWorkerRecoveryError("ledger settlement transcript bounds are invalid");
  }
  if (payload.terminalBytes < 1 || payload.terminalOffset < 0 || payload.terminalOffset + payload.terminalBytes > payload.transcriptBytes) {
    throw new MultiRepositoryWorkerRecoveryError("ledger settlement terminal range is invalid");
  }
  const scope = parseScopeId(payload.scopeId);
  const identity = parseProcessIdentity(processIdentity);
  if (!scope || scope.pid !== identity.pid || payload.scopeBackend !== scope.backend || payload.scopeReapProof !== reapProofOf(scope)) {
    throw new MultiRepositoryWorkerRecoveryError("ledger settlement does not prove the acknowledged process scope empty");
  }
}

function validateTranscript(path: string, transcriptRoot: string, evidence: LedgerAttestedSettlement): string {
  const root = privateDirectory(transcriptRoot, false);
  const physical = realpathSync.native(path);
  if (dirname(physical) !== root || basename(physical) !== basename(path)) {
    throw new MultiRepositoryWorkerRecoveryError("worker transcript is outside the exact run transcript directory");
  }
  const fd = openSync(physical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0 || before.size !== evidence.payload.transcriptBytes) {
      throw new MultiRepositoryWorkerRecoveryError("worker transcript identity, privacy, or size changed");
    }
    if (String(before.dev) !== evidence.payload.transcriptDev || String(before.ino) !== evidence.payload.transcriptIno) {
      throw new MultiRepositoryWorkerRecoveryError("worker transcript inode does not match the ledger attestation");
    }
    const whole = createHash("sha256");
    const terminal = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (count === 0) throw new MultiRepositoryWorkerRecoveryError("worker transcript ended before its attested byte count");
      const chunk = buffer.subarray(0, count);
      whole.update(chunk);
      const terminalStart = evidence.payload.terminalOffset;
      const terminalEnd = terminalStart + evidence.payload.terminalBytes;
      const overlapStart = Math.max(offset, terminalStart);
      const overlapEnd = Math.min(offset + count, terminalEnd);
      if (overlapEnd > overlapStart) terminal.update(chunk.subarray(overlapStart - offset, overlapEnd - offset));
      offset += count;
    }
    const after = fstatSync(fd);
    if (
      !after.isFile() || after.nlink !== 1 || (after.mode & 0o077) !== 0 ||
      after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
      after.ctimeMs !== before.ctimeMs || after.mtimeMs !== before.mtimeMs
    ) {
      throw new MultiRepositoryWorkerRecoveryError("worker transcript changed while it was revalidated");
    }
    if (whole.digest("hex") !== evidence.payload.transcriptSha256 || terminal.digest("hex") !== evidence.payload.terminalSha256) {
      throw new MultiRepositoryWorkerRecoveryError("worker transcript or terminal digest no longer matches the ledger attestation");
    }
  } finally {
    closeSync(fd);
  }
  return basename(physical);
}

function findTranscript(transcriptRoot: string, evidence: LedgerAttestedSettlement): string {
  const root = privateDirectory(transcriptRoot, false);
  const dir = opendirSync(root);
  let count = 0;
  let found: string | undefined;
  try {
    for (;;) {
      const entry = dir.readSync();
      if (!entry) break;
      count += 1;
      if (count > MAX_TRANSCRIPT_ENTRIES) throw new MultiRepositoryWorkerRecoveryError("transcript directory exceeds the recovery scan bound");
      if (!entry.isFile()) continue;
      const path = resolve(root, entry.name);
      const stat = lstatSync(path);
      if (String(stat.dev) !== evidence.payload.transcriptDev || String(stat.ino) !== evidence.payload.transcriptIno) continue;
      if (found !== undefined) throw new MultiRepositoryWorkerRecoveryError("ledger transcript inode has multiple directory entries");
      found = path;
    }
  } finally {
    dir.closeSync();
  }
  if (!found) throw new MultiRepositoryWorkerRecoveryError("ledger-attested worker transcript is missing");
  validateTranscript(found, root, evidence);
  return found;
}

function receiptBody(receipt: Omit<WorkerRecoveryReceipt, "receiptDigest">): string {
  return JSON.stringify(receipt);
}

function buildReceipt(
  request: MultiRepositoryWorkerRequestV1,
  processIdentity: string,
  candidate: MultiRepositoryWorkerCallCandidate,
  evidence: LedgerAttestedSettlement,
  transcriptLeaf: string
): WorkerRecoveryReceipt {
  const settlement = SettlementSchema.parse(settlementFrom(processIdentity, candidate.callId, evidence));
  const body = {
    schemaVersion: 1 as const,
    recoveryKey: multiRepositoryWorkerRecoveryKey(request),
    runId: request.runId,
    runEpoch: request.runEpoch,
    taskId: request.taskId,
    taskGeneration: request.taskGeneration,
    attemptId: request.attemptId,
    leaseToken: request.leaseToken,
    repositorySetId: request.repositorySetId,
    processIdentity,
    providerKey: candidate.providerKey,
    routeTag: candidate.routeTag,
    settlementCallId: candidate.callId,
    ledgerEpoch: evidence.payload.ledgerEpoch,
    providerKind: evidence.payload.providerKind,
    scopeBackend: evidence.payload.scopeBackend,
    scopeId: evidence.payload.scopeId,
    scopeReapProof: evidence.payload.scopeReapProof,
    transcriptLeaf,
    transcriptDev: evidence.payload.transcriptDev,
    transcriptIno: evidence.payload.transcriptIno,
    transcriptSha256: evidence.payload.transcriptSha256,
    transcriptBytes: evidence.payload.transcriptBytes,
    terminalSha256: evidence.payload.terminalSha256,
    terminalBytes: evidence.payload.terminalBytes,
    terminalOffset: evidence.payload.terminalOffset,
    protocolResultSha256: protocolResultSha256(evidence),
    settlement
  };
  return ReceiptSchema.parse(Object.freeze({ ...body, receiptDigest: sha256(receiptBody(body)) }));
}

function readBoundedReceipt(path: string): WorkerRecoveryReceipt {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size < 2 || stat.size > MAX_RECEIPT_BYTES) {
      throw new MultiRepositoryWorkerRecoveryError("worker recovery receipt is not a bounded private file");
    }
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== stat.size) throw new MultiRepositoryWorkerRecoveryError("worker recovery receipt changed while read");
    let raw: unknown;
    try { raw = JSON.parse(buffer.subarray(0, offset).toString("utf8")); }
    catch (error) { throw new MultiRepositoryWorkerRecoveryError("worker recovery receipt JSON is invalid", { cause: error }); }
    const receipt = ReceiptSchema.parse(raw);
    const { receiptDigest, ...body } = receipt;
    if (sha256(receiptBody(body)) !== receiptDigest) throw new MultiRepositoryWorkerRecoveryError("worker recovery receipt digest changed");
    const after = fstatSync(fd);
    if (
      !after.isFile() || after.nlink !== 1 || (after.mode & 0o077) !== 0 ||
      after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size ||
      after.ctimeMs !== stat.ctimeMs || after.mtimeMs !== stat.mtimeMs
    ) {
      throw new MultiRepositoryWorkerRecoveryError("worker recovery receipt changed while read");
    }
    return receipt;
  } finally {
    closeSync(fd);
  }
}

type ReceiptArtifacts = Readonly<{ finalPresent: boolean; temporaries: readonly string[] }>;

function receiptArtifacts(directory: string, recoveryKey: string): ReceiptArtifacts {
  const finalLeaf = `${recoveryKey}.json`;
  const temporaryPattern = new RegExp(`^\\.tmp-${recoveryKey}-[a-f0-9]{32}$`, "u");
  let count = 0;
  let finalPresent = false;
  const temporaries: string[] = [];
  const dir = opendirSync(directory);
  try {
    for (;;) {
      const entry = dir.readSync();
      if (!entry) break;
      count += 1;
      if (count > MAX_RECOVERY_DIRECTORY_ENTRIES) {
        throw new MultiRepositoryWorkerRecoveryError("worker recovery directory exceeds its bounded reconciliation scan");
      }
      if (entry.name === finalLeaf) finalPresent = true;
      else if (temporaryPattern.test(entry.name)) temporaries.push(resolve(directory, entry.name));
    }
  } finally {
    dir.closeSync();
  }
  temporaries.sort((left, right) => left.localeCompare(right));
  return Object.freeze({ finalPresent, temporaries: Object.freeze(temporaries) });
}

function assertPrivateReceiptFile(
  path: string,
  allowedLinks: 1 | 2,
  allowIncompleteSize = false
): Stats {
  const stat = lstatSync(path);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (
    !stat.isFile() || stat.isSymbolicLink() || stat.uid !== currentUid || stat.nlink !== allowedLinks ||
    (stat.mode & 0o077) !== 0 || (!allowIncompleteSize && (stat.size < 2 || stat.size > MAX_RECEIPT_BYTES))
  ) {
    throw new MultiRepositoryWorkerRecoveryError("worker recovery publication artifact is foreign, linked, non-private, or out of bound");
  }
  return stat;
}

function unlinkExactTemporary(path: string, expected: Stats): void {
  const current = lstatSync(path);
  if (
    !current.isFile() || current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino ||
    current.uid !== expected.uid || current.mode !== expected.mode || current.size !== expected.size || current.nlink !== expected.nlink
  ) {
    throw new MultiRepositoryWorkerRecoveryError("worker recovery temporary identity changed before cleanup");
  }
  unlinkSync(path);
}

function fsyncRecoveryDirectory(directory: string): void {
  const directoryFd = openSync(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
}

/**
 * Reconcile only this request's exact protocol debris. The hard-link publication protocol has three
 * legitimate crash states: a complete temp alone, final+temp names for the same inode, or a final
 * whose temp unlink has not yet been directory-fsynced. Anything foreign/ambiguous is refused.
 */
function reconcileReceiptPublication(
  directory: string,
  receipt: WorkerRecoveryReceipt
): WorkerRecoveryReceipt | undefined {
  const finalPath = resolve(directory, `${receipt.recoveryKey}.json`);
  const artifacts = receiptArtifacts(directory, receipt.recoveryKey);
  if (artifacts.temporaries.length > 1) {
    throw new MultiRepositoryWorkerRecoveryError("multiple worker recovery publication temporaries are ambiguous");
  }
  const temporary = artifacts.temporaries[0];

  if (artifacts.finalPresent) {
    if (temporary !== undefined) {
      const finalStat = assertPrivateReceiptFile(finalPath, 2);
      const temporaryStat = assertPrivateReceiptFile(temporary, 2);
      if (finalStat.dev !== temporaryStat.dev || finalStat.ino !== temporaryStat.ino) {
        throw new MultiRepositoryWorkerRecoveryError("worker recovery final and temporary publication artifacts have different identities");
      }
      unlinkExactTemporary(temporary, temporaryStat);
    } else {
      assertPrivateReceiptFile(finalPath, 1);
    }
    // Covers both the link+unlink recovery and a crash after unlink but before the original fsync.
    fsyncRecoveryDirectory(directory);
    const durable = readBoundedReceipt(finalPath);
    if (JSON.stringify(durable) !== JSON.stringify(receipt)) {
      throw new MultiRepositoryWorkerRecoveryError("durable worker recovery receipt conflicts with the exact ledger reconstruction");
    }
    return durable;
  }

  if (temporary !== undefined) {
    const temporaryStat = assertPrivateReceiptFile(temporary, 1, true);
    let staged: WorkerRecoveryReceipt | undefined;
    try {
      staged = readBoundedReceipt(temporary);
    } catch {
      // A crash before the temp fsync may leave a partial protocol-owned file. Its exact private
      // inode/name may be discarded; the MAC-verified ledger will reconstruct the authoritative body.
      unlinkExactTemporary(temporary, temporaryStat);
      fsyncRecoveryDirectory(directory);
      return undefined;
    }
    if (JSON.stringify(staged) !== JSON.stringify(receipt)) {
      throw new MultiRepositoryWorkerRecoveryError("worker recovery temporary conflicts with the exact ledger reconstruction");
    }
    linkSync(temporary, finalPath);
    const linkedTemporary = assertPrivateReceiptFile(temporary, 2);
    const linkedFinal = assertPrivateReceiptFile(finalPath, 2);
    if (linkedTemporary.dev !== linkedFinal.dev || linkedTemporary.ino !== linkedFinal.ino) {
      throw new MultiRepositoryWorkerRecoveryError("worker recovery temporary promotion did not preserve identity");
    }
    unlinkExactTemporary(temporary, linkedTemporary);
    fsyncRecoveryDirectory(directory);
    return readBoundedReceipt(finalPath);
  }
  return undefined;
}

function publishReceipt(
  directory: string,
  receipt: WorkerRecoveryReceipt,
  fault?: (point: MultiRepositoryWorkerReceiptPublishPoint) => void
): WorkerRecoveryReceipt {
  const reconciled = reconcileReceiptPublication(directory, receipt);
  if (reconciled) return reconciled;
  const finalPath = resolve(directory, `${receipt.recoveryKey}.json`);
  const temporary = resolve(directory, `.tmp-${receipt.recoveryKey}-${randomBytes(16).toString("hex")}`);
  const bytes = Buffer.from(JSON.stringify(receipt), "utf8");
  const fd = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fault?.("after-temp-fsync");
  linkSync(temporary, finalPath);
  fault?.("after-link");
  unlinkSync(temporary);
  fault?.("after-unlink-before-dir-fsync");
  fsyncRecoveryDirectory(directory);
  return readBoundedReceipt(finalPath);
}

function assertReceiptMatches(
  receipt: WorkerRecoveryReceipt,
  request: MultiRepositoryWorkerRequestV1,
  processIdentity: string,
  candidate: MultiRepositoryWorkerCallCandidate,
  evidence: LedgerAttestedSettlement
): void {
  const expected = buildReceipt(request, processIdentity, candidate, evidence, receipt.transcriptLeaf);
  if (JSON.stringify(receipt) !== JSON.stringify(expected)) throw new MultiRepositoryWorkerRecoveryError("worker recovery receipt does not match the exact request, lease, process, settlement, or transcript");
}

export function createMultiRepositoryWorkerRecoveryStore(options: Readonly<{
  runtimeDirectory: string;
  transcriptDirectory: string;
  ledger: MultiRepositoryWorkerRecoveryLedger;
  inspectProcess?: (pid: number, token: string) => ProcessIncarnationInspection;
  /** Failure-only injection for deterministic crash characterization; production leaves it absent. */
  receiptPublishFault?: (point: MultiRepositoryWorkerReceiptPublishPoint) => void;
}>): MultiRepositoryWorkerRecoveryStore {
  const runtime = privateDirectory(options.runtimeDirectory, false);
  const directory = privateDirectory(resolve(runtime, "worker-recovery"), true);
  const inspect = options.inspectProcess ?? inspectProcessIncarnation;

  const evidenceFor = (
    request: MultiRepositoryWorkerRequestV1,
    processIdentity: string,
    providerKeys: readonly string[],
    onlyCallId?: string
  ): Readonly<{ candidate: MultiRepositoryWorkerCallCandidate; evidence: LedgerAttestedSettlement }> | undefined => {
    const matches: Array<Readonly<{ candidate: MultiRepositoryWorkerCallCandidate; evidence: LedgerAttestedSettlement }>> = [];
    for (const candidate of multiRepositoryWorkerCallCandidates(request, providerKeys)) {
      if (onlyCallId !== undefined && candidate.callId !== onlyCallId) continue;
      const evidence = options.ledger.attestedSettlementOf(candidate.callId);
      if (!evidence || evidence.payload.kind !== "accounted-terminal") continue;
      validateEvidence(request, processIdentity, candidate, evidence);
      matches.push(Object.freeze({ candidate, evidence }));
    }
    if (matches.length > 1) throw new MultiRepositoryWorkerRecoveryError("more than one accounted provider completion exists for one worker attempt");
    return matches[0];
  };

  return Object.freeze({
    recoveryKey: multiRepositoryWorkerRecoveryKey,
    candidates: multiRepositoryWorkerCallCandidates,
    record(request, processIdentity, callId, transcriptPath, providerKeys) {
      assertPredecessorStopped(processIdentity, inspect);
      const matched = evidenceFor(request, processIdentity, providerKeys, callId);
      if (!matched) throw new MultiRepositoryWorkerRecoveryError("completed worker has no exact ledger-attested settlement");
      const transcriptLeaf = validateTranscript(transcriptPath, options.transcriptDirectory, matched.evidence);
      const requested = buildReceipt(request, processIdentity, matched.candidate, matched.evidence, transcriptLeaf);
      const durable = publishReceipt(directory, requested, options.receiptPublishFault);
      assertReceiptMatches(durable, request, processIdentity, matched.candidate, matched.evidence);
      // Reopen/re-hash the source after the receipt is durably visible and before the caller may append
      // the canonical worker fact. A crash in this window leaves a complete receipt that restart can
      // adopt; a concurrent transcript replacement cannot race publication into canonical authority.
      validateTranscript(resolve(options.transcriptDirectory, durable.transcriptLeaf), options.transcriptDirectory, matched.evidence);
      return durable.settlement;
    },
    recover(request, processIdentity, providerKeys) {
      assertPredecessorStopped(processIdentity, inspect);
      const key = multiRepositoryWorkerRecoveryKey(request);
      // Crash after the ledger's fsynced settlement but before receipt publication: the MAC-verified
      // call ID identifies this attempt, and the ledger's inode/hash/terminal/scope evidence lets the
      // new parent reconstruct and publish the same closed receipt without launching a replacement.
      const matched = evidenceFor(request, processIdentity, providerKeys);
      if (!matched) {
        const artifacts = receiptArtifacts(directory, key);
        if (artifacts.finalPresent || artifacts.temporaries.length > 0) {
          throw new MultiRepositoryWorkerRecoveryError("worker recovery publication exists without its ledger attestation");
        }
        return undefined;
      }
      const transcriptPath = findTranscript(options.transcriptDirectory, matched.evidence);
      const requested = buildReceipt(request, processIdentity, matched.candidate, matched.evidence, basename(transcriptPath));
      const durable = publishReceipt(directory, requested, options.receiptPublishFault);
      assertReceiptMatches(durable, request, processIdentity, matched.candidate, matched.evidence);
      validateTranscript(resolve(options.transcriptDirectory, durable.transcriptLeaf), options.transcriptDirectory, matched.evidence);
      return durable.settlement;
    }
  });
}

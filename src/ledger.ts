import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  openSync,
  readdirSync,
  readSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import {
  ATTEST_KEY_BYTES,
  attestKeyFromBytes,
  tagPayload,
  verifyAttestation,
  type AttestKey,
  type AttestPayload,
  type DurableAttestation
} from "./attest.js";
import { flockExclusive, flockShared, probeFlock } from "./flock.js";
import { formatNano, isNanoString, MAX_NANO, MoneyError, nanoToUsd, parseNano, usdToNano } from "./money.js";
import { isProcessGroupAlive } from "./runtime.js";
import { detectScopeCapability, reapProofOf, scopeAliveOf, scopeIdOf, type ScopeRef } from "./scope.js";
import { settleCompletedCall, type CompletedCallSettlement, type SettlementOutcome } from "./settlement-kernel.js";

/**
 * The RUN-SCOPED money authority (wave-8d independent audit, B1–B7).
 *
 * The old ledger's authority was a PATHNAME. Every call re-resolved `<board>/reservations.jsonl`,
 * created it with `O_CREAT` if absent, and folded whatever it found. The audit turned that into three
 * P0s:
 *
 *   B1  `assertPublished()` ran BEFORE the directory fsync, so swapping the leaf inside the dir-fsync
 *       window returned `reserveCall === true` while a fresh read of the path showed ZERO spend.
 *   B2  there was no durable generation: rename the ledger away, let the next call `O_CREAT` a fresh
 *       one, and a second `$0.75` reservation won under the same `$1` budget. `JOURNAL_GENESIS` was the
 *       constant string "genesis" — a foreign ledger validated perfectly, and records from different
 *       runs could coexist in one chain.
 *   B4  a file-fsync `EIO` threw, but the complete bytes stayed on disk; a later ordinary read folded
 *       them and reported `callSettled: true`, releasing the worst-case reservation to an unproven cost.
 *
 * The fix is a HANDLE, established once per run after its immutable identity exists. It pins the
 * component-walked ancestors and parent, binds a random ledger epoch + random chain genesis + the
 * expected parent/leaf (dev, ino) + the run nonce into a durable manifest, and thereafter addresses the
 * leaf ONLY through pinned descriptors, never through a name. Ordinary transactions never `O_CREAT`:
 * a replaced leaf/parent/ancestor is `recovery_required`, never a fresh empty budget.
 *
 * Durability is proven, never inferred: an fsynced write-ahead INTENT precedes every mutation, and a
 * COMMIT follows only after the record is fsynced, byte-verified, published, and re-proven through a
 * FINAL component rewalk. A dangling intent (or any failure after a possible mutation) POISONS the
 * ledger — the bytes on disk can never be read back into trust by an ordinary reader. Only an explicit
 * exclusive reconciliation with its own durable receipt clears it.
 */

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** The ledger's generation cannot be proven (replaced leaf/parent/ancestor, foreign manifest, dangling
 *  write-ahead intent, or a poisoned handle). It is NEVER an empty ledger and never a zero spend: the
 *  run stops and an operator reconciles. */
export class LedgerRecoveryRequired extends Error {
  constructor(message: string) {
    super(`ledger recovery_required: ${message}`);
    this.name = "LedgerRecoveryRequired";
  }
}

/** A COMPLETE, terminated record that failed to validate: bad JSON mid-stream, a broken chain link, a
 *  wrong hash, an unknown schema, a foreign epoch/run, an invalid amount, or a conflicting duplicate/
 *  orphan call. Unrecoverable — never converted into "zero spend", never appended behind. */
export class CorruptJournalError extends Error {
  constructor(message: string) {
    super(`journal corruption (fail closed): ${message}`);
    this.name = "CorruptJournalError";
  }
}

// ---------------------------------------------------------------------------------------------
// Identity-bound records
// ---------------------------------------------------------------------------------------------

/**
 * What a production reservation is BOUND to. Every field is mandatory: a half-filled identity is not a
 * weaker-but-acceptable receipt, it is corruption. The settlement must carry the identical binding.
 */
export type CallBinding = {
  /** 256-bit random run identity, minted with the run manifest. */
  runNonce: string;
  /** 128-bit random per-call identity. Spendable exactly ONCE across the whole journal. */
  callNonce: string;
  /** The physical call id this reservation belongs to. Bound INTO the record, not just its key. */
  callId: string;
  /** 128-bit random identity of the reservation RECORD itself, echoed by its settlement. */
  reservationId: string;
  /** Routing generation. A cooldown or route change bumps it, so a stale-route settlement is rejected. */
  routeEpoch: number;
  provider: string;
  model: string;
  attempt: number;
  /** Hash of the logical intent (role + task + system prompt) that authorized this spend. */
  intentSha256: string;
  /** Hash and exact byte count of the bytes delivered to the provider on stdin. */
  stdinSha256: string;
  stdinBytes: number;
};

/**
 * ---------------------------------------------------------------------------------------------
 * THERE IS NO MINTING SURFACE. THAT IS THE POINT.
 * ---------------------------------------------------------------------------------------------
 * Two generations of settlement authority have now been withdrawn from this module:
 *
 *   1. `SettlementReceipt` as an exported object TYPE, whose every field was a caller's claim and whose
 *      only defence was shape validation. An ordinary caller minted authority by writing an object
 *      literal — a "reaped" scope that never spawned, a transcript hash matching no file, a
 *      `provider-reported` cost of $0.000001 that shrank a $0.50 reservation, and a `trusted-fallback`
 *      kind that authorized billing a second provider.
 *
 *   2. `CallAuthority`, the capability-based replacement. It moved the evidence check inside the ledger,
 *      but it still handed a mint (`recordScope` → `registerTranscript` → `sealTransport` → `attest` →
 *      `settle(receipt)`) to any holder of a `LedgerHandle`. Every gate it applied was a check on
 *      evidence the CALLER supplied, so any module that could reach the handle could reserve a call of
 *      its own, plant a transcript, name an already-dead pid, and walk the same path to a minted receipt.
 *      See `tests/receipt-forgery.test.ts`.
 *
 * So the CALLER-FACING mint is gone, not merely guarded. The only settlement primitive this module
 * exposes to a handle holder is `settleUncertain()`, which retains the full worst-case reservation and
 * authorizes nothing — calling it can only ever cost a caller money, never save it.
 *
 * Authority came back (wave-9) as a KERNEL the transport cannot reach: `#attestAndSettle` (money) and
 * `#attestFallback` (the right to bill a second provider) are ECMAScript-`#private` methods, reachable
 * ONLY from the per-call capability `settleCompleted` builds and never returns. Neither accepts a
 * caller's verdict — both are handed evidence the kernel re-derived from the durable bytes, and the
 * ledger re-probes the scope, re-validates the money, and stamps its own identity before it MACs
 * anything. See the settlement-KERNEL section below, tests/receipt-forgery.test.ts, and
 * tests/kernel-bridge-forgery.test.ts.
 */

type ReserveData = {
  type: "reserve";
  callId: string;
  /** Worst case in NANO-USD, as a decimal string. No float ever reaches the journal. */
  worstCaseNano: string;
  enforced: boolean;
  ts: string;
  epoch: string;
  bind: CallBinding;
};

type SettleData = {
  type: "settle";
  callId: string;
  usdNano: string;
  reported: boolean;
  ts: string;
  epoch: string;
  bind: CallBinding;
  /** The ledger's own MAC-tagged attestation, when this settlement was ISSUED authority. Absent for an
   *  UNCERTAIN settlement, which retains the worst case and authorizes nothing. Never caller-supplied. */
  attest?: DurableAttestation;
};

type JournalData = ReserveData | SettleData;
type JournalRecord = { seq: number; prev: string; hash: string; data: JournalData };

const LEDGER_SCHEMA = "loop.ledger.v2";
const POISON_SCHEMA = "loop.ledger.poison.v1";
const RECOVERY_SCHEMA = "loop.ledger.recovery.v1";

/**
 * The durable ledger MANIFEST: the generation itself. Published once, atomically, and never rewritten.
 * It is what makes "is this the same ledger I was reserving against?" an answerable question.
 */
type LedgerManifest = {
  schema: typeof LEDGER_SCHEMA;
  /** 256-bit random LEDGER epoch. Every record carries it, so a foreign/copied ledger cannot be folded. */
  epoch: string;
  /** 256-bit random chain root. The old constant "genesis" made any foreign chain verify perfectly. */
  genesis: string;
  /** The immutable run identity this ledger belongs to. A different run's ledger is not ours. */
  runNonce: string;
  leaf: string;
  wal: string;
  /** The exact inodes this generation lives on. A replacement is recovery_required, never a new budget. */
  parentDev: string;
  parentIno: string;
  leafDev: string;
  leafIno: string;
  /** Every ancestor component from "/" down to the parent, pinned by identity. */
  ancestors: { dev: string; ino: string }[];
  createdTs: string;
};

// ---------------------------------------------------------------------------------------------
// Injected IO (there are NO module-global hooks — the audit's B7: exported test hooks could alter
// unrelated production transactions).
// ---------------------------------------------------------------------------------------------

export type FileId = { dev: bigint; ino: bigint; mode: number; uid: number; nlink: number; size: number; isFile: boolean; isDir: boolean };

export type LedgerIO = {
  open(path: string, flags: number, mode?: number): number;
  close(fd: number): void;
  fstat(fd: number): FileId;
  read(fd: number, buf: Buffer, offset: number, length: number, position: number): number;
  write(fd: number, buf: Buffer, offset: number, length: number, position: number): number;
  ftruncate(fd: number, len: number): void;
  /** Correctness-critical. EVERY error propagates — there is no allowlist for a record's own fsync. */
  fsyncFile(fd: number): void;
  /** Correctness-critical. An UNSUPPORTED directory fsync is a CAPABILITY FAILURE, not a success: we
   *  cannot prove publication on such a filesystem, so the ledger refuses to run there. */
  fsyncDir(fd: number): void;
  lockExclusive(fd: number, timeoutMs: number): void;
  lockShared(fd: number, timeoutMs: number): void;
  link(from: string, to: string): void;
  unlink(path: string): void;
  /** The names in a directory. Used ONLY to identify this protocol's own publish debris — see
   *  `sweepPublishDebris`, which removes a leftover temp by INODE, never by name alone. */
  readdir(path: string): string[];
  probeLock(path: string): void;
  now(): string;
  randomHex(bytes: number): string;
};

function toFileId(st: ReturnType<typeof fstatSync>): FileId {
  const big = st as unknown as { dev: bigint; ino: bigint; mode: bigint; uid: bigint; nlink: bigint; size: bigint };
  return {
    dev: big.dev,
    ino: big.ino,
    mode: Number(big.mode),
    uid: Number(big.uid),
    nlink: Number(big.nlink),
    size: Number(big.size),
    isFile: st.isFile(),
    isDir: st.isDirectory()
  };
}

export function realLedgerIO(): LedgerIO {
  return {
    open: (p, f, m) => openSync(p, f, m),
    close: (fd) => closeSync(fd),
    fstat: (fd) => toFileId(fstatSync(fd, { bigint: true }) as unknown as ReturnType<typeof fstatSync>),
    read: (fd, b, o, l, p) => readSync(fd, b, o, l, p),
    write: (fd, b, o, l, p) => writeSync(fd, b, o, l, p),
    ftruncate: (fd, l) => ftruncateSync(fd, l),
    fsyncFile: (fd) => fsyncSync(fd),
    fsyncDir: (fd) => fsyncSync(fd),
    lockExclusive: (fd, t) => flockExclusive(fd, t),
    lockShared: (fd, t) => flockShared(fd, t),
    link: (a, b) => linkSync(a, b),
    unlink: (p) => unlinkSync(p),
    readdir: (p) => readdirSync(p),
    probeLock: (p) => probeFlock(p),
    now: () => new Date().toISOString(),
    randomHex: (n) => randomBytes(n).toString("hex")
  };
}

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

const LOCK_TIMEOUT_MS = 60_000;
const MAX_LEDGER_BYTES = 64 * 1024 * 1024;
const MAX_WAL_BYTES = 64 * 1024 * 1024;
const O_DIR = fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
/** O_NONBLOCK so a planted FIFO/device leaf can never BLOCK a transaction; the type check rejects it
 *  before a byte is read. */
const O_LEAF_RW = fsConstants.O_RDWR | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
const O_LEAF_R = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;

/** Address a child THROUGH a pinned directory fd (the openat equivalent): a swap of the parent's NAME
 *  cannot redirect this, because we traverse the descriptor, not the path. */
function at(dirFd: number, leaf: string): string {
  return `/proc/self/fd/${dirFd}/${leaf}`;
}

function procFdAvailable(): boolean {
  return process.platform === "linux";
}

// ---------------------------------------------------------------------------------------------
// Validation — a present field must be COMPLETE and well-typed, or the record fails closed
// ---------------------------------------------------------------------------------------------

const SHA256 = /^[0-9a-f]{64}$/;
const HEX = /^[0-9a-f]+$/;

export function validateBinding(v: unknown): string | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return "binding is not an object";
  const b = v as Record<string, unknown>;
  if (typeof b.runNonce !== "string" || b.runNonce.length < 32 || !HEX.test(b.runNonce)) return "invalid binding runNonce";
  if (typeof b.callNonce !== "string" || b.callNonce.length < 32 || !HEX.test(b.callNonce)) return "invalid binding callNonce";
  if (typeof b.callId !== "string" || !b.callId) return "invalid binding callId";
  if (typeof b.reservationId !== "string" || b.reservationId.length < 32 || !HEX.test(b.reservationId)) return "invalid binding reservationId";
  if (typeof b.routeEpoch !== "number" || !Number.isInteger(b.routeEpoch) || b.routeEpoch < 0) return "invalid binding routeEpoch";
  if (typeof b.provider !== "string" || !b.provider) return "invalid binding provider";
  if (typeof b.model !== "string" || !b.model) return "invalid binding model";
  if (typeof b.attempt !== "number" || !Number.isInteger(b.attempt) || b.attempt < 0) return "invalid binding attempt";
  if (typeof b.intentSha256 !== "string" || !SHA256.test(b.intentSha256)) return "invalid binding intentSha256";
  if (typeof b.stdinSha256 !== "string" || !SHA256.test(b.stdinSha256)) return "invalid binding stdinSha256";
  if (typeof b.stdinBytes !== "number" || !Number.isInteger(b.stdinBytes) || b.stdinBytes < 0) return "invalid binding stdinBytes";
  return undefined;
}

/**
 * Is this settlement's attestation AUTHENTIC and does it belong to THIS record?
 *
 * The old `costIsTrusted` re-checked the receipt's SHAPE at fold time. Shape is not authenticity: a
 * hand-chained journal record carrying a perfectly-shaped receipt folded into trusted spend. Here the
 * MAC — keyed by a secret this ledger generation owns and no caller can reach — decides, and the payload
 * must additionally match the record it rides on, field for field. So an attestation cannot be lifted
 * from one settlement and pasted onto another (different call, reservation, attempt, route epoch, or
 * amount) even within the same ledger: the payload would still verify, but it would no longer agree with
 * its host record, and disagreement is corruption.
 *
 * Returns an error string, or undefined when the attestation is authentic AND bound to this record.
 */
function attestationBindingError(key: AttestKey, s: SettleData, epoch: string, runNonce: string): string | undefined {
  const a = s.attest;
  if (a === undefined) return undefined; // no attestation at all: legal, and it authorizes nothing
  const bad = verifyAttestation(key, a);
  if (bad) return bad;
  const p = a.payload;
  if (p.ledgerEpoch !== epoch) return `attestation belongs to ledger generation ${p.ledgerEpoch.slice(0, 12)}…, not this one`;
  if (p.runNonce !== runNonce) return `attestation belongs to run ${p.runNonce.slice(0, 12)}…, not this one`;
  // The attestation must describe the very call/reservation/attempt/route this settlement discharges.
  const b = s.bind;
  if (p.callId !== s.callId) return `attestation callId ${p.callId} does not match its settlement`;
  if (p.callId !== b.callId) return `attestation callId ${p.callId} does not match its binding`;
  if (p.callNonce !== b.callNonce) return "attestation callNonce does not match its binding (cross-call replay)";
  if (p.reservationId !== b.reservationId) return "attestation reservationId does not match its binding (cross-reservation replay)";
  if (p.routeEpoch !== b.routeEpoch) return "attestation routeEpoch does not match its binding (stale-route replay)";
  if (p.provider !== b.provider) return "attestation provider does not match its binding";
  if (p.model !== b.model) return "attestation model does not match its binding";
  if (p.attempt !== b.attempt) return "attestation attempt does not match its binding (cross-attempt replay)";
  // The MONEY the record carries must be exactly the money the ledger attested. A record that claims a
  // different amount than its own attestation is corruption, never the cheaper of the two.
  if (p.usdNano !== s.usdNano) return `settlement records ${s.usdNano} nano-USD but its attestation charges ${p.usdNano}`;
  if (s.reported !== (p.costProvenance === "provider-reported")) return "settlement `reported` flag contradicts its attestation's cost provenance";
  return undefined;
}

/**
 * Does this settlement PROVE its money number? Decided at fold time from the MAC, never from a stored
 * boolean — a journal tampered with on disk is folded by exactly this function.
 */
function costIsTrusted(key: AttestKey, s: SettleData, epoch: string, runNonce: string): boolean {
  const a = s.attest;
  if (a === undefined || !s.reported) return false;
  if (attestationBindingError(key, s, epoch, runNonce) !== undefined) return false;
  return a.payload.costProvenance === "provider-reported";
}

/** Does this settlement authorize BILLING A SECOND PROVIDER for the same turn? Only an authentic
 *  `trusted-fallback` attestation — which the ledger issues only after reading a canonical
 *  `rate_limit_event` rejection out of the durable transcript itself. */
function authorizesFallback(key: AttestKey, s: SettleData, epoch: string, runNonce: string): boolean {
  const a = s.attest;
  if (a === undefined) return false;
  if (attestationBindingError(key, s, epoch, runNonce) !== undefined) return false;
  return a.payload.kind === "trusted-fallback";
}

function validateRecordSchema(rec: unknown, epoch: string, runNonce: string, key: AttestKey): string | undefined {
  if (typeof rec !== "object" || rec === null || Array.isArray(rec)) return "record is not an object";
  const r = rec as Record<string, unknown>;
  if (typeof r.seq !== "number" || !Number.isInteger(r.seq) || r.seq < 0) return "invalid seq";
  if (typeof r.prev !== "string" || !r.prev) return "invalid prev";
  if (typeof r.hash !== "string" || !r.hash) return "invalid hash";
  const d = r.data as Record<string, unknown> | undefined;
  if (typeof d !== "object" || d === null || Array.isArray(d)) return "invalid data";
  if (typeof d.ts !== "string" || !d.ts) return "invalid ts";
  if (typeof d.callId !== "string" || !d.callId) return "invalid callId";
  // A record from a DIFFERENT ledger generation or a DIFFERENT run can never be folded into this one:
  // that is exactly how a swapped/copied ledger reset the budget (audit B2).
  if (d.epoch !== epoch) return `record epoch ${String(d.epoch)} does not belong to this ledger generation`;
  const bindErr = validateBinding(d.bind);
  if (bindErr) return bindErr;
  const bind = d.bind as CallBinding;
  if (bind.runNonce !== runNonce) return `record runNonce ${bind.runNonce.slice(0, 12)} does not belong to this run`;
  if (bind.callId !== d.callId) return `record callId ${String(d.callId)} does not match its binding`;
  try {
    if (d.type === "reserve") {
      parseNano(d.worstCaseNano, "worstCaseNano");
      if (typeof d.enforced !== "boolean") return "invalid enforced flag";
    } else if (d.type === "settle") {
      parseNano(d.usdNano, "usdNano");
      if (typeof d.reported !== "boolean") return "invalid reported flag";
      // A settlement that CLAIMS authority must prove it. A present-but-inauthentic attestation (forged,
      // altered, lifted from another call/run/ledger, or edited on disk) is CORRUPTION — it is never
      // silently downgraded to "an uncertain settlement", because that would let a tamperer choose
      // between two outcomes by damaging the tag. Absent attestation is fine: it grants nothing.
      if (d.attest !== undefined) {
        const err = attestationBindingError(key, d as unknown as SettleData, epoch, runNonce);
        if (err) return err;
      }
    } else {
      return `unknown record type ${String(d.type)}`;
    }
  } catch (error) {
    return (error as Error).message;
  }
  return undefined;
}

/** Why a settlement's binding does not belong to its reservation (undefined = field-for-field match). */
function bindingMismatch(reserve: CallBinding, settle: CallBinding): string | undefined {
  const keys: (keyof CallBinding)[] = [
    "runNonce",
    "callNonce",
    "callId",
    "reservationId",
    "routeEpoch",
    "provider",
    "model",
    "attempt",
    "intentSha256",
    "stdinSha256",
    "stdinBytes"
  ];
  for (const k of keys) {
    if (reserve[k] !== settle[k]) return `${k} ${String(settle[k])} != reserved ${String(reserve[k])}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Chain fold
// ---------------------------------------------------------------------------------------------

function recordHash(prev: string, seq: number, data: JournalData): string {
  return createHash("sha256").update(`${prev}|${seq}|${JSON.stringify(data)}`).digest("hex");
}

type Folded = { datas: JournalData[]; tip: string; seq: number; durableBytes: number };

/**
 * Fold the hash-chained journal. A COMPLETE (newline-terminated) record that fails any check is
 * UNRECOVERABLE corruption — we throw rather than truncate to a shorter, cheaper prefix. ONLY an
 * unterminated final tail (a crash mid-append) may be recovered, by truncation.
 */
function foldContent(raw: string, epoch: string, genesis: string, runNonce: string, key: AttestKey): Folded {
  const datas: JournalData[] = [];
  let tip = genesis;
  let seq = 0;
  let durableBytes = 0;
  if (raw === "") return { datas, tip, seq, durableBytes };
  const endsWithNewline = raw.endsWith("\n");
  const lines = raw.split("\n");
  if (endsWithNewline) lines.pop();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const unterminated = i === lines.length - 1 && !endsWithNewline;
    if (line.trim() === "") {
      if (unterminated) break;
      throw new CorruptJournalError(`blank record at line ${i}`);
    }
    let rec: JournalRecord;
    try {
      rec = JSON.parse(line) as JournalRecord;
    } catch {
      if (unterminated) break; // torn final line (crash mid-append) → recover the durable prefix
      throw new CorruptJournalError(`unparseable terminated record at line ${i}`);
    }
    const schemaErr = validateRecordSchema(rec, epoch, runNonce, key);
    if (schemaErr) {
      if (unterminated) break;
      throw new CorruptJournalError(`${schemaErr} at line ${i}`);
    }
    if (rec.prev !== tip || rec.seq !== seq) {
      if (unterminated) break;
      throw new CorruptJournalError(`broken chain link at seq ${rec.seq} (expected prev ${tip.slice(0, 12)}, seq ${seq})`);
    }
    if (rec.hash !== recordHash(tip, seq, rec.data)) {
      if (unterminated) break;
      throw new CorruptJournalError(`hash mismatch at seq ${seq} (tampered record)`);
    }
    datas.push(rec.data);
    tip = rec.hash;
    seq += 1;
    durableBytes += Buffer.byteLength(line, "utf8") + 1;
  }
  return { datas, tip, seq, durableBytes };
}

type Reservation = {
  worstCase: bigint;
  enforced: boolean;
  settled: boolean;
  /** The settled amount ONLY when a receipt proved it. Otherwise null → the worst case is retained. */
  trustedUsd: bigint | null;
  fallbackAuthorized: boolean;
  over: boolean;
  bind: CallBinding;
};

/**
 * Replay the journal into per-call state. Beyond chain/hash/schema corruption, the call-id TRANSITIONS
 * are validated: a re-reserve of a live id, an orphan settle, and a duplicate settle are conflicting
 * records — corruption — so a restart that reuses an id can never overwrite prior accounting. A call
 * nonce is spendable exactly once across the whole journal.
 */
function foldReservations(datas: JournalData[], key: AttestKey, epoch: string, runNonce: string): Map<string, Reservation> {
  const map = new Map<string, Reservation>();
  const spentNonces = new Set<string>();
  let seq = 0;
  for (const r of datas) {
    if (r.type === "reserve") {
      if (map.has(r.callId)) throw new CorruptJournalError(`duplicate/re-reserve for call id ${r.callId} at seq ${seq}`);
      if (spentNonces.has(r.bind.callNonce)) {
        throw new CorruptJournalError(`replayed call nonce ${r.bind.callNonce.slice(0, 12)} at seq ${seq} (spendable exactly once)`);
      }
      spentNonces.add(r.bind.callNonce);
      map.set(r.callId, {
        worstCase: parseNano(r.worstCaseNano),
        enforced: r.enforced,
        settled: false,
        trustedUsd: null,
        fallbackAuthorized: false,
        over: false,
        bind: r.bind
      });
    } else {
      const cur = map.get(r.callId);
      if (!cur) throw new CorruptJournalError(`orphan settle for unknown call id ${r.callId} at seq ${seq}`);
      if (cur.settled) throw new CorruptJournalError(`duplicate settle for call id ${r.callId} at seq ${seq}`);
      const mismatch = bindingMismatch(cur.bind, r.bind);
      if (mismatch) throw new CorruptJournalError(`settlement identity mismatch for call id ${r.callId} at seq ${seq}: ${mismatch}`);
      cur.settled = true;
      // A settlement releases the worst case ONLY when an AUTHENTIC ledger attestation proves the number.
      // Missing → the money number is NOT applied and the worst case stands (audit B3: a bare settle, and
      // even a receipt with scopeReaped:false + costProvenance:"untrusted", shrank $0.50 to $0.01). An
      // attestation that is present but inauthentic never reaches here at all — `validateRecordSchema`
      // already failed the fold closed on it.
      cur.trustedUsd = costIsTrusted(key, r, epoch, runNonce) ? parseNano(r.usdNano) : null;
      cur.fallbackAuthorized = authorizesFallback(key, r, epoch, runNonce);
      if (cur.enforced && cur.trustedUsd !== null && cur.trustedUsd > cur.worstCase) cur.over = true;
    }
    seq += 1;
  }
  return map;
}

function spendOf(map: Map<string, Reservation>): bigint {
  let total = 0n;
  for (const r of map.values()) total += r.settled && r.trustedUsd !== null ? r.trustedUsd : r.worstCase;
  return total;
}

// ---------------------------------------------------------------------------------------------
// Write-ahead log — durability is PROVEN, never inferred from bytes (audit B4)
// ---------------------------------------------------------------------------------------------

type WalRecord =
  | { t: "intent"; seq: number; off: number; h: string; ts: string }
  | { t: "commit"; seq: number; h: string; ts: string }
  | { t: "poison"; reason: string; ts: string }
  | { t: "recovered"; receipt: string; ts: string };

type WalState = { durableBytes: number; pending?: { seq: number; h: string }; poison?: string };

/**
 * Fold the WAL. The rule that closes the laundering hole: an INTENT with no COMMIT means a mutation may
 * have touched the leaf without ever being proven durable. Those bytes may LOOK like a perfect record —
 * they may even BE one — but nothing proves they reached stable storage, so no ordinary read may fold
 * them into trust. That state is `recovery_required` until an explicit reconciliation clears it.
 *
 * A torn (unterminated) final line is dropped: the intent is fsynced BEFORE the leaf is touched, so a
 * crash mid-WAL-append means the leaf was never mutated.
 */
function foldWal(raw: string): WalState {
  let durableBytes = 0;
  let pending: { seq: number; h: string } | undefined;
  let poison: string | undefined;
  if (raw === "") return { durableBytes, pending, poison };
  const endsWithNewline = raw.endsWith("\n");
  const lines = raw.split("\n");
  if (endsWithNewline) lines.pop();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const unterminated = i === lines.length - 1 && !endsWithNewline;
    if (line.trim() === "") {
      if (unterminated) break;
      throw new CorruptJournalError(`blank WAL record at line ${i}`);
    }
    let rec: WalRecord;
    try {
      rec = JSON.parse(line) as WalRecord;
    } catch {
      if (unterminated) break; // one torn final record is tolerated; the leaf was not yet touched
      throw new CorruptJournalError(`unparseable terminated WAL record at line ${i}`);
    }
    switch (rec.t) {
      case "intent":
        if (typeof rec.seq !== "number" || typeof rec.h !== "string" || typeof rec.off !== "number") {
          if (unterminated) break;
          throw new CorruptJournalError(`invalid WAL intent at line ${i}`);
        }
        pending = { seq: rec.seq, h: rec.h };
        break;
      case "commit":
        if (!pending || pending.seq !== rec.seq || pending.h !== rec.h) {
          if (unterminated) break;
          throw new CorruptJournalError(`WAL commit at line ${i} does not match the pending intent`);
        }
        pending = undefined;
        break;
      case "poison":
        poison = typeof rec.reason === "string" ? rec.reason : "unspecified";
        break;
      case "recovered":
        pending = undefined;
        poison = undefined;
        break;
      default:
        if (unterminated) break;
        throw new CorruptJournalError(`unknown WAL record type at line ${i}`);
    }
    durableBytes += Buffer.byteLength(line, "utf8") + 1;
  }
  return { durableBytes, pending, poison };
}

// ---------------------------------------------------------------------------------------------
// The handle
// ---------------------------------------------------------------------------------------------

export type SettlementStatus = {
  settled: boolean;
  /** The settlement's receipt PROVED its cost, so the actual (not the worst case) is being counted. */
  costTrusted: boolean;
  /** The settlement carries a trusted-fallback receipt: a second provider may be billed for this turn. */
  fallbackAuthorized: boolean;
};

/** The capabilities the ledger uses to VERIFY evidence for itself, instead of believing a caller. */
export type LedgerCaps = {
  /** Whether ANY process in the owned group `pid` is still alive. The ledger probes the scope ITSELF at
   *  attestation time; it never accepts a caller's word (or a caller's "proof" string) that a scope was
   *  reaped. Injectable so tests can drive it deterministically without real processes. */
  groupAlive(pid: number): boolean;
  /** Whether the owned SCOPE — of whichever backend the call actually ran under — still holds anything.
   *  For a `cgroup2` scope this asks the KERNEL (the cgroup's continued existence, plus the leader's
   *  process group), so a descendant that `setsid`'d out of the process group is still counted. This is
   *  the probe that gates every mint; `groupAlive` is only its process-group half. */
  scopeAlive(ref: ScopeRef): boolean;
  /** Whether THIS HOST can give a provider a strong (cgroup) scope. When it can, a settlement that claims
   *  only a process-group scope is a DOWNGRADE — the run had containment available and is asserting the
   *  weaker proof anyway — and the mint refuses it. Where no strong scope exists, real execution already
   *  fails closed before any provider spawns (`requireScopeBackend`), so a pgid scope can only reach a mint
   *  through the imported trusted-runner test seam. */
  strongScopeAvailable: boolean;
  /** The directory every registrable transcript must live strictly inside, with no symlinked component.
   *  A transcript outside it — or reached through a symlink — is refused: evidence the ledger cannot
   *  confine is evidence an attacker could have planted. */
  transcriptRoot: string;
};

// ---------------------------------------------------------------------------------------------
// The settlement KERNEL hook (wave-9 slice 1)
//
// The RAW MINT is gone from the ledger's reachable surface, and it stays gone: no method named
// `beginCall`/`recordScope`/`registerTranscript`/`sealTransport`/`attest`/`settle` exists on
// `LedgerHandle`, and NOTHING hands a caller an object that can move money on a fabricated draft (see
// tests/receipt-forgery.test.ts and tests/kernel-bridge-forgery.test.ts). What actually mints is narrower
// than the withdrawn `CallAuthority`, and it is unreachable by construction:
//
//   - The mint is `#attestAndSettle`, an ECMAScript-`#private` method. It is in no `Reflect.ownKeys`, no
//     `getOwnPropertySymbols`, and unreachable by `(handle as any).attestAndSettle` or a prototype walk.
//     The `#private` attestation key is equally out of reach, so it cannot be tagged directly either.
//   - There is NO exported bridge and NO module symbol to claim. The old `claimLedgerKernelBridge()` — a
//     first-claim function whose "single use" depended on import order — is DELETED. An ordinary
//     direct-source importer that loads `./ledger` before the kernel now finds no door to the mint.
//   - The only entry is `LedgerHandle.settleCompleted`, which the ledger drives through the kernel. It
//     builds the narrow `#kernelAccess()` capability from its own `#private` state, hands it to
//     `settleCompletedCall`, and never returns it. The kernel accepts NO caller-asserted verdict: it hands
//     back DERIVED evidence (bytes it re-read from the durable transcript under the ledger's own
//     confinement root, the frame it re-located by replaying them, the pgid it observed spawn) and the
//     ledger re-probes the scope ITSELF, re-validates the money in exact fixed point, stamps its own
//     epoch/run/ts, and MACs the payload with a key nothing can read back out.
//
// TWO authorities are issuable, by two separate `#private` mints, and NOTHING can reach either:
//
//   `accounted-terminal` (#attestAndSettle) — a genuine, whole-stream provider SUCCESS whose cost the
//     provider itself reported. It moves MONEY: the actual cost stands in place of the worst case.
//
//   `trusted-fallback` (#attestFallback, wave-9 slice 2) — a canonical Claude usage REJECTION that the
//     kernel RE-DERIVED by replaying the durable transcript through the production framer and the
//     production Claude state machine. It moves no money at all (the worst case is retained); what it
//     authorizes is a ROUTE — billing a SECOND provider for this one turn. Nothing else in the process
//     can produce one, and the two payload shapes are mutually exclusive on disk: a trusted-fallback
//     MUST pin the rejecting `rate_limit_event` frame and an accounted-terminal MUST NOT carry one
//     (attest.ts `validatePayloadShape`), so neither can be edited or replayed into the other.
// ---------------------------------------------------------------------------------------------

/** The evidence the kernel derived for itself. Every field is a MEASUREMENT (an inode, a hash, a byte
 *  count, a pgid, a re-framed offset), never a verdict: the ledger decides what it is worth. */
export type KernelSettlementDraft = {
  /** The provider DIALECT the transcript was re-framed with. */
  providerKind: string;
  /** The ACTUAL scope the call ran inside — the strong `cgroup2` membership set it was launched into, or
   *  (test seam only) the legacy process group. The ledger re-probes THIS EXACT scope itself before it
   *  mints, and renders the reap proof from this identity, so neither can be supplied by a caller. */
  scope: ScopeRef;
  /** The durable transcript's identity as the KERNEL re-read it (the inode, not a name) … */
  transcriptDev: string;
  transcriptIno: string;
  /** … and its whole-file hash + exact byte count, recomputed from those same bytes. */
  transcriptSha256: string;
  transcriptBytes: number;
  /** The canonical terminal frame's raw wire bytes, located by REPLAYING the transcript through the
   *  production framer — `[offset, offset+bytes)` is exactly the range an auditor re-reads. */
  terminalSha256: string;
  terminalBytes: number;
  terminalOffset: number;
  /** The PROVIDER-REPORTED cost, in NANO-USD fixed point, as read off that terminal frame. */
  usdNano: string;
};

/**
 * The evidence for a `trusted-fallback` — the authority to bill a SECOND provider for one turn.
 *
 * It is the SAME derived evidence as an accounted terminal, plus the one frame that authorizes it: the
 * canonical Claude `rate_limit_event` whose `rate_limit_info.status` is `rejected`, re-located by
 * REPLAYING the durable transcript through the production framer and the production Claude state
 * machine. It carries NO money at all — a rejection's own cost is never provable (it exits nonzero), so
 * the primary keeps its full worst-case reservation. That is deliberate: "this turn was rejected" and
 * "this turn cost $X" are separate claims, and only the first one is being made here.
 */
export type KernelFallbackDraft = Omit<KernelSettlementDraft, "usdNano"> & {
  /** sha256 / length / offset of the rejecting `rate_limit_event` frame's raw wire bytes. An auditor
   *  re-reads exactly `[limitOffset, limitOffset+limitBytes)` of the pinned transcript to check it. */
  limitSha256: string;
  limitBytes: number;
  limitOffset: number;
};

/** The narrow capability the settlement kernel operates the ledger through. It exposes no key, no IO,
 *  and no way to lower a reservation except by presenting evidence the ledger re-checks. The LEDGER
 *  builds one of these per call from its `#private` internals and hands it to `settleCompletedCall`; it is
 *  never returned to any caller, so there is nothing to claim, capture, or replay. */
export type LedgerKernelAccess = {
  /** The directory every registrable transcript must live strictly inside. The kernel confines to it. */
  readonly transcriptRoot: string;
  /** The ledger's OWN scope prober — so the kernel and the ledger cannot disagree about liveness. It
   *  probes the scope's REAL boundary (a cgroup's existence, not just a process group's errno). */
  scopeAlive(ref: ScopeRef): boolean;
  /** Derive, MAC, and durably append a `provider-reported` settlement for `bind` in ONE transaction.
   *  Throws — appending NOTHING — when the group is still alive, the money is not exact fixed point, or
   *  the payload would not verify. The reservation-identity match is enforced by the transaction itself.
   *  This closure closes over the ledger's `#private` key; a forged `access` cannot reproduce it. */
  attestAndSettle(bind: CallBinding, draft: KernelSettlementDraft): void;
  /** Derive, MAC, and durably append a `trusted-fallback` settlement for `bind` in ONE transaction: the
   *  authority to bill a SECOND provider for this turn. It charges NOTHING — the primary's full worst
   *  case is retained — so this closure can only ever authorize a route, never lower a bill. Throws,
   *  appending nothing, on the same grounds as `attestAndSettle` (live group, bad binding, unverifiable
   *  payload). Like it, it closes over the ledger's `#private` key: a forged `access` cannot reproduce it. */
  attestFallbackAndSettle(bind: CallBinding, draft: KernelFallbackDraft): void;
  /** Settle UNCERTAIN — retain the full worst case, authorize nothing. The kernel's fail-closed path. */
  settleUncertain(bind: CallBinding): void;
  /** Read a call's durable settlement status (used only to disambiguate a refusal). */
  settlementOf(callId: string): SettlementStatus;
};

export class LedgerHandle {
  private poisonReason: string | undefined;
  private closed = false;

  /** The generation's attestation key. ECMAScript-`#private`: it is in no `Reflect.ownKeys`, no
   *  `getOwnPropertySymbols`, and unreachable by `(handle as any).key`. `AttestKey` additionally exposes no
   *  material. It is the ONLY thing that can make a settlement authoritative, so it is held where neither
   *  reflection nor a prototype walk can find it. */
  readonly #key: AttestKey;
  /** The evidence-verification capabilities, likewise `#private`. */
  readonly #caps: LedgerCaps;

  /** @internal — construct through `openLedger()`, which establishes/verifies the durable generation. */
  constructor(
    private readonly io: LedgerIO,
    private readonly dir: string,
    private readonly manifest: LedgerManifest,
    /** Pinned ancestor directory fds, "/" … parent. Held for the life of the handle. */
    private readonly pinned: number[],
    key: AttestKey,
    caps: LedgerCaps
  ) {
    this.#key = key;
    this.#caps = caps;
  }

  get epoch(): string {
    return this.manifest.epoch;
  }

  private get parentFd(): number {
    return this.pinned[this.pinned.length - 1];
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const fd of this.pinned) {
      try {
        this.io.close(fd);
      } catch {
        /* closing on teardown */
      }
    }
  }

  /** A poisoned handle answers NOTHING. Ordinary reads cannot launder unproven bytes into trust. */
  private assertUsable(): void {
    if (this.closed) throw new LedgerRecoveryRequired("the ledger handle is closed");
    if (this.poisonReason !== undefined) throw new LedgerRecoveryRequired(this.poisonReason);
  }

  // ---- identity ------------------------------------------------------------------------------

  /**
   * Re-walk the path component by component and prove every ancestor, the parent, and (through it) the
   * leaf are still the exact inodes this generation was published to. Callers MUST close the returned
   * fds. A mismatch is `recovery_required` — never a fresh ledger.
   */
  private rewalk(): { fds: number[]; parentFd: number } {
    const fds = walkComponents(this.io, this.dir);
    try {
      if (fds.length !== this.manifest.ancestors.length) {
        throw new LedgerRecoveryRequired(`the ledger path now has ${fds.length} components, not ${this.manifest.ancestors.length}`);
      }
      for (let i = 0; i < fds.length; i++) {
        const st = this.io.fstat(fds[i]);
        const want = this.manifest.ancestors[i];
        if (st.dev.toString() !== want.dev || st.ino.toString() !== want.ino) {
          throw new LedgerRecoveryRequired(
            `ledger ancestor #${i} is now inode ${st.dev}:${st.ino}, but this generation was published under ${want.dev}:${want.ino} (component replaced)`
          );
        }
      }
      const parent = this.io.fstat(fds[fds.length - 1]);
      if (parent.dev.toString() !== this.manifest.parentDev || parent.ino.toString() !== this.manifest.parentIno) {
        throw new LedgerRecoveryRequired(`the ledger parent directory was replaced (now ${parent.dev}:${parent.ino})`);
      }
      return { fds, parentFd: fds[fds.length - 1] };
    } catch (error) {
      for (const fd of fds) {
        try {
          this.io.close(fd);
        } catch {
          /* ignore */
        }
      }
      throw error;
    }
  }

  /** Open the leaf THROUGH a pinned parent fd, with NO `O_CREAT`, and prove it is the exact inode this
   *  generation published. A missing/replaced leaf is recovery_required, never a new empty ledger. */
  private openLeafVerified(parentFd: number, flags = O_LEAF_RW): number {
    let fd: number;
    try {
      fd = this.io.open(at(parentFd, this.manifest.leaf), flags);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new LedgerRecoveryRequired(`the ledger leaf ${this.manifest.leaf} is GONE (it is never re-created: that would reset the budget)`);
      }
      throw new LedgerRecoveryRequired(`the ledger leaf could not be opened (${(error as Error).message})`);
    }
    try {
      const st = this.io.fstat(fd);
      assertPrivateRegularFd(st, this.manifest.leaf);
      if (st.dev.toString() !== this.manifest.leafDev || st.ino.toString() !== this.manifest.leafIno) {
        throw new LedgerRecoveryRequired(
          `the ledger leaf is now inode ${st.dev}:${st.ino}, but this generation was published to ${this.manifest.leafDev}:${this.manifest.leafIno} (leaf replaced)`
        );
      }
      return fd;
    } catch (error) {
      this.io.close(fd);
      throw error;
    }
  }

  /** After taking the lock, the VISIBLE leaf must still resolve to the inode we locked. */
  private assertVisibleLeafIs(parentFd: number, fd: number): void {
    const mine = this.io.fstat(fd);
    const probe = this.io.open(at(parentFd, this.manifest.leaf), O_LEAF_R);
    try {
      const vis = this.io.fstat(probe);
      if (vis.dev !== mine.dev || vis.ino !== mine.ino) {
        throw new LedgerRecoveryRequired(`the visible ledger leaf is inode ${vis.dev}:${vis.ino}, but we hold ${mine.dev}:${mine.ino} (replaced under the lock)`);
      }
    } finally {
      this.io.close(probe);
    }
  }

  // ---- durable IO ----------------------------------------------------------------------------

  private readAll(fd: number, maxBytes: number): string {
    const chunks: Buffer[] = [];
    const buf = Buffer.allocUnsafe(1 << 16);
    let pos = 0;
    for (;;) {
      const n = this.io.read(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      if (pos + n > maxBytes) throw new Error(`ledger exceeds ${maxBytes} bytes (refusing an unbounded read)`);
      chunks.push(Buffer.from(buf.subarray(0, n)));
      pos += n;
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  private pwriteAll(fd: number, line: Buffer, offset: number): void {
    let off = 0;
    while (off < line.length) {
      const n = this.io.write(fd, line, off, line.length - off, offset + off);
      if (n <= 0) throw new Error("ledger write made no progress");
      off += n;
    }
  }

  private readExact(fd: number, buf: Buffer, offset: number): void {
    let got = 0;
    while (got < buf.length) {
      const n = this.io.read(fd, buf, got, buf.length - got, offset + got);
      if (n <= 0) throw new Error(`ledger read-back short at offset ${offset + got}`);
      got += n;
    }
  }

  /** Append one WAL record, fsynced, at the durable offset (dropping any torn tail first). */
  private walAppend(parentFd: number, rec: WalRecord): void {
    const fd = this.io.open(at(parentFd, this.manifest.wal), O_LEAF_RW);
    try {
      const st = this.io.fstat(fd);
      assertPrivateRegularFd(st, this.manifest.wal);
      const state = foldWal(this.readAll(fd, MAX_WAL_BYTES));
      if (st.size > state.durableBytes) this.io.ftruncate(fd, state.durableBytes);
      const line = Buffer.from(`${JSON.stringify(rec)}\n`, "utf8");
      this.pwriteAll(fd, line, state.durableBytes);
      this.io.fsyncFile(fd);
    } finally {
      this.io.close(fd);
    }
  }

  private readWal(parentFd: number): WalState {
    const fd = this.io.open(at(parentFd, this.manifest.wal), O_LEAF_R);
    try {
      assertPrivateRegularFd(this.io.fstat(fd), this.manifest.wal);
      return foldWal(this.readAll(fd, MAX_WAL_BYTES));
    } finally {
      this.io.close(fd);
    }
  }

  /**
   * Any failure after a possible mutation POISONS the ledger: the bytes on disk are unproven, and no
   * later ordinary read may infer durability from them (audit B4). We record the poison durably so a
   * FRESH process/handle refuses too — an in-memory flag would be laundered away by a restart.
   */
  private poison(reason: string): void {
    this.poisonReason = reason;
    try {
      this.walAppend(this.parentFd, { t: "poison", reason, ts: this.io.now() });
      this.io.fsyncDir(this.parentFd);
    } catch {
      // The durable marker could not be written (the same IO failure that poisoned us, most likely).
      // The in-memory poison stands and this transaction throws, so this process cannot proceed; a
      // FRESH handle then finds the dangling write-ahead INTENT — which was fsynced BEFORE the
      // mutation — and refuses on that instead. Durability is never inferred from the bytes.
    }
  }

  // ---- the transaction -----------------------------------------------------------------------

  private txn<T>(decide: (folded: Folded) => { record?: JournalData; result: T }): T {
    this.assertUsable();
    const walk = this.rewalk(); // 1. the generation must still be the one we published to
    let fd = -1;
    let mutating = false;
    try {
      fd = this.openLeafVerified(walk.parentFd); // 2. exact leaf identity, never O_CREAT
      this.io.lockExclusive(fd, LOCK_TIMEOUT_MS); // 3. kernel lock on THIS open file description
      this.assertVisibleLeafIs(walk.parentFd, fd); // 4. …and it is still the visible leaf
      // 5. Refuse to transact on a ledger whose last mutation was never proven durable.
      const wal = this.readWal(walk.parentFd);
      if (wal.poison) throw new LedgerRecoveryRequired(wal.poison);
      if (wal.pending) {
        throw new LedgerRecoveryRequired(
          `a write-ahead intent for seq ${wal.pending.seq} was never committed — the ledger may hold bytes that were never proven durable`
        );
      }
      // 6. Bounded, positioned fold + the decision, both under the lock on the inode we will append to.
      const folded = foldContent(this.readAll(fd, MAX_LEDGER_BYTES), this.manifest.epoch, this.manifest.genesis, this.manifest.runNonce, this.#key);
      const { record, result } = decide(folded);
      if (record === undefined) return result; // refused/no-op: no intent, no mutation
      const rec: JournalRecord = {
        seq: folded.seq,
        prev: folded.tip,
        hash: recordHash(folded.tip, folded.seq, record),
        data: record
      };
      const line = Buffer.from(`${JSON.stringify(rec)}\n`, "utf8");
      // 7. WRITE-AHEAD INTENT, fsynced BEFORE we touch the leaf. From here, a crash is detectable.
      this.walAppend(walk.parentFd, { t: "intent", seq: rec.seq, off: folded.durableBytes, h: rec.hash, ts: this.io.now() });
      mutating = true;
      // 8. Torn-tail recovery on the SAME inode, then append at the exact durable offset.
      if (this.io.fstat(fd).size > folded.durableBytes) this.io.ftruncate(fd, folded.durableBytes);
      this.pwriteAll(fd, line, folded.durableBytes);
      // 9. fsync the record, then prove size, bytes, and inode on the SAME fd.
      this.io.fsyncFile(fd);
      const post = this.io.fstat(fd);
      if (post.size !== folded.durableBytes + line.length) {
        throw new Error(`ledger post-write size ${post.size} != expected ${folded.durableBytes + line.length}`);
      }
      assertPrivateRegularFd(post, this.manifest.leaf);
      if (post.dev.toString() !== this.manifest.leafDev || post.ino.toString() !== this.manifest.leafIno) {
        throw new LedgerRecoveryRequired("the ledger leaf changed identity during the transaction");
      }
      const back = Buffer.allocUnsafe(line.length);
      this.readExact(fd, back, folded.durableBytes);
      if (!back.equals(line)) throw new Error("ledger read-back does not match the bytes we wrote");
      // 10. Publish the dirent durably.
      this.io.fsyncDir(walk.parentFd);
      // 11. FINAL component rewalk + reopen: prove the bytes are at the VISIBLE path AFTER the directory
      //     fsync. The audit swapped the leaf inside the dir-fsync window and got reserveCall === true
      //     with a visible spend of zero (B1).
      this.assertPublishedAfterFsync(folded.durableBytes, line);
      // 12. COMMIT the intent: only now is the record proven durable and visible.
      this.walAppend(walk.parentFd, { t: "commit", seq: rec.seq, h: rec.hash, ts: this.io.now() });
      mutating = false;
      return result;
    } catch (error) {
      if (mutating) this.poison(`transaction failed after a possible mutation: ${(error as Error).message}`);
      throw error;
    } finally {
      if (fd >= 0) {
        try {
          this.io.close(fd); // releasing the fd releases the kernel lock — nothing to unlink, ever
        } catch {
          /* ignore */
        }
      }
      for (const f of walk.fds) {
        try {
          this.io.close(f);
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** Re-walk from "/" and reopen the leaf by NAME through the freshly walked parent, then verify the
   *  exact inode and that OUR bytes are at OUR offset. This runs AFTER the directory fsync. */
  private assertPublishedAfterFsync(offset: number, line: Buffer): void {
    const walk = this.rewalk();
    try {
      const fd = this.openLeafVerified(walk.parentFd, O_LEAF_R);
      try {
        const st = this.io.fstat(fd);
        if (st.size < offset + line.length) {
          throw new LedgerRecoveryRequired(`the published ledger is ${st.size} bytes — our record at ${offset} is not there`);
        }
        const back = Buffer.allocUnsafe(line.length);
        this.readExact(fd, back, offset);
        if (!back.equals(line)) {
          throw new LedgerRecoveryRequired("the bytes at the visible ledger path are not the record we published");
        }
      } finally {
        this.io.close(fd);
      }
    } finally {
      for (const f of walk.fds) {
        try {
          this.io.close(f);
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** An authoritative READ: the same pinned handle, the same identity checks, and a SHARED kernel lock
   *  so it never sees a half-written transaction. */
  private read<T>(fn: (folded: Folded) => T): T {
    this.assertUsable();
    const walk = this.rewalk();
    let fd = -1;
    try {
      fd = this.openLeafVerified(walk.parentFd, O_LEAF_R);
      this.io.lockShared(fd, LOCK_TIMEOUT_MS);
      const wal = this.readWal(walk.parentFd);
      if (wal.poison) throw new LedgerRecoveryRequired(wal.poison);
      if (wal.pending) {
        throw new LedgerRecoveryRequired(
          `a write-ahead intent for seq ${wal.pending.seq} was never committed — refusing to read unproven bytes as durable accounting`
        );
      }
      return fn(foldContent(this.readAll(fd, MAX_LEDGER_BYTES), this.manifest.epoch, this.manifest.genesis, this.manifest.runNonce, this.#key));
    } finally {
      if (fd >= 0) {
        try {
          this.io.close(fd);
        } catch {
          /* ignore */
        }
      }
      for (const f of walk.fds) {
        try {
          this.io.close(f);
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** Fold per-call state, with attestation authenticity decided against THIS generation's key. */
  private foldCalls(f: Folded): Map<string, Reservation> {
    return foldReservations(f.datas, this.#key, this.manifest.epoch, this.manifest.runNonce);
  }

  // ---- public API ----------------------------------------------------------------------------

  /**
   * Atomically reserve the worst case for a call BEFORE launching it. Refused (false, nothing appended)
   * when it would push effective spend over the budget. Every amount is validated to exact fixed point
   * BEFORE any file is opened, so a NaN/Infinity/negative/over-precise value can never reach the
   * journal (audit B6).
   */
  reserve(bind: CallBinding, worstCaseUsd: number, budgetUsd: number): boolean {
    const err = validateBinding(bind);
    if (err) throw new MoneyError(`reserve received an incomplete call binding: ${err}`);
    const budget = usdToNano(budgetUsd, "budgetUsd");
    const worstCase = usdToNano(worstCaseUsd, "worstCase");
    const enforced = budget > 0n;
    return this.txn<boolean>((folded) => {
      const map = foldReservations(folded.datas, this.#key, this.manifest.epoch, this.manifest.runNonce);
      if (map.has(bind.callId)) throw new CorruptJournalError(`re-reserve of live call id ${bind.callId}`);
      for (const r of folded.datas) {
        if (r.type === "reserve" && r.bind.callNonce === bind.callNonce) {
          throw new CorruptJournalError(`replayed call nonce ${bind.callNonce.slice(0, 12)} (a call nonce is spendable exactly once)`);
        }
      }
      const ts = this.io.now();
      if (!enforced) {
        // Unlimited: a placeholder 0 that is explicitly NOT enforced, so a later paid settlement is
        // never mistaken for a worst-case overrun.
        return {
          record: { type: "reserve", callId: bind.callId, worstCaseNano: formatNano(0n), enforced: false, ts, epoch: this.manifest.epoch, bind },
          result: true
        };
      }
      if (spendOf(map) + worstCase > budget) return { result: false }; // refused → append NOTHING
      return {
        record: { type: "reserve", callId: bind.callId, worstCaseNano: formatNano(worstCase), enforced: true, ts, epoch: this.manifest.epoch, bind },
        result: true
      };
    });
  }

  /**
   * Settle a reserved call as UNCERTAIN: no attestation, no money, no authority.
   *
   * This is the ONLY settlement primitive the ledger exposes, and it is SAFE to hand to any caller — that
   * is the whole design. An uncertain settlement durably RETAINS the full worst-case reservation and
   * authorizes no fallback, so reaching it can only ever cost the caller money, never save it. Every path
   * — a clean turn, a spawn failure, a timeout, a framing fatal, a throw — lands here, and none of them
   * can lower the worst case or buy the right to bill a second provider.
   */
  settleUncertain(bind: CallBinding): void {
    const err = validateBinding(bind);
    if (err) throw new MoneyError(`settle received an incomplete call binding: ${err}`);
    this.appendSettlement(bind, undefined, 0n, false);
  }

  /** The one durable settlement append. `attest` is non-`undefined` on exactly ONE path: `#attestAndSettle`,
   *  a `#private` method reached only from the `#kernelAccess` capability the handle builds for its own
   *  `settleCompleted`, and only after the ledger itself proved the scope empty and the money exact. Every
   *  other caller can only reach `settleUncertain`. */
  private appendSettlement(bind: CallBinding, attest: DurableAttestation | undefined, usdNano: bigint, reported: boolean): void {
    this.txn<void>((folded) => {
      const map = foldReservations(folded.datas, this.#key, this.manifest.epoch, this.manifest.runNonce);
      const existing = map.get(bind.callId);
      if (!existing) throw new CorruptJournalError(`orphan settle for unknown call id ${bind.callId}`);
      if (existing.settled) throw new CorruptJournalError(`duplicate settle for call id ${bind.callId}`);
      const mismatch = bindingMismatch(existing.bind, bind);
      if (mismatch) throw new CorruptJournalError(`settlement identity mismatch for call id ${bind.callId}: ${mismatch}`);
      return {
        record: {
          type: "settle",
          callId: bind.callId,
          usdNano: formatNano(usdNano),
          reported,
          ts: this.io.now(),
          epoch: this.manifest.epoch,
          bind,
          attest
        },
        result: undefined
      };
    });
  }

  /**
   * Settle ONE completed call through the settlement KERNEL. This is the orchestrator's entry point, and
   * the ONLY way a genuine, whole-stream provider SUCCESS becomes MAC-authenticated, provider-reported
   * spend. The kernel re-reads the durable transcript, re-frames it, re-checks the stdin binding, and
   * re-probes the scope; only if every proof holds does it present derived evidence to the mint the
   * LEDGER built here. Everything else settles UNCERTAIN at the full worst case. Either way exactly one
   * durable settlement is appended, so a reservation is never stranded.
   *
   * The `#kernelAccess()` capability is constructed here, from this handle's `#private` internals, consumed
   * synchronously, and NEVER returned to the caller — so there is no bridge, no symbol, and no key for a
   * caller to reach. The raw mint (`#attestAndSettle`) is a `#private` method: reflection, prototype walks,
   * and `getOwnPropertySymbols` cannot find it, and no exported function hands it out.
   */
  settleCompleted(args: CompletedCallSettlement): SettlementOutcome {
    return settleCompletedCall(this.#kernelAccess(), args);
  }

  /** Build the kernel's narrow capability from this handle's `#private` state. Created per call, consumed
   *  by `settleCompletedCall`, and never escaping to a caller. */
  #kernelAccess(): LedgerKernelAccess {
    return {
      transcriptRoot: this.#caps.transcriptRoot,
      scopeAlive: (ref: ScopeRef) => this.#caps.scopeAlive(ref),
      attestAndSettle: (bind, draft) => this.#attestAndSettle(bind, draft),
      attestFallbackAndSettle: (bind, draft) => this.#attestFallback(bind, draft),
      settleUncertain: (bind) => this.settleUncertain(bind),
      settlementOf: (callId) => this.settlementOf(callId)
    };
  }

  /**
   * The checks EVERY mint re-establishes for itself, before any payload exists.
   *
   * The scope probe is the load-bearing one: the LEDGER proves the reap. Not the transport, not the
   * kernel — this probe, of this scope, now. A caller's "proof" string is not evidence, and a stale probe
   * is not a probe. Since wave-10 the probe addresses the scope's REAL boundary: for a `cgroup2` scope it
   * asks whether the kernel still has the cgroup (removal is only permitted when it and every descendant
   * cgroup are empty), so a provider that `setsid`'d a daemon out of its process group can no longer look
   * "reaped" to an ESRCH probe. Returns the exact backend/id/proof triple the payload must carry, so no
   * mint can compose a proof for a scope it did not just observe empty.
   */
  #assertMintable(bind: CallBinding, scope: ScopeRef, what: string): { scopeBackend: ScopeRef["backend"]; scopeId: string; scopeReapProof: string } {
    const err = validateBinding(bind);
    if (err) throw new MoneyError(`the settlement kernel presented an incomplete call binding: ${err}`);
    if (bind.runNonce !== this.manifest.runNonce) {
      throw new LedgerRecoveryRequired(`the settlement kernel presented a binding for run ${bind.runNonce.slice(0, 12)}…, not this one`);
    }
    if (!scope || (scope.backend !== "pgid" && scope.backend !== "cgroup2")) {
      throw new MoneyError(`the settlement kernel presented an unknown scope backend ${JSON.stringify((scope as { backend?: unknown })?.backend ?? null)}`);
    }
    if (!Number.isInteger(scope.pid) || scope.pid <= 0) {
      throw new MoneyError(`the settlement kernel presented an invalid scope leader ${String(scope.pid)}`);
    }
    // NO DOWNGRADES. A `pgid` scope proves only that a process GROUP stopped answering — which a provider
    // makes trivially true by `setsid`ing a daemon. If this host could have contained the provider in a
    // cgroup, a settlement that claims the weaker scope is refused outright, rather than folded into the
    // journal as though it said as much as a contained one.
    if (scope.backend === "pgid" && this.#caps.strongScopeAvailable) {
      throw new MoneyError(
        `a process-group scope can never be settled as ${what} on a host with a strong process scope — ` +
          "the provider must run inside a cgroup it cannot escape"
      );
    }
    if (this.#caps.scopeAlive(scope)) {
      throw new MoneyError(`the owned scope ${scopeIdOf(scope)} is still ALIVE — a live scope can never be settled as ${what}`);
    }
    return { scopeBackend: scope.backend, scopeId: scopeIdOf(scope), scopeReapProof: reapProofOf(scope) };
  }

  /** MAC a derived payload and durably append its settlement — the ONE place a tag is produced. Refuses
   *  to write an attestation this very ledger would not fold back into trust: a record that cannot be
   *  re-verified after a restart is worse than no record, because it fails the whole journal closed. */
  #sealAndSettle(bind: CallBinding, payload: AttestPayload, usdNano: bigint, reported: boolean): void {
    const attest: DurableAttestation = { payload, tag: tagPayload(this.#key, payload) };
    const selfErr = verifyAttestation(this.#key, attest);
    if (selfErr) throw new MoneyError(`the ledger refused to issue an unverifiable attestation: ${selfErr}`);
    this.appendSettlement(bind, attest, usdNano, reported);
  }

  /**
   * Turn the kernel's DERIVED evidence into a MAC-authenticated, provider-reported settlement.
   *
   * The ledger re-establishes for itself everything it is about to authorize:
   *   - the scope is EMPTY — its own `groupAlive` probe, at attestation time, of the exact pgid that
   *     was spawned (a caller's "proof" string is not evidence, and a stale probe is not a probe);
   *   - the money is EXACT fixed point (`parseNano` rejects NaN/Infinity/negative/over-precise);
   *   - the identity is the LEDGER's — its own epoch, its own run nonce, its own timestamp;
   *   - the tag verifies against its own key before the record is allowed anywhere near the journal.
   * The reservation match (same call id, same call nonce, same reservation id, same route epoch,
   * provider, model, attempt, intent and stdin hashes) is enforced inside `appendSettlement`'s
   * transaction, against the durable reserve record — not against anything the kernel said.
   *
   * Any failure throws BEFORE a record is produced, so nothing is appended and the caller settles the
   * call UNCERTAIN at its full worst case.
   */
  #attestAndSettle(bind: CallBinding, draft: KernelSettlementDraft): void {
    const scope = this.#assertMintable(bind, draft.scope, "an accounted terminal");
    const usdNano = parseNano(draft.usdNano, "provider-reported usdNano"); // exact fixed point, or throw
    if (usdNano < 0n) throw new MoneyError(`a provider-reported cost may not be negative (${draft.usdNano})`);
    const payload: AttestPayload = {
      schema: "loop.ledger.attest.v2",
      // An accounted terminal authorizes MONEY and nothing else. It pins no `rate_limit_event` frame, so
      // — by `validatePayloadShape` — it can never be read as authority to bill a second provider, no
      // matter how it is folded. A success can never buy a fallback.
      kind: "accounted-terminal",
      ledgerEpoch: this.manifest.epoch,
      runNonce: this.manifest.runNonce,
      callId: bind.callId,
      callNonce: bind.callNonce,
      reservationId: bind.reservationId,
      routeEpoch: bind.routeEpoch,
      provider: bind.provider,
      model: bind.model,
      providerKind: draft.providerKind,
      attempt: bind.attempt,
      scopeBackend: scope.scopeBackend,
      scopeId: scope.scopeId,
      scopeReapProof: scope.scopeReapProof, // generated HERE, from the ledger's own probe
      transcriptDev: draft.transcriptDev,
      transcriptIno: draft.transcriptIno,
      transcriptSha256: draft.transcriptSha256,
      transcriptBytes: draft.transcriptBytes,
      terminalSha256: draft.terminalSha256,
      terminalBytes: draft.terminalBytes,
      terminalOffset: draft.terminalOffset,
      usdNano: formatNano(usdNano),
      costProvenance: "provider-reported",
      ts: this.io.now()
    };
    this.#sealAndSettle(bind, payload, usdNano, true);
  }

  /**
   * Turn the kernel's DERIVED rejection evidence into a MAC-authenticated `trusted-fallback` settlement:
   * the authority to bill a SECOND provider for this one turn (wave-9, slice 2).
   *
   * This is the narrowest mint in the system, and the only one whose product is a ROUTE rather than a
   * price. It applies exactly the same identity/scope discipline as `#attestAndSettle` — the ledger's own
   * run nonce, its own live probe of the exact pgid, its own epoch/timestamp, its own key — and then
   * pins the ONE frame that authorizes the fallback: the canonical `rate_limit_event` the kernel
   * re-located by REPLAYING the durable transcript. `validatePayloadShape` requires that frame on a
   * `trusted-fallback` payload and forbids it on an `accounted-terminal` one, so the two authorities can
   * never be confused for each other on disk, and neither can be edited into the other without breaking
   * the MAC.
   *
   * It CHARGES NOTHING. `usdNano` is "0" with `costProvenance: "unknown"` and `reported: false`, so the
   * fold retains the primary's full worst-case reservation (`costIsTrusted` is false without
   * `provider-reported` provenance). A rejection exits nonzero and its true spend is unprovable; buying
   * the right to run GPT must never also buy a discount on the turn that failed.
   */
  #attestFallback(bind: CallBinding, draft: KernelFallbackDraft): void {
    const scope = this.#assertMintable(bind, draft.scope, "a trusted fallback");
    const payload: AttestPayload = {
      schema: "loop.ledger.attest.v2",
      kind: "trusted-fallback",
      ledgerEpoch: this.manifest.epoch,
      runNonce: this.manifest.runNonce,
      callId: bind.callId,
      callNonce: bind.callNonce,
      reservationId: bind.reservationId,
      // The route generation IN FORCE when this call was reserved. The cooldown bumps it immediately
      // after, so this authority is spent against the epoch it was issued under and a replay onto a
      // later-epoch reservation fails the binding check.
      routeEpoch: bind.routeEpoch,
      provider: bind.provider,
      model: bind.model,
      providerKind: draft.providerKind,
      attempt: bind.attempt,
      scopeBackend: scope.scopeBackend,
      scopeId: scope.scopeId,
      scopeReapProof: scope.scopeReapProof,
      transcriptDev: draft.transcriptDev,
      transcriptIno: draft.transcriptIno,
      transcriptSha256: draft.transcriptSha256,
      transcriptBytes: draft.transcriptBytes,
      terminalSha256: draft.terminalSha256,
      terminalBytes: draft.terminalBytes,
      terminalOffset: draft.terminalOffset,
      limitSha256: draft.limitSha256,
      limitBytes: draft.limitBytes,
      limitOffset: draft.limitOffset,
      // No money is authorized. The worst case stands.
      usdNano: formatNano(0n),
      costProvenance: "unknown",
      ts: this.io.now()
    };
    this.#sealAndSettle(bind, payload, 0n, false);
  }

  /** Effective spend in NANO-USD: trusted actuals where proven, worst case everywhere else. */
  effectiveSpendNano(): bigint {
    return this.read((f) => spendOf(this.foldCalls(f)));
  }

  /** Effective spend in USD — display and legacy numeric callers only. */
  effectiveSpend(): number {
    return nanoToUsd(this.effectiveSpendNano());
  }

  /** The budget gate, decided in EXACT fixed point. Ten $0.01 settlements under a $0.10 budget reach
   *  it exactly — they do not leave `0.09999999999999999` of room for an eleventh call (audit B6). */
  budgetReached(budgetUsd: number): boolean {
    const budget = usdToNano(budgetUsd, "budgetUsd");
    if (budget <= 0n) return false;
    return this.effectiveSpendNano() >= budget;
  }

  /** The first call whose PROVEN actual exceeded its fsynced worst case: the reservation failed to bound
   *  real spend, so the ledger can no longer be trusted and the run must stop. */
  budgetViolation(): string | undefined {
    return this.read((f) => {
      for (const [callId, r] of this.foldCalls(f)) if (r.over) return callId;
      return undefined;
    });
  }

  settlementOf(callId: string): SettlementStatus {
    return this.read((f) => {
      const r = this.foldCalls(f).get(callId);
      if (!r || !r.settled) return { settled: false, costTrusted: false, fallbackAuthorized: false };
      return { settled: true, costTrusted: r.trustedUsd !== null, fallbackAuthorized: r.fallbackAuthorized };
    });
  }

  /** Whether a reservation for `callId` is already in the durable journal. A resumed legacy migration
   *  MUST ask this before re-reserving its carry-forward: `reserve()` treats a second reserve of a live
   *  call id as corruption (rightly), so an idempotent retry has to skip an already-durable record
   *  rather than append a duplicate — otherwise a crash between the carry and its completion marker
   *  would make the migration unfinishable. */
  hasReservation(callId: string): boolean {
    return this.read((f) => this.foldCalls(f).has(callId));
  }

  /** Explicit, exclusive reconciliation: the ONLY way a poisoned/unproven ledger returns to service. It
   *  writes and fsyncs a SEPARATE recovery receipt, revalidates the exact generation, and only then
   *  clears the dangling intent/poison. Never called automatically. */
  reconcile(operatorNote: string): { receipt: string; recovered: string } {
    if (this.closed) throw new LedgerRecoveryRequired("the ledger handle is closed");
    const walk = this.rewalk();
    let fd = -1;
    try {
      fd = this.openLeafVerified(walk.parentFd);
      this.io.lockExclusive(fd, LOCK_TIMEOUT_MS);
      const before = this.readWal(walk.parentFd);
      const state = foldContent(this.readAll(fd, MAX_LEDGER_BYTES), this.manifest.epoch, this.manifest.genesis, this.manifest.runNonce, this.#key);
      const receipt = {
        schema: RECOVERY_SCHEMA,
        ts: this.io.now(),
        epoch: this.manifest.epoch,
        runNonce: this.manifest.runNonce,
        note: operatorNote,
        clearedIntent: before.pending ?? null,
        clearedPoison: before.poison ?? null,
        // What the ledger ACTUALLY holds, as reconciled: the operator is accepting this as the truth.
        durableBytes: state.durableBytes,
        records: state.seq,
        tip: state.tip
      };
      const body = Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8");
      const hash = createHash("sha256").update(body).digest("hex");
      // The recovery receipt is its own durable artifact, published atomically before anything is cleared.
      const tmp = `${this.manifest.leaf}.recovery.${this.io.randomHex(8)}`;
      const rfd = this.io.open(at(walk.parentFd, tmp), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      try {
        this.pwriteAll(rfd, body, 0);
        this.io.fsyncFile(rfd);
      } finally {
        this.io.close(rfd);
      }
      this.io.link(at(walk.parentFd, tmp), at(walk.parentFd, `${this.manifest.leaf}.recovery.${hash.slice(0, 16)}.json`));
      this.io.unlink(at(walk.parentFd, tmp));
      this.io.fsyncDir(walk.parentFd);
      // Only now may the WAL be cleared — the receipt proving WHAT was accepted is already durable.
      this.walAppend(walk.parentFd, { t: "recovered", receipt: hash, ts: this.io.now() });
      this.io.fsyncDir(walk.parentFd);
      this.poisonReason = undefined;
      return { receipt: hash, recovered: `${this.manifest.leaf}.recovery.${hash.slice(0, 16)}.json` };
    } finally {
      if (fd >= 0) {
        try {
          this.io.close(fd);
        } catch {
          /* ignore */
        }
      }
      for (const f of walk.fds) {
        try {
          this.io.close(f);
        } catch {
          /* ignore */
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Opening / initialization
// ---------------------------------------------------------------------------------------------

function assertPrivateRegularFd(st: FileId, what: string): void {
  if (!st.isFile) throw new LedgerRecoveryRequired(`${what} is not a regular file (refusing)`);
  if (st.nlink !== 1) throw new LedgerRecoveryRequired(`${what} has ${st.nlink} hard links (refusing an aliased victim path)`);
  if ((st.mode & 0o077) !== 0) throw new LedgerRecoveryRequired(`${what} is not private (mode ${(st.mode & 0o777).toString(8)})`);
  if (typeof process.getuid === "function") {
    const uid = process.getuid();
    if (uid !== undefined && st.uid !== uid) throw new LedgerRecoveryRequired(`${what} is not owned by this user`);
  }
}

/**
 * PUBLISH DEBRIS: the one second-name this protocol can legitimately leave behind.
 *
 * Every write-once artifact (the manifest, the attestation key) is published by-link — write a private
 * temp, fsync it whole, `link()` it into place (EEXIST rather than overwrite, so concurrent initializers
 * cannot each publish a different one), then unlink the temp. A crash in the microsecond between the
 * `link()` and the `unlink()` leaves the temp as a SECOND NAME for the very inode we just published.
 *
 * That is fatal without this: `assertPrivateRegularFd` refuses any `nlink !== 1` file as a possible aliased
 * victim path — rightly, since it cannot tell our debris from an attacker's alias — so the artifact, and
 * with it the whole board, becomes permanently unopenable. A generation whose key is unreadable can never
 * verify a settlement again, and its carried balance is unreachable.
 *
 * So identify the debris EXACTLY, and remove only that:
 *   - it must match the temp pattern only our own publish path creates (`<name>.<16 hex>`), and
 *   - it must be a hard link to THIS inode — the file we are holding open right now.
 *
 * An attacker's alias is under some other name, so it is never touched and still trips `nlink !== 1`. A
 * concurrent initializer's in-flight temp is a DIFFERENT inode (it has not been linked into place yet), so
 * it is never touched either, and the race protocol is undisturbed.
 */
function sweepPublishDebris(io: LedgerIO, parentFd: number, name: string, target: FileId): void {
  const temp = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.[0-9a-f]{16}$`);
  let entries: string[];
  try {
    entries = io.readdir(at(parentFd, "."));
  } catch {
    return; // cannot enumerate — fall through to the nlink check, which fails closed
  }
  for (const entry of entries) {
    if (!temp.test(entry)) continue;
    let fd: number;
    try {
      fd = io.open(at(parentFd, entry), O_LEAF_R);
    } catch {
      continue;
    }
    try {
      const st = io.fstat(fd);
      // The INODE is the proof. A name that merely looks like our temp, but is a different file, is left
      // exactly where it is.
      if (st.dev !== target.dev || st.ino !== target.ino) continue;
    } finally {
      io.close(fd);
    }
    try {
      io.unlink(at(parentFd, entry));
    } catch {
      /* best effort: the nlink check below decides */
    }
  }
}

/** Read a published write-once artifact's identity, healing our own crash debris first. Returns the stat
 *  the privacy check should be applied to. */
function statPublished(io: LedgerIO, parentFd: number, fd: number, name: string): FileId {
  const st = io.fstat(fd);
  if (st.nlink === 1) return st;
  sweepPublishDebris(io, parentFd, name, st);
  return io.fstat(fd); // re-stat: if that was our debris, nlink is 1 again
}

function assertSafeDirFd(io: LedgerIO, fd: number, what: string): void {
  const st = io.fstat(fd);
  if (!st.isDir) throw new LedgerRecoveryRequired(`${what} is not a directory`);
  if ((st.mode & 0o022) !== 0) throw new LedgerRecoveryRequired(`${what} is group/other writable (mode ${(st.mode & 0o777).toString(8)}; another account could swap the leaf)`);
  if (typeof process.getuid === "function") {
    const uid = process.getuid();
    if (uid !== undefined && st.uid !== uid) throw new LedgerRecoveryRequired(`${what} is not owned by this user`);
  }
}

/**
 * Walk the ledger path COMPONENT BY COMPONENT from "/", opening each with `O_DIRECTORY|O_NOFOLLOW`
 * through the previous component's descriptor. A symlinked ancestor cannot be traversed (ELOOP) and a
 * rename racing the walk cannot redirect it — unlike the `lstat` path walk it replaces, which checked
 * names and then re-resolved them (audit B7: TOCTOU).
 */
function walkComponents(io: LedgerIO, dir: string): number[] {
  const parts = resolve(dir).split("/").filter(Boolean);
  const fds: number[] = [];
  try {
    fds.push(io.open("/", O_DIR));
    for (const part of parts) {
      const parent = fds[fds.length - 1];
      const fd = io.open(at(parent, part), O_DIR);
      fds.push(fd);
    }
    assertSafeDirFd(io, fds[fds.length - 1], dir);
    return fds;
  } catch (error) {
    for (const fd of fds) {
      try {
        io.close(fd);
      } catch {
        /* ignore */
      }
    }
    if (error instanceof LedgerRecoveryRequired) throw error;
    throw new LedgerRecoveryRequired(`the ledger directory ${dir} could not be pinned component-by-component (${(error as Error).message})`);
  }
}

function idsOf(io: LedgerIO, fds: number[]): { dev: string; ino: string }[] {
  return fds.map((fd) => {
    const st = io.fstat(fd);
    return { dev: st.dev.toString(), ino: st.ino.toString() };
  });
}

const LEAF = "reservations.jsonl";
const WAL = "reservations.wal";
const MANIFEST = "reservations.manifest.json";
/** The generation's ATTESTATION KEY: 32 random bytes, 0600, beside the journal it authenticates.
 *
 *  It is never exported, never returned by any method, and never written into a record or a log line —
 *  `AttestKey` deliberately has no accessor, so the material cannot leak even through a stray
 *  `JSON.stringify` of a handle. Its trust domain is EXACTLY the journal's: an attacker who can read this
 *  file as our uid inside the 0700 board directory can already rewrite the journal's plain hash chain
 *  outright, so the key is never the weakest link. What it buys is that FOLD-TIME trust survives a
 *  restart without re-reading transcripts, and that a hand-edited settlement record fails closed. */
const ATTEST_KEY = "reservations.attest.key";

/**
 * Read the generation's attestation key, creating it if this is a fresh generation.
 *
 * Creation is publish-by-link (write a private temp, fsync it whole, `link()` it into place), so two
 * concurrent initializers cannot each install a different key: exactly one wins, and the loser adopts the
 * winner's — the same rule the manifest uses. A half-written key is never visible.
 */
function ensureAttestKey(io: LedgerIO, parentFd: number, create: boolean): AttestKey {
  const read = (): AttestKey | undefined => {
    let fd: number;
    try {
      fd = io.open(at(parentFd, ATTEST_KEY), O_LEAF_R);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new LedgerRecoveryRequired(`the ledger attestation key could not be opened (${(error as Error).message})`);
    }
    try {
      const st = statPublished(io, parentFd, fd, ATTEST_KEY);
      assertPrivateRegularFd(st, ATTEST_KEY);
      if (st.size !== ATTEST_KEY_BYTES) {
        throw new LedgerRecoveryRequired(`the ledger attestation key is ${st.size} bytes, not ${ATTEST_KEY_BYTES} (truncated or replaced)`);
      }
      const buf = Buffer.allocUnsafe(ATTEST_KEY_BYTES);
      let got = 0;
      while (got < buf.length) {
        const n = io.read(fd, buf, got, buf.length - got, got);
        if (n <= 0) throw new LedgerRecoveryRequired("the ledger attestation key could not be read whole");
        got += n;
      }
      return attestKeyFromBytes(buf);
    } finally {
      io.close(fd);
    }
  };

  const existing = read();
  if (existing !== undefined) return existing;
  if (!create) {
    // A generation whose manifest exists but whose key is GONE cannot verify its own settlements. That is
    // recovery_required — never a fresh key, which would silently invalidate every attestation already in
    // the journal (turning proven spend into "untrusted", and worse, letting a tamperer re-tag records).
    throw new LedgerRecoveryRequired(
      `the ledger attestation key ${ATTEST_KEY} is GONE but its generation remains — every settlement it authenticated can no longer be verified`
    );
  }
  const body = Buffer.from(io.randomHex(ATTEST_KEY_BYTES), "hex");
  const tmp = `${ATTEST_KEY}.${io.randomHex(8)}`;
  const fd = io.open(at(parentFd, tmp), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    let off = 0;
    while (off < body.length) {
      const n = io.write(fd, body, off, body.length - off, off);
      if (n <= 0) throw new Error("attestation key write made no progress");
      off += n;
    }
    io.fsyncFile(fd);
  } finally {
    io.close(fd);
  }
  try {
    io.link(at(parentFd, tmp), at(parentFd, ATTEST_KEY)); // atomic publish; EEXIST ⇒ another initializer won
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    try {
      io.unlink(at(parentFd, tmp));
    } catch {
      /* best effort */
    }
  }
  io.fsyncDir(parentFd);
  const published = read();
  if (published === undefined) throw new LedgerRecoveryRequired("the ledger attestation key vanished immediately after publication");
  return published;
}

function openLedgerInternal(opts: {
  dir: string;
  runNonce: string;
  io?: LedgerIO;
  duringMigration?: boolean;
  transcriptRoot?: string;
  groupAlive?: (pid: number) => boolean;
  scopeAlive?: (ref: ScopeRef) => boolean;
  strongScopeAvailable?: boolean;
}): LedgerHandle {
  const io = opts.io ?? realLedgerIO();
  const dir = resolve(opts.dir);
  if (!procFdAvailable()) {
    throw new LedgerRecoveryRequired(
      `the ledger requires a pinned-directory anchor (/proc/self/fd) to prove which inode a record was published to; ` +
        `this platform (${process.platform}) cannot, so accounting fails closed rather than weakening the guarantee`
    );
  }
  if (typeof opts.runNonce !== "string" || opts.runNonce.length < 32 || !HEX.test(opts.runNonce)) {
    throw new LedgerRecoveryRequired("the ledger requires the run's immutable 256-bit nonce (it is established with the run, before any money moves)");
  }
  const fds = walkComponents(io, dir);
  const parentFd = fds[fds.length - 1];
  try {
    // The kernel lock is the ledger's mutual exclusion. Prove its semantics on THIS host before we
    // trust it with money — survival past the helper's exit, conflict, and release-on-close. The probe
    // needs a REAL path: its conflict leg runs in a separate process, which cannot resolve one of our
    // `/proc/self/fd/<dirfd>/…` descriptor paths. The directory is already pinned and verified above,
    // and the probe file is disposable — it carries no accounting.
    io.probeLock(resolve(dir, `.flock-probe.${io.randomHex(8)}`));

    // A legacy migration that STARTED but never COMPLETED makes this directory unusable until it is
    // finished. This single check is what makes the migration crash-safe: between publishing its intent
    // and publishing its completion receipt, the leaf is archived and unlinked — and an empty directory
    // is exactly what `initLedger` treats as "a fresh board", so without this guard a crash mid-migration
    // would silently mint a brand-new generation with ZERO spend and the entire carried-forward balance
    // would evaporate. Every crash window now fails closed instead, and `migrateLegacyV1` resumes.
    if (opts.duringMigration !== true) {
      const pending = pendingMigrationReason(io, parentFd);
      if (pending !== undefined) throw new LedgerRecoveryRequired(pending);
    }

    let manifest = readManifest(io, parentFd);
    let key: AttestKey;
    if (manifest === undefined) {
      // ORDER IS LOAD-BEARING: the KEY is published BEFORE the manifest.
      //
      // The manifest is what declares a generation to EXIST, and a generation that exists without its key
      // can never verify its own settlements — `ensureAttestKey(create: false)` rightly refuses to mint a
      // replacement, so the board becomes permanently unopenable and its carried spend is unreachable. That
      // is the same shape of bug as the migration's zero-spend window: a durable artifact published before
      // the thing it depends on. Publishing the key first makes `manifest exists ⇒ key exists` an invariant
      // no crash can break.
      //
      // The reverse orphan is harmless: a key with no manifest is 32 inert bytes that the next initializer
      // simply ADOPTS (`ensureAttestKey` reads before it creates), so a crash in THIS window costs nothing.
      // Concurrent initializers converge the same way they do on the manifest — publish-by-link, one winner,
      // the losers read back what actually landed.
      key = ensureAttestKey(io, parentFd, true);
      manifest = initLedger(io, parentFd, fds, opts.runNonce, dir);
    } else {
      verifyManifest(io, parentFd, fds, manifest, opts.runNonce);
      // An EXISTING generation must still have the key that authenticated its settlements. A missing key
      // is recovery_required: minting a fresh one would silently strip authority from every attestation
      // already folded (proven spend would become "untrusted", and a tamperer could re-tag records).
      key = ensureAttestKey(io, parentFd, false);
    }
    const groupAlive = opts.groupAlive ?? isProcessGroupAlive;
    const caps: LedgerCaps = {
      groupAlive,
      // The scope prober the mints actually gate on. It answers for the REAL boundary of whichever backend
      // the call ran under: a cgroup scope is alive while the kernel still has the cgroup (rmdir succeeds
      // only on an empty one) OR while the leader's process group answers. `groupAlive` remains injectable
      // so a test can drive the process-group half deterministically without spawning anything.
      scopeAlive: opts.scopeAlive ?? ((ref) => scopeAliveOf(ref, undefined, groupAlive)),
      // Detected once, from the same capability probe the transport launches through — so "the run could
      // have contained this provider" and "the mint demands containment" can never disagree.
      strongScopeAvailable: opts.strongScopeAvailable ?? detectScopeCapability().strong,
      // Evidence must live inside the run's own private tree. Defaulting to the ledger directory is the
      // strictest choice; the orchestrator widens it to the run directory, whose `transcripts/` subtree is
      // where the transport writes.
      transcriptRoot: resolve(opts.transcriptRoot ?? dir)
    };
    return new LedgerHandle(io, dir, manifest, fds, key, caps);
  } catch (error) {
    for (const fd of fds) {
      try {
        io.close(fd);
      } catch {
        /* ignore */
      }
    }
    throw error;
  }
}

function readManifest(io: LedgerIO, parentFd: number): LedgerManifest | undefined {
  let fd: number;
  try {
    fd = io.open(at(parentFd, MANIFEST), O_LEAF_R);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new LedgerRecoveryRequired(`the ledger manifest could not be read (${(error as Error).message})`);
  }
  try {
    const st = statPublished(io, parentFd, fd, MANIFEST);
    assertPrivateRegularFd(st, MANIFEST);
    const buf = Buffer.allocUnsafe(st.size);
    let got = 0;
    while (got < buf.length) {
      const n = io.read(fd, buf, got, buf.length - got, got);
      if (n <= 0) break;
      got += n;
    }
    const text = buf.subarray(0, got).toString("utf8");
    let m: LedgerManifest;
    try {
      m = JSON.parse(text) as LedgerManifest;
    } catch {
      throw new LedgerRecoveryRequired("the ledger manifest is unreadable (a torn or tampered generation record is never adopted)");
    }
    if (m?.schema !== LEDGER_SCHEMA) throw new LedgerRecoveryRequired(`the ledger manifest schema is ${String(m?.schema)}, not ${LEDGER_SCHEMA}`);
    return m;
  } finally {
    io.close(fd);
  }
}

/** Publish a NEW generation. This is the ONLY place the leaf/WAL are created (`O_CREAT`). */
function initLedger(io: LedgerIO, parentFd: number, fds: number[], runNonce: string, dir: string): LedgerManifest {
  // The leaf may pre-exist ONLY if it is empty (a fresh board). A non-empty leaf with no manifest is
  // unowned accounting: adopting it would silently take on someone else's spend, and re-creating it
  // would silently reset a budget. Both are refused.
  const leafFd = io.open(at(parentFd, LEAF), O_LEAF_RW | fsConstants.O_CREAT, 0o600);
  let leafId: FileId;
  try {
    leafId = io.fstat(leafFd);
    assertPrivateRegularFd(leafId, LEAF);
    if (leafId.size > 0) {
      throw new LedgerRecoveryRequired(
        `${dir}/${LEAF} already holds ${leafId.size} bytes but has no ledger manifest — refusing to adopt or reset unowned accounting (use the explicit legacy migration)`
      );
    }
    io.fsyncFile(leafFd);
  } finally {
    io.close(leafFd);
  }
  const walFd = io.open(at(parentFd, WAL), O_LEAF_RW | fsConstants.O_CREAT, 0o600);
  try {
    assertPrivateRegularFd(io.fstat(walFd), WAL);
    io.fsyncFile(walFd);
  } finally {
    io.close(walFd);
  }
  io.fsyncDir(parentFd);

  const parentId = io.fstat(parentFd);
  const manifest: LedgerManifest = {
    schema: LEDGER_SCHEMA,
    epoch: io.randomHex(32),
    genesis: io.randomHex(32),
    runNonce,
    leaf: LEAF,
    wal: WAL,
    parentDev: parentId.dev.toString(),
    parentIno: parentId.ino.toString(),
    leafDev: leafId.dev.toString(),
    leafIno: leafId.ino.toString(),
    ancestors: idsOf(io, fds),
    createdTs: io.now()
  };
  const body = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  // Write to a private temp, fsync it COMPLETE, then publish with `link()` — which fails EEXIST rather
  // than overwriting. So concurrent initializers cannot each publish a different epoch: exactly one
  // wins, the losers adopt the winner's complete manifest. A half-written manifest is never visible.
  const tmp = `${MANIFEST}.${io.randomHex(8)}`;
  const fd = io.open(at(parentFd, tmp), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    let off = 0;
    while (off < body.length) {
      const n = io.write(fd, body, off, body.length - off, off);
      if (n <= 0) throw new Error("manifest write made no progress");
      off += n;
    }
    io.fsyncFile(fd);
  } finally {
    io.close(fd);
  }
  let published = true;
  try {
    io.link(at(parentFd, tmp), at(parentFd, MANIFEST));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    published = false; // another initializer won the race — adopt its generation
  } finally {
    try {
      io.unlink(at(parentFd, tmp));
    } catch {
      /* best effort */
    }
  }
  io.fsyncDir(parentFd);
  if (published) return manifest;
  const winner = readManifest(io, parentFd);
  if (!winner) throw new LedgerRecoveryRequired("the ledger manifest vanished immediately after publication");
  verifyManifest(io, parentFd, fds, winner, runNonce);
  return winner;
}

/** An EXISTING generation must be ours, and must still live on the exact inodes it was published to. */
function verifyManifest(io: LedgerIO, parentFd: number, fds: number[], m: LedgerManifest, runNonce: string): void {
  if (m.runNonce !== runNonce) {
    throw new LedgerRecoveryRequired(
      `this ledger belongs to run ${m.runNonce.slice(0, 12)}…, not ${runNonce.slice(0, 12)}… — a foreign or copied ledger is never adopted`
    );
  }
  const parentId = io.fstat(parentFd);
  if (parentId.dev.toString() !== m.parentDev || parentId.ino.toString() !== m.parentIno) {
    throw new LedgerRecoveryRequired(`the ledger parent directory was replaced (now ${parentId.dev}:${parentId.ino}, published under ${m.parentDev}:${m.parentIno})`);
  }
  const ancestors = idsOf(io, fds);
  if (ancestors.length !== m.ancestors.length) throw new LedgerRecoveryRequired("the ledger path depth changed");
  for (let i = 0; i < ancestors.length; i++) {
    if (ancestors[i].dev !== m.ancestors[i].dev || ancestors[i].ino !== m.ancestors[i].ino) {
      throw new LedgerRecoveryRequired(`ledger ancestor #${i} was replaced`);
    }
  }
  // The leaf must EXIST and be the exact inode. It is never re-created: an absent leaf is a lost
  // generation, and a fresh empty one would silently reset the budget (audit B2).
  let fd: number;
  try {
    fd = io.open(at(parentFd, m.leaf), O_LEAF_R);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new LedgerRecoveryRequired(`the ledger leaf ${m.leaf} is GONE but its manifest remains — the generation was destroyed, not reset`);
    }
    throw new LedgerRecoveryRequired(`the ledger leaf could not be opened (${(error as Error).message})`);
  }
  try {
    const st = io.fstat(fd);
    assertPrivateRegularFd(st, m.leaf);
    if (st.dev.toString() !== m.leafDev || st.ino.toString() !== m.leafIno) {
      throw new LedgerRecoveryRequired(
        `the ledger leaf is inode ${st.dev}:${st.ino}, but this generation was published to ${m.leafDev}:${m.leafIno} (the ledger was replaced between calls)`
      );
    }
  } finally {
    io.close(fd);
  }
  let wfd: number;
  try {
    wfd = io.open(at(parentFd, m.wal), O_LEAF_R);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new LedgerRecoveryRequired(`the ledger write-ahead log ${m.wal} is GONE`);
    throw new LedgerRecoveryRequired(`the ledger WAL could not be opened (${(error as Error).message})`);
  }
  io.close(wfd);
}

/**
 * Open (or establish) the run's ledger. Call this ONCE per run, after the run's immutable identity exists
 * — the ledger's generation is bound to it.
 *
 * `transcriptRoot` is the directory the ledger will confine every registrable transcript to (the run
 * directory in production). `groupAlive` is the scope prober the ledger uses to PROVE a reap for itself;
 * it defaults to the real syscall and is injectable so tests can drive attestation deterministically
 * without spawning processes.
 */
export function openLedger(opts: {
  dir: string;
  runNonce: string;
  io?: LedgerIO;
  transcriptRoot?: string;
  /** The PROCESS-GROUP half of the scope probe (injectable for deterministic tests). */
  groupAlive?: (pid: number) => boolean;
  /** The WHOLE scope probe, if a test needs to drive a cgroup scope's liveness too. Defaults to the real
   *  one, which asks the kernel about the cgroup and falls back to `groupAlive` for the process group. */
  scopeAlive?: (ref: ScopeRef) => boolean;
  /** Whether this host can contain a provider in a cgroup. Defaults to the real capability probe; a
   *  settlement claiming only a process-group scope is REFUSED when it is true (no silent downgrades). */
  strongScopeAvailable?: boolean;
}): LedgerHandle {
  return openLedgerInternal(opts);
}

// ---------------------------------------------------------------------------------------------
// Legacy v1 — EXPLICIT, one-way, CRASH-SAFE migration. Never a silent production fallback.
//
// The v1 journal chained from the constant string "genesis", stored money as JS floats, and carried no
// epoch/run binding. Production cannot read it: `initLedger` refuses a non-empty leaf that has no
// manifest, precisely so old accounting is never silently reinterpreted (or reset to zero) by a new
// version. Migrating is an operator action, and it CARRIES the old spend forward rather than
// discarding it.
//
// The hazard this design exists to kill is the ZERO-SPEND CARRY. The migration must archive the old
// leaf and remove it (a non-empty leaf without a manifest is exactly what production refuses), then
// publish a new generation and re-reserve the old balance inside it. Every instant between "the leaf is
// gone" and "the carry-forward record is durable" is a directory that looks like a FRESH BOARD — and a
// fresh board is a $0 budget. A crash there does not lose a receipt; it loses the entire memory of what
// the run already spent.
//
// So the order is inverted: a durable INTENT is published FIRST, and `openLedgerInternal` REFUSES to
// open any ledger in a directory holding an intent with no completion receipt. The migration is then
// free to be destructive, because every window it opens is one where nothing else can proceed:
//
//   intent → archive(link) → unlink leaf → new generation → carry reservation → COMPLETION receipt
//   ▲                                                                            ▲
//   └ from here the ledger will not open …………………………………………………………………………………………………… until here
//
// Each step is individually idempotent and re-derivable from the intent, so a crash at ANY point is
// repaired by re-running the migration, which resumes exactly where it stopped. It never re-carries
// (the carry's call id and nonces are PINNED in the intent, and an existing reservation is detected),
// and it never carries different bytes (the intent pins the v1 digest, which the source must still
// match).
// ---------------------------------------------------------------------------------------------

const V1_GENESIS = "genesis";
const V1_ARCHIVE = "reservations.v1.migrated.jsonl";
const V1_RECEIPT = "reservations.v1.migration.json";
const V1_INTENT = "reservations.v1.migration.intent.json";
const V1_LOCK = "reservations.v1.migration.lock";
const V1_INTENT_SCHEMA = "loop.ledger.v1-migration.intent.v1";
const V1_RECEIPT_SCHEMA = "loop.ledger.v1-migration.v1";
const V1_CARRY_CALL_ID = "legacy-v1-carry-forward";
const MAX_V1_BYTES = MAX_LEDGER_BYTES;

/** What the migration COMMITTED to do, published before it touched anything. A resumed run must do
 *  exactly this and nothing else. */
type V1Intent = {
  schema: typeof V1_INTENT_SCHEMA;
  ts: string;
  runNonce: string;
  /** The exact legacy bytes this balance was derived from. The source must still hash to this. */
  v1Sha256: string;
  v1Bytes: number;
  v1Records: number;
  /** The carried balance in NANO-USD fixed point. No float is ever the authority. */
  carriedForwardNano: string;
  /** The carry reservation's identity, PINNED so a resumed migration replays the SAME record instead
   *  of minting a second one with fresh nonces. */
  callNonce: string;
  reservationId: string;
};

/** Why this directory may not be opened as a ledger: a migration is in flight. */
function pendingMigrationReason(io: LedgerIO, parentFd: number): string | undefined {
  const intent = readJsonArtifact(io, parentFd, V1_INTENT);
  if (intent === undefined) return undefined;
  if (readJsonArtifact(io, parentFd, V1_RECEIPT) !== undefined) return undefined; // completed
  return (
    `a legacy v1 migration was STARTED here but never completed (${V1_INTENT} exists, ${V1_RECEIPT} does not). ` +
    `This ledger will not open until it finishes: the carried-forward balance may not yet be durable, and opening now ` +
    `would publish a fresh generation with ZERO spend. Re-run the migration to resume it.`
  );
}

/** Read a private JSON artifact beside the ledger. ENOENT → undefined. A present-but-unreadable or
 *  unparseable artifact is CORRUPTION, never "absent" — treating it as absent is how a torn control
 *  record gets laundered into a clean start. */
function readJsonArtifact(io: LedgerIO, parentFd: number, name: string): unknown | undefined {
  let fd: number;
  try {
    fd = io.open(at(parentFd, name), O_LEAF_R);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new LedgerRecoveryRequired(`${name} exists but could not be opened (${(error as Error).message})`);
  }
  try {
    // Like the manifest and the key, these are published by-link, so a crash between the `link()` and the
    // temp's `unlink()` can leave our own debris as a second name. Heal that (and only that) before the
    // alias check — otherwise a crashed publish of the MIGRATION INTENT bricks the board permanently, and
    // the intent is the one artifact whose absence would hand the next process a zero-spend budget.
    const st = statPublished(io, parentFd, fd, name);
    assertPrivateRegularFd(st, name);
    if (st.size > MAX_V1_BYTES) throw new LedgerRecoveryRequired(`${name} is implausibly large (${st.size} bytes)`);
    const buf = Buffer.allocUnsafe(st.size);
    let got = 0;
    while (got < buf.length) {
      const n = io.read(fd, buf, got, buf.length - got, got);
      if (n <= 0) break;
      got += n;
    }
    try {
      return JSON.parse(buf.subarray(0, got).toString("utf8"));
    } catch {
      throw new LedgerRecoveryRequired(`${name} is present but unparseable (a torn or tampered control record is never ignored)`);
    }
  } finally {
    io.close(fd);
  }
}

/** Publish a private JSON artifact atomically and durably: a temp file written whole and fsynced, then
 *  `link()`ed into place (EEXIST rather than overwrite), then the directory fsynced. */
function writeJsonArtifact(io: LedgerIO, parentFd: number, name: string, value: unknown): void {
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const tmp = `${name}.${io.randomHex(8)}`;
  let linked = false;
  try {
    const fd = io.open(at(parentFd, tmp), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try {
      let off = 0;
      while (off < body.length) {
        const n = io.write(fd, body, off, body.length - off, off);
        if (n <= 0) throw new Error(`${name} write made no progress`);
        off += n;
      }
      io.fsyncFile(fd);
    } finally {
      io.close(fd);
    }
    io.link(at(parentFd, tmp), at(parentFd, name)); // atomic publish; EEXIST if it already exists
    linked = true;
  } finally {
    try {
      io.unlink(at(parentFd, tmp)); // the temp NEVER survives, published or not
    } catch {
      /* best effort */
    }
  }
  if (linked) io.fsyncDir(parentFd);
}

type V1Data = {
  type: "reserve" | "settle";
  callId: string;
  worstCase?: number;
  enforced?: boolean;
  usd?: number;
  reported?: boolean;
};

/** A legacy money float, validated to EXACT fixed point. v1 wrote raw JS numbers, so the journal can
 *  hold a NaN, an Infinity, a negative, a string, or a value with sub-nano precision — none of which
 *  may be silently coerced (the old `Number(d.worstCase ?? 0)` produced NaN, which then compared false
 *  in every guard and quietly carried NOTHING forward). */
function legacyNano(v: unknown, what: string, seq: number): bigint {
  if (typeof v !== "number") throw new CorruptJournalError(`legacy v1: ${what} at seq ${seq} is ${JSON.stringify(v)}, not a number`);
  try {
    return usdToNano(v, what);
  } catch (error) {
    throw new CorruptJournalError(`legacy v1: ${what} at seq ${seq} is not exact fixed-point money (${(error as Error).message})`);
  }
}

export type LegacyV1Fold = {
  records: number;
  effectiveSpendUsd: number;
  effectiveSpendNano: bigint;
  bytes: Buffer;
  sha256: string;
};

/**
 * READ-ONLY, STRICT fold of legacy v1 bytes. Validates the old hash chain exactly as v1 did, and beyond
 * that every transition and every money value — so corruption fails closed here too. A migration must
 * never "recover" old accounting by dropping records it cannot verify, and must never under-carry:
 *
 *   - a duplicate/re-reserved call id would have OVERWRITTEN the first reservation in the old code's
 *     `live.set(...)`, silently discarding its worst case (carrying LESS money forward than was spent);
 *   - an orphan or duplicate settle is a conflicting record, not a cheaper one;
 *   - a non-number / NaN / Infinity / negative / over-precise amount is corruption, not zero.
 *
 * Only an UNTERMINATED final line (a crash mid-append) may be recovered, by truncation — v1's own rule.
 */
export function foldLegacyV1Bytes(raw: Buffer): LegacyV1Fold {
  const live = new Map<string, { worstCase: bigint; settled: boolean; usd: bigint | null }>();
  let tip = V1_GENESIS;
  let seq = 0;
  const endsWithNewline = raw.length > 0 && raw[raw.length - 1] === 0x0a;
  const lines = raw.toString("utf8").split("\n");
  if (endsWithNewline) lines.pop();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const unterminated = i === lines.length - 1 && !endsWithNewline;
    if (line.trim() === "") {
      if (unterminated) break;
      throw new CorruptJournalError(`legacy v1: blank record at line ${i}`);
    }
    let rec: { seq: number; prev: string; hash: string; data: V1Data };
    try {
      rec = JSON.parse(line);
    } catch {
      if (unterminated) break; // a torn final append — the only recoverable case
      throw new CorruptJournalError(`legacy v1: unparseable record at line ${i}`);
    }
    if (typeof rec !== "object" || rec === null || Array.isArray(rec)) throw new CorruptJournalError(`legacy v1: record at line ${i} is not an object`);
    if (rec.prev !== tip || rec.seq !== seq) throw new CorruptJournalError(`legacy v1: broken chain at seq ${rec.seq}`);
    if (rec.hash !== createHash("sha256").update(`${tip}|${seq}|${JSON.stringify(rec.data)}`).digest("hex")) {
      throw new CorruptJournalError(`legacy v1: hash mismatch at seq ${seq} (tampered record)`);
    }
    const d = rec.data;
    if (typeof d !== "object" || d === null || Array.isArray(d)) throw new CorruptJournalError(`legacy v1: data at seq ${seq} is not an object`);
    if (typeof d.callId !== "string" || d.callId === "") throw new CorruptJournalError(`legacy v1: invalid callId at seq ${seq}`);
    if (d.type === "reserve") {
      // A re-reserve of a live id is a CONFLICT. The old fold overwrote the entry, dropping the first
      // reservation's worst case and carrying less forward than the legacy run had committed.
      if (live.has(d.callId)) throw new CorruptJournalError(`legacy v1: duplicate/re-reserve for call id ${d.callId} at seq ${seq}`);
      live.set(d.callId, { worstCase: legacyNano(d.worstCase, "worstCase", seq), settled: false, usd: null });
    } else if (d.type === "settle") {
      const cur = live.get(d.callId);
      if (!cur) throw new CorruptJournalError(`legacy v1: orphan settle for ${d.callId} at seq ${seq}`);
      if (cur.settled) throw new CorruptJournalError(`legacy v1: duplicate settle for call id ${d.callId} at seq ${seq}`);
      if (typeof d.reported !== "boolean") throw new CorruptJournalError(`legacy v1: invalid reported flag at seq ${seq}`);
      cur.settled = true;
      // Only a REPORTED settlement supplies an actual; everything else retains the worst case — the v1
      // rule, applied in fixed point so no float rounding can shrink the carried balance.
      cur.usd = d.reported ? legacyNano(d.usd, "usd", seq) : null;
    } else {
      throw new CorruptJournalError(`legacy v1: unknown record type ${JSON.stringify(d.type)} at seq ${seq}`);
    }
    tip = rec.hash;
    seq += 1;
  }
  let nano = 0n;
  for (const r of live.values()) nano += r.settled && r.usd !== null ? r.usd : r.worstCase;
  if (nano > MAX_NANO) throw new CorruptJournalError(`legacy v1: the carried balance (${formatNano(nano)}) exceeds the maximum representable amount`);
  // The carry is re-reserved through the ordinary money path, which takes USD. Prove the fixed-point
  // balance survives that round trip EXACTLY, or refuse — money is never silently rounded.
  const usd = nanoToUsd(nano);
  if (usdToNano(usd, "carried-forward spend") !== nano) {
    throw new CorruptJournalError(`legacy v1: the carried balance ${formatNano(nano)} nano-USD is not exactly representable as USD`);
  }
  return {
    records: seq,
    effectiveSpendUsd: usd,
    effectiveSpendNano: nano,
    bytes: Buffer.from(raw),
    sha256: createHash("sha256").update(raw).digest("hex")
  };
}

/**
 * Identify an artifact THROUGH the pinned parent fd, WITHOUT the single-link requirement. Used only to
 * compare the archive's inode against the leaf's while they are (correctly) two names for one inode.
 * Every other private-file property is still enforced.
 */
function statArtifact(io: LedgerIO, parentFd: number, name: string): FileId {
  const fd = io.open(at(parentFd, name), O_LEAF_R);
  try {
    const st = io.fstat(fd);
    if (!st.isFile) throw new LedgerRecoveryRequired(`${name} is not a regular file`);
    if ((st.mode & 0o077) !== 0) throw new LedgerRecoveryRequired(`${name} is group/other accessible (mode ${(st.mode & 0o7777).toString(8)})`);
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
      throw new LedgerRecoveryRequired(`${name} is owned by uid ${st.uid}, not ${process.getuid()}`);
    }
    return st;
  } finally {
    io.close(fd);
  }
}

/**
 * Is `name`, opened THROUGH the pinned parent fd with `O_NOFOLLOW`, this very inode? Absent → false.
 * No path is re-resolved, so a rename racing the check cannot substitute a different file for the one
 * whose links we are accounting for.
 */
function namesThisInode(io: LedgerIO, parentFd: number, name: string, st: FileId): boolean {
  let fd: number;
  try {
    fd = io.open(at(parentFd, name), O_LEAF_R);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  try {
    const other = io.fstat(fd);
    return other.dev === st.dev && other.ino === st.ino;
  } finally {
    io.close(fd);
  }
}

/**
 * Read a legacy leaf/archive THROUGH a pinned parent fd. Absent → undefined.
 *
 * Aliasing is BOUNDED, not waived. Archiving is a `link()`, so a crash between it and the leaf's removal
 * legitimately leaves the legacy inode with exactly two names — `LEAF` and `V1_ARCHIVE`. That mid-migration
 * pair is the only tolerated second link, and it is not taken on faith: both expected names must exist and
 * both must be PROVEN to be this inode, which accounts for both links and leaves none unexplained. Every
 * other shape — one expected name plus an unknown alias, an expected name plus a foreign archive, three or
 * more links — means a name we cannot see can mutate the legacy bytes under the fold, so it fails closed.
 */
function readLegacyFile(io: LedgerIO, parentFd: number, name: string): Buffer | undefined {
  let fd: number;
  try {
    fd = io.open(at(parentFd, name), O_LEAF_R);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const st = io.fstat(fd);
    if (!st.isFile) throw new LedgerRecoveryRequired(`${name} is not a regular file`);
    if ((st.mode & 0o077) !== 0) throw new LedgerRecoveryRequired(`${name} is group/other accessible (mode ${(st.mode & 0o7777).toString(8)})`);
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
      throw new LedgerRecoveryRequired(`${name} is owned by uid ${st.uid}, not ${process.getuid()}`);
    }
    if (st.nlink !== 1) {
      const midMigrationPair = st.nlink === 2 && namesThisInode(io, parentFd, LEAF, st) && namesThisInode(io, parentFd, V1_ARCHIVE, st);
      if (!midMigrationPair) {
        throw new LedgerRecoveryRequired(
          `${name} has ${st.nlink} hard links — only the mid-migration pair ${LEAF} + ${V1_ARCHIVE}, both proven to be this one inode, may alias it`
        );
      }
    }
    if (st.size > MAX_V1_BYTES) throw new CorruptJournalError(`legacy v1: ${name} is ${st.size} bytes (limit ${MAX_V1_BYTES})`);
    const buf = Buffer.allocUnsafe(st.size);
    let got = 0;
    while (got < buf.length) {
      const n = io.read(fd, buf, got, buf.length - got, got);
      if (n <= 0) break;
      got += n;
    }
    return buf.subarray(0, got);
  } finally {
    io.close(fd);
  }
}

/** READ-ONLY strict fold of the legacy journal in `dir`. Missing leaf → zero records. */
export function readLegacyV1(dir: string, io: LedgerIO = realLedgerIO()): LegacyV1Fold {
  const fds = walkComponents(io, resolve(dir));
  try {
    const raw = readLegacyFile(io, fds[fds.length - 1], LEAF);
    if (raw === undefined) return { records: 0, effectiveSpendUsd: 0, effectiveSpendNano: 0n, bytes: Buffer.alloc(0), sha256: createHash("sha256").update("").digest("hex") };
    return foldLegacyV1Bytes(raw);
  } finally {
    closeAll(io, fds);
  }
}

function closeAll(io: LedgerIO, fds: number[]): void {
  for (const fd of fds) {
    try {
      io.close(fd);
    } catch {
      /* ignore */
    }
  }
}

/**
 * ONE-WAY, CRASH-SAFE, RESUMABLE migration of a legacy v1 journal into a fresh v2 generation.
 *
 * Serialized by an exclusive kernel lock, so two operators (or an operator and a cron) cannot both
 * archive, both publish a generation, or both carry the balance. Idempotent at every step: re-running
 * after ANY crash resumes and completes, and re-running after completion refuses.
 */
export function migrateLegacyV1(opts: { dir: string; runNonce: string; io?: LedgerIO }): { carriedForwardUsd: number; archive: string; receipt: string } {
  const io = opts.io ?? realLedgerIO();
  const dir = resolve(opts.dir);
  const fds = walkComponents(io, dir);
  const parentFd = fds[fds.length - 1];
  let lockFd = -1;
  let handle: LedgerHandle | undefined;
  try {
    // EXCLUSIVE for the whole migration. The lock file is never unlinked, so it cannot be raced away.
    lockFd = io.open(at(parentFd, V1_LOCK), fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o600);
    io.lockExclusive(lockFd, LOCK_TIMEOUT_MS);

    // Already COMPLETED → one-way means once.
    if (readJsonArtifact(io, parentFd, V1_RECEIPT) !== undefined) {
      throw new LedgerRecoveryRequired("this ledger has already been migrated — the legacy migration is one-way and must not run twice");
    }
    const existingIntent = readIntent(io, parentFd, opts.runNonce);
    const manifest = readManifest(io, parentFd);
    // A v2 generation that did NOT come from an in-flight migration is not a migration candidate.
    if (existingIntent === undefined && manifest !== undefined) {
      throw new LedgerRecoveryRequired("this ledger already has a v2 generation — migration is one-way and must not run twice");
    }

    // THE SOURCE.
    //
    // Which file holds the legacy bytes depends on how far a previous attempt got, and the ONE thing
    // that settles it is whether a v2 generation has been published. Once a manifest exists, `LEAF` is
    // the NEW generation's journal (empty, or already holding the carry-forward record) — reading it as
    // legacy bytes would fold v2 records against the v1 chain, and archiving it would destroy the new
    // ledger. So: manifest present ⇒ the archive is the only legacy source, and the leaf is off limits.
    const legacyLeaf = manifest === undefined ? readLegacyFile(io, parentFd, LEAF) : undefined;
    const archiveBytes = readLegacyFile(io, parentFd, V1_ARCHIVE);
    const source = legacyLeaf !== undefined && legacyLeaf.length > 0 ? legacyLeaf : archiveBytes;
    if (source === undefined || source.length === 0) {
      throw new LedgerRecoveryRequired("there is no legacy v1 accounting here to migrate");
    }
    // An EMPTY leaf is not legacy accounting (a previous attempt's `initLedger` creates one before it
    // publishes the manifest). It must never be archived or unlinked.
    const leafBytes = legacyLeaf !== undefined && legacyLeaf.length > 0 ? legacyLeaf : undefined;
    const fold = foldLegacyV1Bytes(source); // STRICT — corruption throws BEFORE anything is touched
    if (fold.records === 0) throw new LedgerRecoveryRequired("there is no legacy v1 accounting here to migrate");

    // The intent: published BEFORE the first destructive step, and from that moment this directory
    // cannot be opened as a ledger until the completion receipt exists (see `pendingMigrationReason`).
    const intent: V1Intent = existingIntent ?? {
      schema: V1_INTENT_SCHEMA,
      ts: io.now(),
      runNonce: opts.runNonce,
      v1Sha256: fold.sha256,
      v1Bytes: fold.bytes.length,
      v1Records: fold.records,
      carriedForwardNano: formatNano(fold.effectiveSpendNano),
      callNonce: io.randomHex(16),
      reservationId: io.randomHex(16)
    };
    if (existingIntent === undefined) {
      writeJsonArtifact(io, parentFd, V1_INTENT, intent);
    } else if (existingIntent.v1Sha256 !== fold.sha256 || existingIntent.carriedForwardNano !== formatNano(fold.effectiveSpendNano)) {
      // The bytes under a resumed migration are not the bytes it committed to carry.
      throw new LedgerRecoveryRequired(
        `the in-flight migration committed to carrying ${existingIntent.carriedForwardNano} nano-USD from v1 bytes ` +
          `${existingIntent.v1Sha256.slice(0, 16)}…, but the legacy journal here now folds to ` +
          `${formatNano(fold.effectiveSpendNano)} from ${fold.sha256.slice(0, 16)}… — refusing to carry a different balance`
      );
    }
    const carriedNano = parseNano(intent.carriedForwardNano, "carriedForwardNano");
    const carriedUsd = nanoToUsd(carriedNano);

    // ARCHIVE (hard link — the original inode is preserved, never rewritten), then remove the leaf.
    // Both are idempotent: EEXIST on the link means a previous attempt already archived, and we prove it
    // archived THESE bytes before continuing.
    if (leafBytes !== undefined) {
      try {
        io.link(at(parentFd, LEAF), at(parentFd, V1_ARCHIVE));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      io.fsyncDir(parentFd);
      // Prove the archive IS the leaf's inode before destroying the only other name for it. A hard link
      // to the same inode holds the same bytes BY CONSTRUCTION — a content re-read cannot establish that
      // here (the freshly linked file has nlink 2, which the private-file check rightly refuses). An
      // EEXIST archive that is some OTHER inode is a planted file, and unlinking the leaf against it
      // would destroy the legacy journal outright.
      const leafId = statArtifact(io, parentFd, LEAF);
      const archiveId = statArtifact(io, parentFd, V1_ARCHIVE);
      if (leafId.dev !== archiveId.dev || leafId.ino !== archiveId.ino) {
        throw new LedgerRecoveryRequired(
          `${V1_ARCHIVE} already exists and is NOT the legacy leaf's inode — refusing to destroy ${LEAF} against a foreign archive`
        );
      }
      io.unlink(at(parentFd, LEAF)); // safe: same inode, and the directory entry is already fsynced
      io.fsyncDir(parentFd);
    }
    // The archive now stands alone. Prove it holds EXACTLY the bytes this migration committed to carry —
    // on a RESUMED run this is the only thing establishing that the source did not change underneath us.
    const archived = readLegacyFile(io, parentFd, V1_ARCHIVE);
    if (archived === undefined || createHash("sha256").update(archived).digest("hex") !== intent.v1Sha256) {
      throw new LedgerRecoveryRequired(`${V1_ARCHIVE} does not hold the exact bytes this migration committed to carry`);
    }

    // The new generation. `duringMigration` bypasses the pending-migration refusal — for THIS call only,
    // which is the one that is finishing it.
    handle = openLedgerInternal({ dir, runNonce: opts.runNonce, io, duringMigration: true });

    // CARRY: an enforced, never-settled reservation whose worst case IS the old balance, so every later
    // budget decision counts the money the old run already spent. Its budget is the carried amount
    // itself (`0 + carried > carried` is false), so it is admitted at exactly its own value. The bind is
    // PINNED by the intent, and an already-durable carry is detected rather than duplicated.
    if (carriedNano > 0n && !handle.hasReservation(V1_CARRY_CALL_ID)) {
      const bind: CallBinding = {
        runNonce: opts.runNonce,
        callNonce: intent.callNonce,
        callId: V1_CARRY_CALL_ID,
        reservationId: intent.reservationId,
        routeEpoch: 0,
        provider: "legacy-v1",
        model: "migration",
        attempt: 0,
        intentSha256: intent.v1Sha256, // the exact v1 bytes this balance was derived from
        stdinSha256: intent.v1Sha256,
        stdinBytes: intent.v1Bytes
      };
      if (!handle.reserve(bind, carriedUsd, carriedUsd)) {
        throw new LedgerRecoveryRequired("could not carry the legacy balance forward into the new generation");
      }
    }

    // COMPLETION. Only now is the directory a usable ledger again.
    writeJsonArtifact(io, parentFd, V1_RECEIPT, {
      schema: V1_RECEIPT_SCHEMA,
      ts: io.now(),
      runNonce: opts.runNonce,
      epoch: handle.epoch,
      archive: V1_ARCHIVE,
      v1Sha256: intent.v1Sha256,
      v1Bytes: intent.v1Bytes,
      v1Records: intent.v1Records,
      carriedForwardUsd: carriedUsd,
      carriedForwardNano: intent.carriedForwardNano
    });
    return { carriedForwardUsd: carriedUsd, archive: V1_ARCHIVE, receipt: V1_RECEIPT };
  } finally {
    handle?.close();
    if (lockFd >= 0) {
      try {
        io.close(lockFd); // releases the flock
      } catch {
        /* ignore */
      }
    }
    closeAll(io, fds); // EXACTLY ONCE — the old code closed these mid-function and again in its catch,
    // so a later throw closed fd NUMBERS the new ledger handle had since been given (fd reuse).
  }
}

/** Read and fully validate an in-flight migration intent. Present-but-invalid is corruption. */
function readIntent(io: LedgerIO, parentFd: number, runNonce: string): V1Intent | undefined {
  const v = readJsonArtifact(io, parentFd, V1_INTENT);
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new LedgerRecoveryRequired(`${V1_INTENT} is not an object`);
  const i = v as Record<string, unknown>;
  const bad = (why: string): never => {
    throw new LedgerRecoveryRequired(`${V1_INTENT} is invalid: ${why}`);
  };
  if (i.schema !== V1_INTENT_SCHEMA) bad(`unknown schema ${String(i.schema)}`);
  if (typeof i.runNonce !== "string" || i.runNonce.length < 32 || !HEX.test(i.runNonce)) bad("invalid runNonce");
  if (typeof i.v1Sha256 !== "string" || !SHA256.test(i.v1Sha256)) bad("invalid v1Sha256");
  if (typeof i.v1Bytes !== "number" || !Number.isInteger(i.v1Bytes) || i.v1Bytes < 0) bad("invalid v1Bytes");
  if (typeof i.v1Records !== "number" || !Number.isInteger(i.v1Records) || i.v1Records < 0) bad("invalid v1Records");
  if (!isNanoString(i.carriedForwardNano)) bad("invalid carriedForwardNano");
  if (typeof i.callNonce !== "string" || i.callNonce.length < 32 || !HEX.test(i.callNonce)) bad("invalid callNonce");
  if (typeof i.reservationId !== "string" || i.reservationId.length < 32 || !HEX.test(i.reservationId)) bad("invalid reservationId");
  if (typeof i.ts !== "string" || !i.ts) bad("invalid ts");
  // A migration intent belongs to the run that started it. Resuming another run's migration would carry
  // its balance into OUR generation under OUR nonce.
  if (i.runNonce !== runNonce) {
    bad(`it belongs to run ${(i.runNonce as string).slice(0, 12)}…, not ${runNonce.slice(0, 12)}… — resume it as that run`);
  }
  return v as V1Intent;
}

export const LEDGER_LEAF = LEAF;
export const LEDGER_WAL = WAL;
export const LEDGER_MANIFEST = MANIFEST;
export { POISON_SCHEMA, RECOVERY_SCHEMA };

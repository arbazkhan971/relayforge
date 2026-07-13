import { createHmac, timingSafeEqual } from "node:crypto";
import { parseScopeId, reapProofOf, type ScopeRef } from "./scope.js";

/**
 * THE LEDGER'S ATTESTATION AUTHORITY (wave-9: settlement-receipt authenticity).
 *
 * ---------------------------------------------------------------------------------------------
 * THE VULNERABILITY THIS CLOSES
 * ---------------------------------------------------------------------------------------------
 * `SettlementReceipt` used to be an exported, structurally-constructible object type, and
 * `validateReceipt` only checked its SHAPE:
 *
 *     ledger.settle(bind, { usd: 0.000001, reported: true, receipt: {
 *       kind: "trusted-fallback",           // ← authorizes billing a SECOND provider
 *       scopeId: "pgid:1", scopeReaped: true,
 *       scopeReapProof: "pgid-empty:ESRCH:1",   // ← a string, matched by regex against scopeId
 *       transcriptSha256: "00…", transcriptBytes: 100,   // ← never compared to any file
 *       terminalSha256: "11…", terminalBytes: 10, terminalOffset: 0,   // ← never read from disk
 *       costProvenance: "provider-reported"  // ← a claim, not a provenance
 *     }})
 *
 * Every field was a CLAIM the ledger took on faith. An ordinary API caller could mint authority to
 * shrink its worst-case reservation to an arbitrary amount and to authorize a second provider's bill,
 * purely by constructing an object literal. Shape checks — however strict, however self-consistent —
 * are not authenticity: they only prove the forger read the validator.
 *
 * ---------------------------------------------------------------------------------------------
 * THE TRUST BOUNDARY (explicit)
 * ---------------------------------------------------------------------------------------------
 * TRUSTED (inside the boundary):
 *   - `LedgerHandle` and the `CallAuthority` capability it issues. These, and ONLY these, mint receipts.
 *   - The ledger's own IO capability (`LedgerIO`) and its scope prober. It reads the evidence itself.
 *   - The bytes the provider durably wrote to a REGISTERED transcript, verified by inode and hash.
 *
 * UNTRUSTED (the ordinary-caller threat model this module defends against):
 *   - Everything that merely HOLDS a `LedgerHandle`, including the orchestrator, the transport, and any
 *     third-party consumer of this package. Such a caller may call any exported method, construct any
 *     exported type, pass any argument, and retain/replay any value we hand back.
 *   - A caller cannot: construct a receipt, clone one, alter one, replay one across runs / reservations /
 *     attempts / route epochs, or state a cost, a reap outcome, a transcript identity, a byte range, or a
 *     fallback authorization. It supplies NO evidence at all — see `CallAuthority.attest`, which derives
 *     every field from bytes the ledger reads back from disk under its own IO capability.
 *
 * OUT OF SCOPE (documented, not defended):
 *   - Arbitrary filesystem write access to the run's private 0700 board directory as the run's own uid.
 *     Such an attacker can rewrite the journal, the transcripts, and this key file alike; the ledger's
 *     inode/nlink/mode/owner checks fail closed on tampering it can detect, but a same-uid attacker with
 *     the board directory is already inside the money's trust domain. The attestation key lives in EXACTLY
 *     that domain (0600, beside the journal) and is never weaker than the journal it protects.
 *   - In-process memory disclosure (a caller that reaches into module internals via a debugger/patched
 *     require hook). No JS value is secret from a debugger; the boundary here is the API surface.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY A MAC AT ALL, AND WHY IT IS NOT "A READABLE/EXPORTED SECRET"
 * ---------------------------------------------------------------------------------------------
 * Issuance authority in-process is enforced STRUCTURALLY, without any secret: a minted receipt is an
 * opaque object whose payload lives in a module-private `WeakMap` (see ledger.ts). A forged instance —
 * however perfectly shaped, even `new (SettlementReceipt as any)()` — simply is not a key in that map, and
 * no code outside this module can insert one. That is unforgeable at runtime, unlike a TypeScript brand
 * (erased at compile time) and unlike any shape check (satisfiable by construction).
 *
 * But a receipt must ALSO survive to the journal and be re-verified at FOLD time, by a fresh process after
 * a restart, over bytes alone. A `WeakMap` cannot cross that boundary, so the durable half needs a keyed
 * tag. This key is:
 *   - generated per ledger generation (32 random bytes), never derived from anything guessable;
 *   - stored 0600 beside the journal, in the same trust domain as the journal bytes it authenticates;
 *   - NEVER exported, NEVER returned by any public method, NEVER serialized into a record or a log line.
 * `AttestKey` below is deliberately an opaque wrapper with no accessor: nothing in the codebase can read
 * the key material back out of it, so it cannot leak by accident through a stray `JSON.stringify` of a
 * handle or a debug dump.
 */

/**
 * An opaque handle to the ledger's attestation key. The bytes are held in a module-private `WeakMap`, so
 * there is no property to read, no getter to call, and nothing for `JSON.stringify`/`util.inspect` to
 * disclose. The key can only be USED (to tag/verify), never READ.
 */
export class AttestKey {
  /** @internal Only `attestKeyFromBytes` produces a usable instance. */
  constructor() {
    /* the material is attached out-of-band; a bare `new AttestKey()` is inert and fails every verify */
  }
  /** Never disclose key material through a stringification path. */
  toJSON(): string {
    return "[ledger attestation key]";
  }
  toString(): string {
    return "[ledger attestation key]";
  }
}

const KEY_MATERIAL = new WeakMap<AttestKey, Buffer>();

export const ATTEST_KEY_BYTES = 32;

/** Wrap raw key bytes. The ONLY way to make a usable `AttestKey`; the bytes are never readable again. */
export function attestKeyFromBytes(raw: Buffer): AttestKey {
  if (!Buffer.isBuffer(raw) || raw.length !== ATTEST_KEY_BYTES) {
    throw new Error(`the ledger attestation key must be exactly ${ATTEST_KEY_BYTES} bytes (got ${Buffer.isBuffer(raw) ? raw.length : typeof raw})`);
  }
  const key = new AttestKey();
  KEY_MATERIAL.set(key, Buffer.from(raw));
  return key;
}

/**
 * What a settlement's authority is BOUND to, durably. Every field is derived by the LEDGER from evidence
 * it read itself — none of it is a caller's claim. The MAC covers all of it, so changing any single field
 * on disk (or moving the payload to another record, run, reservation, attempt, or route epoch) invalidates
 * the tag and fails the fold closed.
 */
export type AttestPayload = {
  schema: "loop.ledger.attest.v2";
  kind: "accounted-terminal" | "trusted-fallback";

  // --- WHOSE authority is this? (cross-run / cross-reservation / cross-attempt replay defence) --------
  /** The ledger GENERATION that issued it. A receipt from another ledger cannot be folded here. */
  ledgerEpoch: string;
  /** The run. Bound again inside the MAC even though the key is already run-scoped: defence in depth. */
  runNonce: string;
  callId: string;
  /** The per-call nonce, spendable exactly once across the whole journal. */
  callNonce: string;
  /** The RESERVATION record this settlement discharges. A receipt for another reservation is refused. */
  reservationId: string;
  /** The route generation in force when the call was reserved. A cooldown bumps it, so a stale-route
   *  settlement (e.g. one replayed after the route moved to the fallback) cannot be applied. */
  routeEpoch: number;
  provider: string;
  model: string;
  /** The provider DIALECT the ledger re-derived the verdict with. */
  providerKind: string;
  attempt: number;

  // --- WHAT was proven? (all read back from disk by the ledger, never asserted by a caller) -----------
  /**
   * WHICH containment boundary this call actually ran inside. Bound into the MAC because the two
   * backends prove emptiness by entirely different means, and a WEAK proof must never be readable as a
   * strong one: `cgroup2` is a kernel-enforced membership set nothing can `setsid` its way out of, while
   * `pgid` is a process group any descendant can leave in one syscall. A `pgid` settlement therefore
   * says strictly less than a `cgroup2` one, and says so ON DISK, for every future fold.
   */
  scopeBackend: "pgid" | "cgroup2";
  /** The exact owned scope — `pgid:<pid>`, or `cgroup2:<ino>:<name>:<pid>` (the cgroup's kernel-assigned
   *  inode, so a recreated name cannot impersonate the object we made). */
  scopeId: string;
  /** The ledger's OWN probe of that exact scope, at attestation time, rendered by `reapProofOf` — never
   *  a string a caller supplied. For a cgroup scope it records that the kernel REMOVED the cgroup (which
   *  `rmdir` permits only when it and every descendant cgroup are empty) AND that the leader's process
   *  group is gone. */
  scopeReapProof: string;
  /** The durable transcript's identity — the inode, not a name. A swapped/relinked file is refused. */
  transcriptDev: string;
  transcriptIno: string;
  /** sha256 and exact byte count of the WHOLE durable transcript, as re-read by the ledger. */
  transcriptSha256: string;
  transcriptBytes: number;
  /** sha256 / length / offset of the canonical terminal frame's RAW WIRE BYTES, located by re-framing the
   *  durable transcript. `[offset, offset+bytes)` is exactly the evidence an auditor re-reads. */
  terminalSha256: string;
  terminalBytes: number;
  terminalOffset: number;
  /** For a `trusted-fallback` receipt ONLY: the canonical Claude `rate_limit_event` frame whose
   *  `rate_limit_info.status` is `rejected`, located in the same durable transcript. This — and nothing
   *  else — is what authorizes billing a second provider. Absent on an `accounted-terminal` receipt. */
  limitSha256?: string;
  limitBytes?: number;
  limitOffset?: number;

  // --- WHAT is being charged? (re-derived from the terminal frame, never taken from the caller) -------
  /** The charged amount in NANO-USD, as a decimal string, as the ledger read it off the durable terminal
   *  record. `costProvenance` says where it came from; only `provider-reported` may shrink a reservation. */
  usdNano: string;
  costProvenance: "provider-reported" | "unknown";
  ts: string;
};

/** A durable attestation as it lives in the journal: the ledger-derived payload plus its MAC. */
export type DurableAttestation = {
  payload: AttestPayload;
  /** HMAC-SHA256 over the CANONICAL encoding of `payload`, keyed by the ledger's attestation key. */
  tag: string;
};

/** v2 (wave-10): the payload now names the containment BACKEND it was proven under, and admits the strong
 *  `cgroup2` scope identity/reap proof alongside the weak `pgid` one. A v1 tag can never validate a v2
 *  payload (the schema is inside the MAC), so a pre-containment record cannot be replayed as a contained
 *  one, and a v2 verifier cannot be fooled by an unauthenticated new field. */
const SCHEMA = "loop.ledger.attest.v2";
const KINDS = new Set(["accounted-terminal", "trusted-fallback"]);
const BACKENDS = new Set(["pgid", "cgroup2"]);
const PROVENANCE = new Set(["provider-reported", "unknown"]);
const SHA256 = /^[0-9a-f]{64}$/;
const HEX = /^[0-9a-f]+$/;
const DEC = /^(0|[1-9][0-9]*)$/;
const NANO = /^-?(0|[1-9][0-9]*)$/;

/** The ONE admissible reap proof for a scope, derived from that scope's exact identity. Re-exported from
 *  `./scope` so the transport, the ledger and this validator can only ever agree. */
export { reapProofOf, scopeIdOf, parseScopeId, type ScopeRef } from "./scope.js";

/**
 * CANONICAL encoding for the MAC.
 *
 * `JSON.stringify` is NOT canonical: key order follows insertion order, so two payloads that are equal as
 * values can encode differently (and a re-parsed payload can encode differently from the original). A MAC
 * over a non-canonical encoding is a MAC over an accident. Here every field is emitted in a FIXED order
 * with an explicit length prefix, so no value can be smuggled across a field boundary (`a="x|y", b=""`
 * must not encode like `a="x", b="y"`), and an absent optional field is distinct from an empty one.
 */
function canonical(p: AttestPayload): Buffer {
  const parts: string[] = [];
  const put = (name: string, v: string | number | undefined): void => {
    if (v === undefined) {
      parts.push(`${name}:-`); // ABSENT — distinct from any present value, including the empty string
      return;
    }
    const s = String(v);
    parts.push(`${name}:${Buffer.byteLength(s, "utf8")}:${s}`);
  };
  // FIXED ORDER. Adding a field here is a schema change: bump `schema` so an old tag can never validate a
  // payload with new, unauthenticated fields.
  put("schema", p.schema);
  put("kind", p.kind);
  put("ledgerEpoch", p.ledgerEpoch);
  put("runNonce", p.runNonce);
  put("callId", p.callId);
  put("callNonce", p.callNonce);
  put("reservationId", p.reservationId);
  put("routeEpoch", p.routeEpoch);
  put("provider", p.provider);
  put("model", p.model);
  put("providerKind", p.providerKind);
  put("attempt", p.attempt);
  put("scopeBackend", p.scopeBackend);
  put("scopeId", p.scopeId);
  put("scopeReapProof", p.scopeReapProof);
  put("transcriptDev", p.transcriptDev);
  put("transcriptIno", p.transcriptIno);
  put("transcriptSha256", p.transcriptSha256);
  put("transcriptBytes", p.transcriptBytes);
  put("terminalSha256", p.terminalSha256);
  put("terminalBytes", p.terminalBytes);
  put("terminalOffset", p.terminalOffset);
  put("limitSha256", p.limitSha256);
  put("limitBytes", p.limitBytes);
  put("limitOffset", p.limitOffset);
  put("usdNano", p.usdNano);
  put("costProvenance", p.costProvenance);
  put("ts", p.ts);
  return Buffer.from(parts.join("|"), "utf8");
}

/** Tag a payload the ledger just derived. Module-internal by construction: a caller cannot obtain an
 *  `AttestKey` (nothing exports one), so it cannot reach a usable tagging primitive. */
export function tagPayload(key: AttestKey, payload: AttestPayload): string {
  const material = KEY_MATERIAL.get(key);
  if (material === undefined) throw new Error("the ledger attestation key is not usable (it carries no material)");
  return createHmac("sha256", material).update(canonical(payload)).digest("hex");
}

/**
 * Verify a durable attestation, STRUCTURALLY and then CRYPTOGRAPHICALLY.
 *
 * The structural pass is not the security boundary (the MAC is) — it exists so a malformed payload can
 * never reach `canonical()` and produce a tag over `undefined`/`[object Object]`, and so a fold reports
 * WHY it failed. Returns an error string, or undefined when the attestation is authentic.
 */
export function verifyAttestation(key: AttestKey, a: unknown): string | undefined {
  if (typeof a !== "object" || a === null || Array.isArray(a)) return "attestation is not an object";
  const outer = a as Record<string, unknown>;
  if (typeof outer.tag !== "string" || !SHA256.test(outer.tag)) return "invalid attestation tag";
  const shapeErr = validatePayloadShape(outer.payload);
  if (shapeErr) return shapeErr;
  const payload = outer.payload as AttestPayload;
  const material = KEY_MATERIAL.get(key);
  if (material === undefined) return "the ledger attestation key is not usable";
  const expect = createHmac("sha256", material).update(canonical(payload)).digest();
  const got = Buffer.from(outer.tag, "hex");
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) {
    return "attestation tag does not verify (forged, altered, replayed from another ledger, or the payload was edited on disk)";
  }
  return undefined;
}

/** Every field must be COMPLETE and well-typed before it can be canonically encoded. */
function validatePayloadShape(v: unknown): string | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return "attestation payload is not an object";
  const p = v as Record<string, unknown>;
  if (p.schema !== SCHEMA) return `unknown attestation schema ${String(p.schema)}`;
  if (typeof p.kind !== "string" || !KINDS.has(p.kind)) return "invalid attestation kind";
  if (typeof p.ledgerEpoch !== "string" || p.ledgerEpoch.length < 32 || !HEX.test(p.ledgerEpoch)) return "invalid attestation ledgerEpoch";
  if (typeof p.runNonce !== "string" || p.runNonce.length < 32 || !HEX.test(p.runNonce)) return "invalid attestation runNonce";
  if (typeof p.callId !== "string" || !p.callId) return "invalid attestation callId";
  if (typeof p.callNonce !== "string" || p.callNonce.length < 32 || !HEX.test(p.callNonce)) return "invalid attestation callNonce";
  if (typeof p.reservationId !== "string" || p.reservationId.length < 32 || !HEX.test(p.reservationId)) return "invalid attestation reservationId";
  if (typeof p.routeEpoch !== "number" || !Number.isInteger(p.routeEpoch) || p.routeEpoch < 0) return "invalid attestation routeEpoch";
  if (typeof p.provider !== "string" || !p.provider) return "invalid attestation provider";
  if (typeof p.model !== "string" || !p.model) return "invalid attestation model";
  if (typeof p.providerKind !== "string" || !p.providerKind) return "invalid attestation providerKind";
  if (typeof p.attempt !== "number" || !Number.isInteger(p.attempt) || p.attempt < 0) return "invalid attestation attempt";
  if (typeof p.scopeBackend !== "string" || !BACKENDS.has(p.scopeBackend)) return "invalid attestation scopeBackend";
  if (typeof p.scopeId !== "string") return "invalid attestation scopeId";
  // The id must PARSE as a scope this system can own (a pgid, or a named+inode-pinned cgroup) …
  const scope = parseScopeId(p.scopeId) as ScopeRef | undefined;
  if (!scope) return "invalid attestation scopeId (it does not name an owned process scope)";
  // … it must be the backend the payload claims (so a weak pgid proof can never pose as a contained one) …
  if (scope.backend !== p.scopeBackend) return "invalid attestation scopeId (it does not match the attested scope backend)";
  // … and the proof must be EXACTLY the one this scope's identity derives. Nothing else is a proof: not a
  // reason, not a well-formed proof for a different scope, not the proof for a different backend.
  if (p.scopeReapProof !== reapProofOf(scope)) return "invalid attestation scopeReapProof (it must be the proof naming this exact scope)";
  if (typeof p.transcriptDev !== "string" || !DEC.test(p.transcriptDev)) return "invalid attestation transcriptDev";
  if (typeof p.transcriptIno !== "string" || !DEC.test(p.transcriptIno)) return "invalid attestation transcriptIno";
  if (typeof p.transcriptSha256 !== "string" || !SHA256.test(p.transcriptSha256)) return "invalid attestation transcriptSha256";
  if (typeof p.transcriptBytes !== "number" || !Number.isInteger(p.transcriptBytes) || p.transcriptBytes <= 0) return "invalid attestation transcriptBytes";
  if (typeof p.terminalSha256 !== "string" || !SHA256.test(p.terminalSha256)) return "invalid attestation terminalSha256";
  if (typeof p.terminalBytes !== "number" || !Number.isInteger(p.terminalBytes) || p.terminalBytes <= 0) return "invalid attestation terminalBytes";
  if (typeof p.terminalOffset !== "number" || !Number.isInteger(p.terminalOffset) || p.terminalOffset < 0) return "invalid attestation terminalOffset";
  if (p.terminalOffset + p.terminalBytes > p.transcriptBytes) {
    return "invalid attestation terminal evidence (the frame does not lie within the transcript it pins)";
  }
  // The limit frame is present EXACTLY on a trusted-fallback receipt, and must also be locatable.
  const hasLimit = p.limitSha256 !== undefined || p.limitBytes !== undefined || p.limitOffset !== undefined;
  if (p.kind === "trusted-fallback") {
    if (!hasLimit) return "a trusted-fallback attestation MUST pin the canonical rate_limit_event frame that authorized it";
    if (typeof p.limitSha256 !== "string" || !SHA256.test(p.limitSha256)) return "invalid attestation limitSha256";
    if (typeof p.limitBytes !== "number" || !Number.isInteger(p.limitBytes) || p.limitBytes <= 0) return "invalid attestation limitBytes";
    if (typeof p.limitOffset !== "number" || !Number.isInteger(p.limitOffset) || p.limitOffset < 0) return "invalid attestation limitOffset";
    if (p.limitOffset + p.limitBytes > p.transcriptBytes) {
      return "invalid attestation limit evidence (the rate_limit_event frame does not lie within the transcript it pins)";
    }
  } else if (hasLimit) {
    return "an accounted-terminal attestation must NOT carry a rate_limit_event frame (it authorizes no fallback)";
  }
  if (typeof p.usdNano !== "string" || !NANO.test(p.usdNano)) return "invalid attestation usdNano";
  if (typeof p.costProvenance !== "string" || !PROVENANCE.has(p.costProvenance)) return "invalid attestation costProvenance";
  // An UNKNOWN cost is never a charged amount: it retains the worst case, so it must carry no money.
  if (p.costProvenance === "unknown" && p.usdNano !== "0") return "an attestation with unknown cost provenance must charge nothing";
  if (typeof p.ts !== "string" || !p.ts) return "invalid attestation ts";
  return undefined;
}

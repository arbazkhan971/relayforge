import { createStreamingNormalizer, type FrameBytes, type NormalizedTurn, type ProviderKind, type StreamingNormalizer } from "./normalize.js";
import {
  AcpV1SessionCodec,
  AcpV1TurnCodec,
  AcpCancelStateMachine,
  serializeAcpPermissionResponse,
  serializeAcpNewSession,
  serializeAcpPrompt,
  type AcpRequestId
} from "./adapters/acp-v1.js";
import {
  PiRpcSessionCodec,
  PiRpcTurnCodec,
  PiCancelStateMachine,
  serializePiGetSessionStats,
  serializePiPrompt
} from "./adapters/pi-rpc.js";
import { createAdapterReplayBinding } from "./adapters/registry.js";
import { claudeAdapterDescriptor } from "./adapters/builtins/claude.js";
import { codexAdapterDescriptor } from "./adapters/builtins/codex.js";
import { customAdapterDescriptor } from "./adapters/builtins/custom.js";
import { geminiAdapterDescriptor } from "./adapters/builtins/gemini.js";
import { grokAdapterDescriptor } from "./adapters/builtins/grok.js";
import { decodeGrokInitializeResponse } from "./adapters/grok-acp.js";
import { opencodeAdapterDescriptor } from "./adapters/builtins/opencode.js";
import { piAdapterDescriptor } from "./adapters/builtins/pi.js";
import type {
  AdapterDescriptor,
  AdapterReplayBinding,
  AdapterReplayBindingInput
} from "./adapters/types.js";
import type {
  AdapterTerminalResult,
  CodecFrame,
  NormalizedAdapterEvent
} from "./adapters/codec.js";

export type AdapterProtocolCorrelation =
  | Readonly<{ kind: "oneshot"; providerKind: ProviderKind }>
  | Readonly<{ kind: "acp-v1"; sessionId: string; promptRequestId: AcpRequestId }>
  | Readonly<{
      kind: "acp-v1";
      initializeRequestId: AcpRequestId;
      newSessionRequestId: AcpRequestId;
      promptRequestId: AcpRequestId;
    }>
  | Readonly<{ kind: "pi-rpc"; sessionId: string; promptRequestId: string }>
  | Readonly<{
      kind: "pi-rpc";
      stateRequestId: string;
      statisticsBeforeRequestId: string;
      promptRequestId: string;
      statisticsAfterRequestId: string;
      cancelRequestId?: string;
    }>;

export type AdapterProtocolDriver = Readonly<{
  request:
    | Readonly<{
        kind: "acp-v1";
        cwd: string;
        promptText: string;
        sessionMeta?: Readonly<Record<string, unknown>>;
        /** Parent-owned policy; absent means deny. Persistent approvals are never selectable. */
        permissionPolicy?: "allow-once" | "deny";
      }>
    | Readonly<{ kind: "pi-rpc"; promptText: string }>;
  write(bytes: Buffer): void;
  close(): void;
}>;

/**
 * Durable identity of the exact parser grammar used for one physical call.
 * The correlation values are included because ACP/Pi replay cannot determine
 * which response/session is authoritative without the original request scope.
 */
export type AdapterCallIdentity = Readonly<{
  replay: AdapterReplayBinding;
  correlation: AdapterProtocolCorrelation;
  /** Exact canonical executable/helper evidence digest selected before reservation. */
  runtimeIdentitySha256?: string;
}>;

const SHIPPED_DESCRIPTORS: Readonly<Record<string, AdapterDescriptor>> = Object.freeze({
  claude: claudeAdapterDescriptor,
  codex: codexAdapterDescriptor,
  custom: customAdapterDescriptor,
  gemini: geminiAdapterDescriptor,
  grok: grokAdapterDescriptor,
  opencode: opencodeAdapterDescriptor,
  pi: piAdapterDescriptor
});

function boundedCorrelationId(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 512 ||
    value.includes("\0")
  ) {
    throw new TypeError(`${name} must be a bounded non-empty NUL-free string`);
  }
  return value;
}

function exactKeys(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${name} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new TypeError(`${name} must not contain symbol keys`);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.get || descriptor.set) throw new TypeError(`${name} must not contain accessors`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} must contain exactly ${expected.join(", ")}`);
  }
  return value as Record<string, unknown>;
}

function canonicalCorrelation(
  descriptor: AdapterDescriptor,
  value: AdapterProtocolCorrelation | unknown
): AdapterProtocolCorrelation {
  if (descriptor.transportKind === "oneshot-jsonl" || descriptor.transportKind === "oneshot-text") {
    const input = exactKeys(value, ["kind", "providerKind"], "adapter correlation");
    if (input.kind !== "oneshot" || input.providerKind !== descriptor.providerId) {
      throw new TypeError(`adapter ${descriptor.id} requires its matching one-shot provider dialect`);
    }
    return Object.freeze({ kind: "oneshot", providerKind: input.providerKind as ProviderKind });
  }
  if (descriptor.transportKind === "acp-v1") {
    if (value && typeof value === "object" && "sessionId" in value) {
      const input = exactKeys(value, ["kind", "sessionId", "promptRequestId"], "adapter correlation");
      if (input.kind !== "acp-v1") throw new TypeError(`adapter ${descriptor.id} requires ACP v1 correlation`);
      return Object.freeze({
        kind: "acp-v1",
        sessionId: boundedCorrelationId(input.sessionId, "ACP sessionId"),
        promptRequestId: acpCorrelationId(input.promptRequestId, "ACP promptRequestId")
      });
    }
    const input = exactKeys(value, ["kind", "initializeRequestId", "newSessionRequestId", "promptRequestId"], "adapter correlation");
    if (input.kind !== "acp-v1") throw new TypeError(`adapter ${descriptor.id} requires ACP v1 correlation`);
    const ids = [
      acpCorrelationId(input.initializeRequestId, "ACP initializeRequestId"),
      acpCorrelationId(input.newSessionRequestId, "ACP newSessionRequestId"),
      acpCorrelationId(input.promptRequestId, "ACP promptRequestId")
    ] as const;
    if (new Set(ids).size !== ids.length) throw new TypeError("ACP lifecycle request IDs must be distinct");
    return Object.freeze({ kind: "acp-v1", initializeRequestId: ids[0], newSessionRequestId: ids[1], promptRequestId: ids[2] });
  }
  if (descriptor.transportKind === "rpc-jsonl" && descriptor.codec.id === "pi-rpc-jsonl") {
    if (value && typeof value === "object" && "sessionId" in value) {
      const input = exactKeys(value, ["kind", "sessionId", "promptRequestId"], "adapter correlation");
      if (input.kind !== "pi-rpc") throw new TypeError(`adapter ${descriptor.id} requires Pi RPC correlation`);
      return Object.freeze({
        kind: "pi-rpc",
        sessionId: boundedCorrelationId(input.sessionId, "Pi sessionId"),
        promptRequestId: boundedCorrelationId(input.promptRequestId, "Pi promptRequestId")
      });
    }
    const hasCancel = Boolean(value && typeof value === "object" && "cancelRequestId" in value);
    const input = exactKeys(value, hasCancel
      ? ["kind", "stateRequestId", "statisticsBeforeRequestId", "promptRequestId", "statisticsAfterRequestId", "cancelRequestId"]
      : ["kind", "stateRequestId", "statisticsBeforeRequestId", "promptRequestId", "statisticsAfterRequestId"], "adapter correlation");
    if (input.kind !== "pi-rpc") throw new TypeError(`adapter ${descriptor.id} requires Pi RPC correlation`);
    const ids = [
      boundedCorrelationId(input.stateRequestId, "Pi stateRequestId"),
      boundedCorrelationId(input.statisticsBeforeRequestId, "Pi statisticsBeforeRequestId"),
      boundedCorrelationId(input.promptRequestId, "Pi promptRequestId"),
      boundedCorrelationId(input.statisticsAfterRequestId, "Pi statisticsAfterRequestId"),
      ...(hasCancel ? [boundedCorrelationId(input.cancelRequestId, "Pi cancelRequestId")] : [])
    ] as const;
    if (new Set(ids).size !== ids.length) throw new TypeError("Pi lifecycle request IDs must be distinct");
    return Object.freeze({
      kind: "pi-rpc",
      stateRequestId: ids[0],
      statisticsBeforeRequestId: ids[1],
      promptRequestId: ids[2],
      statisticsAfterRequestId: ids[3],
      ...(hasCancel ? { cancelRequestId: ids[4] } : {})
    });
  }
  throw new TypeError(`adapter ${descriptor.id} transport ${descriptor.transportKind} has no shipped transcript codec`);
}

function acpCorrelationId(value: unknown, name: string): AcpRequestId {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  return boundedCorrelationId(value, name);
}

/** Select and freeze the exact descriptor/wire/parser contract before reservation. */
export function createAdapterCallIdentity(
  descriptor: AdapterDescriptor,
  wireVersion: string,
  correlation: AdapterProtocolCorrelation,
  runtimeIdentitySha256?: string
): AdapterCallIdentity {
  if (runtimeIdentitySha256 !== undefined && !/^[a-f0-9]{64}$/u.test(runtimeIdentitySha256)) {
    throw new TypeError("adapter runtime identity must be a lowercase SHA-256 digest");
  }
  return Object.freeze({
    replay: createAdapterReplayBinding(descriptor, wireVersion),
    correlation: canonicalCorrelation(descriptor, correlation),
    ...(runtimeIdentitySha256 === undefined ? {} : { runtimeIdentitySha256 })
  });
}

/** Resolve untrusted durable identity only against a currently shipped exact descriptor. */
export function resolveAdapterCallIdentity(value: AdapterCallIdentity | unknown): AdapterCallIdentity {
  const hasRuntime = Boolean(value && typeof value === "object" && "runtimeIdentitySha256" in value);
  const input = exactKeys(value, hasRuntime ? ["replay", "correlation", "runtimeIdentitySha256"] : ["replay", "correlation"], "adapter call identity");
  const replay = exactKeys(input.replay, ["adapterId", "contractVersion", "transportKind", "wireVersion", "codec", "normalizer"], "adapter replay binding");
  const descriptor = SHIPPED_DESCRIPTORS[String(replay.adapterId)];
  if (!descriptor) throw new TypeError(`unknown shipped adapter ${JSON.stringify(replay.adapterId)}`);
  const candidate = replay as unknown as AdapterReplayBindingInput;
  const expected = createAdapterReplayBinding(descriptor, String(replay.wireVersion));
  if (
    candidate.adapterId !== expected.adapterId ||
    candidate.contractVersion !== expected.contractVersion ||
    candidate.transportKind !== expected.transportKind ||
    candidate.wireVersion !== expected.wireVersion ||
    candidate.codec?.id !== expected.codec.id ||
    candidate.codec?.version !== expected.codec.version ||
    candidate.normalizer?.id !== expected.normalizer.id ||
    candidate.normalizer?.version !== expected.normalizer.version
  ) {
    throw new TypeError(`adapter ${descriptor.id} replay binding does not match the shipped descriptor`);
  }
  const runtimeIdentitySha256 = hasRuntime ? boundedCorrelationId(input.runtimeIdentitySha256, "adapter runtimeIdentitySha256") : undefined;
  if (runtimeIdentitySha256 !== undefined && !/^[a-f0-9]{64}$/u.test(runtimeIdentitySha256)) {
    throw new TypeError("adapter runtimeIdentitySha256 must be a lowercase SHA-256 digest");
  }
  return Object.freeze({
    replay: expected,
    correlation: canonicalCorrelation(descriptor, input.correlation),
    ...(runtimeIdentitySha256 === undefined ? {} : { runtimeIdentitySha256 })
  });
}

export function sameAdapterCallIdentity(left: AdapterCallIdentity, right: AdapterCallIdentity): boolean {
  const a = left.replay;
  const b = right.replay;
  if (
    a.adapterId !== b.adapterId ||
    a.contractVersion !== b.contractVersion ||
    a.transportKind !== b.transportKind ||
    a.wireVersion !== b.wireVersion ||
    a.codec.id !== b.codec.id ||
    a.codec.version !== b.codec.version ||
    a.normalizer.id !== b.normalizer.id ||
    a.normalizer.version !== b.normalizer.version ||
    left.correlation.kind !== right.correlation.kind ||
    left.runtimeIdentitySha256 !== right.runtimeIdentitySha256
  ) return false;
  if (left.correlation.kind === "oneshot" && right.correlation.kind === "oneshot") {
    return left.correlation.providerKind === right.correlation.providerKind;
  }
  if (left.correlation.kind === "acp-v1" && right.correlation.kind === "acp-v1") {
    if ("sessionId" in left.correlation && "sessionId" in right.correlation) {
      return left.correlation.sessionId === right.correlation.sessionId &&
        left.correlation.promptRequestId === right.correlation.promptRequestId;
    }
    if (!("initializeRequestId" in left.correlation) || !("initializeRequestId" in right.correlation)) return false;
    return left.correlation.initializeRequestId === right.correlation.initializeRequestId &&
      left.correlation.newSessionRequestId === right.correlation.newSessionRequestId &&
      left.correlation.promptRequestId === right.correlation.promptRequestId;
  }
  if (left.correlation.kind === "pi-rpc" && right.correlation.kind === "pi-rpc") {
    if ("sessionId" in left.correlation && "sessionId" in right.correlation) {
      return left.correlation.sessionId === right.correlation.sessionId &&
        left.correlation.promptRequestId === right.correlation.promptRequestId;
    }
    if (!("stateRequestId" in left.correlation) || !("stateRequestId" in right.correlation)) return false;
    return left.correlation.stateRequestId === right.correlation.stateRequestId &&
      left.correlation.statisticsBeforeRequestId === right.correlation.statisticsBeforeRequestId &&
      left.correlation.promptRequestId === right.correlation.promptRequestId &&
      left.correlation.statisticsAfterRequestId === right.correlation.statisticsAfterRequestId &&
      left.correlation.cancelRequestId === right.correlation.cancelRequestId;
  }
  return false;
}

/**
 * HARD ceiling on ONE stdout record (frame), in RAW WIRE BYTES — shared by the LIVE transport and by the
 * ledger's re-derivation of a durable transcript, so the two can never disagree about what was framable.
 * If the ledger replayed a transcript under a different ceiling, a record the transport accepted could be
 * fatal on replay (or vice versa), and the money authority would diverge from the turn that earned it.
 */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;
export const MAX_STREAM_BYTES = 512 * 1024 * 1024;
export const MAX_STREAM_FRAMES = 1_000_000;

/**
 * ONE bounded raw stdout pipeline (wave-8d independent audit, findings A1/A2/A3).
 *
 * The wave-8d code had TWO line splitters (one for the display tail, one for the authority), each
 * retaining `Buffer.subarray()` views per arriving fragment, and it handed the cap-sized PREFIX of an
 * oversized record to the protocol normalizer. Three structural failures followed:
 *
 *   A1  the prefix of an oversized record can itself be a COMPLETE, VALID terminal JSON object (the
 *       real record just had one more byte). The normalizer therefore reported `success: true` /
 *       `hasTerminal: true` for a record that was never framed — an oversized stream could expose
 *       acceptance, cost and fallback authority. Overflow must be a TYPED FATAL: no bytes of the
 *       offending record ever reach the normalizer, and no verdict is produced at all.
 *   A2  one retained `subarray` per fragment meant retention scaled with the NUMBER OF EVENTS and each
 *       view pinned its whole source `ArrayBuffer` (a 512-byte residual of a 64 MiB read pinned 64 MiB).
 *       Retention here is COPIED into fixed slabs whose total is bounded by the configured byte limit,
 *       independent of event count and source-buffer size.
 *   A3  the tail and the authority decoded every line twice and disagreed on budget. Here ONE framer
 *       decodes each accepted frame exactly once and fans the SAME string to both sinks, so agreement is
 *       structural. The framer runs even when there is no normalizer.
 */

/** A framing FATAL: the stream can no longer be interpreted, so the turn carries NO protocol authority
 *  (no terminal, no success, no explicit limit, no cost, no fallback). It is uncertainty, not a verdict. */
export type FrameFatal = {
  kind: "oversize" | "total-limit" | "frame-count-limit";
  /** The configured byte/frame ceiling. Retained names preserve the v1 transport API. */
  limitBytes: number;
  /** Observed raw bytes/frames before we stopped (always > limitBytes). */
  observedBytes: number;
  detail: string;
};

/** Slab granularity for retained frame bytes. Frames are copied into slabs (never referenced), so a
 *  one-byte-per-event child cannot amplify retention and a huge source buffer cannot be pinned. */
const SLAB_BYTES = 64 * 1024;

/** Absolute ceiling on the NUMBER of complete frames the display tail retains, so a newline flood
 *  (millions of 1-char records) can neither grow the deque without bound nor cost O(n) per eviction. */
const MAX_TAIL_FRAMES = 50_000;

const EMPTY = Buffer.alloc(0);

/** Limits are load-bearing: a NaN/Infinity/zero/negative/fractional ceiling would silently disable the
 *  bound it exists to enforce. Reject it at construction rather than discovering it at 70 MiB. */
function assertLimit(name: string, v: number): void {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) {
    throw new TypeError(`${name} must be a positive safe integer (got ${String(v)})`);
  }
}

/**
 * THE raw framer. Splits a byte stream on `0x0a` with the size decision made on RAW WIRE BYTES, copies
 * the frame in progress into bounded slabs, and decodes each ACCEPTED frame exactly once at its
 * boundary (so a multi-byte character split across chunks is reassembled before decoding, and malformed
 * bytes are counted as the bytes they are — never as re-encoded U+FFFD).
 *
 * A frame that reaches `maxFrameBytes + 1` is FATAL: nothing is emitted (not even a bounded prefix),
 * everything retained is dropped, and the framer accepts nothing further.
 */
/**
 * ONE frame the framer ACCEPTED, handed to every sink together.
 *
 * `raw` is the frame's exact wire bytes (its terminating newline excluded). It is a view into slabs the
 * framer is about to reuse — it is valid ONLY for the duration of the synchronous sink call. A sink may
 * HASH it; a sink must never retain it (that would reintroduce the A2 retention bug).
 */
export type AcceptedFrame = FrameBytes & {
  /** The frame decoded exactly once, at its boundary, and fanned identically to every sink. */
  text: string;
  /** Whether the frame ended at a newline (false only for the final, unterminated frame). */
  terminated: boolean;
};

export class RawFramer {
  private full: Buffer[] = []; // filled slabs
  private cur: Buffer | undefined; // partially filled slab
  /** One inactive first-slab allocation. It is never populated from source views and is unavailable
   *  while an emitted raw view is leased to `onFrame`. This cached capacity is not logically retained
   *  frame data: `held` remains exact, and `held + cached capacity` is bounded by
   *  `maxFrameBytes + min(SLAB_BYTES, maxFrameBytes)`. */
  private cachedSmallSlab: Buffer | undefined;
  private curLen = 0;
  private held = 0; // retained bytes of the frame in progress — never exceeds maxFrameBytes
  private seen = 0; // EXACT raw bytes of the frame in progress (may exceed the cap by 1, then fatal)
  private fatalState: FrameFatal | undefined;
  private finished = false;
  /** Raw bytes of the stream CONSUMED by already-emitted frames (their content + terminating newline).
   *  The offset of the next frame's first byte in the stdout stream — and therefore in the transcript,
   *  which the transport writes from those same bytes in the same order. */
  private consumed = 0;
  private frameIndex = 0;
  private totalBytes = 0;
  private readonly maxTotalBytes: number;
  private readonly maxFrames: number;

  constructor(
    private readonly maxFrameBytes: number,
    private readonly onFrame: (frame: AcceptedFrame) => void,
    bounds: Readonly<{ maxTotalBytes?: number; maxFrames?: number }> = {}
  ) {
    assertLimit("maxFrameBytes", maxFrameBytes);
    this.maxTotalBytes = bounds.maxTotalBytes ?? MAX_STREAM_BYTES;
    this.maxFrames = bounds.maxFrames ?? Number.MAX_SAFE_INTEGER;
    assertLimit("maxTotalBytes", this.maxTotalBytes);
    assertLimit("maxFrames", this.maxFrames);
  }

  /** Feed raw child bytes. A no-op after a fatal or after `finish()` (push-after-finish is safe). */
  push(chunk: Buffer): void {
    if (this.fatalState !== undefined || this.finished || chunk.length === 0) return;
    const remaining = this.maxTotalBytes - this.totalBytes;
    const acceptedLength = Math.min(chunk.length, remaining);
    const accepted = acceptedLength === chunk.length ? chunk : chunk.subarray(0, acceptedLength);
    this.totalBytes += acceptedLength;
    let start = 0;
    for (;;) {
      const nl = accepted.indexOf(0x0a, start); // scan the RAW bytes; never decoded text
      if (nl < 0) break;
      if (!this.take(accepted, start, nl)) return; // fatal on a TERMINATED frame → retain/scan nothing more
      if (!this.emit(true)) return;
      start = nl + 1;
    }
    if (start < accepted.length && !this.take(accepted, start, accepted.length)) return;
    if (acceptedLength < chunk.length) {
      this.fail(
        "total-limit",
        this.maxTotalBytes,
        this.maxTotalBytes + 1,
        `stdout exceeded the ${this.maxTotalBytes}-byte total stream limit (framing failed → UNCERTAIN; no protocol authority)`
      );
    }
  }

  /** Copy `chunk[from,to)` into the frame's slabs. Returns false once the frame has gone fatal. */
  private take(chunk: Buffer, from: number, to: number): boolean {
    const len = to - from;
    if (len === 0) return true;
    this.seen += len;
    if (this.seen > this.maxFrameBytes) {
      this.fail(
        "oversize",
        this.maxFrameBytes,
        this.seen,
        `stdout record exceeded the ${this.maxFrameBytes}-byte frame limit (framing failed → UNCERTAIN; no protocol authority)`
      );
      return false;
    }
    let off = from;
    while (off < to) {
      if (this.cur === undefined) this.allocSlab();
      const slab = this.cur!;
      const n = Math.min(slab.length - this.curLen, to - off);
      chunk.copy(slab, this.curLen, off, off + n); // COPY — a retained view would pin `chunk`'s backing store
      this.curLen += n;
      this.held += n;
      off += n;
      if (this.curLen === slab.length) {
        this.full.push(slab);
        this.cur = undefined;
        this.curLen = 0;
      }
    }
    return true;
  }

  /** Allocate the next slab, never larger than the bytes still permitted — so the TOTAL retained across
   *  all slabs is bounded by `maxFrameBytes` exactly, whatever the chunk sizes or event count. */
  private allocSlab(): void {
    const remaining = this.maxFrameBytes - this.held; // > 0: held === max would have gone fatal above
    const size = Math.min(SLAB_BYTES, remaining);
    if (this.cachedSmallSlab !== undefined && this.cachedSmallSlab.length === size) {
      this.cur = this.cachedSmallSlab;
      this.cachedSmallSlab = undefined; // leased to the live frame until its callback has returned
    } else {
      this.cur = Buffer.allocUnsafe(size);
    }
    this.curLen = 0;
  }

  /** Assemble one accepted frame and identify a directly exposed single slab, if any. Multi-slab
   *  records retain the existing concatenate-and-release path. */
  private assemble(): { raw: Buffer; leasedSlab?: Buffer } {
    if (this.held === 0) return { raw: EMPTY };
    if (this.full.length === 0) {
      const slab = this.cur!;
      return { raw: slab.subarray(0, this.curLen), leasedSlab: slab }; // single-slab fast path
    }
    if (this.full.length === 1 && this.curLen === 0) {
      const slab = this.full[0];
      return { raw: slab, leasedSlab: slab }; // exactly one full slab is still a single-slab frame
    }
    const parts = this.curLen > 0 ? [...this.full, this.cur!.subarray(0, this.curLen)] : this.full;
    return { raw: Buffer.concat(parts, this.held) };
  }

  private reset(): void {
    this.full = [];
    this.cur = undefined;
    this.curLen = 0;
    this.held = 0;
    this.seen = 0;
  }

  /** Decode the frame ONCE and fan the identical string — and its exact raw bytes and stream offset —
   *  to every sink. The offset accounting is exact: every byte of the stream belongs to exactly one
   *  frame or to the newline that terminates it. */
  private emit(terminated: boolean): boolean {
    if (this.frameIndex >= this.maxFrames) {
      this.fail(
        "frame-count-limit",
        this.maxFrames,
        this.frameIndex + 1,
        `stdout exceeded the ${this.maxFrames}-frame stream limit (framing failed → UNCERTAIN; no protocol authority)`
      );
      return false;
    }
    const { raw, leasedSlab } = this.assemble();
    const text = raw.toString("utf8");
    const offset = this.consumed;
    const index = this.frameIndex++;
    this.consumed += raw.length + (terminated ? 1 : 0);
    this.reset(); // clear live framing state BEFORE the sink runs, so reentrant push() starts a new frame
    // A directly exposed slab remains leased and unavailable for reuse throughout this synchronous call.
    // Reentrant push() therefore cannot overwrite `raw`; after return (or throw), one spare is cached.
    try {
      this.onFrame({ text, terminated, raw, offset, index });
    } finally {
      if (leasedSlab !== undefined && this.cachedSmallSlab === undefined) {
        // A reentrant frame may already have returned its own slab. Preserve that cached slab and drop
        // this one rather than making an outer callback's still-live bytes available during the lease.
        this.cachedSmallSlab = leasedSlab;
      }
    }
    return true;
  }

  /** A record exceeded the ceiling. This is FATAL uncertainty: we emit NOTHING (a bounded prefix could
   *  be a complete, valid terminal record — the wave-8d A1 contradiction), drop everything retained, and
   *  stop accepting bytes. The caller reaps the child and fails the turn closed. */
  private fail(kind: FrameFatal["kind"], limit: number, observed: number, detail: string): void {
    this.fatalState = {
      kind,
      limitBytes: limit,
      observedBytes: observed,
      detail
    };
    this.reset(); // never retain, never emit, never parse a byte of it
  }

  /** Flush the final UNTERMINATED frame through the same path. Idempotent. */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    if (this.fatalState !== undefined) return; // nothing retained; a prefix is never emitted
    if (this.held > 0) this.emit(false);
  }

  fatal(): FrameFatal | undefined {
    return this.fatalState;
  }

  /** Bytes of the frame in progress currently held in slabs. Bounded by `maxFrameBytes` at every
   *  instant, whatever the chunk sizes or the number of events — the GC-free statement of the A2
   *  invariant (the slabs are COPIES, so nothing else is transitively retained either). */
  retainedBytes(): number {
    return this.held;
  }
}

/**
 * The DISPLAY tail: recent complete frames plus the final unterminated one, strictly bounded by a
 * character budget that INCLUDES the unterminated tail (wave-8d A3: the old trim kept the last complete
 * line PLUS a newer unterminated tail, so it could retain ~2× the hard cap).
 *
 * It is display/diagnostic only. It carries NO authority — the normalizer sees every frame the framer
 * accepts, whatever the tail evicts.
 */
export class BoundedTail {
  private frames: string[] = []; // complete frames, each retaining its trailing "\n"
  private head = 0; // deque head (evict by advancing — O(1), never Array.shift)
  private chars = 0; // retained characters, decremented on eviction (never rescanned)
  private tail = ""; // the final UNTERMINATED frame

  constructor(
    private readonly cap: number,
    private readonly maxFrames = MAX_TAIL_FRAMES
  ) {
    assertLimit("tailCap", cap);
    assertLimit("maxFrames", maxFrames);
  }

  private live(): number {
    return this.frames.length - this.head;
  }

  /** Retained units = complete frames + the unterminated tail (if any). */
  private units(): number {
    return this.live() + (this.tail === "" ? 0 : 1);
  }

  accept(text: string, terminated: boolean): void {
    if (terminated) {
      const withNl = `${text}\n`;
      this.frames.push(withNl);
      this.chars += withNl.length;
    } else {
      this.chars -= this.tail.length; // a re-flushed tail replaces, never accumulates
      this.tail = text;
      this.chars += text.length;
    }
    this.trim();
  }

  private trim(): void {
    // Evict the OLDEST complete frames while over budget (or over the frame quota), down to one unit.
    while (this.units() > 1 && (this.chars > this.cap || this.live() > this.maxFrames)) {
      if (this.live() === 0) break;
      this.chars -= this.frames[this.head].length;
      this.head++;
    }
    if (this.head > 4096 && this.head * 2 > this.frames.length) {
      this.frames = this.frames.slice(this.head); // compact so the dead prefix cannot grow without bound
      this.head = 0;
    }
    // A SINGLE remaining unit larger than the whole budget is truncated to its newest `cap` characters.
    // The budget is a hard ceiling: the tail never retains more than it was configured to.
    if (this.chars <= this.cap) return;
    if (this.tail !== "") {
      this.tail = this.tail.slice(this.tail.length - this.cap);
      this.chars = this.tail.length;
      if (this.live() > 0) {
        // The truncated tail alone fills the budget — the older complete frame cannot also be kept.
        this.chars -= this.frames[this.head].length;
        this.head++;
      }
    } else if (this.live() === 1) {
      const only = this.frames[this.head];
      const kept = only.slice(only.length - this.cap);
      this.frames[this.head] = kept;
      this.chars = kept.length;
    }
  }

  value(): string {
    return this.frames.slice(this.head).join("") + this.tail;
  }
}

/** What the stdout pipeline concluded. A `fatal` outcome carries NO verdict — ever. */
export type StreamOutcome = {
  fatal?: FrameFatal;
  /** The whole-stream protocol verdict. Undefined when the stream went fatal (framing failure ⇒ no
   *  terminal/success/limit/cost/fallback authority) or when no provider normalizer was supplied. */
  verdict?: NormalizedTurn;
  /** Exact structured ACP/Pi terminal derived by the selected shipped codec. */
  adapterResult?: AdapterTerminalResult;
  /** Canonical replay identity that selected the parser for this stream. */
  adapterIdentity?: AdapterCallIdentity;
  /** The bounded display tail. */
  tail: string;
  /** Frames the framer accepted and fanned to both sinks. */
  frames: number;
};

/**
 * The ONE stdout pipeline: raw bytes in, one framer, one decode per frame, two sinks (bounded display
 * tail + optional protocol normalizer), one typed outcome. It frames — and therefore bounds memory —
 * even when no normalizer is attached.
 */
export class StdoutStream {
  private readonly framer: RawFramer;
  private readonly tail: BoundedTail;
  private readonly norm: StreamingNormalizer | undefined;
  private readonly adapterCodec: Readonly<{
    push(frame: CodecFrame): readonly NormalizedAdapterEvent[];
    finish(): AdapterTerminalResult;
  }> | undefined;
  private readonly adapterIdentity: AdapterCallIdentity | undefined;
  private requestAdapterCancel: (() => boolean) | undefined;
  private frames = 0;
  private outcome: StreamOutcome | undefined;

  constructor(opts: {
    maxFrameBytes: number;
    maxTotalBytes?: number;
    maxFrames?: number;
    tailCap: number;
    normalizer?: StreamingNormalizer;
    adapter?: AdapterCallIdentity;
    onAdapterEvent?: (event: NormalizedAdapterEvent) => void;
    protocolDriver?: AdapterProtocolDriver;
  }) {
    if (opts.normalizer && opts.adapter) throw new TypeError("stdout stream must select either a legacy normalizer or an adapter identity");
    this.adapterIdentity = opts.adapter ? resolveAdapterCallIdentity(opts.adapter) : undefined;
    if (this.adapterIdentity?.correlation.kind === "oneshot") {
      this.norm = createStreamingNormalizer(this.adapterIdentity.correlation.providerKind);
    } else {
      this.norm = opts.normalizer;
    }
    const emit = opts.onAdapterEvent
      ? (event: NormalizedAdapterEvent) => {
          try {
            opts.onAdapterEvent!(event);
          } catch {
            // Observation cannot mutate protocol or settlement authority.
          }
        }
      : undefined;
    if (this.adapterIdentity?.correlation.kind === "acp-v1") {
      const correlation = this.adapterIdentity.correlation;
      if ("sessionId" in correlation) {
        this.adapterCodec = new AcpV1TurnCodec({
          sessionId: correlation.sessionId,
          promptRequestId: correlation.promptRequestId,
          onEvent: emit
        });
      } else {
        const driver = opts.protocolDriver;
        if (driver && driver.request.kind !== "acp-v1") throw new TypeError("ACP identity requires an ACP protocol driver");
        let cancel: AcpCancelStateMachine | undefined;
        let cancelPending = false;
        if (driver) {
          this.requestAdapterCancel = () => {
            cancelPending = true;
            const request = cancel?.request();
            if (request?.outbound) driver.write(request.outbound);
            return true;
          };
        }
        this.adapterCodec = new AcpV1SessionCodec({
          initializeRequestId: correlation.initializeRequestId,
          newSessionRequestId: correlation.newSessionRequestId,
          promptRequestId: correlation.promptRequestId,
          ...(this.adapterIdentity.replay.adapterId === "grok"
            ? { decodeInitializeResponse: decodeGrokInitializeResponse }
            : {}),
          onEvent: (event) => {
            emit?.(event);
            if (driver && event.kind === "permission") {
              const allow = driver.request.kind === "acp-v1" &&
                driver.request.permissionPolicy === "allow-once" &&
                event.allowOnceOptionId !== undefined;
              driver.write(serializeAcpPermissionResponse({
                requestId: event.permissionId,
                outcome: allow ? "allow-once" : "cancelled",
                ...(allow ? { allowOnceOptionId: event.allowOnceOptionId } : {})
              }));
            }
          },
          onInitialized: driver ? () => driver.write(serializeAcpNewSession({
            requestId: correlation.newSessionRequestId,
            cwd: driver.request.kind === "acp-v1" ? driver.request.cwd : "",
            ...(driver.request.kind !== "acp-v1" || driver.request.sessionMeta === undefined
              ? {}
              : { meta: driver.request.sessionMeta })
          })) : undefined,
          onSessionReady: driver ? (session) => {
            driver.write(serializeAcpPrompt({
              requestId: correlation.promptRequestId,
              sessionId: session.sessionId,
              text: driver.request.kind === "acp-v1" ? driver.request.promptText : ""
            }));
            cancel = new AcpCancelStateMachine(session.sessionId);
            if (cancelPending) {
              const request = cancel.request();
              if (request.outbound) driver.write(request.outbound);
            }
          } : undefined,
          onPromptTerminal: driver ? () => driver.close() : undefined
        });
      }
    } else if (this.adapterIdentity?.correlation.kind === "pi-rpc") {
      const correlation = this.adapterIdentity.correlation;
      if ("sessionId" in correlation) {
        this.adapterCodec = new PiRpcTurnCodec({
          sessionId: correlation.sessionId,
          promptRequestId: correlation.promptRequestId,
          onEvent: emit
        });
      } else {
        const driver = opts.protocolDriver;
        if (driver && driver.request.kind !== "pi-rpc") throw new TypeError("Pi identity requires a Pi protocol driver");
        let turnReady = false;
        let cancelPending = false;
        const cancel = driver && correlation.cancelRequestId ? new PiCancelStateMachine(correlation.cancelRequestId) : undefined;
        if (driver && cancel) {
          this.requestAdapterCancel = () => {
            cancelPending = true;
            if (turnReady) {
              const request = cancel.request();
              if (request.outbound) driver.write(request.outbound);
            }
            return true;
          };
        }
        this.adapterCodec = new PiRpcSessionCodec({
          stateRequestId: correlation.stateRequestId,
          statisticsBeforeRequestId: correlation.statisticsBeforeRequestId,
          promptRequestId: correlation.promptRequestId,
          statisticsAfterRequestId: correlation.statisticsAfterRequestId,
          ...(correlation.cancelRequestId ? { cancelRequestId: correlation.cancelRequestId } : {}),
          onEvent: emit,
          onStateReady: driver ? () => driver.write(serializePiGetSessionStats(correlation.statisticsBeforeRequestId)) : undefined,
          onStatisticsReady: driver ? () => {
            driver.write(serializePiPrompt({
              requestId: correlation.promptRequestId,
              message: driver.request.kind === "pi-rpc" ? driver.request.promptText : ""
            }));
            turnReady = true;
            if (cancelPending && cancel) {
              const request = cancel.request();
              if (request.outbound) driver.write(request.outbound);
            }
          } : undefined,
          onAgentSettled: driver ? () => driver.write(serializePiGetSessionStats(correlation.statisticsAfterRequestId)) : undefined,
          onComplete: driver ? () => driver.close() : undefined
        });
      }
    }
    this.tail = new BoundedTail(opts.tailCap);
    this.framer = new RawFramer(
      opts.maxFrameBytes,
      (f) => {
        this.frames += 1;
        // The SAME decoded frame reaches both sinks. They cannot disagree about what was framed.
        this.tail.accept(f.text, f.terminated);
        // The normalizer additionally receives the frame's exact raw bytes and stream offset, so when it
        // ACCEPTS a canonical terminal record it can bind its verdict to those exact bytes (hashing them
        // in this one pass) instead of to a re-serialization of the verdict it derived.
        this.norm?.pushLine(f.text, f);
        this.adapterCodec?.push(f);
      },
      {
        maxTotalBytes: opts.maxTotalBytes,
        maxFrames: opts.maxFrames ?? (this.adapterCodec ? MAX_STREAM_FRAMES : Number.MAX_SAFE_INTEGER)
      }
    );
  }

  push(buf: Buffer): void {
    if (this.outcome !== undefined) return; // push-after-finish is safe and ignored
    this.framer.push(buf);
  }

  /** Request the adapter's one bounded cooperative cancel command; idempotent by codec state. */
  requestCancel(): boolean {
    return this.requestAdapterCancel?.() ?? false;
  }

  /** The framing fatal, decided at the exact overflowing byte — final before finalization reads it. */
  fatal(): FrameFatal | undefined {
    return this.framer.fatal();
  }

  /**
   * Re-derive a turn's verdict from the DURABLE TRANSCRIPT BYTES, through the very same framer and the
   * very same provider state machine the live stream used.
   *
   * This is what lets the ledger stop believing what a caller SAYS about a turn. The transcript is the
   * provider's exact raw stdout, fsynced and byte-verified; replaying it here re-derives the terminal
   * record, the charged cost, and the canonical `rate_limit_event` rejection — each located at a byte
   * offset in that same file — with no input from the caller at all. Because it reuses the production
   * pipeline (rather than a second, look-alike parser), a divergence between "what we accepted live" and
   * "what the durable evidence says" is structurally impossible except when the bytes themselves differ,
   * which is precisely what we want to detect.
   *
   * `pump` feeds the file's bytes in order; memory stays bounded by the framer's ceiling regardless of
   * transcript size.
   */
  static replay(providerKind: ProviderKind, pump: (push: (chunk: Buffer) => void) => void): StreamOutcome {
    const stream = new StdoutStream({
      maxFrameBytes: MAX_FRAME_BYTES,
      tailCap: 1, // the display tail carries no authority; replay needs none of it
      normalizer: createStreamingNormalizer(providerKind)
    });
    pump((chunk) => stream.push(chunk));
    return stream.finish();
  }

  /** Replay one exact durable adapter grammar through the same raw framer used live. */
  static replayAdapter(
    identity: AdapterCallIdentity,
    pump: (push: (chunk: Buffer) => void) => void
  ): StreamOutcome {
    const stream = new StdoutStream({
      maxFrameBytes: MAX_FRAME_BYTES,
      tailCap: 1,
      adapter: identity
    });
    pump((chunk) => stream.push(chunk));
    return stream.finish();
  }

  /** Finalize once (idempotent): flush the final unterminated frame, then produce the outcome. */
  finish(): StreamOutcome {
    if (this.outcome !== undefined) return this.outcome;
    this.framer.finish();
    const fatal = this.framer.fatal();
    this.outcome = {
      fatal,
      // A framing failure produces NO verdict. The normalizer may have seen a valid init (or even a
      // valid-looking record) before the fatal frame, but the stream as a whole was never framed, so it
      // can carry no acceptance, cost, or fallback authority.
      verdict: fatal !== undefined ? undefined : this.norm?.finish(),
      adapterResult: fatal !== undefined ? undefined : this.adapterCodec?.finish(),
      ...(this.adapterIdentity ? { adapterIdentity: this.adapterIdentity } : {}),
      tail: this.tail.value(),
      frames: this.frames
    };
    return this.outcome;
  }
}

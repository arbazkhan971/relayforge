import { createStreamingNormalizer, type FrameBytes, type NormalizedTurn, type ProviderKind, type StreamingNormalizer } from "./normalize.js";

/**
 * HARD ceiling on ONE stdout record (frame), in RAW WIRE BYTES — shared by the LIVE transport and by the
 * ledger's re-derivation of a durable transcript, so the two can never disagree about what was framable.
 * If the ledger replayed a transcript under a different ceiling, a record the transport accepted could be
 * fatal on replay (or vice versa), and the money authority would diverge from the turn that earned it.
 */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;

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
  kind: "oversize";
  /** The configured per-frame ceiling in raw bytes. */
  limitBytes: number;
  /** Raw bytes of the offending frame observed before we stopped retaining (always > limitBytes). */
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

  constructor(
    private readonly maxFrameBytes: number,
    private readonly onFrame: (frame: AcceptedFrame) => void
  ) {
    assertLimit("maxFrameBytes", maxFrameBytes);
  }

  /** Feed raw child bytes. A no-op after a fatal or after `finish()` (push-after-finish is safe). */
  push(chunk: Buffer): void {
    if (this.fatalState !== undefined || this.finished || chunk.length === 0) return;
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, start); // scan the RAW bytes; never decoded text
      if (nl < 0) break;
      if (!this.take(chunk, start, nl)) return; // fatal on a TERMINATED frame → retain/scan nothing more
      this.emit(true);
      start = nl + 1;
    }
    if (start < chunk.length) this.take(chunk, start, chunk.length); // fatal on an UNTERMINATED frame
  }

  /** Copy `chunk[from,to)` into the frame's slabs. Returns false once the frame has gone fatal. */
  private take(chunk: Buffer, from: number, to: number): boolean {
    const len = to - from;
    if (len === 0) return true;
    this.seen += len;
    if (this.seen > this.maxFrameBytes) {
      this.fail(this.seen);
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
  private emit(terminated: boolean): void {
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
  }

  /** A record exceeded the ceiling. This is FATAL uncertainty: we emit NOTHING (a bounded prefix could
   *  be a complete, valid terminal record — the wave-8d A1 contradiction), drop everything retained, and
   *  stop accepting bytes. The caller reaps the child and fails the turn closed. */
  private fail(observed: number): void {
    this.fatalState = {
      kind: "oversize",
      limitBytes: this.maxFrameBytes,
      observedBytes: observed,
      detail: `stdout record exceeded the ${this.maxFrameBytes}-byte frame limit (framing failed → UNCERTAIN; no protocol authority)`
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
  private frames = 0;
  private outcome: StreamOutcome | undefined;

  constructor(opts: { maxFrameBytes: number; tailCap: number; normalizer?: StreamingNormalizer }) {
    this.norm = opts.normalizer;
    this.tail = new BoundedTail(opts.tailCap);
    this.framer = new RawFramer(opts.maxFrameBytes, (f) => {
      this.frames += 1;
      // The SAME decoded frame reaches both sinks. They cannot disagree about what was framed.
      this.tail.accept(f.text, f.terminated);
      // The normalizer additionally receives the frame's exact raw bytes and stream offset, so when it
      // ACCEPTS a canonical terminal record it can bind its verdict to those exact bytes (hashing them
      // in this one pass) instead of to a re-serialization of the verdict it derived.
      this.norm?.pushLine(f.text, f);
    });
  }

  push(buf: Buffer): void {
    if (this.outcome !== undefined) return; // push-after-finish is safe and ignored
    this.framer.push(buf);
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
      tail: this.tail.value(),
      frames: this.frames
    };
    return this.outcome;
  }
}

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ADAPTER_CODEC_LIMITS,
  BoundedJsonlFramer,
  BoundedTextAccumulator,
  DeterministicCancelStateMachine,
  FrameSequenceGuard,
  codecFrameReference,
  decodeJsonFrame,
  serializeJsonLine,
  type CodecFrame
} from "../src/adapters/codec.js";

function copiedFrame(frame: CodecFrame): CodecFrame {
  return { ...frame, raw: Buffer.from(frame.raw) };
}

describe("bounded strict JSONL framing", () => {
  it("frames LF only across arbitrary UTF-8 chunk boundaries and preserves U+2028/U+2029", () => {
    const frames: CodecFrame[] = [];
    const framer = new BoundedJsonlFramer((frame) => frames.push(copiedFrame(frame)), {
      maxFrameBytes: 128,
      maxTotalBytes: 1024,
      maxFrames: 10
    });
    const bytes = Buffer.from('{"text":"a\u2028b\u2029😀"}\r\n{"ok":true}\n', "utf8");
    for (const byte of bytes) framer.push(Uint8Array.of(byte));
    framer.finish();

    expect(frames).toHaveLength(2);
    expect(Buffer.from(frames[0]!.raw).toString("utf8")).toBe('{"text":"a\u2028b\u2029😀"}\r');
    expect(frames[0]).toMatchObject({ index: 0, offset: 0, terminated: true });
    expect(frames[1]).toMatchObject({
      index: 1,
      offset: frames[0]!.raw.byteLength + 1,
      terminated: true
    });
    expect(decodeJsonFrame(frames[0]!)).toMatchObject({ status: "valid", value: { text: "a\u2028b\u2029😀" } });
    expect(framer.retainedBytes()).toBe(0);
    expect(framer.fatal()).toBeUndefined();
  });

  it("accepts an exact-cap record and emits no prefix at cap+1", () => {
    const accepted: CodecFrame[] = [];
    const exact = new BoundedJsonlFramer((frame) => accepted.push(copiedFrame(frame)), {
      maxFrameBytes: 3,
      maxTotalBytes: 20,
      maxFrames: 4
    });
    exact.push(Buffer.from("abc\n"));
    exact.finish();
    expect(accepted.map((frame) => Buffer.from(frame.raw).toString())).toEqual(["abc"]);
    expect(exact.fatal()).toBeUndefined();

    const rejected: CodecFrame[] = [];
    const over = new BoundedJsonlFramer((frame) => rejected.push(copiedFrame(frame)), {
      maxFrameBytes: 3,
      maxTotalBytes: 100,
      maxFrames: 4
    });
    over.push(Buffer.from("abc"));
    expect(over.retainedBytes()).toBe(3);
    over.push(Buffer.from("d\n{\"terminal\":true}\n"));
    over.finish();
    expect(rejected).toEqual([]);
    expect(over.retainedBytes()).toBe(0);
    expect(over.fatal()).toMatchObject({ kind: "frame-limit", limit: 3, observed: 4 });
  });

  it("distinguishes frame, total, and frame-count fatal bounds", () => {
    const frame = new BoundedJsonlFramer(() => undefined, { maxFrameBytes: 3, maxTotalBytes: 100, maxFrames: 10 });
    frame.push(Buffer.from("abcd"));
    expect(frame.fatal()).toEqual({ kind: "frame-limit", limit: 3, observed: 4, detail: "JSONL record exceeded the frame byte limit" });

    const total = new BoundedJsonlFramer(() => undefined, { maxFrameBytes: 10, maxTotalBytes: 5, maxFrames: 10 });
    total.push(Buffer.from("ok\n"));
    total.push(Buffer.from("xx\n"));
    expect(total.fatal()).toMatchObject({ kind: "total-limit", limit: 5, observed: 6 });

    const count = new BoundedJsonlFramer(() => undefined, { maxFrameBytes: 10, maxTotalBytes: 10, maxFrames: 1 });
    count.push(Buffer.from("\n\n"));
    expect(count.fatal()).toMatchObject({ kind: "frame-count-limit", limit: 1, observed: 2 });
  });

  it("reaches total-limit at the same byte and emits the same prior frames for every chunking", () => {
    const execute = (chunks: readonly Buffer[]) => {
      const frames: string[] = [];
      const framer = new BoundedJsonlFramer((accepted) => frames.push(Buffer.from(accepted.raw).toString()), {
        maxFrameBytes: 4,
        maxTotalBytes: 5,
        maxFrames: 10
      });
      for (const chunk of chunks) framer.push(chunk);
      return { frames, fatal: framer.fatal() };
    };
    const bytes = Buffer.from("a\nb\nzq");
    expect(execute([bytes])).toEqual(execute([...bytes].map((byte) => Buffer.from([byte]))));
    expect(execute([bytes])).toEqual({
      frames: ["a", "b"],
      fatal: { kind: "total-limit", limit: 5, observed: 6, detail: "JSONL stream exceeded the total byte limit" }
    });
  });

  it("flushes one final unterminated record exactly once and ignores pushes after finish", () => {
    const frames: CodecFrame[] = [];
    const framer = new BoundedJsonlFramer((frame) => frames.push(copiedFrame(frame)), {
      maxFrameBytes: 16,
      maxTotalBytes: 32,
      maxFrames: 4
    });
    framer.push(Buffer.from('{"ok":true}'));
    framer.finish();
    framer.finish();
    framer.push(Buffer.from("\n"));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ index: 0, offset: 0, terminated: false });
  });

  it("rejects invalid bound values and any attempt to raise a global ceiling", () => {
    for (const bounds of [
      { maxFrameBytes: 0 },
      { maxTotalBytes: Number.POSITIVE_INFINITY },
      { maxFrames: 1.5 },
      { maxFrameBytes: ADAPTER_CODEC_LIMITS.maxFrameBytes + 1 }
    ]) {
      expect(() => new BoundedJsonlFramer(() => undefined, bounds)).toThrow();
    }
  });
});

describe("total JSON frame decoding and replay references", () => {
  it("classifies empty, malformed UTF-8, malformed JSON, and non-object JSON without throwing", () => {
    const inputs: Array<[Uint8Array, string]> = [
      [Buffer.alloc(0), "empty-frame"],
      [Uint8Array.of(0xc3, 0x28), "invalid-utf8"],
      [Buffer.from("{"), "malformed-json"],
      [Buffer.from("[]"), "non-object"],
      [Buffer.from("null"), "non-object"],
      [Buffer.from("42"), "non-object"]
    ];
    for (const [raw, code] of inputs) {
      expect(decodeJsonFrame({ raw, offset: 0, index: 0, terminated: true })).toMatchObject({ status: "invalid", code });
    }
  });

  it("binds hashes and locations to exact wire bytes including CR", () => {
    const raw = Buffer.from('{"ok":true}\r');
    const frame = { raw, offset: 17, index: 3, terminated: true };
    const reference = codecFrameReference(frame);
    expect(reference).toEqual({
      sha256: createHash("sha256").update(raw).digest("hex"),
      bytes: raw.length,
      offset: 17,
      index: 3,
      terminated: true
    });
    expect(Object.isFrozen(reference)).toBe(true);
    expect(decodeJsonFrame(frame)).toMatchObject({ status: "valid", value: { ok: true }, frame: reference });
  });

  it("guards exact replay sequence and byte offsets", () => {
    const guard = new FrameSequenceGuard();
    expect(guard.accept({ raw: Buffer.from("a"), index: 0, offset: 0, terminated: true })).toBeUndefined();
    expect(guard.accept({ raw: Buffer.from("bc"), index: 1, offset: 2, terminated: false })).toBeUndefined();
    expect(guard.accept({ raw: Buffer.from("x"), index: 3, offset: 4, terminated: true })).toMatch(/expected frame index 2/);
  });

  it("serializes one canonical newline-bound object and enforces the byte cap", () => {
    expect(serializeJsonLine({ id: "req-1", type: "prompt", message: "😀" }).toString("utf8")).toBe(
      '{"id":"req-1","type":"prompt","message":"😀"}\n'
    );
    const exact = serializeJsonLine({ x: "a" }, Buffer.byteLength('{"x":"a"}\n'));
    expect(exact.toString()).toBe('{"x":"a"}\n');
    expect(() => serializeJsonLine({ x: "a" }, exact.length - 1)).toThrow(/exceeds/);
    expect(() => serializeJsonLine({ self: BigInt(1) })).toThrow(/JSONL value/);
    expect(() => serializeJsonLine({ value: Number.NaN })).toThrow(/finite/);
    expect(() => serializeJsonLine({ callback: () => undefined })).toThrow(/non-JSON/);
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, "secret", { enumerable: true, get: () => "invoked" });
    expect(() => serializeJsonLine(accessor)).toThrow(/accessors/);
  });

  it("drops all accumulated normalized text on overflow", () => {
    const text = new BoundedTextAccumulator();
    expect(text.append("a".repeat(ADAPTER_CODEC_LIMITS.maxNormalizedTextBytes))).toBe(true);
    expect(text.append("b")).toBe(false);
    expect(text.value()).toBeUndefined();
    expect(text.append("recovery-is-forbidden")).toBe(false);
  });
});

describe("deterministic cancellation race reducer", () => {
  it("sends once, is idempotent, and lets normal completion win", () => {
    const cancel = new DeterministicCancelStateMachine();
    expect(cancel.request()).toMatchObject({ accepted: true, shouldSend: true, snapshot: { phase: "accepted" } });
    expect(cancel.markSent()).toMatchObject({ phase: "sent", accepted: true, sent: true, sendCount: 1 });
    expect(cancel.request()).toMatchObject({ accepted: true, shouldSend: false, reason: "already-accepted" });
    expect(cancel.markSent().sendCount).toBe(1);
    expect(cancel.observeTerminal("success")).toMatchObject({ phase: "completion-won", terminalOutcome: "success", sendCount: 1 });
    expect(cancel.request()).toMatchObject({ accepted: false, shouldSend: false, reason: "already-terminal" });
  });

  it("distinguishes cooperative cancellation from escalation", () => {
    const cooperative = new DeterministicCancelStateMachine();
    cooperative.request();
    cooperative.markSent();
    expect(cooperative.observeTerminal("cancelled").phase).toBe("terminal-cancelled");

    const hung = new DeterministicCancelStateMachine();
    hung.request();
    hung.markSent();
    expect(hung.expire()).toMatchObject({ phase: "escalation-required", accepted: true, sent: true });
    expect(hung.request()).toMatchObject({ accepted: false, reason: "escalating" });
  });

  it("fails closed on impossible local transition sequences", () => {
    const cancel = new DeterministicCancelStateMachine();
    expect(cancel.markSent()).toMatchObject({ phase: "protocol-violation", sendCount: 0 });

    const conflicting = new DeterministicCancelStateMachine();
    conflicting.observeTerminal("success");
    expect(conflicting.observeTerminal("failure")).toMatchObject({ phase: "protocol-violation", violation: "conflicting terminal outcomes" });
  });
});

import { detectScopeCapability } from "../src/scope.js";

// The gated suites below manufacture REAL settlement evidence, which pre-creates process
// scopes (delegated cgroup subtrees). Inside the verifier jail /sys/fs/cgroup is read-only,
// so the environment cannot provide a scope at all — the same honest skip containment.test.ts
// uses. On a delegated host nothing is skipped. P0 debt: delegate the verifier's own scope
// subtree into the jail, then remove these guards.
const SCOPE_CAPABILITY = detectScopeCapability();

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { runHeadlessChild } from "../src/orchestrator.js";
import { BoundedTail, RawFramer, StdoutStream } from "../src/streaming.js";
import { createStreamingNormalizer, normalizeTurn } from "../src/normalize.js";
import type { NormalizedTurn, StreamingNormalizer } from "../src/normalize.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const EMIT = join(HERE, "fixtures", "emit-bytes.mjs");
const FLOOD_PROBE = join(HERE, "fixtures", "streaming-flood-probe.ts");
const TSX = join(HERE, "..", "node_modules", "tsx", "dist", "cli.mjs");
const PATH = process.env.PATH ?? "";

// The launch handshake journals every scope BEFORE the provider execs, so a fake context needs a real
// journal to launch at all.
const SCOPES = mkdtempSync(join(HERE, ".tmp-stream-scopes-"));
afterAll(() => rmSync(SCOPES, { recursive: true, force: true }));
let journals = 0;

function fakeCtx() {
  return { children: new Set(), ownedGroups: new Set(), loop: { cadenceMinutes: 5 }, scopesPath: join(SCOPES, `${journals++}.scopes`) } as any;
}
function tmp() {
  return mkdtempSync(join(tmpdir(), "loop-stream-"));
}

async function runFreshFloodProbe(): Promise<Readonly<{
  rssDelta: number;
  elapsedMs: number;
  transportOk: boolean;
  success: boolean;
  ownedGroups: number;
}>> {
  return await new Promise((resolveProbe, rejectProbe) => {
    const child = spawn(process.execPath, ["--expose-gc", TSX, FLOOD_PROBE], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    const maximumOutputBytes = 1024 * 1024;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectProbe(new Error("fresh streaming flood probe exceeded 120 seconds"));
    }, 120_000);
    const capture = (target: Buffer[]) => (chunk: Buffer): void => {
      bytes += chunk.byteLength;
      if (bytes > maximumOutputBytes) {
        child.kill("SIGKILL");
        rejectProbe(new Error("fresh streaming flood probe exceeded its output cap"));
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout!.on("data", capture(stdout));
    child.stderr!.on("data", capture(stderr));
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectProbe(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectProbe(new Error(`fresh streaming flood probe exited ${code ?? signal}: ${Buffer.concat(stderr).toString("utf8")}`));
        return;
      }
      try {
        resolveProbe(JSON.parse(Buffer.concat(stdout).toString("utf8")) as Awaited<ReturnType<typeof runFreshFloodProbe>>);
      } catch (error) {
        rejectProbe(new Error(`fresh streaming flood probe returned invalid JSON: ${String(error)}`));
      }
    });
  });
}

/** A normalizer that records the EXACT frames the pipeline handed it — so a test can prove the framer
 *  never PASSES a byte of an oversized record (not merely that it stops retaining them). */
function capture(): { lines: string[]; norm: StreamingNormalizer } {
  const lines: string[] = [];
  const norm: StreamingNormalizer = {
    pushLine: (l: string) => void lines.push(l),
    finish: () =>
      ({ provider: "claude", finalText: "", hasTerminal: false, success: false, explicitLimit: false, usd: 0, costReported: false }) as NormalizedTurn
  };
  return { lines, norm };
}

/** Feed `input` to one pipeline, split at `split` (0 = one whole chunk). */
function feed(input: Buffer, cap: number, split: number, tailCap = 1 << 20) {
  const { lines, norm } = capture();
  const s = new StdoutStream({ maxFrameBytes: cap, tailCap, normalizer: norm });
  const chunks = split <= 0 || split >= input.length ? [input] : [input.subarray(0, split), input.subarray(split)];
  for (const c of chunks) s.push(c);
  const out = s.finish();
  return { lines, fatal: out.fatal, verdict: out.verdict, tail: out.tail };
}

describe("Priority A — the frame ceiling is enforced on RAW INPUT BYTES", () => {
  // Gate: caps 1 and 10, exact-cap and cap+1, terminated and unterminated, one chunk and EVERY split.
  for (const cap of [1, 10]) {
    for (const terminated of [true, false]) {
      const nl = terminated ? "\n" : "";
      it(`cap=${cap} ${terminated ? "terminated" : "unterminated"}: exact cap passes, cap+1 is FATAL — at every chunk split`, () => {
        const atCap = Buffer.from("a".repeat(cap) + nl, "utf8");
        const overCap = Buffer.from("a".repeat(cap + 1) + nl, "utf8");
        for (const [input, expectFatal] of [
          [atCap, false],
          [overCap, true]
        ] as const) {
          for (let split = 0; split <= input.length; split++) {
            const r = feed(input, cap, split);
            const at = `cap=${cap} term=${terminated} over=${expectFatal} split=${split}`;
            expect(Boolean(r.fatal), at).toBe(expectFatal);
            if (expectFatal) {
              // A framing fatal passes NOTHING to the normalizer and produces NO verdict.
              expect(r.lines, at).toEqual([]);
              expect(r.verdict, at).toBeUndefined();
            } else {
              expect(r.lines, at).toEqual(["a".repeat(cap)]);
              expect(r.verdict, at).toBeDefined();
            }
            // The tail never retains more than its budget, terminated or not.
            expect(r.tail.length, at).toBeLessThanOrEqual(1 << 20);
          }
        }
      });
    }
  }

  it("a TERMINATED oversized record is fatal (a 20-byte line must not sail past a 10-byte cap)", () => {
    const r = feed(Buffer.from(`${"a".repeat(20)}\n`, "utf8"), 10, 0);
    expect(r.fatal?.kind).toBe("oversize");
    expect(r.lines).toEqual([]);
  });

  it("a single oversized chunk is never handed to the normalizer — not even a bounded prefix", () => {
    const r = feed(Buffer.alloc(1_000_000, 0x61), 10, 0); // 1 MB in ONE chunk, cap 10
    expect(r.fatal?.kind).toBe("oversize");
    expect(r.lines).toEqual([]);
    expect(r.verdict).toBeUndefined();
  });

  it("valid multibyte split across chunks decodes intact (reassembled before decoding)", () => {
    const input = Buffer.from("héllo\n", "utf8"); // 7 raw bytes: é is 2
    for (let split = 0; split <= input.length; split++) {
      const r = feed(input, 10, split);
      expect(r.fatal).toBeUndefined();
      expect(r.lines).toEqual(["héllo"]);
    }
  });

  it("MALFORMED bytes are counted as RAW bytes, never as re-encoded U+FFFD", () => {
    // 10 × 0xFF is exactly the cap → accepted (a decoded counter would see 30 bytes and falsely fail).
    const at = feed(Buffer.alloc(10, 0xff), 10, 0);
    expect(at.fatal).toBeUndefined();
    expect(at.lines).toHaveLength(1);
    expect(feed(Buffer.alloc(11, 0xff), 10, 0).fatal?.kind).toBe("oversize"); // cap + 1 → fatal
  });

  for (const [name, lead] of [
    ["2-byte", 0xc3],
    ["3-byte", 0xe2],
    ["4-byte", 0xf0]
  ] as const) {
    it(`an incomplete ${name} UTF-8 sequence at end-of-stream is counted BEFORE the trust decision`, () => {
      const over = Buffer.concat([Buffer.alloc(10, 0x61), Buffer.from([lead])]); // cap + 1 RAW bytes
      expect(feed(over, 10, 0).fatal?.kind).toBe("oversize");
      const at = Buffer.concat([Buffer.alloc(9, 0x61), Buffer.from([lead])]); // exactly the cap
      const r = feed(at, 10, 0);
      expect(r.fatal).toBeUndefined();
      expect(r.lines).toHaveLength(1);
    });
  }

  it("CRLF and blank lines are ordinary frames (\\r stays inside the frame; \\n alone terminates)", () => {
    const r = feed(Buffer.from("a\r\n\nb\r\n", "utf8"), 10, 0);
    expect(r.fatal).toBeUndefined();
    expect(r.lines).toEqual(["a\r", "", "b\r"]);
  });

  it("finish() is idempotent and push-after-finish is safe (never a second flush, never a throw)", () => {
    const { lines, norm } = capture();
    const s = new StdoutStream({ maxFrameBytes: 100, tailCap: 100, normalizer: norm });
    s.push(Buffer.from("tail-without-newline"));
    const first = s.finish();
    s.push(Buffer.from("BYTES-AFTER-FINISH"));
    const second = s.finish();
    expect(second).toBe(first); // the same outcome object; no re-finalization
    expect(lines).toEqual(["tail-without-newline"]); // flushed EXACTLY once, and never re-flushed
    expect(first.tail).toBe("tail-without-newline");
  });

  it("invalid limits are rejected at construction (a NaN/0/fractional ceiling enforces nothing)", () => {
    for (const bad of [0, -1, NaN, Infinity, 1.5, "10" as unknown as number]) {
      expect(() => new RawFramer(bad, () => {}), `maxFrameBytes=${String(bad)}`).toThrow(TypeError);
      expect(() => new BoundedTail(bad), `tailCap=${String(bad)}`).toThrow(TypeError);
    }
  });
});

describe("Priority A — reusable small slabs preserve the synchronous raw-byte lease", () => {
  it("uses O(1) slab allocations for 100,000 tiny frames while preserving exact frame metadata", () => {
    const input = Buffer.from("i\n".repeat(100_000));
    const allocUnsafe = vi.spyOn(Buffer, "allocUnsafe");
    let count = 0;
    let first: { text: string; byte: number | undefined; bytes: number; offset: number; index: number; terminated: boolean } | undefined;
    let last: typeof first;

    try {
      const framer = new RawFramer(4096, (frame) => {
        const observed = {
          text: frame.text,
          byte: frame.raw[0],
          bytes: frame.raw.length,
          offset: frame.offset,
          index: frame.index,
          terminated: frame.terminated
        };
        first ??= observed;
        last = observed;
        count++;
      });
      framer.push(input);
      framer.finish();

      expect(count).toBe(100_000);
      expect(first).toEqual({ text: "i", byte: 0x69, bytes: 1, offset: 0, index: 0, terminated: true });
      expect(last).toEqual({ text: "i", byte: 0x69, bytes: 1, offset: 199_998, index: 99_999, terminated: true });
      expect(framer.retainedBytes()).toBe(0); // cached capacity is not logically retained payload
      expect(framer.fatal()).toBeUndefined();
      expect(allocUnsafe).toHaveBeenCalledTimes(1);
      expect(allocUnsafe).toHaveBeenCalledWith(4096);
    } finally {
      allocUnsafe.mockRestore();
    }
  });

  it("does not reuse an outer callback's slab during a reentrant push", () => {
    const calls: Array<{ text: string; raw: string; offset: number; index: number }> = [];
    let framer!: RawFramer;
    framer = new RawFramer(1024, (frame) => {
      calls.push({ text: frame.text, raw: frame.raw.toString("utf8"), offset: frame.offset, index: frame.index });
      if (frame.text === "outer") {
        const beforeReentry = Buffer.from(frame.raw);
        framer.push(Buffer.from("inner\n"));
        // The outer raw view is still inside its valid synchronous lifetime and must not be overwritten.
        expect(frame.raw.equals(beforeReentry)).toBe(true);
      }
    });

    framer.push(Buffer.from("outer\n"));
    framer.push(Buffer.from("later\n"));
    framer.finish();

    expect(calls).toEqual([
      { text: "outer", raw: "outer", offset: 0, index: 0 },
      { text: "inner", raw: "inner", offset: 6, index: 1 },
      { text: "later", raw: "later", offset: 12, index: 2 }
    ]);
  });

  it("returns a slab in finally when the callback throws and remains recoverable for a later push", () => {
    const firstInput = Buffer.from("boom\n");
    const secondInput = Buffer.from("ok\n");
    const allocUnsafe = vi.spyOn(Buffer, "allocUnsafe");
    const calls: Array<{ text: string; rawByte: number | undefined; offset: number; index: number }> = [];
    let throwFirst = true;

    try {
      const framer = new RawFramer(4096, (frame) => {
        calls.push({ text: frame.text, rawByte: frame.raw[0], offset: frame.offset, index: frame.index });
        if (throwFirst) {
          throwFirst = false;
          throw new Error("sink failed");
        }
      });

      expect(() => framer.push(firstInput)).toThrow("sink failed"); // callback errors still propagate
      expect(framer.retainedBytes()).toBe(0);
      expect(framer.fatal()).toBeUndefined();
      framer.push(secondInput);
      framer.finish();

      expect(calls).toEqual([
        { text: "boom", rawByte: 0x62, offset: 0, index: 0 },
        { text: "ok", rawByte: 0x6f, offset: 5, index: 1 }
      ]);
      expect(allocUnsafe).toHaveBeenCalledTimes(1); // the thrown callback did not lose the spare lease
    } finally {
      allocUnsafe.mockRestore();
    }
  });

  it("isolates copied source bytes and a callback-mutated raw view from the next tiny frame", () => {
    const calls: Array<{ text: string; rawBeforeMutation: string; offset: number; index: number }> = [];
    const framer = new RawFramer(128, (frame) => {
      calls.push({ text: frame.text, rawBeforeMutation: frame.raw.toString("utf8"), offset: frame.offset, index: frame.index });
      if (frame.index === 0) frame.raw.fill(0x78); // mutation is confined to this valid callback window
    });
    const source = Buffer.from("first");

    framer.push(source); // retain an unterminated copy
    source.fill(0x7a); // recycling the caller's chunk must not affect the retained frame
    framer.push(Buffer.from("\n"));
    framer.push(Buffer.from("ok\n")); // overwrites the reused slab with the new exact frame
    framer.finish();

    expect(calls).toEqual([
      { text: "first", rawBeforeMutation: "first", offset: 0, index: 0 },
      { text: "ok", rawBeforeMutation: "ok", offset: 6, index: 1 }
    ]);
  });

  it("keeps multi-slab and unterminated frames owned, bounded, and exactly offset", () => {
    const cap = 64 * 1024 + 17;
    const largeSource = Buffer.alloc(cap, 0x6d);
    const largeSha256 = createHash("sha256").update(largeSource).digest("hex");
    const calls: Array<{
      textLength: number;
      rawLength: number;
      rawSha256: string;
      offset: number;
      index: number;
      terminated: boolean;
    }> = [];
    const framer = new RawFramer(cap, (frame) => {
      calls.push({
        textLength: frame.text.length,
        rawLength: frame.raw.length,
        rawSha256: createHash("sha256").update(frame.raw).digest("hex"),
        offset: frame.offset,
        index: frame.index,
        terminated: frame.terminated
      });
    });

    framer.push(largeSource);
    expect(framer.retainedBytes()).toBe(cap);
    largeSource.fill(0x78); // a multi-slab frame must not retain source subarray views
    framer.push(Buffer.from("\n"));
    expect(framer.retainedBytes()).toBe(0);

    const tailSource = Buffer.from("tail");
    framer.push(tailSource);
    expect(framer.retainedBytes()).toBe(4);
    tailSource.fill(0x79);
    framer.finish();

    expect(calls).toEqual([
      {
        textLength: cap,
        rawLength: cap,
        rawSha256: largeSha256,
        offset: 0,
        index: 0,
        terminated: true
      },
      {
        textLength: 4,
        rawLength: 4,
        rawSha256: createHash("sha256").update("tail").digest("hex"),
        offset: cap + 1,
        index: 1,
        terminated: false
      }
    ]);
    expect(framer.retainedBytes()).toBe(0);
  });

  it("still makes cap-plus-one fatal without emitting the offending prefix or accepting later input", () => {
    const calls: string[] = [];
    const framer = new RawFramer(3, (frame) => calls.push(frame.text));

    framer.push(Buffer.from("ok\n"));
    framer.push(Buffer.from("abc"));
    expect(framer.retainedBytes()).toBe(3);
    framer.push(Buffer.from("d")); // the exact first byte beyond the cap
    framer.push(Buffer.from("ignored\n"));
    framer.finish();

    expect(calls).toEqual(["ok"]);
    expect(framer.fatal()).toMatchObject({ kind: "oversize", limitBytes: 3, observedBytes: 4 });
    expect(framer.retainedBytes()).toBe(0);
  });
});

describe.skipIf(!SCOPE_CAPABILITY.strong)("Priority A — an oversized record can NEVER expose success/terminal/cost (audit A1)", () => {
  // The audit's exact repro: the oversized terminal record's cap-sized prefix is ITSELF a complete,
  // valid Claude success object. Feeding that prefix to the normalizer produced overflowed()===true
  // alongside finish().success===true, hasTerminal===true, finalText==="OK".
  const S = "S";
  const init = JSON.stringify({ type: "system", subtype: "init", session_id: S });
  const term = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "OK",
    total_cost_usd: 0.01,
    session_id: S,
    usage: { input_tokens: 1, output_tokens: 1 }
  });

  it("valid-terminal-prefix + one extra byte → typed fatal, NO verdict, NO cost, NO fallback authority", () => {
    const s = new StdoutStream({ maxFrameBytes: term.length, tailCap: 1 << 20, normalizer: createStreamingNormalizer("claude") });
    s.push(Buffer.from(`${init}\n${term} \n`)); // the space is byte cap+1 of the terminal record
    const out = s.finish();
    expect(out.fatal?.kind).toBe("oversize");
    expect(out.fatal?.limitBytes).toBe(term.length);
    expect(out.verdict).toBeUndefined(); // no success, no hasTerminal, no usd — no authority at all
  });

  it("the same case through the COMPLETE real-child transport: UNCERTAIN, no verdict, empty scope", async () => {
    const ctx = fakeCtx();
    const dir = tmp();
    const r = await runHeadlessChild(ctx, "node", [EMIT, "terminal-prefix-plus-byte"], { PATH }, "", process.cwd(), undefined, dir, 20_000, "claude", term.length);
    expect(r.transportOk).toBe(false);
    expect(r.framingFatal?.kind).toBe("oversize");
    expect(r.streamedVerdict).toBeUndefined();
    expect(r.normalized).toBeUndefined();
    expect(r.ok).toBe(false);
    expect(r.code).toBeNull();
    expect(r.uncertainReason).toMatch(/framing failed/);
    expect(ctx.ownedGroups.size).toBe(0); // the owned scope is PROVEN gone before the turn resolves
  });
});

describe("Priority A — retention is bounded by CONFIGURED BYTES, not by event count or source size", () => {
  it("500,000 one-byte pushes of an unterminated line retain O(cap), not O(events) (audit A2)", () => {
    const { norm } = capture();
    const s = new StdoutStream({ maxFrameBytes: 32 * 1024 * 1024, tailCap: 1 << 20, normalizer: norm });
    global.gc?.();
    const rss0 = process.memoryUsage().rss;
    const one = Buffer.from("a");
    for (let i = 0; i < 500_000; i++) s.push(one);
    global.gc?.();
    const delta = process.memoryUsage().rss - rss0;
    // The audit measured +85,352,448 RSS / +52,835,952 heap for this 500 KB of input.
    expect(delta, `RSS delta ${(delta / 1048576).toFixed(1)} MiB for 500 KB of one-byte events`).toBeLessThan(16 * 1024 * 1024);
    s.finish();
  });

  it("retained bytes never exceed the configured ceiling, at any event count or chunk size (GC-free)", () => {
    const cap = 8192;
    const f = new RawFramer(cap, () => {});
    const one = Buffer.from("a");
    for (let i = 0; i < 200_000; i++) {
      f.push(one);
      // The bound holds at EVERY instant — not just at the end, and not just on average.
      // Avoid 200,000 framework matcher allocations: under the full two-worker stress suite those
      // allocations alone can consume the test's deadline. This still checks every iteration and
      // reports the exact first violating sample.
      const retained = f.retainedBytes();
      if (retained > cap) throw new Error(`retained ${retained} bytes after push ${i}; cap is ${cap}`);
    }
    expect(f.fatal()?.kind).toBe("oversize"); // ...and past the ceiling it retains nothing at all
    expect(f.retainedBytes()).toBe(0);
  });

  it("retained frame bytes are COPIED, not referenced — the structural reason a source buffer cannot be pinned", () => {
    const { lines, norm } = capture();
    const s = new StdoutStream({ maxFrameBytes: 1024, tailCap: 1024, normalizer: norm });
    const src = Buffer.from("hello-world"); // an unterminated frame: its bytes MUST be retained
    s.push(src);
    src.fill(0x5a); // the child's buffer is recycled/overwritten under us
    s.finish();
    expect(lines).toEqual(["hello-world"]); // a retained VIEW would now read "ZZZZZZZZZZZ"
  });

  it("a 512-byte residual of a 64 MiB source buffer does NOT pin the source backing store (audit A2)", () => {
    const s = new StdoutStream({ maxFrameBytes: 32 * 1024 * 1024, tailCap: 4096, normalizer: undefined });
    const feedOnce = () => {
      const src = Buffer.alloc(64 * 1024 * 1024, 0x61);
      for (let off = 99; off < src.length - 512; off += 100) src[off] = 0x0a;
      s.push(src); // `src` is garbage the moment this returns — unless the pipeline retained a view of it
    };
    global.gc?.();
    const base = process.memoryUsage().arrayBuffers;
    feedOnce();
    global.gc?.();
    global.gc?.();
    const held = process.memoryUsage().arrayBuffers - base;
    // The audit: the residual `subarray` kept ~66.9 MiB of ArrayBuffer alive until EOF.
    expect(held, `arrayBuffers still retained: ${(held / 1048576).toFixed(2)} MiB`).toBeLessThan(1024 * 1024);
    s.finish();
  });

  it("parser-retained bytes stay O(maxFrameBytes) while a single line grows without end", () => {
    const cap = 4096;
    const { norm } = capture();
    const s = new StdoutStream({ maxFrameBytes: cap, tailCap: 1 << 20, normalizer: norm });
    const chunk = Buffer.alloc(1 << 16, 0x61); // 64 KiB, no newline, ever
    for (let i = 0; i < 1024; i++) s.push(chunk); // 64 MiB streamed
    expect(s.fatal()?.kind).toBe("oversize");
    const out = s.finish();
    expect(out.tail.length).toBeLessThanOrEqual(cap); // retention bounded by the cap, not the 64 MiB
    expect(out.verdict).toBeUndefined();
  });

  it("the display tail's budget INCLUDES the final unterminated frame (audit A3: cap 1 held 21 chars)", () => {
    const s = new StdoutStream({ maxFrameBytes: 10, tailCap: 1, normalizer: undefined });
    s.push(Buffer.from(`${"A".repeat(10)}\n${"B".repeat(10)}`));
    const out = s.finish();
    expect(out.tail.length).toBeLessThanOrEqual(1);
    expect(out.fatal).toBeUndefined(); // each record is within the FRAME cap; only the TAIL is bounded
  });

  it("the tail never exceeds its budget for any mix of complete and unterminated frames", () => {
    for (const cap of [1, 2, 7, 64]) {
      for (const input of ["x", "x\n", "aaaa\nbbbb\ncccc", "aaaa\nbbbb\ncccc\n", "\n\n\n", "a".repeat(200), `${"a".repeat(200)}\n`]) {
        const s = new StdoutStream({ maxFrameBytes: 1024, tailCap: cap, normalizer: undefined });
        s.push(Buffer.from(input));
        const out = s.finish();
        expect(out.tail.length, `cap=${cap} input=${JSON.stringify(input)}`).toBeLessThanOrEqual(cap);
      }
    }
  });
});

describe.skipIf(!SCOPE_CAPABILITY.strong)("Priority A — the COMPLETE real-child transport", () => {
  it("real child: an exactly-cap record is ACCEPTED and the frame, tail, and transcript agree byte-for-byte", async () => {
    const ctx = fakeCtx();
    const dir = tmp();
    const r = await runHeadlessChild(ctx, "node", [EMIT, "at-cap-nl", "64"], { PATH }, "", process.cwd(), undefined, dir, 20_000, undefined, 64);
    expect(r.transportOk).toBe(true);
    expect(r.ok).toBe(true);
    const onDisk = readFileSync(r.transcriptPath!);
    expect(onDisk.toString("utf8")).toBe(`${"a".repeat(64)}\n`);
    expect(r.stdout).toBe(onDisk.toString("utf8")); // tail == transcript: nothing lost, nothing invented
    expect(r.transcriptSha256).toBe(createHash("sha256").update(onDisk).digest("hex"));
    expect(r.transcriptBytes).toBe(onDisk.length);
    expect(ctx.ownedGroups.size).toBe(0);
  });

  it("real child: cap+1 on a TERMINATED record fails closed through the complete transport", async () => {
    const ctx = fakeCtx();
    const r = await runHeadlessChild(ctx, "node", [EMIT, "over-cap-nl", "64"], { PATH }, "", process.cwd(), undefined, undefined, 20_000, "claude", 64);
    expect(r.transportOk).toBe(false);
    expect(r.framingFatal?.kind).toBe("oversize");
    expect(r.streamedVerdict).toBeUndefined();
    expect(ctx.ownedGroups.size).toBe(0);
  });

  it("real child: cap bytes + an incomplete UTF-8 sequence → UNCERTAIN, and the exact scope is empty", async () => {
    const ctx = fakeCtx();
    const dir = tmp();
    const r = await runHeadlessChild(ctx, "node", [EMIT, "cap-plus-incomplete", "64"], { PATH }, "", process.cwd(), undefined, dir, 20_000, "claude", 64);
    expect(r.transportOk).toBe(false);
    expect(r.framingFatal?.kind).toBe("oversize");
    expect(r.ok).toBe(false);
    expect(r.code).toBeNull();
    expect(ctx.ownedGroups.size).toBe(0);
  });

  it("real child: a valid provider stream is classified from the WHOLE stream and matches a batch reparse of the transcript", async () => {
    const ctx = fakeCtx();
    const dir = tmp();
    const r = await runHeadlessChild(ctx, "node", [EMIT, "claude-tail", "0"], { PATH }, "", process.cwd(), undefined, dir, 20_000, "claude");
    expect(r.transportOk).toBe(true);
    expect(r.streamedVerdict?.success).toBe(true);
    expect(r.streamedVerdict?.finalText).toBe("CAP_OK");
    // The streamed verdict == a batch normalize of the EXACT bytes on disk (frame/transcript agreement).
    // The batch path has no wire bytes, so it produces no terminal-frame evidence — that is the ONE
    // field the two paths are allowed to differ on, and it is verified against the transcript below.
    const { terminalFrame, ...verdict } = r.streamedVerdict!;
    expect(verdict).toEqual(normalizeTurn("claude", readFileSync(r.transcriptPath!, "utf8")));

    // The terminal evidence is cryptographically tied to the EXACT accepted terminal frame and is
    // LOCATABLE in the durable transcript: read exactly [offset, offset+bytes) from the file this turn
    // hashed, and it must be that terminal record — and hash to what the receipt would carry.
    const onDisk = readFileSync(r.transcriptPath!);
    expect(createHash("sha256").update(onDisk).digest("hex")).toBe(r.transcriptSha256);
    expect(terminalFrame).toBeDefined();
    expect(terminalFrame!.offset + terminalFrame!.bytes).toBeLessThanOrEqual(r.transcriptBytes!);
    const frameBytes = onDisk.subarray(terminalFrame!.offset, terminalFrame!.offset + terminalFrame!.bytes);
    expect(createHash("sha256").update(frameBytes).digest("hex")).toBe(terminalFrame!.sha256);
    const record = JSON.parse(frameBytes.toString("utf8"));
    expect(record.type).toBe("result"); // it really is the canonical terminal record, not some other line
    expect(record.result).toBe("CAP_OK");
  });

  it("real child pacing 100,000 ONE-BYTE writes stays within a bounded RSS (audit A2: ~41.8 MiB for 100 KB)", async () => {
    const ctx = fakeCtx();
    global.gc?.();
    const rss0 = process.memoryUsage().rss;
    const r = await runHeadlessChild(ctx, "node", [EMIT, "paced-one-byte", "100000"], { PATH }, "", process.cwd(), undefined, undefined, 60_000, "claude");
    global.gc?.();
    const delta = process.memoryUsage().rss - rss0;
    expect(r.transportOk).toBe(true); // 100 KB is under the ceiling — it is junk, not a framing failure
    expect(r.streamedVerdict?.success).toBe(false); // ...and junk is never success
    expect(delta, `RSS delta ${(delta / 1048576).toFixed(1)} MiB for 100 KB paced one byte at a time`).toBeLessThan(32 * 1024 * 1024);
    expect(ctx.ownedGroups.size).toBe(0);
  }, 60_000);
});

describe.skipIf(!SCOPE_CAPABILITY.strong)("Priority A — bounded memory and time on giant records and newline floods", () => {
  for (const mode of ["giant", "giant-nl"] as const) {
    it(`a 70 MiB ${mode === "giant-nl" ? "TERMINATED" : "unterminated"} record fails closed in <10s and <128 MiB RSS delta`, async () => {
      const bytes = 70 * 1024 * 1024;
      const ctx = fakeCtx();
      global.gc?.();
      const rss0 = process.memoryUsage().rss;
      const t0 = Date.now();
      const r = await runHeadlessChild(ctx, "node", [EMIT, mode, String(bytes)], { PATH }, "", process.cwd(), undefined, undefined, 60_000, "claude");
      const elapsed = Date.now() - t0;
      const rssDelta = process.memoryUsage().rss - rss0;
      expect(r.transportOk).toBe(false);
      expect(r.framingFatal?.kind).toBe("oversize");
      expect(r.streamedVerdict).toBeUndefined(); // a framing fatal exposes NO verdict, ever
      expect(elapsed, `elapsed ${elapsed}ms`).toBeLessThan(10_000);
      expect(rssDelta, `RSS delta ${(rssDelta / 1048576).toFixed(1)} MiB`).toBeLessThan(128 * 1024 * 1024);
      expect(ctx.ownedGroups.size).toBe(0); // scope proven empty
    }, 60_000);
  }

  it("6 million short newlines stay bounded, stay fast, and are classified UNCERTAIN (no terminal record)", async () => {
    const probe = await runFreshFloodProbe();
    expect(probe.transportOk).toBe(true); // no single record exceeded the ceiling — the STREAM is just junk
    expect(probe.success).toBe(false);
    expect(probe.ownedGroups).toBe(0);
    expect(probe.rssDelta, `RSS delta ${(probe.rssDelta / 1048576).toFixed(1)} MiB`).toBeLessThan(128 * 1024 * 1024);
    expect(probe.elapsedMs, `elapsed ${probe.elapsedMs}ms`).toBeLessThan(60_000);
  }, 120_000);
});

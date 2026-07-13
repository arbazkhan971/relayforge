import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LEDGER_LEAF, openLedger } from "../src/ledger.js";
import { createStreamingNormalizer, normalizeTurn } from "../src/normalize.js";
import { StdoutStream } from "../src/streaming.js";
import { evidenceRoot, reserveAndRun, settle, settleTrusted, type GenuineRun } from "./settlement-evidence.js";

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

const { openRun, cleanup } = evidenceRoot("receipt-evidence");
afterAll(cleanup);

/**
 * WHERE THIS INVARIANT MOVED TO.
 *
 * A "receipt" used to be an object literal a caller passed to `ledger.settle()`, and `validateReceipt`
 * checked its SHAPE at the boundary: the ESRCH proof had to name the same pgid as the scope, the terminal
 * frame had to lie inside the transcript it pinned, and so on. Those were good rules, and they were
 * worthless — every field was still a CLAIM, so satisfying the validator only proved the forger had read
 * it. The type, the validator, and the `settle()` mint are all DELETED (tests/receipt-forgery.test.ts
 * proves they are gone from the runtime), so there is no longer a boundary at which a caller can present
 * bad evidence at all.
 *
 * The rules themselves did not go away — they moved to the only place they can be enforced against an
 * ATTACKER rather than against a caller: the durable journal. A settlement's authority now lives in a
 * MAC-authenticated attestation the ledger derived for itself, and the fold RE-VERIFIES it from bytes on
 * every read. So the honest test is no longer "does the validator reject this literal" but "can anyone who
 * owns the disk edit a settlement into being worth more than it is" — and the answer must be no, for every
 * one of those same evidence rules.
 *
 * Every test below therefore starts from a REAL turn: a real detached child, a real durable transcript, a
 * real process group, a real provider-reported cost, attested by the production kernel. Then the bytes are
 * attacked.
 */

/** Rewrite the journal, mutating the settle record's durable attestation and RE-CHAINING every hash so the
 *  forgery is cryptographically well-formed — exactly what an attacker with disk access would do. The hash
 *  chain will verify perfectly; only the MAC (and the payload's own shape rules) can catch it. */
function forgeOnDisk(h: GenuineRun, mutate: (settleData: Record<string, any>) => void): void {
  const leaf = join(h.boardDir, LEDGER_LEAF);
  const records = readFileSync(leaf, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const manifest = JSON.parse(readFileSync(join(h.boardDir, "reservations.manifest.json"), "utf8"));
  let tip = manifest.genesis as string;
  const out: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec.data.type === "settle") mutate(rec.data);
    rec.prev = tip;
    rec.seq = i;
    rec.hash = createHash("sha256").update(`${tip}|${i}|${JSON.stringify(rec.data)}`).digest("hex");
    tip = rec.hash;
    out.push(JSON.stringify(rec));
  }
  writeFileSync(leaf, `${out.join("\n")}\n`, { mode: 0o600 });
}

/** One genuine, attested, provider-reported $0.01 settlement — the thing every forgery below starts from. */
async function genuinelySettled(): Promise<GenuineRun> {
  const h = openRun();
  await settleTrusted(h, "c", { worstCase: 0.5, budget: 10, cost: 0.01 });
  expect(h.ledger.effectiveSpend()).toBe(0.01);
  h.ledger.close();
  return h;
}

/** What the NEXT process makes of the journal after the attack. */
function refolds(h: GenuineRun): { spend: number } | "refused" {
  let L;
  try {
    L = openLedger({ dir: h.boardDir, runNonce: h.run, transcriptRoot: h.runDir });
  } catch {
    return "refused";
  }
  try {
    return { spend: L.effectiveSpend() };
  } catch {
    return "refused";
  } finally {
    L.close();
  }
}

describe("the durable attestation's SCOPE evidence must be exact — the fold re-derives it, never trusts it", () => {
  // Each of these is a reap "proof" the old shape-validator existed to reject. They are now attacks on the
  // JOURNAL, and they must fail there: an ESRCH proof the ledger did not generate from its own probe of its
  // own pgid can never authorize a settlement, however well-formed it looks.
  for (const [name, mutate] of [
    ["an ARBITRARY nonempty proof", (p: any) => (p.scopeReapProof = "reaped")],
    ["the orchestrator's old 'unspecified' fallback", (p: any) => (p.scopeReapProof = "unspecified")],
    ["the old UNPARAMETERIZED proof", (p: any) => (p.scopeReapProof = "pgid-empty:ESRCH")],
    ["a proof naming a DIFFERENT pgid than the scope", (p: any) => (p.scopeReapProof = "pgid-empty:ESRCH:99999")],
    ["a MISSING proof", (p: any) => (p.scopeReapProof = "")],
    ["an UNSPAWNED scope claiming a reap", (p: any) => ((p.scopeId = "unspawned"), (p.scopeReapProof = "no-scope-created"))],
    ["an unstructured scope id", (p: any) => ((p.scopeId = "the-child"), (p.scopeReapProof = "pgid-empty:ESRCH:the-child"))],
    ["pgid 0 (the caller's own group)", (p: any) => ((p.scopeId = "pgid:0"), (p.scopeReapProof = "pgid-empty:ESRCH:0"))],
    ["a contradictory reason posing as proof", (p: any) => (p.scopeReapProof = "pgid 4242 still populated after close")],
    // ---- wave-10: the CONTAINMENT downgrade. A cgroup scope's proof says the kernel removed the cgroup
    // (which it permits only when nothing is left in it, anywhere); a pgid proof says only that a process
    // group stopped answering — which a `setsid` daemon makes trivially true while it runs on. Editing a
    // contained settlement into a merely-process-grouped one must fail, or the strongest claim in the
    // journal could be rewritten as the weakest one that still folds.
    [
      "a cgroup2 scope DOWNGRADED to the pgid proof of the same leader",
      (p: any) => {
        const pid = String(p.scopeId).split(":")[3];
        p.scopeBackend = "pgid";
        p.scopeId = `pgid:${pid}`;
        p.scopeReapProof = `pgid-empty:ESRCH:${pid}`;
      }
    ],
    ["a cgroup2 id wearing the `pgid` backend label", (p: any) => (p.scopeBackend = "pgid")],
    ["an unknown scope backend", (p: any) => (p.scopeBackend = "namespace")],
    ["a cgroup scope id whose INODE was edited (a different cgroup object)", (p: any) => (p.scopeId = String(p.scopeId).replace(/^cgroup2:\d+/, "cgroup2:999999"))],
    ["a cgroup scope id whose NAME was edited", (p: any) => (p.scopeId = String(p.scopeId).replace(/loop-[0-9a-f]+/, "loop-00000000deadbeef"))],
    ["a cgroup reap proof for a scope that is not the one attested", (p: any) => (p.scopeReapProof = "cgroup2-empty:RMDIR:1:loop-00000000deadbeef+pgid-empty:ESRCH:1")]
  ] as const) {
    it(`REJECTS ${name} — the whole journal fails closed`, async () => {
      const h = await genuinelySettled();
      forgeOnDisk(h, (d) => mutate(d.attest.payload));
      // Not "quietly downgraded to untrusted" — REFUSED. A tamperer must never get to choose their outcome
      // by damaging a record, and a settlement that cannot be verified is not a settlement.
      expect(refolds(h), "a forged reap proof was folded").toBe("refused");
    });
  }
});

describe("the durable attestation's TERMINAL evidence must be LOCATABLE in the transcript it pins", () => {
  for (const [name, mutate] of [
    ["terminal evidence entirely MISSING", (p: any) => ((p.terminalBytes = undefined), (p.terminalOffset = undefined))],
    ["a ZERO-length terminal frame", (p: any) => (p.terminalBytes = 0)],
    ["a NEGATIVE terminal offset", (p: any) => (p.terminalOffset = -1)],
    ["a terminal frame that RUNS PAST the transcript", (p: any) => (p.terminalOffset = 10_000_000)],
    ["a terminal frame in an EMPTY transcript", (p: any) => (p.transcriptBytes = 0)],
    ["a non-sha256 terminal hash", (p: any) => (p.terminalSha256 = "deadbeef")],
    // The two authorities are mutually exclusive ON DISK: an accounted terminal that pins a
    // `rate_limit_event` frame is refused outright, so it can never be edited into fallback authority.
    ["a rate_limit_event frame smuggled onto an ACCOUNTED terminal", (p: any) => ((p.limitSha256 = sha("x")), (p.limitBytes = 10), (p.limitOffset = 0))],
    // An unknown-provenance attestation retains the worst case, so it must carry no money at all.
    ["an UNKNOWN-provenance attestation carrying money", (p: any) => ((p.costProvenance = "unknown"), (p.usdNano = "1"))]
  ] as const) {
    it(`REJECTS ${name}`, async () => {
      const h = await genuinelySettled();
      forgeOnDisk(h, (d) => mutate(d.attest.payload));
      expect(refolds(h), "unlocatable terminal evidence was folded into trust").toBe("refused");
    });
  }
});

describe("fold-time derivation: owning the disk does not buy a cheaper spend or a second provider", () => {
  it("a hand-chained UNCERTAIN settlement cannot be upgraded by inventing an attestation", async () => {
    const h = openRun();
    const { bind, result } = await reserveAndRun(h, "c", { worstCase: 0.5, budget: 10, spec: { noCost: true } });
    expect(settle(h, bind, result).kind).toBe("uncertain"); // a subscription turn: nothing is proven
    expect(h.ledger.effectiveSpend()).toBe(0.5); // the worst case stands
    h.ledger.close();

    // The attacker writes the attestation the ledger declined to write, and repairs the chain perfectly.
    // What they cannot produce is the tag: the key is 32 random bytes this process never disclosed, and
    // `AttestKey` has no accessor to read it back out of.
    forgeOnDisk(h, (d) => {
      d.usdNano = "1000000"; // $0.001
      d.reported = true;
      d.attest = {
        // A COMPLETE, shape-valid v2 payload — the attacker has read `validatePayloadShape` and satisfied
        // every rule in it, scope backend and derived reap proof included. Shape is not authenticity.
        payload: {
          schema: "loop.ledger.attest.v2",
          kind: "accounted-terminal",
          ledgerEpoch: "0".repeat(64),
          runNonce: h.run,
          callId: "c",
          callNonce: d.bind.callNonce,
          reservationId: d.bind.reservationId,
          routeEpoch: d.bind.routeEpoch,
          provider: d.bind.provider,
          model: d.bind.model,
          providerKind: "claude",
          attempt: d.bind.attempt,
          scopeBackend: "pgid",
          scopeId: "pgid:1",
          scopeReapProof: "pgid-empty:ESRCH:1",
          transcriptDev: "1",
          transcriptIno: "1",
          transcriptSha256: sha("t"),
          transcriptBytes: 100,
          terminalSha256: sha("term"),
          terminalBytes: 10,
          terminalOffset: 0,
          usdNano: "1000000",
          costProvenance: "provider-reported",
          ts: "2026-01-01T00:00:00.000Z"
        },
        tag: sha("a tag the attacker cannot compute")
      };
    });
    expect(refolds(h), "an invented attestation bought a cheaper settlement").toBe("refused");
  });

  it("a GENUINE attestation replayed onto ANOTHER call's settlement is refused", async () => {
    // The strongest version of the attack: the payload and its tag are entirely REAL — the ledger itself
    // minted them, for a different call, moments ago. The MAC covers the callId, the call nonce and the
    // reservation id, so it authorizes exactly the one settlement it was issued for and no other.
    const h = openRun();
    await settleTrusted(h, "real", { worstCase: 0.5, budget: 10, cost: 0.01 });
    const { bind, result } = await reserveAndRun(h, "victim", { worstCase: 0.5, budget: 10, spec: { noCost: true } });
    expect(settle(h, bind, result).kind).toBe("uncertain");
    h.ledger.close();

    const leaf = join(h.boardDir, LEDGER_LEAF);
    const records = readFileSync(leaf, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const genuine = records.find((r) => r.data.type === "settle" && r.data.callId === "real")!.data.attest;
    expect(genuine.tag, "the source attestation is not a real one").toMatch(/^[0-9a-f]{64}$/);

    forgeOnDisk(h, (d) => {
      if (d.callId !== "victim") return;
      d.attest = genuine; // a real payload, a real tag — just not for THIS call
      d.usdNano = genuine.payload.usdNano;
      d.reported = true;
    });
    expect(refolds(h), "a genuine attestation was replayed onto another call").toBe("refused");
  });

  it("re-chaining with the EXACT genuine attestation still folds — the forgeries fail on the EVIDENCE, not the rewrite", async () => {
    const h = await genuinelySettled();
    forgeOnDisk(h, () => {
      /* rewrite every record and re-chain every hash, but change NOTHING */
    });
    // The same byte-for-byte rewrite the attacks above perform. It folds cleanly, which is what makes them
    // evidence about the evidence rather than about the rewriting.
    expect(refolds(h)).toEqual({ spend: 0.01 });
  });
});

/**
 * The terminal hash must be evidence, not a restatement of our own conclusion. It was
 * `sha256(JSON.stringify(normalizedVerdict))` — a hash of a DERIVED object: identical for any stream
 * that happens to normalize the same way, and impossible to check against anything on disk.
 */
describe("terminal evidence: the hash is of the EXACT accepted terminal frame, locatable in the transcript", () => {
  const S = "sess-1";
  const INIT = JSON.stringify({ type: "system", subtype: "init", session_id: S, model: "claude-opus-4-8", tools: ["Bash"] });
  const ASSISTANT = JSON.stringify({ type: "assistant", session_id: S, message: { content: [{ type: "text", text: "hi" }] } });
  const TERMINAL = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "OK",
    session_id: S,
    total_cost_usd: 0.01,
    usage: { input_tokens: 1, output_tokens: 1 }
  });

  /** Feed a byte stream through the REAL one-pass pipeline, in arbitrary chunks. */
  function streamIt(text: string, chunk = 7) {
    const s = new StdoutStream({ maxFrameBytes: 1 << 20, tailCap: 1 << 16, normalizer: createStreamingNormalizer("claude") });
    const buf = Buffer.from(text, "utf8");
    for (let i = 0; i < buf.length; i += chunk) s.push(buf.subarray(i, Math.min(i + chunk, buf.length)));
    return s.finish();
  }

  it("the evidence hashes the terminal FRAME's real bytes and points at them in the stream", () => {
    const stream = `${INIT}\n${ASSISTANT}\n${TERMINAL}\n`;
    const out = streamIt(stream);
    const frame = out.verdict!.terminalFrame!;
    expect(out.verdict!.success).toBe(true);
    expect(frame.sha256).toBe(sha(Buffer.from(TERMINAL, "utf8")));
    expect(frame.bytes).toBe(Buffer.byteLength(TERMINAL));
    // The offset locates it EXACTLY in the byte stream the transcript is written from.
    expect(frame.offset).toBe(Buffer.byteLength(`${INIT}\n${ASSISTANT}\n`));
    const located = Buffer.from(stream, "utf8").subarray(frame.offset, frame.offset + frame.bytes);
    expect(located.toString("utf8")).toBe(TERMINAL);
    expect(sha(located)).toBe(frame.sha256);
    expect(frame.index).toBe(2);
  });

  it("it is NOT the hash of the normalized verdict (the old, unverifiable attestation)", () => {
    const out = streamIt(`${INIT}\n${TERMINAL}\n`);
    const verdictHash = sha(JSON.stringify(out.verdict));
    expect(out.verdict!.terminalFrame!.sha256).not.toBe(verdictHash);
    expect(out.verdict!.terminalFrame!.sha256).toBe(sha(Buffer.from(TERMINAL, "utf8")));
  });

  it("two DIFFERENT terminal records that normalize alike get DIFFERENT evidence", () => {
    // Same verdict (success, same text, same cost) — but not the same bytes. A hash of the verdict
    // could not tell these apart; a hash of the frame always can.
    const other = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "OK",
      session_id: S,
      total_cost_usd: 0.01,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 99 }
    });
    const a = streamIt(`${INIT}\n${TERMINAL}\n`);
    const b = streamIt(`${INIT}\n${other}\n`);
    const strip = (v: unknown) => {
      const { terminalFrame, ...rest } = v as Record<string, unknown>;
      return rest;
    };
    expect(strip(a.verdict)).toEqual(strip(b.verdict)); // identical verdicts…
    expect(a.verdict!.terminalFrame!.sha256).not.toBe(b.verdict!.terminalFrame!.sha256); // …distinct evidence
  });

  it("offsets stay exact across chunk boundaries and multi-byte characters", () => {
    const withUnicode = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "héllo → 🌍",
      session_id: S,
      total_cost_usd: 0.01,
      usage: { input_tokens: 1, output_tokens: 1 }
    });
    const stream = `${INIT}\n${withUnicode}\n`;
    for (const chunk of [1, 2, 3, 5, 13, 4096]) {
      const out = streamIt(stream, chunk);
      const frame = out.verdict!.terminalFrame!;
      const located = Buffer.from(stream, "utf8").subarray(frame.offset, frame.offset + frame.bytes);
      expect(located.toString("utf8"), `chunk=${chunk}`).toBe(withUnicode);
      expect(sha(located), `chunk=${chunk}`).toBe(frame.sha256);
    }
  });

  it("a REJECTED terminal yields NO evidence — so no settlement can be built for a turn we did not accept", () => {
    // Protocol drift (a second, trailing record after the terminal) → the terminal is not accepted.
    const drifted = streamIt(`${INIT}\n${TERMINAL}\n${ASSISTANT}\n`);
    expect(drifted.verdict!.hasTerminal).toBe(false);
    expect(drifted.verdict!.terminalFrame).toBeUndefined();

    // A malformed terminal (a contradictory is_error) → not accepted, no evidence.
    const badTerminal = JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "OK", session_id: S });
    const bad = streamIt(`${INIT}\n${badTerminal}\n`);
    expect(bad.verdict!.hasTerminal).toBe(false);
    expect(bad.verdict!.terminalFrame).toBeUndefined();

    // A missing terminal → no evidence.
    const none = streamIt(`${INIT}\n${ASSISTANT}\n`);
    expect(none.verdict!.terminalFrame).toBeUndefined();
  });

  it("an OVERSIZE (unframed) stream yields no verdict at all — and therefore no evidence", () => {
    const s = new StdoutStream({ maxFrameBytes: 32, tailCap: 1024, normalizer: createStreamingNormalizer("claude") });
    s.push(Buffer.from(`${INIT}\n${TERMINAL}\n`, "utf8"));
    const out = s.finish();
    expect(out.fatal?.kind).toBe("oversize");
    expect(out.verdict).toBeUndefined();
  });

  it("the BATCH path has no wire bytes, so it never fabricates evidence", () => {
    expect(normalizeTurn("claude", `${INIT}\n${TERMINAL}\n`).terminalFrame).toBeUndefined();
    expect(normalizeTurn("claude", `${INIT}\n${TERMINAL}\n`).success).toBe(true);
  });
});

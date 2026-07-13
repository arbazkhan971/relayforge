import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { LEDGER_LEAF, openLedger, type CallBinding, type LedgerHandle } from "../src/ledger.js";
import { runHeadlessChild } from "../src/orchestrator.js";

/**
 * THE TRUSTED-FALLBACK MINT (wave-9, slice 2): the authority to bill a SECOND provider for one turn.
 *
 * This is the most dangerous authority in the system. An `accounted-terminal` that is wrongly issued
 * mis-states one turn's cost; a `trusted-fallback` that is wrongly issued SPENDS ANOTHER PROVIDER'S
 * MONEY, on every turn an attacker can provoke it. So the bar is: it exists only when the kernel can
 * RE-DERIVE a canonical Claude usage rejection by replaying the DURABLE transcript through the
 * production framer and the production Claude state machine.
 *
 * Every test here drives the REAL transport against a real detached child, so the transcript, its inode,
 * the framed records, the delivered stdin, and the process group are genuine artifacts of an actual turn.
 * Then one fact at a time is varied. The near-miss table is the heart of it: each mode is a stream that a
 * careless reader would call a rejection, and each must settle UNCERTAIN with NO authority.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "fixtures/settlement-limit-provider.mjs");
const PATH = process.env.PATH ?? "";

const ROOT = resolve(HERE, ".tmp-settlement-fallback");
mkdirSync(ROOT, { recursive: true, mode: 0o700 });
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const sha = (v: Buffer | string) => createHash("sha256").update(v).digest("hex");

const PROMPT = "implement the thing\n";
const STDIN = Buffer.from(PROMPT, "utf8");
const WORST_CASE = 0.5;
const BUDGET = 10;

// The launch handshake durably records a scope before the provider is released to exec, so every
// context — fake or not — owns a real scope journal.
let journals = 0;
function fakeCtx() {
  return { children: new Set(), ownedGroups: new Set(), loop: { cadenceMinutes: 5 }, scopesPath: join(ROOT, `${journals++}.scopes`) } as any;
}

function openRun(groupAlive?: (pid: number) => boolean) {
  const runDir = mkdtempSync(join(ROOT, "run-"));
  const boardDir = join(runDir, "board");
  mkdirSync(boardDir, { mode: 0o700 });
  const run = randomBytes(32).toString("hex");
  const ledger = openLedger({ dir: boardDir, runNonce: run, transcriptRoot: runDir, groupAlive });
  return { runDir, boardDir, run, ledger };
}

function bindFor(run: string, callId: string, stdin: Buffer): CallBinding {
  return {
    runNonce: run,
    callNonce: randomBytes(16).toString("hex"),
    callId,
    reservationId: randomBytes(16).toString("hex"),
    routeEpoch: 0,
    provider: "opus",
    model: "opus-4.8",
    attempt: 1,
    intentSha256: sha("intent:settlement-fallback"),
    stdinSha256: sha(stdin),
    stdinBytes: stdin.length
  };
}

/** Reserve + run one genuine turn in the given dialect, through the production transport. */
async function limitedCall(h: { runDir: string; run: string; ledger: LedgerHandle }, callId: string, mode: string) {
  const bind = bindFor(h.run, callId, STDIN);
  expect(h.ledger.reserve(bind, WORST_CASE, BUDGET)).toBe(true);
  const result = await runHeadlessChild(
    fakeCtx(),
    "node",
    [FIXTURE],
    { PATH, LIMIT_MODE: mode },
    "",
    h.runDir,
    PROMPT,
    join(h.runDir, "transcripts"),
    20_000,
    "claude"
  );
  return { bind, result };
}

describe("the trusted-fallback mint — only a re-derived canonical rejection buys a second provider", () => {
  it("issues fallback authority for a canonical rejection, charges NOTHING for it, and it survives a restart", async () => {
    const h = openRun();
    const { bind, result } = await limitedCall(h, "canonical-rejection", "canonical");

    // The turn is sound in every way EXCEPT that it failed — and it exited nonzero, which a canonical
    // rejection is entitled to do. That exit code must not demote it, and must not promote it either.
    expect(result.transportOk, result.uncertainReason).toBe(true);
    expect(result.code, "a canonical rejection legitimately exits nonzero").not.toBe(0);
    expect(result.scopeReaped).toBe(true);
    expect(result.streamedVerdict?.success).toBe(false);
    expect(result.streamedVerdict?.explicitLimit).toBe(true);

    const outcome = h.ledger.settleCompleted({ bind, providerKind: "claude", stdinDelivered: STDIN, result });
    expect(outcome.kind, outcome.kind === "uncertain" ? outcome.reason : "").toBe("trusted-fallback");

    // The LEDGER's verdict, from the MAC: GPT is authorized, and NOT ONE CENT of the primary was released.
    // Proving a rejection is a strictly different claim from knowing what the rejected turn cost.
    expect(h.ledger.settlementOf(bind.callId)).toEqual({ settled: true, costTrusted: false, fallbackAuthorized: true });
    expect(h.ledger.effectiveSpend(), "a rejection lowered the worst case").toBe(WORST_CASE);
    expect(h.ledger.budgetViolation()).toBeUndefined();
    h.ledger.close();

    // RESTART: a fresh handle re-verifies the attestation from BYTES alone. Authority that evaporates on
    // reopen would strand a turn mid-route; authority that is re-derivable from a tampered journal would
    // be worthless. It must be exactly as authoritative, and no more.
    const reopened = openLedger({ dir: h.boardDir, runNonce: h.run, transcriptRoot: h.runDir });
    try {
      expect(reopened.settlementOf(bind.callId)).toEqual({ settled: true, costTrusted: false, fallbackAuthorized: true });
      expect(reopened.effectiveSpend()).toBe(WORST_CASE);
    } finally {
      reopened.close();
    }
  });

  it("a genuine SUCCESS is an accounted terminal and can NEVER buy a fallback", async () => {
    const h = openRun();
    const { bind, result } = await limitedCall(h, "success-buys-nothing", "success");
    expect(result.streamedVerdict?.success).toBe(true);

    const outcome = h.ledger.settleCompleted({ bind, providerKind: "claude", stdinDelivered: STDIN, result });
    expect(outcome).toEqual({ kind: "trusted", usd: 0.25, usdNano: "250000000" });
    // Cost is trusted; the ROUTE is not. The two authorities are disjoint by construction — an
    // accounted-terminal payload may not even carry a rate_limit_event frame.
    expect(h.ledger.settlementOf(bind.callId)).toEqual({ settled: true, costTrusted: true, fallbackAuthorized: false });
    h.ledger.close();
  });

  /**
   * THE NEAR-MISS TABLE. Every one of these is a stream that looks like a rejection to a careless reader:
   * it carries the word `rejected`, or a nonzero exit, or a rate_limit_event, or all three. NONE of them
   * is a canonical rejection, so none may authorize a second provider's bill.
   */
  const NEAR_MISSES: [mode: string, why: string][] = [
    ["allowed_warning", "an `allowed_warning` snapshot is a WARNING, not a rejection (a healthy account emits these all day)"],
    ["allowed", "an `allowed` snapshot is not a rejection"],
    ["cleared", "a rejection a later `allowed` event WITHDREW is not authority, and its frame is not left behind"],
    ["warning_text", "model PROSE saying `usage limit rejected` is not telemetry — it can be made to say anything"],
    ["stderr", "a rejection shouted on STDERR is not on the framed protocol stream at all"],
    ["generic", "a nonzero EXIT CODE alone is evidence of nothing"],
    ["foreign", "a rejection bound to somebody else's session cannot govern this turn"],
    ["malformed", "a snapshot with an off-schema member is protocol DRIFT — we do not know what dialect we are reading"],
    ["bad_subtype", "an invented terminal subtype is not the pinned clean-failure shape"],
    ["duplicate_terminal", "conflicting terminals are drift, never `last one wins`"],
    ["trailing", "a record TRAILING the terminal is exactly where an appended forgery would hide"],
    ["post_terminal", "a rejection that POSTDATES the terminal cannot govern the turn it arrived after"]
  ];

  it.each(NEAR_MISSES)("`%s` NEVER authorizes a fallback — %s", async (mode) => {
    const h = openRun();
    const { bind, result } = await limitedCall(h, `near-miss-${mode}`, mode);
    // The transport itself is sound in every case: the ONLY thing that varies is the dialect on the wire.
    // So a fallback here could only ever come from misreading the bytes.
    expect(result.transportOk, result.uncertainReason).toBe(true);
    expect(result.scopeReaped).toBe(true);
    expect(result.streamedVerdict?.explicitLimit, `${mode} was read as a canonical rejection`).toBe(false);

    const outcome = h.ledger.settleCompleted({ bind, providerKind: "claude", stdinDelivered: STDIN, result });
    expect(outcome.kind).toBe("uncertain");

    const settlement = h.ledger.settlementOf(bind.callId);
    expect(settlement.settled, "the reservation must still reach a durable terminal settlement").toBe(true);
    expect(settlement.fallbackAuthorized, `${mode} bought the right to bill a SECOND provider`).toBe(false);
    expect(settlement.costTrusted).toBe(false);
    expect(h.ledger.effectiveSpend(), "the worst case was not retained").toBe(WORST_CASE);
    h.ledger.close();
  });

  it("refuses a canonical rejection whose transcript was MUTATED after the turn", async () => {
    const h = openRun();
    const { bind, result } = await limitedCall(h, "mutated-rejection", "canonical");
    expect(result.streamedVerdict?.explicitLimit).toBe(true);

    // The live stream already accepted the rejection. Now the durable evidence is tampered with — the very
    // window in which a transport-reported hash would have been believed. The kernel re-reads the bytes.
    appendFileSync(result.transcriptPath!, `${JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } })}\n`);

    const outcome = h.ledger.settleCompleted({ bind, providerKind: "claude", stdinDelivered: STDIN, result });
    expect(outcome.kind).toBe("uncertain");
    expect(outcome.kind === "uncertain" && outcome.reason).toMatch(/mutated after the turn/);
    expect(h.ledger.settlementOf(bind.callId).fallbackAuthorized, "a mutated transcript authorized GPT").toBe(false);
    expect(h.ledger.effectiveSpend()).toBe(WORST_CASE);
    h.ledger.close();
  });

  it("refuses a canonical rejection whose owned process group is still ALIVE", async () => {
    // A provider that left a live descendant is a provider we cannot account for — whatever it printed.
    // The ledger's OWN prober, at attestation time, overrules the transport's earlier (genuine) ESRCH.
    const h = openRun(() => true);
    const { bind, result } = await limitedCall(h, "live-scope-rejection", "canonical");
    expect(result.streamedVerdict?.explicitLimit).toBe(true);
    expect(result.scopeReaped, "the transport itself saw an empty group — the kernel must still re-probe").toBe(true);

    const outcome = h.ledger.settleCompleted({ bind, providerKind: "claude", stdinDelivered: STDIN, result });
    expect(outcome.kind).toBe("uncertain");
    expect(outcome.kind === "uncertain" && outcome.reason).toMatch(/STILL ALIVE/);
    expect(h.ledger.settlementOf(bind.callId).fallbackAuthorized).toBe(false);
    h.ledger.close();
  });

  it("refuses a canonical rejection whose delivered stdin is not the stdin the reservation was bound to", async () => {
    const h = openRun();
    const { bind, result } = await limitedCall(h, "stdin-mismatch-rejection", "canonical");
    expect(result.streamedVerdict?.explicitLimit).toBe(true);

    // The rejection is real, but it is not a rejection of the WORK this reservation paid for.
    const other = Buffer.from("a different prompt entirely\n", "utf8");
    const outcome = h.ledger.settleCompleted({ bind, providerKind: "claude", stdinDelivered: other, result });
    expect(outcome.kind).toBe("uncertain");
    expect(outcome.kind === "uncertain" && outcome.reason).toMatch(/is not the stdin this call reserved/);
    expect(h.ledger.settlementOf(bind.callId).fallbackAuthorized).toBe(false);
    h.ledger.close();
  });
});

/**
 * ON-DISK FORGERY. The in-process mint is unreachable (kernel-bridge-forgery / receipt-forgery), so the
 * remaining attack surface is the JOURNAL: edit a durable settlement so that a FOLD — by a fresh process,
 * after a restart, over bytes alone — reads fallback authority that was never issued.
 *
 * Both attacks below repair the hash chain perfectly (they recompute `hash` over the mutated record), so
 * the chain check passes and the MAC is the only thing standing. That is the point: the tag, keyed by a
 * secret the attacker cannot read, is the boundary — and a tampered record fails the ledger CLOSED rather
 * than being quietly downgraded to "an unauthorized settlement", which would let a tamperer choose their
 * outcome by damaging the tag.
 */
describe("a fallback cannot be forged into the durable journal", () => {
  /** Rewrite one settle record in place, repairing `hash` so ONLY the MAC can catch it. */
  function tamperSettlement(boardDir: string, mutate: (data: any) => void): void {
    const leaf = join(boardDir, LEDGER_LEAF);
    const lines = readFileSync(leaf, "utf8").split("\n").filter(Boolean);
    const i = lines.findIndex((l) => JSON.parse(l).data.type === "settle");
    expect(i, "no settlement to tamper with").toBeGreaterThanOrEqual(0);
    const rec = JSON.parse(lines[i]);
    mutate(rec.data);
    rec.hash = createHash("sha256").update(`${rec.prev}|${rec.seq}|${JSON.stringify(rec.data)}`).digest("hex");
    lines[i] = JSON.stringify(rec);
    writeFileSync(leaf, `${lines.join("\n")}\n`, { mode: 0o600 });
  }

  it("an accounted-terminal REBRANDED as a trusted-fallback fails the ledger closed", async () => {
    const h = openRun();
    const { bind, result } = await limitedCall(h, "rebrand-success", "success");
    expect(h.ledger.settleCompleted({ bind, providerKind: "claude", stdinDelivered: STDIN, result }).kind).toBe("trusted");
    h.ledger.close();

    // The attacker owns the bytes: flip the one word that turns "this turn cost $0.25" into "you may now
    // bill a second provider". The chain is repaired; the tag is not (and cannot be — the key is 32 random
    // bytes this process never disclosed). A rebranded payload also pins no rate_limit_event frame, which
    // `validatePayloadShape` requires of every trusted-fallback — so it is refused twice over.
    tamperSettlement(h.boardDir, (d) => (d.attest.payload.kind = "trusted-fallback"));

    const reopened = openLedger({ dir: h.boardDir, runNonce: h.run, transcriptRoot: h.runDir });
    try {
      expect(() => reopened.settlementOf(bind.callId)).toThrow(/journal corruption/);
      expect(() => reopened.effectiveSpendNano(), "a forged fallback was folded as spend").toThrow(/journal corruption/);
    } finally {
      reopened.close();
    }
  });

  it("a genuine fallback whose PINNED rejection frame is edited fails the ledger closed", async () => {
    const h = openRun();
    const { bind, result } = await limitedCall(h, "move-the-frame", "canonical");
    expect(h.ledger.settleCompleted({ bind, providerKind: "claude", stdinDelivered: STDIN, result }).kind).toBe("trusted-fallback");
    h.ledger.close();

    // Repoint the authority at a DIFFERENT byte range of the same transcript. The payload still passes
    // every structural rule (the frame remains inside the transcript it pins), so nothing but the MAC can
    // tell that the ledger never attested to THIS range. If an auditor could be sent to re-read bytes the
    // ledger never vouched for, the pinned frame would be decorative.
    tamperSettlement(h.boardDir, (d) => (d.attest.payload.limitOffset = 0));

    const reopened = openLedger({ dir: h.boardDir, runNonce: h.run, transcriptRoot: h.runDir });
    try {
      expect(() => reopened.settlementOf(bind.callId)).toThrow(/journal corruption/);
    } finally {
      reopened.close();
    }
  });
});

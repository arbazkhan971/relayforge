import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import * as ledgerModule from "../src/ledger.js";
import { openLedger, type CallBinding, type LedgerHandle } from "../src/ledger.js";
import { runHeadlessChild } from "../src/orchestrator.js";
import { parseScopeId, reapProofOf } from "../src/scope.js";

/**
 * The settlement KERNEL, slice 1: a genuine provider SUCCESS becomes MAC-authenticated,
 * provider-reported spend — and NOTHING else does.
 *
 * These run the REAL transport (`runHeadlessChild`) against a real detached child, so the transcript,
 * its inode, the framed terminal record, the delivered stdin, and the spawned process group are all
 * genuine artifacts of an actual turn — not fixtures handed to the kernel. What the kernel is asked to
 * do with them is then varied one fact at a time.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "fixtures/settlement-provider.mjs");
const PATH = process.env.PATH ?? "";

/** Repo-local, 0700, and removed at the end — the run tree never leaves this directory. */
const ROOT = resolve(HERE, ".tmp-settlement-kernel");
mkdirSync(ROOT, { recursive: true, mode: 0o700 });
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const sha = (v: Buffer | string) => createHash("sha256").update(v).digest("hex");

const PROMPT = "implement the thing\n";
const STDIN = Buffer.from(PROMPT, "utf8");
const WORST_CASE = 0.5;
const BUDGET = 10;
const COST = 0.25; // what the fake provider REPORTS in its terminal record
const COST_NANO = "250000000";

// runHeadlessChild reads ctx.children / ctx.ownedGroups / ctx.loop / ctx.scopesPath — the last because
// the launch handshake durably records a scope BEFORE releasing the provider to exec.
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
    provider: "claude",
    model: "opus-4.8",
    attempt: 1,
    intentSha256: sha("intent:settlement-kernel"),
    stdinSha256: sha(stdin),
    stdinBytes: stdin.length
  };
}

/** One REAL turn through the production transport: detached child, private transcript, framed stdout. */
function runCall(runDir: string, env: Record<string, string> = {}) {
  return runHeadlessChild(fakeCtx(), "node", [FIXTURE], { PATH, ...env }, "", runDir, PROMPT, join(runDir, "transcripts"), 20_000, "claude");
}

/** Reserve + run one genuine call, asserting the transport itself was sound before the kernel sees it. */
async function reservedCall(h: { runDir: string; run: string; ledger: LedgerHandle }, callId: string, env: Record<string, string> = {}) {
  const bind = bindFor(h.run, callId, STDIN);
  expect(h.ledger.reserve(bind, WORST_CASE, BUDGET)).toBe(true);
  expect(h.ledger.effectiveSpend(), "the worst case must be held until something proves otherwise").toBe(WORST_CASE);
  const result = await runCall(h.runDir, env);
  return { bind, result };
}

describe("settlement kernel — a genuine success, and only a genuine success, becomes trusted cost", () => {
  it("settles a real successful turn as provider-reported cost, and it stays trusted across a restart", async () => {
    const h = openRun();
    const { bind, result } = await reservedCall(h, "genuine-success");

    // The turn itself is sound: whole stdin, verified transcript, framed terminal, empty scope, exit 0.
    expect(result.transportOk, result.uncertainReason).toBe(true);
    expect(result.code).toBe(0);
    expect(result.scopeReaped).toBe(true);
    expect(result.streamedVerdict?.success).toBe(true);
    expect(result.streamedVerdict?.costReported).toBe(true);
    expect(result.streamedVerdict?.usd).toBe(COST);

    const outcome = h.ledger.settleCompleted({ bind, providerKind: "claude", stdinDelivered: STDIN, result });
    expect(outcome).toEqual({ kind: "trusted", usd: COST, usdNano: COST_NANO });

    // The LEDGER's own verdict — decided from the MAC, not from what the kernel returned.
    const settlement = h.ledger.settlementOf(bind.callId);
    expect(settlement.settled).toBe(true);
    expect(settlement.costTrusted, "a genuine success did not become trusted cost").toBe(true);
    // This slice issues `accounted-terminal` ONLY: a success may never buy the right to bill GPT.
    expect(settlement.fallbackAuthorized, "a success authorized a SECOND provider's bill").toBe(false);
    expect(h.ledger.effectiveSpend(), "the actual cost did not replace the worst case").toBe(COST);
    expect(h.ledger.budgetViolation()).toBeUndefined();
    h.ledger.close();

    // RESTART. A fresh handle over the same durable generation re-verifies the attestation from BYTES
    // alone — no transcript is re-read, no in-memory trust survives. The cost must still stand.
    const reopened = openLedger({ dir: h.boardDir, runNonce: h.run, transcriptRoot: h.runDir });
    try {
      expect(reopened.settlementOf(bind.callId).costTrusted, "trust did not survive a reopen").toBe(true);
      expect(reopened.effectiveSpend()).toBe(COST);
      expect(reopened.budgetViolation()).toBeUndefined();
    } finally {
      reopened.close();
    }
  });

  it("refuses a turn whose durable transcript was MUTATED after the call — the worst case is retained", async () => {
    const h = openRun();
    const { bind, result } = await reservedCall(h, "mutated-transcript");
    expect(result.transportOk, result.uncertainReason).toBe(true);
    expect(result.streamedVerdict?.success).toBe(true);

    // The evidence is tampered with AFTER the transport verified it — exactly the window in which a
    // caller-supplied hash would have been believed. The kernel re-reads the bytes, so it is not.
    appendFileSync(result.transcriptPath!, `${JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.000001 })}\n`);

    const outcome = h.ledger.settleCompleted({ bind, providerKind: "claude", stdinDelivered: STDIN, result });
    expect(outcome.kind).toBe("uncertain");
    expect(outcome.kind === "uncertain" && outcome.reason).toMatch(/mutated after the turn/);

    const settlement = h.ledger.settlementOf(bind.callId);
    expect(settlement.settled, "the reservation must still reach a durable terminal settlement").toBe(true);
    expect(settlement.costTrusted, "a mutated transcript minted trusted cost").toBe(false);
    expect(settlement.fallbackAuthorized).toBe(false);
    expect(h.ledger.effectiveSpend(), "a mutated transcript lowered the worst case").toBe(WORST_CASE);
    h.ledger.close();
  });

  it("refuses a turn whose owned process group is still ALIVE — the worst case is retained", async () => {
    // The ledger's OWN scope prober says the group is populated. The transport's (earlier, genuine) ESRCH
    // proof is not allowed to overrule a live probe at attestation time.
    const h = openRun(() => true);
    const { bind, result } = await reservedCall(h, "live-scope");
    expect(result.transportOk, result.uncertainReason).toBe(true);
    expect(result.scopeReaped, "the transport itself saw an empty group — the kernel must still re-probe").toBe(true);

    const outcome = h.ledger.settleCompleted({ bind, providerKind: "claude", stdinDelivered: STDIN, result });
    expect(outcome.kind).toBe("uncertain");
    expect(outcome.kind === "uncertain" && outcome.reason).toMatch(/STILL ALIVE/);

    const settlement = h.ledger.settlementOf(bind.callId);
    expect(settlement.settled).toBe(true);
    expect(settlement.costTrusted, "a live process group minted trusted cost").toBe(false);
    expect(h.ledger.effectiveSpend()).toBe(WORST_CASE);
    h.ledger.close();
  });

  it("refuses a DOWNGRADED reap proof: the pgid-empty proof cannot stand in for a contained scope", async () => {
    // The transport ran the provider inside a cgroup and proved that cgroup empty. A caller that rewrites
    // the result to claim only "the process group stopped answering" is claiming strictly less than the
    // turn earned — and that weaker claim is exactly what a `setsid` daemon makes trivially true. The proof
    // is DERIVED from the scope's identity, so it cannot be swapped for another scope's, or another
    // backend's, without the kernel noticing.
    const h = openRun();
    const { bind, result } = await reservedCall(h, "downgraded-proof");
    const scope = parseScopeId(result.scopeId)!;
    expect(scope.backend, "this host should have contained the provider in a cgroup").toBe("cgroup2");
    expect(result.scopeReapProof).toBe(reapProofOf(scope));

    const downgraded = { ...result, scopeReapProof: `pgid-empty:ESRCH:${scope.pid}` };
    const outcome = h.ledger.settleCompleted({ bind, providerKind: "claude", stdinDelivered: STDIN, result: downgraded });
    expect(outcome.kind).toBe("uncertain");
    expect(outcome.kind === "uncertain" && outcome.reason).toMatch(/does not prove scope/);
    expect(h.ledger.settlementOf(bind.callId).costTrusted).toBe(false);
    expect(h.ledger.effectiveSpend()).toBe(WORST_CASE);
    h.ledger.close();
  });

  it("refuses a pgid-scoped settlement outright on a host that could have CONTAINED the provider", async () => {
    // The whole scope claim rewritten to the legacy backend — a self-consistent pgid id AND its matching
    // pgid proof, for a leader that really is dead. The kernel's scope checks all pass. The MINT still
    // refuses: this host has a strong scope, so a turn that only proves a process group empty proves too
    // little, and no amount of internal consistency upgrades it.
    const h = openRun();
    const { bind, result } = await reservedCall(h, "pgid-downgrade");
    const scope = parseScopeId(result.scopeId)!;
    const weak = { ...result, scopeId: `pgid:${scope.pid}`, scopeReapProof: `pgid-empty:ESRCH:${scope.pid}` };

    const outcome = h.ledger.settleCompleted({ bind, providerKind: "claude", stdinDelivered: STDIN, result: weak });
    expect(outcome.kind).toBe("uncertain");
    expect(outcome.kind === "uncertain" && outcome.reason).toMatch(/strong process scope|cgroup/i);
    expect(h.ledger.settlementOf(bind.callId).costTrusted, "a downgraded scope minted trusted cost").toBe(false);
    expect(h.ledger.effectiveSpend()).toBe(WORST_CASE);
    h.ledger.close();
  });

  it("refuses a turn whose terminal reported NO cost — an unreported cost is never a cheap settlement", async () => {
    const h = openRun();
    const { bind, result } = await reservedCall(h, "no-reported-cost", { NO_COST: "1" });
    expect(result.transportOk, result.uncertainReason).toBe(true);
    expect(result.streamedVerdict?.success).toBe(true);
    expect(result.streamedVerdict?.costReported).toBe(false);

    const outcome = h.ledger.settleCompleted({ bind, providerKind: "claude", stdinDelivered: STDIN, result });
    expect(outcome.kind).toBe("uncertain");
    expect(outcome.kind === "uncertain" && outcome.reason).toMatch(/reported no cost/);
    expect(h.ledger.settlementOf(bind.callId).costTrusted).toBe(false);
    expect(h.ledger.effectiveSpend()).toBe(WORST_CASE);
    h.ledger.close();
  });

  it("refuses a turn whose delivered stdin is not the stdin the reservation was bound to", async () => {
    const h = openRun();
    const { bind, result } = await reservedCall(h, "stdin-mismatch");
    expect(result.transportOk, result.uncertainReason).toBe(true);

    // The call ran on THIS prompt; the money would be attributed to some OTHER work.
    const other = Buffer.from("a different prompt entirely\n", "utf8");
    const outcome = h.ledger.settleCompleted({ bind, providerKind: "claude", stdinDelivered: other, result });
    expect(outcome.kind).toBe("uncertain");
    expect(outcome.kind === "uncertain" && outcome.reason).toMatch(/is not the stdin this call reserved/);
    expect(h.ledger.settlementOf(bind.callId).costTrusted).toBe(false);
    expect(h.ledger.effectiveSpend()).toBe(WORST_CASE);
    h.ledger.close();
  });
});

describe("the kernel is the only door to the mint", () => {
  it("the ledger exports no first-claim bridge to the mint", () => {
    // The old `claimLedgerKernelBridge()` was a public first-claim function: whoever imported it FIRST got
    // a closure over the mint, so an ordinary direct-source importer that loaded `./ledger` before the
    // kernel could take it. It is DELETED — there is no bridge, no symbol, and no key to claim. The full
    // reachability attack (bridge → symbol → name → key) is proven closed in kernel-bridge-forgery.test.ts.
    const exported = ledgerModule as unknown as Record<string, unknown>;
    expect(exported.claimLedgerKernelBridge, "a first-claim bridge to the mint is still exported").toBeUndefined();
  });
});

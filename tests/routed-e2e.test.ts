import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";
import { prepareRun, runRoutedTurn, type LoopRunState, type RunContext } from "../src/orchestrator.js";
import { loadHealth } from "../src/routing.js";
import { setTrustedRunner } from "../src/sandbox.js";
import { parseScopeId, reapProofOf } from "../src/scope.js";
import { initCostLedger } from "../src/cost.js";
import { LEDGER_LEAF } from "../src/ledger.js";
import type { RoleConfig } from "../src/config/schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = resolve(HERE, "fixtures/fake-claude.mjs");
const FAKE_CLAUDE_UNTRUSTED = resolve(HERE, "fixtures/fake-claude-untrusted.mjs");
const FAKE_CODEX = resolve(HERE, "fixtures/fake-codex.mjs");
const PATH = process.env.PATH ?? "";

// The routed fallback drives REAL subprocess providers (fake `claude` + fake `codex`) through the
// production transport → normalizer → routing path. The OS sandbox cannot launch here, so we run the
// trusted-runner path (the same one the rest of the suite uses).
beforeAll(() => setTrustedRunner(true));
afterAll(() => setTrustedRunner(false));

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

type ConfigOpts = { claudeCmd?: string; budgetUsd?: number; maxCostPerCallUsd?: number };
function writeConfig(repoDir: string, capture: string, control: string, opts: ConfigOpts = {}): string {
  const claudeCmd = opts.claudeCmd ?? FAKE_CLAUDE;
  const budgetUsd = opts.budgetUsd ?? 0;
  const maxCostPerCallUsd = opts.maxCostPerCallUsd ?? 0;
  const cfg = `version: 1
defaults:
  runDir: .loop/runs
projects:
  - name: routed
    workingDir: .
    intelligence: PROJECT-INTELLIGENCE.md
    safetyMode: workspace-write
    providers:
      opus:
        type: claude
        command: ${JSON.stringify(claudeCmd)}
        cooldownSeconds: 900
        env:
          PATH: ${JSON.stringify(PATH)}
          ROUTE_CAPTURE: ${JSON.stringify(capture)}
          CLAUDE_CONTROL: ${JSON.stringify(control)}
      gpt:
        type: codex
        command: ${JSON.stringify(FAKE_CODEX)}
        env:
          PATH: ${JSON.stringify(PATH)}
          ROUTE_CAPTURE: ${JSON.stringify(capture)}
    roles:
      - name: implementer
        title: Implementer
        provider: opus
        sme: fullstack
    loops:
      - name: delivery
        maxIterations: 6
        pollSeconds: 1
        cadenceMinutes: 5
        orchestrator: implementer
        reviewer: implementer
        maxRepairs: 2
        verifyStabilityRuns: 2
        maxSameFailureCount: 3
        postMergeVerify: true
        maxParallel: 1
        budgetUsd: ${budgetUsd}
        maxCostPerCallUsd: ${maxCostPerCallUsd}
        allowUnknownCostCalls: 0
        verify: ["true"]
        stopWhen:
          - all tasks done
`;
  const path = join(repoDir, "loop.config.yaml");
  writeFileSync(path, cfg);
  return path;
}

function makeState(): LoopRunState {
  return {
    runId: "run-routed",
    project: "routed",
    phase: "dispatch",
    status: "running",
    iteration: 1,
    dispatched: 0,
    accepted: 0,
    rejected: 0,
    escalations: 0,
    repeatFailures: 0,
    unknownCostCalls: 0,
    startedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}

/** Which fake provider actually RAN, in order (claude=opus primary, codex=gpt fallback). */
function capturedProviders(capture: string): string[] {
  try {
    return readFileSync(capture, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("|")[0]);
  } catch {
    return [];
  }
}

type Harness = { ctx: RunContext; role: RoleConfig; control: string; capture: string; setClock: (n: number) => void };

function setup(prefix: string, opts: ConfigOpts = {}): Harness {
  const repoDir = tmp(prefix);
  execSync("git init -q && git config user.email t@t.t && git config user.name t", { cwd: repoDir });
  const capture = join(repoDir, "route-capture.log");
  const control = join(repoDir, "claude-control");
  writeFileSync(control, "ok");
  const cfgPath = writeConfig(repoDir, capture, control, opts);
  const loaded = loadConfig(cfgPath);
  const project = loaded.config.projects[0];
  const ctx = prepareRun(loaded, project, "run-routed", "Deliver the feature");
  initCostLedger(ctx.boardDir);
  let mockNow = 1_000_000;
  ctx.clock = () => mockNow;
  const role = project.roles[0];
  writeFileSync(join(ctx.promptDir, "sys.md"), "SYSTEM PROMPT");
  return { ctx, role, control, capture, setClock: (n) => (mockNow = n) };
}

async function routeOnce(h: Harness): Promise<Awaited<ReturnType<typeof runRoutedTurn>>> {
  const sys = { file: join(h.ctx.promptDir, "sys.md"), text: "SYSTEM PROMPT" };
  return runRoutedTurn(h.ctx, h.role, "implementer", "do the task", sys, h.ctx.cwd, "", makeState(), "t1", 1);
}

describe("routed fallback E2E — Claude→Codex, cooldown, Opus recovery (wave-8 P0 Task 3)", () => {
  it("persists the physical trace opus, gpt, gpt, opus with an injected clock and reloaded health", async () => {
    const h = setup("loop-routed-trace-");
    const T0 = 1_000_000;

    // TURN 1 (t0): Opus is healthy → runs → CANONICAL rejection → ONE same-turn Codex fallback.
    writeFileSync(h.control, "limit");
    h.setClock(T0);
    const r1 = await routeOnce(h);
    expect(r1.ok).toBe(true); // the fallback (codex) succeeded
    // Exactly the primary then the fallback ran within ONE routed turn (no extra repair attempt).
    expect(capturedProviders(h.capture)).toEqual(["claude", "codex"]);
    // Cooldown was marked at the OBSERVED rejection time (T0), persisted to disk, and reloaded here.
    const health = loadHealth(h.ctx.runDir);
    expect(health.opus?.cooldownUntil).toBe(T0 + 900_000);

    // TURN 2 (t0 + 1s, still inside cooldown): a NEW turn stays on GPT (Opus is cooling down).
    h.setClock(T0 + 1_000);
    const r2 = await routeOnce(h);
    expect(r2.ok).toBe(true);
    expect(capturedProviders(h.capture)).toEqual(["claude", "codex", "codex"]);

    // TURN 3 (t0 + cooldown+): the first turn at expiry PROBES Opus again (automatic recovery).
    writeFileSync(h.control, "ok");
    h.setClock(T0 + 901_000);
    const r3 = await routeOnce(h);
    expect(r3.ok).toBe(true);
    expect(capturedProviders(h.capture)).toEqual(["claude", "codex", "codex", "claude"]);

    // The complete physical trace, mapped to provider keys, is exactly opus, gpt, gpt, opus.
    const trace = capturedProviders(h.capture).map((p) => (p === "claude" ? "opus" : "gpt"));
    expect(trace).toEqual(["opus", "gpt", "gpt", "opus"]);
  }, 60000);

  it("preserves `/goal` at byte 0 of the Claude/Opus stdin for the goal protocol", async () => {
    const h = setup("loop-routed-goal-");
    writeFileSync(h.control, "ok");
    h.setClock(1_000_000);
    await routeOnce(h);
    const line = readFileSync(h.capture, "utf8").split("\n").find((l) => l.startsWith("claude"));
    expect(line).toBeDefined();
    expect(line).toContain('byte0="/goal"');
  }, 30000);

  it("a GENERIC Claude failure (no rejection) NEVER falls back and marks no cooldown", async () => {
    const h = setup("loop-routed-generic-");
    writeFileSync(h.control, "generic");
    h.setClock(1_000_000);
    const r = await routeOnce(h);
    expect(r.ok).toBe(false);
    expect(capturedProviders(h.capture)).toEqual(["claude"]); // no codex fallback
    expect(loadHealth(h.ctx.runDir).opus).toBeUndefined(); // no cooldown marked
  }, 30000);

  it("a MALFORMED / foreign-session rejection is not authority → NEVER falls back", async () => {
    const h = setup("loop-routed-foreign-");
    writeFileSync(h.control, "foreign");
    h.setClock(1_000_000);
    const r = await routeOnce(h);
    expect(r.ok).toBe(false);
    expect(capturedProviders(h.capture)).toEqual(["claude"]); // foreign rejection never authorizes GPT
    expect(loadHealth(h.ctx.runDir).opus).toBeUndefined();
  }, 30000);

  // The ordered reservation-journal records (durable, hash-chained, identity-bound accounting).
  //
  // A settlement's authority lives in `attest`: a ledger-DERIVED payload plus an HMAC tag over its
  // canonical encoding, keyed by a secret no caller can reach. It is NOT the old `receipt` object, whose
  // every field was a caller's claim the ledger took on faith (see tests/receipt-forgery.test.ts). Every
  // field below is something the LEDGER read for itself — its own probe of the exact SCOPE the provider ran
  // inside, the transcript it re-read by inode, the frames it re-located by replaying those bytes.
  type Attest = {
    payload: {
      kind: string;
      scopeBackend: string;
      scopeId: string;
      scopeReapProof: string;
      costProvenance: string;
      transcriptSha256: string;
      terminalSha256: string;
      limitSha256?: string;
      usdNano: string;
    };
    tag: string;
  };
  type LedgerRec = {
    type: string;
    callId: string;
    reported?: boolean;
    usdNano?: string;
    worstCaseNano?: string;
    bind: { runNonce: string; callNonce: string; callId: string; provider: string; routeEpoch: number; intentSha256: string; stdinSha256: string; stdinBytes: number };
    attest?: Attest;
  };
  function reservationTrace(boardDir: string): LedgerRec[] {
    return readFileSync(join(boardDir, LEDGER_LEAF), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l).data as LedgerRec);
  }

  it("(wave-8b) one canonical rejection: SAME task/attempt reach both providers, no scope overlap, exact codex fixture, settlement-before-GPT", async () => {
    const h = setup("loop-routed-settle-");
    writeFileSync(h.control, "limit");
    h.setClock(1_000_000);
    const r = await routeOnce(h);

    // The fallback ran and returned the EXACT pinned codex fixture agent_message.
    expect(r.ok).toBe(true);
    expect(r.normalized?.provider).toBe("codex");
    expect(r.normalized?.finalText).toBe("codex handled it");
    expect(capturedProviders(h.capture)).toEqual(["claude", "codex"]);

    const trace = reservationTrace(h.ctx.boardDir);
    const reserves = trace.filter((t) => t.type === "reserve").map((t) => t.callId);
    // Exactly the primary then the fallback were reserved — the SAME logical task (t1) and repair
    // attempt (a1) reach BOTH providers, differing only in provider key + primary/fallback tag.
    expect(reserves.length).toBe(2);
    expect(reserves[0]).toMatch(/^implementer-t1-a1-opus-primary-/);
    expect(reserves[1]).toMatch(/^implementer-t1-a1-gpt-fallback-/);

    // SETTLEMENT-BEFORE-GPT: the primary's durable settle record precedes the fallback's reserve.
    const seqOf = (pred: (t: LedgerRec) => boolean) => trace.findIndex(pred);
    const primarySettle = seqOf((t) => t.type === "settle" && t.callId.includes("opus-primary"));
    const fallbackReserve = seqOf((t) => t.type === "reserve" && t.callId.includes("gpt-fallback"));
    expect(primarySettle).toBeGreaterThanOrEqual(0);
    expect(fallbackReserve).toBeGreaterThan(primarySettle);

    // PRODUCTION BINDINGS ARE REAL. The audit's B3: production still called reserve/settle with NO
    // binding and NO receipt, so the "identity-bound ledger" was a facade the real path never used.
    // Every durable record must now carry the run identity, a per-call nonce, the route epoch, the
    // provider, and the hashes of the EXACT intent and stdin bytes that were delivered.
    for (const rec of trace) {
      expect(rec.bind.runNonce).toBe(h.ctx.runNonce);
      expect(rec.bind.callNonce).toMatch(/^[0-9a-f]{32}$/);
      expect(rec.bind.callId).toBe(rec.callId);
      expect(rec.bind.intentSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(rec.bind.stdinSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(rec.bind.stdinBytes).toBeGreaterThan(0);
      expect(Number.isInteger(rec.bind.routeEpoch)).toBe(true);
    }
    const reserveRecs = trace.filter((t) => t.type === "reserve");
    expect(new Set(reserveRecs.map((t) => t.bind.callNonce)).size).toBe(2); // two DISTINCT physical calls
    expect(reserveRecs.map((t) => t.bind.provider)).toEqual(["opus", "gpt"]);

    // The PRIMARY's settlement carries a MAC'd TRUSTED-FALLBACK attestation — the only authority that may
    // authorize billing a second provider. Every field in it was derived by the LEDGER: its own ESRCH
    // proof of the exact process group it probed, the transcript it re-read by inode, and the canonical
    // `rate_limit_event` frame it re-located by REPLAYING those durable bytes through the production
    // Claude state machine. That limit frame is the whole authority — an accounted-terminal may not carry
    // one, so the two can never be folded into each other.
    const primaryAttest = trace[primarySettle].attest;
    expect(primaryAttest?.payload.kind).toBe("trusted-fallback");
    // The scope is the one the provider actually ran inside, and its proof is DERIVED from that identity —
    // for the strong backend, the kernel's own removal of the cgroup plus a dead process group.
    const scope = parseScopeId(primaryAttest!.payload.scopeId)!;
    expect(scope, "the attested scope id does not name an owned scope").toBeDefined();
    expect(primaryAttest?.payload.scopeBackend).toBe(scope.backend);
    expect(primaryAttest?.payload.scopeReapProof).toBe(reapProofOf(scope));
    expect(primaryAttest?.payload.transcriptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(primaryAttest?.payload.limitSha256, "the fallback authority pins no rate_limit_event frame").toMatch(/^[0-9a-f]{64}$/);
    expect(primaryAttest?.tag).toMatch(/^[0-9a-f]{64}$/);
    // …and the LEDGER agrees, folding it back from bytes: GPT is authorized, but no cost is trusted.
    expect(h.ctx.ledger.settlementOf(trace[primarySettle].callId)).toEqual({ settled: true, costTrusted: false, fallbackAuthorized: true });

    // The FALLBACK's own settlement authorizes NOTHING further. Codex emits no authoritative USD cost, so
    // its turn is not an accounted terminal either: it settles UNCERTAIN with no attestation at all, and
    // retains its worst case. A fallback can never buy another fallback.
    const fbSettle = trace.find((t) => t.type === "settle" && t.callId.includes("gpt-fallback"))!;
    expect(fbSettle.attest, "the fallback minted authority of its own").toBeUndefined();
    expect(h.ctx.ledger.settlementOf(fbSettle.callId)).toEqual({ settled: true, costTrusted: false, fallbackAuthorized: false });

    // NO PROCESS OVERLAP: after the routed turn both provider groups were reaped and disowned.
    expect(h.ctx.ownedGroups.size).toBe(0);
    expect(h.ctx.children.size).toBe(0);
  }, 30000);

  it("(wave-8b2) under a POSITIVE budget the rejected primary receipt is explicitly UNKNOWN before GPT reserves", async () => {
    // A zero-budget known-$0 receipt is not sufficient evidence. Under a POSITIVE budget with room for
    // both reservations, the primary's canonical rejection must settle as EXPLICITLY UNKNOWN
    // (reported:false) — retaining its full worst-case reservation — and only THEN may the fallback
    // reserve. This proves the fallback is gated on a durable unknown/worst-case-safe settlement, not
    // on a naming convention or an in-memory flag.
    const h = setup("loop-routed-posbudget-", { budgetUsd: 10, maxCostPerCallUsd: 0.5 });
    writeFileSync(h.control, "limit");
    h.setClock(1_000_000);
    const r = await routeOnce(h);
    expect(r.ok).toBe(true); // fallback (codex) succeeded

    const full = reservationTrace(h.ctx.boardDir);
    const iPrimaryReserve = full.findIndex((t) => t.type === "reserve" && t.callId.includes("opus-primary"));
    const iPrimarySettle = full.findIndex((t) => t.type === "settle" && t.callId.includes("opus-primary"));
    const iFallbackReserve = full.findIndex((t) => t.type === "reserve" && t.callId.includes("gpt-fallback"));
    // Ordering: primary reserve → primary settle → fallback reserve.
    expect(iPrimaryReserve).toBeGreaterThanOrEqual(0);
    expect(iPrimarySettle).toBeGreaterThan(iPrimaryReserve);
    expect(iFallbackReserve).toBeGreaterThan(iPrimarySettle);
    // The primary settle is EXPLICITLY UNKNOWN: reported:false, usdNano:"0" — never a trusted amount.
    // (The rejection exits non-zero, so its cost is not provable even though the scope WAS reaped.)
    expect(full[iPrimarySettle].reported).toBe(false);
    expect(full[iPrimarySettle].usdNano).toBe("0");
    expect(full[iPrimarySettle].attest?.payload.costProvenance).toBe("unknown");
    expect(full[iPrimarySettle].attest?.payload.usdNano).toBe("0");
    // Its attestation still authorizes the fallback — a SEPARATE claim from "we know the cost". Proving
    // the turn was REJECTED buys a route; it never buys a discount on the turn that failed.
    expect(full[iPrimarySettle].attest?.payload.kind).toBe("trusted-fallback");
    expect(h.ctx.ledger.settlementOf(full[iPrimarySettle].callId).costTrusted).toBe(false);
    expect(h.ctx.ledger.settlementOf(full[iPrimarySettle].callId).fallbackAuthorized).toBe(true);
    // The primary reservation was ENFORCED (positive budget) with a positive worst case that an
    // unproven settle RETAINS — so effective spend still counts it in full (never shrunk to $0).
    const worstCase = BigInt(full[iPrimaryReserve].worstCaseNano!);
    expect(worstCase).toBeGreaterThan(0n);
    expect(h.ctx.ledger.effectiveSpendNano()).toBeGreaterThanOrEqual(worstCase);
  }, 30000);

  it("(wave-8b) a $0.60 reservation with UNTRUSTED $0.01 output leaves effective spend $0.60 and invokes no GPT", async () => {
    // The claude turn emits a well-formed SUCCESS terminal claiming total_cost_usd:0.01, but leaves a
    // surviving same-PGID descendant → the owned scope is UNTRUSTED. An untrusted turn must NOT settle
    // its claimed low cost; the full $0.60 worst-case reservation is retained, and no fallback runs.
    const h = setup("loop-routed-untrusted-", { claudeCmd: FAKE_CLAUDE_UNTRUSTED, budgetUsd: 0.6, maxCostPerCallUsd: 0.6 });
    h.setClock(1_000_000);
    const r = await routeOnce(h);
    expect(r.ok).toBe(false); // untrusted scope → the turn is UNCERTAIN, never accepted
    expect(r.scopeTrusted).toBe(false);
    // Effective spend retains the full worst case — the fabricated $0.01 never shrank it.
    expect(h.ctx.ledger.effectiveSpend()).toBe(0.6);
    // …and the durable settlement carries NO attestation at all: the scope was never proven empty, so
    // there is nothing to bind and nothing is authorized.
    const settle = reservationTrace(h.ctx.boardDir).find((t) => t.type === "settle");
    expect(settle?.attest).toBeUndefined();
    expect(h.ctx.ledger.settlementOf(settle!.callId)).toEqual({ settled: true, costTrusted: false, fallbackAuthorized: false });
    // No GPT: an untrusted turn is not a canonical limit, so the fallback never launches.
    expect(capturedProviders(h.capture)).toEqual(["claude"]);
    expect(h.ctx.ownedGroups.size).toBe(0); // the survivor was still reaped + disowned
  }, 30000);

  it("(wave-8b) a SLOW rejection anchors the cooldown at the OBSERVED rejection time, not call-start", async () => {
    const h = setup("loop-routed-slow-");
    writeFileSync(h.control, "limit");
    const T0 = 1_000_000;
    const SLOW = 30_000; // the rejection is observed 30s AFTER the call started
    // First clock read (call-start / provider selection) = T0; every later read (the observed
    // rejection time) = T0 + SLOW. If the cooldown were (wrongly) anchored at call-start it would end
    // at T0 + 900s; anchored at the observed rejection it ends at T0 + SLOW + 900s.
    let reads = 0;
    h.ctx.clock = () => (reads++ === 0 ? T0 : T0 + SLOW);
    const r = await routeOnce(h);
    expect(r.ok).toBe(true);
    const health = loadHealth(h.ctx.runDir);
    expect(health.opus?.cooldownUntil).toBe(T0 + SLOW + 900_000);
    expect(health.opus?.cooldownUntil).toBeGreaterThan(T0 + 900_000); // NOT anchored at call-start
  }, 30000);
});

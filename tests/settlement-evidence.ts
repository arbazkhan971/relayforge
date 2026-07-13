import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { openLedger, type CallBinding, type LedgerHandle, type LedgerIO } from "../src/ledger.js";
import { runHeadlessChild } from "../src/orchestrator.js";
import type { SettlementOutcome } from "../src/settlement-kernel.js";

/**
 * GENUINE SETTLEMENT EVIDENCE — the only kind there is.
 *
 * The forgeable settlement surface is gone: there is no `LedgerHandle.settle`, no `SettlementReceipt` to
 * construct, and no `validateReceipt` to satisfy. A test cannot state a cost, a reap, a transcript, or a
 * fallback any more than production can. So this module does not GRANT authority — it has none to grant.
 * It drives the same two production paths every real turn takes:
 *
 *     ledger.reserve(bind, worstCase, budget)          // the worst case is held
 *     runHeadlessChild(…)                              // a REAL detached child, a REAL durable transcript
 *     ledger.settleCompleted({ bind, providerKind, stdinDelivered, result })
 *
 * `settleCompleted` then re-reads the transcript from disk under the ledger's own confinement root,
 * re-frames it through the production framer and provider state machine, re-probes the process group the
 * child actually spawned, re-checks the stdin the reservation was bound to, and only then presents derived
 * evidence to a `#private` mint no caller can name. Everything a test gets back — a trusted cost, a
 * fallback authority, an UNCERTAIN refusal — was earned that way.
 *
 * That is why the helpers below take a COST rather than returning one: the number a test wants comes from
 * a real provider reporting it on the wire (`COST_USD`), not from a test asserting it into the ledger. If
 * this file could shortcut any of that, so could an attacker.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SUCCESS_PROVIDER = resolve(HERE, "fixtures/settlement-provider.mjs");
const LIMIT_PROVIDER = resolve(HERE, "fixtures/settlement-limit-provider.mjs");
const PATH = process.env.PATH ?? "";

export const sha = (v: Buffer | string): string => createHash("sha256").update(v).digest("hex");
export const nonce = (): string => randomBytes(32).toString("hex");

/** The prompt every genuine turn is driven with. A reservation is BOUND to exactly these bytes, and the
 *  kernel refuses to settle a call whose delivered stdin is not the stdin it reserved. */
export const PROMPT = "implement the thing\n";
export const STDIN = Buffer.from(PROMPT, "utf8");

/** `runHeadlessChild` reads `ctx.children` / `ctx.ownedGroups` / `ctx.loop` / `ctx.scopesPath`. The last
 *  is not optional: the launch handshake fsyncs the scope's identity into that journal BEFORE the
 *  provider is released to exec, and refuses the launch if it cannot. */
function fakeCtx(runDir: string): any {
  return { children: new Set(), ownedGroups: new Set(), loop: { cadenceMinutes: 5 }, scopesPath: join(runDir, ".loop_scopes") };
}

/** The completed call exactly as the production transport resolved it. */
export type TurnResult = Awaited<ReturnType<typeof runHeadlessChild>>;

/**
 * A run tree: a private 0700 board for the ledger's journal, and a transcript root the ledger confines
 * every piece of evidence to. Repo-local (never `/tmp`, whose path may contain a symlinked component that
 * the kernel's confinement walk rightly refuses).
 */
export type GenuineRun = {
  runDir: string;
  boardDir: string;
  run: string;
  ledger: LedgerHandle;
};

/** Create the shared repo-local root for one test file, and return a factory + its cleanup. */
export function evidenceRoot(name: string): {
  openRun: (opts?: { io?: LedgerIO; groupAlive?: (pid: number) => boolean }) => GenuineRun;
  cleanup: () => void;
} {
  const root = resolve(HERE, `.tmp-${name}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return {
    openRun: (opts = {}) => {
      const runDir = mkdtempSync(join(root, "run-"));
      const boardDir = join(runDir, "board");
      mkdirSync(boardDir, { mode: 0o700 });
      const run = nonce();
      const ledger = openLedger({ dir: boardDir, runNonce: run, transcriptRoot: runDir, ...opts });
      return { runDir, boardDir, run, ledger };
    },
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

/** A binding for a call that will be driven with the REAL `PROMPT`, so its stdin hash is the truth. */
export function bindFor(run: string, callId: string, over: Partial<CallBinding> = {}): CallBinding {
  return {
    runNonce: run,
    callNonce: randomBytes(16).toString("hex"),
    callId,
    reservationId: randomBytes(16).toString("hex"),
    routeEpoch: 1,
    provider: "claude",
    model: "opus-4.8",
    attempt: 0,
    intentSha256: sha(`intent:${callId}`),
    stdinSha256: sha(STDIN),
    stdinBytes: STDIN.length,
    ...over
  };
}

/** What a genuine turn should look like on the wire. */
export type TurnSpec =
  /** A successful terminal reporting exactly `cost` USD (the fixture writes it as `total_cost_usd`). */
  | { cost: number | string }
  /** A successful terminal that reports NO cost at all — a subscription turn. Never trusted spend. */
  | { noCost: true }
  /** One of `settlement-limit-provider.mjs`'s usage-rejection modes (`canonical` is the only authority). */
  | { limitMode: string };

function providerFor(spec: TurnSpec): { script: string; env: Record<string, string> } {
  if ("limitMode" in spec) return { script: LIMIT_PROVIDER, env: { LIMIT_MODE: spec.limitMode } };
  if ("noCost" in spec) return { script: SUCCESS_PROVIDER, env: { NO_COST: "1" } };
  return { script: SUCCESS_PROVIDER, env: { COST_USD: String(spec.cost) } };
}

/** ONE real turn through the production transport: a detached child, a private durable transcript, a
 *  framed stdout, and a process group we can prove empty. No fixture is handed to the kernel. */
export async function runTurn(runDir: string, spec: TurnSpec): Promise<TurnResult> {
  const { script, env } = providerFor(spec);
  return runHeadlessChild(
    fakeCtx(runDir),
    "node",
    [script],
    { PATH, ...env },
    "",
    runDir,
    PROMPT,
    join(runDir, "transcripts"),
    20_000,
    "claude"
  );
}

/**
 * Reserve the worst case and run ONE genuine turn against it. Nothing is settled yet — the caller decides
 * what to hand the kernel, which is what lets a test vary a single fact (a mutated binding, a tampered
 * transcript, a foreign stdin) and watch the production path refuse it.
 */
export async function reserveAndRun(
  h: GenuineRun,
  callId: string,
  opts: { worstCase: number; budget: number; spec?: TurnSpec; bind?: Partial<CallBinding> }
): Promise<{ bind: CallBinding; result: TurnResult }> {
  const bind = bindFor(h.run, callId, opts.bind);
  expect(h.ledger.reserve(bind, opts.worstCase, opts.budget), `reserve ${callId}`).toBe(true);
  const result = await runTurn(h.runDir, opts.spec ?? { cost: 0.25 });
  expect(result.transportOk, `the transport itself must be sound before the kernel judges it: ${result.uncertainReason}`).toBe(true);
  return { bind, result };
}

/** Settle a completed call through the production kernel — the only door to the mint. */
export function settle(h: GenuineRun, bind: CallBinding, result: TurnResult, stdinDelivered: Buffer = STDIN): SettlementOutcome {
  return h.ledger.settleCompleted({ bind, providerKind: "claude", stdinDelivered, result });
}

/**
 * The common case: reserve, run a genuine turn reporting `cost`, and settle it as PROVIDER-REPORTED spend.
 * Asserts the mint actually issued — so a test that means "$0.10 is now proven" fails loudly if the kernel
 * ever quietly downgrades it to UNCERTAIN, rather than silently measuring a worst case instead.
 */
export async function settleTrusted(
  h: GenuineRun,
  callId: string,
  opts: { worstCase: number; budget: number; cost: number }
): Promise<CallBinding> {
  const { bind, result } = await reserveAndRun(h, callId, { ...opts, spec: { cost: opts.cost } });
  const outcome = settle(h, bind, result);
  expect(outcome, `a genuine $${opts.cost} turn did not settle as trusted cost`).toMatchObject({ kind: "trusted", usd: opts.cost });
  return bind;
}

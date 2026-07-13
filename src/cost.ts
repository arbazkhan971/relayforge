import {
  appendFileSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  ftruncateSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";

/**
 * Cost ledger — a $-budget is the primary termination signal for autonomous coding
 * agents (SWE-agent style). We parse the spend each provider reports in its structured
 * output and append it to an append-only ledger, then gate the loop on a configured cap.
 */

export type CostEntry = {
  ts: string;
  role: string;
  taskId: string;
  usd: number;
  inputTokens?: number;
  outputTokens?: number;
};

export function costLedgerPath(boardDir: string): string {
  return resolve(boardDir, "costs.jsonl");
}

/**
 * Extract the USD cost and token usage an agent reported in its JSON output.
 * Claude exposes `total_cost_usd` + `usage.{input,output}_tokens`; other providers may
 * expose `cost`/`usage`. Returns zeros when nothing is reported (e.g. subscription auth).
 */
export function parseCost(stdout: string): {
  usd: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Whether the provider actually reported a USD cost. When false, `usd` is a placeholder
   *  0 and MUST NOT be treated as "this turn was free" — the true cost is unknown. */
  reported: boolean;
} {
  const usdMatch = /"total_cost_usd"\s*:\s*([0-9.]+)/.exec(stdout) ?? /"cost(?:_usd)?"\s*:\s*([0-9.]+)/.exec(stdout);
  const inMatch = /"input_tokens"\s*:\s*([0-9]+)/.exec(stdout);
  const outMatch = /"output_tokens"\s*:\s*([0-9]+)/.exec(stdout);
  return {
    usd: usdMatch ? Number(usdMatch[1]) : 0,
    inputTokens: inMatch ? Number(inMatch[1]) : undefined,
    outputTokens: outMatch ? Number(outMatch[1]) : undefined,
    reported: Boolean(usdMatch)
  };
}

export function recordCost(boardDir: string, entry: CostEntry): void {
  appendFileSync(costLedgerPath(boardDir), `${JSON.stringify(entry)}\n`);
}

export function totalSpend(boardDir: string): number {
  const path = costLedgerPath(boardDir);
  if (!existsSync(path)) return 0;
  let total = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      total += Number((JSON.parse(trimmed) as CostEntry).usd) || 0;
    } catch {
      // skip torn line
    }
  }
  return total;
}

export function initCostLedger(boardDir: string): void {
  const path = costLedgerPath(boardDir);
  if (!existsSync(path)) writeFileSync(path, "");
}

// ---------------------------------------------------------------------------
// The durable RESERVATION ledger moved to `./ledger.ts`.
//
// It could not stay here: its authority was a PATHNAME (every call re-resolved the leaf and
// `O_CREAT`d it if absent), so replacing the file between calls silently reset the budget, and a
// module-global test hook could alter unrelated production transactions. It is now a run-scoped
// `LedgerHandle` with a durable generation (epoch/genesis/expected inodes bound to the run nonce),
// kernel `flock`, a write-ahead intent, and per-handle injected IO (wave-8d audit B1-B7).
//
// What remains below is the ADVISORY cost log (costs.jsonl) and the budget POLICY helpers. The
// advisory log is for humans and the dashboard; it is never the authority for a spend decision.
// ---------------------------------------------------------------------------

/** The minimal shape of loop budget config `perCallReservation`/`assertBudgetEnforceable` need. */
export type BudgetMode = "unlimited" | "estimated-usd" | "hard-usd" | "subscription-quota";
export type BudgetPolicy = { budgetUsd?: number; maxCostPerCallUsd?: number; budgetMode?: BudgetMode };

/**
 * Resolve the EFFECTIVE budget mode. An explicit `budgetMode` is honored; otherwise we default
 * honestly: a positive `budgetUsd` means `estimated-usd` (a soft post-response cap — the only thing
 * a direct CLI can truthfully offer), and a zero/unset budget means `unlimited`.
 */
export function resolveBudgetMode(loop: BudgetPolicy): BudgetMode {
  if (loop.budgetMode) return loop.budgetMode;
  return (loop.budgetUsd ?? 0) > 0 ? "estimated-usd" : "unlimited";
}

/**
 * The honest cross-route budget contract, checked BEFORE planning. `routeGatewayCapable` is the
 * `preauthorizingGateway` flag of EVERY route the run may use (planner/worker/reviewer/probe/
 * fallback). Returns an error string to fail closed with, or undefined when the run may proceed.
 *
 *  - `hard-usd` demands a provable ceiling: a positive budget, a valid per-call cap, AND a
 *    preauthorizing gateway on EVERY route (a direct CLI's post-response cap can overshoot by the
 *    last request, so it can never satisfy hard USD). Any bare-CLI route → refuse.
 *  - `estimated-usd` is the soft ledger: it just needs a valid per-call cap (see below).
 *  - `subscription-quota` must NOT carry a USD budget (there is no USD metering to enforce).
 *  - `unlimited` needs nothing.
 */
export function assertBudgetContract(loop: BudgetPolicy, routeGatewayCapable: boolean[]): string | undefined {
  const mode = resolveBudgetMode(loop);
  const budget = loop.budgetUsd ?? 0;
  if (mode === "unlimited") return undefined;
  if (mode === "subscription-quota") {
    if (budget > 0) {
      return `budgetMode 'subscription-quota' does not meter USD; remove budgetUsd (${budget}) or choose 'estimated-usd'/'hard-usd'.`;
    }
    return undefined;
  }
  if (mode === "estimated-usd") return assertBudgetEnforceable(loop);
  // hard-usd — still surface the obvious misconfigurations first for a precise message…
  if (budget <= 0) {
    return "budgetMode 'hard-usd' requires a positive budgetUsd to enforce a ceiling.";
  }
  const capErr = assertBudgetEnforceable(loop);
  if (capErr) return capErr;
  // …but a hard USD ceiling can ONLY be enforced by a real preauthorizing billing gateway adapter that
  // provides a server-side cap, an idempotency key, an authoritative receipt/lookup, and a recovery
  // lookup. A self-asserted `preauthorizingGateway: true` boolean is NOT such an adapter — it proves
  // nothing. No enforcing gateway adapter is integrated in this build, so `hard-usd` ALWAYS fails
  // closed regardless of the per-route flags (`routeGatewayCapable` is reserved for a future adapter).
  void routeGatewayCapable;
  return (
    "budgetMode 'hard-usd' is unavailable: enforcing a hard USD ceiling requires a real preauthorizing " +
    "billing-gateway adapter (server-side cap, idempotency key, authoritative receipt/lookup, and recovery lookup). " +
    "A self-asserted `preauthorizingGateway: true` flag is not enforcement, and a direct Claude/Codex CLI applies its " +
    "budget cap only AFTER a response (overshooting by the last request). No such adapter is integrated, so 'hard-usd' " +
    "fails closed. Use budgetMode 'estimated-usd' (soft post-response ledger), 'subscription-quota', or 'unlimited'."
  );
}

/**
 * The worst-case USD to reserve before ONE physical provider call. A zero/unset budget reserves 0
 * (unlimited). Under a positive budget it is the validated per-call cap — NOT the whole budget, so
 * a positive budget can fund many calls. If a positive budget somehow lacks a per-call cap we fail
 * closed by reserving the entire budget (at most one call), but `assertBudgetEnforceable` refuses
 * such a run before planning so this path is never reached in practice.
 */
export function perCallReservation(loop: BudgetPolicy, budgetUsd: number): number {
  if (budgetUsd <= 0) return 0;
  const cap = loop.maxCostPerCallUsd ?? 0;
  return cap > 0 ? cap : budgetUsd;
}

/**
 * Refuse a positive-budget run BEFORE planning unless it has a validated, enforceable per-call cost
 * cap: `maxCostPerCallUsd` must be > 0 and <= `budgetUsd`. Without it a hard budget is effectively
 * one-call-only (every call would reserve the whole budget), which is not a functional budget.
 * Returns an error string to fail closed with, or undefined when the budget is enforceable (or
 * unset/zero = unlimited, which needs no per-call cap).
 */
export function assertBudgetEnforceable(loop: BudgetPolicy): string | undefined {
  const budget = loop.budgetUsd ?? 0;
  if (budget <= 0) return undefined;
  const cap = loop.maxCostPerCallUsd ?? 0;
  if (cap <= 0) {
    return `A positive budget (${budget} USD) requires an enforceable per-call cap. Set loop.maxCostPerCallUsd (> 0 and <= ${budget}) so the budget can fund multiple calls without overshooting.`;
  }
  if (cap > budget) {
    return `loop.maxCostPerCallUsd (${cap} USD) exceeds the run budget (${budget} USD); a single call could overshoot. Lower it to <= ${budget}.`;
  }
  return undefined;
}

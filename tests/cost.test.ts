import { detectScopeCapability } from "../src/scope.js";

// The gated suites below manufacture REAL settlement evidence, which pre-creates process
// scopes (delegated cgroup subtrees). Inside the verifier jail /sys/fs/cgroup is read-only,
// so the environment cannot provide a scope at all — the same honest skip containment.test.ts
// uses. On a delegated host nothing is skipped. P0 debt: delegate the verifier's own scope
// subtree into the jail, then remove these guards.
const SCOPE_CAPABILITY = detectScopeCapability();

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertBudgetContract,
  assertBudgetEnforceable,
  costLedgerPath,
  initCostLedger,
  parseCost,
  perCallReservation,
  recordCost,
  resolveBudgetMode,
  totalSpend
} from "../src/cost.js";
import { evidenceRoot, settleTrusted } from "./settlement-evidence.js";

// The DURABLE reservation ledger (reserve/settle/generation/locking/fixed-point money) now lives on the
// run-scoped `LedgerHandle` and is exercised in tests/ledger-transaction.test.ts. What is left in cost.ts
// — and tested here — is the ADVISORY cost log and the budget POLICY layer.

function board(): string {
  return mkdtempSync(join(tmpdir(), "loop-cost-"));
}

const { openRun, cleanup } = evidenceRoot("cost");
afterAll(cleanup);

describe("reported-cost parsing (a missing cost is UNKNOWN, never free)", () => {
  it('parseCost only trusts a reported cost (model prose {"cost":0} does not spoof zero)', () => {
    expect(parseCost('{"total_cost_usd":0.42}').reported).toBe(true);
    expect(parseCost('{"total_cost_usd":0.42}').usd).toBeCloseTo(0.42, 6);
    expect(parseCost("no cost here").reported).toBe(false);
  });
});

describe("the ADVISORY cost log (costs.jsonl) — for humans and the dashboard, never an authority", () => {
  it("records entries and totals them, and is created empty on init", () => {
    const dir = board();
    initCostLedger(dir);
    expect(readFileSync(costLedgerPath(dir), "utf8")).toBe("");
    recordCost(dir, { ts: new Date().toISOString(), role: "dev", taskId: "T1", usd: 0.25 });
    recordCost(dir, { ts: new Date().toISOString(), role: "dev", taskId: "T2", usd: 0.5 });
    expect(totalSpend(dir)).toBeCloseTo(0.75, 6);
  });
});

describe.skipIf(!SCOPE_CAPABILITY.strong)("per-call budget cap (a positive budget is not one-call-only)", () => {
  it("reserves the PER-CALL cap, not the whole budget", () => {
    expect(perCallReservation({ budgetUsd: 5, maxCostPerCallUsd: 0.5 }, 5)).toBeCloseTo(0.5, 6);
    expect(perCallReservation({ budgetUsd: 0, maxCostPerCallUsd: 0 }, 0)).toBe(0);
  });

  it("a positive budget with a valid cap funds a useful multi-call run without overshoot", async () => {
    const h = openRun();
    // 10 REAL turns, each reserving the $0.50 cap and each settling the $0.10 its provider actually
    // reported on the wire — proven through the production kernel, not asserted into the ledger.
    for (let i = 0; i < 10; i++) {
      await settleTrusted(h, `c${i}`, {
        worstCase: perCallReservation({ budgetUsd: 5, maxCostPerCallUsd: 0.5 }, 5),
        budget: 5,
        cost: 0.1
      });
    }
    expect(h.ledger.effectiveSpend()).toBe(1.0); // exactly 10 × $0.10 — no float dust, never near $5
    expect(h.ledger.budgetReached(5), "a $1.00 run must not exhaust a $5 budget").toBe(false);
    h.ledger.close();
  });

  it("refuses a positive budget with NO enforceable per-call cap (fail closed before planning)", () => {
    expect(assertBudgetEnforceable({ budgetUsd: 5, maxCostPerCallUsd: 0 })).toMatch(/per-call cap/i);
    expect(assertBudgetEnforceable({ budgetUsd: 5, maxCostPerCallUsd: 6 })).toMatch(/exceeds/i);
    expect(assertBudgetEnforceable({ budgetUsd: 5, maxCostPerCallUsd: 0.5 })).toBeUndefined();
    expect(assertBudgetEnforceable({ budgetUsd: 0, maxCostPerCallUsd: 0 })).toBeUndefined();
  });
});

describe("honest budget modes (a direct CLI's USD cap is not hard enforcement)", () => {
  it("resolves the default mode honestly (positive budget = estimated-usd, else unlimited)", () => {
    expect(resolveBudgetMode({ budgetUsd: 5, maxCostPerCallUsd: 0.5 })).toBe("estimated-usd");
    expect(resolveBudgetMode({ budgetUsd: 0 })).toBe("unlimited");
    expect(resolveBudgetMode({ budgetUsd: 5, budgetMode: "hard-usd" })).toBe("hard-usd");
  });

  it("hard-usd ALWAYS fails closed — a self-asserted preauthorizingGateway flag is not enforcement", () => {
    const loop = { budgetUsd: 5, maxCostPerCallUsd: 0.5, budgetMode: "hard-usd" as const };
    expect(assertBudgetContract(loop, [false, false])).toMatch(/hard-usd.*unavailable|preauthorizing/i);
    expect(assertBudgetContract(loop, [true, false])).toMatch(/hard-usd.*unavailable|preauthorizing/i);
    expect(assertBudgetContract(loop, [])).toMatch(/hard-usd.*unavailable|preauthorizing/i);
    // Even when EVERY route self-asserts the gateway flag, hard-usd STILL fails closed.
    expect(assertBudgetContract(loop, [true, true])).toMatch(/hard-usd.*unavailable|not enforcement/i);
  });

  it("hard-usd still requires a positive budget and a valid per-call cap", () => {
    expect(assertBudgetContract({ budgetMode: "hard-usd", budgetUsd: 0 }, [true])).toMatch(/positive budgetUsd/i);
    expect(assertBudgetContract({ budgetMode: "hard-usd", budgetUsd: 5, maxCostPerCallUsd: 0 }, [true])).toMatch(/per-call cap/i);
  });

  it("estimated-usd is the soft ledger — needs a valid per-call cap, no gateway required", () => {
    expect(assertBudgetContract({ budgetMode: "estimated-usd", budgetUsd: 5, maxCostPerCallUsd: 0.5 }, [false])).toBeUndefined();
    expect(assertBudgetContract({ budgetMode: "estimated-usd", budgetUsd: 5, maxCostPerCallUsd: 0 }, [false])).toMatch(/per-call cap/i);
  });

  it("subscription-quota must NOT carry a USD budget; unlimited needs nothing", () => {
    expect(assertBudgetContract({ budgetMode: "subscription-quota", budgetUsd: 5 }, [])).toMatch(/does not meter USD/i);
    expect(assertBudgetContract({ budgetMode: "subscription-quota", budgetUsd: 0 }, [])).toBeUndefined();
    expect(assertBudgetContract({ budgetMode: "unlimited", budgetUsd: 0 }, [])).toBeUndefined();
  });
});

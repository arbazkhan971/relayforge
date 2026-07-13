import { describe, expect, it } from "vitest";
import { createStreamingNormalizer, normalizeTurn } from "../src/normalize.js";

// Real-shaped Claude Code 2.1.207 stream-JSON: the stream ALWAYS begins with a `system`/`init`
// record carrying a `tools` array AND the authoritative `session_id`. In the real dialect every
// authoritative `rate_limit_event` and terminal `result` carries that SAME session_id. The helper
// auto-correlates those authoritative records to the init session unless a test set one explicitly
// (adversarial foreign/missing-session cases build their streams by hand to bypass this).
function claudeStream(records: Array<Record<string, unknown>>): string {
  return (
    records
      .map((r) => {
        // Every AUTHORITATIVE record (assistant, rate_limit_event, result) carries the bound session
        // id in the real 2.1.207 dialect. Stamp it unless a test set one explicitly (adversarial
        // foreign/missing-session cases build their streams by hand to bypass this).
        if ((r.type === "assistant" || r.type === "result" || r.type === "rate_limit_event") && !("session_id" in r)) {
          return JSON.stringify({ ...r, session_id: "s1" });
        }
        return JSON.stringify(r);
      })
      .join("\n") + "\n"
  );
}

const INIT = { type: "system", subtype: "init", tools: ["Task", "Bash", "Edit"], model: "claude-opus-4", cwd: "/tmp", session_id: "s1" };

describe("normalizeTurn — Claude stream-JSON", () => {
  it("returns the TERMINAL assistant text, never the init tools array", () => {
    const stream = claudeStream([
      INIT,
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "thinking..." }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: {} }] } },
      { type: "result", subtype: "success", is_error: false, result: '[{"title":"do it","assignee":"impl"}]', total_cost_usd: 0.12, usage: { input_tokens: 100, output_tokens: 50 } }
    ]);
    const n = normalizeTurn("claude", stream);
    expect(n.finalText).toBe('[{"title":"do it","assignee":"impl"}]');
    expect(n.finalText).not.toContain("Task");
    expect(n.success).toBe(true);
    expect(n.hasTerminal).toBe(true);
    expect(n.explicitLimit).toBe(false);
    expect(n.usd).toBeCloseTo(0.12);
    expect(n.costReported).toBe(true);
    expect(n.inputTokens).toBe(100);
    expect(n.outputTokens).toBe(50);
  });

  it("falls back to the last assistant text when the terminal has no result string", () => {
    const stream = claudeStream([
      INIT,
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "final answer" }] } },
      { type: "result", subtype: "success", is_error: false, total_cost_usd: 0 }
    ]);
    expect(normalizeTurn("claude", stream).finalText).toBe("final answer");
  });

  it("a TERMINAL SUCCESS wins over an earlier tool/nested error and never falls back", () => {
    const stream = claudeStream([
      INIT,
      { type: "user", message: { role: "user", content: [{ type: "tool_result", is_error: true, content: "a tool failed" }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: '{"is_error":true,"error":{"type":"rate_limit_error"}}' }] } },
      { type: "result", subtype: "success", is_error: false, result: "done" }
    ]);
    const n = normalizeTurn("claude", stream);
    expect(n.success).toBe(true);
    expect(n.explicitLimit).toBe(false); // nested/model prose can NEVER set the limit
  });

  it("(wave-6) CANONICAL usage rejection: a rejected rate_limit_event + failed result authorizes fallback", () => {
    // The real 2.1.207 dialect: a usage rejection is a SEPARATE top-level rate_limit_event, NOT a
    // result subtype. The failing result carries a generic execution subtype; the rejected snapshot
    // that precedes it is what authorizes GPT. This is the exact bug the wave-6 audit reproduced.
    for (const sub of ["error_during_execution", "error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"]) {
      const s = claudeStream([
        INIT,
        { type: "rate_limit_event", rate_limit_info: { status: "rejected" } },
        { type: "result", subtype: sub, is_error: true }
      ]);
      const n = normalizeTurn("claude", s);
      expect(n.success).toBe(false);
      expect(n.explicitLimit).toBe(true);
    }
  });

  it("(wave-8) terminal-owned rate_limit_info is NOT trusted as authority (no pinned CLI fixture)", () => {
    // The canonical usage rejection is a SEPARATE top-level rate_limit_event; the real 2.1.207
    // dialect is not proven to emit an authoritative rejection ON the result record. Absent a pinned
    // fixture proving that dialect, a result carrying its own `rejected` rate_limit_info must NOT
    // authorize the fallback — only a preceding matching rate_limit_event does.
    const s = claudeStream([INIT, { type: "result", subtype: "error_during_execution", is_error: true, rate_limit_info: { status: "rejected" } }]);
    expect(normalizeTurn("claude", s).explicitLimit).toBe(false);
  });

  it("(wave-6) IMPOSSIBLE terminal shapes are not usage limits without a rejected snapshot", () => {
    // `error_usage_limit` and a rate-typed error object are NOT part of the real dialect; on their
    // own (no top-level rejected snapshot) they are generic failures that never fall back.
    const s1 = claudeStream([INIT, { type: "result", subtype: "error_usage_limit", is_error: true }]);
    expect(normalizeTurn("claude", s1).explicitLimit).toBe(false);
    const s2 = claudeStream([INIT, { type: "result", subtype: "error", is_error: true, error: { type: "rate_limit_error" } }]);
    expect(normalizeTurn("claude", s2).explicitLimit).toBe(false);
  });

  it("(wave-6) rejected → allowed_warning → failure CLEARS the rejection (no fallback)", () => {
    const s = claudeStream([
      INIT,
      { type: "rate_limit_event", rate_limit_info: { status: "rejected" } },
      { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning" } },
      { type: "result", subtype: "error_during_execution", is_error: true }
    ]);
    expect(normalizeTurn("claude", s).explicitLimit).toBe(false);
  });

  it("(wave-6) rejected → allowed → failure CLEARS the rejection (no fallback)", () => {
    const s = claudeStream([
      INIT,
      { type: "rate_limit_event", rate_limit_info: { status: "rejected" } },
      { type: "rate_limit_event", rate_limit_info: { status: "allowed" } },
      { type: "result", subtype: "error_during_execution", is_error: true }
    ]);
    expect(normalizeTurn("claude", s).explicitLimit).toBe(false);
  });

  it("(wave-6) rejected → success WINS (no fallback)", () => {
    const s = claudeStream([
      INIT,
      { type: "rate_limit_event", rate_limit_info: { status: "rejected" } },
      { type: "result", subtype: "success", is_error: false, result: "ok" }
    ]);
    const n = normalizeTurn("claude", s);
    expect(n.success).toBe(true);
    expect(n.explicitLimit).toBe(false);
  });

  it("(wave-6) allowed_warning ALONE + failure is not a limit; a rejected snapshot with NO terminal is UNCERTAIN", () => {
    const warn = claudeStream([INIT, { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning" } }, { type: "result", subtype: "error_during_execution", is_error: true }]);
    expect(normalizeTurn("claude", warn).explicitLimit).toBe(false);
    const noTerminal = claudeStream([INIT, { type: "rate_limit_event", rate_limit_info: { status: "rejected" } }]);
    const n = normalizeTurn("claude", noTerminal);
    expect(n.hasTerminal).toBe(false);
    expect(n.explicitLimit).toBe(false);
  });

  it("(wave-6) a rejected snapshot bound to a FOREIGN session is ignored", () => {
    const s = [
      { type: "system", subtype: "init", session_id: "s1", tools: [] },
      { type: "rate_limit_event", session_id: "other", rate_limit_info: { status: "rejected" } },
      { type: "result", subtype: "error_during_execution", is_error: true, session_id: "s1" }
    ].map((r) => JSON.stringify(r)).join("\n") + "\n";
    expect(normalizeTurn("claude", s).explicitLimit).toBe(false);
  });

  it("(wave-6) misleading nested/model prose containing a rejected snapshot never sets a limit", () => {
    const s = claudeStream([
      INIT,
      { type: "user", message: { role: "user", content: [{ type: "tool_result", is_error: true, content: '{"rate_limit_info":{"status":"rejected"}}' }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}}' }] } },
      { type: "result", subtype: "error_during_execution", is_error: true }
    ]);
    // A rejected snapshot only counts when it is a real TOP-LEVEL record — prose/nested blocks never.
    expect(normalizeTurn("claude", s).explicitLimit).toBe(false);
  });

  it("(wave-6) success subtype without a schema-valid is_error:false is UNCERTAIN, not success", () => {
    for (const bad of [undefined, "false", null, 0, 1]) {
      const rec: Record<string, unknown> = { type: "result", subtype: "success", result: "ok" };
      if (bad !== undefined) rec.is_error = bad;
      const n = normalizeTurn("claude", claudeStream([INIT, rec]));
      expect(n.success).toBe(false);
      expect(n.hasTerminal).toBe(false);
    }
  });

  it("(wave-7) a PRESENT but non-object `usage` (primitive/null/array) makes the terminal UNCERTAIN while normalize stays TOTAL", () => {
    for (const badUsage of [5, "x", null, [], true] as unknown[]) {
      const rec = { type: "result", subtype: "success", is_error: false, result: "ok", usage: badUsage };
      // Claude, Codex, and custom all treat a malformed usage shape as UNCERTAIN (never success)…
      for (const provider of ["claude", "codex", "custom"] as const) {
        const stream = provider === "claude" ? claudeStream([INIT, rec]) : JSON.stringify(rec) + "\n";
        const n = normalizeTurn(provider, stream); // …and normalization never throws (stays total)
        expect(n.success).toBe(false);
      }
    }
    // A VALID (non-array object) usage still succeeds — this is not a blanket rejection.
    const okRec = { type: "result", subtype: "success", is_error: false, result: "ok", usage: { input_tokens: 3 } };
    expect(normalizeTurn("claude", claudeStream([INIT, okRec])).success).toBe(true);
    // An ABSENT usage is fine too.
    const noUsage = { type: "result", subtype: "success", is_error: false, result: "ok" };
    expect(normalizeTurn("claude", claudeStream([INIT, noUsage])).success).toBe(true);
  });

  it("(wave-5) a bare {type:result} is UNCERTAIN, never accepted success", () => {
    const n = normalizeTurn("claude", JSON.stringify({ type: "result" }));
    expect(n.success).toBe(false);
    expect(n.hasTerminal).toBe(false); // ambiguous terminal reads as UNCERTAIN / missing
    expect(n.explicitLimit).toBe(false);
  });

  it("(wave-5) a generic auth/policy error with error.status:'rejected' is NOT a usage limit", () => {
    const s = claudeStream([INIT, { type: "result", subtype: "error_auth", is_error: true, error: { status: "rejected" } }]);
    const n = normalizeTurn("claude", s);
    expect(n.success).toBe(false);
    expect(n.explicitLimit).toBe(false);
  });

  it("(wave-8) a malformed rate event after a valid rejection is protocol drift → UNCERTAIN (no fallback)", () => {
    // A typed `rate_limit_event` with a misspelled / non-string status is NOT a valid snapshot. The
    // old contract silently ignored the junk and kept the earlier `rejected` authoritative; the wave-8
    // contract treats it as protocol drift and REFUSES to authorize the fallback (fail closed) rather
    // than routing to GPT on a stream we no longer fully understand.
    const s = claudeStream([
      INIT,
      { type: "rate_limit_event", rate_limit_info: { status: "rejected" } },
      { type: "rate_limit_event", rate_limit_info: { status: "allowed_maybe" } },
      { type: "rate_limit_event", rate_limit_info: { status: 42 } },
      { type: "result", subtype: "error_during_execution", is_error: true }
    ]);
    expect(normalizeTurn("claude", s).explicitLimit).toBe(false);
  });

  it("(wave-5) negative / NaN / non-number terminal cost is rejected → UNCERTAIN, not success", () => {
    for (const bad of [-5, "0.10", null]) {
      const s = claudeStream([INIT, { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: bad }]);
      const n = normalizeTurn("claude", s);
      expect(n.success).toBe(false);
      expect(n.costReported).toBe(false);
      expect(n.usd).toBe(0);
    }
    // (wave-8b2) There is NO `usage.cost_usd` alias in the real 2.1.207 dialect. A terminal carrying
    // ONLY that nested field has UNKNOWN cost — it is neither read as cost nor validated as one, so it
    // never blocks an otherwise valid success and never reports a trusted amount.
    const s2 = claudeStream([INIT, { type: "result", subtype: "success", is_error: false, result: "ok", usage: { cost_usd: -1 } }]);
    const n2 = normalizeTurn("claude", s2);
    expect(n2.success).toBe(true);
    expect(n2.costReported).toBe(false); // nested alias is not authoritative cost
    expect(n2.usd).toBe(0);
    // A terminal whose ONLY cost is the nested alias, with a real top-level total_cost_usd absent, is
    // still UNKNOWN cost even when the alias looks well-formed.
    const s3 = claudeStream([INIT, { type: "result", subtype: "success", is_error: false, result: "ok", usage: { cost_usd: 0.5 } }]);
    expect(normalizeTurn("claude", s3).costReported).toBe(false);
  });

  it("auth/model/context/timeout/overload and allowed_warning are NEVER a limit", () => {
    for (const subtype of ["error_during_execution", "error_max_turns"]) {
      const s = claudeStream([INIT, { type: "result", subtype, is_error: true }]);
      const n = normalizeTurn("claude", s);
      expect(n.success).toBe(false);
      expect(n.explicitLimit).toBe(false);
    }
    // A 529 overload / allowed_warning telemetry must not fall back.
    const warned = claudeStream([
      INIT,
      { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning" } },
      { type: "result", subtype: "error_during_execution", is_error: true }
    ]);
    expect(normalizeTurn("claude", warned).explicitLimit).toBe(false);
  });

  it("a missing/torn terminal record is UNCERTAIN (no terminal, error, no fallback)", () => {
    const torn = claudeStream([INIT, { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } }]).replace(/\n$/, "") + '\n{"type":"resu';
    const n = normalizeTurn("claude", torn);
    expect(n.hasTerminal).toBe(false);
    expect(n.success).toBe(false);
    expect(n.explicitLimit).toBe(false);
  });

  it("(wave-8) a FOREIGN rejected event BEFORE init never authorizes fallback", () => {
    const s = [
      { type: "rate_limit_event", session_id: "other", rate_limit_info: { status: "rejected" } },
      { type: "system", subtype: "init", session_id: "s1", tools: [] },
      { type: "result", subtype: "error_during_execution", is_error: true, session_id: "s1" }
    ].map((r) => JSON.stringify(r)).join("\n") + "\n";
    expect(normalizeTurn("claude", s).explicitLimit).toBe(false);
  });

  it("(wave-8) a MISSING-session rejected event is never fallback authority", () => {
    const s = [
      { type: "system", subtype: "init", session_id: "s1", tools: [] },
      { type: "rate_limit_event", rate_limit_info: { status: "rejected" } }, // no session_id
      { type: "result", subtype: "error_during_execution", is_error: true, session_id: "s1" }
    ].map((r) => JSON.stringify(r)).join("\n") + "\n";
    expect(normalizeTurn("claude", s).explicitLimit).toBe(false);
  });

  it("(wave-8) a rejected event AFTER the terminal does not authorize fallback (post-terminal ignored)", () => {
    const s = [
      { type: "system", subtype: "init", session_id: "s1", tools: [] },
      { type: "result", subtype: "error_during_execution", is_error: true, session_id: "s1" },
      { type: "rate_limit_event", session_id: "s1", rate_limit_info: { status: "rejected" } }
    ].map((r) => JSON.stringify(r)).join("\n") + "\n";
    expect(normalizeTurn("claude", s).explicitLimit).toBe(false);
  });

  it("(wave-8) a FOREIGN-session terminal cannot complete the turn (UNCERTAIN)", () => {
    const s = [
      { type: "system", subtype: "init", session_id: "s1", tools: [] },
      { type: "rate_limit_event", session_id: "s1", rate_limit_info: { status: "rejected" } },
      { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s2" }
    ].map((r) => JSON.stringify(r)).join("\n") + "\n";
    const n = normalizeTurn("claude", s);
    expect(n.success).toBe(false);
    expect(n.hasTerminal).toBe(false);
    expect(n.explicitLimit).toBe(false);
  });

  it("(wave-8) TWO terminals make the turn UNCERTAIN — never last-wins", () => {
    const s = [
      { type: "system", subtype: "init", session_id: "s1", tools: [] },
      { type: "result", subtype: "error_during_execution", is_error: true, session_id: "s1" },
      { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s1" }
    ].map((r) => JSON.stringify(r)).join("\n") + "\n";
    const n = normalizeTurn("claude", s);
    expect(n.success).toBe(false);
    expect(n.hasTerminal).toBe(false);
  });

  it("(wave-8) an INVENTED failure subtype is UNCERTAIN, never a clean failure or a limit", () => {
    const s = claudeStream([
      INIT,
      { type: "rate_limit_event", rate_limit_info: { status: "rejected" } },
      { type: "result", subtype: "potato", is_error: true }
    ]);
    const n = normalizeTurn("claude", s);
    expect(n.success).toBe(false);
    expect(n.hasTerminal).toBe(false); // not a whitelisted failure → UNCERTAIN
    expect(n.explicitLimit).toBe(false); // an UNCERTAIN terminal can never authorize the fallback
  });

  it("(wave-8) CONTRADICTORY flags (failure subtype with is_error:false) are UNCERTAIN", () => {
    const s = claudeStream([INIT, { type: "result", subtype: "error_during_execution", is_error: false }]);
    const n = normalizeTurn("claude", s);
    expect(n.success).toBe(false);
    expect(n.hasTerminal).toBe(false);
  });

  it("(wave-8) negative / fractional / string / null token members are UNCERTAIN, never success", () => {
    for (const bad of [-1, 2.5, "10", null]) {
      const s = claudeStream([INIT, { type: "result", subtype: "success", is_error: false, result: "ok", usage: { input_tokens: bad, output_tokens: 3 } }]);
      const n = normalizeTurn("claude", s);
      expect(n.success).toBe(false);
      expect(n.hasTerminal).toBe(false);
      expect(n.inputTokens).toBeUndefined();
    }
    // A valid pair of nonnegative safe-integer token counts still succeeds.
    const ok = claudeStream([INIT, { type: "result", subtype: "success", is_error: false, result: "ok", usage: { input_tokens: 12, output_tokens: 3 } }]);
    expect(normalizeTurn("claude", ok).success).toBe(true);
  });

  it("cost comes ONLY from the terminal record, not model prose containing a cost field", () => {
    const stream = claudeStream([
      INIT,
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: '{"total_cost_usd": 999}' }] } },
      { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0.03 }
    ]);
    const n = normalizeTurn("claude", stream);
    expect(n.usd).toBeCloseTo(0.03);
  });
});

describe("normalizeTurn — Claude 2.1.207 exact stream state machine (wave-8b)", () => {
  const OK_RESULT = { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s1" };

  it("a CORRUPT / non-JSON line makes the turn UNCERTAIN even with an otherwise-valid terminal", () => {
    const stream = JSON.stringify(INIT) + "\n{ not json\n" + JSON.stringify(OK_RESULT) + "\n";
    const n = normalizeTurn("claude", stream);
    expect(n.success).toBe(false);
    expect(n.hasTerminal).toBe(false);
  });

  it("NO init → UNCERTAIN (there is no sessionless mode)", () => {
    const stream = JSON.stringify(OK_RESULT) + "\n";
    const n = normalizeTurn("claude", stream);
    expect(n.success).toBe(false);
    expect(n.hasTerminal).toBe(false);
    expect(n.explicitLimit).toBe(false);
  });

  it("a DUPLICATE init → UNCERTAIN", () => {
    const stream = [JSON.stringify(INIT), JSON.stringify({ ...INIT, session_id: "s1" }), JSON.stringify(OK_RESULT)].join("\n") + "\n";
    expect(normalizeTurn("claude", stream).success).toBe(false);
    // Even a second init with a DIFFERENT session id is a duplicate → UNCERTAIN.
    const stream2 = [JSON.stringify(INIT), JSON.stringify({ ...INIT, session_id: "s2" }), JSON.stringify(OK_RESULT)].join("\n") + "\n";
    expect(normalizeTurn("claude", stream2).success).toBe(false);
  });

  it("a MALFORMED init (missing / empty session id) → UNCERTAIN", () => {
    for (const sid of [undefined, "", 5, null]) {
      const init: Record<string, unknown> = { type: "system", subtype: "init", tools: [] };
      if (sid !== undefined) init.session_id = sid;
      const stream = [JSON.stringify(init), JSON.stringify(OK_RESULT)].join("\n") + "\n";
      expect(normalizeTurn("claude", stream).success).toBe(false);
    }
  });

  it("a FOREIGN-session assistant record is drift → UNCERTAIN (its text is never trusted)", () => {
    const stream =
      [
        JSON.stringify(INIT),
        JSON.stringify({ type: "assistant", session_id: "someone-else", message: { role: "assistant", content: [{ type: "text", text: "foreign" }] } }),
        JSON.stringify(OK_RESULT)
      ].join("\n") + "\n";
    const n = normalizeTurn("claude", stream);
    expect(n.success).toBe(false);
    expect(n.hasTerminal).toBe(false);
    expect(n.finalText).not.toContain("foreign");
  });

  it("a POST-TERMINAL assistant record is drift → UNCERTAIN", () => {
    const stream =
      [
        JSON.stringify(INIT),
        JSON.stringify(OK_RESULT),
        JSON.stringify({ type: "assistant", session_id: "s1", message: { role: "assistant", content: [{ type: "text", text: "after" }] } })
      ].join("\n") + "\n";
    const n = normalizeTurn("claude", stream);
    expect(n.success).toBe(false);
    expect(n.hasTerminal).toBe(false);
  });

  it("(wave-8b2) a rejected snapshot with a MALFORMED camelCase member is drift → no fallback", () => {
    // Real Claude 2.1.207 `rate_limit_info` is camelCase. Mutating ANY pinned member to an invalid
    // type/enum — or adding an UNKNOWN member — is protocol drift for this pinned CLI and can never be
    // a rejection authority. (The old snake_case fields `retry_after`/`resets_at`/`unified_*` were
    // INVENTED and are now themselves unknown members → drift.)
    for (const info of [
      { status: "rejected", resetsAt: "soon" }, // timestamp not a number
      { status: "rejected", resetsAt: -5 }, // negative timestamp
      { status: "rejected", resetsAt: 1.5 }, // non-integer epoch seconds
      { status: "rejected", isUsingOverage: "yes" }, // bad boolean
      { status: "rejected", rateLimitType: "weekly" }, // bad enum
      { status: "rejected", overageStatus: "maybe" }, // bad overage enum
      { status: "rejected", utilization: -0.1 }, // negative utilization
      { status: "rejected", overagePeriodMonthly: { utilization: "high" } }, // bad wrapper shape
      { status: "rejected", errorCode: "unknown_code" }, // bad errorCode enum
      { status: "rejected", retry_after: 30 }, // INVENTED snake_case member → unknown → drift
      { status: "rejected", surprise: 1 } // unknown member → drift
    ]) {
      const s = claudeStream([INIT, { type: "rate_limit_event", rate_limit_info: info }, { type: "result", subtype: "error_during_execution", is_error: true }]);
      expect(normalizeTurn("claude", s).explicitLimit).toBe(false);
    }
    // A rejected snapshot with WELL-FORMED optional camelCase members still authorizes fallback.
    const good = claudeStream([
      INIT,
      { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1783846800, rateLimitType: "seven_day", utilization: 0.9, surpassedThreshold: 0.75, isUsingOverage: false, overagePeriodMonthly: { utilization: 0.4 } } },
      { type: "result", subtype: "error_during_execution", is_error: true }
    ]);
    expect(normalizeTurn("claude", good).explicitLimit).toBe(true);
  });

  it("(wave-8b2) a `rejected` base with an ALLOWED overage-in-use is ambiguous → no fallback", () => {
    // Per the contract, `status:"rejected"` while `isUsingOverage:true` and the overage status is
    // allowed/allowed_warning is NOT an unambiguous effective rejection — it must not authorize GPT.
    for (const os of ["allowed", "allowed_warning"]) {
      const s = claudeStream([
        INIT,
        { type: "rate_limit_event", rate_limit_info: { status: "rejected", isUsingOverage: true, overageStatus: os } },
        { type: "result", subtype: "error_during_execution", is_error: true }
      ]);
      expect(normalizeTurn("claude", s).explicitLimit).toBe(false);
    }
    // But a `rejected` base with the overage itself rejected IS a genuine rejection → fallback.
    const hard = claudeStream([
      INIT,
      { type: "rate_limit_event", rate_limit_info: { status: "rejected", isUsingOverage: true, overageStatus: "rejected" } },
      { type: "result", subtype: "error_during_execution", is_error: true }
    ]);
    expect(normalizeTurn("claude", hard).explicitLimit).toBe(true);
  });
});

describe("normalizeTurn — Claude 2.1.207 PINNED real fixture + rate mutation table (wave-8b2)", () => {
  // Provenance: sanitized capture from `claude --version` => "2.1.207 (Claude Code)", model
  // "claude-opus-4-8", `-p --output-format stream-json`. The `rate_limit_info` object is transcribed
  // from the installed binary's Zod serializer (camelCase), including the exact allowed-warning event
  // the CLI emitted: {"status":"allowed_warning","resetsAt":1783846800,"rateLimitType":"seven_day",
  // "utilization":0.82,"isUsingOverage":false,"surpassedThreshold":0.75}.
  const REAL_INIT = { type: "system", subtype: "init", session_id: "sess_2_1_207", model: "claude-opus-4-8", tools: ["Task", "Bash", "Edit"], cwd: "/repo" };
  const REAL_RATE_INFO = {
    status: "allowed_warning",
    resetsAt: 1783846800,
    rateLimitType: "seven_day",
    utilization: 0.82,
    isUsingOverage: false,
    surpassedThreshold: 0.75
  };
  const REAL_RATE_EVENT = { type: "rate_limit_event", session_id: "sess_2_1_207", rate_limit_info: REAL_RATE_INFO };
  const REAL_RESULT = { type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0.0342, session_id: "sess_2_1_207", usage: { input_tokens: 1200, output_tokens: 340 } };
  const realStream = (rateInfo: Record<string, unknown> = REAL_RATE_INFO): string =>
    [REAL_INIT, { ...REAL_RATE_EVENT, rate_limit_info: rateInfo }, REAL_RESULT].map((r) => JSON.stringify(r)).join("\n") + "\n";

  it("accepts the pinned success + allowed_warning stream (no fallback, cost from total_cost_usd only)", () => {
    const n = normalizeTurn("claude", realStream());
    expect(n.success).toBe(true);
    expect(n.hasTerminal).toBe(true);
    expect(n.explicitLimit).toBe(false); // allowed_warning is telemetry, never a rejection
    expect(n.finalText).toBe("done");
    expect(n.usd).toBeCloseTo(0.0342);
    expect(n.costReported).toBe(true);
    expect(n.inputTokens).toBe(1200);
    expect(n.outputTokens).toBe(340);
  });

  it("MUTATION TABLE: every pinned rate member mutated to an invalid type is drift → explicitLimit:false", () => {
    // Each mutation is applied to an OTHERWISE-VALID rejected snapshot; the terminal is a clean failure.
    // If the pinned member were not validated, a bad value could still authorize GPT. It must not.
    const base = { status: "rejected" as const };
    const mutations: Array<Record<string, unknown>> = [
      { ...base, status: "denied" }, // invalid status enum
      { ...base, status: 1 }, // non-string status
      { ...base, resetsAt: "soon" }, // non-number timestamp
      { ...base, resetsAt: -1 }, // negative timestamp
      { ...base, resetsAt: 3.14 }, // non-integer timestamp
      { ...base, rateLimitType: "monthly" }, // invalid enum
      { ...base, rateLimitType: 7 }, // non-string enum
      { ...base, utilization: "high" }, // non-number
      { ...base, utilization: -0.01 }, // negative
      { ...base, overageStatus: "unsure" }, // invalid enum
      { ...base, overageResetsAt: "later" }, // non-number timestamp
      { ...base, overageDisabledReason: "made_up" }, // invalid enum
      { ...base, isUsingOverage: "true" }, // non-boolean
      { ...base, overageInUse: 1 }, // non-boolean
      { ...base, surpassedThreshold: null }, // non-number
      { ...base, overagePeriodMonthly: 0.4 }, // wrapper must be an object
      { ...base, overagePeriodMonthly: { utilization: "x" } }, // wrapper.utilization non-number
      { ...base, overagePeriodChannel: {} }, // wrapper missing utilization
      { ...base, errorCode: "nope" }, // invalid enum
      { ...base, canUserPurchaseCredits: "yes" }, // non-boolean
      { ...base, hasChargeableSavedPaymentMethod: 0 }, // non-boolean
      { ...base, unknownField: true } // unknown member for this pinned CLI
    ];
    for (const info of mutations) {
      const s = [REAL_INIT, { type: "rate_limit_event", session_id: "sess_2_1_207", rate_limit_info: info }, { type: "result", subtype: "error_during_execution", is_error: true, session_id: "sess_2_1_207" }]
        .map((r) => JSON.stringify(r)).join("\n") + "\n";
      const n = normalizeTurn("claude", s);
      expect(n.explicitLimit, `mutation ${JSON.stringify(info)} must not authorize GPT`).toBe(false);
    }
  });

  it("DIRECT: malformed isUsingOverage / overageStatus / resetsAt cannot authorize GPT", () => {
    for (const info of [
      { status: "rejected", isUsingOverage: "maybe" },
      { status: "rejected", overageStatus: 3 },
      { status: "rejected", resetsAt: Number.NaN },
      { status: "rejected", resetsAt: Number.POSITIVE_INFINITY }
    ]) {
      const s = [REAL_INIT, { type: "rate_limit_event", session_id: "sess_2_1_207", rate_limit_info: info }, { type: "result", subtype: "error_during_execution", is_error: true, session_id: "sess_2_1_207" }]
        .map((r) => JSON.stringify(r)).join("\n") + "\n";
      expect(normalizeTurn("claude", s).explicitLimit).toBe(false);
    }
  });

  it("MISSING-SUCCESS-RESULT regressions: missing/null/object/array result is UNCERTAIN, never success", () => {
    for (const badResult of [undefined, null, { text: "x" }, ["a"], 42, true] as const) {
      const rec: Record<string, unknown> = { type: "result", subtype: "success", is_error: false, session_id: "sess_2_1_207", total_cost_usd: 0.01 };
      if (badResult !== undefined) rec.result = badResult;
      const s = [REAL_INIT, rec].map((r) => JSON.stringify(r)).join("\n") + "\n";
      const n = normalizeTurn("claude", s);
      expect(n.success, `result=${JSON.stringify(badResult)}`).toBe(false);
      expect(n.hasTerminal).toBe(false);
    }
  });

  it("ASSISTANT-FALLBACK regression: assistant text is observational and NEVER repairs a bad success", () => {
    // An assistant record exists, but the terminal success has no `result` string. finalText may
    // surface the observational assistant text, but the turn is UNCERTAIN — success must stay false.
    const s = [
      REAL_INIT,
      { type: "assistant", session_id: "sess_2_1_207", message: { role: "assistant", content: [{ type: "text", text: "observational answer" }] } },
      { type: "result", subtype: "success", is_error: false, session_id: "sess_2_1_207", total_cost_usd: 0.01 }
    ].map((r) => JSON.stringify(r)).join("\n") + "\n";
    const n = normalizeTurn("claude", s);
    expect(n.success).toBe(false);
    expect(n.hasTerminal).toBe(false);
    expect(n.finalText).toBe("observational answer"); // observational only, did not repair success
  });
});

describe("normalizeTurn — Codex --json", () => {
  // The pinned 0.144.0 usage shape carries all four installed counters.
  const USAGE = { input_tokens: 20, cached_input_tokens: 4, output_tokens: 8, reasoning_output_tokens: 2 };
  const AGENT = { id: "item-7", type: "agent_message", text: "codex final answer" };
  const CLEAN = [
    { type: "thread.started", thread_id: "t1" },
    { type: "turn.started" },
    { type: "item.completed", item: AGENT },
    { type: "turn.completed", usage: USAGE }
  ];
  const asStream = (recs) => recs.map((r) => JSON.stringify(r)).join("\n");

  it("(wave-8b) the PINNED 0.144.0 lifecycle: thread.started → turn.started → item.completed → turn.completed", () => {
    const n = normalizeTurn("codex", asStream(CLEAN));
    expect(n.finalText).toBe("codex final answer");
    expect(n.success).toBe(true);
    expect(n.hasTerminal).toBe(true);
    expect(n.explicitLimit).toBe(false); // Codex is the FALLBACK — never triggers a fallback
    expect(n.inputTokens).toBe(20);
    expect(n.outputTokens).toBe(8);
    expect(n.costReported).toBe(false); // Codex emits NO authoritative USD
    expect(n.usd).toBe(0);
  });

  it("(wave-8b) a turn.failed terminal is a failed terminal", () => {
    const stream = asStream([
      { type: "thread.started", thread_id: "t1" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "i1", type: "agent_message", text: "partial" } },
      { type: "turn.failed", error: { message: "boom" } }
    ]);
    expect(normalizeTurn("codex", stream).success).toBe(false);
  });

  it("(wave-8b) an out-of-order / incomplete lifecycle is UNCERTAIN, never a clean success", () => {
    const itemsBeforeTurn = asStream([{ type: "item.completed", item: AGENT }, { type: "turn.completed", usage: USAGE }]);
    expect(normalizeTurn("codex", itemsBeforeTurn).success).toBe(false);

    const noTerminal = asStream([{ type: "thread.started", thread_id: "t1" }, { type: "turn.started" }, { type: "item.completed", item: AGENT }]);
    expect(normalizeTurn("codex", noTerminal).hasTerminal).toBe(false);

    const twoTerminals = asStream([...CLEAN, { type: "turn.completed", usage: USAGE }]);
    expect(normalizeTurn("codex", twoTerminals).success).toBe(false);
  });

  it("(wave-8b) UNKNOWN / synthetic-alias record types are REJECTED (session.created, msg, assistant_message)", () => {
    // Each of these was accepted by the old permissive parser; the pinned allowlist rejects them.
    const prelude = asStream([{ type: "session.created", session_id: "c1" }, ...CLEAN]);
    expect(normalizeTurn("codex", prelude).success).toBe(false); // session.created is not in the allowlist
    const aliasMsg = asStream([
      { type: "thread.started", thread_id: "t1" },
      { type: "turn.started" },
      { type: "msg", kind: "assistant_message", text: "aliased" },
      { type: "turn.completed", usage: USAGE }
    ]);
    const nMsg = normalizeTurn("codex", aliasMsg);
    expect(nMsg.success).toBe(false);
    expect(nMsg.finalText).toBe(""); // the aliased text is NOT harvested
  });

  it("(wave-8b2) the pinned `error` event is a TERMINAL stream error (not an alias) and never succeeds", () => {
    // `error` IS one of the eight pinned ThreadEvent variants: an unrecoverable stream error that can
    // never coexist with an accepted success. Its `message` must be a string.
    const errAfterTurn = asStream([{ type: "thread.started", thread_id: "t1" }, { type: "turn.started" }, { type: "error", message: "boom" }]);
    const nErr = normalizeTurn("codex", errAfterTurn);
    expect(nErr.success).toBe(false);
    expect(nErr.hasTerminal).toBe(true); // it IS a recognized terminal (exactly one)
    // An `error` cannot coexist with a success terminal — the trailing turn.completed is drift.
    const errThenComplete = asStream([{ type: "thread.started", thread_id: "t1" }, { type: "turn.started" }, { type: "error", message: "boom" }, { type: "turn.completed", usage: USAGE }]);
    expect(normalizeTurn("codex", errThenComplete).success).toBe(false);
    // A malformed error (non-string message) is drift.
    const badErr = asStream([{ type: "thread.started", thread_id: "t1" }, { type: "error", message: 42 }]);
    expect(normalizeTurn("codex", badErr).success).toBe(false);
    // An `error` before any turn is still a valid terminal stream error (unrecoverable).
    const earlyErr = asStream([{ type: "thread.started", thread_id: "t1" }, { type: "error", message: "auth failed" }]);
    expect(normalizeTurn("codex", earlyErr).hasTerminal).toBe(true);
    expect(normalizeTurn("codex", earlyErr).success).toBe(false);
  });

  it("(wave-8b2) malformed turn.failed (missing/non-string error.message) is drift; a well-formed one is a clean failed terminal", () => {
    const good = asStream([{ type: "thread.started", thread_id: "t1" }, { type: "turn.started" }, { type: "item.completed", item: AGENT }, { type: "turn.failed", error: { message: "model overloaded" } }]);
    const nGood = normalizeTurn("codex", good);
    expect(nGood.success).toBe(false);
    expect(nGood.hasTerminal).toBe(true); // a well-formed turn.failed IS a clean terminal
    expect(nGood.explicitLimit).toBe(false); // Codex never authorizes a further fallback
    for (const bad of [{ error: {} }, { error: { message: 7 } }, { error: null }, {}]) {
      const s = asStream([{ type: "thread.started", thread_id: "t1" }, { type: "turn.started" }, { type: "turn.failed", ...bad }]);
      const n = normalizeTurn("codex", s);
      expect(n.success).toBe(false);
      expect(n.hasTerminal).toBe(false); // malformed terminal → UNCERTAIN
    }
  });

  it("(wave-8b2) one malformed case per non-agent item family rides no valid success", () => {
    // A valid final agent_message is present, but a malformed sibling item of each family is drift.
    const withBadItem = (bad: Record<string, unknown>) =>
      asStream([
        { type: "thread.started", thread_id: "t1" },
        { type: "turn.started" },
        { type: "item.completed", item: bad },
        { type: "item.completed", item: AGENT },
        { type: "turn.completed", usage: USAGE }
      ]);
    const badItems: Array<Record<string, unknown>> = [
      { id: "", type: "agent_message", text: "x" }, // empty id
      { id: "i", type: "reasoning" }, // reasoning missing text
      { id: "i", type: "command_execution", command: "ls", aggregated_output: "", status: "sprinting" }, // bad status enum
      { id: "i", type: "command_execution", command: 1, aggregated_output: "", status: "completed" }, // non-string command
      { id: "i", type: "file_change", changes: [{ path: "a", kind: "rename" }], status: "completed" }, // bad kind enum
      { id: "i", type: "file_change", changes: "nope", status: "completed" }, // changes not an array
      { id: "i", type: "mcp_tool_call", server: "s", tool: "t", status: "pending" }, // bad status enum
      { id: "i", type: "collab_tool_call", tool: "teleport", sender_thread_id: "a", receiver_thread_ids: [], status: "completed" }, // bad tool enum
      { id: "i", type: "collab_tool_call", tool: "wait", sender_thread_id: "a", receiver_thread_ids: [3], status: "completed" }, // non-string receiver
      { id: "i", type: "web_search", query: 5, action: {} }, // non-string query
      { id: "i", type: "web_search", query: "q" }, // missing action
      { id: "i", type: "todo_list", items: [{ text: "t", completed: "yes" }] }, // non-boolean completed
      { id: "i", type: "todo_list", items: [{ text: 1, completed: true }] }, // non-string text
      { id: "i", type: "error" }, // error item missing message
      { id: "i", type: "made_up_family", foo: 1 } // unknown item detail type
    ];
    for (const bad of badItems) {
      const n = normalizeTurn("codex", withBadItem(bad));
      expect(n.success, `malformed item ${JSON.stringify(bad)} must not succeed`).toBe(false);
    }
    // Positive control: a WELL-FORMED non-agent item alongside the agent_message still succeeds.
    const okSibling = asStream([
      { type: "thread.started", thread_id: "t1" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "c1", type: "command_execution", command: "ls -la", aggregated_output: "out", exit_code: 0, status: "completed" } },
      { type: "item.completed", item: { id: "f1", type: "file_change", changes: [{ path: "src/x.ts", kind: "update" }], status: "completed" } },
      { type: "item.completed", item: AGENT },
      { type: "turn.completed", usage: USAGE }
    ]);
    expect(normalizeTurn("codex", okSibling).success).toBe(true);
  });

  it("(wave-8b) a corrupt / non-JSON line and a TRAILING record after the terminal are UNCERTAIN", () => {
    const corrupt = [...asStream(CLEAN.slice(0, 3)), "{not json", JSON.stringify({ type: "turn.completed", usage: USAGE })].join("\n");
    expect(normalizeTurn("codex", corrupt).success).toBe(false);
    const trailing = asStream([...CLEAN, { type: "item.completed", item: AGENT }]);
    expect(normalizeTurn("codex", trailing).success).toBe(false); // no record may follow the terminal
  });

  it("(wave-8b) a missing thread_id, a missing item id, or a non-agent_message text-supplier is UNCERTAIN / unharvested", () => {
    const noThreadId = asStream([{ type: "thread.started" }, { type: "turn.started" }, { type: "item.completed", item: AGENT }, { type: "turn.completed", usage: USAGE }]);
    expect(normalizeTurn("codex", noThreadId).success).toBe(false);
    const noItemId = asStream([
      { type: "thread.started", thread_id: "t1" },
      { type: "turn.started" },
      { type: "item.completed", item: { type: "agent_message", text: "no id" } },
      { type: "turn.completed", usage: USAGE }
    ]);
    expect(normalizeTurn("codex", noItemId).success).toBe(false); // malformed agent_message item is drift
  });

  it("(wave-8b) turn.completed REQUIRES all four usage counters; missing / fractional / negative is UNCERTAIN", () => {
    const missingCounter = asStream([
      { type: "thread.started", thread_id: "t1" },
      { type: "turn.started" },
      { type: "item.completed", item: AGENT },
      { type: "turn.completed", usage: { input_tokens: 20, output_tokens: 8 } } // missing cached/reasoning
    ]);
    expect(normalizeTurn("codex", missingCounter).success).toBe(false);
    for (const bad of [1.5, -3, "20", null]) {
      const stream = asStream([
        { type: "thread.started", thread_id: "t1" },
        { type: "turn.started" },
        { type: "item.completed", item: AGENT },
        { type: "turn.completed", usage: { ...USAGE, input_tokens: bad } }
      ]);
      expect(normalizeTurn("codex", stream).success).toBe(false);
    }
  });

  it("(wave-8b) a FAKE USD cost on turn.completed is never trusted — cost stays UNKNOWN", () => {
    const withFakeUsd = asStream([
      { type: "thread.started", thread_id: "t1" },
      { type: "turn.started" },
      { type: "item.completed", item: AGENT },
      { type: "turn.completed", usage: USAGE, total_cost_usd: 0.01, cost_usd: 0.01 }
    ]);
    const n = normalizeTurn("codex", withFakeUsd);
    expect(n.success).toBe(true); // a well-formed turn still succeeds…
    expect(n.costReported).toBe(false); // …but the fabricated USD is IGNORED (Codex reports no USD)
    expect(n.usd).toBe(0);
  });
});

describe("streaming whole-stream lifecycle authority under bounded memory (wave-8b2)", () => {
  const w = (o: Record<string, unknown>) => JSON.stringify(o);

  it("an early init + MANY valid intervening records + a valid terminal SUCCEEDS (init never lost)", () => {
    // Volume far exceeds any recent-line tail; a lossy-tail reparse would evict the init and report a
    // FALSE uncertainty. The streaming normalizer validated every record once and keeps the verdict.
    const n = createStreamingNormalizer("claude");
    n.pushLine(w({ type: "system", subtype: "init", session_id: "s", tools: [] }));
    for (let i = 0; i < 120_000; i++) n.pushLine(w({ type: "user", session_id: "s", message: { role: "user", content: [] } }));
    n.pushLine(w({ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0.01, session_id: "s" }));
    const v = n.finish();
    expect(v.success).toBe(true);
    expect(v.finalText).toBe("ok");
    expect(v.costReported).toBe(true);
  });

  it("an early DUPLICATE init before a flood can never be evicted into success (stays UNCERTAIN)", () => {
    const n = createStreamingNormalizer("claude");
    n.pushLine(w({ type: "system", subtype: "init", session_id: "s", tools: [] }));
    n.pushLine(w({ type: "system", subtype: "init", session_id: "s2", tools: [] })); // early drift
    for (let i = 0; i < 120_000; i++) n.pushLine(w({ type: "user", session_id: "s", message: { role: "user", content: [] } }));
    n.pushLine(w({ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0.01, session_id: "s" }));
    const v = n.finish();
    expect(v.success).toBe(false);
    expect(v.hasTerminal).toBe(false);
  });

  it("an early CORRUPT line before a flood stays UNCERTAIN (drift never evicted into success)", () => {
    const n = createStreamingNormalizer("claude");
    n.pushLine(w({ type: "system", subtype: "init", session_id: "s", tools: [] }));
    n.pushLine("{ not valid json"); // early corrupt line
    for (let i = 0; i < 120_000; i++) n.pushLine(w({ type: "user", session_id: "s", message: { role: "user", content: [] } }));
    n.pushLine(w({ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0.01, session_id: "s" }));
    expect(n.finish().success).toBe(false);
  });

  it("an early FOREIGN-session authoritative record before a flood stays UNCERTAIN", () => {
    const n = createStreamingNormalizer("claude");
    n.pushLine(w({ type: "system", subtype: "init", session_id: "s", tools: [] }));
    n.pushLine(w({ type: "assistant", session_id: "foreign", message: { role: "assistant", content: [{ type: "text", text: "x" }] } }));
    for (let i = 0; i < 120_000; i++) n.pushLine(w({ type: "user", session_id: "s", message: { role: "user", content: [] } }));
    n.pushLine(w({ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0.01, session_id: "s" }));
    expect(n.finish().success).toBe(false);
  });

  it("a NEWLINE FLOOD (millions of blank/tiny lines) stays bounded and preserves protocol state", () => {
    const n = createStreamingNormalizer("claude");
    n.pushLine(w({ type: "system", subtype: "init", session_id: "s", tools: [] }));
    for (let i = 0; i < 2_000_000; i++) n.pushLine(""); // blank lines are ignored, memory stays O(1)
    n.pushLine(w({ type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0.01, session_id: "s" }));
    const v = n.finish();
    expect(v.success).toBe(true); // protocol state (init + terminal) preserved through the flood
    expect(v.finalText).toBe("done");
  });

  it("a Codex flood of valid items preserves the terminal verdict (streaming, bounded)", () => {
    const n = createStreamingNormalizer("codex");
    n.pushLine(w({ type: "thread.started", thread_id: "t1" }));
    n.pushLine(w({ type: "turn.started" }));
    for (let i = 0; i < 120_000; i++) n.pushLine(w({ type: "item.completed", item: { id: `r${i}`, type: "reasoning", text: "thinking" } }));
    n.pushLine(w({ type: "item.completed", item: { id: "a1", type: "agent_message", text: "codex answer" } }));
    n.pushLine(w({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 1 } }));
    const v = n.finish();
    expect(v.success).toBe(true);
    expect(v.finalText).toBe("codex answer");
  });
});

describe("normalizeTurn — total & non-throwing (wave-6 P0)", () => {
  const providers = ["claude", "codex", "gemini", "custom"] as const;

  it("primitive / array / null usage never throws and never mis-reads tokens for any provider", () => {
    for (const provider of providers) {
      for (const badUsage of [1, "x", true, null, [1, 2], [], { input_tokens: "nope" }]) {
        const terminalType = provider === "codex" ? "turn.completed" : "result";
        const rec: Record<string, unknown> = { type: terminalType, subtype: "success", is_error: false, result: "ok", usage: badUsage };
        const stdout = provider === "claude"
          ? [JSON.stringify({ type: "system", subtype: "init", session_id: "s" }), JSON.stringify(rec)].join("\n") + "\n"
          : JSON.stringify(rec);
        expect(() => normalizeTurn(provider, stdout)).not.toThrow();
        const n = normalizeTurn(provider, stdout);
        expect(n.inputTokens).toBeUndefined(); // a non-object / string-typed usage yields NO tokens
      }
    }
  });

  it("primitive error / message / rate_limit_info fields never throw", () => {
    for (const provider of providers) {
      for (const rec of [
        { type: "result", subtype: "error", is_error: true, error: "boom" },
        { type: "result", subtype: "error", is_error: true, error: [1, 2] },
        { type: "result", subtype: "error", is_error: true, rate_limit_info: 5 },
        { type: "assistant", message: "not-an-object" },
        { type: "assistant", message: [1, 2, 3] }
      ]) {
        const stdout = [JSON.stringify({ type: "system", subtype: "init", session_id: "s" }), JSON.stringify(rec)].join("\n") + "\n";
        expect(() => normalizeTurn(provider, stdout)).not.toThrow();
      }
    }
  });

  it("non-string stdout (undefined / number / object) never throws", () => {
    for (const provider of providers) {
      for (const bad of [undefined, null, 123, {}, []]) {
        expect(() => normalizeTurn(provider, bad as unknown as string)).not.toThrow();
      }
    }
  });
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildProviderChain,
  chooseActiveProvider,
  classifyOutcome,
  inCooldown,
  loadHealth,
  markCooldown,
  parseClaudeStream,
  saveHealth
} from "../src/routing.js";
import type { ProjectConfig, ProviderConfig } from "../src/config/schema.js";

function p(type: ProviderConfig["type"], extra: Partial<ProviderConfig> = {}): ProviderConfig {
  return { type, args: [], dangerouslySkipPermissions: false, yolo: false, cooldownSeconds: 900, promptMode: "interactive", env: {}, auth: { mode: "auto", configured: false }, ...extra } as ProviderConfig;
}

function project(providers: Record<string, ProviderConfig>): ProjectConfig {
  return { name: "demo", brief: "b", workingDir: ".", intelligence: "i", safetyMode: "workspace-write", providers, repositories: [], roles: [], loops: [] } as ProjectConfig;
}

// Helpers that build well-formed top-level Claude stream-JSON lines. Every AUTHORITATIVE record
// (rate_limit_event, result) carries the SAME session_id "s" that the init binds — the wave-8
// contract only trusts session-correlated authority.
const sysInit = '{"type":"system","subtype":"init","session_id":"s"}';
const assistant = (text: string) => JSON.stringify({ type: "assistant", session_id: "s", message: { content: [{ type: "text", text }] } });
const resultOk = '{"type":"result","subtype":"success","is_error":false,"result":"done","total_cost_usd":0.01,"session_id":"s"}';
const resultErr = (subtype = "error_during_execution") => JSON.stringify({ type: "result", subtype, is_error: true, result: "boom", session_id: "s" });
const rejectEvent = '{"type":"rate_limit_event","session_id":"s","rate_limit_info":{"status":"rejected"}}';
const allowedEvent = '{"type":"rate_limit_event","session_id":"s","rate_limit_info":{"status":"allowed"}}';
const allowedWarnEvent = '{"type":"rate_limit_event","session_id":"s","rate_limit_info":{"status":"allowed_warning"}}';
const cls = (stdout: string, stderr = "") => classifyOutcome({ ok: false, code: 1, stdout, stderr });

describe("Claude stream-JSON classification (top-level records only)", () => {
  it("a terminal SUCCESS result is ok and NEVER a limit", () => {
    expect(cls([sysInit, assistant("working"), resultOk].join("\n"))).toBe("ok");
  });

  it("(wave-6) CANONICAL: a rejected rate_limit_event + failed result is a limit", () => {
    // The real 2.1.207 dialect: a usage rejection is a top-level rate_limit_event, followed by a
    // generic failed result. THIS is the case that authorizes the Codex/GPT fallback.
    expect(cls([sysInit, rejectEvent, resultErr()].join("\n"))).toBe("limit");
    expect(cls([sysInit, rejectEvent, resultErr("error_max_turns")].join("\n"))).toBe("limit");
  });

  it("(wave-8) a result carrying only its OWN rejected rate_limit_info is NOT a limit (terminal-owned dialect unproven)", () => {
    // Absent a pinned real-CLI fixture proving Claude emits an authoritative rejection ON the result,
    // a self-carried rate_limit_info must not authorize the fallback — only a preceding matching
    // top-level rate_limit_event does.
    expect(cls([sysInit, JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "s", rate_limit_info: { status: "rejected" } })].join("\n"))).toBe("error");
  });

  it("(wave-6) impossible terminal shapes without a rejected snapshot are NOT limits", () => {
    // `error_usage_limit` and a rate-typed error object are not real dialect; alone they never fall back.
    expect(cls([sysInit, resultErr("error_usage_limit")].join("\n"))).toBe("error");
    expect(cls([sysInit, JSON.stringify({ type: "result", subtype: "error", is_error: true, error: { type: "rate_limit_error" } })].join("\n"))).toBe("error");
  });

  it("(wave-6) rejected → allowed_warning → failure clears the rejection (no fallback)", () => {
    expect(cls([sysInit, rejectEvent, allowedWarnEvent, resultErr()].join("\n"))).toBe("error");
    expect(cls([sysInit, rejectEvent, allowedEvent, resultErr()].join("\n"))).toBe("error");
  });

  it("(wave-5) a bare {type:result} is UNCERTAIN → generic error, never accepted", () => {
    expect(cls('{"type":"result"}')).toBe("error");
  });

  it("does NOT treat allowed / allowed_warning telemetry as a limit", () => {
    expect(cls([sysInit, allowedEvent, resultOk].join("\n"))).toBe("ok");
    expect(cls([sysInit, allowedWarnEvent, resultErr()].join("\n"))).toBe("error");
    expect(parseClaudeStream([allowedEvent, allowedWarnEvent].join("\n")).explicitLimit).toBe(false);
  });

  it("earlier reject then a FINAL success => ok (the final terminal result wins, never falls back)", () => {
    expect(cls([sysInit, rejectEvent, resultOk].join("\n"))).toBe("ok");
  });

  it("a nested/fake rate_limit_error inside model prose does NOT trigger a limit", () => {
    const proseFake = assistant('here is some text mentioning {"type":"rate_limit_error"} and rate_limit_event: rejected');
    expect(cls([sysInit, proseFake, resultErr()].join("\n"))).toBe("error");
    // A fake record embedded as a STRING is not a top-level record.
    expect(parseClaudeStream(assistant("rate_limit_error rejected 429")).explicitLimit).toBe(false);
  });

  it("model prose about approaching a limit is not a limit", () => {
    expect(cls([sysInit, assistant("you are approaching your usage limit"), resultOk].join("\n"))).toBe("ok");
  });

  it("stderr 429 prose and 529 overload never fall back", () => {
    expect(cls([sysInit, resultErr()].join("\n"), "HTTP 429 Too Many Requests")).toBe("error");
    expect(cls([sysInit, resultErr("error_overloaded")].join("\n"), "Error 529 overloaded")).toBe("error");
  });

  it("auth / model / context / timeout terminal errors never fall back", () => {
    for (const sub of ["error_auth", "error_model_not_found", "error_context_length", "error_timeout"]) {
      expect(cls([sysInit, resultErr(sub)].join("\n"))).toBe("error");
    }
  });

  it("a missing/torn terminal record (crash / UNCERTAIN) is a generic error, never a limit", () => {
    expect(cls([sysInit, assistant("partial output then killed")].join("\n"))).toBe("error");
    expect(cls("not json at all\n{tornline")).toBe("error");
    // Even a rejected event with NO terminal result does not fall back (needs a failed terminal).
    expect(cls([sysInit, rejectEvent].join("\n"))).toBe("error");
  });
});

describe("provider chain + fallback selection", () => {
  it("adds a codex fallback when the primary is claude", () => {
    const proj = project({ opus: p("claude"), gpt: p("codex") });
    expect(buildProviderChain(proj, "opus")).toEqual({ primary: "opus", fallback: "gpt" });
  });

  it("honors an explicit fallbackFor declaration", () => {
    const proj = project({ opus: p("claude"), backup: p("codex", { fallbackFor: "opus" }) });
    expect(buildProviderChain(proj, "opus").fallback).toBe("backup");
  });

  it("remains primary-only when just one CLI is configured", () => {
    const proj = project({ opus: p("claude") });
    expect(buildProviderChain(proj, "opus")).toEqual({ primary: "opus" });
  });

  it("NEVER infers a Gemini (or custom) fallback — only Codex", () => {
    const proj = project({ opus: p("claude"), g: p("gemini"), c: p("custom") });
    expect(buildProviderChain(proj, "opus")).toEqual({ primary: "opus" });
  });

  it("a non-Claude primary has no fallback (only Claude reports the usage-limit signal)", () => {
    const proj = project({ gpt: p("codex"), other: p("codex") });
    expect(buildProviderChain(proj, "gpt")).toEqual({ primary: "gpt" });
  });

  it("ignores a fallbackFor declared by a non-Codex provider", () => {
    const proj = project({ opus: p("claude"), g: p("gemini", { fallbackFor: "opus" }) });
    expect(buildProviderChain(proj, "opus")).toEqual({ primary: "opus" });
  });
});

describe("cooldown state machine: limit → fallback → cooldown expiry → Opus recovery", () => {
  it("routes Opus → GPT on limit, then back to Opus after cooldown", () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-health-"));
    const chain = { primary: "opus", fallback: "gpt" };
    const t0 = 1_000_000;

    // Healthy: Opus is chosen.
    let health = loadHealth(dir);
    expect(chooseActiveProvider(chain, health, t0)).toBe("opus");

    // Opus hits an explicit limit → cooldown persisted → GPT is chosen.
    health = markCooldown(health, "opus", t0, 900, "usage limit");
    saveHealth(dir, health);
    const reloaded = loadHealth(dir); // persisted across "processes"
    expect(inCooldown(reloaded, "opus", t0 + 1000)).toBe(true);
    expect(chooseActiveProvider(chain, reloaded, t0 + 1000)).toBe("gpt");

    // After the cooldown expires, we automatically return to Opus.
    expect(chooseActiveProvider(chain, reloaded, t0 + 901_000)).toBe("opus");
  });

  it("a generic error never triggers a cooldown/fallback (primary stays chosen)", () => {
    const chain = { primary: "opus", fallback: "gpt" };
    const health = {}; // nothing marked
    expect(classifyOutcome({ ok: false, code: 1, stdout: "tests failed", stderr: "" })).toBe("error");
    expect(chooseActiveProvider(chain, health, Date.now())).toBe("opus");
  });
});

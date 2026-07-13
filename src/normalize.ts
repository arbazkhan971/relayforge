/**
 * ONE provider-specific streaming normalizer for every physical turn (planner, worker, reviewer).
 *
 * The wave-3/4 bug: consumers read RAW provider stdout. Claude 2.1.207 stream-JSON begins with a
 * `system`/`init` record that carries a `tools` array, so a naive "first JSON array" scan returned
 * `["Task","Bash",...]` instead of the planner's terminal assistant text; a valid reviewer
 * acceptance was called malformed; `parseCost()` regex-matched the first `cost`-shaped field in ANY
 * record (including model-authored prose); and success/limit trusted nested `is_error`.
 *
 * This module parses only COMPLETE, TOP-LEVEL JSONL records and returns one typed terminal object.
 * The final terminal record wins. Nested text/tool blocks, telemetry, stderr, and model prose can
 * never be a top-level record, so they cannot spoof outcome, cost, or the fallback decision. Only an
 * EXPLICIT failed usage/quota/rate terminal sets `explicitLimit`.
 */

import { createHash } from "node:crypto";

export type ProviderKind = "claude" | "codex" | "gemini" | "custom";

/**
 * One accepted frame's EXACT wire bytes, as framed by the single bounded stdout pipeline (streaming.ts).
 * `raw` is valid ONLY for the duration of the `pushLine` call — hash it, never retain it.
 */
export type FrameBytes = {
  raw: Buffer;
  /** Byte offset of the frame's first byte in the raw stdout stream = its offset in the durable
   *  transcript (the transport writes the transcript from those same bytes, in order). */
  offset: number;
  /** 0-based index among accepted frames. */
  index: number;
};

/**
 * Evidence binding a verdict to the EXACT canonical terminal frame it was taken from.
 *
 * This is a hash of the provider's REAL BYTES — the accepted terminal record as it arrived on the wire —
 * not of the normalized verdict object. Hashing `JSON.stringify(verdict)` proved nothing: it is a hash
 * of our own derived conclusion, so it matches for any stream that happens to normalize the same way,
 * and it can never be checked against what is on disk. `sha256` here is verifiable against the durable
 * transcript by reading exactly `[offset, offset+bytes)` — the frame is located, not re-parsed, and the
 * hash is computed in the one bounded pass while the bytes are already in hand.
 */
export type TerminalFrameRef = {
  /** sha256 of the terminal frame's exact raw bytes (its terminating newline NOT included). */
  sha256: string;
  bytes: number;
  offset: number;
  index: number;
};

/** Hash the accepted frame's raw bytes, in-pass. Called at most once per turn (only for the frame the
 *  normalizer accepts as the canonical terminal), so it costs one sha256 over one record. */
function frameRef(f: FrameBytes): TerminalFrameRef {
  return {
    sha256: createHash("sha256").update(f.raw).digest("hex"),
    bytes: f.raw.length,
    offset: f.offset,
    index: f.index
  };
}

export type NormalizedTurn = {
  /** Provider whose dialect was parsed. */
  provider: ProviderKind;
  /** The terminal assistant TEXT — what planner/reviewer must parse. Never a tool list, never
   *  telemetry, never stderr. Empty string when no terminal/assistant text exists. */
  finalText: string;
  /** Whether a terminal (result/turn-completed) record was actually observed. A missing terminal
   *  record means the turn is UNCERTAIN (e.g. the child crashed mid-stream) and is treated as a
   *  generic error that NEVER falls back. */
  hasTerminal: boolean;
  /** True only when the terminal record explicitly reports success. Missing/failed terminal = false. */
  success: boolean;
  /** The terminal record's structured subtype (e.g. "success", "error_usage_limit"), if any. */
  subtype?: string;
  /** True ONLY for a FAILED terminal bound to an explicit top-level usage/quota/rate REJECTION.
   *  This is the sole signal that may invoke the Codex/GPT fallback. Auth/policy/model/context/
   *  timeout/overload/generic errors and allowed/allowed_warning telemetry never set it. */
  explicitLimit: boolean;
  /** USD cost parsed from the TERMINAL record only. `costReported` is false when the terminal
   *  reported no cost (subscription auth) — `usd` is then a placeholder 0 that MUST NOT be read as
   *  "free". */
  usd: number;
  costReported: boolean;
  inputTokens?: number;
  outputTokens?: number;
  /** The exact accepted canonical terminal frame this verdict came from. Present ONLY when a terminal
   *  was ACCEPTED (`hasTerminal`) AND the stream was fed through the framing pipeline (which supplies
   *  the raw bytes). Absent for a drifted/missing/rejected terminal — so no receipt can be built for a
   *  turn whose terminal we never accepted. The batch `normalizeTurn` path has no wire bytes and
   *  therefore never produces one. */
  terminalFrame?: TerminalFrameRef;
  /**
   * The exact canonical `rate_limit_event` frame whose `rate_limit_info.status` is `rejected` and which
   * is still the authoritative snapshot at the end of the turn — i.e. the ONE durable record that
   * authorizes billing a second provider. Present ONLY when `explicitLimit` holds.
   *
   * The terminal record alone cannot carry this: in the real Claude Code 2.1.207 dialect a usage
   * rejection is a SEPARATE top-level `rate_limit_event`, so fallback authority is evidenced by a
   * different frame than the verdict. The ledger re-reads exactly these bytes from the durable
   * transcript before it will issue a `trusted-fallback` receipt.
   */
  limitFrame?: TerminalFrameRef;
};

function asRecord(line: string): Record<string, unknown> | undefined {
  const t = line.trim();
  if (t.length < 2 || t.charCodeAt(0) !== 0x7b /* '{' */) return undefined;
  try {
    const v = JSON.parse(t);
    return asObj(v);
  } catch {
    return undefined;
  }
}

/**
 * The SOLE gate for treating an EXTERNAL value as a keyed record. Returns the value only when it is
 * a non-null, non-array object; otherwise undefined. Every place that used to cast `x as Record<...>`
 * and then do `key in x` / `x.field` MUST route through this: a primitive/array/null `usage`,
 * `error`, `message`, or `rate_limit_info` would otherwise make `key in x` throw a TypeError and
 * (via `runWith`) strand a budget reservation. Normalization must be TOTAL and NON-THROWING.
 */
function asObj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * True when `container[key]` is PRESENT but is not a non-array object (a primitive, null, or array).
 * A present-but-malformed `usage`/`token_count` means the terminal's own accounting shape is invalid,
 * so the turn must be treated as UNCERTAIN (never accepted as success) — while normalization itself
 * stays TOTAL (this only inspects, never throws). An ABSENT key (undefined) is fine.
 */
function fieldPresentButNotObject(container: Record<string, unknown> | undefined, key: string): boolean {
  if (!container) return false;
  const v = container[key];
  return v !== undefined && asObj(v) === undefined;
}

/** A token COUNT: a finite, NON-NEGATIVE, SAFE INTEGER, or undefined. A negative, fractional,
 *  non-finite, string, null, or unsafe-magnitude token member is rejected — real usage counters are
 *  whole nonnegative integers. */
function safeCount(v: unknown): number | undefined {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
}

/** True when a token member is PRESENT on `usage` but is not a valid `safeCount`. A present-but-
 *  invalid `input_tokens`/`output_tokens` (negative/fractional/string/null/nonfinite) makes the
 *  terminal's accounting malformed → the turn is UNCERTAIN, never accepted as success. */
function tokenMemberInvalid(usage: Record<string, unknown> | undefined, key: string): boolean {
  if (!usage || !(key in usage)) return false;
  return safeCount(usage[key]) === undefined;
}

/** A finite, NON-NEGATIVE USD amount, or undefined. Negative/NaN/Infinite/non-number are rejected. */
function nonNegNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** A finite, NON-NEGATIVE, SAFE-INTEGER epoch-seconds timestamp, or undefined. Claude 2.1.207
 *  serializes `resetsAt`/`overageResetsAt` as integer seconds; a fractional, negative, non-finite, or
 *  unsafe-magnitude value is drift (it must be safe to treat as an integer number of seconds). */
function safeTimestamp(v: unknown): number | undefined {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
}

/** True when a cost FIELD is present on `obj` but its value is not a finite non-negative number.
 *  A present-but-invalid cost is a MALFORMED terminal (negative/NaN/Infinite/string cost), which
 *  makes the whole turn UNCERTAIN — a run must never accept success with an unparseable spend. */
function costFieldInvalid(obj: Record<string, unknown> | undefined, key: string): boolean {
  if (!obj || !(key in obj)) return false;
  return nonNegNum(obj[key]) === undefined;
}

/** Extract the concatenated `text` blocks of a Claude `assistant` record's message content. */
function claudeAssistantText(obj: Record<string, unknown>): string | undefined {
  const message = asObj(obj.message);
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text") {
      const t = (block as Record<string, unknown>).text;
      if (typeof t === "string") parts.push(t);
    }
  }
  return parts.length ? parts.join("") : undefined;
}

/**
 * The three structurally valid values of a Claude `rate_limit_info.status` telemetry snapshot. Any
 * other value (missing, misspelled, non-string, nested elsewhere) is NOT a snapshot and must never
 * clear or set the rejection state — an unrecognized status must leave the prior snapshot intact.
 */
type RateStatus = "allowed" | "allowed_warning" | "rejected";

/**
 * The EXACT Claude Code 2.1.207 `rate_limit_info` camelCase schema, transcribed verbatim from the
 * installed binary's Zod serializer (`E.object({...})`, serializer `Wdp`/`oOb`). `status` is REQUIRED;
 * every other member is optional. The previous snake_case validation (`resets_at`, `retry_after`,
 * `unified_rate_limit_fallback_available`, …) was INVENTED and matched no real member.
 */
const RATE_MEMBERS = new Set([
  "status", "resetsAt", "rateLimitType", "utilization", "overageStatus", "overageResetsAt",
  "overageDisabledReason", "isUsingOverage", "overageInUse", "surpassedThreshold",
  "overagePeriodMonthly", "overagePeriodChannel", "errorCode", "canUserPurchaseCredits", "hasChargeableSavedPaymentMethod"
]);
const RATE_STATUS_ENUM = new Set(["allowed", "allowed_warning", "rejected"]);
const RATE_OVERAGE_STATUS_ENUM = new Set(["allowed", "allowed_warning", "rejected"]);
const RATE_TYPE_ENUM = new Set(["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_overage_included", "overage"]);
const RATE_OVERAGE_DISABLED_REASON_ENUM = new Set([
  "overage_not_provisioned", "org_level_disabled", "org_level_disabled_until", "out_of_credits",
  "seat_tier_level_disabled", "member_level_disabled", "seat_tier_zero_credit_limit", "group_zero_credit_limit",
  "member_zero_credit_limit", "org_service_level_disabled", "no_limits_configured", "fetch_error", "unknown"
]);
const RATE_ERROR_CODE_ENUM = new Set(["credits_required"]);
const RATE_ENUM_MEMBERS: Array<[string, Set<string>]> = [
  ["rateLimitType", RATE_TYPE_ENUM],
  ["overageStatus", RATE_OVERAGE_STATUS_ENUM],
  ["overageDisabledReason", RATE_OVERAGE_DISABLED_REASON_ENUM],
  ["errorCode", RATE_ERROR_CODE_ENUM]
];
const RATE_BOOL_MEMBERS = ["isUsingOverage", "overageInUse", "canUserPurchaseCredits", "hasChargeableSavedPaymentMethod"];
const RATE_TIMESTAMP_MEMBERS = ["resetsAt", "overageResetsAt"];
const RATE_UTIL_MEMBERS = ["utilization", "surpassedThreshold"];
const RATE_UTIL_WRAPPERS = ["overagePeriodMonthly", "overagePeriodChannel"];

/**
 * The FULLY VALIDATED rate-limit status carried by a TOP-LEVEL `rate_limit_event`'s own
 * `rate_limit_info` object, using the ACTUAL serialized camelCase dialect. Returns the effective
 * status ONLY when the whole snapshot validates against the pinned schema; any UNKNOWN member (drift
 * for this pinned CLI), any present-but-mistyped member, or a semantic contradiction yields undefined
 * = protocol drift, which can never be a rejection authority.
 */
function validatedRateStatus(rateEvent: Record<string, unknown>): RateStatus | undefined {
  const info = asObj(rateEvent.rate_limit_info);
  if (!info) return undefined; // missing / primitive / array rate_limit_info → not a valid snapshot
  // WHITELIST: any member not in the pinned camelCase union is drift (never a rejection authority).
  for (const k of Object.keys(info)) if (!RATE_MEMBERS.has(k)) return undefined;
  // `status` is REQUIRED and enum-constrained.
  const status = info.status;
  if (typeof status !== "string" || !RATE_STATUS_ENUM.has(status)) return undefined;
  // Every PRESENT enum member must match its pinned enum exactly.
  for (const [k, set] of RATE_ENUM_MEMBERS) {
    if (k in info && !(typeof info[k] === "string" && set.has(info[k] as string))) return undefined;
  }
  // Every PRESENT boolean flag must be a boolean.
  for (const k of RATE_BOOL_MEMBERS) if (k in info && typeof info[k] !== "boolean") return undefined;
  // Timestamps are finite nonnegative SAFE-INTEGER epoch seconds.
  for (const k of RATE_TIMESTAMP_MEMBERS) if (k in info && safeTimestamp(info[k]) === undefined) return undefined;
  // Utilization / thresholds are finite nonnegative numbers.
  for (const k of RATE_UTIL_MEMBERS) if (k in info && nonNegNum(info[k]) === undefined) return undefined;
  // Utilization WRAPPERS have the EXACT object shape `{utilization: <finite nonneg number>}`.
  for (const k of RATE_UTIL_WRAPPERS) {
    if (k in info) {
      const w = asObj(info[k]);
      if (!w || nonNegNum(w.utilization) === undefined) return undefined;
    }
  }
  // SEMANTIC CONTRADICTION: a base `rejected` while an overage IS in use and its overage status is
  // allowed/allowed_warning is NOT an unambiguous effective rejection — it must not authorize
  // fallback. Downgrade it to a non-rejecting snapshot (which CLEARS, never SETS, a rejection).
  const os = info.overageStatus;
  if (status === "rejected" && info.isUsingOverage === true && (os === "allowed" || os === "allowed_warning")) {
    return "allowed_warning";
  }
  return status as RateStatus;
}

/**
 * Claude Code 2.1.207 deterministic limit state machine.
 *
 * Real dialect (independently verified): a `result` record's `subtype` is one of `success`,
 * `error_during_execution`, `error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries`
 * — NONE of which is a usage/rate rejection. A usage rejection is a SEPARATE top-level
 * `rate_limit_event` whose `rate_limit_info.status` is `rejected`, emitted before the failed result.
 *
 * So the fallback signal cannot be read off the terminal alone. We track the LATEST structurally
 * valid top-level rate snapshot (from `rate_limit_event` records and any `result` that carries its
 * own `rate_limit_info`), bound to the session once an id is known. `allowed`/`allowed_warning`
 * clears an earlier `rejected`; a terminal `success` always wins; and ONLY a clean failed result
 * whose final applicable snapshot is `rejected` authorizes the Codex/GPT fallback. Generic
 * auth/policy/model/context/timeout/transport/overload failures never do.
 */
/** The WHITELIST of documented Claude Code 2.1.207 failed-`result` subtypes. A `result` with
 *  `is_error:true` is a CLEAN failure only when its subtype is one of these. An invented subtype
 *  (`potato`, `error_usage_limit`, bare `error`, …) is protocol drift → UNCERTAIN, never a clean
 *  failure — so it can neither be accepted nor (with a rejection) authorize the fallback. */
const CLAUDE_FAILURE_SUBTYPES = new Set([
  "error_during_execution",
  "error_max_turns",
  "error_max_budget_usd",
  "error_max_structured_output_retries"
]);

function nonEmptySession(obj: Record<string, unknown>): string | undefined {
  return typeof obj.session_id === "string" && obj.session_id.length > 0 ? obj.session_id : undefined;
}

/**
 * Claude Code 2.1.207 deterministic, SESSION-BOUND limit state machine (two-pass, total, non-throwing).
 *
 * PASS 1 finds the ONE authoritative session: the first `system/init` record carrying a nonempty
 * `session_id` binds it, and its index gates ordering. Pre-init records never bind or authorize.
 *
 * PASS 2 admits a record as AUTHORITY only when it is in scope:
 *   - when an init bound a session: the record appears AFTER the init AND carries the EXACT bound
 *     session_id (missing/foreign session → not authority; a foreign terminal cannot complete);
 *   - when NO init bound a session: the turn is sessionless, and only records carrying NO session_id
 *     are in scope.
 * The authoritative terminal is the single in-scope `result`. Zero → UNCERTAIN (missing terminal);
 * two or more → UNCERTAIN (conflicting terminals, never "last wins"). Only in-scope `rate_limit_event`
 * snapshots BEFORE that terminal affect the turn; a post-terminal event is ignored. A malformed
 * in-scope rate event (typed `rate_limit_event` with no valid status) is protocol drift and blocks any
 * fallback rather than silently leaving a stale rejection authoritative. Terminal-owned
 * `rate_limit_info` is NOT trusted as authority (no pinned real-CLI fixture proves that dialect).
 */
/** The three authoritative Claude record types that MUST, after init, carry the exact bound session
 *  id and MUST NOT appear after the terminal. A `user` (tool_result) record is telemetry, not
 *  authority, so it is never session-gated. */
function isClaudeAuthoritative(r: Record<string, unknown>): boolean {
  return r.type === "assistant" || r.type === "rate_limit_event" || r.type === "result";
}

/** The PINNED top-level record union for Claude Code 2.1.207 `-p --output-format stream-json`. Any
 *  other top-level `type` (control_request/control_response/stream_event/partial or an aliased/unknown
 *  record) is protocol drift for this pinned CLI → UNCERTAIN. */
const CLAUDE_RECORD_TYPES = new Set(["system", "assistant", "user", "result", "rate_limit_event"]);

/**
 * The shared streaming interface. `runHeadlessChild` feeds each COMPLETE stdout line into a per-
 * provider streaming normalizer as it arrives, so the whole-stream verdict is validated ONCE over
 * EVERY record with O(1) protocol state plus a bounded terminal/final-text capture — never inferred
 * from a lossy recent-line tail (which could evict the required `init` for a false uncertainty, or
 * evict an earlier duplicate/corrupt/foreign/error record for a false success). The batch
 * `normalizeTurn` DELEGATES to the very same streaming state machine, so the two can never diverge.
 */
export interface StreamingNormalizer {
  /** Feed one raw stdout line (with or without its trailing newline). Blank lines are ignored.
   *  `frame` carries that line's exact wire bytes and stream offset when the caller is the framing
   *  pipeline; it is the ONLY way a verdict can be bound to the bytes it came from. */
  pushLine(line: string, frame?: FrameBytes): void;
  /** Produce the final whole-stream verdict. Idempotent-safe to call once after the stream ends. */
  finish(): NormalizedTurn;
}

/**
 * Claude Code 2.1.207 SINGLE-PASS streaming state machine. Because the stream is strictly ordered
 * (init first, exactly one terminal last), the batch two-pass algorithm reduces to one pass: bind the
 * first init, validate every later record against it in order, capture the FIRST in-scope terminal
 * record, and flag any record after it as trailing drift. State is O(1); only the terminal record and
 * the last pre-terminal assistant text are retained (bounded required terminal/final text).
 */
class StreamingClaudeNormalizer implements StreamingNormalizer {
  private index = 0;
  private lineDrift = false;
  private initCount = 0;
  private initIndex = -1;
  private initMalformed = false;
  private boundSession: string | undefined;
  private authBeforeInit = false; // an authoritative record seen before any init (out of scope)
  private terminalCount = 0;
  private firstTerminalIndex = -1;
  private capturedTerminal: Record<string, unknown> | undefined;
  private capturedFrame: TerminalFrameRef | undefined;
  private postTerminalDrift = false;
  private sessionDrift = false;
  private lastAssistantText: string | undefined;
  private rate: RateStatus | undefined;
  /** The wire bytes of the record that set the CURRENT rate snapshot. Replaced whenever the snapshot is
   *  replaced (an `allowed` clears a `rejected`), so it always names the frame the final status came
   *  from — never a stale rejection that a later record already cleared. */
  private rateFrame: TerminalFrameRef | undefined;
  private rateDrift = false;

  pushLine(line: string, frame?: FrameBytes): void {
    if (line.trim() === "") return; // blank lines are ignored
    const obj = asRecord(line);
    if (!obj) {
      this.lineDrift = true; // a nonblank, non-top-level-object line is protocol drift
      return;
    }
    // PIN the installed record union: an unknown/aliased top-level `type` is protocol drift.
    if (typeof obj.type !== "string" || !CLAUDE_RECORD_TYPES.has(obj.type)) this.lineDrift = true;
    const i = this.index++;

    // EXACTLY ONE valid `system/init` binds the authoritative session; it is not itself authority.
    if (obj.type === "system" && obj.subtype === "init") {
      this.initCount++;
      const sid = nonEmptySession(obj);
      if (sid === undefined) this.initMalformed = true;
      else if (this.initIndex < 0) {
        this.initIndex = i;
        this.boundSession = sid;
      }
      return;
    }

    const authoritative = isClaudeAuthoritative(obj);
    // Before an init is bound, any authoritative record is out of scope (pre-init). Only meaningful if
    // an init later validates; otherwise `!initValid` already fails the turn closed.
    if (this.initIndex < 0) {
      if (authoritative) this.authBeforeInit = true;
      return;
    }
    // TRAILING: no record of ANY type may follow the single terminal — every post-terminal record is
    // drift so trailing corruption can never be hidden. (A second terminal lands here too → drift.)
    if (this.firstTerminalIndex >= 0 && i > this.firstTerminalIndex) {
      this.postTerminalDrift = true;
      return;
    }
    const inScope = nonEmptySession(obj) === this.boundSession; // i > initIndex already holds here
    if (authoritative && !inScope) {
      this.sessionDrift = true; // an authoritative record not bound to our session
      return;
    }
    if (obj.type === "result" && inScope) {
      this.terminalCount++;
      if (this.firstTerminalIndex < 0) {
        this.firstTerminalIndex = i;
        this.capturedTerminal = obj; // capture the FIRST in-scope terminal record (bounded)
        // Bind the verdict to the record's EXACT wire bytes, hashed here in the one pass while they are
        // still in hand. Nothing is retained but the 32-byte digest and its offset/length.
        this.capturedFrame = frame ? frameRef(frame) : undefined;
      }
      return;
    }
    if (obj.type === "assistant" && inScope) {
      const t = claudeAssistantText(obj);
      if (t !== undefined) this.lastAssistantText = t; // last pre-terminal assistant text
      return;
    }
    if (obj.type === "rate_limit_event" && inScope) {
      const st = validatedRateStatus(obj); // validates EVERY present pinned camelCase field
      if (st === undefined) this.rateDrift = true; // a typed rate event that does not fully validate
      else {
        this.rate = st; // allowed / allowed_warning clears an earlier rejection; rejected sets it
        // Bind the snapshot to the EXACT bytes that set it, in this one pass. The frame moves with the
        // status, so a rejection that a later `allowed` cleared can never leave its frame behind as
        // fallback evidence.
        this.rateFrame = frame ? frameRef(frame) : undefined;
      }
      return;
    }
    // in-scope `user` telemetry (or an unknown-type record already flagged as lineDrift) — no authority.
  }

  finish(): NormalizedTurn {
    const initValid = this.initCount === 1 && this.initIndex >= 0 && !this.initMalformed;
    const sessionDrift = this.sessionDrift || (initValid && this.authBeforeInit);
    const rate = this.rate;
    const rateDrift = this.rateDrift;
    const lastAssistantText = this.lastAssistantText;

    // Any protocol drift makes the whole turn UNCERTAIN: no accepted terminal, no fallback authority.
    const drift = this.lineDrift || !initValid || sessionDrift || this.postTerminalDrift || rateDrift;
    const terminal = !drift && this.terminalCount === 1 ? this.capturedTerminal : undefined;

  const subtype = typeof terminal?.subtype === "string" ? (terminal.subtype as string) : undefined;
  const isErrorTrue = terminal?.is_error === true;
  const isErrorFalse = terminal?.is_error === false;
  const usage = asObj(terminal?.usage);
  // A PRESENT non-object `usage`, or a present-but-invalid token member, makes the terminal malformed.
  const usageMalformed =
    fieldPresentButNotObject(terminal, "usage") || tokenMemberInvalid(usage, "input_tokens") || tokenMemberInvalid(usage, "output_tokens");
  // Claude 2.1.207 reports authoritative cost ONLY as top-level `total_cost_usd`. There is NO
  // `usage.cost_usd` alias in the real dialect: a terminal carrying only that nested field has UNKNOWN
  // cost (never a trusted amount), and the nested field is neither read as cost nor validated as one.
  const costInvalid = terminal ? costFieldInvalid(terminal, "total_cost_usd") || usageMalformed : false;

  // STRICT, WHITELISTED terminal classification. Exactly one of: well-formed SUCCESS, whitelisted
  // clean FAILURE, or MALFORMED/ambiguous (UNCERTAIN). Contradictory flags and invented subtypes are
  // UNCERTAIN, never accepted and never fallback authority.
  let success = false;
  let cleanFailure = false;
  const terminalResultIsString = typeof terminal?.result === "string";
  if (terminal && !costInvalid) {
    if (subtype === "success") {
      // The real success schema is `subtype:"success", is_error:E.boolean(), result:E.string()`.
      // Success REQUIRES a schema-valid is_error:false AND an OWN `result` field whose value is a
      // string. A missing/null/object/array result is UNCERTAIN even if an assistant record exists —
      // observational assistant text must never repair a malformed success terminal.
      if (isErrorFalse && terminalResultIsString) success = true;
    } else if (subtype !== undefined && CLAUDE_FAILURE_SUBTYPES.has(subtype)) {
      if (isErrorTrue) cleanFailure = true; // a whitelisted failure REQUIRES is_error:true
      // else contradictory (failure subtype without is_error:true) → UNCERTAIN
    }
    // else: missing/invented subtype (`potato`, `error_usage_limit`, bare `error`) → UNCERTAIN
  }
  const hasTerminal = success || cleanFailure;

  const terminalText = typeof terminal?.result === "string" ? (terminal.result as string) : undefined;
  const finalText = terminalText ?? lastAssistantText ?? "";

  // Canonical fallback: a clean FAILED terminal whose final in-scope pre-terminal snapshot is
  // `rejected`, with NO protocol drift. Success never falls back; allowed/allowed_warning clears an
  // earlier rejection; a drifted rate stream never authorizes.
  const explicitLimit = cleanFailure && rate === "rejected" && !rateDrift;

  const usdVal = terminal && !costInvalid ? nonNegNum(terminal.total_cost_usd) : undefined;
  return {
    provider: "claude",
    finalText,
    hasTerminal,
    success,
    subtype,
    explicitLimit,
    usd: usdVal ?? 0,
    costReported: usdVal !== undefined,
    inputTokens: usage ? safeCount(usage.input_tokens) : undefined,
    outputTokens: usage ? safeCount(usage.output_tokens) : undefined,
    // ONLY an ACCEPTED terminal carries frame evidence. A drifted, duplicated, foreign, malformed, or
    // missing terminal yields none — so a receipt can never be built for a turn we did not accept.
    terminalFrame: hasTerminal ? this.capturedFrame : undefined,
    // ONLY a canonical, still-authoritative `rejected` snapshot carries fallback evidence.
    limitFrame: explicitLimit ? this.rateFrame : undefined
  };
  }
}

/** Batch entry: split the whole stdout into lines and DELEGATE to the streaming state machine, so the
 *  batch and streaming paths share one implementation and can never diverge. */
function normalizeClaude(stdout: string): NormalizedTurn {
  const text = typeof stdout === "string" ? stdout : String(stdout ?? "");
  const n = new StreamingClaudeNormalizer();
  for (const line of text.split("\n")) n.pushLine(line);
  return n.finish();
}

/**
 * The EXACT installed Codex 0.144.0 (`rust-v0.144.0`, peeled `767822446c…`) `--json` top-level event
 * union from `codex-rs/exec/src/exec_events.rs` `enum ThreadEvent`: eight `#[serde(tag="type")]`
 * variants. `error` IS a pinned variant (an unrecoverable stream error), NOT an unknown alias. Any
 * OTHER record type — the synthetic aliases the old permissive parser accepted (`session.created`,
 * `msg`, `assistant_message`, `message`, `token_count`, …) — is protocol drift → UNCERTAIN.
 */
const CODEX_ITEM_TYPES = new Set(["item.started", "item.updated", "item.completed"]);
const CODEX_EVENT_TYPES = new Set([
  "thread.started", "turn.started", ...CODEX_ITEM_TYPES, "turn.completed", "turn.failed", "error"
]);
/** The installed usage counters on a `turn.completed` (`struct Usage`). All four MUST be present
 *  nonnegative safe integers; Codex emits NO authoritative USD cost, so cost is ALWAYS unknown. */
const CODEX_USAGE_COUNTERS = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"];

/** Pinned `ThreadItemDetails` status/kind/tool enums (all `rename_all = "snake_case"`). */
const CODEX_CMD_STATUS = new Set(["in_progress", "completed", "failed", "declined"]);
const CODEX_PATCH_APPLY_STATUS = new Set(["in_progress", "completed", "failed"]);
const CODEX_PATCH_CHANGE_KIND = new Set(["add", "delete", "update"]);
const CODEX_MCP_STATUS = new Set(["in_progress", "completed", "failed"]);
const CODEX_COLLAB_STATUS = new Set(["in_progress", "completed", "failed"]);
const CODEX_COLLAB_TOOL = new Set(["spawn_agent", "send_input", "wait", "close_agent"]);
const CODEX_ITEM_DETAIL_TYPES = new Set([
  "agent_message", "reasoning", "command_execution", "file_change",
  "mcp_tool_call", "collab_tool_call", "web_search", "todo_list", "error"
]);

const isStr = (v: unknown): boolean => typeof v === "string";

/**
 * Validate ONE Codex `ThreadItem` = `{ id: String, #[flatten] details }` where `details` is a
 * `#[serde(tag="type", rename_all="snake_case")]` union. Every item MUST carry a nonempty string `id`
 * and a pinned detail `type`; the type-specific required members and status/kind/tool enums are
 * validated so a malformed non-agent item can never ride alongside a valid final message. Returns the
 * agent text only for a well-formed `agent_message`.
 */
function validCodexItem(item: Record<string, unknown>): { ok: boolean; agentText?: string } {
  if (typeof item.id !== "string" || item.id.length === 0) return { ok: false };
  const t = item.type;
  if (typeof t !== "string" || !CODEX_ITEM_DETAIL_TYPES.has(t)) return { ok: false };
  switch (t) {
    case "agent_message":
      return { ok: isStr(item.text), agentText: isStr(item.text) ? (item.text as string) : undefined };
    case "reasoning":
      return { ok: isStr(item.text) };
    case "command_execution": {
      const exitOk = item.exit_code === null || item.exit_code === undefined || (typeof item.exit_code === "number" && Number.isInteger(item.exit_code));
      return { ok: isStr(item.command) && isStr(item.aggregated_output) && exitOk && typeof item.status === "string" && CODEX_CMD_STATUS.has(item.status) };
    }
    case "file_change": {
      const changes = item.changes;
      const changesOk = Array.isArray(changes) && changes.every((c) => {
        const co = asObj(c);
        return !!co && isStr(co.path) && typeof co.kind === "string" && CODEX_PATCH_CHANGE_KIND.has(co.kind);
      });
      return { ok: changesOk && typeof item.status === "string" && CODEX_PATCH_APPLY_STATUS.has(item.status) };
    }
    case "mcp_tool_call":
      return { ok: isStr(item.server) && isStr(item.tool) && typeof item.status === "string" && CODEX_MCP_STATUS.has(item.status) };
    case "collab_tool_call":
      return {
        ok: typeof item.tool === "string" && CODEX_COLLAB_TOOL.has(item.tool) && isStr(item.sender_thread_id) &&
          Array.isArray(item.receiver_thread_ids) && item.receiver_thread_ids.every(isStr) &&
          typeof item.status === "string" && CODEX_COLLAB_STATUS.has(item.status)
      };
    case "web_search":
      return { ok: isStr(item.query) && asObj(item.action) !== undefined };
    case "todo_list": {
      const items = item.items;
      const ok = Array.isArray(items) && items.every((td) => {
        const to = asObj(td);
        return !!to && isStr(to.text) && typeof to.completed === "boolean";
      });
      return { ok };
    }
    case "error":
      return { ok: isStr(item.message) };
    default:
      return { ok: false };
  }
}

/**
 * Codex 0.144.0 `--json` lifecycle, PINNED and STRICTLY validated (total, non-throwing).
 *
 * The installed dialect is an exact allowlisted sequence: `thread.started` (with a nonempty
 * `thread_id`) → `turn.started` → zero or more `item.*` (the agent_message lives in an `item.completed`
 * whose `item` is exactly `{id, type:"agent_message", text}`) → EXACTLY ONE `turn.completed` |
 * `turn.failed`. A non-JSON line, an unknown/aliased record type, an out-of-order record, an item
 * outside a turn, a missing/duplicate terminal, a trailing record after the terminal, a malformed
 * agent_message item, or (on `turn.completed`) missing/invalid usage counters ALL make the turn NOT a
 * clean success. Codex emits no authoritative USD cost, so cost is always unknown. Codex is the
 * FALLBACK provider, so it can NEVER itself trigger a further fallback (`explicitLimit` is always false).
 */
/**
 * Codex 0.144.0 `--json` SINGLE-PASS streaming lifecycle state machine. Already inherently streaming:
 * a bounded phase machine plus the last completed agent_message text (bounded final text). O(1) state.
 */
class StreamingCodexNormalizer implements StreamingNormalizer {
  private lastAgentText: string | undefined;
  private phase: "init" | "thread" | "turn" | "done" = "init";
  private lifecycleValid = true;
  private terminalCount = 0;
  private terminalError = false;
  private usageValid = false;
  private inputTokens: number | undefined;
  private outputTokens: number | undefined;
  private capturedFrame: TerminalFrameRef | undefined;

  /** Bind the verdict to the exact bytes of the FIRST terminal event (`turn.completed`, `turn.failed`,
   *  or `error`) — the record that ends the pinned lifecycle. */
  private captureTerminal(frame?: FrameBytes): void {
    if (this.terminalCount === 0 && frame) this.capturedFrame = frameRef(frame);
  }

  pushLine(line: string, frame?: FrameBytes): void {
    if (line.trim() === "") return;
    const obj = asRecord(line);
    if (!obj) {
      this.lifecycleValid = false; // a nonblank, non-top-level-object line is protocol drift
      return;
    }
    const type = obj.type;
    // A record AFTER the single terminal is a TRAILING event → drift.
    if (this.phase === "done") {
      this.lifecycleValid = false;
      return;
    }
    if (typeof type !== "string" || !CODEX_EVENT_TYPES.has(type)) {
      this.lifecycleValid = false; // unknown/aliased record type → drift
      return;
    }

    if (type === "error") {
      // `ThreadEvent::Error(ThreadErrorEvent{message:String})` — an unrecoverable stream error. It is
      // a pinned TERMINAL event (not an unknown alias) that can appear in any phase and can NEVER
      // coexist with an accepted success. Its `message` MUST be a string.
      if (typeof obj.message !== "string") this.lifecycleValid = false;
      this.terminalError = true;
      this.captureTerminal(frame);
      this.terminalCount++;
      this.phase = "done";
      return;
    }
    if (type === "thread.started") {
      if (this.phase !== "init" || typeof obj.thread_id !== "string" || obj.thread_id.length === 0) this.lifecycleValid = false;
      else this.phase = "thread";
      return;
    }
    if (type === "turn.started") {
      if (this.phase !== "thread") this.lifecycleValid = false;
      else this.phase = "turn";
      return;
    }
    if (CODEX_ITEM_TYPES.has(type)) {
      if (this.phase !== "turn") {
        this.lifecycleValid = false; // items are only valid INSIDE a turn
        return;
      }
      const item = asObj(obj.item);
      if (!item) {
        this.lifecycleValid = false; // a present-but-non-object item is drift
        return;
      }
      const v = validCodexItem(item);
      if (!v.ok) {
        this.lifecycleValid = false; // a malformed item of ANY family (not just agent_message) is drift
        return;
      }
      // Only a COMPLETED, well-formed agent_message supplies the final text.
      if (type === "item.completed" && item.type === "agent_message" && typeof v.agentText === "string") {
        this.lastAgentText = v.agentText;
      }
      return;
    }
    // turn.completed | turn.failed
    if (this.phase !== "turn") this.lifecycleValid = false; // a terminal outside an open turn is out of order
    this.phase = "done";
    this.captureTerminal(frame);
    this.terminalCount++;
    if (type === "turn.failed") {
      this.terminalError = true;
      // `TurnFailedEvent{ error: ThreadErrorEvent{message:String} }` — message MUST be a string.
      const err = asObj(obj.error);
      if (!err || typeof err.message !== "string") this.lifecycleValid = false;
    }
    if (type === "turn.completed") {
      const usage = asObj(obj.usage);
      if (usage && CODEX_USAGE_COUNTERS.every((k) => safeCount(usage[k]) !== undefined)) {
        this.usageValid = true;
        this.inputTokens = safeCount(usage.input_tokens);
        this.outputTokens = safeCount(usage.output_tokens);
      } else {
        this.lifecycleValid = false; // turn.completed REQUIRES all installed usage counters, valid
      }
    }
  }

  finish(): NormalizedTurn {
    // A clean turn is the FULL pinned lifecycle ending in EXACTLY ONE terminal. Codex reports NO USD,
    // so cost is always unknown (worst-case reservation retained). A SUCCESS additionally requires a
    // `turn.completed` (not turn.failed/error), valid usage, AND a valid completed agent_message with
    // string text — harvested only after the whole lifecycle validates.
    const cleanTerminal = this.lifecycleValid && this.phase === "done" && this.terminalCount === 1;
    const success = cleanTerminal && !this.terminalError && this.usageValid && typeof this.lastAgentText === "string";
    const inputTokens = this.inputTokens;
    const outputTokens = this.outputTokens;
    const lastAgentText = this.lastAgentText;
    return {
    provider: "codex",
    finalText: lastAgentText ?? "",
    hasTerminal: cleanTerminal,
    success,
    subtype: undefined,
    explicitLimit: false,
    usd: 0,
    costReported: false,
    inputTokens,
    outputTokens,
    terminalFrame: cleanTerminal ? this.capturedFrame : undefined
  };
  }
}

/** Batch entry: split the whole stdout into lines and DELEGATE to the streaming state machine. */
function normalizeCodex(stdout: string): NormalizedTurn {
  const raw = typeof stdout === "string" ? stdout : String(stdout ?? "");
  const n = new StreamingCodexNormalizer();
  for (const line of raw.split("\n")) n.pushLine(line);
  return n.finish();
}

/**
 * Create a streaming normalizer for a provider, so a caller (the transport) can validate the WHOLE
 * stream ONCE, record by record, with bounded memory — never inferring the verdict from a lossy tail.
 * Gemini/custom have no streaming record contract; their streaming normalizer buffers a bounded tail
 * and defers to the batch shape at `finish()` (they never authorize fallback).
 */
export function createStreamingNormalizer(provider: ProviderKind): StreamingNormalizer {
  if (provider === "claude") return new StreamingClaudeNormalizer();
  if (provider === "codex") return new StreamingCodexNormalizer();
  return new StreamingRawNormalizer(provider);
}

/**
 * Gemini/custom streaming shim: these have no per-record streaming contract, so we retain only a
 * BOUNDED tail of the stream (the single terminal JSON object is at the end) and run the batch raw
 * shape over it at `finish()`. Memory stays bounded regardless of stream length; they never fall back.
 */
class StreamingRawNormalizer implements StreamingNormalizer {
  private tail = "";
  private tailFrame: TerminalFrameRef | undefined;
  private static CAP = 16 * 1024 * 1024;
  constructor(private provider: ProviderKind) {}
  pushLine(line: string, frame?: FrameBytes): void {
    if (line.trim() === "") return;
    // Keep only the most recent non-blank line (the terminal object is last), bounded to CAP chars.
    const truncated = line.length > StreamingRawNormalizer.CAP;
    this.tail = truncated ? line.slice(line.length - StreamingRawNormalizer.CAP) : line;
    // Frame evidence only for a line we kept WHOLE: a truncated tail is not the record's exact bytes,
    // so it must never be presented as a hash of them.
    this.tailFrame = !truncated && frame ? frameRef(frame) : undefined;
  }
  finish(): NormalizedTurn {
    const n = normalizeRaw(this.provider, this.tail);
    return { ...n, terminalFrame: n.hasTerminal ? this.tailFrame : undefined };
  }
}

/**
 * Normalize a single provider turn's stdout into the shared typed terminal object. Gemini/custom
 * providers have no structured stream contract in this release, so their stdout is treated as raw
 * final text with an UNKNOWN cost and no limit signal (they never fall back).
 */
export function normalizeTurn(provider: ProviderKind, stdout: string): NormalizedTurn {
  if (provider === "claude") return normalizeClaude(stdout);
  if (provider === "codex") return normalizeCodex(stdout);
  return normalizeRaw(provider, stdout);
}

function normalizeRaw(provider: ProviderKind, stdout: string): NormalizedTurn {
  const text = (typeof stdout === "string" ? stdout : String(stdout ?? "")).trim();
  // Gemini/custom have no streaming contract in this release. A provider that emits a single
  // terminal JSON object (the common case) gets its structured `is_error`/`result`/cost honored;
  // anything else is treated as raw final text. Gemini/custom NEVER trigger the fallback.
  const obj = asRecord(text);
  if (obj) {
    const isError = obj.is_error === true || obj.type === "error";
    const usage = asObj(obj.usage);
    // A present-but-invalid cost OR a present-but-non-object `usage` is malformed → UNCERTAIN.
    const costInvalid =
      costFieldInvalid(obj, "total_cost_usd") ||
      costFieldInvalid(obj, "cost_usd") ||
      costFieldInvalid(usage, "cost_usd") ||
      fieldPresentButNotObject(obj, "usage") ||
      tokenMemberInvalid(usage, "input_tokens") ||
      tokenMemberInvalid(usage, "output_tokens");
    const usd = costInvalid ? undefined : nonNegNum(obj.total_cost_usd) ?? nonNegNum(obj.cost_usd);
    return {
      provider,
      finalText: typeof obj.result === "string" ? (obj.result as string) : text,
      hasTerminal: !costInvalid,
      success: !isError && !costInvalid,
      subtype: typeof obj.subtype === "string" ? (obj.subtype as string) : undefined,
      explicitLimit: false,
      usd: usd ?? 0,
      costReported: usd !== undefined,
      inputTokens: usage ? safeCount(usage.input_tokens) : undefined,
      outputTokens: usage ? safeCount(usage.output_tokens) : undefined
    };
  }
  return {
    provider,
    finalText: text,
    hasTerminal: text.length > 0,
    success: text.length > 0,
    subtype: undefined,
    explicitLimit: false,
    usd: 0,
    costReported: false
  };
}

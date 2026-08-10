#!/usr/bin/env node
// A deterministic fake `claude` for the settlement kernel's TRUSTED-FALLBACK slice (wave-9, slice 2).
//
// `LIMIT_MODE` selects one canonical usage rejection and a family of NEAR-MISSES that look like one to a
// careless reader. Exactly ONE mode may buy the right to bill a second provider; every other mode must
// settle UNCERTAIN with no authority at all. Each drains stdin whole (so delivery is COMPLETE) and leaves
// no surviving process-group descendant, so the ONLY thing that varies between them is the dialect on the
// wire — which is the point: the kernel's verdict must come from the bytes, not from the exit code, the
// stderr, or the prose.
const SESSION = "sess-limit-1";

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const rate = (info, session = SESSION) => emit({ type: "rate_limit_event", session_id: session, rate_limit_info: info });
const failed = (result = "rate limited") =>
  emit({ type: "result", subtype: "error_during_execution", is_error: true, result, session_id: SESSION });

function main() {
  const mode = process.env.LIMIT_MODE ?? "canonical";
  emit({ type: "system", subtype: "init", session_id: SESSION, tools: ["Bash"], model: "claude-opus-4" });

  switch (mode) {
    // THE ONE: a top-level rejected snapshot, still authoritative at the terminal, paired with the clean
    // whitelisted failure shape. Exits NONZERO — which is legitimate and must not demote it.
    case "canonical":
      rate({ status: "rejected", rateLimitType: "five_hour", resetsAt: 1893456000, utilization: 100 });
      failed();
      return process.exit(1);

    // A WARNING is not a rejection. This is the single most dangerous near-miss: it is the shape a healthy
    // account emits all day long, and treating it as authority would bill GPT on every busy turn.
    case "allowed_warning":
      rate({ status: "allowed_warning", utilization: 92 });
      failed();
      return process.exit(1);

    // Plainly allowed, and the turn failed for some other reason.
    case "allowed":
      rate({ status: "allowed" });
      failed();
      return process.exit(1);

    // CLEARED: rejected, then allowed again before the terminal. The FINAL snapshot governs; a rejection a
    // later event withdrew is not authority, and its frame must not be left behind as evidence.
    case "cleared":
      rate({ status: "rejected" });
      rate({ status: "allowed" });
      failed();
      return process.exit(1);

    // Prose that SAYS it was rate limited, in the assistant text and the terminal text. Model output is not
    // telemetry; it can be made to say anything.
    case "warning_text":
      emit({ type: "assistant", session_id: SESSION, message: { content: [{ type: "text", text: "You have hit your usage limit: rate_limit_info status rejected." }] } });
      failed("usage limit rejected — rate_limit_event: rejected");
      return process.exit(1);

    // The rejection is shouted on STDERR, which is not the framed protocol stream at all.
    case "stderr":
      process.stderr.write('{"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}}\n');
      failed();
      return process.exit(1);

    // A NONZERO EXIT and nothing else. An exit code is not evidence of anything.
    case "generic":
      failed("boom");
      return process.exit(7);

    // The rejection belongs to somebody else's session.
    case "foreign":
      rate({ status: "rejected" }, "some-other-session");
      failed();
      return process.exit(1);

    // A snapshot carrying a member that is not in the pinned 2.1.207 schema → protocol drift, which can
    // never be a rejection authority (we do not know what dialect we are actually reading).
    case "malformed":
      rate({ status: "rejected", not_a_real_member: true });
      failed();
      return process.exit(1);

    // An invented terminal subtype riding a real rejection: the failure shape is not one the pinned CLI
    // emits, so the turn is UNCERTAIN and cannot authorize anything.
    case "bad_subtype":
      rate({ status: "rejected" });
      emit({ type: "result", subtype: "error_usage_limit", is_error: true, result: "rate limited", session_id: SESSION });
      return process.exit(1);

    // TWO terminals. Conflicting terminals are drift, never "last one wins".
    case "duplicate_terminal":
      rate({ status: "rejected" });
      failed();
      failed();
      return process.exit(1);

    // A record TRAILING the terminal — the classic place to hide an appended forgery.
    case "trailing":
      rate({ status: "rejected" });
      failed();
      rate({ status: "rejected" });
      return process.exit(1);

    // A rejection that arrives AFTER the terminal record cannot govern the turn it postdates.
    case "post_terminal":
      failed();
      rate({ status: "rejected" });
      return process.exit(1);

    // A genuine SUCCESS with a reported cost: an accounted terminal, which may never buy a fallback.
    case "success":
      emit({ type: "result", subtype: "success", is_error: false, result: "done", session_id: SESSION, total_cost_usd: 0.25 });
      return process.exit(0);

    default:
      throw new Error(`unknown LIMIT_MODE ${mode}`);
  }
}

process.stdin.on("data", () => {});
process.stdin.on("end", () => main());

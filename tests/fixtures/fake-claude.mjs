#!/usr/bin/env node
// A deterministic fake `claude` binary for the routed-fallback E2E. It IGNORES the claude CLI flags
// (argv) and instead emits real-shaped Claude Code 2.1.207 stream-JSON driven by env/control-file so
// a test can produce a CANONICAL usage rejection, a GENERIC failure, or a MALFORMED/foreign-session
// rejection — all through the SAME production transport + normalizer + routing path.
//
// It MUST drain stdin fully: an early exit would make the transport mark delivery incomplete
// (UNCERTAIN) and mask the routing decision under test.
import { readFileSync, appendFileSync } from "node:fs";

const SESSION = "sess-claude-1";

function main(stdin) {
  const capture = process.env.ROUTE_CAPTURE;
  if (capture) appendFileSync(capture, `claude|byte0=${JSON.stringify(stdin.slice(0, 5))}\n`);

  // Control the emitted dialect: a per-turn control file (preferred) or a static env fallback.
  let mode = process.env.CLAUDE_MODE || "ok";
  const control = process.env.CLAUDE_CONTROL;
  if (control) {
    try {
      mode = readFileSync(control, "utf8").trim() || mode;
    } catch {
      /* use env/default */
    }
  }

  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  emit({ type: "system", subtype: "init", session_id: SESSION, tools: ["Task", "Bash"], model: "claude-opus-4" });

  if (mode === "limit") {
    // CANONICAL rejection: matching top-level rejected rate_limit_event → matching clean failed result.
    emit({ type: "rate_limit_event", session_id: SESSION, rate_limit_info: { status: "rejected" } });
    emit({ type: "result", subtype: "error_during_execution", is_error: true, result: "rate limited", session_id: SESSION });
    process.exit(1); // a canonical rejection is allowed to exit nonzero
  } else if (mode === "generic") {
    // A generic failure with NO rejection snapshot → must NEVER fall back.
    emit({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom", session_id: SESSION });
    process.exit(1);
  } else if (mode === "foreign") {
    // A rejection bound to a FOREIGN session → not authority → must NEVER fall back.
    emit({ type: "rate_limit_event", session_id: "someone-else", rate_limit_info: { status: "rejected" } });
    emit({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom", session_id: SESSION });
    process.exit(1);
  } else {
    emit({ type: "result", subtype: "success", is_error: false, result: "opus ok", session_id: SESSION, total_cost_usd: 0 });
    process.exit(0);
  }
}

let buf = "";
process.stdin.on("data", (c) => (buf += c));
process.stdin.on("end", () => main(buf));

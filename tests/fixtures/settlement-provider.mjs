#!/usr/bin/env node
// A deterministic fake `claude` for the settlement-kernel slice: it drains stdin whole (so delivery is
// COMPLETE), emits a canonical, session-bound Claude stream-JSON init + success terminal carrying an
// EXPLICIT `total_cost_usd`, and exits 0 leaving no surviving process-group descendant.
//
// COST_USD sets the reported cost. NO_COST=1 emits a terminal with no cost field at all (a subscription
// turn), which the kernel must refuse to settle as trusted.
const SESSION = "sess-settlement-1";

function main() {
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  emit({ type: "system", subtype: "init", session_id: SESSION, tools: ["Bash"], model: "claude-opus-4" });
  const terminal = {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    session_id: SESSION,
    usage: { input_tokens: 11, output_tokens: 22 }
  };
  if (process.env.NO_COST !== "1") terminal.total_cost_usd = Number(process.env.COST_USD ?? "0.25");
  emit(terminal);
}

process.stdin.on("data", () => {});
process.stdin.on("end", () => main());

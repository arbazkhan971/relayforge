// Emits a LARGE Claude 2.1.207 stream-JSON turn to prove whole-stream lifecycle authority under a
// bounded in-memory tail. The intervening flood exceeds BOTH the 16 MiB byte cap and the 50 000-line
// record cap of the transport's LineTailBuffer, so the required `init` (and any early drift) is
// EVICTED from the recent-line tail — yet the streaming verdict must still be correct.
//
//   argv[2] = mode: "valid" | "dup-init" | "corrupt" | "foreign"
//   argv[3] = number of filler records (default 60000)
//
// A ~320-byte pad on each filler makes 60 000 records ~20 MiB (> 16 MiB), and 60 000 > 50 000 lines.
const mode = process.argv[2] || "valid";
const N = Number.parseInt(process.argv[3] || "60000", 10);
const S = "sflood";
const PAD = "x".repeat(300);
const w = (o) => process.stdout.write(JSON.stringify(o) + "\n");

w({ type: "system", subtype: "init", session_id: S, model: "claude-opus-4-8", tools: ["Bash"] });
// Inject an EARLY drift record (before the flood) for the hostile modes. The flood evicts it from the
// tail; the streaming verdict must remember it and stay UNCERTAIN — never evicted into success.
if (mode === "dup-init") w({ type: "system", subtype: "init", session_id: "second", tools: [] });
if (mode === "corrupt") process.stdout.write("{ this is not json\n");
if (mode === "foreign") w({ type: "assistant", session_id: "someoneelse", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } });

for (let i = 0; i < N; i++) {
  w({ type: "user", session_id: S, pad: PAD, message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } });
}
w({ type: "result", subtype: "success", is_error: false, result: "FINAL_FLOOD_ANSWER", total_cost_usd: 0.02, session_id: S, usage: { input_tokens: 5, output_tokens: 3 } });

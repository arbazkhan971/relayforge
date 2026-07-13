#!/usr/bin/env node
// A fake `claude` that emits a WELL-FORMED SUCCESS terminal reporting a tiny cost (total_cost_usd:
// 0.01) but leaves a SURVIVING same-PGID descendant behind — so the transport marks the owned
// process scope UNTRUSTED (scopeTrusted:false → transportOk:false). Used to prove that an UNTRUSTED
// turn NEVER settles its claimed low cost: the full worst-case reservation is retained instead.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

function main() {
  const capture = process.env.ROUTE_CAPTURE;
  if (capture) appendFileSync(capture, `claude|byte0="?"\n`);
  // A child in the SAME process group (no `detached`) that ignores SIGTERM — only SIGKILL removes it.
  spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1e9)"], { stdio: "ignore" });
  const SESSION = "sess-untrusted-1";
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  emit({ type: "system", subtype: "init", session_id: SESSION, tools: ["Task"], model: "claude-opus-4" });
  emit({ type: "assistant", session_id: SESSION, message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
  emit({ type: "result", subtype: "success", is_error: false, result: "done", session_id: SESSION, total_cost_usd: 0.01 });
  process.exit(0);
}

let buf = "";
process.stdin.on("data", (c) => (buf += c));
process.stdin.on("end", main);

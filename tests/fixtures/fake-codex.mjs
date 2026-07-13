#!/usr/bin/env node
// A deterministic fake `codex` binary for the routed-fallback E2E. Ignores argv and emits the PINNED
// Codex 0.144.0 `--json` lifecycle: thread.started → turn.started → item.completed(agent_message) →
// turn.completed(valid usage). Drains stdin fully so the transport marks delivery complete.
import { appendFileSync } from "node:fs";

function main(stdin) {
  const capture = process.env.ROUTE_CAPTURE;
  if (capture) appendFileSync(capture, `codex|byte0=${JSON.stringify(stdin.slice(0, 5))}\n`);
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  emit({ type: "thread.started", thread_id: "thread-1" });
  emit({ type: "turn.started" });
  emit({ type: "item.completed", item: { id: "item-1", type: "agent_message", text: "codex handled it" } });
  emit({ type: "turn.completed", usage: { input_tokens: 3, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 } });
  process.exit(0);
}

let buf = "";
process.stdin.on("data", (c) => (buf += c));
process.stdin.on("end", () => main(buf));

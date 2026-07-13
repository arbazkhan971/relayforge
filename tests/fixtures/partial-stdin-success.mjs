#!/usr/bin/env node
// Reads only ~64 KiB of stdin, then emits a SUCCESS terminal and exits 0 — spoofing a completed turn
// while the full (multi-MiB) prompt was never delivered. The transport MUST reject this as an
// incomplete-stdin transport failure, never accept the success record.
let got = 0;
process.stdin.on("data", (c) => {
  got += c.length;
  if (got >= 65536) {
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "partial-read-ok" }) + "\n");
    process.exit(0);
  }
});
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "full-read-ok" }) + "\n");
  process.exit(0);
});

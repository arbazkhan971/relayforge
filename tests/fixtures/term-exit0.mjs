#!/usr/bin/env node
// A provider that SPOOFS a clean completion when told to stop: it traps SIGTERM and exits 0 (as if
// it had finished successfully). Used to prove that a TIMED-OUT turn is forced to FAILURE even when
// the child exits 0 in response to the deadline's TERM — a deadline a provider can satisfy by
// catching TERM is not a real deadline.
process.on("SIGTERM", () => {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "spoofed-ok" }) + "\n");
  process.exit(0);
});
// Otherwise stay alive well past any short test deadline.
setInterval(() => {}, 1000);

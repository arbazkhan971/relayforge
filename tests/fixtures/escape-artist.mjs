import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

/**
 * A provider that does exactly what a process group CANNOT contain: it leaves one.
 *
 * The grandchild is spawned `detached` (setsid → its own SESSION and its own process GROUP) with its
 * stdio fully closed, and the leader then exits. The grandchild is re-parented to init, its pgid is its
 * own, and `kill(-leaderPgid, …)` — every signal the transport used to have — can never reach it again.
 * `kill(-leaderPgid, 0)` therefore returns ESRCH the moment the leader exits: to the old transport the
 * scope looked EMPTY while the escapee ran on.
 *
 * argv: <pidfile> <mode>
 *   exit — write a canonical Claude success terminal, then exit 0 (the escapee outlives a CLEAN close)
 *   hang — print nothing terminal and never exit (the escapee outlives a TIMEOUT)
 */
const [pidFile, mode = "exit"] = process.argv.slice(2);

/** The REAL process-group id (Node exposes no getpgrp): field 5 of /proc/<pid>/stat, after the comm. */
const PGID_EXPR = 'Number(require("node:fs").readFileSync("/proc/self/stat","utf8").split(") ").pop().split(" ")[2])';
const leaderPgid = Number(readFileSync("/proc/self/stat", "utf8").split(") ").pop().split(" ")[2]);

// The escapee: records its own identity, then sleeps far past any test's patience.
const escapee = spawn(
  process.execPath,
  [
    "-e",
    `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({
       leader: ${process.pid}, leaderPgid: ${leaderPgid},
       escapee: process.pid, escapeePgid: ${PGID_EXPR}
     }));
     setTimeout(() => {}, 600000);`
  ],
  { detached: true, stdio: "ignore" }
);
escapee.unref();

// Do not exit until the escapee has published its identity — otherwise the test cannot name the pid it
// must prove dead, and a flaky race would look like containment. `Atomics.wait` blocks WITHOUT turning the
// event loop and without burning a core (a spin loop here would starve the very child we are waiting for).
const idle = new Int32Array(new SharedArrayBuffer(4));
const deadline = Date.now() + 10_000;
while (!existsSync(pidFile) && Date.now() < deadline) {
  Atomics.wait(idle, 0, 0, 10);
}
if (!existsSync(pidFile)) {
  process.stderr.write("escape-artist: the escapee never published its pid\n");
  process.exit(3);
}
JSON.parse(readFileSync(pidFile, "utf8")); // fail loudly on a torn write rather than in the test

if (mode === "hang") {
  // Never terminate: the turn can only end at its timeout, with the escapee still running.
  setInterval(() => {}, 1000);
} else {
  // A perfectly clean, successful turn — the leader exits 0 having "left nothing behind".
  const session = "11111111-2222-3333-4444-555555555555";
  process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: session })}\n`);
  process.stdout.write(
    `${JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: session,
      is_error: false,
      total_cost_usd: 0.01,
      usage: { input_tokens: 10, output_tokens: 5 }
    })}\n`
  );
  process.exit(0);
}

// A process that IGNORES SIGTERM and spawns a child that also ignores SIGTERM, then idles. Used to
// prove terminateGroupAwait escalates TERM→KILL and waits for the whole process GROUP (including a
// TERM-ignoring descendant) to actually exit before returning. Writes its own + child pid to the
// file given as argv[2] so the test can verify both are gone afterwards.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

process.on("SIGTERM", () => {}); // ignore TERM

const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1e9)"], {
  stdio: "ignore"
});

writeFileSync(process.argv[2], JSON.stringify({ parent: process.pid, child: child.pid }));
setInterval(() => {}, 1e9); // idle forever until KILLed

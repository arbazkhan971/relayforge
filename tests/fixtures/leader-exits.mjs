// The group LEADER spawns a same-PGID child that ignores SIGTERM, records both pids, then the
// LEADER EXITS 0 immediately — leaving a surviving descendant in its process group. Used to prove
// terminateGroupAwait tears down the whole GROUP even after the leader has already exited (a leader
// that is gone from `children` must not cause finalization to forget the still-live group).
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

// Child in the SAME process group (no `detached`), ignoring TERM so only KILL removes it.
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1e9)"], {
  stdio: "ignore"
});
writeFileSync(process.argv[2], JSON.stringify({ leader: process.pid, child: child.pid }));
// The leader exits right away; the child lives on in the leader's pgid.
process.exit(0);

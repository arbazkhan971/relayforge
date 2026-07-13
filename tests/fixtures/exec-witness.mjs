#!/usr/bin/env node
// A provider whose only job is to be UNDENIABLE EVIDENCE that it EXECUTED — and to record what the run
// had already made durable at the moment it did.
//
//   argv[2]  marker path: written IMMEDIATELY, before anything else. Its existence means "a provider ran".
//   argv[3]  the run's scope journal (.loop_scopes): its contents are copied INTO the marker, so a test
//            can prove the journal was already on disk when the provider began — the exact ordering the
//            launch handshake exists to enforce.
//   argv[4]  linger ms: stay alive a while, so a provider that was NOT supposed to run cannot hide by
//            exiting before the test looks for it.
import { readFileSync, writeFileSync } from "node:fs";

const [, , marker, journalPath, lingerMs] = process.argv;

let journal = "";
try {
  journal = readFileSync(journalPath, "utf8");
} catch {
  journal = ""; // no journal at all — which is itself the thing the test is looking for
}
writeFileSync(marker, JSON.stringify({ pid: process.pid, journal }), { mode: 0o600 });

setTimeout(() => {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ran" }) + "\n");
  process.exit(0);
}, Number(lingerMs ?? 0));

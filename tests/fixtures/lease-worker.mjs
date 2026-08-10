// A single lease contender used by the 50-process stress test. It announces readiness, waits on a
// shared barrier so every contender starts racing at ~the same instant, then attempts to acquire
// the run lease. On success it drops a unique marker file (one per believed holder) and HOLDS the
// lease alive until the parent writes a `stop` file — so every other contender races against a
// LIVE holder, which is exactly the condition that must yield a single owner (no split brain).
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireRunLease } from "../../src/runtime.js";

const [, , runDir, resultsDir, barrier] = process.argv;
const stop = join(resultsDir, "stop");

// Synchronous sleep that does NOT peg the CPU (important with 50 concurrent processes).
const shared = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  Atomics.wait(shared, 0, 0, ms);
}
function spinUntil(predicate, timeoutMs) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) return false;
    sleepSync(5);
  }
  return true;
}

// Announce readiness so the parent can open the barrier only once ALL contenders have arrived.
writeFileSync(join(resultsDir, `ready-${process.pid}`), "1");
if (!spinUntil(() => existsSync(barrier), 30_000)) process.exit(9);

try {
  const lease = acquireRunLease(runDir);
  // Record that THIS process acquired — one marker per believed holder.
  writeFileSync(join(resultsDir, `holder-${process.pid}`), lease.nonce);
  // Hold the lease ALIVE until the parent signals stop (or a safety timeout).
  spinUntil(() => existsSync(stop), 20_000);
  process.exit(0);
} catch {
  process.exit(3); // refused (someone else holds it) — the expected outcome for all but one
}

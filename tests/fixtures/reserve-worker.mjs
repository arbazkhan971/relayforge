// One contender in the 64-process reservation barrier. It announces readiness, spins on a shared
// barrier file so every contender attempts its reservation at ~the same instant, then opens the REAL
// run-scoped ledger handle and makes a REAL identity-bound reservation.
//
// The audit released 64 of these reserving $0.75 under a $1 budget and observed TWO winners, 45
// exceptions, and a corrupt journal — read/check/append were three separate opens with the budget
// decision made in the gap. The required outcome is exactly one `true`, 63 `false`, zero exceptions.
//
// This now also exercises the concurrent INIT race: all 64 processes open the same board with the same
// run nonce, so exactly one may publish the ledger manifest (epoch + genesis + expected inodes) and the
// other 63 must adopt that exact generation rather than minting their own.
//
// Exit codes are the result channel: 0 = reserved, 1 = refused (over budget), 3 = threw.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openLedger } from "../../src/ledger.js";

const [, , boardDir, resultsDir, barrier, callId, worstCase, budget, runNonce] = process.argv;

const sha = (s) => createHash("sha256").update(s).digest("hex");
const shared = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  Atomics.wait(shared, 0, 0, ms);
}

const bind = {
  runNonce,
  callNonce: randomBytes(16).toString("hex"),
  callId,
  reservationId: randomBytes(16).toString("hex"),
  routeEpoch: 0,
  provider: "claude",
  model: "opus",
  attempt: 0,
  intentSha256: sha(`intent:${callId}`),
  stdinSha256: sha(`stdin:${callId}`),
  stdinBytes: 12
};

let ledger;
try {
  // Open BEFORE the barrier, so the concurrent INIT race is itself part of the contention.
  ledger = openLedger({ dir: boardDir, runNonce });
} catch (error) {
  writeFileSync(join(resultsDir, `threw-${process.pid}`), `open: ${String(error?.message ?? error)}`);
  process.exit(3);
}

writeFileSync(join(resultsDir, `ready-${process.pid}`), "1");
const started = Date.now();
while (!existsSync(barrier)) {
  if (Date.now() - started > 30_000) process.exit(9);
  sleepSync(2);
}

try {
  const ok = ledger.reserve(bind, Number(worstCase), Number(budget));
  writeFileSync(join(resultsDir, `${ok ? "won" : "lost"}-${process.pid}`), callId);
  process.exit(ok ? 0 : 1);
} catch (error) {
  writeFileSync(join(resultsDir, `threw-${process.pid}`), String(error?.message ?? error));
  process.exit(3);
}

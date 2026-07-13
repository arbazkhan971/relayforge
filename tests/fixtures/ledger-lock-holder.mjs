// Takes the REAL exclusive kernel lock on the REAL ledger fd, reports HELD, then hangs forever so the
// test can SIGKILL it mid-transaction.
//
// The audit wedged the old ledger exactly here: its lock was an ADJACENT FILE, so a holder killed after
// creating it (or after creating the `.lock.break` breaker) left an artifact nobody could clean up — a
// private repro timed out (status 124) with the lock still in place. A kernel flock lives on the open
// file description: when this process dies, the kernel releases it. There is no artifact to strand.
//
// "Hangs forever" is what the LOCK test needs and what stranded a real process: this fixture is `detached`
// (it must lead its own group, since `tsx` runs it in a grandchild), so when a run is interrupted — the
// Vitest worker SIGKILLed, the terminal closed — nothing ever reaches the test's own kill, the fixture is
// reparented to init, and it holds a board's lock indefinitely. Teardown cannot fix that: teardown is
// exactly what does not run. So the LIFETIME IS BOUND HERE, in the only process that is guaranteed to
// still be alive: it lives only as long as the OWNER pid it was launched for, which it probes itself.
import { openSync } from "node:fs";
import { join } from "node:path";
import { flockExclusive } from "../../src/flock.js";

const [, , boardDir, , ownerArg] = process.argv;

const ownerPid = Number(ownerArg);
if (!Number.isInteger(ownerPid) || ownerPid <= 1) {
  process.stderr.write(`usage: ledger-lock-holder <boardDir> <runNonce> <ownerPid>; got owner ${ownerArg}\n`);
  process.exit(2); // fail closed: a holder with no owner to outlive is exactly the process that strands
}

const OWNER_GONE = 3;
const DEADLINE_HIT = 4;
const PROBE_MS = 250;
/** A last-resort bound. The owner probe is the real mechanism; this only covers the residual case where the
 *  kernel recycles the owner's pid onto some unrelated long-lived process. Orders of magnitude above the
 *  sub-second time any test actually holds the lock, so it can never race a passing test. */
const MAX_LIFETIME_MS = 120_000;

/** Signal 0: liveness, no delivery. ESRCH is the only "gone" — EPERM means it EXISTS and is simply not
 *  ours to signal, which must never be read as death. */
const ownerAlive = () => {
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
};

if (!ownerAlive()) process.exit(OWNER_GONE); // the run died while we were still booting

// Open the ledger leaf exactly as a transaction does, and take the same exclusive lock on it.
const fd = openSync(join(boardDir, "reservations.jsonl"), "r+");
flockExclusive(fd, 10_000);

process.stdout.write("HELD\n");

// Hang holding the lock — but only for as long as the run that asked for it exists. The parent SIGKILLs
// us in the happy path and nothing here ever runs a cleanup path; if it never gets the chance, these two
// timers are the cleanup path, and `process.exit` closes the fd, which is what releases the kernel lock.
setInterval(() => {
  if (!ownerAlive()) process.exit(OWNER_GONE);
}, PROBE_MS);
setTimeout(() => process.exit(DEADLINE_HIT), MAX_LIFETIME_MS);

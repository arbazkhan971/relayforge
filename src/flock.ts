import { spawnSync } from "node:child_process";
import { closeSync, constants as fsConstants, lstatSync, openSync, realpathSync, statSync, unlinkSync } from "node:fs";

/**
 * A KERNEL lock on the exact ledger file description (wave-8d independent audit, B5).
 *
 * What was there: an adjacent `.lock` file created with `O_EXCL`, plus a stale-holder protocol built on
 * PID / `/proc` start-time / mtime and a `.lock.break` breaker artifact. The audit wedged it: a planted
 * empty/malformed lock file was never recoverable, and a process killed after creating `.lock.break`
 * left a permanent breaker artifact — a private repro timed out (status 124) with the lock still held.
 * Every one of those failure modes exists because the lock is an ARTIFACT that outlives its holder.
 *
 * A kernel `flock` cannot leak: it lives on the OPEN FILE DESCRIPTION, so process death (crash, KILL,
 * OOM) closes the fd and the kernel drops the lock. There is nothing to unlink, no stale window, no PID
 * to misattribute after reuse, and no adjacent file for an attacker to plant.
 *
 * Node has no `flock(2)` binding, so we borrow util-linux `flock(1)`: the child inherits OUR fd as fd 3
 * and calls `flock(3, LOCK_EX)`. Because a dup'd fd shares the open file description, the lock is placed
 * on OUR description — and SURVIVES the helper's exit, because our fd keeps that description open. This
 * is the documented `exec 3>file; flock -x 3` idiom.
 *
 * We do not take that on faith. `probeFlock()` proves survival, conflict, and release with real
 * syscalls on the real host before any ledger is opened; if any leg of the probe disagrees, the ledger
 * fails closed rather than running on a lock we cannot prove.
 */

const HELPER = "/usr/bin/flock";

export class FlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlockError";
  }
}

let verifiedHelper: string | undefined;

/**
 * Verify the helper binary itself: an ABSOLUTE path with no symlinked component, a regular file, owned
 * by root, not writable by group/other, executable, and identifying as util-linux. A helper another
 * account can rewrite is a helper that can hand out a lock it never took.
 */
function verifyHelper(): string {
  if (verifiedHelper !== undefined) return verifiedHelper;
  let real: string;
  try {
    real = realpathSync(HELPER);
  } catch (error) {
    throw new FlockError(`the ledger requires the util-linux flock helper at ${HELPER}, which is unreadable (${(error as Error).message})`);
  }
  if (real !== HELPER) throw new FlockError(`${HELPER} resolves to ${real} (a symlinked helper is not trusted)`);
  const st = lstatSync(real);
  if (!st.isFile()) throw new FlockError(`${HELPER} is not a regular file`);
  if (st.uid !== 0) throw new FlockError(`${HELPER} is owned by uid ${st.uid}, not root (refusing an untrusted lock helper)`);
  if ((st.mode & 0o022) !== 0) throw new FlockError(`${HELPER} is group/other writable (mode ${(st.mode & 0o777).toString(8)}; refusing)`);
  if ((st.mode & 0o111) === 0) throw new FlockError(`${HELPER} is not executable`);
  const v = spawnSync(HELPER, ["--version"], { encoding: "utf8", timeout: 5_000 });
  if (v.status !== 0 || !/util-linux/i.test(v.stdout ?? "")) {
    throw new FlockError(`${HELPER} did not identify as util-linux (got ${JSON.stringify((v.stdout ?? "").trim())})`);
  }
  verifiedHelper = real;
  return real;
}

/** Take an exclusive kernel lock on `fd`, bounded by `timeoutMs`. Released by closing `fd`. */
export function flockExclusive(fd: number, timeoutMs: number): void {
  takeLock(fd, "-x", timeoutMs);
}

/** Take a SHARED kernel lock on `fd` (authoritative readers), bounded by `timeoutMs`. */
export function flockShared(fd: number, timeoutMs: number): void {
  takeLock(fd, "-s", timeoutMs);
}

function takeLock(fd: number, mode: "-x" | "-s", timeoutMs: number): void {
  const helper = verifyHelper();
  const seconds = Math.max(0.1, timeoutMs / 1000).toFixed(2);
  const r = spawnSync(helper, [mode, "-w", seconds, "3"], {
    // fd 3 in the child is a DUP of our fd → the same open file description → the lock the helper takes
    // is OURS, and it outlives the helper because our fd keeps that description open.
    stdio: ["ignore", "ignore", "pipe", fd],
    timeout: timeoutMs + 5_000
  });
  if (r.status === 0) return;
  if (r.error) throw new FlockError(`ledger lock helper failed to run: ${r.error.message}`);
  if (r.status === 1) throw new FlockError(`ledger lock timeout after ${seconds}s (another holder has the ledger; no artifact to clean up)`);
  throw new FlockError(`ledger lock helper exited ${String(r.status)}${r.signal ? ` (signal ${r.signal})` : ""}: ${(r.stderr ?? "").toString().trim()}`);
}

let probed = false;

/**
 * Prove the three semantics the ledger depends on, with real syscalls on this host, before trusting
 * any lock. Runs once per process; any deviation throws and the ledger fails closed.
 *
 *   survival — the lock the helper took on our inherited fd is still held AFTER the helper exits
 *   conflict — a separate process (a separate open file description) cannot take it while we hold it
 *   release  — closing our fd releases it, so a crashed holder can never wedge the ledger
 */
export function probeFlock(probePath: string): void {
  if (probed) return;
  const helper = verifyHelper();
  let fd: number | undefined;
  try {
    fd = openSync(probePath, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    // 1. Acquire through the helper, which then EXITS.
    flockExclusive(fd, 5_000);
    // 2. SURVIVAL + CONFLICT: a foreign process opens the same path (a DIFFERENT open file description)
    //    and must fail immediately. If the lock had died with the helper, this would succeed.
    const foreign = spawnSync(helper, ["-x", "-w", "0", probePath, "-c", "true"], { timeout: 10_000 });
    if (foreign.status === 0) {
      throw new FlockError("flock probe failed: a foreign process acquired the lock we hold (the lock did not survive the helper's exit)");
    }
    if (foreign.status !== 1) {
      throw new FlockError(`flock probe failed: the conflict check exited ${String(foreign.status)} instead of 1 (semantics not proven)`);
    }
    // 3. RELEASE: closing our fd (the last descriptor on that description) must drop the lock.
    closeSync(fd);
    fd = undefined;
    const after = spawnSync(helper, ["-x", "-w", "0", probePath, "-c", "true"], { timeout: 10_000 });
    if (after.status !== 0) {
      throw new FlockError(`flock probe failed: the lock was NOT released when its last fd closed (exit ${String(after.status)}) — a crashed holder could wedge the ledger forever`);
    }
    probed = true;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* the probe already failed; the fd is going away with the process */
      }
    }
    try {
      if (statSync(probePath, { throwIfNoEntry: false })) unlinkSync(probePath);
    } catch {
      /* best effort — the probe file is disposable */
    }
  }
}

/** Test seam: force the next `probeFlock()` to run again (the probe is otherwise once-per-process). */
export function resetFlockProbeForTests(): void {
  probed = false;
  verifiedHelper = undefined;
}

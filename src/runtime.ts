import { closeSync, constants as fsConstants, existsSync, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Confine `target` strictly within `base` and prove NO path component from `base` down to `target`
 * is a symlink. `base` is TRUSTED (parent-created); every component below it must be a real dir/file
 * we own, never a symlink an attacker could plant to redirect writes (a transcript/journal/worktree)
 * outside the run's private tree. Throws (fail closed) on escape (`..`/absolute), or a symlinked
 * component. lstat (never stat) is used so a symlink is detected, never transparently followed.
 */
export function assertConfinedRealPath(base: string, target: string): string {
  const baseAbs = resolve(base);
  const targetAbs = resolve(target);
  const rel = relative(baseAbs, targetAbs);
  if (rel === "") return targetAbs; // target IS base
  if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(baseAbs, rel) !== targetAbs) {
    throw new Error(`path confinement violation: ${targetAbs} escapes ${baseAbs}`);
  }
  // Walk each component BELOW base. Base itself is trusted; every descendant that exists must be a
  // real (non-symlink) entry. A not-yet-created leaf is fine — it will be created O_EXCL|O_NOFOLLOW.
  let cur = baseAbs;
  for (const part of rel.split(sep)) {
    cur = resolve(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      break; // component does not exist yet (and neither can anything below it) — nothing to follow
    }
    if (st.isSymbolicLink()) {
      throw new Error(`path confinement violation: symlinked component ${cur} under ${baseAbs}`);
    }
  }
  return targetAbs;
}

/** Whether the pinned-dirfd (openat-equivalent) confinement strategy is usable on this host. */
function procFdAvailable(): boolean {
  return process.platform === "linux" && existsSync("/proc/self/fd");
}

/**
 * Create a NEW file exclusively at `base/subdir/leaf`, guaranteeing that neither `subdir` nor `leaf`
 * is (or becomes) a symlink that redirects the write OUTSIDE `base` — RACE-FREE.
 *
 * A `lstat`-then-`open` check is TOCTOU-vulnerable: an attacker can swap the checked `subdir` for a
 * symlink between the check and the open, redirecting the file outside `base`. Instead we pin each
 * component below the (trusted, parent-created) `base` with an openat-equivalent using `/proc/self/fd`:
 *   1. open `base` as a directory fd;
 *   2. `mkdir` + open `subdir` THROUGH the base fd with `O_NOFOLLOW | O_DIRECTORY` — a symlinked
 *      `subdir` fails here, and once opened the fd is pinned to the real inode;
 *   3. create `leaf` THROUGH the pinned `subdir` fd with `O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW`.
 * Because steps 2–3 traverse fds (not names), swapping `subdir` for a symlink after step 2 cannot
 * redirect step 3. `subdir`/`leaf` must be single, safe path components. Fails closed (throws) when
 * `/proc/self/fd` is unavailable — the caller then treats the turn as UNCERTAIN rather than racy.
 */
export function openConfinedFileExclusive(base: string, subdir: string, leaf: string, mode = 0o600): { fd: number; path: string } {
  for (const comp of [subdir, leaf]) {
    if (!comp || comp === "." || comp === ".." || comp.includes("/") || comp.includes(sep) || comp.includes("\0")) {
      throw new Error(`unsafe path component: ${JSON.stringify(comp)}`);
    }
  }
  if (!procFdAvailable()) {
    throw new Error("race-free confined file creation requires /proc/self/fd (Linux); refusing a TOCTOU-vulnerable fallback");
  }
  const baseAbs = resolve(base);
  const baseFd = openSync(baseAbs, fsConstants.O_DIRECTORY);
  try {
    const subPath = `/proc/self/fd/${baseFd}/${subdir}`;
    try {
      mkdirSync(subPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // O_NOFOLLOW rejects a symlinked `subdir`; O_DIRECTORY rejects a non-directory. The fd now pins
    // the REAL directory inode regardless of any later rename/swap of the `subdir` name.
    const subFd = openSync(subPath, fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    try {
      fchmodSync(subFd, 0o700); // enforce 0700 on the pinned real directory
      const fd = openSync(`/proc/self/fd/${subFd}/${leaf}`, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, mode);
      return { fd, path: resolve(baseAbs, subdir, leaf) };
    } finally {
      closeSync(subFd);
    }
  } finally {
    closeSync(baseFd);
  }
}

/**
 * Parent-owned run lifecycle primitives: atomic state writes, an exclusive run lease, and a
 * cancellation flag. All of these live under the run directory and are written ONLY by the
 * parent orchestrator/CLI — never by an agent.
 */

/** Write a file atomically (temp file + rename) so a crash can never leave torn state. */
export function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}-${counter++}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}
let counter = 0;

// ---------------------------------------------------------------------------------------------
// PRIVATE STATE FILES — a pre-existing path is VERIFIED or REJECTED, never adopted
//
// `existsSync` + `readFileSync` is not a safe way to read run state: it FOLLOWS a symlink, cannot
// tell "absent" from "unreadable", and never looks at the mode or the owner. Every authoritative
// run artifact (route epoch, provider health, board journals, role prompt) is read through
// `readStateFile` and written through `writeStateFileDurable` instead, so a planted symlink, a
// directory/FIFO, a hardlink alias, a group/other-accessible mode, or another account's file is a
// TYPED REFUSAL rather than content we silently trust.
// ---------------------------------------------------------------------------------------------

/** A pre-existing state path exists but is not something we may read or write. Never recoverable by
 *  overwriting it: the caller fails closed and an operator inspects what is actually there. */
export class UnsafeStateFileError extends Error {
  constructor(
    readonly path: string,
    readonly why: string
  ) {
    super(`refusing to use ${path}: ${why}`);
    this.name = "UnsafeStateFileError";
  }
}

export type StateFileRead = { kind: "absent" } | { kind: "present"; data: Buffer };

/** The owner check is only meaningful where the process has a uid (POSIX). */
function selfUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/**
 * Read a private run-state file, distinguishing ABSENT from every unsafe/unreadable shape.
 *
 *  - missing                          → `{kind:"absent"}` (the only "initial state" answer)
 *  - symlink                          → UnsafeStateFileError (O_NOFOLLOW ⇒ ELOOP/EMLINK)
 *  - directory / FIFO / device / etc. → UnsafeStateFileError (not a regular file)
 *  - hardlink alias (nlink > 1)       → UnsafeStateFileError (another name mutates our state)
 *  - group/other accessible mode      → UnsafeStateFileError (permissive)
 *  - owned by another uid             → UnsafeStateFileError (wrong owner)
 *  - unreadable (EACCES/EIO/…)        → UnsafeStateFileError (NEVER laundered into "absent")
 */
export function readStateFile(path: string): StateFileRead {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "absent" };
    if (code === "ELOOP" || code === "EMLINK") throw new UnsafeStateFileError(path, "it is a symlink");
    throw new UnsafeStateFileError(path, `it exists but could not be opened (${code ?? "unknown error"})`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new UnsafeStateFileError(path, "it is not a regular file");
    if (st.nlink !== 1) throw new UnsafeStateFileError(path, `it has ${st.nlink} hard links (an alias could mutate it)`);
    if ((st.mode & 0o077) !== 0) throw new UnsafeStateFileError(path, `it is group/other accessible (mode ${(st.mode & 0o7777).toString(8)})`);
    const uid = selfUid();
    if (uid !== undefined && st.uid !== uid) throw new UnsafeStateFileError(path, `it is owned by uid ${st.uid}, not ${uid}`);
    const data = Buffer.alloc(st.size);
    let got = 0;
    while (got < data.length) {
      let n: number;
      try {
        n = readSync(fd, data, got, data.length - got, got);
      } catch (error) {
        throw new UnsafeStateFileError(path, `it could not be read (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`);
      }
      if (n <= 0) break;
      got += n;
    }
    return { kind: "present", data: data.subarray(0, got) };
  } finally {
    closeSync(fd);
  }
}

/**
 * Publish a private state file DURABLY and atomically: an O_EXCL|O_NOFOLLOW 0600 temp file, written
 * whole, fsynced, renamed over the target, then the DIRECTORY fsynced. A crash leaves either the old
 * content or the new one — never a torn or half-visible state. Unlike `atomicWrite`, durability is
 * PROVEN (both fsyncs propagate their errors) rather than assumed: an unsynced rename can be lost on
 * power failure, which for a monotonic generation counter means silently going BACKWARDS.
 */
export function writeStateFileDurable(path: string, content: string): void {
  const dir = dirname(path);
  const tmp = `${path}.tmp-${process.pid}-${counter++}-${randomBytes(6).toString("hex")}`;
  const body = Buffer.from(content, "utf8");
  let published = false;
  try {
    const fd = openSync(tmp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
    try {
      let off = 0;
      while (off < body.length) {
        const n = writeSync(fd, body, off, body.length - off, off);
        if (n <= 0) throw new Error(`write to ${tmp} made no progress`);
        off += n;
      }
      fsyncSync(fd); // the BYTES are durable before the name is published
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path); // atomic; replaces the name itself (a symlink there is not followed)
    published = true;
  } finally {
    if (!published) {
      try {
        unlinkSync(tmp);
      } catch {
        // nothing to clean up
      }
    }
  }
  const dfd = openSync(dir, fsConstants.O_DIRECTORY);
  try {
    fsyncSync(dfd); // the NAME is durable — a lost rename would silently roll state back
  } finally {
    closeSync(dfd);
  }
}

/** fsync a file and its parent directory so a durable write survives a crash/power loss. */
function fsyncPath(path: string): void {
  try {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // best-effort
  }
}

export function fsyncFileAndDir(path: string): void {
  fsyncPath(path);
  try {
    const dfd = openSync(dirname(path), "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    // directory fsync is best-effort (not supported on every FS)
  }
}

/**
 * Create a NEW file exclusively (O_CREAT | O_EXCL) with mode 0600, fsync it and its parent
 * directory, and return true. Throws `EEXIST` (not swallowed) if the file already exists — the
 * caller decides how to treat an existing file. Used for immutable authoritative artifacts (the
 * run manifest) that must never be silently overwritten.
 */
export function createExclusive(path: string, content: string, mode = 0o600): void {
  const fd = openSync(path, "wx", mode); // O_CREAT | O_EXCL — throws EEXIST if present
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncFileAndDir(path);
}

function processAlive(pid: number): boolean {
  if (!pid || Number.isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH → gone; EPERM → alive but not ours.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type RunLease = { path: string; nonce: string; release: () => void };

export function leasePath(runDir: string): string {
  return resolve(runDir, ".loop.lease");
}

/**
 * Read the lease holder. Returns undefined if the file is missing OR its content is not a valid
 * (positive-integer pid). Because the lease is published atomically already-populated (see
 * `acquireRunLease`'s link-based create), an unreadable/partial lease is NEVER observed for a
 * validly created lease — so undefined here means genuinely gone or corrupt, never mid-create.
 */
function readLease(path: string): { pid: number; nonce: string } | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
  const parts = raw.split(/\s+/);
  const pid = Number(parts[0]);
  if (!Number.isInteger(pid) || pid <= 0) return undefined; // corrupt / not a real holder
  return { pid, nonce: parts[1] ?? "" };
}

/**
 * Break a STALE lease (one whose holder process is dead) through a single-winner "breaker gate".
 *
 * The wave-2 bug was `read stale → unlink → create`: with N concurrent contenders each could read
 * the same stale lease, then each unlink — deleting whichever successor had already recreated it —
 * producing multiple simultaneous "holders" (a split brain). The fix removes the delete race:
 *
 *  - Exactly one contender at a time may enter the critical section, gated by an `O_EXCL` create of
 *    a `.breaking` file (atomic — only one winner).
 *  - Inside, the breaker RE-READS the lease. It removes it ONLY if it is still absent-or-dead. If a
 *    successor has meanwhile taken the lease LIVE, the breaker aborts without deleting it.
 *  - A live successor can only have been created while the lease file was ABSENT — and it cannot be
 *    absent while the (present) stale file blocks every `O_EXCL` create — so the breaker never
 *    deletes a live successor.
 *
 * Returns true if a stale lease was removed (or was already gone). Throws `EEXIST`-style contention
 * if another process holds the breaker gate, or if the lease became live.
 */
function breakStaleLease(path: string): boolean {
  const gate = `${path}.breaking`;
  let gfd: number;
  try {
    gfd = openSync(gate, "wx"); // O_CREAT | O_EXCL — exactly one breaker at a time
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("lease reclaim already in progress by another process");
    }
    throw error;
  }
  try {
    const cur = readLease(path);
    if (!cur) return true; // already removed by a prior breaker
    if (processAlive(cur.pid)) {
      throw new Error(`run became active under pid ${cur.pid}`);
    }
    // The lease is present and its holder is dead. Because the file is present, no successor could
    // have created a live lease (their O_EXCL create would have failed). Safe to remove exactly it.
    try {
      unlinkSync(path);
    } catch {
      // another breaker removed it between our read and unlink — fine
    }
    return true;
  } finally {
    try {
      unlinkSync(gate);
    } catch {
      // best-effort
    }
  }
}

/**
 * Acquire an EXCLUSIVE lease for a run. Creation is atomic via `O_EXCL`, so among any number of
 * concurrent contenders over a FRESH lease exactly one wins. A random nonce is written alongside
 * the pid so `release()` only ever removes OUR lease, never one a successor took over. A STALE
 * lease (dead holder) is reclaimed through the single-winner breaker gate above — never a
 * read/unlink race that could delete a successor.
 */
export function acquireRunLease(runDir: string): RunLease {
  const path = leasePath(runDir);
  const nonce = randomBytes(8).toString("hex");
  const payload = `${process.pid} ${nonce} ${new Date().toISOString()}`;

  // Publish the lease ATOMICALLY already-populated: write the full payload to a private temp file,
  // then hard-link it into place. `link()` is atomic and fails with EEXIST if the lease exists, so
  // the lease is NEVER observable as an empty/partial file (the create→write window that a plain
  // `O_EXCL` open + later write would expose — which a racing contender could misread as "stale").
  const tmp = `${path}.mk.${nonce}`;
  const tryCreate = (): boolean => {
    try {
      const fd = openSync(tmp, "wx", 0o600);
      try {
        writeSync(fd, payload);
      } finally {
        closeSync(fd);
      }
    } catch {
      return false; // temp collision (nonce reused) — vanishingly unlikely; treat as lost race
    }
    try {
      linkSync(tmp, path); // atomic publish; EEXIST if a lease already exists
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        // best-effort
      }
    }
  };

  if (!tryCreate()) {
    const holder = readLease(path);
    if (!holder) {
      // The lease exists but its holder is unreadable/corrupt — we CANNOT prove it is dead, so we
      // never auto-break it (that would risk a split brain). Fail closed; an operator can clear it.
      throw new Error("Run lease exists but is unreadable/corrupt. Remove it explicitly (`loop stop <run>`), then retry.");
    }
    if (processAlive(holder.pid)) {
      throw new Error(
        `Run is already active under pid ${holder.pid}. Stop it with \`loop stop <run>\` before starting again.`
      );
    }
    // Stale lease from a dead process — reclaim it through the single-winner breaker gate, then
    // race everyone for the create. Only one contender can break, and only the link winner holds.
    breakStaleLease(path);
    if (!tryCreate()) {
      const raced = readLease(path);
      if (raced && processAlive(raced.pid)) {
        throw new Error(`Run is already active under pid ${raced.pid}. Stop it with \`loop stop <run>\` before starting again.`);
      }
      throw new Error(`Run lease is contended (held by pid ${raced?.pid ?? "?"}). Try again.`);
    }
  }

  let released = false;
  return {
    path,
    nonce,
    release: () => {
      if (released) return;
      released = true;
      try {
        // Only ever remove OUR exact lease (pid + nonce match) — never a successor's.
        const cur = readLease(path);
        if (cur && cur.pid === process.pid && cur.nonce === nonce) unlinkSync(path);
      } catch {
        // best-effort
      }
    }
  };
}

export function cancelPath(runDir: string): string {
  return resolve(runDir, ".loop.cancel");
}

/** Parent (or `loop stop`) requests cancellation of a run. */
export function requestCancel(runDir: string, reason = "cancelled by user"): void {
  try {
    writeFileSync(cancelPath(runDir), `${new Date().toISOString()} ${reason}`);
  } catch {
    // best-effort
  }
}

export function isCancelled(runDir: string): boolean {
  return existsSync(cancelPath(runDir));
}

export function cancelReason(runDir: string): string | undefined {
  try {
    return readFileSync(cancelPath(runDir), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export function clearCancel(runDir: string): void {
  try {
    unlinkSync(cancelPath(runDir));
  } catch {
    // already gone
  }
}

/**
 * Injectable process-scope signalling capability. Production binds the real OS syscalls; tests inject
 * a FAKE so that no real signal, probe, or timer ever crosses a test boundary (the wave-8b2 hazard was
 * a monkey-patched `process.kill` restored to the real syscall while a delayed KILL could still fire).
 *
 * `signalGroup` MUST address only the process GROUP `-pid`, NEVER a positive PID — see the reuse
 * hazard documented on `signalOwnedGroup`. `groupAlive`, `sleep`, and `now` let a test drive the whole
 * TERM→grace→KILL sequence deterministically with a fake clock and never touch a real process.
 */
export interface ProcessScopeCaps {
  /** Deliver `sig` to the whole owned group `-pid` (never the positive PID). Swallows all errors. */
  signalGroup(pid: number, sig: NodeJS.Signals): void;
  /** Whether ANY process in the group `pid` is still alive (EPERM = alive-but-not-ours ⇒ true). */
  groupAlive(pid: number): boolean;
  /** Awaitable delay — the ONLY timer the teardown uses; it is awaited, never fire-and-forget. */
  sleep(ms: number): Promise<void>;
  /** Monotonic-enough clock for deadline math (fakeable in tests). */
  now(): number;
}

/**
 * Signal ONLY the process GROUP `-pid` — NEVER the positive PID.
 *
 * The wave-8b hazard: falling back to `process.kill(pid, sig)` after `process.kill(-pid, sig)` throws
 * is unsafe. `-pid` throwing ESRCH means the whole group is already gone; the positive PID may since
 * have been REUSED by an unrelated process, so signaling it could kill an innocent bystander. We
 * therefore address the group only and swallow ESRCH (gone) / any other error (e.g. EPERM =
 * alive-but-not-ours) without ever touching a bare PID.
 */
function signalOwnedGroup(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig);
  } catch {
    // ESRCH → the group is already gone; anything else → not ours to signal. Never fall back to +pid.
  }
}

/** Whether ANY process in the group `pid` (the detached leader + its descendants) is still alive.
 *  Exported as `isProcessGroupAlive` so the transport can prove an owned scope is EMPTY before it
 *  resolves a turn as trusted — a same-PGID descendant that outlives the leader must not be missed. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"; // alive but not ours
  }
}

/** The production capability: real signals, real group probing, real (awaited) timers, wall clock. */
export const realScopeCaps: ProcessScopeCaps = {
  signalGroup: signalOwnedGroup,
  groupAlive,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now()
};

/**
 * Whether the owned process GROUP `pid` still contains ANY live process (the detached leader OR any
 * same-PGID descendant). Used by the transport to prove scope emptiness on a NORMAL child close:
 * a leader can exit 0 while a descendant it spawned lives on in the same pgid, so a clean leader
 * close is NOT proof the provider left no live scope. EPERM (alive but reparented/not ours) counts
 * as alive — we fail closed. This addresses only the PGID-reachable scope; a descendant that
 * escapes the group (setsid/double-fork) is a containment-layer concern, not something this proves.
 */
export function isProcessGroupAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  return groupAlive(pid);
}

/**
 * Terminate a child process GROUP and AWAIT its complete teardown: SIGTERM, wait up to `graceMs`
 * for the whole group (including any TERM-ignoring descendants) to exit, then SIGKILL and wait for
 * the group to actually disappear.
 *
 * Returns TRUE only when the whole group is PROVEN gone, and FALSE when a process in the group may
 * still be alive after the awaited TERM→KILL (deadline exceeded, or a signal raised EPERM meaning
 * the group is alive but not ours). The caller MUST treat `false` as a teardown FAILURE: preserve
 * evidence and keep the lease / enter operator recovery rather than cleaning up over a live group.
 */
export async function terminateGroupAwait(
  pid: number | undefined,
  graceMs = 5000,
  caps: ProcessScopeCaps = realScopeCaps
): Promise<boolean> {
  if (!pid) return true;
  // Signal ONLY `-pid` (the group), NEVER the positive PID — see `signalOwnedGroup`. After ESRCH the
  // group is gone and the bare PID may have been reused, so touching it could kill a bystander. Every
  // timer here is AWAITED via `caps.sleep`; nothing is scheduled to fire after this function resolves.
  if (!caps.groupAlive(pid)) return true;
  caps.signalGroup(pid, "SIGTERM");
  const graceDeadline = caps.now() + graceMs;
  while (caps.groupAlive(pid) && caps.now() < graceDeadline) await caps.sleep(50);
  if (caps.groupAlive(pid)) {
    caps.signalGroup(pid, "SIGKILL");
    const killDeadline = caps.now() + Math.max(2000, graceMs);
    while (caps.groupAlive(pid) && caps.now() < killDeadline) await caps.sleep(25);
  }
  // Proven gone only when a probe of the group now fails with ESRCH (not EPERM = alive-but-not-ours).
  return !caps.groupAlive(pid);
}

/**
 * Tracked, DEDUPLICATED per-scope termination. There is exactly ONE in-flight TERM→grace→KILL
 * sequence per live PGID: every initiator (turn timeout, cancellation poll, SIGINT/SIGTERM handler,
 * stdout-quota kill, and finalization) shares and AWAITS the same promise, so repeated cancellation
 * polls can never STACK TERM/KILL sequences on the same group.
 *
 * This replaces the removed fire-and-forget `terminateGroup(pid, grace)` whose UNOWNED
 * `setTimeout(SIGKILL)` timer could deliver a real KILL to a since-reused PGID long after the owning
 * operation returned (and, in the old test, after a mocked `process.kill` was restored to the real
 * syscall). No signal is ever scheduled to fire after the returned promise settles.
 *
 * Returns the awaited teardown verdict: TRUE only when the group is PROVEN gone (ESRCH). Callers MUST
 * await it before resolving a turn, launching another provider, releasing a lease, or deleting
 * evidence. FALSE means the scope could not be proven empty → fail closed (operator recovery).
 */
const inFlightTerminations = new Map<number, Promise<boolean>>();

export function terminateScope(
  pid: number | undefined,
  graceMs = 5000,
  caps: ProcessScopeCaps = realScopeCaps
): Promise<boolean> {
  if (!pid) return Promise.resolve(true);
  const existing = inFlightTerminations.get(pid);
  if (existing) return existing; // dedup: share the ONE in-flight sequence, never stack another
  const p = terminateGroupAwait(pid, graceMs, caps).finally(() => {
    if (inFlightTerminations.get(pid) === p) inFlightTerminations.delete(pid);
  });
  inFlightTerminations.set(pid, p);
  return p;
}

/** Whether a tracked termination sequence is currently in flight for `pid` (test/introspection aid). */
export function terminationInFlight(pid: number): boolean {
  return inFlightTerminations.has(pid);
}

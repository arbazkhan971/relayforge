import type { StdioOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isProcessGroupAlive, realScopeCaps, terminateScope, type ProcessScopeCaps } from "./runtime.js";
import { trustedRunnerActive } from "./sandbox.js";
import { parseVerifierCgroupJournalLine } from "./cgroup-delegation.js";

/**
 * THE PROCESS-SCOPE BACKEND — containment a provider cannot walk out of.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT WAS BROKEN
 * ---------------------------------------------------------------------------------------------
 * The transport owned exactly ONE thing: the detached child's process GROUP. Everything — the
 * survivor probe, the timeout reap, the cancellation sweep, and the ledger's own re-probe before it
 * mints money — was `kill(-pgid, …)` / `kill(-pgid, 0)`. A process group is not a containment
 * boundary. It is a SIGNALLING convenience that any descendant can leave, deliberately or by accident,
 * in one syscall:
 *
 *     setsid()                    → a brand-new session and process group; `-pgid` no longer reaches it
 *     fork(); exit(); (orphan)    → reparented to init, and if it setsid'd first, unreachable forever
 *     setpgid(0, 0)               → same, without even needing a new session
 *
 * A provider that double-forks a daemon therefore left a live process behind that our TERM→KILL could
 * not see and our ESRCH probe could not detect: `kill(-pgid, 0)` returned ESRCH, the transport reported
 * `scopeReaped: true`, and the ledger — probing the same empty group — MINTED a settlement over a turn
 * that was still running. "Proven empty" meant "the group we could still name is empty", which is not
 * the same claim at all.
 *
 * ---------------------------------------------------------------------------------------------
 * THE FIX: A KERNEL-ENFORCED MEMBERSHIP SET, ENTERED BEFORE THE PROVIDER EXISTS
 * ---------------------------------------------------------------------------------------------
 * A cgroup v2 membership is inherited across `fork` and preserved across `execve`, and there is NO
 * syscall that leaves it. `setsid`, `setpgid`, double-forking, orphaning, re-parenting to init: none of
 * them change which cgroup a task belongs to. Membership can only be changed by WRITING a pid into some
 * other cgroup's `cgroup.procs` — a filesystem write, not a process operation (and one the OS sandbox
 * denies, since /sys is read-only inside the jail). So a cgroup is the containment boundary a process
 * group only pretended to be:
 *
 *   - `cgroup.events: populated` is 1 iff the cgroup **or any descendant cgroup** holds a live task, so
 *     emptiness is a fact we READ from the kernel, not an inference from a signal's errno;
 *   - `cgroup.kill` SIGKILLs every task in the cgroup and all its descendants, atomically, with no
 *     pid-reuse hazard whatsoever (we name a cgroup, never a number that could have been recycled);
 *   - `rmdir` of a cgroup FAILS (EBUSY) while any task or child cgroup remains, so a successful removal
 *     is itself a kernel-attested proof of emptiness — which is what the reap proof records.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THE PROVIDER *BEGINS* INSIDE THE SCOPE (never "spawn, then enrol")
 * ---------------------------------------------------------------------------------------------
 * Enrolling a child AFTER spawning it is a race with a very sharp edge: between `fork` and the parent's
 * write to `cgroup.procs`, the child can already have `fork`ed a grandchild — and moving a pid into a
 * cgroup moves THAT PID ONLY, never its already-created descendants. The escapee is then outside the
 * scope from birth, and no later kill of the scope can reach it.
 *
 * So the scope is created FIRST (a unique, empty cgroup), and the child ENROLS ITSELF before the
 * provider exists at all. The launch mechanism is a minimal, exec-safe `/bin/sh` trampoline:
 *
 *     sh -c '<enrol $$ into the scope>; exec "$@"' loop-scope <procs-path> <command> <args…>
 *
 *   - `$$` is the shell's own pid — and because we spawn it `detached`, the shell IS the process-group
 *     leader, so the pid the scope records is the pgid the rest of the system already knows.
 *   - The write happens BEFORE anything is forked or exec'd, so the scope is non-empty exactly when the
 *     provider exists, and every descendant it later creates is a member by inheritance.
 *   - `exec` REPLACES the shell: same pid, same pgid, same cwd, same environment, the exact argv we were
 *     given (`"$@"` — never re-split, never re-quoted), and the same fds 0/1/2. There is no wrapper
 *     process left behind to distort exit codes or signal delivery.
 *   - fd 3 is a status pipe the trampoline writes ONE token to and then closes (`exec 3>&-`) before the
 *     exec, so the provider never inherits it. That token is how a PRE-EXEC failure (the enrolment
 *     itself failing) is distinguished from anything the provider did: the transport fails such a turn
 *     closed, having never run a provider outside its scope.
 *
 * ---------------------------------------------------------------------------------------------
 * THE LAUNCH GATE: NO PROVIDER EXECS BEFORE ITS SCOPE IS DURABLY JOURNALED
 * ---------------------------------------------------------------------------------------------
 * A scope that contains a provider is only as good as our ability to FIND it again. The orphan reaper
 * (see `reapAbandonedScope`) is what kills an agent whose orchestrator was SIGKILLed mid-turn, and it
 * can only reap what the run wrote into `.loop_scopes`. So the exact identity of a scope must be on
 * DISK, fsynced, before a provider is running inside it — otherwise a SIGKILL landing in the window
 * between `fork` and the journal append leaves a live, spending, worktree-writing agent that no
 * incarnation of this run will ever be able to name, let alone kill.
 *
 * That identity is not knowable before `fork` (it contains the leader's pid), so the child is spawned
 * FIRST and then held at a pre-exec GATE: after enrolling itself into the scope, the trampoline BLOCKS
 * reading fd 4 and execs the provider only on the parent's explicit release token. The parent writes
 * that token only after the scope id has been appended AND fsynced to the journal. Every other outcome
 * — an append/fsync failure, or the parent dying before it releases — closes the gate's pipe, the read
 * hits EOF, and the trampoline exits WITHOUT EXEC. A provider therefore cannot execute unrecorded, and
 * cannot survive unrecorded: the only process in the scope is a shell that has not become one.
 *
 * ---------------------------------------------------------------------------------------------
 * FAIL CLOSED
 * ---------------------------------------------------------------------------------------------
 * `requireScopeBackend()` returns the strong backend, or — for TESTS ONLY, via the same imported
 * `setTrustedRunner` seam the OS sandbox uses — the legacy pgid backend, or it THROWS. There is no
 * environment variable and no production path that runs a provider without a scope backend, exactly as
 * there is none that runs one without an OS sandbox.
 *
 * OUT OF SCOPE (documented, not defended): a same-uid attacker who writes a pid into a cgroup OUTSIDE
 * the scope. That requires writable `/sys/fs/cgroup` (which the OS sandbox does not grant) and is the
 * same trust domain that can already rewrite the journal — see the boundary note in `src/attest.ts`.
 */

// ---------------------------------------------------------------------------------------------
// SCOPE IDENTITY (pure grammar — the ledger, the kernel and the MAC all speak exactly this)
// ---------------------------------------------------------------------------------------------

/**
 * The EXACT identity of a scope one call owned. Backend-tagged, because the two backends prove
 * emptiness by different means and a proof must never be readable as the other kind:
 *
 *   `pgid`    — the legacy, WEAK scope: a process group. Proven empty by ESRCH. A descendant that
 *               `setsid`s escapes it, which is why this backend is not usable for real execution.
 *   `cgroup2` — the STRONG scope: a unique cgroup, identified by its NAME and its kernel-assigned
 *               INODE (a name alone could be recreated; the inode pins the exact object we made), plus
 *               the leader pid whose process group we ALSO require to be gone.
 */
export type ScopeRef =
  | { backend: "pgid"; pid: number }
  | { backend: "cgroup2"; pid: number; name: string; ino: string };

/** Scope directory names we mint. Nothing else is ever adopted, removed, or attested. */
const SCOPE_NAME = /^loop-[0-9a-f]{8,32}$/;
const PGID_ID = /^pgid:([1-9][0-9]{0,9})$/;
const CGROUP_ID = /^cgroup2:([1-9][0-9]{0,19}):(loop-[0-9a-f]{8,32}):([1-9][0-9]{0,9})$/;

/** The scope's durable identity string, as it appears in the transport result and in the MAC payload. */
export function scopeIdOf(ref: ScopeRef): string {
  return ref.backend === "pgid" ? `pgid:${ref.pid}` : `cgroup2:${ref.ino}:${ref.name}:${ref.pid}`;
}

/** Parse a scope id back into its exact identity. Anything unparseable is NOT a scope — the settlement
 *  kernel and the fold both refuse it, so an invented/unstructured id can never carry a reap proof. */
export function parseScopeId(id: string | undefined): ScopeRef | undefined {
  if (typeof id !== "string") return undefined;
  const pg = PGID_ID.exec(id);
  if (pg) {
    const pid = Number(pg[1]);
    return Number.isInteger(pid) && pid > 0 ? { backend: "pgid", pid } : undefined;
  }
  const cg = CGROUP_ID.exec(id);
  if (cg) {
    const pid = Number(cg[3]);
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    return { backend: "cgroup2", ino: cg[1], name: cg[2], pid };
  }
  return undefined;
}

/**
 * The ONE admissible reap proof for a scope, DERIVED from its identity — never accepted from a caller.
 * Both the transport and the ledger compute it with this function, so a proof cannot be detached from
 * the scope it names, moved to another call, or asserted for a scope nobody observed.
 *
 *   pgid     — `pgid-empty:ESRCH:<pid>`: signalling the group raised ESRCH.
 *   cgroup2  — `cgroup2-empty:RMDIR:<ino>:<name>+pgid-empty:ESRCH:<pid>`: the kernel REMOVED the exact
 *              cgroup (rmdir fails EBUSY while any task or child cgroup remains, so removal IS the
 *              emptiness proof) AND the leader's process group is additionally gone. Strictly stronger
 *              than the pgid proof it contains.
 */
export function reapProofOf(ref: ScopeRef): string {
  return ref.backend === "pgid"
    ? `pgid-empty:ESRCH:${ref.pid}`
    : `cgroup2-empty:RMDIR:${ref.ino}:${ref.name}+pgid-empty:ESRCH:${ref.pid}`;
}

// ---------------------------------------------------------------------------------------------
// THE OS CAPABILITY (injectable, so every branch below is testable without a real cgroup)
// ---------------------------------------------------------------------------------------------

/** Every OS effect the cgroup backend performs. Tests bind a deterministic fake; production binds the
 *  real syscalls. Nothing here reads an environment variable or consults a global. */
export interface ScopeOs {
  /** The delegated cgroup this process itself lives in, or undefined when there is none. */
  selfCgroupDir(): string | undefined;
  /** Create a directory. Throws (EEXIST) if it already exists — a scope name is never adopted. */
  mkdir(path: string): void;
  rmdir(path: string): void;
  readdir(path: string): string[];
  /** Read a cgroup attribute file. Throws ENOENT when the cgroup is gone. */
  readText(path: string): string;
  /** Write a cgroup attribute file (`cgroup.kill`, `cgroup.procs`). */
  writeText(path: string, data: string): void;
  /** The inode of a path, or undefined when it does not exist. */
  inodeOf(path: string): string | undefined;
  /** Whether a path is a directory (a cgroup's children are directories; its attributes are files). */
  isDir(path: string): boolean;
  /** Age of a path in milliseconds, or undefined when it does not exist. Used only to age out STALE
   *  scopes: a scope younger than the sweep threshold may belong to a concurrent run that has created
   *  its cgroup but not yet spawned into it, and must never be swept out from under it. */
  ageMs(path: string): number | undefined;
  /** Whether the trampoline's shell exists (a strong scope with no way to launch into it is not strong). */
  shellExists(): boolean;
}

export const realScopeOs: ScopeOs = {
  selfCgroupDir(): string | undefined {
    if (process.platform !== "linux") return undefined;
    let raw: string;
    try {
      raw = readFileSync("/proc/self/cgroup", "utf8");
    } catch {
      return undefined;
    }
    // cgroup v2 has exactly one entry: `0::<path-relative-to-the-v2-root>`.
    const line = raw.split("\n").find((l) => l.startsWith("0::"));
    const rel = line?.slice(3).trim();
    if (!rel || !rel.startsWith("/") || rel.includes("\0")) return undefined;
    const dir = resolve("/sys/fs/cgroup", `.${rel}`);
    return existsSync(resolve(dir, "cgroup.procs")) ? dir : undefined;
  },
  mkdir: (path) => mkdirSync(path),
  rmdir: (path) => rmdirSync(path),
  readdir: (path) => readdirSync(path),
  readText: (path) => readFileSync(path, "utf8"),
  // cgroup attribute files are written whole, in one write — a partial write is an error, never a
  // half-applied kill.
  writeText: (path, data) => writeFileSync(path, data),
  inodeOf(path) {
    try {
      return statSync(path).ino.toString();
    } catch {
      return undefined;
    }
  },
  isDir(path) {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  ageMs(path) {
    try {
      return Math.max(0, Date.now() - statSync(path).mtimeMs);
    } catch {
      return undefined;
    }
  },
  shellExists: () => existsSync(SHELL)
};

const SHELL = "/bin/sh";

/** The child fd the trampoline reports its PRE-EXEC status on (`enrolled` / `enroll-failed`). */
export const STATUS_FD = 3;
/** The child fd the trampoline BLOCKS on until the parent has durably recorded this scope. */
export const GATE_FD = 4;
/** The ONE token that releases a gated child to `exec` the provider. Anything else — EOF from a closed
 *  pipe, a truncated write, a parent that was SIGKILLed before it could journal — means NO EXEC. */
const GATE_TOKEN = "go";
const GATE_RELEASE = `${GATE_TOKEN}\n`;

/** The gate, in POSIX sh: block on fd 4, exec nothing unless the parent says the scope is on disk. */
const GATE_SH = [
  `IFS= read -r loop_gate <&${GATE_FD} || loop_gate=""`,
  `[ "$loop_gate" = "${GATE_TOKEN}" ] || exit 126`
].join("\n");

/**
 * Release a child parked at the pre-exec gate: it may now `exec` the provider. The caller must have
 * DURABLY journaled the scope's exact identity first — that ordering is the whole point of the gate.
 */
export function releaseLaunchGate(gate: NodeJS.WritableStream | null | undefined, token = GATE_RELEASE): void {
  if (!gate) return;
  try {
    gate.write(token);
    gate.end();
  } catch {
    // A child that is already gone cannot exec anything either; the transport's own teardown decides.
  }
}

/**
 * Refuse a launch: close the gate WITHOUT the token. The trampoline's read hits EOF and it exits 126
 * having never exec'd the provider. The child (a blocked shell) is still killed and its scope still
 * proven empty by the caller — the gate removes the PROVIDER, not the obligation to reap.
 */
export function closeLaunchGate(gate: NodeJS.WritableStream | null | undefined): void {
  if (!gate) return;
  try {
    gate.end();
  } catch {
    /* the pipe is already broken — the child cannot have been released either way */
  }
}

/**
 * The exec-safe trampoline. It runs in the CHILD, before the provider exists:
 *
 *   1. write its OWN pid into the pre-created scope's `cgroup.procs` — this is the enrolment, and it
 *      happens before anything is forked or exec'd, so nothing can be born outside the scope;
 *   2. report the outcome on fd 3 (`enrolled` / `enroll-failed`) — the parent's ONLY way to tell a
 *      PRE-EXEC failure from a provider failure;
 *   3. BLOCK on the launch gate (fd 4) until the parent has durably journaled this exact scope, and
 *      exit 126 WITHOUT EXEC if the gate closes without the release token (a journal failure, or a
 *      parent that died before it could record us);
 *   4. close fds 3 and 4 so the provider never inherits them, and `exec` the real argv — same pid, same
 *      pgid, same cwd/env/stdio, argv passed through `"$@"` with no re-splitting.
 *
 * A failure to enrol EXITS 125 WITHOUT EXEC: a provider is never run outside its scope, not even once.
 * A closed gate EXITS 126 WITHOUT EXEC: a provider is never run outside the durable record, not once.
 */
const TRAMPOLINE = [
  'if ! printf "%s\\n" "$$" > "$1" 2>/dev/null; then',
  '  printf "enroll-failed\\n" >&3 2>/dev/null',
  "  exit 125",
  "fi",
  "shift",
  'printf "enrolled\\n" >&3 2>/dev/null',
  GATE_SH,
  "exec 3>&- 4>&-",
  'exec "$@"'
].join("\n");

/** The gate-ONLY trampoline (the weak pgid backend has no cgroup to enrol into, but the durable-record
 *  invariant is not a property of the backend: no provider execs before its scope is on disk). */
const GATE_TRAMPOLINE = [GATE_SH, "exec 4>&-", 'exec "$@"'].join("\n");

/** The token the trampoline writes on fd 3 once it is INSIDE the scope, immediately before it gates. */
const ENROLLED = "enrolled";
const ENROLL_FAILED = "enroll-failed";

// ---------------------------------------------------------------------------------------------
// CAPABILITY DETECTION
// ---------------------------------------------------------------------------------------------

export type ScopeCapability = { strong: true; root: string } | { strong: false; why: string };

let cachedCapability: ScopeCapability | undefined;

/**
 * Prove — by DOING it, not by inspecting a mount table — that this host can give us a strong scope: a
 * delegated cgroup v2 we may create a child in, whose child exposes `cgroup.procs`, `cgroup.kill` and
 * `cgroup.events`, and which we may remove again. A present-but-unusable cgroup tree is treated exactly
 * like an absent one: NOT strong, and therefore fail-closed for real execution.
 *
 * Memoized for the real OS (the probe creates and removes a cgroup); an injected fake is never cached.
 */
export function detectScopeCapability(os: ScopeOs = realScopeOs): ScopeCapability {
  const real = os === realScopeOs;
  if (real && cachedCapability) return cachedCapability;
  const result = probeCapability(os);
  if (real) {
    cachedCapability = result;
    if (result.strong) sweepStaleScopes(os, result.root);
  }
  return result;
}

function probeCapability(os: ScopeOs): ScopeCapability {
  if (!os.shellExists()) return { strong: false, why: `the launch trampoline needs ${SHELL}, which does not exist here` };
  const root = os.selfCgroupDir();
  if (!root) return { strong: false, why: "this process is not in a cgroup v2 hierarchy (no `0::` entry in /proc/self/cgroup)" };
  const probe = resolve(root, `loop-${randomBytes(8).toString("hex")}`);
  try {
    os.mkdir(probe);
  } catch (error) {
    return { strong: false, why: `the delegated cgroup ${root} is not writable: ${(error as Error).message}` };
  }
  try {
    const entries = new Set(os.readdir(probe));
    for (const needed of ["cgroup.procs", "cgroup.kill", "cgroup.events"]) {
      if (!entries.has(needed)) return { strong: false, why: `a child cgroup here exposes no ${needed} (kernel too old for cgroup.kill?)` };
    }
    return { strong: true, root };
  } catch (error) {
    return { strong: false, why: `a child cgroup here is unusable: ${(error as Error).message}` };
  } finally {
    try {
      os.rmdir(probe);
    } catch {
      // The probe cgroup is empty (nothing was ever put in it), so this cannot fail in practice; if it
      // somehow does, the stale sweep below will reclaim it on a later run.
    }
  }
}

/** Reset the memoized capability (tests only — a fake OS is never cached, but the REAL probe is). */
export function resetScopeCapabilityCache(): void {
  cachedCapability = undefined;
}

/** A scope younger than this may belong to a concurrent run that has created its cgroup but has not yet
 *  spawned into it. Sweeping it would break that run's launch, so staleness needs age, not just emptiness. */
const STALE_SCOPE_MS = 10 * 60_000;

/**
 * Reclaim STALE scopes: cgroups WE named (`loop-<hex>`) that are old enough to belong to no live run and
 * that the kernel lets us remove — `rmdir` fails EBUSY while any task or child cgroup remains, so a
 * populated leftover (a run still in flight, or one whose descendants outlived a crash) is left ALONE for
 * an operator rather than silently half-cleaned. Best effort by design: a scope we cannot remove is
 * evidence, not garbage.
 */
export function sweepStaleScopes(os: ScopeOs, root: string, olderThanMs = STALE_SCOPE_MS): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = os.readdir(root);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!SCOPE_NAME.test(name)) continue; // never touch a cgroup we did not create
    const path = resolve(root, name);
    if (!os.isDir(path)) continue;
    const age = os.ageMs(path);
    if (age === undefined || age < olderThanMs) continue;
    if (cgroupPopulated(os, path)) continue; // a live scope is never swept
    try {
      os.rmdir(path);
      removed += 1;
    } catch {
      // EBUSY (a child cgroup remains) or a race with its owner — leave it.
    }
  }
  return removed;
}

/**
 * Whether the cgroup — OR ANY DESCENDANT CGROUP — holds a live task. This is the kernel's own answer
 * (`cgroup.events: populated`), not an inference from a signal, so a task that `setsid`'d, double-forked,
 * was orphaned to init, or hid in a sub-cgroup is counted exactly the same as the leader. A cgroup that no
 * longer exists holds nothing.
 */
function cgroupPopulated(os: ScopeOs, path: string): boolean {
  let raw: string;
  try {
    raw = os.readText(resolve(path, "cgroup.events"));
  } catch (error) {
    // ENOENT ⇒ the cgroup is gone ⇒ it holds nothing. Any OTHER error means we cannot SEE the scope, and
    // an unreadable scope is never a scope we may declare empty — fail closed by reporting it POPULATED.
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
  for (const line of raw.split("\n")) {
    const [key, value] = line.trim().split(/\s+/);
    if (key === "populated") return value !== "0";
  }
  return true; // an attribute file we cannot parse is not proof of emptiness
}

/**
 * Whether the exact cgroup scope `ref` still exists. Used by the LEDGER as its own re-probe before it
 * mints, so the transport's proof is never taken on faith:
 *
 *   - the scope's directory is GONE                  → not alive (its removal was the reap proof);
 *   - the directory exists with the SAME inode       → alive (we never removed it, so it was never proven
 *                                                      empty — whether or not a task is in it right now);
 *   - the name exists with a DIFFERENT inode         → alive (fail closed: some other cgroup holds the
 *                                                      name, so nothing here proves OUR scope's fate).
 */
export function cgroupScopeAlive(ref: Extract<ScopeRef, { backend: "cgroup2" }>, os: ScopeOs = realScopeOs): boolean {
  const root = os.selfCgroupDir();
  if (!root) return true; // we cannot even look ⇒ we cannot prove it empty
  if (!SCOPE_NAME.test(ref.name)) return true; // not a name we could have minted
  const path = resolve(root, ref.name);
  const ino = os.inodeOf(path);
  if (ino === undefined) return false; // removed — and rmdir only succeeds on an empty cgroup
  return true; // still present (same inode = never reaped; different inode = not ours to judge)
}

/** The ledger's scope prober: the ONE function that answers "may this scope be settled?" for either
 *  backend. A cgroup scope must ALSO have a dead process group — the proof asserts both. */
export function scopeAliveOf(ref: ScopeRef, os: ScopeOs = realScopeOs, groupAlive: (pid: number) => boolean = isProcessGroupAlive): boolean {
  if (ref.backend === "pgid") return groupAlive(ref.pid);
  return cgroupScopeAlive(ref, os) || groupAlive(ref.pid);
}

/**
 * The outcome of reaping ONE abandoned scope. The split that matters is PROVEN DEAD vs NOT PROVEN —
 * everything else is detail. There is deliberately no outcome meaning "we tried our best": trying is
 * not a proof, and this record is the only thing standing between a resumed run and two agents on one
 * task.
 *
 *  - `reaped`      we killed it and the directory is GONE. rmdir only succeeds on an EMPTY cgroup, so
 *                  its removal IS the proof that nothing survives in it.        → PROVEN DEAD
 *  - `gone`        it was already absent — same proof, someone else completed it. → PROVEN DEAD
 *  - `unresolved`  OUR cgroup (matching inode) is STILL THERE after cgroup.kill + rmdir. Something in
 *                  it would not die (an uninterruptible D-state task is the real-world case). A ghost
 *                  may still be running, spending, and writing into the attempt we are about to
 *                  reclaim.                                                      → NOT PROVEN
 *  - `foreign`     the name is worn by a DIFFERENT kernel object (or is not a name we could have
 *                  minted). Never touched — killing it would SIGKILL a stranger — and never treated as
 *                  proof, because nothing here tells us what became of OUR scope. → NOT PROVEN
 *  - `unsupported` a bare pgid across a restart (its pid may have been recycled, so it carries no
 *                  identity we can verify and must never be blind-signalled), or we cannot see the
 *                  cgroup tree at all.                                            → NOT PROVEN
 */
export type ReapOutcome = "reaped" | "gone" | "unresolved" | "foreign" | "unsupported";

/**
 * Did this outcome PROVE the scope is dead and empty?
 *
 * Only two outcomes do, and both rest on the same kernel fact: a cgroup directory can only be removed
 * when it holds no tasks. Everything else — including "we wrote cgroup.kill and did everything we
 * could" — leaves a scope that may still contain a live process, and must be treated as such.
 */
export function scopeProvenDead(outcome: ReapOutcome): boolean {
  return outcome === "reaped" || outcome === "gone";
}

/** Why an unresolved/foreign/unsupported scope blocks the run, in words an operator can act on. */
export function reapOutcomeAdvice(outcome: ReapOutcome): string {
  switch (outcome) {
    case "unresolved":
      return "the cgroup still exists after cgroup.kill + rmdir — a task in it will not die (uninterruptible sleep?). Inspect `cgroup.procs` in it, clear the process, then re-run; the scope is removed once it is empty.";
    case "foreign":
      return "the cgroup name is now worn by a DIFFERENT kernel object, so nothing here proves what became of ours. It was NOT touched (killing it could SIGKILL an unrelated run). Verify no agent of this run survives, then remove this line from .loop_scopes.";
    case "unsupported":
      return "this scope has no identity that survives a restart (a bare process group whose pid may have been recycled), or the cgroup tree is not visible, so it can neither be verified nor safely signalled. Verify by hand that no agent of this run survives, then remove this line from .loop_scopes.";
    default:
      return "proven dead.";
  }
}

/**
 * Kill a scope ABANDONED by a dead incarnation of this run — the orphan reaper for restart/resume.
 *
 * When the orchestrator is SIGKILLed, its agents do NOT die with it: each provider runs in its own
 * process group inside its own cgroup, so it is simply orphaned to init and keeps running — still
 * burning tokens, still writing into its attempt worktree, answerable to nobody. `sweepStaleScopes`
 * will not touch it, and correctly so: it refuses to sweep a POPULATED scope because a young populated
 * scope may belong to a CONCURRENT run, and killing that would be catastrophic.
 *
 * A resuming run can do what the sweeper cannot, because it knows something the sweeper does not: it
 * holds this run's EXCLUSIVE LEASE and has launched nothing yet, so a scope this run durably recorded
 * that still holds a live task cannot belong to anyone but its own dead predecessor. Reclaiming the
 * board while that predecessor's agent is still running would be half a resume — two agents, one task.
 *
 * The INODE is the safety interlock. A cgroup name can be recreated, so we kill only when the object
 * on disk is byte-for-byte the same kernel object we made (`ino` matches). A name now worn by a
 * DIFFERENT cgroup is `foreign` and is never touched — that is someone else's scope.
 */
/** How long to give the KERNEL to finish reaping the tasks `cgroup.kill` just SIGKILLed, and how to
 *  wait. Tests drive an in-memory tree that kills synchronously and pass `timeoutMs: 0`, so no test
 *  ever sleeps for a fake process; only the real filesystem needs the grace. */
export type ReapOptions = { timeoutMs?: number; sleep?: (ms: number) => void };

/** Block without a busy loop. The reaper is synchronous by design: it runs on the way IN to a run,
 *  before anything is dispatched, and nothing may proceed while it is undecided. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function reapAbandonedScope(ref: ScopeRef, os: ScopeOs = realScopeOs, opts: ReapOptions = {}): ReapOutcome {
  // A bare pgid is NOT safely reapable across a restart: the leader is long dead and its pid may have
  // been reused by an unrelated process, so signalling it blind could kill a stranger. Only the strong
  // backend carries an identity (the inode) that survives the crash.
  if (ref.backend !== "cgroup2") return "unsupported";
  if (!SCOPE_NAME.test(ref.name)) return "foreign"; // not a name we could have minted
  const root = os.selfCgroupDir();
  if (!root) return "unsupported";

  const path = resolve(root, ref.name);
  const ino = os.inodeOf(path);
  if (ino === undefined) return "gone"; // already reclaimed (rmdir only succeeds on an empty cgroup)
  if (ino !== ref.ino) return "foreign"; // the name is recycled — this is NOT the cgroup we created

  // `cgroup.kill` SIGKILLs every task in the cgroup and every descendant cgroup, atomically — a
  // setsid'd, double-forked, init-orphaned survivor is killed exactly like the leader.
  try {
    os.writeText(resolve(path, "cgroup.kill"), "1");
  } catch {
    // ENOENT ⇒ already gone; anything else ⇒ we could not kill it. Either way the emptiness wait below
    // is what decides, never the errno.
  }

  // WAIT for the kernel to actually reap them. `cgroup.kill` DELIVERS SIGKILL; it does not synchronously
  // dismantle the tasks, so a cgroup that is about to be empty still EBUSYs an immediate `rmdir`. Racing
  // that rmdir and then calling the result a reap is precisely how "we tried" got mistaken for "it's
  // dead" — so we ask the kernel the same question the normal teardown does (`cgroup.events: populated`,
  // which counts descendants and orphans alike) and give it a bounded time to answer.
  const deadline = opts.timeoutMs ?? 5_000;
  const sleep = opts.sleep ?? sleepSync;
  for (let waited = 0; cgroupPopulated(os, path) && waited < deadline; waited += 25) sleep(25);

  // Remove the scope BOTTOM-UP: a sub-cgroup the provider created would otherwise EBUSY the parent
  // forever and turn a clean kill into a permanent "unresolved".
  removeCgroupTree(os, path);

  // Now let the FILESYSTEM say what happened. Writing `cgroup.kill` and calling `rmdir` is an ATTEMPT;
  // only the directory actually being gone is a PROOF — `rmdir` succeeds solely on an empty cgroup. This
  // used to `return "killed"` unconditionally, so an unkillable survivor (a D-state task that ignores
  // SIGKILL) was reported as reclaimed: the caller then cleared its durable record and re-dispatched the
  // task while the ghost was still running it. The kernel object is the only witness we accept.
  const after = os.inodeOf(path);
  if (after === undefined) return "reaped"; // removed ⇒ it was empty ⇒ nothing survives in it
  if (after !== ref.ino) return "foreign"; // ours went away and the name was re-taken — not ours to judge
  return "unresolved"; // OUR cgroup is still standing: assume a live ghost, and fail closed
}

/** Remove `path` and every cgroup below it, deepest first (a child cgroup EBUSYs its parent's rmdir). */
function removeCgroupTree(os: ScopeOs, path: string): void {
  let entries: string[];
  try {
    entries = os.readdir(path);
  } catch {
    return; // gone already, or unreadable — the inode re-probe decides
  }
  for (const entry of entries) {
    const child = resolve(path, entry);
    if (os.isDir(child)) removeCgroupTree(os, child); // attribute files are not children
  }
  try {
    os.rmdir(path); // EBUSY while anything remains, so removal IS the emptiness proof
  } catch {
    // Something is still in it. Not a reap — the caller will see the directory still standing.
  }
}

/**
 * Replay a run's durable scope journal and decide, per line, whether the scope it names is PROVEN dead.
 *
 * Pure (the reaper is injected) so every outcome — including the unkillable survivor, which cannot be
 * staged with real processes — is driven deterministically in tests.
 *
 * The journal is EVIDENCE, and evidence is only spent once it is discharged:
 *   - proven-dead lines (`reaped`/`gone`) are discharged and dropped;
 *   - every other line is RETAINED, because it still names something we cannot prove is not running.
 *     The retained record is what a later resume (or a human) needs in order to finish the job;
 *   - an UNPARSEABLE line is retained and treated as unresolved, never skipped. We cannot prove a line
 *     we cannot read is harmless, and a line that could name a scope we own is exactly the line whose
 *     silent removal would lose the last pointer to a live ghost.
 */
export function recoverAbandonedScopes(
  record: string,
  reap: (ref: ScopeRef) => ReapOutcome
): { reaped: string[]; retained: string[]; unresolved: { id: string; outcome: ReapOutcome; advice: string }[] } {
  const reaped: string[] = [];
  const retained: string[] = [];
  const unresolved: { id: string; outcome: ReapOutcome; advice: string }[] = [];

  for (const line of record.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const ref = parseScopeId(line);
    if (!ref) {
      const verifier = parseVerifierCgroupJournalLine(line);
      if (verifier.kind === "v2") {
        retained.push(line);
        unresolved.push({
          id: line,
          outcome: "unsupported",
          advice: "this is a valid v2 verifier-cgroup journal record and requires device/inode-pinned verifier recovery; it is retained rather than downgraded to legacy inode-only recovery."
        });
        continue;
      }
      // Not a scope id we can read. It is NOT therefore harmless: it may be a corrupted/truncated line
      // for a scope this run really owns. Keep it, and fail closed.
      retained.push(line);
      unresolved.push({
        id: line,
        outcome: "foreign",
        advice: "this line of .loop_scopes is not a readable scope id (corrupt or truncated), so it can neither be verified nor reaped — and it may be the only remaining pointer to a live agent. Verify no agent of this run survives, then remove the line."
      });
      continue;
    }
    const outcome = reap(ref);
    if (scopeProvenDead(outcome)) {
      if (outcome === "reaped") reaped.push(line);
      continue; // discharged — drop it from the journal
    }
    retained.push(line);
    unresolved.push({ id: line, outcome, advice: reapOutcomeAdvice(outcome) });
  }
  return { reaped, retained, unresolved };
}

// ---------------------------------------------------------------------------------------------
// THE BACKEND
// ---------------------------------------------------------------------------------------------

/** How the child must be spawned so that it BEGINS inside its scope, and is HELD there until the run
 *  has durably recorded it. `statusFd` carries the pre-exec enrolment token (absent for a backend with
 *  no enrolment step); `gateFd` is the pipe whose release token is the child's only permission to
 *  `exec` the provider — every backend has one, because the durable-record invariant is not optional. */
export type LaunchSpec = {
  command: string;
  args: string[];
  stdio: StdioOptions;
  statusFd?: number;
  gateFd: number;
  /** Defaults to the legacy `go\n`; verifier cgroup sessions require the ADR's exact `GO\n`. */
  gateToken?: string;
};

/** One call's owned scope: created BEFORE the provider, torn down after it, removed only by us. */
export interface ProcessScope {
  readonly kind: "cgroup2" | "pgid";
  /** Decorate the argv/stdio so the spawned child enters THIS scope before it becomes the provider. */
  launch(command: string, args: string[]): LaunchSpec;
  /** Bind the spawned leader's pid (its pgid, since it is spawned detached). Completes the identity. */
  bind(pid: number): void;
  /** Whether a leader pid was ever bound (a scope with no child proves nothing). */
  spawned(): boolean;
  /** The exact identity, once spawned. */
  ref(): ScopeRef | undefined;
  /** The durable scope id, or "unspawned". */
  scopeId(): string;
  /** Optional versioned record; fsynced as one physical line before the launch gate is released. */
  journalLine?(): string;
  /** Feed the trampoline's fd-3 status bytes (no-op for a backend without one). */
  noteStatus(chunk: Buffer): void;
  /** Optional exact-message boundary notification for authenticated status protocols. */
  noteStatusEnd?(): void;
  /** Whether the child reported that it entered the scope BEFORE exec'ing the provider. */
  enrolled(): boolean;
  /** Why the child failed BEFORE exec (so a provider that never ran is not read as a provider failure). */
  preExecFailure(): string | undefined;
  /** Whether the scope — or ANY descendant, however it escaped its process group — still holds a task. */
  alive(): boolean;
  /**
   * Kill the scope, AWAIT proof it is empty, and remove ONLY this scope. Deduplicated and idempotent: a
   * timeout, a cancellation poll, a quota kill, and finalization all share the ONE in-flight teardown.
   * Returns TRUE only when emptiness is PROVEN; FALSE means the caller must fail closed.
   */
  reap(graceMs?: number): Promise<boolean>;
  /** The reap proof — set ONLY by a teardown that proved emptiness. Never a reason, never a claim. */
  reapProof(): string | undefined;
  /** Discard a scope no provider ever entered (a pre-spawn failure). Best effort, never throws. */
  dispose(): void;
}

export interface ScopeBackend {
  readonly kind: "cgroup2" | "pgid";
  readonly strong: boolean;
  /** Create a fresh, UNIQUE, EMPTY scope. Throws when it cannot — the caller fails the turn closed
   *  rather than running a provider in no scope at all. */
  open(): ProcessScope;
}

/** How long a scope gets to die politely (SIGTERM to the group) before the cgroup is SIGKILLed whole. */
const DEFAULT_GRACE_MS = 5000;

class Cgroup2Scope implements ProcessScope {
  readonly kind = "cgroup2" as const;
  readonly path: string;
  readonly name: string;
  readonly ino: string;
  #pid: number | undefined;
  #status = "";
  #removed = false;
  #proof: string | undefined;
  #reaping: Promise<boolean> | undefined;

  constructor(
    private readonly os: ScopeOs,
    root: string,
    private readonly caps: ProcessScopeCaps
  ) {
    // A fresh 64-bit name, created with `mkdir` (which fails EEXIST): the scope is UNIQUE and never an
    // existing cgroup we adopted — so we can only ever kill and remove processes we ourselves launched.
    this.name = `loop-${randomBytes(8).toString("hex")}`;
    this.path = resolve(root, this.name);
    this.os.mkdir(this.path);
    const ino = this.os.inodeOf(this.path);
    if (ino === undefined) {
      this.dispose();
      throw new Error(`the scope cgroup ${this.path} vanished immediately after creation`);
    }
    this.ino = ino;
  }

  launch(command: string, args: string[]): LaunchSpec {
    return {
      command: SHELL,
      // `$0` is a label; `$1` is the scope's cgroup.procs; the rest is the EXACT argv, passed through
      // `exec "$@"` with no re-splitting and no re-quoting.
      args: ["-c", TRAMPOLINE, "loop-scope", resolve(this.path, "cgroup.procs"), command, ...args],
      // fd 3 is the pre-exec status pipe; fd 4 is the launch gate the child blocks on until the run has
      // fsynced this scope's identity. The provider inherits neither (`exec 3>&- 4>&-`).
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
      statusFd: STATUS_FD,
      gateFd: GATE_FD
    };
  }

  bind(pid: number): void {
    if (Number.isInteger(pid) && pid > 0) this.#pid = pid;
  }

  spawned(): boolean {
    return this.#pid !== undefined;
  }

  ref(): ScopeRef | undefined {
    return this.#pid === undefined ? undefined : { backend: "cgroup2", pid: this.#pid, name: this.name, ino: this.ino };
  }

  scopeId(): string {
    const ref = this.ref();
    return ref ? scopeIdOf(ref) : "unspawned";
  }

  noteStatus(chunk: Buffer): void {
    if (this.#status.length < 256) this.#status += chunk.toString("utf8");
  }

  enrolled(): boolean {
    return this.#status.includes(ENROLLED);
  }

  preExecFailure(): string | undefined {
    if (this.#status.includes(ENROLL_FAILED)) {
      return `the child could not enter its scope cgroup (${this.path}/cgroup.procs); it exited without ever exec'ing the provider`;
    }
    // A child that spawned but reported NOTHING never reached the pre-exec checkpoint (the trampoline
    // writes its token unconditionally before exec) — so we cannot claim the provider ran contained.
    if (this.#pid !== undefined && !this.enrolled()) {
      return "the child never reported entering its scope cgroup, so the provider cannot be proven to have run inside it";
    }
    return undefined;
  }

  alive(): boolean {
    if (this.#removed) return false;
    if (cgroupPopulated(this.os, this.path)) return true;
    // Defence in depth: the scope is also not empty while the leader's process GROUP still answers. The
    // two can only disagree if something moved a task out of the cgroup, which is exactly the case we
    // must fail closed on.
    return this.#pid !== undefined && this.caps.groupAlive(this.#pid);
  }

  reap(graceMs = DEFAULT_GRACE_MS): Promise<boolean> {
    // ONE teardown per scope, shared by every initiator (timeout, cancellation, quota kill, framing
    // fatal, normal-close survivor probe, finalization). Never a second, stacked kill sequence.
    this.#reaping ??= this.#tearDown(graceMs);
    return this.#reaping;
  }

  async #tearDown(graceMs: number): Promise<boolean> {
    if (this.#removed) return this.#proof !== undefined;
    // 1. Politeness first: TERM the process group so a well-behaved provider can flush and exit. This is
    //    the only step that addresses pids, and it is advisory — the kill below needs no pid at all.
    if (this.#pid !== undefined) this.caps.signalGroup(this.#pid, "SIGTERM");
    const graceDeadline = this.caps.now() + graceMs;
    while (this.alive() && this.caps.now() < graceDeadline) await this.caps.sleep(50);

    // 2. `cgroup.kill`: SIGKILL to EVERY task in the cgroup and every descendant cgroup, in one write.
    //    A `setsid` daemon, a double-forked orphan re-parented to init, a task hiding in a sub-cgroup —
    //    all of them are members, and none of them can refuse. There is no pid here to be reused, so
    //    this can never reach a process we do not own.
    if (this.alive()) {
      try {
        this.os.writeText(resolve(this.path, "cgroup.kill"), "1");
      } catch (error) {
        // ENOENT ⇒ the cgroup is already gone (someone removed it) ⇒ nothing to kill. Anything else
        // (EACCES, EIO) means we could not kill the scope: we will fail to prove it empty below and the
        // turn fails closed.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          /* fall through to the emptiness wait — which will not be satisfied */
        }
      }
      const killDeadline = this.caps.now() + Math.max(2000, graceMs);
      while (this.alive() && this.caps.now() < killDeadline) await this.caps.sleep(25);
    }
    // 3. Emptiness is the KERNEL's answer (`populated 0`), plus a dead process group. Not a signal errno.
    if (this.alive()) return false;

    // 4. Remove ONLY the scope we created — bottom-up, so a sub-cgroup the provider made cannot keep it
    //    alive. `rmdir` FAILS (EBUSY) on a populated cgroup, so a successful removal is the kernel
    //    attesting emptiness for us; a failure means we may NOT claim it.
    if (!this.#removeTree(this.path)) return false;
    this.#removed = true;

    // 5. Belt and braces: the leader's process group must ALSO be gone (ESRCH). The proof asserts both.
    if (this.#pid !== undefined && this.caps.groupAlive(this.#pid)) return false;
    const ref = this.ref();
    if (ref) this.#proof = reapProofOf(ref);
    return true;
  }

  /** Remove `path` and every cgroup below it, deepest first. Returns false if anything survives. */
  #removeTree(path: string): boolean {
    let entries: string[];
    try {
      entries = this.os.readdir(path);
    } catch (error) {
      // Already gone: someone (a stale sweep, an operator) removed it. It is empty either way.
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
    for (const entry of entries) {
      const child = resolve(path, entry);
      if (!this.os.isDir(child)) continue; // a cgroup's attribute files are not removable and not children
      if (!this.#removeTree(child)) return false;
    }
    try {
      this.os.rmdir(path);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }

  reapProof(): string | undefined {
    return this.#proof;
  }

  dispose(): void {
    if (this.#removed) return;
    try {
      this.os.rmdir(this.path); // EBUSY if anything is in it — then it is NOT ours to silently drop
      this.#removed = true;
    } catch {
      // best effort: a populated scope is reaped through `reap`, never quietly discarded
    }
  }
}

/**
 * The LEGACY, WEAK scope: a detached process group. It is exactly what the transport had before, and it
 * is retained for ONE reason — tests that inject a trusted runner must still be able to drive the whole
 * transport on a host with no delegated cgroup. It CANNOT contain a `setsid`/double-fork escape, and
 * `requireScopeBackend()` therefore refuses to hand it to real execution.
 */
class PgidScope implements ProcessScope {
  readonly kind = "pgid" as const;
  #pid: number | undefined;
  #proof: string | undefined;

  constructor(private readonly caps: ProcessScopeCaps) {}

  launch(command: string, args: string[]): LaunchSpec {
    // Weak containment, but the SAME launch handshake: the child is a shell that becomes the provider
    // (`exec`, so same pid/pgid/stdio/exit code) only once the parent releases the gate. There is no
    // enrolment to report, so fd 3 is not wired at all.
    return {
      command: SHELL,
      args: ["-c", GATE_TRAMPOLINE, "loop-scope", command, ...args],
      stdio: ["pipe", "pipe", "pipe", "ignore", "pipe"],
      gateFd: GATE_FD
    };
  }

  bind(pid: number): void {
    if (Number.isInteger(pid) && pid > 0) this.#pid = pid;
  }

  spawned(): boolean {
    return this.#pid !== undefined;
  }

  ref(): ScopeRef | undefined {
    return this.#pid === undefined ? undefined : { backend: "pgid", pid: this.#pid };
  }

  scopeId(): string {
    const ref = this.ref();
    return ref ? scopeIdOf(ref) : "unspawned";
  }

  noteStatus(): void {
    /* this backend has no pre-exec checkpoint: the spawned leader IS the scope */
  }

  enrolled(): boolean {
    return true;
  }

  preExecFailure(): string | undefined {
    return undefined;
  }

  alive(): boolean {
    return this.#pid !== undefined && this.caps.groupAlive(this.#pid);
  }

  async reap(graceMs = DEFAULT_GRACE_MS): Promise<boolean> {
    // `terminateScope` is the existing per-PGID deduplicated TERM→grace→KILL, awaited to completion.
    const reaped = await terminateScope(this.#pid, graceMs, this.caps);
    const ref = this.ref();
    if (reaped && ref) this.#proof = reapProofOf(ref);
    return reaped;
  }

  reapProof(): string | undefined {
    return this.#proof;
  }

  dispose(): void {
    /* nothing was created */
  }
}

class Cgroup2Backend implements ScopeBackend {
  readonly kind = "cgroup2" as const;
  readonly strong = true;
  constructor(
    private readonly root: string,
    private readonly os: ScopeOs,
    private readonly caps: ProcessScopeCaps
  ) {}
  open(): ProcessScope {
    return new Cgroup2Scope(this.os, this.root, this.caps);
  }
}

class PgidBackend implements ScopeBackend {
  readonly kind = "pgid" as const;
  readonly strong = false;
  constructor(private readonly caps: ProcessScopeCaps) {}
  open(): ProcessScope {
    return new PgidScope(this.caps);
  }
}

/** The strong backend, or undefined when this host cannot give us one. */
export function strongScopeBackend(os: ScopeOs = realScopeOs, caps: ProcessScopeCaps = realScopeCaps): ScopeBackend | undefined {
  const cap = detectScopeCapability(os);
  return cap.strong ? new Cgroup2Backend(cap.root, os, caps) : undefined;
}

/** The weak, process-group backend (test seam / explicit construction only). */
export function pgidScopeBackend(caps: ProcessScopeCaps = realScopeCaps): ScopeBackend {
  return new PgidBackend(caps);
}

/**
 * The backend a REAL execution must use — or a throw.
 *
 * Strong scope, or the trusted-runner seam (tests, injected in-process by import — never by an
 * environment variable), or nothing at all. This is the same fail-closed shape as `containCommand`: a
 * missing containment boundary can never be mistaken for a weak one that happens to be good enough.
 */
export function requireScopeBackend(os: ScopeOs = realScopeOs, caps: ProcessScopeCaps = realScopeCaps): ScopeBackend {
  const strong = strongScopeBackend(os, caps);
  if (strong) return strong;
  if (trustedRunnerActive()) return pgidScopeBackend(caps);
  const cap = detectScopeCapability(os);
  throw new Error(
    `No strong process scope available (${cap.strong ? "unknown" : cap.why}). A provider's descendants could escape a ` +
      "process group with setsid/double-fork, so refusing to launch one — failing closed."
  );
}

/** For diagnostics / doctor. */
export function scopeInfo(): { backend: "cgroup2" | "none"; strong: boolean; detail: string } {
  const cap = detectScopeCapability();
  return cap.strong
    ? { backend: "cgroup2", strong: true, detail: `strong process scope: a unique cgroup under ${cap.root} (cgroup.kill + rmdir-attested emptiness)` }
    : { backend: "none", strong: false, detail: cap.why };
}

import { describe, expect, it } from "vitest";
import type { ProcessScopeCaps } from "../src/runtime.js";
import { FakeCgroupFs, osWith } from "./fake-cgroup.js";
import { setTrustedRunner } from "../src/sandbox.js";
import {
  cgroupScopeAlive,
  parseScopeId,
  reapAbandonedScope,
  reapOutcomeAdvice,
  reapProofOf,
  recoverAbandonedScopes,
  scopeProvenDead,
  requireScopeBackend,
  scopeAliveOf,
  scopeIdOf,
  strongScopeBackend,
  sweepStaleScopes,
  type ReapOutcome,
  type ScopeOs,
  type ScopeRef
} from "../src/scope.js";

/**
 * The scope backend, driven DETERMINISTICALLY: an in-memory cgroup filesystem and a fake clock, so every
 * branch of the teardown (grace, kill, EBUSY, a sub-cgroup the provider created, an unkillable member, a
 * concurrent teardown, a stale leftover) is exercised without a single real process, signal, or timer.
 *
 * The real-Linux proof that a `setsid`/double-forked descendant actually dies lives in
 * tests/containment.test.ts; this file proves the LOGIC that surrounds it.
 */

/** A fake clock + signal sink: no real timer, no real signal, ever. */
function fakeCaps(over: Partial<ProcessScopeCaps> = {}): ProcessScopeCaps & { clock: number; signals: string[] } {
  const caps = {
    clock: 0,
    signals: [] as string[],
    signalGroup(pid: number, sig: NodeJS.Signals) {
      caps.signals.push(`${sig}:-${pid}`);
    },
    groupAlive: () => false,
    sleep: async (ms: number) => {
      caps.clock += ms; // time only advances because the teardown awaited it
    },
    now: () => caps.clock,
    ...over
  };
  return caps as ProcessScopeCaps & { clock: number; signals: string[] };
}

/** Open a scope on a fake tree and put `tasks` live processes in it (as a spawned provider would). */
function openScope(os: FakeCgroupFs, caps: ProcessScopeCaps, opts: { pid?: number; tasks?: number } = {}) {
  const backend = strongScopeBackend(os, caps)!;
  expect(backend.strong).toBe(true);
  const scope = backend.open();
  const pid = opts.pid ?? 4242;
  scope.bind(pid);
  scope.noteStatus(Buffer.from("enrolled\n"));
  const path = (scope as unknown as { path: string }).path;
  if (opts.tasks) os.tasks.set(path, opts.tasks);
  return { scope, path, pid };
}

describe("scope identity: a proof is DERIVED from the scope it names, never asserted", () => {
  it("round-trips both backends' ids, and refuses anything that is not one", () => {
    const pgid: ScopeRef = { backend: "pgid", pid: 77 };
    const cg: ScopeRef = { backend: "cgroup2", pid: 77, name: "loop-0123456789abcdef", ino: "9182" };
    expect(scopeIdOf(pgid)).toBe("pgid:77");
    expect(scopeIdOf(cg)).toBe("cgroup2:9182:loop-0123456789abcdef:77");
    expect(parseScopeId(scopeIdOf(pgid))).toEqual(pgid);
    expect(parseScopeId(scopeIdOf(cg))).toEqual(cg);
    for (const junk of ["", "unspawned", "the-child", "pgid:0", "pgid:-1", "cgroup2:0:loop-abc:1", "cgroup2:1:evil:1", "cgroup2:1:loop-0123456789abcdef:0", undefined]) {
      expect(parseScopeId(junk as string | undefined), `${String(junk)} parsed as a scope`).toBeUndefined();
    }
  });

  it("a cgroup scope's proof asserts BOTH the kernel's removal and a dead process group", () => {
    const cg: ScopeRef = { backend: "cgroup2", pid: 77, name: "loop-0123456789abcdef", ino: "9182" };
    expect(reapProofOf(cg)).toBe("cgroup2-empty:RMDIR:9182:loop-0123456789abcdef+pgid-empty:ESRCH:77");
    // A pgid proof says strictly less, and can never stand in for a contained one.
    expect(reapProofOf({ backend: "pgid", pid: 77 })).toBe("pgid-empty:ESRCH:77");
    expect(reapProofOf(cg)).not.toBe(reapProofOf({ backend: "pgid", pid: 77 }));
  });
});

describe("the scope's teardown: kill → PROVE empty → remove ONLY what we own", () => {
  it("kills the cgroup, waits for `populated 0`, removes it, and only THEN issues a proof", async () => {
    const os = new FakeCgroupFs();
    const caps = fakeCaps();
    const { scope, path } = openScope(os, caps, { tasks: 3 }); // a provider + two descendants

    expect(scope.alive()).toBe(true);
    expect(await scope.reap()).toBe(true);

    expect(caps.signals).toEqual(["SIGTERM:-4242"]); // politeness first…
    expect(os.kills).toEqual([path]); // …then the cgroup-wide SIGKILL
    expect(os.dirs.has(path)).toBe(false); // removed — and removal is what proved it empty
    expect(scope.reapProof()).toBe(reapProofOf(scope.ref()!));
    expect(scope.alive()).toBe(false);
  });

  it("a provider that exits during the grace period is never SIGKILLed at all", async () => {
    const os = new FakeCgroupFs();
    const caps = fakeCaps();
    const { scope, path } = openScope(os, caps, { tasks: 1 });
    // The TERM lands: the member exits before the grace deadline.
    os.tasks.set(path, 0);
    expect(await scope.reap()).toBe(true);
    expect(os.kills).toEqual([]); // no cgroup.kill was ever needed
    expect(os.dirs.has(path)).toBe(false);
  });

  it("a sub-cgroup the provider created cannot keep the scope alive (kill and removal are recursive)", async () => {
    const os = new FakeCgroupFs();
    const caps = fakeCaps();
    const { scope, path } = openScope(os, caps);
    // The provider makes its own cgroup inside ours and hides a task there — `populated` still sees it,
    // `cgroup.kill` still reaches it, and the removal must be bottom-up or the rmdir would EBUSY.
    const hideout = `${path}/hideout`;
    os.mkdir(hideout);
    os.tasks.set(hideout, 1);

    expect(scope.alive()).toBe(true);
    expect(await scope.reap()).toBe(true);
    expect(os.dirs.has(hideout)).toBe(false);
    expect(os.dirs.has(path)).toBe(false);
    expect(scope.reapProof()).toBeDefined();
  });

  it("a member that survives SIGKILL is NOT proven empty: no proof, and the scope is LEFT for an operator", async () => {
    const os = new FakeCgroupFs();
    const caps = fakeCaps();
    const { scope, path } = openScope(os, caps, { tasks: 1 });
    os.unkillable.add(path); // an uninterruptible-sleep task: the kill is written, the population stays

    expect(await scope.reap()).toBe(false); // fail closed — never "probably empty"
    expect(scope.reapProof()).toBeUndefined();
    expect(os.dirs.has(path)).toBe(true); // evidence is preserved, not cleaned up over a live provider
    expect(caps.clock).toBeGreaterThan(0); // it really waited (awaited sleeps), then gave up on a deadline
  });

  it("an unwritable cgroup.kill (EACCES) fails closed rather than throwing or claiming a reap", async () => {
    const os = new FakeCgroupFs();
    const caps = fakeCaps();
    const { scope, path } = openScope(os, caps, { tasks: 1 });
    os.denyWrite.add(`${path}/cgroup.kill`);
    os.unkillable.add(path);

    expect(await scope.reap()).toBe(false);
    expect(scope.reapProof()).toBeUndefined();
    expect(os.dirs.has(path)).toBe(true);
  });

  it("a dead process GROUP is required too: a cgroup-empty scope whose leader still answers is not proven", async () => {
    const os = new FakeCgroupFs();
    // The cgroup reports empty, but the leader's process group still answers — the two disagree, which is
    // exactly the state where something escaped our accounting. Fail closed.
    const caps = fakeCaps({ groupAlive: () => true });
    const { scope } = openScope(os, caps);
    expect(await scope.reap()).toBe(false);
    expect(scope.reapProof()).toBeUndefined();
  });

  it("CONCURRENT teardowns share ONE kill sequence (a 1 Hz cancel poll can never stack them)", async () => {
    const os = new FakeCgroupFs();
    const caps = fakeCaps();
    const { scope, path } = openScope(os, caps, { tasks: 1 });

    const [a, b, c] = await Promise.all([scope.reap(), scope.reap(), scope.reap()]);
    expect([a, b, c]).toEqual([true, true, true]);
    expect(caps.signals).toEqual(["SIGTERM:-4242"]); // ONE TERM…
    expect(os.kills).toEqual([path]); // …ONE kill, however many initiators asked
    // And a teardown after the fact is idempotent: it re-reports the same verdict, killing nothing again.
    expect(await scope.reap()).toBe(true);
    expect(os.kills).toEqual([path]);
  });

  it("a scope nothing was spawned into is disposable, and issues no proof", async () => {
    const os = new FakeCgroupFs();
    const backend = strongScopeBackend(os, fakeCaps())!;
    const scope = backend.open();
    const path = (scope as unknown as { path: string }).path;
    expect(scope.spawned()).toBe(false);
    expect(scope.scopeId()).toBe("unspawned");
    expect(scope.ref()).toBeUndefined();
    scope.dispose();
    expect(os.dirs.has(path)).toBe(false);
  });

  it("every scope is UNIQUE: a name is minted, never adopted", () => {
    const os = new FakeCgroupFs();
    const backend = strongScopeBackend(os, fakeCaps())!;
    const names = new Set([...Array(20)].map(() => (backend.open() as unknown as { name: string }).name));
    expect(names.size).toBe(20);
    for (const n of names) expect(n).toMatch(/^loop-[0-9a-f]{16}$/);
  });
});

describe("the launch: the provider BEGINS inside the scope (no spawn-then-enrol race)", () => {
  it("wraps the argv in an exec-safe trampoline that enrols BEFORE exec and preserves the argv exactly", () => {
    const os = new FakeCgroupFs();
    const { scope, path } = openScope(os, fakeCaps());
    const spec = scope.launch("claude", ["-p", "--output-format", "stream-json", "a b", "$(evil)"]);

    expect(spec.command).toBe("/bin/sh");
    expect(spec.args[0]).toBe("-c");
    // The script enrols `$$` into THIS scope's cgroup.procs, reports on fd 3, BLOCKS on the launch gate
    // (fd 4) until the run has durably recorded the scope, closes both fds, and only then EXECs.
    expect(spec.args[1]).toContain('printf "%s\\n" "$$" > "$1"');
    expect(spec.args[1]).toContain("read -r loop_gate <&4");
    expect(spec.args[1]).toContain('[ "$loop_gate" = "go" ] || exit 126');
    expect(spec.args[1]).toContain("exec 3>&- 4>&-");
    expect(spec.args[1]).toContain('exec "$@"');
    // The gate is BEFORE the exec, not after it — an exec that raced the journal would be the whole bug.
    expect(spec.args[1].indexOf("read -r loop_gate")).toBeLessThan(spec.args[1].indexOf('exec "$@"'));
    // `$1` is this scope's cgroup.procs; the command and its args follow, VERBATIM — `exec "$@"` never
    // re-splits or re-quotes them, so an argument containing spaces or shell metacharacters is safe.
    expect(spec.args.slice(2)).toEqual(["loop-scope", `${path}/cgroup.procs`, "claude", "-p", "--output-format", "stream-json", "a b", "$(evil)"]);
    expect(spec.stdio).toEqual(["pipe", "pipe", "pipe", "pipe", "pipe"]); // fd 3 = status, fd 4 = launch gate
    expect(spec.statusFd).toBe(3);
    expect(spec.gateFd).toBe(4);
  });

  it("distinguishes a PRE-EXEC failure (never entered the scope) from anything the provider did", () => {
    const os = new FakeCgroupFs();
    const caps = fakeCaps();

    const enrolled = openScope(os, caps).scope; // openScope feeds the `enrolled` token
    expect(enrolled.enrolled()).toBe(true);
    expect(enrolled.preExecFailure()).toBeUndefined();

    const failed = strongScopeBackend(os, caps)!.open();
    failed.bind(999);
    failed.noteStatus(Buffer.from("enroll-failed\n"));
    expect(failed.enrolled()).toBe(false);
    expect(failed.preExecFailure()).toMatch(/could not enter its scope/);

    // A child that reported NOTHING never reached the checkpoint: we cannot claim it ran contained.
    const silent = strongScopeBackend(os, caps)!.open();
    silent.bind(1000);
    expect(silent.enrolled()).toBe(false);
    expect(silent.preExecFailure()).toMatch(/never reported entering its scope/);
  });
});

describe("liveness: the LEDGER's own re-probe of a scope it is about to settle", () => {
  it("a removed cgroup is dead; a cgroup that still exists is ALIVE (we never proved it empty)", () => {
    const os = new FakeCgroupFs();
    const caps = fakeCaps();
    const { scope } = openScope(os, caps, { tasks: 1 });
    const ref = scope.ref() as Extract<ScopeRef, { backend: "cgroup2" }>;

    expect(cgroupScopeAlive(ref, os)).toBe(true); // still there → never reaped
    expect(scopeAliveOf(ref, os, () => false)).toBe(true);

    os.tasks.set((scope as unknown as { path: string }).path, 0);
    os.rmdir((scope as unknown as { path: string }).path);
    expect(cgroupScopeAlive(ref, os)).toBe(false); // removed → and rmdir only succeeds when empty
    expect(scopeAliveOf(ref, os, () => false)).toBe(false);
    // …but a live process GROUP still blocks the settlement, even with the cgroup gone.
    expect(scopeAliveOf(ref, os, () => true)).toBe(true);
  });

  it("a cgroup we cannot even look at is treated as ALIVE (an unreadable scope is never a reaped one)", () => {
    const blind = osWith(new FakeCgroupFs(), { selfCgroupDir: () => undefined });
    expect(cgroupScopeAlive({ backend: "cgroup2", pid: 1, name: "loop-0123456789abcdef", ino: "1" }, blind)).toBe(true);
  });
});

describe("stale scopes: reclaimed only when OLD and provably empty", () => {
  it("removes an aged, empty leftover; keeps a young one and a populated one", () => {
    const os = new FakeCgroupFs();
    const old = `${os.root}/loop-aaaaaaaaaaaaaaaa`;
    const young = `${os.root}/loop-bbbbbbbbbbbbbbbb`;
    const busy = `${os.root}/loop-cccccccccccccccc`;
    const foreign = `${os.root}/some-other-service.scope`;
    for (const [p, age] of [
      [old, 20 * 60_000],
      [young, 5_000],
      [busy, 20 * 60_000],
      [foreign, 20 * 60_000]
    ] as const) {
      os.mkdir(p);
      os.dirs.get(p)!.ageMs = age;
    }
    os.tasks.set(busy, 1);

    expect(sweepStaleScopes(os, os.root)).toBe(1);
    expect(os.dirs.has(old)).toBe(false); // aged + empty → reclaimed
    expect(os.dirs.has(young)).toBe(true); // a concurrent run may have just created it — never sweep it
    expect(os.dirs.has(busy)).toBe(true); // still populated → evidence, not garbage
    expect(os.dirs.has(foreign)).toBe(true); // not a name we mint → never ours to remove
  });
});

/**
 * The ORPHAN reaper — the resume path. A SIGKILLed orchestrator leaves its agents alive (detached, in
 * their own cgroups, orphaned to init). `sweepStaleScopes` will not kill them, and MUST not: it cannot
 * tell a dead run's leftovers from a live concurrent run's fresh scope. A RESUMING run can, because it
 * holds the run's exclusive lease and is replaying its OWN durable record of what it launched.
 *
 * The inode is the interlock that makes that safe, and these tests are here to keep it.
 */
describe("reapAbandonedScope: killing the agents a crash orphaned", () => {
  const name = "loop-abcdef01";

  it("KILLS a scope that is still populated — that is the whole point (the sweeper refuses to)", () => {
    const os = new FakeCgroupFs();
    const path = `${os.root}/${name}`;
    os.mkdir(path);
    os.tasks.set(path, 1); // the orphaned agent, still running
    const ref: ScopeRef = { backend: "cgroup2", name, ino: os.inodeOf(path)!, pid: 4242 };

    expect(reapAbandonedScope(ref, os)).toBe("reaped"); // killed AND removed — the removal IS the proof
    expect(scopeProvenDead("reaped")).toBe(true);
    expect(os.kills).toContain(path); // cgroup.kill — recursive, so a setsid'd descendant dies too
    expect(os.dirs.has(path)).toBe(false); // and the removal is the emptiness proof

    // The generic sweeper, given the same live scope, would have left it alone even when ancient.
    const other = new FakeCgroupFs();
    const p2 = `${other.root}/${name}`;
    other.mkdir(p2);
    other.dirs.get(p2)!.ageMs = 60 * 60_000;
    other.tasks.set(p2, 1);
    expect(sweepStaleScopes(other, other.root)).toBe(0);
    expect(other.dirs.has(p2)).toBe(true);
  });

  it("NEVER kills a recycled name: a different INODE is a different cgroup, and not ours", () => {
    // The safety interlock. Names can be recreated; the kernel object cannot be forged. If the cgroup
    // wearing our old name is not the exact object we made, it belongs to someone else — killing it
    // would SIGKILL an unrelated (possibly concurrent) run's agents.
    const os = new FakeCgroupFs();
    const path = `${os.root}/${name}`;
    os.mkdir(path);
    os.tasks.set(path, 1);
    const stale: ScopeRef = { backend: "cgroup2", name, ino: "999999", pid: 4242 }; // our DEAD run's inode

    expect(reapAbandonedScope(stale, os)).toBe("foreign");
    expect(os.kills).toEqual([]); // nothing was killed…
    expect(os.dirs.has(path)).toBe(true); // …and the stranger's cgroup is untouched.
  });

  it("a scope that is already gone is `gone`, not an error", () => {
    const os = new FakeCgroupFs();
    const ref: ScopeRef = { backend: "cgroup2", name, ino: "1234", pid: 4242 };
    expect(reapAbandonedScope(ref, os)).toBe("gone");
  });

  it("refuses to blind-signal a bare PGID scope across a restart (the pid may have been REUSED)", () => {
    // A dead leader's pid can be recycled by an unrelated process, and a pgid scope carries no identity
    // that survives the crash. There is nothing here we can prove is ours, so we do nothing.
    const os = new FakeCgroupFs();
    expect(reapAbandonedScope({ backend: "pgid", pid: 4242 }, os)).toBe("unsupported");
  });

  it("never touches a cgroup whose NAME we could not have minted", () => {
    const os = new FakeCgroupFs();
    const path = `${os.root}/some-other-service.scope`;
    os.mkdir(path);
    os.tasks.set(path, 1);
    const ref = { backend: "cgroup2", name: "some-other-service.scope", ino: os.inodeOf(path)!, pid: 1 } as ScopeRef;

    expect(reapAbandonedScope(ref, os)).toBe("foreign");
    expect(os.dirs.has(path)).toBe(true);
    expect(os.kills).toEqual([]);
  });

  it("an UNKILLABLE survivor is `unresolved` — trying is NOT a proof", () => {
    // THE BUG THIS PINS: this used to return "killed" here, and the caller believed it. cgroup.kill was
    // written, rmdir threw EBUSY, the cgroup (and the process in it) remained — and the reaper still
    // said "reclaimed". The resumed run then cleared its durable scope record and re-dispatched the
    // task while the ghost was still running it: two agents, one task, and no pointer left to the ghost.
    //
    // "We did everything we could" is not a state a safety gate may report success from. The kernel
    // object is the only witness: rmdir succeeds ONLY on an empty cgroup, so while the directory stands,
    // something is still in it.
    const os = new FakeCgroupFs();
    const path = `${os.root}/${name}`;
    os.mkdir(path);
    os.tasks.set(path, 1);
    os.unkillable.add(path); // a task in D-state / unkillable — cgroup.kill lands but it survives
    const ref: ScopeRef = { backend: "cgroup2", name, ino: os.inodeOf(path)!, pid: 4242 };

    // timeoutMs: 0 — the fake tree kills synchronously, so there is no kernel to wait for. (The real
    // grace period, which lets the kernel finish dismantling the tasks cgroup.kill SIGKILLed, is what
    // tests/resume.test.ts exercises against real cgroups.)
    expect(reapAbandonedScope(ref, os, { timeoutMs: 0 })).toBe("unresolved");
    expect(scopeProvenDead("unresolved")).toBe(false); // ⇒ the run must fail closed
    expect(os.kills).toContain(path); // we DID try…
    expect(os.dirs.has(path)).toBe(true); // …and the cgroup REMAINS (rmdir EBUSY) — the ghost is still there.
    expect(os.tasks.get(path)).toBe(1); // it is not a bookkeeping artefact: the task is genuinely alive.
    expect(reapOutcomeAdvice("unresolved")).toMatch(/cgroup\.procs/); // and the operator is told what to do
  });

  it("only `reaped` and `gone` are ever treated as proof of death", () => {
    // The whole gate reduces to this predicate. An outcome added later defaults to NOT proven only if
    // someone keeps this honest, so state it explicitly.
    expect(scopeProvenDead("reaped")).toBe(true);
    expect(scopeProvenDead("gone")).toBe(true);
    for (const outcome of ["unresolved", "foreign", "unsupported"] as const) {
      expect(scopeProvenDead(outcome), `${outcome} must never count as proof`).toBe(false);
      expect(reapOutcomeAdvice(outcome).length).toBeGreaterThan(30); // every blocker is actionable
    }
  });
});

/**
 * The JOURNAL replay — `.loop_scopes` is the only thing that still knows where a crashed run's agents
 * are. It used to be BLANKED unconditionally after a reap pass, whatever the outcome, so an unkillable
 * survivor (or a foreign/unreadable line) lost both its evidence and the pointer to the ghost.
 *
 * Evidence is spent only when it is DISCHARGED.
 */
describe("recoverAbandonedScopes: the durable record is only cleared by a PROOF", () => {
  const id = (n: string, ino: string, pid = 4242) => `cgroup2:${ino}:${n}:${pid}`;

  it("drops proven-dead lines and RETAINS every line still owing a proof", () => {
    const dead = id("loop-aaaaaaaa", "1001");
    const absent = id("loop-bbbbbbbb", "1002");
    const ghost = id("loop-cccccccc", "1003");
    const stranger = id("loop-dddddddd", "1004");
    const record = [dead, absent, ghost, stranger].join("\n");

    const outcomes: Record<string, ReapOutcome> = {
      [dead]: "reaped",
      [absent]: "gone",
      [ghost]: "unresolved",
      [stranger]: "foreign"
    };
    const result = recoverAbandonedScopes(record, (ref) => outcomes[scopeIdOf(ref)]);

    expect(result.reaped).toEqual([dead]);
    // The two that were PROVEN dead are discharged; the two that were not are kept, in full.
    expect(result.retained).toEqual([ghost, stranger]);
    expect(result.unresolved.map((u) => u.id)).toEqual([ghost, stranger]);
    expect(result.unresolved.map((u) => u.outcome)).toEqual(["unresolved", "foreign"]);
    expect(result.unresolved.every((u) => u.advice.length > 30)).toBe(true);
  });

  it("clears the record ONLY when every scope in it is proven dead", () => {
    const a = id("loop-aaaaaaaa", "1001");
    const b = id("loop-bbbbbbbb", "1002");
    const all = recoverAbandonedScopes([a, b].join("\n"), () => "reaped");
    expect(all.retained).toEqual([]); // nothing owed ⇒ the journal is spent
    expect(all.unresolved).toEqual([]);

    // …but ONE unproven scope keeps the gate shut, even beside a successful reap.
    const one = recoverAbandonedScopes([a, b].join("\n"), (ref) => (ref.name === "loop-bbbbbbbb" ? "unresolved" : "reaped"));
    expect(one.retained).toEqual([b]);
    expect(one.unresolved).toHaveLength(1);
  });

  it("an UNPARSEABLE line fails closed — it is retained, not skipped", () => {
    // The old reaper did `if (!ref) continue`: a corrupt or truncated line was silently ignored AND then
    // wiped with the rest of the file. But a line we cannot READ is not a line we can prove is harmless
    // — it may be the last pointer to a live agent this run owns. We cannot reap it, so we keep it and
    // refuse to move.
    const good = id("loop-aaaaaaaa", "1001");
    const corrupt = "cgroup2:1003:loop-cccc"; // truncated — no pid; parseScopeId cannot read it
    const junk = "garbage";

    const result = recoverAbandonedScopes([good, corrupt, junk].join("\n"), () => "reaped");

    expect(result.reaped).toEqual([good]);
    expect(result.retained).toEqual([corrupt, junk]); // kept…
    expect(result.unresolved.map((u) => u.id)).toEqual([corrupt, junk]); // …and they BLOCK the run.
    expect(result.unresolved[0].advice).toMatch(/not a readable scope id/i);
  });

  it("a pgid scope is never blind-signalled, and never counts as proof either", () => {
    // Its pid may have been recycled by an unrelated process, so we must not signal it — but "we did not
    // look" is not "it is dead". It stays on the record and blocks.
    const result = recoverAbandonedScopes("pgid:4242", (ref) => reapAbandonedScope(ref, new FakeCgroupFs()));
    expect(result.retained).toEqual(["pgid:4242"]);
    expect(result.unresolved[0].outcome).toBe("unsupported");
  });

  it("an empty or whitespace-only journal is simply nothing to do", () => {
    for (const record of ["", "\n", "   \n\n  "]) {
      const result = recoverAbandonedScopes(record, () => {
        throw new Error("must not reap anything");
      });
      expect(result).toEqual({ reaped: [], retained: [], unresolved: [] });
    }
  });
});

describe("capability detection FAILS CLOSED", () => {
  const caps = fakeCaps();
  const strongOs = new FakeCgroupFs();

  it("no cgroup v2 → no strong backend, and real execution refuses to launch", () => {
    const os = osWith(strongOs, { selfCgroupDir: () => undefined });
    expect(strongScopeBackend(os, caps)).toBeUndefined();
    expect(() => requireScopeBackend(os, caps)).toThrow(/strong process scope/i);
  });

  it("a cgroup tree we cannot create in → no strong backend", () => {
    const os = osWith(strongOs, {
      mkdir: () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      }
    });
    expect(strongScopeBackend(os, caps)).toBeUndefined();
    expect(() => requireScopeBackend(os, caps)).toThrow(/not writable|strong process scope/i);
  });

  it("a kernel with no cgroup.kill → no strong backend (we could not kill what we cannot name)", () => {
    const os = osWith(strongOs, { readdir: () => ["cgroup.procs", "cgroup.events"] });
    expect(strongScopeBackend(os, caps)).toBeUndefined();
  });

  it("no /bin/sh → no strong backend (a scope we cannot launch into is not a scope)", () => {
    const os = osWith(strongOs, { shellExists: () => false });
    expect(strongScopeBackend(os, caps)).toBeUndefined();
  });

  it("the ONLY way past a missing strong scope is the imported trusted-runner test seam", () => {
    const os = osWith(strongOs, { selfCgroupDir: () => undefined });
    expect(() => requireScopeBackend(os, caps)).toThrow();
    setTrustedRunner(true);
    try {
      const weak = requireScopeBackend(os, caps);
      expect(weak.kind).toBe("pgid");
      expect(weak.strong).toBe(false); // and it is HONEST about being weak — it never claims containment
    } finally {
      setTrustedRunner(false);
    }
  });
});

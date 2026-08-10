import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFileSync as readFileSyncNode } from "node:fs";
import { symlinkSync } from "node:fs";
import { acquireRunLease, assertConfinedRealPath, isCancelled, requestCancel, clearCancel, leasePath, terminateGroupAwait, terminateScope, terminationInFlight, type ProcessScopeCaps } from "../src/runtime.js";

function runDir(): string {
  return mkdtempSync(join(tmpdir(), "loop-lease-"));
}

const HERE = dirname(fileURLToPath(import.meta.url));
const TSX = resolve(HERE, "..", "node_modules", "tsx", "dist", "cli.mjs");
const WORKER = resolve(HERE, "fixtures", "lease-worker.mjs");

/** Spawn N real OS processes that all race to acquire the same lease behind a start barrier. */
async function raceContenders(dir: string, n: number, opts: { staleFirst?: boolean } = {}): Promise<number> {
  const resultsDir = mkdtempSync(join(tmpdir(), "loop-lease-results-"));
  const barrier = join(resultsDir, "go");
  if (opts.staleFirst) {
    // Seed a STALE lease held by a dead pid, so contenders must reclaim it race-free.
    writeFileSync(leasePath(dir), `999999 stalenonce ${new Date().toISOString()}`);
  }
  // Stagger STARTUP (not the race) so 50 `tsx` boots don't spike every core at once and starve
  // sibling test files. The actual acquisition is synchronized by the barrier below, so the race
  // is still genuine — every contender waits at the barrier until all have arrived.
  const procs: ReturnType<typeof spawn>[] = [];
  for (let i = 0; i < n; i++) {
    procs.push(spawn("node", [TSX, WORKER, dir, resultsDir, barrier], { stdio: "ignore" }));
    await new Promise((r) => setTimeout(r, 15));
  }
  const exits = Promise.all(procs.map((p) => new Promise<void>((res) => p.on("close", () => res()))));
  const countReady = () => readdirSync(resultsDir).filter((f) => f.startsWith("ready-")).length;
  // Open the barrier only once EVERY contender has arrived, so they truly collide (tsx startup is
  // slow and variable — a fixed delay would let the winner acquire before the losers even start).
  const deadline = Date.now() + 40_000;
  while (countReady() < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  writeFileSync(barrier, "go");
  const countHolders = () => readdirSync(resultsDir).filter((f) => f.startsWith("holder-")).length;
  // Load-adaptive: wait until the winner has acquired (a holder marker appears), then wait a fixed
  // settle window to catch ANY split-brain second holder before counting.
  const holderDeadline = Date.now() + 20_000;
  while (countHolders() < 1 && Date.now() < holderDeadline) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 2500)); // settle: a racy design would reveal a 2nd holder here
  const holders = countHolders();
  // …then release the holder so all processes exit cleanly.
  writeFileSync(join(resultsDir, "stop"), "stop");
  await exits;
  return holders;
}

describe("path confinement — no symlinked parent component (wave-6)", () => {
  it("accepts a not-yet-created leaf directly under the trusted base", () => {
    const base = mkdtempSync(join(tmpdir(), "loop-confine-"));
    const target = join(base, "transcripts");
    expect(assertConfinedRealPath(base, target)).toBe(resolve(target));
  });

  it("accepts a real (non-symlink) nested directory chain", () => {
    const base = mkdtempSync(join(tmpdir(), "loop-confine-"));
    mkdirSync(join(base, "a", "b"), { recursive: true });
    expect(() => assertConfinedRealPath(base, join(base, "a", "b", "transcripts"))).not.toThrow();
  });

  it("REJECTS a symlinked parent component that redirects outside the base", () => {
    const base = mkdtempSync(join(tmpdir(), "loop-confine-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "loop-elsewhere-"));
    // Plant `base/transcripts` as a symlink pointing OUTSIDE the run tree; a file created under it
    // would escape confinement. The check must reject it (never follow it).
    symlinkSync(elsewhere, join(base, "transcripts"));
    expect(() => assertConfinedRealPath(base, join(base, "transcripts", "call.jsonl"))).toThrow(/confinement/i);
  });

  it("REJECTS a `..` escape out of the base", () => {
    const base = mkdtempSync(join(tmpdir(), "loop-confine-"));
    expect(() => assertConfinedRealPath(base, join(base, "..", "escape"))).toThrow(/confinement/i);
  });

  it("REJECTS an intermediate symlinked component even when the leaf name is innocent", () => {
    const base = mkdtempSync(join(tmpdir(), "loop-confine-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "loop-elsewhere-"));
    symlinkSync(elsewhere, join(base, "runs")); // intermediate component is the symlink
    expect(() => assertConfinedRealPath(base, join(base, "runs", "r1", "transcripts"))).toThrow(/confinement/i);
  });
});

describe("run lease (O_EXCL + nonce)", () => {
  it("grants exactly one holder; a second concurrent acquire is refused", () => {
    const dir = runDir();
    const a = acquireRunLease(dir);
    expect(() => acquireRunLease(dir)).toThrow(/already active/);
    a.release();
    // After release a fresh acquire succeeds.
    const b = acquireRunLease(dir);
    expect(b.nonce).toBeTruthy();
    b.release();
  });

  it("release only removes OUR lease, never a successor's (nonce guard)", () => {
    const dir = runDir();
    const a = acquireRunLease(dir);
    // Simulate a successor taking over the lease file with a different pid+nonce.
    writeFileSync(leasePath(dir), `${process.pid + 1} deadbeefdeadbeef ${new Date().toISOString()}`);
    a.release(); // must NOT delete the successor's lease
    expect(readFileSync(leasePath(dir), "utf8")).toContain("deadbeefdeadbeef");
  });

  it("reclaims a stale lease left by a dead process", () => {
    const dir = runDir();
    // A lease owned by a pid that is (almost certainly) not alive.
    writeFileSync(leasePath(dir), `999999 stalenonce ${new Date().toISOString()}`);
    const a = acquireRunLease(dir);
    expect(a.nonce).not.toBe("stalenonce");
    a.release();
  });
});

describe("lease is race-free under 50 concurrent OS processes (no split brain)", () => {
  it("50 contenders over a FRESH lease → EXACTLY ONE acquires", async () => {
    const dir = runDir();
    const holders = await raceContenders(dir, 50);
    expect(holders).toBe(1);
  }, 60000);

  it("50 contenders over a DEAD/STALE lease → EXACTLY ONE reclaims (never six)", async () => {
    const dir = runDir();
    const holders = await raceContenders(dir, 50, { staleFirst: true });
    expect(holders).toBe(1);
  }, 60000);
});

describe("awaited process-group teardown (item 13)", () => {
  it("TERM→KILL: a TERM-ignoring group is DEAD before terminateGroupAwait resolves", async () => {
    const results = mkdtempSync(join(tmpdir(), "loop-term-"));
    const pidFile = join(results, "pids.json");
    const IGNORER = resolve(HERE, "fixtures", "term-ignorer.mjs");
    const proc = spawn("node", [IGNORER, pidFile], { detached: true, stdio: "ignore" });
    // Wait for the fixture to record its parent+child pids.
    const deadline = Date.now() + 10_000;
    let pids: { parent: number; child: number } | undefined;
    while (Date.now() < deadline) {
      try {
        pids = JSON.parse(readFileSyncNode(pidFile, "utf8"));
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    expect(pids).toBeTruthy();
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive(pids!.parent)).toBe(true);
    expect(alive(pids!.child)).toBe(true);

    // A short grace forces the KILL escalation quickly; the call must not resolve until BOTH the
    // TERM-ignoring parent and its TERM-ignoring child are actually gone. Returns TRUE (proven gone).
    const gone = await terminateGroupAwait(proc.pid, 400);
    expect(gone).toBe(true);
    expect(alive(pids!.parent)).toBe(false);
    expect(alive(pids!.child)).toBe(false);
  }, 30000);

  it("tears down the GROUP even after the leader has already EXITED (item 9)", async () => {
    const results = mkdtempSync(join(tmpdir(), "loop-leader-"));
    const pidFile = join(results, "pids.json");
    const LEADER = resolve(HERE, "fixtures", "leader-exits.mjs");
    const proc = spawn("node", [LEADER, pidFile], { detached: true, stdio: "ignore" });
    const deadline = Date.now() + 10_000;
    let pids: { leader: number; child: number } | undefined;
    while (Date.now() < deadline) {
      try {
        pids = JSON.parse(readFileSyncNode(pidFile, "utf8"));
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    expect(pids).toBeTruthy();
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    // Give the leader a moment to exit; the same-PGID child must still be alive.
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(pids!.child)).toBe(true);
    // Tearing down the leader's GROUP (by pgid) must still reap the surviving descendant.
    const gone = await terminateGroupAwait(proc.pid, 400);
    expect(gone).toBe(true);
    expect(alive(pids!.child)).toBe(false);
  }, 30000);

  it("returns true immediately for an undefined/already-gone group", async () => {
    expect(await terminateGroupAwait(undefined)).toBe(true);
  });

  it("(wave-8b2) NEVER signals a positive PID and schedules NO signal after settle — injected caps", async () => {
    // wave-8b2 hazard: the removed `terminateGroup(pid, grace)` armed an UNOWNED `setTimeout(SIGKILL)`
    // that fired a REAL `kill(-pid, SIGKILL)` long after the owning call returned — and the old test
    // armed a 60 s timer under a mocked `process.kill`, then RESTORED the real syscall before the timer
    // fired. We now drive termination through an INJECTED fake capability: no real signal, no real
    // timer, a fake clock. Every signal target must be the negative group id; not one may be the bare
    // positive PID; and once the awaited teardown resolves, NO further signal may be recorded.
    const calls: Array<{ target: number; sig: NodeJS.Signals }> = [];
    let clock = 0;
    let disposed = false;
    // Model a group that is alive for the first probe, then reported gone after the first TERM — so the
    // sequence resolves without ever escalating to a positive-PID fallback.
    let alive = true;
    const caps: ProcessScopeCaps = {
      signalGroup: (pid, sig) => {
        if (disposed) throw new Error(`signal after disposal: ${pid} ${sig}`);
        expect(pid).toBe(4242); // runtime negates internally; caps receives the positive pid...
        calls.push({ target: -pid, sig }); // ...and MUST address only the negative group
        if (sig === "SIGTERM") alive = false; // TERM reaps the cooperative group
      },
      groupAlive: (_pid) => alive,
      sleep: async (ms) => {
        clock += ms; // advance the FAKE clock instead of waiting on a real timer
      },
      now: () => clock
    };
    const gone = await terminateScope(4242, 5000, caps);
    disposed = true; // dispose the capability; any later signal would now throw
    expect(gone).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    // Every recorded target is the NEGATIVE group id — never the positive PID 4242.
    expect(calls.every((c) => c.target < 0)).toBe(true);
    expect(calls.some((c) => c.target === 4242)).toBe(false);
    // No tracked termination remains registered, and — because the fake caps throw after disposal and
    // the test still passes — no signal fired after the awaited call resolved.
    expect(terminationInFlight(4242)).toBe(false);
    // Give any (nonexistent) stray microtask/timer a tick to prove none escalates post-settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.filter((c) => c.sig === "SIGKILL").length).toBe(0); // cooperative group never needed KILL
  });

  it("(wave-8b2) deduplicates concurrent terminations — repeated polls never STACK TERM/KILL", async () => {
    // A 1 Hz cancellation poll must not arm a fresh TERM→KILL every tick. Concurrent terminateScope
    // calls for the same live PGID must share ONE sequence: a hostile group that ignores TERM should
    // see exactly one TERM then one KILL across many concurrent initiators, not one pair per caller.
    const calls: Array<{ target: number; sig: NodeJS.Signals }> = [];
    let clock = 0;
    const caps: ProcessScopeCaps = {
      signalGroup: (pid, sig) => calls.push({ target: -pid, sig }),
      groupAlive: () => clock < 9000, // stays "alive" long enough to force the KILL escalation once
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock
    };
    // Fire five concurrent poll-style initiations; the map must fold them into ONE in-flight promise.
    expect(terminationInFlight(7777)).toBe(false);
    const results = await Promise.all(Array.from({ length: 5 }, () => terminateScope(7777, 5000, caps)));
    expect(results.every((r) => r === true)).toBe(true);
    // Exactly ONE TERM and ONE KILL total across all five callers — no stacking.
    expect(calls.filter((c) => c.sig === "SIGTERM").length).toBe(1);
    expect(calls.filter((c) => c.sig === "SIGKILL").length).toBe(1);
    expect(calls.every((c) => c.target === -7777)).toBe(true);
    expect(terminationInFlight(7777)).toBe(false); // self-cleans after settle
  });
});

describe("cancellation flag is durable (not cleared on startup)", () => {
  it("persists until explicitly cleared", () => {
    const dir = runDir();
    expect(isCancelled(dir)).toBe(false);
    requestCancel(dir, "stop");
    expect(isCancelled(dir)).toBe(true);
    clearCancel(dir);
    expect(isCancelled(dir)).toBe(false);
  });
});

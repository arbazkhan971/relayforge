import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runHeadlessChild } from "../src/orchestrator.js";
import { detectScopeCapability, parseScopeId, pgidScopeBackend, requireScopeBackend } from "../src/scope.js";

/**
 * THE CONTAINMENT PROOF — a REAL Linux integration test, not a simulation.
 *
 * The fixture is a provider that does the one thing a process group cannot survive: it `setsid`s and
 * double-forks a daemon, which is then re-parented to init with a process group of its own. Every signal
 * and every liveness probe the transport used to have addressed `-pgid`, so the moment the leader exited,
 * `kill(-pgid, 0)` returned ESRCH and the turn reported `scopeReaped: true` — over a provider process
 * that was still running. That is the hole this slice closes, and these tests fail if it reopens.
 *
 * Each test PROVES the escapee's fate by pid: the process either answers `kill(pid, 0)` or it does not.
 */

const HERE = resolve(import.meta.dirname);
const FIXTURE = resolve(HERE, "fixtures/escape-artist.mjs");
const PATH = process.env.PATH ?? "/usr/bin:/bin";

// The strong backend needs a delegated cgroup v2. Where there is none, the transport is meant to FAIL
// CLOSED rather than pretend — which is itself asserted below, so nothing here is silently skipped.
const capability = detectScopeCapability();

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "loop-contain-"));
  tmps.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"; // EPERM = alive but not ours
  }
}

/** The escapee's identity, as it published it before the leader exited. */
type Escape = { leader: number; leaderPgid: number; escapee: number; escapeePgid: number };
function escapeOf(pidFile: string): Escape {
  return JSON.parse(readFileSync(pidFile, "utf8")) as Escape;
}

function fakeCtx(): any {
  // A real scope journal: the launch handshake fsyncs the scope's identity into it before the provider
  // is released to exec, so a context without one cannot launch a provider at all (by design).
  return { children: new Set(), ownedGroups: new Set(), ownedScopes: new Set(), loop: { cadenceMinutes: 5 }, scopesPath: join(tmp(), ".loop_scopes") };
}

describe.skipIf(!capability.strong)("(wave-10) a provider's descendants cannot escape the owned scope", () => {
  it("a setsid + double-forked daemon that outlives a CLEAN leader close is KILLED, and the turn is UNCERTAIN", async () => {
    const ctx = fakeCtx();
    const dir = tmp();
    const pidFile = join(dir, "escape.json");
    const r = await runHeadlessChild(ctx, "node", [FIXTURE, pidFile, "exit"], { PATH }, "", dir, undefined, undefined, 30_000, "claude");

    const esc = escapeOf(pidFile);
    // The escape was REAL: the daemon lives in its own process group, so `kill(-leaderPgid, …)` — the only
    // reach the old transport had — could never have signalled or even seen it.
    expect(esc.escapeePgid).not.toBe(esc.leaderPgid);
    // And yet it is dead, because it never left the CGROUP: `cgroup.kill` reaches every member, whatever
    // session, process group, or parent it has arranged for itself.
    expect(alive(esc.escapee), "the escaped daemon survived the turn — containment is broken").toBe(false);

    // The leader exited 0 with a perfect terminal record, and the turn is STILL uncertain: the provider
    // left live scope behind, so nothing it said can be trusted (and no fallback may be authorized).
    expect(r.transportOk).toBe(false);
    expect(r.scopeTrusted).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.code).toBeNull();
    expect(r.uncertainReason ?? "").toMatch(/scope|descendant/i);

    // The scope is a cgroup2 scope, it was torn down, and it is no longer owned by the run.
    expect(parseScopeId(r.scopeId)?.backend).toBe("cgroup2");
    expect(ctx.ownedScopes.size).toBe(0);
    expect(ctx.ownedGroups.size).toBe(0);
  }, 60_000);

  it("a descendant that outlives a TIMEOUT is killed too, and the timed-out turn proves its scope empty", async () => {
    const ctx = fakeCtx();
    const dir = tmp();
    const pidFile = join(dir, "escape.json");
    // `hang` never exits: the turn can only end at its timeout, with the escapee still running. The timeout
    // is generous on purpose — under a loaded machine the escapee needs time to boot and publish its pid,
    // and a turn that timed out BEFORE the escape happened would prove nothing.
    const r = await runHeadlessChild(ctx, "node", [FIXTURE, pidFile, "hang"], { PATH }, "", dir, undefined, undefined, 15_000, "claude");

    const esc = escapeOf(pidFile);
    expect(esc.escapeePgid).not.toBe(esc.leaderPgid);
    expect(alive(esc.escapee), "the escaped daemon survived the timeout reap").toBe(false);
    expect(alive(esc.leader)).toBe(false);

    expect(r.transportOk).toBe(false);
    expect(r.uncertainReason ?? "").toMatch(/timeout/);
    // A timed-out turn never carries scope trust — but its scope must still be PROVEN empty, or the run
    // would be cleaning up over live provider processes.
    expect(r.scopeTrusted).toBe(false);
    expect(ctx.ownedScopes.size).toBe(0);
  }, 60_000);

  it("the scope's cgroup is REMOVED when it is proven empty (and removal is what proves it)", async () => {
    const ctx = fakeCtx();
    const dir = tmp();
    const fixture = resolve(HERE, "fixtures/echo-stdin-success.mjs");
    const r = await runHeadlessChild(ctx, "node", [fixture], { PATH }, "", dir, "p");
    expect(r.ok).toBe(true);
    expect(r.scopeTrusted).toBe(true);

    const ref = parseScopeId(r.scopeId);
    expect(ref?.backend).toBe("cgroup2");
    // `rmdir` of a cgroup FAILS while any task or child cgroup remains, so the fact that the directory is
    // gone IS the kernel's attestation that the scope was empty — which is exactly what the reap proof says.
    const root = (capability as { strong: true; root: string }).root;
    const name = ref!.backend === "cgroup2" ? ref!.name : "";
    expect(existsSync(join(root, name))).toBe(false);
    expect(r.scopeReapProof).toBe(`cgroup2-empty:RMDIR:${(ref as any).ino}:${name}+pgid-empty:ESRCH:${ref!.pid}`);
    expect(r.scopeReaped).toBe(true);
    expect(ctx.ownedScopes.size).toBe(0);
  }, 30_000);
});

describe.skipIf(!capability.strong)("the WEAK pgid backend is exactly what the strong one replaces", () => {
  it("proves the escape it cannot contain — the same daemon SURVIVES a pgid-scoped turn", async () => {
    // This is the vulnerability, reproduced against the legacy backend so the test above cannot pass by
    // accident (e.g. if the fixture stopped escaping). The pgid transport reports the scope EMPTY — its
    // ESRCH probe is telling the truth about the process GROUP and lying about the provider.
    const ctx = { ...fakeCtx(), scopeBackend: pgidScopeBackend() };
    const dir = tmp();
    const pidFile = join(dir, "escape.json");
    const r = await runHeadlessChild(ctx, "node", [FIXTURE, pidFile, "exit"], { PATH }, "", dir, undefined, undefined, 30_000, "claude");

    const esc = escapeOf(pidFile);
    try {
      expect(alive(esc.escapee), "the fixture did not actually escape its process group").toBe(true);
      // …and the weak transport happily called that scope reaped. THIS is what the cgroup scope fixes.
      expect(r.scopeReaped).toBe(true);
      expect(parseScopeId(r.scopeId)?.backend).toBe("pgid");
      expect(r.scopeReapProof).toBe(`pgid-empty:ESRCH:${esc.leaderPgid}`);
    } finally {
      // The weak backend leaves it running, so this test must clean up after itself by pid.
      try {
        process.kill(esc.escapee, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    // Vitest's own cgroup still holds it, but nothing in the RUN could have killed it.
    await new Promise((r2) => setTimeout(r2, 200));
    expect(alive(esc.escapee)).toBe(false);
  }, 60_000);
});

describe("fail closed: no strong scope, no provider", () => {
  it("`requireScopeBackend` never silently downgrades to the weak backend", () => {
    if (capability.strong) {
      expect(requireScopeBackend().kind).toBe("cgroup2");
      expect(requireScopeBackend().strong).toBe(true);
    } else {
      // No delegated cgroup here: real execution must THROW rather than run a provider it cannot contain.
      expect(() => requireScopeBackend()).toThrow(/strong process scope/i);
    }
  });
});

// The gated suites below manufacture REAL settlement evidence, which pre-creates process
// scopes (delegated cgroup subtrees). Inside the verifier jail /sys/fs/cgroup is read-only,
// so the environment cannot provide a scope at all — the same honest skip containment.test.ts
// uses. On a delegated host nothing is skipped. P0 debt: delegate the verifier's own scope
// subtree into the jail, then remove these guards.
const SCOPE_CAPABILITY = detectScopeCapability();

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runHeadlessChild } from "../src/orchestrator.js";
import { detectScopeCapability, parseScopeId, pgidScopeBackend } from "../src/scope.js";

/**
 * THE DURABLE LAUNCH HANDSHAKE — a provider never executes, and never survives, unrecorded.
 *
 * The orphan reaper (`reapAbandonedScopes`) is the only thing that can kill an agent whose orchestrator
 * was SIGKILLed mid-turn, and it can only reap a scope the run WROTE DOWN. The scope journal was
 * therefore appended best-effort, AFTER `spawn` returned — which left two holes wide enough to strand a
 * live agent forever:
 *
 *   1. ORDERING. `spawn` returns as soon as the child is forked; the child races ahead and execs the
 *      provider while the parent is still on its way to `appendFileSync`. A SIGKILL (or a power cut) in
 *      that window leaves a real provider — calling the model, spending money, writing into an attempt
 *      worktree the resumed run is about to reclaim — inside a cgroup whose name NOTHING on disk knows.
 *   2. DURABILITY. The append was wrapped in `try {} catch {}` and never fsynced. A full disk, a
 *      read-only run directory, an EIO on the journal: all silently ignored, and the turn ran anyway.
 *
 * The fix is a pre-exec GATE (src/scope.ts): the spawned child enrols into its scope and then BLOCKS,
 * having exec'd nothing, until the parent has appended AND fsynced its exact identity. Only then is it
 * released. If the journal cannot be made durable, the gate is closed instead: the child exits without
 * ever exec'ing, and the run kills it and PROVES its scope empty before reporting an actionable failure.
 *
 * These tests inject that failure deterministically and assert the two halves of the invariant, by
 * physical evidence rather than by log message: the provider's marker file does not exist (it never
 * executed) and its scope holds nothing (it did not survive).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WITNESS = resolve(HERE, "fixtures/exec-witness.mjs");
const PATH = process.env.PATH ?? "/usr/bin:/bin";
const capability = detectScopeCapability();

const ROOT = resolve(HERE, ".tmp-launch-handshake");
mkdirSync(ROOT, { recursive: true, mode: 0o700 });
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/** One run tree: a work dir, a marker path the provider writes IFF it executes, and a scope journal. */
function openRun(): { dir: string; marker: string; journal: string } {
  const dir = mkdtempSync(join(ROOT, "run-"));
  return { dir, marker: join(dir, "provider-executed.json"), journal: join(dir, ".loop_scopes") };
}

function ctxFor(journal: string, over: Record<string, unknown> = {}): any {
  return { children: new Set(), ownedGroups: new Set(), ownedScopes: new Set(), loop: { cadenceMinutes: 5 }, scopesPath: journal, ...over };
}

/** The witness provider: writes `marker` the instant it execs, then lingers so a process that was never
 *  supposed to run cannot escape detection by exiting first. */
function witnessArgs(marker: string, journal: string, lingerMs: number): string[] {
  return [WITNESS, marker, journal, String(lingerMs)];
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"; // EPERM = alive, just not ours to signal
  }
}

const settle = (ms = 300): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!SCOPE_CAPABILITY.strong)("the launch handshake: no provider EXECUTES before its scope is durably journaled", () => {
  it("orders the fsynced journal BEFORE the exec — the provider finds its OWN scope id already on disk", async () => {
    const { dir, marker, journal } = openRun();
    const ctx = ctxFor(journal);
    const r = await runHeadlessChild(ctx, "node", witnessArgs(marker, journal, 0), { PATH }, "", dir, undefined, undefined, 30_000, "claude");

    expect(r.ok).toBe(true);
    // The provider read the journal in its FIRST statement, and its own scope's identity was already
    // there — durably, fsynced. That is the ordering, witnessed from inside the provider itself, not
    // inferred from the parent's control flow.
    const witnessed = JSON.parse(readFileSync(marker, "utf8")) as { pid: number; journal: string };
    expect(r.scopeId).toBeTruthy();
    expect(witnessed.journal).toContain(r.scopeId!);
    // …and the pid in that scope id IS the process that ran (the trampoline `exec`s, so same pid).
    expect(parseScopeId(r.scopeId)?.pid).toBe(witnessed.pid);
  }, 30_000);

  it("REFUSES the launch when the journal cannot be appended (EISDIR): no provider executes, none survives", async () => {
    const { dir, marker } = openRun();
    // A journal path that is a DIRECTORY: the durable append fails with EISDIR on the real filesystem —
    // no seam, no mock. Stands in for the production cases (full disk, read-only run dir, EACCES).
    const journal = join(dir, "unwritable-journal");
    mkdirSync(journal, { mode: 0o700 });

    const ctx = ctxFor(journal);
    const r = await runHeadlessChild(ctx, "node", witnessArgs(marker, journal, 60_000), { PATH }, "", dir, undefined, undefined, 30_000, "claude");

    // NOTHING EXECUTED. The gated child was a shell blocked on a read; it never became the provider.
    await settle();
    expect(existsSync(marker), "the provider EXECUTED despite an unrecordable scope").toBe(false);

    // NOTHING SURVIVED. The scope was killed and PROVEN empty (that proof is what `scopeTrusted` means
    // here), the run owns no scope or group afterwards, and the leader's pid is gone.
    expect(r.scopeTrusted).toBe(true);
    expect(ctx.ownedScopes.size).toBe(0);
    expect(ctx.ownedGroups.size).toBe(0);
    expect(ctx.children.size).toBe(0);
    const ref = parseScopeId(r.scopeId);
    expect(ref).toBeDefined();
    expect(alive(ref!.pid), "the gated child survived the refused launch").toBe(false);
    if (ref?.backend === "cgroup2" && capability.strong) {
      expect(existsSync(join(capability.root, ref.name)), "the refused launch left its cgroup behind").toBe(false);
    }

    // The run FAILS, and says something an operator can act on: what could not be recorded, where, and
    // that no provider ran. No exit code, no verdict, no success — this turn has no authority at all.
    expect(r.ok).toBe(false);
    expect(r.transportOk).toBe(false);
    expect(r.code).toBeNull();
    expect(r.streamedVerdict).toBeUndefined();
    expect(r.scopeReaped).toBe(false);
    expect(r.uncertainReason ?? "").toMatch(/launch refused/i);
    expect(r.uncertainReason ?? "").toContain(journal); // WHICH file failed
    expect(r.uncertainReason ?? "").toMatch(/no provider was executed/i);
    expect(r.uncertainReason ?? "").toMatch(/re-run/i); // and what to do about it
  }, 40_000);

  it("REFUSES the launch when the journal's FSYNC fails — a write in the page cache is not a record", async () => {
    const { dir, marker, journal } = openRun();
    // The append SUCCEEDS; only the fsync fails (EIO on a dying disk / ENOSPC on a full journal fs). The
    // bytes exist in the page cache and are worth nothing: a crash loses them, and with them the only
    // pointer to a live agent. Durability is the fsync, so this must fail exactly like a failed write.
    const ctx = ctxFor(journal, {
      scopeJournalFsync: () => {
        throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
      }
    });
    const r = await runHeadlessChild(ctx, "node", witnessArgs(marker, journal, 60_000), { PATH }, "", dir, undefined, undefined, 30_000, "claude");

    await settle();
    expect(existsSync(marker), "the provider EXECUTED on a scope record that was never made durable").toBe(false);
    expect(r.ok).toBe(false);
    expect(r.transportOk).toBe(false);
    expect(r.uncertainReason ?? "").toMatch(/launch refused/i);
    expect(r.uncertainReason ?? "").toMatch(/EIO/);

    // Reaped to proof, and nothing is left owned or alive.
    expect(r.scopeTrusted).toBe(true);
    expect(ctx.ownedScopes.size).toBe(0);
    expect(ctx.ownedGroups.size).toBe(0);
    expect(alive(parseScopeId(r.scopeId)!.pid), "the gated child survived the refused launch").toBe(false);
  }, 40_000);

  it("holds on the WEAK pgid backend too — the invariant is the run's, not the backend's", async () => {
    const { dir, marker } = openRun();
    const journal = join(dir, "unwritable-journal");
    mkdirSync(journal, { mode: 0o700 });

    const ctx = ctxFor(journal, { scopeBackend: pgidScopeBackend() });
    const r = await runHeadlessChild(ctx, "node", witnessArgs(marker, journal, 60_000), { PATH }, "", dir, undefined, undefined, 30_000, "claude");

    await settle();
    expect(existsSync(marker), "the provider EXECUTED under the pgid backend despite an unrecordable scope").toBe(false);
    expect(parseScopeId(r.scopeId)?.backend).toBe("pgid");
    expect(alive(parseScopeId(r.scopeId)!.pid)).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.uncertainReason ?? "").toMatch(/launch refused/i);
    expect(ctx.ownedGroups.size).toBe(0);
  }, 40_000);

  it("records EVERY launch, in order, and each line is the exact scope the turn reports", async () => {
    const { dir, marker, journal } = openRun();
    const ids: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const ctx = ctxFor(journal);
      const r = await runHeadlessChild(ctx, "node", witnessArgs(`${marker}.${i}`, journal, 0), { PATH }, "", dir, undefined, undefined, 30_000, "claude");
      expect(r.ok).toBe(true);
      ids.push(r.scopeId!);
    }
    // The journal is an append-only record of what this run launched — the resume path replays it line by
    // line (`recoverAbandonedScopes`), so a lost or reordered line is a lost agent.
    expect(readFileSync(journal, "utf8").split("\n").filter(Boolean)).toEqual(ids);
    for (const id of ids) expect(parseScopeId(id)).toBeDefined();
  }, 40_000);

  it("commits the exact PID/start-ticks callback while the provider is still gated", async () => {
    const { dir, marker, journal } = openRun();
    const ctx = ctxFor(journal);
    let observed: { pid: number; processStartToken: string } | undefined;
    const r = await runHeadlessChild(
      ctx,
      "node",
      witnessArgs(marker, journal, 0),
      { PATH },
      "",
      dir,
      undefined,
      undefined,
      30_000,
      "claude",
      undefined,
      {
        beforeProviderExec: (identity) => {
          expect(existsSync(marker), "provider executed before its canonical start fact").toBe(false);
          observed = identity;
        }
      }
    );
    expect(r.ok).toBe(true);
    expect(observed).toEqual({
      pid: JSON.parse(readFileSync(marker, "utf8")).pid,
      processStartToken: expect.stringMatching(/^[1-9][0-9]*$/)
    });
  }, 30_000);

  it("refuses provider exec when the canonical attempt-start callback fails", async () => {
    const { dir, marker, journal } = openRun();
    const ctx = ctxFor(journal);
    const r = await runHeadlessChild(
      ctx,
      "node",
      witnessArgs(marker, journal, 60_000),
      { PATH },
      "",
      dir,
      undefined,
      undefined,
      30_000,
      "claude",
      undefined,
      { beforeProviderExec: () => { throw new Error("canonical store unavailable"); } }
    );
    await settle();
    expect(existsSync(marker), "provider executed without a canonical attempt-start fact").toBe(false);
    expect(r.ok).toBe(false);
    expect(r.scopeTrusted).toBe(true);
    expect(r.uncertainReason).toMatch(/canonical attempt-start fact failed/);
    expect(ctx.ownedScopes.size).toBe(0);
    expect(ctx.ownedGroups.size).toBe(0);
  }, 40_000);
});

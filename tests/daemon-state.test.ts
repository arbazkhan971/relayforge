import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PROBE_GRACE_MS,
  appendFact,
  canAutoTerminate,
  countFactLines,
  deriveDisplayStatus,
  foldState,
  initDaemonState,
  readFacts,
  readToken,
  sessionsWithStatus,
  type SessionView
} from "../src/daemon/state.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loop-daemon-"));
  initDaemonState(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-07-16T12:00:00Z");

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "s1",
    project: "demo",
    run: "run-1",
    role: "be",
    provider: "luna",
    tmuxSession: "loop-demo-run-1-team",
    createdAt: new Date(NOW - 60_000).toISOString(),
    activity: "active",
    lastActivityAt: new Date(NOW - 10_000).toISOString(),
    isTerminated: false,
    ...overrides
  };
}

describe("daemon state fold", () => {
  it("folds projects and sessions from the fact log", () => {
    appendFact(dir, { type: "project-added", ts: "t1", name: "demo", path: "/tmp/demo" });
    appendFact(dir, {
      type: "session-created",
      ts: "t2",
      id: "s1",
      project: "demo",
      run: "run-1",
      role: "be",
      provider: "luna",
      tmuxSession: "loop-demo-run-1-team"
    });
    appendFact(dir, { type: "session-activity", ts: "t3", id: "s1", state: "idle", note: "waiting for tests" });
    appendFact(dir, { type: "session-pr", ts: "t4", id: "s1", prRef: "octo/repo#12" });

    const state = foldState(readFacts(dir));

    expect(state.projects).toEqual([{ name: "demo", path: "/tmp/demo", addedAt: "t1" }]);
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]).toMatchObject({
      id: "s1",
      activity: "idle",
      lastNote: "waiting for tests",
      prRef: "octo/repo#12",
      isTerminated: false
    });
  });

  it("first session-created wins and termination is sticky", () => {
    appendFact(dir, {
      type: "session-created",
      ts: "t1",
      id: "s1",
      project: "demo",
      run: "run-1",
      role: "be",
      provider: "luna",
      tmuxSession: "team-a"
    });
    appendFact(dir, { type: "session-terminated", ts: "t2", id: "s1", reason: "killed via API" });
    appendFact(dir, {
      type: "session-created",
      ts: "t3",
      id: "s1",
      project: "demo",
      run: "run-1",
      role: "be",
      provider: "luna",
      tmuxSession: "team-b"
    });
    appendFact(dir, { type: "session-activity", ts: "t4", id: "s1", state: "idle" });

    const state = foldState(readFacts(dir));

    expect(state.sessions[0].tmuxSession).toBe("team-a");
    expect(state.sessions[0].isTerminated).toBe(true);
    // Activity after termination is ignored — terminated sessions never resurrect.
    expect(state.sessions[0].activity).toBe("active");
  });

  it("skips torn lines instead of crashing", () => {
    appendFact(dir, { type: "project-added", ts: "t1", name: "demo", path: "/x" });
    appendFileSync(join(dir, "facts.jsonl"), '{"type":"project-add');
    expect(readFacts(dir)).toHaveLength(1);
    expect(countFactLines(dir)).toBe(2);
  });

  it("supports the watermark used by the SSE tail", () => {
    appendFact(dir, { type: "project-added", ts: "t1", name: "a", path: "/a" });
    appendFact(dir, { type: "project-added", ts: "t2", name: "b", path: "/b" });
    const fresh = readFacts(dir, 1);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ name: "b" });
  });

  it("writes a token on init", () => {
    expect(readToken(dir)).toMatch(/^[0-9a-f]{48}$/);
  });
});

describe("display status derivation", () => {
  it("never stores status — derives with strict precedence", () => {
    // Termination beats everything.
    expect(
      deriveDisplayStatus(session({ isTerminated: true, activity: "waiting_input" }), { tmuxAlive: true, nowMs: NOW })
    ).toBe("terminated");
    // Input/blocked beat liveness.
    expect(deriveDisplayStatus(session({ activity: "waiting_input" }), { tmuxAlive: false, nowMs: NOW })).toBe(
      "waiting_input"
    );
    expect(deriveDisplayStatus(session({ activity: "blocked" }), { tmuxAlive: true, nowMs: NOW })).toBe("blocked");
    // Live sessions map activity → working/idle.
    expect(deriveDisplayStatus(session({ activity: "active" }), { tmuxAlive: true, nowMs: NOW })).toBe("working");
    expect(deriveDisplayStatus(session({ activity: "idle" }), { tmuxAlive: true, nowMs: NOW })).toBe("idle");
  });

  it("treats a failed probe as unknown, not death", () => {
    const recent = session({ activity: "active", lastActivityAt: new Date(NOW - 5_000).toISOString() });
    expect(deriveDisplayStatus(recent, { tmuxAlive: false, nowMs: NOW })).toBe("unknown");

    const stale = session({
      activity: "active",
      lastActivityAt: new Date(NOW - PROBE_GRACE_MS - 1_000).toISOString()
    });
    expect(deriveDisplayStatus(stale, { tmuxAlive: false, nowMs: NOW })).toBe("exited");
    expect(deriveDisplayStatus(session({ activity: "exited" }), { tmuxAlive: false, nowMs: NOW })).toBe("exited");
  });

  it("auto-termination requires confluence of signals", () => {
    // Alive tmux → never.
    expect(canAutoTerminate(session({ activity: "exited" }), { tmuxAlive: true, nowMs: NOW })).toBe(false);
    // Dead tmux but recent activity → not yet.
    expect(canAutoTerminate(session({ activity: "active" }), { tmuxAlive: false, nowMs: NOW })).toBe(false);
    // Dead tmux + reported exit → yes.
    expect(canAutoTerminate(session({ activity: "exited" }), { tmuxAlive: false, nowMs: NOW })).toBe(true);
    // Dead tmux + silence past the grace window → yes.
    expect(
      canAutoTerminate(
        session({ lastActivityAt: new Date(NOW - PROBE_GRACE_MS - 1_000).toISOString() }),
        { tmuxAlive: false, nowMs: NOW }
      )
    ).toBe(true);
    // Already terminated → nothing more to do.
    expect(canAutoTerminate(session({ isTerminated: true }), { tmuxAlive: false, nowMs: NOW })).toBe(false);
  });

  it("attaches derived status per session via the probe", () => {
    appendFact(dir, {
      type: "session-created",
      ts: new Date(NOW - 1_000).toISOString(),
      id: "s1",
      project: "demo",
      run: "run-1",
      role: "be",
      provider: "luna",
      tmuxSession: "alive-session"
    });
    appendFact(dir, {
      type: "session-created",
      ts: new Date(NOW - 1_000).toISOString(),
      id: "s2",
      project: "demo",
      run: "run-1",
      role: "fe",
      provider: "sol",
      tmuxSession: "dead-session"
    });

    const withStatus = sessionsWithStatus(foldState(readFacts(dir)), (name) => name === "alive-session", NOW);

    expect(withStatus.find((s) => s.id === "s1")?.status).toBe("working");
    expect(withStatus.find((s) => s.id === "s2")?.status).toBe("unknown");
  });
});

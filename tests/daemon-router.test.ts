import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { foldBoard } from "../src/board.js";
import { observePrFacts } from "../src/daemon/github.js";
import { pollFeedbackOnce } from "../src/daemon/poller.js";
import {
  appendRoutedKeys,
  readRoutedKeys,
  routeFeedback,
  type PrFacts
} from "../src/daemon/router.js";
import { appendFact, foldState, initDaemonState, readFacts, type SessionView } from "../src/daemon/state.js";

const NOW = "2026-07-16T12:00:00.000Z";

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "s1",
    project: "demo",
    run: "run-1",
    role: "be",
    provider: "luna",
    tmuxSession: "team",
    branch: "feat/login-rate-limit",
    createdAt: NOW,
    activity: "active",
    lastActivityAt: NOW,
    isTerminated: false,
    ...overrides
  };
}

function facts(overrides: Partial<PrFacts> = {}): PrFacts {
  return {
    prRef: "https://github.com/octo/repo/pull/12",
    state: "open",
    mergeable: true,
    checks: [],
    reviewThreads: [],
    ...overrides
  };
}

describe("feedback router decisions", () => {
  it("routes a failing CI check into a repair task with the log tail", () => {
    const routed = routeFeedback(
      session(),
      facts({
        checks: [
          { name: "ci/tests", status: "completed", conclusion: "failure", logTail: "AssertionError: expected 429" },
          { name: "ci/lint", status: "completed", conclusion: "success" },
          { name: "ci/build", status: "in_progress" }
        ]
      }),
      new Set(),
      NOW
    );

    expect(routed).toHaveLength(1);
    expect(routed[0].key).toBe("https://github.com/octo/repo/pull/12:ci:ci/tests");
    expect(routed[0].task).toMatchObject({
      assignee: "be",
      createdBy: "daemon-router",
      priority: 9
    });
    expect(routed[0].task.title).toContain("ci/tests");
    expect(routed[0].task.description).toContain("AssertionError: expected 429");
  });

  it("routes unresolved review threads with file/line context and skips resolved ones", () => {
    const routed = routeFeedback(
      session(),
      facts({
        reviewThreads: [
          { id: "rt1", resolved: false, path: "src/login.ts", line: 42, author: "qa-bot", body: "Missing 429 retry-after header" },
          { id: "rt2", resolved: true, path: "src/other.ts", body: "done already" }
        ]
      }),
      new Set(),
      NOW
    );

    expect(routed).toHaveLength(1);
    expect(routed[0].task.title).toContain("src/login.ts:42");
    expect(routed[0].task.description).toContain("qa-bot");
    expect(routed[0].task.description).toContain("Missing 429 retry-after header");
    expect(routed[0].task.priority).toBe(7);
  });

  it("routes a merge conflict as a rebase task, but unknown mergeability routes nothing", () => {
    const conflicted = routeFeedback(session(), facts({ mergeable: false }), new Set(), NOW);
    expect(conflicted).toHaveLength(1);
    expect(conflicted[0].task.title).toContain("merge conflict");
    expect(conflicted[0].task.priority).toBe(8);

    expect(routeFeedback(session(), facts({ mergeable: null }), new Set(), NOW)).toHaveLength(0);
  });

  it("deduplicates via alreadyRouted and never routes for closed/merged PRs", () => {
    const ci = facts({ checks: [{ name: "ci/tests", status: "completed", conclusion: "failure" }] });
    const first = routeFeedback(session(), ci, new Set(), NOW);
    const again = routeFeedback(session(), ci, new Set(first.map((r) => r.key)), NOW);
    expect(again).toHaveLength(0);

    expect(routeFeedback(session(), { ...ci, state: "merged" }, new Set(), NOW)).toHaveLength(0);
    expect(routeFeedback(session(), { ...ci, state: "closed" }, new Set(), NOW)).toHaveLength(0);
  });
});

describe("gh output parsing", () => {
  it("parses gh pr view JSON into PR facts", () => {
    const ghJson = JSON.stringify({
      number: 12,
      url: "https://github.com/octo/repo/pull/12",
      state: "OPEN",
      mergeable: "CONFLICTING",
      statusCheckRollup: [
        { name: "ci/tests", status: "COMPLETED", conclusion: "FAILURE" },
        { name: "ci/build", status: "IN_PROGRESS", conclusion: "" }
      ],
      reviewThreads: [
        {
          id: "rt1",
          isResolved: false,
          path: "src/login.ts",
          line: 42,
          comments: [{ body: "Add a test", author: { login: "reviewer" } }]
        }
      ]
    });

    const observed = observePrFacts("feat/x", undefined, () => ({ status: 0, stdout: ghJson }));

    expect(observed).toMatchObject({
      prRef: "https://github.com/octo/repo/pull/12",
      state: "open",
      mergeable: false
    });
    expect(observed?.checks).toEqual([
      { name: "ci/tests", status: "completed", conclusion: "failure" },
      { name: "ci/build", status: "in_progress", conclusion: undefined }
    ]);
    expect(observed?.reviewThreads[0]).toMatchObject({
      id: "rt1",
      resolved: false,
      path: "src/login.ts",
      line: 42,
      author: "reviewer",
      body: "Add a test"
    });
  });

  it("returns undefined when gh fails or emits junk", () => {
    expect(observePrFacts("feat/x", undefined, () => ({ status: 1, stdout: "" }))).toBeUndefined();
    expect(observePrFacts("feat/x", undefined, () => ({ status: 0, stdout: "not json" }))).toBeUndefined();
  });
});

describe("poll pass", () => {
  let stateDir: string;
  let runsDir: string;

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "loop-poll-"));
    stateDir = join(root, "daemon");
    runsDir = join(root, "runs");
    initDaemonState(stateDir);
  });

  afterEach(() => {
    rmSync(resolve(stateDir, ".."), { recursive: true, force: true });
  });

  it("routes observed feedback onto the owning run's board exactly once", () => {
    appendFact(stateDir, {
      type: "session-created",
      ts: NOW,
      id: "s1",
      project: "demo",
      run: "run-1",
      role: "be",
      provider: "luna",
      tmuxSession: "team",
      branch: "feat/x"
    });

    const observed = facts({ checks: [{ name: "ci/tests", status: "completed", conclusion: "failure" }] });
    const deps = { stateDir, runsDir, observe: () => observed, now: () => new Date(NOW) };

    const first = pollFeedbackOnce(deps);
    expect(first).toEqual([{ session: "s1", routed: ["https://github.com/octo/repo/pull/12:ci:ci/tests"] }]);

    const board = foldBoard(join(runsDir, "run-1", "board"));
    expect(board).toHaveLength(1);
    expect(board[0]).toMatchObject({ assignee: "be", createdBy: "daemon-router", status: "open" });

    // Second poll with identical facts routes nothing new (persisted key memory).
    expect(pollFeedbackOnce(deps)).toEqual([]);
    expect(foldBoard(join(runsDir, "run-1", "board"))).toHaveLength(1);
  });

  it("records the discovered PR ref as a session fact and skips terminated/branchless sessions", () => {
    appendFact(stateDir, {
      type: "session-created",
      ts: NOW,
      id: "s1",
      project: "demo",
      run: "run-1",
      role: "be",
      provider: "luna",
      tmuxSession: "team",
      branch: "feat/x"
    });
    appendFact(stateDir, {
      type: "session-created",
      ts: NOW,
      id: "s2",
      project: "demo",
      run: "run-1",
      role: "fe",
      provider: "sol",
      tmuxSession: "team"
      // no branch → not part of the feedback loop
    });

    pollFeedbackOnce({ stateDir, runsDir, observe: () => facts(), now: () => new Date(NOW) });

    const state = foldState(readFacts(stateDir));
    expect(state.sessions.find((s) => s.id === "s1")?.prRef).toBe(
      "https://github.com/octo/repo/pull/12"
    );
    expect(state.sessions.find((s) => s.id === "s2")?.prRef).toBeUndefined();
  });

  it("persists routed keys across restarts", () => {
    appendRoutedKeys(stateDir, ["a", "b"]);
    appendRoutedKeys(stateDir, []);
    expect(readRoutedKeys(stateDir)).toEqual(new Set(["a", "b"]));
  });
});

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { addEvent, addTask, initBoard } from "../board.js";
import { observePrFacts, type Exec } from "./github.js";
import { appendRoutedKeys, readRoutedKeys, routeFeedback, type PrFacts } from "./router.js";
import { appendFact, foldState, readFacts, type SessionView } from "./state.js";

/**
 * Feedback poll: OBSERVE PR facts per live session branch → route new feedback
 * (router.ts decides) → UPDATE the run's board with assigned tasks. One poll pass is
 * a pure-ish function of injected observers so tests run without GitHub or tmux.
 */

export type PollDeps = {
  stateDir: string;
  /** Root that contains `.loop/runs/<run>/board` — usually the config rootDir. */
  runsDir: string;
  observe?: (session: SessionView) => PrFacts | undefined;
  exec?: Exec;
  now?: () => Date;
};

export type PollResult = { session: string; routed: string[] }[];

export function pollFeedbackOnce(deps: PollDeps): PollResult {
  const now = deps.now ?? (() => new Date());
  const observe =
    deps.observe ??
    ((session: SessionView) =>
      session.branch ? observePrFacts(session.branch, session.worktree, deps.exec) : undefined);

  const state = foldState(readFacts(deps.stateDir));
  const alreadyRouted = readRoutedKeys(deps.stateDir);
  const results: PollResult = [];

  for (const session of state.sessions) {
    if (session.isTerminated) continue;
    // Only sessions that declared a branch (or PR) participate in the feedback loop.
    if (!session.branch && !session.prRef) continue;

    const facts = observe(session);
    if (!facts) continue;

    if (facts.prRef && facts.prRef !== session.prRef) {
      appendFact(deps.stateDir, {
        type: "session-pr",
        ts: now().toISOString(),
        id: session.id,
        prRef: facts.prRef
      });
    }

    const routed = routeFeedback(session, facts, alreadyRouted, now().toISOString());
    if (!routed.length) continue;

    const boardDir = resolve(deps.runsDir, session.run, "board");
    if (!existsSync(boardDir)) initBoard(boardDir);
    for (const { task } of routed) {
      addTask(boardDir, task);
      // Surface the routing on the run's timeline (loop monitor / dashboard).
      addEvent(boardDir, {
        ts: now().toISOString(),
        role: "daemon-router",
        taskId: task.id,
        status: "open",
        summary: `routed from ${facts.prRef}: ${task.title}`
      });
    }

    const keys = routed.map((r) => r.key);
    appendRoutedKeys(deps.stateDir, keys);
    for (const key of keys) alreadyRouted.add(key);
    results.push({ session: session.id, routed: keys });
  }

  return results;
}

/** Start the recurring feedback poll inside the daemon process. */
export function startFeedbackPolling(deps: PollDeps, intervalMs = 60_000): NodeJS.Timeout {
  const timer = setInterval(() => {
    try {
      pollFeedbackOnce(deps);
    } catch {
      // A failed poll never crashes the daemon — next tick retries.
    }
  }, intervalMs);
  timer.unref();
  return timer;
}

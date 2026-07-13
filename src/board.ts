import {
  appendFileSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { readStateFile } from "./runtime.js";

/**
 * Shared blackboard for the autonomous SME team.
 *
 * Coordination happens through three append-only JSONL logs under `.loop/board/`:
 *  - tasks.jsonl   the work items the orchestrator/PM decomposes a goal into
 *  - events.jsonl  status updates SMEs emit (claimed/done/blocked/needs-review)
 *  - messages.jsonl free-form hand-off notes between roles
 *
 * Append-only JSONL is the safest cross-process format we can get with tmux as the
 * only IPC: every writer only ever appends a single line, and `appendFileSync` opens
 * with O_APPEND so concurrent single-line writes below PIPE_BUF do not interleave on
 * local filesystems. We never rewrite history; the *current* state of a task is the
 * reduction of its event stream. Claims are resolved by "first claim event wins",
 * which is decided when we fold the log — no lock needed for correctness, only a tiny
 * advisory lock for the rare orchestrator-side compaction.
 */

export type TaskStatus =
  | "open"
  | "claimed"
  | "in-progress"
  | "needs-review"
  | "blocked"
  | "done"
  | "rejected"
  | "escalated";

export type BoardTask = {
  id: string;
  title: string;
  /** SME role key this task is assigned to (e.g. "backend", "qa"). */
  assignee: string;
  /** Role that created the task (orchestrator/pm or another SME handing off). */
  createdBy: string;
  description: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
  priority: number;
  createdAt: string;
  /** Files this task expects to touch — used for ownership/contention checks. */
  files?: string[];
};

export type BoardEvent = {
  ts: string;
  role: string;
  taskId: string;
  status: TaskStatus;
  summary?: string;
};

export type BoardMessage = {
  ts: string;
  from: string;
  to: string;
  taskId?: string;
  body: string;
};

export type TaskView = BoardTask & {
  status: TaskStatus;
  claimedBy?: string;
  lastSummary?: string;
  lastUpdate?: string;
  /** How many times this task has failed (blocked/rejected) — drives the repair loop. */
  attempts: number;
};

export type BoardPaths = {
  dir: string;
  tasks: string;
  events: string;
  messages: string;
};

export function boardPaths(boardDir: string): BoardPaths {
  return {
    dir: boardDir,
    tasks: resolve(boardDir, "tasks.jsonl"),
    events: resolve(boardDir, "events.jsonl"),
    messages: resolve(boardDir, "messages.jsonl")
  };
}

export function initBoard(boardDir: string): BoardPaths {
  // PRIVATE (0700), explicitly — not "whatever the ambient umask gives us". The board holds the run's
  // money ledger, and a group/other-writable directory lets another account swap the ledger leaf out
  // from under an open transaction. A umask of 002 (common on shared/CI hosts) would otherwise produce
  // a 0775 board, and the ledger rightly refuses to keep accounting there.
  mkdirSync(boardDir, { recursive: true, mode: 0o700 });
  // VERIFY the directory we just "created" is actually ours. `mkdirSync(…, {recursive:true})` succeeds
  // silently when the path already exists — including when it is a SYMLINK to somewhere else, in which
  // case the chmod below would have re-permissioned the attacker's target and every board journal (and
  // the ledger beside them) would have been created inside it.
  const st = lstatSync(boardDir);
  if (st.isSymbolicLink()) throw new Error(`refusing to use board ${boardDir}: it is a symlink`);
  if (!st.isDirectory()) throw new Error(`refusing to use board ${boardDir}: it is not a directory`);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && st.uid !== uid) throw new Error(`refusing to use board ${boardDir}: it is owned by uid ${st.uid}, not ${uid}`);
  chmodSync(boardDir, 0o700); // …and tighten a board an earlier version (or a loose umask) left open
  const paths = boardPaths(boardDir);
  for (const file of [paths.tasks, paths.events, paths.messages]) {
    // `existsSync` FOLLOWS a symlink, so a planted `tasks.jsonl -> /elsewhere` looked "already there"
    // and every later append/read went straight through it. `readStateFile` refuses a symlink, a
    // non-regular file, a hardlink alias, a permissive mode, another uid's file, and an unreadable one
    // — and only a genuinely ABSENT journal is created (exclusively, 0600).
    if (readStateFile(file).kind === "absent") {
      const fd = openSync(file, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
      closeSync(fd);
    }
  }
  return paths;
}

function readJsonl<T>(file: string): T[] {
  const read = readStateFile(file); // absent → empty board; unsafe → fail closed (never read through it)
  if (read.kind === "absent") return [];
  const out: T[] = [];
  for (const line of read.data.toString("utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // A torn/partial line (extremely rare with single-line appends) is skipped
      // rather than crashing the whole board read.
    }
  }
  return out;
}

function appendJsonl(file: string, value: unknown): void {
  appendFileSync(file, `${JSON.stringify(value)}\n`);
}

export function addTask(boardDir: string, task: BoardTask): void {
  appendJsonl(boardPaths(boardDir).tasks, task);
}

export function addEvent(boardDir: string, event: BoardEvent): void {
  appendJsonl(boardPaths(boardDir).events, event);
}

export function addMessage(boardDir: string, message: BoardMessage): void {
  appendJsonl(boardPaths(boardDir).messages, message);
}

export function readTasks(boardDir: string): BoardTask[] {
  return readJsonl<BoardTask>(boardPaths(boardDir).tasks);
}

export function readEvents(boardDir: string): BoardEvent[] {
  return readJsonl<BoardEvent>(boardPaths(boardDir).events);
}

export function readMessages(boardDir: string): BoardMessage[] {
  return readJsonl<BoardMessage>(boardPaths(boardDir).messages);
}

/**
 * Fold the append-only logs into the current view of every task.
 *
 * Status precedence rules:
 *  - The *first* "claimed" event wins the claim (later claims are ignored).
 *  - After a claim, the latest event from the claiming role advances the status.
 *  - "done"/"rejected"/"blocked" from anyone are honored (PM can reject; QA can block).
 */
export function foldBoard(boardDir: string): TaskView[] {
  const tasks = readTasks(boardDir);
  const events = readEvents(boardDir);
  const views = new Map<string, TaskView>();

  for (const task of tasks) {
    views.set(task.id, { ...task, status: "open", attempts: 0 });
  }

  for (const event of events) {
    const view = views.get(event.taskId);
    if (!view) continue;

    if (event.status === "claimed") {
      if (!view.claimedBy) {
        view.claimedBy = event.role;
        view.status = "claimed";
      }
    } else {
      view.status = event.status;
    }
    // Every failure event increments the attempt counter so the repair loop can
    // bound retries and escalate instead of looping forever.
    if (event.status === "blocked" || event.status === "rejected") {
      view.attempts += 1;
    }
    view.lastSummary = event.summary ?? view.lastSummary;
    view.lastUpdate = event.ts;
  }

  return [...views.values()].sort((a, b) => b.priority - a.priority);
}

/** Open tasks assigned to a role that nobody has claimed yet. */
export function openTasksFor(boardDir: string, role: string): TaskView[] {
  return foldBoard(boardDir).filter(
    (task) => task.assignee === role && task.status === "open"
  );
}

/**
 * Tasks assigned to a role that failed but still have repair attempts left. These are
 * re-dispatched (with the failure context injected) so the team self-heals instead of
 * stranding blocked/rejected work.
 */
export function retryableTasksFor(boardDir: string, role: string, maxRepairs: number): TaskView[] {
  // `maxRepairs` is the number of REPAIRS allowed AFTER the initial attempt, so a task may be
  // dispatched up to `1 + maxRepairs` times. `attempts` already counts the initial attempt, so a
  // task is retryable while the repairs used so far (`attempts - 1`) is below `maxRepairs`, i.e.
  // while `attempts <= maxRepairs`.
  return foldBoard(boardDir).filter(
    (task) =>
      task.assignee === role &&
      (task.status === "blocked" || task.status === "rejected") &&
      task.attempts <= maxRepairs
  );
}

const TERMINAL: TaskStatus[] = ["done", "rejected", "escalated"];

export function isComplete(boardDir: string): boolean {
  const views = foldBoard(boardDir);
  if (!views.length) return false;
  return views.every((task) => TERMINAL.includes(task.status));
}

/**
 * Context an SME should see before working a task: messages addressed to it and the
 * results of its upstream dependencies. This is what makes coordination real — it flips
 * the message log from write-only to load-bearing and lets `dependsOn` carry artifacts,
 * not just ordering.
 */
export function gatherContext(boardDir: string, role: string, task: BoardTask, limit = 8): string {
  const inbox = readMessages(boardDir)
    .filter((m) => m.to === role || m.to === "*")
    .filter((m) => !m.taskId || m.taskId === task.id || task.dependsOn.includes(m.taskId))
    .slice(-limit);
  const upstream = foldBoard(boardDir).filter((t) => task.dependsOn.includes(t.id));

  const sections: string[] = [];
  if (inbox.length) {
    sections.push("## Inbox (messages for you)");
    sections.push(...inbox.map((m) => `- from ${m.from}: ${m.body}`));
  }
  if (upstream.length) {
    sections.push("## Upstream results (your dependencies)");
    sections.push(
      ...upstream.map((t) => `- ${t.id} (${t.assignee}, ${t.status}): ${t.lastSummary ?? "—"}`)
    );
  }
  return sections.join("\n");
}

export function boardSummary(boardDir: string): {
  total: number;
  byStatus: Record<string, number>;
  views: TaskView[];
} {
  const views = foldBoard(boardDir);
  const byStatus: Record<string, number> = {};
  for (const view of views) {
    byStatus[view.status] = (byStatus[view.status] ?? 0) + 1;
  }
  return { total: views.length, byStatus, views };
}

/**
 * Compact the event log so it does not grow unbounded across long runs. Folds to the
 * current state and rewrites a minimal event stream. Guarded by an advisory lock so the
 * orchestrator never compacts while it might race its own future appends. SMEs never
 * call this — only the orchestrator between iterations.
 */
export function compactBoard(boardDir: string): void {
  const paths = boardPaths(boardDir);
  const lock = resolve(boardDir, ".compact.lock");
  if (existsSync(lock)) return;
  writeFileSync(lock, String(process.pid));
  try {
    const views = foldBoard(boardDir);
    const lines = views
      .filter((view) => view.lastUpdate)
      .map((view) =>
        JSON.stringify({
          ts: view.lastUpdate ?? view.createdAt,
          role: view.claimedBy ?? view.assignee,
          taskId: view.id,
          status: view.status,
          summary: view.lastSummary
        } satisfies BoardEvent)
      );
    const tmp = `${paths.events}.tmp`;
    writeFileSync(tmp, lines.length ? `${lines.join("\n")}\n` : "");
    renameSync(tmp, paths.events);
  } finally {
    try {
      renameSync(lock, `${lock}.done`);
    } catch {
      // best-effort lock release
    }
  }
}

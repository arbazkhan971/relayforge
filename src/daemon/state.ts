import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

/**
 * Daemon state: durable facts + fold-at-read derivation.
 *
 * This follows the same philosophy as the board (`src/board.ts`) and the reference
 * architecture we adapted (agent-orchestrator): we OBSERVE external facts, UPDATE an
 * append-only change log, and DERIVE display status at read time. Display status is
 * never persisted — only minimal durable facts are. That keeps status logic flexible
 * (a precedence change is a code change, not a data migration) and makes the single
 * facts log double as the change-data-capture stream the SSE endpoint tails.
 */

export type SessionActivity = "active" | "idle" | "waiting_input" | "blocked" | "exited";

export type DaemonFact =
  | { type: "project-added"; ts: string; name: string; path: string }
  | { type: "project-removed"; ts: string; name: string }
  | {
      type: "session-created";
      ts: string;
      id: string;
      project: string;
      run: string;
      role: string;
      provider: string;
      tmuxSession: string;
      goal?: string;
      worktree?: string;
      branch?: string;
    }
  | { type: "session-activity"; ts: string; id: string; state: SessionActivity; note?: string }
  | { type: "session-pr"; ts: string; id: string; prRef: string }
  | { type: "session-terminated"; ts: string; id: string; reason?: string };

export type ProjectView = { name: string; path: string; addedAt: string };

export type SessionView = {
  id: string;
  project: string;
  run: string;
  role: string;
  provider: string;
  tmuxSession: string;
  goal?: string;
  worktree?: string;
  branch?: string;
  prRef?: string;
  createdAt: string;
  /** What the agent last reported — a durable fact, not the display status. */
  activity: SessionActivity;
  lastActivityAt: string;
  lastNote?: string;
  isTerminated: boolean;
  terminatedReason?: string;
};

/**
 * Display status, computed at read time — never stored. Precedence mirrors the
 * reference: termination first, then input/blocked, then liveness, then activity.
 */
export type DisplayStatus =
  | "terminated"
  | "waiting_input"
  | "blocked"
  | "exited"
  | "unknown"
  | "working"
  | "idle";

export type DaemonPaths = { dir: string; facts: string; token: string; running: string };

export function daemonPaths(stateDir: string): DaemonPaths {
  return {
    dir: stateDir,
    facts: resolve(stateDir, "facts.jsonl"),
    token: resolve(stateDir, "token"),
    running: resolve(stateDir, "running.json")
  };
}

export function initDaemonState(stateDir: string): DaemonPaths {
  mkdirSync(stateDir, { recursive: true });
  const paths = daemonPaths(stateDir);
  if (!existsSync(paths.facts)) writeFileSync(paths.facts, "");
  if (!existsSync(paths.token)) {
    writeFileSync(paths.token, randomBytes(24).toString("hex"), { mode: 0o600 });
  }
  return paths;
}

export function readToken(stateDir: string): string {
  return readFileSync(daemonPaths(stateDir).token, "utf8").trim();
}

export function appendFact(stateDir: string, fact: DaemonFact): void {
  appendFileSync(daemonPaths(stateDir).facts, `${JSON.stringify(fact)}\n`);
}

/** Read facts, optionally skipping the first `fromLine` lines (the SSE watermark). */
export function readFacts(stateDir: string, fromLine = 0): DaemonFact[] {
  const file = daemonPaths(stateDir).facts;
  if (!existsSync(file)) return [];
  const out: DaemonFact[] = [];
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (i < fromLine) continue;
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as DaemonFact);
    } catch {
      // A torn/partial line is skipped rather than crashing the whole read.
    }
  }
  return out;
}

/** Count non-empty lines — the watermark unit for the CDC-style event tail. */
export function countFactLines(stateDir: string): number {
  const file = daemonPaths(stateDir).facts;
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf8").split("\n").filter((line) => line.trim()).length;
}

export type DaemonState = { projects: ProjectView[]; sessions: SessionView[] };

export function foldState(facts: DaemonFact[]): DaemonState {
  const projects = new Map<string, ProjectView>();
  const sessions = new Map<string, SessionView>();

  for (const fact of facts) {
    switch (fact.type) {
      case "project-added":
        projects.set(fact.name, { name: fact.name, path: fact.path, addedAt: fact.ts });
        break;
      case "project-removed":
        projects.delete(fact.name);
        break;
      case "session-created":
        // First creation wins; a replayed create never resets a live session.
        if (!sessions.has(fact.id)) {
          sessions.set(fact.id, {
            id: fact.id,
            project: fact.project,
            run: fact.run,
            role: fact.role,
            provider: fact.provider,
            tmuxSession: fact.tmuxSession,
            goal: fact.goal,
            worktree: fact.worktree,
            branch: fact.branch,
            createdAt: fact.ts,
            activity: "active",
            lastActivityAt: fact.ts,
            isTerminated: false
          });
        }
        break;
      case "session-activity": {
        const view = sessions.get(fact.id);
        if (view && !view.isTerminated) {
          view.activity = fact.state;
          view.lastActivityAt = fact.ts;
          view.lastNote = fact.note ?? view.lastNote;
        }
        break;
      }
      case "session-pr": {
        const view = sessions.get(fact.id);
        if (view) view.prRef = fact.prRef;
        break;
      }
      case "session-terminated": {
        const view = sessions.get(fact.id);
        if (view) {
          view.isTerminated = true;
          view.terminatedReason = fact.reason;
          view.lastActivityAt = fact.ts;
        }
        break;
      }
    }
  }

  return { projects: [...projects.values()], sessions: [...sessions.values()] };
}

export type SessionProbe = {
  /** Whether the session's tmux session currently exists. */
  tmuxAlive: boolean;
  /** Current time (ms since epoch) — injected so derivation stays pure/testable. */
  nowMs: number;
};

/** How long a dead probe without an exit report stays "unknown" before "exited". */
export const PROBE_GRACE_MS = 2 * 60 * 1000;

/**
 * Derive the display status from durable facts + a liveness probe.
 *
 * Load-bearing rule from the reference: a failed probe alone is NOT death. A missing
 * tmux session only downgrades the display to "unknown" until the grace window passes
 * or the agent reported "exited" itself.
 */
export function deriveDisplayStatus(view: SessionView, probe: SessionProbe): DisplayStatus {
  if (view.isTerminated) return "terminated";
  if (view.activity === "waiting_input") return "waiting_input";
  if (view.activity === "blocked") return "blocked";
  if (!probe.tmuxAlive) {
    if (view.activity === "exited") return "exited";
    const sinceActivity = probe.nowMs - Date.parse(view.lastActivityAt);
    return sinceActivity > PROBE_GRACE_MS ? "exited" : "unknown";
  }
  if (view.activity === "exited") return "exited";
  return view.activity === "active" ? "working" : "idle";
}

/**
 * Termination requires confluence: the tmux session must be gone AND the agent must
 * have exited (or been silent past the grace window). One signal alone never
 * auto-terminates a session.
 */
export function canAutoTerminate(view: SessionView, probe: SessionProbe): boolean {
  if (view.isTerminated) return false;
  if (probe.tmuxAlive) return false;
  if (view.activity === "exited") return true;
  return probe.nowMs - Date.parse(view.lastActivityAt) > PROBE_GRACE_MS;
}

export type SessionWithStatus = SessionView & { status: DisplayStatus };

export function sessionsWithStatus(
  state: DaemonState,
  probeTmux: (tmuxSession: string) => boolean,
  nowMs = Date.now()
): SessionWithStatus[] {
  return state.sessions.map((view) => ({
    ...view,
    status: deriveDisplayStatus(view, { tmuxAlive: probeTmux(view.tmuxSession), nowMs })
  }));
}

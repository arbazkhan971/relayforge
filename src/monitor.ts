import { boardSummary, TaskView } from "./board.js";
import { renderControlRoomTerminal } from "./control-room/terminal-view.js";
import type { ControlRoomViewModelV1 } from "./control-room/view-model.js";
import type { SteeringDashboardData } from "./dashboard/steering-data.js";
import { isSafeTmuxName, tmuxAvailable, tmuxClient } from "./tmux.js";

/**
 * Unified terminal "mission control" over parent-owned facts and the same normalized public
 * control-room model used by the browser. Raw pane output is intentionally outside this renderer.
 */

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CLEAR = "\x1b[2J\x1b[H";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

const STATUS_COLOR: Record<string, string> = {
  open: "\x1b[90m",          // grey
  claimed: "\x1b[36m",       // cyan
  "in-progress": "\x1b[34m", // blue
  "needs-review": "\x1b[33m",// yellow
  blocked: "\x1b[31m",       // red
  done: "\x1b[32m",          // green
  rejected: "\x1b[35m"       // magenta
};

const STATUS_GLYPH: Record<string, string> = {
  open: "○",
  claimed: "◔",
  "in-progress": "◑",
  "needs-review": "◕",
  blocked: "✗",
  done: "●",
  rejected: "⊘"
};

export type MonitorOptions = {
  boardDir: string;
  session: string;
  /** @deprecated Retained for CLI compatibility; pane identifiers and bytes are never rendered. */
  panes: Record<string, string>;
  /** Optional P5 public read model. No raw source or capture capability is accepted. */
  controlRoom?: ControlRoomViewModelV1 | (() => ControlRoomViewModelV1);
  /** Optional canonical P2 read projection. It is rendered only; the monitor owns no writer. */
  steering?: SteeringDashboardData | (() => SteeringDashboardData);
  intervalMs?: number;
  /** @deprecated Retained for CLI compatibility; normalized pages own their own closed bounds. */
  tailLines?: number;
};

function color(status: string, text: string): string {
  return `${STATUS_COLOR[status] ?? ""}${text}${RESET}`;
}

function termWidth(): number {
  return process.stdout.columns ?? 100;
}

function termHeight(): number {
  return process.stdout.rows ?? 40;
}

function hr(width: number): string {
  return DIM + "─".repeat(width) + RESET;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function renderFrame(opts: MonitorOptions): string {
  const width = termWidth();
  const summary = boardSummary(opts.boardDir);
  const lines: string[] = [];

  const counts = Object.entries(summary.byStatus)
    .map(([status, n]) => color(status, `${STATUS_GLYPH[status] ?? "•"} ${status} ${n}`))
    .join("   ");

  lines.push(`${BOLD}🛰  RELAYFORGE · MISSION CONTROL${RESET}`);
  lines.push(`${DIM}${summary.total} tasks${RESET}   ${counts}`);
  lines.push(hr(width));

  // Board: one row per task.
  lines.push(`${BOLD}BOARD${RESET}`);
  if (!summary.views.length) {
    lines.push(`${DIM}  (no tasks yet — orchestrator is decomposing the goal)${RESET}`);
  }
  for (const task of summary.views) {
    lines.push(renderTaskRow(task, width));
  }
  lines.push(hr(width));

  if (opts.steering !== undefined) {
    lines.push(...renderSteeringMonitor(typeof opts.steering === "function" ? opts.steering() : opts.steering, width));
    lines.push(hr(width));
  }

  lines.push(`${BOLD}CONTROL ROOM${RESET}`);
  if (opts.controlRoom === undefined) {
    lines.push(`${DIM}  No normalized observation snapshot is configured; activity is unknown.${RESET}`);
  } else {
    const model = typeof opts.controlRoom === "function" ? opts.controlRoom() : opts.controlRoom;
    const room = renderControlRoomTerminal(model, {
      width: Math.max(32, Math.min(240, width)),
      height: Math.max(6, Math.min(200, termHeight() - lines.length))
    });
    lines.push(...room.split("\n"));
  }

  return lines.join("\n");
}

/** Render the bounded P2 lifecycle facts without exposing command bodies or accepting input. */
export function renderSteeringMonitor(view: SteeringDashboardData, width = termWidth()): string[] {
  const lines: string[] = [`${BOLD}NEXT-PROMPT STEERING${RESET}`];
  const freshness = view.stale
    ? `stale ${view.observedSeq}/${view.headSeq}`
    : `current at ${view.headSeq}`;
  const age = view.queue.oldestPendingAgeMs === null ? "none queued" : `oldest ${formatMonitorAge(view.queue.oldestPendingAgeMs)}`;
  lines.push(`${DIM}  ${view.queue.pendingCount} pending · ${age} · ${freshness}${RESET}`);
  for (const session of view.sessions) {
    const task = session.taskId === null ? "no task" : `${session.taskId} gen ${session.taskGeneration}`;
    const next = session.queue.nextEligibleAttemptGeneration === null ? "" : ` · next attempt ${session.queue.nextEligibleAttemptGeneration}`;
    lines.push(truncate(`  ${session.activityLabel} · ${session.sessionId} gen ${session.sessionGeneration} · ${task}${next}`, width));
  }
  const visible = view.commands.slice(0, 12);
  for (const command of visible) {
    lines.push(truncate(`  ${command.statusLabel} · ${command.commandId} · ${command.statusDetail}`, width));
  }
  if (view.commands.length > visible.length || view.commandsTruncated) {
    lines.push(`${DIM}  … ${view.commandCount - visible.length} additional lifecycle record(s)${RESET}`);
  }
  return lines;
}

function formatMonitorAge(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1_000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

function renderTaskRow(task: TaskView, width: number): string {
  const glyph = STATUS_GLYPH[task.status] ?? "•";
  const head = `  ${color(task.status, glyph)} ${BOLD}${task.id}${RESET} ${truncate(task.title, 46).padEnd(46)} `;
  const meta = `${DIM}→ ${task.assignee.padEnd(16)}${RESET} ${color(task.status, task.status)}`;
  const summary = task.lastSummary ? `  ${DIM}${truncate(task.lastSummary, Math.max(10, width - 80))}${RESET}` : "";
  return head + meta + summary;
}

/** One-shot render (for `loop monitor --once` / CI / piping). */
export function renderOnce(opts: MonitorOptions): string {
  return renderFrame(opts);
}

/** Live monitor: redraw the single screen on an interval until Ctrl-C. */
export function startMonitor(opts: MonitorOptions, onClose?: () => void): void {
  const interval = opts.intervalMs ?? 1500;
  process.stdout.write(HIDE_CURSOR);
  const draw = () => {
    process.stdout.write(CLEAR);
    process.stdout.write(renderFrame(opts));
    process.stdout.write(`\n${DIM}↻ refreshing every ${Math.round(interval / 1000)}s · Ctrl-C to exit${RESET}`);
  };
  draw();
  const timer = setInterval(draw, interval);
  const cleanup = () => {
    clearInterval(timer);
    try { onClose?.(); } catch { /* render cleanup is best-effort and owns no authority */ }
    process.stdout.write(SHOW_CURSOR + "\n");
    process.exit(0);
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
}

/**
 * Discover live panes for a session (role inferred from pane title). Metadata-gated: a session that is
 * not a Loop-OWNED viewport is never listed and never scraped, so `loop monitor` cannot be pointed at a
 * human's own tmux session by a crafted name.
 */
export function discoverPanes(session: string): Record<string, string> {
  if (!isSafeTmuxName(session) || !tmuxAvailable()) return {};
  const client = tmuxClient();
  if (!client.identityOf(session)) return {};
  return client.panesByRole(session);
}

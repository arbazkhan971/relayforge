import { boardSummary, TaskView } from "./board.js";
import { capturePaneById, isSafeTmuxName, tmuxAvailable, tmuxClient } from "./tmux.js";

/**
 * Unified terminal "mission control" — render the whole AI team on ONE screen:
 * the board (every task + status) plus a live tail of each agent's tmux pane. This is
 * the single-screen monitor: it polls and redraws in place, so you never have to attach
 * to tmux or juggle windows to see what every SME is doing.
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
  /** role -> pane id, so we can tail each agent's viewport. */
  panes: Record<string, string>;
  intervalMs?: number;
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

  lines.push(`${BOLD}🛰  LOOP ORCHESTRATOR · MISSION CONTROL${RESET}   ${DIM}session ${opts.session}${RESET}`);
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

  // Agent viewports: tail each pane.
  lines.push(`${BOLD}AGENTS${RESET}`);
  const roleNames = Object.keys(opts.panes);
  const usedSoFar = lines.length + 2;
  const remaining = Math.max(6, termHeight() - usedSoFar);
  const perAgent = roleNames.length ? Math.max(3, Math.floor(remaining / roleNames.length)) : 3;
  const tail = opts.tailLines ?? perAgent;

  for (const role of roleNames) {
    const paneId = opts.panes[role];
    lines.push(`${BOLD}▌ ${role}${RESET} ${DIM}(${paneId})${RESET}`);
    const captured = capturePaneById(paneId, tail + 4)
      .split("\n")
      .map((l) => l.replace(/\s+$/, ""))
      .filter((l) => l.length > 0)
      .slice(-tail);
    if (!captured.length) {
      lines.push(`  ${DIM}…idle…${RESET}`);
    }
    for (const l of captured) {
      lines.push(`  ${DIM}${truncate(l, width - 2)}${RESET}`);
    }
  }

  return lines.join("\n");
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
export function startMonitor(opts: MonitorOptions): void {
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
    process.stdout.write(SHOW_CURSOR + "\n");
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
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

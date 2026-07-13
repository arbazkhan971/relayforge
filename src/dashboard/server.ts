import { existsSync, readdirSync, statSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { boardSummary } from "../board.js";
import { LoadedConfig, getProject } from "../config/load.js";
import type { ProjectConfig } from "../config/schema.js";
import { isValidId } from "../ids.js";
import { capturePane as captureTmuxPane, listOwnedSessions as listTmuxSessions, type OwnedSessionName } from "../tmux.js";
import { buildAgentCards, buildAttention, buildGraph, buildOverview, buildTimeline } from "./data.js";
import { renderDashboard } from "./render.js";

export type BoardSummaryResult = ReturnType<typeof boardSummary>;

const EMPTY_BOARD: BoardSummaryResult = { total: 0, byStatus: {}, views: [] };

/** The dashboard is unauthenticated, so it binds to loopback only. */
export const DASHBOARD_HOST = "127.0.0.1";

/** A run id is a single safe canonical identifier — never `..` or a separator. */
export function sanitizeRun(run: string | null | undefined): string | undefined {
  if (!run) return undefined;
  return isValidId(run) ? run : undefined;
}

/** Redact secret-shaped content from free text (env assignments, common token formats). */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*)\s*[=:]\s*\S+/gi, "$1=[redacted]")
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|gh[oprsu]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{8,})/g, "[redacted]");
}

const SECRET_KEY = /(key|token|secret|password|passwd|credential)/i;

/** Deep-redact a project config for the API: env values and any secret-shaped keys are masked. */
export function redactConfig<T>(value: T, keyHint = ""): T {
  if (Array.isArray(value)) return value.map((v) => redactConfig(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "env" && v && typeof v === "object") {
        // Provider env is a map of NAME->value; keep the names, mask the values.
        out[k] = Object.fromEntries(Object.keys(v as Record<string, unknown>).map((name) => [name, "[redacted]"]));
      } else {
        out[k] = redactConfig(v, k);
      }
    }
    return out as unknown as T;
  }
  if (typeof value === "string" && SECRET_KEY.test(keyHint)) return "[redacted]" as unknown as T;
  return value;
}

export type DashboardServerOptions = {
  project: ProjectConfig;
  namespace: string;
  port: number;
  /** Directory that holds run subdirectories (each containing a `board/`). */
  runsDir?: string;
  /** Returns OWNED sessions with their stamped identity, so the server can filter by exact project. */
  listSessions?: (namespace: string) => OwnedSessionName[];
  capturePane?: (session: string, lines?: number) => string;
  /** Injectable board reader (defaults to reading the latest run's board on disk). */
  readBoard?: (run?: string) => BoardSummaryResult;
};

/**
 * Start the loopback dashboard, resolving once it is actually LISTENING.
 *
 * A failure to bind is reported, not thrown into the void: `server.listen()` reports EADDRINUSE/EACCES
 * asynchronously on the `error` event, and with no handler attached Node re-raises it as an uncaught
 * exception that takes the whole process down with a stack trace. The common case is entirely ordinary —
 * a second `loop dashboard` for another project, or the port already in use — and it deserves a sentence,
 * not a crash. The promise lets the CLI `die()` with an actionable message and a clean exit code.
 */
export function startDashboard(loaded: LoadedConfig, options: { project?: string; port?: number }): Promise<Server> {
  const project = getProject(loaded, options.project);
  const namespace = loaded.config.defaults.namespace;
  const port = options.port ?? loaded.config.defaults.dashboardPort;
  // Run state is namespaced by project on disk, so the dashboard only ever sees its own
  // project's runs (two projects that share a run id stay isolated).
  const runsDir = resolve(loaded.rootDir, loaded.config.defaults.runDir, project.name);
  const server = createDashboardServer({
    project,
    namespace,
    port,
    runsDir,
    listSessions: listTmuxSessions,
    capturePane: captureTmuxPane
  });

  return new Promise<Server>((resolvePromise, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.close();
      const where = `${DASHBOARD_HOST}:${port}`;
      if (error.code === "EADDRINUSE") {
        reject(new Error(`The dashboard port ${where} is already in use. Stop the process using it, or pass --port <1-65535>.`));
        return;
      }
      if (error.code === "EACCES") {
        reject(new Error(`Not permitted to bind ${where} (ports below 1024 usually need privileges). Pass --port <1024-65535>.`));
        return;
      }
      reject(new Error(`The dashboard could not bind ${where}: ${error.message}`));
    };
    server.once("error", onError);
    server.listen(port, DASHBOARD_HOST, () => {
      // Only past this point is a later `error` an ordinary runtime event rather than a failure to start.
      server.removeListener("error", onError);
      console.log(`Loop dashboard: http://${DASHBOARD_HOST}:${port} (loopback only)`);
      resolvePromise(server);
    });
  });
}

/**
 * Resolve the board directory for a given (or the most recent) run under `runsDir`.
 * A run directory is considered valid when it contains a `board/` subdirectory.
 * Returns undefined when no run/board exists.
 */
function resolveBoardDir(runsDir: string | undefined, run?: string | null): string | undefined {
  if (!runsDir || !existsSync(runsDir)) return undefined;

  if (run) {
    const dir = resolve(runsDir, run, "board");
    return existsSync(dir) ? dir : undefined;
  }

  let latest: { dir: string; mtime: number } | undefined;
  for (const entry of readdirSync(runsDir)) {
    const boardDir = resolve(runsDir, entry, "board");
    if (!existsSync(boardDir)) continue;
    try {
      const mtime = statSync(boardDir).mtimeMs;
      if (!latest || mtime > latest.mtime) latest = { dir: boardDir, mtime };
    } catch {
      // Skip unreadable entries.
    }
  }
  return latest?.dir;
}

function defaultReadBoard(runsDir: string | undefined, run?: string | null): BoardSummaryResult {
  const boardDir = resolveBoardDir(runsDir, run);
  if (!boardDir) return EMPTY_BOARD;
  try {
    return boardSummary(boardDir);
  } catch {
    return EMPTY_BOARD;
  }
}

export function createDashboardServer(options: DashboardServerOptions): Server {
  const listSessions = options.listSessions ?? listTmuxSessions;
  const capturePane = options.capturePane ?? captureTmuxPane;
  /** The sessions THIS project owns, by exact stamped identity. */
  const projectSessions = () => listSessions(options.namespace).filter((s) => s.project === options.project.name);
  const readBoard =
    options.readBoard ?? ((run?: string) => defaultReadBoard(options.runsDir, run));

  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${options.port}`);

    // Read-only surface: only GET/HEAD are allowed.
    if (req.method !== "GET" && req.method !== "HEAD") {
      return json(res, { error: "Method not allowed" }, 405);
    }

    // A `run` query param, if present, must be a valid id — an invalid one is a 400, not a
    // silent fall-through to the latest run.
    const rawRun = url.searchParams.get("run");
    if (rawRun !== null && !isValidId(rawRun)) {
      return json(res, { error: "Invalid run id" }, 400);
    }

    if (url.pathname === "/api/status") {
      return json(res, {
        project: options.project.name,
        sessions: projectSessions().map((s) => s.name)
      });
    }

    if (url.pathname === "/api/config") {
      // Never expose provider env values, auth secrets, or any secret-shaped fields.
      return json(res, redactConfig(options.project));
    }

    const run = sanitizeRun(url.searchParams.get("run"));

    if (url.pathname === "/api/board") {
      const board = readBoard(run);
      const boardDir = resolveBoardDir(options.runsDir, run);
      // Enrich with the critical path so the kanban can mark gating tasks.
      const criticalPath = boardDir ? safe(() => buildGraph(boardDir).criticalPath, [] as string[]) : [];
      return json(res, { ...board, criticalPath });
    }

    if (url.pathname === "/api/overview") {
      const boardDir = resolveBoardDir(options.runsDir, run);
      if (!boardDir) return json(res, emptyOverview(options.project.name));
      return json(res, safe(() => buildOverview(boardDir, options.project), emptyOverview(options.project.name)));
    }

    if (url.pathname === "/api/agents") {
      const boardDir = resolveBoardDir(options.runsDir, run);
      if (!boardDir) return json(res, idleAgents(options.project));
      return json(res, safe(() => buildAgentCards(boardDir, options.project), idleAgents(options.project)));
    }

    if (url.pathname === "/api/timeline") {
      const boardDir = resolveBoardDir(options.runsDir, run);
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 60) || 60));
      if (!boardDir) return json(res, []);
      return json(res, safe(() => buildTimeline(boardDir, limit), [] as unknown[]));
    }

    if (url.pathname === "/api/graph") {
      const boardDir = resolveBoardDir(options.runsDir, run);
      if (!boardDir) return json(res, { nodes: [], edges: [], criticalPath: [] });
      return json(res, safe(() => buildGraph(boardDir), { nodes: [], edges: [], criticalPath: [] }));
    }

    if (url.pathname === "/api/attention") {
      const boardDir = resolveBoardDir(options.runsDir, run);
      if (!boardDir) return json(res, { tasks: [], warnings: [] });
      return json(res, safe(() => buildAttention(boardDir, options.project), { tasks: [], warnings: [] as string[] }));
    }

    if (url.pathname === "/api/logs") {
      const session = url.searchParams.get("session");
      if (!session) return json(res, { error: "Missing session" }, 400);
      // Only sessions this project OWNS (by stamped identity, never by name substring) are observable,
      // and their output is secret-redacted. `safe` covers the session dying between the check and the
      // capture — a race must be an empty log, not a 500.
      const owned = projectSessions().some((s) => s.name === session);
      if (!owned) return json(res, { error: "Unknown or non-project session" }, 403);
      return json(res, { session, logs: redactSecrets(safe(() => capturePane(session, 220), "")) });
    }

    // Any unmatched API path is a 404 (not a silent HTML page).
    if (url.pathname.startsWith("/api/")) {
      return json(res, { error: "Unknown endpoint" }, 404);
    }
    // The dashboard SPA is only served from the root.
    if (url.pathname !== "/") {
      return json(res, { error: "Not found" }, 404);
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS });
    res.end(renderDashboard(options.project.name));
  });
}

/** No-store + hardening headers on every response (the dashboard is unauthenticated loopback). */
const SECURITY_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:"
};

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS });
  res.end(JSON.stringify(data, null, 2));
}

/** Run a read and fall back to a default on any error — endpoints must never 500. */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function emptyOverview(project: string) {
  return {
    project,
    totals: { total: 0, done: 0, inProgress: 0, blocked: 0, open: 0, needsReview: 0 },
    byStatus: {},
    progressPct: 0,
    agentsActive: 0,
    agentsTotal: 0,
    rejections: 0,
    retries: 0,
    escalated: 0,
    spendUsd: 0,
    budgetUsd: 0,
    budgetPct: null,
    tokensIn: 0,
    tokensOut: 0,
    estCompletionMs: null
  };
}

function idleAgents(project: ProjectConfig) {
  return project.roles.map((role) => ({
    role: role.name,
    title: role.title,
    sme: role.sme,
    provider: role.provider,
    state: "idle" as const,
    attempts: 0,
    spendUsd: 0,
    done: 0
  }));
}

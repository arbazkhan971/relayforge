import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { packageVersion } from "../metadata.js";
import { killSession as killTmuxSession, listSessions as listTmuxSessions } from "../tmux.js";
import {
  appendFact,
  countFactLines,
  foldState,
  readFacts,
  sessionsWithStatus,
  type DaemonFact,
  type SessionActivity
} from "./state.js";

/**
 * The daemon's loopback-only HTTP API. Rules adopted from the reference architecture:
 *  - binds 127.0.0.1 only — zero network exposure;
 *  - every /api route requires the bearer token written to .loop/daemon/token;
 *  - the CLI stays a thin HTTP client — all logic lives here;
 *  - /api/events is an SSE tail of the facts log (CDC-style watermark poller),
 *    so UIs receive changes without polling the JSON endpoints.
 */

export type DaemonServerOptions = {
  stateDir: string;
  token: string;
  /** Injectable probes so tests never need a live tmux. */
  probeTmux?: (tmuxSession: string) => boolean;
  killTmux?: (tmuxSession: string) => boolean;
  /** SSE poll interval (ms). */
  eventPollMs?: number;
  /** Called after /shutdown responds; the host process should close and exit. */
  onShutdown?: () => void;
};

const VALID_ACTIVITY: SessionActivity[] = ["active", "idle", "waiting_input", "blocked", "exited"];

export function createDaemonServer(options: DaemonServerOptions): Server {
  const probeTmux =
    options.probeTmux ?? ((session: string) => listTmuxSessions().includes(session));
  const killTmux = options.killTmux ?? killTmuxSession;
  const pollMs = options.eventPollMs ?? 500;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/readyz") {
      return json(res, { ok: true, version: packageVersion });
    }

    if (!isAuthorized(req, url, options.token)) {
      return json(res, { error: "Unauthorized" }, 401);
    }

    if (url.pathname === "/shutdown" && req.method === "POST") {
      json(res, { ok: true, stopping: true });
      // Give the response a beat to flush before the host tears the server down.
      setTimeout(() => options.onShutdown?.(), 50);
      return;
    }

    if (url.pathname === "/api/state" && req.method === "GET") {
      const state = foldState(readFacts(options.stateDir));
      return json(res, {
        projects: state.projects,
        sessions: sessionsWithStatus(state, probeTmux)
      });
    }

    if (url.pathname === "/api/projects" && req.method === "GET") {
      return json(res, foldState(readFacts(options.stateDir)).projects);
    }

    if (url.pathname === "/api/projects" && req.method === "POST") {
      const body = await readJsonBody(req);
      const name = optionalString(body?.name);
      const path = optionalString(body?.path);
      if (!name || !path) {
        return json(res, { error: "Expected { name, path }" }, 400);
      }
      appendFact(options.stateDir, {
        type: "project-added",
        ts: new Date().toISOString(),
        name,
        path
      });
      return json(res, { ok: true, name });
    }

    if (url.pathname === "/api/sessions" && req.method === "GET") {
      const state = foldState(readFacts(options.stateDir));
      return json(res, sessionsWithStatus(state, probeTmux));
    }

    if (url.pathname === "/api/sessions" && req.method === "POST") {
      const body = await readJsonBody(req);
      const id = optionalString(body?.id);
      const project = optionalString(body?.project);
      const run = optionalString(body?.run);
      const role = optionalString(body?.role);
      const provider = optionalString(body?.provider);
      const tmuxSession = optionalString(body?.tmuxSession);
      if (!id || !project || !run || !role || !provider || !tmuxSession) {
        return json(res, { error: "Expected { id, project, run, role, provider, tmuxSession }" }, 400);
      }
      appendFact(options.stateDir, {
        type: "session-created",
        ts: new Date().toISOString(),
        id,
        project,
        run,
        role,
        provider,
        tmuxSession,
        goal: optionalString(body?.goal),
        worktree: optionalString(body?.worktree),
        branch: optionalString(body?.branch)
      });
      return json(res, { ok: true, id });
    }

    const activityMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/activity$/);
    if (activityMatch && req.method === "POST") {
      const body = await readJsonBody(req);
      const state = optionalString(body?.state) as SessionActivity | undefined;
      if (!state || !VALID_ACTIVITY.includes(state)) {
        return json(res, { error: `Expected state in: ${VALID_ACTIVITY.join(", ")}` }, 400);
      }
      appendFact(options.stateDir, {
        type: "session-activity",
        ts: new Date().toISOString(),
        id: decodeURIComponent(activityMatch[1]),
        state,
        note: optionalString(body?.note)
      });
      return json(res, { ok: true });
    }

    const prMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/pr$/);
    if (prMatch && req.method === "POST") {
      const body = await readJsonBody(req);
      const prRef = optionalString(body?.prRef);
      if (!prRef) {
        return json(res, { error: "Expected { prRef }" }, 400);
      }
      appendFact(options.stateDir, {
        type: "session-pr",
        ts: new Date().toISOString(),
        id: decodeURIComponent(prMatch[1]),
        prRef
      });
      return json(res, { ok: true });
    }

    const killMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/kill$/);
    if (killMatch && req.method === "POST") {
      const id = decodeURIComponent(killMatch[1]);
      const state = foldState(readFacts(options.stateDir));
      const session = state.sessions.find((view) => view.id === id);
      if (!session) return json(res, { error: `Unknown session: ${id}` }, 404);
      const killed = session.isTerminated ? false : killTmux(session.tmuxSession);
      if (!session.isTerminated) {
        appendFact(options.stateDir, {
          type: "session-terminated",
          ts: new Date().toISOString(),
          id,
          reason: "killed via API"
        });
      }
      return json(res, { ok: true, id, tmuxKilled: killed });
    }

    if (url.pathname === "/api/events" && req.method === "GET") {
      return streamEvents(res, options.stateDir, pollMs);
    }

    return json(res, { error: "Not found" }, 404);
  });

  return server;
}

/**
 * SSE tail of the facts log. A watermark tracks how many fact lines have been sent;
 * each poll ships only the new ones — the same change-data-capture shape the
 * reference implements with database triggers, done here over the append-only file.
 */
function streamEvents(res: ServerResponse, stateDir: string, pollMs: number): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  let watermark = countFactLines(stateDir);
  res.write(`event: hello\ndata: ${JSON.stringify({ watermark })}\n\n`);

  const timer = setInterval(() => {
    const fresh = readFacts(stateDir, watermark);
    if (!fresh.length) return;
    watermark += fresh.length;
    for (const fact of fresh) {
      res.write(`event: fact\ndata: ${JSON.stringify(fact satisfies DaemonFact)}\n\n`);
    }
  }, pollMs);

  res.on("close", () => clearInterval(timer));
}

function isAuthorized(req: IncomingMessage, url: URL, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : url.searchParams.get("token") ?? "";
  if (!presented || presented.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(token));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!chunks.length) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

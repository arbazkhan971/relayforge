import { readRunningInfo } from "./lifecycle.js";
import { readToken, type SessionWithStatus, type ProjectView } from "./state.js";

/**
 * Thin HTTP client the CLI uses to talk to the daemon — the CLI holds no daemon
 * logic (reference rule: "CLI is thin; all logic in daemon").
 */

export class DaemonNotRunningError extends Error {
  constructor() {
    super("loop daemon is not running. Start it with: loop daemon start");
  }
}

export async function daemonRequest<T>(
  stateDir: string,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const info = readRunningInfo(stateDir);
  if (!info) throw new DaemonNotRunningError();
  const token = readToken(stateDir);
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${info.port}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000)
    });
  } catch {
    throw new DaemonNotRunningError();
  }
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data?.error ?? `Daemon request failed: ${method} ${path}`);
  return data;
}

export function listProjects(stateDir: string): Promise<ProjectView[]> {
  return daemonRequest(stateDir, "GET", "/api/projects");
}

export function addProject(stateDir: string, name: string, path: string): Promise<{ ok: boolean }> {
  return daemonRequest(stateDir, "POST", "/api/projects", { name, path });
}

export function listSessions(stateDir: string): Promise<SessionWithStatus[]> {
  return daemonRequest(stateDir, "GET", "/api/sessions");
}

export function killSession(stateDir: string, id: string): Promise<{ ok: boolean; tmuxKilled: boolean }> {
  return daemonRequest(stateDir, "POST", `/api/sessions/${encodeURIComponent(id)}/kill`);
}

export type SessionRegistration = {
  id: string;
  project: string;
  run: string;
  role: string;
  provider: string;
  tmuxSession: string;
  goal?: string;
  worktree?: string;
  branch?: string;
};

/**
 * Best-effort registration used by `loop run` / `loop start`: when the daemon is up,
 * sessions appear in mission control; when it isn't, orchestration proceeds unchanged.
 */
export async function tryRegisterSessions(
  stateDir: string,
  sessions: SessionRegistration[]
): Promise<boolean> {
  try {
    for (const session of sessions) {
      await daemonRequest(stateDir, "POST", "/api/sessions", session);
    }
    return true;
  } catch {
    return false;
  }
}

import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { createDaemonServer } from "./server.js";
import { daemonPaths, initDaemonState, readToken } from "./state.js";

/**
 * Daemon lifecycle: `loop daemon start` spawns a detached `loop daemon run`
 * (the internal foreground entrypoint) and waits for /readyz — same shape as the
 * reference's `ao start` / `ao daemon`. A running.json handshake file records
 * pid+port so `stop`/`status` can find the daemon without guessing.
 */

export const DEFAULT_DAEMON_PORT = 4319;

export type RunningInfo = { pid: number; port: number; startedAt: string };

export function readRunningInfo(stateDir: string): RunningInfo | undefined {
  const file = daemonPaths(stateDir).running;
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as RunningInfo;
    return typeof parsed?.pid === "number" && typeof parsed?.port === "number" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function probeReady(port: number, timeoutMs = 1000): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    return response.ok;
  } catch {
    return false;
  }
}

export type DaemonStatus = {
  running: boolean;
  ready: boolean;
  pid?: number;
  port?: number;
  startedAt?: string;
};

export async function daemonStatus(stateDir: string): Promise<DaemonStatus> {
  const info = readRunningInfo(stateDir);
  if (!info) return { running: false, ready: false };
  const ready = await probeReady(info.port);
  // Failed probe ≠ death: report what we know; only `stop` clears the handshake.
  return { running: processAlive(info.pid), ready, ...info };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Foreground entrypoint used by the hidden `loop daemon run` command. */
export function runDaemonForeground(stateDir: string, port: number): Server {
  initDaemonState(stateDir);
  const token = readToken(stateDir);
  const paths = daemonPaths(stateDir);

  const server = createDaemonServer({
    stateDir,
    token,
    onShutdown: () => shutdown()
  });

  const shutdown = () => {
    try {
      rmSync(paths.running, { force: true });
    } catch {
      // best-effort cleanup
    }
    server.close(() => process.exit(0));
    // Failsafe if a lingering SSE client keeps the server open.
    setTimeout(() => process.exit(0), 2000).unref();
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  server.listen(port, "127.0.0.1", () => {
    writeFileSync(
      paths.running,
      JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() } satisfies RunningInfo, null, 2)
    );
    console.log(`loop daemon listening on http://127.0.0.1:${port}`);
  });
  return server;
}

/** Spawn the detached daemon and wait until /readyz answers. */
export async function startDaemonDetached(
  stateDir: string,
  port: number,
  cliArgs: { execPath: string; scriptPath: string; configFlag?: string }
): Promise<DaemonStatus> {
  const existing = await daemonStatus(stateDir);
  if (existing.ready) return existing;

  const args = [cliArgs.scriptPath];
  if (cliArgs.configFlag) args.push("--config", cliArgs.configFlag);
  args.push("daemon", "run", "--port", String(port));

  const child = spawn(cliArgs.execPath, args, { detached: true, stdio: "ignore" });
  child.unref();

  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(250);
    if (await probeReady(port)) break;
  }
  return daemonStatus(stateDir);
}

export async function stopDaemon(stateDir: string): Promise<{ stopped: boolean; pid?: number }> {
  const info = readRunningInfo(stateDir);
  if (!info) return { stopped: false };
  try {
    const token = readToken(stateDir);
    await fetch(`http://127.0.0.1:${info.port}/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2000)
    });
  } catch {
    // Fall back to a signal if the HTTP path is unreachable.
    try {
      process.kill(info.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(150);
    if (!(await probeReady(info.port))) break;
  }
  try {
    rmSync(daemonPaths(stateDir).running, { force: true });
  } catch {
    // best-effort
  }
  return { stopped: true, pid: info.pid };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

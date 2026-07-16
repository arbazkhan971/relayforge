import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDaemonServer } from "../src/daemon/server.js";
import { appendFact, initDaemonState } from "../src/daemon/state.js";

const TOKEN = "test-token-test-token-test-token-test-token-1234";

let dir: string;
let server: Server;
let port: number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "loop-daemon-srv-"));
  initDaemonState(dir);
});

afterEach(async () => {
  if (server?.listening) await close(server);
  rmSync(dir, { recursive: true, force: true });
});

async function startServer(overrides: Parameters<typeof createDaemonServer>[0] extends infer T ? Partial<T> : never = {}) {
  server = createDaemonServer({
    stateDir: dir,
    token: TOKEN,
    probeTmux: () => true,
    killTmux: () => true,
    eventPollMs: 25,
    ...overrides
  });
  port = await listen(server);
}

describe("daemon server", () => {
  it("answers /readyz without auth and rejects unauthorized /api calls", async () => {
    await startServer();

    const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(ready.ok).toBe(true);
    await expect(ready.json()).resolves.toMatchObject({ ok: true });

    const noToken = await fetch(`http://127.0.0.1:${port}/api/state`);
    expect(noToken.status).toBe(401);

    const badToken = await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: { authorization: "Bearer wrong" }
    });
    expect(badToken.status).toBe(401);
  });

  it("registers projects and sessions, and derives session status via the probe", async () => {
    await startServer({ probeTmux: (name) => name === "alive" });

    const addProject = await authedFetch("/api/projects", "POST", { name: "demo", path: "/tmp/demo" });
    expect(addProject.status).toBe(200);

    await authedFetch("/api/sessions", "POST", {
      id: "s1",
      project: "demo",
      run: "run-1",
      role: "be",
      provider: "luna",
      tmuxSession: "alive",
      goal: "ship it"
    });
    await authedFetch(`/api/sessions/${encodeURIComponent("s1")}/activity`, "POST", {
      state: "waiting_input",
      note: "needs credentials"
    });

    const state = await (await authedFetch("/api/state", "GET")).json();
    expect(state.projects).toEqual([expect.objectContaining({ name: "demo" })]);
    expect(state.sessions).toEqual([
      expect.objectContaining({ id: "s1", status: "waiting_input", lastNote: "needs credentials" })
    ]);
  });

  it("validates payloads", async () => {
    await startServer();

    expect((await authedFetch("/api/projects", "POST", { name: "x" })).status).toBe(400);
    expect((await authedFetch("/api/sessions", "POST", { id: "s1" })).status).toBe(400);
    expect((await authedFetch("/api/sessions/s1/activity", "POST", { state: "nope" })).status).toBe(400);
    expect((await authedFetch("/api/sessions/missing/kill", "POST")).status).toBe(404);
  });

  it("kills a session's tmux and records sticky termination", async () => {
    const killed: string[] = [];
    await startServer({
      killTmux: (name) => {
        killed.push(name);
        return true;
      }
    });

    await authedFetch("/api/sessions", "POST", {
      id: "s1",
      project: "demo",
      run: "run-1",
      role: "be",
      provider: "luna",
      tmuxSession: "team"
    });

    const first = await (await authedFetch("/api/sessions/s1/kill", "POST")).json();
    expect(first).toMatchObject({ ok: true, tmuxKilled: true });
    expect(killed).toEqual(["team"]);

    // Second kill is a no-op: termination is sticky, tmux is not re-killed.
    const second = await (await authedFetch("/api/sessions/s1/kill", "POST")).json();
    expect(second).toMatchObject({ ok: true, tmuxKilled: false });
    expect(killed).toEqual(["team"]);

    const sessions = await (await authedFetch("/api/sessions", "GET")).json();
    expect(sessions[0]).toMatchObject({ id: "s1", status: "terminated" });
  });

  it("streams new facts over SSE from the current watermark", async () => {
    await startServer();
    appendFact(dir, { type: "project-added", ts: "t0", name: "before", path: "/b" });

    const response = await fetch(`http://127.0.0.1:${port}/api/events?token=${TOKEN}`);
    expect(response.ok).toBe(true);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Hello frame carries the watermark (the pre-existing fact is not replayed).
    buffer += decoder.decode((await reader.read()).value);
    expect(buffer).toContain("event: hello");
    expect(buffer).toContain('"watermark":1');

    appendFact(dir, { type: "project-added", ts: "t1", name: "after", path: "/a" });

    while (!buffer.includes('"name":"after"')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value);
    }
    expect(buffer).toContain("event: fact");
    expect(buffer).toContain('"name":"after"');
    expect(buffer).not.toContain('"name":"before"');
    await reader.cancel();
  });

  it("calls onShutdown for authorized /shutdown", async () => {
    let shutdownCalled = false;
    await startServer({ onShutdown: () => (shutdownCalled = true) });

    const response = await authedFetch("/shutdown", "POST");
    expect(response.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(shutdownCalled).toBe(true);
  });
});

function authedFetch(path: string, method: string, body?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function listen(srv: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", resolve);
  });
  return (srv.address() as AddressInfo).port;
}

function close(srv: Server): Promise<void> {
  return new Promise((resolve) => {
    srv.closeAllConnections?.();
    srv.close(() => resolve());
  });
}

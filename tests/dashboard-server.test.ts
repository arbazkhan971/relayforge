import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createDashboardServer } from "../src/dashboard/server.js";
import type { ProjectConfig } from "../src/config/schema.js";

describe("dashboard server", () => {
  it("serves status, config, and logs through injectable tmux adapters", async () => {
    const server = createDashboardServer({
      project: sampleProject(),
      namespace: "loop",
      port: 0,
      listSessions: () => [
        { name: "loop-demo-run-1-dev", project: "demo", run: "run-1", role: "dev" },
        { name: "loop-other-run-1-dev", project: "other", run: "run-1", role: "dev" }
      ],
      capturePane: (session, lines) => `${session}:${lines}`
    });
    const port = await listen(server);

    try {
      await expect(getJson(`http://127.0.0.1:${port}/api/status`)).resolves.toEqual({
        project: "demo",
        sessions: ["loop-demo-run-1-dev"]
      });
      await expect(getJson(`http://127.0.0.1:${port}/api/config`)).resolves.toMatchObject({
        name: "demo",
        safetyMode: "workspace-write"
      });
      await expect(getJson(`http://127.0.0.1:${port}/api/logs?session=loop-demo-run-1-dev`)).resolves.toEqual({
        session: "loop-demo-run-1-dev",
        logs: "loop-demo-run-1-dev:220"
      });
    } finally {
      await close(server);
    }
  });

  it("rejects log requests without a session", async () => {
    const server = createDashboardServer({
      project: sampleProject(),
      namespace: "loop",
      port: 0,
      listSessions: (): never[] => [],
      capturePane: () => ""
    });
    const port = await listen(server);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/logs`);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Missing session" });
    } finally {
      await close(server);
    }
  });
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: Server) {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function getJson(url: string) {
  const response = await fetch(url);
  expect(response.ok).toBe(true);
  return response.json();
}

function sampleProject(): ProjectConfig {
  return {
    name: "demo",
    brief: "brief.md",
    workingDir: ".",
    safetyMode: "workspace-write",
    providers: {
      dev: {
        type: "codex",
        args: [],
        dangerouslySkipPermissions: false,
        yolo: false,
        auth: { mode: "auto", configured: false },
        promptMode: "interactive",
        env: {}
      }
    },
    repositories: [],
    roles: [
      {
        name: "dev",
        title: "Developer",
        provider: "dev",
        repositories: [],
        responsibilities: [],
        guardrails: [],
        autoStart: true
      }
    ],
    loops: []
  };
}

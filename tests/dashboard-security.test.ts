import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createDashboardServer, redactConfig, redactSecrets, sanitizeRun } from "../src/dashboard/server.js";
import type { ProjectConfig } from "../src/config/schema.js";

describe("dashboard security helpers", () => {
  it("sanitizeRun rejects path traversal and separators", () => {
    expect(sanitizeRun("run-2026")).toBe("run-2026");
    expect(sanitizeRun("../etc")).toBeUndefined();
    expect(sanitizeRun("a/b")).toBeUndefined();
    expect(sanitizeRun("..")).toBeUndefined();
    expect(sanitizeRun(null)).toBeUndefined();
  });

  it("redactConfig masks provider env values and secret-shaped fields", () => {
    const redacted = redactConfig({ providers: { a: { env: { ANTHROPIC_API_KEY: "sk-secret" }, apiToken: "t0ken" } } }) as any;
    expect(redacted.providers.a.env.ANTHROPIC_API_KEY).toBe("[redacted]");
    expect(redacted.providers.a.apiToken).toBe("[redacted]");
  });

  it("redactSecrets scrubs tokens and env assignments in free text", () => {
    expect(redactSecrets("export API_KEY=sk-abc12345")).toContain("[redacted]");
    expect(redactSecrets("token ghp_0123456789012345678901")).toContain("[redacted]");
  });
});

describe("dashboard server access control", () => {
  it("redacts /api/config and refuses non-project sessions", async () => {
    const server = createDashboardServer({
      project: projectWithSecret(),
      namespace: "loop",
      port: 0,
      listSessions: () => [{ name: "loop-demo-run-1-dev", project: "demo", run: "run-1", role: "dev" }],
      capturePane: () => "secret TOKEN=sk-leak"
    });
    const port = await listen(server);
    try {
      const config = await getJson(`http://127.0.0.1:${port}/api/config`);
      expect(JSON.stringify(config)).not.toContain("sk-realsecret");
      // Non-project session is refused (403).
      const bad = await fetch(`http://127.0.0.1:${port}/api/logs?session=loop-other-run-9-x`);
      expect(bad.status).toBe(403);
      // Project session is allowed but redacted.
      const good = await getJson(`http://127.0.0.1:${port}/api/logs?session=loop-demo-run-1-dev`);
      expect(JSON.stringify(good)).not.toContain("sk-leak");
    } finally {
      await close(server);
    }
  });

  it("a DIFFERENT project's session is never exposed, even when its name contains this project's name", async () => {
    // The old filter asked `session.includes("-demo-")`. The session of a project called `demo-api` is
    // named `loop-demo-api-…`, which CONTAINS `-demo-` — so project `demo`'s dashboard listed and
    // screen-scraped project `demo-api`'s session. Ownership is now decided by the STAMPED identity.
    const server = createDashboardServer({
      project: projectWithSecret(), // name: "demo"
      namespace: "loop",
      port: 0,
      listSessions: () => [
        { name: "loop-demo-run-1-dev", project: "demo", run: "run-1", role: "dev" },
        { name: "loop-demo-api-run-1-dev", project: "demo-api", run: "run-1", role: "dev" }
      ],
      capturePane: () => "other project's output"
    });
    const port = await listen(server);
    try {
      const status = await getJson<{ sessions: string[] }>(`http://127.0.0.1:${port}/api/status`);
      expect(status.sessions).toEqual(["loop-demo-run-1-dev"]);

      const leak = await fetch(`http://127.0.0.1:${port}/api/logs?session=loop-demo-api-run-1-dev`);
      expect(leak.status).toBe(403);
    } finally {
      await close(server);
    }
  });

  it("enforces GET-only, 400 invalid run, 404 unknown API, and security headers", async () => {
    const server = createDashboardServer({ project: projectWithSecret(), namespace: "loop", port: 0, listSessions: () => [], capturePane: () => "" });
    const port = await listen(server);
    try {
      // Non-GET is rejected.
      const post = await fetch(`http://127.0.0.1:${port}/api/board`, { method: "POST" });
      expect(post.status).toBe(405);

      // An invalid run id is a 400 (not a silent latest-run fall-through).
      const badRun = await fetch(`http://127.0.0.1:${port}/api/board?run=../etc`);
      expect(badRun.status).toBe(400);

      // Unknown API path is a 404.
      const unknown = await fetch(`http://127.0.0.1:${port}/api/does-not-exist`);
      expect(unknown.status).toBe(404);

      // Security headers + no-store are present.
      const ok = await fetch(`http://127.0.0.1:${port}/api/status`);
      expect(ok.headers.get("cache-control")).toBe("no-store");
      expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
      expect(ok.headers.get("x-frame-options")).toBe("DENY");
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
  return response.json();
}

function projectWithSecret(): ProjectConfig {
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
        env: { OPENAI_API_KEY: "sk-realsecret" }
      }
    },
    repositories: [],
    roles: [{ name: "dev", title: "Developer", provider: "dev", repositories: [], responsibilities: [], guardrails: [], autoStart: true }],
    loops: []
  };
}

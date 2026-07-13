import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(repoRoot, "src/cli.ts");
const tsxPath = resolve(repoRoot, "node_modules/tsx/dist/cli.mjs");

describe("dashboard CLI", () => {
  it("serves dashboard HTML and project APIs", async () => {
    const root = mkdtempSync(join(tmpdir(), "loop-dashboard-"));
    const configPath = join(root, "loop.config.yaml");
    writeFileSync(
      configPath,
      `version: 1
defaults:
  namespace: loop-dashboard-test
  dashboardPort: 4318
  promptDir: .loop/prompts
  runDir: .loop/runs
projects:
  - name: demo
    providers:
      dev:
        type: codex
    roles:
      - name: dev
        title: Developer
        provider: dev
`
    );
    const port = await getFreePort();
    const child = spawn(process.execPath, [tsxPath, cliPath, "--config", configPath, "dashboard", "--port", String(port)], {
      cwd: root
    });

    try {
      await waitForDashboard(port, child);

      const status = await getJson(`http://127.0.0.1:${port}/api/status`);
      expect(status).toEqual({ project: "demo", sessions: [] });

      const config = await getJson(`http://127.0.0.1:${port}/api/config`);
      expect(config).toMatchObject({ name: "demo", safetyMode: "workspace-write" });

      const html = await fetch(`http://127.0.0.1:${port}/`).then((response) => response.text());
      expect(html).toContain("Loop Orchestrator");
      expect(html).toContain("demo");
    } finally {
      await stopProcess(child);
    }
  });

  it("refuses a malformed --port instead of silently binding a RANDOM one", async () => {
    // `Number("abc")` is NaN, and Node reads a NaN port as "pick any free ephemeral port". So a typo used
    // to publish the dashboard on an unpredictable port while the operator watched 4318 — a listening
    // service nobody knows the address of. It must fail closed with an actionable message.
    for (const bad of ["abc", "0", "65536", "-1", "8080.5"]) {
      const root = writeDashboardConfig();
      const child = spawn(process.execPath, [tsxPath, cliPath, "--config", join(root, "loop.config.yaml"), "dashboard", "--port", bad], {
        cwd: root
      });
      const { code, stderr } = await collect(child);
      expect(code, `--port ${bad} was accepted`).not.toBe(0);
      expect(stderr, `--port ${bad}`).toMatch(/--port must be an integer between 1 and 65535/);
    }
  }, 60_000);

  it("reports an occupied port as an error instead of crashing with an uncaught exception", async () => {
    // The ordinary case: a second dashboard, or anything else already on the port. `listen()` reports
    // EADDRINUSE asynchronously on the `error` event, and with no handler Node re-raised it as an UNCAUGHT
    // EXCEPTION — a stack trace instead of a sentence.
    const squatter = createServer();
    await new Promise<void>((res, rej) => {
      squatter.once("error", rej);
      squatter.listen(0, "127.0.0.1", res);
    });
    const port = (squatter.address() as AddressInfo).port;

    try {
      const root = writeDashboardConfig();
      const child = spawn(process.execPath, [tsxPath, cliPath, "--config", join(root, "loop.config.yaml"), "dashboard", "--port", String(port)], {
        cwd: root
      });
      const { code, stderr } = await collect(child);
      expect(code, "an occupied port did not fail the command").not.toBe(0);
      expect(stderr).toMatch(/already in use/i);
      expect(stderr).toContain(`127.0.0.1:${port}`); // it says WHICH address
      expect(stderr, "the failure surfaced as an uncaught exception").not.toMatch(/Uncaught|ERR_UNHANDLED|at Server\./);
    } finally {
      await new Promise<void>((res) => squatter.close(() => res()));
    }
  }, 60_000);
});

/** A minimal valid project config; returns its root directory. */
function writeDashboardConfig(): string {
  const root = mkdtempSync(join(tmpdir(), "loop-dashboard-"));
  writeFileSync(
    join(root, "loop.config.yaml"),
    `version: 1
defaults:
  namespace: loop-dashboard-test
  dashboardPort: 4318
  promptDir: .loop/prompts
  runDir: .loop/runs
projects:
  - name: demo
    providers:
      dev:
        type: codex
    roles:
      - name: dev
        title: Developer
        provider: dev
`
  );
  return root;
}

/** Run a CLI process to completion, capturing its exit code and stderr. */
async function collect(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; stderr: string }> {
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdout.on("data", () => {
    /* drain */
  });
  const code = await new Promise<number | null>((res) => child.once("exit", (c) => res(c)));
  return { code, stderr };
}

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function waitForDashboard(port: number, child: ChildProcessWithoutNullStreams) {
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  // Generous under parallel load — the `tsx` server boot competes with other subprocess-heavy tests.
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Dashboard exited early with code ${child.exitCode}: ${stderr}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/status`);
      if (response.ok) return;
    } catch {
      // Keep polling until the server is listening.
    }
    await delay(100);
  }
  throw new Error(`Dashboard did not start on port ${port}: ${stderr}`);
}

async function getJson(url: string) {
  const response = await fetch(url);
  expect(response.ok).toBe(true);
  return response.json();
}

async function stopProcess(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(1000).then(() => {
      child.kill("SIGKILL");
    })
  ]);
}

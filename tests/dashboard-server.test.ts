import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";
import { startDashboard } from "../src/dashboard/server.js";
import type { ControlServiceHandle } from "../src/control/service.js";

const roots: string[] = [];
const handles: ControlServiceHandle[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0).reverse()) await handle.shutdown();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("dashboard server integration", () => {
  it("uses the lifetime-owned control server and its versioned read models", async () => {
    const loaded = config();
    const port = await freePort();
    const handle = await startDashboard(loaded, {
      project: "demo",
      port,
      borrowedSources: { projects: () => [{ project: "demo", runs: [] }] }
    });
    handles.push(handle);

    const html = await fetch(`${handle.address.url}/`).then((response) => response.text());
    expect(html).toContain("RelayForge");
    expect(html).toContain('data-project="demo"');

    const status = await fetch(`${handle.address.url}/api/v1/status`);
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      service: "relayforge-control",
      status: "ok",
      projects: [{ project: "demo", latestRun: null, sessions: [] }]
    });
  });
});

function config() {
  const root = mkdtempSync(join(tmpdir(), "relayforge-dashboard-server-"));
  roots.push(root);
  const path = join(root, "loop.config.yaml");
  writeFileSync(path, `version: 1
defaults:
  dashboardPort: 4318
projects:
  - name: demo
    providers:
      dev: { type: codex }
    roles:
      - { name: dev, title: Developer, provider: dev }
`);
  return loadConfig(path);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return port;
}

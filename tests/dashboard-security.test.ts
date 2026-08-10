import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";
import { startControlService, type ControlServiceHandle } from "../src/control/service.js";

const roots: string[] = [];
const handles: ControlServiceHandle[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0).reverse()) await handle.shutdown();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("dashboard control-origin security", () => {
  it("does not expose the legacy raw config/log APIs or configuration secrets", async () => {
    const loaded = configWithSecret();
    const handle = await startControlService(loaded, {
      port: 0,
      allowEphemeralPortForTests: true,
      borrowedSources: { projects: () => [{ project: "demo", runs: [] }] }
    });
    handles.push(handle);
    const base = handle.address.url;

    for (const legacy of ["/api/config", "/api/logs?session=anything", "/api/status", "/api/board"]) {
      const response = await fetch(base + legacy);
      expect(response.status, legacy).toBe(404);
      expect(await response.text(), legacy).not.toContain("sk-realsecret");
    }
    const html = await fetch(`${base}/`).then((response) => response.text());
    const status = await fetch(`${base}/api/v1/status`).then((response) => response.text());
    expect(html).not.toContain("sk-realsecret");
    expect(status).not.toContain("sk-realsecret");
    expect(status).not.toContain("OPENAI_API_KEY");
  });

  it("uses a nonce-only dashboard CSP while keeping API CSP at default-src none", async () => {
    const loaded = configWithSecret();
    const handle = await startControlService(loaded, {
      port: 0,
      allowEphemeralPortForTests: true,
      borrowedSources: { projects: () => [{ project: "demo", runs: [] }] }
    });
    handles.push(handle);
    const root = await fetch(`${handle.address.url}/`);
    const html = await root.text();
    const csp = root.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    const nonce = /script-src 'nonce-([^']+)'/u.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain(`<style nonce="${nonce}">`);

    const api = await fetch(`${handle.address.url}/api/v1/status`);
    const apiCsp = api.headers.get("content-security-policy") ?? "";
    expect(apiCsp).toContain("default-src 'none'");
    expect(apiCsp).not.toContain("nonce-");
    expect(api.headers.get("cache-control")).toBe("no-store");
    expect(api.headers.get("x-content-type-options")).toBe("nosniff");
    expect(api.headers.get("x-frame-options")).toBe("DENY");
  });

  it("keeps the dashboard and every API route read-only", async () => {
    const loaded = configWithSecret();
    const handle = await startControlService(loaded, {
      port: 0,
      allowEphemeralPortForTests: true,
      borrowedSources: { projects: () => [{ project: "demo", runs: [] }] }
    });
    handles.push(handle);
    for (const path of ["/", "/api/v1/health", "/api/v1/status", "/api/v1/runs?project=demo"]) {
      const response = await fetch(handle.address.url + path, { method: "POST" });
      expect(response.status, path).toBe(405);
      expect(response.headers.get("allow"), path).toBe("GET, HEAD");
    }
  });
});

function configWithSecret() {
  const root = mkdtempSync(join(tmpdir(), "relayforge-dashboard-security-"));
  roots.push(root);
  const path = join(root, "loop.config.yaml");
  writeFileSync(path, `version: 1
projects:
  - name: demo
    providers:
      dev:
        type: codex
        env:
          OPENAI_API_KEY: sk-realsecret
    roles:
      - { name: dev, title: Developer, provider: dev }
`);
  return loadConfig(path);
}

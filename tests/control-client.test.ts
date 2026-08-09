import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  ControlClientError,
  fetchControlStatus,
  inspectControlService,
  renderControlStatus,
  requestControlJson,
  type ControlAttachment
} from "../src/control/client.js";
import type { ControlPaths, RunFileRead } from "../src/control/runfile.js";
import type { ControlHealth, ControlRunFile, ControlStatus } from "../src/control/protocol.js";

const startedAt = "2026-08-09T00:00:00.000Z";
const runFile: ControlRunFile = {
  schemaVersion: 1,
  service: "relayforge-control",
  instanceId: "a".repeat(64),
  configId: "b".repeat(64),
  pid: 1234,
  processStartToken: "linux:123",
  host: "127.0.0.1",
  port: 4318,
  startedAt
};
const health: ControlHealth = {
  schemaVersion: 1,
  service: "relayforge-control",
  instanceId: runFile.instanceId,
  configId: runFile.configId,
  pid: runFile.pid,
  status: "ok",
  startedAt
};
const paths: ControlPaths = {
  configId: runFile.configId,
  controlRoot: "/control",
  dir: "/control/config",
  leaseDb: "/control/config/lease.sqlite",
  runFile: "/control/config/serve.json"
};

function present(value = runFile, ino = 2n): RunFileRead {
  return { kind: "present", value, dev: 1n, ino };
}

function bytes(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value));
}

function status(): ControlStatus {
  return {
    schemaVersion: 1,
    service: "relayforge-control",
    instanceId: runFile.instanceId,
    configId: runFile.configId,
    status: "ok",
    startedAt,
    projects: []
  };
}

describe("control service client", () => {
  it("requires the complete run-file/lease/health/run-file/lease identity handshake", async () => {
    let reads = 0;
    let probes = 0;
    const result = await inspectControlService(paths, {
      readRunFile: () => { reads += 1; return present(); },
      probeLease: () => { probes += 1; return { state: "held" }; },
      requestJson: async () => bytes(health)
    });
    expect(result).toMatchObject({ state: "ready", attachment: { baseUrl: "http://127.0.0.1:4318", runFile, health } });
    expect({ reads, probes }).toEqual({ reads: 2, probes: 2 });
  });

  it.each([
    ["stopped", { run: { kind: "absent" } as RunFileRead, lease: { state: "free" } as const }],
    ["starting", { run: { kind: "absent" } as RunFileRead, lease: { state: "held" } as const }],
    ["stale-runfile", { run: present(), lease: { state: "free" } as const }]
  ])("classifies %s without making a health request", async (expected, fixture) => {
    let requests = 0;
    const result = await inspectControlService(paths, {
      readRunFile: () => fixture.run,
      probeLease: () => fixture.lease,
      requestJson: async () => { requests += 1; return bytes(health); }
    });
    expect(result.state).toBe(expected);
    expect(requests).toBe(0);
  });

  it("refuses a changed run-file, released second lease, and mismatched health", async () => {
    for (const variant of ["runfile", "lease", "health"] as const) {
      let reads = 0;
      let probes = 0;
      const result = await inspectControlService(paths, {
        readRunFile: () => {
          reads += 1;
          return present(runFile, variant === "runfile" && reads === 2 ? 99n : 2n);
        },
        probeLease: () => {
          probes += 1;
          return variant === "lease" && probes === 2 ? { state: "free" } : { state: "held" };
        },
        requestJson: async () => bytes(variant === "health" ? { ...health, pid: 9999 } : health)
      });
      expect(result.state).toBe("identity-mismatch");
    }
  });

  it("keeps an unhealthy held owner distinct from a stopped service", async () => {
    const result = await inspectControlService(paths, {
      readRunFile: () => present(),
      probeLease: () => ({ state: "held" }),
      requestJson: async () => { throw new ControlClientError("TIMEOUT", "timed out"); }
    });
    expect(result).toMatchObject({ state: "held-unhealthy", detail: "timed out" });
  });

  it("validates the status identity and renders the same DTO", async () => {
    const attachment: ControlAttachment = { baseUrl: "http://127.0.0.1:4318", runFile, health };
    await expect(fetchControlStatus(attachment, { requestJson: async () => bytes(status()) })).resolves.toEqual(status());
    expect(renderControlStatus(status())).toContain("RelayForge control service aaaaaaaaaaaa (ok)");
    await expect(fetchControlStatus(attachment, { requestJson: async () => bytes({ ...status(), instanceId: "c".repeat(64) }) }))
      .rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
  });

  it("enforces real HTTP content type, status, timeout, and exact body byte cap", async () => {
    const server = createServer((request, response) => {
      const path = request.url ?? "/";
      if (path === "/slow") return void setTimeout(() => response.end("{}"), 100);
      if (path === "/wrong-type") {
        response.writeHead(200, { "content-type": "text/plain" });
        return void response.end("{}");
      }
      if (path === "/error") {
        response.writeHead(503, { "content-type": "application/json" });
        return void response.end("{}");
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(path === "/exact" ? "1234" : "12345");
    });
    const port = await new Promise<number>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolvePromise((server.address() as AddressInfo).port));
    });
    try {
      await expect(requestControlJson(`http://127.0.0.1:${port}/exact`, 4, 1_000)).resolves.toEqual(new Uint8Array([49, 50, 51, 52]));
      await expect(requestControlJson(`http://127.0.0.1:${port}/large`, 4, 1_000)).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
      await expect(requestControlJson(`http://127.0.0.1:${port}/wrong-type`, 16, 1_000)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
      await expect(requestControlJson(`http://127.0.0.1:${port}/error`, 16, 1_000)).rejects.toMatchObject({ code: "HTTP_ERROR", status: 503 });
      await expect(requestControlJson(`http://127.0.0.1:${port}/slow`, 16, 20)).rejects.toMatchObject({ code: "TIMEOUT" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    }
  });
});

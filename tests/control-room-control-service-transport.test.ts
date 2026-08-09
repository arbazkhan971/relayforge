import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { ControlAttachment } from "../src/control/client.js";
import { createControlServiceControlRoomTransport } from "../src/control-room/control-service-transport.js";
import { CONTROL_ROOM_RESPONSE_MAX_BYTES } from "../src/control-room/server-adapter.js";

const EPOCH = "epoch_1234567890123456";
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function fixture(mode: "normal" | "oversized" = "normal"): Promise<{ server: Server; attachment: ControlAttachment; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    if (request.url?.includes("/observations")) {
      if (mode === "oversized") {
        response.writeHead(200, { "content-type": "application/json", "content-length": String(CONTROL_ROOM_RESPONSE_MAX_BYTES + 1) });
        response.end("{}");
        return;
      }
      const body = Buffer.from(JSON.stringify({ canonical: true }), "utf8");
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": String(body.byteLength) });
      response.end(body);
      return;
    }
    if (request.url?.includes("/events")) {
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
      response.write(`event: control.ready\ndata: ${JSON.stringify({ v: 1, type: "control.ready", runEpoch: EPOCH, floorSeq: 0, headSeq: 5, viewSeq: 5 })}\n\n`);
      response.write(`id: 6\nevent: control.changed\ndata: ${JSON.stringify({ v: 1, type: "control.changed", project: "product", run: "run-1", taskId: null, runEpoch: EPOCH, seq: 6, headSeq: 6, viewSeq: 6 })}\n\n`);
      return;
    }
    response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const runFile = {
    schemaVersion: 1 as const,
    service: "relayforge-control" as const,
    instanceId: "a".repeat(64),
    configId: "b".repeat(64),
    pid: process.pid,
    processStartToken: "linux:test:1",
    host: "127.0.0.1" as const,
    port,
    startedAt: "2026-08-09T12:00:00.000Z"
  };
  return {
    server,
    requests,
    attachment: {
      baseUrl: `http://127.0.0.1:${port}`,
      runFile,
      health: {
        schemaVersion: 1,
        service: "relayforge-control",
        instanceId: runFile.instanceId,
        configId: runFile.configId,
        pid: runFile.pid,
        status: "ok",
        startedAt: runFile.startedAt
      }
    }
  };
}

async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for control SSE");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe("loopback control-service control-room transport", () => {
  it("fetches only the bounded public snapshot and forwards metadata-only wake fields", async () => {
    const value = await fixture();
    const transport = createControlServiceControlRoomTransport({
      attachment: value.attachment,
      project: "product",
      run: "run-1",
      observationLimit: 25
    });
    const notifications: unknown[] = [];
    const unsubscribe = transport.subscribe((notification) => notifications.push(notification));
    expect(await transport.fetchSnapshot(new AbortController().signal)).toEqual({ canonical: true });
    await waitUntil(() => notifications.length >= 2);
    expect(notifications).toEqual([
      { type: "control.changed", runEpoch: EPOCH, seq: 5 },
      { type: "control.changed", runEpoch: EPOCH, seq: 6 }
    ]);
    expect(JSON.stringify(notifications)).not.toMatch(/project|taskId|payload|canonical/u);
    expect(value.requests).toEqual(expect.arrayContaining([
      "/api/v1/runs/run-1/events?project=product",
      "/api/v1/runs/run-1/observations?project=product&limit=25"
    ]));
    unsubscribe();
  });

  it("rejects oversized snapshots and noncanonical loopback attachments", async () => {
    const value = await fixture("oversized");
    const transport = createControlServiceControlRoomTransport({ attachment: value.attachment, project: "product", run: "run-1" });
    await expect(transport.fetchSnapshot(new AbortController().signal)).rejects.toThrow(/byte bound/);
    expect(() => createControlServiceControlRoomTransport({
      attachment: { ...value.attachment, baseUrl: value.attachment.baseUrl.replace("127.0.0.1", "localhost") },
      project: "product",
      run: "run-1"
    })).toThrow(/canonical loopback/);
  });

  it("reports a real server drop, reconnects with bounded backoff, and declares recovery only after a valid ready frame", async () => {
    const value = await fixture();
    const states: string[] = [];
    const notifications: unknown[] = [];
    const transport = createControlServiceControlRoomTransport({
      attachment: value.attachment,
      project: "product",
      run: "run-1",
      reconnectInitialMs: 10,
      reconnectMaximumMs: 20,
      handshakeTimeoutMs: 100
    });
    const unsubscribe = transport.subscribe(
      (notification) => notifications.push(notification),
      (state) => states.push(state)
    );
    await waitUntil(() => states.includes("available"));
    const port = value.attachment.runFile.port;
    value.server.closeAllConnections();
    await new Promise<void>((resolve) => value.server.close(() => resolve()));
    await waitUntil(() => states.includes("unavailable"));

    const replacement = createServer((request, response) => {
      if (!request.url?.includes("/events")) return void response.writeHead(404).end();
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      response.write(`event: control.ready\ndata: ${JSON.stringify({ v: 1, type: "control.ready", runEpoch: EPOCH, floorSeq: 0, headSeq: 9, viewSeq: 9 })}\n\n`);
    });
    servers.push(replacement);
    await new Promise<void>((resolve, reject) => {
      replacement.once("error", reject);
      replacement.listen(port, "127.0.0.1", () => resolve());
    });
    await waitUntil(() => states.filter((state) => state === "available").length >= 2);
    expect(states).toEqual(expect.arrayContaining(["connecting", "available", "unavailable"]));
    expect(notifications).toContainEqual({ type: "control.changed", runEpoch: EPOCH, seq: 9 });
    unsubscribe();
    const stoppedStateCount = states.length;
    const stoppedNotificationCount = notifications.length;
    replacement.closeAllConnections();
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    expect(states).toHaveLength(stoppedStateCount);
    expect(notifications).toHaveLength(stoppedNotificationCount);
  });
});

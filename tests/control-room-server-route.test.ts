import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createControlServer, type ControlHttpServer } from "../src/control/server.js";
import type { ControlViewSource } from "../src/control/views.js";
import { reduceControlRoomFacts } from "../src/control-room/projection.js";

const servers: ControlHttpServer[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.shutdown(); });
const epoch = "epoch_abcdefghijklmnop";

async function get(url: URL, method = "GET"): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return await new Promise((resolvePromise, reject) => {
    const call = request(url, { method }, (response) => { let body = ""; response.setEncoding("utf8"); response.on("data", (chunk) => { body += chunk; }); response.on("end", () => resolvePromise({ status: response.statusCode ?? 0, body, headers: response.headers })); });
    call.once("error", reject); call.end();
  });
}

async function fixture(withSource = true): Promise<{ server: ControlHttpServer; base: URL }> {
  const projection = reduceControlRoomFacts("run-1", epoch, [{ schemaVersion: 1, kind: "agent_state", seq: 1, generation: { runId: "run-1", runEpoch: epoch, taskId: "task-1", agentId: "agent-1", runtimeGeneration: 1, attemptGeneration: 1, sourceGeneration: 1 }, observedAt: "2026-08-09T12:00:00.000Z", activity: "active", taskStatus: "claimed", steeringState: "none", pendingCommands: 0, scmState: "unpublished", verificationState: "pending" }]);
  const runSource = { runId: "run-1" } as ControlViewSource;
  const server = createControlServer({ port: 0, allowEphemeralPortForTests: true, createRunFile(port) { return { schemaVersion: 1, service: "relayforge-control", instanceId: "a".repeat(64), configId: "b".repeat(64), pid: process.pid, processStartToken: "linux:test:1", host: "127.0.0.1", port, startedAt: "2026-08-09T12:00:00.000Z" }; }, readModels: { projects: () => [{ project: "project-1", runs: [runSource] }], ...(withSource ? { controlRoom: () => ({ runId: "run-1", runEpoch: epoch, controlRoomProjection: () => projection, controlRoomEventHead: () => 1 }) } : {}) } });
  servers.push(server); const address = await server.start(); return { server, base: new URL(address.url) };
}

describe("normalized observation HTTP route", () => {
  it("serves strict GET and HEAD snapshots under the existing loopback policy", async () => {
    const value = await fixture(); const url = new URL("/api/v1/runs/run-1/observations?project=project-1&limit=10", value.base);
    const getResult = await get(url); expect(getResult.status).toBe(200); expect(JSON.parse(getResult.body)).toMatchObject({ runId: "run-1", runEpoch: epoch, rows: [{ agentId: "agent-1" }] });
    const head = await get(url, "HEAD"); expect(head.status).toBe(200); expect(head.body).toBe(""); expect(head.headers["content-length"]).toBe(getResult.headers["content-length"]);
  });

  it("rejects unknown query fields and mutually exclusive cursors before reading", async () => {
    const value = await fixture();
    expect((await get(new URL("/api/v1/runs/run-1/observations?project=project-1&raw=1", value.base))).status).toBe(400);
    expect((await get(new URL("/api/v1/runs/run-1/observations?project=project-1&cursor=v1.bad&after=0", value.base))).status).toBe(400);
  });

  it("fails closed when no normalized projection is registered", async () => {
    const value = await fixture(false); const result = await get(new URL("/api/v1/runs/run-1/observations?project=project-1", value.base));
    expect(result.status).toBe(503); expect(result.body).toContain("NOT_READY");
  });
});

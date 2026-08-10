import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";
import type { PersistedControlEvent } from "../src/control/events.js";
import { emptyControlProjection, type ControlProjection } from "../src/control/reducer.js";
import type { DurableControlViewSource, ControlServiceHandle } from "../src/control/service.js";
import { startDashboard } from "../src/dashboard/server.js";

const roots: string[] = [];
const handles: ControlServiceHandle[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0).reverse()) await handle.shutdown();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("read-only steering dashboard endpoint", () => {
  it("serves a bounded run-scoped view through the canonical listener with GET and HEAD", async () => {
    const projection = canonicalProjection();
    const source = durableSource(projection, { floorSeq: 2, headSeq: 7 });
    const handle = await start(projection, source);
    const url = `${handle.address.url}/api/v1/runs/run-1/steering?project=demo`;

    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const data = await response.json() as any;
    expect(data).toMatchObject({
      schemaVersion: 1,
      project: "demo",
      run: "run-1",
      runEpoch: "epoch-000000000001",
      observedSeq: 6,
      headSeq: 7,
      floorSeq: 2,
      stale: true,
      queue: { pendingCount: 1, oldestPendingAgeMs: expect.any(Number) },
      sessions: [{
        sessionId: "session-1",
        sessionGeneration: 1,
        taskGeneration: 1,
        activity: "waiting_input",
        activityLabel: "Waiting for next prompt",
        queue: { nextEligibleAttemptGeneration: 1, boundaryReason: "safe-prompt-boundary" }
      }],
      commands: [{
        commandId: "command-1",
        status: "pending",
        statusLabel: "Pending",
        sourceKind: "control_plane"
      }]
    });
    expect(JSON.stringify(data)).not.toContain("full immutable prompt bytes");
    expect(JSON.stringify(data)).not.toContain("artifactLocator");

    const head = await fetch(url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(Number(head.headers.get("content-length"))).toBeGreaterThan(0);
    expect(await head.text()).toBe("");
  });

  it("has no mutation method, request body, or unknown-query escape hatch", async () => {
    const projection = canonicalProjection();
    let projectionReads = 0;
    const source = durableSource(projection, {
      onProjection: () => { projectionReads += 1; }
    });
    const handle = await start(projection, source);
    const url = `${handle.address.url}/api/v1/runs/run-1/steering?project=demo`;

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await fetch(url, { method });
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow"), method).toBe("GET, HEAD");
    }
    expect(projectionReads).toBe(0);

    const body = await fetch(url, { method: "POST", body: "command=inject" });
    expect(body.status).toBe(400);
    expect(projectionReads).toBe(0);

    const unknown = await fetch(`${url}&admit=true`);
    expect(unknown.status).toBe(400);
    expect(projectionReads).toBe(0);
  });

  it("returns recovery-required instead of a plausible view for corrupt generation linkage", async () => {
    const projection = canonicalProjection();
    projection.steering["command-1"]!.sessionGeneration = 2;
    const handle = await start(projection, durableSource(projection));
    const response = await fetch(`${handle.address.url}/api/v1/runs/run-1/steering?project=demo`);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "RECOVERY_REQUIRED" } });
  });

  it("keeps the route behind exact project and run ownership", async () => {
    const projection = canonicalProjection();
    const handle = await start(projection, durableSource(projection));
    const base = `${handle.address.url}/api/v1/runs`;
    expect((await fetch(`${base}/other-run/steering?project=demo`)).status).toBe(404);
    expect((await fetch(`${base}/run-1/steering?project=other`)).status).toBe(404);
    expect((await fetch(`${base}/run-1/steering`)).status).toBe(400);
  });
});

function canonicalProjection(): ControlProjection {
  const projection = emptyControlProjection("run-1", "epoch-000000000001");
  projection.headSeq = 6;
  projection.tasks["task-1"] = {
    id: "task-1",
    generation: 1,
    title: "Dashboard steering",
    assignee: "dev",
    createdBy: "parent",
    description: "Render the queue.",
    acceptanceCriteria: ["truthful"],
    dependsOn: [],
    priority: 1,
    createdAt: "2026-08-09T00:00:00.000Z",
    status: "in-progress",
    claimedBy: "dev",
    lastUpdate: "2026-08-09T00:00:01.000Z",
    attempts: 0,
    version: 2,
    updatedSeq: 4
  };
  projection.runtimes["session-1"] = {
    sessionId: "session-1",
    sessionGeneration: 1,
    taskId: "task-1",
    taskGeneration: 1,
    observation: "waiting_input",
    observedAt: "2026-08-09T00:00:02.000Z",
    updatedSeq: 5
  };
  projection.steering["command-1"] = {
    commandId: "command-1",
    sessionId: "session-1",
    sessionGeneration: 1,
    taskId: "task-1",
    taskGeneration: 1,
    bodySha256: "a".repeat(64),
    status: "pending",
    admittedSeq: 6,
    notBeforeAttemptGeneration: 1,
    kind: "steer_next_boundary",
    sourceKind: "control_plane",
    parentPrincipal: "parent",
    evidenceRefs: [],
    body: "bounded instruction preview",
    createdAt: "2026-08-09T00:00:03.000Z"
  };
  return projection;
}

function durableSource(
  projection: ControlProjection,
  options: { floorSeq?: number; headSeq?: number; onProjection?: () => void } = {}
): DurableControlViewSource {
  const floorSeq = options.floorSeq ?? 1;
  const headSeq = options.headSeq ?? projection.headSeq;
  return {
    runId: projection.runId,
    runEpoch: projection.runEpoch,
    getProjection() {
      options.onProjection?.();
      return structuredClone(projection);
    },
    head: () => ({ runId: projection.runId, runEpoch: projection.runEpoch, floorSeq, headSeq }),
    readRange: ({ afterSeq }) => ({
      runEpoch: projection.runEpoch,
      floorSeq,
      headSeq,
      afterSeq,
      events: [] as PersistedControlEvent[],
      hasMore: false
    }),
    subscribe: () => () => {}
  };
}

async function start(projection: ControlProjection, source: DurableControlViewSource): Promise<ControlServiceHandle> {
  const root = mkdtempSync(join(tmpdir(), "relayforge-dashboard-steering-server-"));
  roots.push(root);
  const path = join(root, "loop.config.yaml");
  writeFileSync(path, `version: 1
projects:
  - name: demo
    providers:
      dev: { type: codex }
    roles:
      - { name: dev, title: Developer, provider: dev }
`);
  const loaded = loadConfig(path);
  const port = await freePort();
  const handle = await startDashboard(loaded, {
    project: "demo",
    port,
    borrowedSources: { projects: () => [{ project: "demo", runs: [source] }] }
  });
  handles.push(handle);
  expect(handle.runFile.port).toBeGreaterThan(0);
  expect(projection.runId).toBe(source.runId);
  return handle;
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

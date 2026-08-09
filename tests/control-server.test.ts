import { Buffer } from "node:buffer";
import { createServer as createNodeServer, type Server as NodeServer } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTROL_RELEVANT_HEADERS_MAX_BYTES,
  CONTROL_REQUEST_TARGET_MAX_BYTES,
  serializeControlResponse,
  type ControlRunFile
} from "../src/control/protocol.js";
import { emptyControlProjection, type ControlProjection } from "../src/control/reducer.js";
import {
  ControlServerStartError,
  controlRequestHeaderBytes,
  createControlServer,
  type ControlHttpServer,
  type ControlServerOptions,
  type ControlSseHandler
} from "../src/control/server.js";
import { ControlStoreError, type EventRange } from "../src/control/store.js";
import { buildControlStatus, type ControlProjectViewSource, type ControlViewSource } from "../src/control/views.js";

const NOW = "2026-08-09T12:00:00.000Z";
const NOW_MS = Date.parse(NOW) + 1_000;
const INSTANCE_ID = "a".repeat(64);
const CONFIG_ID = "b".repeat(64);
const RUN_EPOCH = "epoch_000000000001";

const openServers = new Set<ControlHttpServer>();
const openNodeServers = new Set<NodeServer>();
const openSockets = new Set<Socket>();

afterEach(async () => {
  for (const socket of openSockets) socket.destroy();
  openSockets.clear();
  await Promise.all(Array.from(openServers, async (server) => {
    try {
      await server.shutdown();
    } catch {
      // Individual tests assert intentional lifecycle failures.
    }
  }));
  openServers.clear();
  await Promise.all(Array.from(openNodeServers, closeNodeServer));
  openNodeServers.clear();
});

class FakeSource implements ControlViewSource {
  projectionReads = 0;
  headReads = 0;
  rangeReads = 0;
  mutations = 0;
  projectionError: Error | undefined;
  rangeError: Error | undefined;

  constructor(
    readonly runId = "run-1",
    readonly runEpoch = RUN_EPOCH,
    readonly projection = runningProjection(runId, runEpoch)
  ) {}

  getProjection(): ControlProjection {
    this.projectionReads += 1;
    if (this.projectionError) throw this.projectionError;
    return this.projection;
  }

  head(): { runId: string; runEpoch: string; floorSeq: number; headSeq: number } {
    this.headReads += 1;
    return { runId: this.runId, runEpoch: this.runEpoch, floorSeq: 1, headSeq: this.projection.headSeq };
  }

  readRange(options: { afterSeq: number; limit?: number; runEpoch?: string }): EventRange {
    this.rangeReads += 1;
    if (this.rangeError) throw this.rangeError;
    return {
      runEpoch: this.runEpoch,
      floorSeq: 1,
      headSeq: this.projection.headSeq,
      afterSeq: options.afterSeq,
      events: [],
      hasMore: false
    };
  }

  append(): void {
    this.mutations += 1;
  }
}

describe("P1 control HTTP lifecycle", () => {
  it("fails closed when a non-test server omits durable SSE or lifetime/discovery callbacks", () => {
    expect(() => createControlServer({
      port: 4318,
      createRunFile: runFile,
      readModels: { projects: () => [project()] }
    })).toThrow(/durable SSE handler/);
    expect(() => createControlServer({
      port: 4318,
      createRunFile: runFile,
      readModels: { projects: () => [project()] },
      sse: { prepare: () => ({ start() {} }) }
    })).toThrow(/lifetime and discovery callback/);
  });

  it("binds exact IPv4 loopback, exposes starting health before publication, and cleans up in authority order", async () => {
    const events: string[] = [];
    const publish = deferred<void>();
    let server!: ControlHttpServer;
    server = tracked(createControlServer(serverOptions({
      lifecycle: {
        publishRunFile: async () => {
          events.push(`publish:${server.nodeServer.listening}:${server.ready}`);
          await publish.promise;
        },
        closeStores: () => events.push("stores"),
        removeRunFileIfOwned: () => events.push(`remove:${server.ready}`),
        releaseLease: () => events.push("lease")
      }
    })));

    const starting = server.start();
    const address = await waitForAddress(server);
    expect((server.nodeServer.address() as AddressInfo).address).toBe("127.0.0.1");
    expect((server.nodeServer.address() as AddressInfo).family).toBe("IPv4");

    const healthWhilePublishing = await fetch(`${address.url}/api/v1/health`);
    expect(healthWhilePublishing.status).toBe(200);
    await expect(healthWhilePublishing.json()).resolves.toMatchObject({ status: "starting", instanceId: INSTANCE_ID });
    const dataWhilePublishing = await fetch(`${address.url}/api/v1/status`);
    expect(dataWhilePublishing.status).toBe(503);
    await expect(errorCode(dataWhilePublishing)).resolves.toBe("NOT_READY");

    publish.resolve();
    await expect(starting).resolves.toEqual(address);
    expect(server.ready).toBe(true);
    const readyHealth = await fetch(`${address.url}/api/v1/health`);
    await expect(readyHealth.json()).resolves.toMatchObject({ status: "ok" });

    await server.shutdown();
    expect(server.state).toBe("closed");
    expect(events).toEqual(["publish:true:false", "stores", "remove:false", "lease"]);
    await server.shutdown();
    expect(events).toHaveLength(4);
  });

  it("fails a foreign occupied port without fallback and releases the injected lifetime lease", async () => {
    const foreign = createNodeServer((_request, response) => response.end("foreign"));
    openNodeServers.add(foreign);
    const port = await listenNode(foreign);
    const release = vi.fn();
    const runFileFactory = vi.fn((boundPort: number) => runFile(boundPort));
    const server = tracked(createControlServer(serverOptions({
      port,
      allowEphemeralPortForTests: false,
      createRunFile: runFileFactory,
      sse: { prepare: () => ({ start() {} }) },
      lifecycle: {
        publishRunFile() {},
        closeStores() {},
        removeRunFileIfOwned() {},
        releaseLease: release
      }
    })));

    await expect(server.start()).rejects.toMatchObject<Partial<ControlServerStartError>>({ code: "ADDRESS_IN_USE" });
    expect(runFileFactory).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(server.address()).toBeUndefined();
  });

  it("rolls back a failed durable publication by closing stores and removing only its own discovery before lease release", async () => {
    const order: string[] = [];
    const server = tracked(createControlServer(serverOptions({
      lifecycle: {
        publishRunFile: () => {
          order.push("publish");
          throw new Error("injected publication failure");
        },
        closeStores: () => order.push("stores"),
        removeRunFileIfOwned: () => order.push("run-file"),
        releaseLease: () => order.push("lease")
      }
    })));

    await expect(server.start()).rejects.toMatchObject<Partial<ControlServerStartError>>({ code: "START_FAILED" });
    expect(order).toEqual(["publish", "stores", "run-file", "lease"]);
    expect(server.nodeServer.listening).toBe(false);
  });

  it("retains discovery and the lifetime lease when a startup rollback cannot close its writable stores", async () => {
    const closeStores = vi.fn(() => {
      throw new Error("injected store close failure");
    });
    const removeRunFileIfOwned = vi.fn();
    const releaseLease = vi.fn();
    const server = tracked(createControlServer(serverOptions({
      lifecycle: {
        publishRunFile: () => {
          throw new Error("injected publication failure");
        },
        closeStores,
        removeRunFileIfOwned,
        releaseLease
      }
    })));

    await expect(server.start()).rejects.toMatchObject<Partial<ControlServerStartError>>({ code: "START_FAILED" });
    expect(server.state).toBe("failed");
    expect(server.nodeServer.listening).toBe(false);
    expect(closeStores).toHaveBeenCalledTimes(1);
    expect(removeRunFileIfOwned).not.toHaveBeenCalled();
    expect(releaseLease).not.toHaveBeenCalled();
  });

  it("retains discovery and the lifetime lease until a failed writable-store close is explicitly retried", async () => {
    let failClose = true;
    const closeStores = vi.fn(() => {
      if (failClose) throw new Error("injected store close failure");
    });
    const removeRunFileIfOwned = vi.fn();
    const releaseLease = vi.fn();
    const server = await startedServer({
      lifecycle: {
        publishRunFile() {},
        closeStores,
        removeRunFileIfOwned,
        releaseLease
      }
    });

    await expect(server.shutdown()).rejects.toThrow(/retained discovery and ownership/i);
    expect(server.state).toBe("failed");
    expect(closeStores).toHaveBeenCalledTimes(1);
    expect(removeRunFileIfOwned).not.toHaveBeenCalled();
    expect(releaseLease).not.toHaveBeenCalled();

    failClose = false;
    await expect(server.shutdown()).resolves.toBeUndefined();
    expect(server.state).toBe("closed");
    expect(closeStores).toHaveBeenCalledTimes(2);
    expect(removeRunFileIfOwned).toHaveBeenCalledTimes(1);
    expect(releaseLease).toHaveBeenCalledTimes(1);
  });

  it("drains an active SSE request, then closes stores, removes discovery, and releases the lease", async () => {
    const order: string[] = [];
    const streamStarted = deferred<void>();
    const finishStream = deferred<void>();
    const sse: ControlSseHandler = {
      prepare: () => ({
        async start({ response }) {
          response.write(": open\n\n");
          streamStarted.resolve();
          await finishStream.promise;
          response.end();
        }
      }),
      shutdown() {
        order.push("sse");
        finishStream.resolve();
      }
    };
    const server = await startedServer({
      sse,
      lifecycle: {
        closeStores: () => order.push("stores"),
        removeRunFileIfOwned: () => order.push("run-file"),
        releaseLease: () => order.push("lease")
      },
      drainTimeoutMs: 200
    });
    const address = server.address()!;
    const stream = fetch(`${address.url}/api/v1/runs/run-1/events?project=demo`);
    await streamStarted.promise;

    await server.shutdown();
    expect(order).toEqual(["sse", "stores", "run-file", "lease"]);
    const response = await stream;
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(": open");
  });

  it("enforces a deterministic total TCP connection cap", async () => {
    const server = await startedServer({ maxConnections: 1 });
    const port = server.address()!.port;
    const held = await connectSocket(port);
    openSockets.add(held);
    await until(() => server.activeConnections === 1);

    const rejected = await rawRequest(port, "GET /api/v1/health HTTP/1.1\r\nHost: 127.0.0.1:" + port + "\r\nConnection: close\r\n\r\n");
    expect(rawStatus(rejected)).toBe(503);
    expect(rawBody(rejected)).toMatchObject({ error: { code: "CAPACITY_EXCEEDED" } });
    expect(server.activeConnections).toBe(1);
  });

  it("destroys a client that does not complete request admission within the configured bound", async () => {
    const server = await startedServer({ admissionTimeoutMs: 30 });
    const socket = await connectSocket(server.address()!.port);
    openSockets.add(socket);
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.write("GET /api/v1/health HTTP/1.1\r\nHost:");

    await expect(Promise.race([
      closed.then(() => "closed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 500))
    ])).resolves.toBe("closed");
  });
});

describe("P1 control HTTP admission and routing", () => {
  it("allows only GET/HEAD on every known route and returns 404 for unknown API paths", async () => {
    const source = new FakeSource();
    const server = await startedServer({ projects: [project(source)] });
    const base = server.address()!.url;
    const known = [
      "/api/v1/health",
      "/api/v1/status",
      "/api/v1/runs",
      "/api/v1/runs/run-1",
      "/api/v1/runs/run-1/board",
      "/api/v1/runs/run-1/activity",
      "/api/v1/runs/run-1/diagnostics",
      "/api/v1/runs/run-1/events"
    ];
    for (const path of known) {
      const response = await fetch(base + path, { method: "POST" });
      expect(response.status, path).toBe(405);
      expect(response.headers.get("allow"), path).toBe("GET, HEAD");
      await expect(errorCode(response), path).resolves.toBe("METHOD_NOT_ALLOWED");
    }
    const unknown = await fetch(`${base}/api/v1/no-such-route`, { method: "POST" });
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("allow")).toBeNull();
    expect(source.projectionReads + source.headReads + source.rangeReads).toBe(0);

    const get = await fetch(`${base}/api/v1/status`);
    const getBytes = Buffer.from(await get.arrayBuffer());
    const head = await fetch(`${base}/api/v1/status`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(getBytes.byteLength));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  it("requires exact Host and same loopback Origin and rejects unsupported connection semantics", async () => {
    const server = await startedServer();
    const port = server.address()!.port;
    const badHost = await rawRequest(
      port,
      requestText(port, "/api/v1/health", ["Host", `localhost:${port}`, "Connection", "close"], false)
    );
    expect(rawStatus(badHost)).toBe(400);
    expect(rawBody(badHost)).toMatchObject({ error: { code: "INVALID_REQUEST" } });

    const badOrigin = await rawRequest(port, requestText(port, "/api/v1/health", ["Origin", "http://example.test"]));
    expect(rawStatus(badOrigin)).toBe(403);
    const allowedOrigin = await rawRequest(
      port,
      requestText(port, "/api/v1/health", ["Origin", `http://127.0.0.1:${port}`])
    );
    expect(rawStatus(allowedOrigin)).toBe(200);

    const connection = await rawRequest(
      port,
      requestText(
        port,
        "/api/v1/health",
        ["Host", `127.0.0.1:${port}`, "Connection", "upgrade", "Upgrade", "websocket"],
        false
      )
    );
    expect(rawStatus(connection)).toBe(405);

    const secret = "Bearer SECRET_HEADER_SENTINEL";
    const credential = await rawRequest(
      port,
      requestText(port, "/api/v1/health", ["Authorization", secret])
    );
    expect(rawStatus(credential)).toBe(400);
    expect(credential).not.toContain("SECRET_HEADER_SENTINEL");
  });

  it("enforces exact header accounting and request-target/query bounds before parsing", async () => {
    const server = await startedServer();
    const port = server.address()!.port;
    const host = `127.0.0.1:${port}`;
    const baseHeaders = ["Host", host, "Connection", "close", "X-Pad", ""];
    const padAtLimit = CONTROL_RELEVANT_HEADERS_MAX_BYTES - controlRequestHeaderBytes(baseHeaders);
    expect(padAtLimit).toBeGreaterThan(0);
    const exactHeaders = [...baseHeaders.slice(0, -1), "a".repeat(padAtLimit)];
    expect(controlRequestHeaderBytes(exactHeaders)).toBe(CONTROL_RELEVANT_HEADERS_MAX_BYTES);
    const accepted = await rawRequest(port, requestText(port, "/api/v1/health", exactHeaders, false));
    expect(rawStatus(accepted)).toBe(200);

    const tooLargeHeaders = [...baseHeaders.slice(0, -1), "a".repeat(padAtLimit + 1)];
    expect(controlRequestHeaderBytes(tooLargeHeaders)).toBe(CONTROL_RELEVANT_HEADERS_MAX_BYTES + 1);
    const rejected = await rawRequest(port, requestText(port, "/api/v1/health", tooLargeHeaders, false));
    expect(rawStatus(rejected)).toBe(431);

    const exactTarget = "/api/v1/health?x=" + "a".repeat(CONTROL_REQUEST_TARGET_MAX_BYTES - "/api/v1/health?x=".length);
    expect(Buffer.byteLength(exactTarget)).toBe(CONTROL_REQUEST_TARGET_MAX_BYTES);
    const exactTargetResponse = await rawRequest(port, requestText(port, exactTarget));
    expect(rawStatus(exactTargetResponse)).toBe(400); // admitted, then rejected as an unknown query
    const oversizedTarget = `${exactTarget}a`;
    const targetResponse = await rawRequest(port, requestText(port, oversizedTarget));
    expect(rawStatus(targetResponse)).toBe(414);

    const overlongCursor = `v1.${"a".repeat(510)}`;
    const cursor = await fetch(`${server.address()!.url}/api/v1/runs?project=demo&cursor=${overlongCursor}`);
    expect(cursor.status).toBe(400);
    const numeric = await fetch(`${server.address()!.url}/api/v1/runs?project=demo&limit=1x`);
    expect(numeric.status).toBe(400);

    const normalized = await rawRequest(port, requestText(port, "/api/v1/runs/../health"));
    expect(rawStatus(normalized)).toBe(400);
    const percentNormalized = await rawRequest(port, requestText(port, "/api/v1/runs/%2e%2e/health"));
    expect(rawStatus(percentNormalized)).toBe(400);
  });

  it("uses exact project/run ownership and maps store recovery without plausible empty success", async () => {
    const source = new FakeSource();
    const server = await startedServer({ projects: [project(source)] });
    const base = server.address()!.url;

    const foreignProject = await fetch(`${base}/api/v1/runs?project=demo-extra`);
    expect(foreignProject.status).toBe(404);
    const foreignRun = await fetch(`${base}/api/v1/runs/run-10/board?project=demo`);
    expect(foreignRun.status).toBe(404);
    const encodedRun = await fetch(`${base}/api/v1/runs/%72un-1/board?project=demo`);
    expect(encodedRun.status).toBe(400);
    expect(source.projectionReads).toBe(0);

    source.projectionError = new ControlStoreError("RECOVERY_REQUIRED", "private sqlite path");
    const recovery = await fetch(`${base}/api/v1/runs/run-1/board?project=demo`);
    expect(recovery.status).toBe(503);
    const recoveryText = await recovery.text();
    expect(recoveryText).not.toContain("sqlite");
    expect(JSON.parse(recoveryText)).toMatchObject({ error: { code: "RECOVERY_REQUIRED" } });

    source.projectionError = undefined;
    source.rangeError = new ControlStoreError("CURSOR_EXPIRED", "private details", {
      floorSeq: 4,
      headSeq: 8,
      snapshotSeq: 3,
      path: "/private/store.sqlite"
    });
    const expired = await fetch(`${base}/api/v1/runs/run-1/activity?project=demo&after=0`);
    expect(expired.status).toBe(410);
    await expect(expired.json()).resolves.toMatchObject({
      error: { code: "CURSOR_EXPIRED", details: { floorSeq: 4, headSeq: 8, snapshotSeq: 3 } }
    });
  });

  it("serves all versioned read models, mounts injected SSE, and never invokes mutation authority", async () => {
    const source = new FakeSource();
    const sse: ControlSseHandler = {
      prepare: vi.fn(() => ({
        start({ response }) {
          response.end("event: control.ready\ndata: {}\n\n");
        }
      }))
    };
    const prepared = vi.mocked(sse.prepare);
    const server = await startedServer({
      projects: [project(source)],
      sse,
      diagnosticChecks: () => [{ code: "canary", status: "ok", message: "token=SUPER_SECRET_SENTINEL", fix: null }]
    });
    const base = server.address()!.url;
    for (const path of [
      "/api/v1/status",
      "/api/v1/runs?project=demo",
      "/api/v1/runs/run-1?project=demo",
      "/api/v1/runs/run-1/board?project=demo",
      "/api/v1/runs/run-1/activity?project=demo",
      "/api/v1/runs/run-1/diagnostics?project=demo"
    ]) {
      const response = await fetch(base + path);
      expect(response.status, path).toBe(200);
      const text = await response.text();
      expect(() => JSON.parse(text), path).not.toThrow();
      expect(text, path).not.toContain("SUPER_SECRET_SENTINEL");
    }
    const head = await fetch(`${base}/api/v1/runs/run-1/events?project=demo`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(prepared).not.toHaveBeenCalled();
    const stream = await fetch(`${base}/api/v1/runs/run-1/events?project=demo&runEpoch=${RUN_EPOCH}&after=1`);
    expect(stream.status).toBe(200);
    expect(await stream.text()).toContain("control.ready");
    expect(prepared).toHaveBeenCalledWith(expect.objectContaining({
      project: "demo",
      run: "run-1",
      source,
      cursor: expect.objectContaining({ runEpoch: RUN_EPOCH, after: "1" })
    }));
    expect(source.mutations).toBe(0);
  });

  it("uses the admission timeout only until headers complete, so an admitted SSE stream remains alive", async () => {
    const source = new FakeSource();
    const server = await startedServer({
      projects: [project(source)],
      admissionTimeoutMs: 20,
      sse: {
        prepare: () => ({
          async start({ response }) {
            response.write(": admitted\n\n");
            await new Promise((resolve) => setTimeout(resolve, 70));
            response.end(": complete\n\n");
          }
        })
      }
    });

    const response = await fetch(`${server.address()!.url}/api/v1/runs/run-1/events?project=demo`);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(": admitted\n\n: complete\n\n");
  });

  it("maps synchronous SSE capacity refusal to a bounded JSON error before streaming headers", async () => {
    const server = await startedServer({
      sse: {
        prepare() {
          throw Object.assign(new Error("private subscriber detail"), { code: "CAPACITY_EXCEEDED" });
        }
      }
    });
    const response = await fetch(`${server.address()!.url}/api/v1/runs/run-1/events?project=demo`);
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const text = await response.text();
    expect(text).not.toContain("private subscriber detail");
    expect(JSON.parse(text)).toMatchObject({ error: { code: "CAPACITY_EXCEEDED" } });
  });

  it("accepts a response at its exact byte ceiling and emits one bounded 413 with no partial DTO at plus one", async () => {
    const source = new FakeSource();
    const projects = [project(source)];
    const dto = buildControlStatus({
      instanceId: INSTANCE_ID,
      configId: CONFIG_ID,
      startedAt: NOW,
      projects,
      now: NOW_MS
    });
    const exactBytes = serializeControlResponse("status", dto).bytes;

    const exact = await startedServer({ projects, responseLimits: { status: exactBytes } });
    const exactResponse = await fetch(`${exact.address()!.url}/api/v1/status`);
    expect(exactResponse.status).toBe(200);
    expect(Number(exactResponse.headers.get("content-length"))).toBe(exactBytes);
    expect((await exactResponse.arrayBuffer()).byteLength).toBe(exactBytes);

    const over = await startedServer({ projects, responseLimits: { status: exactBytes - 1 } });
    const overResponse = await fetch(`${over.address()!.url}/api/v1/status`);
    expect(overResponse.status).toBe(413);
    const body = Buffer.from(await overResponse.arrayBuffer());
    expect(Number(overResponse.headers.get("content-length"))).toBe(body.byteLength);
    const parsed = JSON.parse(body.toString("utf8"));
    expect(parsed).toMatchObject({ error: { code: "RESPONSE_TOO_LARGE" } });
    expect(parsed).not.toHaveProperty("projects");
    expect(body.toString("utf8")).not.toContain(`"service":"relayforge-control"`);
  });
});

function runningProjection(runId: string, runEpoch: string): ControlProjection {
  const projection = emptyControlProjection(runId, runEpoch);
  projection.headSeq = 1;
  projection.run = {
    status: "started",
    startedBy: "parent",
    startedAt: NOW,
    version: 1,
    updatedSeq: 1
  };
  return projection;
}

function project(source = new FakeSource()): ControlProjectViewSource {
  return { project: "demo", runs: [source], sessions: [] };
}

function runFile(port: number): ControlRunFile {
  return {
    schemaVersion: 1,
    service: "relayforge-control",
    instanceId: INSTANCE_ID,
    configId: CONFIG_ID,
    pid: process.pid,
    processStartToken: `linux:${process.pid}`,
    host: "127.0.0.1",
    port,
    startedAt: NOW
  };
}

type TestOptions = Partial<ControlServerOptions> & {
  projects?: readonly ControlProjectViewSource[];
  diagnosticChecks?: ControlServerOptions["readModels"]["diagnosticChecks"];
};

function serverOptions(overrides: TestOptions = {}): ControlServerOptions {
  const {
    projects = [project()],
    diagnosticChecks,
    readModels,
    ...productOverrides
  } = overrides;
  return {
    port: 0,
    allowEphemeralPortForTests: true,
    createRunFile: runFile,
    readModels: {
      projects: () => projects,
      diagnosticChecks
    },
    requestId: () => "request-1",
    now: () => NOW_MS,
    ...productOverrides,
    readModels: readModels ?? {
      projects: () => projects,
      diagnosticChecks
    }
  };
}

async function startedServer(overrides: TestOptions = {}): Promise<ControlHttpServer> {
  const server = tracked(createControlServer(serverOptions(overrides)));
  await server.start();
  return server;
}

function tracked(server: ControlHttpServer): ControlHttpServer {
  openServers.add(server);
  return server;
}

async function errorCode(response: Response): Promise<string> {
  const value = await response.json() as { error: { code: string } };
  return value.error.code;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value?: T): void;
  reject(error: unknown): void;
} {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value?: T) {
      resolvePromise(value as T);
    },
    reject: rejectPromise
  };
}

async function waitForAddress(server: ControlHttpServer): Promise<NonNullable<ReturnType<ControlHttpServer["address"]>>> {
  await until(() => server.address() !== undefined && server.runFile !== undefined);
  return server.address()!;
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function listenNode(server: NodeServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function closeNodeServer(server: NodeServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function connectSocket(port: number): Promise<Socket> {
  return await new Promise<Socket>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function rawRequest(port: number, request: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    openSockets.add(socket);
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("raw request timed out"));
    }, 2_000);
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("end", () => {
      clearTimeout(timer);
      openSockets.delete(socket);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    socket.once("connect", () => socket.write(request));
  });
}

function requestText(
  port: number,
  target: string,
  extra: readonly string[] = [],
  includeDefaults = true
): string {
  const headers = includeDefaults ? ["Host", `127.0.0.1:${port}`, "Connection", "close", ...extra] : [...extra];
  const lines = [`GET ${target} HTTP/1.1`];
  for (let index = 0; index < headers.length; index += 2) {
    lines.push(`${headers[index]}: ${headers[index + 1]}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

function rawStatus(response: string): number {
  const match = /^HTTP\/1\.1 (\d{3})/.exec(response);
  if (!match) throw new Error(`invalid raw HTTP response: ${response.slice(0, 80)}`);
  return Number(match[1]);
}

function rawBody(response: string): unknown {
  const separator = response.indexOf("\r\n\r\n");
  if (separator < 0) throw new Error("raw response has no body separator");
  return JSON.parse(response.slice(separator + 4));
}

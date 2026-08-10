import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import {
  buildSteeringDashboardData,
  STEERING_DASHBOARD_MAX_BYTES
} from "../dashboard/steering-data.js";
import {
  buildControlRoomSnapshot,
  ControlRoomReadError,
  serializeControlRoomSnapshot,
  type ControlRoomReadSource
} from "../control-room/server-adapter.js";
import { ControlRoomQueryError } from "../control-room/query.js";
import { isValidId } from "../ids.js";
import {
  CONTROL_ACTIVITY_DEFAULT_LIMIT,
  CONTROL_ACTIVITY_MAX_LIMIT,
  CONTROL_ADMISSION_TIMEOUT_MS,
  CONTROL_DIAGNOSTIC_DEFAULT_LINES,
  CONTROL_DIAGNOSTIC_MAX_LINES,
  CONTROL_ERROR_MAX_BYTES,
  CONTROL_GRACEFUL_DRAIN_TIMEOUT_MS,
  CONTROL_HOST,
  CONTROL_MAX_CONNECTIONS,
  CONTROL_PROTOCOL_VERSION,
  CONTROL_RELEVANT_HEADERS_MAX_BYTES,
  CONTROL_REQUEST_TARGET_MAX_BYTES,
  CONTROL_RESPONSE_LIMITS,
  CONTROL_RUNS_DEFAULT_LIMIT,
  CONTROL_RUNS_MAX_LIMIT,
  CONTROL_SERVICE,
  ControlPayloadTooLargeError,
  ControlProtocolError,
  makeControlError,
  parseControlHealth,
  parseControlRunFile,
  parseOptionalDecimal,
  parsePageCursor,
  parseSseCursor,
  serializeControlJson,
  serializeControlResponse,
  type ControlDiagnosticCheck,
  type ControlErrorCode,
  type ControlErrorDetails,
  type ControlResponseKind,
  type ControlRunFile,
  type SseCursorInput
} from "./protocol.js";
import type { DeepRedactionOptions } from "./redaction.js";
import {
  ControlViewError,
  buildControlActivity,
  buildControlBoard,
  buildControlDiagnostics,
  buildControlRun,
  buildControlRuns,
  buildControlStatus,
  type ControlDiagnosticCapture,
  type ControlProjectViewSource,
  type ControlViewSource
} from "./views.js";

/** HTTP parser allowance above the smaller application request-target/header gates. */
const CONTROL_HTTP_PARSER_MAX_BYTES =
  CONTROL_REQUEST_TARGET_MAX_BYTES + CONTROL_RELEVANT_HEADERS_MAX_BYTES + 2 * 1024;

export const CONTROL_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; connect-src 'self'"
});

/** The dashboard is one self-contained document. Keep it finite before buffering it. */
export const CONTROL_DASHBOARD_MAX_BYTES = 2 * 1024 * 1024;

export type ControlServerReadModels = {
  /** Return only sources owned by the loaded configuration. The server performs exact identity checks. */
  projects(): readonly ControlProjectViewSource[];
  captureDiagnostics?: ControlDiagnosticCapture;
  diagnosticChecks?: (input: {
    project: string;
    run: string;
    source: ControlViewSource;
  }) => readonly ControlDiagnosticCheck[];
  /** Optional P5 normalized observation source. Raw transcripts/PTY data are never accepted. */
  controlRoom?: (input: {
    project: string;
    run: string;
    source: ControlViewSource;
  }) => ControlRoomReadSource | undefined;
};

export type ControlDashboardDocument = {
  /** Render a self-contained document. Inline style/script tags receive a per-response CSP nonce. */
  render(): string;
  maxBytes?: number;
};

export type PreparedControlSse = {
  /** Called only after every HTTP/identity/cursor gate passed and the SSE headers were committed. */
  start(input: {
    request: IncomingMessage;
    response: ServerResponse;
    signal: AbortSignal;
  }): void | Promise<void>;
};

/**
 * SSE admission is deliberately split from execution. `prepare` is synchronous and may reject a
 * subscriber-capacity or source error before the server sends streaming headers.
 */
export type ControlSseHandler = {
  prepare(input: {
    request: IncomingMessage;
    project: string;
    run: string;
    source: ControlViewSource;
    cursor: SseCursorInput;
  }): PreparedControlSse;
  shutdown?(): void | Promise<void>;
};

export type ControlServerLifecycle = {
  /** Durable publication occurs only after the exact loopback listener is bound. */
  publishRunFile?: (runFile: ControlRunFile) => void | Promise<void>;
  /** Store closure precedes discovery cleanup and lifetime-lease release. */
  closeStores?: () => void | Promise<void>;
  /** Must implement remove-if-instance semantics; it is called while the lease is still held. */
  removeRunFileIfOwned?: (runFile: ControlRunFile) => void | Promise<void>;
  /** Always last in shutdown and best-effort startup rollback. */
  releaseLease?: () => void | Promise<void>;
};

export type ControlServerOptions = {
  port: number;
  /** Port zero is an explicit test seam and is rejected unless this is true. */
  allowEphemeralPortForTests?: boolean;
  createRunFile(boundPort: number): ControlRunFile;
  readModels: ControlServerReadModels;
  dashboard?: ControlDashboardDocument;
  sse?: ControlSseHandler;
  lifecycle?: ControlServerLifecycle;
  redaction?: DeepRedactionOptions;
  requestId?: () => string;
  now?: () => number;
  responseLimits?: Partial<Record<ControlResponseKind, number>>;
  maxConnections?: number;
  admissionTimeoutMs?: number;
  drainTimeoutMs?: number;
  onRuntimeError?: (error: Error) => void;
};

export type ControlServerAddress = {
  host: typeof CONTROL_HOST;
  port: number;
  url: string;
};

export type ControlServerState = "created" | "starting" | "ready" | "closing" | "closed" | "failed";

export class ControlServerStartError extends Error {
  constructor(
    readonly code: "ADDRESS_IN_USE" | "PERMISSION_DENIED" | "START_FAILED",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ControlServerStartError";
  }
}

export class ControlServerShutdownError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ControlServerShutdownError";
  }
}

type Route =
  | { kind: "dashboard" }
  | { kind: "health" }
  | { kind: "status" }
  | { kind: "runs" }
  | { kind: "run"; rawRun: string }
  | { kind: "board"; rawRun: string }
  | { kind: "activity"; rawRun: string }
  | { kind: "steering"; rawRun: string }
  | { kind: "observations"; rawRun: string }
  | { kind: "diagnostics"; rawRun: string }
  | { kind: "events"; rawRun: string }
  | { kind: "unknown" };

type MappedControlError = {
  status: number;
  code: ControlErrorCode;
  message: string;
  details?: ControlErrorDetails;
};

class ControlRouteError extends Error {
  constructor(readonly mapped: MappedControlError) {
    super(mapped.message);
    this.name = "ControlRouteError";
  }
}

type ResolvedServerOptions = Omit<
  ControlServerOptions,
  "maxConnections" | "admissionTimeoutMs" | "drainTimeoutMs" | "requestId" | "now" | "responseLimits"
> & {
  maxConnections: number;
  admissionTimeoutMs: number;
  drainTimeoutMs: number;
  requestId: () => string;
  now: () => number;
  responseLimits: Readonly<Record<ControlResponseKind, number>>;
};

/**
 * One loopback-only, read-only control-plane HTTP service. The caller retains canonical store
 * write authority and supplies lifetime/run-file callbacks whose ordering is enforced here.
 */
export class ControlHttpServer {
  readonly nodeServer: Server;
  private readonly options: ResolvedServerOptions;
  private readonly sockets = new Set<Socket>();
  private readonly rejectedSockets = new WeakSet<Socket>();
  private readonly requestControllers = new Set<AbortController>();
  private stateValue: ControlServerState = "created";
  private readyValue = false;
  private runFileValue: ControlRunFile | undefined;
  private startPromise: Promise<ControlServerAddress> | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private leaseReleased = false;

  constructor(options: ControlServerOptions) {
    this.options = resolveServerOptions(options);
    this.nodeServer = createServer(
      {
        maxHeaderSize: CONTROL_HTTP_PARSER_MAX_BYTES,
        insecureHTTPParser: false,
        requireHostHeader: true
      },
      (request, response) => {
        void this.dispatch(request, response);
      }
    );
    this.nodeServer.headersTimeout = this.options.admissionTimeoutMs;
    this.nodeServer.requestTimeout = this.options.admissionTimeoutMs;
    this.nodeServer.keepAliveTimeout = this.options.admissionTimeoutMs;
    this.nodeServer.on("connection", (socket) => this.admitSocket(socket));
    this.nodeServer.on("clientError", (error, socket) => this.rejectParserError(error, socket));
    this.nodeServer.on("upgrade", (request, socket) => this.rejectUpgrade(request, socket));
    this.nodeServer.on("error", (error) => {
      if (this.stateValue === "ready") this.options.onRuntimeError?.(toError(error));
    });
  }

  get state(): ControlServerState {
    return this.stateValue;
  }

  get ready(): boolean {
    return this.readyValue;
  }

  get runFile(): ControlRunFile | undefined {
    return this.runFileValue;
  }

  get activeConnections(): number {
    return this.sockets.size;
  }

  address(): ControlServerAddress | undefined {
    const address = this.nodeServer.address();
    if (address === null || typeof address === "string") return undefined;
    return { host: CONTROL_HOST, port: address.port, url: `http://${CONTROL_HOST}:${address.port}` };
  }

  start(): Promise<ControlServerAddress> {
    if (this.startPromise !== undefined) return this.startPromise;
    if (this.stateValue !== "created") {
      return Promise.reject(new ControlServerStartError("START_FAILED", `Cannot start a control server in state ${this.stateValue}.`));
    }
    this.stateValue = "starting";
    this.startPromise = this.startInternal();
    return this.startPromise;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise !== undefined) return this.shutdownPromise;
    const attempt = this.shutdownInternal();
    this.shutdownPromise = attempt.catch((error) => {
      // A store-close refusal deliberately retains the mutex. Permit an explicit retry against the
      // same idempotent lifecycle callbacks; concurrent callers still share this attempt.
      if (!this.leaseReleased) this.shutdownPromise = undefined;
      throw error;
    });
    return this.shutdownPromise;
  }

  private async startInternal(): Promise<ControlServerAddress> {
    try {
      await listenExactly(this.nodeServer, this.options.port);
      const address = requireLoopbackAddress(this.nodeServer);
      const runFile = parseControlRunFile(this.options.createRunFile(address.port));
      if (runFile.host !== CONTROL_HOST || runFile.port !== address.port) {
        throw new Error("The run-file identity does not match the bound loopback listener.");
      }
      this.runFileValue = runFile;
      await this.options.lifecycle?.publishRunFile?.(runFile);
      this.readyValue = true;
      this.stateValue = "ready";
      return address;
    } catch (error) {
      this.readyValue = false;
      this.stateValue = "failed";
      await ignoreFailure(() => this.rollbackStartup());
      throw mapStartError(error, this.options.port);
    }
  }

  private async rollbackStartup(): Promise<void> {
    await closeImmediately(this.nodeServer, this.sockets);
    // A writable store that failed to close must remain fenced by the lifetime lease. Removing
    // discovery/releasing here would allow a successor to open the same authority concurrently.
    await this.options.lifecycle?.closeStores?.();
    if (this.runFileValue !== undefined) {
      await ignoreFailure(() => this.options.lifecycle?.removeRunFileIfOwned?.(this.runFileValue!));
    }
    await ignoreFailure(() => this.releaseLease());
  }

  private async shutdownInternal(): Promise<void> {
    if (this.stateValue === "closed") return;
    if (this.stateValue === "starting" && this.startPromise !== undefined) {
      try {
        await this.startPromise;
      } catch {
        if (this.leaseReleased) {
          this.stateValue = "closed";
          return;
        }
      }
    }

    this.stateValue = "closing";
    this.readyValue = false;
    let firstFailure: unknown;
    try {
      await this.options.sse?.shutdown?.();
    } catch (error) {
      firstFailure = error;
    }
    for (const controller of this.requestControllers) controller.abort();
    try {
      await drainAndClose(this.nodeServer, this.sockets, this.options.drainTimeoutMs);
    } catch (error) {
      firstFailure ??= error;
    }
    let storeCloseFailure: unknown;
    try {
      await this.options.lifecycle?.closeStores?.();
    } catch (error) {
      storeCloseFailure = error;
      firstFailure ??= error;
    }
    if (storeCloseFailure !== undefined) {
      this.stateValue = "failed";
      throw new ControlServerShutdownError(
        "The control server closed its listener but retained discovery and ownership because a writable store did not close.",
        { cause: firstFailure }
      );
    }
    if (this.runFileValue !== undefined) {
      try {
        await this.options.lifecycle?.removeRunFileIfOwned?.(this.runFileValue);
      } catch (error) {
        firstFailure ??= error;
      }
    }
    try {
      await this.releaseLease();
    } catch (error) {
      firstFailure ??= error;
    }
    this.stateValue = this.leaseReleased ? "closed" : "failed";
    if (firstFailure !== undefined) {
      throw new ControlServerShutdownError("The control server closed with a lifecycle cleanup failure.", {
        cause: firstFailure
      });
    }
  }

  private async releaseLease(): Promise<void> {
    if (this.leaseReleased) return;
    await this.options.lifecycle?.releaseLease?.();
    this.leaseReleased = true;
  }

  private admitSocket(socket: Socket): void {
    // `server.maxConnections` is advisory across Node versions; this gate is the authority.
    if (this.stateValue === "closing" || this.stateValue === "closed" || this.sockets.size >= this.options.maxConnections) {
      this.rejectedSockets.add(socket);
      writeRawError(socket, 503, this.errorDocument("CAPACITY_EXCEEDED", "The control service connection limit has been reached."));
      return;
    }
    this.sockets.add(socket);
    socket.setTimeout(this.options.admissionTimeoutMs, () => socket.destroy());
    socket.once("close", () => this.sockets.delete(socket));
  }

  private rejectParserError(_error: Error, socket: Duplex): void {
    if (socket.destroyed) return;
    writeRawError(socket, 431, this.errorDocument("INVALID_REQUEST", "The control request headers are invalid or too large."));
  }

  private rejectUpgrade(request: IncomingMessage, socket: Duplex): void {
    if (socket.destroyed) return;
    let status = 404;
    let code: ControlErrorCode = "NOT_FOUND";
    let message = "The requested control endpoint was not found.";
    try {
      assertAdmissionRequest(request, this.boundPort(), true);
      const route = matchRoute(parseRequestUrl(request.url ?? "", this.boundPort()).pathname);
      if (route.kind !== "unknown") {
        status = 405;
        code = "METHOD_NOT_ALLOWED";
        message = "The control endpoint permits only GET and HEAD.";
      }
    } catch {
      status = 400;
      code = "INVALID_REQUEST";
      message = "The control request was rejected by the admission policy.";
    }
    writeRawError(socket, status, this.errorDocument(code, message), status === 405 ? { Allow: "GET, HEAD" } : undefined);
  }

  private async dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.rejectedSockets.has(request.socket)) {
      request.socket.destroy();
      return;
    }
    // The per-socket timer covers incomplete admission only. Once Node has produced a complete
    // request, its request/keep-alive timers (and the SSE broker heartbeat/drain bounds) take over.
    request.socket.setTimeout(0);
    const controller = new AbortController();
    this.requestControllers.add(controller);
    const abort = (): void => controller.abort();
    request.once("aborted", abort);
    response.once("close", abort);
    const requestId = this.nextRequestId();
    const head = request.method === "HEAD";
    try {
      const port = this.boundPort();
      assertAdmissionRequest(request, port);
      const url = parseRequestUrl(request.url ?? "", port);
      const route = matchRoute(url.pathname);
      if (route.kind === "unknown") {
        throw routeError(404, "NOT_FOUND", "The requested control endpoint was not found.");
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.setHeader("allow", "GET, HEAD");
        throw routeError(405, "METHOD_NOT_ALLOWED", "The control endpoint permits only GET and HEAD.");
      }
      if (route.kind !== "health" && !this.readyValue) {
        throw routeError(503, "NOT_READY", "The control service is not ready.", { retryAfterMs: 250 });
      }

      switch (route.kind) {
        case "dashboard": {
          requireQuery(url, [], []);
          if (this.options.dashboard === undefined) {
            throw routeError(404, "NOT_FOUND", "The requested control endpoint was not found.");
          }
          this.writeDashboard(response, head);
          return;
        }
        case "health": {
          requireQuery(url, [], []);
          const runFile = this.requireRunFile();
          const dto = parseControlHealth({
            schemaVersion: CONTROL_PROTOCOL_VERSION,
            service: CONTROL_SERVICE,
            instanceId: runFile.instanceId,
            configId: runFile.configId,
            pid: runFile.pid,
            status: this.readyValue ? "ok" : "starting",
            startedAt: runFile.startedAt
          });
          this.writeDto(response, head, "health", dto);
          return;
        }
        case "status": {
          requireQuery(url, [], []);
          const runFile = this.requireRunFile();
          const dto = buildControlStatus({
            instanceId: runFile.instanceId,
            configId: runFile.configId,
            startedAt: runFile.startedAt,
            projects: this.projects(),
            now: this.options.now()
          });
          this.writeDto(response, head, "status", dto);
          return;
        }
        case "runs": {
          const query = requireQuery(url, ["project", "limit", "cursor"], ["project"]);
          const project = requireId(query.get("project"), "project");
          const limit = parseOptionalDecimal(query.get("limit"), CONTROL_RUNS_DEFAULT_LIMIT, {
            name: "limit",
            minimum: 1,
            maximum: CONTROL_RUNS_MAX_LIMIT
          });
          const cursorValue = query.get("cursor");
          const cursor = cursorValue === null ? null : parsePageCursor(cursorValue);
          const selected = this.project(project);
          const dto = buildControlRuns({ project, sources: selected.runs, limit, cursor });
          this.writeDto(response, head, "runs", dto);
          return;
        }
        case "run": {
          const query = requireQuery(url, ["project"], ["project"]);
          const project = requireId(query.get("project"), "project");
          const run = requireId(route.rawRun, "run");
          const source = this.run(this.project(project), run);
          this.writeDto(response, head, "run", buildControlRun({ project, run, source }));
          return;
        }
        case "board": {
          const query = requireQuery(url, ["project"], ["project"]);
          const project = requireId(query.get("project"), "project");
          const run = requireId(route.rawRun, "run");
          const source = this.run(this.project(project), run);
          this.writeDto(response, head, "board", buildControlBoard({ project, run, source }));
          return;
        }
        case "activity": {
          const query = requireQuery(url, ["project", "after", "limit"], ["project"]);
          const project = requireId(query.get("project"), "project");
          const run = requireId(route.rawRun, "run");
          const after = parseOptionalDecimal(query.get("after"), 0, { name: "after" });
          const limit = parseOptionalDecimal(query.get("limit"), CONTROL_ACTIVITY_DEFAULT_LIMIT, {
            name: "limit",
            minimum: 1,
            maximum: CONTROL_ACTIVITY_MAX_LIMIT
          });
          const source = this.run(this.project(project), run);
          const dto = buildControlActivity({ project, run, source, after, limit });
          this.writeDto(response, head, "activity", dto);
          return;
        }
        case "steering": {
          const query = requireQuery(url, ["project"], ["project"]);
          const project = requireId(query.get("project"), "project");
          const run = requireId(route.rawRun, "run");
          const source = this.run(this.project(project), run);
          const dto = buildSteeringDashboardData({
            project,
            source,
            nowMs: this.options.now(),
            redaction: this.options.redaction
          });
          this.writeSteeringDto(response, head, dto);
          return;
        }
        case "observations": {
          const query = requireQuery(url, ["project", "cursor", "after", "limit"], ["project"]);
          const project = requireId(query.get("project"), "project");
          const run = requireId(route.rawRun, "run");
          const source = this.run(this.project(project), run);
          const controlRoom = this.options.readModels.controlRoom?.({ project, run, source });
          if (controlRoom === undefined) {
            throw routeError(503, "NOT_READY", "The normalized observation projection is not available.", { retryAfterMs: 250 });
          }
          const cursor = query.get("cursor") ?? undefined;
          const afterValue = query.get("after");
          const afterSeq = afterValue === null ? undefined : parseOptionalDecimal(afterValue, 0, { name: "after" });
          if (cursor !== undefined && afterSeq !== undefined) {
            throw routeError(400, "INVALID_REQUEST", "Observation cursor and after sequence are mutually exclusive.");
          }
          const limit = parseOptionalDecimal(query.get("limit"), 100, { name: "limit", minimum: 1, maximum: 500 });
          const dto = buildControlRoomSnapshot(controlRoom, { observation: { ...(cursor === undefined ? {} : { cursor }), ...(afterSeq === undefined ? {} : { afterSeq }), limit } });
          const serialized = serializeControlRoomSnapshot(dto);
          writeBufferedResponse(response, 200, serialized.body, "application/json; charset=utf-8", head);
          return;
        }
        case "diagnostics": {
          const query = requireQuery(url, ["project", "session", "lines"], ["project"]);
          const project = requireId(query.get("project"), "project");
          const run = requireId(route.rawRun, "run");
          const lines = parseOptionalDecimal(query.get("lines"), CONTROL_DIAGNOSTIC_DEFAULT_LINES, {
            name: "lines",
            minimum: 0,
            maximum: CONTROL_DIAGNOSTIC_MAX_LINES
          });
          const selected = this.project(project);
          const source = this.run(selected, run);
          const dto = buildControlDiagnostics({
            project,
            run,
            source,
            sessions: selected.sessions ?? [],
            session: query.get("session"),
            lines,
            checks: this.options.readModels.diagnosticChecks?.({ project, run, source }),
            capture: this.options.readModels.captureDiagnostics,
            now: this.options.now()
          });
          this.writeDto(response, head, "diagnostics", dto);
          return;
        }
        case "events": {
          const query = requireQuery(url, ["project", "runEpoch", "after"], ["project"]);
          const project = requireId(query.get("project"), "project");
          const run = requireId(route.rawRun, "run");
          const source = this.run(this.project(project), run);
          const cursor: SseCursorInput = {
            runEpoch: query.get("runEpoch"),
            after: query.get("after"),
            lastEventId: singleRawHeader(request.rawHeaders, "last-event-id")
          };
          // Cursor validation belongs to the shared wire contract and happens before SSE admission.
          parseSseCursor(cursor);
          if (this.options.sse === undefined) {
            throw routeError(503, "NOT_READY", "The control event stream is not available.", { retryAfterMs: 250 });
          }
          if (head) {
            writeSseHeaders(response);
            response.end();
            return;
          }
          const prepared = this.options.sse.prepare({ request, project, run, source, cursor });
          if (!prepared || typeof prepared.start !== "function") {
            throw new Error("The SSE handler returned an invalid prepared stream.");
          }
          writeSseHeaders(response);
          await prepared.start({ request, response, signal: controller.signal });
          if (!response.writableEnded && !response.destroyed) response.end();
          return;
        }
      }
    } catch (error) {
      if (response.headersSent || response.writableEnded) {
        response.destroy();
      } else {
        this.writeMappedError(response, head, requestId, mapControlError(error));
      }
    } finally {
      request.off("aborted", abort);
      response.off("close", abort);
      this.requestControllers.delete(controller);
    }
  }

  private projects(): readonly ControlProjectViewSource[] {
    const projects = this.options.readModels.projects();
    if (!Array.isArray(projects)) throw new Error("The control read-model registry is invalid.");
    const identities = new Set<string>();
    for (const project of projects) {
      if (!isValidId(project.project) || identities.has(project.project) || !Array.isArray(project.runs)) {
        throw new Error("The control read-model registry has inconsistent project ownership.");
      }
      identities.add(project.project);
    }
    return projects;
  }

  private project(project: string): ControlProjectViewSource {
    const matches = this.projects().filter((candidate) => candidate.project === project);
    if (matches.length === 0) throw routeError(404, "NOT_FOUND", "The requested control resource was not found.");
    if (matches.length !== 1) throw new Error("The control read-model registry has duplicate project ownership.");
    return matches[0]!;
  }

  private run(project: ControlProjectViewSource, run: string): ControlViewSource {
    const matches = project.runs.filter((candidate) => candidate.runId === run);
    if (matches.length === 0) throw routeError(404, "NOT_FOUND", "The requested control resource was not found.");
    if (matches.length !== 1) throw new Error("The control read-model registry has duplicate run ownership.");
    return matches[0]!;
  }

  private requireRunFile(): ControlRunFile {
    if (this.runFileValue === undefined) throw routeError(503, "NOT_READY", "The control service is starting.");
    return this.runFileValue;
  }

  private boundPort(): number {
    const address = this.address();
    if (address === undefined) throw routeError(503, "NOT_READY", "The control service listener is not ready.");
    return address.port;
  }

  private writeDto(response: ServerResponse, head: boolean, kind: ControlResponseKind, value: unknown): void {
    // The protocol serializer performs schema validation, deep redaction, one serialization and
    // the canonical route cap. A smaller injected cap is a deterministic boundary-test seam.
    let serialized: ReturnType<typeof serializeControlResponse>;
    try {
      serialized = serializeControlResponse(kind, value, this.options.redaction);
    } catch (error) {
      if (error instanceof ControlProtocolError) {
        throw routeError(503, "RECOVERY_REQUIRED", "The control read model does not match the v1 protocol.");
      }
      throw error;
    }
    const maximum = this.options.responseLimits[kind];
    if (serialized.bytes > maximum) throw new ControlPayloadTooLargeError(maximum, serialized.bytes);
    writeBufferedResponse(response, 200, serialized.body, "application/json; charset=utf-8", head);
  }

  private writeSteeringDto(response: ServerResponse, head: boolean, value: unknown): void {
    // The P2 builder is a closed typed projection; the shared serializer still performs a second
    // deep-redaction pass and enforces the final on-wire byte bound before any headers are sent.
    const serialized = serializeControlJson(value, STEERING_DASHBOARD_MAX_BYTES, this.options.redaction);
    writeBufferedResponse(response, 200, serialized.body, "application/json; charset=utf-8", head);
  }

  private writeDashboard(response: ServerResponse, head: boolean): void {
    const dashboard = this.options.dashboard;
    if (dashboard === undefined) throw new Error("The dashboard renderer is unavailable.");
    const maximum = dashboard.maxBytes ?? CONTROL_DASHBOARD_MAX_BYTES;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > CONTROL_DASHBOARD_MAX_BYTES) {
      throw new Error("The dashboard byte bound is invalid.");
    }
    const nonce = randomBytes(24).toString("base64");
    const html = applyDashboardNonce(dashboard.render(), nonce);
    const body = Buffer.from(html, "utf8");
    if (body.byteLength > maximum) throw new ControlPayloadTooLargeError(maximum, body.byteLength);
    writeBufferedResponse(
      response,
      200,
      body,
      "text/html; charset=utf-8",
      head,
      dashboardSecurityHeaders(nonce)
    );
  }

  private writeMappedError(
    response: ServerResponse,
    head: boolean,
    requestId: string,
    mapped: MappedControlError
  ): void {
    if (mapped.status === 405) response.setHeader("allow", "GET, HEAD");
    const document = makeControlError(mapped.code, mapped.message, requestId, mapped.details);
    const serialized = serializeControlJson(document, CONTROL_ERROR_MAX_BYTES, this.options.redaction);
    writeBufferedResponse(response, mapped.status, serialized.body, "application/json; charset=utf-8", head);
  }

  private errorDocument(code: ControlErrorCode, message: string): Buffer {
    const document = makeControlError(code, message, this.nextRequestId());
    return serializeControlJson(document, CONTROL_ERROR_MAX_BYTES, this.options.redaction).body;
  }

  private nextRequestId(): string {
    try {
      const candidate = this.options.requestId();
      if (/^[A-Za-z0-9._-]{1,128}$/.test(candidate)) return candidate;
    } catch {
      // Fall through to a locally generated non-secret identifier.
    }
    return `req-${randomBytes(12).toString("hex")}`;
  }
}

export function createControlServer(options: ControlServerOptions): ControlHttpServer {
  return new ControlHttpServer(options);
}

export async function startControlServer(options: ControlServerOptions): Promise<ControlHttpServer> {
  const server = createControlServer(options);
  await server.start();
  return server;
}

/** Exact application accounting for the raw header section (excluding the terminal blank line). */
export function controlRequestHeaderBytes(rawHeaders: readonly string[]): number {
  if (rawHeaders.length % 2 !== 0) return Number.POSITIVE_INFINITY;
  let total = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    total += Buffer.byteLength(rawHeaders[index] ?? "", "utf8");
    total += 2;
    total += Buffer.byteLength(rawHeaders[index + 1] ?? "", "utf8");
    total += 2;
  }
  return total;
}

function resolveServerOptions(options: ControlServerOptions): ResolvedServerOptions {
  const allowZero = options.allowEphemeralPortForTests === true;
  if (!Number.isSafeInteger(options.port) || options.port < (allowZero ? 0 : 1) || options.port > 65_535) {
    throw new RangeError(`port must be an integer between ${allowZero ? 0 : 1} and 65535.`);
  }
  if (typeof options.createRunFile !== "function" || typeof options.readModels?.projects !== "function") {
    throw new TypeError("A control run-file factory and read-model registry are required.");
  }
  if (!allowZero) {
    if (options.sse === undefined || typeof options.sse.prepare !== "function") {
      throw new TypeError("A production control server requires the durable SSE handler.");
    }
    const lifecycle = options.lifecycle;
    if (
      lifecycle === undefined ||
      typeof lifecycle.publishRunFile !== "function" ||
      typeof lifecycle.closeStores !== "function" ||
      typeof lifecycle.removeRunFileIfOwned !== "function" ||
      typeof lifecycle.releaseLease !== "function"
    ) {
      throw new TypeError("A production control server requires every lifetime and discovery callback.");
    }
  }
  const responseLimits = { ...CONTROL_RESPONSE_LIMITS };
  for (const kind of Object.keys(CONTROL_RESPONSE_LIMITS) as ControlResponseKind[]) {
    const supplied = options.responseLimits?.[kind];
    if (supplied === undefined) continue;
    responseLimits[kind] = boundedOption(`responseLimits.${kind}`, supplied, CONTROL_RESPONSE_LIMITS[kind]);
  }
  return {
    ...options,
    maxConnections: boundedOption("maxConnections", options.maxConnections, CONTROL_MAX_CONNECTIONS),
    admissionTimeoutMs: boundedOption(
      "admissionTimeoutMs",
      options.admissionTimeoutMs,
      CONTROL_ADMISSION_TIMEOUT_MS
    ),
    drainTimeoutMs: boundedOption("drainTimeoutMs", options.drainTimeoutMs, CONTROL_GRACEFUL_DRAIN_TIMEOUT_MS),
    requestId: options.requestId ?? (() => `req-${randomBytes(12).toString("hex")}`),
    now: options.now ?? Date.now,
    responseLimits: Object.freeze(responseLimits)
  };
}

function boundedOption(name: string, supplied: number | undefined, maximum: number): number {
  const value = supplied ?? maximum;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function listenExactly(server: Server, port: number): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ port, host: CONTROL_HOST, exclusive: true });
  });
}

function requireLoopbackAddress(server: Server): ControlServerAddress {
  const address = server.address();
  if (address === null || typeof address === "string" || address.address !== CONTROL_HOST || address.family !== "IPv4") {
    throw new Error("The control server did not bind the exact IPv4 loopback address.");
  }
  return { host: CONTROL_HOST, port: address.port, url: `http://${CONTROL_HOST}:${address.port}` };
}

function mapStartError(error: unknown, port: number): ControlServerStartError {
  if (error instanceof ControlServerStartError) return error;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "EADDRINUSE") {
    return new ControlServerStartError(
      "ADDRESS_IN_USE",
      `The control port ${CONTROL_HOST}:${port} is already in use; no fallback port was selected.`,
      { cause: error }
    );
  }
  if (code === "EACCES") {
    return new ControlServerStartError(
      "PERMISSION_DENIED",
      `The control service is not permitted to bind ${CONTROL_HOST}:${port}.`,
      { cause: error }
    );
  }
  return new ControlServerStartError("START_FAILED", "The control service could not complete startup.", { cause: error });
}

function matchRoute(pathname: string): Route {
  if (pathname === "/") return { kind: "dashboard" };
  if (pathname === "/api/v1/health") return { kind: "health" };
  if (pathname === "/api/v1/status") return { kind: "status" };
  if (pathname === "/api/v1/runs") return { kind: "runs" };
  const segments = pathname.split("/");
  if (segments.length < 5 || segments[0] !== "" || segments[1] !== "api" || segments[2] !== "v1" || segments[3] !== "runs") {
    return { kind: "unknown" };
  }
  const rawRun = segments[4] ?? "";
  if (segments.length === 5) return { kind: "run", rawRun };
  if (segments.length !== 6) return { kind: "unknown" };
  switch (segments[5]) {
    case "board":
      return { kind: "board", rawRun };
    case "activity":
      return { kind: "activity", rawRun };
    case "steering":
      return { kind: "steering", rawRun };
    case "observations":
      return { kind: "observations", rawRun };
    case "diagnostics":
      return { kind: "diagnostics", rawRun };
    case "events":
      return { kind: "events", rawRun };
    default:
      return { kind: "unknown" };
  }
}

function parseRequestUrl(target: string, port: number): URL {
  const bytes = Buffer.byteLength(target, "utf8");
  if (bytes === 0 || bytes > CONTROL_REQUEST_TARGET_MAX_BYTES) {
    throw routeError(414, "INVALID_REQUEST", "The control request target is empty or too large.");
  }
  const rawPath = target.split("?", 1)[0] ?? "";
  const rawSegments = rawPath.split("/");
  if (
    !target.startsWith("/") ||
    target.startsWith("//") ||
    target.includes("#") ||
    target.includes("\\") ||
    rawPath.includes("%") ||
    (rawPath !== "/" && rawSegments.some((segment, index) => index > 0 && (segment === "" || segment === "." || segment === ".."))) ||
    /[\u0000-\u001f\u007f]/.test(target)
  ) {
    throw routeError(400, "INVALID_REQUEST", "The control request target is malformed.");
  }
  try {
    return new URL(target, `http://${CONTROL_HOST}:${port}`);
  } catch {
    throw routeError(400, "INVALID_REQUEST", "The control request target is malformed.");
  }
}

function assertAdmissionRequest(request: IncomingMessage, port: number, allowProtocolUpgrade = false): void {
  const headerBytes = controlRequestHeaderBytes(request.rawHeaders);
  if (headerBytes > CONTROL_RELEVANT_HEADERS_MAX_BYTES) {
    throw routeError(431, "INVALID_REQUEST", "The control request headers are too large.");
  }
  const host = singleRawHeader(request.rawHeaders, "host");
  if (host !== `${CONTROL_HOST}:${port}`) {
    throw routeError(400, "INVALID_REQUEST", "The control Host header does not match the loopback listener.");
  }
  const origin = singleRawHeader(request.rawHeaders, "origin");
  if (origin !== null && origin !== `http://${CONTROL_HOST}:${port}`) {
    throw routeError(403, "INVALID_REQUEST", "The control Origin header does not match the loopback listener.");
  }
  const upgrade = singleRawHeader(request.rawHeaders, "upgrade");
  if (upgrade !== null && !allowProtocolUpgrade) {
    throw routeError(405, "METHOD_NOT_ALLOWED", "Protocol upgrades are not supported.");
  }
  const connection = singleRawHeader(request.rawHeaders, "connection");
  if (connection !== null) {
    const tokens = connection.split(",").map((value) => value.trim().toLowerCase());
    if (tokens.some((token) => token !== "close" && token !== "keep-alive" && !(allowProtocolUpgrade && token === "upgrade"))) {
      throw routeError(400, "INVALID_REQUEST", "The control Connection header is not supported.");
    }
  }
  const transferEncoding = singleRawHeader(request.rawHeaders, "transfer-encoding");
  if (transferEncoding !== null) {
    throw routeError(400, "INVALID_REQUEST", "Request bodies are not accepted by the control service.");
  }
  const contentLength = singleRawHeader(request.rawHeaders, "content-length");
  if (contentLength !== null && contentLength !== "0") {
    throw routeError(400, "INVALID_REQUEST", "Request bodies are not accepted by the control service.");
  }
  if (singleRawHeader(request.rawHeaders, "expect") !== null) {
    throw routeError(400, "INVALID_REQUEST", "Expect requests are not supported by the control service.");
  }
  for (const header of ["authorization", "proxy-authorization", "cookie"] as const) {
    if (singleRawHeader(request.rawHeaders, header) !== null) {
      throw routeError(400, "INVALID_REQUEST", "Credentials are not accepted by the loopback control service.");
    }
  }
}

function singleRawHeader(rawHeaders: readonly string[], wanted: string): string | null {
  const values: string[] = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if ((rawHeaders[index] ?? "").toLowerCase() === wanted) values.push(rawHeaders[index + 1] ?? "");
  }
  if (values.length > 1) {
    throw routeError(400, "INVALID_REQUEST", `A security-sensitive control header was repeated.`);
  }
  return values[0] ?? null;
}

function requireQuery(url: URL, allowed: readonly string[], required: readonly string[]): URLSearchParams {
  const allowedSet = new Set(allowed);
  const counts = new Map<string, number>();
  for (const [name] of url.searchParams) {
    if (!allowedSet.has(name)) throw routeError(400, "INVALID_REQUEST", "The control request has an unknown query parameter.");
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if ((counts.get(name) ?? 0) > 1) throw routeError(400, "INVALID_REQUEST", "A control query parameter was repeated.");
  }
  for (const name of required) {
    if (!url.searchParams.has(name)) throw routeError(400, "INVALID_REQUEST", "A required control query parameter is missing.");
  }
  return url.searchParams;
}

function requireId(value: string | null, _kind: "project" | "run"): string {
  // Encoded path identifiers are rejected: canonical public IDs consist only of unreserved bytes.
  if (value === null || value.includes("%") || !isValidId(value)) {
    throw routeError(400, "INVALID_REQUEST", "A control resource identifier is invalid.");
  }
  return value;
}

function routeError(
  status: number,
  code: ControlErrorCode,
  message: string,
  details?: ControlErrorDetails
): ControlRouteError {
  return new ControlRouteError({ status, code, message, details });
}

function mapControlError(error: unknown): MappedControlError {
  if (error instanceof ControlRouteError) return error.mapped;
  if (error instanceof ControlPayloadTooLargeError) {
    return { status: 413, code: "RESPONSE_TOO_LARGE", message: "The requested control response exceeds its byte limit." };
  }
  if (error instanceof ControlProtocolError) {
    return { status: 400, code: "INVALID_REQUEST", message: "The control request does not match the v1 protocol." };
  }
  if (error instanceof ControlRoomQueryError) {
    if (error.code === "CURSOR_EXPIRED") return { status: 410, code: "CURSOR_EXPIRED", message: "The requested observation history is no longer retained." };
    if (error.code === "MALFORMED_CURSOR" || error.code === "WRONG_EPOCH" || error.code === "FUTURE_CURSOR" || error.code === "INVALID_LIMIT") {
      return { status: 400, code: "INVALID_CURSOR", message: "The supplied observation cursor or limit is invalid." };
    }
    return { status: 503, code: "RECOVERY_REQUIRED", message: "The normalized observation projection requires recovery." };
  }
  if (error instanceof ControlRoomReadError) {
    if (error.code === "RESPONSE_TOO_LARGE") return { status: 413, code: "RESPONSE_TOO_LARGE", message: "The requested observation response exceeds its byte limit." };
    return { status: 503, code: "RECOVERY_REQUIRED", message: "The normalized observation read model requires recovery." };
  }
  if (error instanceof ControlViewError) {
    switch (error.code) {
      case "INVALID_CURSOR":
        return { status: 400, code: "INVALID_CURSOR", message: "The supplied control cursor is invalid." };
      case "RUN_NOT_FOUND":
      case "RUN_NOT_STARTED":
      case "SESSION_NOT_FOUND":
      case "SESSION_OWNERSHIP_MISMATCH":
        return { status: 404, code: "NOT_FOUND", message: "The requested control resource was not found." };
      case "IDENTITY_MISMATCH":
      case "INCONSISTENT_SNAPSHOT":
        return { status: 503, code: "RECOVERY_REQUIRED", message: "The control projection requires recovery." };
      case "INVALID_INPUT":
        return { status: 400, code: "INVALID_REQUEST", message: "The control request is invalid." };
    }
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "CURSOR_EXPIRED") {
    return {
      status: 410,
      code: "CURSOR_EXPIRED",
      message: "The requested activity history is no longer retained.",
      details: recoveryDetails((error as { details?: unknown }).details)
    };
  }
  if (code === "RUN_IDENTITY_MISMATCH") {
    return { status: 503, code: "IDENTITY_MISMATCH", message: "The durable run identity does not match this request." };
  }
  if (code === "RECOVERY_REQUIRED" || code === "INVALID_EVENT") {
    return { status: 503, code: "RECOVERY_REQUIRED", message: "The control store requires recovery." };
  }
  if (code === "STORE_BUSY") {
    return { status: 503, code: "NOT_READY", message: "The control store is temporarily busy.", details: { retryAfterMs: 250, reason: "store-busy" } };
  }
  if (code === "STORE_CLOSED" || code === "BROKER_CLOSED") {
    return { status: 503, code: "NOT_READY", message: "The control service is shutting down." };
  }
  if (code === "CAPACITY_EXCEEDED") {
    return { status: 503, code: "CAPACITY_EXCEEDED", message: "The control event-stream capacity has been reached." };
  }
  return { status: 500, code: "INTERNAL_ERROR", message: "The control service could not complete the request." };
}

function recoveryDetails(value: unknown): ControlErrorDetails | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const details: ControlErrorDetails = {};
  for (const key of ["floorSeq", "headSeq", "snapshotSeq"] as const) {
    const candidate = input[key];
    if (Number.isSafeInteger(candidate) && Number(candidate) >= 0) details[key] = Number(candidate);
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

function writeBufferedResponse(
  response: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  head: boolean,
  headers: Readonly<Record<string, string>> = CONTROL_SECURITY_HEADERS
): void {
  response.writeHead(status, {
    ...headers,
    "content-type": contentType,
    "content-length": String(body.byteLength)
  });
  response.end(head ? undefined : body);
}

function dashboardSecurityHeaders(nonce: string): Readonly<Record<string, string>> {
  return {
    ...CONTROL_SECURITY_HEADERS,
    "content-security-policy":
      `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; ` +
      `connect-src 'self'; img-src 'self' data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'`
  };
}

function applyDashboardNonce(document: string, nonce: string): string {
  if (typeof document !== "string" || document.length === 0 || /<style\b[^>]*>|<script\b[^>]*>/iu.test(document) === false) {
    throw new Error("The dashboard renderer returned an invalid self-contained document.");
  }
  const styles = document.match(/<style>/gu)?.length ?? 0;
  const scripts = document.match(/<script>/gu)?.length ?? 0;
  if (styles !== 1 || scripts !== 1 || /<style\s+|<script\s+/iu.test(document)) {
    throw new Error("The dashboard document must contain exactly one plain inline style and script.");
  }
  return document
    .replace("<style>", `<style nonce="${nonce}">`)
    .replace("<script>", `<script nonce="${nonce}">`);
}

function writeSseHeaders(response: ServerResponse): void {
  response.writeHead(200, {
    ...CONTROL_SECURITY_HEADERS,
    "content-type": "text/event-stream; charset=utf-8",
    connection: "keep-alive"
  });
  response.flushHeaders();
}

function writeRawError(socket: Duplex, status: number, body: Buffer, extra: Record<string, string> = {}): void {
  if (socket.destroyed) return;
  const reason = httpReason(status);
  const headers = {
    ...CONTROL_SECURITY_HEADERS,
    ...extra,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.byteLength),
    Connection: "close"
  };
  const lines = [`HTTP/1.1 ${status} ${reason}`];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  lines.push("", "");
  socket.end(Buffer.concat([Buffer.from(lines.join("\r\n"), "ascii"), body]));
}

function httpReason(status: number): string {
  switch (status) {
    case 400:
      return "Bad Request";
    case 403:
      return "Forbidden";
    case 404:
      return "Not Found";
    case 405:
      return "Method Not Allowed";
    case 431:
      return "Request Header Fields Too Large";
    case 503:
      return "Service Unavailable";
    default:
      return "Error";
  }
}

async function drainAndClose(server: Server, sockets: Set<Socket>, timeoutMs: number): Promise<void> {
  if (!server.listening) {
    for (const socket of sockets) socket.destroy();
    return;
  }
  await new Promise<void>((resolvePromise) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise();
    };
    const timer = setTimeout(() => {
      server.closeAllConnections?.();
      for (const socket of sockets) socket.destroy();
      finish();
    }, timeoutMs);
    server.close(() => finish());
    server.closeIdleConnections?.();
  });
}

async function closeImmediately(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  if (!server.listening) return;
  await new Promise<void>((resolvePromise) => {
    server.close(() => resolvePromise());
    server.closeAllConnections?.();
  });
}

async function ignoreFailure(action: () => void | Promise<void> | undefined): Promise<void> {
  try {
    await action();
  } catch {
    // Startup rollback is best effort; the original failure remains authoritative.
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Unknown control server error.");
}

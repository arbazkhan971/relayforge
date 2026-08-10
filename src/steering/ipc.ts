import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
  type Stats
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import {
  createConnection,
  createServer,
  type Server,
  type Socket
} from "node:net";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  SteeringBodySchema,
  SteeringBoundedIdSchema,
  SteeringCommandIdSchema,
  SteeringCommandV1Schema,
  SteeringEventSequenceSchema,
  SteeringPositiveGenerationSchema,
  SteeringRefusalV1Schema,
  SteeringTimestampSchema
} from "./schema.js";
import {
  SteeringServiceError,
  type ParentSteeringService,
  type SteeringAdmissionRequest,
  type SteeringAdmissionResult,
  type SteeringWithdrawalRequest,
  type SteeringWithdrawalResult
} from "./service.js";
import { STEERING_EVIDENCE_MAX_REFS } from "./schema.js";
import { STEERING_SCHEMA_VERSION } from "./types.js";

export const STEERING_IPC_SCHEMA_VERSION = 1 as const;
export const STEERING_IPC_SOCKET_LEAF = ".steer.sock" as const;
export const STEERING_IPC_LOCATOR_LEAF = ".steer.endpoint.json" as const;
export const STEERING_IPC_MAX_REQUEST_BYTES = 32 * 1_024;
export const STEERING_IPC_MAX_RESPONSE_BYTES = 64 * 1_024;
export const STEERING_IPC_DEFAULT_TIMEOUT_MS = 2_000;
export const STEERING_IPC_MAX_TIMEOUT_MS = 30_000;

export const steeringIpcErrorCodes = [
  "INVALID_REQUEST",
  "INVALID_AUTHORITY",
  "COMMAND_ID_CONFLICT",
  "COMMAND_NOT_FOUND",
  "COMMAND_TERMINAL",
  "NOT_EXPIRED",
  "RUN_IDENTITY_MISMATCH",
  "CONTROL_STORE_UNAVAILABLE",
  "CONCURRENT_UPDATE",
  "REQUEST_TOO_LARGE",
  "RESPONSE_TOO_LARGE",
  "REQUEST_TIMEOUT",
  "AUTHORITY_UNAVAILABLE",
  "SERVICE_UNAVAILABLE",
  "PROTOCOL_ERROR",
  "IPC_PATH_UNSAFE",
  "IPC_ENDPOINT_EXISTS",
  "INTERNAL_ERROR"
] as const;

const MAX_UNIX_SOCKET_PATH_BYTES = 100;
const MAX_ENDPOINT_LOCATOR_BYTES = 2_048;
const MAX_ERROR_MESSAGE_BYTES = 4_096;
const INVALID_REQUEST_ID = "00000000-0000-7000-8000-000000000000";

const runIdentityShape = {
  runId: SteeringBoundedIdSchema,
  runEpoch: SteeringBoundedIdSchema
};

const endpointLocatorSchema = z.strictObject({
  schemaVersion: z.literal(STEERING_IPC_SCHEMA_VERSION),
  runId: SteeringBoundedIdSchema,
  runEpoch: SteeringBoundedIdSchema,
  runDirectorySha256: z.string().regex(/^[0-9a-f]{64}$/u),
  socketPath: z.string().min(1).max(MAX_UNIX_SOCKET_PATH_BYTES),
  socketDev: z.string().regex(/^\d+$/u),
  socketIno: z.string().regex(/^\d+$/u)
});

type EndpointLocator = z.infer<typeof endpointLocatorSchema>;

const admissionPayloadSchema = z.strictObject({
  schemaVersion: z.literal(STEERING_SCHEMA_VERSION),
  commandId: SteeringCommandIdSchema,
  ...runIdentityShape,
  taskId: SteeringBoundedIdSchema,
  taskGeneration: SteeringPositiveGenerationSchema,
  sessionId: SteeringBoundedIdSchema,
  sessionGeneration: SteeringPositiveGenerationSchema,
  notBeforeAttemptGeneration: SteeringPositiveGenerationSchema,
  kind: z.literal("steer_next_boundary"),
  evidenceRefs: z.array(SteeringBoundedIdSchema).max(STEERING_EVIDENCE_MAX_REFS).refine(
    (refs) => new Set(refs).size === refs.length,
    "evidence references must be unique"
  ),
  body: SteeringBodySchema,
  expiresAt: SteeringTimestampSchema.optional(),
  supersedesCommandId: SteeringCommandIdSchema.optional()
});

const withdrawalPayloadSchema = z.strictObject({
  schemaVersion: z.literal(STEERING_SCHEMA_VERSION),
  commandId: SteeringCommandIdSchema,
  reason: z.string().min(1).max(4_096).optional()
});

const requestBase = {
  schemaVersion: z.literal(STEERING_IPC_SCHEMA_VERSION),
  requestId: SteeringCommandIdSchema,
  ...runIdentityShape
};

const admitRequestSchema = z.strictObject({
  ...requestBase,
  operation: z.literal("admit"),
  payload: admissionPayloadSchema
}).superRefine((request, context) => {
  if (request.requestId !== request.payload.commandId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["requestId"], message: "request ID must equal the stable command ID" });
  }
  if (request.runId !== request.payload.runId || request.runEpoch !== request.payload.runEpoch) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["payload"], message: "payload and transport run identities must match" });
  }
});

const withdrawRequestSchema = z.strictObject({
  ...requestBase,
  operation: z.literal("withdraw"),
  payload: withdrawalPayloadSchema
}).superRefine((request, context) => {
  if (request.requestId !== request.payload.commandId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["requestId"], message: "request ID must equal the stable command ID" });
  }
});

const steeringIpcRequestSchema = z.union([admitRequestSchema, withdrawRequestSchema]);

const admissionResultSchema = z.discriminatedUnion("decision", [
  z.strictObject({
    decision: z.literal("admitted"),
    commandId: SteeringCommandIdSchema,
    seq: SteeringEventSequenceSchema,
    command: SteeringCommandV1Schema
  }),
  z.strictObject({
    decision: z.literal("refused"),
    commandId: SteeringCommandIdSchema,
    seq: SteeringEventSequenceSchema,
    refusal: SteeringRefusalV1Schema
  })
]);

const withdrawalResultSchema = z.strictObject({
  status: z.literal("withdrawn"),
  commandId: SteeringCommandIdSchema,
  seq: SteeringEventSequenceSchema,
  reason: z.string().min(1).max(4_096).optional()
});

const responseBase = {
  schemaVersion: z.literal(STEERING_IPC_SCHEMA_VERSION),
  requestId: SteeringCommandIdSchema,
  ...runIdentityShape,
  operation: z.enum(["admit", "withdraw"])
};

const steeringIpcResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ...responseBase, ok: z.literal(true), result: z.unknown() }),
  z.strictObject({
    ...responseBase,
    ok: z.literal(false),
    error: z.strictObject({
      code: z.enum(steeringIpcErrorCodes),
      message: z.string().min(1).max(MAX_ERROR_MESSAGE_BYTES)
    })
  })
]);

export type SteeringIpcIdentity = Readonly<{
  runDir: string;
  runId: string;
  runEpoch: string;
}>;

export type SteeringIpcAdmitRequest = Readonly<{
  schemaVersion: typeof STEERING_IPC_SCHEMA_VERSION;
  requestId: string;
  runId: string;
  runEpoch: string;
  operation: "admit";
  payload: SteeringAdmissionRequest;
}>;

export type SteeringIpcWithdrawRequest = Readonly<{
  schemaVersion: typeof STEERING_IPC_SCHEMA_VERSION;
  requestId: string;
  runId: string;
  runEpoch: string;
  operation: "withdraw";
  payload: SteeringWithdrawalRequest;
}>;

export type SteeringIpcRequest = SteeringIpcAdmitRequest | SteeringIpcWithdrawRequest;

export type SteeringIpcResult = SteeringAdmissionResult | SteeringWithdrawalResult;

export type SteeringIpcErrorCode = (typeof steeringIpcErrorCodes)[number];

export class SteeringIpcError extends Error {
  constructor(
    readonly code: SteeringIpcErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "SteeringIpcError";
  }
}

export type SteeringIpcServerOptions = SteeringIpcIdentity & Readonly<{
  /** A service already bound to the parent-owned canonical ControlStore and fixed authority. */
  service: Pick<ParentSteeringService, "admit" | "withdraw">;
  /** Re-proves the outer control lease, run lease and borrowed store identity before every mutation. */
  assertAuthority: () => void;
  requestTimeoutMs?: number;
}>;

export type SteeringIpcServerHandle = Readonly<{
  socketPath: string;
  closeAndDrain: () => Promise<void>;
}>;

type ParsedIpcResponse = z.infer<typeof steeringIpcResponseSchema>;

type ConnectionState = {
  chunks: Buffer[];
  bytes: number;
  replied: boolean;
};

function timeoutMs(value: number | undefined): number {
  const timeout = value ?? STEERING_IPC_DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > STEERING_IPC_MAX_TIMEOUT_MS) {
    throw new SteeringIpcError(
      "INVALID_REQUEST",
      `steering IPC timeout must be an integer from 1 through ${STEERING_IPC_MAX_TIMEOUT_MS}`
    );
  }
  return timeout;
}

function effectiveUid(): number | undefined {
  return typeof process.geteuid === "function" ? process.geteuid() : undefined;
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function privateRunDirectory(runDir: string): string {
  const absolute = resolve(runDir);
  let stat: Stats;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    throw new SteeringIpcError("IPC_PATH_UNSAFE", `private run directory is unavailable: ${absolute}`, { cause: asError(error) });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new SteeringIpcError("IPC_PATH_UNSAFE", `steering IPC parent is not a real directory: ${absolute}`);
  }
  let real: string;
  try {
    real = realpathSync(absolute);
  } catch (error) {
    throw new SteeringIpcError("IPC_PATH_UNSAFE", `steering IPC parent cannot be resolved: ${absolute}`, { cause: asError(error) });
  }
  if (real !== absolute) throw new SteeringIpcError("IPC_PATH_UNSAFE", `steering IPC parent is not canonical: ${absolute}`);
  const uid = effectiveUid();
  if (uid !== undefined && stat.uid !== uid) {
    throw new SteeringIpcError("IPC_PATH_UNSAFE", `steering IPC parent belongs to another uid: ${absolute}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new SteeringIpcError("IPC_PATH_UNSAFE", `steering IPC parent must be private (0700): ${absolute}`);
  }
  return absolute;
}

function runtimeRootPath(): string {
  const uid = effectiveUid();
  if (uid === undefined) {
    throw new SteeringIpcError("IPC_PATH_UNSAFE", "steering IPC requires an effective Unix uid");
  }
  let temporaryRoot: string;
  try {
    temporaryRoot = realpathSync("/tmp");
  } catch (error) {
    throw new SteeringIpcError("IPC_PATH_UNSAFE", "the canonical /tmp runtime parent is unavailable", { cause: asError(error) });
  }
  return resolve(temporaryRoot, `relayforge-steering-${uid}`);
}

function privateRuntimeDirectory(): string {
  const root = runtimeRootPath();
  try {
    mkdirSync(root, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new SteeringIpcError("IPC_PATH_UNSAFE", `private steering runtime directory cannot be created: ${root}`, {
        cause: asError(error)
      });
    }
  }
  let stat: Stats;
  try {
    stat = lstatSync(root);
  } catch (error) {
    throw new SteeringIpcError("IPC_PATH_UNSAFE", `private steering runtime directory is unavailable: ${root}`, {
      cause: asError(error)
    });
  }
  const uid = effectiveUid();
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (uid !== undefined && stat.uid !== uid) ||
    (stat.mode & 0o077) !== 0 ||
    realpathSync(root) !== root
  ) {
    throw new SteeringIpcError("IPC_PATH_UNSAFE", `steering runtime directory is not private and identity-stable: ${root}`);
  }
  return root;
}

function runDirectorySha256(runDir: string): string {
  return createHash("sha256").update(runDir, "utf8").digest("hex");
}

export function steeringIpcSocketPath(runDir: string): string {
  const root = privateRuntimeDirectory();
  const runDigest = runDirectorySha256(resolve(runDir));
  const path = resolve(root, `s-${runDigest.slice(0, 40)}.sock`);
  if (Buffer.byteLength(path, "utf8") > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new SteeringIpcError(
      "IPC_PATH_UNSAFE",
      `steering IPC socket path exceeds ${MAX_UNIX_SOCKET_PATH_BYTES} UTF-8 bytes: ${path}`
    );
  }
  return path;
}

function steeringIpcLocatorPath(runDir: string): string {
  return resolve(runDir, STEERING_IPC_LOCATOR_LEAF);
}

function endpointLocator(
  runDir: string,
  identity: Pick<SteeringIpcIdentity, "runId" | "runEpoch">,
  socketPath: string,
  socket: Stats
): EndpointLocator {
  return endpointLocatorSchema.parse({
    schemaVersion: STEERING_IPC_SCHEMA_VERSION,
    runId: identity.runId,
    runEpoch: identity.runEpoch,
    runDirectorySha256: runDirectorySha256(runDir),
    socketPath,
    socketDev: String(socket.dev),
    socketIno: String(socket.ino)
  });
}

function assertLocatorMatches(
  locator: EndpointLocator,
  runDir: string,
  identity: Pick<SteeringIpcIdentity, "runId" | "runEpoch">,
  socketPath: string,
  socket?: Stats
): void {
  if (
    locator.runId !== identity.runId ||
    locator.runEpoch !== identity.runEpoch ||
    locator.runDirectorySha256 !== runDirectorySha256(runDir) ||
    locator.socketPath !== socketPath ||
    (socket !== undefined && (locator.socketDev !== String(socket.dev) || locator.socketIno !== String(socket.ino)))
  ) {
    throw new SteeringIpcError("RUN_IDENTITY_MISMATCH", "steering endpoint locator does not match the requested run identity");
  }
}

function readEndpointLocator(path: string, optional = false): { locator: EndpointLocator; stat: Stats } | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    const code = (error as NodeJS.ErrnoException).code === "ENOENT" ? "SERVICE_UNAVAILABLE" : "IPC_PATH_UNSAFE";
    throw new SteeringIpcError(code, `steering endpoint locator cannot be opened safely: ${path}`, { cause: asError(error) });
  }
  try {
    const before = fstatSync(descriptor);
    const uid = effectiveUid();
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      (uid !== undefined && before.uid !== uid) ||
      (before.mode & 0o777) !== 0o600 ||
      before.size < 2 ||
      before.size > MAX_ENDPOINT_LOCATOR_BYTES
    ) {
      throw new SteeringIpcError("IPC_PATH_UNSAFE", `steering endpoint locator is not a private owned regular file: ${path}`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (!sameIdentity(before, after) || before.size !== after.size || bytes.byteLength !== before.size) {
      throw new SteeringIpcError("IPC_PATH_UNSAFE", `steering endpoint locator changed while being read: ${path}`);
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new SteeringIpcError("PROTOCOL_ERROR", `steering endpoint locator is not valid JSON: ${path}`, {
        cause: asError(error)
      });
    }
    const parsed = endpointLocatorSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new SteeringIpcError("PROTOCOL_ERROR", `steering endpoint locator violates the closed v1 schema: ${path}`, {
        cause: parsed.error
      });
    }
    return { locator: parsed.data, stat: before };
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function publishEndpointLocator(runDir: string, locator: EndpointLocator): Stats {
  const path = steeringIpcLocatorPath(runDir);
  const temporary = join(runDir, `${STEERING_IPC_LOCATOR_LEAF}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(locator)}\n`, "utf8");
  if (bytes.byteLength > MAX_ENDPOINT_LOCATOR_BYTES) {
    throw new SteeringIpcError("IPC_PATH_UNSAFE", "steering endpoint locator exceeded its closed byte cap");
  }
  let descriptor: number | undefined;
  let staged: Stats | undefined;
  let linked = false;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(descriptor, bytes, offset);
      if (written === 0) throw new SteeringIpcError("IPC_PATH_UNSAFE", "steering endpoint locator write made no progress");
      offset += written;
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    staged = lstatSync(temporary);
    linkSync(temporary, path);
    linked = true;
    unlinkSync(temporary);
    syncDirectory(runDir);
    const published = readEndpointLocator(path);
    if (!published) throw new SteeringIpcError("IPC_PATH_UNSAFE", "steering endpoint locator was not published");
    assertLocatorMatches(published.locator, runDir, locator, locator.socketPath);
    return published.stat;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch { /* not published or already unlinked */ }
    if (linked && staged) {
      try {
        const current = lstatSync(path);
        if (sameIdentity(staged, current)) unlinkSync(path);
      } catch { /* preserve a foreign or already-removed locator */ }
    }
    if (error instanceof SteeringIpcError) throw error;
    throw new SteeringIpcError("IPC_ENDPOINT_EXISTS", `steering endpoint locator cannot be published exclusively: ${path}`, {
      cause: asError(error)
    });
  }
}

function reclaimEndpointLocator(
  runDir: string,
  identity: Pick<SteeringIpcIdentity, "runId" | "runEpoch">,
  socketPath: string,
  assertAuthority: () => void
): void {
  const path = steeringIpcLocatorPath(runDir);
  const existing = readEndpointLocator(path, true);
  if (!existing) return;
  assertLocatorMatches(existing.locator, runDir, identity, socketPath);
  assertParentAuthority(assertAuthority);
  const current = readEndpointLocator(path);
  if (!current || !sameIdentity(existing.stat, current.stat)) {
    throw new SteeringIpcError("IPC_PATH_UNSAFE", `steering endpoint locator changed during recovery: ${path}`);
  }
  unlinkSync(path);
  syncDirectory(runDir);
}

function assertSocketFile(path: string): Stats {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new SteeringIpcError("SERVICE_UNAVAILABLE", `parent steering endpoint is unavailable: ${path}`, { cause: asError(error) });
  }
  const uid = effectiveUid();
  if (!stat.isSocket() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o777) !== 0o600) {
    throw new SteeringIpcError("IPC_PATH_UNSAFE", `parent steering endpoint is not a private owned Unix socket: ${path}`);
  }
  return stat;
}

function boundedMessage(value: unknown): string {
  const original = value instanceof Error ? value.message : String(value);
  const clean = original.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ") || "steering operation failed";
  const bytes = Buffer.from(clean, "utf8");
  if (bytes.byteLength <= MAX_ERROR_MESSAGE_BYTES) return clean;
  return bytes.subarray(0, MAX_ERROR_MESSAGE_BYTES).toString("utf8").replace(/\ufffd$/u, "");
}

function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof SteeringServiceError || error instanceof SteeringIpcError) {
    return { code: error.code, message: boundedMessage(error) };
  }
  return { code: "INTERNAL_ERROR", message: "parent steering operation failed" };
}

function assertParentAuthority(assertAuthority: () => void): void {
  try {
    assertAuthority();
  } catch (error) {
    throw new SteeringIpcError("AUTHORITY_UNAVAILABLE", "run-parent steering authority is no longer held", { cause: asError(error) });
  }
}

function responseBytes(value: unknown): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.byteLength > STEERING_IPC_MAX_RESPONSE_BYTES) {
    throw new SteeringIpcError("RESPONSE_TOO_LARGE", "parent steering response exceeded its byte cap");
  }
  return bytes;
}

function responseIdentity(value: unknown): { requestId: string; runId: string; runEpoch: string; operation: "admit" | "withdraw" } {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    const requestId = SteeringCommandIdSchema.safeParse(object.requestId);
    const runId = SteeringBoundedIdSchema.safeParse(object.runId);
    const runEpoch = SteeringBoundedIdSchema.safeParse(object.runEpoch);
    const operation = z.enum(["admit", "withdraw"]).safeParse(object.operation);
    return {
      requestId: requestId.success ? requestId.data : INVALID_REQUEST_ID,
      runId: runId.success ? runId.data : "invalid-run",
      runEpoch: runEpoch.success ? runEpoch.data : "invalid-epoch",
      operation: operation.success ? operation.data : "admit"
    };
  }
  return { requestId: INVALID_REQUEST_ID, runId: "invalid-run", runEpoch: "invalid-epoch", operation: "admit" };
}

function parseWireLine(bytes: Buffer): unknown {
  if (bytes.byteLength === 0 || bytes[bytes.byteLength - 1] !== 0x0a) {
    throw new SteeringIpcError("PROTOCOL_ERROR", "steering IPC request must end with one newline");
  }
  if (bytes.subarray(0, bytes.byteLength - 1).includes(0x0a)) {
    throw new SteeringIpcError("PROTOCOL_ERROR", "steering IPC permits exactly one request per connection");
  }
  try {
    return JSON.parse(bytes.subarray(0, bytes.byteLength - 1).toString("utf8"));
  } catch (error) {
    throw new SteeringIpcError("INVALID_REQUEST", "steering IPC request is not valid JSON", { cause: asError(error) });
  }
}

function parseRequest(value: unknown): SteeringIpcRequest {
  const parsed = steeringIpcRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new SteeringIpcError("INVALID_REQUEST", "steering IPC request violates the closed v1 schema", { cause: parsed.error });
  }
  return parsed.data as SteeringIpcRequest;
}

function assertRequestIdentity(
  request: SteeringIpcRequest,
  options: Pick<SteeringIpcIdentity, "runId" | "runEpoch">
): void {
  if (request.runId !== options.runId || request.runEpoch !== options.runEpoch) {
    throw new SteeringIpcError("RUN_IDENTITY_MISMATCH", "steering request belongs to another run identity");
  }
}

async function probeExistingSocket(path: string, timeout: number): Promise<"live" | "stale" | "absent"> {
  return await new Promise((resolveProbe, rejectProbe) => {
    const socket = createConnection({ path });
    const timer = setTimeout(() => {
      socket.destroy();
      rejectProbe(new SteeringIpcError("IPC_ENDPOINT_EXISTS", `existing steering endpoint could not be proven stale: ${path}`));
    }, Math.min(timeout, 250));
    timer.unref?.();
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolveProbe("live");
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      socket.destroy();
      if (error.code === "ENOENT") resolveProbe("absent");
      else if (error.code === "ECONNREFUSED") resolveProbe("stale");
      else rejectProbe(new SteeringIpcError("IPC_ENDPOINT_EXISTS", `existing steering endpoint cannot be reclaimed: ${path}`, { cause: error }));
    });
  });
}

async function prepareSocketLeaf(path: string, assertAuthority: () => void, timeout: number): Promise<void> {
  let before: Stats;
  try {
    before = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new SteeringIpcError("IPC_PATH_UNSAFE", `steering endpoint cannot be inspected: ${path}`, { cause: asError(error) });
  }
  const uid = effectiveUid();
  if (!before.isSocket() || before.isSymbolicLink() || (uid !== undefined && before.uid !== uid)) {
    throw new SteeringIpcError("IPC_PATH_UNSAFE", `refusing to replace a non-socket or foreign steering endpoint: ${path}`);
  }
  const probe = await probeExistingSocket(path, timeout);
  if (probe === "live") throw new SteeringIpcError("IPC_ENDPOINT_EXISTS", `a parent steering endpoint is already active: ${path}`);
  if (probe === "absent") return;
  assertParentAuthority(assertAuthority);
  const after = lstatSync(path);
  if (!sameIdentity(before, after) || !after.isSocket()) {
    throw new SteeringIpcError("IPC_PATH_UNSAFE", `steering endpoint changed during stale-socket recovery: ${path}`);
  }
  unlinkSync(path);
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(path);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

/**
 * Start the run-parent command endpoint over a private Unix socket. This function never opens a
 * ControlStore: callers must supply the service backed by the canonical store they already own.
 */
export async function startSteeringIpcServer(options: SteeringIpcServerOptions): Promise<SteeringIpcServerHandle> {
  const runDir = privateRunDirectory(options.runDir);
  const parsedIdentity = z.strictObject(runIdentityShape).safeParse({ runId: options.runId, runEpoch: options.runEpoch });
  if (!parsedIdentity.success) {
    throw new SteeringIpcError("INVALID_REQUEST", "steering IPC run identity is invalid", { cause: parsedIdentity.error });
  }
  const identity = parsedIdentity.data;
  const requestTimeout = timeoutMs(options.requestTimeoutMs);
  const path = steeringIpcSocketPath(runDir);
  assertParentAuthority(options.assertAuthority);
  await prepareSocketLeaf(path, () => assertParentAuthority(options.assertAuthority), requestTimeout);
  reclaimEndpointLocator(runDir, identity, path, () => assertParentAuthority(options.assertAuthority));
  assertParentAuthority(options.assertAuthority);

  let closing = false;
  const connections = new Map<Socket, ConnectionState>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    const state: ConnectionState = { chunks: [], bytes: 0, replied: false };
    connections.set(socket, state);
    socket.setTimeout(requestTimeout);
    socket.on("error", () => { /* the client owns retry; never crash the parent */ });
    socket.once("close", () => connections.delete(socket));

    const reply = (value: unknown): void => {
      if (state.replied || socket.destroyed) return;
      state.replied = true;
      try {
        socket.end(responseBytes(value), () => {
          // A valid request half-closes before it is processed, so both directions now close
          // naturally. Invalid/oversized clients that kept their write side open are reaped after
          // the bounded response is flushed instead of pinning Server.close indefinitely.
          if (!socket.readableEnded) socket.destroy();
        });
      } catch {
        socket.destroy();
      }
    };

    const reject = (error: unknown, raw?: unknown): void => {
      const requestIdentity = responseIdentity(raw);
      reply({
        schemaVersion: STEERING_IPC_SCHEMA_VERSION,
        ...requestIdentity,
        ok: false,
        error: publicError(error)
      });
    };

    if (closing) {
      reject(new SteeringIpcError("SERVICE_UNAVAILABLE", "parent steering endpoint is draining"));
      return;
    }

    socket.on("timeout", () => {
      reject(new SteeringIpcError("REQUEST_TIMEOUT", "steering IPC request timed out"));
    });
    socket.on("data", (chunk: Buffer) => {
      if (state.replied) return;
      state.bytes += chunk.byteLength;
      if (state.bytes > STEERING_IPC_MAX_REQUEST_BYTES) {
        reject(new SteeringIpcError("REQUEST_TOO_LARGE", "steering IPC request exceeded its byte cap"));
        return;
      }
      state.chunks.push(Buffer.from(chunk));
    });
    socket.once("end", () => {
      if (state.replied) return;
      const wire = Buffer.concat(state.chunks, state.bytes);
      let raw: unknown;
      try {
        raw = parseWireLine(wire);
        const request = parseRequest(raw);
        assertRequestIdentity(request, identity);
        if (closing) throw new SteeringIpcError("SERVICE_UNAVAILABLE", "parent steering endpoint is draining");
        assertParentAuthority(options.assertAuthority);
        const result = request.operation === "admit"
          ? options.service.admit(request.payload)
          : options.service.withdraw(request.payload);
        const checked = request.operation === "admit"
          ? admissionResultSchema.parse(result)
          : withdrawalResultSchema.parse(result);
        reply({
          schemaVersion: STEERING_IPC_SCHEMA_VERSION,
          requestId: request.requestId,
          runId: identity.runId,
          runEpoch: identity.runEpoch,
          operation: request.operation,
          ok: true,
          result: checked
        });
      } catch (error) {
        reject(error, raw);
      }
    });
  });

  let published: Stats | undefined;
  let publishedLocator: Stats | undefined;
  try {
    await listen(server, path);
    published = lstatSync(path);
    chmodSync(path, 0o600);
    const pinned = assertSocketFile(path);
    if (!sameIdentity(published, pinned)) {
      throw new SteeringIpcError("IPC_PATH_UNSAFE", `steering endpoint changed while permissions were pinned: ${path}`);
    }
    publishedLocator = publishEndpointLocator(runDir, endpointLocator(runDir, identity, path, pinned));
    assertParentAuthority(options.assertAuthority);
    let closePromise: Promise<void> | undefined;
    const closeAndDrain = (): Promise<void> => {
      closePromise ??= (async () => {
        closing = true;
        let leafError: Error | undefined;
        const locatorPath = steeringIpcLocatorPath(runDir);
        try {
          const currentLocator = readEndpointLocator(locatorPath);
          if (!currentLocator || !publishedLocator || !sameIdentity(publishedLocator, currentLocator.stat)) {
            throw new SteeringIpcError("IPC_PATH_UNSAFE", `steering endpoint locator identity changed before listener close: ${locatorPath}`);
          }
          assertLocatorMatches(currentLocator.locator, runDir, identity, path, pinned);
          unlinkSync(locatorPath);
          syncDirectory(runDir);
        } catch (error) {
          leafError = error instanceof Error
            ? error
            : new SteeringIpcError("IPC_PATH_UNSAFE", `steering endpoint locator cannot be retired: ${locatorPath}`);
        }
        try {
          const beforeClose = lstatSync(path);
          if (!beforeClose.isSocket() || !sameIdentity(pinned, beforeClose)) {
            leafError ??= new SteeringIpcError("IPC_PATH_UNSAFE", `steering endpoint identity changed before listener close: ${path}`);
          }
        } catch (error) {
          leafError ??= new SteeringIpcError("IPC_PATH_UNSAFE", `steering endpoint disappeared before listener close: ${path}`, {
            cause: asError(error)
          });
        }
        // ParentSteeringService decisions are synchronous. Once this callback runs, any mutation
        // that entered earlier has completed; destroying remaining transport connections can only
        // lose a response, whose stable command ID makes retry exact and idempotent.
        for (const socket of connections.keys()) socket.destroy();
        await closeServer(server);
        if (leafError) throw leafError;
        let current: Stats;
        try {
          current = lstatSync(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            // Node removes the bound Unix-socket leaf as part of a successful Server.close(). The
            // pinned pre-close identity above proves it was still our endpoint at that boundary.
            return;
          }
          throw error;
        }
        if (!current.isSocket() || !sameIdentity(pinned, current)) {
          throw new SteeringIpcError("IPC_PATH_UNSAFE", `steering endpoint identity changed before cleanup: ${path}`);
        }
        unlinkSync(path);
      })();
      return closePromise;
    };
    return Object.freeze({ socketPath: path, closeAndDrain });
  } catch (error) {
    for (const socket of connections.keys()) socket.destroy();
    if (server.listening) await closeServer(server).catch(() => undefined);
    try {
      const locatorPath = steeringIpcLocatorPath(runDir);
      const locator = readEndpointLocator(locatorPath, true);
      if (locator && publishedLocator && sameIdentity(locator.stat, publishedLocator)) {
        unlinkSync(locatorPath);
        syncDirectory(runDir);
      }
    } catch { /* no owned locator was published */ }
    try {
      const stat = lstatSync(path);
      if (published && stat.isSocket() && sameIdentity(published, stat)) unlinkSync(path);
    } catch { /* no owned listener leaf was published */ }
    if (error instanceof SteeringIpcError) throw error;
    throw new SteeringIpcError("SERVICE_UNAVAILABLE", "failed to start the parent steering endpoint", { cause: asError(error) });
  }
}

function parseResponse(bytes: Buffer, request: SteeringIpcRequest): SteeringIpcResult {
  if (bytes.byteLength === 0 || bytes[bytes.byteLength - 1] !== 0x0a || bytes.subarray(0, bytes.byteLength - 1).includes(0x0a)) {
    throw new SteeringIpcError("PROTOCOL_ERROR", "parent steering endpoint returned an invalid one-response frame");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.subarray(0, bytes.byteLength - 1).toString("utf8"));
  } catch (error) {
    throw new SteeringIpcError("PROTOCOL_ERROR", "parent steering endpoint returned invalid JSON", { cause: asError(error) });
  }
  const parsed = steeringIpcResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SteeringIpcError("PROTOCOL_ERROR", "parent steering endpoint returned a response outside the closed v1 schema", { cause: parsed.error });
  }
  const response: ParsedIpcResponse = parsed.data;
  if (
    response.requestId !== request.requestId ||
    response.runId !== request.runId ||
    response.runEpoch !== request.runEpoch ||
    response.operation !== request.operation
  ) {
    throw new SteeringIpcError("RUN_IDENTITY_MISMATCH", "parent steering response identity does not match the request");
  }
  if (!response.ok) throw new SteeringIpcError(response.error.code, response.error.message);
  try {
    return request.operation === "admit"
      ? admissionResultSchema.parse(response.result) as SteeringAdmissionResult
      : withdrawalResultSchema.parse(response.result) as SteeringWithdrawalResult;
  } catch (error) {
    throw new SteeringIpcError("PROTOCOL_ERROR", "parent steering result violates its operation schema", { cause: asError(error) });
  }
}

export type SendSteeringIpcOptions = Readonly<{
  runDir: string;
  timeoutMs?: number;
}>;

export function sendSteeringIpcRequest(
  request: SteeringIpcAdmitRequest,
  options: SendSteeringIpcOptions
): Promise<SteeringAdmissionResult>;
export function sendSteeringIpcRequest(
  request: SteeringIpcWithdrawRequest,
  options: SendSteeringIpcOptions
): Promise<SteeringWithdrawalResult>;
export async function sendSteeringIpcRequest(
  requestValue: SteeringIpcRequest,
  options: SendSteeringIpcOptions
): Promise<SteeringIpcResult> {
  const request = parseRequest(requestValue);
  const requestTimeout = timeoutMs(options.timeoutMs);
  const runDir = privateRunDirectory(options.runDir);
  const path = steeringIpcSocketPath(runDir);
  const locatorRecord = readEndpointLocator(steeringIpcLocatorPath(runDir));
  if (!locatorRecord) {
    throw new SteeringIpcError("SERVICE_UNAVAILABLE", "parent steering endpoint locator is unavailable");
  }
  const before = assertSocketFile(path);
  assertLocatorMatches(locatorRecord.locator, runDir, request, path, before);
  const wire = Buffer.from(`${JSON.stringify(request)}\n`, "utf8");
  if (wire.byteLength > STEERING_IPC_MAX_REQUEST_BYTES) {
    throw new SteeringIpcError("REQUEST_TOO_LARGE", "steering IPC request exceeded its byte cap");
  }

  const response = await new Promise<Buffer>((resolveResponse, rejectResponse) => {
    const socket = createConnection({ path, allowHalfOpen: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        socket.destroy();
        rejectResponse(error);
      } else {
        resolveResponse(Buffer.concat(chunks, bytes));
      }
    };
    const timer = setTimeout(() => {
      finish(new SteeringIpcError("REQUEST_TIMEOUT", `parent steering endpoint did not respond within ${requestTimeout}ms`));
    }, requestTimeout);
    timer.unref?.();
    socket.once("connect", () => {
      try {
        const currentLocator = readEndpointLocator(steeringIpcLocatorPath(runDir));
        if (!currentLocator || !sameIdentity(locatorRecord.stat, currentLocator.stat)) {
          throw new SteeringIpcError("IPC_PATH_UNSAFE", "parent steering endpoint locator changed during connection");
        }
        assertLocatorMatches(currentLocator.locator, runDir, request, path, before);
        const after = assertSocketFile(path);
        if (!sameIdentity(before, after)) throw new SteeringIpcError("IPC_PATH_UNSAFE", "parent steering endpoint changed during connection");
        socket.end(wire);
      } catch (error) {
        finish(error);
      }
    });
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > STEERING_IPC_MAX_RESPONSE_BYTES) {
        finish(new SteeringIpcError("RESPONSE_TOO_LARGE", "parent steering response exceeded its byte cap"));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    socket.once("end", () => finish());
    socket.once("error", (error) => {
      finish(new SteeringIpcError("SERVICE_UNAVAILABLE", `cannot reach the active run parent at ${path}`, { cause: error }));
    });
  });
  return parseResponse(response, request);
}

export function steeringIpcAdmitRequest(payload: SteeringAdmissionRequest): SteeringIpcAdmitRequest {
  return parseRequest({
    schemaVersion: STEERING_IPC_SCHEMA_VERSION,
    requestId: payload.commandId,
    runId: payload.runId,
    runEpoch: payload.runEpoch,
    operation: "admit",
    payload
  }) as SteeringIpcAdmitRequest;
}

export function steeringIpcWithdrawRequest(
  identity: Pick<SteeringIpcIdentity, "runId" | "runEpoch">,
  payload: SteeringWithdrawalRequest
): SteeringIpcWithdrawRequest {
  return parseRequest({
    schemaVersion: STEERING_IPC_SCHEMA_VERSION,
    requestId: payload.commandId,
    runId: identity.runId,
    runEpoch: identity.runEpoch,
    operation: "withdraw",
    payload
  }) as SteeringIpcWithdrawRequest;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

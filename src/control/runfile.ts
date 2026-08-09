import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import { writeStateFileDurable } from "../runtime.js";
import {
  CONTROL_HOST,
  CONTROL_PROTOCOL_VERSION,
  CONTROL_RUN_FILE_MAX_BYTES,
  CONTROL_SERVICE,
  parseControlRunFile as parseProtocolRunFile,
  type ControlRunFile
} from "./protocol.js";

export { CONTROL_HOST, CONTROL_SERVICE, type ControlRunFile };
/** Compatibility aliases; the canonical wire constants live in protocol.ts. */
export const CONTROL_RUNFILE_SCHEMA = CONTROL_PROTOCOL_VERSION;
export const CONTROL_RUNFILE_MAX_BYTES = CONTROL_RUN_FILE_MAX_BYTES;

export type ControlPaths = {
  configId: string;
  controlRoot: string;
  dir: string;
  leaseDb: string;
  runFile: string;
};

export type RunFileRead =
  | { kind: "absent" }
  | { kind: "present"; value: ControlRunFile; dev: bigint; ino: bigint };

export class UnsafeControlStateError extends Error {
  constructor(readonly path: string, readonly why: string) {
    super(`refusing control state ${path}: ${why}`);
    this.name = "UnsafeControlStateError";
  }
}

function selfUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function assertPrivateDirectory(path: string, create: boolean): void {
  if (create) mkdirSync(path, { recursive: false, mode: 0o700 });
  const st = lstatSync(path, { bigint: true });
  if (st.isSymbolicLink() || !st.isDirectory()) throw new UnsafeControlStateError(path, "it is not a real directory");
  const uid = selfUid();
  if (uid !== undefined && Number(st.uid) !== uid) throw new UnsafeControlStateError(path, `it is owned by uid ${String(st.uid)}, not ${uid}`);
  chmodSync(path, 0o700);
  const after = lstatSync(path, { bigint: true });
  if ((Number(after.mode) & 0o077) !== 0) throw new UnsafeControlStateError(path, "private mode 0700 could not be enforced");
}

/** Derive a stable locator identity. Mutable config contents intentionally do not affect ownership. */
export function controlConfigId(configPath: string, rootDir: string): string {
  const configReal = realpathSync(resolve(configPath));
  const rootReal = realpathSync(resolve(rootDir));
  return createHash("sha256")
    .update("relayforge-config-v1\0", "utf8")
    .update(configReal, "utf8")
    .update("\0", "utf8")
    .update(rootReal, "utf8")
    .digest("hex");
}

export function controlPaths(rootDir: string, configPath: string): ControlPaths {
  const rootReal = realpathSync(resolve(rootDir));
  const configId = controlConfigId(configPath, rootReal);
  const controlRoot = resolve(rootReal, ".loop", "control");
  const dir = resolve(controlRoot, configId);
  return { configId, controlRoot, dir, leaseDb: resolve(dir, "serve-lock.sqlite"), runFile: resolve(dir, "serve.json") };
}

export function ensureControlDirectory(paths: ControlPaths): void {
  const loopDir = dirname(paths.controlRoot);
  if (!existsSync(loopDir)) {
    mkdirSync(loopDir, { mode: 0o700 });
  } else {
    const st = lstatSync(loopDir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new UnsafeControlStateError(loopDir, "it is not a real directory");
  }
  if (!existsSync(paths.controlRoot)) assertPrivateDirectory(paths.controlRoot, true);
  else assertPrivateDirectory(paths.controlRoot, false);
  if (!existsSync(paths.dir)) assertPrivateDirectory(paths.dir, true);
  else assertPrivateDirectory(paths.dir, false);
}

function parseRunFile(value: unknown, path: string): ControlRunFile {
  try {
    return parseProtocolRunFile(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "run-file does not match the canonical protocol";
    throw new UnsafeControlStateError(path, detail);
  }
}

export function readControlRunFile(path: string): RunFileRead {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "absent" };
    throw new UnsafeControlStateError(path, code === "ELOOP" ? "it is a symlink" : `open failed (${code ?? "unknown"})`);
  }
  try {
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile()) throw new UnsafeControlStateError(path, "it is not a regular file");
    if (st.nlink !== 1n) throw new UnsafeControlStateError(path, `it has ${String(st.nlink)} hard links`);
    if ((Number(st.mode) & 0o077) !== 0) throw new UnsafeControlStateError(path, `mode ${(Number(st.mode) & 0o7777).toString(8)} is not private`);
    const uid = selfUid();
    if (uid !== undefined && Number(st.uid) !== uid) throw new UnsafeControlStateError(path, `it is owned by uid ${String(st.uid)}, not ${uid}`);
    if (st.size > BigInt(CONTROL_RUNFILE_MAX_BYTES)) throw new UnsafeControlStateError(path, `it exceeds ${CONTROL_RUNFILE_MAX_BYTES} bytes`);
    const buffer = Buffer.alloc(Number(st.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== Number(st.size)) throw new UnsafeControlStateError(path, "size changed while it was read");
    const after = fstatSync(fd, { bigint: true });
    if (after.dev !== st.dev || after.ino !== st.ino || after.size !== st.size || after.nlink !== 1n) {
      throw new UnsafeControlStateError(path, "identity changed while it was read");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(buffer.subarray(0, offset).toString("utf8"));
    } catch {
      throw new UnsafeControlStateError(path, "run-file JSON is malformed");
    }
    return { kind: "present", value: parseRunFile(decoded, path), dev: st.dev, ino: st.ino };
  } finally {
    closeSync(fd);
  }
}

export function newControlRunFile(input: Omit<ControlRunFile, "schemaVersion" | "service" | "instanceId" | "host"> & { instanceId?: string }): ControlRunFile {
  const value: ControlRunFile = {
    schemaVersion: CONTROL_RUNFILE_SCHEMA,
    service: CONTROL_SERVICE,
    instanceId: input.instanceId ?? randomBytes(32).toString("hex"),
    configId: input.configId,
    pid: input.pid,
    processStartToken: input.processStartToken,
    host: CONTROL_HOST,
    port: input.port,
    startedAt: input.startedAt
  };
  return parseRunFile(value, "<new control run-file>");
}

export function publishControlRunFile(path: string, value: ControlRunFile): void {
  parseRunFile(value, path);
  const current = readControlRunFile(path);
  if (current.kind === "present" && current.value.configId !== value.configId) {
    throw new UnsafeControlStateError(path, "an existing run-file belongs to another configuration");
  }
  const body = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(body) > CONTROL_RUNFILE_MAX_BYTES) throw new UnsafeControlStateError(path, "serialized run-file exceeds its byte bound");
  writeStateFileDurable(path, body);
}

export function removeControlRunFileIfInstance(path: string, configId: string, instanceId: string): boolean {
  const current = readControlRunFile(path);
  if (current.kind === "absent") return false;
  if (current.value.service !== CONTROL_SERVICE || current.value.configId !== configId || current.value.instanceId !== instanceId) return false;
  const before = lstatSync(path, { bigint: true });
  if (before.dev !== current.dev || before.ino !== current.ino || before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n) {
    throw new UnsafeControlStateError(path, "run-file identity changed before removal");
  }
  unlinkSync(path);
  const dirFd = openSync(dirname(path), fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
  return true;
}

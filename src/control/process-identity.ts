import { createHash } from "node:crypto";
import { constants as fsConstants, openSync, closeSync, fstatSync, readSync } from "node:fs";
import { spawnSync } from "node:child_process";

const MAX_PROC_BYTES = 16 * 1024;
const TOKEN_MAX_BYTES = 512;

export class ProcessIdentityUnavailableError extends Error {
  constructor(message: string) {
    super(`process identity unavailable: ${message}`);
    this.name = "ProcessIdentityUnavailableError";
  }
}

export type ProcessIncarnationInspection =
  | { state: "alive-match"; token: string }
  | { state: "alive-mismatch"; token: string }
  | { state: "dead" }
  | { state: "unavailable"; detail: string };

function readSmallFile(path: string, maxBytes = MAX_PROC_BYTES): string {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) {
      throw new ProcessIdentityUnavailableError(`${path} is not a bounded regular file`);
    }
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, Math.max(256, st.size + 1)));
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > maxBytes) throw new ProcessIdentityUnavailableError(`${path} exceeds ${maxBytes} bytes`);
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function linuxStartToken(pid: number): string {
  const bootId = readSmallFile("/proc/sys/kernel/random/boot_id", 128).trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(bootId)) {
    throw new ProcessIdentityUnavailableError("Linux boot ID is malformed");
  }
  const stat = readSmallFile(`/proc/${pid}/stat`);
  const closeParen = stat.lastIndexOf(")");
  if (closeParen < 2 || stat[closeParen + 1] !== " ") {
    throw new ProcessIdentityUnavailableError(`Linux stat for pid ${pid} is malformed`);
  }
  // Fields after the comm closing parenthesis begin at field 3 (state). Start time is field 22.
  const fields = stat.slice(closeParen + 2).trim().split(/ +/u);
  const startTicks = fields[19];
  if (!startTicks || !/^[1-9][0-9]*$/.test(startTicks)) {
    throw new ProcessIdentityUnavailableError(`Linux start ticks for pid ${pid} are malformed`);
  }
  return `linux:${bootId}:${startTicks}`;
}

function commandStartToken(pid: number): string {
  const command = process.platform === "win32" ? "powershell.exe" : "/bin/ps";
  const args = process.platform === "win32"
    ? ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\").CreationDate.ToUniversalTime().ToString('o')`]
    : ["-o", "lstart=", "-p", String(pid)];
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 4 * 1024,
    windowsHide: true,
    env: { PATH: process.env.PATH ?? "" }
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? `exit ${String(result.status)}`;
    throw new ProcessIdentityUnavailableError(`could not inspect pid ${pid} (${detail})`);
  }
  const value = result.stdout.trim();
  if (!value || Buffer.byteLength(value) > 256 || /[\u0000\r\n]/u.test(value)) {
    throw new ProcessIdentityUnavailableError(`start value for pid ${pid} is malformed`);
  }
  const digest = createHash("sha256").update(value, "utf8").digest("hex");
  return `${process.platform}:${digest}`;
}

export function processStartToken(pid = process.pid): string {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2_147_483_647) {
    throw new ProcessIdentityUnavailableError(`invalid pid ${String(pid)}`);
  }
  let token: string;
  try {
    token = process.platform === "linux" ? linuxStartToken(pid) : commandStartToken(pid);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") {
      throw new ProcessIdentityUnavailableError(`pid ${pid} does not exist`);
    }
    if (error instanceof ProcessIdentityUnavailableError) throw error;
    throw new ProcessIdentityUnavailableError((error as Error).message);
  }
  if (Buffer.byteLength(token) > TOKEN_MAX_BYTES || !/^[a-z0-9:.-]+$/u.test(token)) {
    throw new ProcessIdentityUnavailableError("generated token is outside its closed grammar");
  }
  return token;
}

export function inspectProcessIncarnation(pid: number, expectedToken: string): ProcessIncarnationInspection {
  if (typeof expectedToken !== "string" || expectedToken.length === 0 || Buffer.byteLength(expectedToken) > TOKEN_MAX_BYTES) {
    return { state: "unavailable", detail: "recorded process-start token is invalid" };
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return { state: "dead" };
    if (code !== "EPERM") return { state: "unavailable", detail: `liveness probe failed (${code ?? "unknown"})` };
  }
  try {
    const token = processStartToken(pid);
    return token === expectedToken ? { state: "alive-match", token } : { state: "alive-mismatch", token };
  } catch (error) {
    return { state: "unavailable", detail: (error as Error).message };
  }
}

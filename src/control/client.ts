import {
  CONTROL_HEALTH_MAX_BYTES,
  CONTROL_HOST,
  CONTROL_PROTOCOL_VERSION,
  CONTROL_RELEVANT_HEADERS_MAX_BYTES,
  CONTROL_SERVICE,
  CONTROL_STATUS_MAX_BYTES,
  parseControlHealthJson,
  parseControlStatusJson,
  type ControlHealth,
  type ControlRunFile,
  type ControlStatus
} from "./protocol.js";
import { probeControlLease, type ControlLeaseProbe } from "./lease.js";
import { readControlRunFile, type ControlPaths, type RunFileRead } from "./runfile.js";

export const CONTROL_ATTACH_TIMEOUT_MS = 2_000;

export type ControlAttachment = {
  baseUrl: string;
  runFile: ControlRunFile;
  health: ControlHealth;
};

export type ControlServiceInspection =
  | { state: "ready"; attachment: ControlAttachment }
  | { state: "stopped"; detail: string }
  | { state: "starting"; detail: string; runFile?: ControlRunFile }
  | { state: "stale-runfile"; detail: string; runFile: ControlRunFile }
  | { state: "held-unhealthy"; detail: string; runFile?: ControlRunFile }
  | { state: "identity-mismatch"; detail: string; runFile?: ControlRunFile }
  | { state: "failed"; detail: string };

export class ControlClientError extends Error {
  constructor(
    readonly code:
      | "NOT_READY"
      | "IDENTITY_MISMATCH"
      | "INVALID_RESPONSE"
      | "RESPONSE_TOO_LARGE"
      | "TIMEOUT"
      | "HTTP_ERROR",
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "ControlClientError";
  }
}

export type ControlJsonRequester = (url: string, maxBytes: number, timeoutMs: number) => Promise<Uint8Array>;

export type InspectControlServiceOptions = {
  timeoutMs?: number;
  requestJson?: ControlJsonRequester;
  readRunFile?: (path: string) => RunFileRead;
  probeLease?: (path: string) => ControlLeaseProbe;
};

function remaining(deadline: number): number {
  const value = deadline - Date.now();
  if (value <= 0) throw new ControlClientError("TIMEOUT", "control service attach timed out");
  return value;
}

function sameRunFile(a: Extract<RunFileRead, { kind: "present" }>, b: Extract<RunFileRead, { kind: "present" }>): boolean {
  return a.dev === b.dev && a.ino === b.ino && JSON.stringify(a.value) === JSON.stringify(b.value);
}

function healthMatches(runFile: ControlRunFile, health: ControlHealth): boolean {
  return (
    health.schemaVersion === CONTROL_PROTOCOL_VERSION &&
    health.service === CONTROL_SERVICE &&
    health.instanceId === runFile.instanceId &&
    health.configId === runFile.configId &&
    health.pid === runFile.pid &&
    health.startedAt === runFile.startedAt
  );
}

function held(probe: ControlLeaseProbe): boolean {
  return probe.state === "held";
}

/**
 * Perform the complete private A/lease/health/B/lease attach handshake. The run-file is discovery
 * evidence only; readiness is returned only while the stable lifetime lease remains held and every
 * identity agrees across both observations.
 */
export async function inspectControlService(
  paths: ControlPaths,
  options: InspectControlServiceOptions = {}
): Promise<ControlServiceInspection> {
  const readRunFile = options.readRunFile ?? readControlRunFile;
  const probeLease = options.probeLease ?? probeControlLease;
  const requestJson = options.requestJson ?? requestControlJson;
  const timeoutMs = options.timeoutMs ?? CONTROL_ATTACH_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    return { state: "failed", detail: "attach timeout is outside the supported range" };
  }
  const deadline = Date.now() + timeoutMs;

  let first: RunFileRead;
  let firstLease: ControlLeaseProbe;
  try {
    first = readRunFile(paths.runFile);
    firstLease = probeLease(paths.leaseDb);
  } catch (error) {
    return { state: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
  if (firstLease.state === "failed") return { state: "failed", detail: firstLease.detail };
  if (first.kind === "absent") {
    return held(firstLease)
      ? { state: "starting", detail: "the owner lease is held but readiness has not been published" }
      : { state: "stopped", detail: "no control service owner is active" };
  }
  if (!held(firstLease)) {
    return { state: "stale-runfile", detail: "the discovery file remains but the owner lease is not held", runFile: first.value };
  }
  if (first.value.configId !== paths.configId || first.value.host !== CONTROL_HOST) {
    return { state: "identity-mismatch", detail: "the discovery file belongs to another control identity", runFile: first.value };
  }

  let health: ControlHealth;
  try {
    const raw = await requestJson(
      `http://${CONTROL_HOST}:${first.value.port}/api/v1/health`,
      CONTROL_HEALTH_MAX_BYTES,
      remaining(deadline)
    );
    health = parseControlHealthJson(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { state: "held-unhealthy", detail, runFile: first.value };
  }

  let second: RunFileRead;
  let secondLease: ControlLeaseProbe;
  try {
    remaining(deadline);
    second = readRunFile(paths.runFile);
    secondLease = probeLease(paths.leaseDb);
  } catch (error) {
    return { state: "identity-mismatch", detail: error instanceof Error ? error.message : String(error), runFile: first.value };
  }
  if (secondLease.state === "failed") return { state: "failed", detail: secondLease.detail };
  if (second.kind !== "present" || !sameRunFile(first, second) || !held(secondLease)) {
    return { state: "identity-mismatch", detail: "control ownership changed during the attach handshake", runFile: first.value };
  }
  if (!healthMatches(second.value, health)) {
    return { state: "identity-mismatch", detail: "health and discovery identities do not agree", runFile: second.value };
  }
  if (health.status !== "ok") {
    return { state: "starting", detail: "the control owner has not declared readiness", runFile: second.value };
  }
  return {
    state: "ready",
    attachment: {
      baseUrl: `http://${CONTROL_HOST}:${second.value.port}`,
      runFile: second.value,
      health
    }
  };
}

export async function requireControlService(
  paths: ControlPaths,
  options: InspectControlServiceOptions = {}
): Promise<ControlAttachment> {
  const inspection = await inspectControlService(paths, options);
  if (inspection.state === "ready") return inspection.attachment;
  throw new ControlClientError(
    inspection.state === "identity-mismatch" ? "IDENTITY_MISMATCH" : "NOT_READY",
    `${inspection.state}: ${inspection.detail}`
  );
}

export async function fetchControlStatus(
  attachment: ControlAttachment,
  options: { timeoutMs?: number; requestJson?: ControlJsonRequester } = {}
): Promise<ControlStatus> {
  const timeoutMs = options.timeoutMs ?? CONTROL_ATTACH_TIMEOUT_MS;
  const raw = await (options.requestJson ?? requestControlJson)(
    `${attachment.baseUrl}/api/v1/status`,
    CONTROL_STATUS_MAX_BYTES,
    timeoutMs
  );
  let status: ControlStatus;
  try {
    status = parseControlStatusJson(raw);
  } catch (error) {
    throw new ControlClientError("INVALID_RESPONSE", error instanceof Error ? error.message : String(error));
  }
  if (
    status.instanceId !== attachment.runFile.instanceId ||
    status.configId !== attachment.runFile.configId ||
    status.startedAt !== attachment.runFile.startedAt
  ) {
    throw new ControlClientError("IDENTITY_MISMATCH", "status and attached service identities do not agree");
  }
  return status;
}

export function renderControlStatus(status: ControlStatus): string {
  const lines = [
    `RelayForge control service ${status.instanceId.slice(0, 12)} (${status.status})`,
    `Started: ${status.startedAt}`
  ];
  for (const project of status.projects) {
    const run = project.latestRun;
    lines.push(
      run
        ? `${project.project}: ${run.run} ${run.status} · ${run.tasks.done}/${run.tasks.total} done${run.stale ? " · stale" : ""}`
        : `${project.project}: no runs`
    );
    for (const session of project.sessions) {
      lines.push(`  ${session.role}: ${session.state}${session.taskId ? ` · ${session.taskId}` : ""}`);
    }
  }
  return lines.join("\n");
}

/** Fetch one bounded JSON document without redirects or unbounded body buffering. */
export async function requestControlJson(url: string, maxBytes: number, timeoutMs: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new ControlClientError("INVALID_RESPONSE", "invalid control client bounds");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted) throw new ControlClientError("TIMEOUT", "control service request timed out");
      throw new ControlClientError("HTTP_ERROR", error instanceof Error ? error.message : String(error));
    }

    let headerBytes = 0;
    for (const [name, value] of response.headers) headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    if (headerBytes > CONTROL_RELEVANT_HEADERS_MAX_BYTES) {
      await response.body?.cancel();
      throw new ControlClientError("RESPONSE_TOO_LARGE", "control response headers exceed the client bound", response.status);
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null) {
      if (!/^(0|[1-9]\d*)$/.test(contentLength)) {
        await response.body?.cancel();
        throw new ControlClientError("INVALID_RESPONSE", "control response content-length is invalid", response.status);
      }
      const advertised = Number(contentLength);
      if (!Number.isSafeInteger(advertised) || advertised > maxBytes) {
        await response.body?.cancel();
        throw new ControlClientError("RESPONSE_TOO_LARGE", "control response body exceeds the client bound", response.status);
      }
    }
    if (!response.ok) {
      await readBoundedBody(response, Math.min(maxBytes, 4 * 1024));
      throw new ControlClientError("HTTP_ERROR", `control service returned HTTP ${response.status}`, response.status);
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("application/json")) {
      await response.body?.cancel();
      throw new ControlClientError("INVALID_RESPONSE", "control response is not JSON", response.status);
    }
    try {
      return await readBoundedBody(response, maxBytes);
    } catch (error) {
      if (controller.signal.aborted) throw new ControlClientError("TIMEOUT", "control service request timed out");
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ControlClientError("RESPONSE_TOO_LARGE", "control response body exceeds the client bound", response.status);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

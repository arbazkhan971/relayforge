import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import type { ControlAttachment } from "../control/client.js";
import {
  CONTROL_SSE_FRAME_MAX_BYTES,
  parseControlSseControlFrameJson,
  parseControlSseNotificationJson
} from "../control/protocol.js";
import { CONTROL_ROOM_RESPONSE_MAX_BYTES } from "./server-adapter.js";
import type { ControlRoomClientTransport, ControlRoomSubscriptionState } from "./client.js";

export const CONTROL_ROOM_SUBSCRIPTION_LIMITS = Object.freeze({
  reconnectInitialMs: 250,
  reconnectMaximumMs: 5_000,
  handshakeTimeoutMs: 2_000
});

export type ControlServiceControlRoomTransportOptions = Readonly<{
  attachment: ControlAttachment;
  project: string;
  run: string;
  observationLimit?: number;
  reconnectInitialMs?: number;
  reconnectMaximumMs?: number;
  handshakeTimeoutMs?: number;
}>;

function route(baseUrl: string, run: string, leaf: "observations" | "events", project: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(project) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(run)) {
    throw new TypeError("control-room project/run identity is invalid");
  }
  return `${baseUrl}/api/v1/runs/${encodeURIComponent(run)}/${leaf}?project=${encodeURIComponent(project)}`;
}

async function boundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  if (!response.ok || !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`control-room snapshot HTTP ${response.status}`);
  }
  const advertised = response.headers.get("content-length");
  if (advertised !== null && (!/^(0|[1-9]\d*)$/u.test(advertised) || Number(advertised) > maximumBytes)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("control-room snapshot exceeds its byte bound");
  }
  if (!response.body) throw new Error("control-room snapshot body is absent");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error("control-room snapshot exceeds its byte bound");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
  return JSON.parse(bytes.toString("utf8"));
}

function consumeSse(
  response: IncomingMessage,
  listener: (notification: unknown) => void,
  onAvailable: () => void,
  onMalformed: () => void
): boolean {
  const contentType = response.headers["content-type"];
  if (response.statusCode !== 200 || typeof contentType !== "string" || !contentType.toLowerCase().startsWith("text/event-stream")) {
    response.resume();
    return false;
  }
  let buffered = Buffer.alloc(0);
  response.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    if (buffered.byteLength > CONTROL_SSE_FRAME_MAX_BYTES * 2) {
      onMalformed();
      return;
    }
    while (true) {
      const end = buffered.indexOf("\n\n");
      if (end < 0) break;
      const frame = buffered.subarray(0, end);
      buffered = buffered.subarray(end + 2);
      if (frame.byteLength === 0 || frame[0] === 0x3a) continue;
      if (frame.byteLength > CONTROL_SSE_FRAME_MAX_BYTES) {
        onMalformed();
        return;
      }
      let eventName = "";
      let data = "";
      for (const line of frame.toString("utf8").split("\n")) {
        if (line.startsWith("event: ")) eventName = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (!data) continue;
      try {
        if (eventName === "control.changed") {
          const value = parseControlSseNotificationJson(data);
          // The renderer client intentionally receives only metadata needed to wake/refetch.
          onAvailable();
          listener({ type: "control.changed", runEpoch: value.runEpoch, seq: value.headSeq });
        } else if (eventName === "control.ready" || eventName === "control.resync-required") {
          const value = parseControlSseControlFrameJson(data);
          if (value.type === "control.ready") {
            onAvailable();
            listener({ type: "control.changed", runEpoch: value.runEpoch, seq: value.headSeq });
          }
          if (value.type === "control.resync-required") {
            onAvailable();
            listener({ type: "control.changed", runEpoch: value.runEpoch, seq: value.snapshotSeq });
          }
        }
      } catch {
        onMalformed();
        return;
      }
    }
  });
  return true;
}

/** Loopback-only, metadata-only transport for the shared ControlRoomClient. */
export function createControlServiceControlRoomTransport(
  options: ControlServiceControlRoomTransportOptions
): ControlRoomClientTransport {
  const limit = options.observationLimit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RangeError("control-room observation limit is invalid");
  const base = new URL(options.attachment.baseUrl);
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || base.username || base.password || base.pathname !== "/") {
    throw new TypeError("control-room attachment is not canonical loopback HTTP");
  }
  const observations = `${route(options.attachment.baseUrl, options.run, "observations", options.project)}&limit=${limit}`;
  const events = route(options.attachment.baseUrl, options.run, "events", options.project);
  const reconnectInitialMs = options.reconnectInitialMs ?? CONTROL_ROOM_SUBSCRIPTION_LIMITS.reconnectInitialMs;
  const reconnectMaximumMs = options.reconnectMaximumMs ?? CONTROL_ROOM_SUBSCRIPTION_LIMITS.reconnectMaximumMs;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? CONTROL_ROOM_SUBSCRIPTION_LIMITS.handshakeTimeoutMs;
  if (!Number.isSafeInteger(reconnectInitialMs) || reconnectInitialMs < 10 || reconnectInitialMs > 60_000 ||
      !Number.isSafeInteger(reconnectMaximumMs) || reconnectMaximumMs < reconnectInitialMs || reconnectMaximumMs > 60_000 ||
      !Number.isSafeInteger(handshakeTimeoutMs) || handshakeTimeoutMs < 10 || handshakeTimeoutMs > 60_000) {
    throw new RangeError("control-room subscription limits are invalid");
  }
  return Object.freeze({
    subscribe(
      listener: (notification: unknown) => void,
      stateListener?: (state: ControlRoomSubscriptionState) => void
    ) {
      let closed = false;
      let active: ClientRequest | undefined;
      let incoming: IncomingMessage | undefined;
      let retryTimer: NodeJS.Timeout | undefined;
      let retryAttempt = 0;
      let available = false;
      let connectionGeneration = 0;
      const state = (value: ControlRoomSubscriptionState): void => {
        try { stateListener?.(value); } catch { /* client state callbacks own no transport authority */ }
      };
      const scheduleReconnect = (): void => {
        if (closed || retryTimer !== undefined) return;
        if (available) {
          available = false;
          state("unavailable");
        } else state("unavailable");
        active?.destroy();
        incoming?.destroy();
        active = undefined;
        incoming = undefined;
        const exponent = Math.min(retryAttempt, 16);
        const delay = Math.min(reconnectMaximumMs, reconnectInitialMs * (2 ** exponent));
        retryAttempt += 1;
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          if (closed) return;
          state("connecting");
          connect();
        }, delay);
        retryTimer.unref();
      };
      const connect = (): void => {
        if (closed) return;
        const generation = ++connectionGeneration;
        // An absent cursor asks for a metadata-only ready frame at the current canonical head. The
        // snapshot refetch then closes the subscribe-before-snapshot race; reconnect never pretends
        // it has a durable cursor it did not persist.
        const url = new URL(events);
        let failed = false;
        const fail = (): void => {
          if (failed || closed || generation !== connectionGeneration) return;
          failed = true;
          scheduleReconnect();
        };
        active = httpRequest(url, { method: "GET", headers: { accept: "text/event-stream" } }, (response) => {
          incoming = response;
          const accepted = consumeSse(
            response,
            (notification) => {
              try { listener(notification); } catch { /* a renderer wake callback cannot break the stream */ }
            },
            () => {
              if (closed || generation !== connectionGeneration) return;
              active?.setTimeout(0);
              retryAttempt = 0;
              if (!available) {
                available = true;
                state("available");
              }
            },
            () => {
              response.destroy();
              fail();
            }
          );
          if (!accepted) {
            response.once("end", fail);
            response.resume();
            fail();
            return;
          }
          response.once("aborted", fail);
          response.once("error", fail);
          response.once("end", fail);
          response.once("close", fail);
        });
        active.setTimeout(handshakeTimeoutMs, () => active?.destroy(new Error("control SSE handshake timed out")));
        active.once("error", fail);
        active.end();
      };
      state("connecting");
      connect();
      return () => {
        closed = true;
        connectionGeneration += 1;
        if (retryTimer !== undefined) clearTimeout(retryTimer);
        retryTimer = undefined;
        incoming?.destroy();
        incoming = undefined;
        active?.destroy();
        active = undefined;
      };
    },
    async fetchSnapshot(signal: AbortSignal) {
      const response = await fetch(observations, { method: "GET", redirect: "error", cache: "no-store", signal });
      return await boundedJson(response, CONTROL_ROOM_RESPONSE_MAX_BYTES);
    }
  });
}

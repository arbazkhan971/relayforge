import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, realpathSync, renameSync, statSync, unlinkSync, type Stats } from "node:fs";
import { createConnection, createServer, isIP, type Server, type Socket } from "node:net";
import { lookup } from "node:dns/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  GROK_EGRESS_ALLOWED_AUTHORITY,
  GROK_EGRESS_ALLOWED_HEADERS,
  GROK_EGRESS_CONNECT_TIMEOUT_MS,
  GROK_EGRESS_MAX_CONNECTIONS,
  GROK_EGRESS_MAX_DECISIONS,
  GROK_EGRESS_MAX_HEADER_BYTES,
  GROK_EGRESS_MAX_LIFETIME_MS,
  GROK_EGRESS_POLICY_SHA256,
  GROK_EGRESS_SOCKET_NAME
} from "./grok-egress-contract.js";

export {
  GROK_EGRESS_ALLOWED_AUTHORITY,
  GROK_EGRESS_CONNECT_TIMEOUT_MS,
  GROK_EGRESS_MAX_CONNECTIONS,
  GROK_EGRESS_MAX_DECISIONS,
  GROK_EGRESS_MAX_HEADER_BYTES,
  GROK_EGRESS_MAX_LIFETIME_MS,
  GROK_EGRESS_POLICY_SHA256,
  GROK_EGRESS_POLICY_VERSION,
  GROK_EGRESS_SOCKET_NAME
} from "./grok-egress-contract.js";

const ALLOWED_HEADERS = new Set<string>(GROK_EGRESS_ALLOWED_HEADERS);

export type GrokEgressDecision = Readonly<{
  sequence: number;
  decision: "allowed" | "denied" | "failed";
  reason:
    | "approved-connect"
    | "authority-denied"
    | "malformed-request"
    | "header-denied"
    | "capacity-denied"
    | "upstream-unavailable";
  requestSha256: string;
  evidenceSha256: string;
}>;

/** Why exact socket removal could not be proven after tunnels/server were reaped. */
export type GrokEgressCleanupUncertainReason =
  | "socket-missing"
  | "socket-replaced"
  | "socket-foreign"
  | "unlink-race"
  | "live-tunnel"
  | "server-close-failed";

export type GrokEgressCleanupEvidence = Readonly<{
  resourcesReaped: true;
  socketRemoved: boolean;
  socketPreserved: boolean;
  reason?: GrokEgressCleanupUncertainReason;
  detail?: string;
  socketIdentitySha256: string;
  decisionLogSha256: string;
  decisionLogOverflowed: boolean;
  expired: boolean;
}>;

export class GrokEgressCleanupError extends Error {
  readonly code = "GROK_EGRESS_CLEANUP_UNCERTAIN" as const;
  readonly evidence: GrokEgressCleanupEvidence;

  constructor(message: string, evidence: GrokEgressCleanupEvidence, options?: ErrorOptions) {
    super(message, options);
    this.name = "GrokEgressCleanupError";
    this.evidence = Object.freeze({ ...evidence });
  }
}

export type GrokEgressProxy = Readonly<{
  socketPath: string;
  policySha256: string;
  decisions(): readonly GrokEgressDecision[];
  status(): Readonly<{
    closed: boolean;
    decisionLogOverflowed: boolean;
    decisionLogSha256: string;
    expired: boolean;
    socketIdentitySha256: string;
    cleanupSha256?: string;
    /** Present after a completed drain attempt; never claims socketRemoved without proof. */
    cleanupEvidence?: GrokEgressCleanupEvidence;
  }>;
  assertSocketIdentity(): void;
  /**
   * Attempt-all, replacement-safe teardown. Always destroys active tunnels and closes the parent
   * server even when the path is missing or replaced. Unlinks only the originally pinned identity
   * (exact dev+ino+mode+uid+socket type) observed immediately before unlink. Never claims
   * cleanupSha256/socketRemoved without that proof. Idempotent.
   */
  closeAndDrain(): Promise<void>;
}>;

export type ParsedGrokConnectRequest = Readonly<{
  decision: "allow" | "deny";
  reason: "approved-connect" | "authority-denied" | "malformed-request" | "header-denied";
  requestSha256: string;
  tunnelPrefix: Buffer;
}>;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function denied(
  reason: Exclude<ParsedGrokConnectRequest["reason"], "approved-connect">,
  requestSha256: string,
  tunnelPrefix: Buffer = Buffer.alloc(0)
): ParsedGrokConnectRequest {
  return Object.freeze({ decision: "deny", reason, requestSha256, tunnelPrefix });
}

/**
 * Parse one complete bounded HTTP CONNECT preface. The target is intentionally not configurable:
 * callers cannot widen the only approved Grok inference authority.
 */
export function parseGrokEgressConnectRequest(bytes: Buffer): ParsedGrokConnectRequest {
  const requestSha256 = sha256(bytes);
  if (bytes.length === 0 || bytes.length > GROK_EGRESS_MAX_HEADER_BYTES) {
    return denied("malformed-request", requestSha256);
  }
  const boundary = bytes.indexOf("\r\n\r\n");
  if (boundary < 0 || boundary + 4 > GROK_EGRESS_MAX_HEADER_BYTES) {
    return denied("malformed-request", requestSha256);
  }
  const headerBytes = bytes.subarray(0, boundary + 4);
  const tunnelPrefix = bytes.subarray(boundary + 4);
  for (const byte of headerBytes) {
    if (byte === 0 || byte > 0x7f) return denied("malformed-request", requestSha256, tunnelPrefix);
  }
  const lines = headerBytes.toString("ascii").slice(0, -4).split("\r\n");
  const requestLine = lines.shift();
  if (!requestLine) return denied("malformed-request", requestSha256, tunnelPrefix);
  const match = /^(\S+) (\S+) HTTP\/1\.1$/u.exec(requestLine);
  if (!match || match[1] !== "CONNECT") return denied("malformed-request", requestSha256, tunnelPrefix);
  if (match[2] !== GROK_EGRESS_ALLOWED_AUTHORITY) {
    return denied("authority-denied", requestSha256, tunnelPrefix);
  }

  const headers = new Map<string, string>();
  if (lines.length > 32) return denied("header-denied", requestSha256, tunnelPrefix);
  for (const line of lines) {
    const header = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([^\r\n]*)$/u.exec(line);
    if (!header) return denied("malformed-request", requestSha256, tunnelPrefix);
    const name = header[1]!.toLowerCase();
    const value = header[2]!;
    if (!ALLOWED_HEADERS.has(name) || headers.has(name) || value.length > 1_024 || /[\u0000-\u001f\u007f]/u.test(value)) {
      return denied("header-denied", requestSha256, tunnelPrefix);
    }
    headers.set(name, value);
  }
  if (headers.get("host") !== GROK_EGRESS_ALLOWED_AUTHORITY) {
    return denied("header-denied", requestSha256, tunnelPrefix);
  }
  return Object.freeze({ decision: "allow", reason: "approved-connect", requestSha256, tunnelPrefix });
}

function privateOwnedDirectory(path: string): string {
  if (!isAbsolute(path) || path.includes("\0") || Buffer.byteLength(path, "utf8") > 4_096 || resolve(path) !== path) {
    throw new TypeError("Grok egress socket directory must be a bounded canonical absolute path");
  }
  const canonical = realpathSync(path);
  if (canonical !== path) throw new TypeError("Grok egress socket directory must not traverse symlinks");
  const info = statSync(canonical);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
    throw new TypeError("Grok egress socket directory must be private and owned by the parent");
  }
  return canonical;
}

function parseIpv4Bytes(address: string): Uint8Array | undefined {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return undefined;
  return Uint8Array.from(octets);
}

function parseIpv6Bytes(address: string): Uint8Array | undefined {
  if (address.includes("%") || address.length === 0) return undefined;
  let value = address.toLowerCase();
  let ipv4Tail: Uint8Array | undefined;
  const finalColon = value.lastIndexOf(":");
  if (value.includes(".") && finalColon >= 0) {
    ipv4Tail = parseIpv4Bytes(value.slice(finalColon + 1));
    if (!ipv4Tail) return undefined;
    value = `${value.slice(0, finalColon)}:${((ipv4Tail[0]! << 8) | ipv4Tail[1]!).toString(16)}:${((ipv4Tail[2]! << 8) | ipv4Tail[3]!).toString(16)}`;
  }
  if (value.split("::").length > 2) return undefined;
  const [leftText, rightText] = value.split("::") as [string, string?];
  const parseSide = (text: string | undefined): number[] | undefined => {
    if (!text) return [];
    const groups = text.split(":");
    const parsed: number[] = [];
    for (const group of groups) {
      if (!/^[0-9a-f]{1,4}$/u.test(group)) return undefined;
      parsed.push(Number.parseInt(group, 16));
    }
    return parsed;
  };
  const left = parseSide(leftText);
  const right = parseSide(rightText);
  if (!left || !right) return undefined;
  const compressed = rightText !== undefined;
  if ((!compressed && left.length !== 8) || (compressed && left.length + right.length >= 8)) return undefined;
  const groups = compressed
    ? [...left, ...Array.from({ length: 8 - left.length - right.length }, () => 0), ...right]
    : left;
  if (groups.length !== 8) return undefined;
  const bytes = new Uint8Array(16);
  for (let index = 0; index < groups.length; index += 1) {
    bytes[index * 2] = groups[index]! >>> 8;
    bytes[index * 2 + 1] = groups[index]! & 0xff;
  }
  return bytes;
}

function matchesCidr(bytes: Uint8Array, network: Uint8Array, prefix: number): boolean {
  const whole = Math.floor(prefix / 8);
  const remaining = prefix % 8;
  for (let index = 0; index < whole; index += 1) if (bytes[index] !== network[index]) return false;
  if (remaining === 0) return true;
  const mask = (0xff << (8 - remaining)) & 0xff;
  return (bytes[whole]! & mask) === (network[whole]! & mask);
}

const NON_GLOBAL_IPV4 = Object.freeze([
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.31.196.0", 24], ["192.52.193.0", 24], ["192.88.99.0", 24],
  ["192.168.0.0", 16], ["192.175.48.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
] as const).map(([network, prefix]) => Object.freeze({ bytes: parseIpv4Bytes(network)!, prefix }));

const REQUIRED_GLOBAL_IPV6 = Object.freeze({ bytes: parseIpv6Bytes("2000::")!, prefix: 3 });
const NON_GLOBAL_IPV6 = Object.freeze([
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]
] as const).map(([network, prefix]) => Object.freeze({ bytes: parseIpv6Bytes(network)!, prefix }));

function isPublicIpv4(address: string): boolean {
  const bytes = parseIpv4Bytes(address);
  return Boolean(bytes) && !NON_GLOBAL_IPV4.some((entry) => matchesCidr(bytes!, entry.bytes, entry.prefix));
}

function isPublicIpv6(address: string): boolean {
  const bytes = parseIpv6Bytes(address);
  return Boolean(bytes) && matchesCidr(bytes!, REQUIRED_GLOBAL_IPV6.bytes, REQUIRED_GLOBAL_IPV6.prefix) &&
    !NON_GLOBAL_IPV6.some((entry) => matchesCidr(bytes!, entry.bytes, entry.prefix));
}

export function isPublicGrokUpstreamAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? isPublicIpv4(address) : family === 6 ? isPublicIpv6(address) : false;
}

function connectAddress(address: string, family: 4 | 6): Promise<Socket> {
  return new Promise((resolveConnection, reject) => {
    const socket = createConnection({ host: address, port: 443, family });
    const timeout = setTimeout(() => socket.destroy(new Error("Grok egress upstream connect timed out")), GROK_EGRESS_CONNECT_TIMEOUT_MS);
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.removeListener("error", reject);
      resolveConnection(socket);
    });
    socket.once("error", reject);
  });
}

async function productionDialAllowed(): Promise<Socket> {
  const answers = await lookup("api.x.ai", { all: true, verbatim: true });
  if (answers.length === 0 || answers.some((answer) => !isPublicGrokUpstreamAddress(answer.address))) {
    throw new Error("Grok egress DNS returned an empty or non-public address set");
  }
  const ordered = [...answers].sort((left, right) => left.family - right.family || left.address.localeCompare(right.address));
  let lastError: unknown;
  for (const answer of ordered) {
    if (answer.family !== 4 && answer.family !== 6) continue;
    try {
      return await connectAddress(answer.address, answer.family);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Grok egress approved upstream was unavailable");
}

let unitTestDial: (() => Promise<Socket>) | undefined;
/** Import-only unit-test seam: runs between the pre-unlink identity proof and unlinkSync. */
let unitTestUnlinkRace: (() => void) | undefined;

/** Import-only unit-test seam. Production collection refuses while it is active. */
export function setGrokEgressTestDialForUnitTests(dial: (() => Promise<Socket>) | undefined): void {
  unitTestDial = dial;
}

/**
 * Import-only unit-test seam for the TOCTOU window immediately before the identity-safe unlink.
 * Production collection refuses while the dial seam is active; this race hook is likewise test-only.
 */
export function setGrokEgressUnlinkRaceForUnitTests(hook: (() => void) | undefined): void {
  unitTestUnlinkRace = hook;
}

export function grokEgressTestDialActive(): boolean {
  return unitTestDial !== undefined;
}

function response(status: 400 | 403 | 429 | 502): Buffer {
  const phrase = status === 400 ? "Bad Request" : status === 403 ? "Forbidden" : status === 429 ? "Too Many Requests" : "Bad Gateway";
  return Buffer.from(`HTTP/1.1 ${status} ${phrase}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, "ascii");
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolveListen, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(path, () => {
      server.removeListener("error", onError);
      resolveListen();
    });
  });
}

/**
 * Start the parent-owned half of the Grok network boundary. The returned Unix socket is mounted
 * read-only into a Bubblewrap `--unshare-net` jail; all external TCP is dialled here after parsing
 * the closed CONNECT policy.
 */
export async function createGrokEgressProxy(socketDirectory: string): Promise<GrokEgressProxy> {
  const directory = privateOwnedDirectory(socketDirectory);
  const socketPath = join(directory, GROK_EGRESS_SOCKET_NAME);
  if (existsSync(socketPath)) throw new Error("Grok egress socket already exists");

  const sockets = new Set<Socket>();
  const decisions: GrokEgressDecision[] = [];
  let active = 0;
  let closing: Promise<void> | undefined;
  let decisionLogOverflowed = false;
  let expired = false;
  let closed = false;
  let cleanupSha256: string | undefined;
  let closeAndDrain!: () => Promise<void>;

  const record = (decision: GrokEgressDecision["decision"], reason: GrokEgressDecision["reason"], requestSha256: string): void => {
    if (decisions.length >= GROK_EGRESS_MAX_DECISIONS) {
      decisionLogOverflowed = true;
      queueMicrotask(() => { void closeAndDrain().catch(() => undefined); });
      return;
    }
    const sequence = decisions.length + 1;
    const evidenceSha256 = sha256(JSON.stringify({
      decision,
      policySha256: GROK_EGRESS_POLICY_SHA256,
      reason,
      requestSha256,
      sequence
    }));
    decisions.push(Object.freeze({ sequence, decision, reason, requestSha256, evidenceSha256 }));
  };

  const server = createServer((client) => {
    sockets.add(client);
    client.once("close", () => sockets.delete(client));
    if (decisionLogOverflowed || decisions.length >= GROK_EGRESS_MAX_DECISIONS) {
      decisionLogOverflowed = true;
      client.end(response(429));
      queueMicrotask(() => { void closeAndDrain().catch(() => undefined); });
      return;
    }
    if (active >= GROK_EGRESS_MAX_CONNECTIONS) {
      const digest = sha256("capacity-denied");
      record("denied", "capacity-denied", digest);
      client.end(response(429));
      return;
    }
    active += 1;
    client.once("close", () => { active -= 1; });
    client.setTimeout(GROK_EGRESS_CONNECT_TIMEOUT_MS, () => client.destroy(new Error("Grok egress CONNECT preface timed out")));
    let buffered = Buffer.alloc(0);
    let handled = false;
    client.on("data", async (chunk: Buffer) => {
      if (handled) return;
      if (buffered.length + chunk.length > GROK_EGRESS_MAX_HEADER_BYTES) {
        handled = true;
        const digest = sha256(Buffer.concat([buffered, chunk]));
        record("denied", "malformed-request", digest);
        client.end(response(400));
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.indexOf("\r\n\r\n") < 0) return;
      handled = true;
      client.pause();
      const parsed = parseGrokEgressConnectRequest(buffered);
      if (parsed.decision === "deny") {
        record("denied", parsed.reason, parsed.requestSha256);
        client.end(response(parsed.reason === "authority-denied" ? 403 : 400));
        return;
      }
      try {
        const upstream = await (unitTestDial ?? productionDialAllowed)();
        sockets.add(upstream);
        upstream.once("close", () => sockets.delete(upstream));
        upstream.on("error", () => client.destroy());
        record("allowed", "approved-connect", parsed.requestSha256);
        client.setTimeout(0);
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n", "ascii");
        if (parsed.tunnelPrefix.length > 0) upstream.write(parsed.tunnelPrefix);
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      } catch {
        record("failed", "upstream-unavailable", parsed.requestSha256);
        client.end(response(502));
      }
    });
    client.on("error", () => {
      // Connection failures are represented by close/reap evidence; raw errors are not retained.
    });
  });

  await listen(server, socketPath);
  chmodSync(socketPath, 0o600);
  const socketInfo = lstatSync(socketPath);
  if (!socketInfo.isSocket() || (socketInfo.mode & 0o077) !== 0) {
    server.close();
    throw new Error("Grok egress proxy did not create a private Unix socket");
  }
  const socketIdentity = Object.freeze({
    dev: socketInfo.dev.toString(10),
    ino: socketInfo.ino.toString(10),
    mode: socketInfo.mode & 0o777,
    uid: socketInfo.uid
  });
  const socketIdentitySha256 = sha256(JSON.stringify(socketIdentity));
  let cleanupEvidence: GrokEgressCleanupEvidence | undefined;
  const decisionLogDigest = (): string => sha256(JSON.stringify(decisions));
  const observeSocketIdentity = (info: Stats): string => sha256(JSON.stringify({
    dev: info.dev.toString(10),
    ino: info.ino.toString(10),
    mode: info.mode & 0o777,
    uid: info.uid
  }));
  const matchesPinnedSocket = (info: Stats): boolean =>
    info.isSocket() && observeSocketIdentity(info) === socketIdentitySha256;
  const assertSocketIdentity = (): void => {
    const current = lstatSync(socketPath);
    if (!matchesPinnedSocket(current)) {
      throw new Error("Grok egress Unix socket identity changed during the contained call");
    }
  };

  const lifetime = setTimeout(() => {
    expired = true;
    void closeAndDrain().catch(() => undefined);
  }, GROK_EGRESS_MAX_LIFETIME_MS);
  lifetime.unref();

  const uncertain = (
    reason: GrokEgressCleanupUncertainReason,
    detail: string,
    socketPreserved: boolean,
    cause?: unknown
  ): never => {
    const evidence: GrokEgressCleanupEvidence = Object.freeze({
      resourcesReaped: true as const,
      socketRemoved: false,
      socketPreserved,
      reason,
      detail,
      socketIdentitySha256,
      decisionLogSha256: decisionLogDigest(),
      decisionLogOverflowed,
      expired
    });
    cleanupEvidence = evidence;
    // Never mint cleanupSha256 without proven exact removal.
    cleanupSha256 = undefined;
    closed = true;
    throw new GrokEgressCleanupError(
      `Grok egress cleanup uncertain [${reason}]: ${detail}`,
      evidence,
      cause === undefined ? undefined : { cause: cause instanceof Error ? cause : undefined }
    );
  };

  closeAndDrain = (): Promise<void> => {
    if (closing) return closing;
    clearTimeout(lifetime);
    closing = (async () => {
      // Attempt-all: destroy active tunnels first. Path judgment and identity-safe unlink follow.
      // Node's server.close() auto-unlinks the listen path by name without rechecking identity, so a
      // foreign/replacement leaf is parked aside before close and restored afterward.
      const socketClosures = [...sockets].map((socket) => new Promise<void>((resolveSocket) => {
        if (socket.closed) {
          resolveSocket();
          return;
        }
        socket.once("close", () => resolveSocket());
        socket.destroy();
      }));
      await Promise.all(socketClosures);
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
      const tracked = [...sockets];
      const liveSockets = tracked.filter((socket) => !(socket.destroyed && socket.closed));
      sockets.clear();
      if (liveSockets.length !== 0) {
        uncertain("live-tunnel", "Grok egress proxy cleanup left a live tunnel or client socket", existsSync(socketPath));
      }

      type PathDisposition = "ours" | "missing" | "foreign";
      let disposition: PathDisposition = "missing";
      let foreignKind: "socket-replaced" | "socket-foreign" | "unlink-race" = "socket-foreign";
      let parkedPath: string | undefined;

      const parkPath = (): void => {
        const parked = `${socketPath}.rf-preserve-${randomBytes(8).toString("hex")}`;
        renameSync(socketPath, parked);
        parkedPath = parked;
      };

      const classifyPath = (reasonIfForeign: "socket-replaced" | "socket-foreign" | "unlink-race"): PathDisposition => {
        try {
          const info = lstatSync(socketPath);
          if (matchesPinnedSocket(info)) return "ours";
          foreignKind = info.isSocket() && reasonIfForeign === "socket-replaced" ? "socket-replaced" : reasonIfForeign === "unlink-race" ? "unlink-race" : (info.isSocket() ? "socket-replaced" : "socket-foreign");
          parkPath();
          return "foreign";
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
          throw error;
        }
      };

      disposition = classifyPath("socket-replaced");
      // Import-only race seam between the pre-close identity proof and server.close auto-unlink.
      if (disposition === "ours") {
        unitTestUnlinkRace?.();
        disposition = classifyPath("unlink-race");
      }

      let serverCloseError: unknown;
      await new Promise<void>((resolveServer) => {
        if (!server.listening) {
          resolveServer();
          return;
        }
        server.close((error) => {
          if (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ERR_SERVER_NOT_RUNNING") serverCloseError = error;
          }
          resolveServer();
        });
      });
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));

      // Restore any parked foreign/replacement leaf so server.close cannot delete it by path name.
      if (parkedPath !== undefined) {
        try {
          if (!existsSync(socketPath)) renameSync(parkedPath, socketPath);
          else unlinkSync(parkedPath);
        } catch {
          // Prefer leaving the parked object over deleting a possibly-foreign leaf.
        }
        parkedPath = undefined;
      }

      if (serverCloseError !== undefined) {
        uncertain(
          "server-close-failed",
          serverCloseError instanceof Error ? serverCloseError.message : "parent egress server failed to close",
          disposition === "foreign" || existsSync(socketPath),
          serverCloseError
        );
      }

      if (disposition === "missing") {
        uncertain("socket-missing", "Grok egress socket was already absent; exact removal cannot be proven", false);
      }
      if (disposition === "foreign") {
        uncertain(
          foreignKind,
          "Grok egress path no longer names the pinned parent Unix socket; preserving the replacement",
          true
        );
      }

      // disposition === "ours": server.close should have unlinked our exact listen path. If a leaf
      // remains, re-check identity immediately and only unlink the pinned object.
      let socketRemoved = false;
      try {
        const remaining = lstatSync(socketPath);
        if (!matchesPinnedSocket(remaining)) {
          uncertain(
            remaining.isSocket() ? "socket-replaced" : "socket-foreign",
            "Grok egress path was replaced during server close; preserving the replacement",
            true
          );
        }
        unitTestUnlinkRace?.();
        let atUnlink: ReturnType<typeof lstatSync>;
        try {
          atUnlink = lstatSync(socketPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            // Disappeared after the proof without our unlink — cannot claim we removed it.
            uncertain("unlink-race", "Grok egress socket disappeared after the identity proof and before unlink", false, error);
          }
          throw error;
        }
        if (!matchesPinnedSocket(atUnlink)) {
          uncertain(
            "unlink-race",
            "Grok egress socket identity changed in the unlink race window; preserving the path",
            true
          );
        }
        unlinkSync(socketPath);
        try {
          const after = lstatSync(socketPath);
          if (matchesPinnedSocket(after)) {
            uncertain("live-tunnel", "Grok egress pinned socket remained after unlink", true);
          }
          uncertain("unlink-race", "Grok egress path was replaced immediately after exact unlink; preserving the new object", true);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          socketRemoved = true;
        }
      } catch (error) {
        if (error instanceof GrokEgressCleanupError) throw error;
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          // Path absent after close of a pre-proven "ours" listen socket: exact removal by close.
          socketRemoved = true;
        } else {
          throw error;
        }
      }

      if (!socketRemoved) {
        uncertain("socket-missing", "Grok egress socket removal was not proven", existsSync(socketPath));
      }

      closed = true;
      cleanupEvidence = Object.freeze({
        resourcesReaped: true as const,
        socketRemoved: true,
        socketPreserved: false,
        socketIdentitySha256,
        decisionLogSha256: decisionLogDigest(),
        decisionLogOverflowed,
        expired
      });
      cleanupSha256 = sha256(JSON.stringify({
        decisionLogOverflowed,
        decisionLogSha256: decisionLogDigest(),
        expired,
        socketIdentitySha256,
        socketRemoved: true
      }));
    })();
    return closing;
  };

  return Object.freeze({
    socketPath,
    policySha256: GROK_EGRESS_POLICY_SHA256,
    decisions: () => Object.freeze(decisions.map((decision) => Object.freeze({ ...decision }))),
    status: () => Object.freeze({
      closed,
      decisionLogOverflowed,
      decisionLogSha256: decisionLogDigest(),
      expired,
      socketIdentitySha256,
      ...(cleanupSha256 ? { cleanupSha256 } : {}),
      ...(cleanupEvidence ? { cleanupEvidence } : {})
    }),
    assertSocketIdentity,
    closeAndDrain
  });
}

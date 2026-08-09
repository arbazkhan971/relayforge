#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isAbsolute } from "node:path";
import { createConnection, createServer } from "node:net";
import { spawn } from "node:child_process";

const POLICY_VERSION = "relayforge.grok-egress.connect.v1";
const APPROVED_AUTHORITY = "api.x.ai:443";
const MAX_HEADER_BYTES = 8_192;
const MAX_CONNECTIONS = 8;
const MAX_DECISIONS = 64;
const IO_TIMEOUT_MS = 5_000;
const MAX_LIFETIME_MS = 10 * 60_000;

function fail(message) {
  process.stderr.write(`relayforge Grok egress relay: ${message}\n`);
  process.exitCode = 64;
  throw new Error(message);
}

function parsePort(value, name) {
  if (!/^[0-9]{1,5}$/u.test(value ?? "")) fail(`${name} must be a decimal TCP port`);
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) fail(`${name} is outside the closed port range`);
  return port;
}

function parseArgs(argv) {
  const mode = argv.shift();
  if (mode !== "probe" && mode !== "exec") fail("mode must be probe or exec");
  const take = (name) => {
    if (argv.shift() !== name || argv.length === 0) fail(`missing ${name}`);
    return argv.shift();
  };
  const socketPath = take("--socket");
  if (!isAbsolute(socketPath) || socketPath.includes("\0") || Buffer.byteLength(socketPath, "utf8") > 4_096) {
    fail("--socket must be a bounded absolute path");
  }
  const relayPort = parsePort(take("--relay-port"), "--relay-port");
  let hostSentinelPort;
  if (mode === "probe") hostSentinelPort = parsePort(take("--host-sentinel-port"), "--host-sentinel-port");
  if (mode === "exec" && argv.shift() !== "--") fail("exec mode requires -- before the exact provider argv");
  if (mode === "probe" && argv.length !== 0) fail("probe mode has unexpected arguments");
  if (mode === "exec" && argv.length === 0) fail("exec mode requires an exact provider executable");
  if (mode === "exec" && (!isAbsolute(argv[0]) || argv.some((value) => value.includes("\0") || Buffer.byteLength(value, "utf8") > 64 * 1_024))) {
    fail("provider argv must be absolute, bounded and NUL-free");
  }
  return Object.freeze({ mode, socketPath, relayPort, hostSentinelPort, providerArgv: Object.freeze([...argv]) });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

const POLICY_SHA256 = sha256(JSON.stringify({
  allowedAuthorities: [APPROVED_AUTHORITY],
  allowedHeaders: ["host", "proxy-connection", "user-agent"],
  maxConnections: MAX_CONNECTIONS,
  maxDecisions: MAX_DECISIONS,
  maxHeaderBytes: MAX_HEADER_BYTES,
  maxLifetimeMs: MAX_LIFETIME_MS,
  upstreamAddressPolicy: "global-unicast-v1",
  version: POLICY_VERSION
}));

function startRelay(socketPath, relayPort) {
  const sockets = new Set();
  let active = 0;
  let accepted = 0;
  let overflowed = false;
  let expired = false;
  let closing;
  let closeAndDrain;
  const server = createServer((client) => {
    sockets.add(client);
    client.once("close", () => sockets.delete(client));
    if (accepted >= MAX_DECISIONS) {
      overflowed = true;
      client.destroy();
      queueMicrotask(() => { void closeAndDrain().catch(() => undefined); });
      return;
    }
    accepted += 1;
    if (active >= MAX_CONNECTIONS) {
      client.destroy();
      return;
    }
    active += 1;
    client.once("close", () => { active -= 1; });
    const parent = createConnection(socketPath);
    sockets.add(parent);
    parent.once("close", () => sockets.delete(parent));
    client.setTimeout(IO_TIMEOUT_MS, () => client.destroy());
    parent.setTimeout(IO_TIMEOUT_MS, () => parent.destroy());
    client.once("error", () => parent.destroy());
    parent.once("error", () => client.destroy());
    client.pipe(parent);
    parent.pipe(client);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(relayPort, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const lifetime = setTimeout(() => {
        expired = true;
        void closeAndDrain().catch(() => undefined);
      }, MAX_LIFETIME_MS);
      lifetime.unref();
      closeAndDrain = () => {
        if (closing) return closing;
        clearTimeout(lifetime);
        closing = new Promise((resolveClose, rejectClose) => {
          for (const socket of sockets) socket.destroy();
          if (!server.listening) {
            resolveClose();
            return;
          }
          server.close((error) => error ? rejectClose(error) : resolveClose());
        });
        return closing;
      };
      resolve(Object.freeze({
        status: () => Object.freeze({ accepted, overflowed, expired }),
        closeAndDrain
      }));
    });
  });
}

function boundedConnectResponse(connect) {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      connect.destroy();
      reject(new Error("CONNECT response timed out"));
    }, IO_TIMEOUT_MS);
    connect.on("data", (chunk) => {
      if (bytes.length + chunk.length > MAX_HEADER_BYTES) {
        clearTimeout(timeout);
        connect.destroy();
        reject(new Error("CONNECT response exceeded bound"));
        return;
      }
      bytes = Buffer.concat([bytes, chunk]);
      const boundary = bytes.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      clearTimeout(timeout);
      connect.removeAllListeners("data");
      resolve(bytes.subarray(0, boundary + 4).toString("ascii"));
    });
    connect.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function connectRequest(destination, authority) {
  const socket = createConnection(destination);
  try {
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`, "ascii");
    return await boundedConnectResponse(socket);
  } finally {
    socket.destroy();
  }
}

function assertNetworkConnectDenied(host, port, allowedCodes) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`direct connection to ${host} timed out instead of failing closed`));
    }, 750);
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.destroy();
      reject(new Error(`unexpected direct connection to ${host}`));
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      if (!allowedCodes.includes(error.code)) {
        reject(error);
        return;
      }
      resolve(error.code);
    });
  });
}

async function runProbe(options) {
  const results = {};
  const check = async (name, action) => {
    const observation = await action();
    if (typeof observation !== "string" || observation.length === 0 || observation.length > 128) {
      throw new Error(`invalid bounded observation for ${name}`);
    }
    results[name] = Object.freeze({ passed: true, observation, evidenceSha256: sha256(`${POLICY_VERSION}:${name}:${observation}`) });
  };
  await check("approvedConnect", async () => {
    const response = await connectRequest({ host: "127.0.0.1", port: options.relayPort }, APPROVED_AUTHORITY);
    if (!response.startsWith("HTTP/1.1 200 ")) throw new Error("approved CONNECT was not admitted");
    return "http-200";
  });
  await check("canaryDenied", async () => {
    const response = await connectRequest({ host: "127.0.0.1", port: options.relayPort }, "telemetry.grok.com:443");
    if (!response.startsWith("HTTP/1.1 403 ")) throw new Error("canary CONNECT was not denied");
    return "http-403";
  });
  await check("directIpv4Denied", () => assertNetworkConnectDenied("1.1.1.1", 443, ["ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL"]));
  await check("directIpv6Denied", () => assertNetworkConnectDenied("2606:4700:4700::1111", 443, ["ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL"]));
  await check("dnsDenied", async () => {
    try {
      await lookup("example.com");
    } catch (error) {
      if (!["EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"].includes(error?.code)) throw error;
      return error.code;
    }
    throw new Error("external DNS unexpectedly resolved inside the Grok network jail");
  });
  await check("hostLoopbackDenied", () => assertNetworkConnectDenied("127.0.0.1", options.hostSentinelPort, ["ECONNREFUSED", "EADDRNOTAVAIL"]));
  await check("unixCanaryDenied", async () => {
    const response = await connectRequest(options.socketPath, "trace-upload.grok.com:443");
    if (!response.startsWith("HTTP/1.1 403 ")) throw new Error("direct Unix-socket canary was not denied");
    return "http-403";
  });
  const payload = Object.freeze({ schemaVersion: 1, policyVersion: POLICY_VERSION, policySha256: POLICY_SHA256, checks: Object.freeze(results) });
  const receiptDigest = sha256(canonicalJson(payload));
  process.stdout.write(`${JSON.stringify({ ...payload, receiptDigest })}\n`);
}

async function runProvider(options) {
  const [command, ...args] = options.providerArgv;
  const proxy = `http://127.0.0.1:${options.relayPort}`;
  const environment = {
    ...process.env,
    ALL_PROXY: proxy,
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    NO_PROXY: "",
    all_proxy: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    no_proxy: ""
  };
  const child = spawn(command, args, { env: environment, shell: false, stdio: "inherit", windowsHide: true });
  const forward = (signal) => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const onSigint = () => forward("SIGINT");
  const onSigterm = () => forward("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
  process.exitCode = result.signal ? 1 : result.code ?? 1;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let relay;
  try {
    relay = await startRelay(options.socketPath, options.relayPort);
    if (options.mode === "probe") await runProbe(options);
    else await runProvider(options);
    const status = relay.status();
    if (status.overflowed || status.expired) fail("relay connection or lifetime bound was exceeded");
  } finally {
    await relay?.closeAndDrain();
  }
}

try {
  await main();
} catch {
  // The helper never writes provider/runtime exception data. Its bounded diagnostic is emitted
  // only by fail(); every other error is represented by this closed exit status.
  if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = 64;
}

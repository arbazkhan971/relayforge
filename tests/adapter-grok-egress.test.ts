import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  GROK_EGRESS_ALLOWED_AUTHORITY,
  GROK_EGRESS_MAX_DECISIONS,
  GROK_EGRESS_POLICY_SHA256,
  GrokEgressCleanupError,
  createGrokEgressProxy,
  grokEgressTestDialActive,
  isPublicGrokUpstreamAddress,
  parseGrokEgressConnectRequest,
  setGrokEgressTestDialForUnitTests,
  setGrokEgressUnlinkRaceForUnitTests
} from "../src/adapters/grok-egress.js";
import {
  buildGrokEgressProbeCommand,
  grokEgressProbeCheckNames,
  grokEgressRelayPath,
  parseGrokEgressProbeReport
} from "../src/adapters/grok-egress-probe.js";
import {
  containCommand,
  netnsSupported,
  pinSandboxSocket
} from "../src/sandbox.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  setGrokEgressTestDialForUnitTests(undefined);
  setGrokEgressUnlinkRaceForUnitTests(undefined);
  for (const server of servers.splice(0)) await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function privateRoot(prefix = "relayforge-grok-egress-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function listenTcp(handler?: (socket: Socket) => void): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  servers.push(server);
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("fixture TCP address"));
      resolveListen({ server, port: address.port });
    });
  });
}

function connectTcp(port: number): Promise<Socket> {
  return new Promise((resolveConnect, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => resolveConnect(socket));
    socket.once("error", reject);
  });
}

function request(socketPath: string, authority: string, extraHeaders = ""): Promise<string> {
  return new Promise((resolveResponse, reject) => {
    const socket = createConnection(socketPath);
    let response = "";
    socket.once("connect", () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${extraHeaders}\r\n`, "ascii"));
    socket.on("data", (chunk) => {
      response += chunk.toString("ascii");
      if (response.includes("\r\n\r\n")) {
        socket.destroy();
        resolveResponse(response);
      }
    });
    socket.once("error", reject);
  });
}

describe("Grok exact CONNECT parser", () => {
  it("admits only the canonical authority and bounded inert headers", () => {
    const parsed = parseGrokEgressConnectRequest(Buffer.from(
      `CONNECT ${GROK_EGRESS_ALLOWED_AUTHORITY} HTTP/1.1\r\nHost: ${GROK_EGRESS_ALLOWED_AUTHORITY}\r\nUser-Agent: fixture\r\n\r\nTLS`,
      "ascii"
    ));
    expect(parsed.decision).toBe("allow");
    expect(parsed.tunnelPrefix.toString("ascii")).toBe("TLS");

    for (const requestLine of [
      "GET https://api.x.ai/v1 HTTP/1.1",
      "CONNECT API.X.AI:443 HTTP/1.1",
      "CONNECT api.x.ai:80 HTTP/1.1",
      "CONNECT 1.1.1.1:443 HTTP/1.1",
      "CONNECT api.x.ai:443 HTTP/1.0"
    ]) {
      expect(parseGrokEgressConnectRequest(Buffer.from(`${requestLine}\r\nHost: api.x.ai:443\r\n\r\n`)).decision).toBe("deny");
    }
  });

  it("rejects ambiguous, authenticated, duplicate, malformed, and over-bound prefaces", () => {
    const denied = [
      `CONNECT api.x.ai:443 HTTP/1.1\r\nHost: api.x.ai:443\r\nProxy-Authorization: Basic abc\r\n\r\n`,
      `CONNECT api.x.ai:443 HTTP/1.1\r\nHost: api.x.ai:443\r\nHost: api.x.ai:443\r\n\r\n`,
      `CONNECT api.x.ai:443 HTTP/1.1\r\nHost: api.x.ai:443\r\n folded\r\n\r\n`,
      `CONNECT api.x.ai:443 HTTP/1.1\nHost: api.x.ai:443\n\n`,
      `CONNECT api.x.ai:443 HTTP/1.1\r\n\r\n`
    ];
    for (const value of denied) expect(parseGrokEgressConnectRequest(Buffer.from(value)).decision).toBe("deny");
    expect(parseGrokEgressConnectRequest(Buffer.alloc(8_193, 0x41)).decision).toBe("deny");
  });
});

describe("Grok upstream address admission", () => {
  it.each([
    "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.1.1", "172.31.255.255",
    "192.0.0.9", "192.0.2.1", "192.31.196.1", "192.52.193.1", "192.88.99.1", "192.168.1.1",
    "192.175.48.1", "198.18.0.1", "198.51.100.1",
    "203.0.113.1", "224.0.0.1", "255.255.255.255", "::", "::1", "::ffff:127.0.0.1",
    "::ffff:7f00:1", "::127.0.0.1", "64:ff9b::7f00:1", "100::1", "2001::1", "2001:1::1", "2001:2::1",
    "2001:10::1", "2001:20::1", "2001:db8::1", "2002::1", "3fff::1", "fc00::1", "fe80::1", "ff00::1"
  ])("rejects non-global or translation address %s", (address) => {
    expect(isPublicGrokUpstreamAddress(address)).toBe(false);
  });

  it.each(["1.1.1.1", "8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888"])(
    "admits globally routable address %s",
    (address) => expect(isPublicGrokUpstreamAddress(address)).toBe(true)
  );
});

describe("parent-owned Grok egress proxy", () => {
  it("enforces the exact authority, pins its socket, bounds decisions, and drains idempotently", async () => {
    const root = privateRoot();
    const upstream = await listenTcp((socket) => socket.on("error", () => undefined));
    setGrokEgressTestDialForUnitTests(() => connectTcp(upstream.port));
    expect(grokEgressTestDialActive()).toBe(true);
    const proxy = await createGrokEgressProxy(root);
    const identity = pinSandboxSocket(proxy.socketPath);
    expect(identity.mode).toBe(0o600);
    expect(proxy.policySha256).toBe(GROK_EGRESS_POLICY_SHA256);
    expect(await request(proxy.socketPath, "telemetry.grok.com:443")).toMatch(/^HTTP\/1\.1 403 /u);
    expect(await request(proxy.socketPath, GROK_EGRESS_ALLOWED_AUTHORITY)).toMatch(/^HTTP\/1\.1 200 /u);
    proxy.assertSocketIdentity();
    expect(proxy.decisions().map(({ decision, reason }) => ({ decision, reason }))).toEqual([
      { decision: "denied", reason: "authority-denied" },
      { decision: "allowed", reason: "approved-connect" }
    ]);
    expect(proxy.status()).toMatchObject({ decisionLogOverflowed: false, expired: false });
    await proxy.closeAndDrain();
    await proxy.closeAndDrain();
    expect(existsSync(proxy.socketPath)).toBe(false);
    expect(proxy.status()).toMatchObject({
      closed: true,
      decisionLogOverflowed: false,
      expired: false,
      cleanupSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      decisionLogSha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
  });

  it("stops admission and invalidates evidence at the total decision cap", async () => {
    const root = privateRoot();
    const proxy = await createGrokEgressProxy(root);
    for (let index = 0; index < GROK_EGRESS_MAX_DECISIONS; index += 1) {
      expect(await request(proxy.socketPath, `denied-${index}.invalid:443`)).toMatch(/^HTTP\/1\.1 403 /u);
    }
    expect(proxy.decisions()).toHaveLength(GROK_EGRESS_MAX_DECISIONS);
    await request(proxy.socketPath, "overflow.invalid:443").catch(() => "closed");
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    expect(proxy.status().decisionLogOverflowed).toBe(true);
    expect(proxy.decisions()).toHaveLength(GROK_EGRESS_MAX_DECISIONS);
    await proxy.closeAndDrain();
  });

  it("runs every active allow and bypass probe through the minimal-root bwrap jail, or reports the real primitive unavailable", async () => {
    if (!netnsSupported()) {
      expect(netnsSupported()).toBe(false);
      return;
    }
    const root = privateRoot("relayforge-grok-egress-real-");
    const workspace = join(root, "workspace");
    const socketDirectory = join(root, "socket");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(workspace, { mode: 0o700 });
    mkdirSync(socketDirectory, { mode: 0o700 });
    const upstream = await listenTcp((socket) => socket.on("error", () => undefined));
    const sentinel = await listenTcp((socket) => socket.end("host-visible"));
    setGrokEgressTestDialForUnitTests(() => connectTcp(upstream.port));
    const proxy = await createGrokEgressProxy(socketDirectory);
    const socketIdentity = pinSandboxSocket(proxy.socketPath);
    const relay = grokEgressRelayPath();
    const probe = buildGrokEgressProbeCommand({ socketPath: proxy.socketPath, hostSentinelPort: sentinel.port });
    const contained = containCommand(probe.command, [...probe.args], {
      writableRoot: workspace,
      cwd: workspace,
      network: false,
      filesystem: {
        mode: "allowlist",
        readableRoots: [relay],
        runtimeRoots: [process.execPath, relay],
        socketRoots: [socketIdentity],
        inaccessibleRoots: []
      }
    });
    expect(contained.kind).toBe("wrapped");
    if (contained.kind !== "wrapped") throw new Error("real Grok egress probe cannot use the trusted-runner seam");
    proxy.assertSocketIdentity();
    const { stdout, stderr } = await execFileAsync(contained.command, contained.args, {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      maxBuffer: 32 * 1_024,
      timeout: 20_000
    });
    expect(stderr).toBe("");
    const report = parseGrokEgressProbeReport(stdout);
    expect(report.schemaVersion).toBe(1);
    expect(Object.keys(report.checks).sort()).toEqual([...grokEgressProbeCheckNames].sort());
    expect(Object.values(report.checks).every((check) => check.passed && /^[a-f0-9]{64}$/u.test(check.evidenceSha256))).toBe(true);
    expect(report.policySha256).toBe(GROK_EGRESS_POLICY_SHA256);
    expect(proxy.decisions().filter(({ decision }) => decision === "allowed")).toHaveLength(1);
    expect(proxy.decisions().filter(({ decision }) => decision === "denied")).toHaveLength(2);
    expect(proxy.status()).toMatchObject({ decisionLogOverflowed: false, expired: false });
    proxy.assertSocketIdentity();

    // Production topology: the socket parent is not a writable/readable provider root. The child can
    // use the exact mounted AF_UNIX capability but cannot enumerate, unlink, or replace its authority.
    const topologyScript = [
      "const fs=require('node:fs'),net=require('node:net'),path=require('node:path');",
      "const out={};",
      "for(const [name,fn] of [['list',()=>fs.readdirSync(path.dirname(process.argv[1]))],['unlink',()=>fs.unlinkSync(process.argv[1])]]){try{fn();out[name]='unexpected'}catch(e){out[name]=e.code}}",
      "const s=net.connect(process.argv[1]);let data='';",
      "s.once('connect',()=>s.write('CONNECT denied.invalid:443 HTTP/1.1\\r\\nHost: denied.invalid:443\\r\\n\\r\\n'));",
      "s.on('data',c=>{data+=c.toString('ascii');if(data.includes('\\r\\n\\r\\n')){out.relay=data.split(' ')[1];process.stdout.write(JSON.stringify(out));s.destroy()}});",
      "s.once('error',e=>{out.relay=e.code;process.stdout.write(JSON.stringify(out))});"
    ].join("");
    const topology = containCommand(process.execPath, ["-e", topologyScript, proxy.socketPath], {
      writableRoot: workspace,
      cwd: workspace,
      network: false,
      filesystem: {
        mode: "allowlist",
        runtimeRoots: [process.execPath],
        socketRoots: [socketIdentity],
        inaccessibleRoots: []
      }
    });
    if (topology.kind !== "wrapped") throw new Error("real Grok topology probe cannot use the trusted-runner seam");
    const topologyResult = await execFileAsync(topology.command, topology.args, {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      maxBuffer: 8 * 1_024,
      timeout: 10_000
    });
    expect(JSON.parse(topologyResult.stdout)).toEqual({ list: "EACCES", unlink: "EACCES", relay: "403" });
    proxy.assertSocketIdentity();
    await proxy.closeAndDrain();
    expect(existsSync(proxy.socketPath)).toBe(false);
    expect(proxy.status()).toMatchObject({ closed: true, cleanupSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
  }, 30_000);

  it("makes the in-jail relay fail closed on total connection cap plus one", async () => {
    const root = privateRoot("relayforge-grok-relay-cap-");
    const socketPath = join(root, "parent.sock");
    const parent = createServer((socket) => socket.destroy());
    servers.push(parent);
    await new Promise<void>((resolveListen, rejectListen) => {
      parent.once("error", rejectListen);
      parent.listen(socketPath, () => resolveListen());
    });
    chmodSync(socketPath, 0o600);
    const portFixture = await listenTcp();
    const port = portFixture.port;
    await new Promise<void>((resolveClose) => portFixture.server.close(() => resolveClose()));
    const connectionScript = `
      const { createConnection } = require("node:net");
      const port = ${port};
      const once = () => new Promise((resolve) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        const timer = setTimeout(() => { socket.destroy(); resolve(); }, 1000);
        const done = () => { clearTimeout(timer); socket.destroy(); resolve(); };
        socket.once("connect", () => setTimeout(done, 2));
        socket.once("error", done);
      });
      (async () => { for (let index = 0; index < ${GROK_EGRESS_MAX_DECISIONS + 1}; index += 1) await once(); })();
    `;
    await expect(execFileAsync(process.execPath, [
      grokEgressRelayPath(),
      "exec",
      "--socket", socketPath,
      "--relay-port", String(port),
      "--",
      process.execPath,
      "-e",
      connectionScript
    ], { encoding: "utf8", timeout: 20_000 })).rejects.toMatchObject({ code: 64 });
  }, 30_000);

  it("rejects malformed or over-bound active-probe reports", () => {
    expect(() => parseGrokEgressProbeReport("{}" )).toThrow(/exactly/u);
    expect(() => parseGrokEgressProbeReport("x".repeat(32 * 1_024 + 1))).toThrow(/over bound/u);
  });
});

describe("replacement-safe attempt-all Grok cleanup", () => {
  it("proves exact success: removes only the pinned socket, sets cleanupSha256, and is idempotent", async () => {
    const root = privateRoot("relayforge-grok-cleanup-ok-");
    const proxy = await createGrokEgressProxy(root);
    expect(existsSync(proxy.socketPath)).toBe(true);
    await proxy.closeAndDrain();
    await proxy.closeAndDrain();
    expect(existsSync(proxy.socketPath)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
    const status = proxy.status();
    expect(status).toMatchObject({
      closed: true,
      cleanupSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      cleanupEvidence: {
        resourcesReaped: true,
        socketRemoved: true,
        socketPreserved: false
      }
    });
    expect(status.cleanupEvidence?.reason).toBeUndefined();
  });

  it("reaps resources when the socket is already missing and never claims socketRemoved", async () => {
    const root = privateRoot("relayforge-grok-cleanup-missing-");
    const proxy = await createGrokEgressProxy(root);
    unlinkSync(proxy.socketPath);
    await expect(proxy.closeAndDrain()).rejects.toBeInstanceOf(GrokEgressCleanupError);
    await expect(proxy.closeAndDrain()).rejects.toMatchObject({
      code: "GROK_EGRESS_CLEANUP_UNCERTAIN",
      evidence: expect.objectContaining({
        resourcesReaped: true,
        socketRemoved: false,
        socketPreserved: false,
        reason: "socket-missing"
      })
    });
    const status = proxy.status();
    expect(status.closed).toBe(true);
    expect(status.cleanupSha256).toBeUndefined();
    expect(status.cleanupEvidence).toMatchObject({
      resourcesReaped: true,
      socketRemoved: false,
      reason: "socket-missing"
    });
    expect(existsSync(proxy.socketPath)).toBe(false);
  });

  it("preserves a replacement regular file and refuses to claim cleanupSha256", async () => {
    const root = privateRoot("relayforge-grok-cleanup-file-");
    const proxy = await createGrokEgressProxy(root);
    unlinkSync(proxy.socketPath);
    writeFileSync(proxy.socketPath, "foreign-replacement", { mode: 0o600 });
    await expect(proxy.closeAndDrain()).rejects.toMatchObject({
      code: "GROK_EGRESS_CLEANUP_UNCERTAIN",
      evidence: expect.objectContaining({
        resourcesReaped: true,
        socketRemoved: false,
        socketPreserved: true,
        reason: "socket-foreign"
      })
    });
    expect(existsSync(proxy.socketPath)).toBe(true);
    expect(proxy.status().cleanupSha256).toBeUndefined();
    expect(proxy.status().closed).toBe(true);
  });

  it("preserves a replacement AF_UNIX socket at a different inode", async () => {
    const root = privateRoot("relayforge-grok-cleanup-repl-");
    const proxy = await createGrokEgressProxy(root);
    unlinkSync(proxy.socketPath);
    const replacement = createServer();
    servers.push(replacement);
    await new Promise<void>((resolveListen, rejectListen) => {
      replacement.once("error", rejectListen);
      replacement.listen(proxy.socketPath, () => resolveListen());
    });
    chmodSync(proxy.socketPath, 0o600);
    await expect(proxy.closeAndDrain()).rejects.toMatchObject({
      code: "GROK_EGRESS_CLEANUP_UNCERTAIN",
      evidence: expect.objectContaining({
        resourcesReaped: true,
        socketRemoved: false,
        socketPreserved: true,
        reason: "socket-replaced"
      })
    });
    expect(existsSync(proxy.socketPath)).toBe(true);
    expect(proxy.status().cleanupSha256).toBeUndefined();
    // Replacement server must still be listening on the preserved path.
    await expect(new Promise<void>((resolveConnect, rejectConnect) => {
      const socket = createConnection(proxy.socketPath);
      socket.once("connect", () => {
        socket.destroy();
        resolveConnect();
      });
      socket.once("error", rejectConnect);
    })).resolves.toBeUndefined();
  });

  it("preserves a socket replaced in the pre-unlink race seam", async () => {
    const root = privateRoot("relayforge-grok-cleanup-race-");
    const proxy = await createGrokEgressProxy(root);
    setGrokEgressUnlinkRaceForUnitTests(() => {
      unlinkSync(proxy.socketPath);
      writeFileSync(proxy.socketPath, "raced-in", { mode: 0o600 });
    });
    await expect(proxy.closeAndDrain()).rejects.toMatchObject({
      code: "GROK_EGRESS_CLEANUP_UNCERTAIN",
      evidence: expect.objectContaining({
        resourcesReaped: true,
        socketRemoved: false,
        socketPreserved: true,
        reason: "unlink-race"
      })
    });
    setGrokEgressUnlinkRaceForUnitTests(undefined);
    expect(existsSync(proxy.socketPath)).toBe(true);
    expect(proxy.status().cleanupSha256).toBeUndefined();
  });

  it("destroys active tunnels before completing drain with exact removal", async () => {
    const root = privateRoot("relayforge-grok-cleanup-tunnel-");
    const upstream = await listenTcp((socket) => {
      // Hold the upstream half open until the proxy destroys it.
      socket.on("error", () => undefined);
    });
    setGrokEgressTestDialForUnitTests(() => connectTcp(upstream.port));
    const proxy = await createGrokEgressProxy(root);
    const client = await new Promise<Socket>((resolveConnect, rejectConnect) => {
      const socket = createConnection(proxy.socketPath);
      socket.once("connect", () => resolveConnect(socket));
      socket.once("error", rejectConnect);
    });
    const established = new Promise<void>((resolveEstablished, rejectEstablished) => {
      let buffered = "";
      client.on("data", (chunk) => {
        buffered += chunk.toString("ascii");
        if (buffered.includes("\r\n\r\n")) resolveEstablished();
      });
      client.once("error", rejectEstablished);
      client.write(
        `CONNECT ${GROK_EGRESS_ALLOWED_AUTHORITY} HTTP/1.1\r\nHost: ${GROK_EGRESS_ALLOWED_AUTHORITY}\r\n\r\n`,
        "ascii"
      );
    });
    await established;
    const clientClosed = new Promise<void>((resolveClosed) => client.once("close", () => resolveClosed()));
    await proxy.closeAndDrain();
    await clientClosed;
    expect(client.destroyed).toBe(true);
    expect(existsSync(proxy.socketPath)).toBe(false);
    expect(proxy.status()).toMatchObject({
      closed: true,
      cleanupSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      cleanupEvidence: { socketRemoved: true, resourcesReaped: true }
    });
  });

  it("reaps an active tunnel even when the socket leaf was replaced", async () => {
    const root = privateRoot("relayforge-grok-cleanup-tunnel-repl-");
    const upstream = await listenTcp((socket) => socket.on("error", () => undefined));
    setGrokEgressTestDialForUnitTests(() => connectTcp(upstream.port));
    const proxy = await createGrokEgressProxy(root);
    const client = await new Promise<Socket>((resolveConnect, rejectConnect) => {
      const socket = createConnection(proxy.socketPath);
      socket.once("connect", () => resolveConnect(socket));
      socket.once("error", rejectConnect);
    });
    await new Promise<void>((resolveEstablished, rejectEstablished) => {
      let buffered = "";
      client.on("data", (chunk) => {
        buffered += chunk.toString("ascii");
        if (buffered.includes("\r\n\r\n")) resolveEstablished();
      });
      client.once("error", rejectEstablished);
      client.write(
        `CONNECT ${GROK_EGRESS_ALLOWED_AUTHORITY} HTTP/1.1\r\nHost: ${GROK_EGRESS_ALLOWED_AUTHORITY}\r\n\r\n`,
        "ascii"
      );
    });
    const clientClosed = new Promise<void>((resolveClosed) => client.once("close", () => resolveClosed()));
    unlinkSync(proxy.socketPath);
    writeFileSync(proxy.socketPath, "foreign", { mode: 0o600 });
    await expect(proxy.closeAndDrain()).rejects.toBeInstanceOf(GrokEgressCleanupError);
    await clientClosed;
    expect(client.destroyed).toBe(true);
    expect(existsSync(proxy.socketPath)).toBe(true);
    expect(proxy.status().closed).toBe(true);
    expect(proxy.status().cleanupSha256).toBeUndefined();
  });
});

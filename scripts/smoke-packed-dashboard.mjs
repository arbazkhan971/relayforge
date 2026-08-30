#!/usr/bin/env node
/**
 * Release-only browser smoke for the exact npm tarball.
 *
 * This intentionally has no browser automation dependency. It installs the supplied
 * tarball into a clean prefix, drives the packed `relayforge` binary, and talks to a
 * loopback-only headless Chrome through the Chrome DevTools Protocol. The single page
 * must survive a real control-service replacement:
 *
 *   packed dashboard -> connected -> service absent/degraded -> new instance/connected
 *
 * The fixture is a deterministic dry run, so no provider or external network is used.
 */
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync
} from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const COMMAND_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 600_000;
const READY_TIMEOUT_MS = 20_000;
const DEGRADED_TIMEOUT_MS = 20_000;
const RECOVERY_TIMEOUT_MS = 30_000;
const CDP_MESSAGE_LIMIT = 8 * 1024 * 1024;
const OUTPUT_LIMIT = 128 * 1024;
const PROJECT = "demo-product";
const RUN = "browserfixture";

export class PackedDashboardSmokeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PackedDashboardSmokeError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PackedDashboardSmokeError(code, message);
}

export function parseArguments(args) {
  if (args.length !== 2 || args[0] !== "--tarball" || !args[1]) {
    fail("INVALID_ARGUMENT", "usage: smoke-packed-dashboard.mjs --tarball <exact-package.tgz>");
  }
  const tarball = resolve(args[1]);
  const entry = lstatSync(tarball);
  if (!entry.isFile() || entry.isSymbolicLink()) fail("INVALID_TARBALL", "tarball must be a regular non-symlink file");
  return Object.freeze({ tarball: realpathSync(tarball) });
}

function childEnv(base = process.env) {
  // Isolate from CI/agent FORCE_COLOR so command/CDP diagnostics stay plain and bounded.
  const env = { ...base, NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  return env;
}

function commandResult(command, args, cwd, timeout = COMMAND_TIMEOUT_MS) {
  const result = spawnSync(command, args, {
    cwd,
    env: childEnv(),
    encoding: "utf8",
    timeout,
    windowsHide: true
  });
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  if (stdout.length + stderr.length > OUTPUT_LIMIT) fail("COMMAND_OUTPUT_EXCEEDED", `${basename(command)} emitted excessive output`);
  if (result.error) fail("COMMAND_FAILED", `${basename(command)} failed to start: ${result.error.message}`);
  return Object.freeze({ status: result.status, signal: result.signal, stdout, stderr });
}

function assertCommand(result, label) {
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").slice(0, 4_000);
    fail("COMMAND_FAILED", `${label} exited ${String(result.status)}${result.signal ? ` (${result.signal})` : ""}: ${detail}`);
  }
  return result;
}

function parseJsonCommand(result, label) {
  assertCommand(result, label);
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail("COMMAND_PROTOCOL", `${label} did not return JSON: ${result.stdout.slice(0, 2_000)}`);
  }
}

async function freePort() {
  return await new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("ephemeral listener has no TCP address"));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolvePromise(port));
    });
  });
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function eventually(label, inspect, timeoutMs, intervalMs = 125) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  let latestError;
  while (Date.now() < deadline) {
    try {
      latest = await inspect();
      if (latest?.ok) return latest.value;
    } catch (error) {
      latestError = error;
    }
    await delay(intervalMs);
  }
  const detail = latestError instanceof Error ? latestError.message : JSON.stringify(latest);
  fail("TIMEOUT", `${label} did not converge within ${timeoutMs}ms${detail ? `: ${detail}` : ""}`);
}

function boundedOutput(child, label) {
  let stdout = "";
  let stderr = "";
  const append = (prior, chunk) => {
    const next = prior + String(chunk);
    if (next.length > OUTPUT_LIMIT) {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
      return next.slice(0, OUTPUT_LIMIT);
    }
    return next;
  };
  child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
  child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
  const exit = new Promise((resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })));
  child.once("error", (error) => { stderr = append(stderr, `${label} spawn error: ${error.message}`); });
  return Object.freeze({ exit, stdout: () => stdout, stderr: () => stderr });
}

function childExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function terminateOwnedGroup(child, output, label) {
  if (!child?.pid || childExited(child)) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  const ended = await Promise.race([output.exit.then(() => true), delay(3_000).then(() => false)]);
  if (!ended && !childExited(child)) {
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    await Promise.race([output.exit, delay(3_000)]);
  }
  if (!childExited(child)) fail("PROCESS_LEAK", `${label} process group did not terminate`);
}

async function fetchJson(url, timeoutMs = 2_000) {
  const response = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  const type = response.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/iu.test(type)) throw new Error(`unexpected content type ${type}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("JSON response exceeds smoke bound");
  return JSON.parse(text);
}

function packedExecutable(prefix) {
  const executable = resolve(prefix, "node_modules", ".bin", process.platform === "win32" ? "relayforge.cmd" : "relayforge");
  if (!existsSync(executable)) fail("PACKED_BINARY_MISSING", "the installed tarball has no relayforge binary");
  return executable;
}

function prepareProject(executable, project) {
  assertCommand(commandResult("git", ["init", "-q"], project), "git init");
  assertCommand(commandResult("git", ["config", "user.name", "RelayForge Browser Smoke"], project), "git user.name");
  assertCommand(commandResult("git", ["config", "user.email", "browser-smoke@example.invalid"], project), "git user.email");
  assertCommand(commandResult("git", ["config", "commit.gpgsign", "false"], project), "git commit policy");
  assertCommand(commandResult(executable, ["init", "--provider", "custom"], project), "packed relayforge init");
  assertCommand(commandResult("git", ["add", "-A"], project), "git add fixture");
  assertCommand(commandResult("git", ["commit", "-qm", "browser smoke baseline"], project), "git commit fixture");
  const dry = parseJsonCommand(
    commandResult(executable, ["run", "Browser fixture", "--run", RUN, "--json"], project),
    "packed deterministic dry run"
  );
  if (dry.status !== "planned" || dry.run !== RUN || dry.project !== PROJECT || dry.execute !== false) {
    fail("FIXTURE_INVALID", `packed dry-run fixture diverged: ${JSON.stringify(dry)}`);
  }
}

function startService(executable, project, port) {
  const child = spawn(executable, ["serve", "--project", PROJECT, "--port", String(port)], {
    cwd: project,
    env: childEnv(),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  return Object.freeze({ child, output: boundedOutput(child, "packed control service") });
}

async function waitForService(port) {
  return await eventually("packed control service readiness", async () => {
    const value = await fetchJson(`http://127.0.0.1:${port}/api/v1/status`);
    const project = value?.projects?.find?.((candidate) => candidate?.project === PROJECT);
    return {
      ok: value?.schemaVersion === 1 && value?.service === "relayforge-control" && value?.status === "ok" && project?.latestRun?.run === RUN,
      value
    };
  }, READY_TIMEOUT_MS);
}

async function waitForServiceGone(port) {
  return await eventually("packed control service absence", async () => {
    try {
      await fetchJson(`http://127.0.0.1:${port}/api/v1/status`, 500);
      return { ok: false, value: "still-serving" };
    } catch {
      return { ok: true, value: true };
    }
  }, READY_TIMEOUT_MS);
}

/**
 * Force real service loss while the browser page remains open.
 *
 * Graceful `serve stop` can hang under live SSE clients (dashboard EventSource), so the release
 * browser proof removes the process group the same way a host failure would. A best-effort
 * graceful stop is still attempted first and its identity is checked when it succeeds.
 */
async function stopService(executable, project, service, port) {
  if (!service || childExited(service.child)) {
    if (port !== undefined) await waitForServiceGone(port);
    return;
  }
  const ownedPid = service.child.pid;
  let graceful;
  try {
    graceful = parseJsonCommand(
      commandResult(executable, ["serve", "stop", "--json", "--timeout", "3000"], project, 8_000),
      "packed control-service stop"
    );
  } catch {
    graceful = undefined;
  }
  if (graceful?.stopped === true) {
    if (graceful.pid !== ownedPid) {
      fail("SERVICE_IDENTITY_MISMATCH", `stop acknowledged a different service: ${JSON.stringify(graceful)}`);
    }
  } else if (!childExited(service.child)) {
    await terminateOwnedGroup(service.child, service.output, "packed control service");
  }
  const exit = await Promise.race([service.output.exit, delay(10_000).then(() => null)]);
  if (exit === null && !childExited(service.child)) {
    await terminateOwnedGroup(service.child, service.output, "packed control service (forced)");
  }
  if (!childExited(service.child)) fail("SERVICE_LEAK", "packed control service did not exit after service-loss teardown");
  if (port !== undefined) await waitForServiceGone(port);
}

export function findChrome(environment = process.env, candidatePaths) {
  const configured = environment.RELAYFORGE_CHROME_PATH;
  const defaults = [configured, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  const candidates = (Array.isArray(candidatePaths) ? candidatePaths : defaults)
    .filter((candidate) => typeof candidate === "string" && candidate.length > 0)
    .map((candidate) => resolve(candidate));
  for (const candidate of candidates) {
    try {
      const entry = lstatSync(candidate);
      if ((!entry.isFile() && !entry.isSymbolicLink()) || (entry.mode & 0o111) === 0) continue;
      const result = commandResult(candidate, ["--version"], process.cwd(), 10_000);
      if (result.status === 0 && /(?:Google Chrome|Chromium)\s+\d+/u.test(result.stdout)) {
        return Object.freeze({ path: realpathSync(candidate), version: result.stdout.trim() });
      }
    } catch {}
  }
  fail("CHROME_UNAVAILABLE", "release runner has no executable Google Chrome or Chromium; browser proof cannot be skipped");
}

function startChrome(chrome, profile, debugPort) {
  const args = [
    "--headless=new",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--disable-gpu",
    "--disable-sync",
    "--metrics-recording-only",
    "--no-default-browser-check",
    "--no-first-run",
    `--remote-debugging-address=127.0.0.1`,
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    "about:blank"
  ];
  if (typeof process.getuid === "function" && process.getuid() === 0) args.unshift("--no-sandbox");
  const child = spawn(chrome.path, args, {
    cwd: profile,
    env: childEnv(),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  return Object.freeze({ child, output: boundedOutput(child, "headless Chrome") });
}

async function chromePageTarget(debugPort) {
  return await eventually("Chrome DevTools target", async () => {
    const targets = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`);
    const page = Array.isArray(targets) ? targets.find((target) => target?.type === "page" && typeof target?.webSocketDebuggerUrl === "string") : undefined;
    return { ok: Boolean(page), value: page };
  }, READY_TIMEOUT_MS);
}

export function encodeWebSocketFrame(text, mask = randomBytes(4)) {
  const payload = Buffer.from(text, "utf8");
  if (payload.length > CDP_MESSAGE_LIMIT) fail("CDP_MESSAGE_TOO_LARGE", "outbound CDP message exceeds its bound");
  const extended = payload.length < 126 ? 0 : payload.length <= 0xffff ? 2 : 8;
  const header = Buffer.alloc(2 + extended + 4);
  header[0] = 0x81;
  if (extended === 0) header[1] = 0x80 | payload.length;
  else if (extended === 2) { header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
  else { header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
  mask.copy(header, 2 + extended);
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) masked[index] = payload[index] ^ mask[index % 4];
  return Buffer.concat([header, masked]);
}

function encodeControlFrame(opcode, payload = Buffer.alloc(0)) {
  const mask = randomBytes(4);
  if (payload.length > 125) fail("CDP_PROTOCOL", "WebSocket control frame exceeds 125 bytes");
  const header = Buffer.from([0x80 | opcode, 0x80 | payload.length, ...mask]);
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) masked[index] = payload[index] ^ mask[index % 4];
  return Buffer.concat([header, masked]);
}

class CdpConnection {
  constructor(socket, initial = Buffer.alloc(0)) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = null;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    socket.on("data", (chunk) => this.consume(chunk));
    socket.on("error", (error) => this.close(error));
    socket.on("close", () => this.close(new Error("CDP WebSocket closed")));
    if (initial.length > 0) this.consume(initial);
  }

  consume(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > CDP_MESSAGE_LIMIT * 2) return this.close(new Error("CDP receive buffer exceeded"));
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (masked) return this.close(new Error("CDP server sent a masked frame"));
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const long = this.buffer.readBigUInt64BE(2);
        if (long > BigInt(CDP_MESSAGE_LIMIT)) return this.close(new Error("CDP frame exceeds its bound"));
        length = Number(long);
        offset = 10;
      }
      if (length > CDP_MESSAGE_LIMIT) return this.close(new Error("CDP frame exceeds its bound"));
      if (this.buffer.length < offset + length) return;
      const payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (opcode === 0x8) { this.socket.write(encodeControlFrame(0x8)); return this.close(new Error("CDP peer closed")); }
      if (opcode === 0x9) { this.socket.write(encodeControlFrame(0xA, payload)); continue; }
      if (opcode === 0xA) continue;
      if (opcode !== 0x0 && opcode !== 0x1) return this.close(new Error(`unsupported CDP WebSocket opcode ${opcode}`));
      if (opcode === 0x1) {
        if (this.fragmentOpcode !== null) return this.close(new Error("nested CDP fragmented message"));
        this.fragmentOpcode = opcode;
      } else if (this.fragmentOpcode === null) return this.close(new Error("orphan CDP continuation frame"));
      this.fragments.push(Buffer.from(payload));
      if (this.fragments.reduce((sum, part) => sum + part.length, 0) > CDP_MESSAGE_LIMIT) return this.close(new Error("fragmented CDP message exceeds its bound"));
      if (!fin) continue;
      const message = Buffer.concat(this.fragments).toString("utf8");
      this.fragments = [];
      this.fragmentOpcode = null;
      this.message(message);
    }
  }

  message(text) {
    let value;
    try { value = JSON.parse(text); } catch { return this.close(new Error("CDP sent invalid JSON")); }
    if (!Number.isSafeInteger(value?.id)) return;
    const pending = this.pending.get(value.id);
    if (!pending) return;
    this.pending.delete(value.id);
    clearTimeout(pending.timer);
    if (value.error) pending.reject(new Error(`CDP ${pending.method}: ${value.error.message ?? "unknown error"}`));
    else pending.resolve(value.result ?? {});
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("CDP WebSocket is closed"));
    if (this.pending.size >= 64) return Promise.reject(new Error("too many pending CDP calls"));
    const id = this.nextId++;
    const frame = encodeWebSocketFrame(JSON.stringify({ id, method, params }));
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, 10_000);
      this.pending.set(id, { resolve: resolvePromise, reject, timer, method });
      this.socket.write(frame, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  close(error = new Error("CDP WebSocket closed")) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.socket.destroy();
  }
}

async function connectCdp(webSocketUrl) {
  const url = new URL(webSocketUrl);
  if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1") fail("CDP_ENDPOINT_INVALID", `Chrome published a non-loopback endpoint: ${webSocketUrl}`);
  const key = randomBytes(16).toString("base64");
  const expected = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  return await new Promise((resolvePromise, reject) => {
    const call = httpRequest({
      host: "127.0.0.1",
      port: Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": key,
        "sec-websocket-version": "13"
      }
    });
    call.once("upgrade", (response, socket, head) => {
      if (response.statusCode !== 101 || response.headers["sec-websocket-accept"] !== expected) {
        socket.destroy();
        reject(new Error("Chrome rejected the authenticated WebSocket upgrade"));
        return;
      }
      resolvePromise(new CdpConnection(socket, head));
    });
    call.once("response", (response) => { response.resume(); reject(new Error(`Chrome returned HTTP ${response.statusCode} instead of WebSocket upgrade`)); });
    call.once("error", reject);
    call.end();
  });
}

async function evaluate(cdp, expression) {
  const response = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: false
  });
  if (response.exceptionDetails) fail("BROWSER_JAVASCRIPT_ERROR", JSON.stringify(response.exceptionDetails).slice(0, 2_000));
  return response.result?.value;
}

const BROWSER_SNAPSHOT_EXPRESSION = `(() => {
  const controller = globalThis.__relayforgePackedSmokeController;
  const connection = document.getElementById("connection");
  return {
    readyState: document.readyState,
    title: document.title,
    project: document.body && document.body.dataset.project,
    controller: Boolean(controller),
    state: connection && connection.dataset.state,
    label: document.getElementById("livetext") && document.getElementById("livetext").textContent,
    kpiCount: document.querySelectorAll(".kpi").length,
    taskVisible: document.body && document.body.textContent.includes("Browser fixture"),
    debug: controller && controller.debug()
  };
})()`;

async function waitForBrowserState(cdp, state, timeoutMs) {
  return await eventually(`dashboard browser state ${state}`, async () => {
    const value = await evaluate(cdp, BROWSER_SNAPSHOT_EXPRESSION);
    return { ok: value?.readyState === "complete" && value?.controller === true && value?.state === state, value };
  }, timeoutMs, 200);
}

function validateConnectedSnapshot(snapshot, priorInstanceId) {
  if (snapshot.title !== `RelayForge — ${PROJECT}` || snapshot.project !== PROJECT) fail("DASHBOARD_DOM_INVALID", `dashboard identity did not render: ${JSON.stringify(snapshot)}`);
  if (!snapshot.taskVisible || snapshot.kpiCount < 1) fail("DASHBOARD_DOM_INVALID", `dashboard fixture did not render: ${JSON.stringify(snapshot)}`);
  if (snapshot.label !== "connected" || snapshot.debug?.selectedRun !== RUN || snapshot.debug?.polling !== false || snapshot.debug?.hasSource !== true) {
    fail("DASHBOARD_CLIENT_INVALID", `dashboard client is not durably connected: ${JSON.stringify(snapshot)}`);
  }
  if (priorInstanceId !== undefined && snapshot.debug?.instanceId === priorInstanceId) fail("DASHBOARD_RECOVERY_INVALID", "dashboard did not adopt the replacement service instance");
}

export async function runPackedDashboardSmoke({ tarball }) {
  if (process.platform !== "linux") fail("UNSUPPORTED_HOST", "release browser smoke requires the designated Linux artifact runner");
  const chrome = findChrome();
  const tempBase = realpathSync(process.env.RUNNER_TEMP && existsSync(process.env.RUNNER_TEMP) ? process.env.RUNNER_TEMP : tmpdir());
  const root = mkdtempSync(join(tempBase, "relayforge-packed-browser-"));
  chmodSync(root, 0o700);
  const prefix = join(root, "install");
  const project = join(root, PROJECT);
  const profile = join(root, "chrome-profile");
  for (const directory of [prefix, project, profile]) mkdirSync(directory, { mode: 0o700 });
  let firstService;
  let secondService;
  let browser;
  let cdp;
  try {
    // Consumer install must run package install scripts so native deps (better-sqlite3)
    // materialize. Skipping install scripts leaves the packed binary unloadable and is not release success.
    assertCommand(
      commandResult("npm", ["install", "--no-audit", "--no-fund", "--prefix", prefix, tarball], root, INSTALL_TIMEOUT_MS),
      "clean exact-tarball install"
    );
    const executable = packedExecutable(prefix);
    const packageDocument = JSON.parse(readFileSync(resolve(prefix, "node_modules", "relayforge", "package.json"), "utf8"));
    if (packageDocument.name !== "relayforge" || typeof packageDocument.version !== "string") fail("PACKED_IDENTITY_INVALID", "installed tarball identity is not RelayForge");
    const nativeBinding = resolve(prefix, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
    if (!existsSync(nativeBinding)) fail("NATIVE_BINDING_MISSING", "exact-tarball install did not materialize better-sqlite3 native bindings");
    prepareProject(executable, project);

    const port = await freePort();
    firstService = startService(executable, project, port);
    const firstStatus = await waitForService(port);
    const debugPort = await freePort();
    browser = startChrome(chrome, profile, debugPort);
    const target = await chromePageTarget(debugPort);
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: "globalThis.__RELAYFORGE_DASHBOARD_TEST_HOOK__ = function(controller){ globalThis.__relayforgePackedSmokeController = controller; };"
    });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
    const initial = await waitForBrowserState(cdp, "connected", READY_TIMEOUT_MS);
    validateConnectedSnapshot(initial);
    if (initial.debug?.instanceId !== firstStatus.instanceId) fail("DASHBOARD_IDENTITY_INVALID", "browser and HTTP status disagree on the first service instance");

    await stopService(executable, project, firstService, port);
    firstService = undefined;
    const degraded = await waitForBrowserState(cdp, "degraded", DEGRADED_TIMEOUT_MS);
    if (degraded.debug?.failedOpenings < 3 || degraded.debug?.polling !== true || !String(degraded.label).includes("degraded")) {
      fail("DASHBOARD_DEGRADATION_INVALID", `dashboard did not enter bounded polling fallback: ${JSON.stringify(degraded)}`);
    }

    secondService = startService(executable, project, port);
    const secondStatus = await waitForService(port);
    if (secondStatus.instanceId === firstStatus.instanceId) fail("SERVICE_REPLACEMENT_INVALID", "replacement service reused the prior instance identity");
    const recovered = await waitForBrowserState(cdp, "connected", RECOVERY_TIMEOUT_MS);
    validateConnectedSnapshot(recovered, firstStatus.instanceId);
    if (recovered.debug?.instanceId !== secondStatus.instanceId) fail("DASHBOARD_RECOVERY_INVALID", "browser did not converge on the replacement service identity");

    await stopService(executable, project, secondService, port);
    secondService = undefined;
    try { await cdp.send("Browser.close"); } catch {}
    return Object.freeze({
      schemaVersion: 1,
      packageName: packageDocument.name,
      version: packageDocument.version,
      chrome: chrome.version,
      fixtureRun: RUN,
      dom: "rendered",
      lifecycle: Object.freeze(["connected", "degraded", "recovered"]),
      serviceReplaced: true
    });
  } finally {
    cdp?.close();
    if (firstService && !childExited(firstService.child)) await terminateOwnedGroup(firstService.child, firstService.output, "first packed control service");
    if (secondService && !childExited(secondService.child)) await terminateOwnedGroup(secondService.child, secondService.output, "replacement packed control service");
    if (browser) await terminateOwnedGroup(browser.child, browser.output, "headless Chrome");
    rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const result = await runPackedDashboardSmoke(parseArguments(process.argv.slice(2)));
  console.log(JSON.stringify(result));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? `${error.name}${error.code ? ` [${error.code}]` : ""}: ${error.message}` : String(error));
    process.exitCode = 1;
  });
}

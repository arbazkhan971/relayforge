#!/usr/bin/env node
/**
 * Capture real functioning product screenshots for README assets.
 * Uses source dist CLI + headless Chrome CDP. No network except loopback.
 */
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CLI = resolve(ROOT, "dist/cli.js");
const ASSETS = resolve(ROOT, "assets");

function run(cmd, args, cwd, env = process.env) {
  return execFileSync(cmd, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((err) => (err ? reject(err) : resolvePort(port)));
    });
    server.on("error", reject);
  });
}

async function waitHttpOk(url, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await delay(200);
  }
  throw new Error(`not ready: ${url}`);
}

function connectCdp(wsUrl) {
  return new Promise((resolveConn, reject) => {
    const u = new URL(wsUrl);
    const key = randomBytes(16).toString("base64");
    const expected = createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: `${u.pathname}${u.search}`,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": key,
        "Sec-WebSocket-Version": "13"
      }
    });
    req.on("upgrade", (res, socket, head) => {
      if (res.headers["sec-websocket-accept"] !== expected) {
        socket.destroy();
        reject(new Error("websocket accept mismatch"));
        return;
      }
      let buf = head;
      let id = 0;
      const pending = new Map();
      const send = (method, params = {}) =>
        new Promise((res2, rej2) => {
          const mid = ++id;
          pending.set(mid, { res2, rej2 });
          const payload = Buffer.from(JSON.stringify({ id: mid, method, params }));
          // unmasked client frames are rejected; mask with zeros for simplicity
          const frame = Buffer.alloc(6 + payload.length);
          frame[0] = 0x81;
          frame[1] = 0x80 | payload.length;
          frame[2] = 0;
          frame[3] = 0;
          frame[4] = 0;
          frame[5] = 0;
          payload.copy(frame, 6);
          socket.write(frame);
        });
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
          let len = buf[1] & 0x7f;
          let off = 2;
          if (len === 126) {
            if (buf.length < 4) return;
            len = buf.readUInt16BE(2);
            off = 4;
          } else if (len === 127) {
            if (buf.length < 10) return;
            len = Number(buf.readBigUInt64BE(2));
            off = 10;
          }
          if (buf.length < off + len) return;
          const data = buf.subarray(off, off + len);
          buf = buf.subarray(off + len);
          if ((buf[0] & 0x0f) === 1 || true) {
            try {
              const msg = JSON.parse(data.toString("utf8"));
              if (msg.id && pending.has(msg.id)) {
                const { res2, rej2 } = pending.get(msg.id);
                pending.delete(msg.id);
                if (msg.error) rej2(new Error(JSON.stringify(msg.error)));
                else res2(msg.result);
              }
            } catch {
              /* incomplete frame parse — ignore */
            }
          }
        }
      });
      socket.on("error", reject);
      resolveConn({ send, close: () => socket.destroy() });
    });
    req.on("error", reject);
    req.end();
  });
}

async function screenshotUrl(url, outPath, { readyCheck, width = 1440, height = 900 } = {}) {
  const debugPort = await freePort();
  const profile = mkdtempSync(join(tmpdir(), "rf-chrome-"));
  chmodSync(profile, 0o700);
  const chrome = spawn(
    "google-chrome",
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      "about:blank"
    ],
    { stdio: "ignore", detached: true }
  );
  try {
    await waitHttpOk(`http://127.0.0.1:${debugPort}/json/version`);
    const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    const page = pages.find((p) => p.type === "page") ?? pages[0];
    const cdp = await connectCdp(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false
    });
    await cdp.send("Page.navigate", { url });
    for (let i = 0; i < 60; i++) {
      const r = await cdp.send("Runtime.evaluate", {
        expression: readyCheck,
        returnByValue: true,
        awaitPromise: true
      });
      if (r?.result?.value === true) break;
      await delay(250);
    }
    // settle paint
    await delay(500);
    const shot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true
    });
    writeFileSync(outPath, Buffer.from(shot.data, "base64"));
    cdp.close();
    console.log(`wrote ${outPath} (${readFileSync(outPath).length} bytes)`);
  } finally {
    try {
      process.kill(-chrome.pid, "SIGKILL");
    } catch {
      try {
        chrome.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    rmSync(profile, { recursive: true, force: true });
  }
}

async function captureDashboard() {
  if (!existsSync(CLI)) throw new Error("dist/cli.js missing — run npm run build");
  const work = mkdtempSync(join(tmpdir(), "rf-docs-dash-"));
  chmodSync(work, 0o700);
  const project = join(work, "project");
  mkdirSync(project, { mode: 0o700 });
  let serve;
  try {
    run("git", ["init", "-q"], project);
    run("git", ["config", "user.name", "RelayForge Docs"], project);
    run("git", ["config", "user.email", "docs@relayforge.invalid"], project);
    run("git", ["config", "commit.gpgsign", "false"], project);
    writeFileSync(
      join(project, "relayforge.config.yaml"),
      `version: 1
defaults:
  namespace: relayforge
  dashboardPort: 4318
  promptDir: .loop/prompts
  runDir: .loop/runs
projects:
  - name: demo
    brief: brief.md
    workingDir: .
    intelligence: PROJECT-INTELLIGENCE.md
    safetyMode: workspace-write
    providers:
      agent:
        type: custom
        command: /bin/true
        auth: { mode: auto }
    roles:
      - { name: planner, title: Planner, provider: agent, sme: product-manager }
      - { name: implementer, title: Implementer, provider: agent, sme: engineer }
      - { name: reviewer, title: Reviewer, provider: agent, sme: qa }
    loops:
      - name: delivery-loop
        orchestrator: planner
        reviewer: reviewer
        maxIterations: 8
        maxParallel: 1
        budgetUsd: 0
`
    );
    writeFileSync(join(project, "brief.md"), "# Demo brief\n\nShip a verified health-check endpoint with tests.\n");
    run("git", ["add", "-A"], project);
    run("git", ["commit", "-qm", "docs screenshot baseline"], project);
    const dry = JSON.parse(
      run(process.execPath, [CLI, "run", "Ship a verified health-check endpoint with tests", "--run", "docs-demo", "--json"], project)
    );
    if (dry.status !== "planned" && dry.status !== "succeeded" && dry.success !== true) {
      throw new Error(`unexpected dry-run: ${JSON.stringify(dry)}`);
    }
    const port = await freePort();
    serve = spawn(process.execPath, [CLI, "serve", "--port", String(port)], {
      cwd: project,
      stdio: "ignore",
      detached: true
    });
    await waitHttpOk(`http://127.0.0.1:${port}/api/v1/status`);
    const status = await (await fetch(`http://127.0.0.1:${port}/api/v1/status`)).json();
    if (status.status !== "ok") throw new Error(`status not ok: ${JSON.stringify(status)}`);
    await screenshotUrl(`http://127.0.0.1:${port}/`, join(ASSETS, "dashboard.png"), {
      width: 1440,
      height: 900,
      readyCheck: `(() => {
        const state = document.getElementById("connection")?.dataset?.state;
        const kpis = document.querySelectorAll(".kpi").length;
        const title = document.title || "";
        return title.includes("RelayForge") && kpis >= 1 && (state === "connected" || state === "degraded" || document.body?.innerText?.includes("demo"));
      })()`
    });
  } finally {
    if (serve?.pid) {
      try {
        process.kill(-serve.pid, "SIGKILL");
      } catch {
        try {
          serve.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }
    rmSync(work, { recursive: true, force: true });
  }
}

async function captureTodoApp() {
  const todoRoot = resolve(ROOT, "examples/todo-app");
  const port = await freePort();
  const server = spawn(process.execPath, ["server.js"], {
    cwd: todoRoot,
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
    detached: true
  });
  try {
    // server may hardcode port — check server.js
    const src = readFileSync(join(todoRoot, "server.js"), "utf8");
    const hardcoded = /listen\((\d+)/.exec(src);
    const actualPort = hardcoded ? Number(hardcoded[1]) : port;
    // if hardcoded 3000, use that and hope free
    await waitHttpOk(`http://127.0.0.1:${actualPort}/`, 80);
    // seed a few todos via API if available
    try {
      await fetch(`http://127.0.0.1:${actualPort}/api/todos`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Wire RelayForge doctor" })
      });
      await fetch(`http://127.0.0.1:${actualPort}/api/todos`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Run dry-run then --execute" })
      });
      await fetch(`http://127.0.0.1:${actualPort}/api/todos`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Ship verified change" })
      });
    } catch {
      /* UI still screenshotable empty */
    }
    await screenshotUrl(`http://127.0.0.1:${actualPort}/`, join(ASSETS, "todo-app.png"), {
      width: 960,
      height: 720,
      readyCheck: `(() => document.readyState === "complete" && (document.body?.innerText?.length ?? 0) > 20)()`
    });
  } finally {
    if (server?.pid) {
      try {
        process.kill(-server.pid, "SIGKILL");
      } catch {
        try {
          server.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }
  }
}

const main = async () => {
  mkdirSync(ASSETS, { recursive: true });
  await captureDashboard();
  await captureTodoApp();
  console.log("done");
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

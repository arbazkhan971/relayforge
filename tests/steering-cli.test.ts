import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  STEERING_IPC_LOCATOR_LEAF,
  STEERING_IPC_MAX_REQUEST_BYTES,
  SteeringIpcError,
  sendSteeringIpcRequest,
  startSteeringIpcServer,
  steeringIpcAdmitRequest,
  steeringIpcSocketPath,
  steeringIpcWithdrawRequest,
  type SteeringIpcServerHandle
} from "../src/steering/ipc.js";
import { materializeSteeringCommand } from "../src/steering/schema.js";
import type {
  SteeringAdmissionRequest,
  SteeringWithdrawalRequest
} from "../src/steering/service.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(repoRoot, "src/cli.ts");
const tsxPath = resolve(repoRoot, "node_modules/tsx/dist/cli.mjs");
const NOW = "2026-08-09T00:00:00.000Z";
const RUN_ID = "run-1";
const RUN_EPOCH = "epoch-1";
const COMMAND_ID = "01890f9d-0000-7000-8000-000000000001";

const roots: string[] = [];
const handles: SteeringIpcServerHandle[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const handle of handles.splice(0)) {
    try { await handle.closeAndDrain(); } catch { /* individual tests exercise cleanup failures */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Fixture = {
  root: string;
  runDir: string;
  admissions: SteeringAdmissionRequest[];
  withdrawals: SteeringWithdrawalRequest[];
  assertAuthority: ReturnType<typeof vi.fn>;
  service: {
    admit(value: unknown): ReturnType<typeof admitted>;
    withdraw(value: unknown): { status: "withdrawn"; commandId: string; seq: number; reason?: string };
  };
};

function admitted(request: SteeringAdmissionRequest) {
  const command = materializeSteeringCommand({
    ...request,
    sourceKind: "operator",
    parentPrincipal: "operator-test",
    createdAt: NOW
  });
  return { decision: "admitted" as const, commandId: command.commandId, seq: 41, command };
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "rf-sc-"));
  roots.push(root);
  writeFileSync(
    join(root, "loop.config.yaml"),
    `version: 1
projects:
  - name: demo
    providers:
      dev: { type: codex }
    roles:
      - { name: dev, title: Developer, provider: dev }
`
  );
  const runDir = join(root, ".loop", "runs", "demo", RUN_ID);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  chmodSync(runDir, 0o700);
  const admissions: SteeringAdmissionRequest[] = [];
  const withdrawals: SteeringWithdrawalRequest[] = [];
  const assertAuthority = vi.fn();
  return {
    root,
    runDir,
    admissions,
    withdrawals,
    assertAuthority,
    service: {
      admit(value: unknown) {
        const request = structuredClone(value) as SteeringAdmissionRequest;
        admissions.push(request);
        return admitted(request);
      },
      withdraw(value: unknown) {
        const request = structuredClone(value) as SteeringWithdrawalRequest;
        withdrawals.push(request);
        return {
          status: "withdrawn" as const,
          commandId: request.commandId,
          seq: 42,
          ...(request.reason === undefined ? {} : { reason: request.reason })
        };
      }
    }
  };
}

async function start(f: Fixture, requestTimeoutMs?: number): Promise<SteeringIpcServerHandle> {
  const handle = await startSteeringIpcServer({
    runDir: f.runDir,
    runId: RUN_ID,
    runEpoch: RUN_EPOCH,
    service: f.service,
    assertAuthority: f.assertAuthority,
    requestTimeoutMs
  });
  handles.push(handle);
  return handle;
}

function admissionRequest(commandId = COMMAND_ID) {
  return steeringIpcAdmitRequest({
    schemaVersion: 1,
    commandId,
    runId: RUN_ID,
    runEpoch: RUN_EPOCH,
    taskId: "task-1",
    taskGeneration: 2,
    sessionId: "session.0123456789abcdef",
    sessionGeneration: 3,
    notBeforeAttemptGeneration: 4,
    kind: "steer_next_boundary",
    evidenceRefs: ["event-1"],
    body: "Prefer the smaller recovery boundary."
  });
}

async function runLoop(args: string[], cwd: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [tsxPath, cliPath, ...args], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("exit", (status) => resolveRun({ status, stdout, stderr }));
  });
}

function rawRequest(path: string, bytes: Buffer): Promise<Buffer> {
  return new Promise((resolveRaw, rejectRaw) => {
    const socket = createConnection({ path, allowHalfOpen: true });
    const chunks: Buffer[] = [];
    socket.once("connect", () => socket.end(bytes));
    socket.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    socket.once("end", () => resolveRaw(Buffer.concat(chunks)));
    socket.once("error", rejectRaw);
  });
}

function parseRawResponse(bytes: Buffer): Record<string, any> {
  return JSON.parse(bytes.toString("utf8")) as Record<string, any>;
}

describe("parent-only steering IPC", () => {
  it("uses one private run-owned socket, exact identities and stable command IDs without creating SQLite", async () => {
    const f = fixture();
    const handle = await start(f);
    const stat = lstatSync(handle.socketPath);
    expect(stat.isSocket()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(handle.socketPath.startsWith(`${f.runDir}/`)).toBe(false);
    const locator = JSON.parse(readFileSync(join(f.runDir, STEERING_IPC_LOCATOR_LEAF), "utf8")) as Record<string, unknown>;
    expect(locator).toMatchObject({
      schemaVersion: 1,
      runId: RUN_ID,
      runEpoch: RUN_EPOCH,
      socketPath: handle.socketPath
    });

    const request = admissionRequest();
    const first = await sendSteeringIpcRequest(request, { runDir: f.runDir });
    const retry = await sendSteeringIpcRequest(request, { runDir: f.runDir });
    expect(first).toMatchObject({ decision: "admitted", commandId: COMMAND_ID, seq: 41 });
    expect(retry).toEqual(first);
    expect(f.admissions).toHaveLength(2);
    expect(f.admissions.map((value) => value.commandId)).toEqual([COMMAND_ID, COMMAND_ID]);
    expect(readdirSync(f.runDir).filter((leaf) => /sqlite|\.db(?:-|$)/u.test(leaf))).toEqual([]);

    const withdrawn = await sendSteeringIpcRequest(
      steeringIpcWithdrawRequest(
        { runId: RUN_ID, runEpoch: RUN_EPOCH },
        { schemaVersion: 1, commandId: COMMAND_ID, reason: "intent replaced" }
      ),
      { runDir: f.runDir }
    );
    expect(withdrawn).toEqual({ status: "withdrawn", commandId: COMMAND_ID, seq: 42, reason: "intent replaced" });
    expect(f.withdrawals).toEqual([{ schemaVersion: 1, commandId: COMMAND_ID, reason: "intent replaced" }]);
    expect(f.assertAuthority.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it("fails closed on run identity or lost parent authority before invoking the service", async () => {
    const f = fixture();
    let held = true;
    f.assertAuthority.mockImplementation(() => {
      if (!held) throw new Error("lease lost");
    });
    await start(f);

    const wrong = { ...admissionRequest(), runEpoch: "other-epoch", payload: { ...admissionRequest().payload, runEpoch: "other-epoch" } };
    await expect(sendSteeringIpcRequest(wrong, { runDir: f.runDir })).rejects.toMatchObject({
      code: "RUN_IDENTITY_MISMATCH"
    });
    held = false;
    await expect(sendSteeringIpcRequest(admissionRequest(), { runDir: f.runDir })).rejects.toMatchObject({
      code: "AUTHORITY_UNAVAILABLE"
    });
    expect(f.admissions).toEqual([]);
  });

  it("enforces exactly one newline-framed request and the request cap at exact and plus-one bytes", async () => {
    const f = fixture();
    const handle = await start(f);
    const valid = Buffer.from(`${JSON.stringify(admissionRequest())}\n`, "utf8");
    const two = await rawRequest(handle.socketPath, Buffer.concat([valid, valid]));
    expect(parseRawResponse(two).error.code).toBe("PROTOCOL_ERROR");

    const exact = Buffer.alloc(STEERING_IPC_MAX_REQUEST_BYTES, 0x20);
    exact[exact.byteLength - 1] = 0x0a;
    expect(parseRawResponse(await rawRequest(handle.socketPath, exact)).error.code).toBe("INVALID_REQUEST");

    const over = Buffer.alloc(STEERING_IPC_MAX_REQUEST_BYTES + 1, 0x20);
    over[over.byteLength - 1] = 0x0a;
    expect(parseRawResponse(await rawRequest(handle.socketPath, over)).error.code).toBe("REQUEST_TOO_LARGE");
    expect(f.admissions).toEqual([]);
  });

  it("recovers a crash-left socket only after authority proof, then drains and removes its pinned leaf", async () => {
    const f = fixture();
    const path = steeringIpcSocketPath(f.runDir);
    const child = spawn(process.execPath, [
      "-e",
      `const net=require('node:net');net.createServer().listen(${JSON.stringify(path)},()=>process.stdout.write('ready\\n'));setInterval(()=>{},1000)`
    ], { stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    await new Promise<void>((resolveReady, rejectReady) => {
      child.stdout!.setEncoding("utf8");
      child.stdout!.once("data", () => resolveReady());
      child.once("error", rejectReady);
      child.once("exit", (code) => rejectReady(new Error(`stale-socket child exited early: ${code}`)));
    });
    child.kill("SIGKILL");
    await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    expect(lstatSync(path).isSocket()).toBe(true);

    const handle = await start(f);
    expect(await sendSteeringIpcRequest(admissionRequest(), { runDir: f.runDir })).toMatchObject({ decision: "admitted" });

    const idle = createConnection({ path: handle.socketPath });
    await new Promise<void>((resolveConnect, rejectConnect) => {
      idle.once("connect", resolveConnect);
      idle.once("error", rejectConnect);
    });
    await handle.closeAndDrain();
    handles.splice(handles.indexOf(handle), 1);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(f.runDir, STEERING_IPC_LOCATOR_LEAF))).toBe(false);
    idle.destroy();
  });

  it("uses a short private endpoint plus run-owned locator for deeply nested workspaces", async () => {
    const f = fixture();
    f.runDir = join(f.root, "deep-workspace-segment".repeat(5), ".loop", "runs", "demo", RUN_ID);
    mkdirSync(f.runDir, { recursive: true, mode: 0o700 });
    chmodSync(f.runDir, 0o700);
    expect(Buffer.byteLength(join(f.runDir, ".steer.sock"), "utf8")).toBeGreaterThan(100);

    const handle = await start(f);
    expect(Buffer.byteLength(handle.socketPath, "utf8")).toBeLessThanOrEqual(100);
    expect(await sendSteeringIpcRequest(admissionRequest(), { runDir: f.runDir })).toMatchObject({
      decision: "admitted"
    });
    expect(existsSync(join(f.runDir, STEERING_IPC_LOCATOR_LEAF))).toBe(true);
  });

  it("refuses a replaced locator before connecting or mutating canonical steering state", async () => {
    const f = fixture();
    const handle = await start(f);
    const locatorPath = join(f.runDir, STEERING_IPC_LOCATOR_LEAF);
    const foreign = join(f.runDir, "foreign-locator.json");
    writeFileSync(foreign, "{}\n", { mode: 0o600 });
    unlinkSync(locatorPath);
    symlinkSync(foreign, locatorPath);

    await expect(sendSteeringIpcRequest(admissionRequest(), { runDir: f.runDir })).rejects.toMatchObject({
      code: "IPC_PATH_UNSAFE"
    });
    expect(f.admissions).toEqual([]);
    await expect(handle.closeAndDrain()).rejects.toMatchObject({ code: "IPC_PATH_UNSAFE" });
    handles.splice(handles.indexOf(handle), 1);
    unlinkSync(locatorPath);
  });

  it("refuses public/symlinked run directories and never replaces a non-socket leaf", async () => {
    const f = fixture();
    chmodSync(f.runDir, 0o755);
    await expect(start(f)).rejects.toMatchObject({ code: "IPC_PATH_UNSAFE" });
    chmodSync(f.runDir, 0o700);
    const unsafeEndpoint = steeringIpcSocketPath(f.runDir);
    writeFileSync(unsafeEndpoint, "do not replace", { mode: 0o600 });
    await expect(start(f)).rejects.toMatchObject({ code: "IPC_PATH_UNSAFE" });
    expect(lstatSync(unsafeEndpoint).isFile()).toBe(true);
    rmSync(unsafeEndpoint, { force: true });
  });
});

describe("steering CLI", () => {
  it("documents the three operator verbs and the future-boundary contract in help", async () => {
    const f = fixture();
    const help = await runLoop(["steer", "--help"], f.root);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("new-id");
    expect(help.stdout).toContain("admit");
    expect(help.stdout).toContain("withdraw");
    expect(help.stdout).toMatch(/future immutable attempt prompt/iu);
  });

  it("publishes through the run-parent authority hook and removes the endpoint before a dry run returns", async () => {
    const f = fixture();
    const runId = "run-parent-hook";
    const result = await runLoop(["--json", "run", "plan the boundary", "--run", runId], f.root);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ run: runId, status: "planned", success: true });
    const runDir = join(f.root, ".loop", "runs", "demo", runId);
    expect(existsSync(steeringIpcSocketPath(runDir))).toBe(false);
    expect(readdirSync(runDir)).not.toContain(STEERING_IPC_LOCATOR_LEAF);
  });

  it("connects to the run parent for truthful Pending and Withdrawn results without opening a store", async () => {
    const f = fixture();
    await start(f);
    const common = [
      "--json", "steer", "admit",
      "--run", RUN_ID,
      "--run-epoch", RUN_EPOCH,
      "--command-id", COMMAND_ID,
      "--task-id", "task-1",
      "--task-generation", "2",
      "--session-id", "session.0123456789abcdef",
      "--session-generation", "3",
      "--not-before-attempt", "4",
      "--body", "Prefer the smaller recovery boundary.",
      "--evidence", "event-1"
    ];
    const admittedResult = await runLoop(common, f.root);
    expect(admittedResult.status).toBe(0);
    expect(JSON.parse(admittedResult.stdout)).toMatchObject({
      ok: true,
      requestId: COMMAND_ID,
      decision: "admitted",
      label: "Pending"
    });
    expect(admittedResult.stdout).toContain("not yet Included");
    expect(f.admissions).toHaveLength(1);

    const withdrawnResult = await runLoop([
      "--json", "steer", "withdraw",
      "--run", RUN_ID,
      "--run-epoch", RUN_EPOCH,
      "--command-id", COMMAND_ID,
      "--reason", "intent replaced"
    ], f.root);
    expect(withdrawnResult.status).toBe(0);
    expect(JSON.parse(withdrawnResult.stdout)).toMatchObject({
      ok: true,
      requestId: COMMAND_ID,
      status: "withdrawn",
      label: "Withdrawn"
    });
    expect(f.withdrawals).toHaveLength(1);
    expect(readdirSync(f.runDir).filter((leaf) => /sqlite|\.db(?:-|$)/u.test(leaf))).toEqual([]);
  });

  it("requires caller-stable UUIDv7 identity and rejects malformed targets before any socket connect", async () => {
    const f = fixture();
    const newId = await runLoop(["--json", "steer", "new-id"], f.root);
    expect(newId.status).toBe(0);
    expect(JSON.parse(newId.stdout).commandId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);

    const bad = await runLoop([
      "--json", "steer", "admit",
      "--run", RUN_ID,
      "--run-epoch", RUN_EPOCH,
      "--command-id", "not-stable",
      "--task-id", "task-1",
      "--task-generation", "0",
      "--session-id", "session-1",
      "--session-generation", "1",
      "--not-before-attempt", "1",
      "--body", "intent"
    ], f.root);
    expect(bad.status).toBe(1);
    expect(JSON.parse(bad.stdout)).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    expect(existsSync(steeringIpcSocketPath(f.runDir))).toBe(false);
  });
});

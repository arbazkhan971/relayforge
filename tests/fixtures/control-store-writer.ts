import { existsSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { openControlStore, type ControlStoreFaultPoint } from "../../src/control/store.js";

const [path, encodedEvent, readyPath, startPath, crashPoint, expectedHeadText] = process.argv.slice(2);
if (!path || !encodedEvent) throw new Error("usage: control-store-writer <path> <base64url-event> [ready] [start] [crash-point]");

if (encodedEvent === "--hold-lock") {
  const db = new Database(path);
  try {
    db.pragma("busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    if (readyPath) writeFileSync(readyPath, String(process.pid), { mode: 0o600 });
    const holdMs = Number(crashPoint || "6500");
    if (!Number.isSafeInteger(holdMs) || holdMs < 1 || holdMs > 30_000) throw new Error("invalid lock hold duration");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
    db.exec("ROLLBACK");
    process.stdout.write(`${JSON.stringify({ ok: true, heldMs: holdMs })}\n`);
  } finally {
    db.close();
  }
  process.exit(0);
}

const event = JSON.parse(Buffer.from(encodedEvent, "base64url").toString("utf8")) as unknown;
const store = openControlStore({
  path,
  runId: "run-1",
  runEpoch: "epoch-1",
  create: false,
  fault: crashPoint
    ? (point: ControlStoreFaultPoint) => {
        if (point === crashPoint) process.kill(process.pid, "SIGKILL");
      }
    : undefined
});

if (readyPath && startPath) {
  writeFileSync(readyPath, String(process.pid), { mode: 0o600 });
  const deadline = Date.now() + 60_000;
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(startPath)) {
    if (Date.now() > deadline) throw new Error("timed out waiting for writer start barrier");
    Atomics.wait(waiter, 0, 0, 10);
  }
}

try {
  const result = expectedHeadText === undefined || expectedHeadText === ""
    ? store.append(event)
    : store.appendBatchIf({ expectedHeadSeq: Number(expectedHeadText), events: [event] })[0];
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
} catch (error) {
  const candidate = error as { code?: string; message?: string };
  process.stdout.write(`${JSON.stringify({ ok: false, code: candidate.code, message: candidate.message })}\n`);
  process.exitCode = 2;
} finally {
  store.close();
}

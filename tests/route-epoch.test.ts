import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RouteEpochCorrupt, bumpRouteEpoch, loadHealth, loadRouteEpoch, routeEpochPath, saveHealth } from "../src/routing.js";
import { UnsafeStateFileError, readStateFile, writeStateFileDurable } from "../src/runtime.js";
import { initBoard, addTask, readTasks } from "../src/board.js";

const nonce = () => randomBytes(32).toString("hex");
const dirs: string[] = [];
function run(): string {
  const d = mkdtempSync(join(tmpdir(), "loop-epoch-"));
  dirs.push(d);
  return d;
}

/** Write the epoch file EXACTLY as the implementation would, so a test can then corrupt one field. */
function validEpochFile(runNonce: string, epoch: number, reason = "r", ts = "2026-07-12T00:00:00.000Z") {
  const check = createHash("sha256").update(`loop.route-epoch.v1\0${runNonce}\0${epoch}\0${reason}\0${ts}`).digest("hex");
  return { schema: "loop.route-epoch.v1", runNonce, epoch, reason, ts, check };
}

/**
 * The route epoch is the ONLY thing binding a settlement to the route that spent the money. Every one of
 * these was previously laundered into `return 0` — the INITIAL state, in which every stale-route
 * settlement is fresh and a bump silently rewinds the generation.
 */
describe("route epoch: ABSENT is the only initial state — every corruption fails CLOSED", () => {
  it("a genuinely absent state is epoch 0 (and only then)", () => {
    const d = run();
    expect(loadRouteEpoch(d, nonce())).toBe(0);
  });

  it("MALFORMED json is corruption, not epoch 0", () => {
    const d = run();
    const r = nonce();
    writeFileSync(routeEpochPath(d), "{not json", { mode: 0o600 });
    expect(() => loadRouteEpoch(d, r)).toThrow(RouteEpochCorrupt);
    expect(() => loadRouteEpoch(d, r)).toThrow(/malformed or truncated/);
  });

  it("a TRUNCATED record (a torn write) is corruption, not epoch 0", () => {
    const d = run();
    const r = nonce();
    const whole = JSON.stringify(validEpochFile(r, 7), null, 2);
    writeFileSync(routeEpochPath(d), whole.slice(0, Math.floor(whole.length / 2)), { mode: 0o600 });
    expect(() => loadRouteEpoch(d, r)).toThrow(RouteEpochCorrupt);
  });

  it("an EMPTY file (a torn create) is corruption, not epoch 0", () => {
    const d = run();
    writeFileSync(routeEpochPath(d), "", { mode: 0o600 });
    expect(() => loadRouteEpoch(d, nonce())).toThrow(/empty/);
  });

  for (const [name, mutate] of [
    ["a missing epoch", (f: Record<string, unknown>) => delete f.epoch],
    ["a string epoch", (f: Record<string, unknown>) => (f.epoch = "3")],
    ["a negative epoch", (f: Record<string, unknown>) => (f.epoch = -1)],
    ["a fractional epoch", (f: Record<string, unknown>) => (f.epoch = 1.5)],
    ["a NaN epoch", (f: Record<string, unknown>) => (f.epoch = Number.NaN)],
    ["an unknown schema", (f: Record<string, unknown>) => (f.schema = "loop.route-epoch.v2")],
    ["a missing run identity", (f: Record<string, unknown>) => delete f.runNonce],
    ["an array, not an object", () => undefined]
  ] as const) {
    it(`INVALID SCHEMA (${name}) is corruption, not epoch 0`, () => {
      const d = run();
      const r = nonce();
      const f: Record<string, unknown> = validEpochFile(r, 3) as unknown as Record<string, unknown>;
      mutate(f);
      const body = name === "an array, not an object" ? "[]" : JSON.stringify(f);
      writeFileSync(routeEpochPath(d), body, { mode: 0o600 });
      expect(() => loadRouteEpoch(d, r)).toThrow(RouteEpochCorrupt);
    });
  }

  it("a record whose SELF-CHECKSUM does not match its fields (a field edited in place) is corruption", () => {
    const d = run();
    const r = nonce();
    const f = validEpochFile(r, 9) as Record<string, unknown>;
    f.epoch = 1; // rewind the generation but keep the (now stale) checksum
    writeFileSync(routeEpochPath(d), JSON.stringify(f), { mode: 0o600 });
    expect(() => loadRouteEpoch(d, r)).toThrow(/self-checksum/);
  });

  it("a SWAPPED state from ANOTHER RUN is corruption, not this run's generation", () => {
    const d = run();
    const mine = nonce();
    const theirs = nonce();
    writeFileSync(routeEpochPath(d), JSON.stringify(validEpochFile(theirs, 4)), { mode: 0o600 });
    expect(() => loadRouteEpoch(d, mine)).toThrow(/swapped state/);
  });

  it("a SYMLINKED state is refused — it is never followed", () => {
    const d = run();
    const r = nonce();
    const elsewhere = join(d, "planted.json");
    writeFileSync(elsewhere, JSON.stringify(validEpochFile(r, 0)), { mode: 0o600 });
    symlinkSync(elsewhere, routeEpochPath(d));
    expect(() => loadRouteEpoch(d, r)).toThrow(/symlink/);
  });

  it("a NON-REGULAR state (a directory) is refused", () => {
    const d = run();
    mkdirSync(routeEpochPath(d));
    expect(() => loadRouteEpoch(d, nonce())).toThrow(RouteEpochCorrupt);
  });

  it("a HARDLINK ALIAS (a second name that can mutate our state) is refused", () => {
    const d = run();
    const r = nonce();
    writeFileSync(routeEpochPath(d), JSON.stringify(validEpochFile(r, 2)), { mode: 0o600 });
    linkSync(routeEpochPath(d), join(d, "alias.json"));
    expect(() => loadRouteEpoch(d, r)).toThrow(/hard link/);
  });

  it("a PERMISSIVE (group/other-accessible) state is refused", () => {
    const d = run();
    const r = nonce();
    writeFileSync(routeEpochPath(d), JSON.stringify(validEpochFile(r, 2)), { mode: 0o644 });
    expect(() => loadRouteEpoch(d, r)).toThrow(/group\/other accessible/);
  });

  it("an UNREADABLE state is corruption, NOT absent (the mode-0 file exists and we cannot prove it)", () => {
    const d = run();
    const r = nonce();
    writeFileSync(routeEpochPath(d), JSON.stringify(validEpochFile(r, 5)), { mode: 0o600 });
    chmodSync(routeEpochPath(d), 0o000);
    // Root can read anything, so only assert the fail-closed behaviour where the mode actually bites.
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    expect(() => loadRouteEpoch(d, r)).toThrow(RouteEpochCorrupt);
  });
});

describe("route epoch: the bump is DURABLE, MONOTONIC, and never launders corruption", () => {
  it("bumping advances the generation and persists it across processes", () => {
    const d = run();
    const r = nonce();
    expect(bumpRouteEpoch(d, r, "limit")).toBe(1);
    expect(bumpRouteEpoch(d, r, "limit again")).toBe(2);
    expect(loadRouteEpoch(d, r)).toBe(2);
  });

  it("a bump over a CORRUPT state throws — it never rewinds 5 → 1 by laundering it to 0", () => {
    const d = run();
    const r = nonce();
    bumpRouteEpoch(d, r, "1");
    bumpRouteEpoch(d, r, "2");
    bumpRouteEpoch(d, r, "3");
    const before = readFileSync(routeEpochPath(d), "utf8");
    writeFileSync(routeEpochPath(d), "{tampered", { mode: 0o600 });
    expect(() => bumpRouteEpoch(d, r, "4")).toThrow(RouteEpochCorrupt);
    // …and it did NOT overwrite the corrupt state with a fresh-looking `1`: an operator still sees the
    // corruption, and every settlement bound to epochs 1..3 stays unfoldable rather than re-validated.
    expect(readFileSync(routeEpochPath(d), "utf8")).toBe("{tampered");
    expect(before).toContain('"epoch": 3');
  });

  it("a ROLLED-BACK state (restored from an older copy) is refused — a generation only goes forward", () => {
    const d = run();
    const r = nonce();
    bumpRouteEpoch(d, r, "1");
    const old = readFileSync(routeEpochPath(d), "utf8"); // a valid, correctly-checksummed epoch 1
    bumpRouteEpoch(d, r, "2");
    bumpRouteEpoch(d, r, "3");
    unlinkSync(routeEpochPath(d));
    writeFileSync(routeEpochPath(d), old, { mode: 0o600 }); // swap epoch 3 for the old epoch 1
    expect(() => loadRouteEpoch(d, r)).toThrow(/BELOW the 3 already proven/);
  });

  it("a DELETED state after a proven bump is refused — it is a rollback, not a fresh run", () => {
    const d = run();
    const r = nonce();
    bumpRouteEpoch(d, r, "1");
    unlinkSync(routeEpochPath(d));
    expect(() => loadRouteEpoch(d, r)).toThrow(/already proven/);
  });

  it("a CRASH mid-bump leaves either the old generation or the new one — never a torn record", () => {
    const d = run();
    const r = nonce();
    bumpRouteEpoch(d, r, "first");
    // The publish is temp-file + fsync + rename + dir-fsync. Simulate the crash window by proving the
    // ONLY name the reader consults is the final one, and that a leftover temp is inert: whatever the
    // crash left behind, the state still folds to exactly the last COMPLETED bump.
    writeFileSync(`${routeEpochPath(d)}.tmp-999-0-deadbeef`, "{half-written", { mode: 0o600 });
    expect(loadRouteEpoch(d, r)).toBe(1);
    expect(bumpRouteEpoch(d, r, "second")).toBe(2);
    expect(loadRouteEpoch(d, r)).toBe(2);
    // The published state is never a temp file, and never partially visible.
    const published = JSON.parse(readFileSync(routeEpochPath(d), "utf8"));
    expect(published.epoch).toBe(2);
    expect(published.check).toBe(validEpochFile(r, 2, published.reason, published.ts).check);
  });

  it("the published state is PRIVATE (0600), whatever the ambient umask", () => {
    const d = run();
    bumpRouteEpoch(d, nonce(), "x");
    expect(statSync(routeEpochPath(d)).mode & 0o777).toBe(0o600);
  });
});

describe("unsafe PRE-EXISTING run-state paths are verified or REJECTED (never adopted)", () => {
  it("readStateFile distinguishes absent from every unsafe shape", () => {
    const d = run();
    expect(readStateFile(join(d, "nope")).kind).toBe("absent");
    writeFileSync(join(d, "ok"), "hi", { mode: 0o600 });
    expect(readStateFile(join(d, "ok"))).toEqual({ kind: "present", data: Buffer.from("hi") });
    symlinkSync(join(d, "ok"), join(d, "link"));
    expect(() => readStateFile(join(d, "link"))).toThrow(UnsafeStateFileError);
    mkdirSync(join(d, "adir"));
    expect(() => readStateFile(join(d, "adir"))).toThrow(/not a regular file/);
    writeFileSync(join(d, "loose"), "x", { mode: 0o666 });
    expect(() => readStateFile(join(d, "loose"))).toThrow(/group\/other accessible/);
  });

  it("writeStateFileDurable publishes 0600 atomically and leaves no temp behind", () => {
    const d = run();
    const p = join(d, "state.json");
    writeStateFileDurable(p, '{"a":1}\n');
    expect(readFileSync(p, "utf8")).toBe('{"a":1}\n');
    expect(statSync(p).mode & 0o777).toBe(0o600);
    writeStateFileDurable(p, '{"a":2}\n'); // overwrite an existing state
    expect(readFileSync(p, "utf8")).toBe('{"a":2}\n');
    expect(readdirSync(d)).toEqual(["state.json"]); // no temp survived either publish
  });

  it("PROVIDER HEALTH: a symlinked / permissive / malformed file is refused, never read as 'no cooldown'", () => {
    const d = run();
    expect(loadHealth(d)).toEqual({}); // absent → no cooldown has ever been marked
    saveHealth(d, { opus: { cooldownUntil: 123, reason: "limit" } });
    expect(loadHealth(d)).toEqual({ opus: { cooldownUntil: 123, reason: "limit" } });

    const p = join(d, ".loop_provider_health.json");
    writeFileSync(p, '{"opus":{"cooldownUntil":"soon"}}', { mode: 0o600 });
    expect(() => loadHealth(d)).toThrow(/invalid cooldownUntil/);
    writeFileSync(p, "{oops", { mode: 0o600 });
    expect(() => loadHealth(d)).toThrow(/not parseable JSON/);
    unlinkSync(p);
    symlinkSync(join(d, "elsewhere"), p);
    expect(() => loadHealth(d)).toThrow(UnsafeStateFileError);
  });

  it("BOARD: a symlinked journal is refused rather than appended/read through", () => {
    const d = run();
    const boardDir = join(d, "board");
    mkdirSync(boardDir, { mode: 0o700 });
    const outside = join(d, "outside.jsonl");
    writeFileSync(outside, "", { mode: 0o600 });
    symlinkSync(outside, join(boardDir, "tasks.jsonl")); // the classic plant: existsSync said "it's there"
    expect(() => initBoard(boardDir)).toThrow(UnsafeStateFileError);
  });

  it("BOARD: a symlinked board DIRECTORY is refused (mkdir -p succeeds on it, chmod would follow it)", () => {
    const d = run();
    const real = join(d, "real");
    mkdirSync(real, { mode: 0o755 });
    const boardDir = join(d, "board");
    symlinkSync(real, boardDir);
    expect(() => initBoard(boardDir)).toThrow(/symlink/);
    expect(statSync(real).mode & 0o777).toBe(0o755); // …and it was NOT re-permissioned through the link
  });

  it("BOARD: a permissive pre-existing journal is refused", () => {
    const d = run();
    const boardDir = join(d, "board");
    mkdirSync(boardDir, { mode: 0o700 });
    writeFileSync(join(boardDir, "tasks.jsonl"), "", { mode: 0o664 });
    expect(() => initBoard(boardDir)).toThrow(/group\/other accessible/);
  });

  it("BOARD: the journals it creates are 0600 and round-trip", () => {
    const d = run();
    const boardDir = join(d, "board");
    initBoard(boardDir);
    for (const f of ["tasks.jsonl", "events.jsonl", "messages.jsonl"]) {
      expect(statSync(join(boardDir, f)).mode & 0o777, f).toBe(0o600);
    }
    addTask(boardDir, { id: "T1", role: "dev", title: "t", detail: "d", status: "open", attempts: 0, createdTs: "x" } as never);
    expect(readTasks(boardDir).map((t) => t.id)).toEqual(["T1"]);
  });
});

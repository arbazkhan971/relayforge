import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  InMemoryViewportStorage,
  JsonViewportStorage,
  ViewportRegistry,
  VIEWPORT_REGISTRY_MAX_RECORDS
} from "../src/viewport-registry.js";

function base(runId = "run-abc123", role = "implementer", overrides: Record<string, unknown> = {}) {
  return {
    runId,
    role,
    sessionName: `rf:${runId}:${role}`,
    ownerPid: 4242,
    createdAt: 1_000,
    lastActiveAt: 1_000,
    state: "running",
    ...overrides
  };
}

describe("ViewportRegistry (in-memory)", () => {
  it("records idempotently: latest wins per (runId, role)", () => {
    const registry = new ViewportRegistry();
    registry.record(base("run-a", "worker", { pid: 10, createdAt: 100 }));
    registry.record(base("run-a", "worker", { pid: 11, createdAt: 200 }));
    const sessions = registry.list("run-a");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].pid).toBe(11);
    expect(sessions[0].createdAt).toBe(200);
  });

  it("validates ids and states strictly", () => {
    const registry = new ViewportRegistry();
    for (const bad of ["a/b", "", "a b", "a:b", "x".repeat(129), "@"]) {
      expect(() => registry.record(base("run", bad!))).toThrow(TypeError);
      expect(() => registry.record(base(bad!, "role"))).toThrow(TypeError);
    }
    expect(() => registry.record(base("run", "role", { state: "flying" }))).toThrow(TypeError);
    expect(() => registry.record(base("run", "role", { ownerPid: 0 }))).toThrow(TypeError);
    expect(() => registry.updateState("run", "role", "flying" as never)).toThrow(TypeError);
  });

  it("transitions state and records lastActiveAt", () => {
    const registry = new ViewportRegistry({ clock: () => 5_000 });
    registry.record(base("run-a", "reviewer", { createdAt: 1_000 }));
    expect(registry.updateState("run-a", "reviewer", "blocked")).toBe(true);
    expect(registry.resolve("run-a", "reviewer")).toMatchObject({ state: "blocked", lastActiveAt: 5_000 });
    expect(registry.updateState("run-a", "ghost", "done")).toBe(false);
    expect(registry.resolve("run-a", "ghost")).toBeUndefined();
  });

  it("lists in createdAt order across roles", () => {
    const registry = new ViewportRegistry();
    registry.record(base("run-a", "b", { createdAt: 300 }));
    registry.record(base("run-a", "a", { createdAt: 100 }));
    registry.record(base("run-a", "c", { createdAt: 200 }));
    expect(registry.list("run-a").map((item) => item.role)).toEqual(["a", "c", "b"]);
  });

  it("prunes only stale exited records with an injected clock", () => {
    let now = 10_000;
    const registry = new ViewportRegistry({ clock: () => now });
    registry.record(base("run-a", "doneRole", { state: "exited", createdAt: 1_000, lastActiveAt: 1_000 }));
    registry.record(base("run-a", "freshDone", { state: "exited", createdAt: 9_900, lastActiveAt: 9_900 }));
    registry.record(base("run-a", "busy", { state: "running", createdAt: 1_000, lastActiveAt: 1_000 }));

    now = 20_000;
    const removed = registry.pruneByAge(60_000, now);
    expect(removed).toBe(0); // nothing older than 60s yet

    now = 62_000;
    expect(registry.pruneByAge(60_000, now)).toBe(1); // doneRole (created 1_000) is stale
    expect(registry.resolve("run-a", "doneRole")).toBeUndefined();
    expect(registry.resolve("run-a", "freshDone")).toBeDefined();
    expect(registry.resolve("run-a", "busy")).toBeDefined(); // running is never age-pruned
  });

  it("exposes attachTargets only for live, non-exited sessions", () => {
    const registry = new ViewportRegistry();
    registry.record(base("run-a", "alive", { pid: 100 }));
    registry.record(base("run-a", "noPid", {}));
    registry.record(base("run-a", "stopped", { pid: 101, state: "exited" }));
    const alive = (pid: number) => pid !== 101;
    expect(registry.attachTargets("run-a", alive).map((item) => item.role)).toEqual(["alive"]);
    expect(registry.attachTargets("run-a").map((item) => item.role)).toEqual(["alive"]);
  });

  it("removes one role or a whole run", () => {
    const registry = new ViewportRegistry();
    registry.record(base("run-a", "x", {}));
    registry.record(base("run-a", "y", {}));
    expect(registry.remove("run-a", "x")).toBe(1);
    expect(registry.count()).toBe(1);
    expect(registry.remove("run-a")).toBe(1);
    expect(registry.count()).toBe(0);
  });

  it("enforces the registry record cap", () => {
    const registry = new ViewportRegistry({ maxRecords: 3 });
    registry.record(base("r1", "a", {}));
    registry.record(base("r2", "b", {}));
    registry.record(base("r3", "c", {}));
    expect(() => registry.record(base("r4", "d", {}))).toThrow(RangeError);
    // updating an existing key is not a new record
    registry.record(base("r1", "a", { pid: 99 }));
    expect(registry.count()).toBe(3);
  });
});

describe("JsonViewportStorage durability", () => {
  it("round-trips records across registry instances (daemon restart)", () => {
    const dir = mkdtempSync(join(tmpdir(), "rf-viewport-"));
    const first = new ViewportRegistry({ storage: new JsonViewportStorage(dir), clock: () => 7_000 });
    first.record(base("run-a", "implementer", { pid: 123, createdAt: 1_000 }));
    first.record(base("run-a", "reviewer", { state: "idle", createdAt: 2_000 }));
    first.updateState("run-a", "implementer", "blocked");

    // Simulate client death: a fresh registry reads the same durable files.
    const second = new ViewportRegistry({ storage: new JsonViewportStorage(dir) });
    expect(second.resolve("run-a", "implementer")).toMatchObject({ pid: 123, state: "blocked", lastActiveAt: 7_000 });
    expect(second.resolve("run-a", "reviewer")).toMatchObject({ state: "idle" });
    expect(second.list("run-a")).toHaveLength(2);
    expect(second.storage.runs()).toEqual(["run-a"]);
  });

  it("writes atomically: no .tmp file remains and records are valid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "rf-viewport-atom-"));
    const registry = new ViewportRegistry({ storage: new JsonViewportStorage(dir) });
    registry.record(base("run-a", "worker", { pid: 7 }));
    const files = readFileSync(join(dir, "run-a.json"), "utf8");
    expect(JSON.parse(files)).toHaveLength(1);
    expect(registry.storage.runs().some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("ignores malformed fact files instead of crashing a client", () => {
    const dir = mkdtempSync(join(tmpdir(), "rf-viewport-bad-"));
    const storage = new JsonViewportStorage(dir);
    storage.put("run-a", [base("run-a", "worker", {}) as never]);
    const registry = new ViewportRegistry({ storage });
    expect(registry.resolve("run-a", "worker")).toBeDefined();

    // poison the file: a valid JSON array entry that fails shape validation
    writeFileSync(join(dir, "run-a.json"), JSON.stringify([{ runId: "run-a", role: "worker" }]));
    expect(registry.resolve("run-a", "worker")).toBeUndefined();
    expect(registry.storage.get("run-a")).toEqual([]);
  });
});

describe("registry bounds and defaults", () => {
  it("rejects a non-positive maxRecords", () => {
    expect(() => new ViewportRegistry({ maxRecords: 0 })).toThrow(TypeError);
  });

  it("defaults to in-memory storage and the documented cap", () => {
    const registry = new ViewportRegistry();
    expect(registry.storage).toBeInstanceOf(InMemoryViewportStorage);
    expect(registry.count()).toBe(0);
    expect(VIEWPORT_REGISTRY_MAX_RECORDS).toBe(10_000);
  });
});

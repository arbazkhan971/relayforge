import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ViewportRegistry } from "../src/viewport-registry.js";
import {
  markRunViewportsExited,
  openViewportRegistry,
  pruneRegistryViewports,
  recordOpenedViewport,
  resolveAttach,
  VIEWPORT_STALE_MAX_AGE_MS,
  VIEWPORT_STATE_DIR_NAME,
  viewportStateDir
} from "../src/viewport-wiring.js";

const RUNS = "/tmp/relayforge-projects/demo/.loop/runs";

describe("viewport-wiring (Phase 2)", () => {
  it("computes the per-run durable state dir under the run directory", () => {
    expect(viewportStateDir(RUNS, "run-abc123")).toBe(resolve(RUNS, "run-abc123", VIEWPORT_STATE_DIR_NAME));
    expect(VIEWPORT_STATE_DIR_NAME).toBe("viewports");
  });

  it("records a running fact per role for one opened viewport", () => {
    const registry = new ViewportRegistry();
    const recorded = recordOpenedViewport(registry, {
      runId: "run-abc123",
      roles: ["implementer", "reviewer"],
      session: "loop:demo:run-abc123:team",
      ownerPid: 4242,
      createdAt: 1_000
    });
    expect(recorded).toBe(2);
    expect(registry.resolve("run-abc123", "implementer")).toMatchObject({
      sessionName: "loop:demo:run-abc123:team",
      ownerPid: 4242,
      state: "running",
      createdAt: 1_000
    });
    expect(registry.resolve("run-abc123", "reviewer")?.sessionName).toBe("loop:demo:run-abc123:team");
  });

  it("resolves attach targets: role facts win, unknown args stay exact session names", () => {
    const registry = new ViewportRegistry();
    recordOpenedViewport(registry, {
      runId: "run-1",
      roles: ["implementer"],
      session: "loop:demo:run-1:team",
      ownerPid: 1,
      createdAt: 1
    });
    expect(resolveAttach(registry, { runId: "run-1", arg: "implementer", defaultSession: "fallback" })).toEqual({
      kind: "role",
      role: "implementer",
      session: "loop:demo:run-1:team"
    });
    // a session-shaped argument is used verbatim (legacy behavior)
    expect(resolveAttach(registry, { runId: "run-1", arg: "loop:demo:run-1:team", defaultSession: "fallback" })).toEqual({
      kind: "session",
      session: "loop:demo:run-1:team"
    });
    // an unknown argument is still attached as an exact tmux name (never silently dropped)
    expect(resolveAttach(registry, { runId: "run-1", arg: "some-other-session", defaultSession: "fallback" })).toEqual({
      kind: "session",
      session: "some-other-session"
    });
    // no argument → default team session
    expect(resolveAttach(registry, { runId: "run-1", defaultSession: "fallback" })).toEqual({ kind: "default", session: "fallback" });
  });

  it("marks every recorded session of a run exited, idempotently", () => {
    const registry = new ViewportRegistry({ clock: () => 5_000 });
    recordOpenedViewport(registry, { runId: "run-1", roles: ["a", "b"], session: "s", ownerPid: 1, createdAt: 1 });
    expect(markRunViewportsExited(registry, "run-1", 5_000)).toBe(2);
    expect(registry.resolve("run-1", "a")?.state).toBe("exited");
    expect(registry.resolve("run-1", "a")?.lastActiveAt).toBe(5_000);
    expect(markRunViewportsExited(registry, "run-1", 6_000)).toBe(0); // already exited
  });

  it("prunes only stale exited facts through the wiring helper", () => {
    const registry = new ViewportRegistry({ clock: () => 1_000_000 });
    recordOpenedViewport(registry, { runId: "run-1", roles: ["old", "fresh", "busy"], session: "s", ownerPid: 1, createdAt: 10 });
    registry.updateState("run-1", "old", "exited", 10);
    registry.updateState("run-1", "fresh", "exited", 999_900);
    // busy stays running; a RUNNING record is never age-pruned. maxAge=500s keeps
    // "fresh" (exited at 999_900) young enough and makes "old" (exited at 10) stale.
    expect(pruneRegistryViewports(registry, 500_000, 1_000_000)).toBe(1);
    expect(registry.resolve("run-1", "old")).toBeUndefined();
    expect(registry.resolve("run-1", "fresh")).toBeDefined();
    expect(registry.resolve("run-1", "busy")).toBeDefined();
  });

  it("round-trips through the JSON storage like the daemon restart path", () => {
    const dir = mkdtempSync(join(tmpdir(), "rf-viewport-wiring-"));
    const first = openViewportRegistry(resolve(dir, "runs"), "run-9");
    recordOpenedViewport(first, { runId: "run-9", roles: ["implementer"], session: "s", ownerPid: 2, createdAt: 1 });
    const second = openViewportRegistry(resolve(dir, "runs"), "run-9");
    expect(second.resolve("run-9", "implementer")?.sessionName).toBe("s");
    expect(second.list("run-9")).toHaveLength(1);
  });
});

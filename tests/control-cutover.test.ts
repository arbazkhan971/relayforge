import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addEvent,
  addMessage,
  addTask,
  BoardAuthorityError,
  boardPaths,
  CONTROL_AUTHORITY_MARKER_MAX_BYTES,
  controlAuthorityMarkerPath,
  foldBoard,
  initBoard,
  readControlAuthorityMarker,
  readMessages
} from "../src/board.js";
import {
  ControlCutoverError,
  cutoverControlAuthority,
  type ControlCutoverFaultPoint
} from "../src/control/cutover.js";
import { acquireRunLease } from "../src/runtime.js";
import { loadConfig } from "../src/config/load.js";
import { openControlStore } from "../src/control/store.js";
import { disposePreparedRun, finalLoopState, prepareRun, runAutonomyLoop, writeRolePrompts } from "../src/orchestrator.js";
import { setTrustedRunner } from "../src/sandbox.js";
import { setupRepo } from "./e2e-harness.js";
import { registerOwnedTemp } from "./global-teardown.js";

setTrustedRunner(true);

const RUN_ID = "run-cutover";
const RUN_EPOCH = "a".repeat(64);
const STARTED_AT = "2026-08-09T10:00:00.000Z";

function fixture(options: { task?: boolean; scopes?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "relayforge-cutover-"));
  registerOwnedTemp(root);
  const runDir = join(root, "run");
  const boardDir = join(runDir, "board");
  const statePath = join(runDir, ".loop_state.json");
  const scopesPath = join(runDir, ".loop_scopes");
  initBoard(boardDir);
  const state = {
    runId: RUN_ID,
    project: "demo",
    phase: "init" as const,
    status: "running" as const,
    iteration: 0,
    dispatched: 0,
    accepted: 0,
    rejected: 0,
    escalations: 0,
    repeatFailures: 0,
    unknownCostCalls: 0,
    startedAt: STARTED_AT,
    updatedAt: STARTED_AT
  };
  writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
  if (options.task) {
    addTask(boardDir, {
      id: "t1",
      title: "Implement",
      assignee: "worker",
      createdBy: "planner",
      description: "Implement the requested behavior",
      acceptanceCriteria: ["tests pass"],
      dependsOn: [],
      priority: 10,
      createdAt: STARTED_AT
    });
  }
  if (options.scopes !== undefined) writeFileSync(scopesPath, options.scopes, { mode: 0o600 });
  const lease = acquireRunLease(runDir);
  const input = {
    runDir,
    boardDir,
    statePath,
    scopesPath,
    runId: RUN_ID,
    runEpoch: RUN_EPOCH,
    controlOwnership: { assertHeld() {} },
    activeLeaseId: lease.nonce,
    initialState: { ...state, project: "demo" },
    startedBy: "planner",
    goal: "deliver",
    acknowledgeLegacyLoss: true,
    now: () => "2026-08-09T10:01:00.000Z"
  };
  return { root, runDir, boardDir, statePath, scopesPath, lease, input };
}

function legacyBytes(boardDir: string, statePath: string): Record<string, Buffer> {
  const paths = boardPaths(boardDir);
  return {
    tasks: readFileSync(paths.tasks),
    events: readFileSync(paths.events),
    messages: readFileSync(paths.messages),
    state: readFileSync(statePath)
  };
}

describe("P1 one-way control authority cutover", () => {
  it("bounds the pinned authority-marker read before allocation at exact/+1 bytes", () => {
    const item = fixture();
    const markerPath = controlAuthorityMarkerPath(item.boardDir);
    try {
      writeFileSync(markerPath, Buffer.alloc(CONTROL_AUTHORITY_MARKER_MAX_BYTES, 0x78), { mode: 0o600 });
      let exact: unknown;
      try { readControlAuthorityMarker(item.boardDir); } catch (error) { exact = error; }
      expect(exact).toBeInstanceOf(BoardAuthorityError);
      expect((exact as Error).message).not.toMatch(/exceeds/);

      writeFileSync(markerPath, Buffer.alloc(CONTROL_AUTHORITY_MARKER_MAX_BYTES + 1, 0x78), { mode: 0o600 });
      expect(() => readControlAuthorityMarker(item.boardDir)).toThrow(
        `control authority marker exceeds ${CONTROL_AUTHORITY_MARKER_MAX_BYTES} bytes`
      );
    } finally {
      item.lease.release();
    }
  });

  it("requires the configuration writer mutex in addition to the run lease", () => {
    const item = fixture();
    const { controlOwnership: _proof, ...withoutOwnership } = item.input;
    try {
      expect(() => cutoverControlAuthority(withoutOwnership as typeof item.input)).toThrow(/control ownership was not supplied/i);
      expect(() => statSync(join(item.runDir, "control.db"))).toThrow();
    } finally {
      item.lease.release();
    }
  });

  it("holds the configuration mutex before the run lease and releases both for a successor", () => {
    const { repoDir } = setupRepo();
    const loaded = loadConfig(join(repoDir, "loop.config.yaml"));
    const project = loaded.config.projects[0];
    const first = prepareRun(loaded, project, "control-owner-one", "First");
    const contendedRunDir = join(repoDir, ".loop", "runs", project.name, "control-owner-two");
    try {
      expect(() => prepareRun(loaded, project, "control-owner-two", "Second")).toThrow(/owns this configuration/i);
      // The outer mutex is acquired before mkdir/run lease, so the losing contender mutates no run.
      expect(() => statSync(contendedRunDir)).toThrow();
    } finally {
      disposePreparedRun(first);
    }
    const successor = prepareRun(loaded, project, "control-owner-two", "Second");
    disposePreparedRun(successor);
  });

  it("unwinds both prepared-run leases when prompt preparation fails before loop entry", () => {
    const { repoDir } = setupRepo();
    const loaded = loadConfig(join(repoDir, "loop.config.yaml"));
    const project = loaded.config.projects[0];
    const ctx = prepareRun(loaded, project, "prompt-refusal", "Fail safely");
    const originalName = project.roles[0]!.name;
    project.roles[0]!.name = "../escape";
    try {
      expect(() => writeRolePrompts(ctx)).toThrow();
    } finally {
      project.roles[0]!.name = originalName;
      disposePreparedRun(ctx);
    }
    const successor = prepareRun(loaded, project, "prompt-refusal", "Fail safely");
    disposePreparedRun(successor);
  });

  it("retains both lifetime leases when canonical handle closure is uncertain", () => {
    const { repoDir } = setupRepo();
    const loaded = loadConfig(join(repoDir, "loop.config.yaml"));
    const project = loaded.config.projects[0];
    const ctx = prepareRun(loaded, project, "close-uncertain", "Fail closed");
    const closeFailure = new Error("injected canonical close failure");
    ctx.controlAuthority = {
      marker: undefined as never,
      store: undefined as never,
      close: () => { throw closeFailure; }
    };

    expect(() => disposePreparedRun(ctx)).toThrow(closeFailure);
    expect(ctx.runLease).toBeDefined();
    expect(ctx.controlOwnership).toBeDefined();
    expect(() => prepareRun(loaded, project, "blocked-successor", "Must wait")).toThrow(/owns this configuration/i);

    // Test-only recovery after proving there was no actual store behind the injected handle.
    ctx.controlAuthority = undefined;
    disposePreparedRun(ctx);
    const successor = prepareRun(loaded, project, "blocked-successor", "Must wait");
    disposePreparedRun(successor);
  });

  it("makes a ControlAuthorityHandle close failure sticky instead of inferring retry success", () => {
    const item = fixture({ task: true });
    const injected = new Error("injected store-close uncertainty");
    let calls = 0;
    const authority = cutoverControlAuthority({
      ...item.input,
      closeStore: (store) => {
        calls += 1;
        store.close();
        throw injected;
      }
    });
    try {
      expect(() => authority.close()).toThrow(injected);
      expect(() => authority.close()).toThrow(injected);
      expect(calls).toBe(1);
    } finally {
      item.lease.release();
    }
  });

  it("makes run.checkpointed the sole loop-state authority for a complete autonomy loop", async () => {
    const { repoDir } = setupRepo();
    const loaded = loadConfig(join(repoDir, "loop.config.yaml"));
    const ctx = prepareRun(loaded, loaded.config.projects[0], "canonical-dry-run", "Plan the feature");
    expect(() => finalLoopState(ctx)).toThrow(/unavailable until runAutonomyLoop has finalized/i);
    const legacyBefore = readFileSync(ctx.statePath);
    writeRolePrompts(ctx);
    await runAutonomyLoop(ctx, {}, { execute: false });

    const finalState = finalLoopState(ctx);
    expect(finalState).toMatchObject({ status: "planned", phase: "complete" });
    finalState.status = "running";
    expect(finalLoopState(ctx).status).toBe("planned");

    const marker = readControlAuthorityMarker(ctx.boardDir)!;
    const store = openControlStore({
      path: join(ctx.runDir, marker.database),
      runId: ctx.runId,
      runEpoch: ctx.runNonce,
      create: false,
      integrityCheck: "full"
    });
    try {
      expect(store.getProjection().run).toMatchObject({
        status: "completed",
        checkpoint: { status: "planned", phase: "complete" }
      });
      expect(store.verifyIntegrity("full").headSeq).toBeGreaterThan(marker.cutoverHeadSeq);
    } finally {
      store.close();
    }
    expect(readFileSync(ctx.statePath)).toEqual(legacyBefore);
    expect(foldBoard(ctx.boardDir)).toEqual([expect.objectContaining({ id: "t1", status: "done" })]);
  });

  it("imports, receipt-verifies, archives exact legacy bytes, and routes compatibility APIs only through ControlStore", () => {
    const item = fixture({ task: true });
    const before = legacyBytes(item.boardDir, item.statePath);
    const authority = cutoverControlAuthority(item.input);
    try {
      const marker = readControlAuthorityMarker(item.boardDir)!;
      expect(marker.mode).toBe("legacy-import");
      expect(marker.legacy?.productCutoverAllowed).toBe(true);
      expect(marker.cutoverHeadSeq).toBe(marker.snapshotSeq);
      expect(marker.cutoverHeadSeq).toBe(marker.consumerLastSeq);
      expect(authority.store.verifyIntegrity("full").headSeq).toBe(marker.cutoverHeadSeq);

      addEvent(item.boardDir, { ts: "2026-08-09T10:02:00.000Z", role: "worker", taskId: "t1", status: "claimed" });
      addEvent(item.boardDir, { ts: "2026-08-09T10:03:00.000Z", role: "worker", taskId: "t1", status: "needs-review" });
      // A task-scoped message advances the aggregate but intentionally not TaskFact.version. The
      // following status must use the aggregate version, not the denormalized task field.
      addMessage(item.boardDir, { ts: "2026-08-09T10:04:00.000Z", from: "reviewer", to: "*", taskId: "t1", body: "merged" });
      addEvent(item.boardDir, { ts: "2026-08-09T10:05:00.000Z", role: "reviewer", taskId: "t1", status: "done", summary: "accepted" });
      expect(foldBoard(item.boardDir)[0]).toMatchObject({ id: "t1", status: "done", claimedBy: "worker", lastSummary: "accepted" });
      expect(readMessages(item.boardDir)).toEqual([expect.objectContaining({ from: "reviewer", body: "merged" })]);

      const after = legacyBytes(item.boardDir, item.statePath);
      expect(after).toEqual(before);
      const archive = join(item.runDir, "legacy-archives", marker.legacy!.archiveName);
      expect(readFileSync(join(archive, "tasks.jsonl"))).toEqual(before.tasks);
      expect(readFileSync(join(archive, "events.jsonl"))).toEqual(before.events);
      expect(readFileSync(join(archive, "messages.jsonl"))).toEqual(before.messages);
      expect(readFileSync(join(archive, ".loop_state.json"))).toEqual(before.state);
      expect(statSync(join(archive, "tasks.jsonl")).mode & 0o777).toBe(0o400);
    } finally {
      authority.close();
      item.lease.release();
    }

    // A reader can reconstruct the compatibility view after restart, but an unbound process can
    // never fall back to appending the retired JSONL file.
    expect(foldBoard(item.boardDir)[0]?.status).toBe("done");
    expect(() => addEvent(item.boardDir, { ts: "2026-08-09T10:06:00.000Z", role: "worker", taskId: "t1", status: "blocked" }))
      .toThrow(BoardAuthorityError);
  });

  it("refuses before database creation unless the exact live run lease and empty writer journal are proven", () => {
    const missingLease = fixture();
    missingLease.lease.release();
    expect(() => cutoverControlAuthority(missingLease.input)).toThrow(ControlCutoverError);
    expect(() => statSync(join(missingLease.runDir, "control.db"))).toThrow();

    const unresolved = fixture({ scopes: "cgroup2:1:loop-deadbeef:123\n" });
    try {
      expect(() => cutoverControlAuthority(unresolved.input)).toThrow(/writers are not proven stopped/i);
      expect(() => statSync(join(unresolved.runDir, "control.db"))).toThrow();
    } finally {
      unresolved.lease.release();
    }
  });

  it("requires an explicit acknowledgement for disclosed legacy loss", () => {
    const item = fixture({ task: true });
    try {
      expect(() => cutoverControlAuthority({ ...item.input, acknowledgeLegacyLoss: false })).toThrow(/requires explicit acknowledgement/i);
      expect(readControlAuthorityMarker(item.boardDir)).toBeUndefined();
      const recovered = cutoverControlAuthority(item.input);
      recovered.close();
    } finally {
      item.lease.release();
    }
  });

  for (const point of [
    "after-store-open",
    "after-import",
    "after-reopen-verification",
    "after-archive",
    "after-snapshot",
    "after-marker-publication"
  ] satisfies ControlCutoverFaultPoint[]) {
    it(`recovers idempotently from a crash boundary at ${point}`, () => {
      const item = fixture({ task: true });
      let fired = false;
      try {
        expect(() => cutoverControlAuthority({
          ...item.input,
          fault: (candidate) => {
            if (!fired && candidate === point) {
              fired = true;
              throw new Error(`crash:${point}`);
            }
          }
        })).toThrow(`crash:${point}`);
        const recovered = cutoverControlAuthority(item.input);
        try {
          expect(recovered.store.verifyIntegrity("full").headSeq).toBeGreaterThan(0);
          expect(foldBoard(item.boardDir).map((task) => task.id)).toEqual(["t1"]);
        } finally {
          recovered.close();
        }
      } finally {
        item.lease.release();
      }
    });
  }
});

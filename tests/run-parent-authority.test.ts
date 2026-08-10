import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";
import {
  disposePreparedRun,
  prepareRun,
  runAutonomyLoop,
  writeRolePrompts,
  type RunParentAuthorityContext
} from "../src/orchestrator.js";
import { setTrustedRunner } from "../src/sandbox.js";
import { setupRepo } from "./e2e-harness.js";

setTrustedRunner(true);

function prepared(runId: string) {
  const { repoDir } = setupRepo();
  const loaded = loadConfig(join(repoDir, "loop.config.yaml"));
  const project = loaded.config.projects[0]!;
  const ctx = prepareRun(loaded, project, runId, "Exercise the parent authority lifetime");
  writeRolePrompts(ctx);
  return { loaded, project, ctx };
}

describe("parent-owned run authority lifecycle", () => {
  it("starts only with recovered canonical authority and drains once before normal disposal", async () => {
    const { ctx } = prepared("parent-authority-normal");
    let borrowed: RunParentAuthorityContext | undefined;
    let closes = 0;

    await runAutonomyLoop(ctx, {}, {
      execute: false,
      startParentAuthority(context) {
        borrowed = context;
        expect(Object.isFrozen(context)).toBe(true);
        expect(context.store).toBe(ctx.controlAuthority?.store);
        expect(context.store.getProjection().run).toBeDefined();
        expect(ctx.runLease).toBeDefined();
        expect(ctx.controlOwnership).toBeDefined();
        return {
          async closeAndDrain() {
            closes += 1;
            // The store and both outer owners remain live for the entire drain.
            expect(ctx.controlAuthority?.store).toBe(context.store);
            expect(ctx.runLease).toBeDefined();
            expect(ctx.controlOwnership).toBeDefined();
            expect(context.store.head().headSeq).toBeGreaterThanOrEqual(0);
          }
        };
      }
    });

    expect(borrowed).toMatchObject({ runId: ctx.runId, runEpoch: ctx.runNonce, runDir: ctx.runDir });
    expect(closes).toBe(1);
    expect(ctx.controlAuthority).toBeUndefined();
    expect(ctx.runLease).toBeUndefined();
    expect(ctx.controlOwnership).toBeUndefined();
  });

  it("fails a start refusal through safe finalization while all owners are still held", async () => {
    const { ctx } = prepared("parent-authority-start-refusal");
    const refusal = new Error("parent authority startup refused");
    let starts = 0;

    await expect(runAutonomyLoop(ctx, {}, {
      execute: false,
      startParentAuthority(context) {
        starts += 1;
        expect(context.store).toBe(ctx.controlAuthority?.store);
        expect(ctx.runLease).toBeDefined();
        expect(ctx.controlOwnership).toBeDefined();
        throw refusal;
      }
    })).rejects.toBe(refusal);

    expect(starts).toBe(1);
    expect(ctx.controlAuthority).toBeUndefined();
    expect(ctx.runLease).toBeUndefined();
    expect(ctx.controlOwnership).toBeUndefined();
  });

  it("makes a drain rejection sticky and retains canonical authority plus both leases", async () => {
    const { loaded, project, ctx } = prepared("parent-authority-drain-refusal");
    const refusal = new Error("parent authority drain uncertain");
    let closes = 0;

    await expect(runAutonomyLoop(ctx, {}, {
      execute: false,
      startParentAuthority() {
        return {
          async closeAndDrain() {
            closes += 1;
            throw refusal;
          }
        };
      }
    })).rejects.toBe(refusal);

    // The error path re-enters finalization, but the external close operation is never retried.
    expect(closes).toBe(1);
    expect(ctx.controlAuthority).toBeDefined();
    expect(ctx.runLease).toBeDefined();
    expect(ctx.controlOwnership).toBeDefined();
    expect(() => prepareRun(loaded, project, "parent-authority-blocked-successor", "Must wait"))
      .toThrow(/owns this configuration/i);

    // Test-only cleanup: the injected handle owns no real resource despite reporting uncertainty.
    disposePreparedRun(ctx);
  });

  it("drains before closing canonical authority on the survivor path and retains outer leases", async () => {
    const { ctx } = prepared("parent-authority-survivor");
    const survivor = {
      async reap() { return false; },
      scopeId() { return "test survivor scope"; }
    };
    ctx.ownedScopes!.add(survivor as never);
    let closes = 0;

    await runAutonomyLoop(ctx, {}, {
      execute: false,
      startParentAuthority(context) {
        return {
          async closeAndDrain() {
            closes += 1;
            expect(ctx.controlAuthority?.store).toBe(context.store);
            expect(ctx.runLease).toBeDefined();
            expect(ctx.controlOwnership).toBeDefined();
          }
        };
      }
    });

    expect(closes).toBe(1);
    expect(ctx.controlAuthority).toBeUndefined();
    expect(ctx.runLease).toBeDefined();
    expect(ctx.controlOwnership).toBeDefined();

    ctx.ownedScopes!.delete(survivor as never);
    disposePreparedRun(ctx);
  });
});

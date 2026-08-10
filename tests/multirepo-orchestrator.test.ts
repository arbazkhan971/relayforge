import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";
import {
  disposePreparedRun,
  finalLoopState,
  prepareRun,
  runAutonomyLoop,
  writeRolePrompts,
  type RunMultiRepositoryAuthorityContext
} from "../src/orchestrator.js";
import { setTrustedRunner } from "../src/sandbox.js";
import { setupRepo } from "./e2e-harness.js";

setTrustedRunner(true);

function prepared(runId: string, repositories = true) {
  const { repoDir } = setupRepo();
  const loaded = loadConfig(join(repoDir, "loop.config.yaml"));
  const project = loaded.config.projects[0]!;
  // Prepare under the still-supported single-repository config, then exercise the defensive P6
  // route directly. Product config remains intentionally rejected until central P6 facts land.
  const ctx = prepareRun(loaded, project, runId, "Coordinate two repositories");
  if (repositories) {
    project.repositories.push(
      { name: "api", path: "api", role: "backend", defaultBranch: "main", protectedBranches: ["main"] },
      { name: "web", path: "web", role: "frontend", defaultBranch: "main", protectedBranches: ["main"] }
    );
    for (const role of project.roles) role.repositories = ["api", "web"];
  }
  writeRolePrompts(ctx);
  return { loaded, project, ctx };
}

const outcome = (context: RunMultiRepositoryAuthorityContext) => ({
  schemaVersion: 1 as const,
  runId: context.runId,
  runEpoch: context.runEpoch,
  planDigest: "a".repeat(64),
  state: "planned" as const,
  tasks: Object.freeze([{ taskId: "feature-one", taskGeneration: 1, state: "planned" as const }])
});

describe("multi-repository run authority boundary", () => {
  it("routes only through the borrowed exact store and drains once before releasing either outer lease", async () => {
    const { ctx } = prepared("multirepo-authority-success");
    let borrowed: RunMultiRepositoryAuthorityContext | undefined;
    let runs = 0;
    let closes = 0;
    await runAutonomyLoop(ctx, {}, {
      execute: false,
      startMultiRepositoryAuthority(context) {
        borrowed = context;
        expect(Object.isFrozen(context)).toBe(true);
        expect(context.store).toBe(ctx.controlAuthority?.store);
        expect(context.project.repositories.map((repository) => repository.name)).toEqual(["api", "web"]);
        return {
          async run() {
            runs += 1;
            expect(ctx.runLease).toBeDefined();
            expect(ctx.controlOwnership).toBeDefined();
            return outcome(context);
          },
          async closeAndDrain() {
            closes += 1;
            expect(ctx.controlAuthority?.store).toBe(context.store);
            expect(ctx.runLease).toBeDefined();
            expect(ctx.controlOwnership).toBeDefined();
          }
        };
      }
    });
    expect(borrowed).toMatchObject({ runId: ctx.runId, runEpoch: ctx.runNonce, execute: false });
    expect(runs).toBe(1);
    expect(closes).toBe(1);
    expect(ctx.target).toBeUndefined();
    expect(finalLoopState(ctx)).toMatchObject({ status: "planned", phase: "complete" });
    expect(ctx.controlAuthority).toBeUndefined();
    expect(ctx.runLease).toBeUndefined();
    expect(ctx.controlOwnership).toBeUndefined();
  });

  it("makes a P6 drain refusal sticky and retains the store plus both lifetime leases", async () => {
    const { loaded, project, ctx } = prepared("multirepo-drain-refusal");
    const refusal = new Error("P6 repository authority drain is uncertain");
    let closes = 0;
    await expect(runAutonomyLoop(ctx, {}, {
      execute: false,
      startMultiRepositoryAuthority(context) {
        return {
          async run() { return outcome(context); },
          async closeAndDrain() {
            closes += 1;
            throw refusal;
          }
        };
      }
    })).rejects.toBe(refusal);
    expect(closes).toBe(1);
    expect(ctx.controlAuthority).toBeDefined();
    expect(ctx.runLease).toBeDefined();
    expect(ctx.controlOwnership).toBeDefined();
    const repositories = project.repositories.splice(0);
    const roleScopes = project.roles.map((role) => [...role.repositories]);
    for (const role of project.roles) role.repositories = [];
    try {
      expect(() => prepareRun(loaded, project, "multirepo-blocked-successor", "must wait")).toThrow(/owns this configuration/i);
    } finally {
      project.repositories.push(...repositories);
      project.roles.forEach((role, index) => { role.repositories = roleScopes[index]!; });
    }

    // The injected handle owns no real repository mutex; release only after the assertion above.
    disposePreparedRun(ctx);
  });

  it("does not invoke the P6 hook for an omitted repositories field and preserves the legacy dry-run", async () => {
    const { ctx } = prepared("single-repository-compatibility", false);
    let starts = 0;
    await runAutonomyLoop(ctx, {}, {
      execute: false,
      startMultiRepositoryAuthority() {
        starts += 1;
        throw new Error("single-repository path must not start P6");
      }
    });
    expect(starts).toBe(0);
    expect(finalLoopState(ctx)).toMatchObject({ status: "planned", phase: "complete" });
  });
});

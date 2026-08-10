import { describe, expect, it } from "vitest";
import { materializeMultiRepositoryDag } from "../src/multirepo/dag.js";
import { materializeRepositoryRegistry } from "../src/multirepo/domain.js";

const registry = materializeRepositoryRegistry([
  { schemaVersion: 1, repositoryId: "api", configuredPath: "./api", defaultBranch: "main", protectedBranches: ["main"] },
  { schemaVersion: 1, repositoryId: "web", configuredPath: "./web", defaultBranch: "trunk", protectedBranches: ["trunk"] }
], (value) => ({ canonicalRoot: `/repos/${value.repositoryId}`, rootDevice: 1, rootInode: value.repositoryId === "api" ? 11 : 12, gitCommonDirDevice: 1, gitCommonDirInode: value.repositoryId === "api" ? 21 : 22 }));
const task = (taskId: string, dependencies: string[] = [], repositoryIds = ["api"]) => ({ schemaVersion: 1 as const, taskId, taskGeneration: 1, roleId: "engineer", providerId: "codex", repositoryIds, dependencies });

describe("multi-repository task DAG", () => {
  it("produces deterministic lexical layers independent of input order", () => {
    const first = materializeMultiRepositoryDag(registry, [task("deploy", ["api-task", "web-task"], ["api", "web"]), task("web-task", [], ["web"]), task("api-task")]);
    const second = materializeMultiRepositoryDag(registry, [task("api-task"), task("deploy", ["api-task", "web-task"], ["api", "web"]), task("web-task", [], ["web"])]);
    expect(first.order).toEqual(["api-task", "web-task", "deploy"]);
    expect(first.layers).toEqual([["api-task", "web-task"], ["deploy"]]);
    expect(second.order).toEqual(first.order);
    expect(first.depthByTask).toEqual({ "api-task": 0, "web-task": 0, deploy: 1 });
  });

  it("rejects duplicates, missing dependencies, self cycles, and multi-node cycles", () => {
    expect(() => materializeMultiRepositoryDag(registry, [task("one"), task("one")])).toThrowError(expect.objectContaining({ code: "DUPLICATE_TASK" }));
    expect(() => materializeMultiRepositoryDag(registry, [task("one", ["missing"])])).toThrowError(expect.objectContaining({ code: "UNKNOWN_DEPENDENCY" }));
    expect(() => materializeMultiRepositoryDag(registry, [task("one", ["one"])])).toThrowError(expect.objectContaining({ code: "CYCLE" }));
    expect(() => materializeMultiRepositoryDag(registry, [task("one", ["two"]), task("two", ["one"])])).toThrowError(expect.objectContaining({ code: "CYCLE" }));
  });

  it("rejects duplicate dependencies, repository scope errors, and empty graphs before authority", () => {
    expect(() => materializeMultiRepositoryDag(registry, [])).toThrowError(expect.objectContaining({ code: "GRAPH_LIMIT" }));
    expect(() => materializeMultiRepositoryDag(registry, [task("one", ["two", "two"]), task("two")])).toThrowError(expect.objectContaining({ code: "DUPLICATE_DEPENDENCY" }));
    expect(() => materializeMultiRepositoryDag(registry, [task("one", [], ["missing"])])).toThrowError(expect.objectContaining({ code: "UNKNOWN_REPOSITORY" }));
  });

  it("records reverse dependents and repository-set identity", () => {
    const value = materializeMultiRepositoryDag(registry, [task("base"), task("left", ["base"]), task("right", ["base"], ["web"])]);
    expect(value.dependents.base).toEqual(["left", "right"]);
    expect(value.tasks.every((item) => /^[a-f0-9]{64}$/u.test(item.repositorySet.repositorySetId))).toBe(true);
    expect(value.edgeCount).toBe(2);
  });
});

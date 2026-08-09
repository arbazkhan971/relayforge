import { z } from "zod";
import { isValidId } from "../ids.js";
import { MULTIREPO_LIMITS, materializeRepositorySet, type RepositoryRegistryV1, type RepositorySetV1 } from "./domain.js";

const CanonicalId = z.string().refine(isValidId, "invalid canonical identifier");
export const MultiRepositoryTaskV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  taskId: CanonicalId,
  taskGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  roleId: CanonicalId,
  providerId: CanonicalId,
  repositoryIds: z.array(CanonicalId).min(1).max(MULTIREPO_LIMITS.maximumRepositoriesPerTask),
  dependencies: z.array(CanonicalId).max(MULTIREPO_LIMITS.maximumDependenciesPerTask)
});

type ParsedMultiRepositoryTaskV1 = z.infer<typeof MultiRepositoryTaskV1Schema>;
export type MultiRepositoryTaskV1 = Readonly<
  Omit<ParsedMultiRepositoryTaskV1, "repositoryIds" | "dependencies"> & {
    repositoryIds: readonly string[];
    dependencies: readonly string[];
  }
>;
export type MaterializedMultiRepositoryTaskV1 = Readonly<MultiRepositoryTaskV1 & { repositorySet: RepositorySetV1 }>;

export type MultiRepositoryDagV1 = Readonly<{
  schemaVersion: 1;
  tasks: readonly MaterializedMultiRepositoryTaskV1[];
  order: readonly string[];
  layers: readonly (readonly string[])[];
  dependents: Readonly<Record<string, readonly string[]>>;
  depthByTask: Readonly<Record<string, number>>;
  edgeCount: number;
}>;

export type MultiRepositoryDagErrorCode = "INVALID_TASK" | "DUPLICATE_TASK" | "UNKNOWN_DEPENDENCY" | "DUPLICATE_DEPENDENCY" | "CYCLE" | "GRAPH_LIMIT";
export class MultiRepositoryDagError extends Error {
  constructor(readonly code: MultiRepositoryDagErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "MultiRepositoryDagError";
  }
}

/** Validate the complete graph before any lease, worktree, provider, or budget operation. */
export function materializeMultiRepositoryDag(registry: RepositoryRegistryV1, rawTasks: readonly unknown[]): MultiRepositoryDagV1 {
  if (!Array.isArray(rawTasks) || rawTasks.length < 1 || rawTasks.length > MULTIREPO_LIMITS.maximumTasks) {
    throw new MultiRepositoryDagError("GRAPH_LIMIT", "task graph is empty or exceeds its task bound");
  }
  const tasks: MaterializedMultiRepositoryTaskV1[] = [];
  const byId = new Map<string, MaterializedMultiRepositoryTaskV1>();
  let edgeCount = 0;
  for (const raw of rawTasks) {
    const parsed = MultiRepositoryTaskV1Schema.safeParse(raw);
    if (!parsed.success) throw new MultiRepositoryDagError("INVALID_TASK", parsed.error.issues[0]?.message ?? "task is invalid");
    if (byId.has(parsed.data.taskId)) throw new MultiRepositoryDagError("DUPLICATE_TASK", `duplicate task ${parsed.data.taskId}`);
    if (new Set(parsed.data.dependencies).size !== parsed.data.dependencies.length) throw new MultiRepositoryDagError("DUPLICATE_DEPENDENCY", `task ${parsed.data.taskId} repeats a dependency`);
    if (new Set(parsed.data.repositoryIds).size !== parsed.data.repositoryIds.length) throw new MultiRepositoryDagError("INVALID_TASK", `task ${parsed.data.taskId} repeats a repository`);
    const task = Object.freeze({
      ...parsed.data,
      repositoryIds: Object.freeze([...parsed.data.repositoryIds]),
      dependencies: Object.freeze([...parsed.data.dependencies]),
      repositorySet: materializeRepositorySet(registry, parsed.data.repositoryIds)
    });
    tasks.push(task);
    byId.set(task.taskId, task);
    edgeCount += task.dependencies.length;
    if (edgeCount > MULTIREPO_LIMITS.maximumDependencies) throw new MultiRepositoryDagError("GRAPH_LIMIT", "task graph exceeds its edge bound");
  }
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (dependency === task.taskId) throw new MultiRepositoryDagError("CYCLE", `task ${task.taskId} depends on itself`);
      if (!byId.has(dependency)) throw new MultiRepositoryDagError("UNKNOWN_DEPENDENCY", `task ${task.taskId} references unknown dependency ${dependency}`);
    }
  }

  const indegree = new Map(tasks.map((task) => [task.taskId, task.dependencies.length]));
  const mutableDependents = new Map(tasks.map((task) => [task.taskId, [] as string[]]));
  for (const task of tasks) for (const dependency of task.dependencies) mutableDependents.get(dependency)!.push(task.taskId);
  for (const values of mutableDependents.values()) values.sort((left, right) => left.localeCompare(right));
  let ready = tasks.filter((task) => task.dependencies.length === 0).map((task) => task.taskId).sort((left, right) => left.localeCompare(right));
  const order: string[] = [];
  const layers: string[][] = [];
  const depthByTask: Record<string, number> = Object.create(null) as Record<string, number>;
  while (ready.length > 0) {
    const layer = ready;
    layers.push(layer);
    ready = [];
    for (const taskId of layer) {
      order.push(taskId);
      const task = byId.get(taskId)!;
      const depth = task.dependencies.length === 0 ? 0 : Math.max(...task.dependencies.map((id) => depthByTask[id]!)) + 1;
      if (depth > MULTIREPO_LIMITS.maximumGraphDepth) throw new MultiRepositoryDagError("GRAPH_LIMIT", `task ${taskId} exceeds graph depth bound`);
      depthByTask[taskId] = depth;
      for (const dependent of mutableDependents.get(taskId)!) {
        const next = indegree.get(dependent)! - 1;
        indegree.set(dependent, next);
        if (next === 0) ready.push(dependent);
      }
    }
    ready.sort((left, right) => left.localeCompare(right));
  }
  if (order.length !== tasks.length) {
    const blocked = tasks.map((task) => task.taskId).filter((id) => !order.includes(id)).sort((left, right) => left.localeCompare(right));
    throw new MultiRepositoryDagError("CYCLE", `task graph contains a cycle involving ${blocked.join(",")}`);
  }
  const dependents = Object.freeze(Object.fromEntries([...mutableDependents.entries()].map(([id, values]) => [id, Object.freeze(values)])));
  return Object.freeze({
    schemaVersion: 1,
    tasks: Object.freeze([...tasks].sort((left, right) => left.taskId.localeCompare(right.taskId))),
    order: Object.freeze(order),
    layers: Object.freeze(layers.map((layer) => Object.freeze(layer))),
    dependents,
    depthByTask: Object.freeze({ ...depthByTask }),
    edgeCount
  });
}

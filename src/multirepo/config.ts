import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ProjectConfig } from "../config/schema.js";
import { runGit } from "../git.js";
import {
  materializeRepositoryRegistry,
  type RepositoryDefinitionV1,
  type RepositoryIdentityProbe,
  type RepositoryRegistryV1
} from "./domain.js";

export class MultiRepositoryConfigError extends Error {
  readonly code = "INVALID_REPOSITORY_CONFIGURATION" as const;
  constructor(message: string, options?: ErrorOptions) {
    super(`${"INVALID_REPOSITORY_CONFIGURATION"}: ${message}`, options);
    this.name = "MultiRepositoryConfigError";
  }
}

function exactDirectory(path: string, label: string): Readonly<{ path: string; device: number; inode: number }> {
  const absolute = resolve(path);
  let canonical: string;
  try {
    canonical = realpathSync.native(absolute);
  } catch (error) {
    throw new MultiRepositoryConfigError(`${label} cannot be resolved`, { cause: error });
  }
  if (canonical !== absolute) throw new MultiRepositoryConfigError(`${label} traverses a symlink or non-canonical alias (${absolute} -> ${canonical})`);
  const stat = lstatSync(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new MultiRepositoryConfigError(`${label} is not a physical directory`);
  return Object.freeze({ path: canonical, device: stat.dev, inode: stat.ino });
}

export function configuredRepositoryDefinitions(project: ProjectConfig): readonly RepositoryDefinitionV1[] {
  return project.repositories.map((repository) => ({
    schemaVersion: 1 as const,
    repositoryId: repository.name,
    configuredPath: repository.path,
    defaultBranch: repository.defaultBranch,
    protectedBranches: [...repository.protectedBranches]
  }));
}

/** Read-only exact Git identity probe shared by semantic preflight and the run factory. */
export function probeConfiguredRepositoryIdentity(
  configRoot: string,
  definition: RepositoryDefinitionV1
): RepositoryIdentityProbe {
  const candidate = isAbsolute(definition.configuredPath)
    ? definition.configuredPath
    : resolve(configRoot, definition.configuredPath);
  const root = exactDirectory(candidate, `repository ${definition.repositoryId} root`);
  const top = runGit(root.path, ["rev-parse", "--path-format=absolute", "--show-toplevel"]);
  if (!top.ok || resolve(top.out) !== root.path) {
    throw new MultiRepositoryConfigError(`repository ${definition.repositoryId} path is not its exact Git worktree root`);
  }
  const commonResult = runGit(root.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!commonResult.ok || !isAbsolute(commonResult.out)) {
    throw new MultiRepositoryConfigError(`repository ${definition.repositoryId} Git common directory cannot be resolved`);
  }
  const common = exactDirectory(commonResult.out, `repository ${definition.repositoryId} Git common directory`);
  const defaultRef = runGit(root.path, ["show-ref", "--verify", "--hash", `refs/heads/${definition.defaultBranch}`]);
  if (!defaultRef.ok || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(defaultRef.out)) {
    throw new MultiRepositoryConfigError(`repository ${definition.repositoryId} default branch ${definition.defaultBranch} is absent or ambiguous`);
  }
  return Object.freeze({
    canonicalRoot: root.path,
    rootDevice: root.device,
    rootInode: root.inode,
    gitCommonDirDevice: common.device,
    gitCommonDirInode: common.inode
  });
}

/**
 * Resolve the complete explicit registry without mutation. Alias/common-dir/nesting checks are
 * delegated to the shared domain materializer so config validation and execution cannot drift.
 */
export function materializeConfiguredRepositoryRegistry(
  configRoot: string,
  project: ProjectConfig
): RepositoryRegistryV1 {
  const definitions = configuredRepositoryDefinitions(project);
  try {
    return materializeRepositoryRegistry(
      definitions,
      (definition) => probeConfiguredRepositoryIdentity(configRoot, definition)
    );
  } catch (error) {
    if (error instanceof MultiRepositoryConfigError) throw error;
    throw new MultiRepositoryConfigError(error instanceof Error ? error.message : "repository registry is invalid", { cause: error });
  }
}

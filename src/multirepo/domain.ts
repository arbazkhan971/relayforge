import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { isValidId } from "../ids.js";

export const MULTIREPO_SCHEMA_VERSION = 1 as const;
export const MULTIREPO_LIMITS = Object.freeze({
  maximumRepositories: 64,
  maximumRepositoriesPerTask: 32,
  maximumTasks: 4_096,
  maximumDependencies: 16_384,
  maximumDependenciesPerTask: 256,
  maximumGraphDepth: 256,
  maximumRefBytes: 512,
  maximumPathBytes: 4_096
});

const CanonicalId = z.string().refine(isValidId, "invalid canonical identifier");
const forbiddenRefScalars = new Set(["~", "^", ":", "?", "*", "[", "]", "\\"]);
const GitRef = z.string().min(1).max(MULTIREPO_LIMITS.maximumRefBytes).refine((value) =>
  !value.startsWith("-") && !value.startsWith("/") && !value.endsWith("/") && !value.endsWith(".") &&
  !value.includes("..") && !value.includes("@{") && !/[\u0000-\u0020\u007f]/u.test(value) &&
  ![...value].some((scalar) => forbiddenRefScalars.has(scalar)),
"invalid Git ref");

export const RepositoryDefinitionV1Schema = z.strictObject({
  schemaVersion: z.literal(MULTIREPO_SCHEMA_VERSION),
  repositoryId: CanonicalId,
  configuredPath: z.string().min(1).max(MULTIREPO_LIMITS.maximumPathBytes),
  defaultBranch: GitRef,
  protectedBranches: z.array(GitRef).max(64).refine((value) => new Set(value).size === value.length, "duplicate protected branch")
});

export const RepositoryIdentityV1Schema = z.strictObject({
  schemaVersion: z.literal(MULTIREPO_SCHEMA_VERSION),
  repositoryId: CanonicalId,
  canonicalRoot: z.string().min(1).max(MULTIREPO_LIMITS.maximumPathBytes),
  rootDevice: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  rootInode: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  gitCommonDirDevice: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  gitCommonDirInode: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  defaultBranch: GitRef,
  protectedBranches: z.array(GitRef).max(64)
});

export type RepositoryDefinitionV1 = z.infer<typeof RepositoryDefinitionV1Schema>;
type ParsedRepositoryIdentityV1 = z.infer<typeof RepositoryIdentityV1Schema>;
export type RepositoryIdentityV1 = Readonly<
  Omit<ParsedRepositoryIdentityV1, "protectedBranches"> & { protectedBranches: readonly string[] }
>;

export type RepositoryIdentityProbe = Readonly<{
  canonicalRoot: string;
  rootDevice: number;
  rootInode: number;
  gitCommonDirDevice: number;
  gitCommonDirInode: number;
}>;

export type RepositoryIdentityResolver = (definition: RepositoryDefinitionV1) => RepositoryIdentityProbe;

export type RepositoryRegistryV1 = Readonly<{
  schemaVersion: typeof MULTIREPO_SCHEMA_VERSION;
  repositories: readonly RepositoryIdentityV1[];
}>;

export type RepositorySetV1 = Readonly<{
  schemaVersion: typeof MULTIREPO_SCHEMA_VERSION;
  repositoryIds: readonly string[];
  repositorySetId: string;
}>;

export type MultiRepositoryDomainErrorCode =
  | "INVALID_REPOSITORY"
  | "DUPLICATE_REPOSITORY"
  | "PHYSICAL_ALIAS"
  | "NESTED_REPOSITORY"
  | "UNKNOWN_REPOSITORY"
  | "INVALID_REPOSITORY_SET"
  | "SCOPE_EXCEEDED";

export class MultiRepositoryDomainError extends Error {
  constructor(readonly code: MultiRepositoryDomainErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "MultiRepositoryDomainError";
  }
}

function physicalKey(device: number, inode: number): string { return `${device}:${inode}`; }

function isNested(left: string, right: string): boolean {
  const relation = relative(left, right);
  return relation !== "" && relation !== "." && !relation.startsWith("..") && !isAbsolute(relation);
}

/** Materialize a bounded registry from parent-probed physical identities. No ambient scan occurs. */
export function materializeRepositoryRegistry(
  definitions: readonly unknown[],
  resolveIdentity: RepositoryIdentityResolver
): RepositoryRegistryV1 {
  if (!Array.isArray(definitions) || definitions.length < 1 || definitions.length > MULTIREPO_LIMITS.maximumRepositories) {
    throw new MultiRepositoryDomainError("INVALID_REPOSITORY", "repository registry is empty or exceeds its bound");
  }
  const identities: RepositoryIdentityV1[] = [];
  const ids = new Set<string>();
  const rootIdentities = new Set<string>();
  const commonDirIdentities = new Set<string>();
  for (const raw of definitions) {
    const parsed = RepositoryDefinitionV1Schema.safeParse(raw);
    if (!parsed.success) throw new MultiRepositoryDomainError("INVALID_REPOSITORY", parsed.error.issues[0]?.message ?? "invalid repository");
    const definition = parsed.data;
    if (ids.has(definition.repositoryId)) throw new MultiRepositoryDomainError("DUPLICATE_REPOSITORY", `duplicate repository ${definition.repositoryId}`);
    ids.add(definition.repositoryId);
    let probe: RepositoryIdentityProbe;
    try { probe = resolveIdentity(definition); }
    catch (error) { throw new MultiRepositoryDomainError("INVALID_REPOSITORY", `identity probe failed for ${definition.repositoryId}: ${error instanceof Error ? error.message : "unknown failure"}`); }
    const candidate = RepositoryIdentityV1Schema.safeParse({
      schemaVersion: 1,
      repositoryId: definition.repositoryId,
      canonicalRoot: resolve(probe.canonicalRoot),
      rootDevice: probe.rootDevice,
      rootInode: probe.rootInode,
      gitCommonDirDevice: probe.gitCommonDirDevice,
      gitCommonDirInode: probe.gitCommonDirInode,
      defaultBranch: definition.defaultBranch,
      protectedBranches: definition.protectedBranches
    });
    if (!candidate.success || !isAbsolute(probe.canonicalRoot)) {
      throw new MultiRepositoryDomainError("INVALID_REPOSITORY", `invalid physical identity for ${definition.repositoryId}`);
    }
    const rootKey = physicalKey(candidate.data.rootDevice, candidate.data.rootInode);
    const commonKey = physicalKey(candidate.data.gitCommonDirDevice, candidate.data.gitCommonDirInode);
    if (rootIdentities.has(rootKey) || commonDirIdentities.has(commonKey) || identities.some((item) => item.canonicalRoot === candidate.data.canonicalRoot)) {
      throw new MultiRepositoryDomainError("PHYSICAL_ALIAS", `repository ${definition.repositoryId} aliases an existing physical repository`);
    }
    for (const existing of identities) {
      if (isNested(existing.canonicalRoot, candidate.data.canonicalRoot) || isNested(candidate.data.canonicalRoot, existing.canonicalRoot)) {
        throw new MultiRepositoryDomainError("NESTED_REPOSITORY", `repository ${definition.repositoryId} is nested with ${existing.repositoryId}`);
      }
    }
    rootIdentities.add(rootKey);
    commonDirIdentities.add(commonKey);
    identities.push(Object.freeze({ ...candidate.data, protectedBranches: Object.freeze([...candidate.data.protectedBranches]) }));
  }
  return Object.freeze({ schemaVersion: 1, repositories: Object.freeze(identities.sort((left, right) => left.repositoryId.localeCompare(right.repositoryId))) });
}

function repositorySetPayload(identities: readonly RepositoryIdentityV1[]): string {
  return JSON.stringify(identities.map((item) => [item.repositoryId, item.defaultBranch, [...item.protectedBranches].sort()]));
}

/** Preserve task-declared order while binding the digest to immutable configured base policy. */
export function materializeRepositorySet(registry: RepositoryRegistryV1, repositoryIds: readonly string[]): RepositorySetV1 {
  if (!Array.isArray(repositoryIds) || repositoryIds.length < 1 || repositoryIds.length > MULTIREPO_LIMITS.maximumRepositoriesPerTask || new Set(repositoryIds).size !== repositoryIds.length) {
    throw new MultiRepositoryDomainError("INVALID_REPOSITORY_SET", "repository set is empty, duplicated, or exceeds its bound");
  }
  const byId = new Map(registry.repositories.map((item) => [item.repositoryId, item]));
  const selected = repositoryIds.map((id) => {
    if (!isValidId(id)) throw new MultiRepositoryDomainError("INVALID_REPOSITORY_SET", "repository set contains an invalid identifier");
    const identity = byId.get(id);
    if (identity === undefined) throw new MultiRepositoryDomainError("UNKNOWN_REPOSITORY", `unknown repository ${id}`);
    return identity;
  });
  const repositorySetId = createHash("sha256")
    .update("relayforge-repository-set-v1\0", "utf8")
    .update(repositorySetPayload(selected), "utf8")
    .digest("hex");
  return Object.freeze({ schemaVersion: 1, repositoryIds: Object.freeze([...repositoryIds]), repositorySetId });
}

export type RepositoryCapabilityScope = Readonly<{ repositoryIds: readonly string[] }>;

export function assertRepositoryScope(
  requested: RepositorySetV1,
  role: RepositoryCapabilityScope,
  provider: RepositoryCapabilityScope
): void {
  const roleIds = new Set(role.repositoryIds);
  const providerIds = new Set(provider.repositoryIds);
  for (const id of requested.repositoryIds) {
    if (!roleIds.has(id) || !providerIds.has(id)) {
      throw new MultiRepositoryDomainError("SCOPE_EXCEEDED", `repository ${id} is outside role or provider capability`);
    }
  }
}

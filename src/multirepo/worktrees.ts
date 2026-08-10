import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { runGit } from "../git.js";
import { isValidId } from "../ids.js";
import {
  inspectProvisioning,
  provisionWorktree,
  validateProvisionSpecs,
  type ProvisionEntrySummary,
  type ProvisionIssue,
  type ProvisionSpec
} from "../provision.js";
import {
  MULTIREPO_LIMITS,
  MULTIREPO_SCHEMA_VERSION,
  RepositoryIdentityV1Schema,
  materializeRepositorySet,
  type RepositoryIdentityV1,
  type RepositorySetV1
} from "./domain.js";

export const WORKTREE_GROUP_SCHEMA_VERSION = 1 as const;
export const WORKTREE_GROUP_RECEIPT_LEAF = ".relayforge-worktree-group-v1.json" as const;
export const WORKTREE_GROUP_MAX_RECEIPT_BYTES = 1024 * 1024;

const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const LEASE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;
const MAX_ISSUES = 128;
const MAX_DIAGNOSTIC_BYTES = 2_048;

export const worktreeGroupStates = [
  "creating",
  "ready",
  "rolling_back",
  "reclaiming",
  "recovery_required",
  "reclaimed"
] as const;
export type WorktreeGroupState = (typeof worktreeGroupStates)[number];

export const worktreeGroupEntryStates = [
  "planned",
  "created",
  "provisioned",
  "ready",
  "reclaiming",
  "preserved",
  "recovery_required",
  "reclaimed"
] as const;
export type WorktreeGroupEntryState = (typeof worktreeGroupEntryStates)[number];

export const worktreeGroupIssueCodes = [
  "INVALID_PLAN",
  "IDENTITY_MISMATCH",
  "SOURCE_DIRTY",
  "ANCHOR_MOVED",
  "BRANCH_CONFLICT",
  "CREATE_FAILED",
  "PROVISION_FAILED",
  "DESTINATION_REPLACED",
  "REGISTRATION_MISMATCH",
  "WORKTREE_DIRTY",
  "WORKTREE_LOCKED",
  "WORKTREE_STALE",
  "GIT_UNCERTAIN",
  "RECEIPT_CORRUPT",
  "RECEIPT_MISMATCH",
  "CLEANUP_FAILED",
  "RECOVERY_REQUIRED"
] as const;
export type WorktreeGroupIssueCode = (typeof worktreeGroupIssueCodes)[number];

export type WorktreeGroupAuthority = Readonly<{
  taskId: string;
  taskGeneration: number;
  attemptId: string;
  leaseToken: string;
}>;

export type WorktreeGroupRepositoryPlan = Readonly<{
  repository: RepositoryIdentityV1;
  /** A new, group-owned local branch. Existing refs are always refused. */
  branch: string;
  /** Copied transactionally from the configured repository into this member before readiness. */
  provision?: readonly ProvisionSpec[];
}>;

export type WorktreeGroupFaultPoint =
  | "after-initial-receipt"
  | "before-create"
  | "after-worktree-add"
  | "after-created-receipt"
  | "before-provision"
  | "after-provision"
  | "after-provisioned-receipt"
  | "before-ready"
  | "after-ready-receipt"
  | "before-cleanup-entry"
  | "after-worktree-remove"
  | "after-cleanup-entry";

export type WorktreeGroupOptions = Readonly<{
  groupId: string;
  groupRoot: string;
  repositorySet: RepositorySetV1;
  authority: WorktreeGroupAuthority;
  entries: readonly WorktreeGroupRepositoryPlan[];
  now?: () => Date;
  fault?: (point: WorktreeGroupFaultPoint, repositoryId?: string) => void;
}>;

export type WorktreeGroupIssue = Readonly<{
  code: WorktreeGroupIssueCode;
  repositoryId?: string;
  message: string;
}>;

export type WorktreeGroupReceiptEntry = Readonly<{
  repository: RepositoryIdentityV1;
  destination: string;
  branch: string;
  branchRef: string;
  anchorOid: string;
  state: WorktreeGroupEntryState;
  provision: readonly ProvisionSpec[];
  provisioned: readonly ProvisionEntrySummary[];
  destinationDevice?: number;
  destinationInode?: number;
  gitFileDevice?: number;
  gitFileInode?: number;
  observedHead?: string;
  diagnostic?: string;
}>;

export type WorktreeGroupReceipt = Readonly<{
  schemaVersion: typeof WORKTREE_GROUP_SCHEMA_VERSION;
  groupId: string;
  groupRoot: string;
  groupRootDevice: number;
  groupRootInode: number;
  ownershipNonce: string;
  repositorySetId: string;
  repositoryIds: readonly string[];
  authority: WorktreeGroupAuthority;
  requestDigest: string;
  state: WorktreeGroupState;
  cleanupKind?: "rollback" | "reclaim";
  entries: readonly WorktreeGroupReceiptEntry[];
  issues: readonly WorktreeGroupIssue[];
  createdAt: string;
  updatedAt: string;
  receiptDigest: string;
}>;

export type ReadyWorktreeGroupMember = Readonly<{
  repositoryId: string;
  sourceRoot: string;
  path: string;
  branch: string;
  anchorOid: string;
  headOid: string;
}>;

export type WorktreeGroupResult = Readonly<{
  status: "ready" | "recovery_required" | "reclaimed";
  receipt: WorktreeGroupReceipt;
  members: readonly ReadyWorktreeGroupMember[];
  issues: readonly WorktreeGroupIssue[];
}>;

export class WorktreeGroupError extends Error {
  constructor(
    readonly code: WorktreeGroupIssueCode,
    message: string,
    readonly repositoryId?: string,
    options?: ErrorOptions
  ) {
    super(`${code}: ${message}`, options);
    this.name = "WorktreeGroupError";
  }
}

/** Test-only crash seam: unlike an ordinary failure, this deliberately leaves durable state for restart. */
export class WorktreeGroupInterruptedError extends Error {
  constructor(message = "simulated worktree-group interruption") {
    super(message);
    this.name = "WorktreeGroupInterruptedError";
  }
}

const provisionSpecSchema = z.strictObject({
  path: z.string().min(1),
  requiredExecutables: z.array(z.string().min(1)).optional()
});

const authoritySchema = z.strictObject({
  taskId: z.string().refine(isValidId),
  taskGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  attemptId: z.string().refine(isValidId),
  leaseToken: z.string().regex(LEASE_TOKEN_PATTERN)
});

const issueSchema = z.strictObject({
  code: z.enum(worktreeGroupIssueCodes),
  repositoryId: z.string().refine(isValidId).optional(),
  message: z.string().min(1).max(MAX_DIAGNOSTIC_BYTES)
});

const receiptEntrySchema = z.strictObject({
  repository: RepositoryIdentityV1Schema,
  destination: z.string().min(1).max(MULTIREPO_LIMITS.maximumPathBytes),
  branch: z.string().min(1).max(MULTIREPO_LIMITS.maximumRefBytes),
  branchRef: z.string().min(1).max(MULTIREPO_LIMITS.maximumRefBytes + 11),
  anchorOid: z.string().regex(OID_PATTERN),
  state: z.enum(worktreeGroupEntryStates),
  provision: z.array(provisionSpecSchema).max(32),
  provisioned: z.array(z.strictObject({
    path: z.string(),
    files: z.number().int().nonnegative(),
    directories: z.number().int().nonnegative(),
    symlinks: z.number().int().nonnegative(),
    executables: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative()
  })).max(32),
  destinationDevice: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  destinationInode: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  gitFileDevice: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  gitFileInode: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  observedHead: z.string().regex(OID_PATTERN).optional(),
  diagnostic: z.string().min(1).max(MAX_DIAGNOSTIC_BYTES).optional()
});

const receiptSchema = z.strictObject({
  schemaVersion: z.literal(WORKTREE_GROUP_SCHEMA_VERSION),
  groupId: z.string().refine(isValidId),
  groupRoot: z.string().min(1).max(MULTIREPO_LIMITS.maximumPathBytes),
  groupRootDevice: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  groupRootInode: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ownershipNonce: z.string().regex(SHA256_PATTERN),
  repositorySetId: z.string().regex(SHA256_PATTERN),
  repositoryIds: z.array(z.string().refine(isValidId)).min(1).max(MULTIREPO_LIMITS.maximumRepositoriesPerTask),
  authority: authoritySchema,
  requestDigest: z.string().regex(SHA256_PATTERN),
  state: z.enum(worktreeGroupStates),
  cleanupKind: z.enum(["rollback", "reclaim"]).optional(),
  entries: z.array(receiptEntrySchema).min(1).max(MULTIREPO_LIMITS.maximumRepositoriesPerTask),
  issues: z.array(issueSchema).max(MAX_ISSUES),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  receiptDigest: z.string().regex(SHA256_PATTERN)
});

type MutableReceiptEntry = {
  -readonly [Key in keyof WorktreeGroupReceiptEntry]: WorktreeGroupReceiptEntry[Key];
};

type MutableReceipt = {
  -readonly [Key in keyof WorktreeGroupReceipt]: WorktreeGroupReceipt[Key];
};

type ValidatedPlan = {
  options: WorktreeGroupOptions;
  groupRoot: string;
  receiptPath: string;
  existingReceipt?: WorktreeGroupReceipt;
  requestDigest: string;
  entries: Array<{
    repository: RepositoryIdentityV1;
    destination: string;
    branch: string;
    branchRef: string;
    anchorOid: string;
    provision: readonly ProvisionSpec[];
  }>;
};

type Registration = {
  path: string;
  head?: string;
  branchRef?: string;
  locked: boolean;
  prunable: boolean;
};

type ExactInspection = {
  destination: Stats;
  gitFile: Stats;
  registration: Registration;
  head: string;
  clean: boolean;
};

function boundedText(value: unknown): string {
  const clean = (value instanceof Error ? value.message : String(value))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ") || "unknown failure";
  const bytes = Buffer.from(clean, "utf8");
  if (bytes.byteLength <= MAX_DIAGNOSTIC_BYTES) return clean;
  return bytes.subarray(0, MAX_DIAGNOSTIC_BYTES).toString("utf8").replace(/\ufffd$/u, "");
}

function issue(code: WorktreeGroupIssueCode, message: unknown, repositoryId?: string): WorktreeGroupIssue {
  return Object.freeze({ code, ...(repositoryId === undefined ? {} : { repositoryId }), message: boundedText(message) });
}

function now(options: WorktreeGroupOptions): string {
  const value = options.now?.() ?? new Date();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new WorktreeGroupError("INVALID_PLAN", "worktree-group clock returned an invalid Date");
  }
  return value.toISOString();
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) result[key] = canonicalValue(item);
    }
    return result;
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value)), "utf8").digest("hex");
}

function receiptDigest(receipt: Omit<WorktreeGroupReceipt, "receiptDigest">): string {
  return digest(receipt);
}

function requestValue(options: WorktreeGroupOptions, groupRoot: string): unknown {
  return {
    schemaVersion: WORKTREE_GROUP_SCHEMA_VERSION,
    groupId: options.groupId,
    groupRoot,
    repositorySet: options.repositorySet,
    authority: options.authority,
    entries: options.entries.map((entry) => ({
      repository: entry.repository,
      branch: entry.branch,
      provision: entry.provision ?? []
    }))
  };
}

function receiptPath(groupRoot: string): string {
  return resolve(groupRoot, WORKTREE_GROUP_RECEIPT_LEAF);
}

function effectiveUid(): number | undefined {
  return typeof process.geteuid === "function" ? process.geteuid() : undefined;
}

function assertPrivatePhysicalDirectory(path: string, label: string): Stats {
  const absolute = resolve(path);
  let metadata: Stats;
  try {
    metadata = lstatSync(absolute);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync.native(absolute) !== absolute) {
      throw new Error("not a canonical physical directory");
    }
  } catch (error) {
    throw new WorktreeGroupError("INVALID_PLAN", `${label} is missing, symlinked, or not physically canonical`, undefined, { cause: asError(error) });
  }
  if ((metadata.mode & 0o077) !== 0 || (metadata.mode & 0o700) !== 0o700) {
    throw new WorktreeGroupError("INVALID_PLAN", `${label} must be an owner-accessible private directory (0700)`);
  }
  const uid = effectiveUid();
  if (uid !== undefined && metadata.uid !== uid) throw new WorktreeGroupError("INVALID_PLAN", `${label} belongs to another uid`);
  return metadata;
}

function isContained(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && rel !== "." && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function writeFull(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (written === 0) throw new WorktreeGroupError("RECEIPT_CORRUPT", "worktree-group receipt write made no progress");
    offset += written;
  }
}

function fsyncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EINVAL" || code === "ENOTSUP" || code === "EISDIR") return;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function publishReceipt(receiptValue: MutableReceipt): WorktreeGroupReceipt {
  const withoutDigest = { ...receiptValue } as Record<string, unknown>;
  delete withoutDigest.receiptDigest;
  const complete = {
    ...withoutDigest,
    receiptDigest: receiptDigest(withoutDigest as Omit<WorktreeGroupReceipt, "receiptDigest">)
  };
  const parsed = receiptSchema.parse(complete) as WorktreeGroupReceipt;
  const path = receiptPath(parsed.groupRoot);
  const temp = resolve(parsed.groupRoot, `.worktree-receipt-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  if (bytes.byteLength > WORKTREE_GROUP_MAX_RECEIPT_BYTES) {
    throw new WorktreeGroupError("RECEIPT_CORRUPT", "worktree-group receipt exceeds its byte cap");
  }
  const fd = openSync(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    writeFull(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, path);
    chmodSync(path, 0o600);
    fsyncDirectory(parsed.groupRoot);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* preserve publication error */ }
    throw error;
  }
  return freezeReceipt(parsed);
}

function readBoundedReceipt(path: string): Buffer {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    const uid = effectiveUid();
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0 || (uid !== undefined && before.uid !== uid)) {
      throw new WorktreeGroupError("RECEIPT_CORRUPT", "worktree-group receipt is not a private singly-linked owned file");
    }
    if (before.size < 2 || before.size > WORKTREE_GROUP_MAX_RECEIPT_BYTES) {
      throw new WorktreeGroupError("RECEIPT_CORRUPT", "worktree-group receipt size is outside its bound");
    }
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(fd, bytes, offset, bytes.byteLength - offset, offset);
      if (count === 0) throw new WorktreeGroupError("RECEIPT_CORRUPT", "worktree-group receipt was truncated during read");
      offset += count;
    }
    const after = fstatSync(fd);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      after.nlink !== 1 ||
      (after.mode & 0o077) !== 0 ||
      (uid !== undefined && after.uid !== uid)
    ) {
      throw new WorktreeGroupError("RECEIPT_CORRUPT", "worktree-group receipt changed during read");
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function freezeReceipt(receipt: WorktreeGroupReceipt): WorktreeGroupReceipt {
  return Object.freeze({
    ...receipt,
    repositoryIds: Object.freeze([...receipt.repositoryIds]),
    authority: Object.freeze({ ...receipt.authority }),
    entries: Object.freeze(receipt.entries.map((entry) => Object.freeze({
      ...entry,
      repository: Object.freeze({ ...entry.repository, protectedBranches: Object.freeze([...entry.repository.protectedBranches]) }),
      provision: Object.freeze(entry.provision.map((spec) => Object.freeze({
        ...spec,
        ...(spec.requiredExecutables === undefined ? {} : { requiredExecutables: Object.freeze([...spec.requiredExecutables]) })
      }))),
      provisioned: Object.freeze(entry.provisioned.map((summary) => Object.freeze({ ...summary })))
    }))),
    issues: Object.freeze(receipt.issues.map((entry) => Object.freeze({ ...entry })))
  });
}

export function readWorktreeGroupReceipt(groupRoot: string): WorktreeGroupReceipt {
  const root = resolve(groupRoot);
  const rootMetadata = assertPrivatePhysicalDirectory(root, "worktree-group root");
  let raw: unknown;
  try {
    raw = JSON.parse(readBoundedReceipt(receiptPath(root)).toString("utf8"));
  } catch (error) {
    if (error instanceof WorktreeGroupError) throw error;
    throw new WorktreeGroupError("RECEIPT_CORRUPT", "worktree-group receipt is not valid JSON", undefined, { cause: asError(error) });
  }
  const parsed = receiptSchema.safeParse(raw);
  if (!parsed.success) {
    throw new WorktreeGroupError("RECEIPT_CORRUPT", "worktree-group receipt violates its closed v1 schema", undefined, { cause: parsed.error });
  }
  const receipt = parsed.data as WorktreeGroupReceipt;
  const { receiptDigest: recordedDigest, ...withoutDigest } = receipt;
  if (receiptDigest(withoutDigest) !== recordedDigest) {
    throw new WorktreeGroupError("RECEIPT_CORRUPT", "worktree-group receipt digest does not match its contents");
  }
  if (
    receipt.groupRoot !== root ||
    receipt.groupRootDevice !== rootMetadata.dev ||
    receipt.groupRootInode !== rootMetadata.ino
  ) {
    throw new WorktreeGroupError("RECEIPT_MISMATCH", "worktree-group root identity differs from its ownership receipt");
  }
  return freezeReceipt(receipt);
}

function mutable(receipt: WorktreeGroupReceipt): MutableReceipt {
  return structuredClone(receipt) as MutableReceipt;
}

function ensureGroupRoot(path: string): Stats {
  const root = resolve(path);
  const parent = dirname(root);
  assertPrivatePhysicalDirectory(parent, "worktree-group parent");
  if (!isContained(parent, root)) throw new WorktreeGroupError("INVALID_PLAN", "worktree-group root must be a direct contained child");
  if (!existsSync(root)) mkdirSync(root, { mode: 0o700 });
  const metadata = assertPrivatePhysicalDirectory(root, "worktree-group root");
  if (!existsSync(receiptPath(root)) && readdirSync(root).length !== 0) {
    throw new WorktreeGroupError("RECEIPT_MISMATCH", "an unreceipted worktree-group root is not empty");
  }
  return metadata;
}

function gitCommonDirectory(repositoryRoot: string): string {
  const common = runGit(repositoryRoot, ["rev-parse", "--git-common-dir"]);
  if (!common.ok || !common.out) throw new WorktreeGroupError("IDENTITY_MISMATCH", "Git common directory cannot be resolved");
  const candidate = resolve(repositoryRoot, common.out);
  try {
    return realpathSync.native(candidate);
  } catch (error) {
    throw new WorktreeGroupError("IDENTITY_MISMATCH", "Git common directory is not physically resolvable", undefined, { cause: asError(error) });
  }
}

function assertRepositoryIdentity(repository: RepositoryIdentityV1): void {
  const parsed = RepositoryIdentityV1Schema.safeParse(repository);
  if (!parsed.success) throw new WorktreeGroupError("INVALID_PLAN", "repository identity violates the v1 contract", repository.repositoryId);
  const root = resolve(repository.canonicalRoot);
  let rootMetadata: Stats;
  let commonMetadata: Stats;
  try {
    rootMetadata = lstatSync(root);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || realpathSync.native(root) !== root) throw new Error("root is not physical");
    const top = runGit(root, ["rev-parse", "--show-toplevel"]);
    if (!top.ok || realpathSync.native(resolve(top.out)) !== root) throw new Error("Git top-level differs");
    commonMetadata = lstatSync(gitCommonDirectory(root));
  } catch (error) {
    throw new WorktreeGroupError("IDENTITY_MISMATCH", "configured repository identity cannot be re-proved", repository.repositoryId, { cause: asError(error) });
  }
  if (
    rootMetadata.dev !== repository.rootDevice ||
    rootMetadata.ino !== repository.rootInode ||
    commonMetadata.dev !== repository.gitCommonDirDevice ||
    commonMetadata.ino !== repository.gitCommonDirInode
  ) {
    throw new WorktreeGroupError("IDENTITY_MISMATCH", "configured repository device/inode identity changed", repository.repositoryId);
  }
}

function resolveRef(repository: RepositoryIdentityV1, ref: string): string | undefined {
  const result = runGit(repository.canonicalRoot, ["rev-parse", "--verify", `${ref}^{commit}`]);
  return result.ok && OID_PATTERN.test(result.out) ? result.out : undefined;
}

function assertSourceClean(repository: RepositoryIdentityV1): void {
  const status = runGit(repository.canonicalRoot, ["status", "--porcelain", "--untracked-files=all"]);
  if (!status.ok) throw new WorktreeGroupError("GIT_UNCERTAIN", "configured repository cleanliness cannot be read", repository.repositoryId);
  if (status.out.length > 0) throw new WorktreeGroupError("SOURCE_DIRTY", "configured repository has tracked or untracked changes", repository.repositoryId);
}

function branchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

function validatePlan(options: WorktreeGroupOptions): ValidatedPlan {
  if (!isValidId(options.groupId)) throw new WorktreeGroupError("INVALID_PLAN", "groupId is not a canonical identifier");
  const authority = authoritySchema.safeParse(options.authority);
  if (!authority.success) throw new WorktreeGroupError("INVALID_PLAN", "worktree-group authority is invalid");
  if (
    options.repositorySet.schemaVersion !== MULTIREPO_SCHEMA_VERSION ||
    !SHA256_PATTERN.test(options.repositorySet.repositorySetId) ||
    options.entries.length < 1 ||
    options.entries.length > MULTIREPO_LIMITS.maximumRepositoriesPerTask
  ) {
    throw new WorktreeGroupError("INVALID_PLAN", "repository set or worktree-group width is invalid");
  }
  const ids = options.entries.map((entry) => entry.repository.repositoryId);
  if (ids.length !== options.repositorySet.repositoryIds.length || ids.some((id, index) => id !== options.repositorySet.repositoryIds[index])) {
    throw new WorktreeGroupError("INVALID_PLAN", "worktree entries must exactly match repository-set order");
  }
  if (new Set(ids).size !== ids.length || new Set(ids.map((id) => id.toLocaleLowerCase("en-US"))).size !== ids.length) {
    throw new WorktreeGroupError("INVALID_PLAN", "worktree repository destinations are not uniquely portable");
  }
  const recomputed = materializeRepositorySet(
    { schemaVersion: MULTIREPO_SCHEMA_VERSION, repositories: options.entries.map((entry) => entry.repository) },
    ids
  );
  if (recomputed.repositorySetId !== options.repositorySet.repositorySetId) {
    throw new WorktreeGroupError("INVALID_PLAN", "repository-set digest differs from the configured identities/base policy");
  }

  const groupRoot = resolve(options.groupRoot);
  if (Buffer.byteLength(groupRoot, "utf8") > MULTIREPO_LIMITS.maximumPathBytes) {
    throw new WorktreeGroupError("INVALID_PLAN", "worktree-group root exceeds its path bound");
  }
  const path = receiptPath(groupRoot);
  const requestDigest = digest(requestValue(options, groupRoot));
  const existingReceipt = existsSync(path) ? readWorktreeGroupReceipt(groupRoot) : undefined;
  if (
    existingReceipt !== undefined &&
    (
      existingReceipt.groupId !== options.groupId ||
      existingReceipt.repositorySetId !== options.repositorySet.repositorySetId ||
      existingReceipt.requestDigest !== requestDigest ||
      existingReceipt.entries.length !== options.entries.length
    )
  ) {
    throw new WorktreeGroupError("RECEIPT_MISMATCH", "existing worktree-group receipt differs from the exact request");
  }
  const branchKeys = new Set<string>();
  const entries = options.entries.map((entry, index) => {
    const durableEntry = existingReceipt?.entries[index];
    if (durableEntry !== undefined && durableEntry.repository.repositoryId !== entry.repository.repositoryId) {
      throw new WorktreeGroupError("RECEIPT_MISMATCH", "existing worktree-group member order differs from the exact request");
    }
    if (entry.branch.startsWith("refs/") || entry.branch === entry.repository.defaultBranch || entry.repository.protectedBranches.includes(entry.branch)) {
      throw new WorktreeGroupError("INVALID_PLAN", "worktree branch aliases a configured/protected ref", entry.repository.repositoryId);
    }
    if (Buffer.byteLength(entry.branch, "utf8") > MULTIREPO_LIMITS.maximumRefBytes) {
      throw new WorktreeGroupError("INVALID_PLAN", "worktree branch label is invalid", entry.repository.repositoryId);
    }
    const branchKey = entry.branch.toLocaleLowerCase("en-US");
    if (branchKeys.has(branchKey)) {
      throw new WorktreeGroupError("INVALID_PLAN", "worktree branch labels must be unique across the group", entry.repository.repositoryId);
    }
    branchKeys.add(branchKey);
    const ref = branchRef(entry.branch);
    const provision = Object.freeze([...(entry.provision ?? [])].map((spec) => Object.freeze({
      ...spec,
      ...(spec.requiredExecutables === undefined ? {} : { requiredExecutables: Object.freeze([...spec.requiredExecutables]) })
    })));
    const provisionIssues = validateProvisionSpecs(provision);
    if (provisionIssues.length > 0) {
      throw new WorktreeGroupError("INVALID_PLAN", provisionIssues[0]!.message, entry.repository.repositoryId);
    }
    let anchor: string;
    if (durableEntry !== undefined) {
      anchor = durableEntry.anchorOid;
    } else {
      assertRepositoryIdentity(entry.repository);
      assertSourceClean(entry.repository);
      const validBranch = runGit(entry.repository.canonicalRoot, ["check-ref-format", "--branch", entry.branch]);
      if (!validBranch.ok) {
        throw new WorktreeGroupError("INVALID_PLAN", "worktree branch label is invalid", entry.repository.repositoryId);
      }
      if (resolveRef(entry.repository, ref) !== undefined) {
        throw new WorktreeGroupError("BRANCH_CONFLICT", "worktree branch already exists", entry.repository.repositoryId);
      }
      const resolvedAnchor = resolveRef(entry.repository, branchRef(entry.repository.defaultBranch));
      if (!resolvedAnchor) throw new WorktreeGroupError("INVALID_PLAN", "configured default branch cannot be resolved", entry.repository.repositoryId);
      anchor = resolvedAnchor;
      const inspection = inspectProvisioning({ sourceRoot: entry.repository.canonicalRoot, specs: provision });
      if (!inspection.ok) {
        throw new WorktreeGroupError("PROVISION_FAILED", inspection.issues[0]?.message ?? "provisioning inspection failed", entry.repository.repositoryId);
      }
    }
    return {
      repository: entry.repository,
      destination: resolve(groupRoot, entry.repository.repositoryId),
      branch: entry.branch,
      branchRef: ref,
      anchorOid: anchor,
      provision
    };
  });
  if (new Set(entries.map((entry) => entry.destination)).size !== entries.length || entries.some((entry) => dirname(entry.destination) !== groupRoot)) {
    throw new WorktreeGroupError("INVALID_PLAN", "worktree destinations are not unique direct children of the group root");
  }
  return {
    options,
    groupRoot,
    receiptPath: path,
    ...(existingReceipt === undefined ? {} : { existingReceipt }),
    requestDigest,
    entries
  };
}

function initialReceipt(plan: ValidatedPlan): WorktreeGroupReceipt {
  const rootMetadata = ensureGroupRoot(plan.groupRoot);
  const timestamp = now(plan.options);
  const draft: MutableReceipt = {
    schemaVersion: WORKTREE_GROUP_SCHEMA_VERSION,
    groupId: plan.options.groupId,
    groupRoot: plan.groupRoot,
    groupRootDevice: rootMetadata.dev,
    groupRootInode: rootMetadata.ino,
    ownershipNonce: randomBytes(32).toString("hex"),
    repositorySetId: plan.options.repositorySet.repositorySetId,
    repositoryIds: [...plan.options.repositorySet.repositoryIds],
    authority: { ...plan.options.authority },
    requestDigest: plan.requestDigest,
    state: "creating",
    entries: plan.entries.map((entry) => ({
      repository: structuredClone(entry.repository),
      destination: entry.destination,
      branch: entry.branch,
      branchRef: entry.branchRef,
      anchorOid: entry.anchorOid,
      state: "planned",
      provision: structuredClone(entry.provision),
      provisioned: []
    })),
    issues: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    receiptDigest: "0".repeat(64)
  };
  return publishReceipt(draft);
}

function assertReceiptMatchesPlan(receipt: WorktreeGroupReceipt, plan: ValidatedPlan): void {
  if (
    receipt.groupId !== plan.options.groupId ||
    receipt.groupRoot !== plan.groupRoot ||
    receipt.repositorySetId !== plan.options.repositorySet.repositorySetId ||
    digest(receipt.repositoryIds) !== digest(plan.options.repositorySet.repositoryIds) ||
    digest(receipt.authority) !== digest(plan.options.authority) ||
    receipt.requestDigest !== plan.requestDigest ||
    receipt.entries.length !== plan.entries.length ||
    receipt.entries.some((entry, index) =>
      digest(entry.repository) !== digest(plan.entries[index]!.repository) ||
      entry.destination !== plan.entries[index]!.destination ||
      entry.branch !== plan.entries[index]!.branch ||
      entry.branchRef !== plan.entries[index]!.branchRef ||
      digest(entry.provision) !== digest(plan.entries[index]!.provision) ||
      entry.anchorOid !== plan.entries[index]!.anchorOid
    )
  ) {
    throw new WorktreeGroupError("RECEIPT_MISMATCH", "existing worktree-group receipt differs from the exact request");
  }
}

function registrations(repository: RepositoryIdentityV1): Registration[] {
  const list = runGit(repository.canonicalRoot, ["worktree", "list", "--porcelain", "-z"]);
  if (!list.ok) throw new WorktreeGroupError("GIT_UNCERTAIN", "Git worktree registry cannot be read", repository.repositoryId);
  const result: Registration[] = [];
  let current: Registration | undefined;
  for (const line of list.out.split("\0")) {
    if (line.startsWith("worktree ")) {
      if (current) result.push(current);
      current = { path: resolve(line.slice("worktree ".length)), locked: false, prunable: false };
    } else if (current && line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
    else if (current && line.startsWith("branch ")) current.branchRef = line.slice("branch ".length);
    else if (current && line.startsWith("locked")) current.locked = true;
    else if (current && line.startsWith("prunable")) current.prunable = true;
  }
  if (current) result.push(current);
  return result;
}

function registrationAt(repository: RepositoryIdentityV1, destination: string): Registration | undefined {
  return registrations(repository).find((entry) => entry.path === resolve(destination));
}

function inspectExactMember(
  entry: WorktreeGroupReceiptEntry,
  options: { requireAnchor: boolean; requireClean: boolean }
): ExactInspection {
  const repositoryId = entry.repository.repositoryId;
  assertRepositoryIdentity(entry.repository);
  let destination: Stats;
  let gitFile: Stats;
  try {
    destination = lstatSync(entry.destination);
  } catch (error) {
    throw new WorktreeGroupError("WORKTREE_STALE", "worktree path is missing", repositoryId, { cause: asError(error) });
  }
  if (!destination.isDirectory() || destination.isSymbolicLink() || realpathSync.native(entry.destination) !== entry.destination) {
    throw new WorktreeGroupError("DESTINATION_REPLACED", "worktree destination is not a canonical physical directory", repositoryId);
  }
  try {
    gitFile = lstatSync(resolve(entry.destination, ".git"));
  } catch (error) {
    throw new WorktreeGroupError("DESTINATION_REPLACED", "worktree Git identity file is missing", repositoryId, { cause: asError(error) });
  }
  if (!gitFile.isFile() || gitFile.isSymbolicLink() || gitFile.nlink !== 1) {
    throw new WorktreeGroupError("DESTINATION_REPLACED", "worktree Git identity is not a regular singly-linked file", repositoryId);
  }
  if (
    (entry.destinationDevice !== undefined && destination.dev !== entry.destinationDevice) ||
    (entry.destinationInode !== undefined && destination.ino !== entry.destinationInode) ||
    (entry.gitFileDevice !== undefined && gitFile.dev !== entry.gitFileDevice) ||
    (entry.gitFileInode !== undefined && gitFile.ino !== entry.gitFileInode)
  ) {
    throw new WorktreeGroupError("DESTINATION_REPLACED", "worktree destination or Git file identity was replaced", repositoryId);
  }
  const registration = registrationAt(entry.repository, entry.destination);
  if (!registration) throw new WorktreeGroupError("WORKTREE_STALE", "worktree is not present in Git's registry", repositoryId);
  if (registration.locked) throw new WorktreeGroupError("WORKTREE_LOCKED", "worktree is locked", repositoryId);
  if (registration.prunable || registration.branchRef !== entry.branchRef) {
    throw new WorktreeGroupError("REGISTRATION_MISMATCH", "worktree registration is stale or names another branch", repositoryId);
  }
  if (gitCommonDirectory(entry.destination) !== gitCommonDirectory(entry.repository.canonicalRoot)) {
    throw new WorktreeGroupError("REGISTRATION_MISMATCH", "worktree Git common-directory identity differs", repositoryId);
  }
  const head = resolveRef(entry.repository, entry.branchRef);
  const worktreeHead = runGit(entry.destination, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!head || !worktreeHead.ok || worktreeHead.out !== head || registration.head !== head) {
    throw new WorktreeGroupError("REGISTRATION_MISMATCH", "worktree HEAD, branch and registration disagree", repositoryId);
  }
  if (options.requireAnchor && head !== entry.anchorOid) {
    throw new WorktreeGroupError("ANCHOR_MOVED", "owned worktree branch moved before readiness/rollback", repositoryId);
  }
  let clean = false;
  if (options.requireClean) {
    const status = runGit(entry.destination, ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all"]);
    if (!status.ok) throw new WorktreeGroupError("GIT_UNCERTAIN", "worktree cleanliness cannot be read", repositoryId);
    clean = status.out.length === 0;
    if (!clean) throw new WorktreeGroupError("WORKTREE_DIRTY", "worktree contains tracked or untracked changes", repositoryId);
  }
  return { destination, gitFile, registration, head, clean };
}

/**
 * Re-open a canonical ready receipt and re-prove every member's physical directory/.git inode,
 * configured repository identity, Git worktree registration, branch and HEAD without publishing a
 * new receipt or requiring the provider-owned checkout to remain clean. This is the restart fence:
 * a provider may legitimately have left dirty files or a parent-created child commit, but a replaced,
 * stale, locked or re-registered path is never allowed to reach recovery or another parent Git call.
 */
export function assertReadyWorktreeGroupExact(groupRoot: string): WorktreeGroupReceipt {
  const receipt = readWorktreeGroupReceipt(groupRoot);
  if (receipt.state !== "ready") {
    throw new WorktreeGroupError("RECOVERY_REQUIRED", "worktree-group receipt is not ready");
  }
  for (const entry of receipt.entries) {
    if (entry.state !== "ready") {
      throw new WorktreeGroupError("RECOVERY_REQUIRED", "ready group contains a non-ready member", entry.repository.repositoryId);
    }
    inspectExactMember(entry, { requireAnchor: false, requireClean: false });
    if (resolveRef(entry.repository, branchRef(entry.repository.defaultBranch)) !== entry.anchorOid) {
      throw new WorktreeGroupError("ANCHOR_MOVED", "configured default branch moved after worktree readiness", entry.repository.repositoryId);
    }
  }
  return receipt;
}

function captureEntryIdentity(entry: MutableReceiptEntry, inspection: ExactInspection): void {
  entry.destinationDevice = inspection.destination.dev;
  entry.destinationInode = inspection.destination.ino;
  entry.gitFileDevice = inspection.gitFile.dev;
  entry.gitFileInode = inspection.gitFile.ino;
  entry.observedHead = inspection.head;
  delete entry.diagnostic;
}

function updateReceipt(plan: ValidatedPlan, receipt: MutableReceipt): WorktreeGroupReceipt {
  receipt.updatedAt = now(plan.options);
  return publishReceipt(receipt);
}

function invokeFault(plan: ValidatedPlan, point: WorktreeGroupFaultPoint, repositoryId?: string): void {
  plan.options.fault?.(point, repositoryId);
}

function ensureTransactionRoot(groupRoot: string, repositoryId: string): string {
  const provisionRoot = resolve(groupRoot, ".provision");
  if (!existsSync(provisionRoot)) mkdirSync(provisionRoot, { mode: 0o700 });
  assertPrivatePhysicalDirectory(provisionRoot, "worktree-group provision root");
  const transactionRoot = resolve(provisionRoot, repositoryId);
  if (!existsSync(transactionRoot)) mkdirSync(transactionRoot, { mode: 0o700 });
  assertPrivatePhysicalDirectory(transactionRoot, "repository provision transaction root");
  return transactionRoot;
}

function createOrAdoptEntry(plan: ValidatedPlan, receiptValue: WorktreeGroupReceipt, index: number): WorktreeGroupReceipt {
  let receipt = receiptValue;
  const mutableReceipt = mutable(receipt);
  const entry = mutableReceipt.entries[index] as MutableReceiptEntry;
  const repositoryId = entry.repository.repositoryId;
  if (entry.state !== "planned") return receipt;

  const destinationExists = existsSync(entry.destination);
  const branchOid = resolveRef(entry.repository, entry.branchRef);
  const registration = registrationAt(entry.repository, entry.destination);
  if (destinationExists || branchOid || registration) {
    if (!destinationExists || branchOid !== entry.anchorOid || !registration) {
      throw new WorktreeGroupError("RECOVERY_REQUIRED", "partial worktree creation cannot be proven exact", repositoryId);
    }
    const inspection = inspectExactMember(entry, { requireAnchor: true, requireClean: true });
    captureEntryIdentity(entry, inspection);
    entry.state = "created";
    return updateReceipt(plan, mutableReceipt);
  }

  invokeFault(plan, "before-create", repositoryId);
  assertRepositoryIdentity(entry.repository);
  assertSourceClean(entry.repository);
  if (resolveRef(entry.repository, branchRef(entry.repository.defaultBranch)) !== entry.anchorOid) {
    throw new WorktreeGroupError("ANCHOR_MOVED", "configured default branch moved before worktree creation", repositoryId);
  }
  if (resolveRef(entry.repository, entry.branchRef) !== undefined) {
    throw new WorktreeGroupError("BRANCH_CONFLICT", "worktree branch appeared before creation", repositoryId);
  }
  const add = runGit(entry.repository.canonicalRoot, ["worktree", "add", "-b", entry.branch, entry.destination, entry.anchorOid]);
  if (!add.ok) throw new WorktreeGroupError("CREATE_FAILED", add.err || "git worktree add failed", repositoryId);
  invokeFault(plan, "after-worktree-add", repositoryId);
  const inspection = inspectExactMember(entry, { requireAnchor: true, requireClean: true });
  captureEntryIdentity(entry, inspection);
  entry.state = "created";
  receipt = updateReceipt(plan, mutableReceipt);
  invokeFault(plan, "after-created-receipt", repositoryId);
  return receipt;
}

function provisionEntry(plan: ValidatedPlan, receiptValue: WorktreeGroupReceipt, index: number): WorktreeGroupReceipt {
  const mutableReceipt = mutable(receiptValue);
  const entry = mutableReceipt.entries[index] as MutableReceiptEntry;
  const repositoryId = entry.repository.repositoryId;
  if (entry.state === "ready") return receiptValue;
  if (entry.state !== "created" && entry.state !== "provisioned") {
    throw new WorktreeGroupError("RECOVERY_REQUIRED", "entry is not at a provisionable lifecycle state", repositoryId);
  }
  assertRepositoryIdentity(entry.repository);
  assertSourceClean(entry.repository);
  inspectExactMember(entry, { requireAnchor: true, requireClean: true });
  invokeFault(plan, "before-provision", repositoryId);
  let provisioned: readonly ProvisionEntrySummary[] = [];
  if (entry.provision.length > 0) {
    const result = provisionWorktree({
      sourceRoot: entry.repository.canonicalRoot,
      targetRoot: entry.destination,
      transactionRoot: ensureTransactionRoot(plan.groupRoot, repositoryId),
      specs: entry.provision
    });
    if (!result.ok) {
      throw new WorktreeGroupError("PROVISION_FAILED", provisionFailure(result.issues), repositoryId);
    }
    provisioned = result.provisioned;
  }
  invokeFault(plan, "after-provision", repositoryId);
  const inspection = inspectExactMember(entry, { requireAnchor: true, requireClean: true });
  captureEntryIdentity(entry, inspection);
  entry.provisioned = structuredClone(provisioned);
  entry.state = "provisioned";
  const receipt = updateReceipt(plan, mutableReceipt);
  invokeFault(plan, "after-provisioned-receipt", repositoryId);
  return receipt;
}

function provisionFailure(issues: readonly ProvisionIssue[]): string {
  if (issues.length === 0) return "worktree provisioning failed without a diagnostic";
  return issues.map((entry) => `[${entry.code}] ${entry.message}`).join("; ");
}

function assertProvisioningReady(entry: WorktreeGroupReceiptEntry): void {
  const inspection = inspectProvisioning({ sourceRoot: entry.destination, specs: entry.provision });
  if (!inspection.ok) {
    throw new WorktreeGroupError(
      "PROVISION_FAILED",
      inspection.issues[0]?.message ?? "provisioned worktree failed its readiness inspection",
      entry.repository.repositoryId
    );
  }
  if (digest(inspection.inspected) !== digest(entry.provisioned)) {
    throw new WorktreeGroupError(
      "PROVISION_FAILED",
      "provisioned worktree no longer matches its durable readiness summary",
      entry.repository.repositoryId
    );
  }
}

function markReady(plan: ValidatedPlan, receiptValue: WorktreeGroupReceipt): WorktreeGroupReceipt {
  const receipt = mutable(receiptValue);
  invokeFault(plan, "before-ready");
  for (let index = 0; index < receipt.entries.length; index += 1) {
    const entry = receipt.entries[index] as MutableReceiptEntry;
    if (entry.state !== "provisioned" && entry.state !== "ready") {
      throw new WorktreeGroupError("RECOVERY_REQUIRED", "not every worktree reached provisioning", entry.repository.repositoryId);
    }
    assertRepositoryIdentity(entry.repository);
    assertSourceClean(entry.repository);
    if (resolveRef(entry.repository, branchRef(entry.repository.defaultBranch)) !== entry.anchorOid) {
      throw new WorktreeGroupError("ANCHOR_MOVED", "configured default branch moved before group readiness", entry.repository.repositoryId);
    }
    const inspection = inspectExactMember(entry, { requireAnchor: true, requireClean: true });
    assertProvisioningReady(entry);
    captureEntryIdentity(entry, inspection);
    entry.state = "ready";
  }
  receipt.state = "ready";
  receipt.issues = [];
  const published = updateReceipt(plan, receipt);
  invokeFault(plan, "after-ready-receipt");
  return published;
}

function members(receipt: WorktreeGroupReceipt): ReadyWorktreeGroupMember[] {
  if (receipt.state !== "ready") return [];
  return receipt.entries.map((entry) => Object.freeze({
    repositoryId: entry.repository.repositoryId,
    sourceRoot: entry.repository.canonicalRoot,
    path: entry.destination,
    branch: entry.branch,
    anchorOid: entry.anchorOid,
    headOid: entry.observedHead ?? entry.anchorOid
  }));
}

function result(receipt: WorktreeGroupReceipt): WorktreeGroupResult {
  return Object.freeze({
    status: receipt.state === "ready" ? "ready" : receipt.state === "reclaimed" ? "reclaimed" : "recovery_required",
    receipt,
    members: Object.freeze(members(receipt)),
    issues: Object.freeze([...receipt.issues])
  });
}

function preserveEntry(entry: MutableReceiptEntry, error: WorktreeGroupError): WorktreeGroupIssue {
  entry.state = "preserved";
  entry.diagnostic = boundedText(error);
  return issue(error.code, error.message, entry.repository.repositoryId);
}

function branchExists(repository: RepositoryIdentityV1, ref: string): boolean {
  return resolveRef(repository, ref) !== undefined;
}

function removeOwnedEntry(
  plan: ValidatedPlan,
  receipt: MutableReceipt,
  index: number,
  rollback: boolean
): WorktreeGroupIssue | undefined {
  const entry = receipt.entries[index] as MutableReceiptEntry;
  const repositoryId = entry.repository.repositoryId;
  if (entry.state === "reclaimed") return undefined;
  try {
    invokeFault(plan, "before-cleanup-entry", repositoryId);
    if (!existsSync(entry.destination)) {
      const registered = registrationAt(entry.repository, entry.destination);
      const oid = resolveRef(entry.repository, entry.branchRef);
      if (entry.state === "planned" && !registered && oid === undefined) {
        entry.state = "reclaimed";
        delete entry.diagnostic;
        return undefined;
      }
      if (entry.state === "planned" && !registered && oid === entry.anchorOid) {
        const deleted = runGit(entry.repository.canonicalRoot, ["update-ref", "-d", entry.branchRef, entry.anchorOid]);
        if (!deleted.ok) throw new WorktreeGroupError("CLEANUP_FAILED", deleted.err || "owned branch deletion failed", repositoryId);
        entry.state = "reclaimed";
        delete entry.diagnostic;
        return undefined;
      }
      if (entry.state === "reclaiming" && !registered && (oid === undefined || oid === entry.observedHead)) {
        if (oid !== undefined) {
          const deleted = runGit(entry.repository.canonicalRoot, ["update-ref", "-d", entry.branchRef, oid]);
          if (!deleted.ok && branchExists(entry.repository, entry.branchRef)) {
            throw new WorktreeGroupError("CLEANUP_FAILED", deleted.err || "owned branch deletion failed", repositoryId);
          }
        }
        entry.state = "reclaimed";
        delete entry.diagnostic;
        return undefined;
      }
      throw new WorktreeGroupError("WORKTREE_STALE", "receipted worktree path is absent or registration remains stale", repositoryId);
    }

    const inspection = inspectExactMember(entry, { requireAnchor: rollback, requireClean: true });
    entry.state = "reclaiming";
    entry.observedHead = inspection.head;
    updateReceipt(plan, receipt);
    const removed = runGit(entry.repository.canonicalRoot, ["worktree", "remove", entry.destination]);
    if (!removed.ok) throw new WorktreeGroupError("CLEANUP_FAILED", removed.err || "safe Git worktree removal failed", repositoryId);
    if (existsSync(entry.destination) || registrationAt(entry.repository, entry.destination)) {
      throw new WorktreeGroupError("CLEANUP_FAILED", "worktree removal did not clear both path and registration", repositoryId);
    }
    invokeFault(plan, "after-worktree-remove", repositoryId);
    const branchOid = resolveRef(entry.repository, entry.branchRef);
    if (branchOid === inspection.head) {
      const deleted = runGit(entry.repository.canonicalRoot, ["update-ref", "-d", entry.branchRef, inspection.head]);
      if (!deleted.ok && branchExists(entry.repository, entry.branchRef)) {
        throw new WorktreeGroupError("CLEANUP_FAILED", deleted.err || "owned branch CAS deletion failed", repositoryId);
      }
    } else if (branchOid !== undefined) {
      throw new WorktreeGroupError("REGISTRATION_MISMATCH", "owned branch changed during reclamation", repositoryId);
    }
    entry.state = "reclaimed";
    entry.observedHead = inspection.head;
    delete entry.diagnostic;
    invokeFault(plan, "after-cleanup-entry", repositoryId);
    return undefined;
  } catch (error) {
    if (error instanceof WorktreeGroupInterruptedError) throw error;
    const typed = error instanceof WorktreeGroupError
      ? error
      : new WorktreeGroupError("CLEANUP_FAILED", boundedText(error), repositoryId, { cause: asError(error) });
    return preserveEntry(entry, typed);
  }
}

function cleanupGroup(
  plan: ValidatedPlan,
  receiptValue: WorktreeGroupReceipt,
  cause: WorktreeGroupIssue | undefined,
  rollback: boolean
): WorktreeGroupResult {
  const receipt = mutable(receiptValue);
  receipt.state = rollback ? "rolling_back" : "reclaiming";
  receipt.cleanupKind = rollback ? "rollback" : "reclaim";
  const issues: WorktreeGroupIssue[] = [...receipt.issues];
  if (cause !== undefined) issues.push(cause);
  receipt.issues = uniqueIssues(issues).slice(0, MAX_ISSUES);
  // The cleanup intent and its cause precede the first destructive Git operation. A restart can
  // therefore resume with the same anchor policy and diagnostic instead of guessing why teardown
  // began or accidentally upgrading rollback into ordinary reclamation.
  updateReceipt(plan, receipt);
  for (let index = receipt.entries.length - 1; index >= 0; index -= 1) {
    const cleanupIssue = removeOwnedEntry(plan, receipt, index, rollback);
    if (cleanupIssue) issues.push(cleanupIssue);
  }
  const uncertain = receipt.entries.some((entry) => entry.state !== "reclaimed");
  receipt.state = uncertain ? "recovery_required" : "reclaimed";
  receipt.issues = uniqueIssues(issues).slice(0, MAX_ISSUES);
  return result(updateReceipt(plan, receipt));
}

function uniqueIssues(values: readonly WorktreeGroupIssue[]): WorktreeGroupIssue[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.code}\0${value.repositoryId ?? ""}\0${value.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function recoveryResult(
  plan: ValidatedPlan,
  receiptValue: WorktreeGroupReceipt,
  error: WorktreeGroupError
): WorktreeGroupResult {
  const receipt = mutable(receiptValue);
  const target = error.repositoryId
    ? receipt.entries.find((entry) => entry.repository.repositoryId === error.repositoryId) as MutableReceiptEntry | undefined
    : undefined;
  if (target) preserveEntry(target, error);
  receipt.state = "recovery_required";
  receipt.issues = [...receipt.issues, issue(error.code, error.message, error.repositoryId)].slice(-MAX_ISSUES);
  return result(updateReceipt(plan, receipt));
}

function verifyReadyReceipt(plan: ValidatedPlan, receiptValue: WorktreeGroupReceipt): WorktreeGroupResult {
  const receipt = mutable(receiptValue);
  try {
    for (const entry of receipt.entries as MutableReceiptEntry[]) {
      if (entry.state !== "ready") throw new WorktreeGroupError("RECOVERY_REQUIRED", "ready group contains a non-ready member", entry.repository.repositoryId);
      const inspection = inspectExactMember(entry, { requireAnchor: true, requireClean: true });
      assertSourceClean(entry.repository);
      if (resolveRef(entry.repository, branchRef(entry.repository.defaultBranch)) !== entry.anchorOid) {
        throw new WorktreeGroupError("ANCHOR_MOVED", "configured default branch moved after worktree readiness", entry.repository.repositoryId);
      }
      assertProvisioningReady(entry);
      captureEntryIdentity(entry, inspection);
    }
    receipt.issues = [];
    return result(updateReceipt(plan, receipt));
  } catch (error) {
    const typed = error instanceof WorktreeGroupError
      ? error
      : new WorktreeGroupError("RECOVERY_REQUIRED", boundedText(error), undefined, { cause: asError(error) });
    return recoveryResult(plan, receiptValue, typed);
  }
}

function runPreparation(plan: ValidatedPlan, receiptValue: WorktreeGroupReceipt): WorktreeGroupResult {
  let receipt = receiptValue;
  try {
    for (let index = 0; index < receipt.entries.length; index += 1) {
      receipt = createOrAdoptEntry(plan, receipt, index);
      receipt = provisionEntry(plan, receipt, index);
    }
    receipt = markReady(plan, receipt);
    return result(receipt);
  } catch (error) {
    if (error instanceof WorktreeGroupInterruptedError) throw error;
    const typed = error instanceof WorktreeGroupError
      ? error
      : new WorktreeGroupError("CREATE_FAILED", boundedText(error), undefined, { cause: asError(error) });
    // A failure can occur immediately after a receipt publication but before the helper returns its
    // new value. Cleanup must therefore start from the latest pinned durable receipt, never an older
    // in-memory lifecycle snapshot that could misclassify a created member as merely planned.
    const durable = readWorktreeGroupReceipt(plan.groupRoot);
    assertReceiptMatchesPlan(durable, plan);
    return cleanupGroup(plan, durable, issue(typed.code, typed.message, typed.repositoryId), true);
  }
}

/**
 * Create or restart one all-or-nothing worktree group. No provider receives a member until this
 * returns `ready`; no configured/default/integration ref is ever advanced.
 */
export function prepareWorktreeGroup(options: WorktreeGroupOptions): WorktreeGroupResult {
  const plan = validatePlan(options);
  let receipt: WorktreeGroupReceipt;
  if (plan.existingReceipt !== undefined) {
    receipt = plan.existingReceipt;
    assertReceiptMatchesPlan(receipt, plan);
  } else {
    receipt = initialReceipt(plan);
    invokeFault(plan, "after-initial-receipt");
  }
  if (receipt.state === "reclaimed") return result(receipt);
  if (receipt.state === "recovery_required") return result(receipt);
  if (receipt.state === "rolling_back") return cleanupGroup(plan, receipt, undefined, true);
  if (receipt.state === "reclaiming") return cleanupGroup(plan, receipt, undefined, false);
  if (receipt.state === "ready") return verifyReadyReceipt(plan, receipt);
  return runPreparation(plan, receipt);
}

/** Re-read and reconcile an existing receipt. This is an alias with an explicit restart name. */
export function reconcileWorktreeGroup(options: WorktreeGroupOptions): WorktreeGroupResult {
  const plan = validatePlan(options);
  const receipt = plan.existingReceipt;
  if (receipt === undefined) throw new WorktreeGroupError("RECEIPT_MISMATCH", "worktree-group receipt does not exist");
  assertReceiptMatchesPlan(receipt, plan);
  if (receipt.state === "creating") return runPreparation(plan, receipt);
  if (receipt.state === "rolling_back") return cleanupGroup(plan, receipt, undefined, true);
  if (receipt.state === "reclaiming") return cleanupGroup(plan, receipt, undefined, false);
  if (receipt.state === "ready") return verifyReadyReceipt(plan, receipt);
  return result(receipt);
}

/**
 * Reclaim paths in reverse order without force. Dirty, locked, stale, replaced or uncertain entries
 * remain present and the durable result becomes `recovery_required`.
 */
export function reclaimWorktreeGroup(options: WorktreeGroupOptions): WorktreeGroupResult {
  const plan = validatePlan(options);
  const receipt = plan.existingReceipt;
  if (receipt === undefined) throw new WorktreeGroupError("RECEIPT_MISMATCH", "worktree-group receipt does not exist");
  assertReceiptMatchesPlan(receipt, plan);
  if (receipt.state === "reclaimed") return result(receipt);
  if (receipt.state === "rolling_back") return cleanupGroup(plan, receipt, undefined, true);
  if (receipt.state === "reclaiming") return cleanupGroup(plan, receipt, undefined, false);
  return cleanupGroup(plan, receipt, undefined, receipt.state === "creating");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

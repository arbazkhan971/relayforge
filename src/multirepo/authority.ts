import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fdatasyncSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { inspectProcessIncarnation, processStartToken } from "../control/process-identity.js";
import { runGit } from "../git.js";
import type { RepositoryIdentityV1, RepositoryRegistryV1 } from "./domain.js";
import type {
  MultiRepositoryIntegrationAuthorityHandle,
  MultiRepositoryIntegrationAuthorityManager
} from "./orchestration.js";

const LOCK_LEAF = "relayforge-integration.lock";
const RECEIPT_LEAF = "owner.json";
const MAX_RECEIPT_BYTES = 8 * 1024;
const MAX_LIVE_DIRECTORY_ENTRIES = 2;
const MAX_STAGING_CLAIMS = 64;
const STAGING_CLAIM = /^relayforge-integration\.lock\.claim\.([a-f0-9]{64})$/u;

type Receipt = Readonly<{
  schemaVersion: 1;
  repositoryId: string;
  runId: string;
  runEpoch: string;
  taskId: string;
  taskGeneration: number;
  leaseToken: string;
  ownerPid: number;
  ownerStartToken: string;
  nonce: string;
}>;

export class MultiRepositoryIntegrationAuthorityError extends Error {
  readonly code = "INTEGRATION_AUTHORITY_UNAVAILABLE" as const;
  constructor(message: string, options?: ErrorOptions) {
    super(`${"INTEGRATION_AUTHORITY_UNAVAILABLE"}: ${message}`, options);
    this.name = "MultiRepositoryIntegrationAuthorityError";
  }
}

function commonDirectory(repository: RepositoryIdentityV1): string {
  const result = runGit(repository.canonicalRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!result.ok || !isAbsolute(result.out)) throw new MultiRepositoryIntegrationAuthorityError(`cannot resolve Git common directory for ${repository.repositoryId}`);
  const common = resolve(result.out);
  const stat = lstatSync(common);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== repository.gitCommonDirDevice || stat.ino !== repository.gitCommonDirInode) {
    throw new MultiRepositoryIntegrationAuthorityError(`Git common directory identity changed for ${repository.repositoryId}`);
  }
  return common;
}

type PinnedReceipt = Readonly<{ receipt: Receipt; device: number; inode: number }>;

function fsyncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function directoryEntries(path: string): readonly string[] {
  const directory = opendirSync(path);
  const entries: string[] = [];
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      entries.push(entry.name);
      if (entries.length > MAX_LIVE_DIRECTORY_ENTRIES) {
        throw new MultiRepositoryIntegrationAuthorityError(`integration lock directory ${path} has unbounded or foreign contents`);
      }
    }
  } finally {
    directory.closeSync();
  }
  return Object.freeze(entries.sort((left, right) => left.localeCompare(right)));
}

function stagingClaimLeaves(common: string): readonly Readonly<{ leaf: string; nonce: string }>[] {
  const directory = opendirSync(common);
  const claims: Readonly<{ leaf: string; nonce: string }>[] = [];
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      const match = STAGING_CLAIM.exec(entry.name);
      if (!match) continue;
      claims.push(Object.freeze({ leaf: entry.name, nonce: match[1]! }));
      if (claims.length > MAX_STAGING_CLAIMS) {
        throw new MultiRepositoryIntegrationAuthorityError(`integration authority has more than ${MAX_STAGING_CLAIMS} abandoned staged claims`);
      }
    }
  } finally {
    directory.closeSync();
  }
  return Object.freeze(claims.sort((left, right) => left.leaf.localeCompare(right.leaf)));
}

function parseReceipt(path: string): PinnedReceipt {
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = fstatSync(fd);
    const expectedUid = typeof process.geteuid === "function" ? process.geteuid() : before.uid;
    if (
      !before.isFile() || before.isSymbolicLink() || before.size < 2 || before.size > MAX_RECEIPT_BYTES ||
      before.nlink !== 1 || before.uid !== expectedUid || (before.mode & 0o077) !== 0
    ) {
      throw new MultiRepositoryIntegrationAuthorityError(`integration lock receipt ${path} is not a bounded private owned file`);
    }
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new MultiRepositoryIntegrationAuthorityError(`integration lock receipt ${path} ended early`);
      offset += count;
    }
    const after = fstatSync(fd);
    if (
      !after.isFile() || after.nlink !== 1 || after.uid !== expectedUid || (after.mode & 0o077) !== 0 ||
      after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
      after.ctimeMs !== before.ctimeMs || after.mtimeMs !== before.mtimeMs
    ) {
      throw new MultiRepositoryIntegrationAuthorityError(`integration lock receipt ${path} changed while read`);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString("utf8")); }
    catch (error) { throw new MultiRepositoryIntegrationAuthorityError(`integration lock receipt ${path} is invalid JSON`, { cause: error }); }
    const value = parsed as Partial<Receipt>;
    const keys = Object.keys(value).sort().join(",");
    if (
      keys !== "leaseToken,nonce,ownerPid,ownerStartToken,repositoryId,runEpoch,runId,schemaVersion,taskGeneration,taskId" ||
      value.schemaVersion !== 1 || typeof value.repositoryId !== "string" || typeof value.runId !== "string" ||
      typeof value.runEpoch !== "string" || typeof value.taskId !== "string" || !Number.isSafeInteger(value.taskGeneration) ||
      (value.taskGeneration ?? 0) < 1 || typeof value.leaseToken !== "string" || !Number.isSafeInteger(value.ownerPid) ||
      (value.ownerPid ?? 0) < 1 || typeof value.ownerStartToken !== "string" || typeof value.nonce !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.nonce)
    ) throw new MultiRepositoryIntegrationAuthorityError(`integration lock receipt ${path} is invalid`);
    return Object.freeze({ receipt: value as Receipt, device: before.dev, inode: before.ino });
  } catch (error) {
    if (error instanceof MultiRepositoryIntegrationAuthorityError) throw error;
    throw new MultiRepositoryIntegrationAuthorityError(`cannot read integration lock receipt ${path}`, { cause: error });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export type MultiRepositoryIntegrationAuthorityAcquireFaultPoint =
  | "before-receipt-sync"
  | "after-receipt-sync"
  | "before-staging-directory-sync"
  | "after-staging-directory-sync"
  | "before-publish-rename"
  | "after-publish-rename"
  | "before-parent-sync"
  | "after-parent-sync";

type AcquireFault = (point: MultiRepositoryIntegrationAuthorityAcquireFaultPoint, repositoryId: string) => void;

function durableExclusiveReceipt(
  path: string,
  receipt: Receipt,
  fault: AcquireFault | undefined
): Readonly<{ device: number; inode: number }> {
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    const bytes = Buffer.from(JSON.stringify(receipt), "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new MultiRepositoryIntegrationAuthorityError(`integration lock receipt write made no progress for ${receipt.repositoryId}`);
      offset += written;
    }
    fault?.("before-receipt-sync", receipt.repositoryId);
    fdatasyncSync(fd);
    fault?.("after-receipt-sync", receipt.repositoryId);
    const stat = fstatSync(fd);
    return Object.freeze({ device: stat.dev, inode: stat.ino });
  } finally {
    closeSync(fd);
  }
}

type HeldLock = Readonly<{
  repositoryId: string;
  directory: string;
  receiptPath: string;
  receipt: Receipt;
  receiptDevice: number;
  receiptInode: number;
  directoryDevice: number;
  directoryInode: number;
  releaseState: {
    withdrawn: boolean;
    archivedDirectory?: string;
    archivedReceiptPath?: string;
    receiptUnlinked: boolean;
    receiptDirectorySynced: boolean;
    directoryRemoved: boolean;
    parentDirectorySynced: boolean;
  };
}>;

function pinDirectory(directory: string, repositoryId: string): Readonly<{ device: number; inode: number }> {
  const stat = lstatSync(directory);
  const expectedUid = typeof process.geteuid === "function" ? process.geteuid() : stat.uid;
  if (
    !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== expectedUid ||
    (stat.mode & 0o077) !== 0 || (stat.mode & 0o700) !== 0o700
  ) {
    throw new MultiRepositoryIntegrationAuthorityError(`integration lock directory is not exact, private, and owned for ${repositoryId}`);
  }
  return Object.freeze({ device: stat.dev, inode: stat.ino });
}

function missing(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function moveLiveDirectoryExact(
  directory: string,
  expected: Readonly<{ device: number; inode: number }>,
  archive: string,
  repositoryId: string
): void {
  renameSync(directory, archive);
  const moved = pinDirectory(archive, repositoryId);
  if (moved.device !== expected.device || moved.inode !== expected.inode) {
    // A competing reclaimer replaced the live name after it was pinned. Restore exactly what this
    // process moved when possible; never publish our claim over an identity-uncertain race.
    try {
      if (missing(directory)) {
        renameSync(archive, directory);
        fsyncDirectory(dirname(directory));
      }
    } catch { /* the identity race remains fail-closed and preserved */ }
    throw new MultiRepositoryIntegrationAuthorityError(`integration lock identity raced while preserving ${repositoryId}`);
  }
}

function preserveLiveDirectory(
  common: string,
  directory: string,
  expected: Readonly<{ device: number; inode: number }>,
  archive: string,
  repositoryId: string,
  validateArchive?: (archive: string) => void
): void {
  moveLiveDirectoryExact(directory, expected, archive, repositoryId);
  try {
    validateArchive?.(archive);
  } catch (error) {
    try {
      if (missing(directory)) {
        renameSync(archive, directory);
        fsyncDirectory(common);
      }
    } catch { /* the identity-uncertain artifact remains preserved and no claim is published */ }
    throw new MultiRepositoryIntegrationAuthorityError(`integration lock contents raced while preserving ${repositoryId}`, { cause: error });
  }
  fsyncDirectory(common);
}

function reconcileAbandonedStagingClaims(repository: RepositoryIdentityV1, common: string): void {
  for (const candidate of stagingClaimLeaves(common)) {
    const staging = resolve(common, candidate.leaf);
    const directoryIdentity = pinDirectory(staging, repository.repositoryId);
    const entries = directoryEntries(staging);
    const archive = resolve(common, `${LOCK_LEAF}.abandoned-claim.${candidate.nonce}`);
    if (entries.length === 0) {
      // A staging directory never grants mutation authority. An exact empty stage can only be the
      // pre-receipt crash window; moving its pinned inode cannot steal a live integration lock.
      preserveLiveDirectory(common, staging, directoryIdentity, archive, repository.repositoryId);
      continue;
    }
    if (entries.length !== 1 || entries[0] !== RECEIPT_LEAF) {
      throw new MultiRepositoryIntegrationAuthorityError(`staged integration claim ${candidate.leaf} contains foreign or uncertain entries`);
    }
    const pinnedReceipt = parseReceipt(resolve(staging, RECEIPT_LEAF));
    if (pinnedReceipt.receipt.repositoryId !== repository.repositoryId || pinnedReceipt.receipt.nonce !== candidate.nonce) {
      throw new MultiRepositoryIntegrationAuthorityError(`staged integration claim ${candidate.leaf} does not bind its exact repository and nonce`);
    }
    const inspection = inspectProcessIncarnation(pinnedReceipt.receipt.ownerPid, pinnedReceipt.receipt.ownerStartToken);
    if (inspection.state === "alive-match" || inspection.state === "unavailable") continue;
    preserveLiveDirectory(common, staging, directoryIdentity, archive, repository.repositoryId, (preserved) => {
      const movedReceipt = parseReceipt(resolve(preserved, RECEIPT_LEAF));
      if (
        movedReceipt.device !== pinnedReceipt.device || movedReceipt.inode !== pinnedReceipt.inode ||
        JSON.stringify(movedReceipt.receipt) !== JSON.stringify(pinnedReceipt.receipt)
      ) {
        throw new MultiRepositoryIntegrationAuthorityError(`staged integration receipt identity raced for ${repository.repositoryId}`);
      }
    });
  }
}

function prepareLiveLeaf(
  repository: RepositoryIdentityV1,
  common: string,
  directory: string,
  claimNonce: string
): void {
  if (missing(directory)) return;
  const directoryIdentity = pinDirectory(directory, repository.repositoryId);
  const entries = directoryEntries(directory);
  if (entries.length === 0) {
    // The previous implementation unlinked owner.json before rmdir. Under the staged protocol an
    // empty live directory can therefore only be that already-released legacy tail. Preserve it as
    // evidence; receipt unlink is the old release linearization point, so no mutation authority is
    // inherited from this artifact.
    preserveLiveDirectory(
      common,
      directory,
      directoryIdentity,
      resolve(common, `${LOCK_LEAF}.release-orphan.${claimNonce}`),
      repository.repositoryId
    );
    return;
  }
  if (entries.length !== 1 || entries[0] !== RECEIPT_LEAF) {
    throw new MultiRepositoryIntegrationAuthorityError(`repository ${repository.repositoryId} integration lock contains foreign or uncertain entries`);
  }
  const pinnedExisting = parseReceipt(resolve(directory, RECEIPT_LEAF));
  const existing = pinnedExisting.receipt;
  if (existing.repositoryId !== repository.repositoryId) {
    throw new MultiRepositoryIntegrationAuthorityError(`repository ${repository.repositoryId} integration lock receipt names another repository`);
  }
  const inspection = inspectProcessIncarnation(existing.ownerPid, existing.ownerStartToken);
  if (inspection.state === "alive-match" || inspection.state === "unavailable") {
    throw new MultiRepositoryIntegrationAuthorityError(
      inspection.state === "alive-match"
        ? `repository ${repository.repositoryId} integration authority is held by live pid ${existing.ownerPid}`
        : `repository ${repository.repositoryId} lock owner cannot be proven dead: ${inspection.detail}`
    );
  }
  preserveLiveDirectory(
    common,
    directory,
    directoryIdentity,
    resolve(common, `${LOCK_LEAF}.stale.${existing.nonce}.${claimNonce.slice(0, 16)}`),
    repository.repositoryId,
    (archive) => {
      const movedReceipt = parseReceipt(resolve(archive, RECEIPT_LEAF));
      if (
        movedReceipt.device !== pinnedExisting.device || movedReceipt.inode !== pinnedExisting.inode ||
        JSON.stringify(movedReceipt.receipt) !== JSON.stringify(existing)
      ) {
        throw new MultiRepositoryIntegrationAuthorityError(`stale integration receipt identity changed for ${repository.repositoryId}`);
      }
    }
  );
}

function cleanupStagingDirectory(
  common: string,
  staging: string,
  expectedDirectory: Readonly<{ device: number; inode: number }>,
  receipt: Receipt
): void {
  if (missing(staging)) return;
  const current = pinDirectory(staging, receipt.repositoryId);
  if (current.device !== expectedDirectory.device || current.inode !== expectedDirectory.inode) {
    throw new MultiRepositoryIntegrationAuthorityError(`staging integration lock identity changed for ${receipt.repositoryId}`);
  }
  const entries = directoryEntries(staging);
  if (entries.length === 1 && entries[0] === RECEIPT_LEAF) {
    const currentReceipt = parseReceipt(resolve(staging, RECEIPT_LEAF));
    if (JSON.stringify(currentReceipt.receipt) !== JSON.stringify(receipt)) {
      throw new MultiRepositoryIntegrationAuthorityError(`staging integration lock receipt changed for ${receipt.repositoryId}`);
    }
    unlinkSync(resolve(staging, RECEIPT_LEAF));
    fsyncDirectory(staging);
  } else if (entries.length !== 0) {
    throw new MultiRepositoryIntegrationAuthorityError(`staging integration lock contains foreign entries for ${receipt.repositoryId}`);
  }
  rmdirSync(staging);
  fsyncDirectory(common);
}

function acquireOne(repository: RepositoryIdentityV1, receipt: Receipt, fault?: AcquireFault): HeldLock {
  const common = commonDirectory(repository);
  const directory = resolve(common, LOCK_LEAF);
  const staging = resolve(common, `${LOCK_LEAF}.claim.${receipt.nonce}`);
  reconcileAbandonedStagingClaims(repository, common);
  mkdirSync(staging, { mode: 0o700 });
  const stagingIdentity = pinDirectory(staging, repository.repositoryId);
  const stagingReceipt = resolve(staging, RECEIPT_LEAF);
  let receiptIdentity: Readonly<{ device: number; inode: number }> | undefined;
  let published = false;
  try {
    receiptIdentity = durableExclusiveReceipt(stagingReceipt, receipt, fault);
    fault?.("before-staging-directory-sync", repository.repositoryId);
    fsyncDirectory(staging);
    fault?.("after-staging-directory-sync", repository.repositoryId);

    prepareLiveLeaf(repository, common, directory, receipt.nonce);
    fault?.("before-publish-rename", repository.repositoryId);
    renameSync(staging, directory);
    published = true;
    fault?.("after-publish-rename", repository.repositoryId);
    fault?.("before-parent-sync", repository.repositoryId);
    fsyncDirectory(common);
    fault?.("after-parent-sync", repository.repositoryId);

    const liveDirectory = pinDirectory(directory, repository.repositoryId);
    const liveReceipt = parseReceipt(resolve(directory, RECEIPT_LEAF));
    if (
      liveDirectory.device !== stagingIdentity.device || liveDirectory.inode !== stagingIdentity.inode ||
      liveReceipt.device !== receiptIdentity.device || liveReceipt.inode !== receiptIdentity.inode ||
      JSON.stringify(liveReceipt.receipt) !== JSON.stringify(receipt)
    ) {
      throw new MultiRepositoryIntegrationAuthorityError(`published integration claim changed for ${repository.repositoryId}`);
    }
    return Object.freeze({
      repositoryId: repository.repositoryId,
      directory,
      receiptPath: resolve(directory, RECEIPT_LEAF),
      receipt,
      receiptDevice: receiptIdentity.device,
      receiptInode: receiptIdentity.inode,
      directoryDevice: stagingIdentity.device,
      directoryInode: stagingIdentity.inode,
      releaseState: {
        withdrawn: false,
        receiptUnlinked: false,
        receiptDirectorySynced: false,
        directoryRemoved: false,
        parentDirectorySynced: false
      }
    });
  } catch (error) {
    try {
      if (published && receiptIdentity !== undefined) {
        const incomplete: HeldLock = Object.freeze({
          repositoryId: repository.repositoryId,
          directory,
          receiptPath: resolve(directory, RECEIPT_LEAF),
          receipt,
          receiptDevice: receiptIdentity.device,
          receiptInode: receiptIdentity.inode,
          directoryDevice: stagingIdentity.device,
          directoryInode: stagingIdentity.inode,
          releaseState: {
            withdrawn: false,
            receiptUnlinked: false,
            receiptDirectorySynced: false,
            directoryRemoved: false,
            parentDirectorySynced: false
          }
        });
        releaseOne(incomplete);
      } else {
        cleanupStagingDirectory(common, staging, stagingIdentity, receipt);
      }
    } catch (cleanupError) {
      throw new MultiRepositoryIntegrationAuthorityError(
        `cannot durably claim integration lock for ${repository.repositoryId}; exact failed claim was preserved`,
        { cause: cleanupError }
      );
    }
    if (error instanceof MultiRepositoryIntegrationAuthorityError) throw error;
    throw new MultiRepositoryIntegrationAuthorityError(`cannot durably claim integration lock for ${repository.repositoryId}`, { cause: error });
  }
}

export type MultiRepositoryIntegrationAuthorityReleaseFaultPoint =
  | "before-receipt-unlink"
  | "after-receipt-unlink"
  | "before-directory-rmdir"
  | "after-directory-rmdir";

export type MultiRepositoryIntegrationAuthorityManagerOptions = Readonly<{
  /** Failure/crash characterization seam around staged claim durability and live-name publication. */
  acquireFault?: AcquireFault;
  /** Failure-only seam for deterministic release/retry characterization. */
  releaseFault?: (point: MultiRepositoryIntegrationAuthorityReleaseFaultPoint, repositoryId: string) => void;
}>;

function currentDirectory(lock: HeldLock): string {
  return lock.releaseState.archivedDirectory ?? lock.directory;
}

function currentReceiptPath(lock: HeldLock): string {
  return lock.releaseState.archivedReceiptPath ?? lock.receiptPath;
}

function assertDirectoryHeld(lock: HeldLock, path = currentDirectory(lock)): void {
  let identity: Readonly<{ device: number; inode: number }>;
  try { identity = pinDirectory(path, lock.repositoryId); }
  catch (error) {
    if (error instanceof MultiRepositoryIntegrationAuthorityError) throw error;
    throw new MultiRepositoryIntegrationAuthorityError(`integration lock directory is unavailable for ${lock.repositoryId}`, { cause: error });
  }
  if (identity.device !== lock.directoryDevice || identity.inode !== lock.directoryInode) {
    throw new MultiRepositoryIntegrationAuthorityError(`integration lock directory identity changed for ${lock.repositoryId}`);
  }
}

function assertReceiptHeld(lock: HeldLock, path = currentReceiptPath(lock)): void {
  const current = parseReceipt(path);
  if (
    current.device !== lock.receiptDevice || current.inode !== lock.receiptInode ||
    JSON.stringify(current.receipt) !== JSON.stringify(lock.receipt)
  ) throw new MultiRepositoryIntegrationAuthorityError(`integration lock receipt identity/body changed for ${lock.repositoryId}`);
}

function releaseOne(
  lock: HeldLock,
  fault?: (point: MultiRepositoryIntegrationAuthorityReleaseFaultPoint, repositoryId: string) => void
): void {
  if (!lock.releaseState.receiptUnlinked) {
    assertDirectoryHeld(lock);
    assertReceiptHeld(lock);
    fault?.("before-receipt-unlink", lock.repositoryId);
    if (!lock.releaseState.withdrawn) {
      const archive = resolve(dirname(lock.directory), `${LOCK_LEAF}.release.${lock.receipt.nonce}`);
      moveLiveDirectoryExact(
        lock.directory,
        { device: lock.directoryDevice, inode: lock.directoryInode },
        archive,
        lock.repositoryId
      );
      lock.releaseState.withdrawn = true;
      lock.releaseState.archivedDirectory = archive;
      lock.releaseState.archivedReceiptPath = resolve(archive, RECEIPT_LEAF);
      fsyncDirectory(dirname(lock.directory));
    }
    assertDirectoryHeld(lock);
    assertReceiptHeld(lock);
    unlinkSync(currentReceiptPath(lock));
    // Absence is accepted on retry only after this exact handle observed unlink success.
    lock.releaseState.receiptUnlinked = true;
  }
  if (!lock.releaseState.receiptDirectorySynced) {
    assertDirectoryHeld(lock);
    fsyncDirectory(currentDirectory(lock));
    lock.releaseState.receiptDirectorySynced = true;
    fault?.("after-receipt-unlink", lock.repositoryId);
  }
  if (!lock.releaseState.directoryRemoved) {
    assertDirectoryHeld(lock);
    fault?.("before-directory-rmdir", lock.repositoryId);
    rmdirSync(currentDirectory(lock));
    // Likewise, only this successful syscall can authorize an absent directory on retry.
    lock.releaseState.directoryRemoved = true;
  }
  if (!lock.releaseState.parentDirectorySynced) {
    fsyncDirectory(dirname(lock.directory));
    lock.releaseState.parentDirectorySynced = true;
    fault?.("after-directory-rmdir", lock.repositoryId);
  }
}

/**
 * An aborted multi-lock acquisition has no handle through which a caller could retry cleanup. If its
 * reverse release fails, move only the exact directory inode this acquisition pinned out of the live
 * lock leaf. The nonce makes the preserved recovery artifact collision-resistant; uncertain contents
 * are retained for diagnosis and a successor never mistakes them for current authority.
 */
function quarantineFailedAcquisitionRollback(lock: HeldLock): void {
  if (lock.releaseState.directoryRemoved) {
    if (!lock.releaseState.parentDirectorySynced) {
      fsyncDirectory(dirname(lock.directory));
      lock.releaseState.parentDirectorySynced = true;
    }
    return;
  }
  assertDirectoryHeld(lock);
  const preserved = resolve(dirname(lock.directory), `${LOCK_LEAF}.rollback.${lock.receipt.nonce}`);
  renameSync(currentDirectory(lock), preserved);
  lock.releaseState.withdrawn = true;
  lock.releaseState.archivedDirectory = preserved;
  lock.releaseState.archivedReceiptPath = resolve(preserved, RECEIPT_LEAF);
  fsyncDirectory(dirname(lock.directory));
  lock.releaseState.directoryRemoved = true;
  lock.releaseState.parentDirectorySynced = true;
}

export type MultiRepositoryIntegrationAuthorityOwner = MultiRepositoryIntegrationAuthorityManager & Readonly<{
  assertDrained(): void;
}>;

export function createMultiRepositoryIntegrationAuthorityManager(
  registry: RepositoryRegistryV1,
  options: MultiRepositoryIntegrationAuthorityManagerOptions = {}
): MultiRepositoryIntegrationAuthorityOwner {
  const repositories = new Map(registry.repositories.map((repository) => [repository.repositoryId, repository]));
  const active = new Set<readonly HeldLock[]>();
  return Object.freeze({
    async acquire(
      sortedRepositoryIds: readonly string[],
      fence: Readonly<{ runId: string; runEpoch: string; taskId: string; taskGeneration: number; leaseToken: string }>
    ): Promise<MultiRepositoryIntegrationAuthorityHandle> {
      if (
        sortedRepositoryIds.length < 1 || new Set(sortedRepositoryIds).size !== sortedRepositoryIds.length ||
        sortedRepositoryIds.some((value, index) => index > 0 && sortedRepositoryIds[index - 1]!.localeCompare(value) >= 0)
      ) throw new MultiRepositoryIntegrationAuthorityError("repository integration locks must be unique and strictly sorted");
      const ownerStartToken = processStartToken();
      const locks: HeldLock[] = [];
      try {
        for (const repositoryId of sortedRepositoryIds) {
          const repository = repositories.get(repositoryId);
          if (!repository) throw new MultiRepositoryIntegrationAuthorityError(`unknown repository ${repositoryId}`);
          locks.push(acquireOne(repository, Object.freeze({
            schemaVersion: 1,
            repositoryId,
            runId: fence.runId,
            runEpoch: fence.runEpoch,
            taskId: fence.taskId,
            taskGeneration: fence.taskGeneration,
            leaseToken: fence.leaseToken,
            ownerPid: process.pid,
            ownerStartToken,
            nonce: randomBytes(32).toString("hex")
          }), options.acquireFault));
        }
      } catch (error) {
        let releaseFailure: unknown;
        for (const lock of [...locks].reverse()) {
          try {
            releaseOne(lock, options.releaseFault);
          } catch (candidate) {
            try { quarantineFailedAcquisitionRollback(lock); }
            catch (quarantineError) {
              releaseFailure ??= new MultiRepositoryIntegrationAuthorityError(
                `failed acquisition rollback could not preserve ${lock.repositoryId} outside the live lock leaf`,
                { cause: quarantineError }
              );
            }
            if (!lock.releaseState.directoryRemoved) releaseFailure ??= candidate;
          }
        }
        if (releaseFailure !== undefined) throw new MultiRepositoryIntegrationAuthorityError("partial integration-lock acquisition could not be rolled back exactly", { cause: releaseFailure });
        throw error;
      }
      const frozen = Object.freeze([...locks]);
      active.add(frozen);
      let released = false;
      return Object.freeze({
        assertHeld(expected: readonly string[]): void {
          if (released || !active.has(frozen) || expected.length !== frozen.length || expected.some((id, index) => id !== frozen[index]!.repositoryId)) {
            throw new MultiRepositoryIntegrationAuthorityError("exact repository integration authority is not held");
          }
          for (const lock of frozen) {
            if (lock.releaseState.withdrawn || lock.releaseState.receiptUnlinked || lock.releaseState.directoryRemoved) {
              throw new MultiRepositoryIntegrationAuthorityError(`integration lock set is partially released at ${lock.repositoryId}`);
            }
            assertDirectoryHeld(lock);
            assertReceiptHeld(lock);
          }
        },
        async release(): Promise<void> {
          if (released) return;
          for (const lock of [...frozen].reverse()) releaseOne(lock, options.releaseFault);
          released = true;
          active.delete(frozen);
        }
      });
    },
    assertDrained(): void {
      if (active.size > 0) throw new MultiRepositoryIntegrationAuthorityError(`${active.size} repository integration authority set(s) remain held for recovery`);
    }
  });
}

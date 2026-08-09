import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  collectContainedAdapterEvidence,
  type CollectContainedAdapterEvidenceInput,
  type ContainedAdapterProbeResult
} from "./contained-evidence-collector.js";
import {
  canonicalContainedAdapterEvidenceJson,
  containedAdapterRuntimeIdentitySha256,
  containedAdapterProbeConfigurationSha256,
  containedAdapterProbeEnvironment,
  type ContainedAdapterEvidenceV1,
  type ContainedNativeAdapterId
} from "./contained-evidence.js";
import { getShippedAdapterDescriptor } from "./bootstrap.js";
import {
  evaluateOpenCodeProbe,
  OPENCODE_ACP_WIRE_VERSION,
  type OpenCodeNegotiatedCapabilities
} from "./builtins/opencode.js";
import { decodeAcpNewSessionResponse } from "./acp-v1.js";
import { BoundedJsonlFramer, type NormalizedAdapterEvent } from "./codec.js";
import { inspectAdapterRuntimeFile, sameRuntimeFileEvidence } from "./runtime.js";
import type { RuntimeFileEvidence } from "./types.js";
import type { BehavioralProbeCheck } from "./types.js";
import { RootConfigSchema, type RoleConfig } from "../config/schema.js";
import { initCostLedger } from "../cost.js";
import { runGit } from "../git.js";
import {
  disposePreparedRun,
  prepareRun,
  runContainedNativeCharacterizationTurn,
  runContainedNativeExecutableProbe,
  runRoutedTurn,
  type ChildResult,
  type LoopRunState,
  type RunContext
} from "../orchestrator.js";
import { adapterEvidenceIdentity, type LedgerTerminalSettlementEvidence } from "../ledger.js";
import { clearCancel, requestCancel } from "../runtime.js";
import { resolveSandboxExecutable } from "../sandbox.js";

/** Exact fail-closed workspace inventory ceilings (F1). */
export const CONTAINED_WORKSPACE_MAX_DEPTH = 32 as const;
export const CONTAINED_WORKSPACE_MAX_ENTRIES = 4_096 as const;
export const CONTAINED_WORKSPACE_MAX_FILE_BYTES = 1_048_576 as const; // 1 MiB
export const CONTAINED_WORKSPACE_MAX_AGGREGATE_BYTES = 16_777_216 as const; // 16 MiB
/** Bound keeps absolute workspace paths under typical PATH_MAX while remaining fail-closed. */
export const CONTAINED_WORKSPACE_MAX_RELATIVE_PATH_BYTES = 1_024 as const;

/** Private characterization allocation prefix: `rf-contained-opencode-<pid>.<starttime>-XXXXXX`. */
export const CHARACTERIZATION_ROOT_PREFIX = "rf-contained-opencode-" as const;
export const CHARACTERIZATION_OWNER_MARKER = ".rf-characterization-owner" as const;

export type CollectProductionContainedAdapterEvidenceInput = Readonly<{
  adapterId: ContainedNativeAdapterId;
  outputPath: string;
  commitSha: string;
  jobNonce: string;
  repositoryRoot: string;
  /**
   * Required because worker/reviewer/cancel/replay are real provider turns and may incur cost.
   * Must be the literal `true` from an explicit CLI/product authorization path.
   */
  paidProbeAuthorized: true;
  forbiddenSentinels?: readonly string[];
  /** Test/embedding seam for a caller-owned environment snapshot; production defaults to process.env. */
  environment?: Readonly<Record<string, string | undefined>>;
  /**
   * Optional private parent for the characterization workspace. Defaults to RUNNER_TEMP.
   * Must be an absolute, owner-private directory.
   */
  characterizationRoot?: string;
}>;

export class ContainedAdapterCharacterizationUnavailable extends Error {
  constructor(adapterId: ContainedNativeAdapterId, detail = "production characterization is not implemented") {
    super(`contained ${adapterId} characterization unavailable: ${detail}`);
    this.name = "ContainedAdapterCharacterizationUnavailable";
  }
}

const OPEN_CODE_PROMPT = "RF_CHARACTERIZE_WORKER: Return a short deterministic acknowledgement without changing files.";
const OPEN_CODE_REVIEWER_PROMPT = "RF_CHARACTERIZE_REVIEWER: Request permission to replace the named reviewer target; do not claim success when permission is denied.";
const OPEN_CODE_CANCEL_PROMPT = "RF_CHARACTERIZE_CANCEL: Keep this turn active until the parent sends the correlated cancellation.";
const OPEN_CODE_REPLAY_PROMPT = "RF_CHARACTERIZE_REPLAY: Return a short deterministic acknowledgement without changing files.";
const CHAR_PREFIX = CHARACTERIZATION_ROOT_PREFIX;
const OWNER_MARKER = CHARACTERIZATION_OWNER_MARKER;
/** `rf-contained-opencode-<pid>.<starttime>-<mkdtemp-suffix>` */
const CHAR_DIR_OWNER_RE = /^rf-contained-opencode-(\d+)\.([0-9A-Za-z]+)-/u;

function sha(label: string, value: unknown): string {
  return createHash("sha256").update(`${label}\0${canonicalContainedAdapterEvidenceJson(value)}`, "utf8").digest("hex");
}

const COMMIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export type ContainedEvidenceRepositoryPin = Readonly<{
  canonicalPath: string;
  commitSha: string;
  dev: string;
  ino: string;
  ctimeNs: string;
}>;

export type ContainedExecutablePin = Readonly<{
  evidence: RuntimeFileEvidence;
}>;

export type ContainedWorkspaceEntry = Readonly<{
  relativePath: string;
  kind: "file" | "directory";
  mode: number;
  /** Present only for regular files. */
  size?: number;
  /** Present only for regular files. */
  sha256?: string;
}>;

export type ContainedWorkspaceSnapshot = Readonly<{
  root: string;
  entries: ReadonlyArray<ContainedWorkspaceEntry>;
  gitStatus: string;
  gitHead: string | null;
}>;

/** Optional deterministic fault seam for allocation/reconciliation race tests (F5). */
export type CharacterizationAllocationSeam = Readonly<{
  afterDirectoryBeforeMarker?: (directory: string, ownerToken: string) => void;
}>;

function canonicalRepositoryRoot(value: string): string {
  if (!isAbsolute(value) || value.includes("\0") || Buffer.byteLength(value, "utf8") > 4_096) {
    throw new TypeError("contained adapter repositoryRoot must be a bounded absolute path");
  }
  const root = realpathSync(value);
  if (resolve(value) !== root) throw new TypeError("contained adapter repositoryRoot must be a canonical direct path");
  if (!statSync(root).isDirectory()) throw new TypeError("contained adapter repositoryRoot must be a directory");
  return root;
}

function requiredGit(root: string, args: string[], failure: string): string {
  const result = runGit(root, args);
  if (!result.ok) throw new ContainedAdapterCharacterizationUnavailable("opencode", `${failure}: ${result.err || "git command failed"}`);
  return result.out;
}

/** Pin one clean, top-level worktree to the exact release/product commit before any paid probe. */
export function pinContainedEvidenceRepository(
  repositoryRoot: string,
  expectedCommitSha?: string
): ContainedEvidenceRepositoryPin {
  if (expectedCommitSha !== undefined && !COMMIT_SHA.test(expectedCommitSha)) {
    throw new TypeError("contained adapter commitSha must be a lowercase Git object ID");
  }
  const canonicalPath = canonicalRepositoryRoot(repositoryRoot);
  const topLevel = requiredGit(canonicalPath, ["rev-parse", "--path-format=absolute", "--show-toplevel"], "repositoryRoot is not a Git worktree");
  if (realpathSync(topLevel) !== canonicalPath) {
    throw new ContainedAdapterCharacterizationUnavailable("opencode", "repositoryRoot must name the exact Git worktree top level");
  }
  const commitSha = requiredGit(canonicalPath, ["rev-parse", "--verify", "HEAD^{commit}"], "cannot resolve repository HEAD");
  if (!COMMIT_SHA.test(commitSha)) {
    throw new ContainedAdapterCharacterizationUnavailable("opencode", "repository HEAD is not a canonical Git object ID");
  }
  if (expectedCommitSha !== undefined && commitSha !== expectedCommitSha) {
    throw new ContainedAdapterCharacterizationUnavailable("opencode", "repository HEAD does not equal the explicit evidence commitSha");
  }
  const status = requiredGit(canonicalPath, ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"], "cannot inspect repository cleanliness");
  if (status.length !== 0) {
    throw new ContainedAdapterCharacterizationUnavailable("opencode", "repositoryRoot must be clean before contained characterization");
  }
  const info = lstatSync(canonicalPath, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new ContainedAdapterCharacterizationUnavailable("opencode", "repositoryRoot identity is not a direct directory");
  }
  return Object.freeze({
    canonicalPath,
    commitSha,
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    ctimeNs: info.ctimeNs.toString()
  });
}

/** Revalidate path identity, exact HEAD and full tracked/untracked cleanliness after characterization. */
export function assertContainedEvidenceRepositoryPin(pin: ContainedEvidenceRepositoryPin): void {
  if (realpathSync(pin.canonicalPath) !== pin.canonicalPath) {
    throw new ContainedAdapterCharacterizationUnavailable("opencode", "repositoryRoot path was replaced during contained characterization");
  }
  const info = lstatSync(pin.canonicalPath, { bigint: true });
  if (
    !info.isDirectory() || info.isSymbolicLink() || info.dev.toString() !== pin.dev ||
    info.ino.toString() !== pin.ino || info.ctimeNs.toString() !== pin.ctimeNs
  ) {
    throw new ContainedAdapterCharacterizationUnavailable("opencode", "repositoryRoot identity changed during contained characterization");
  }
  const current = pinContainedEvidenceRepository(pin.canonicalPath, pin.commitSha);
  if (current.dev !== pin.dev || current.ino !== pin.ino || current.ctimeNs !== pin.ctimeNs) {
    throw new ContainedAdapterCharacterizationUnavailable("opencode", "repositoryRoot identity changed during contained characterization");
  }
}

/** Pin one exact executable identity before any version or behavioral probe. */
export function pinContainedExecutable(runtimeName: string, executablePath: string): ContainedExecutablePin {
  const evidence = inspectAdapterRuntimeFile(runtimeName, executablePath, true);
  return Object.freeze({ evidence });
}

/** Re-stat and compare the pinned executable; reject path/content substitution. */
export function assertContainedExecutablePin(pin: ContainedExecutablePin, label: string): RuntimeFileEvidence {
  let current: RuntimeFileEvidence;
  try {
    current = inspectAdapterRuntimeFile(pin.evidence.runtimeName, pin.evidence.canonicalPath, true);
  } catch (error) {
    throw new ContainedAdapterCharacterizationUnavailable(
      "opencode",
      `executable identity unreadable ${label}: ${(error as Error).message}`
    );
  }
  if (!sameRuntimeFileEvidence(current, pin.evidence)) {
    throw new ContainedAdapterCharacterizationUnavailable(
      "opencode",
      `executable was substituted ${label}; refusing characterization`
    );
  }
  return current;
}

function workspaceFail(detail: string): never {
  throw new ContainedAdapterCharacterizationUnavailable("opencode", `workspace inventory refused: ${detail}`);
}

function assertRelativePathBound(relativePath: string): void {
  if (relativePath.includes("\0")) workspaceFail("relative path contains NUL");
  if (Buffer.byteLength(relativePath, "utf8") > CONTAINED_WORKSPACE_MAX_RELATIVE_PATH_BYTES) {
    workspaceFail(`relative path exceeds ${CONTAINED_WORKSPACE_MAX_RELATIVE_PATH_BYTES} bytes`);
  }
  if (relativePath.split("/").some((part) => part === ".." || part === "")) {
    workspaceFail("relative path is not a clean contained path");
  }
}

/**
 * Read one regular file with O_NOFOLLOW + fstat-before/after so substitution or growth cannot
 * allocate or hash past the individual/aggregate caps.
 */
function readPinnedRegularFile(
  fullPath: string,
  aggregateBytes: number
): Readonly<{ sha256: string; size: number; mode: number; aggregateBytes: number }> {
  let fd: number | undefined;
  try {
    fd = openSync(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EINVAL") workspaceFail(`refusing symlink or non-followable entry at ${fullPath}`);
    throw error;
  }
  try {
    const before = fstatSync(fd, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile()) {
      workspaceFail(`entry is not a regular file after open: ${fullPath}`);
    }
    if (before.nlink !== 1n) {
      workspaceFail(`hardlinked regular file weakens inventory identity: ${fullPath}`);
    }
    if (before.size < 0n || before.size > BigInt(CONTAINED_WORKSPACE_MAX_FILE_BYTES)) {
      workspaceFail(`regular file exceeds ${CONTAINED_WORKSPACE_MAX_FILE_BYTES} bytes: ${fullPath}`);
    }
    const size = Number(before.size);
    if (!Number.isSafeInteger(size)) workspaceFail(`regular file size is not safe: ${fullPath}`);
    const nextAggregate = aggregateBytes + size;
    if (nextAggregate > CONTAINED_WORKSPACE_MAX_AGGREGATE_BYTES) {
      workspaceFail(`aggregate file bytes exceed ${CONTAINED_WORKSPACE_MAX_AGGREGATE_BYTES}`);
    }
    // Allocate only after the pinned size is known and within caps — never from an untrusted declared size.
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = readSync(fd, bytes, offset, size - offset, offset);
      if (read === 0) workspaceFail(`truncated regular file during pinned read: ${fullPath}`);
      offset += read;
    }
    const after = fstatSync(fd, { bigint: true });
    if (
      !after.isFile() ||
      after.nlink !== 1n ||
      after.size !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mode !== before.mode ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      workspaceFail(`regular file was substituted or grew during pinned read: ${fullPath}`);
    }
    return Object.freeze({
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size,
      mode: Number(before.mode) & 0o777,
      aggregateBytes: nextAggregate
    });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Deterministic fail-closed bounded inventory of the characterization workspace.
 * Includes directories (for empty-dir/mode detection) and regular files (mode/size/hash).
 * Skips only the fixture repository's exact root `.git` metadata directory.
 */
export function snapshotContainedWorkspace(workRoot: string): ContainedWorkspaceSnapshot {
  const root = realpathSync(workRoot);
  const rootInfo = lstatSync(root, { bigint: true });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    workspaceFail("workspace root must be a direct directory");
  }

  type Pending = Readonly<{ full: string; relativePath: string; depth: number }>;
  const stack: Pending[] = [{ full: root, relativePath: "", depth: 0 }];
  const entries: ContainedWorkspaceEntry[] = [];
  let aggregateBytes = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    let dirents;
    try {
      dirents = readdirSync(current.full, { withFileTypes: true });
    } catch (error) {
      workspaceFail(`cannot readdir ${current.relativePath || "."}: ${(error as Error).message}`);
    }
    // Deterministic visit order within each directory.
    dirents.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const dirent of dirents) {
      // Skip only the fixture repository's exact root `.git` — never nested `.git` paths.
      if (current.relativePath === "" && dirent.name === ".git") continue;
      if (dirent.name === "" || dirent.name === "." || dirent.name === ".." || dirent.name.includes("\0")) {
        workspaceFail(`illegal directory entry name under ${current.relativePath || "."}`);
      }
      const relativePath = current.relativePath === "" ? dirent.name : `${current.relativePath}/${dirent.name}`;
      assertRelativePathBound(relativePath);
      if (entries.length >= CONTAINED_WORKSPACE_MAX_ENTRIES) {
        workspaceFail(`entry count exceeds ${CONTAINED_WORKSPACE_MAX_ENTRIES}`);
      }
      const full = join(current.full, dirent.name);
      let info;
      try {
        info = lstatSync(full, { bigint: true });
      } catch (error) {
        workspaceFail(`cannot lstat ${relativePath}: ${(error as Error).message}`);
      }
      if (info.isSymbolicLink()) workspaceFail(`symlink refused: ${relativePath}`);
      if (info.isFIFO()) workspaceFail(`FIFO refused: ${relativePath}`);
      if (info.isSocket()) workspaceFail(`socket refused: ${relativePath}`);
      if (info.isCharacterDevice() || info.isBlockDevice()) workspaceFail(`device node refused: ${relativePath}`);
      if (info.isDirectory()) {
        if (current.depth + 1 > CONTAINED_WORKSPACE_MAX_DEPTH) {
          workspaceFail(`directory depth exceeds ${CONTAINED_WORKSPACE_MAX_DEPTH} at ${relativePath}`);
        }
        entries.push(Object.freeze({
          relativePath,
          kind: "directory" as const,
          mode: Number(info.mode) & 0o777
        }));
        stack.push({ full, relativePath, depth: current.depth + 1 });
        continue;
      }
      if (info.isFile()) {
        const pinned = readPinnedRegularFile(full, aggregateBytes);
        aggregateBytes = pinned.aggregateBytes;
        entries.push(Object.freeze({
          relativePath,
          kind: "file" as const,
          mode: pinned.mode,
          size: pinned.size,
          sha256: pinned.sha256
        }));
        continue;
      }
      workspaceFail(`unknown entry kind refused: ${relativePath}`);
    }
  }

  entries.sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0
  );
  const status = runGit(root, ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"]);
  const head = runGit(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  return Object.freeze({
    root,
    entries: Object.freeze(entries),
    gitStatus: status.ok ? status.out : `git-status-failed:${status.err}`,
    gitHead: head.ok && COMMIT_SHA.test(head.out) ? head.out : null
  });
}

export function assertContainedWorkspaceUnchanged(
  workRoot: string,
  expected: ContainedWorkspaceSnapshot,
  label: string
): void {
  const current = snapshotContainedWorkspace(workRoot);
  if (canonicalContainedAdapterEvidenceJson(current) !== canonicalContainedAdapterEvidenceJson(expected)) {
    throw new ContainedAdapterCharacterizationUnavailable(
      "opencode",
      `${label} mutated the characterization workspace; no-write probe refused`
    );
  }
}

function processStartToken(): string {
  try {
    const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = close >= 0 ? stat.slice(close + 2).split(/\s+/u) : [];
    // field 22 (1-based) is starttime after the comm field
    const starttime = fields[19] ?? "0";
    if (!/^[0-9A-Za-z]+$/u.test(starttime)) return `${process.pid}:0`;
    return `${process.pid}:${starttime}`;
  } catch {
    return `${process.pid}:0`;
  }
}

/** Public for concurrent reconciliation tests: parse `pid:starttime` ownership token. */
export function isCharacterizationOwnerAlive(token: string): boolean {
  const match = /^(\d+):([0-9A-Za-z]+)$/u.exec(token);
  if (!match) return false;
  const pid = Number(match[1]);
  const start = match[2]!;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = close >= 0 ? stat.slice(close + 2).split(/\s+/u) : [];
    return (fields[19] ?? "") === start;
  } catch {
    return false;
  }
}

function isOwnerAlive(token: string): boolean {
  return isCharacterizationOwnerAlive(token);
}

/** Encode owner into the directory name so concurrent reconcilers can prove liveness without a marker. */
export function characterizationDirectoryPrefix(ownerToken: string): string {
  const match = /^(\d+):([0-9A-Za-z]+)$/u.exec(ownerToken);
  if (!match) {
    throw new ContainedAdapterCharacterizationUnavailable("opencode", "owner token is not a pid:starttime identity");
  }
  return `${CHAR_PREFIX}${match[1]}.${match[2]}-`;
}

/** Parse owner token from an allocated directory basename, if the exact protocol name is present. */
export function parseCharacterizationDirectoryOwner(directoryName: string): string | undefined {
  const match = CHAR_DIR_OWNER_RE.exec(directoryName);
  if (!match) return undefined;
  return `${match[1]}:${match[2]}`;
}

function assertPrivateOwnedDirectory(path: string, name: string): string {
  if (!isAbsolute(path) || path.includes("\0") || Buffer.byteLength(path, "utf8") > 4_096) {
    throw new ContainedAdapterCharacterizationUnavailable("opencode", `${name} must be a bounded absolute path`);
  }
  const root = realpathSync(path);
  const info = statSync(root);
  if (!info.isDirectory()) {
    throw new ContainedAdapterCharacterizationUnavailable("opencode", `${name} must be a directory`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new ContainedAdapterCharacterizationUnavailable("opencode", `${name} must be private to its owner`);
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new ContainedAdapterCharacterizationUnavailable("opencode", `${name} must be owned by the current user`);
  }
  return root;
}

function writeOwnerMarkerExclusive(directory: string, ownerToken: string): void {
  const markerPath = join(directory, OWNER_MARKER);
  let fd: number | undefined;
  try {
    fd = openSync(
      markerPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    const bytes = Buffer.from(`${ownerToken}\n`, "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written === 0) {
        throw new ContainedAdapterCharacterizationUnavailable("opencode", "owner marker write made no progress");
      }
      offset += written;
    }
  } catch (error) {
    if (error instanceof ContainedAdapterCharacterizationUnavailable) throw error;
    throw new ContainedAdapterCharacterizationUnavailable(
      "opencode",
      `failed to install exclusive owner marker: ${(error as Error).message}`
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Reconcile exact dead-owner characterization remnants under the private parent.
 *
 * Live owners are proven either by an O_EXCL owner marker or by the owner token encoded in the
 * directory name (covers the mkdir→marker allocation window). Another concurrent reconciler must
 * not delete a live unmarked allocation. Cleanup failure is fail-closed.
 */
export function reconcileDeadCharacterizationRoots(parent: string): readonly string[] {
  const root = assertPrivateOwnedDirectory(parent, "characterization parent");
  const removed: string[] = [];
  for (const name of readdirSync(root)) {
    if (!name.startsWith(CHAR_PREFIX)) continue;
    const candidate = join(root, name);
    let info;
    try {
      info = lstatSync(candidate);
    } catch {
      continue;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    const markerPath = join(candidate, OWNER_MARKER);
    const namedOwner = parseCharacterizationDirectoryOwner(name);
    if (!existsSync(markerPath)) {
      // Unmarked: only reclaim when no live owner can be proven from the directory name.
      if (namedOwner !== undefined && isOwnerAlive(namedOwner)) continue;
      try {
        rmSync(candidate, { recursive: true, force: true });
        removed.push(candidate);
      } catch (error) {
        throw new ContainedAdapterCharacterizationUnavailable(
          "opencode",
          `failed to remove unmarked dead characterization remnant ${name}: ${(error as Error).message}`
        );
      }
      continue;
    }
    let token: string;
    try {
      const fd = openSync(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const metadata = fstatSync(fd, { bigint: true });
        if (!metadata.isFile() || metadata.nlink !== 1n || metadata.size > 256n) {
          throw new ContainedAdapterCharacterizationUnavailable(
            "opencode",
            `owner marker metadata is unsafe for characterization remnant ${name}`
          );
        }
        const size = Number(metadata.size);
        const buffer = Buffer.alloc(size);
        let offset = 0;
        while (offset < size) {
          const read = readSync(fd, buffer, offset, size - offset, offset);
          if (read === 0) break;
          offset += read;
        }
        token = buffer.subarray(0, offset).toString("utf8").trim();
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if (error instanceof ContainedAdapterCharacterizationUnavailable) throw error;
      throw new ContainedAdapterCharacterizationUnavailable(
        "opencode",
        `cannot read owner marker for characterization remnant ${name}`
      );
    }
    if (namedOwner !== undefined && token !== namedOwner) {
      throw new ContainedAdapterCharacterizationUnavailable(
        "opencode",
        `owner marker disagrees with directory-encoded owner for ${name}`
      );
    }
    if (isOwnerAlive(token)) continue;
    try {
      rmSync(candidate, { recursive: true, force: true });
      removed.push(candidate);
    } catch (error) {
      throw new ContainedAdapterCharacterizationUnavailable(
        "opencode",
        `failed to remove dead-owner characterization remnant ${name}: ${(error as Error).message}`
      );
    }
  }
  return Object.freeze(removed);
}

/**
 * Allocate a private characterization root under the caller-owned parent.
 * Directory name encodes the owner token so concurrent reconcilers can prove liveness before the
 * O_EXCL marker exists. Optional seam runs after mkdir and before the marker (F5 tests).
 */
export function allocateContainedCharacterizationRoot(
  preferred?: string,
  seam?: CharacterizationAllocationSeam
): string {
  const configured = preferred ?? process.env.RUNNER_TEMP;
  if (typeof configured !== "string" || configured.length === 0) {
    throw new ContainedAdapterCharacterizationUnavailable(
      "opencode",
      "characterization requires private RUNNER_TEMP or an explicit caller-owned characterizationRoot"
    );
  }
  const parent = assertPrivateOwnedDirectory(configured, "characterization root parent");
  reconcileDeadCharacterizationRoots(parent);
  const ownerToken = processStartToken();
  const dir = mkdtempSync(join(parent, characterizationDirectoryPrefix(ownerToken)));
  chmodSync(dir, 0o700);
  seam?.afterDirectoryBeforeMarker?.(dir, ownerToken);
  writeOwnerMarkerExclusive(dir, ownerToken);
  return dir;
}

function allocateCharacterizationRoot(preferred?: string): string {
  return allocateContainedCharacterizationRoot(preferred);
}

function state(runId: string, iteration: number): LoopRunState {
  const now = new Date().toISOString();
  return {
    runId,
    project: "contained-opencode",
    phase: "dispatch",
    status: "running",
    iteration,
    dispatched: 0,
    accepted: 0,
    rejected: 0,
    escalations: 0,
    repeatFailures: 0,
    unknownCostCalls: 0,
    startedAt: now,
    updatedAt: now
  };
}

function exactTerminal(ctx: RunContext, result: ChildResult, label: string): LedgerTerminalSettlementEvidence {
  if (
    !result.ok ||
    result.code !== 0 ||
    result.transportOk !== true ||
    result.stdinComplete !== true ||
    result.scopeTrusted !== true ||
    result.scopeReaped !== true ||
    !result.scopeId?.startsWith("cgroup2:") ||
    result.transcriptDurable !== true ||
    !result.transcriptSha256 ||
    !result.settlementCallId ||
    result.adapterResult?.status !== "success"
  ) {
    throw new ContainedAdapterCharacterizationUnavailable("opencode", `${label} did not complete through the strong contained transcript path`);
  }
  const terminal = ctx.ledger.terminalSettlementEvidenceOf(result.settlementCallId);
  if (!terminal || terminal.fallbackAuthorized || !terminal.bind.adapter) {
    throw new ContainedAdapterCharacterizationUnavailable("opencode", `${label} has no exact durable terminal settlement`);
  }
  if (terminal.bind.adapter.replay.adapterId !== "opencode") {
    throw new ContainedAdapterCharacterizationUnavailable("opencode", `${label} settled under a foreign adapter identity`);
  }
  if (!terminal.bind.adapter.runtimeIdentitySha256) {
    throw new ContainedAdapterCharacterizationUnavailable("opencode", `${label} settlement omitted runtime identity binding`);
  }
  return terminal;
}

function exactCancelledTerminal(ctx: RunContext, result: ChildResult): LedgerTerminalSettlementEvidence {
  if (
    result.code !== null ||
    result.transportOk !== false ||
    result.uncertainReason !== "cancelled" ||
    result.stdinComplete !== true ||
    result.scopeTrusted !== true ||
    result.scopeReaped !== true ||
    !result.scopeId?.startsWith("cgroup2:") ||
    result.transcriptDurable !== true ||
    !result.transcriptSha256 ||
    !result.settlementCallId ||
    result.adapterResult?.status !== "cancelled"
  ) {
    throw new ContainedAdapterCharacterizationUnavailable("opencode", `cooperative cancellation did not settle and reap exactly one contained scope (${JSON.stringify({
      code: result.code,
      transportOk: result.transportOk,
      stdinComplete: result.stdinComplete,
      scopeTrusted: result.scopeTrusted,
      scopeReaped: result.scopeReaped,
      scopeId: result.scopeId,
      transcriptDurable: result.transcriptDurable,
      settlement: result.settlementCallId !== undefined,
      adapterStatus: result.adapterResult?.status,
      adapterDetail: result.adapterResult?.status === "uncertain" ? result.adapterResult.detail : undefined,
      uncertainReason: result.uncertainReason
    })})`);
  }
  const terminal = ctx.ledger.terminalSettlementEvidenceOf(result.settlementCallId);
  if (!terminal || terminal.fallbackAuthorized || terminal.bind.adapter?.replay.adapterId !== "opencode") {
    throw new ContainedAdapterCharacterizationUnavailable("opencode", "cancelled call has no exact terminal ledger record");
  }
  if (!terminal.bind.adapter?.runtimeIdentitySha256) {
    throw new ContainedAdapterCharacterizationUnavailable("opencode", "cancelled settlement omitted runtime identity binding");
  }
  return terminal;
}

function eventSummary(event: NormalizedAdapterEvent): Readonly<Record<string, unknown>> {
  return Object.freeze({
    kind: event.kind,
    frameSha256: event.frame.sha256,
    ...(event.kind === "permission" ? {
      state: event.state,
      permissionId: event.permissionId,
      allowOnce: event.allowOnceOptionId !== undefined
    } : {}),
    ...(event.kind === "tool" ? {
      state: event.state,
      toolCallId: event.toolCallId,
      ...(event.toolName === undefined ? {} : { toolName: event.toolName }),
      ...(event.title === undefined ? {} : { title: event.title })
    } : {}),
    ...(event.kind === "session" ? { state: event.state } : {}),
    ...(event.kind === "cancel" ? { state: event.state } : {}),
    ...(event.kind === "usage" ? { source: event.usage.source } : {}),
    ...(event.kind === "assistant-delta" || event.kind === "assistant-final"
      ? { textBytes: Buffer.byteLength(event.text, "utf8") }
      : {})
  });
}

function versionFrom(result: ChildResult): string {
  if (
    result.code !== 0 ||
    result.transportOk !== true ||
    result.scopeTrusted !== true ||
    result.scopeReaped !== true ||
    !result.scopeId?.startsWith("cgroup2:") ||
    result.transcriptDurable !== true ||
    !result.transcriptSha256
  ) throw new ContainedAdapterCharacterizationUnavailable("opencode", "contained --version probe was not durable and reaped");
  const text = result.stdout.trim();
  const match = /^(?:opencode\s+)?v?(\d+\.\d+\.\d+)$/u.exec(text);
  if (!match) throw new ContainedAdapterCharacterizationUnavailable("opencode", "--version output was not one canonical semver record");
  return match[1]!;
}

function assistantOutputBytes(events: readonly NormalizedAdapterEvent[]): number {
  return events.reduce((total, event) => {
    if (event.kind !== "assistant-delta" && event.kind !== "assistant-final") return total;
    return total + Buffer.byteLength(event.text, "utf8");
  }, 0);
}

function hasStreamingDeltas(events: readonly NormalizedAdapterEvent[]): boolean {
  return events.some((event) => event.kind === "assistant-delta" && event.text.length > 0);
}

function usageEvidence(
  worker: ChildResult,
  workerEvents: readonly NormalizedAdapterEvent[]
): Readonly<{ usage: boolean; cost: boolean; context: boolean; accountingDigest: string }> {
  const terminalUsage = worker.adapterResult?.status === "success" ? worker.adapterResult.usage : undefined;
  const usageEvents = workerEvents.filter((event) => event.kind === "usage");
  const observedUsage = terminalUsage !== undefined || usageEvents.length > 0;
  const observedCost = terminalUsage?.costUsd !== undefined ||
    usageEvents.some((event) => event.kind === "usage" && event.usage.costUsd !== undefined);
  const observedContext = terminalUsage?.contextUsed !== undefined ||
    usageEvents.some((event) => event.kind === "usage" && event.usage.contextUsed !== undefined);
  // Accounting is either explicit provider usage or explicitly observed unknown — never fabricated zero.
  const accountingDigest = sha("opencode:accounting-observation", {
    observedUsage,
    observedCost,
    observedContext,
    terminalHasUsage: terminalUsage !== undefined,
    usageEventSources: usageEvents.map((event) => event.kind === "usage" ? event.usage.source : null),
    terminalStatus: worker.adapterResult?.status ?? null
  });
  return Object.freeze({
    usage: observedUsage,
    cost: observedCost,
    context: observedContext,
    accountingDigest
  });
}

function reviewerMutationEvidence(
  targetPath: string,
  targetOriginal: string,
  events: readonly NormalizedAdapterEvent[],
  workspace: ContainedWorkspaceSnapshot
): Readonly<{ passed: true; evidenceSha256: string }> {
  const targetName = targetPath.split(/[/\\]/u).pop() ?? "";
  if (!targetName) {
    throw new ContainedAdapterCharacterizationUnavailable("opencode", "reviewer target path is malformed");
  }
  let currentTarget: string;
  try {
    currentTarget = readFileSync(targetPath, "utf8");
  } catch {
    throw new ContainedAdapterCharacterizationUnavailable("opencode", "reviewer target disappeared during denial probe");
  }
  if (currentTarget !== targetOriginal) {
    throw new ContainedAdapterCharacterizationUnavailable("opencode", "reviewer target content changed; mutation denial failed");
  }
  assertContainedWorkspaceUnchanged(workspace.root, workspace, "reviewer denial");

  const permissions = events.filter((event) => event.kind === "permission");
  const requested = permissions.filter((event) => event.kind === "permission" && event.state === "requested");
  if (requested.length !== 1) {
    throw new ContainedAdapterCharacterizationUnavailable(
      "opencode",
      "reviewer denial requires exactly one correlated permission request for the mutation attempt"
    );
  }
  const permission = requested[0]!;
  if (permission.kind !== "permission") {
    throw new ContainedAdapterCharacterizationUnavailable("opencode", "reviewer permission event kind mismatch");
  }

  const tools = events.filter((event) => event.kind === "tool");
  // F3: title or toolCallId must contain the exact target basename — no generic write/edit regex.
  const namesTarget = (event: Extract<NormalizedAdapterEvent, { kind: "tool" }>): boolean =>
    (event.title !== undefined && event.title.includes(targetName)) ||
    event.toolCallId.includes(targetName);
  const pending = tools.filter((event) =>
    event.kind === "tool" &&
    (event.state === "proposed" || event.state === "started") &&
    namesTarget(event)
  );
  const failed = tools.filter((event) =>
    event.kind === "tool" &&
    event.state === "failed" &&
    namesTarget(event)
  );
  if (pending.length === 0 || failed.length === 0) {
    throw new ContainedAdapterCharacterizationUnavailable(
      "opencode",
      "reviewer denial lacks tool lifecycle evidence correlated to the named mutation target; marking unavailable rather than guessing"
    );
  }
  // Require the failed toolCallId to equal a started/proposed attempt (exact lifecycle correlation).
  const correlated = failed.some((failEvent) =>
    failEvent.kind === "tool" &&
    pending.some((start) => start.kind === "tool" && start.toolCallId === failEvent.toolCallId)
  );
  if (!correlated) {
    throw new ContainedAdapterCharacterizationUnavailable(
      "opencode",
      "reviewer tool failure is not lifecycle-correlated to the permissioned mutation attempt"
    );
  }
  const evidenceSha256 = sha("opencode:read-only-denial", {
    targetName,
    targetUnchanged: true,
    permissionId: permission.permissionId,
    toolCallIds: failed.filter((event) => event.kind === "tool").map((event) => event.toolCallId),
    workspace: {
      entryCount: workspace.entries.length,
      gitStatus: workspace.gitStatus,
      gitHead: workspace.gitHead
    },
    events: events.map(eventSummary)
  });
  return Object.freeze({ passed: true as const, evidenceSha256 });
}

/**
 * F4: session-create must be observed from a normalized session-created event or another exact
 * durable decoded session fact (session/new response re-decoded from the durable transcript).
 * Never inferred from ACP reservation grammar alone.
 */
export function observeContainedOpenCodeSessionCreate(input: Readonly<{
  events: readonly NormalizedAdapterEvent[];
  transcriptPath?: string;
  transcriptDurable?: boolean;
  transcriptSha256?: string;
  newSessionRequestId?: string | number;
}>): Readonly<{ sessionId: string; source: "normalized-event" | "durable-transcript"; frameSha256?: string }> {
  const created = input.events.find((event) => event.kind === "session" && event.state === "created");
  if (created && created.kind === "session") {
    return Object.freeze({ sessionId: created.sessionId, source: "normalized-event" as const, frameSha256: created.frame.sha256 });
  }
  if (
    input.transcriptDurable === true &&
    typeof input.transcriptPath === "string" &&
    input.transcriptPath.length > 0 &&
    input.newSessionRequestId !== undefined
  ) {
    const decoded = decodeSessionCreateFromDurableTranscript(
      input.transcriptPath,
      input.newSessionRequestId,
      input.transcriptSha256
    );
    if (decoded) return decoded;
  }
  throw new ContainedAdapterCharacterizationUnavailable(
    "opencode",
    "session-create was not observed; refusing to infer it from ACP reservation grammar"
  );
}

function decodeSessionCreateFromDurableTranscript(
  transcriptPath: string,
  newSessionRequestId: string | number,
  expectedSha256?: string
): Readonly<{ sessionId: string; source: "durable-transcript"; frameSha256: string }> | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(transcriptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const metadata = fstatSync(fd, { bigint: true });
    if (!metadata.isFile() || metadata.nlink !== 1n || metadata.size > 16n * 1024n * 1024n) return undefined;
    const size = Number(metadata.size);
    if (!Number.isSafeInteger(size)) return undefined;
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = readSync(fd, bytes, offset, size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    const body = bytes.subarray(0, offset);
    if (expectedSha256 !== undefined) {
      const actual = createHash("sha256").update(body).digest("hex");
      if (actual !== expectedSha256) return undefined;
    }
    let found: Readonly<{ sessionId: string; source: "durable-transcript"; frameSha256: string }> | undefined;
    const framer = new BoundedJsonlFramer((frame) => {
      if (found) return;
      const decoded = decodeAcpNewSessionResponse(frame, newSessionRequestId);
      if (decoded.status !== "valid") return;
      found = Object.freeze({
        sessionId: decoded.value.sessionId,
        source: "durable-transcript" as const,
        frameSha256: decoded.frame.sha256
      });
    }, {
      maxFrameBytes: 64 * 1024,
      maxTotalBytes: 16 * 1024 * 1024,
      maxFrames: 4_096
    });
    framer.push(body);
    framer.finish();
    return found;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function requireWorkerPromptEvidence(events: readonly NormalizedAdapterEvent[]): number {
  const assistantBytes = assistantOutputBytes(events);
  if (assistantBytes <= 0) {
    throw new ContainedAdapterCharacterizationUnavailable(
      "opencode",
      "worker prompt produced no assistant output; prompt-roundtrip is unproven"
    );
  }
  if (!hasStreamingDeltas(events)) {
    throw new ContainedAdapterCharacterizationUnavailable(
      "opencode",
      "worker prompt produced no streaming assistant deltas; streaming is unproven"
    );
  }
  return assistantBytes;
}

function deriveBehavioralEvidence(input: Readonly<{
  version: ChildResult;
  worker: ChildResult;
  workerTerminal: LedgerTerminalSettlementEvidence;
  workerEvents: readonly NormalizedAdapterEvent[];
  reviewer: ChildResult;
  reviewerTerminal: LedgerTerminalSettlementEvidence;
  reviewerEvents: readonly NormalizedAdapterEvent[];
  cancellation: ChildResult;
  cancellationTerminal: LedgerTerminalSettlementEvidence;
  cancellationEvents: readonly NormalizedAdapterEvent[];
  reviewerDenial: Readonly<{ evidenceSha256: string }>;
  accounting: Readonly<{ accountingDigest: string; usage: boolean; cost: boolean; context: boolean }>;
  executable: RuntimeFileEvidence;
  configurationSha256: string;
  observedVersion: string;
}>): Readonly<Record<BehavioralProbeCheck, string>> {
  // Empty successful terminals without assistant output must not prove prompt-roundtrip or streaming.
  const workerAssistantBytes = requireWorkerPromptEvidence(input.workerEvents);
  const correlation = input.workerTerminal.bind.adapter?.correlation;
  const newSessionRequestId =
    correlation &&
    typeof correlation === "object" &&
    correlation.kind === "acp-v1" &&
    "newSessionRequestId" in correlation
      ? correlation.newSessionRequestId
      : undefined;
  const sessionObserved = observeContainedOpenCodeSessionCreate({
    events: input.workerEvents,
    transcriptPath: input.worker.transcriptPath,
    transcriptDurable: input.worker.transcriptDurable,
    transcriptSha256: input.worker.transcriptSha256,
    newSessionRequestId
  });
  if (input.cancellationEvents.filter((event) => event.kind === "cancel" && event.state === "terminal-cancelled").length !== 1) {
    throw new ContainedAdapterCharacterizationUnavailable("opencode", "cooperative cancellation was not observed exactly once");
  }

  const runtimeBinding = containedAdapterRuntimeIdentitySha256(
    input.executable,
    [],
    input.configurationSha256
  );
  if (input.workerTerminal.bind.adapter?.runtimeIdentitySha256 !== runtimeBinding) {
    throw new ContainedAdapterCharacterizationUnavailable(
      "opencode",
      "worker settlement runtime identity does not match the pinned executable and controlled configuration"
    );
  }

  const framing = sha("opencode:framing", {
    workerFrames: input.workerEvents.map((event) => event.frame.sha256),
    transcript: input.worker.transcriptSha256
  });
  const transport = sha("opencode:transport-handshake", {
    wire: OPENCODE_ACP_WIRE_VERSION,
    versionTranscript: input.version.transcriptSha256,
    workerTranscript: input.worker.transcriptSha256
  });
  const executableVersion = sha("opencode:executable-version", {
    version: input.observedVersion,
    identity: input.executable.identity,
    configurationSha256: input.configurationSha256
  });
  const promptRoundtrip = sha("opencode:prompt-roundtrip", {
    transcript: input.worker.transcriptSha256,
    terminal: input.workerTerminal.recordSha256,
    adapter: adapterEvidenceIdentity(input.workerTerminal.bind.adapter!),
    assistantBytes: workerAssistantBytes,
    streaming: true,
    events: input.workerEvents.map(eventSummary)
  });
  const cancellation = sha("opencode:cancellation", {
    transcript: input.cancellation.transcriptSha256,
    terminal: input.cancellationTerminal.recordSha256,
    events: input.cancellationEvents.map(eventSummary)
  });
  const sessionCreate = sha("opencode:session-create", {
    sessionId: sessionObserved.sessionId,
    source: sessionObserved.source,
    frameSha256: sessionObserved.frameSha256 ?? null,
    events: input.workerEvents.filter((event) => event.kind === "session").map(eventSummary)
  });

  return Object.freeze({
    "executable-version": executableVersion,
    "transport-handshake": transport,
    framing,
    "session-create": sessionCreate,
    "prompt-roundtrip": promptRoundtrip,
    cancellation,
    "read-only-denial": input.reviewerDenial.evidenceSha256,
    accounting: input.accounting.accountingDigest
  } as Record<BehavioralProbeCheck, string>);
}

function capabilities(
  accounting: Readonly<{ usage: boolean; cost: boolean; context: boolean }>,
  workerEvents: readonly NormalizedAdapterEvent[],
  reviewerDenialProven: boolean
): OpenCodeNegotiatedCapabilities {
  return Object.freeze({
    modelDiscovery: false,
    sessionCreate: true,
    sessionResume: false,
    streaming: hasStreamingDeltas(workerEvents),
    cancellation: true,
    usage: accounting.usage,
    cost: accounting.cost,
    context: accounting.context,
    steering: false,
    attachments: false,
    innerReadOnly: reviewerDenialProven
  });
}

async function characterizeOpenCode(
  executablePath: string,
  environment: Readonly<Record<string, string>>,
  configurationSha256: string,
  characterizationParent?: string
): Promise<ContainedAdapterProbeResult> {
  const root = allocateCharacterizationRoot(characterizationParent);
  const work = join(root, "workspace");
  mkdirSync(work, { mode: 0o700 });
  writeFileSync(join(work, "README.md"), "contained OpenCode characterization\n", { mode: 0o600 });
  const gitInit = runGit(work, ["init", "--quiet"]);
  if (!gitInit.ok) {
    rmSync(root, { recursive: true, force: true });
    throw new ContainedAdapterCharacterizationUnavailable("opencode", `private fixture repository init failed: ${gitInit.err}`);
  }
  // Baseline commit so git status/head are well-defined for no-write snapshots.
  runGit(work, ["config", "user.email", "contained@relayforge.local"]);
  runGit(work, ["config", "user.name", "RelayForge Contained"]);
  runGit(work, ["add", "README.md"]);
  runGit(work, ["commit", "--quiet", "-m", "baseline"]);

  const config = RootConfigSchema.parse({
    version: 1,
    defaults: { runDir: ".relayforge/runs" },
    projects: [{
      name: "contained-opencode",
      workingDir: "workspace",
      providers: { native: { type: "opencode", auth: { mode: "api-key", configured: true } } },
      roles: [{ name: "probe", title: "Contained probe", provider: "native" }],
      loops: [{
        name: "evidence",
        orchestrator: "probe",
        reviewer: "probe",
        budgetUsd: 10,
        maxCostPerCallUsd: 1,
        allowUnknownCostCalls: 10,
        cadenceMinutes: 1
      }]
    }]
  });
  const loaded = { config, path: join(root, "relayforge.config.yaml"), rootDir: root };
  writeFileSync(loaded.path, "version: 1\n", { mode: 0o600 });
  const project = config.projects[0]!;
  const role = project.roles[0] as RoleConfig;
  const runId = `probe-${randomBytes(8).toString("hex")}`;
  let ctx: RunContext | undefined;
  try {
    // Pin executable identity before any version or behavioral call.
    const executablePin = pinContainedExecutable("opencode", executablePath);
    assertContainedExecutablePin(executablePin, "before version probe");

    ctx = prepareRun(loaded, project, runId, "contained OpenCode compatibility characterization", "evidence");
    initCostLedger(ctx.boardDir);
    ctx.adapterEnvironment = Object.freeze({ native: environment });
    const systemPrompt = {
      file: join(ctx.promptDir, "system.md"),
      text: "You are a bounded RelayForge compatibility probe. Follow the exact request and do not inspect unrelated state."
    };
    writeFileSync(systemPrompt.file, systemPrompt.text, { mode: 0o600 });
    const transcriptDirectory = join(ctx.runDir, "version-transcripts");
    mkdirSync(transcriptDirectory, { mode: 0o700 });
    const runtime = Object.freeze({ executablePath: executablePin.evidence.canonicalPath, wireVersion: OPENCODE_ACP_WIRE_VERSION });

    const version = await runContainedNativeExecutableProbe({
      ctx,
      providerKey: "native",
      runtime,
      args: ["--version"],
      environment,
      cwd: work,
      transcriptDirectory
    });
    assertContainedExecutablePin(executablePin, "after version probe");
    const observedVersion = versionFrom(version);

    const baselineWorkspace = snapshotContainedWorkspace(work);
    const workerEvents: NormalizedAdapterEvent[] = [];
    const worker = await runContainedNativeCharacterizationTurn({
      ctx,
      role,
      kind: "implementer",
      taskText: OPEN_CODE_PROMPT,
      systemPrompt,
      workCwd: work,
      state: state(runId, 1),
      taskId: "worker",
      attempt: 1,
      providerKey: "native",
      runtime,
      onAdapterEvent: (event) => workerEvents.push(event)
    });
    assertContainedExecutablePin(executablePin, "after worker prompt");
    assertContainedWorkspaceUnchanged(work, baselineWorkspace, "worker prompt");
    const workerTerminal = exactTerminal(ctx, worker, "worker prompt");
    // Fail before spending more provider/containment work when the primary
    // prompt cannot establish the minimum semantic roundtrip. The derivation
    // repeats this check as defense in depth over the final evidence set.
    requireWorkerPromptEvidence(workerEvents);

    const reviewerTarget = join(work, "reviewer-target.txt");
    const reviewerOriginal = "parent-owned reviewer sentinel\n";
    writeFileSync(reviewerTarget, reviewerOriginal, { mode: 0o600 });
    // Reviewer may not mutate the workspace; snapshot includes the new target.
    const reviewerWorkspace = snapshotContainedWorkspace(work);
    const reviewerEvents: NormalizedAdapterEvent[] = [];
    const reviewer = await runContainedNativeCharacterizationTurn({
      ctx,
      role,
      kind: "reviewer",
      taskText: `${OPEN_CODE_REVIEWER_PROMPT} Target: ${reviewerTarget}`,
      systemPrompt,
      workCwd: work,
      state: state(runId, 2),
      taskId: "reviewer",
      attempt: 1,
      providerKey: "native",
      runtime,
      onAdapterEvent: (event) => reviewerEvents.push(event)
    });
    assertContainedExecutablePin(executablePin, "after reviewer denial");
    const reviewerTerminal = exactTerminal(ctx, reviewer, "reviewer denial");
    const reviewerDenial = reviewerMutationEvidence(
      reviewerTarget,
      reviewerOriginal,
      reviewerEvents,
      reviewerWorkspace
    );

    const cancellationEvents: NormalizedAdapterEvent[] = [];
    const cancellationPromise = runContainedNativeCharacterizationTurn({
      ctx,
      role,
      kind: "implementer",
      taskText: OPEN_CODE_CANCEL_PROMPT,
      systemPrompt,
      workCwd: work,
      state: state(runId, 3),
      taskId: "cancel",
      attempt: 1,
      providerKey: "native",
      runtime,
      onAdapterEvent: (event) => cancellationEvents.push(event)
    });
    const cancellationTimer = setTimeout(() => requestCancel(ctx!.runDir, "contained OpenCode cooperative cancellation"), 250);
    let cancellation: ChildResult;
    try {
      cancellation = await cancellationPromise;
    } finally {
      clearTimeout(cancellationTimer);
      clearCancel(ctx.runDir);
    }
    assertContainedExecutablePin(executablePin, "after cancellation");
    const cancellationTerminal = exactCancelledTerminal(ctx, cancellation);

    const accounting = usageEvidence(worker, workerEvents);
    const executable = assertContainedExecutablePin(executablePin, "before availability derivation");
    const behavioral = deriveBehavioralEvidence({
      version,
      worker,
      workerTerminal,
      workerEvents,
      reviewer,
      reviewerTerminal,
      reviewerEvents,
      cancellation,
      cancellationTerminal,
      cancellationEvents,
      reviewerDenial,
      accounting,
      executable,
      configurationSha256,
      observedVersion
    });

    const availability = evaluateOpenCodeProbe({
      executable: { canonicalPath: executable.canonicalPath, identity: executable.identity, version: observedVersion },
      wireVersion: OPENCODE_ACP_WIRE_VERSION,
      behavioralEvidenceSha256: behavioral,
      capabilities: capabilities(accounting, workerEvents, true),
      probedAt: new Date().toISOString(),
      consultedConfigSha256: configurationSha256
    });
    if (availability.status !== "available") {
      throw new ContainedAdapterCharacterizationUnavailable("opencode", `${availability.reason.code}: ${availability.reason.detail}`);
    }

    // Consume only the just-derived availability in the ordinary public route. This is the proof that
    // characterization did not create a parallel launch grammar or a provisional availability bypass.
    ctx.adapterAvailability = Object.freeze({ native: availability });
    const replayWorkspace = snapshotContainedWorkspace(work);
    const replay = await runRoutedTurn(
      ctx,
      role,
      "implementer",
      OPEN_CODE_REPLAY_PROMPT,
      systemPrompt,
      work,
      "",
      state(runId, 4),
      "replay",
      1
    );
    assertContainedExecutablePin(executablePin, "after ordinary replay");
    assertContainedWorkspaceUnchanged(work, replayWorkspace, "ordinary availability replay");
    const replayTerminal = exactTerminal(ctx, replay, "ordinary availability replay");
    if (
      canonicalContainedAdapterEvidenceJson({
        ...replayTerminal.bind.adapter!.replay
      }) !==
        canonicalContainedAdapterEvidenceJson({
          ...workerTerminal.bind.adapter!.replay
        }) ||
      replayTerminal.bind.adapter?.replay.normalizer.id !== availability.binding.normalizer.id
    ) throw new ContainedAdapterCharacterizationUnavailable("opencode", "ordinary route replay did not match the characterized adapter contract");
    const expectedRuntime = containedAdapterRuntimeIdentitySha256(executable, [], configurationSha256);
    if (
      workerTerminal.bind.adapter?.runtimeIdentitySha256 !== expectedRuntime ||
      replayTerminal.bind.adapter?.runtimeIdentitySha256 !== expectedRuntime ||
      cancellationTerminal.bind.adapter?.runtimeIdentitySha256 !== expectedRuntime
    ) {
      throw new ContainedAdapterCharacterizationUnavailable(
        "opencode",
        "runtime plus controlled-configuration identity was not bound into reservation/settlement/replay"
      );
    }

    if (ctx.children.size !== 0 || ctx.ownedGroups.size !== 0 || (ctx.ownedScopes?.size ?? 0) !== 0) {
      throw new ContainedAdapterCharacterizationUnavailable("opencode", "characterization left a live process or containment scope");
    }
    const promptCompleted = behavioral["prompt-roundtrip"]!;
    const cancellationSettled = behavioral.cancellation!;
    const checks = Object.freeze({
      promptCompleted: Object.freeze({ passed: true as const, evidenceSha256: promptCompleted }),
      cancellationSettled: Object.freeze({ passed: true as const, evidenceSha256: cancellationSettled }),
      reviewerWriteDenied: Object.freeze({
        passed: true as const,
        evidenceSha256: behavioral["read-only-denial"]!
      }),
      scopeEmpty: Object.freeze({
        passed: true as const,
        evidenceSha256: sha("opencode:all-scopes-empty", [worker.scopeReapProof, reviewer.scopeReapProof, cancellation.scopeReapProof, replay.scopeReapProof])
      }),
      replayMatched: Object.freeze({
        passed: true as const,
        evidenceSha256: sha("opencode:ordinary-replay-matched", {
          record: replayTerminal.recordSha256,
          transcript: replay.transcriptSha256,
          adapter: adapterEvidenceIdentity(replayTerminal.bind.adapter!),
          runtimeIdentitySha256: replayTerminal.bind.adapter?.runtimeIdentitySha256
        })
      })
    }) as unknown as ContainedAdapterProbeResult["checks"];
    const normalExitReapedSha256 = sha("opencode:normal-reaped", {
      scope: worker.scopeId,
      proof: worker.scopeReapProof,
      terminal: workerTerminal.recordSha256
    });
    const cancellationReapedSha256 = sha("opencode:cancellation-reaped", {
      scope: cancellation.scopeId,
      proof: cancellation.scopeReapProof,
      terminal: cancellationTerminal.recordSha256
    });
    return Object.freeze({
      availability,
      containment: Object.freeze({
        backend: "linux-cgroup-v2" as const,
        scopeId: worker.scopeId!,
        normalExitReapedSha256,
        cancellationReapedSha256
      }),
      settlement: Object.freeze({
        callId: worker.settlementCallId!,
        terminal: true as const,
        costAuthority: workerTerminal.costAuthority,
        receiptDigest: sha("opencode:terminal-settlement", {
          record: workerTerminal.recordSha256,
          adapter: adapterEvidenceIdentity(workerTerminal.bind.adapter!),
          transcript: worker.transcriptSha256,
          replay: replayTerminal.recordSha256,
          runtimeIdentitySha256: workerTerminal.bind.adapter?.runtimeIdentitySha256
        })
      }),
      checks
    });
  } finally {
    try {
      if (ctx) disposePreparedRun(ctx);
    } finally {
      // Ordinary exceptions and cancellation must leave no process, cgroup, socket, run, or temp root.
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Best-effort; dead-owner reconciliation covers restart remnants.
      }
    }
  }
}

export async function collectProductionContainedAdapterEvidence(
  input: CollectProductionContainedAdapterEvidenceInput
): Promise<ContainedAdapterEvidenceV1> {
  if (input.paidProbeAuthorized !== true) {
    throw new ContainedAdapterCharacterizationUnavailable(
      input.adapterId,
      "paid behavioral characterization requires explicit paidProbeAuthorized: true authorization"
    );
  }
  // Pin the release/product checkout before any prepareRun/worktree mutation or paid probe.
  const repositoryPin = pinContainedEvidenceRepository(input.repositoryRoot, input.commitSha);
  const source = input.environment ?? process.env;
  const controlledEnvironment = containedAdapterProbeEnvironment(input.adapterId, source);
  const configurationSha256 = containedAdapterProbeConfigurationSha256(input.adapterId, source);
  // Independent re-derivation from the controlled recipe must match the ambient-credential derivation.
  if (containedAdapterProbeConfigurationSha256(input.adapterId, controlledEnvironment) !== configurationSha256) {
    throw new ContainedAdapterCharacterizationUnavailable(
      input.adapterId,
      "controlled configuration hash is not stable under OPENAI_API_KEY expansion"
    );
  }
  const executablePath = resolveSandboxExecutable(input.adapterId, source.PATH ?? process.env.PATH);
  pinContainedExecutable(input.adapterId, executablePath);

  const finalizerInput: CollectContainedAdapterEvidenceInput = {
    adapterId: input.adapterId,
    outputPath: input.outputPath,
    commitSha: input.commitSha,
    jobNonce: input.jobNonce,
    environment: source,
    ...(input.forbiddenSentinels ? { forbiddenSentinels: input.forbiddenSentinels } : {}),
    authority: {
      async collect(expectation) {
        if (expectation.configurationSha256 !== configurationSha256) {
          throw new Error("contained adapter configuration changed before characterization");
        }
        if (input.adapterId !== "opencode") {
          throw new ContainedAdapterCharacterizationUnavailable(input.adapterId);
        }
        try {
          return await characterizeOpenCode(
            executablePath,
            controlledEnvironment,
            configurationSha256,
            input.characterizationRoot
          );
        } finally {
          assertContainedEvidenceRepositoryPin(repositoryPin);
        }
      }
    }
  };
  const envelope = await collectContainedAdapterEvidence(finalizerInput);
  assertContainedEvidenceRepositoryPin(repositoryPin);
  return envelope;
}

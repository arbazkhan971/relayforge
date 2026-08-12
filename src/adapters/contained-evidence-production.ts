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
  rmdirSync,
  statSync,
  writeFileSync,
  writeSync
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
  containedNativeAdapterIds,
  type ContainedAdapterEvidenceV1,
  type ContainedNativeAdapterId
} from "./contained-evidence.js";
import {
  evaluateOpenCodeProbe,
  OPENCODE_ACP_WIRE_VERSION,
  type OpenCodeNegotiatedCapabilities
} from "./builtins/opencode.js";
import {
  evaluatePiProbe,
  PI_AUDITED_VERSION,
  PI_REVIEWER_HELPER_RUNTIME,
  type PiNegotiatedCapabilities
} from "./builtins/pi.js";
import {
  evaluateGrokProbe,
  GROK_AUDITED_BUILD_COMMIT,
  GROK_AUDITED_VERSION,
  GROK_ACP_WIRE_VERSION,
  GROK_FIXED_SAFETY_ENVIRONMENT,
  type GrokNegotiatedCapabilities
} from "./builtins/grok.js";
import { decodeAcpNewSessionResponse } from "./acp-v1.js";
import { decodeGrokInitializeResponse } from "./grok-acp.js";
import {
  createGrokEgressProxy,
  type GrokEgressProxy
} from "./grok-egress.js";
import {
  GROK_EGRESS_POLICY_SHA256,
  GROK_EGRESS_RELAY_RUNTIME,
  grokEgressDenialEvidenceSha256,
  type GrokEgressEvidenceBinding
} from "./grok-egress-contract.js";
import {
  buildGrokEgressProbeCommand,
  grokEgressRelayPath,
  parseGrokEgressProbeReport
} from "./grok-egress-probe.js";
import {
  decodePiSessionStatsResponse,
  decodePiStateResponse,
  PI_RPC_WIRE_VERSION,
  type PiSessionStatsSnapshot,
  type PiStateEvidence
} from "./pi-rpc.js";
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
  runHeadlessChild,
  runRoutedTurn,
  type ChildResult,
  type LoopRunState,
  type RunContext
} from "../orchestrator.js";
import { adapterEvidenceIdentity, type LedgerTerminalSettlementEvidence } from "../ledger.js";
import { clearCancel, requestCancel } from "../runtime.js";
import {
  containCommand,
  netnsSupported,
  pinSandboxSocket,
  resolveSandboxExecutable
} from "../sandbox.js";

/** Exact fail-closed workspace inventory ceilings (F1). */
export const CONTAINED_WORKSPACE_MAX_DEPTH = 32 as const;
export const CONTAINED_WORKSPACE_MAX_ENTRIES = 4_096 as const;
export const CONTAINED_WORKSPACE_MAX_FILE_BYTES = 1_048_576 as const; // 1 MiB
export const CONTAINED_WORKSPACE_MAX_AGGREGATE_BYTES = 16_777_216 as const; // 16 MiB
/** Bound keeps absolute workspace paths under typical PATH_MAX while remaining fail-closed. */
export const CONTAINED_WORKSPACE_MAX_RELATIVE_PATH_BYTES = 1_024 as const;

/** Private characterization allocation prefix: `rf-contained-<adapterId>-<pid>.<starttime>-XXXXXX`. */
export function characterizationRootPrefix(adapterId: ContainedNativeAdapterId): string {
  return `rf-contained-${adapterId}-`;
}

/** Back-compat OpenCode prefix constant; prefer {@link characterizationRootPrefix}. */
export const CHARACTERIZATION_ROOT_PREFIX = characterizationRootPrefix("opencode");
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
const PI_PROMPT = "RF_CHARACTERIZE_WORKER: Return a short deterministic acknowledgement without changing files.";
const PI_REVIEWER_PROMPT = "RF_CHARACTERIZE_REVIEWER: Attempt to replace the named reviewer target through a write tool; do not claim success when the write is denied.";
const PI_CANCEL_PROMPT = "RF_CHARACTERIZE_CANCEL: Keep this turn active until the parent sends the correlated cancellation.";
const PI_REPLAY_PROMPT = "RF_CHARACTERIZE_REPLAY: Return a short deterministic acknowledgement without changing files.";
const GROK_PROMPT = "RF_CHARACTERIZE_WORKER: Return a short deterministic acknowledgement without changing files.";
const GROK_REVIEWER_PROMPT = "RF_CHARACTERIZE_REVIEWER: Request permission to replace the named reviewer target; do not claim success when permission is denied.";
const GROK_CANCEL_PROMPT = "RF_CHARACTERIZE_CANCEL: Keep this turn active until the parent sends the correlated cancellation.";
const GROK_REPLAY_PROMPT = "RF_CHARACTERIZE_REPLAY: Return a short deterministic acknowledgement without changing files.";
const OWNER_MARKER = CHARACTERIZATION_OWNER_MARKER;
/** `rf-contained-<adapterId>-<pid>.<starttime>-<mkdtemp-suffix>` for every native adapter. */
const CHAR_DIR_OWNER_RE = /^rf-contained-(?:opencode|pi|grok)-(\d+)\.([0-9A-Za-z]+)-/u;
const GROK_VERSION_RE = /^(?:grok\s+)?v?(\d+\.\d+\.\d+)\s+\(([a-f0-9]{10,40})\)\s+\[([^\]]+)\]$/u;

function piReviewerHelperPath(): string {
  return fileURLToPath(new URL("../../assets/pi-relayforge-reviewer.mjs", import.meta.url));
}

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

function requiredGit(adapterId: ContainedNativeAdapterId, root: string, args: string[], failure: string): string {
  const result = runGit(root, args);
  if (!result.ok) throw new ContainedAdapterCharacterizationUnavailable(adapterId, `${failure}: ${result.err || "git command failed"}`);
  return result.out;
}

/** Pin one clean, top-level worktree to the exact release/product commit before any paid probe. */
export function pinContainedEvidenceRepository(
  repositoryRoot: string,
  expectedCommitSha?: string,
  adapterId: ContainedNativeAdapterId = "opencode"
): ContainedEvidenceRepositoryPin {
  if (expectedCommitSha !== undefined && !COMMIT_SHA.test(expectedCommitSha)) {
    throw new TypeError("contained adapter commitSha must be a lowercase Git object ID");
  }
  const canonicalPath = canonicalRepositoryRoot(repositoryRoot);
  const topLevel = requiredGit(adapterId, canonicalPath, ["rev-parse", "--path-format=absolute", "--show-toplevel"], "repositoryRoot is not a Git worktree");
  if (realpathSync(topLevel) !== canonicalPath) {
    throw new ContainedAdapterCharacterizationUnavailable(adapterId, "repositoryRoot must name the exact Git worktree top level");
  }
  const commitSha = requiredGit(adapterId, canonicalPath, ["rev-parse", "--verify", "HEAD^{commit}"], "cannot resolve repository HEAD");
  if (!COMMIT_SHA.test(commitSha)) {
    throw new ContainedAdapterCharacterizationUnavailable(adapterId, "repository HEAD is not a canonical Git object ID");
  }
  if (expectedCommitSha !== undefined && commitSha !== expectedCommitSha) {
    throw new ContainedAdapterCharacterizationUnavailable(adapterId, "repository HEAD does not equal the explicit evidence commitSha");
  }
  const status = requiredGit(adapterId, canonicalPath, ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"], "cannot inspect repository cleanliness");
  if (status.length !== 0) {
    throw new ContainedAdapterCharacterizationUnavailable(adapterId, "repositoryRoot must be clean before contained characterization");
  }
  const info = lstatSync(canonicalPath, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new ContainedAdapterCharacterizationUnavailable(adapterId, "repositoryRoot identity is not a direct directory");
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
export function assertContainedEvidenceRepositoryPin(
  pin: ContainedEvidenceRepositoryPin,
  adapterId: ContainedNativeAdapterId = "opencode"
): void {
  if (realpathSync(pin.canonicalPath) !== pin.canonicalPath) {
    throw new ContainedAdapterCharacterizationUnavailable(adapterId, "repositoryRoot path was replaced during contained characterization");
  }
  const info = lstatSync(pin.canonicalPath, { bigint: true });
  if (
    !info.isDirectory() || info.isSymbolicLink() || info.dev.toString() !== pin.dev ||
    info.ino.toString() !== pin.ino || info.ctimeNs.toString() !== pin.ctimeNs
  ) {
    throw new ContainedAdapterCharacterizationUnavailable(adapterId, "repositoryRoot identity changed during contained characterization");
  }
  const current = pinContainedEvidenceRepository(pin.canonicalPath, pin.commitSha, adapterId);
  if (current.dev !== pin.dev || current.ino !== pin.ino || current.ctimeNs !== pin.ctimeNs) {
    throw new ContainedAdapterCharacterizationUnavailable(adapterId, "repositoryRoot identity changed during contained characterization");
  }
}

/** Pin one exact executable identity before any version or behavioral probe. */
export function pinContainedExecutable(runtimeName: string, executablePath: string, executable = true): ContainedExecutablePin {
  const evidence = inspectAdapterRuntimeFile(runtimeName, executablePath, executable);
  return Object.freeze({ evidence });
}

/** Re-stat and compare the pinned executable; reject path/content substitution. */
export function assertContainedExecutablePin(
  pin: ContainedExecutablePin,
  label: string,
  adapterId: ContainedNativeAdapterId = "opencode",
  executable = true
): RuntimeFileEvidence {
  let current: RuntimeFileEvidence;
  try {
    current = inspectAdapterRuntimeFile(pin.evidence.runtimeName, pin.evidence.canonicalPath, executable);
  } catch (error) {
    throw new ContainedAdapterCharacterizationUnavailable(
      adapterId,
      `executable identity unreadable ${label}: ${(error as Error).message}`
    );
  }
  if (!sameRuntimeFileEvidence(current, pin.evidence)) {
    throw new ContainedAdapterCharacterizationUnavailable(
      adapterId,
      `executable was substituted ${label}; refusing characterization`
    );
  }
  return current;
}

function workspaceFail(adapterId: ContainedNativeAdapterId, detail: string): never {
  throw new ContainedAdapterCharacterizationUnavailable(adapterId, `workspace inventory refused: ${detail}`);
}

function assertRelativePathBound(adapterId: ContainedNativeAdapterId, relativePath: string): void {
  if (relativePath.includes("\0")) workspaceFail(adapterId, "relative path contains NUL");
  if (Buffer.byteLength(relativePath, "utf8") > CONTAINED_WORKSPACE_MAX_RELATIVE_PATH_BYTES) {
    workspaceFail(adapterId, `relative path exceeds ${CONTAINED_WORKSPACE_MAX_RELATIVE_PATH_BYTES} bytes`);
  }
  if (relativePath.split("/").some((part) => part === ".." || part === "")) {
    workspaceFail(adapterId, "relative path is not a clean contained path");
  }
}

/**
 * Read one regular file with O_NOFOLLOW + fstat-before/after so substitution or growth cannot
 * allocate or hash past the individual/aggregate caps.
 */
function readPinnedRegularFile(
  adapterId: ContainedNativeAdapterId,
  fullPath: string,
  aggregateBytes: number
): Readonly<{ sha256: string; size: number; mode: number; aggregateBytes: number }> {
  let fd: number | undefined;
  try {
    fd = openSync(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EINVAL") workspaceFail(adapterId, `refusing symlink or non-followable entry at ${fullPath}`);
    throw error;
  }
  try {
    const before = fstatSync(fd, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile()) {
      workspaceFail(adapterId, `entry is not a regular file after open: ${fullPath}`);
    }
    if (before.nlink !== 1n) {
      workspaceFail(adapterId, `hardlinked regular file weakens inventory identity: ${fullPath}`);
    }
    if (before.size < 0n || before.size > BigInt(CONTAINED_WORKSPACE_MAX_FILE_BYTES)) {
      workspaceFail(adapterId, `regular file exceeds ${CONTAINED_WORKSPACE_MAX_FILE_BYTES} bytes: ${fullPath}`);
    }
    const size = Number(before.size);
    if (!Number.isSafeInteger(size)) workspaceFail(adapterId, `regular file size is not safe: ${fullPath}`);
    const nextAggregate = aggregateBytes + size;
    if (nextAggregate > CONTAINED_WORKSPACE_MAX_AGGREGATE_BYTES) {
      workspaceFail(adapterId, `aggregate file bytes exceed ${CONTAINED_WORKSPACE_MAX_AGGREGATE_BYTES}`);
    }
    // Allocate only after the pinned size is known and within caps — never from an untrusted declared size.
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = readSync(fd, bytes, offset, size - offset, offset);
      if (read === 0) workspaceFail(adapterId, `truncated regular file during pinned read: ${fullPath}`);
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
      workspaceFail(adapterId, `regular file was substituted or grew during pinned read: ${fullPath}`);
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
export function snapshotContainedWorkspace(
  workRoot: string,
  adapterId: ContainedNativeAdapterId = "opencode"
): ContainedWorkspaceSnapshot {
  const root = realpathSync(workRoot);
  const rootInfo = lstatSync(root, { bigint: true });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    workspaceFail(adapterId, "workspace root must be a direct directory");
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
      workspaceFail(adapterId, `cannot readdir ${current.relativePath || "."}: ${(error as Error).message}`);
    }
    // Deterministic visit order within each directory.
    dirents.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const dirent of dirents) {
      // Skip only the fixture repository's exact root `.git` — never nested `.git` paths.
      if (current.relativePath === "" && dirent.name === ".git") continue;
      if (dirent.name === "" || dirent.name === "." || dirent.name === ".." || dirent.name.includes("\0")) {
        workspaceFail(adapterId, `illegal directory entry name under ${current.relativePath || "."}`);
      }
      const relativePath = current.relativePath === "" ? dirent.name : `${current.relativePath}/${dirent.name}`;
      assertRelativePathBound(adapterId, relativePath);
      if (entries.length >= CONTAINED_WORKSPACE_MAX_ENTRIES) {
        workspaceFail(adapterId, `entry count exceeds ${CONTAINED_WORKSPACE_MAX_ENTRIES}`);
      }
      const full = join(current.full, dirent.name);
      let info;
      try {
        info = lstatSync(full, { bigint: true });
      } catch (error) {
        workspaceFail(adapterId, `cannot lstat ${relativePath}: ${(error as Error).message}`);
      }
      if (info.isSymbolicLink()) workspaceFail(adapterId, `symlink refused: ${relativePath}`);
      if (info.isFIFO()) workspaceFail(adapterId, `FIFO refused: ${relativePath}`);
      if (info.isSocket()) workspaceFail(adapterId, `socket refused: ${relativePath}`);
      if (info.isCharacterDevice() || info.isBlockDevice()) workspaceFail(adapterId, `device node refused: ${relativePath}`);
      if (info.isDirectory()) {
        if (current.depth + 1 > CONTAINED_WORKSPACE_MAX_DEPTH) {
          workspaceFail(adapterId, `directory depth exceeds ${CONTAINED_WORKSPACE_MAX_DEPTH} at ${relativePath}`);
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
        const pinned = readPinnedRegularFile(adapterId, full, aggregateBytes);
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
      workspaceFail(adapterId, `unknown entry kind refused: ${relativePath}`);
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
  label: string,
  adapterId: ContainedNativeAdapterId = "opencode"
): void {
  const current = snapshotContainedWorkspace(workRoot, adapterId);
  if (canonicalContainedAdapterEvidenceJson(current) !== canonicalContainedAdapterEvidenceJson(expected)) {
    throw new ContainedAdapterCharacterizationUnavailable(
      adapterId,
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
export function characterizationDirectoryPrefix(
  ownerToken: string,
  adapterId: ContainedNativeAdapterId = "opencode"
): string {
  const match = /^(\d+):([0-9A-Za-z]+)$/u.exec(ownerToken);
  if (!match) {
    throw new ContainedAdapterCharacterizationUnavailable(adapterId, "owner token is not a pid:starttime identity");
  }
  return `${characterizationRootPrefix(adapterId)}${match[1]}.${match[2]}-`;
}

/** Parse owner token from an allocated directory basename, if the exact protocol name is present. */
export function parseCharacterizationDirectoryOwner(directoryName: string): string | undefined {
  const match = CHAR_DIR_OWNER_RE.exec(directoryName);
  if (!match) return undefined;
  return `${match[1]}:${match[2]}`;
}

function isCharacterizationDirectoryName(name: string): boolean {
  return containedNativeAdapterIds.some((adapterId) => name.startsWith(characterizationRootPrefix(adapterId)));
}

function assertPrivateOwnedDirectory(path: string, name: string, adapterId: ContainedNativeAdapterId = "opencode"): string {
  if (!isAbsolute(path) || path.includes("\0") || Buffer.byteLength(path, "utf8") > 4_096) {
    throw new ContainedAdapterCharacterizationUnavailable(adapterId, `${name} must be a bounded absolute path`);
  }
  const root = realpathSync(path);
  const info = statSync(root);
  if (!info.isDirectory()) {
    throw new ContainedAdapterCharacterizationUnavailable(adapterId, `${name} must be a directory`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new ContainedAdapterCharacterizationUnavailable(adapterId, `${name} must be private to its owner`);
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new ContainedAdapterCharacterizationUnavailable(adapterId, `${name} must be owned by the current user`);
  }
  return root;
}

function writeOwnerMarkerExclusive(directory: string, ownerToken: string, adapterId: ContainedNativeAdapterId = "opencode"): void {
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
        throw new ContainedAdapterCharacterizationUnavailable(adapterId, "owner marker write made no progress");
      }
      offset += written;
    }
  } catch (error) {
    if (error instanceof ContainedAdapterCharacterizationUnavailable) throw error;
    throw new ContainedAdapterCharacterizationUnavailable(
      adapterId,
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
export function reconcileDeadCharacterizationRoots(
  parent: string,
  adapterId: ContainedNativeAdapterId = "opencode"
): readonly string[] {
  const root = assertPrivateOwnedDirectory(parent, "characterization parent", adapterId);
  const removed: string[] = [];
  for (const name of readdirSync(root)) {
    if (!isCharacterizationDirectoryName(name)) continue;
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
          adapterId,
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
            adapterId,
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
        adapterId,
        `cannot read owner marker for characterization remnant ${name}`
      );
    }
    if (namedOwner !== undefined && token !== namedOwner) {
      throw new ContainedAdapterCharacterizationUnavailable(
        adapterId,
        `owner marker disagrees with directory-encoded owner for ${name}`
      );
    }
    if (isOwnerAlive(token)) continue;
    try {
      rmSync(candidate, { recursive: true, force: true });
      removed.push(candidate);
    } catch (error) {
      throw new ContainedAdapterCharacterizationUnavailable(
        adapterId,
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
  seam?: CharacterizationAllocationSeam,
  adapterId: ContainedNativeAdapterId = "opencode"
): string {
  const configured = preferred ?? process.env.RUNNER_TEMP;
  if (typeof configured !== "string" || configured.length === 0) {
    throw new ContainedAdapterCharacterizationUnavailable(
      adapterId,
      "characterization requires private RUNNER_TEMP or an explicit caller-owned characterizationRoot"
    );
  }
  const parent = assertPrivateOwnedDirectory(configured, "characterization root parent", adapterId);
  reconcileDeadCharacterizationRoots(parent, adapterId);
  const ownerToken = processStartToken();
  const dir = mkdtempSync(join(parent, characterizationDirectoryPrefix(ownerToken, adapterId)));
  chmodSync(dir, 0o700);
  seam?.afterDirectoryBeforeMarker?.(dir, ownerToken);
  writeOwnerMarkerExclusive(dir, ownerToken, adapterId);
  return dir;
}

function allocateCharacterizationRoot(adapterId: ContainedNativeAdapterId, preferred?: string): string {
  return allocateContainedCharacterizationRoot(preferred, undefined, adapterId);
}

function state(adapterId: ContainedNativeAdapterId, runId: string, iteration: number): LoopRunState {
  const now = new Date().toISOString();
  return {
    runId,
    project: `contained-${adapterId}`,
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

function exactTerminal(
  adapterId: ContainedNativeAdapterId,
  ctx: RunContext,
  result: ChildResult,
  label: string
): LedgerTerminalSettlementEvidence {
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
    throw new ContainedAdapterCharacterizationUnavailable(adapterId, `${label} did not complete through the strong contained transcript path`);
  }
  const terminal = ctx.ledger!.terminalSettlementEvidenceOf(result.settlementCallId);
  if (!terminal || terminal.fallbackAuthorized || !terminal.bind.adapter) {
    throw new ContainedAdapterCharacterizationUnavailable(adapterId, `${label} has no exact durable terminal settlement`);
  }
  if (terminal.bind.adapter.replay.adapterId !== adapterId) {
    throw new ContainedAdapterCharacterizationUnavailable(adapterId, `${label} settled under a foreign adapter identity`);
  }
  if (!terminal.bind.adapter.runtimeIdentitySha256) {
    throw new ContainedAdapterCharacterizationUnavailable(adapterId, `${label} settlement omitted runtime identity binding`);
  }
  return terminal;
}

function exactCancelledTerminal(
  adapterId: ContainedNativeAdapterId,
  ctx: RunContext,
  result: ChildResult
): LedgerTerminalSettlementEvidence {
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
    throw new ContainedAdapterCharacterizationUnavailable(adapterId, `cooperative cancellation did not settle and reap exactly one contained scope (${JSON.stringify({
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
  const terminal = ctx.ledger!.terminalSettlementEvidenceOf(result.settlementCallId);
  if (!terminal || terminal.fallbackAuthorized || terminal.bind.adapter?.replay.adapterId !== adapterId) {
    throw new ContainedAdapterCharacterizationUnavailable(adapterId, "cancelled call has no exact terminal ledger record");
  }
  if (!terminal.bind.adapter?.runtimeIdentitySha256) {
    throw new ContainedAdapterCharacterizationUnavailable(adapterId, "cancelled settlement omitted runtime identity binding");
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

function versionFrom(adapterId: ContainedNativeAdapterId, result: ChildResult): string {
  if (
    result.code !== 0 ||
    result.transportOk !== true ||
    result.scopeTrusted !== true ||
    result.scopeReaped !== true ||
    !result.scopeId?.startsWith("cgroup2:") ||
    result.transcriptDurable !== true ||
    !result.transcriptSha256
  ) throw new ContainedAdapterCharacterizationUnavailable(adapterId, "contained --version probe was not durable and reaped");
  const text = result.stdout.trim();
  const match = new RegExp(`^(?:${adapterId}\\s+)?v?(\\d+\\.\\d+\\.\\d+)$`, "u").exec(text);
  if (!match) throw new ContainedAdapterCharacterizationUnavailable(adapterId, "--version output was not one canonical semver record");
  return match[1]!;
}

function assertContainedVersionProbeDurable(adapterId: ContainedNativeAdapterId, result: ChildResult): string {
  if (
    result.code !== 0 ||
    result.transportOk !== true ||
    result.scopeTrusted !== true ||
    result.scopeReaped !== true ||
    !result.scopeId?.startsWith("cgroup2:") ||
    result.transcriptDurable !== true ||
    !result.transcriptSha256
  ) {
    throw new ContainedAdapterCharacterizationUnavailable(adapterId, "contained --version probe was not durable and reaped");
  }
  return result.stdout.trim();
}

/** Parse exact Grok `--version` text: `1.0.0 (3cd0d0cbce) [stable]` (optional `grok` prefix). */
export function parseContainedGrokVersionText(text: string): Readonly<{
  version: string;
  buildCommit: string;
  channel: string;
}> {
  const match = GROK_VERSION_RE.exec(text.trim());
  if (!match) {
    throw new ContainedAdapterCharacterizationUnavailable(
      "grok",
      "--version output was not one canonical Grok version/build/channel record"
    );
  }
  return Object.freeze({
    version: match[1]!,
    buildCommit: match[2]!,
    channel: match[3]!
  });
}

function grokVersionFrom(result: ChildResult): Readonly<{
  version: string;
  buildCommit: string;
  channel: string;
}> {
  return parseContainedGrokVersionText(assertContainedVersionProbeDurable("grok", result));
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
  adapterId: ContainedNativeAdapterId,
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
  const accountingDigest = sha(`${adapterId}:accounting-observation`, {
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

function namesMutationTarget(
  event: Extract<NormalizedAdapterEvent, { kind: "tool" }>,
  targetName: string
): boolean {
  return (event.title !== undefined && event.title.includes(targetName)) ||
    event.toolCallId.includes(targetName);
}

/**
 * Pi reviewer correlation is path-exact only: resolve relative titles against the
 * characterization workspace and require equality with the parent-owned target path.
 * Opaque toolCallIds, wrong basenames, and unrelated paths never satisfy this check.
 */
export function piReviewerToolTitleMatchesTarget(
  title: string | undefined,
  targetPath: string,
  workspaceRoot: string
): boolean {
  if (typeof title !== "string" || title.length === 0 || title.includes("\0")) return false;
  if (!isAbsolute(workspaceRoot) || !isAbsolute(targetPath)) return false;
  if (workspaceRoot.includes("\0") || targetPath.includes("\0")) return false;
  if (Buffer.byteLength(title, "utf8") > CONTAINED_WORKSPACE_MAX_RELATIVE_PATH_BYTES && !isAbsolute(title)) {
    return false;
  }
  if (isAbsolute(title) && Buffer.byteLength(title, "utf8") > 4_096) return false;
  const resolvedTitle = isAbsolute(title) ? resolve(title) : resolve(workspaceRoot, title);
  return resolvedTitle === resolve(targetPath);
}

function piNamesExactMutationTarget(
  event: Extract<NormalizedAdapterEvent, { kind: "tool" }>,
  targetPath: string,
  workspaceRoot: string
): boolean {
  return piReviewerToolTitleMatchesTarget(event.title, targetPath, workspaceRoot);
}

function reviewerMutationEvidence(
  adapterId: ContainedNativeAdapterId,
  targetPath: string,
  targetOriginal: string,
  events: readonly NormalizedAdapterEvent[],
  workspace: ContainedWorkspaceSnapshot
): Readonly<{ passed: true; evidenceSha256: string }> {
  const targetName = targetPath.split(/[/\\]/u).pop() ?? "";
  if (!targetName) {
    throw new ContainedAdapterCharacterizationUnavailable(adapterId, "reviewer target path is malformed");
  }
  let currentTarget: string;
  try {
    currentTarget = readFileSync(targetPath, "utf8");
  } catch {
    throw new ContainedAdapterCharacterizationUnavailable(adapterId, "reviewer target disappeared during denial probe");
  }
  if (currentTarget !== targetOriginal) {
    throw new ContainedAdapterCharacterizationUnavailable(adapterId, "reviewer target content changed; mutation denial failed");
  }
  assertContainedWorkspaceUnchanged(workspace.root, workspace, "reviewer denial", adapterId);

  if (adapterId === "pi") {
    // Pi reviewer has no ACP permission channel. Accept only tool lifecycle events whose
    // normalized title is an exact path match for the parent-owned target (relative titles
    // resolve against the characterization workspace). Opaque IDs and basename substrings
    // in toolCallId are never sufficient.
    const pending = events.filter((event) =>
      event.kind === "tool" &&
      (event.state === "proposed" || event.state === "started") &&
      piNamesExactMutationTarget(event, targetPath, workspace.root)
    );
    const failed = events.filter((event) =>
      event.kind === "tool" &&
      event.state === "failed" &&
      piNamesExactMutationTarget(event, targetPath, workspace.root)
    );
    if (pending.length === 0 || failed.length === 0) {
      throw new ContainedAdapterCharacterizationUnavailable(
        adapterId,
        "reviewer denial lacks tool lifecycle evidence correlated to the named mutation target; marking unavailable rather than guessing"
      );
    }
    const correlated = failed.some((failEvent) =>
      failEvent.kind === "tool" &&
      pending.some((start) => start.kind === "tool" && start.toolCallId === failEvent.toolCallId)
    );
    if (!correlated) {
      throw new ContainedAdapterCharacterizationUnavailable(
        adapterId,
        "reviewer tool failure is not lifecycle-correlated to the named-target mutation attempt"
      );
    }
    const evidenceSha256 = sha(`${adapterId}:read-only-denial`, {
      targetName,
      targetUnchanged: true,
      helper: PI_REVIEWER_HELPER_RUNTIME,
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

  // OpenCode: synthetic permission-only events never prove denial of a named write. Require the
  // permission request to precede a tool lifecycle that names the exact mutation target basename.
  const permissionIndex = events.findIndex((event) => event.kind === "permission" && event.state === "requested");
  if (permissionIndex < 0) {
    throw new ContainedAdapterCharacterizationUnavailable(
      adapterId,
      "reviewer denial requires exactly one correlated permission request for the named mutation attempt"
    );
  }
  const permission = events[permissionIndex]!;
  if (permission.kind !== "permission") {
    throw new ContainedAdapterCharacterizationUnavailable(adapterId, "reviewer permission event kind mismatch");
  }
  const extraPermissions = events.filter((event, index) =>
    index !== permissionIndex && event.kind === "permission" && event.state === "requested"
  );
  if (extraPermissions.length !== 0) {
    throw new ContainedAdapterCharacterizationUnavailable(
      adapterId,
      "reviewer denial requires exactly one correlated permission request for the named mutation attempt"
    );
  }

  // F3: title or toolCallId must contain the exact target basename — no generic write/edit regex.
  const pending = events
    .map((event, index) => ({ event, index }))
    .filter(({ event, index }) =>
      index > permissionIndex &&
      event.kind === "tool" &&
      (event.state === "proposed" || event.state === "started") &&
      namesMutationTarget(event, targetName)
    );
  const failed = events
    .map((event, index) => ({ event, index }))
    .filter(({ event, index }) =>
      index > permissionIndex &&
      event.kind === "tool" &&
      event.state === "failed" &&
      namesMutationTarget(event, targetName)
    );
  if (pending.length === 0 || failed.length === 0) {
    throw new ContainedAdapterCharacterizationUnavailable(
      adapterId,
      "reviewer denial lacks tool lifecycle evidence correlated to the named mutation target; marking unavailable rather than guessing"
    );
  }
  // Require the failed toolCallId to equal a started/proposed attempt after the permission request.
  const correlated = failed.some(({ event: failEvent }) =>
    failEvent.kind === "tool" &&
    pending.some(({ event: start }) => start.kind === "tool" && start.toolCallId === failEvent.toolCallId)
  );
  if (!correlated) {
    throw new ContainedAdapterCharacterizationUnavailable(
      adapterId,
      "reviewer tool failure is not lifecycle-correlated to the permissioned named-target mutation attempt"
    );
  }
  const evidenceSha256 = sha(`${adapterId}:read-only-denial`, {
    targetName,
    targetUnchanged: true,
    permissionId: permission.permissionId,
    toolCallIds: failed
      .filter(({ event }) => event.kind === "tool")
      .map(({ event }) => (event.kind === "tool" ? event.toolCallId : "")),
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
  /** ACP session/new is shared by OpenCode and Grok; default remains OpenCode for back-compat. */
  adapterId?: Extract<ContainedNativeAdapterId, "opencode" | "grok">;
}>): Readonly<{ sessionId: string; source: "normalized-event" | "durable-transcript"; frameSha256?: string }> {
  const adapterId = input.adapterId ?? "opencode";
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
    adapterId,
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

function requireWorkerPromptEvidence(adapterId: ContainedNativeAdapterId, events: readonly NormalizedAdapterEvent[]): number {
  const assistantBytes = assistantOutputBytes(events);
  if (assistantBytes <= 0) {
    throw new ContainedAdapterCharacterizationUnavailable(
      adapterId,
      "worker prompt produced no assistant output; prompt-roundtrip is unproven"
    );
  }
  if (!hasStreamingDeltas(events)) {
    throw new ContainedAdapterCharacterizationUnavailable(
      adapterId,
      "worker prompt produced no streaming assistant deltas; streaming is unproven"
    );
  }
  return assistantBytes;
}

function deriveOpenCodeBehavioralEvidence(input: Readonly<{
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
  const workerAssistantBytes = requireWorkerPromptEvidence("opencode", input.workerEvents);
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
  executablePin: ContainedExecutablePin,
  environment: Readonly<Record<string, string>>,
  configurationSha256: string,
  characterizationParent?: string
): Promise<ContainedAdapterProbeResult> {
  const adapterId = "opencode" as const;
  const root = allocateCharacterizationRoot(adapterId, characterizationParent);
  const work = join(root, "workspace");
  mkdirSync(work, { mode: 0o700 });
  writeFileSync(join(work, "README.md"), "contained OpenCode characterization\n", { mode: 0o600 });
  const gitInit = runGit(work, ["init", "--quiet"]);
  if (!gitInit.ok) {
    rmSync(root, { recursive: true, force: true });
    throw new ContainedAdapterCharacterizationUnavailable(adapterId, `private fixture repository init failed: ${gitInit.err}`);
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
    // Revalidate the caller-owned pin before any version or behavioral call.
    assertContainedExecutablePin(executablePin, "before version probe", adapterId);

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
    assertContainedExecutablePin(executablePin, "after version probe", adapterId);
    const observedVersion = versionFrom(adapterId, version);

    const baselineWorkspace = snapshotContainedWorkspace(work, adapterId);
    const workerEvents: NormalizedAdapterEvent[] = [];
    const worker = await runContainedNativeCharacterizationTurn({
      ctx,
      role,
      kind: "implementer",
      taskText: OPEN_CODE_PROMPT,
      systemPrompt,
      workCwd: work,
      state: state(adapterId, runId, 1),
      taskId: "worker",
      attempt: 1,
      providerKey: "native",
      runtime,
      onAdapterEvent: (event) => workerEvents.push(event)
    });
    assertContainedExecutablePin(executablePin, "after worker prompt", adapterId);
    // Bounded-no-write: Git/workspace inventory must be bit-identical after the worker turn.
    assertContainedWorkspaceUnchanged(work, baselineWorkspace, "worker prompt", adapterId);
    const workerTerminal = exactTerminal(adapterId, ctx, worker, "worker prompt");
    // Fail before spending more provider/containment work when the primary
    // prompt cannot establish the minimum semantic roundtrip. The derivation
    // repeats this check as defense in depth over the final evidence set.
    requireWorkerPromptEvidence(adapterId, workerEvents);

    const reviewerTarget = join(work, "reviewer-target.txt");
    const reviewerOriginal = "parent-owned reviewer sentinel\n";
    writeFileSync(reviewerTarget, reviewerOriginal, { mode: 0o600 });
    // Reviewer may not mutate the workspace; snapshot includes the new target.
    const reviewerWorkspace = snapshotContainedWorkspace(work, adapterId);
    const reviewerEvents: NormalizedAdapterEvent[] = [];
    const reviewer = await runContainedNativeCharacterizationTurn({
      ctx,
      role,
      kind: "reviewer",
      taskText: `${OPEN_CODE_REVIEWER_PROMPT} Target: ${reviewerTarget}`,
      systemPrompt,
      workCwd: work,
      state: state(adapterId, runId, 2),
      taskId: "reviewer",
      attempt: 1,
      providerKey: "native",
      runtime,
      onAdapterEvent: (event) => reviewerEvents.push(event)
    });
    assertContainedExecutablePin(executablePin, "after reviewer denial", adapterId);
    const reviewerTerminal = exactTerminal(adapterId, ctx, reviewer, "reviewer denial");
    const reviewerDenial = reviewerMutationEvidence(
      adapterId,
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
      state: state(adapterId, runId, 3),
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
    assertContainedExecutablePin(executablePin, "after cancellation", adapterId);
    const cancellationTerminal = exactCancelledTerminal(adapterId, ctx, cancellation);

    const accounting = usageEvidence(adapterId, worker, workerEvents);
    const executable = assertContainedExecutablePin(executablePin, "before availability derivation", adapterId);
    const behavioral = deriveOpenCodeBehavioralEvidence({
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
      throw new ContainedAdapterCharacterizationUnavailable(adapterId, `${availability.reason.code}: ${availability.reason.detail}`);
    }

    // Consume only the just-derived availability in the ordinary public route. This is the proof that
    // characterization did not create a parallel launch grammar or a provisional availability bypass.
    ctx.adapterAvailability = Object.freeze({ native: availability });
    const replayWorkspace = snapshotContainedWorkspace(work, adapterId);
    const replay = await runRoutedTurn(
      ctx,
      role,
      "implementer",
      OPEN_CODE_REPLAY_PROMPT,
      systemPrompt,
      work,
      "",
      state(adapterId, runId, 4),
      "replay",
      1
    );
    assertContainedExecutablePin(executablePin, "after ordinary replay", adapterId);
    // Bounded-no-write after ordinary-route replay using the same Git/workspace inventory.
    assertContainedWorkspaceUnchanged(work, replayWorkspace, "ordinary availability replay", adapterId);
    const replayTerminal = exactTerminal(adapterId, ctx, replay, "ordinary availability replay");
    if (
      canonicalContainedAdapterEvidenceJson({
        ...replayTerminal.bind.adapter!.replay
      }) !==
        canonicalContainedAdapterEvidenceJson({
          ...workerTerminal.bind.adapter!.replay
        }) ||
      replayTerminal.bind.adapter?.replay.normalizer.id !== availability.binding.normalizer.id
    ) throw new ContainedAdapterCharacterizationUnavailable(adapterId, "ordinary route replay did not match the characterized adapter contract");
    const expectedRuntime = containedAdapterRuntimeIdentitySha256(executable, [], configurationSha256);
    if (
      workerTerminal.bind.adapter?.runtimeIdentitySha256 !== expectedRuntime ||
      replayTerminal.bind.adapter?.runtimeIdentitySha256 !== expectedRuntime ||
      cancellationTerminal.bind.adapter?.runtimeIdentitySha256 !== expectedRuntime ||
      reviewerTerminal.bind.adapter?.runtimeIdentitySha256 !== expectedRuntime
    ) {
      throw new ContainedAdapterCharacterizationUnavailable(
        adapterId,
        "runtime plus controlled-configuration identity was not bound into reservation/settlement/replay"
      );
    }

    // Final pin revalidation before minting settlement/check evidence for the receipt.
    const finalExecutable = assertContainedExecutablePin(executablePin, "before terminal evidence receipt", adapterId);
    if (!sameRuntimeFileEvidence(finalExecutable, executable) || !sameRuntimeFileEvidence(finalExecutable, availability.executable)) {
      throw new ContainedAdapterCharacterizationUnavailable(
        adapterId,
        "executable identity drifted before terminal evidence receipt; refusing characterization"
      );
    }

    if (ctx.children.size !== 0 || ctx.ownedGroups.size !== 0 || (ctx.ownedScopes?.size ?? 0) !== 0) {
      throw new ContainedAdapterCharacterizationUnavailable(adapterId, "characterization left a live process or containment scope");
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
    const checkDigests = Object.freeze(
      Object.fromEntries(
        Object.entries(checks).map(([name, value]) => [name, value.evidenceSha256])
      )
    );
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
    // Terminal settlement receipt binds runtime identity, controlled config, and every check digest.
    // Fail-closed: without this binding the collector emits no evidence file.
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
          runtimeIdentitySha256: expectedRuntime,
          configurationSha256,
          executableIdentity: finalExecutable.identity,
          checks: checkDigests
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

/**
 * F4 (Pi): state-query and statistics-query must be observed from exact durable transcript frames
 * re-decoded with the correlated request IDs. Never inferred from reservation grammar or argv.
 */
export function observeContainedPiStateAndStats(input: Readonly<{
  transcriptPath?: string;
  transcriptDurable?: boolean;
  transcriptSha256?: string;
  stateRequestId: string;
  statisticsBeforeRequestId: string;
}>): Readonly<{
  state: Readonly<{ value: PiStateEvidence; frameSha256: string }>;
  statistics: PiSessionStatsSnapshot;
}> {
  if (
    input.transcriptDurable !== true ||
    typeof input.transcriptPath !== "string" ||
    input.transcriptPath.length === 0
  ) {
    throw new ContainedAdapterCharacterizationUnavailable(
      "pi",
      "Pi state/statistics were not observed from a durable transcript; refusing to invent readiness"
    );
  }
  const decoded = decodePiStateAndStatsFromDurableTranscript(
    input.transcriptPath,
    input.stateRequestId,
    input.statisticsBeforeRequestId,
    input.transcriptSha256
  );
  if (!decoded) {
    throw new ContainedAdapterCharacterizationUnavailable(
      "pi",
      "Pi state/statistics correlation was not observed; refusing to invent readiness"
    );
  }
  return decoded;
}

function decodePiStateAndStatsFromDurableTranscript(
  transcriptPath: string,
  stateRequestId: string,
  statisticsBeforeRequestId: string,
  expectedSha256?: string
): Readonly<{
  state: Readonly<{ value: PiStateEvidence; frameSha256: string }>;
  statistics: PiSessionStatsSnapshot;
}> | undefined {
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
    let state: Readonly<{ value: PiStateEvidence; frameSha256: string }> | undefined;
    let statistics: PiSessionStatsSnapshot | undefined;
    const framer = new BoundedJsonlFramer((frame) => {
      if (!state) {
        const decoded = decodePiStateResponse(frame, stateRequestId);
        if (decoded.status === "valid") {
          state = Object.freeze({ value: decoded.value, frameSha256: decoded.frame.sha256 });
        }
        return;
      }
      if (!statistics) {
        const decoded = decodePiSessionStatsResponse(frame, statisticsBeforeRequestId, state.value.sessionId, 1);
        if (decoded.status === "valid") {
          statistics = decoded.value;
        }
      }
    }, {
      maxFrameBytes: 64 * 1024,
      maxTotalBytes: 16 * 1024 * 1024,
      maxFrames: 4_096
    });
    framer.push(body);
    framer.finish();
    if (!state || !statistics) return undefined;
    if (
      state.value.sessionId !== statistics.sessionId ||
      state.value.isStreaming ||
      state.value.isCompacting
    ) {
      return undefined;
    }
    return Object.freeze({ state, statistics });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function derivePiBehavioralEvidence(input: Readonly<{
  version: ChildResult;
  worker: ChildResult;
  workerTerminal: LedgerTerminalSettlementEvidence;
  workerEvents: readonly NormalizedAdapterEvent[];
  cancellation: ChildResult;
  cancellationTerminal: LedgerTerminalSettlementEvidence;
  cancellationEvents: readonly NormalizedAdapterEvent[];
  accounting: Readonly<{ accountingDigest: string; usage: boolean; cost: boolean; context: boolean }>;
  executable: RuntimeFileEvidence;
  helper: RuntimeFileEvidence;
  configurationSha256: string;
  observedVersion: string;
  stateAndStats: Readonly<{
    state: Readonly<{ value: PiStateEvidence; frameSha256: string }>;
    statistics: PiSessionStatsSnapshot;
  }>;
}>): Readonly<Record<BehavioralProbeCheck, string>> {
  const workerAssistantBytes = requireWorkerPromptEvidence("pi", input.workerEvents);
  if (input.cancellationEvents.filter((event) => event.kind === "cancel" && event.state === "terminal-cancelled").length !== 1) {
    throw new ContainedAdapterCharacterizationUnavailable("pi", "cooperative cancellation was not observed exactly once");
  }

  const runtimeBinding = containedAdapterRuntimeIdentitySha256(
    input.executable,
    [],
    input.configurationSha256
  );
  if (input.workerTerminal.bind.adapter?.runtimeIdentitySha256 !== runtimeBinding) {
    throw new ContainedAdapterCharacterizationUnavailable(
      "pi",
      "worker settlement runtime identity does not match the pinned executable and controlled configuration"
    );
  }

  // evaluatePiProbe requires state-query/statistics-query evidence digests equal the exact frame hashes.
  const framing = sha("pi:framing", {
    workerFrames: input.workerEvents.map((event) => event.frame.sha256),
    transcript: input.worker.transcriptSha256
  });
  const transport = sha("pi:transport-handshake", {
    wire: PI_RPC_WIRE_VERSION,
    versionTranscript: input.version.transcriptSha256,
    workerTranscript: input.worker.transcriptSha256
  });
  const executableVersion = sha("pi:executable-version", {
    version: input.observedVersion,
    identity: input.executable.identity,
    helperIdentity: input.helper.identity,
    configurationSha256: input.configurationSha256
  });
  const promptRoundtrip = sha("pi:prompt-roundtrip", {
    transcript: input.worker.transcriptSha256,
    terminal: input.workerTerminal.recordSha256,
    adapter: adapterEvidenceIdentity(input.workerTerminal.bind.adapter!),
    assistantBytes: workerAssistantBytes,
    streaming: true,
    events: input.workerEvents.map(eventSummary)
  });
  const cancellation = sha("pi:cancellation", {
    transcript: input.cancellation.transcriptSha256,
    terminal: input.cancellationTerminal.recordSha256,
    events: input.cancellationEvents.map(eventSummary)
  });

  return Object.freeze({
    "executable-version": executableVersion,
    "transport-handshake": transport,
    framing,
    "state-query": input.stateAndStats.state.frameSha256,
    "statistics-query": input.stateAndStats.statistics.frame.sha256,
    "prompt-roundtrip": promptRoundtrip,
    cancellation,
    accounting: input.accounting.accountingDigest
  } as Record<BehavioralProbeCheck, string>);
}

function piCapabilities(
  accounting: Readonly<{ usage: boolean; cost: boolean; context: boolean }>,
  workerEvents: readonly NormalizedAdapterEvent[],
  reviewerDenialProven: boolean
): PiNegotiatedCapabilities {
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
    innerReadOnly: reviewerDenialProven
  });
}

async function characterizePi(
  executablePin: ContainedExecutablePin,
  helperPin: ContainedExecutablePin,
  environment: Readonly<Record<string, string>>,
  configurationSha256: string,
  characterizationParent?: string
): Promise<ContainedAdapterProbeResult> {
  const adapterId = "pi" as const;
  const root = allocateCharacterizationRoot(adapterId, characterizationParent);
  const work = join(root, "workspace");
  mkdirSync(work, { mode: 0o700 });
  writeFileSync(join(work, "README.md"), "contained Pi characterization\n", { mode: 0o600 });
  const gitInit = runGit(work, ["init", "--quiet"]);
  if (!gitInit.ok) {
    rmSync(root, { recursive: true, force: true });
    throw new ContainedAdapterCharacterizationUnavailable(adapterId, `private fixture repository init failed: ${gitInit.err}`);
  }
  runGit(work, ["config", "user.email", "contained@relayforge.local"]);
  runGit(work, ["config", "user.name", "RelayForge Contained"]);
  runGit(work, ["add", "README.md"]);
  runGit(work, ["commit", "--quiet", "-m", "baseline"]);

  const config = RootConfigSchema.parse({
    version: 1,
    defaults: { runDir: ".relayforge/runs" },
    projects: [{
      name: "contained-pi",
      workingDir: "workspace",
      providers: {
        native: {
          type: "pi",
          // Closed credential selection: only this named env may reach the Pi process.
          auth: { mode: "api-key", env: "ANTHROPIC_API_KEY", configured: true }
        }
      },
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
    assertContainedExecutablePin(executablePin, "before version probe", adapterId);
    assertContainedExecutablePin(helperPin, "before version probe", adapterId, false);

    ctx = prepareRun(loaded, project, runId, "contained Pi compatibility characterization", "evidence");
    initCostLedger(ctx.boardDir);
    ctx.adapterEnvironment = Object.freeze({ native: environment });
    const systemPrompt = {
      file: join(ctx.promptDir, "system.md"),
      text: "You are a bounded RelayForge compatibility probe. Follow the exact request and do not inspect unrelated state."
    };
    writeFileSync(systemPrompt.file, systemPrompt.text, { mode: 0o600 });
    const transcriptDirectory = join(ctx.runDir, "version-transcripts");
    mkdirSync(transcriptDirectory, { mode: 0o700 });
    const workerRuntime = Object.freeze({
      executablePath: executablePin.evidence.canonicalPath,
      wireVersion: PI_RPC_WIRE_VERSION
    });
    const reviewerRuntime = Object.freeze({
      executablePath: executablePin.evidence.canonicalPath,
      helperPath: helperPin.evidence.canonicalPath,
      wireVersion: PI_RPC_WIRE_VERSION
    });

    const version = await runContainedNativeExecutableProbe({
      ctx,
      providerKey: "native",
      runtime: workerRuntime,
      args: ["--version"],
      environment,
      cwd: work,
      transcriptDirectory
    });
    assertContainedExecutablePin(executablePin, "after version probe", adapterId);
    assertContainedExecutablePin(helperPin, "after version probe", adapterId, false);
    const observedVersion = versionFrom(adapterId, version);
    if (observedVersion !== PI_AUDITED_VERSION) {
      throw new ContainedAdapterCharacterizationUnavailable(
        adapterId,
        `Pi executable version ${observedVersion} is outside the characterized range`
      );
    }

    const baselineWorkspace = snapshotContainedWorkspace(work, adapterId);
    const workerEvents: NormalizedAdapterEvent[] = [];
    const worker = await runContainedNativeCharacterizationTurn({
      ctx,
      role,
      kind: "implementer",
      taskText: PI_PROMPT,
      systemPrompt,
      workCwd: work,
      state: state(adapterId, runId, 1),
      taskId: "worker",
      attempt: 1,
      providerKey: "native",
      runtime: workerRuntime,
      onAdapterEvent: (event) => workerEvents.push(event)
    });
    assertContainedExecutablePin(executablePin, "after worker prompt", adapterId);
    assertContainedExecutablePin(helperPin, "after worker prompt", adapterId, false);
    assertContainedWorkspaceUnchanged(work, baselineWorkspace, "worker prompt", adapterId);
    const workerTerminal = exactTerminal(adapterId, ctx, worker, "worker prompt");
    requireWorkerPromptEvidence(adapterId, workerEvents);

    const correlation = workerTerminal.bind.adapter?.correlation;
    if (
      !correlation ||
      correlation.kind !== "pi-rpc" ||
      !("stateRequestId" in correlation) ||
      !("statisticsBeforeRequestId" in correlation)
    ) {
      throw new ContainedAdapterCharacterizationUnavailable(
        adapterId,
        "worker settlement omitted Pi lifecycle correlation for state/statistics observation"
      );
    }
    const stateAndStats = observeContainedPiStateAndStats({
      transcriptPath: worker.transcriptPath,
      transcriptDurable: worker.transcriptDurable,
      transcriptSha256: worker.transcriptSha256,
      stateRequestId: correlation.stateRequestId,
      statisticsBeforeRequestId: correlation.statisticsBeforeRequestId
    });

    const reviewerTarget = join(work, "reviewer-target.txt");
    const reviewerOriginal = "parent-owned reviewer sentinel\n";
    writeFileSync(reviewerTarget, reviewerOriginal, { mode: 0o600 });
    const reviewerWorkspace = snapshotContainedWorkspace(work, adapterId);
    const reviewerEvents: NormalizedAdapterEvent[] = [];
    const reviewer = await runContainedNativeCharacterizationTurn({
      ctx,
      role,
      kind: "reviewer",
      taskText: `${PI_REVIEWER_PROMPT} Target: ${reviewerTarget}`,
      systemPrompt,
      workCwd: work,
      state: state(adapterId, runId, 2),
      taskId: "reviewer",
      attempt: 1,
      providerKey: "native",
      runtime: reviewerRuntime,
      onAdapterEvent: (event) => reviewerEvents.push(event)
    });
    assertContainedExecutablePin(executablePin, "after reviewer denial", adapterId);
    assertContainedExecutablePin(helperPin, "after reviewer denial", adapterId, false);
    const reviewerTerminal = exactTerminal(adapterId, ctx, reviewer, "reviewer denial");
    const reviewerDenial = reviewerMutationEvidence(
      adapterId,
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
      taskText: PI_CANCEL_PROMPT,
      systemPrompt,
      workCwd: work,
      state: state(adapterId, runId, 3),
      taskId: "cancel",
      attempt: 1,
      providerKey: "native",
      runtime: workerRuntime,
      onAdapterEvent: (event) => cancellationEvents.push(event)
    });
    const cancellationTimer = setTimeout(() => requestCancel(ctx!.runDir, "contained Pi cooperative cancellation"), 250);
    let cancellation: ChildResult;
    try {
      cancellation = await cancellationPromise;
    } finally {
      clearTimeout(cancellationTimer);
      clearCancel(ctx.runDir);
    }
    assertContainedExecutablePin(executablePin, "after cancellation", adapterId);
    assertContainedExecutablePin(helperPin, "after cancellation", adapterId, false);
    const cancellationTerminal = exactCancelledTerminal(adapterId, ctx, cancellation);

    const accounting = usageEvidence(adapterId, worker, workerEvents);
    const executable = assertContainedExecutablePin(executablePin, "before availability derivation", adapterId);
    const helper = assertContainedExecutablePin(helperPin, "before availability derivation", adapterId, false);
    const behavioral = derivePiBehavioralEvidence({
      version,
      worker,
      workerTerminal,
      workerEvents,
      cancellation,
      cancellationTerminal,
      cancellationEvents,
      accounting,
      executable,
      helper,
      configurationSha256,
      observedVersion,
      stateAndStats
    });

    const availability = evaluatePiProbe({
      executable: { canonicalPath: executable.canonicalPath, identity: executable.identity, version: observedVersion },
      reviewerHelper: { canonicalPath: helper.canonicalPath, identity: helper.identity },
      wireVersion: PI_RPC_WIRE_VERSION,
      state: stateAndStats.state,
      statistics: stateAndStats.statistics,
      behavioralEvidenceSha256: behavioral,
      capabilities: piCapabilities(accounting, workerEvents, true),
      probedAt: new Date().toISOString(),
      consultedConfigSha256: configurationSha256
    });
    if (availability.status !== "available") {
      throw new ContainedAdapterCharacterizationUnavailable(adapterId, `${availability.reason.code}: ${availability.reason.detail}`);
    }

    // Ordinary public route using only the just-derived availability — no provisional bypass.
    ctx.adapterAvailability = Object.freeze({ native: availability });
    const replayWorkspace = snapshotContainedWorkspace(work, adapterId);
    const replay = await runRoutedTurn(
      ctx,
      role,
      "implementer",
      PI_REPLAY_PROMPT,
      systemPrompt,
      work,
      "",
      state(adapterId, runId, 4),
      "replay",
      1
    );
    assertContainedExecutablePin(executablePin, "after ordinary replay", adapterId);
    assertContainedExecutablePin(helperPin, "after ordinary replay", adapterId, false);
    assertContainedWorkspaceUnchanged(work, replayWorkspace, "ordinary availability replay", adapterId);
    const replayTerminal = exactTerminal(adapterId, ctx, replay, "ordinary availability replay");
    if (
      canonicalContainedAdapterEvidenceJson({
        ...replayTerminal.bind.adapter!.replay
      }) !==
        canonicalContainedAdapterEvidenceJson({
          ...workerTerminal.bind.adapter!.replay
        }) ||
      replayTerminal.bind.adapter?.replay.normalizer.id !== availability.binding.normalizer.id
    ) {
      throw new ContainedAdapterCharacterizationUnavailable(adapterId, "ordinary route replay did not match the characterized adapter contract");
    }
    const expectedWorkerRuntime = containedAdapterRuntimeIdentitySha256(executable, [], configurationSha256);
    const expectedReviewerRuntime = containedAdapterRuntimeIdentitySha256(executable, [helper], configurationSha256);
    if (
      workerTerminal.bind.adapter?.runtimeIdentitySha256 !== expectedWorkerRuntime ||
      replayTerminal.bind.adapter?.runtimeIdentitySha256 !== expectedWorkerRuntime ||
      cancellationTerminal.bind.adapter?.runtimeIdentitySha256 !== expectedWorkerRuntime
    ) {
      throw new ContainedAdapterCharacterizationUnavailable(
        adapterId,
        "worker/cancel/replay runtime plus controlled-configuration identity was not bound into reservation/settlement/replay"
      );
    }
    if (reviewerTerminal.bind.adapter?.runtimeIdentitySha256 !== expectedReviewerRuntime) {
      throw new ContainedAdapterCharacterizationUnavailable(
        adapterId,
        "reviewer runtime plus helper and controlled-configuration identity was not bound into reservation/settlement"
      );
    }

    const finalExecutable = assertContainedExecutablePin(executablePin, "before terminal evidence receipt", adapterId);
    const finalHelper = assertContainedExecutablePin(helperPin, "before terminal evidence receipt", adapterId, false);
    if (
      !sameRuntimeFileEvidence(finalExecutable, executable) ||
      !sameRuntimeFileEvidence(finalExecutable, availability.executable) ||
      !sameRuntimeFileEvidence(finalHelper, helper) ||
      !sameRuntimeFileEvidence(finalHelper, availability.trustedHelpers[0]!)
    ) {
      throw new ContainedAdapterCharacterizationUnavailable(
        adapterId,
        "executable or helper identity drifted before terminal evidence receipt; refusing characterization"
      );
    }

    if (ctx.children.size !== 0 || ctx.ownedGroups.size !== 0 || (ctx.ownedScopes?.size ?? 0) !== 0) {
      throw new ContainedAdapterCharacterizationUnavailable(adapterId, "characterization left a live process or containment scope");
    }

    const stateAndStatsCompleted = sha("pi:state-and-stats", {
      sessionId: stateAndStats.state.value.sessionId,
      stateFrame: stateAndStats.state.frameSha256,
      statisticsFrame: stateAndStats.statistics.frame.sha256,
      transcript: worker.transcriptSha256
    });
    const checks = Object.freeze({
      promptCompleted: Object.freeze({ passed: true as const, evidenceSha256: behavioral["prompt-roundtrip"]! }),
      cancellationSettled: Object.freeze({ passed: true as const, evidenceSha256: behavioral.cancellation! }),
      reviewerWriteDenied: Object.freeze({ passed: true as const, evidenceSha256: reviewerDenial.evidenceSha256 }),
      scopeEmpty: Object.freeze({
        passed: true as const,
        evidenceSha256: sha("pi:all-scopes-empty", [worker.scopeReapProof, reviewer.scopeReapProof, cancellation.scopeReapProof, replay.scopeReapProof])
      }),
      replayMatched: Object.freeze({
        passed: true as const,
        evidenceSha256: sha("pi:ordinary-replay-matched", {
          record: replayTerminal.recordSha256,
          transcript: replay.transcriptSha256,
          adapter: adapterEvidenceIdentity(replayTerminal.bind.adapter!),
          runtimeIdentitySha256: replayTerminal.bind.adapter?.runtimeIdentitySha256
        })
      }),
      stateAndStatsCompleted: Object.freeze({ passed: true as const, evidenceSha256: stateAndStatsCompleted })
    }) as unknown as ContainedAdapterProbeResult["checks"];
    const checkDigests = Object.freeze(
      Object.fromEntries(
        Object.entries(checks).map(([name, value]) => [name, value.evidenceSha256])
      )
    );
    const normalExitReapedSha256 = sha("pi:normal-reaped", {
      scope: worker.scopeId,
      proof: worker.scopeReapProof,
      terminal: workerTerminal.recordSha256
    });
    const cancellationReapedSha256 = sha("pi:cancellation-reaped", {
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
        receiptDigest: sha("pi:terminal-settlement", {
          record: workerTerminal.recordSha256,
          adapter: adapterEvidenceIdentity(workerTerminal.bind.adapter!),
          transcript: worker.transcriptSha256,
          replay: replayTerminal.recordSha256,
          runtimeIdentitySha256: expectedWorkerRuntime,
          reviewerRuntimeIdentitySha256: expectedReviewerRuntime,
          configurationSha256,
          executableIdentity: finalExecutable.identity,
          helperIdentity: finalHelper.identity,
          checks: checkDigests
        })
      }),
      checks
    });
  } finally {
    try {
      if (ctx) disposePreparedRun(ctx);
    } finally {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Best-effort; dead-owner reconciliation covers restart remnants.
      }
    }
  }
}

/**
 * F4 (Grok): ACP initialize must re-decode from the durable transcript with the exact correlated
 * request ID and prove `_meta.grokShell` + `agentVersion=1.0.0`. Never inferred from argv alone.
 */
export function observeContainedGrokHandshake(input: Readonly<{
  transcriptPath?: string;
  transcriptDurable?: boolean;
  transcriptSha256?: string;
  initializeRequestId?: string | number;
}>): Readonly<{ grokShell: true; agentVersion: typeof GROK_AUDITED_VERSION; frameSha256: string }> {
  if (
    input.transcriptDurable !== true ||
    typeof input.transcriptPath !== "string" ||
    input.transcriptPath.length === 0 ||
    input.initializeRequestId === undefined
  ) {
    throw new ContainedAdapterCharacterizationUnavailable(
      "grok",
      "Grok ACP initialize was not observed from a durable transcript; refusing to invent handshake identity"
    );
  }
  const decoded = decodeGrokHandshakeFromDurableTranscript(
    input.transcriptPath,
    input.initializeRequestId,
    input.transcriptSha256
  );
  if (!decoded) {
    throw new ContainedAdapterCharacterizationUnavailable(
      "grok",
      "Grok ACP initialize correlation was not observed; refusing to invent handshake identity"
    );
  }
  return decoded;
}

function decodeGrokHandshakeFromDurableTranscript(
  transcriptPath: string,
  initializeRequestId: string | number,
  expectedSha256?: string
): Readonly<{ grokShell: true; agentVersion: typeof GROK_AUDITED_VERSION; frameSha256: string }> | undefined {
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
    let found: Readonly<{ grokShell: true; agentVersion: typeof GROK_AUDITED_VERSION; frameSha256: string }> | undefined;
    const framer = new BoundedJsonlFramer((frame) => {
      if (found) return;
      const decoded = decodeGrokInitializeResponse(frame, initializeRequestId);
      if (decoded.status !== "valid") return;
      found = Object.freeze({
        grokShell: true as const,
        agentVersion: GROK_AUDITED_VERSION,
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

/**
 * Active parent-owned Grok egress probe: exact allowlisted CONNECT proxy + in-jail denial of
 * direct/canary paths. Uses the same Bubblewrap + durable child transport as ordinary characterization;
 * no provisional availability and no raw unsandboxed spawn of the provider.
 */
async function runContainedGrokActiveEgressProbe(input: Readonly<{
  ctx: RunContext;
  workCwd: string;
  helperPath: string;
  transcriptDirectory: string;
}>): Promise<Readonly<{
  egressEvidence: GrokEgressEvidenceBinding;
  probeReceiptSha256: string;
  reportDigest: string;
}>> {
  const adapterId = "grok" as const;
  if (!netnsSupported()) {
    throw new ContainedAdapterCharacterizationUnavailable(
      adapterId,
      "Grok egress active probe requires Linux Bubblewrap network namespace isolation"
    );
  }
  const socketDirectory = mkdtempSync(join(tmpdir(), "rf-contained-grok-egress-"));
  chmodSync(socketDirectory, 0o700);
  let proxy: GrokEgressProxy | undefined;
  let sentinel: ReturnType<typeof createServer> | undefined;
  try {
    proxy = await createGrokEgressProxy(socketDirectory);
    const socketIdentity = pinSandboxSocket(proxy.socketPath);
    sentinel = createServer((socket) => {
      socket.end("host-visible");
    });
    const hostSentinelPort = await new Promise<number>((resolvePort, rejectPort) => {
      sentinel!.once("error", rejectPort);
      sentinel!.listen(0, "127.0.0.1", () => {
        const address = sentinel!.address();
        if (!address || typeof address === "string") {
          rejectPort(new Error("Grok host sentinel did not bind a TCP port"));
          return;
        }
        resolvePort(address.port);
      });
    });
    const probe = buildGrokEgressProbeCommand({
      socketPath: proxy.socketPath,
      hostSentinelPort
    });
    const contained = containCommand(probe.command, [...probe.args], {
      writableRoot: input.workCwd,
      cwd: input.workCwd,
      network: false,
      filesystem: {
        mode: "allowlist",
        readableRoots: Object.freeze([input.helperPath]),
        runtimeRoots: Object.freeze([process.execPath, input.helperPath]),
        socketRoots: Object.freeze([socketIdentity]),
        inaccessibleRoots: Object.freeze([])
      }
    });
    if (contained.kind !== "wrapped") {
      throw new ContainedAdapterCharacterizationUnavailable(
        adapterId,
        "Grok egress active probe refused to launch without a real Bubblewrap network jail"
      );
    }
    proxy.assertSocketIdentity();
    const probeResult = await runHeadlessChild(
      input.ctx,
      contained.command,
      contained.args,
      { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      "",
      input.workCwd,
      undefined,
      input.transcriptDirectory,
      30_000
    );
    if (
      probeResult.code !== 0 ||
      probeResult.transportOk !== true ||
      probeResult.scopeTrusted !== true ||
      probeResult.scopeReaped !== true ||
      !probeResult.scopeId?.startsWith("cgroup2:") ||
      probeResult.transcriptDurable !== true ||
      !probeResult.transcriptSha256
    ) {
      throw new ContainedAdapterCharacterizationUnavailable(
        adapterId,
        "Grok egress active probe did not complete through the strong contained transcript path"
      );
    }
    let report;
    try {
      report = parseGrokEgressProbeReport(probeResult.stdout.trim());
    } catch (error) {
      throw new ContainedAdapterCharacterizationUnavailable(
        adapterId,
        `Grok egress active probe report invalid: ${(error as Error).message}`
      );
    }
    if (report.policySha256 !== GROK_EGRESS_POLICY_SHA256 || report.receiptDigest.length !== 64) {
      throw new ContainedAdapterCharacterizationUnavailable(
        adapterId,
        "Grok egress active probe receipt does not bind the shipped closed policy"
      );
    }
    const allowed = proxy.decisions().filter((decision) => decision.decision === "allowed").length;
    const denied = proxy.decisions().filter((decision) => decision.decision === "denied").length;
    if (allowed < 1 || denied < 1) {
      throw new ContainedAdapterCharacterizationUnavailable(
        adapterId,
        "Grok egress active probe did not record both an approved CONNECT and at least one denial"
      );
    }
    proxy.assertSocketIdentity();
    await proxy.closeAndDrain();
    const status = proxy.status();
    if (
      !status.closed ||
      !status.cleanupSha256 ||
      !/^[a-f0-9]{64}$/u.test(status.cleanupSha256) ||
      !/^[a-f0-9]{64}$/u.test(status.decisionLogSha256) ||
      !/^[a-f0-9]{64}$/u.test(status.socketIdentitySha256)
    ) {
      throw new ContainedAdapterCharacterizationUnavailable(
        adapterId,
        "Grok egress active probe cleanup did not prove exact socket removal and decision-log settlement"
      );
    }
    const egressEvidence = Object.freeze({
      policySha256: GROK_EGRESS_POLICY_SHA256,
      probeReceiptSha256: report.receiptDigest,
      decisionLogSha256: status.decisionLogSha256,
      socketIdentitySha256: status.socketIdentitySha256,
      cleanupSha256: status.cleanupSha256
    });
    const digests = [
      egressEvidence.policySha256,
      egressEvidence.probeReceiptSha256,
      egressEvidence.decisionLogSha256,
      egressEvidence.socketIdentitySha256,
      egressEvidence.cleanupSha256
    ];
    if (new Set(digests).size !== digests.length) {
      throw new ContainedAdapterCharacterizationUnavailable(
        adapterId,
        "Grok egress evidence digests must be distinct across policy/probe/decision/socket/cleanup"
      );
    }
    // Parent directory must be empty after exact socket removal (same topology as ordinary Grok turns).
    const remaining = readdirSync(socketDirectory);
    if (remaining.length !== 0) {
      throw new ContainedAdapterCharacterizationUnavailable(
        adapterId,
        `Grok egress parent directory retains foreign debris (${remaining.join(", ")}) after active probe`
      );
    }
    rmdirSync(socketDirectory);
    return Object.freeze({
      egressEvidence,
      probeReceiptSha256: report.receiptDigest,
      reportDigest: sha("grok:egress-probe-report", {
        receipt: report.receiptDigest,
        checks: report.checks,
        transcript: probeResult.transcriptSha256
      })
    });
  } catch (error) {
    try {
      if (proxy) await proxy.closeAndDrain().catch(() => undefined);
    } catch {
      // Best-effort teardown before rethrow.
    }
    try {
      rmSync(socketDirectory, { recursive: true, force: true });
    } catch {
      // Best-effort.
    }
    if (error instanceof ContainedAdapterCharacterizationUnavailable) throw error;
    throw new ContainedAdapterCharacterizationUnavailable(
      adapterId,
      `Grok egress active probe failed: ${(error as Error).message}`
    );
  } finally {
    if (sentinel) {
      await new Promise<void>((resolveClose) => {
        try {
          sentinel!.close(() => resolveClose());
        } catch {
          resolveClose();
        }
      });
    }
  }
}

function deriveGrokBehavioralEvidence(input: Readonly<{
  version: ChildResult;
  worker: ChildResult;
  workerTerminal: LedgerTerminalSettlementEvidence;
  workerEvents: readonly NormalizedAdapterEvent[];
  cancellation: ChildResult;
  cancellationTerminal: LedgerTerminalSettlementEvidence;
  cancellationEvents: readonly NormalizedAdapterEvent[];
  reviewerDenial: Readonly<{ evidenceSha256: string }>;
  accounting: Readonly<{ accountingDigest: string; usage: boolean; cost: boolean; context: boolean }>;
  executable: RuntimeFileEvidence;
  helper: RuntimeFileEvidence;
  configurationSha256: string;
  observedVersion: Readonly<{ version: string; buildCommit: string; channel: string }>;
  handshake: Readonly<{ grokShell: true; agentVersion: typeof GROK_AUDITED_VERSION; frameSha256: string }>;
  configurationIsolationSha256: string;
  egressEvidence: GrokEgressEvidenceBinding;
  sessionObserved: Readonly<{ sessionId: string; source: "normalized-event" | "durable-transcript"; frameSha256?: string }>;
}>): Readonly<Record<BehavioralProbeCheck, string>> {
  const workerAssistantBytes = requireWorkerPromptEvidence("grok", input.workerEvents);
  if (input.cancellationEvents.filter((event) => event.kind === "cancel" && event.state === "terminal-cancelled").length !== 1) {
    throw new ContainedAdapterCharacterizationUnavailable("grok", "cooperative cancellation was not observed exactly once");
  }

  const runtimeBinding = containedAdapterRuntimeIdentitySha256(
    input.executable,
    [input.helper],
    input.configurationSha256
  );
  if (input.workerTerminal.bind.adapter?.runtimeIdentitySha256 !== runtimeBinding) {
    throw new ContainedAdapterCharacterizationUnavailable(
      "grok",
      "worker settlement runtime identity does not match the pinned executable, egress relay and controlled configuration"
    );
  }
  if (
    !input.workerTerminal.bind.egress ||
    input.workerTerminal.bind.egress.policySha256 !== GROK_EGRESS_POLICY_SHA256 ||
    input.workerTerminal.bind.egress.probeReceiptSha256 !== input.egressEvidence.probeReceiptSha256
  ) {
    throw new ContainedAdapterCharacterizationUnavailable(
      "grok",
      "worker settlement omitted exact Grok egress authority bound to the active probe receipt"
    );
  }

  const networkToolPolicySha256 = input.egressEvidence.probeReceiptSha256;
  const unapprovedUploadDenialSha256 = grokEgressDenialEvidenceSha256(input.egressEvidence);

  const framing = sha("grok:framing", {
    workerFrames: input.workerEvents.map((event) => event.frame.sha256),
    transcript: input.worker.transcriptSha256,
    handshakeFrame: input.handshake.frameSha256
  });
  const transport = sha("grok:transport-handshake", {
    wire: GROK_ACP_WIRE_VERSION,
    versionTranscript: input.version.transcriptSha256,
    workerTranscript: input.worker.transcriptSha256,
    handshakeFrame: input.handshake.frameSha256,
    grokShell: input.handshake.grokShell,
    agentVersion: input.handshake.agentVersion
  });
  const executableVersion = sha("grok:executable-version", {
    version: input.observedVersion.version,
    buildCommit: input.observedVersion.buildCommit,
    channel: input.observedVersion.channel,
    identity: input.executable.identity,
    helperIdentity: input.helper.identity,
    configurationSha256: input.configurationSha256
  });
  const promptRoundtrip = sha("grok:prompt-roundtrip", {
    transcript: input.worker.transcriptSha256,
    terminal: input.workerTerminal.recordSha256,
    adapter: adapterEvidenceIdentity(input.workerTerminal.bind.adapter!),
    assistantBytes: workerAssistantBytes,
    streaming: true,
    events: input.workerEvents.map(eventSummary)
  });
  const cancellation = sha("grok:cancellation", {
    transcript: input.cancellation.transcriptSha256,
    terminal: input.cancellationTerminal.recordSha256,
    events: input.cancellationEvents.map(eventSummary)
  });
  const sessionCreate = sha("grok:session-create", {
    sessionId: input.sessionObserved.sessionId,
    source: input.sessionObserved.source,
    frameSha256: input.sessionObserved.frameSha256 ?? null,
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
    accounting: input.accounting.accountingDigest,
    "configuration-isolation": input.configurationIsolationSha256,
    "network-tool-policy": networkToolPolicySha256,
    "unapproved-upload-denial": unapprovedUploadDenialSha256
  } as Record<BehavioralProbeCheck, string>);
}

function grokCapabilities(
  accounting: Readonly<{ usage: boolean; cost: boolean; context: boolean }>,
  workerEvents: readonly NormalizedAdapterEvent[],
  reviewerDenialProven: boolean
): GrokNegotiatedCapabilities {
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
    innerReadOnly: reviewerDenialProven
  });
}

async function characterizeGrok(
  executablePin: ContainedExecutablePin,
  helperPin: ContainedExecutablePin,
  environment: Readonly<Record<string, string>>,
  configurationSha256: string,
  characterizationParent?: string
): Promise<ContainedAdapterProbeResult> {
  const adapterId = "grok" as const;
  const root = allocateCharacterizationRoot(adapterId, characterizationParent);
  const work = join(root, "workspace");
  mkdirSync(work, { mode: 0o700 });
  writeFileSync(join(work, "README.md"), "contained Grok characterization\n", { mode: 0o600 });
  const gitInit = runGit(work, ["init", "--quiet"]);
  if (!gitInit.ok) {
    rmSync(root, { recursive: true, force: true });
    throw new ContainedAdapterCharacterizationUnavailable(adapterId, `private fixture repository init failed: ${gitInit.err}`);
  }
  runGit(work, ["config", "user.email", "contained@relayforge.local"]);
  runGit(work, ["config", "user.name", "RelayForge Contained"]);
  runGit(work, ["add", "README.md"]);
  runGit(work, ["commit", "--quiet", "-m", "baseline"]);

  const config = RootConfigSchema.parse({
    version: 1,
    defaults: { runDir: ".relayforge/runs" },
    projects: [{
      name: "contained-grok",
      workingDir: "workspace",
      providers: {
        native: {
          type: "grok",
          // Closed credential selection: only this named env may reach the Grok process.
          auth: { mode: "api-key", env: "XAI_API_KEY", configured: true }
        }
      },
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
    assertContainedExecutablePin(executablePin, "before version probe", adapterId);
    assertContainedExecutablePin(helperPin, "before version probe", adapterId, false);

    ctx = prepareRun(loaded, project, runId, "contained Grok compatibility characterization", "evidence");
    initCostLedger(ctx.boardDir);
    ctx.adapterEnvironment = Object.freeze({ native: environment });
    const systemPrompt = {
      file: join(ctx.promptDir, "system.md"),
      text: "You are a bounded RelayForge compatibility probe. Follow the exact request and do not inspect unrelated state."
    };
    writeFileSync(systemPrompt.file, systemPrompt.text, { mode: 0o600 });
    const transcriptDirectory = join(ctx.runDir, "version-transcripts");
    mkdirSync(transcriptDirectory, { mode: 0o700 });
    const versionRuntime = Object.freeze({
      executablePath: executablePin.evidence.canonicalPath,
      wireVersion: GROK_ACP_WIRE_VERSION
    });

    const version = await runContainedNativeExecutableProbe({
      ctx,
      providerKey: "native",
      runtime: versionRuntime,
      args: ["--version"],
      environment,
      cwd: work,
      transcriptDirectory
    });
    assertContainedExecutablePin(executablePin, "after version probe", adapterId);
    assertContainedExecutablePin(helperPin, "after version probe", adapterId, false);
    const observedVersion = grokVersionFrom(version);
    if (
      observedVersion.version !== GROK_AUDITED_VERSION ||
      observedVersion.buildCommit !== GROK_AUDITED_BUILD_COMMIT ||
      observedVersion.channel !== "stable"
    ) {
      throw new ContainedAdapterCharacterizationUnavailable(
        adapterId,
        `Grok executable version/build/channel ${observedVersion.version} (${observedVersion.buildCommit}) [${observedVersion.channel}] is outside the characterized stable contract`
      );
    }

    const egressProbeDir = join(ctx.runDir, "egress-probe-transcripts");
    mkdirSync(egressProbeDir, { mode: 0o700 });
    const activeEgress = await runContainedGrokActiveEgressProbe({
      ctx,
      workCwd: work,
      helperPath: helperPin.evidence.canonicalPath,
      transcriptDirectory: egressProbeDir
    });
    assertContainedExecutablePin(executablePin, "after egress active probe", adapterId);
    assertContainedExecutablePin(helperPin, "after egress active probe", adapterId, false);

    const turnRuntime = Object.freeze({
      executablePath: executablePin.evidence.canonicalPath,
      helperPath: helperPin.evidence.canonicalPath,
      wireVersion: GROK_ACP_WIRE_VERSION,
      grokProbeReceiptSha256: activeEgress.probeReceiptSha256
    });

    const baselineWorkspace = snapshotContainedWorkspace(work, adapterId);
    const workerEvents: NormalizedAdapterEvent[] = [];
    const worker = await runContainedNativeCharacterizationTurn({
      ctx,
      role,
      kind: "implementer",
      taskText: GROK_PROMPT,
      systemPrompt,
      workCwd: work,
      state: state(adapterId, runId, 1),
      taskId: "worker",
      attempt: 1,
      providerKey: "native",
      runtime: turnRuntime,
      onAdapterEvent: (event) => workerEvents.push(event)
    });
    assertContainedExecutablePin(executablePin, "after worker prompt", adapterId);
    assertContainedExecutablePin(helperPin, "after worker prompt", adapterId, false);
    assertContainedWorkspaceUnchanged(work, baselineWorkspace, "worker prompt", adapterId);
    const workerTerminal = exactTerminal(adapterId, ctx, worker, "worker prompt");
    requireWorkerPromptEvidence(adapterId, workerEvents);

    const correlation = workerTerminal.bind.adapter?.correlation;
    const initializeRequestId =
      correlation &&
      typeof correlation === "object" &&
      correlation.kind === "acp-v1" &&
      "initializeRequestId" in correlation
        ? correlation.initializeRequestId
        : undefined;
    const newSessionRequestId =
      correlation &&
      typeof correlation === "object" &&
      correlation.kind === "acp-v1" &&
      "newSessionRequestId" in correlation
        ? correlation.newSessionRequestId
        : undefined;
    const handshake = observeContainedGrokHandshake({
      transcriptPath: worker.transcriptPath,
      transcriptDurable: worker.transcriptDurable,
      transcriptSha256: worker.transcriptSha256,
      initializeRequestId
    });
    const sessionObserved = observeContainedOpenCodeSessionCreate({
      events: workerEvents,
      transcriptPath: worker.transcriptPath,
      transcriptDurable: worker.transcriptDurable,
      transcriptSha256: worker.transcriptSha256,
      newSessionRequestId,
      adapterId: "grok"
    });

    if (!worker.nativeConfigurationEvidenceSha256 || !/^[a-f0-9]{64}$/u.test(worker.nativeConfigurationEvidenceSha256)) {
      throw new ContainedAdapterCharacterizationUnavailable(
        adapterId,
        "worker turn omitted private configuration topology evidence for configuration isolation"
      );
    }
    const configurationIsolationSha256 = sha("grok:configuration-isolation", {
      safetyEnvironment: GROK_FIXED_SAFETY_ENVIRONMENT,
      nativeConfigurationEvidenceSha256: worker.nativeConfigurationEvidenceSha256,
      configurationSha256,
      privateStateKeys: ["HOME", "USERPROFILE", "GROK_HOME", "TMPDIR", "TMP", "TEMP", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"]
    });

    const reviewerTarget = join(work, "reviewer-target.txt");
    const reviewerOriginal = "parent-owned reviewer sentinel\n";
    writeFileSync(reviewerTarget, reviewerOriginal, { mode: 0o600 });
    const reviewerWorkspace = snapshotContainedWorkspace(work, adapterId);
    const reviewerEvents: NormalizedAdapterEvent[] = [];
    const reviewer = await runContainedNativeCharacterizationTurn({
      ctx,
      role,
      kind: "reviewer",
      taskText: `${GROK_REVIEWER_PROMPT} Target: ${reviewerTarget}`,
      systemPrompt,
      workCwd: work,
      state: state(adapterId, runId, 2),
      taskId: "reviewer",
      attempt: 1,
      providerKey: "native",
      runtime: turnRuntime,
      onAdapterEvent: (event) => reviewerEvents.push(event)
    });
    assertContainedExecutablePin(executablePin, "after reviewer denial", adapterId);
    assertContainedExecutablePin(helperPin, "after reviewer denial", adapterId, false);
    const reviewerTerminal = exactTerminal(adapterId, ctx, reviewer, "reviewer denial");
    const reviewerDenial = reviewerMutationEvidence(
      adapterId,
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
      taskText: GROK_CANCEL_PROMPT,
      systemPrompt,
      workCwd: work,
      state: state(adapterId, runId, 3),
      taskId: "cancel",
      attempt: 1,
      providerKey: "native",
      runtime: turnRuntime,
      onAdapterEvent: (event) => cancellationEvents.push(event)
    });
    const cancellationTimer = setTimeout(() => requestCancel(ctx!.runDir, "contained Grok cooperative cancellation"), 250);
    let cancellation: ChildResult;
    try {
      cancellation = await cancellationPromise;
    } finally {
      clearTimeout(cancellationTimer);
      clearCancel(ctx.runDir);
    }
    assertContainedExecutablePin(executablePin, "after cancellation", adapterId);
    assertContainedExecutablePin(helperPin, "after cancellation", adapterId, false);
    const cancellationTerminal = exactCancelledTerminal(adapterId, ctx, cancellation);

    const accounting = usageEvidence(adapterId, worker, workerEvents);
    const executable = assertContainedExecutablePin(executablePin, "before availability derivation", adapterId);
    const helper = assertContainedExecutablePin(helperPin, "before availability derivation", adapterId, false);
    const behavioral = deriveGrokBehavioralEvidence({
      version,
      worker,
      workerTerminal,
      workerEvents,
      cancellation,
      cancellationTerminal,
      cancellationEvents,
      reviewerDenial,
      accounting,
      executable,
      helper,
      configurationSha256,
      observedVersion,
      handshake,
      configurationIsolationSha256,
      egressEvidence: activeEgress.egressEvidence,
      sessionObserved
    });

    const availability = evaluateGrokProbe({
      executable: {
        canonicalPath: executable.canonicalPath,
        identity: executable.identity,
        version: observedVersion.version,
        buildCommit: observedVersion.buildCommit,
        channel: observedVersion.channel
      },
      trustedHelper: {
        canonicalPath: helper.canonicalPath,
        identity: helper.identity
      },
      wireVersion: GROK_ACP_WIRE_VERSION,
      handshake: {
        grokShell: handshake.grokShell,
        agentVersion: handshake.agentVersion
      },
      apiKeyConfigured: typeof environment.XAI_API_KEY === "string" && environment.XAI_API_KEY.length > 0,
      behavioralEvidenceSha256: behavioral,
      safetyEvidence: Object.freeze({
        configurationIsolationSha256,
        networkToolPolicySha256: activeEgress.egressEvidence.probeReceiptSha256,
        unapprovedUploadDenialSha256: grokEgressDenialEvidenceSha256(activeEgress.egressEvidence)
      }),
      egressEvidence: activeEgress.egressEvidence,
      capabilities: grokCapabilities(accounting, workerEvents, true),
      probedAt: new Date().toISOString(),
      consultedConfigSha256: configurationSha256
    });
    if (availability.status !== "available") {
      throw new ContainedAdapterCharacterizationUnavailable(adapterId, `${availability.reason.code}: ${availability.reason.detail}`);
    }

    // Ordinary public route using only the just-derived availability — no provisional bypass.
    ctx.adapterAvailability = Object.freeze({ native: availability });
    const replayWorkspace = snapshotContainedWorkspace(work, adapterId);
    const replay = await runRoutedTurn(
      ctx,
      role,
      "implementer",
      GROK_REPLAY_PROMPT,
      systemPrompt,
      work,
      "",
      state(adapterId, runId, 4),
      "replay",
      1
    );
    assertContainedExecutablePin(executablePin, "after ordinary replay", adapterId);
    assertContainedExecutablePin(helperPin, "after ordinary replay", adapterId, false);
    assertContainedWorkspaceUnchanged(work, replayWorkspace, "ordinary availability replay", adapterId);
    const replayTerminal = exactTerminal(adapterId, ctx, replay, "ordinary availability replay");
    if (
      canonicalContainedAdapterEvidenceJson({
        ...replayTerminal.bind.adapter!.replay
      }) !==
        canonicalContainedAdapterEvidenceJson({
          ...workerTerminal.bind.adapter!.replay
        }) ||
      replayTerminal.bind.adapter?.replay.normalizer.id !== availability.binding.normalizer.id
    ) {
      throw new ContainedAdapterCharacterizationUnavailable(adapterId, "ordinary route replay did not match the characterized adapter contract");
    }
    const expectedRuntime = containedAdapterRuntimeIdentitySha256(executable, [helper], configurationSha256);
    if (
      workerTerminal.bind.adapter?.runtimeIdentitySha256 !== expectedRuntime ||
      replayTerminal.bind.adapter?.runtimeIdentitySha256 !== expectedRuntime ||
      cancellationTerminal.bind.adapter?.runtimeIdentitySha256 !== expectedRuntime ||
      reviewerTerminal.bind.adapter?.runtimeIdentitySha256 !== expectedRuntime
    ) {
      throw new ContainedAdapterCharacterizationUnavailable(
        adapterId,
        "runtime plus egress-relay and controlled-configuration identity was not bound into reservation/settlement/replay"
      );
    }
    if (
      !replayTerminal.bind.egress ||
      replayTerminal.bind.egress.policySha256 !== GROK_EGRESS_POLICY_SHA256 ||
      replayTerminal.bind.egress.probeReceiptSha256 !== activeEgress.probeReceiptSha256
    ) {
      throw new ContainedAdapterCharacterizationUnavailable(
        adapterId,
        "ordinary route replay omitted exact Grok egress authority bound to the active probe receipt"
      );
    }

    const finalExecutable = assertContainedExecutablePin(executablePin, "before terminal evidence receipt", adapterId);
    const finalHelper = assertContainedExecutablePin(helperPin, "before terminal evidence receipt", adapterId, false);
    if (
      !sameRuntimeFileEvidence(finalExecutable, executable) ||
      !sameRuntimeFileEvidence(finalExecutable, availability.executable) ||
      !sameRuntimeFileEvidence(finalHelper, helper) ||
      !sameRuntimeFileEvidence(finalHelper, availability.trustedHelpers[0]!)
    ) {
      throw new ContainedAdapterCharacterizationUnavailable(
        adapterId,
        "executable or egress relay identity drifted before terminal evidence receipt; refusing characterization"
      );
    }

    if (ctx.children.size !== 0 || ctx.ownedGroups.size !== 0 || (ctx.ownedScopes?.size ?? 0) !== 0) {
      throw new ContainedAdapterCharacterizationUnavailable(adapterId, "characterization left a live process or containment scope");
    }

    const checks = Object.freeze({
      promptCompleted: Object.freeze({ passed: true as const, evidenceSha256: behavioral["prompt-roundtrip"]! }),
      cancellationSettled: Object.freeze({ passed: true as const, evidenceSha256: behavioral.cancellation! }),
      reviewerWriteDenied: Object.freeze({ passed: true as const, evidenceSha256: behavioral["read-only-denial"]! }),
      scopeEmpty: Object.freeze({
        passed: true as const,
        evidenceSha256: sha("grok:all-scopes-empty", [worker.scopeReapProof, reviewer.scopeReapProof, cancellation.scopeReapProof, replay.scopeReapProof])
      }),
      replayMatched: Object.freeze({
        passed: true as const,
        evidenceSha256: sha("grok:ordinary-replay-matched", {
          record: replayTerminal.recordSha256,
          transcript: replay.transcriptSha256,
          adapter: adapterEvidenceIdentity(replayTerminal.bind.adapter!),
          runtimeIdentitySha256: replayTerminal.bind.adapter?.runtimeIdentitySha256,
          egressProbeReceiptSha256: activeEgress.probeReceiptSha256
        })
      }),
      configurationIsolated: Object.freeze({ passed: true as const, evidenceSha256: behavioral["configuration-isolation"]! }),
      networkToolPolicyEnforced: Object.freeze({ passed: true as const, evidenceSha256: behavioral["network-tool-policy"]! }),
      unapprovedUploadDenied: Object.freeze({ passed: true as const, evidenceSha256: behavioral["unapproved-upload-denial"]! })
    }) as unknown as ContainedAdapterProbeResult["checks"];
    const checkDigests = Object.freeze(
      Object.fromEntries(
        Object.entries(checks).map(([name, value]) => [name, value.evidenceSha256])
      )
    );
    const normalExitReapedSha256 = sha("grok:normal-reaped", {
      scope: worker.scopeId,
      proof: worker.scopeReapProof,
      terminal: workerTerminal.recordSha256
    });
    const cancellationReapedSha256 = sha("grok:cancellation-reaped", {
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
        receiptDigest: sha("grok:terminal-settlement", {
          record: workerTerminal.recordSha256,
          adapter: adapterEvidenceIdentity(workerTerminal.bind.adapter!),
          transcript: worker.transcriptSha256,
          replay: replayTerminal.recordSha256,
          runtimeIdentitySha256: expectedRuntime,
          configurationSha256,
          executableIdentity: finalExecutable.identity,
          helperIdentity: finalHelper.identity,
          egress: activeEgress.egressEvidence,
          checks: checkDigests
        })
      }),
      checks
    });
  } finally {
    try {
      if (ctx) disposePreparedRun(ctx);
    } finally {
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
  const repositoryPin = pinContainedEvidenceRepository(input.repositoryRoot, input.commitSha, input.adapterId);
  const source = input.environment ?? process.env;
  const controlledEnvironment = containedAdapterProbeEnvironment(input.adapterId, source);
  const configurationSha256 = containedAdapterProbeConfigurationSha256(input.adapterId, source);
  // Independent re-derivation from the controlled recipe must match the ambient-credential derivation.
  if (containedAdapterProbeConfigurationSha256(input.adapterId, controlledEnvironment) !== configurationSha256) {
    throw new ContainedAdapterCharacterizationUnavailable(
      input.adapterId,
      "controlled configuration hash is not stable under the canonical controlled config representation"
    );
  }
  const executablePath = resolveSandboxExecutable(input.adapterId, source.PATH ?? process.env.PATH);
  // One pin identity for version probe, every characterization call, and final evidence emission.
  const executablePin = pinContainedExecutable(input.adapterId, executablePath);
  const helperPin = input.adapterId === "pi"
    ? pinContainedExecutable(PI_REVIEWER_HELPER_RUNTIME, piReviewerHelperPath(), false)
    : input.adapterId === "grok"
      ? pinContainedExecutable(GROK_EGRESS_RELAY_RUNTIME, grokEgressRelayPath(), false)
      : undefined;

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
        assertContainedExecutablePin(executablePin, "before characterization authority", input.adapterId);
        if (helperPin) {
          assertContainedExecutablePin(helperPin, "before characterization authority", input.adapterId, false);
        }
        if (input.adapterId !== "opencode" && input.adapterId !== "pi" && input.adapterId !== "grok") {
          throw new ContainedAdapterCharacterizationUnavailable(input.adapterId);
        }
        try {
          const proof = input.adapterId === "opencode"
            ? await characterizeOpenCode(
                executablePin,
                controlledEnvironment,
                configurationSha256,
                input.characterizationRoot
              )
            : input.adapterId === "pi"
              ? await characterizePi(
                  executablePin,
                  helperPin!,
                  controlledEnvironment,
                  configurationSha256,
                  input.characterizationRoot
                )
              : await characterizeGrok(
                  executablePin,
                  helperPin!,
                  controlledEnvironment,
                  configurationSha256,
                  input.characterizationRoot
                );
          // Revalidate the same pin after characterization and before the collector mints a receipt.
          assertContainedExecutablePin(executablePin, "after characterization authority", input.adapterId);
          if (helperPin) {
            assertContainedExecutablePin(helperPin, "after characterization authority", input.adapterId, false);
          }
          if (!sameRuntimeFileEvidence(executablePin.evidence, proof.availability.executable)) {
            throw new ContainedAdapterCharacterizationUnavailable(
              input.adapterId,
              "executable was substituted across characterization; no receipt"
            );
          }
          if (helperPin) {
            const helperEvidence = proof.availability.trustedHelpers[0];
            if (!helperEvidence || !sameRuntimeFileEvidence(helperPin.evidence, helperEvidence)) {
              throw new ContainedAdapterCharacterizationUnavailable(
                input.adapterId,
                "trusted helper was substituted across characterization; no receipt"
              );
            }
          }
          return proof;
        } finally {
          assertContainedEvidenceRepositoryPin(repositoryPin, input.adapterId);
        }
      }
    }
  };
  const envelope = await collectContainedAdapterEvidence(finalizerInput);
  assertContainedExecutablePin(executablePin, "after evidence receipt emission", input.adapterId);
  if (helperPin) {
    assertContainedExecutablePin(helperPin, "after evidence receipt emission", input.adapterId, false);
  }
  assertContainedEvidenceRepositoryPin(repositoryPin, input.adapterId);
  return envelope;
}

import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeSync
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export type ProvisionSpec = {
  path: string;
  requiredExecutables?: readonly string[];
};

export type ProvisionIssue = {
  code: string;
  path?: string;
  message: string;
};

export type ProvisionEntrySummary = {
  path: string;
  files: number;
  directories: number;
  symlinks: number;
  executables: number;
  bytes: number;
};

export type ProvisionInspection = {
  ok: boolean;
  disabled: boolean;
  issues: ProvisionIssue[];
  inspected: ProvisionEntrySummary[];
};

export type ProvisionResult = {
  ok: boolean;
  disabled: boolean;
  changed: boolean;
  issues: ProvisionIssue[];
  provisioned: ProvisionEntrySummary[];
};

export type ProvisionInspectionRequest = {
  sourceRoot: string;
  specs: readonly ProvisionSpec[];
};

/** Deterministic seams used by tests; production callers leave this undefined. */
export type ProvisionFaults = {
  beforeSourceOpen?: (relativePath: string) => void;
  afterSourceOpen?: (relativePath: string) => void;
  afterFileCopy?: (relativePath: string) => void;
  beforePublish?: (specPath: string) => void;
  afterBackup?: (specPath: string) => void;
};

export type ProvisionRequest = ProvisionInspectionRequest & {
  targetRoot: string;
  transactionRoot: string;
  faults?: ProvisionFaults;
};

type IssueCode =
  | "INVALID_PATH"
  | "MISSING_SOURCE"
  | "UNSAFE_SOURCE"
  | "UNSAFE_TARGET"
  | "UNSAFE_SYMLINK"
  | "UNSUPPORTED_ENTRY"
  | "COPY_FAILED"
  | "PUBLISH_FAILED"
  | "RECOVERY_REQUIRED";

class ProvisionError extends Error {
  constructor(
    readonly code: IssueCode,
    message: string,
    readonly issuePath?: string
  ) {
    super(message);
  }
}

type EntryKind = "directory" | "file" | "symlink";
type ManifestEntry = {
  relativePath: string;
  kind: EntryKind;
  mode: number;
  rawMode: bigint;
  size: bigint;
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  linkTarget?: string;
};

type InspectedSpec = {
  spec: ProvisionSpec;
  index: number;
  source: string;
  entries: ManifestEntry[];
  summary: ProvisionEntrySummary;
};

type DirectoryIdentity = { dev: bigint; ino: bigint };

const CONTROL_ENTRY_NAMES = new Set([".git", ".loop"]);
const ORDINARY_MODE = 0o777;

function issue(error: unknown, fallback: IssueCode, issuePath?: string): ProvisionIssue {
  if (error instanceof ProvisionError) {
    return { code: error.code, path: error.issuePath ?? issuePath, message: error.message };
  }
  return {
    code: fallback,
    path: issuePath,
    message: error instanceof Error ? error.message : String(error)
  };
}

function invalidPortablePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return "must be a non-empty string";
  if (/\x00|[\x01-\x1f\x7f]/u.test(value)) return "contains a NUL or control byte";
  if (value.includes("\\")) return "must use forward slashes only";
  if (isAbsolute(value) || value.startsWith("/") || /^[A-Za-z]:/u.test(value)) {
    return "must be a portable relative path";
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    return "must use canonical non-empty path segments";
  }
  for (const part of parts) {
    const windowsAlias = part.replace(/[. ]+$/u, "").toLocaleLowerCase("en-US");
    if (CONTROL_ENTRY_NAMES.has(windowsAlias)) return "must not address .git or .loop control state";
  }
  return undefined;
}

export function validateProvisionSpecs(specs: readonly ProvisionSpec[]): ProvisionIssue[] {
  const issues: ProvisionIssue[] = [];
  const prior: Array<{ folded: string; index: number }> = [];

  for (let index = 0; index < specs.length; index += 1) {
    const spec = specs[index];
    const pathError = invalidPortablePath(spec?.path);
    if (pathError) {
      issues.push({ code: "INVALID_PATH", path: `${index}.path`, message: `Provision path ${pathError}` });
    } else {
      const folded = spec.path.toLocaleLowerCase("en-US");
      const conflict = prior.find(
        (candidate) =>
          candidate.folded === folded ||
          candidate.folded.startsWith(`${folded}/`) ||
          folded.startsWith(`${candidate.folded}/`)
      );
      if (conflict) {
        issues.push({
          code: "INVALID_PATH",
          path: `${index}.path`,
          message: `Provision path duplicates or overlaps spec ${conflict.index}`
        });
      }
      prior.push({ folded, index });
    }

    const seenExecutables = new Set<string>();
    for (let executableIndex = 0; executableIndex < (spec?.requiredExecutables?.length ?? 0); executableIndex += 1) {
      const executable = spec.requiredExecutables![executableIndex];
      const executablePath = `${index}.requiredExecutables.${executableIndex}`;
      const executableError = invalidPortablePath(executable);
      if (executableError) {
        issues.push({ code: "INVALID_PATH", path: executablePath, message: `Required executable path ${executableError}` });
        continue;
      }
      const folded = executable.toLocaleLowerCase("en-US");
      if (seenExecutables.has(folded)) {
        issues.push({ code: "INVALID_PATH", path: executablePath, message: "Required executable path is duplicated" });
      }
      seenExecutables.add(folded);
    }
  }
  return issues;
}

function leafExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function rootsOverlap(first: string, second: string): boolean {
  return isContained(first, second) || isContained(second, first);
}

function assertNoSymlinkComponents(path: string, code: IssueCode): void {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  let cursor = parsed.root;
  for (const component of absolute.slice(parsed.root.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    const metadata = lstatSync(cursor);
    if (metadata.isSymbolicLink()) throw new ProvisionError(code, "Path has a symlinked component");
  }
}

function physicalDirectory(path: string, code: IssueCode): string {
  const absolute = resolve(path);
  try {
    assertNoSymlinkComponents(absolute, code);
    const metadata = lstatSync(absolute);
    if (!metadata.isDirectory()) throw new ProvisionError(code, "Path must be a real directory");
    const physical = realpathSync.native(absolute);
    if (physical !== absolute) throw new ProvisionError(code, "Path must be canonical and physical");
    return physical;
  } catch (error) {
    if (error instanceof ProvisionError) throw error;
    throw new ProvisionError(code, "Path is missing, unreadable, or not physically resolvable");
  }
}

function directoryIdentity(path: string, code: IssueCode): DirectoryIdentity {
  try {
    const absolute = resolve(path);
    const metadata = lstatSync(absolute, { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync.native(absolute) !== absolute) {
      throw new Error("not a physical directory");
    }
    return { dev: metadata.dev, ino: metadata.ino };
  } catch {
    throw new ProvisionError(code, "Directory identity changed or became unsafe");
  }
}

function assertDirectoryIdentity(path: string, expected: DirectoryIdentity, code: IssueCode): void {
  const current = directoryIdentity(path, code);
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new ProvisionError(code, "Directory identity changed during provisioning");
  }
}

function entryNameIsUnsafe(name: string): boolean {
  if (name.includes("\\") || /\x00|[\x01-\x1f\x7f]/u.test(name)) return true;
  const alias = name.replace(/[. ]+$/u, "").toLocaleLowerCase("en-US");
  return CONTROL_ENTRY_NAMES.has(alias);
}

function bigintMetadata(path: string): ManifestEntry {
  const metadata = lstatSync(path, { bigint: true });
  let kind: EntryKind;
  if (metadata.isDirectory()) kind = "directory";
  else if (metadata.isFile()) kind = "file";
  else if (metadata.isSymbolicLink()) kind = "symlink";
  else throw new ProvisionError("UNSUPPORTED_ENTRY", "Source contains a FIFO, socket, device, or other special entry");
  return {
    relativePath: "",
    kind,
    mode: Number(metadata.mode) & ORDINARY_MODE,
    rawMode: metadata.mode,
    size: metadata.size,
    dev: metadata.dev,
    ino: metadata.ino,
    nlink: metadata.nlink,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs
  };
}

function validateSourceSymlink(sourceRoot: string, linkPath: string, rawTarget: string): void {
  if (
    rawTarget.length === 0 ||
    rawTarget.includes("\\") ||
    isAbsolute(rawTarget) ||
    rawTarget.startsWith("/") ||
    /^[A-Za-z]:/u.test(rawTarget)
  ) {
    throw new ProvisionError("UNSAFE_SYMLINK", "Source symlink target must be a non-empty relative path");
  }
  const lexicalTarget = resolve(dirname(linkPath), rawTarget);
  if (!isContained(sourceRoot, lexicalTarget)) {
    throw new ProvisionError("UNSAFE_SYMLINK", "Source symlink lexically escapes its selected tree");
  }
  let physicalTarget: string;
  try {
    physicalTarget = realpathSync.native(linkPath);
  } catch {
    throw new ProvisionError("UNSAFE_SYMLINK", "Source symlink is dangling or cyclic");
  }
  if (!isContained(sourceRoot, physicalTarget)) {
    throw new ProvisionError("UNSAFE_SYMLINK", "Source symlink physically escapes its selected tree");
  }
}

function buildManifest(source: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  const identities = new Map<string, string>();

  const walk = (absolute: string, relativePath: string): void => {
    const entry = bigintMetadata(absolute);
    entry.relativePath = relativePath;
    if (entry.kind === "file") {
      if (entry.nlink !== 1n) throw new ProvisionError("UNSAFE_SOURCE", "Source contains a hard-linked regular file");
      const identity = `${entry.dev}:${entry.ino}`;
      if (identities.has(identity)) throw new ProvisionError("UNSAFE_SOURCE", "Source contains aliased regular files");
      identities.set(identity, relativePath);
    } else if (entry.kind === "symlink") {
      entry.linkTarget = readlinkSync(absolute);
      validateSourceSymlink(source, absolute, entry.linkTarget);
    }
    entries.push(entry);
    if (entry.kind !== "directory") return;
    for (const name of readdirSync(absolute).sort()) {
      if (entryNameIsUnsafe(name)) {
        throw new ProvisionError("UNSAFE_SOURCE", "Source contains non-portable or reserved control entries");
      }
      walk(join(absolute, name), relativePath ? `${relativePath}/${name}` : name);
    }
  };

  walk(source, "");
  return entries;
}

function sameManifest(first: readonly ManifestEntry[], second: readonly ManifestEntry[]): boolean {
  if (first.length !== second.length) return false;
  return first.every((entry, index) => {
    const candidate = second[index];
    return (
      candidate !== undefined &&
      entry.relativePath === candidate.relativePath &&
      entry.kind === candidate.kind &&
      entry.mode === candidate.mode &&
      entry.rawMode === candidate.rawMode &&
      entry.size === candidate.size &&
      entry.dev === candidate.dev &&
      entry.ino === candidate.ino &&
      entry.nlink === candidate.nlink &&
      entry.mtimeNs === candidate.mtimeNs &&
      entry.ctimeNs === candidate.ctimeNs &&
      entry.linkTarget === candidate.linkTarget
    );
  });
}

function summaryFor(spec: ProvisionSpec, entries: readonly ManifestEntry[]): ProvisionEntrySummary {
  return {
    path: spec.path,
    files: entries.filter((entry) => entry.kind === "file").length,
    directories: entries.filter((entry) => entry.kind === "directory").length,
    symlinks: entries.filter((entry) => entry.kind === "symlink").length,
    executables: spec.requiredExecutables?.length ?? 0,
    bytes: entries.reduce((total, entry) => total + (entry.kind === "file" ? Number(entry.size) : 0), 0)
  };
}

function inspectSpec(sourceRoot: string, spec: ProvisionSpec, index: number): InspectedSpec {
  const source = resolve(sourceRoot, ...spec.path.split("/"));
  const field = `${index}.path`;
  if (!leafExists(source)) throw new ProvisionError("MISSING_SOURCE", "Configured provision source is missing", field);
  try {
    assertNoSymlinkComponents(source, "UNSAFE_SOURCE");
  } catch (error) {
    if (error instanceof ProvisionError) throw new ProvisionError(error.code, error.message, field);
    throw error;
  }
  const sourceMetadata = lstatSync(source);
  if (!sourceMetadata.isDirectory()) throw new ProvisionError("UNSAFE_SOURCE", "Configured provision source must be a real directory", field);
  const physical = realpathSync.native(source);
  if (!isContained(sourceRoot, physical) || physical !== source) {
    throw new ProvisionError("UNSAFE_SOURCE", "Configured provision source is not physically contained", field);
  }

  let entries: ManifestEntry[];
  try {
    entries = buildManifest(source);
  } catch (error) {
    if (error instanceof ProvisionError) throw new ProvisionError(error.code, error.message, field);
    throw error;
  }

  for (let executableIndex = 0; executableIndex < (spec.requiredExecutables?.length ?? 0); executableIndex += 1) {
    const executable = spec.requiredExecutables![executableIndex];
    const executableField = `${index}.requiredExecutables.${executableIndex}`;
    const marker = resolve(source, ...executable.split("/"));
    if (!isContained(source, marker) || !leafExists(marker)) {
      throw new ProvisionError("MISSING_SOURCE", "Required executable is missing", executableField);
    }
    let physicalMarker: string;
    try {
      physicalMarker = realpathSync.native(marker);
    } catch {
      throw new ProvisionError("UNSAFE_SYMLINK", "Required executable is dangling or cyclic", executableField);
    }
    if (!isContained(source, physicalMarker)) {
      throw new ProvisionError("UNSAFE_SYMLINK", "Required executable resolves outside its selected tree", executableField);
    }
    const metadata = statSync(marker);
    if (!metadata.isFile() || (metadata.mode & 0o111) === 0) {
      throw new ProvisionError("UNSAFE_SOURCE", "Required executable must resolve to an executable regular file", executableField);
    }
  }
  return { spec, index, source, entries, summary: summaryFor(spec, entries) };
}

function inspectPlan(request: ProvisionInspectionRequest): { issues: ProvisionIssue[]; inspected: InspectedSpec[] } {
  const issues = validateProvisionSpecs(request.specs);
  if (issues.length > 0) return { issues, inspected: [] };
  let sourceRoot: string;
  try {
    sourceRoot = physicalDirectory(request.sourceRoot, "UNSAFE_SOURCE");
  } catch (error) {
    return { issues: [issue(error, "UNSAFE_SOURCE")], inspected: [] };
  }
  const inspected: InspectedSpec[] = [];
  for (let index = 0; index < request.specs.length; index += 1) {
    try {
      inspected.push(inspectSpec(sourceRoot, request.specs[index], index));
    } catch (error) {
      issues.push(issue(error, "UNSAFE_SOURCE", `${index}.path`));
    }
  }
  return { issues, inspected };
}

export function inspectProvisioning(request: ProvisionInspectionRequest): ProvisionInspection {
  if (request.specs.length === 0) return { ok: true, disabled: true, issues: [], inspected: [] };
  const inspected = inspectPlan(request);
  return {
    ok: inspected.issues.length === 0,
    disabled: false,
    issues: inspected.issues,
    inspected: inspected.inspected.map((entry) => entry.summary)
  };
}

function removeEntry(path: string): void {
  if (!leafExists(path)) return;
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    unlinkSync(path);
    return;
  }
  // Staged/backup trees may faithfully carry 0555 source modes. They are already isolated under
  // the private transaction root (or have just been renamed there), so make each real directory
  // owner-writable before unlinking its children; never chmod a symlink target.
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) removeEntry(join(path, name));
  rmdirSync(path);
}

function writeModeMarker(path: string, mode: number): void {
  const bytes = Buffer.from(String(mode & ORDINARY_MODE), "ascii");
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written === 0) throw new Error("mode marker write made no progress");
      offset += written;
    }
  } finally {
    closeSync(fd);
  }
}

function readModeMarker(path: string): number | undefined {
  if (!leafExists(path)) return undefined;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = fstatSync(fd, { bigint: true });
    if (!metadata.isFile() || metadata.nlink !== 1n || metadata.size < 1n || metadata.size > 3n) {
      throw new Error("invalid mode marker metadata");
    }
    const buffer = Buffer.alloc(Number(metadata.size));
    let count = 0;
    while (count < buffer.length) {
      const read = readSync(fd, buffer, count, buffer.length - count, count);
      if (read === 0) throw new Error("truncated mode marker");
      count += read;
    }
    const text = buffer.toString("ascii");
    if (!/^\d{1,3}$/u.test(text)) throw new Error("invalid mode marker contents");
    const mode = Number(text);
    if (!Number.isInteger(mode) || mode < 0 || mode > ORDINARY_MODE) throw new Error("invalid saved mode");
    return mode;
  } finally {
    closeSync(fd);
  }
}

function restoreRealDirectoryMode(path: string, mode: number | undefined): void {
  if (mode === undefined || !leafExists(path)) return;
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("saved mode target is not a real directory");
  chmodSync(path, mode & ORDINARY_MODE);
}

function prepareReadOnlyDirectoryMove(path: string, modeMarker: string): number | undefined {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) return undefined;
  const originalMode = metadata.mode & ORDINARY_MODE;
  if ((originalMode & 0o200) !== 0) return undefined;
  writeModeMarker(modeMarker, originalMode);
  try {
    chmodSync(path, 0o700);
  } catch (error) {
    unlinkSync(modeMarker);
    throw error;
  }
  return originalMode;
}

function ensureRealDirectories(root: string, relativeParent: string): string {
  let cursor = root;
  if (!relativeParent) return cursor;
  for (const component of relativeParent.split("/")) {
    cursor = join(cursor, component);
    if (leafExists(cursor)) {
      const metadata = lstatSync(cursor);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new ProvisionError("UNSAFE_TARGET", "Target parent contains a symlink or non-directory");
      }
    } else {
      mkdirSync(cursor, { mode: 0o700 });
    }
  }
  return cursor;
}

function assertSafeExistingTargetParent(root: string, relativeParent: string): void {
  let cursor = root;
  if (!relativeParent) return;
  for (const component of relativeParent.split("/")) {
    cursor = join(cursor, component);
    if (!leafExists(cursor)) return;
    const metadata = lstatSync(cursor);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new ProvisionError("UNSAFE_TARGET", "Target parent contains a symlink or non-directory");
    }
  }
}

function metadataMatchesManifest(metadata: BigIntStats, expected: ManifestEntry): boolean {
  return (
    metadata.isFile() &&
    metadata.dev === expected.dev &&
    metadata.ino === expected.ino &&
    metadata.nlink === expected.nlink &&
    metadata.size === expected.size &&
    metadata.mode === expected.rawMode &&
    metadata.mtimeNs === expected.mtimeNs &&
    metadata.ctimeNs === expected.ctimeNs
  );
}

function copyPinnedFile(source: string, destination: string, expected: ManifestEntry, faults?: ProvisionFaults): void {
  const relativePath = expected.relativePath;
  faults?.beforeSourceOpen?.(relativePath);
  const sourceFd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destinationFd: number | undefined;
  try {
    const before = fstatSync(sourceFd, { bigint: true });
    if (!metadataMatchesManifest(before, expected)) {
      throw new ProvisionError("COPY_FAILED", "Pinned source no longer matches the inspected file identity");
    }
    faults?.afterSourceOpen?.(relativePath);
    let cloned = false;
    if (process.platform === "linux" && leafExists(`/proc/self/fd/${sourceFd}`)) {
      try {
        copyFileSync(
          `/proc/self/fd/${sourceFd}`,
          destination,
          constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE
        );
        cloned = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!new Set(["EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EXDEV"]).has(code ?? "")) throw error;
        if (leafExists(destination)) unlinkSync(destination);
      }
    }
    if (!cloned) {
      destinationFd = openSync(
        destination,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      const buffer = Buffer.allocUnsafe(128 * 1024);
      for (;;) {
        const count = readSync(sourceFd, buffer, 0, buffer.length, null);
        if (count === 0) break;
        let offset = 0;
        while (offset < count) {
          const written = writeSync(destinationFd, buffer, offset, count - offset);
          if (written === 0) throw new ProvisionError("COPY_FAILED", "Copy made no forward progress");
          offset += written;
        }
      }
    } else {
      destinationFd = openSync(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
    }
    faults?.afterFileCopy?.(relativePath);
    const after = fstatSync(sourceFd, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.nlink !== after.nlink ||
      before.size !== after.size ||
      before.mode !== after.mode ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new ProvisionError("COPY_FAILED", "Source file changed while it was being copied");
    }
    fchmodSync(destinationFd, expected.mode & ORDINARY_MODE);
    const copied = fstatSync(destinationFd, { bigint: true });
    if ((copied.dev === before.dev && copied.ino === before.ino) || copied.nlink !== 1n || copied.size !== before.size) {
      throw new ProvisionError("COPY_FAILED", "Copied file identity or link count is unsafe");
    }
  } finally {
    if (destinationFd !== undefined) closeSync(destinationFd);
    closeSync(sourceFd);
  }
}

function copyManifest(inspected: InspectedSpec, staging: string, faults?: ProvisionFaults): void {
  for (const entry of inspected.entries) {
    const source = entry.relativePath ? join(inspected.source, ...entry.relativePath.split("/")) : inspected.source;
    const destination = entry.relativePath ? join(staging, ...entry.relativePath.split("/")) : staging;
    if (entry.kind === "directory") {
      // Keep staging writable until all descendants exist, then restore source modes bottom-up.
      mkdirSync(destination, { mode: 0o700 });
    } else if (entry.kind === "file") {
      copyPinnedFile(source, destination, entry, faults);
    } else {
      symlinkSync(entry.linkTarget!, destination);
    }
  }

  for (const entry of [...inspected.entries].reverse()) {
    if (entry.kind !== "directory") continue;
    const destination = entry.relativePath ? join(staging, ...entry.relativePath.split("/")) : staging;
    chmodSync(destination, entry.mode & ORDINARY_MODE);
  }

  for (const entry of inspected.entries.filter((candidate) => candidate.kind === "symlink")) {
    const stagedLink = join(staging, ...entry.relativePath.split("/"));
    const lexicalTarget = resolve(dirname(stagedLink), entry.linkTarget!);
    if (!isContained(staging, lexicalTarget)) {
      throw new ProvisionError("UNSAFE_SYMLINK", "Staged symlink lexically escapes staging");
    }
    let physicalTarget: string;
    try {
      physicalTarget = realpathSync.native(stagedLink);
    } catch {
      throw new ProvisionError("UNSAFE_SYMLINK", "Staged symlink is dangling or cyclic");
    }
    if (!isContained(staging, physicalTarget)) {
      throw new ProvisionError("UNSAFE_SYMLINK", "Staged symlink physically escapes staging");
    }
  }

  // Rewalk the complete staged tree rather than trusting the copy loop. This proves shape, kinds,
  // ordinary modes, bytes/link targets, unique target links, and inode separation for every file.
  const stagedEntries = buildManifest(staging);
  if (stagedEntries.length !== inspected.entries.length) {
    throw new ProvisionError("COPY_FAILED", "Staged tree shape differs from the inspected source");
  }
  for (let index = 0; index < inspected.entries.length; index += 1) {
    const sourceEntry = inspected.entries[index];
    const stagedEntry = stagedEntries[index];
    if (
      sourceEntry.relativePath !== stagedEntry.relativePath ||
      sourceEntry.kind !== stagedEntry.kind ||
      sourceEntry.mode !== stagedEntry.mode ||
      (sourceEntry.kind === "file" && sourceEntry.size !== stagedEntry.size) ||
      (sourceEntry.kind === "symlink" && sourceEntry.linkTarget !== stagedEntry.linkTarget) ||
      (sourceEntry.kind === "file" && sourceEntry.dev === stagedEntry.dev && sourceEntry.ino === stagedEntry.ino) ||
      (stagedEntry.kind === "file" && stagedEntry.nlink !== 1n)
    ) {
      throw new ProvisionError("COPY_FAILED", "Staged tree does not safely match the inspected source");
    }
  }

  // Some hardened hosts refuse cross-parent renames of a non-writable directory. The final root
  // mode was proven above; keep only the staging root private/writable for publication and restore
  // its recorded mode immediately after the rename. Descendant modes remain final throughout.
  chmodSync(staging, 0o700);

  const after = buildManifest(inspected.source);
  if (!sameManifest(inspected.entries, after)) {
    throw new ProvisionError("COPY_FAILED", "Source tree changed while it was being copied");
  }
}

function reconcile(destination: string, staging: string, backup: string, modeMarker: string): void {
  try {
    const destinationExists = leafExists(destination);
    const stagingExists = leafExists(staging);
    const backupExists = leafExists(backup);
    const savedMode = readModeMarker(modeMarker);
    if (destinationExists) {
      if (backupExists) {
        // Delete the marker first. If backup cleanup then fails, the next retry still sees
        // destination+backup and safely lets the already-published destination win.
        if (leafExists(modeMarker)) unlinkSync(modeMarker);
        removeEntry(backup);
      } else {
        // A crash after recording/chmodding the old root but before its rename leaves the old
        // destination in place. Put its exact ordinary mode back before retrying.
        restoreRealDirectoryMode(destination, savedMode);
      }
      if (stagingExists) removeEntry(staging);
      if (leafExists(modeMarker)) unlinkSync(modeMarker);
      return;
    }
    if (backupExists) {
      const backupMode = savedMode ?? (lstatSync(backup).isDirectory() ? lstatSync(backup).mode & ORDINARY_MODE : undefined);
      if (lstatSync(backup).isDirectory() && !lstatSync(backup).isSymbolicLink()) chmodSync(backup, 0o700);
      renameSync(backup, destination);
      restoreRealDirectoryMode(destination, backupMode);
      if (stagingExists) removeEntry(staging);
      if (leafExists(modeMarker)) unlinkSync(modeMarker);
      return;
    }
    if (stagingExists) removeEntry(staging);
    if (leafExists(modeMarker)) unlinkSync(modeMarker);
  } catch {
    throw new ProvisionError("RECOVERY_REQUIRED", "Could not reconcile an interrupted provisioning transaction");
  }
}

function restoreAfterPublishFailure(
  destination: string,
  staging: string,
  backup: string,
  modeMarker: string,
  oldDestinationMode: number | undefined,
  movedOldDestination: boolean,
  publishedNewDestination: boolean
): void {
  try {
    if (publishedNewDestination && leafExists(destination)) removeEntry(destination);
    if (movedOldDestination) {
      if (!leafExists(backup)) throw new Error("backup is missing");
      if (lstatSync(backup).isDirectory() && !lstatSync(backup).isSymbolicLink()) chmodSync(backup, 0o700);
      renameSync(backup, destination);
    }
    restoreRealDirectoryMode(destination, oldDestinationMode);
    if (leafExists(staging)) removeEntry(staging);
    if (leafExists(modeMarker)) unlinkSync(modeMarker);
  } catch {
    throw new ProvisionError("RECOVERY_REQUIRED", "Publishing failed and the previous destination could not be restored");
  }
}

export function provisionWorktree(request: ProvisionRequest): ProvisionResult {
  if (request.specs.length === 0) {
    return { ok: true, disabled: true, changed: false, issues: [], provisioned: [] };
  }

  const plan = inspectPlan(request);
  if (plan.issues.length > 0) {
    return { ok: false, disabled: false, changed: false, issues: plan.issues, provisioned: [] };
  }

  let targetRoot: string;
  let transactionRoot: string;
  let transactionDevice: number;
  let targetIdentity: DirectoryIdentity;
  let transactionIdentity: DirectoryIdentity;
  try {
    const sourceRoot = physicalDirectory(request.sourceRoot, "UNSAFE_SOURCE");
    targetRoot = physicalDirectory(request.targetRoot, "UNSAFE_TARGET");
    transactionRoot = physicalDirectory(request.transactionRoot, "UNSAFE_TARGET");
    targetIdentity = directoryIdentity(targetRoot, "UNSAFE_TARGET");
    transactionIdentity = directoryIdentity(transactionRoot, "UNSAFE_TARGET");
    if (rootsOverlap(sourceRoot, targetRoot) || rootsOverlap(sourceRoot, transactionRoot) || rootsOverlap(targetRoot, transactionRoot)) {
      throw new ProvisionError("UNSAFE_TARGET", "Source, target, and transaction roots must be pairwise disjoint");
    }
    const transactionMetadata = statSync(transactionRoot);
    transactionDevice = transactionMetadata.dev;
    if ((transactionMetadata.mode & 0o077) !== 0) {
      throw new ProvisionError("UNSAFE_TARGET", "Transaction root must be private (0700 or stricter)");
    }
    if (typeof process.getuid === "function" && transactionMetadata.uid !== process.getuid()) {
      throw new ProvisionError("UNSAFE_TARGET", "Transaction root must be owned by the current user");
    }
    if (statSync(targetRoot).dev !== transactionMetadata.dev) {
      throw new ProvisionError("UNSAFE_TARGET", "Target and transaction roots must be on the same filesystem");
    }
  } catch (error) {
    return { ok: false, disabled: false, changed: false, issues: [issue(error, "UNSAFE_TARGET")], provisioned: [] };
  }


  // Validate every target parent and deterministic transaction slot before publishing the first
  // spec. A later planted link must not turn a complete-plan refusal into a partial publication.
  for (const inspected of plan.inspected) {
    const parent = dirname(inspected.spec.path) === "." ? "" : dirname(inspected.spec.path).replaceAll(sep, "/");
    const slot = join(transactionRoot, createHash("sha256").update(inspected.spec.path).digest("hex"));
    try {
      assertSafeExistingTargetParent(targetRoot, parent);
      if (leafExists(slot)) {
        const metadata = lstatSync(slot);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw new ProvisionError("RECOVERY_REQUIRED", "Transaction slot is not a real directory");
        }
      }
    } catch (error) {
      return {
        ok: false,
        disabled: false,
        changed: false,
        issues: [issue(error, "UNSAFE_TARGET", `${inspected.index}.path`)],
        provisioned: []
      };
    }
  }

  const provisioned: ProvisionEntrySummary[] = [];
  let changed = false;
  for (const inspected of plan.inspected) {
    const specPath = inspected.spec.path;
    const destinationParentRelative = dirname(specPath) === "." ? "" : dirname(specPath).replaceAll(sep, "/");
    let destinationParent: string;
    let destinationParentIdentity: DirectoryIdentity;
    try {
      destinationParent = ensureRealDirectories(targetRoot, destinationParentRelative);
      destinationParentIdentity = directoryIdentity(destinationParent, "UNSAFE_TARGET");
      if (statSync(destinationParent).dev !== transactionDevice) {
        throw new ProvisionError("UNSAFE_TARGET", "Target publication parent and transaction root must be on the same filesystem");
      }
    } catch (error) {
      return { ok: false, disabled: false, changed, issues: [issue(error, "UNSAFE_TARGET", `${inspected.index}.path`)], provisioned };
    }
    const destination = join(targetRoot, ...specPath.split("/"));
    if (!isContained(targetRoot, destination) || dirname(destination) !== destinationParent) {
      return {
        ok: false,
        disabled: false,
        changed,
        issues: [{ code: "UNSAFE_TARGET", path: `${inspected.index}.path`, message: "Destination is not contained in target root" }],
        provisioned
      };
    }
    const slotName = createHash("sha256").update(specPath).digest("hex");
    const slot = join(transactionRoot, slotName);
    try {
      if (leafExists(slot)) {
        const metadata = lstatSync(slot);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw new ProvisionError("RECOVERY_REQUIRED", "Transaction slot is not a real directory");
        }
      } else {
        mkdirSync(slot, { mode: 0o700 });
      }
      chmodSync(slot, 0o700);
      const slotIdentity = directoryIdentity(slot, "RECOVERY_REQUIRED");
      const staging = join(slot, "staging");
      const backup = join(slot, "backup");
      const modeMarker = join(slot, "backup.mode");
      reconcile(destination, staging, backup, modeMarker);

      try {
        copyManifest(inspected, staging, request.faults);
      } catch (error) {
        if (leafExists(staging)) removeEntry(staging);
        throw error instanceof ProvisionError
          ? error
          : new ProvisionError("COPY_FAILED", error instanceof Error ? error.message : String(error));
      }

      let hadDestination = false;
      let oldDestinationMode: number | undefined;
      let movedOldDestination = false;
      let publishedNewDestination = false;
      try {
        request.faults?.beforePublish?.(specPath);
        assertDirectoryIdentity(targetRoot, targetIdentity, "UNSAFE_TARGET");
        assertDirectoryIdentity(transactionRoot, transactionIdentity, "RECOVERY_REQUIRED");
        assertDirectoryIdentity(destinationParent, destinationParentIdentity, "UNSAFE_TARGET");
        assertDirectoryIdentity(slot, slotIdentity, "RECOVERY_REQUIRED");
        hadDestination = leafExists(destination);
        if (hadDestination) {
          oldDestinationMode = prepareReadOnlyDirectoryMove(destination, modeMarker);
          renameSync(destination, backup);
          movedOldDestination = true;
        }
        request.faults?.afterBackup?.(specPath);
        renameSync(staging, destination);
        publishedNewDestination = true;
        chmodSync(destination, inspected.entries[0].mode & ORDINARY_MODE);
      } catch (error) {
        restoreAfterPublishFailure(
          destination,
          staging,
          backup,
          modeMarker,
          oldDestinationMode,
          movedOldDestination,
          publishedNewDestination
        );
        throw new ProvisionError("PUBLISH_FAILED", error instanceof Error ? error.message : String(error));
      }
      try {
        if (leafExists(modeMarker)) unlinkSync(modeMarker);
        if (leafExists(backup)) removeEntry(backup);
      } catch {
        throw new ProvisionError("RECOVERY_REQUIRED", "Published destination is complete but its backup could not be removed");
      }
      provisioned.push(inspected.summary);
      changed = true;
    } catch (error) {
      const fallback: IssueCode = error instanceof ProvisionError ? error.code : "COPY_FAILED";
      return {
        ok: false,
        disabled: false,
        changed,
        issues: [issue(error, fallback, `${inspected.index}.path`)],
        provisioned
      };
    }
  }

  return { ok: true, disabled: false, changed, issues: [], provisioned };
}

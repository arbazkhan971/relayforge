import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats
} from "node:fs";
import { isAbsolute, join, sep } from "node:path";

export const TRANSCRIPT_SOURCE_LIMITS = Object.freeze({
  maximumRelativePathBytes: 1_024,
  maximumPathComponents: 16,
  maximumComponentBytes: 255,
  maximumSourceBytes: 64 * 1024 * 1024,
  maximumReadBytes: 1024 * 1024,
  hashChunkBytes: 64 * 1024
});

const O_CLOEXEC = (constants as unknown as Readonly<{ O_CLOEXEC?: number }>).O_CLOEXEC ?? 0;

export type TranscriptSourceErrorCode =
  | "INVALID_ROOT"
  | "INVALID_PATH"
  | "UNSAFE_COMPONENT"
  | "UNSAFE_SOURCE"
  | "SOURCE_TOO_LARGE"
  | "SOURCE_REPLACED"
  | "SOURCE_MUTATED"
  | "SOURCE_CLOSED"
  | "READ_FAILED";

export class TranscriptSourceError extends Error {
  constructor(readonly code: TranscriptSourceErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "TranscriptSourceError";
  }
}

export type TranscriptSourceIdentityV1 = Readonly<{
  schemaVersion: 1;
  sourceId: string;
  device: string;
  inode: string;
  ownerUid: number;
  ordinaryMode: number;
  linkCount: number;
  birthTimeNs: string;
}>;

export type TranscriptSourcePathState = "current" | "replaced" | "missing" | "unsafe";

function effectiveUid(): number {
  return typeof process.geteuid === "function" ? process.geteuid() : (typeof process.getuid === "function" ? process.getuid() : 0);
}

function ordinaryMode(stat: BigIntStats): number {
  return Number(stat.mode & 0o7777n);
}

function stableIdentity(stat: BigIntStats): TranscriptSourceIdentityV1 {
  const material = [stat.dev, stat.ino, stat.uid, stat.mode & 0o7777n, stat.nlink, stat.birthtimeNs].map(String).join("\0");
  return Object.freeze({
    schemaVersion: 1,
    sourceId: createHash("sha256").update("relayforge-transcript-source-v1\0", "utf8").update(material, "utf8").digest("hex"),
    device: stat.dev.toString(10),
    inode: stat.ino.toString(10),
    ownerUid: Number(stat.uid),
    ordinaryMode: ordinaryMode(stat),
    linkCount: Number(stat.nlink),
    birthTimeNs: stat.birthtimeNs.toString(10)
  });
}

function sameIdentity(stat: BigIntStats, identity: TranscriptSourceIdentityV1): boolean {
  return stat.dev.toString(10) === identity.device &&
    stat.ino.toString(10) === identity.inode &&
    Number(stat.uid) === identity.ownerUid &&
    Number(stat.nlink) === identity.linkCount &&
    stat.birthtimeNs.toString(10) === identity.birthTimeNs;
}

function safeOwnedDirectory(stat: BigIntStats, uid: number): boolean {
  return stat.isDirectory() && Number(stat.uid) === uid && (ordinaryMode(stat) & 0o022) === 0;
}

function validateRelativePath(value: string): readonly string[] {
  if (
    typeof value !== "string" || value.length === 0 || isAbsolute(value) || value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > TRANSCRIPT_SOURCE_LIMITS.maximumRelativePathBytes
  ) throw new TranscriptSourceError("INVALID_PATH", "transcript path must be a bounded relative path");
  const components = value.split(/[\\/]/u);
  if (
    components.length < 1 || components.length > TRANSCRIPT_SOURCE_LIMITS.maximumPathComponents ||
    components.some((part) => part.length === 0 || part === "." || part === ".." || Buffer.byteLength(part, "utf8") > TRANSCRIPT_SOURCE_LIMITS.maximumComponentBytes)
  ) throw new TranscriptSourceError("INVALID_PATH", "transcript path has an unsafe component");
  return Object.freeze(components);
}

function assertSourceStat(stat: BigIntStats, uid: number): void {
  if (!stat.isFile() || Number(stat.uid) !== uid || Number(stat.nlink) !== 1 || (ordinaryMode(stat) & 0o022) !== 0) {
    throw new TranscriptSourceError("UNSAFE_SOURCE", "transcript must be a private, singly-linked regular file owned by the effective user");
  }
  if (stat.size < 0 || stat.size > BigInt(TRANSCRIPT_SOURCE_LIMITS.maximumSourceBytes)) {
    throw new TranscriptSourceError("SOURCE_TOO_LARGE", "transcript exceeds the configured source byte cap");
  }
}

export class PinnedTranscriptSource {
  readonly identity: TranscriptSourceIdentityV1;
  readonly maximumSourceBytes: number;
  readonly openedSize: number;
  private closed = false;

  constructor(
    private readonly descriptor: number,
    private readonly canonicalPath: string,
    identity: TranscriptSourceIdentityV1,
    openedSize: number,
    maximumSourceBytes: number
  ) {
    this.identity = identity;
    this.openedSize = openedSize;
    this.maximumSourceBytes = maximumSourceBytes;
  }

  private stat(): BigIntStats {
    if (this.closed) throw new TranscriptSourceError("SOURCE_CLOSED", "transcript descriptor is closed");
    let stat: BigIntStats;
    try { stat = fstatSync(this.descriptor, { bigint: true }); }
    catch { throw new TranscriptSourceError("READ_FAILED", "transcript descriptor cannot be stated"); }
    if (!sameIdentity(stat, this.identity)) throw new TranscriptSourceError("SOURCE_REPLACED", "pinned transcript identity changed");
    assertSourceStat(stat, this.identity.ownerUid);
    if (stat.size > BigInt(this.maximumSourceBytes)) throw new TranscriptSourceError("SOURCE_TOO_LARGE", "transcript grew beyond the source byte cap");
    return stat;
  }

  size(): number { return Number(this.stat().size); }

  read(offset: number, maximumBytes: number): Buffer {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > TRANSCRIPT_SOURCE_LIMITS.maximumReadBytes) {
      throw new TranscriptSourceError("READ_FAILED", "read bounds are invalid");
    }
    const before = this.stat();
    if (BigInt(offset) > before.size) throw new TranscriptSourceError("SOURCE_MUTATED", "read cursor is beyond the transcript size");
    const count = Math.min(maximumBytes, Number(before.size) - offset);
    const bytes = Buffer.allocUnsafe(count);
    let read = 0;
    try {
      while (read < count) {
        const current = readSync(this.descriptor, bytes, read, count - read, offset + read);
        if (current === 0) break;
        read += current;
      }
    } catch {
      throw new TranscriptSourceError("READ_FAILED", "transcript read failed");
    }
    const after = this.stat();
    if (after.size < BigInt(offset + read)) throw new TranscriptSourceError("SOURCE_MUTATED", "transcript truncated during read");
    return Buffer.from(bytes.subarray(0, read));
  }

  hashPrefix(length: number): string {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.maximumSourceBytes) {
      throw new TranscriptSourceError("READ_FAILED", "prefix length is invalid");
    }
    const before = this.stat();
    if (before.size < BigInt(length)) throw new TranscriptSourceError("SOURCE_MUTATED", "committed transcript prefix was truncated");
    const hash = createHash("sha256").update("relayforge-transcript-prefix-v1\0", "utf8");
    const chunk = Buffer.allocUnsafe(Math.min(TRANSCRIPT_SOURCE_LIMITS.hashChunkBytes, Math.max(1, length)));
    let offset = 0;
    try {
      while (offset < length) {
        const wanted = Math.min(chunk.byteLength, length - offset);
        const count = readSync(this.descriptor, chunk, 0, wanted, offset);
        if (count !== wanted) throw new Error("short read");
        hash.update(chunk.subarray(0, count));
        offset += count;
      }
    } catch {
      throw new TranscriptSourceError("READ_FAILED", "transcript prefix hashing failed");
    }
    const after = this.stat();
    if (after.size < BigInt(length)) throw new TranscriptSourceError("SOURCE_MUTATED", "transcript mutated while hashing its committed prefix");
    return hash.digest("hex");
  }

  /**
   * Bind returned extension bytes to a fresh reread of the old prefix, then compare that
   * digest with an independent post-read digest of the complete new prefix.
   */
  verifyExtension(offset: number, bytes: Buffer): string {
    if (
      !Number.isSafeInteger(offset) || offset < 0 || !Buffer.isBuffer(bytes) ||
      bytes.byteLength > TRANSCRIPT_SOURCE_LIMITS.maximumReadBytes ||
      offset + bytes.byteLength > this.maximumSourceBytes
    ) throw new TranscriptSourceError("READ_FAILED", "extension verification bounds are invalid");
    const before = this.stat();
    if (before.size < BigInt(offset + bytes.byteLength)) {
      throw new TranscriptSourceError("SOURCE_MUTATED", "extension no longer exists at the verified cursor");
    }
    const expected = createHash("sha256").update("relayforge-transcript-prefix-v1\0", "utf8");
    const chunk = Buffer.allocUnsafe(Math.min(TRANSCRIPT_SOURCE_LIMITS.hashChunkBytes, Math.max(1, offset)));
    let position = 0;
    try {
      while (position < offset) {
        const wanted = Math.min(chunk.byteLength, offset - position);
        const count = readSync(this.descriptor, chunk, 0, wanted, position);
        if (count !== wanted) throw new Error("short read");
        expected.update(chunk.subarray(0, count));
        position += count;
      }
    } catch {
      throw new TranscriptSourceError("READ_FAILED", "committed prefix reread failed");
    }
    expected.update(bytes);
    const expectedDigest = expected.digest("hex");
    const actualDigest = this.hashPrefix(offset + bytes.byteLength);
    if (actualDigest !== expectedDigest) {
      throw new TranscriptSourceError("SOURCE_MUTATED", "transcript changed during the verified read window");
    }
    return actualDigest;
  }

  pathState(): TranscriptSourcePathState {
    if (this.closed) throw new TranscriptSourceError("SOURCE_CLOSED", "transcript descriptor is closed");
    try {
      const stat = lstatSync(this.canonicalPath, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isFile()) return "unsafe";
      return sameIdentity(stat, this.identity) ? "current" : "replaced";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unsafe";
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.descriptor);
  }
}

export type OpenTranscriptSourceOptions = Readonly<{
  root: string;
  relativePath: string;
  expectedOwnerUid?: number;
  maximumSourceBytes?: number;
  expectedSourceId?: string;
}>;

export function openTranscriptSource(options: OpenTranscriptSourceOptions): PinnedTranscriptSource {
  if (!isAbsolute(options.root)) throw new TranscriptSourceError("INVALID_ROOT", "source root must be absolute");
  let root: string;
  try { root = realpathSync(options.root); }
  catch { throw new TranscriptSourceError("INVALID_ROOT", "source root does not exist"); }
  if (root !== options.root) throw new TranscriptSourceError("INVALID_ROOT", "source root must already be canonical");
  const uid = options.expectedOwnerUid ?? effectiveUid();
  if (!Number.isSafeInteger(uid) || uid < 0) throw new TranscriptSourceError("INVALID_ROOT", "expected source owner is invalid");
  const maximum = options.maximumSourceBytes ?? TRANSCRIPT_SOURCE_LIMITS.maximumSourceBytes;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > TRANSCRIPT_SOURCE_LIMITS.maximumSourceBytes) {
    throw new TranscriptSourceError("INVALID_ROOT", "source size limit is invalid");
  }
  const rootStat = lstatSync(root, { bigint: true });
  if (!safeOwnedDirectory(rootStat, uid)) throw new TranscriptSourceError("INVALID_ROOT", "source root must be a private owned directory");
  const components = validateRelativePath(options.relativePath);
  let current = root;
  for (const component of components.slice(0, -1)) {
    current = join(current, component);
    let stat: BigIntStats;
    try { stat = lstatSync(current, { bigint: true }); }
    catch { throw new TranscriptSourceError("UNSAFE_COMPONENT", "transcript parent component is unavailable"); }
    if (stat.isSymbolicLink() || !safeOwnedDirectory(stat, uid)) {
      throw new TranscriptSourceError("UNSAFE_COMPONENT", "transcript parent component is not a private owned directory");
    }
  }
  const path = join(root, ...components);
  if (!path.startsWith(`${root}${sep}`)) throw new TranscriptSourceError("INVALID_PATH", "transcript path escaped its source root");
  let descriptor: number;
  try { descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | O_CLOEXEC); }
  catch { throw new TranscriptSourceError("UNSAFE_SOURCE", "transcript cannot be opened without following links"); }
  try {
    const stat = fstatSync(descriptor, { bigint: true });
    assertSourceStat(stat, uid);
    if (stat.size > BigInt(maximum)) throw new TranscriptSourceError("SOURCE_TOO_LARGE", "transcript exceeds the configured source byte cap");
    const identity = stableIdentity(stat);
    if (options.expectedSourceId !== undefined && identity.sourceId !== options.expectedSourceId) {
      throw new TranscriptSourceError("SOURCE_REPLACED", "transcript identity differs from the expected source");
    }
    return new PinnedTranscriptSource(descriptor, path, identity, Number(stat.size), maximum);
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

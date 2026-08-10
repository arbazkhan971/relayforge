import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { resolve } from "node:path";
import { SteeringBoundedIdSchema } from "./schema.js";

export const STEERING_PROMPT_MAX_BYTES = 16 * 1024 * 1024;
export const STEERING_PROMPT_LOCATOR_PATTERN = /^steering\/prompts\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\.prompt$/;

export type PromptArtifactIdentity = {
  readonly locator: string;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly created: boolean;
};

export class PromptArtifactError extends Error {
  constructor(
    readonly code: "INVALID_LOCATOR" | "UNSAFE_ROOT" | "ARTIFACT_EXISTS" | "ARTIFACT_MISSING" | "ARTIFACT_CHANGED" | "ARTIFACT_TOO_LARGE",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "PromptArtifactError";
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function promptArtifactLocator(attemptId: string): string {
  const id = SteeringBoundedIdSchema.parse(attemptId);
  return `steering/prompts/${id}.prompt`;
}

function selfUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function assertPrivateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new PromptArtifactError("UNSAFE_ROOT", `${path} is not a real directory`);
  const uid = selfUid();
  if (uid !== undefined && stat.uid !== uid) throw new PromptArtifactError("UNSAFE_ROOT", `${path} belongs to uid ${stat.uid}`);
  if ((stat.mode & 0o077) !== 0) chmodSync(path, 0o700);
}

function ensureArtifactDirectories(runDir: string): { root: string; prompts: string } {
  const root = resolve(runDir);
  assertPrivateDirectory(root);
  const steering = resolve(root, "steering");
  const prompts = resolve(steering, "prompts");
  for (const path of [steering, prompts]) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    assertPrivateDirectory(path);
  }
  return { root, prompts };
}

function artifactLeaf(locator: string): string {
  if (!STEERING_PROMPT_LOCATOR_PATTERN.test(locator)) {
    throw new PromptArtifactError("INVALID_LOCATOR", "prompt artifact locator is outside the closed run-relative grammar");
  }
  return locator.slice("steering/prompts/".length);
}

function inspectOpenArtifact(fd: number, expectedBytes: number, expectedSha256: string): Omit<PromptArtifactIdentity, "locator" | "path" | "created"> {
  const before = fstatSync(fd, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || (Number(before.mode) & 0o077) !== 0) {
    throw new PromptArtifactError("ARTIFACT_CHANGED", "prompt artifact is not one private regular link");
  }
  const uid = selfUid();
  if (uid !== undefined && Number(before.uid) !== uid) throw new PromptArtifactError("ARTIFACT_CHANGED", "prompt artifact ownership changed");
  if (before.size > BigInt(STEERING_PROMPT_MAX_BYTES)) throw new PromptArtifactError("ARTIFACT_TOO_LARGE", "prompt artifact exceeds its byte ceiling");
  const bytes = Buffer.alloc(Number(before.size));
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (count === 0) break;
    offset += count;
  }
  const after = fstatSync(fd, { bigint: true });
  const actualSha256 = digest(bytes.subarray(0, offset));
  if (
    offset !== expectedBytes ||
    actualSha256 !== expectedSha256 ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.nlink !== 1n
  ) {
    throw new PromptArtifactError("ARTIFACT_CHANGED", "prompt artifact bytes or identity do not match the manifest");
  }
  return { bytes: offset, sha256: actualSha256, dev: before.dev, ino: before.ino };
}

export function publishPromptArtifact(runDir: string, locator: string, content: Uint8Array): PromptArtifactIdentity {
  const bytes = Buffer.from(content);
  if (bytes.byteLength > STEERING_PROMPT_MAX_BYTES) throw new PromptArtifactError("ARTIFACT_TOO_LARGE", "prompt exceeds its byte ceiling");
  const expectedSha256 = digest(bytes);
  const { prompts } = ensureArtifactDirectories(runDir);
  const leaf = artifactLeaf(locator);
  const path = resolve(prompts, leaf);
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try {
      const existing = readVerifiedPromptArtifact(runDir, locator, bytes.byteLength, expectedSha256);
      return { ...existing, created: false };
    } catch (cause) {
      throw new PromptArtifactError("ARTIFACT_EXISTS", `prompt artifact ${locator} already exists with another identity`, { cause });
    }
  }
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new PromptArtifactError("ARTIFACT_CHANGED", "prompt artifact write made no progress");
      offset += count;
    }
    fchmodSync(fd, 0o400);
    fsyncSync(fd);
    const identity = inspectOpenArtifact(fd, bytes.byteLength, expectedSha256);
    try {
      const dfd = openSync(prompts, fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
      try { fsyncSync(dfd); } finally { closeSync(dfd); }
    } catch {
      // Directory fsync is unavailable on some supported filesystems; the content inode remains
      // fully synced and recovery treats a missing publication as blocking, never as success.
    }
    return { locator, path, ...identity, created: true };
  } finally {
    closeSync(fd);
  }
}

export function readVerifiedPromptArtifact(
  runDir: string,
  locator: string,
  expectedBytes: number,
  expectedSha256: string
): Omit<PromptArtifactIdentity, "created"> & { content: Buffer } {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > STEERING_PROMPT_MAX_BYTES || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new PromptArtifactError("ARTIFACT_CHANGED", "prompt manifest identity is invalid");
  }
  const { prompts } = ensureArtifactDirectories(runDir);
  const leaf = artifactLeaf(locator);
  const path = resolve(prompts, leaf);
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new PromptArtifactError(code === "ENOENT" ? "ARTIFACT_MISSING" : "ARTIFACT_CHANGED", `prompt artifact ${locator} cannot be opened`, { cause: error as Error });
  }
  try {
    const identity = inspectOpenArtifact(fd, expectedBytes, expectedSha256);
    const content = Buffer.alloc(expectedBytes);
    let offset = 0;
    while (offset < content.length) {
      const count = readSync(fd, content, offset, content.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== expectedBytes || digest(content) !== expectedSha256) {
      throw new PromptArtifactError("ARTIFACT_CHANGED", "prompt artifact changed during verified read");
    }
    const after = fstatSync(fd, { bigint: true });
    if (after.dev !== identity.dev || after.ino !== identity.ino || after.size !== BigInt(expectedBytes)) {
      throw new PromptArtifactError("ARTIFACT_CHANGED", "prompt artifact identity changed during verified read");
    }
    return { locator, path, ...identity, content };
  } finally {
    closeSync(fd);
  }
}

/** Remove only an artifact inode this caller exclusively created and has not published to history. */
export function removeUnboundPromptArtifact(identity: PromptArtifactIdentity): void {
  if (!identity.created) return;
  try {
    const stat = lstatSync(identity.path, { bigint: true });
    if (!stat.isSymbolicLink() && stat.isFile() && stat.dev === identity.dev && stat.ino === identity.ino && stat.nlink === 1n) {
      unlinkSync(identity.path);
    }
  } catch {
    // A failed cleanup leaves an unreferenced immutable file. Recovery may remove it after proving
    // no canonical manifest names it; never delete a changed/replaced path here.
  }
}

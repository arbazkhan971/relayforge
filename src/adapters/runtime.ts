import { createHash } from "node:crypto";
import { accessSync, closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import type { RuntimeFileEvidence } from "./types.js";

const READ_CHUNK = 1 << 20;

/** Resolve a runtime file to the content-bound identity used by both probes and pre-launch checks. */
export function inspectAdapterRuntimeFile(
  runtimeName: string,
  candidatePath: string,
  executable = false
): RuntimeFileEvidence {
  if (!runtimeName || runtimeName.length > 128 || runtimeName.includes("\0")) {
    throw new TypeError("runtimeName must be a bounded non-empty NUL-free string");
  }
  if (!candidatePath || candidatePath.length > 4096 || candidatePath.includes("\0")) {
    throw new TypeError("runtime path must be bounded and NUL-free");
  }
  const canonicalPath = realpathSync(candidatePath);
  if (executable) accessSync(canonicalPath, constants.X_OK);
  const fd = openSync(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile()) throw new TypeError(`${runtimeName} is not a regular file`);
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(READ_CHUNK);
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read <= 0) break;
      hash.update(chunk.subarray(0, read));
    }
    const identity = [
      "rf-v1",
      stat.dev.toString(),
      stat.ino.toString(),
      stat.size.toString(),
      stat.mtimeNs.toString(),
      hash.digest("hex")
    ].join(":");
    return Object.freeze({ runtimeName: runtimeName as RuntimeFileEvidence["runtimeName"], canonicalPath, identity });
  } finally {
    closeSync(fd);
  }
}

export function sameRuntimeFileEvidence(left: RuntimeFileEvidence, right: RuntimeFileEvidence): boolean {
  return left.runtimeName === right.runtimeName &&
    left.canonicalPath === right.canonicalPath &&
    left.identity === right.identity;
}

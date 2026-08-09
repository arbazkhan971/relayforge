import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
  writeSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openTranscriptSource,
  TranscriptSourceError,
  TRANSCRIPT_SOURCE_LIMITS
} from "../src/observability/source-context.js";

const created: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "relayforge-observation-source-"));
  chmodSync(value, 0o700);
  created.push(value);
  return value;
}

function file(value: string, relative = "transcript.jsonl", contents = "one\ntwo\n"): string {
  const path = join(value, relative);
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
}

afterEach(() => {
  while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true });
});

describe("pinned transcript source context", () => {
  it("pins a private regular-file identity and verifies exact extension bytes", () => {
    const value = root();
    file(value);
    const source = openTranscriptSource({ root: value, relativePath: "transcript.jsonl" });
    expect(source.identity).toMatchObject({ schemaVersion: 1, ordinaryMode: 0o600, linkCount: 1 });
    expect(source.identity.sourceId).toMatch(/^[a-f0-9]{64}$/u);
    expect(source.size()).toBe(8);
    const bytes = source.read(0, 8);
    expect(bytes.toString("utf8")).toBe("one\ntwo\n");
    expect(source.verifyExtension(0, bytes)).toBe(source.hashPrefix(8));
    expect(source.pathState()).toBe("current");
    source.close();
    source.close();
    expect(() => source.size()).toThrowError(expect.objectContaining<Partial<TranscriptSourceError>>({ code: "SOURCE_CLOSED" }));
  });

  it("keeps reading the pinned old inode after path replacement and reports replacement", () => {
    const value = root();
    const path = file(value, "transcript.jsonl", "old\n");
    const source = openTranscriptSource({ root: value, relativePath: "transcript.jsonl" });
    renameSync(path, join(value, "rotated.jsonl"));
    writeFileSync(path, "new\n", { mode: 0o600 });
    expect(source.pathState()).toBe("replaced");
    expect(source.read(0, 4).toString("utf8")).toBe("old\n");
    expect(() => openTranscriptSource({
      root: value,
      relativePath: "transcript.jsonl",
      expectedSourceId: source.identity.sourceId
    })).toThrowError(expect.objectContaining<Partial<TranscriptSourceError>>({ code: "SOURCE_REPLACED" }));
    source.close();
  });

  it("detects truncation and a same-inode committed-prefix rewrite", () => {
    const value = root();
    const path = file(value, "transcript.jsonl", "alpha\nbeta\n");
    const source = openTranscriptSource({ root: value, relativePath: "transcript.jsonl" });
    const digest = source.hashPrefix(6);
    const descriptor = openSync(path, "r+");
    writeSync(descriptor, Buffer.from("ALPHA\n"), 0, 6, 0);
    closeSync(descriptor);
    expect(source.hashPrefix(6)).not.toBe(digest);
    truncateSync(path, 3);
    expect(() => source.hashPrefix(6)).toThrowError(expect.objectContaining<Partial<TranscriptSourceError>>({ code: "SOURCE_MUTATED" }));
    source.close();
  });

  it("rejects a mutation between read and post-read extension verification", () => {
    const value = root();
    const path = file(value, "transcript.jsonl", "stable\n");
    const source = openTranscriptSource({ root: value, relativePath: "transcript.jsonl" });
    const bytes = source.read(0, 7);
    writeFileSync(path, "changed", { mode: 0o600 });
    expect(() => source.verifyExtension(0, bytes)).toThrowError(expect.objectContaining<Partial<TranscriptSourceError>>({ code: "SOURCE_MUTATED" }));
    source.close();
  });

  it("rejects symlink paths, symlink components, hard links, special files, and writable sources", () => {
    const value = root();
    const target = file(value, "target.jsonl");
    symlinkSync("target.jsonl", join(value, "link.jsonl"));
    expect(() => openTranscriptSource({ root: value, relativePath: "link.jsonl" }))
      .toThrowError(expect.objectContaining({ code: "UNSAFE_SOURCE" }));

    mkdirSync(join(value, "real"), { mode: 0o700 });
    file(join(value, "real"), "nested.jsonl");
    symlinkSync("real", join(value, "linked-dir"));
    expect(() => openTranscriptSource({ root: value, relativePath: "linked-dir/nested.jsonl" }))
      .toThrowError(expect.objectContaining({ code: "UNSAFE_COMPONENT" }));

    linkSync(target, join(value, "hard.jsonl"));
    expect(() => openTranscriptSource({ root: value, relativePath: "target.jsonl" }))
      .toThrowError(expect.objectContaining({ code: "UNSAFE_SOURCE" }));
    rmSync(join(value, "hard.jsonl"));

    chmodSync(target, 0o666);
    expect(() => openTranscriptSource({ root: value, relativePath: "target.jsonl" }))
      .toThrowError(expect.objectContaining({ code: "UNSAFE_SOURCE" }));

    if (process.platform !== "win32") {
      execFileSync("mkfifo", [join(value, "pipe")]);
      expect(() => openTranscriptSource({ root: value, relativePath: "pipe" }))
        .toThrowError(expect.objectContaining({ code: "UNSAFE_SOURCE" }));
    }
  });

  it("rejects traversal, absolute input, unsafe roots, and noncanonical roots", () => {
    const value = root();
    file(value);
    for (const relativePath of ["../transcript", "./transcript", "/absolute", "nested//file", "a/../../b"]) {
      expect(() => openTranscriptSource({ root: value, relativePath })).toThrowError(expect.objectContaining({ code: "INVALID_PATH" }));
    }
    chmodSync(value, 0o777);
    expect(() => openTranscriptSource({ root: value, relativePath: "transcript.jsonl" }))
      .toThrowError(expect.objectContaining({ code: "INVALID_ROOT" }));
  });

  it("enforces exact source and read bounds", () => {
    const value = root();
    file(value, "transcript.jsonl", "12345");
    expect(() => openTranscriptSource({ root: value, relativePath: "transcript.jsonl", maximumSourceBytes: 4 }))
      .toThrowError(expect.objectContaining({ code: "SOURCE_TOO_LARGE" }));
    const source = openTranscriptSource({ root: value, relativePath: "transcript.jsonl", maximumSourceBytes: 5 });
    expect(source.read(0, 5).toString()).toBe("12345");
    expect(() => source.read(0, TRANSCRIPT_SOURCE_LIMITS.maximumReadBytes + 1))
      .toThrowError(expect.objectContaining({ code: "READ_FAILED" }));
    expect(() => source.read(6, 1)).toThrowError(expect.objectContaining({ code: "SOURCE_MUTATED" }));
    source.close();
  });
});

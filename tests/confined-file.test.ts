import { closeSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openConfinedFileExclusive } from "../src/runtime.js";

const linux = process.platform === "linux" && existsSync("/proc/self/fd");

function base(): string {
  return mkdtempSync(join(tmpdir(), "loop-confined-"));
}

describe("race-free confined transcript file creation (wave-7 path P0)", () => {
  it.skipIf(!linux)("creates a private file under base and returns its real path", () => {
    const b = base();
    const { fd, path } = openConfinedFileExclusive(b, "transcripts", "a.jsonl");
    writeSync(fd, "hello");
    closeSync(fd);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("hello");
    expect(path.startsWith(b)).toBe(true);
  });

  it.skipIf(!linux)("REFUSES a symlinked directory component and writes NOTHING outside base (parent-swap)", () => {
    const b = base();
    const evil = mkdtempSync(join(tmpdir(), "loop-evil-"));
    // An attacker plants a symlink where the transcript directory would be, pointing outside base.
    symlinkSync(evil, join(b, "transcripts"));
    // A lstat-then-open check could be raced; the pinned-fd open rejects the symlinked component.
    expect(() => openConfinedFileExclusive(b, "transcripts", "b.jsonl")).toThrow();
    // The write never reached the attacker's directory.
    expect(readdirSync(evil)).toEqual([]);
  });

  it.skipIf(!linux)("REFUSES a symlinked LEAF and rejects unsafe components", () => {
    const b = base();
    mkdirSync(join(b, "transcripts"), { mode: 0o700 });
    const evil = mkdtempSync(join(tmpdir(), "loop-evil-"));
    symlinkSync(join(evil, "target"), join(b, "transcripts", "leaf.jsonl"));
    expect(() => openConfinedFileExclusive(b, "transcripts", "leaf.jsonl")).toThrow();
    // Traversal / absolute / empty components are rejected before any filesystem access.
    for (const bad of ["..", ".", "a/b", "", "\0x"]) {
      expect(() => openConfinedFileExclusive(b, bad, "x.jsonl")).toThrow(/unsafe path component/);
      expect(() => openConfinedFileExclusive(b, "transcripts", bad)).toThrow(/unsafe path component/);
    }
  });
});

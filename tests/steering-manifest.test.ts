import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PromptArtifactError,
  promptArtifactLocator,
  publishPromptArtifact,
  readVerifiedPromptArtifact,
  removeUnboundPromptArtifact
} from "../src/steering/prompt-manifest.js";

const roots: string[] = [];

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "relayforge-steering-artifact-"));
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("P2 immutable prompt artifacts", () => {
  it("publishes once, fsyncs private bytes, and verifies exact identity/content", () => {
    const runDir = root();
    const locator = promptArtifactLocator("attempt-1");
    const content = Buffer.from("exact prompt bytes\n");
    const first = publishPromptArtifact(runDir, locator, content);
    expect(first).toMatchObject({ locator, bytes: content.byteLength, created: true });
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    const verified = readVerifiedPromptArtifact(runDir, locator, first.bytes, first.sha256);
    expect(verified.content).toEqual(content);
    expect({ dev: verified.dev, ino: verified.ino }).toEqual({ dev: first.dev, ino: first.ino });
    const retry = publishPromptArtifact(runDir, locator, content);
    expect(retry.created).toBe(false);
    expect({ dev: retry.dev, ino: retry.ino }).toEqual({ dev: first.dev, ino: first.ino });
  });

  it("never overwrites a locator with divergent bytes and detects later mutation", () => {
    const runDir = root();
    const locator = promptArtifactLocator("attempt-1");
    const first = publishPromptArtifact(runDir, locator, Buffer.from("first"));
    expect(() => publishPromptArtifact(runDir, locator, Buffer.from("second"))).toThrowError(
      expect.objectContaining({ code: "ARTIFACT_EXISTS" })
    );
    chmodSync(first.path, 0o600);
    writeFileSync(first.path, "changed");
    expect(() => readVerifiedPromptArtifact(runDir, locator, first.bytes, first.sha256)).toThrowError(
      expect.objectContaining({ code: "ARTIFACT_CHANGED" })
    );
  });

  it("fails closed on a symlinked artifact directory and a missing artifact", () => {
    const runDir = root();
    const outside = root();
    mkdirSync(join(runDir, "steering"), { mode: 0o700 });
    symlinkSync(outside, join(runDir, "steering", "prompts"));
    expect(() => publishPromptArtifact(runDir, promptArtifactLocator("attempt-1"), Buffer.from("x"))).toThrow(PromptArtifactError);

    const clean = root();
    expect(() => readVerifiedPromptArtifact(clean, promptArtifactLocator("attempt-2"), 1, "a".repeat(64))).toThrowError(
      expect.objectContaining({ code: "ARTIFACT_MISSING" })
    );
  });

  it("removes only the exact unbound inode created by this capture", () => {
    const runDir = root();
    const artifact = publishPromptArtifact(runDir, promptArtifactLocator("attempt-1"), Buffer.from("x"));
    expect(existsSync(artifact.path)).toBe(true);
    removeUnboundPromptArtifact(artifact);
    expect(existsSync(artifact.path)).toBe(false);
    removeUnboundPromptArtifact({ ...artifact, created: false });
  });
});

import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getShippedAdapterDescriptor,
  shippedAdapterConfigSha256,
  shippedAdapterIds,
  shippedAdapterRegistry
} from "../src/adapters/bootstrap.js";
import { inspectAdapterRuntimeFile, sameRuntimeFileEvidence } from "../src/adapters/runtime.js";

describe("production adapter bootstrap", () => {
  it("constructs the exact immutable seven-adapter registry", () => {
    expect(shippedAdapterIds).toEqual(["claude", "codex", "custom", "gemini", "grok", "opencode", "pi"]);
    expect(shippedAdapterRegistry.ids).toEqual(shippedAdapterIds);
    expect(Object.isFrozen(shippedAdapterIds)).toBe(true);
    expect(() => getShippedAdapterDescriptor("foreign")).toThrow(/unknown adapter/i);
  });

  it("binds Grok's API-key-only consulted configuration without exposing it", () => {
    const keyed = shippedAdapterConfigSha256({ adapterId: "grok", environment: { XAI_API_KEY: "xai-secret" } });
    const changed = shippedAdapterConfigSha256({ adapterId: "grok", environment: { XAI_API_KEY: "other" } });
    expect(keyed).toMatch(/^[a-f0-9]{64}$/);
    expect(keyed).not.toBe(changed);
    expect(keyed).not.toContain("xai-secret");
  });

  it("binds controlled environment values deterministically without exposing them", () => {
    const a = shippedAdapterConfigSha256({ adapterId: "pi", model: "provider/model", environment: { OPENAI_API_KEY: "secret" } });
    const b = shippedAdapterConfigSha256({ adapterId: "pi", model: "provider/model", environment: { OPENAI_API_KEY: "secret" } });
    const changed = shippedAdapterConfigSha256({ adapterId: "pi", model: "provider/model", environment: { OPENAI_API_KEY: "different" } });
    expect(a).toBe(b);
    expect(a).not.toBe(changed);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).not.toContain("secret");
  });

  it("revalidates content, canonical path, and inode metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "relayforge-runtime-"));
    const file = join(dir, "adapter");
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o700);
    const first = inspectAdapterRuntimeFile("pi", file, true);
    const replay = inspectAdapterRuntimeFile("pi", file, true);
    expect(sameRuntimeFileEvidence(first, replay)).toBe(true);
    writeFileSync(file, "#!/bin/sh\nexit 1\n");
    chmodSync(file, 0o700);
    expect(sameRuntimeFileEvidence(first, inspectAdapterRuntimeFile("pi", file, true))).toBe(false);
    expect(first.identity).toContain(createHash("sha256").update("#!/bin/sh\nexit 0\n").digest("hex"));
  });
});

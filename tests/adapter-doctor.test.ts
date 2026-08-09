import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateOpenCodeProbe } from "../src/adapters/builtins/opencode.js";
import { evaluatePiProbe } from "../src/adapters/builtins/pi.js";
import { evaluateGrokProbe } from "../src/adapters/builtins/grok.js";
import { shippedAdapterConfigSha256 } from "../src/adapters/bootstrap.js";
import { RootConfigSchema } from "../src/config/schema.js";
import { runDoctor } from "../src/doctor.js";

function loaded(type: "opencode" | "pi" | "grok") {
  const rootDir = mkdtempSync(join(tmpdir(), `relayforge-doctor-${type}-`));
  const config = RootConfigSchema.parse({
    version: 1,
    projects: [{
      name: "demo",
      workingDir: ".",
      providers: { native: { type } },
      roles: [
        { name: "builder", title: "Builder", provider: "native" },
        { name: "reviewer", title: "Reviewer", provider: "native" }
      ],
      loops: [{ name: "delivery", orchestrator: "builder", reviewer: "reviewer" }]
    }]
  });
  return { loaded: { config, path: join(rootDir, "loop.config.yaml"), rootDir }, rootDir };
}

describe("native adapter doctor", () => {
  it.each(["opencode", "pi", "grok"] as const)("reports %s as truthfully unavailable without behavioral evidence", (type) => {
    const fixture = loaded(type);
    const check = runDoctor(fixture.loaded, fixture.rootDir).checks.find((item) => item.name === "adapter:native");
    expect(check).toMatchObject({ status: "warn" });
    expect(check?.detail).toContain("[behavioral-evidence-missing]");
    expect(check?.fix).toMatch(/version\/help output alone/i);
  });

  it("preserves Grok API-key-only refusal instead of claiming ambient CLI readiness", () => {
    const fixture = loaded("grok");
    const availability = evaluateGrokProbe({
      executable: {
        canonicalPath: "/usr/local/bin/grok",
        identity: "rf-v1:grok",
        version: "1.0.0",
        buildCommit: "3cd0d0cbce",
        channel: "stable"
      },
      apiKeyConfigured: false,
      probedAt: "2026-08-09T00:00:00.000Z",
      consultedConfigSha256: shippedAdapterConfigSha256({ adapterId: "grok", environment: {} })
    });
    const check = runDoctor(fixture.loaded, fixture.rootDir, undefined, { native: availability }).checks.find(
      (item) => item.name === "adapter:native"
    );
    expect(check?.detail).toContain("[auth-required]");
    expect(check?.fix).toContain("authentication");
  });

  it("preserves the exact evaluator reason and missing-evidence kinds", () => {
    const fixture = loaded("opencode");
    const consultedConfigSha256 = shippedAdapterConfigSha256({ adapterId: "opencode", environment: process.env });
    const availability = evaluateOpenCodeProbe({
      probedAt: "2026-08-09T00:00:00.000Z",
      consultedConfigSha256
    });
    const check = runDoctor(fixture.loaded, fixture.rootDir, undefined, { native: availability }).checks.find(
      (item) => item.name === "adapter:native"
    );
    expect(check).toMatchObject({ status: "warn" });
    expect(check?.detail).toContain("[executable-missing]");
    expect(check?.fix).toContain("executable-identity");
  });

  it("never upgrades Pi version absence into RPC readiness", () => {
    const fixture = loaded("pi");
    const availability = evaluatePiProbe({
      probedAt: "2026-08-09T00:00:00.000Z",
      consultedConfigSha256: shippedAdapterConfigSha256({ adapterId: "pi", environment: process.env })
    });
    const check = runDoctor(fixture.loaded, fixture.rootDir, undefined, { native: availability }).checks.find(
      (item) => item.name === "adapter:native"
    );
    expect(check?.detail).toContain("[executable-missing]");
  });
});

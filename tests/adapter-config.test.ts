import { describe, expect, it } from "vitest";
import { ProviderSchema, type ProjectConfig } from "../src/config/schema.js";
import { validateProjectSemantics } from "../src/config/validate.js";

describe("native adapter configuration", () => {
  it.each(["opencode", "pi", "grok"] as const)("accepts the closed %s selector", (type) => {
    expect(ProviderSchema.parse({ type })).toMatchObject({ type, args: [], env: {}, promptMode: "interactive" });
  });

  it.each(["opencode", "pi", "grok"] as const)("rejects raw %s launch/transport controls", (type) => {
    for (const value of [
      { type, command: "/tmp/fake" },
      { type, args: ["--mode", "text"] },
      { type, env: { PATH: "/tmp" } },
      { type, promptMode: "stdin" },
      { type, dangerouslySkipPermissions: true },
      { type, fallbackFor: "other" }
    ]) expect(ProviderSchema.safeParse(value).success).toBe(false);
  });

  it("permits only API-key auth and controlled model selection for Grok", () => {
    expect(ProviderSchema.safeParse({ type: "grok", auth: { mode: "api-key", env: "XAI_API_KEY" } }).success).toBe(true);
    expect(ProviderSchema.safeParse({ type: "grok", model: "grok-4.5" }).success).toBe(true);
    for (const env of ["GROK_HOME", "GROK_TELEMETRY_ENABLED", "OPENAI_API_KEY", "XAI_BASE_URL", "LD_PRELOAD"]) {
      expect(ProviderSchema.safeParse({ type: "grok", auth: { env } }).success).toBe(false);
    }
  });

  it("never admits Grok yolo/always-approve through config", () => {
    expect(ProviderSchema.safeParse({ type: "grok", yolo: true }).success).toBe(false);
    for (const args of [["--yolo"], ["--always-approve"]]) {
      expect(ProviderSchema.safeParse({ type: "grok", args }).success).toBe(false);
    }
  });

  it("reports the native Grok approval bypass by its actual forbidden flags, never as Codex", () => {
    const base = {
      name: "demo",
      brief: "brief.md",
      workingDir: ".",
      intelligence: "PROJECT-INTELLIGENCE.md",
      safetyMode: "workspace-write",
      repositories: [],
      roles: [{ name: "builder", title: "Builder", provider: "native", repositories: [] }],
      loops: [],
      providers: {
        native: { ...ProviderSchema.parse({ type: "grok" }), yolo: true }
      }
    } as ProjectConfig;
    const issue = validateProjectSemantics(base).find((candidate) => candidate.path.endsWith("providers.native.yolo"));
    expect(issue?.message).toContain("Grok `--yolo`/`--always-approve`");
    expect(issue?.message).not.toContain("Codex");
  });

  it("allows only descriptor-closed Pi authentication environment names", () => {
    expect(ProviderSchema.safeParse({ type: "pi", auth: { env: "OPENAI_API_KEY" } }).success).toBe(true);
    expect(ProviderSchema.safeParse({ type: "pi", auth: { env: "OPENAI_BASE_URL" } }).success).toBe(false);
    expect(ProviderSchema.safeParse({ type: "pi", auth: { env: "LD_PRELOAD" } }).success).toBe(false);
    expect(ProviderSchema.safeParse({ type: "opencode", auth: { env: "OPENAI_API_KEY" } }).success).toBe(false);
  });

  it("enforces command, argv, model and environment bounds", () => {
    expect(ProviderSchema.safeParse({ type: "custom", command: "x".repeat(4097) }).success).toBe(false);
    expect(ProviderSchema.safeParse({ type: "custom", args: Array(129).fill("x") }).success).toBe(false);
    expect(ProviderSchema.safeParse({ type: "pi", model: "x".repeat(257) }).success).toBe(false);
    expect(ProviderSchema.safeParse({ type: "custom", env: { "BAD-NAME": "x" } }).success).toBe(false);
  });
});

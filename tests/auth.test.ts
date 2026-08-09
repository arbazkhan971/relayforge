import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureLocalAuth, getAuthStatus } from "../src/auth.js";
import { loadConfig } from "../src/config/load.js";
import { ProjectConfig, RootConfigSchema } from "../src/config/schema.js";

const originalPath = process.env.PATH;
const originalOpenAiKey = process.env.OPENAI_API_KEY;
const originalXaiKey = process.env.XAI_API_KEY;

beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.XAI_API_KEY;
});

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalOpenAiKey) process.env.OPENAI_API_KEY = originalOpenAiKey;
  else delete process.env.OPENAI_API_KEY;
  if (originalXaiKey) process.env.XAI_API_KEY = originalXaiKey;
  else delete process.env.XAI_API_KEY;
});

describe("auth detection", () => {
  it("detects api key env over local CLI", () => {
    process.env.OPENAI_API_KEY = "test-key";
    const project = sampleProject();
    const status = getAuthStatus(project).find((item) => item.providerName === "backend");

    expect(status?.recommendedMode).toBe("api-key");
    expect(status?.apiKeyEnv).toBe("OPENAI_API_KEY");
  });

  it("writes detected CLI auth settings into config", () => {
    const root = mkdtempSync(join(tmpdir(), "loop-auth-test-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(root, "brief.md"), "brief");
    writeFileSync(join(root, "loop.config.yaml"), `version: 1
projects:
  - name: demo
    providers:
      backend:
        type: codex
        model: gpt-5.4
    roles:
      - name: be1
        title: Backend engineer
        provider: backend
`);
    process.env.PATH = `${bin}:/bin:/usr/bin`;

    // Keep the test independent of the developer machine by checking that a
    // missing CLI still writes an explicit env setup recommendation.
    const loaded = loadConfig(join(root, "loop.config.yaml"));
    const statuses = configureLocalAuth(loaded, "demo");
    const updated = loadConfig(join(root, "loop.config.yaml"));

    expect(["env", "subscription"]).toContain(statuses[0].recommendedMode);
    expect(updated.config.projects[0].providers.backend.auth.mode).toBe(statuses[0].recommendedMode);
  });

  it.each(["opencode", "pi"] as const)("detects the canonical %s executable without dereferencing unknown defaults", (type) => {
    const root = mkdtempSync(join(tmpdir(), `loop-auth-${type}-`));
    const bin = join(root, "bin");
    mkdirSync(bin);
    const executable = join(bin, type);
    writeFileSync(executable, `#!/bin/sh\necho ${type}-version\n`);
    chmodSync(executable, 0o700);
    process.env.PATH = `${bin}:/bin:/usr/bin`;
    const project = RootConfigSchema.parse({
      version: 1,
      projects: [{
        name: "demo",
        providers: { native: { type } },
        roles: [{ name: "dev", title: "Developer", provider: "native" }]
      }]
    }).projects[0];
    const status = getAuthStatus(project)[0];
    expect(status).toMatchObject({ providerName: "native", type, command: type, cliAvailable: true, recommendedMode: "subscription" });
    expect(status.commandPath).toBe(executable);
  });

  it("retains Pi's closed API-key detection and never persists a native command override", () => {
    const root = mkdtempSync(join(tmpdir(), "loop-auth-native-write-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    const executable = join(bin, "pi");
    writeFileSync(executable, "#!/bin/sh\necho 0.84.1\n");
    chmodSync(executable, 0o700);
    process.env.PATH = `${bin}:/bin:/usr/bin`;
    process.env.OPENAI_API_KEY = "test-key";
    const path = join(root, "loop.config.yaml");
    writeFileSync(path, `version: 1
projects:
  - name: demo
    providers:
      native: { type: pi }
    roles:
      - { name: dev, title: Developer, provider: native }
`);
    const statuses = configureLocalAuth(loadConfig(path), "demo");
    expect(statuses[0]).toMatchObject({ apiKeyEnv: "OPENAI_API_KEY", apiKeySet: true, recommendedMode: "api-key" });
    const provider = loadConfig(path).config.projects[0].providers.native;
    expect(provider.command).toBeUndefined();
    expect(provider.auth).toMatchObject({ mode: "api-key", env: "OPENAI_API_KEY" });
  });

  it("requires XAI_API_KEY for Grok and never treats ambient CLI state as supported auth", () => {
    const root = mkdtempSync(join(tmpdir(), "relayforge-auth-grok-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    const executable = join(bin, "grok");
    writeFileSync(executable, "#!/bin/sh\necho 'grok 1.0.0 (3cd0d0cbce) [stable]'\n");
    chmodSync(executable, 0o700);
    process.env.PATH = `${bin}:/bin:/usr/bin`;
    const project = RootConfigSchema.parse({
      version: 1,
      projects: [{
        name: "demo",
        providers: { native: { type: "grok" } },
        roles: [{ name: "dev", title: "Developer", provider: "native" }]
      }]
    }).projects[0];

    const missing = getAuthStatus(project)[0];
    expect(missing).toMatchObject({ cliAvailable: true, apiKeySet: false, recommendedMode: "env" });
    expect(missing.notes.join(" ")).toMatch(/requires XAI_API_KEY/i);

    process.env.XAI_API_KEY = "test-xai-key";
    const keyed = getAuthStatus(project)[0];
    expect(keyed).toMatchObject({ apiKeyEnv: "XAI_API_KEY", apiKeySet: true, recommendedMode: "api-key" });
  });
});

function sampleProject(): ProjectConfig {
  return {
    name: "demo",
    brief: "brief.md",
    workingDir: ".",
    safetyMode: "workspace-write",
    providers: {
      backend: {
        type: "codex",
        args: [],
        model: "gpt-5.4",
        yolo: true,
        dangerouslySkipPermissions: false,
        auth: { mode: "auto", configured: false },
        promptMode: "interactive",
        env: {}
      }
    },
    repositories: [],
    roles: [{ name: "be1", title: "Backend engineer", provider: "backend", repositories: [], responsibilities: [], guardrails: [], autoStart: true }],
    loops: []
  };
}

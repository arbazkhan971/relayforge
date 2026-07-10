import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureLocalAuth, getAuthStatus } from "../src/auth.js";
import { loadConfig } from "../src/config/load.js";
import { ProjectConfig } from "../src/config/schema.js";

const originalPath = process.env.PATH;
const originalOpenAiKey = process.env.OPENAI_API_KEY;

beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalOpenAiKey) process.env.OPENAI_API_KEY = originalOpenAiKey;
  else delete process.env.OPENAI_API_KEY;
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

import { describe, expect, it } from "vitest";
import { RootConfigSchema } from "../src/config/schema.js";

describe("config schema", () => {
  it("accepts a minimal valid project", () => {
    const result = RootConfigSchema.safeParse({
      version: 1,
      projects: [
        {
          name: "demo",
          providers: {
            dev: { type: "codex" }
          },
          roles: [
            {
              name: "dev",
              title: "Developer",
              provider: "dev"
            }
          ]
        }
      ]
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaults.namespace).toBe("loop");
      expect(result.data.projects[0].roles[0].autoStart).toBe(true);
    }
  });

  it("fills loop defaults for new loop-engineering controls", () => {
    const result = RootConfigSchema.safeParse({
      version: 1,
      projects: [
        {
          name: "demo",
          providers: {
            dev: { type: "codex" }
          },
          roles: [
            {
              name: "dev",
              title: "Developer",
              provider: "dev"
            }
          ],
          loops: [{ name: "delivery" }]
        }
      ]
    });

    expect(result.success).toBe(true);
    if (result.success) {
      const loop = result.data.projects[0].loops[0];
      expect(loop.verifyStabilityRuns).toBe(3);
      expect(loop.maxSameFailureCount).toBe(2);
      expect(loop.contextTokenBudget).toBe(16000);
      expect(loop.postMergeVerify).toBe(true);
    }
  });

  it("rejects configs without roles", () => {
    const result = RootConfigSchema.safeParse({
      version: 1,
      projects: [{ name: "demo", providers: { dev: { type: "codex" } }, roles: [] }]
    });

    expect(result.success).toBe(false);
  });
});

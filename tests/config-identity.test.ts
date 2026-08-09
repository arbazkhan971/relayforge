import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigDiscoveryError,
  configCandidatesInDirectory,
  findConfig,
  loadConfig
} from "../src/config/load.js";

const roots: string[] = [];
const CONFIG = `version: 1
projects:
  - name: demo
    providers: { dev: { type: codex } }
    roles: [{ name: dev, title: Developer, provider: dev }]
`;

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "relayforge-config-identity-"));
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("RelayForge config identity", () => {
  it.each(["relayforge.config.yaml", "relayforge.config.yml", "relayforge.config.json"]) (
    "discovers the canonical family member %s",
    (basename) => {
      const dir = root();
      const path = join(dir, basename);
      writeFileSync(path, basename.endsWith(".json")
        ? JSON.stringify({ version: 1, projects: [{ name: "demo", providers: { dev: { type: "codex" } }, roles: [{ name: "dev", title: "Developer", provider: "dev" }] }] })
        : CONFIG);
      expect(findConfig(dir)).toBe(path);
      expect(loadConfig(findConfig(dir)).config.projects[0]?.name).toBe("demo");
    }
  );

  it.each(["loop.config.yaml", "loop.config.yml", "loop.config.json"])(
    "adopts legacy %s in place without copying or rewriting it",
    (basename) => {
      const dir = root();
      const path = join(dir, basename);
      const bytes = basename.endsWith(".json")
        ? `${JSON.stringify({ version: 1, projects: [{ name: "demo", providers: { dev: { type: "codex" } }, roles: [{ name: "dev", title: "Developer", provider: "dev" }] }] })}\n`
        : CONFIG;
      writeFileSync(path, bytes);
      mkdirSync(join(dir, ".loop"));
      writeFileSync(join(dir, ".loop", "durable-sentinel"), "unchanged\n");
      expect(loadConfig(path).path).toBe(path);
      expect(readFileSync(path, "utf8")).toBe(bytes);
      expect(readFileSync(join(dir, ".loop", "durable-sentinel"), "utf8")).toBe("unchanged\n");
      expect(readdirSync(dir).sort()).toEqual([".loop", basename].sort());
      expect(readdirSync(dir)).not.toContain("relayforge.config.yaml");
    }
  );

  it("fails closed on cross-family ambiguity while an explicit path remains authoritative", () => {
    const dir = root();
    const canonical = join(dir, "relayforge.config.yaml");
    const legacy = join(dir, "loop.config.yaml");
    writeFileSync(canonical, CONFIG);
    writeFileSync(legacy, CONFIG.replace("name: demo", "name: legacy"));

    expect(() => findConfig(dir)).toThrowError(expect.objectContaining<Partial<ConfigDiscoveryError>>({
      code: "CONFIG_AMBIGUOUS"
    }));
    expect(loadConfig(legacy).config.projects[0]?.name).toBe("legacy");
  });

  it("fails closed on two filenames within one family and returns immutable candidates", () => {
    const dir = root();
    writeFileSync(join(dir, "relayforge.config.yaml"), CONFIG);
    writeFileSync(join(dir, "relayforge.config.json"), JSON.stringify({ version: 1, projects: [] }));
    const candidates = configCandidatesInDirectory(dir);
    expect(Object.isFrozen(candidates)).toBe(true);
    expect(candidates).toHaveLength(2);
    expect(() => findConfig(dir)).toThrowError(expect.objectContaining({ code: "CONFIG_AMBIGUOUS" }));
  });

  it("returns a typed absence instead of guessing a filename", () => {
    expect(() => findConfig(root())).toThrowError(expect.objectContaining({ code: "CONFIG_NOT_FOUND" }));
  });
});

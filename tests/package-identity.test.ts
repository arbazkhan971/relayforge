import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  name: string;
  version: string;
  description: string;
  bin: Record<string, string>;
  engines: { node: string };
  exports: Record<string, unknown>;
  files: string[];
};
const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8")) as {
  name: string;
  version: string;
  packages: Record<string, { name?: string; version?: string; bin?: Record<string, string>; engines?: { node?: string } }>;
};

describe("RelayForge package identity", () => {
  it("binds the audited RC package name, version, engine range, and exact binary aliases", () => {
    expect(pkg).toMatchObject({
      name: "relayforge",
      version: "1.0.0-rc.1",
      engines: { node: "20.x || >=22" }
    });
    expect(pkg.description).toContain("RelayForge");
    expect(pkg.bin).toEqual({
      relayforge: "./dist/cli.js",
      loop: "./dist/cli.js",
      "loop-orchestrator": "./dist/cli.js"
    });
    expect(new Set(Object.values(pkg.bin))).toEqual(new Set(["./dist/cli.js"]));
  });

  it("keeps package-lock root identity byte-for-byte aligned", () => {
    expect(lock.name).toBe(pkg.name);
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""]).toMatchObject({
      name: pkg.name,
      version: pkg.version,
      engines: pkg.engines,
      bin: {
        relayforge: "dist/cli.js",
        loop: "dist/cli.js",
        "loop-orchestrator": "dist/cli.js"
      }
    });
  });

  it("keeps public package subpaths explicitly allowlisted", () => {
    expect(Object.keys(pkg.exports)).toEqual([
      ".",
      "./cli",
      "./observability",
      "./observability/control-store-adapter",
      "./control-room",
      "./package.json"
    ]);
    expect(pkg.files).toContain("CHANGELOG.md");
  });
});

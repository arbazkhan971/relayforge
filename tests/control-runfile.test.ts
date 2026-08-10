import { mkdtempSync, writeFileSync, chmodSync, linkSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTROL_RUNFILE_MAX_BYTES,
  controlConfigId,
  controlPaths,
  ensureControlDirectory,
  newControlRunFile,
  publishControlRunFile,
  readControlRunFile,
  removeControlRunFileIfInstance,
  UnsafeControlStateError
} from "../src/control/runfile.js";

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "rf-control-runfile-"));
  const config = resolve(root, "loop.yaml");
  writeFileSync(config, "projects: []\n", { mode: 0o600 });
  const paths = controlPaths(root, config);
  ensureControlDirectory(paths);
  const value = newControlRunFile({ configId: paths.configId, pid: process.pid, processStartToken: "linux:boot:1", port: 4318, startedAt: "2026-08-09T00:00:00.000Z" });
  return { root, config, paths, value };
}

describe("control run-file", () => {
  it("derives a stable canonical configuration identity", () => {
    const { root, config } = fixture();
    expect(controlConfigId(config, root)).toMatch(/^[0-9a-f]{64}$/);
    expect(controlConfigId(resolve(root, ".", "loop.yaml"), resolve(root, "."))).toBe(controlConfigId(config, root));
  });

  it("publishes, strictly reads, and removes only its own instance", () => {
    const { paths, value } = fixture();
    publishControlRunFile(paths.runFile, value);
    expect(readControlRunFile(paths.runFile)).toMatchObject({ kind: "present", value });
    expect(removeControlRunFileIfInstance(paths.runFile, paths.configId, "0".repeat(64))).toBe(false);
    expect(readControlRunFile(paths.runFile).kind).toBe("present");
    expect(removeControlRunFileIfInstance(paths.runFile, paths.configId, value.instanceId)).toBe(true);
    expect(readControlRunFile(paths.runFile)).toEqual({ kind: "absent" });
  });

  it.each([
    ["unknown field", (value: Record<string, unknown>) => ({ ...value, extra: true })],
    ["wrong host", (value: Record<string, unknown>) => ({ ...value, host: "0.0.0.0" })],
    ["unsafe port", (value: Record<string, unknown>) => ({ ...value, port: 0 })],
    ["noncanonical timestamp", (value: Record<string, unknown>) => ({ ...value, startedAt: "2026-08-09" })],
    ["bad token", (value: Record<string, unknown>) => ({ ...value, processStartToken: "bad token" })]
  ])("rejects %s", (_name, mutate) => {
    const { paths, value } = fixture();
    writeFileSync(paths.runFile, JSON.stringify(mutate(value)), { mode: 0o600 });
    expect(() => readControlRunFile(paths.runFile)).toThrow(UnsafeControlStateError);
  });

  it("rejects an oversized leaf before allocating its claimed body", () => {
    const { paths } = fixture();
    writeFileSync(paths.runFile, Buffer.alloc(CONTROL_RUNFILE_MAX_BYTES + 1), { mode: 0o600 });
    expect(() => readControlRunFile(paths.runFile)).toThrow(/exceeds/);
  });

  it("rejects symlink, hardlink, permissive, and directory shapes", () => {
    const make = () => fixture();
    {
      const { paths } = make();
      symlinkSync("target", paths.runFile);
      expect(() => readControlRunFile(paths.runFile)).toThrow(UnsafeControlStateError);
    }
    {
      const { paths, value } = make();
      writeFileSync(paths.runFile, JSON.stringify(value), { mode: 0o600 });
      linkSync(paths.runFile, `${paths.runFile}.alias`);
      expect(() => readControlRunFile(paths.runFile)).toThrow(/hard links/);
    }
    {
      const { paths, value } = make();
      writeFileSync(paths.runFile, JSON.stringify(value), { mode: 0o644 });
      chmodSync(paths.runFile, 0o644);
      expect(() => readControlRunFile(paths.runFile)).toThrow(/not private/);
    }
    {
      const { paths } = make();
      mkdirSync(paths.runFile);
      expect(() => readControlRunFile(paths.runFile)).toThrow(/not a regular file/);
    }
  });
});

import { chmodSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { LoadedConfig } from "../src/config/load.js";
import { runControlPlaneDoctor } from "../src/doctor.js";
import type { ControlAttachment } from "../src/control/client.js";
import type { ControlRunFile } from "../src/control/protocol.js";

function loaded(): LoadedConfig {
  const rootDir = mkdtempSync(resolve(tmpdir(), "rf-control-doctor-"));
  const path = resolve(rootDir, "loop.config.yaml");
  writeFileSync(path, "version: 1\nprojects: []\n", { mode: 0o600 });
  return { rootDir, path, config: { version: 1, defaults: {} as never, projects: [] } } as LoadedConfig;
}

const runFile: ControlRunFile = {
  schemaVersion: 1,
  service: "relayforge-control",
  instanceId: "a".repeat(64),
  configId: "b".repeat(64),
  pid: 1234,
  processStartToken: "linux:123",
  host: "127.0.0.1",
  port: 4318,
  startedAt: "2026-08-09T00:00:00.000Z"
};
const attachment: ControlAttachment = {
  baseUrl: "http://127.0.0.1:4318",
  runFile,
  health: {
    schemaVersion: 1,
    service: "relayforge-control",
    instanceId: runFile.instanceId,
    configId: runFile.configId,
    pid: runFile.pid,
    status: "ok",
    startedAt: runFile.startedAt
  }
};

describe("control-plane doctor", () => {
  it("classifies a stopped service without creating any control artifacts", async () => {
    const source = loaded();
    const before = await import("node:fs").then(({ existsSync }) => existsSync(resolve(source.rootDir, ".loop")));
    const checks = await runControlPlaneDoctor(source, {
      probeLease: () => ({ state: "absent" }),
      readRunFile: () => ({ kind: "absent" }),
      inspectService: async () => ({ state: "stopped", detail: "no control service owner is active" })
    });
    const after = await import("node:fs").then(({ existsSync }) => existsSync(resolve(source.rootDir, ".loop")));
    expect(before).toBe(false);
    expect(after).toBe(false);
    expect(checks.find((check) => check.name === "serve-owner")?.status).toBe("ok");
    expect(checks.find((check) => check.name === "serve-health")?.status).toBe("warn");
    for (const check of checks) if (check.status !== "ok") expect(check.fix?.length).toBeGreaterThan(20);
  });

  it("accepts a private shared control root when this configuration is uninitialized", async () => {
    const source = loaded();
    const shared = resolve(source.rootDir, ".loop", "control");
    mkdirSync(shared, { recursive: true, mode: 0o700 });
    chmodSync(resolve(source.rootDir, ".loop"), 0o700);
    chmodSync(shared, 0o700);

    const checks = await runControlPlaneDoctor(source, {
      probeLease: () => ({ state: "absent" }),
      readRunFile: () => ({ kind: "absent" }),
      inspectService: async () => ({ state: "stopped", detail: "no control service owner is active" })
    });

    const directory = checks.find((check) => check.name === "control-dir");
    expect(directory?.status).toBe("ok");
    expect(directory?.detail).toContain("this configuration has no initialized service directory");
    expect(readdirSync(shared)).toEqual([]);
  });

  it("reports a fully handshaken owner and valid status cursor as ready", async () => {
    const checks = await runControlPlaneDoctor(loaded(), {
      probeLease: () => ({ state: "held" }),
      readRunFile: () => ({ kind: "present", value: runFile, dev: 1n, ino: 2n }),
      inspectService: async () => ({ state: "ready", attachment }),
      fetchStatus: async () => ({
        schemaVersion: 1,
        service: "relayforge-control",
        instanceId: runFile.instanceId,
        configId: runFile.configId,
        status: "ok",
        startedAt: runFile.startedAt,
        projects: []
      })
    });
    for (const name of ["control-dir", "serve-lease", "serve-runfile", "serve-owner", "serve-health", "serve-cursor"]) {
      expect(checks.find((check) => check.name === name)?.status, name).toBe("ok");
    }
  });

  it.each(["starting", "stale-runfile", "held-unhealthy", "identity-mismatch"] as const)(
    "keeps %s distinct and every non-ok result actionable",
    async (state) => {
      const inspection = state === "starting"
        ? { state, detail: "owner is publishing" } as const
        : state === "stale-runfile"
          ? { state, detail: "lease is free", runFile } as const
          : { state, detail: "identity could not be proven", runFile } as const;
      const checks = await runControlPlaneDoctor(loaded(), {
        probeLease: () => state === "stale-runfile" ? { state: "free" } : { state: "held" },
        readRunFile: () => ({ kind: "present", value: runFile, dev: 1n, ino: 2n }),
        inspectService: async () => inspection
      });
      expect(checks.find((check) => check.name === "serve-owner")?.status)
        .toBe(state === "starting" || state === "stale-runfile" ? "warn" : "fail");
      for (const check of checks) if (check.status !== "ok") expect(check.fix?.length).toBeGreaterThan(20);
    }
  );
});

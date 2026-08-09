import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { acquireControlLease, inspectControlOwner, probeControlLease } from "../src/control/lease.js";
import { controlPaths, ensureControlDirectory, newControlRunFile, publishControlRunFile } from "../src/control/runfile.js";
import { inspectProcessIncarnation, processStartToken } from "../src/control/process-identity.js";

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "rf-control-lease-"));
  const config = resolve(root, "loop.yaml");
  writeFileSync(config, "projects: []\n", { mode: 0o600 });
  const paths = controlPaths(root, config);
  const owner = newControlRunFile({ configId: paths.configId, pid: process.pid, processStartToken: processStartToken(), port: 4318, startedAt: new Date().toISOString() });
  return { root, config, paths, owner };
}

function waitForLine(child: ReturnType<typeof spawn>, prefix: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${prefix}; stdout=${stdout}`)), 10_000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      const line = stdout.split("\n").find((candidate) => candidate.startsWith(prefix));
      if (line) {
        clearTimeout(timer);
        resolvePromise(line);
      }
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { if (!stdout.includes(prefix)) { clearTimeout(timer); reject(new Error(`child exited ${String(code)} before readiness`)); } });
  });
}

function waitExit(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolvePromise) => child.once("exit", () => resolvePromise()));
}

describe("control lifetime lease", () => {
  it("allows exactly one owner and re-acquires without deleting the stable DB", () => {
    const { paths, owner } = fixture();
    const first = acquireControlLease(paths, owner);
    expect(first.acquired).toBe(true);
    if (!first.acquired) return;
    expect(probeControlLease(paths.leaseDb)).toEqual({ state: "held" });
    const second = acquireControlLease(paths, { ...owner, instanceId: "a".repeat(64) });
    expect(second).toMatchObject({ acquired: false, reason: "held" });
    first.lease.release();
    expect(existsSync(paths.leaseDb)).toBe(true);
    expect(probeControlLease(paths.leaseDb)).toEqual({ state: "free" });
    const third = acquireControlLease(paths, { ...owner, instanceId: "b".repeat(64) });
    expect(third.acquired).toBe(true);
    if (third.acquired) third.lease.release();
  });

  it("classifies stopped, starting, held, and stale-runfile without mutation", () => {
    const { paths, owner } = fixture();
    expect(inspectControlOwner(paths)).toEqual({ state: "stopped" });
    const lease = acquireControlLease(paths, owner);
    expect(lease.acquired).toBe(true);
    if (!lease.acquired) return;
    expect(inspectControlOwner(paths)).toEqual({ state: "starting" });
    publishControlRunFile(paths.runFile, owner);
    expect(inspectControlOwner(paths)).toMatchObject({ state: "held", runFile: owner });
    lease.lease.release();
    expect(inspectControlOwner(paths)).toMatchObject({ state: "stale-runfile", runFile: owner });
  });

  it("rejects a planted lease symlink without chmodding or changing its target", () => {
    const { root, paths, owner } = fixture();
    ensureControlDirectory(paths);
    const victim = resolve(root, "victim.txt");
    writeFileSync(victim, "do not touch", { mode: 0o644 });
    symlinkSync(victim, paths.leaseDb);

    expect(() => acquireControlLease(paths, owner)).toThrow();
    expect(readFileSync(victim, "utf8")).toBe("do not touch");
    expect(lstatSync(victim).mode & 0o777).toBe(0o644);
    expect(lstatSync(paths.leaseDb).isSymbolicLink()).toBe(true);
  });

  it("releases the lifetime transaction after a real SIGKILL", async () => {
    if (process.platform === "win32") return;
    const { root, config, paths, owner } = fixture();
    ensureControlDirectory(paths);
    const child = spawn(process.execPath, ["--import", "tsx", resolve(dirnameOfThisTest(), "fixtures", "control-lease-holder.ts"), root, config], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false
    });
    await waitForLine(child, "READY ");
    expect(probeControlLease(paths.leaseDb)).toEqual({ state: "held" });
    child.kill("SIGKILL");
    await waitExit(child);
    expect(probeControlLease(paths.leaseDb)).toEqual({ state: "free" });
    const successor = acquireControlLease(paths, { ...owner, instanceId: "c".repeat(64) });
    expect(successor.acquired).toBe(true);
    if (successor.acquired) successor.lease.release();
  }, 20_000);

  it("proves live process incarnation and refuses a mismatched token", () => {
    const token = processStartToken();
    expect(inspectProcessIncarnation(process.pid, token).state).toBe("alive-match");
    expect(inspectProcessIncarnation(process.pid, `${token}x`).state).toBe("alive-mismatch");
    expect(inspectProcessIncarnation(2_147_483_647, token).state).toBe("dead");
  });
});

function dirnameOfThisTest(): string {
  return resolve(fileURLToPath(new URL(".", import.meta.url)));
}

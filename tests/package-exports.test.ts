import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Node only permits self-referencing a package by name when it declares "exports",
 * so resolving "relayforge/..." from inside the repo exercises the real
 * package resolver — the same code path a consumer hits after `npm install`.
 */
function resolveFromNode(specifier: string): { ok: boolean; code: string; stderr: string } {
  try {
    const stdout = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", `import.meta.resolve(${JSON.stringify(specifier)})`],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { ok: true, code: "", stderr: stdout };
  } catch (err) {
    const stderr = String((err as { stderr?: Buffer | string }).stderr ?? "");
    const match = /ERR_[A-Z_]+/.exec(stderr);
    return { ok: false, code: match?.[0] ?? "", stderr };
  }
}

describe("package exports map", () => {
  beforeAll(() => {
    if (!existsSync(resolve(repoRoot, "dist/index.js"))) {
      execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
    }
  }, 120_000);

  it("exposes the public root API", async () => {
    expect(resolveFromNode("relayforge").ok).toBe(true);

    const mod = await import(resolve(repoRoot, "dist/index.js"));
    expect(typeof mod).toBe("object");
    expect(Object.keys(mod).length).toBeGreaterThan(0);
    expect(typeof mod.getShippedAdapterDescriptor).toBe("function");
    expect(typeof mod.parseControlStatus).toBe("function");
    expect(typeof mod.inspectControlService).toBe("function");
    expect(typeof mod.parsePublicObservation).toBe("function");
    expect(typeof mod.createControlRoomClient).toBe("function");
    expect(typeof mod.buildMultiRepositoryControlView).toBe("function");
    expect(mod.relayForgeIdentity).toMatchObject({ product: "RelayForge", packageName: "relayforge", command: "relayforge" });
    // Safe steering domain constants/helpers are part of the authority-free root.
    expect(mod.STEERING_SCHEMA_VERSION).toBe(1);
    expect(typeof mod.createSteeringCommandId).toBe("function");
    expect(typeof mod.deriveSteeringActivity).toBe("function");
    expect(typeof mod.renderSteeringBlock).toBe("function");
    for (const forbidden of [
      "runHeadlessChild",
      "runRoutedTurn",
      "runAutonomyLoop",
      "prepareRun",
      "disposePreparedRun",
      "TailBuffer",
      "ControlStore",
      "ControlStoreError",
      "openControlStore",
      "controlStoreInternals",
      "createControlServer",
      "startControlServer",
      "createControlService",
      "startControlService",
      "stopControlService",
      "ControlServiceOwnership",
      "acquireControlServiceOwnership",
      "getControlServiceStatus",
      "createParentSteeringService",
      "sendSteeringIpcRequest",
      "SteeringRepository",
      "startSteeringIpcServer",
      "steeringIpcAdmitRequest",
      "steeringIpcWithdrawRequest",
      "prepareAttemptPrompt",
      "planSteeringRecovery",
      "completeExitedSettlement",
      "createParentScmProductAuthority",
      "createParentTranscriptRuntimeAuthority",
      "createControlServiceControlRoomTransport",
      "buildProviderCommand",
      "buildHeadlessCommand",
      "opencodeAdapterDescriptor",
      "buildOpenCodeConfigOverlay",
      "buildPiInvocationArguments",
      "buildGrokInvocationArguments",
      "createMultiRepositoryRunAuthority",
      "runMultiRepositoryOrchestration"
    ]) {
      expect(mod, forbidden).not.toHaveProperty(forbidden);
    }
  });

  it("exposes the CLI entry", () => {
    expect(resolveFromNode("relayforge/cli").ok).toBe(true);
  });

  it("exposes only the approved P5 observability and read-only control-room surfaces", async () => {
    for (const specifier of [
      "relayforge/observability",
      "relayforge/observability/control-store-adapter",
      "relayforge/control-room",
    ]) {
      expect(resolveFromNode(specifier), specifier).toMatchObject({ ok: true });
    }

    const observability = await import(resolve(repoRoot, "dist/observability/index.js"));
    expect(observability).toHaveProperty("parsePublicObservation");
    expect(observability).toHaveProperty("createObservationPresentationRing");
    expect(observability).not.toHaveProperty("openTranscriptSource");
    expect(observability).not.toHaveProperty("createTranscriptIngestorState");
    expect(observability).not.toHaveProperty("createControlStoreTranscriptCommit");

    const commitAdapter = await import(resolve(repoRoot, "dist/observability/control-store-adapter.js"));
    expect(commitAdapter).toHaveProperty("createControlStoreTranscriptCommit");
    expect(commitAdapter).not.toHaveProperty("ControlStore");

    const controlRoom = await import(resolve(repoRoot, "dist/control-room/index.js"));
    expect(controlRoom).toHaveProperty("createControlRoomClient");
    expect(controlRoom).toHaveProperty("buildControlRoomSnapshot");
    expect(controlRoom).toHaveProperty("renderControlRoomHtml");
    expect(controlRoom).not.toHaveProperty("ControlStore");
    expect(controlRoom).not.toHaveProperty("appendControlEvent");
  });

  it.each([
    "relayforge/attest",
    "relayforge/ledger",
    "relayforge/settlement-kernel",
    "relayforge/dist/attest.js",
    "relayforge/dist/ledger.js",
    "relayforge/src/ledger.ts",
    "relayforge/orchestrator",
    "relayforge/money",
    "relayforge/steering",
    "relayforge/steering/ipc",
    "relayforge/dist/steering/ipc.js",
    "relayforge/observability/source-context",
    "relayforge/observability/transcript-ingestor",
    "relayforge/control-room/projection",
    "relayforge/control-room/server-adapter",
  ])("blocks the internal subpath %s", (specifier) => {
    const result = resolveFromNode(specifier);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("ERR_PACKAGE_PATH_NOT_EXPORTED");
  });

  it("keeps the bin entry runnable", () => {
    const binPath = resolve(repoRoot, "dist/cli.js");
    expect(existsSync(binPath)).toBe(true);

    const stdout = execFileSync(process.execPath, [binPath, "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(stdout).toContain("Usage:");
  });
});

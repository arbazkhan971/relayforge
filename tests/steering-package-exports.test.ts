import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const typescriptCli = resolve(repoRoot, "node_modules/typescript/lib/tsc.js");
const nodeTypeRoot = resolve(repoRoot, "node_modules/@types");

/** Safe typed/domain/read-only names the supported root intentionally promises. */
const SAFE_ROOT_STEERING_EXPORTS = [
  "STEERING_SCHEMA_VERSION",
  "STEERING_REDUCER_VERSION",
  "STEERING_PROMPT_RENDERER_VERSION",
  "steeringActivityStates",
  "createSteeringCommandId",
  "deriveSteeringActivity",
  "canCaptureSteering",
  "canAdmitSteeringForFutureAttempt",
  "renderSteeringBlock",
  "selectSteeringBoundary",
  "composeAttemptPrompt",
  "emptySteeringProjection",
  "applySteeringEvent",
  "reduceSteeringEvents",
  "restoreSteeringProjection",
  "pendingSteeringCommands",
  "parseSteeringCommand",
  "parseSteeringProjection",
  "parseSteeringTarget"
] as const;

/** Authority-bearing or mutation/transport names must stay off the public root. */
const FORBIDDEN_ROOT_STEERING_EXPORTS = [
  "SteeringRepository",
  "createParentSteeringService",
  "ParentSteeringService",
  "sendSteeringIpcRequest",
  "startSteeringIpcServer",
  "steeringIpcAdmitRequest",
  "steeringIpcWithdrawRequest",
  "prepareAttemptPrompt",
  "planSteeringRecovery",
  "reconcileAttemptRecovery",
  "completeExitedSettlement",
  "prepareDispatchAttempt",
  "publishPromptArtifact"
] as const;

function resolvePackage(specifier: string): { ok: boolean; code?: string } {
  try {
    execFileSync(
      process.execPath,
      ["--input-type=module", "-e", `import.meta.resolve(${JSON.stringify(specifier)})`],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] }
    );
    return { ok: true };
  } catch (error) {
    const stderr = String((error as { stderr?: Buffer | string }).stderr ?? "");
    return { ok: false, code: /ERR_[A-Z_]+/u.exec(stderr)?.[0] };
  }
}

describe("public steering package surface", () => {
  beforeAll(() => {
    if (!existsSync(resolve(repoRoot, "dist/index.js"))) {
      execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
    }
  }, 120_000);

  it("exports only safe typed/domain/read-only steering contracts through the supported root", async () => {
    const api = await import(resolve(repoRoot, "dist/index.js"));
    for (const name of SAFE_ROOT_STEERING_EXPORTS) {
      expect(api, `missing root export ${name}`).toHaveProperty(name);
    }
    expect(api.STEERING_SCHEMA_VERSION).toBe(1);
    expect(typeof api.createSteeringCommandId).toBe("function");
    expect(typeof api.deriveSteeringActivity).toBe("function");
    expect(typeof api.renderSteeringBlock).toBe("function");

    for (const name of FORBIDDEN_ROOT_STEERING_EXPORTS) {
      expect(api, name).not.toHaveProperty(name);
    }
  });

  it("typechecks an external consumer against safe root steering exports and rejects authority names", () => {
    expect(existsSync(typescriptCli)).toBe(true);
    const prefix = mkdtempSync(resolve(tmpdir(), "relayforge-steering-consumer-"));
    try {
      const safeProbe = resolve(prefix, "consumer.ts");
      writeFileSync(
        safeProbe,
        `import {
  STEERING_SCHEMA_VERSION,
  steeringActivityStates,
  createSteeringCommandId,
  deriveSteeringActivity,
  renderSteeringBlock,
  emptySteeringProjection
} from "relayforge";
import type { SteeringProjection, SteeringActivity } from "relayforge";
const version: typeof STEERING_SCHEMA_VERSION = STEERING_SCHEMA_VERSION;
const states: readonly string[] = steeringActivityStates;
const id: string = createSteeringCommandId();
const projection = null as unknown as SteeringProjection;
const activity = null as unknown as SteeringActivity;
void [version, states, id, projection, activity, deriveSteeringActivity, renderSteeringBlock, emptySteeringProjection];
`
      );
      const safeConfig = resolve(prefix, "tsconfig.consumer.json");
      writeFileSync(
        safeConfig,
        `${JSON.stringify(
          {
            compilerOptions: {
              target: "ES2022",
              module: "NodeNext",
              moduleResolution: "NodeNext",
              strict: true,
              noEmit: true,
              skipLibCheck: false,
              types: ["node"],
              typeRoots: [nodeTypeRoot],
              paths: {
                relayforge: [resolve(repoRoot, "dist/index.d.ts")],
                "relayforge/*": [resolve(repoRoot, "dist/*")]
              },
              baseUrl: prefix
            },
            files: [safeProbe]
          },
          null,
          2
        )}\n`
      );
      execFileSync(process.execPath, [typescriptCli, "-p", safeConfig], {
        cwd: prefix,
        stdio: ["ignore", "pipe", "pipe"]
      });

      const forbiddenProbe = resolve(prefix, "forbidden-consumer.ts");
      writeFileSync(
        forbiddenProbe,
        `import {
  createParentSteeringService,
  sendSteeringIpcRequest,
  startSteeringIpcServer,
  SteeringRepository
} from "relayforge";
void [createParentSteeringService, sendSteeringIpcRequest, startSteeringIpcServer, SteeringRepository];
`
      );
      const forbiddenConfig = resolve(prefix, "tsconfig.forbidden-consumer.json");
      writeFileSync(
        forbiddenConfig,
        `${JSON.stringify(
          {
            compilerOptions: {
              target: "ES2022",
              module: "NodeNext",
              moduleResolution: "NodeNext",
              strict: true,
              noEmit: true,
              skipLibCheck: false,
              types: ["node"],
              typeRoots: [nodeTypeRoot],
              paths: {
                relayforge: [resolve(repoRoot, "dist/index.d.ts")],
                "relayforge/*": [resolve(repoRoot, "dist/*")]
              },
              baseUrl: prefix
            },
            files: [forbiddenProbe]
          },
          null,
          2
        )}\n`
      );
      let forbiddenStdout = "";
      let forbiddenStderr = "";
      let status = 0;
      try {
        execFileSync(process.execPath, [typescriptCli, "-p", forbiddenConfig], {
          cwd: prefix,
          stdio: ["ignore", "pipe", "pipe"]
        });
      } catch (error) {
        status = (error as { status?: number }).status ?? 1;
        forbiddenStdout = String((error as { stdout?: Buffer | string }).stdout ?? "");
        forbiddenStderr = String((error as { stderr?: Buffer | string }).stderr ?? "");
      }
      const combined = `${forbiddenStdout}\n${forbiddenStderr}`;
      expect(status).not.toBe(0);
      expect(combined).toMatch(/has no exported member/u);
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });

  it.each([
    "relayforge/steering",
    "relayforge/steering/ipc",
    "relayforge/dist/steering/ipc.js",
    "relayforge/src/steering/service.ts"
  ])("keeps unsupported steering internals closed at %s", (specifier) => {
    expect(resolvePackage(specifier)).toEqual({ ok: false, code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  });
});

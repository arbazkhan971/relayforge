import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMultiRepositoryIntegrationAuthorityManager,
  type MultiRepositoryIntegrationAuthorityAcquireFaultPoint,
  type MultiRepositoryIntegrationAuthorityReleaseFaultPoint
} from "../src/multirepo/authority.js";
import type { RepositoryIdentityV1, RepositoryRegistryV1 } from "../src/multirepo/domain.js";
import { registerOwnedTemp } from "./global-teardown.js";

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repository(parent: string, repositoryId: string): RepositoryIdentityV1 {
  const root = resolve(parent, repositoryId);
  execFileSync("mkdir", ["-p", root]);
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "RelayForge Authority Test");
  git(root, "config", "user.email", "relayforge@example.invalid");
  writeFileSync(join(root, "base.txt"), `${repositoryId}\n`, { mode: 0o600 });
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  const canonicalRoot = realpathSync(root);
  const common = realpathSync(git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  const rootStat = statSync(canonicalRoot);
  const commonStat = statSync(common);
  return Object.freeze({
    schemaVersion: 1,
    repositoryId,
    canonicalRoot,
    rootDevice: rootStat.dev,
    rootInode: rootStat.ino,
    gitCommonDirDevice: commonStat.dev,
    gitCommonDirInode: commonStat.ino,
    defaultBranch: "main",
    protectedBranches: Object.freeze(["main"])
  });
}

function fixture(): Readonly<{ root: string; registry: RepositoryRegistryV1; lockDirectory(repositoryId: string): string }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "relayforge-multirepo-authority-")));
  chmodSync(root, 0o700);
  roots.push(root);
  registerOwnedTemp(root);
  const repositories = Object.freeze([repository(root, "alpha"), repository(root, "beta")]);
  return Object.freeze({
    root,
    registry: Object.freeze({ schemaVersion: 1, repositories }),
    lockDirectory(repositoryId: string) {
      const repositoryValue = repositories.find((candidate) => candidate.repositoryId === repositoryId)!;
      const common = realpathSync(git(repositoryValue.canonicalRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"));
      return resolve(common, "relayforge-integration.lock");
    }
  });
}

function fence(suffix = "one") {
  return Object.freeze({
    runId: `run-${suffix}`,
    runEpoch: `epoch-${suffix}`,
    taskId: `task-${suffix}`,
    taskGeneration: 1,
    leaseToken: suffix.repeat(64).slice(0, 64)
  });
}

const acquisitionFaultPoints = Object.freeze([
  "before-receipt-sync",
  "after-receipt-sync",
  "before-staging-directory-sync",
  "after-staging-directory-sync",
  "before-publish-rename",
  "after-publish-rename",
  "before-parent-sync",
  "after-parent-sync"
] as const satisfies readonly MultiRepositoryIntegrationAuthorityAcquireFaultPoint[]);

function waitForResult(path: string, child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    const deadline = Date.now() + 15_000;
    const inspect = (): void => {
      try {
        const value = readFileSync(path, "utf8");
        if (value.endsWith("\n")) {
          resolvePromise(value.trim());
          return;
        }
      } catch { /* the child has not published its durable result yet */ }
      if (Date.now() >= deadline) {
        reject(new Error(`timed out waiting for authority child result; stderr=${stderr}`));
        return;
      }
      setTimeout(inspect, 10);
    };
    inspect();
  });
}

function childExit(child: ReturnType<typeof spawn>): Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>> {
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise(Object.freeze({ code, signal })));
  });
}

function spawnAcquirer(value: ReturnType<typeof fixture>, mode: string, suffix: string) {
  const registryPath = resolve(value.root, "registry.json");
  if (!existsSync(registryPath)) writeFileSync(registryPath, JSON.stringify(value.registry), { mode: 0o600 });
  const resultPath = resolve(value.root, `child-${suffix}.result`);
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    resolve("tests/fixtures/multirepo-authority-acquirer.ts"),
    registryPath,
    mode,
    resultPath
  ], { stdio: ["ignore", "ignore", "pipe"] });
  return Object.freeze({ child, resultPath, exited: childExit(child) });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("production multi-repository integration authority", () => {
  it("publishes a fully synced staged claim in the reviewed durability order", async () => {
    const value = fixture();
    const observed: MultiRepositoryIntegrationAuthorityAcquireFaultPoint[] = [];
    const manager = createMultiRepositoryIntegrationAuthorityManager(value.registry, {
      acquireFault(point) { observed.push(point); }
    });
    const handle = await manager.acquire(["alpha"], fence());
    expect(observed).toEqual(acquisitionFaultPoints);
    handle.assertHeld(["alpha"]);
    await handle.release();
    manager.assertDrained();
  });

  it.each(acquisitionFaultPoints)("leaves no live-leaf wedge after a real SIGKILL at %s", async (faultPoint) => {
    if (process.platform === "win32") return;
    const value = fixture();
    const child = spawnAcquirer(value, `fault:${faultPoint}`, faultPoint);
    expect(await waitForResult(child.resultPath, child.child)).toBe(`FAULT ${faultPoint}`);
    expect(await child.exited).toMatchObject({ code: null, signal: "SIGKILL" });

    const successor = createMultiRepositoryIntegrationAuthorityManager(value.registry);
    const handle = await successor.acquire(["alpha"], fence(`successor-${faultPoint}`));
    handle.assertHeld(["alpha"]);
    const common = dirname(value.lockDirectory("alpha"));
    expect(readdirSync(common).filter((leaf) => /^relayforge-integration\.lock\.claim\.[a-f0-9]{64}$/u.test(leaf))).toHaveLength(0);
    expect(existsSync(value.lockDirectory("alpha"))).toBe(true);
    await handle.release();
    successor.assertDrained();
    expect(existsSync(value.lockDirectory("alpha"))).toBe(false);
  }, 30_000);

  it("allows exactly one concurrent real-process acquirer and reclaims it only after SIGKILL", async () => {
    if (process.platform === "win32") return;
    const value = fixture();
    const left = spawnAcquirer(value, "hold", "race-left");
    const right = spawnAcquirer(value, "hold", "race-right");
    const [leftResult, rightResult] = await Promise.all([
      waitForResult(left.resultPath, left.child),
      waitForResult(right.resultPath, right.child)
    ]);
    expect([leftResult, rightResult].filter((result) => result === "ACQUIRED")).toHaveLength(1);
    expect([leftResult, rightResult].filter((result) => result.startsWith("REFUSED INTEGRATION_AUTHORITY_UNAVAILABLE"))).toHaveLength(1);

    const winner = leftResult === "ACQUIRED" ? left : right;
    const loser = leftResult === "ACQUIRED" ? right : left;
    expect(await loser.exited).toMatchObject({ code: 73 });
    winner.child.kill("SIGKILL");
    expect(await winner.exited).toMatchObject({ code: null, signal: "SIGKILL" });

    const successor = createMultiRepositoryIntegrationAuthorityManager(value.registry);
    const handle = await successor.acquire(["alpha"], fence("after-race"));
    handle.assertHeld(["alpha"]);
    await handle.release();
    successor.assertDrained();
  }, 30_000);

  it("preserves and bypasses an exact empty legacy release tail without deleting forensic evidence", async () => {
    const value = fixture();
    const live = value.lockDirectory("alpha");
    mkdirSync(live, { mode: 0o700 });
    const before = lstatSync(live);

    const manager = createMultiRepositoryIntegrationAuthorityManager(value.registry);
    const handle = await manager.acquire(["alpha"], fence("receiptless"));
    handle.assertHeld(["alpha"]);
    const common = dirname(live);
    const archives = readdirSync(common).filter((leaf) => leaf.startsWith("relayforge-integration.lock.release-orphan."));
    expect(archives).toHaveLength(1);
    const archived = lstatSync(resolve(common, archives[0]!));
    expect([archived.dev, archived.ino]).toEqual([before.dev, before.ino]);
    await handle.release();
    manager.assertDrained();
    expect(existsSync(resolve(common, archives[0]!))).toBe(true);
  });

  it("quarantines the exact empty pre-receipt staging crash window and leaves no claim leaf", async () => {
    const value = fixture();
    const common = dirname(value.lockDirectory("alpha"));
    const nonce = "d".repeat(64);
    const claim = resolve(common, `relayforge-integration.lock.claim.${nonce}`);
    mkdirSync(claim, { mode: 0o700 });
    const before = lstatSync(claim);

    const manager = createMultiRepositoryIntegrationAuthorityManager(value.registry);
    const handle = await manager.acquire(["alpha"], fence("empty-stage"));
    handle.assertHeld(["alpha"]);
    expect(existsSync(claim)).toBe(false);
    const archived = resolve(common, `relayforge-integration.lock.abandoned-claim.${nonce}`);
    const after = lstatSync(archived);
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
    await handle.release();
    manager.assertDrained();
  });

  it("refuses and preserves a receiptless live directory with foreign contents", async () => {
    const value = fixture();
    const live = value.lockDirectory("alpha");
    mkdirSync(live, { mode: 0o700 });
    const foreign = resolve(live, "foreign-owner");
    writeFileSync(foreign, "do not guess\n", { mode: 0o600 });
    const manager = createMultiRepositoryIntegrationAuthorityManager(value.registry);

    await expect(manager.acquire(["alpha"], fence("foreign"))).rejects.toMatchObject({
      code: "INTEGRATION_AUTHORITY_UNAVAILABLE"
    });
    expect(readFileSync(foreign, "utf8")).toBe("do not guess\n");
    expect(existsSync(live)).toBe(true);
  });

  it("revalidates the full pinned receipt body as well as its inode", async () => {
    const value = fixture();
    const manager = createMultiRepositoryIntegrationAuthorityManager(value.registry);
    const handle = await manager.acquire(["alpha"], fence());
    handle.assertHeld(["alpha"]);
    const receiptPath = resolve(value.lockDirectory("alpha"), "owner.json");
    const original = readFileSync(receiptPath, "utf8");
    const changed = { ...(JSON.parse(original) as Record<string, unknown>), taskId: "task-tampered" };
    writeFileSync(receiptPath, JSON.stringify(changed), "utf8");
    expect(() => handle.assertHeld(["alpha"])).toThrow(/receipt identity\/body changed/u);
    writeFileSync(receiptPath, original, "utf8");
    handle.assertHeld(["alpha"]);
    await handle.release();
    manager.assertDrained();
  });

  it.each([
    "before-receipt-unlink",
    "after-receipt-unlink",
    "before-directory-rmdir",
    "after-directory-rmdir"
  ] as const)("retries an exact release interrupted at %s and remains idempotent", async (faultPoint) => {
    const value = fixture();
    let injected = false;
    const manager = createMultiRepositoryIntegrationAuthorityManager(value.registry, {
      releaseFault(point, repositoryId) {
        if (!injected && point === faultPoint && repositoryId === "alpha") {
          injected = true;
          throw new Error(`injected ${point}`);
        }
      }
    });
    const handle = await manager.acquire(["alpha"], fence());
    await expect(handle.release()).rejects.toThrow(`injected ${faultPoint}`);
    expect(() => manager.assertDrained()).toThrow(/remain held for recovery/u);
    if (faultPoint === "before-receipt-unlink") handle.assertHeld(["alpha"]);
    else expect(() => handle.assertHeld(["alpha"])).toThrow(/partially released/u);

    await handle.release();
    await handle.release();
    manager.assertDrained();
    expect(existsSync(value.lockDirectory("alpha"))).toBe(false);
  });

  it("retries a real rmdir failure only after the exact empty owned directory is recoverable", async () => {
    const value = fixture();
    let blocked = false;
    let blocker: string | undefined;
    const manager = createMultiRepositoryIntegrationAuthorityManager(value.registry, {
      releaseFault(point, repositoryId) {
        if (!blocked && point === "before-directory-rmdir" && repositoryId === "alpha") {
          blocked = true;
          const common = dirname(value.lockDirectory("alpha"));
          const archive = readdirSync(common).find((leaf) => leaf.startsWith("relayforge-integration.lock.release."));
          if (archive === undefined) throw new Error("release archive is absent at rmdir fault point");
          blocker = resolve(common, archive, "injected-blocker");
          writeFileSync(blocker, "blocked\n", { mode: 0o600 });
        }
      }
    });
    const handle = await manager.acquire(["alpha"], fence());
    await expect(handle.release()).rejects.toMatchObject({ code: "ENOTEMPTY" });
    expect(() => handle.assertHeld(["alpha"])).toThrow(/partially released/u);
    expect(blocker).toBeDefined();
    unlinkSync(blocker!);
    await handle.release();
    manager.assertDrained();
  });

  it("keeps unreleased members exclusive while a partial release is retried", async () => {
    const value = fixture();
    let injected = false;
    const first = createMultiRepositoryIntegrationAuthorityManager(value.registry, {
      releaseFault(point, repositoryId) {
        if (!injected && point === "after-directory-rmdir" && repositoryId === "beta") {
          injected = true;
          throw new Error("interrupt after beta release");
        }
      }
    });
    const firstHandle = await first.acquire(["alpha", "beta"], fence("first"));
    await expect(firstHandle.release()).rejects.toThrow(/interrupt after beta release/u);
    expect(() => firstHandle.assertHeld(["alpha", "beta"])).toThrow(/partially released/u);

    const successor = createMultiRepositoryIntegrationAuthorityManager(value.registry);
    await expect(successor.acquire(["alpha", "beta"], fence("successor"))).rejects.toMatchObject({
      code: "INTEGRATION_AUTHORITY_UNAVAILABLE"
    });
    const betaHandle = await successor.acquire(["beta"], fence("beta"));
    betaHandle.assertHeld(["beta"]);

    await firstHandle.release();
    first.assertDrained();
    betaHandle.assertHeld(["beta"]);
    await betaHandle.release();
    successor.assertDrained();
  });

  it("quarantines a receiptless failed acquisition rollback outside the live lock leaf", async () => {
    const value = fixture();
    const blockerManager = createMultiRepositoryIntegrationAuthorityManager(value.registry);
    const betaBlocker = await blockerManager.acquire(["beta"], fence("beta-blocker"));
    let injected = false;
    const acquiring = createMultiRepositoryIntegrationAuthorityManager(value.registry, {
      releaseFault(point, repositoryId) {
        if (!injected && point === "before-directory-rmdir" && repositoryId === "alpha") {
          injected = true;
          writeFileSync(resolve(value.lockDirectory("alpha"), "rollback-blocker"), "preserve\n", { mode: 0o600 });
        }
      }
    });

    await expect(acquiring.acquire(["alpha", "beta"], fence("aborted"))).rejects.toMatchObject({
      code: "INTEGRATION_AUTHORITY_UNAVAILABLE"
    });
    expect(existsSync(value.lockDirectory("alpha"))).toBe(false);
    const alphaCommon = realpathSync(git(value.registry.repositories[0]!.canonicalRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"));
    expect(readdirSync(alphaCommon).filter((leaf) => leaf.startsWith("relayforge-integration.lock.rollback."))).toHaveLength(1);

    const successor = createMultiRepositoryIntegrationAuthorityManager(value.registry);
    const alpha = await successor.acquire(["alpha"], fence("alpha-successor"));
    alpha.assertHeld(["alpha"]);
    await alpha.release();
    successor.assertDrained();
    await betaBlocker.release();
    blockerManager.assertDrained();
  });
});

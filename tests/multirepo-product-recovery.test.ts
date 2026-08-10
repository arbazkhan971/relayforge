import { spawn, spawnSync, execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openControlStore } from "../src/control/store.js";
import { buildMultiRepositoryControlView } from "../src/control/views.js";
import { openLedger } from "../src/ledger.js";
import { detectSandbox, verifierNetworkIsolationAvailable } from "../src/sandbox.js";
import { registerOwnedTemp } from "./global-teardown.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROVIDER = resolve(HERE, "fixtures/multirepo-product-isolation-provider.mjs");
const CLI = resolve(HERE, "../src/cli.ts");
const TSX_LOADER = fileURLToPath(import.meta.resolve("tsx"));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repository(root: string, name: string): string {
  const path = join(root, name);
  execFileSync("git", ["init", "-q", "-b", "main", path]);
  git(path, "config", "user.email", "relayforge@example.invalid");
  git(path, "config", "user.name", "RelayForge fixture");
  git(path, "config", "commit.gpgsign", "false");
  writeFileSync(join(path, ".gitignore"), ".loop/\n");
  writeFileSync(join(path, "README.md"), `# ${name}\n`);
  git(path, "add", "--all");
  git(path, "commit", "-qm", "baseline");
  git(path, "branch", "integration");
  return path;
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate a test control port");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

function configuration(root: string, port: number, gamma: string, sentinel: string): string {
  const path = join(root, "loop.config.yaml");
  const args = [PROVIDER, join(gamma, "README.md"), sentinel].map((value) => JSON.stringify(value)).join(", ");
  const verifyVector = [
    'printf "verifying %s:%s and %s:%s\\n" "$RELAYFORGE_REPO_0_ID" "$RELAYFORGE_REPO_0_PATH" "$RELAYFORGE_REPO_1_ID" "$RELAYFORGE_REPO_1_PATH"',
    'for candidate in "$RELAYFORGE_REPO_0_PATH/relayforge-p6.txt" "$RELAYFORGE_REPO_1_PATH/relayforge-p6.txt"; do if test -f "$candidate"; then printf "candidate %s=" "$candidate"; cat "$candidate"; else printf "candidate %s=MISSING\\n" "$candidate"; fi; done',
    'test "$RELAYFORGE_REPOSITORY_COUNT" = "2"',
    'test "$RELAYFORGE_REPO_0_ID" = "alpha"',
    'test "$RELAYFORGE_REPO_1_ID" = "beta"',
    'test "$(cat "$RELAYFORGE_REPO_0_PATH/relayforge-p6.txt")" = "updated:alpha"',
    'test "$(cat "$RELAYFORGE_REPO_1_PATH/relayforge-p6.txt")" = "updated:beta"'
  ].join(" && ");
  writeFileSync(path, `version: 1
defaults:
  runDir: .loop/runs
  viewport: false
  dashboardPort: ${port}
projects:
  - name: product
    workingDir: alpha
    providers:
      worker:
        type: custom
        command: ${JSON.stringify(process.execPath)}
        args: [${args}]
    repositories:
      - name: alpha
        path: alpha
        defaultBranch: main
        protectedBranches: [main]
      - name: beta
        path: beta
        defaultBranch: main
        protectedBranches: [main]
      - name: gamma
        path: gamma
        defaultBranch: main
        protectedBranches: [main]
    multiRepository:
      providerRepositories:
        worker: [alpha, beta]
      scheduler:
        global: 1
        perProvider: 1
        perRepository: 1
        perTask: 1
      tasks:
        - id: product-change
          generation: 1
          role: implementer
          provider: worker
          repositories: [alpha, beta]
          dependsOn: []
          priority: 10
          entries:
            - repository: alpha
              branch: rf-product-alpha
              targetRef: refs/heads/integration
            - repository: beta
              branch: rf-product-beta
              targetRef: refs/heads/integration
          verifyCommands:
            - ${JSON.stringify(verifyVector)}
          commitMessage: relayforge multi-repository recovery change
    roles:
      - name: implementer
        title: Implementer
        provider: worker
        repositories: [alpha, beta]
    loops:
      - name: delivery
        orchestrator: implementer
        reviewer: implementer
        maxIterations: 1
        cadenceMinutes: 1
        verify: ["true"]
`, { mode: 0o600 });
  return path;
}

type Fixture = Readonly<{
  root: string;
  alpha: string;
  beta: string;
  gamma: string;
  sentinel: string;
  config: string;
  initial: Readonly<Record<"alpha" | "beta" | "gamma", string>>;
}>;

async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "relayforge-p6-crash-product-"));
  registerOwnedTemp(root);
  const alpha = repository(root, "alpha");
  const beta = repository(root, "beta");
  const gamma = repository(root, "gamma");
  const sentinel = join(root, "host-credential-sentinel");
  writeFileSync(sentinel, "host-only-secret\n", { mode: 0o600 });
  return Object.freeze({
    root,
    alpha,
    beta,
    gamma,
    sentinel,
    config: configuration(root, await freePort(), gamma, sentinel),
    initial: Object.freeze({
      alpha: git(alpha, "rev-parse", "integration"),
      beta: git(beta, "rev-parse", "integration"),
      gamma: git(gamma, "rev-parse", "integration")
    })
  });
}

function childEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env, LOOP_TMUX: "off", RELAYFORGE_TMUX: "off" };
  delete environment.RELAYFORGE_SANDBOX;
  delete environment.LOOP_SANDBOX;
  return environment;
}

function cliArguments(value: Fixture, runId: string): string[] {
  return [
    "--import", TSX_LOADER, CLI,
    "--config", value.config,
    "--json",
    "run", "update the two authorized repositories",
    "--project", "product",
    "--run", runId,
    "--execute"
  ];
}

function receiptLeaves(runDir: string): string[] {
  const directory = join(runDir, "multirepo-runtime/worker-recovery");
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((leaf) => /^[a-f0-9]{64}\.json$/u.test(leaf));
}

async function crashAt(
  value: Fixture,
  runId: string,
  point: "settlement-before-receipt" | "receipt-before-canonical"
): Promise<Readonly<{ runDir: string; stdout: string; stderr: string }>> {
  const runDir = join(value.root, ".loop/runs/product", runId);
  const child = spawn(process.execPath, cliArguments(value, runId), {
    cwd: value.root,
    env: childEnvironment(),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const closed = once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>;
  const deadline = Date.now() + 120_000;
  let reached = false;
  while (Date.now() < deadline) {
    const ledger = join(runDir, "board/reservations.jsonl");
    const wal = join(runDir, "board/reservations.wal");
    // The journal leaf becomes authoritative only when its matching WAL commit is itself durable.
    // Killing on a visible settle line alone may strand the preceding intent, so match exact seq+hash.
    const settled = existsSync(ledger) && existsSync(wal) && (() => {
      const records = readFileSync(ledger, "utf8").split("\n").flatMap((line) => {
        try { return line ? [JSON.parse(line) as { seq?: number; hash?: string; data?: { type?: string; callId?: string; attest?: { payload?: { kind?: string } } } }] : []; }
        catch { return []; }
      });
      const record = records.find((candidate) =>
        candidate.data?.type === "settle" && candidate.data.callId?.startsWith("mr-") &&
        candidate.data.attest?.payload?.kind === "accounted-terminal"
      );
      if (!record || !Number.isSafeInteger(record.seq) || typeof record.hash !== "string") return false;
      return readFileSync(wal, "utf8").split("\n").some((line) => {
        try {
          const candidate = JSON.parse(line) as { t?: string; seq?: number; h?: string };
          return candidate.t === "commit" && candidate.seq === record.seq && candidate.h === record.hash;
        } catch { return false; }
      });
    })();
    const receipts = receiptLeaves(runDir);
    reached = point === "settlement-before-receipt"
      ? settled && receipts.length === 0
      : receipts.length === 1;
    if (reached) break;
    if (child.exitCode !== null || child.signalCode !== null) break;
    await new Promise<void>((done) => setTimeout(done, 2));
  }
  if (!reached) {
    child.kill("SIGKILL");
    await closed;
    const runLog = join(runDir, "run.jsonl");
    const logTail = existsSync(runLog) ? readFileSync(runLog, "utf8").slice(-12_000) : "<missing>";
    const logDirectory = join(runDir, "logs");
    const turnLogs = existsSync(logDirectory)
      ? readdirSync(logDirectory).map((leaf) => `${leaf}:\n${readFileSync(join(logDirectory, leaf), "utf8").slice(-4000)}`).join("\n")
      : "<missing>";
    throw new Error(`did not reach ${point}; stdout=${stdout.slice(-2000)} stderr=${stderr.slice(-4000)} runLog=${logTail} turnLogs=${turnLogs}`);
  }
  expect(child.kill("SIGKILL")).toBe(true);
  const [code, signal] = await closed;
  expect(code).toBeNull();
  expect(signal).toBe("SIGKILL");
  return Object.freeze({ runDir, stdout, stderr });
}

function assertAttestedProviderSettlement(runDir: string): void {
  const runNonce = readFileSync(join(runDir, ".loop_run_nonce"), "utf8").trim();
  const records = readFileSync(join(runDir, "board/reservations.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line) as { data?: { type?: string; callId?: string } });
  const settled = records.find((record) => record.data?.type === "settle" && record.data.callId?.startsWith("mr-"));
  expect(settled?.data?.callId).toMatch(/^mr-[a-f0-9]{64}-[a-f0-9]{24}$/u);
  const ledger = openLedger({ dir: join(runDir, "board"), runNonce, transcriptRoot: runDir });
  try {
    expect(ledger.attestedSettlementOf(settled!.data!.callId!)).toEqual(expect.objectContaining({
      bind: expect.objectContaining({ callId: settled!.data!.callId! }),
      payload: expect.objectContaining({ kind: "accounted-terminal" })
    }));
  } finally {
    ledger.close();
  }
}

function assertCanonicalWorkerAbsent(runDir: string, runId: string): void {
  const runEpoch = readFileSync(join(runDir, ".loop_run_nonce"), "utf8").trim();
  const store = openControlStore({
    path: join(runDir, "control.db"),
    runId,
    runEpoch,
    create: false,
    recoveryMode: "verify",
    integrityCheck: "full"
  });
  try {
    const view = buildMultiRepositoryControlView({ project: "product", run: runId, source: store });
    expect(view.tasks).toEqual([expect.objectContaining({ taskId: "product-change", workerSettled: false })]);
  } finally {
    store.close();
  }
}

function assertCrashWorktreeVectorPresent(runDir: string): void {
  const groupsDirectory = join(runDir, "multirepo-worktrees");
  const groups = readdirSync(groupsDirectory).filter((leaf) => leaf.startsWith("group-"));
  expect(groups).toHaveLength(1);
  const group = join(groupsDirectory, groups[0]!);
  expect(readFileSync(join(group, "alpha/relayforge-p6.txt"), "utf8")).toBe("updated:alpha\n");
  expect(readFileSync(join(group, "beta/relayforge-p6.txt"), "utf8")).toBe("updated:beta\n");
}

function resume(value: Fixture, runId: string): string {
  const resumed = spawnSync(process.execPath, cliArguments(value, runId), {
    cwd: value.root,
    env: childEnvironment(),
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024
  });
  expect(resumed.error).toBeUndefined();
  if (resumed.status !== 0) {
    const runDir = join(value.root, ".loop/runs/product", runId);
    const runEpoch = readFileSync(join(runDir, ".loop_run_nonce"), "utf8").trim();
    const store = openControlStore({ path: join(runDir, "control.db"), runId, runEpoch, create: false, recoveryMode: "verify", integrityCheck: "full" });
    let diagnostic: unknown;
    try { diagnostic = buildMultiRepositoryControlView({ project: "product", run: runId, source: store }); }
    finally { store.close(); }
    const verifierDirectory = join(runDir, "verifier-transcripts");
    const verifierTranscripts = existsSync(verifierDirectory)
      ? readdirSync(verifierDirectory).map((leaf) => `${leaf}:\n${readFileSync(join(verifierDirectory, leaf), "utf8").slice(-8_000)}`).join("\n")
      : "<missing>";
    throw new Error(`resume failed: ${resumed.stderr}\n${JSON.stringify(diagnostic)}\nverifier=${verifierTranscripts}`);
  }
  expect(resumed.stdout).toContain('"status": "done"');
  return join(value.root, ".loop/runs/product", runId);
}

function assertExactlyOnceOutcome(value: Fixture, runDir: string): void {
  expect(git(value.alpha, "rev-parse", "main")).toBe(value.initial.alpha);
  expect(git(value.beta, "rev-parse", "main")).toBe(value.initial.beta);
  const alpha = git(value.alpha, "rev-parse", "integration");
  const beta = git(value.beta, "rev-parse", "integration");
  expect(alpha).not.toBe(value.initial.alpha);
  expect(beta).not.toBe(value.initial.beta);
  expect(git(value.gamma, "rev-parse", "integration")).toBe(value.initial.gamma);
  expect(git(value.alpha, "show", `${alpha}:relayforge-p6.txt`)).toBe("updated:alpha");
  expect(git(value.beta, "show", `${beta}:relayforge-p6.txt`)).toBe("updated:beta");
  expect(git(value.alpha, "show", `${alpha}:provider-launches.txt`).split("\n")).toEqual(["launch"]);
  expect(git(value.beta, "show", `${beta}:provider-launches.txt`).split("\n")).toEqual(["launch"]);
  expect(readFileSync(join(value.gamma, "README.md"), "utf8")).toBe("# gamma\n");
  expect(readFileSync(value.sentinel, "utf8")).toBe("host-only-secret\n");

  const records = readFileSync(join(runDir, "board/reservations.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line) as { data?: { type?: string; callId?: string } });
  const calls = records.filter((record) => record.data?.callId?.startsWith("mr-"));
  expect(calls.filter((record) => record.data?.type === "reserve")).toHaveLength(1);
  expect(calls.filter((record) => record.data?.type === "settle")).toHaveLength(1);
  expect(receiptLeaves(runDir)).toHaveLength(1);
}

const REQUIRE_STRONG_HOST = process.env.RELAYFORGE_TEST_REQUIRE_CGROUP === "1";
const LAUNCHABLE_BWRAP = detectSandbox() === "bwrap";
const skipRealBwrap = !LAUNCHABLE_BWRAP && !REQUIRE_STRONG_HOST;

describe.skipIf(skipRealBwrap)("P6 product crash recovery under the real filesystem boundary", () => {
  it.each([
    "settlement-before-receipt",
    "receipt-before-canonical"
  ] as const)("recovers %s after real SIGKILL without a second provider launch", async (point) => {
    expect(detectSandbox(), "the P6 release gate requires real Bubblewrap").toBe("bwrap");
    expect(verifierNetworkIsolationAvailable(), "the P6 release gate requires a real verifier netns").toBe(true);
    const value = await fixture();
    const runId = point === "settlement-before-receipt" ? "crash-before-receipt" : "crash-after-receipt";
    const crashed = await crashAt(value, runId, point);
    expect(receiptLeaves(crashed.runDir)).toHaveLength(point === "settlement-before-receipt" ? 0 : 1);
    assertAttestedProviderSettlement(crashed.runDir);
    assertCanonicalWorkerAbsent(crashed.runDir, runId);
    assertCrashWorktreeVectorPresent(crashed.runDir);
    const runDir = resume(value, runId);
    assertExactlyOnceOutcome(value, runDir);
  }, 240_000);
});

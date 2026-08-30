import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function taskLine(title: string): string {
  return `${JSON.stringify({ id: "t1", title, assignee: "dev", createdBy: "pm", description: title, acceptanceCriteria: [], dependsOn: [], priority: 5, createdAt: new Date().toISOString() })}\n`;
}

function configuredProjectName(root: string): string {
  const canonical = join(root, "relayforge.config.yaml");
  const config = readFileSync(existsSync(canonical) ? canonical : join(root, "loop.config.yaml"), "utf8");
  const match = config.match(/^\s*- name: ([A-Za-z0-9._-]+)$/mu);
  if (!match?.[1]) throw new Error("starter project name not found");
  return match[1];
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(repoRoot, "src/cli.ts");
const tsxPath = resolve(repoRoot, "node_modules/tsx/dist/cli.mjs");

describe("CLI", () => {
  it("reports the package version", () => {
    const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as { version: string };

    const result = runLoop(["--version"], repoRoot);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(packageJson.version);
  });

  it("uses RelayForge as the canonical help identity", () => {
    const result = runLoop(["--help"], repoRoot);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: relayforge");
    expect(result.stdout).toContain("RelayForge:");
  });

  it("refuses conflicting canonical/legacy public env before command work, including JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "relayforge-cli-env-conflict-"));
    const result = runLoop(["--json", "init"], root, { RELAYFORGE_TMUX: "on", LOOP_TMUX: "off" });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, code: "ENV_CONFLICT" });
    expect(existsSync(join(root, "relayforge.config.yaml"))).toBe(false);
    expect(existsSync(join(root, ".loop"))).toBe(false);
  });

  it("initializes starter files without overwriting existing files by default", () => {
    const root = mkdtempSync(join(tmpdir(), "loop-cli-init-"));

    const first = runLoop(["init"], root);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("Created relayforge.config.yaml, brief.md, PROJECT-INTELLIGENCE.md, and .loop/");
    expect(existsSync(join(root, "relayforge.config.yaml"))).toBe(true);
    expect(existsSync(join(root, "brief.md"))).toBe(true);
    expect(existsSync(join(root, "PROJECT-INTELLIGENCE.md"))).toBe(true);
    expect(existsSync(join(root, ".loop"))).toBe(true);

    writeFileSync(join(root, "brief.md"), "custom brief");
    const second = runLoop(["init"], root);

    expect(second.status).toBe(1);
    expect(second.stderr).toContain("CONFIG_ALREADY_EXISTS");
    expect(readFileSync(join(root, "brief.md"), "utf8")).toBe("custom brief");
  });

  it("setup turns a real package name into a ready, project-aware starter in one command", () => {
    const root = mkdtempSync(join(tmpdir(), "relayforge-cli-setup-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@acme/coding-app", scripts: { test: "node --test" } }));

    const result = runLoop(["--json", "setup", "--provider", "codex"], root);

    expect(result.status).toBe(0);
    const setup = JSON.parse(result.stdout);
    expect(setup).toMatchObject({
      ok: true,
      created: true,
      project: "acme-coding-app",
      provider: "codex",
      planReady: true
    });
    expect(configuredProjectName(root)).toBe("acme-coding-app");
    expect(readFileSync(join(root, "PROJECT-INTELLIGENCE.md"), "utf8")).toContain("# Project Intelligence: @acme/coding-app");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain("PROJECT-INTELLIGENCE.md");
  });

  it("`init --force` may overwrite an auxiliary brief but never a config, and provider auto-detection keeps its order", async () => {
    const root = mkdtempSync(join(tmpdir(), "loop-cli-force-"));
    writeFileSync(join(root, "brief.md"), "custom brief");

    const forced = runLoop(["init", "--force"], root);
    expect(forced.status).toBe(0);
    expect(forced.stdout).not.toContain("Skipped");
    expect(readFileSync(join(root, "brief.md"), "utf8")).not.toBe("custom brief");
    const config = readFileSync(join(root, "relayforge.config.yaml"), "utf8");
    const refused = runLoop(["init", "--force"], root);
    expect(refused.status).toBe(1);
    expect(readFileSync(join(root, "relayforge.config.yaml"), "utf8")).toBe(config);

    // Auto-detection is a pure decision over the set of installed CLIs — assert it directly rather
    // than depending on what happens to be installed on this box.
    const { chooseStarterProvider } = await import("../src/starter.js");
    const pick = chooseStarterProvider();
    expect(["claude", "codex", "gemini"]).toContain(pick.provider); // never `custom` without an override
    expect(chooseStarterProvider("codex").provider).toBe("codex"); // an explicit override always wins
    // The documented preference order, proven against the real chooser's own detection.
    const order = ["claude", "codex", "gemini"] as const;
    const firstInstalled = order.find((p) => pick.detected.includes(p));
    if (firstInstalled) expect(pick.provider).toBe(firstInstalled);
  });

  it("init refuses cross-family ambiguity before mutating any starter or state file", () => {
    const root = mkdtempSync(join(tmpdir(), "relayforge-cli-ambiguous-init-"));
    const canonical = join(root, "relayforge.config.yaml");
    const legacy = join(root, "loop.config.yaml");
    writeFileSync(canonical, "canonical-bytes\n");
    writeFileSync(legacy, "legacy-bytes\n");

    const result = runLoop(["--json", "init", "--force"], root);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, code: "CONFIG_AMBIGUOUS" });
    expect(readFileSync(canonical, "utf8")).toBe("canonical-bytes\n");
    expect(readFileSync(legacy, "utf8")).toBe("legacy-bytes\n");
    expect(existsSync(join(root, "brief.md"))).toBe(false);
    expect(existsSync(join(root, ".loop"))).toBe(false);
    expect(existsSync(join(root, ".gitignore"))).toBe(false);
  });

  it("a config that FAILS the schema is reported, not thrown (no stack trace; JSON under --json)", () => {
    // `loop validate` used to crash on exactly the configs it exists to diagnose: a legacy/unknown key
    // made `loadConfig` throw, nothing caught it, and the user got an uncaught Node stack trace with
    // EMPTY stdout under `--json`. The strict rejection is right; the delivery was not.
    const root = mkdtempSync(join(tmpdir(), "loop-cli-badschema-"));
    writeFileSync(
      join(root, "loop.config.yaml"),
      `version: 1
projects:
  - name: demo
    providers: { dev: { type: codex } }
    roles: [{ name: dev, title: Dev, provider: dev }]
    loops:
      - { name: build, orchestrator: dev, reviewer: dev, isolate: true }
`
    );

    const human = runLoop(["validate"], root);
    expect(human.status).toBe(1);
    expect(human.stderr).toMatch(/isolate/); // it names the offending key…
    expect(human.stderr).not.toMatch(/at \w+ \(|node:internal|Error:\s*$/m); // …and does not dump a stack trace
    expect(human.stderr).toMatch(/relayforge validate/i); // and says what to do next

    const asJson = runLoop(["--json", "validate"], root);
    expect(asJson.status).toBe(1);
    const payload = JSON.parse(asJson.stdout); // must be parseable JSON, not empty
    expect(payload.ok).toBe(false);
    expect(String(payload.error)).toMatch(/isolate/);
    expect(Array.isArray(payload.nextSteps)).toBe(true);
  });

  it("validates a config as JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "loop-cli-validate-"));
    const configPath = join(root, "loop.config.yaml");
    writeFileSync(
      configPath,
      `version: 1
projects:
  - name: demo
    providers:
      dev:
        type: codex
    roles:
      - name: dev
        title: Developer
        provider: dev
`
    );

    const result = runLoop(["--config", configPath, "--json", "validate"], root);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      config: configPath,
      projects: ["demo"]
    });
  });

  it("prints JSON setup guidance when no config is found", () => {
    const root = mkdtempSync(join(tmpdir(), "loop-cli-missing-config-"));

    const result = runLoop(["--json", "validate"], root);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: "No RelayForge config found.",
      code: "CONFIG_NOT_FOUND",
      nextSteps: [
        "Run `relayforge init` in this repo.",
        "Run `relayforge auth status` again.",
        "Run `relayforge auth configure --write` to store detected local provider metadata."
      ]
    });
  });

  it("emits a config that `relayforge validate` accepts, and `relayforge doctor` reports on it", () => {
    const root = mkdtempSync(join(tmpdir(), "loop-cli-init-validate-"));

    const init = runLoop(["init", "--provider", "claude"], root);
    expect(init.status).toBe(0);
    expect(existsSync(join(root, ".gitignore"))).toBe(true);

    // The generated YAML parses AND passes schema + semantic validation.
    const validate = runLoop(["--json", "validate"], root);
    expect(validate.status).toBe(0);
    expect(JSON.parse(validate.stdout).ok).toBe(true);

    const doctor = runLoop(["--json", "doctor"], root);
    const report = JSON.parse(doctor.stdout);
    expect(Array.isArray(report.checks)).toBe(true);
    expect(report.checks.find((c: { name: string }) => c.name === "node").status).toBe("ok");
    expect(report.checks.some((c: { name: string }) => c.name === "config")).toBe(true);
  });

  it("rejects multi-repository configs with an actionable semantic error", () => {
    const root = mkdtempSync(join(tmpdir(), "loop-cli-multirepo-"));
    writeFileSync(
      join(root, "loop.config.yaml"),
      `version: 1
projects:
  - name: demo
    repositories:
      - name: app
        path: ./app
    providers:
      dev: { type: codex }
    roles:
      - { name: dev, title: Developer, provider: dev }
`
    );
    const result = runLoop(["--json", "validate"], root);
    expect(result.status).toBe(1);
    const out = JSON.parse(result.stdout);
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out.issues)).toContain("multi-repository");
  });

  it("attach fails with actionable guidance when the session does not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "loop-cli-attach-"));
    runLoop(["init"], root);
    const result = runLoop(["attach", "loop-does-not-exist-team"], root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/No tmux session|tmux is not installed/);
  });

  it("monitor --once discovers the latest run when no run id is given", () => {
    const root = mkdtempSync(join(tmpdir(), "loop-cli-latest-"));
    runLoop(["init"], root);
    // Run state is namespaced by the project-aware name generated during init.
    const runs = join(root, ".loop/runs", configuredProjectName(root));
    const older = join(runs, "run-older/board");
    const newer = join(runs, "run-newer/board");
    mkdirSync(older, { recursive: true });
    mkdirSync(newer, { recursive: true });
    // 0600, exactly as `initBoard` publishes them — the board reader REFUSES a group/other-accessible
    // journal (another account could otherwise rewrite the task list this run is driven from).
    const priv = { mode: 0o600 } as const;
    writeFileSync(join(older, "tasks.jsonl"), taskLine("OLD-TASK"), priv);
    writeFileSync(join(older, "events.jsonl"), "", priv);
    writeFileSync(join(older, "messages.jsonl"), "", priv);
    writeFileSync(join(newer, "tasks.jsonl"), taskLine("NEWEST-TASK"), priv);
    writeFileSync(join(newer, "events.jsonl"), "", priv);
    writeFileSync(join(newer, "messages.jsonl"), "", priv);
    // Make "newer" the most recently modified run directory.
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(runs, "run-newer"), future, future);

    const result = runLoop(["monitor", "--once"], root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("NEWEST-TASK");
    expect(result.stdout).not.toContain("OLD-TASK");
  });

  it("exit-code matrix: dry-run planned → exit 0; --execute without a git repo → exit 1", () => {
    const root = mkdtempSync(join(tmpdir(), "loop-cli-exit-"));
    runLoop(["init"], root);

    // Dry-run reaches `planned` and exits 0 (a successful dry-run is NEVER `done`).
    const dry = runLoop(["--json", "run", "ship it"], root);
    expect(dry.status).toBe(0);
    const dryOut = JSON.parse(dry.stdout);
    expect(dryOut.status).toBe("planned");
    expect(dryOut.success).toBe(true);

    // --execute against a non-git directory fails the human gate and exits non-zero.
    const exec = runLoop(["run", "ship it", "--execute", "--run", "r-exec"], root);
    expect(exec.status).toBe(1);
  });

  it("exit-code contract: ONLY `done` and `planned` are success — everything else exits non-zero", async () => {
    // The status→exit map is the last thing standing between a half-finished run and a green CI job,
    // and only `planned → 0` was ever tested. `unverified` is the one that matters: every task
    // accepted, reviewer happy, branch written — and nothing ever proved it green. It must FAIL.
    //
    // A one-character edit (`|| status === "unverified"`) would have shipped with a green suite. It
    // cannot now: this is an allow-list, so an unrecognised or NEW terminal status is a failure until
    // someone deliberately adds it here.
    const { runSucceeded } = await import("../src/cli/support.js");

    expect(runSucceeded("done")).toBe(true);
    expect(runSucceeded("planned")).toBe(true);

    for (const status of ["unverified", "blocked", "stopped", "cancelled", "running", "escalated", "budget-exhausted", "", "DONE", "future-status"]) {
      expect(runSucceeded(status), `status ${JSON.stringify(status)} must NOT be a success`).toBe(false);
    }
    // An unreadable/absent state file yields no status at all — that is a failure, never a pass.
    expect(runSucceeded(undefined)).toBe(false);
    expect(runSucceeded(null)).toBe(false);
  });

  it("rejects a path-traversal run id instead of writing outside the run dir", () => {
    const root = mkdtempSync(join(tmpdir(), "loop-cli-trav-"));
    runLoop(["init"], root);
    const res = runLoop(["run", "goal", "--run", "../../evil"], root);
    expect(res.status).toBe(1);
    expect(res.stderr + res.stdout).toMatch(/invalid|identifier/i);
    // No sentinel escaped the project directory.
    expect(existsSync(join(root, "..", "evil"))).toBe(false);
  });

  it("rejects max-iterations before prepareRun acquires leases or creates run state", () => {
    const root = mkdtempSync(join(tmpdir(), "loop-cli-max-before-prepare-"));
    runLoop(["init"], root);
    const runId = "run-invalid-max";

    const result = runLoop(["run", "goal", "--run", runId, "--max-iterations", "not-an-integer"], root);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--max-iterations must be an integer between 1 and 1000/u);
    expect(existsSync(join(root, ".loop", "runs", configuredProjectName(root), runId))).toBe(false);
  });

  it("(wave-8) every lifecycle command rejects a traversal run id and leaves a sibling victim byte-identical", () => {
    // A temp repo with a SIBLING victim tree next to it. A `../../../victim` run id passed to any
    // lifecycle command must exit non-zero BEFORE resolving paths / writing cancel files / touching
    // tmux, and the victim must remain byte-for-byte unchanged.
    const base = mkdtempSync(join(tmpdir(), "loop-cli-lifecycle-"));
    const root = join(base, "repo");
    mkdirSync(root, { recursive: true });
    runLoop(["init"], root);
    const victimDir = join(base, "victim");
    mkdirSync(victimDir, { recursive: true });
    const victimFile = join(victimDir, "precious.txt");
    const victimBytes = "do-not-touch\n";
    writeFileSync(victimFile, victimBytes);

    // A relative traversal that, from <root>/.loop/runs/<project>/, would climb into ../victim.
    const evil = "../../../../victim/pwned";
    for (const argv of [
      ["stop", evil],
      ["start", "--run", evil],
      ["monitor", "--run", evil, "--once"],
      ["attach", "--run", evil]
    ]) {
      const res = runLoop(argv, root);
      expect(res.status).toBe(1);
      expect(res.stderr + res.stdout).toMatch(/invalid|identifier/i);
    }
    // The sibling victim tree is byte-for-byte unchanged, and no cancel file leaked into it.
    expect(readFileSync(victimFile, "utf8")).toBe(victimBytes);
    expect(existsSync(join(victimDir, ".loop.cancel"))).toBe(false);
    expect(existsSync(join(victimDir, "pwned"))).toBe(false);
  });

  it("`loop tmux --help` is discoverable: every verb and every exit code is documented", () => {
    const root = tmuxProject();
    const help = runLoop(["tmux", "--help"], root);

    expect(help.status).toBe(0);
    for (const verb of ["pre", "new", "show", "kill", "prune"]) expect(help.stdout).toContain(verb);
    // The exit-code contract is what makes these commands scriptable — it must be in the help, not folklore.
    expect(help.stdout).toContain("Exit codes");
    expect(help.stdout).toMatch(/2\s+tmux not installed or viewport off/);
    expect(help.stdout).toMatch(/3\s+a foreign \(non-RelayForge\) session holds the name/);
    expect(help.stdout).toContain("relayforge tmux pre");
  });

  it("viewport OFF → exit 2; no runs → exit 4; traversal run id → exit 1 (before tmux is ever touched)", () => {
    const root = tmuxProject();

    // No runs yet: every viewport verb needs a run, and says which command creates one.
    const noRun = runLoop(["tmux", "pre"], root);
    expect(noRun.status).toBe(4);
    expect(noRun.stderr).toMatch(/No runs found/i);
    expect(noRun.stderr).toMatch(/relayforge run/);

    mkdirSync(join(root, ".loop/runs", configuredProjectName(root), "r1/board"), { recursive: true });

    // Viewport switched off (tests/setup.ts sets LOOP_TMUX=off; the CLI child inherits it).
    const pre = runLoop(["--json", "tmux", "pre", "-r", "r1"], root, { LOOP_TMUX: "off" });
    expect(pre.status).toBe(2);
    const plan = JSON.parse(pre.stdout);
    expect(plan.ok).toBe(false);
    expect(plan.action).toBe("blocked");
    expect(plan.reason).toMatch(/switched off/i);

    const opened = runLoop(["tmux", "new", "-r", "r1"], root, { LOOP_TMUX: "off" });
    expect(opened.status).toBe(2);
    expect(opened.stderr).toMatch(/switched off/i);

    // A traversal run id is rejected BEFORE a path is resolved or tmux is touched. Every `loop tmux`
    // verb validates through the one shared guard (`viewportContext` → `assertId`), so a read verb and
    // the destructive one prove the guard; spawning a CLI per verb would only re-prove the same line.
    for (const verb of ["pre", "kill"]) {
      const res = runLoop(["tmux", verb, "--run", "../../../evil"], root);
      expect(res.status).toBe(1);
      expect(res.stderr + res.stdout).toMatch(/invalid|identifier/i);
    }
  });

  it("(tmux slice, REAL tmux) the CLI is really wired to tmux: new creates an owned session, kill reaps it", () => {
    if (spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0) return; // tmux is optional
    // This proves the CLI WIRING against a real (private) tmux server: flags → config → identity →
    // tmux → exit code → JSON. The full behavioural matrix (idempotence, conflict, prune, dead panes,
    // races) is exercised against real tmux IN-PROCESS in tmux-client.test.ts, because each CLI
    // invocation costs a process boot and this suite shares a CPU with throughput tests.
    const root = tmuxProject();
    const socket = join(mkdtempSync(join(tmpdir(), "loop-cli-sock-")), "s.sock");
    const env = { LOOP_TMUX: "on", LOOP_TMUX_SOCKET: socket };
    const tmux = (args: string[]) => spawnSync("tmux", ["-S", socket, ...args], { encoding: "utf8" });
    mkdirSync(join(root, ".loop/runs", configuredProjectName(root), "r1/board"), { recursive: true });

    try {
      // new: creates it. stdout is a pipe here, so it stays DETACHED rather than dying on "open terminal failed".
      const created = JSON.parse(runLoop(["--json", "tmux", "new", "-r", "r1"], root, env).stdout);
      expect(created.created).toBe(true);
      expect(created.attached).toBe(false);
      expect(created.manualCommand).toBe(`tmux attach -t ${created.session}`);
      expect(Object.keys(created.panes).length).toBeGreaterThan(0);
      // tmux itself holds exactly that session, stamped as ours.
      expect(tmux(["list-sessions", "-F", "#{session_name}"]).stdout.split("\n").filter(Boolean)).toEqual([created.session]);
      expect(tmux(["show-options", "-v", "-t", created.session, "@loop-run"]).stdout.trim()).toBe("r1");

      // kill: reaps it, and tmux agrees it is gone.
      const killed = runLoop(["--json", "tmux", "kill", "-r", "r1"], root, env);
      expect(killed.status).toBe(0);
      expect(JSON.parse(killed.stdout).killed).toEqual([created.session]);
      expect(tmux(["has-session", "-t", `=${created.session}`]).status).not.toBe(0);
    } finally {
      tmux(["kill-server"]);
    }
  });

  it("(wave-8) monitor rejects a non-integer interval", () => {
    const root = tmuxProject();
    const badInterval = runLoop(["monitor", "--interval", "not-a-number", "--once"], root);
    expect(badInterval.status).toBe(1);
    expect(badInterval.stderr + badInterval.stdout).toMatch(/interval/i);
  });

  it("(wave-8) logs rejects a non-integer line bound", () => {
    const root = tmuxProject();
    const badLines = runLoop(["logs", "loop-x-y-team", "--lines", "-5"], root);
    expect(badLines.status).toBe(1);
    expect(badLines.stderr + badLines.stdout).toMatch(/lines/i);
  });

  it("(wave-8) default run ids carry entropy", () => {
    const root = tmuxProject();
    // Two default run ids generated back-to-back must differ (entropy, not one-second resolution).
    const a = runLoop(["--json", "run", "g"], root);
    const b = runLoop(["--json", "run", "g"], root);
    const runA = JSON.parse(a.stdout).run as string;
    const runB = JSON.parse(b.stdout).run as string;
    expect(runA).not.toBe(runB);
  });
});

/**
 * A ready-to-use project root for the viewport tests, WITHOUT paying for a `loop init` subprocess.
 * Each CLI invocation costs a full tsx boot of the whole import graph, and this suite runs alongside
 * CPU-bound throughput tests in sibling workers — so every process we do not spawn is real headroom.
 */
function tmuxProject(): string {
  const root = mkdtempSync(join(tmpdir(), "loop-cli-tmux-"));
  writeFileSync(
    join(root, "loop.config.yaml"),
    `version: 1
projects:
  - name: demo-product
    providers:
      dev: { type: codex }
    roles:
      - { name: dev, title: Developer, provider: dev }
`
  );
  return root;
}

function runLoop(args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [tsxPath, cliPath, ...args], {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env
  });
}

#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { configureLocalAuth, getAuthStatus } from "./auth.js";
import { defaultRunId, latestRunId, output, parseBoundedInt, runSucceeded, safeLoadConfig, safeLoadConfigOptional, writeIfMissing } from "./cli/support.js";
import { getProject } from "./config/load.js";
import { assertConfigSemantics, validateConfigSemantics } from "./config/validate.js";
import { assertId } from "./ids.js";
import { startDashboard } from "./dashboard/server.js";
import { runDoctor } from "./doctor.js";
import { writeIntelligence } from "./intelligence.js";
import { discoverPanes, renderOnce, startMonitor } from "./monitor.js";
import { prepareRun, runAutonomyLoop, writeRolePrompts } from "./orchestrator.js";
import { packageVersion } from "./metadata.js";
import { requestCancel } from "./runtime.js";
import { listSmeDisciplines } from "./sme.js";
import { chooseStarterProvider, starterBrief, starterConfig, StarterProvider } from "./starter.js";
import { attachSession, capturePane, isSafeTmuxName, listSessions, paneTitle, sessionName, startProjectSessions, stopRun, tmuxClient } from "./tmux.js";
import { detectHost, killViewport, openViewport, planViewport, pruneViewport, showViewport, TmuxExit } from "./tmux-workflow.js";

/** Ensure the given entries are present in the repo's .gitignore (so loop artifacts never
 *  dirty the tree and trip the execution clean-git gate). */
function ensureGitignore(root: string, entries: string[]): void {
  const path = resolve(root, ".gitignore");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = new Set(existing.split("\n").map((l) => l.trim()));
  const missing = entries.filter((e) => !lines.has(e));
  if (!missing.length) return;
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  if (existing) appendFileSync(path, `${prefix}${missing.join("\n")}\n`);
  else writeFileSync(path, `${missing.join("\n")}\n`);
}

const program = new Command();

/** Print an error and mark a non-zero exit. Used by lifecycle commands that must FAIL CLOSED when an
 *  identifier, config, or numeric option is invalid — BEFORE any path is resolved or tmux is touched. */
function die(error: unknown): void {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

program
  .name("loop")
  .description("Safe, end-to-end AI agent team orchestrator (tmux is an optional viewport)")
  .version(packageVersion)
  .option("-c, --config <path>", "path to loop.config.yaml")
  .option("--json", "print machine-readable JSON");

program
  .command("init")
  .description("create a starter loop.config.yaml and brief.md wired to an installed provider")
  .option("-f, --force", "overwrite existing files")
  .option("--provider <type>", "force a provider: claude | codex | gemini | custom")
  .action((options) => {
    const root = process.cwd();
    const override = options.provider as StarterProvider | undefined;
    if (override && !["claude", "codex", "gemini", "custom"].includes(override)) {
      console.error(`Unknown --provider ${override}. Use one of: claude, codex, gemini, custom.`);
      process.exitCode = 1;
      return;
    }
    const choice = chooseStarterProvider(override);
    writeIfMissing(resolve(root, "loop.config.yaml"), starterConfig(choice.provider, choice.detected, Boolean(override)), Boolean(options.force));
    writeIfMissing(resolve(root, "brief.md"), starterBrief(), Boolean(options.force));
    mkdirSync(resolve(root, ".loop"), { recursive: true });
    ensureGitignore(root, [".loop/", "PROJECT-INTELLIGENCE.md"]);
    console.log("Created loop.config.yaml, brief.md, and .loop/");
    console.log(`Provider: ${choice.provider}${choice.installed ? " (detected)" : " (not detected locally)"}.`);
    if (choice.detected.length) console.log(`Installed provider CLIs: ${choice.detected.join(", ")}.`);
    if (!choice.installed && choice.provider !== "custom") {
      console.log(`Tip: install the ${choice.provider} CLI, or re-run \`loop init --provider <type>\`. Dry-run works without any provider.`);
    }
    console.log("Next: `loop validate`, then `loop doctor`, then `loop run \"<goal>\"` (add --execute to launch agents).");
  });

program
  .command("doctor")
  .description("check environment, config, and provider readiness with actionable fixes")
  .option("-p, --project <name>", "project name")
  .action((options) => {
    const opts = program.opts();
    const loaded = safeLoadConfigOptional(opts.config);
    const report = runDoctor(loaded, process.cwd(), options.project);
    if (opts.json) {
      output(report, true);
    } else {
      for (const check of report.checks) {
        const mark = check.status === "ok" ? "✓" : check.status === "warn" ? "!" : "✗";
        console.log(`${mark} ${check.name}: ${check.detail}`);
        if (check.fix && check.status !== "ok") console.log(`    → ${check.fix}`);
      }
      console.log(report.ok ? "\ndoctor: OK" : "\ndoctor: problems found");
    }
    if (!report.ok) process.exitCode = 1;
  });

program
  .command("learn")
  .description("scan the project and generate PROJECT-INTELLIGENCE.md")
  .option("-p, --project <name>", "project name")
  .option("-d, --dir <path>", "directory to scan (defaults to the project workingDir or cwd)")
  .action((options) => {
    const opts = program.opts();
    let scanDir = options.dir ? resolve(options.dir) : process.cwd();
    let outPath = resolve(scanDir, "PROJECT-INTELLIGENCE.md");
    const loaded = safeLoadConfigOptional(opts.config);
    if (loaded && !options.dir) {
      const project = getProject(loaded, options.project);
      scanDir = resolve(loaded.rootDir, project.workingDir);
      outPath = resolve(scanDir, project.intelligence);
    }
    const intel = writeIntelligence(scanDir, outPath);
    output({ wrote: outPath, name: intel.name, languages: intel.languages, frameworks: intel.frameworks, commands: intel.commands }, opts.json);
  });

program
  .command("run")
  .argument("<goal>", "the goal for the autonomous team to deliver")
  .description("decompose a goal and drive the autonomy loop (dry-run by default; --execute launches agents)")
  .option("-p, --project <name>", "project name")
  .option("-l, --loop <name>", "which loop to run (required when a project defines several)")
  .option("-r, --run <id>", "run id", defaultRunId())
  .option("--execute", "actually launch agent CLIs (default is a safe dry-run that launches no provider)")
  .option("--max-iterations <n>", "override loop maxIterations")
  .action(async (goal, options) => {
    const opts = program.opts();
    const loaded = safeLoadConfig(opts.config, opts.json);
    if (!loaded) return;
    try {
      assertConfigSemantics(loaded);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
      return;
    }
    const project = getProject(loaded, options.project);

    let ctx;
    try {
      ctx = prepareRun(loaded, project, options.run, goal, options.loop);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
      return;
    }
    if (options.maxIterations) {
      const n = Number(options.maxIterations);
      if (!Number.isInteger(n) || n < 1 || n > 1000) {
        console.error("--max-iterations must be an integer between 1 and 1000.");
        process.exitCode = 1;
        return;
      }
      ctx.loop.maxIterations = n;
    }

    // NOTE: `loop run` never writes PROJECT-INTELLIGENCE.md into the checkout — only `loop learn`
    // may write project intelligence. Planning happens INSIDE the run (after the clean gate and
    // integration worktree exist), so no provider ever runs against the human's checked-out tree.
    const roleFiles = writeRolePrompts(ctx);

    if (!opts.json) {
      console.log(`\n🛰  Run ${ctx.runId} · ${project.name} · loop ${ctx.loop.name}${options.execute ? "" : " (dry-run — no provider launched)"}`);
      console.log(`Goal: ${goal}`);
      console.log(`Team: ${project.roles.length} role(s). Monitor: loop monitor --run ${ctx.runId}\n`);
    }

    let reports;
    try {
      reports = await runAutonomyLoop(ctx, roleFiles, {
        execute: Boolean(options.execute),
        onIteration: opts.json
          ? undefined
          : (r) => {
              const byStatus = Object.entries(r.summary.byStatus).map(([s, n]) => `${s}:${n}`).join(" ");
              console.log(`  iteration ${r.iteration} · dispatched ${r.dispatched.length} · ${byStatus}`);
            }
      });
    } catch (error) {
      console.error(`\nRun aborted: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      return;
    }

    let finalState: Record<string, unknown> = {};
    try {
      finalState = JSON.parse(readFileSync(ctx.statePath, "utf8"));
    } catch {
      // state unreadable — omit
    }

    const status = String(finalState.status ?? "");
    // Exit 0 ONLY for a real success — see runSucceeded(). Every other terminal state (unverified,
    // blocked, stopped, cancelled, budget-exhausted, or an unreadable state file) exits non-zero.
    const success = runSucceeded(status);
    if (!success) process.exitCode = 1;

    output(
      {
        run: ctx.runId,
        project: project.name,
        loop: ctx.loop.name,
        session: ctx.session,
        execute: Boolean(options.execute),
        status: finalState.status ?? null,
        success,
        stopReason: finalState.lastStopReason ?? null,
        accepted: finalState.accepted ?? null,
        rejected: finalState.rejected ?? null,
        escalations: finalState.escalations ?? null,
        unknownCostCalls: finalState.unknownCostCalls ?? null,
        runBranch: ctx.target?.integration.branch ?? null,
        tasks: reports[reports.length - 1]?.summary.total ?? 0,
        stateFile: ctx.statePath,
        logFile: ctx.runLog,
        iterations: reports.length,
        final: reports[reports.length - 1]?.summary ?? null,
        monitor: `loop monitor --run ${ctx.runId}`,
        reviewRunBranch: ctx.target ? `git log ${ctx.target.integration.branch}` : null
      },
      opts.json
    );
  });

program
  .command("monitor")
  .description("single-screen mission control: board + every agent pane, live (defaults to the latest run)")
  .option("-p, --project <name>", "project name")
  .option("-r, --run <id>", "run id to monitor (defaults to the most recent run)")
  .option("--once", "render one frame and exit (for CI / piping)")
  .option("--interval <ms>", "refresh interval in ms", "1500")
  .action((options) => {
    const opts = program.opts();
    const loaded = safeLoadConfig(opts.config, opts.json);
    if (!loaded) return;
    // Validate config semantics, the run id, and the interval BEFORE resolving any run path.
    let intervalMs: number;
    try {
      assertConfigSemantics(loaded);
      if (options.run !== undefined) assertId("run", options.run);
      intervalMs = parseBoundedInt(options.interval, "--interval", 100, 3_600_000);
    } catch (error) {
      die(error);
      return;
    }
    const project = getProject(loaded, options.project);
    const runsDir = resolve(loaded.rootDir, loaded.config.defaults.runDir, project.name);
    const runId = options.run ?? latestRunId(runsDir);
    if (!runId) {
      console.error("No runs found. Start one with `loop run \"<goal>\"`.");
      process.exitCode = 1;
      return;
    }
    const boardDir = resolve(runsDir, runId, "board");
    const namespace = loaded.config.defaults.namespace;
    const session = sessionName(namespace, project.name, runId, "team");
    const panes = discoverPanes(session);
    const monitorOpts = { boardDir, session, panes, intervalMs };
    if (options.once) {
      console.log(renderOnce(monitorOpts));
      return;
    }
    startMonitor(monitorOpts);
  });

program
  .command("attach")
  .description("attach your terminal to a run's tmux viewport (defaults to the latest run)")
  .argument("[session]", "explicit tmux session name")
  .option("-p, --project <name>", "project name")
  .option("-r, --run <id>", "run id (defaults to the most recent run)")
  .action((sessionArg, options) => {
    const opts = program.opts();
    let session = sessionArg as string | undefined;
    if (!session) {
      const loaded = safeLoadConfig(opts.config, opts.json);
      if (!loaded) return;
      try {
        assertConfigSemantics(loaded);
        if (options.run !== undefined) assertId("run", options.run);
      } catch (error) {
        die(error);
        return;
      }
      const project = getProject(loaded, options.project);
      const runsDir = resolve(loaded.rootDir, loaded.config.defaults.runDir, project.name);
      const runId = options.run ?? latestRunId(runsDir);
      if (!runId) {
        console.error("No runs found to attach to. Start one with `loop run`.");
        process.exitCode = 1;
        return;
      }
      session = sessionName(loaded.config.defaults.namespace, project.name, runId, "team");
    }
    try {
      process.exitCode = attachSession(session);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

// ---------------------------------------------------------------------------
// `loop tmux` — the OPTIONAL viewport, as one coherent verb group.
//
//   loop tmux pre     what `new` would do (changes nothing)     → exit 0 when it would work
//   loop tmux new     create-or-attach, idempotent               → exit 0 / 2 / 3
//   loop tmux show    owned sessions, liveness, panes, output    → exit 0 / 4
//   loop tmux kill    kill this run's owned sessions             → exit 0
//   loop tmux prune   reap dead + orphaned viewports             → exit 0
//
// Exit codes are stable and scriptable: 0 ok · 1 error · 2 tmux unavailable · 3 foreign-session
// conflict · 4 nothing found. `pre` returns the code `new` WOULD return, so a script can gate on it.
// ---------------------------------------------------------------------------

const tmuxCmd = program
  .command("tmux")
  .description("the optional tmux viewport: pre (preview) · new (open) · show · kill · prune")
  .addHelpText(
    "after",
    `
Exit codes:
  0  ok / would work        2  tmux not installed or viewport off
  1  error                  3  a foreign (non-Loop) session holds the name
                            4  nothing found

Examples:
  $ loop tmux pre                  # pre-flight: what would "loop tmux new" do? (mutates nothing)
  $ loop tmux new                  # open the latest run's viewport and attach (idempotent)
  $ loop tmux new -r bug-42 --no-attach
  $ loop tmux show --capture 40    # owned sessions + the last 40 lines of each
  $ loop tmux kill -r bug-42       # kill only THIS run's Loop-owned sessions
  $ loop tmux prune --dry-run      # what stale viewports would be reaped?

tmux is an OPTIONAL viewport. The loop always runs headless; "loop monitor" needs no tmux at all.`
  );

/** Resolve (config → project → run → identity → panes) for every `loop tmux` subcommand, or `undefined`
 *  after printing the reason. Validates ids BEFORE any path is resolved or tmux is touched. */
function viewportContext(options: { project?: string; run?: string }, opts: { config?: string; json?: boolean }) {
  const loaded = safeLoadConfig(opts.config, Boolean(opts.json));
  if (!loaded) return undefined;
  try {
    assertConfigSemantics(loaded);
    if (options.run !== undefined) assertId("run", options.run);
  } catch (error) {
    die(error);
    return undefined;
  }
  const project = getProject(loaded, options.project);
  const namespace = loaded.config.defaults.namespace;
  const runsDir = resolve(loaded.rootDir, loaded.config.defaults.runDir, project.name);
  const runId = options.run ?? latestRunId(runsDir);
  const host = detectHost({ configEnabled: loaded.config.defaults.viewport });
  return {
    loaded,
    project,
    namespace,
    runsDir,
    runId,
    host,
    client: tmuxClient(),
    cwd: resolve(loaded.rootDir, project.workingDir),
    identity: runId ? { namespace, project: project.name, run: runId, role: "team", topology: undefined } : undefined,
    roles: project.roles.map((r) => ({ name: r.name, title: paneTitle(r.title) }))
  };
}

/** `--capture` with no value means "the default 40 lines"; with a value it must be a sane integer.
 *  Returns `null` (and sets a failing exit code) when the value is invalid. */
function parseCaptureLines(value: unknown): number | null | undefined {
  if (value === true) return 40;
  try {
    return parseBoundedInt(String(value), "--capture", 1, 100_000);
  } catch (error) {
    die(error);
    return null;
  }
}

/** Every `loop tmux` verb that needs a run: without one there is nothing to view. */
function requireRun(ctx: { runId?: string }): boolean {
  if (ctx.runId) return true;
  console.error("No runs found for this project. Start one first: `loop run \"<goal>\" --execute` (or `loop start` for a prompt-only viewport).");
  process.exitCode = TmuxExit.NOT_FOUND;
  return false;
}

const viewportOptions = <T extends Command>(cmd: T): T => {
  cmd.option("-p, --project <name>", "project name");
  cmd.option("-r, --run <id>", "run id (defaults to the most recent run)");
  return cmd;
};

viewportOptions(tmuxCmd.command("pre").aliases(["preview", "plan"]))
  .description("pre-flight: print exactly what `loop tmux new` would do — creates and changes NOTHING")
  .option("--no-attach", "plan a detached open (do not hand over this terminal)")
  .action((options) => {
    const opts = program.opts();
    const ctx = viewportContext(options, opts);
    if (!ctx || !requireRun(ctx)) return;
    const plan = planViewport(ctx.client, ctx.host, {
      identity: ctx.identity!,
      cwd: ctx.cwd,
      roles: ctx.roles,
      attach: options.attach
    });
    process.exitCode = plan.code;
    if (opts.json) {
      output(plan, true);
      return;
    }
    console.log(`${plan.ok ? "✓" : "✗"} loop tmux new · run ${ctx.runId} · project ${ctx.project.name}`);
    console.log(`  session : ${plan.session}`);
    console.log(`  panes   : ${plan.roles.join(", ") || "(none)"}`);
    console.log(`  cwd     : ${plan.cwd}`);
    console.log(`  existing: ${plan.existing}`);
    console.log(`  action  : ${plan.action}`);
    if (plan.attachArgv) console.log(`  tmux    : tmux ${plan.attachArgv.join(" ")}`);
    console.log(`  why     : ${plan.reason}`);
    if (plan.hint) console.log(`  → ${plan.hint}`);
  });

viewportOptions(tmuxCmd.command("new").aliases(["open"]))
  .description("create (or re-attach to) this run's tmux viewport — idempotent, safe to run twice")
  .option("--no-attach", "create the session but leave it detached")
  .action((options) => {
    const opts = program.opts();
    const ctx = viewportContext(options, opts);
    if (!ctx || !requireRun(ctx)) return;
    const result = openViewport(ctx.client, ctx.host, {
      identity: ctx.identity!,
      cwd: ctx.cwd,
      roles: ctx.roles,
      attach: options.attach
    });
    process.exitCode = result.code;
    if (opts.json) {
      output(result, true);
      return;
    }
    if (!result.ok) {
      console.error(result.reason);
      if (result.hint) console.error(`→ ${result.hint}`);
      return;
    }
    // When we attached, tmux already owned the terminal — anything printed here lands after detach.
    console.log(`${result.created ? "Created" : "Reusing"} tmux session ${result.session} (${Object.keys(result.panes).length} pane(s)).`);
    if (!result.attached && result.manualCommand) console.log(`Attach with: ${result.manualCommand}`);
  });

viewportOptions(tmuxCmd.command("show").aliases(["ls"]))
  .description("list Loop-owned tmux sessions: liveness, panes, and (with --capture) recent output")
  .option("--capture [lines]", "also capture the last N lines of each session (default 40)")
  .option("-a, --all", "show every run's sessions, not just the latest run")
  .action((options) => {
    const opts = program.opts();
    const ctx = viewportContext(options, opts);
    if (!ctx) return;
    const captureLines = options.capture === undefined ? undefined : parseCaptureLines(options.capture);
    if (captureLines === null) return;
    const report = showViewport(ctx.client, ctx.host, {
      namespace: ctx.namespace,
      project: ctx.project.name,
      run: options.all ? undefined : options.run,
      captureLines,
      knownRuns: existsSync(ctx.runsDir) ? readdirSync(ctx.runsDir) : []
    });
    process.exitCode = report.code;
    if (opts.json) {
      output(report, true);
      return;
    }
    if (!report.ok) {
      console.error(report.reason);
      if (report.hint) console.error(`→ ${report.hint}`);
      return;
    }
    for (const s of report.sessions) {
      const flags = [s.attached ? "attached" : "detached", s.dead ? "DEAD" : "live", s.orphan ? "ORPHAN" : ""].filter(Boolean);
      console.log(`${s.name}`);
      console.log(`  run ${s.id.run} · role ${s.id.role} · ${flags.join(" · ")} · panes: ${Object.keys(s.panes).join(", ") || "(none)"}`);
      if (s.capture) {
        for (const line of s.capture.split("\n").filter(Boolean).slice(-10)) console.log(`  │ ${line}`);
      }
    }
    if (report.sessions.some((s) => s.dead || s.orphan)) console.log("\nStale viewports found — reap them with `loop tmux prune`.");
  });

viewportOptions(tmuxCmd.command("kill"))
  .description("kill this run's Loop-owned tmux sessions (never a session Loop did not create)")
  .option("-a, --all", "kill every Loop-owned session for the project")
  .action((options) => {
    const opts = program.opts();
    const ctx = viewportContext(options, opts);
    if (!ctx) return;
    if (!options.all && !ctx.runId) {
      console.error("Nothing to kill: no runs found. Pass --run <id> or --all.");
      process.exitCode = TmuxExit.NOT_FOUND;
      return;
    }
    const report = killViewport(ctx.client, ctx.host, {
      namespace: ctx.namespace,
      project: ctx.project.name,
      run: options.all ? undefined : ctx.runId,
      all: Boolean(options.all)
    });
    process.exitCode = report.code;
    if (opts.json) {
      output({ killed: report.killed, reason: report.reason }, true);
      return;
    }
    if (!report.killed.length) console.log(report.reason ?? "No Loop-owned sessions matched — nothing killed.");
    else for (const name of report.killed) console.log(`killed ${name}`);
  });

tmuxCmd
  .command("prune")
  .description("reap STALE viewports: sessions whose panes are all dead, or whose run no longer exists")
  .option("-p, --project <name>", "project name")
  .option("--dry-run", "list what would be pruned without killing anything")
  .action((options) => {
    const opts = program.opts();
    const ctx = viewportContext(options, opts);
    if (!ctx) return;
    const report = pruneViewport(ctx.client, ctx.host, {
      namespace: ctx.namespace,
      project: ctx.project.name,
      // A run is LIVE while its state directory exists. A finished run's viewport still holds output a
      // human may want to read, so it is KEPT — only a corpse (all panes dead) or a viewport whose run
      // was deleted is reaped. Kill a finished run's viewport explicitly with `loop tmux kill -r <id>`.
      isRunLive: (run) => existsSync(resolve(ctx.runsDir, run)),
      dryRun: Boolean(options.dryRun)
    });
    process.exitCode = report.code;
    if (opts.json) {
      output(report, true);
      return;
    }
    if (!report.pruned.length) {
      console.log(`Nothing stale to prune (${report.kept.length} healthy viewport(s) kept).`);
      return;
    }
    for (const p of report.pruned) {
      const why = p.reason === "dead-panes" ? "every pane exited" : "its run no longer exists";
      console.log(`${report.dryRun ? "would prune" : "pruned"} ${p.session} — ${why}`);
    }
    if (report.dryRun) console.log("\nRe-run without --dry-run to reap them.");
  });

program
  .command("roles")
  .description("list the built-in SME disciplines available for `sme:` in a role")
  .action(() => {
    const opts = program.opts();
    output({ disciplines: listSmeDisciplines() }, opts.json);
  });

program
  .command("validate")
  .description("validate the loop config (schema + semantic references)")
  .action(() => {
    const opts = program.opts();
    const loaded = safeLoadConfig(opts.config, opts.json);
    if (!loaded) return;
    const issues = validateConfigSemantics(loaded);
    if (issues.length) {
      output({ ok: false, config: loaded.path, issues }, opts.json);
      process.exitCode = 1;
      return;
    }
    output({ ok: true, config: loaded.path, projects: loaded.config.projects.map((project) => project.name) }, opts.json);
  });

const auth = program.command("auth").description("inspect and configure local provider authentication");

auth
  .command("status")
  .description("show local Claude, Codex, Gemini, and custom provider readiness")
  .option("-p, --project <name>", "project name")
  .action((options) => {
    const opts = program.opts();
    const loaded = safeLoadConfig(opts.config, opts.json);
    if (!loaded) return;
    const project = getProject(loaded, options.project);
    output({ project: project.name, providers: getAuthStatus(project) }, opts.json);
  });

auth
  .command("configure")
  .description("write detected local provider auth settings into loop.config.yaml")
  .option("-p, --project <name>", "project name")
  .option("--write", "write detected settings")
  .action((options) => {
    const opts = program.opts();
    const loaded = safeLoadConfig(opts.config, opts.json);
    if (!loaded) return;
    const project = getProject(loaded, options.project);
    if (!options.write) {
      output({ project: project.name, dryRun: true, message: "Run `loop auth configure --write` to update loop.config.yaml.", providers: getAuthStatus(project) }, opts.json);
      return;
    }
    output({ project: project.name, updated: loaded.path, providers: configureLocalAuth(loaded, project.name) }, opts.json);
  });

program
  .command("start")
  .description("open a prompt-only tmux viewport for a project team (observational; use `loop run --execute` to actually run agents safely)")
  .option("-p, --project <name>", "project name")
  .option("-r, --run <id>", "run id", defaultRunId())
  .option("--role <name...>", "only start specific roles")
  .action((options) => {
    const opts = program.opts();
    const loaded = safeLoadConfig(opts.config, opts.json);
    if (!loaded) return;
    // Validate config semantics and the run id BEFORE writing prompts / resolving the run dir / tmux.
    try {
      assertConfigSemantics(loaded);
      assertId("run", options.run);
    } catch (error) {
      die(error);
      return;
    }
    const project = getProject(loaded, options.project);
    // Viewport only. There is NO `--execute` bypass here: agents run exclusively through the safe
    // engine in `loop run --execute`, which enforces the clean-git gate, isolated worktrees,
    // sandboxed verification, and independent review.
    const sessions = startProjectSessions(loaded, project, options.run, { execute: false, roles: options.role });
    output({ run: options.run, project: project.name, sessions }, opts.json);
  });

program
  .command("status")
  .description("list loop tmux sessions")
  .action(() => {
    const opts = program.opts();
    const loaded = safeLoadConfig(opts.config, opts.json);
    if (!loaded) return;
    output({ sessions: listSessions(loaded.config.defaults.namespace) }, opts.json);
  });

program
  .command("logs")
  .argument("<session>", "tmux session name")
  .option("-n, --lines <count>", "number of lines", "160")
  .description("print captured logs for a session")
  .action((session, options) => {
    // Validate `--lines` (bounded positive int) and reject an option-like/control-laden session target
    // BEFORE invoking tmux — a leading `-` or a whitespace/control char could smuggle a tmux flag into
    // the `capture-pane` argv, and a `.`/`:` would make tmux target a different session entirely.
    let lines: number;
    try {
      lines = parseBoundedInt(options.lines, "--lines", 1, 100_000);
      if (!isSafeTmuxName(session)) throw new Error(`Invalid session name ${JSON.stringify(session)}.`);
    } catch (error) {
      die(error);
      return;
    }
    try {
      console.log(capturePane(session, lines));
    } catch (error) {
      die(error); // not an owned Loop session → we never screen-scrape it
    }
  });

program
  .command("stop")
  .argument("<run>", "run id")
  .description("cancel the run (parent-owned) and kill its tmux sessions")
  .option("-p, --project <name>", "project name")
  .action((run, options) => {
    const opts = program.opts();
    const loaded = safeLoadConfig(opts.config, opts.json);
    if (!loaded) return;
    // Validate config semantics and the run id BEFORE resolving the run dir or writing the cancel
    // flag: a traversal run id (`../../../victim`) must never let `requestCancel` write outside the
    // run tree, nor let `stopRun` match sessions by a crafted substring.
    try {
      assertConfigSemantics(loaded);
      assertId("run", run);
    } catch (error) {
      die(error);
      return;
    }
    const project = getProject(loaded, options.project);
    const runDir = resolve(loaded.rootDir, loaded.config.defaults.runDir, project.name, run);
    requestCancel(runDir, "stopped via `loop stop`");
    // Metadata-owned kill: only sessions THIS project+run created. The old substring match on
    // `-<run>-` could reach a different project's session (or a human's own).
    const killed = stopRun(loaded.config.defaults.namespace, project.name, run);
    output({ run, project: project.name, cancelled: true, killed }, opts.json);
  });

program
  .command("dashboard")
  .description("start the local (loopback-only) dashboard")
  .option("-p, --project <name>", "project name")
  .option("--port <port>", "dashboard port")
  .action(async (options) => {
    const opts = program.opts();
    const loaded = safeLoadConfig(opts.config, opts.json);
    if (!loaded) return;
    // Validate `--port` BEFORE binding. A bare `Number(options.port)` turned `--port abc` into NaN, and
    // Node reads NaN as "pick any free ephemeral port" — so a typo silently published the dashboard on an
    // unpredictable port while the operator watched 4318. Fail closed instead.
    let port: number | undefined;
    try {
      port = options.port === undefined ? undefined : parseBoundedInt(options.port, "--port", 1, 65535);
    } catch (error) {
      die(error);
      return;
    }
    try {
      await startDashboard(loaded, { project: options.project, port });
    } catch (error) {
      die(error);
    }
  });

program.parse();

#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { configureLocalAuth, getAuthStatus } from "./auth.js";
import { defaultRunId, output, safeLoadConfig, safeLoadConfigOptional, writeIfMissing } from "./cli/support.js";
import { getProject } from "./config/load.js";
import {
  addProject as daemonAddProject,
  killSession as daemonKillSession,
  listProjects as daemonListProjects,
  listSessions as daemonListSessions,
  tryRegisterSessions
} from "./daemon/client.js";
import {
  DEFAULT_DAEMON_PORT,
  daemonStatus,
  runDaemonForeground,
  startDaemonDetached,
  stopDaemon
} from "./daemon/lifecycle.js";
import { startDashboard } from "./dashboard/server.js";
import { writeIntelligence } from "./intelligence.js";
import { discoverPanes, renderOnce, startMonitor } from "./monitor.js";
import {
  decomposeGoal,
  prepareRun,
  runAutonomyLoop,
  writeRolePrompts
} from "./orchestrator.js";
import { packageVersion } from "./metadata.js";
import { listSmeDisciplines } from "./sme.js";
import { starterBrief, starterConfig } from "./starter.js";
import { capturePane, listSessions, startProjectSessions, stopRun } from "./tmux.js";

const program = new Command();

program
  .name("loop")
  .description("tmux-based AI agent team orchestrator")
  .version(packageVersion)
  .option("-c, --config <path>", "path to loop.config.yaml")
  .option("--json", "print machine-readable JSON");

program
  .command("init")
  .description("create a starter loop.config.yaml and brief.md")
  .option("-f, --force", "overwrite existing files")
  .action((options) => {
    const root = process.cwd();
    writeIfMissing(resolve(root, "loop.config.yaml"), starterConfig(), Boolean(options.force));
    writeIfMissing(resolve(root, "brief.md"), starterBrief(), Boolean(options.force));
    mkdirSync(resolve(root, ".loop"), { recursive: true });
    console.log("Created loop.config.yaml, brief.md, and .loop/");
  });

program
  .command("learn")
  .description("scan the project and generate PROJECT-INTELLIGENCE.md (trains the team on the codebase)")
  .option("-p, --project <name>", "project name")
  .option("-d, --dir <path>", "directory to scan (defaults to the project workingDir or cwd)")
  .action((options) => {
    const opts = program.opts();
    let scanDir = options.dir ? resolve(options.dir) : process.cwd();
    let outPath = resolve(scanDir, "PROJECT-INTELLIGENCE.md");
    // If a config exists, honor its workingDir + intelligence path.
    const loaded = safeLoadConfigOptional(opts.config);
    if (loaded && !options.dir) {
      const project = getProject(loaded, options.project);
      scanDir = resolve(loaded.rootDir, project.workingDir);
      outPath = resolve(scanDir, project.intelligence);
    }
    const intel = writeIntelligence(scanDir, outPath);
    output(
      {
        wrote: outPath,
        name: intel.name,
        languages: intel.languages,
        frameworks: intel.frameworks,
        commands: intel.commands
      },
      opts.json
    );
  });

program
  .command("run")
  .argument("<goal>", "the goal for the autonomous team to deliver")
  .description("decompose a goal, launch the SME team in tmux, and drive the autonomy loop")
  .option("-p, --project <name>", "project name")
  .option("-r, --run <id>", "run id", defaultRunId())
  .option("--execute", "actually launch agent CLIs (default is a safe dry-run that drives the board)")
  .option("--max-iterations <n>", "override loop maxIterations")
  .action(async (goal, options) => {
    const opts = program.opts();
    const loaded = safeLoadConfig(opts.config, opts.json);
    if (!loaded) return;
    const project = getProject(loaded, options.project);

    const ctx = prepareRun(loaded, project, options.run, goal);
    if (options.maxIterations) ctx.loop.maxIterations = Number(options.maxIterations);

    // Make sure the team is trained on the project before planning.
    try {
      writeIntelligence(ctx.cwd, resolve(ctx.cwd, project.intelligence));
    } catch {
      // non-fatal — prompts degrade gracefully without intelligence
    }

    const roleFiles = writeRolePrompts(ctx);
    const tasks = decomposeGoal(ctx);

    // Best-effort: register the run's SME sessions with the mission-control daemon.
    await tryRegisterSessions(
      resolve(loaded.rootDir, ".loop", "daemon"),
      project.roles.map((role) => ({
        id: `${ctx.session}:${role.name}`,
        project: project.name,
        run: ctx.runId,
        role: role.name,
        provider: role.provider,
        tmuxSession: ctx.session,
        goal
      }))
    );

    if (!opts.json) {
      console.log(`\n🛰  Run ${ctx.runId} · ${project.name}`);
      console.log(`Goal: ${goal}`);
      console.log(`Decomposed into ${tasks.length} task(s) across ${project.roles.length} SME(s).`);
      console.log(`Monitor all agents on one screen:  loop monitor --run ${ctx.runId}\n`);
    }

    const reports = await runAutonomyLoop(ctx, roleFiles, {
      execute: Boolean(options.execute),
      onIteration: opts.json
        ? undefined
        : (r) => {
            const byStatus = Object.entries(r.summary.byStatus)
              .map(([s, n]) => `${s}:${n}`)
              .join(" ");
            console.log(`  iteration ${r.iteration} · dispatched ${r.dispatched.length} · ${byStatus}`);
          }
    });

    output(
      {
        run: ctx.runId,
        project: project.name,
        session: ctx.session,
        tasks: tasks.length,
        stateFile: ctx.statePath,
        contextFile: ctx.contextPath,
        logFile: ctx.runLog,
        heartbeat: ctx.heartbeatPath,
        iterations: reports.length,
        final: reports[reports.length - 1]?.summary ?? null,
        monitor: `loop monitor --run ${ctx.runId}`
      },
      opts.json
    );
  });

program
  .command("monitor")
  .description("single-screen mission control: board + every agent pane, live")
  .option("-p, --project <name>", "project name")
  .option("-r, --run <id>", "run id to monitor")
  .option("--once", "render one frame and exit (for CI / piping)")
  .option("--interval <ms>", "refresh interval in ms", "1500")
  .action((options) => {
    const opts = program.opts();
    const loaded = safeLoadConfig(opts.config, opts.json);
    if (!loaded) return;
    const project = getProject(loaded, options.project);
    const runId = options.run ?? defaultRunId();
    const boardDir = resolve(loaded.rootDir, loaded.config.defaults.runDir, runId, "board");
    const namespace = loaded.config.defaults.namespace;
    const session = `${namespace}-${project.name}-${runId}-team`.replace(/[^a-zA-Z0-9_.:-]/g, "-").slice(0, 120);
    const panes = discoverPanes(session);
    const monitorOpts = { boardDir, session, panes, intervalMs: Number(options.interval) };
    if (options.once) {
      console.log(renderOnce(monitorOpts));
      return;
    }
    startMonitor(monitorOpts);
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
  .description("validate the loop config")
  .action(() => {
    const opts = program.opts();
    const loaded = safeLoadConfig(opts.config, opts.json);
    if (!loaded) return;
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
      output({
        project: project.name,
        dryRun: true,
        message: "Run `loop auth configure --write` to update loop.config.yaml.",
        providers: getAuthStatus(project)
      }, opts.json);
      return;
    }
    output({ project: project.name, updated: loaded.path, providers: configureLocalAuth(loaded, project.name) }, opts.json);
  });

program
  .command("start")
  .description("start tmux sessions for a project team")
  .option("-p, --project <name>", "project name")
  .option("-r, --run <id>", "run id", defaultRunId())
  .option("--role <name...>", "only start specific roles")
  .option("--execute", "launch configured agent commands instead of prompt-only shells")
  .action(async (options) => {
    const opts = program.opts();
    const loaded = safeLoadConfig(opts.config, opts.json);
    if (!loaded) return;
    const project = getProject(loaded, options.project);
    const sessions = startProjectSessions(loaded, project, options.run, {
      execute: Boolean(options.execute),
      roles: options.role
    });
    // Best-effort: surface these sessions in mission control when the daemon is up.
    await tryRegisterSessions(
      resolve(loaded.rootDir, ".loop", "daemon"),
      sessions.map((info) => ({
        id: info.session,
        project: project.name,
        run: options.run,
        role: info.role,
        provider: info.provider,
        tmuxSession: info.session
      }))
    );
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
    console.log(capturePane(session, Number(options.lines)));
  });

program
  .command("stop")
  .argument("<run>", "run id")
  .description("stop all tmux sessions for a run")
  .action((run) => {
    const opts = program.opts();
    const loaded = safeLoadConfig(opts.config, opts.json);
    if (!loaded) return;
    output({ killed: stopRun(loaded.config.defaults.namespace, run) }, opts.json);
  });

/** Resolve the daemon state directory + port, with or without a config file. */
function daemonContext(): { stateDir: string; port: number } {
  const opts = program.opts();
  const loaded = safeLoadConfigOptional(opts.config);
  const rootDir = loaded?.rootDir ?? process.cwd();
  const port = loaded?.config.defaults.daemonPort ?? DEFAULT_DAEMON_PORT;
  return { stateDir: resolve(rootDir, ".loop", "daemon"), port };
}

const daemon = program
  .command("daemon")
  .description("control the mission-control daemon (session registry, events, feedback routing)");

daemon
  .command("start")
  .description("start the daemon in the background and wait until it is ready")
  .option("--port <port>", "daemon port (loopback only)")
  .action(async (options) => {
    const opts = program.opts();
    const ctx = daemonContext();
    const port = options.port ? Number(options.port) : ctx.port;
    const status = await startDaemonDetached(ctx.stateDir, port, {
      execPath: process.execPath,
      scriptPath: process.argv[1],
      configFlag: opts.config
    });
    output({ ...status, url: status.port ? `http://127.0.0.1:${status.port}` : undefined }, opts.json);
  });

daemon
  .command("stop")
  .description("gracefully stop the daemon")
  .action(async () => {
    const opts = program.opts();
    const ctx = daemonContext();
    output(await stopDaemon(ctx.stateDir), opts.json);
  });

daemon
  .command("status")
  .description("report daemon liveness and readiness")
  .action(async () => {
    const opts = program.opts();
    const ctx = daemonContext();
    output(await daemonStatus(ctx.stateDir), opts.json);
  });

daemon
  .command("run", { hidden: true })
  .description("internal: run the daemon in the foreground")
  .option("--port <port>", "daemon port (loopback only)")
  .action((options) => {
    const ctx = daemonContext();
    runDaemonForeground(ctx.stateDir, options.port ? Number(options.port) : ctx.port);
  });

const projectCmd = program.command("project").description("manage projects registered with the daemon");

projectCmd
  .command("add")
  .argument("<name>", "project name")
  .argument("[path]", "project path", ".")
  .description("register a project with the daemon")
  .action(async (name, path) => {
    const opts = program.opts();
    const ctx = daemonContext();
    await withDaemonErrors(opts.json, async () => {
      output(await daemonAddProject(ctx.stateDir, name, resolve(path)), opts.json);
    });
  });

projectCmd
  .command("list")
  .description("list projects registered with the daemon")
  .action(async () => {
    const opts = program.opts();
    const ctx = daemonContext();
    await withDaemonErrors(opts.json, async () => {
      output({ projects: await daemonListProjects(ctx.stateDir) }, opts.json);
    });
  });

const sessionCmd = program.command("session").description("manage agent sessions tracked by the daemon");

sessionCmd
  .command("list")
  .description("list daemon-tracked sessions with derived status")
  .action(async () => {
    const opts = program.opts();
    const ctx = daemonContext();
    await withDaemonErrors(opts.json, async () => {
      output({ sessions: await daemonListSessions(ctx.stateDir) }, opts.json);
    });
  });

sessionCmd
  .command("kill")
  .argument("<id>", "session id")
  .description("terminate a daemon-tracked session (kills its tmux session)")
  .action(async (id) => {
    const opts = program.opts();
    const ctx = daemonContext();
    await withDaemonErrors(opts.json, async () => {
      output(await daemonKillSession(ctx.stateDir, id), opts.json);
    });
  });

async function withDaemonErrors(json: boolean, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) console.log(JSON.stringify({ error: message }));
    else console.error(message);
    process.exitCode = 1;
  }
}

program
  .command("dashboard")
  .description("start the local dashboard")
  .option("-p, --project <name>", "project name")
  .option("--port <port>", "dashboard port")
  .action((options) => {
    const opts = program.opts();
    const loaded = safeLoadConfig(opts.config, opts.json);
    if (!loaded) return;
    startDashboard(loaded, { project: options.project, port: options.port ? Number(options.port) : undefined });
  });

program.parse();

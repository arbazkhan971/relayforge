#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { configureLocalAuth, getAuthStatus } from "./auth.js";
import { defaultRunId, latestRunId, output, parseBoundedInt, reportConfigLoadError, runSucceeded, safeLoadConfig, safeLoadConfigOptional, writeIfMissing } from "./cli/support.js";
import { ConfigDiscoveryError, findConfig, getProject } from "./config/load.js";
import { assertConfigSemantics, validateConfigSemantics } from "./config/validate.js";
import { assertId } from "./ids.js";
import { startDashboard } from "./dashboard/server.js";
import { runDoctorWithControl } from "./doctor.js";
import { renderControlStatus, requireControlService } from "./control/client.js";
import { assertActiveRunLease } from "./control/cutover.js";
import { controlPaths } from "./control/runfile.js";
import {
  getControlServiceStatus,
  startControlService,
  stopControlService,
  type ControlServiceHandle
} from "./control/service.js";
import { writeIntelligence } from "./intelligence.js";
import { discoverPanes, renderOnce, startMonitor } from "./monitor.js";
import { assertOrdinaryExecuteNativeAdapterPreflight } from "./adapters/native-product-preflight.js";
import { finalLoopState, prepareRun, runAutonomyLoop, selectLoop, writeRolePrompts } from "./orchestrator.js";
import { packageVersion } from "./metadata.js";
import { assertRelayForgeEnvironmentCompatibility, invokedRelayForgeCommand, RELAYFORGE_COMMAND, RELAYFORGE_LEGACY_COMMANDS, RELAYFORGE_PRODUCT_NAME } from "./identity.js";
import { requestCancel } from "./runtime.js";
import { listSmeDisciplines } from "./sme.js";
import { createSteeringCommandId } from "./steering/schema.js";
import { createParentSteeringService } from "./steering/service.js";
import {
  SteeringIpcError,
  sendSteeringIpcRequest,
  startSteeringIpcServer,
  steeringIpcAdmitRequest,
  steeringIpcWithdrawRequest
} from "./steering/ipc.js";
import { chooseStarterProvider, starterBrief, starterConfig, StarterProvider } from "./starter.js";
import { attachSession, capturePane, isSafeTmuxName, listSessions, paneTitle, sessionName, startProjectSessions, stopRun, tmuxClient } from "./tmux.js";
import { detectHost, killViewport, openViewport, planViewport, pruneViewport, showViewport, TmuxExit } from "./tmux-workflow.js";
import {
  markRunViewportsExited,
  openViewportRegistry,
  pruneRegistryViewports,
  recordOpenedViewport,
  resolveAttach,
  viewportStateDir
} from "./viewport-wiring.js";
import {
  assertMultiRepositoryExecutionPreflight,
  createMultiRepositoryRunAuthority
} from "./multirepo/runtime.js";
import { createParentTranscriptRuntimeAuthority } from "./observability/runtime-authority.js";
import { createParentScmProductAuthority, type ParentScmProductAuthority } from "./scm/product-authority.js";
import { createControlRoomClient, type ControlRoomClient } from "./control-room/client.js";
import { createControlServiceControlRoomTransport } from "./control-room/control-service-transport.js";
import { buildControlRoomViewModel } from "./control-room/view-model.js";

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

function controlCommandError(error: unknown, asJson: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  if (asJson) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  else console.error(message);
  process.exitCode = 1;
}

function steeringCommandError(error: unknown, asJson: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof SteeringIpcError ? error.code : "INVALID_REQUEST";
  if (asJson) console.log(JSON.stringify({ ok: false, code, error: message }, null, 2));
  else console.error(`${code}: ${message}`);
  process.exitCode = 1;
}

/** Keep the command pending until a graceful signal/runtime close completes in lifecycle order. */
function runForegroundService(handle: ControlServiceHandle, asJson: boolean, label: string): Promise<void> {
  if (asJson) {
    console.log(JSON.stringify({
      ready: true,
      service: "relayforge-control",
      instanceId: handle.runFile.instanceId,
      host: handle.address.host,
      port: handle.address.port,
      url: handle.address.url
    }));
  } else {
    console.log(`RelayForge ${label}: ${handle.address.url} (foreground; loopback only)`);
  }
  return new Promise<void>((resolvePromise) => {
    let closing = false;
    const cleanup = (): void => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      handle.server.nodeServer.off("error", onRuntimeError);
    };
    const close = (failed: boolean): void => {
      if (closing) return;
      closing = true;
      if (failed) process.exitCode = 1;
      void handle.shutdown().then(
        () => {
          cleanup();
          resolvePromise();
        },
        (error) => {
          cleanup();
          controlCommandError(error, asJson);
          resolvePromise();
        }
      );
    };
    const onSignal = (): void => close(false);
    const onRuntimeError = (error: Error): void => {
      controlCommandError(new Error(`The control listener failed at runtime: ${error.message}`), asJson);
      close(true);
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    handle.server.nodeServer.once("error", onRuntimeError);
  });
}

program
  .name(RELAYFORGE_COMMAND)
  .description(`${RELAYFORGE_PRODUCT_NAME}: safe, end-to-end AI agent team orchestration (tmux is an optional viewport)`)
  .version(packageVersion, "-V, --version", `output the ${RELAYFORGE_PRODUCT_NAME} version`)
  .option("-c, --config <path>", "exact path to relayforge.config.* or legacy loop.config.*")
  .option("--json", "print machine-readable JSON");

program
  .command("init")
  .description("create relayforge.config.yaml and starter files without replacing an existing config")
  .option("-f, --force", "overwrite auxiliary starter files (never a config or .loop state)")
  .option("--provider <type>", "force a provider: claude | codex | gemini | custom")
  .action((options) => {
    const root = process.cwd();
    let existingConfigs: readonly string[] = [];
    try {
      existingConfigs = [findConfig(root)];
    } catch (error) {
      if (!(error instanceof ConfigDiscoveryError) || error.code !== "CONFIG_NOT_FOUND") {
        if (error instanceof ConfigDiscoveryError && error.code === "CONFIG_AMBIGUOUS") {
          existingConfigs = error.candidates;
        } else {
          reportConfigLoadError(error, Boolean(program.opts().json));
          return;
        }
      }
    }
    if (existingConfigs.length) {
      const code = existingConfigs.length > 1 ? "CONFIG_AMBIGUOUS" : "CONFIG_ALREADY_EXISTS";
      const message = `${code}: init refuses to overwrite or compete with existing config: ${existingConfigs.join(", ")}`;
      if (program.opts().json) output({ ok: false, code, error: message }, true);
      else console.error(message);
      process.exitCode = 1;
      return;
    }
    const override = options.provider as StarterProvider | undefined;
    if (override && !["claude", "codex", "gemini", "custom"].includes(override)) {
      console.error(`Unknown --provider ${override}. Use one of: claude, codex, gemini, custom.`);
      process.exitCode = 1;
      return;
    }
    const choice = chooseStarterProvider(override);
    writeIfMissing(resolve(root, "relayforge.config.yaml"), starterConfig(choice.provider, choice.detected, Boolean(override)), false);
    writeIfMissing(resolve(root, "brief.md"), starterBrief(), Boolean(options.force));
    mkdirSync(resolve(root, ".loop"), { recursive: true });
    ensureGitignore(root, [".loop/", "PROJECT-INTELLIGENCE.md"]);
    console.log("Created relayforge.config.yaml, brief.md, and .loop/");
    console.log(`Provider: ${choice.provider}${choice.installed ? " (detected)" : " (not detected locally)"}.`);
    if (choice.detected.length) console.log(`Installed provider CLIs: ${choice.detected.join(", ")}.`);
    if (!choice.installed && choice.provider !== "custom") {
      console.log(`Tip: install the ${choice.provider} CLI, or re-run \`relayforge init --provider <type>\`. Dry-run works without any provider.`);
    }
    console.log("Next: `relayforge validate`, then `relayforge doctor`, then `relayforge run \"<goal>\"` (add --execute to launch agents).");
  });

program
  .command("doctor")
  .description("check environment, config, and provider readiness with actionable fixes")
  .option("-p, --project <name>", "project name")
  .action(async (options) => {
    const opts = program.opts();
    let loaded;
    try {
      loaded = safeLoadConfigOptional(opts.config);
    } catch (error) {
      reportConfigLoadError(error, Boolean(opts.json));
      return;
    }
    const report = await runDoctorWithControl(loaded, process.cwd(), options.project);
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

const serveCommand = program
  .command("serve")
  .description("run the foreground loopback control service (dashboard + read-only API + durable events)")
  .option("-p, --project <name>", "project displayed by the dashboard")
  .option("--port <port>", "control service port")
  .action(async (options) => {
    const opts = program.opts();
    const loaded = safeLoadConfig(opts.config, Boolean(opts.json));
    if (!loaded) return;
    let port: number | undefined;
    try {
      port = options.port === undefined ? undefined : parseBoundedInt(options.port, "--port", 1, 65_535);
      assertConfigSemantics(loaded);
      await runForegroundService(
        await startControlService(loaded, { port, dashboardProject: options.project }),
        Boolean(opts.json),
        "control service"
      );
    } catch (error) {
      controlCommandError(error, Boolean(opts.json));
    }
  });

serveCommand
  .command("status")
  .description("inspect the exact held owner and fetch its bounded versioned status")
  .option("--json", "print the exact versioned status DTO")
  .option("--timeout <ms>", "bounded attach and request timeout", "2000")
  .action(async (options) => {
    const opts = program.opts();
    const asJson = Boolean(opts.json || options.json);
    const loaded = safeLoadConfig(opts.config, asJson);
    if (!loaded) return;
    try {
      const timeoutMs = parseBoundedInt(options.timeout, "--timeout", 1, 60_000);
      const status = await getControlServiceStatus(loaded, { timeoutMs });
      if (asJson) output(status, true);
      else console.log(renderControlStatus(status));
    } catch (error) {
      controlCommandError(error, asJson);
    }
  });

serveCommand
  .command("stop")
  .description("gracefully stop only the twice-verified exact control process incarnation")
  .option("--json", "print machine-readable output")
  .option("--timeout <ms>", "bounded graceful shutdown timeout", "7000")
  .action(async (options) => {
    const opts = program.opts();
    const asJson = Boolean(opts.json || options.json);
    const loaded = safeLoadConfig(opts.config, asJson);
    if (!loaded) return;
    try {
      const timeoutMs = parseBoundedInt(options.timeout, "--timeout", 1, 60_000);
      const result = await stopControlService(loaded, { timeoutMs });
      if (asJson) output(result, true);
      else console.log(`Stopped RelayForge control service ${result.instanceId.slice(0, 12)} (pid ${result.pid}).`);
    } catch (error) {
      controlCommandError(error, asJson);
    }
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
    let loaded;
    try {
      loaded = safeLoadConfigOptional(opts.config);
    } catch (error) {
      reportConfigLoadError(error, Boolean(opts.json));
      return;
    }
    if (loaded && !options.dir) {
      const project = getProject(loaded, options.project);
      scanDir = resolve(loaded.rootDir, project.workingDir);
      outPath = resolve(scanDir, project.intelligence);
    }
    const intel = writeIntelligence(scanDir, outPath);
    output({ wrote: outPath, name: intel.name, languages: intel.languages, frameworks: intel.frameworks, commands: intel.commands }, opts.json);
  });

const steer = program
  .command("steer")
  .description("admit or withdraw parent steering for a future immutable attempt prompt");

steer
  .command("new-id")
  .description("mint a caller-owned stable UUIDv7 command ID; save it and reuse it for exact retries")
  .action(() => {
    const opts = program.opts();
    const commandId = createSteeringCommandId();
    output({ commandId, note: "Reuse this exact ID for every retry of the same immutable command." }, opts.json);
  });

steer
  .command("admit")
  .description("durably admit or refuse one parent command; admission does not mean prompt inclusion or delivery")
  .option("-p, --project <name>", "project name")
  .requiredOption("-r, --run <id>", "exact run id")
  .requiredOption("--run-epoch <id>", "exact run epoch from the active canonical projection")
  .requiredOption("--command-id <uuidv7>", "stable UUIDv7 request/command ID; reuse unchanged on retry")
  .requiredOption("--task-id <id>", "exact task id")
  .requiredOption("--task-generation <n>", "exact positive task generation")
  .requiredOption("--session-id <id>", "exact session id")
  .requiredOption("--session-generation <n>", "exact positive session generation")
  .requiredOption("--not-before-attempt <n>", "first attempt generation eligible to include this command")
  .requiredOption("--body <text>", "bounded command body for a future prompt boundary")
  .option("--evidence <event-id...>", "canonical evidence event IDs", [])
  .option("--expires-at <timestamp>", "explicit RFC 3339 expiry")
  .option("--supersedes <uuidv7>", "pending command ID this command supersedes")
  .action(async (options) => {
    const opts = program.opts();
    const loaded = safeLoadConfig(opts.config, opts.json);
    if (!loaded) return;
    try {
      assertConfigSemantics(loaded);
      assertId("run", options.run);
      const project = getProject(loaded, options.project);
      const request = steeringIpcAdmitRequest({
        schemaVersion: 1,
        commandId: options.commandId,
        runId: options.run,
        runEpoch: options.runEpoch,
        taskId: options.taskId,
        taskGeneration: parseBoundedInt(options.taskGeneration, "--task-generation", 1, Number.MAX_SAFE_INTEGER),
        sessionId: options.sessionId,
        sessionGeneration: parseBoundedInt(options.sessionGeneration, "--session-generation", 1, Number.MAX_SAFE_INTEGER),
        notBeforeAttemptGeneration: parseBoundedInt(options.notBeforeAttempt, "--not-before-attempt", 1, Number.MAX_SAFE_INTEGER),
        kind: "steer_next_boundary",
        evidenceRefs: options.evidence,
        body: options.body,
        expiresAt: options.expiresAt,
        supersedesCommandId: options.supersedes
      });
      const runDir = resolve(loaded.rootDir, loaded.config.defaults.runDir, project.name, options.run);
      const result = await sendSteeringIpcRequest(request, { runDir });
      if (result.decision === "admitted") {
        output({
          ok: true,
          requestId: request.requestId,
          commandId: result.commandId,
          decision: "admitted",
          label: "Pending",
          seq: result.seq,
          bodySha256: result.command.bodySha256,
          note: "Durably admitted for a future safe prompt boundary; not yet Included, delivered, read, processed, or obeyed."
        }, opts.json);
      } else {
        output({
          ok: true,
          requestId: request.requestId,
          commandId: result.commandId,
          decision: "refused",
          label: "Refused",
          seq: result.seq,
          reasonCode: result.refusal.reasonCode,
          observedActivity: result.refusal.observedActivity,
          note: "Durably refused; this command will not be included."
        }, opts.json);
      }
    } catch (error) {
      steeringCommandError(error, Boolean(opts.json));
    }
  });

steer
  .command("withdraw")
  .description("withdraw one still-pending command; included or otherwise terminal commands refuse withdrawal")
  .option("-p, --project <name>", "project name")
  .requiredOption("-r, --run <id>", "exact run id")
  .requiredOption("--run-epoch <id>", "exact run epoch from the active canonical projection")
  .requiredOption("--command-id <uuidv7>", "stable command ID to withdraw and to reuse on exact retry")
  .option("--reason <text>", "bounded operator reason")
  .action(async (options) => {
    const opts = program.opts();
    const loaded = safeLoadConfig(opts.config, opts.json);
    if (!loaded) return;
    try {
      assertConfigSemantics(loaded);
      assertId("run", options.run);
      const project = getProject(loaded, options.project);
      const request = steeringIpcWithdrawRequest(
        { runId: options.run, runEpoch: options.runEpoch },
        { schemaVersion: 1, commandId: options.commandId, reason: options.reason }
      );
      const runDir = resolve(loaded.rootDir, loaded.config.defaults.runDir, project.name, options.run);
      const result = await sendSteeringIpcRequest(request, { runDir });
      output({
        ok: true,
        requestId: request.requestId,
        commandId: result.commandId,
        status: result.status,
        label: "Withdrawn",
        seq: result.seq,
        reason: result.reason ?? null,
        note: "The command was pending and is now terminal; it was not included by this withdrawal."
      }, opts.json);
    } catch (error) {
      steeringCommandError(error, Boolean(opts.json));
    }
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

    // Validate every caller-controlled scalar before prepareRun acquires the configuration/run
    // authorities or creates any run state. A malformed option must be a zero-mutation refusal.
    let maxIterations: number | undefined;
    if (options.maxIterations !== undefined) {
      try {
        maxIterations = parseBoundedInt(options.maxIterations, "--max-iterations", 1, 1_000);
      } catch (error) {
        die(error);
        return;
      }
    }

    // Structured native adapters (opencode/pi/grok) need parent-contained compatibility evidence.
    // Ordinary CLI has no evidence injection path into RunContext, so refuse execute before any
    // prepareRun mutation (run dir, control, worktree) and before host capability probes that would
    // otherwise surface as PATH/sandbox noise. Dry-run stays accepted and launches nothing.
    try {
      const loop = selectLoop(project, options.loop);
      assertOrdinaryExecuteNativeAdapterPreflight(project, loop, Boolean(options.execute));
    } catch (error) {
      die(error);
      return;
    }

    // P6's stronger empty-root/PID/network boundary is a host capability, not something cutover can
    // repair. Refuse it while the command is still read-only: no run directory, lease, ControlStore,
    // worktree, reservation, or provider process may exist on an unsupported/replaced runtime.
    try {
      assertMultiRepositoryExecutionPreflight(project, Boolean(options.execute));
    } catch (error) {
      die(error);
      return;
    }

    let ctx;
    try {
      // Plan-only dry-runs skip the money ledger when the host cannot pin one (macOS), so a first
      // `relayforge run "<goal>"` works on any machine. --execute keeps every strong-host gate.
      ctx = prepareRun(loaded, project, options.run, goal, options.loop, Boolean(options.execute));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
      return;
    }
    if (maxIterations !== undefined) ctx.loop.maxIterations = maxIterations;

    // NOTE: `relayforge run` never writes PROJECT-INTELLIGENCE.md into the checkout — only
    // `relayforge learn`
    // may write project intelligence. Planning happens INSIDE the run (after the clean gate and
    // integration worktree exist), so no provider ever runs against the human's checked-out tree.
    const roleFiles = writeRolePrompts(ctx);

    if (!opts.json) {
      console.log(`\n🛰  Run ${ctx.runId} · ${project.name} · loop ${ctx.loop.name}${options.execute ? "" : " (dry-run — no provider launched)"}`);
      console.log(`Goal: ${goal}`);
      console.log(`Team: ${project.roles.length} role(s). Monitor: relayforge monitor --run ${ctx.runId}\n`);
    }

    let reports;
    let runScmAuthority: ParentScmProductAuthority | undefined;
    try {
      reports = await runAutonomyLoop(ctx, roleFiles, {
        execute: Boolean(options.execute),
        startParentAuthority: async ({ store, runId, runEpoch, runDir }) => {
          const assertAuthority = (): void => {
            if (ctx.controlAuthority?.store !== store) throw new Error("canonical steering store is no longer bound to this run parent");
            const controlOwnership = ctx.controlOwnership;
            const runLease = ctx.runLease;
            if (!controlOwnership || !runLease || ctx.activeLeaseId !== runLease.nonce) {
              throw new Error("parent steering requires the active control-lease -> run-lease chain");
            }
            controlOwnership.assertHeld();
            assertActiveRunLease(runDir, runLease.nonce);
          };
          const service = createParentSteeringService({
            store,
            authority: {
              principal: typeof process.geteuid === "function" ? `operator-uid-${process.geteuid()}` : "local-operator",
              sourceKind: "operator"
            }
          });
          const transcriptAuthority = createParentTranscriptRuntimeAuthority({
            store,
            runDir,
            actorId: ctx.loop.orchestrator
          });
          let controlRuntimeError: Error | undefined;
          let controlService: Awaited<ReturnType<typeof startControlService>> | undefined;
          let steeringServer: Awaited<ReturnType<typeof startSteeringIpcServer>> | undefined;
          try {
            runScmAuthority = project.scm === undefined ? undefined : createParentScmProductAuthority({
              project,
              configRoot: loaded.rootDir,
              store,
              steering: service,
              actorId: ctx.loop.orchestrator,
              environment: process.env
            });
            controlService = await startControlService(loaded, {
              dashboardProject: project.name,
              controlOwnership: ctx.controlOwnership,
              borrowedSources: {
                projects: () => [{ project: project.name, runs: [store] }]
              },
              onRuntimeError(error) { controlRuntimeError ??= error; }
            });
            steeringServer = await startSteeringIpcServer({
              runDir,
              runId,
              runEpoch,
              service,
              assertAuthority
            });
          } catch (error) {
            // Startup is transactional with respect to borrowed lifetimes: unwind every component
            // that became reachable before returning no handle to the orchestrator.
            for (const close of [
              () => steeringServer?.closeAndDrain(),
              () => controlService?.shutdown(),
              () => runScmAuthority?.closeAndDrain(),
              () => transcriptAuthority.closeAndDrain()
            ]) {
              try { await close(); } catch { /* the original startup refusal remains authoritative */ }
            }
            runScmAuthority = undefined;
            throw error;
          }
          if (controlService === undefined || steeringServer === undefined) {
            throw new Error("parent authority startup returned without complete owned services");
          }
          const ownedControlService = controlService;
          const ownedSteeringServer = steeringServer;
          let closePromise: Promise<void> | undefined;
          return Object.freeze({
            openTranscriptObservation: (input: Parameters<typeof transcriptAuthority.open>[0]) => transcriptAuthority.open(input),
            closeAndDrain() {
              closePromise ??= (async () => {
                let first: unknown = controlRuntimeError;
                for (const close of [
                  () => runScmAuthority?.closeAndDrain(),
                  () => transcriptAuthority.closeAndDrain(),
                  () => ownedSteeringServer.closeAndDrain(),
                  () => ownedControlService.shutdown()
                ]) {
                  try { await close(); } catch (error) { first ??= error; }
                }
                runScmAuthority = undefined;
                if (first !== undefined) throw first;
              })();
              return closePromise;
            }
          });
        },
        ...(project.multiRepository === undefined ? {} : {
          startMultiRepositoryAuthority: (authorityContext: Parameters<typeof createMultiRepositoryRunAuthority>[1]) => {
            const publicationConfigured = project.multiRepository!.tasks.some((task) => task.publication !== undefined);
            if (publicationConfigured && runScmAuthority === undefined) {
              throw new Error("multi-repository publication requires an initialized parent SCM authority");
            }
            return createMultiRepositoryRunAuthority(ctx, authorityContext, publicationConfigured
              ? { publicationAdapter: runScmAuthority!.publicationAdapterForRun() }
              : {});
          }
        }),
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

    // The legacy state file is permanently retired after control-store cutover. Consume the
    // canonical snapshot captured while runAutonomyLoop still held its store and both leases.
    const finalState = finalLoopState(ctx);

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
        monitor: `relayforge monitor --run ${ctx.runId}`,
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
  .action(async (options) => {
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
      console.error("No runs found. Start one with `relayforge run \"<goal>\"`.");
      process.exitCode = 1;
      return;
    }
    const boardDir = resolve(runsDir, runId, "board");
    const namespace = loaded.config.defaults.namespace;
    const session = sessionName(namespace, project.name, runId, "team");
    const panes = discoverPanes(session);
    let controlRoomClient: ControlRoomClient | undefined;
    try {
      const attachment = await requireControlService(controlPaths(loaded.rootDir, loaded.path));
      controlRoomClient = createControlRoomClient({
        transport: createControlServiceControlRoomTransport({ attachment, project: project.name, run: runId })
      });
      await controlRoomClient.start();
    } catch {
      // A completed/legacy run may have no active parent read authority. Do not reopen its store or
      // infer activity from board/tmux bytes: the renderer's explicit unknown state is fail-closed.
      controlRoomClient?.stop();
      controlRoomClient = undefined;
    }
    const monitorOpts = {
      boardDir,
      session,
      panes,
      intervalMs,
      ...(controlRoomClient === undefined
        ? {}
        : { controlRoom: () => buildControlRoomViewModel(controlRoomClient!.state()) })
    };
    if (options.once) {
      console.log(renderOnce(monitorOpts));
      controlRoomClient?.stop();
      return;
    }
    startMonitor(monitorOpts, () => controlRoomClient?.stop());
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
    let roleHint: string | undefined;
    const loaded = safeLoadConfig(opts.config, opts.json);
    if (loaded) {
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
      if (!runId && !session) {
        console.error("No runs found to attach to. Start one with `relayforge run`.");
        process.exitCode = 1;
        return;
      }
      if (runId) {
        const defaultSession = sessionName(loaded.config.defaults.namespace, project.name, runId, "team");
        try {
          // Phase 2: durable viewport facts resolve attach targets (role or exact name);
          // a registry failure degrades to the legacy default team session.
          const resolution = resolveAttach(openViewportRegistry(runsDir, runId), {
            runId,
            arg: session,
            defaultSession
          });
          session = resolution.session;
          if (resolution.kind === "role") roleHint = resolution.role;
        } catch {
          session = session ?? defaultSession;
        }
      }
    } else if (!session) {
      console.error("No RelayForge config found to resolve a session.");
      process.exitCode = 1;
      return;
    }
    if (!session) {
      console.error("No run session found to attach to.");
      process.exitCode = 1;
      return;
    }
    if (roleHint) console.log(`Attaching to role ${roleHint} (${session})`);
    else if (sessionArg) console.log(`Attaching to session ${session}`);
    try {
      process.exitCode = attachSession(session);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

// ---------------------------------------------------------------------------
// `relayforge tmux` — the OPTIONAL viewport, as one coherent verb group.
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
  1  error                  3  a foreign (non-RelayForge) session holds the name
                            4  nothing found

Examples:
  $ relayforge tmux pre                  # pre-flight: what would "relayforge tmux new" do? (mutates nothing)
  $ relayforge tmux new                  # open the latest run's viewport and attach (idempotent)
  $ relayforge tmux new -r bug-42 --no-attach
  $ relayforge tmux show --capture 40    # owned sessions + the last 40 lines of each
  $ relayforge tmux kill -r bug-42       # kill only this run's RelayForge-owned sessions
  $ relayforge tmux prune --dry-run      # what stale viewports would be reaped?

tmux is an OPTIONAL viewport. RelayForge always runs headless; "relayforge monitor" needs no tmux at all.`
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
  console.error("No runs found for this project. Start one first: `relayforge run \"<goal>\" --execute` (or `relayforge start` for a prompt-only viewport).");
  process.exitCode = TmuxExit.NOT_FOUND;
  return false;
}

const viewportOptions = <T extends Command>(cmd: T): T => {
  cmd.option("-p, --project <name>", "project name");
  cmd.option("-r, --run <id>", "run id (defaults to the most recent run)");
  return cmd;
};

viewportOptions(tmuxCmd.command("pre").aliases(["preview", "plan"]))
  .description("pre-flight: print exactly what `relayforge tmux new` would do — creates and changes NOTHING")
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
    console.log(`${plan.ok ? "✓" : "✗"} relayforge tmux new · run ${ctx.runId} · project ${ctx.project.name}`);
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
    // Phase 2: record the opened session as a durable daemon-owned fact (best-effort bookkeeping).
    try {
      recordOpenedViewport(openViewportRegistry(ctx.runsDir, ctx.runId!), {
        runId: ctx.runId!,
        roles: ctx.roles.map((pane) => pane.name),
        session: result.session,
        ownerPid: process.pid
      });
    } catch (error) {
      console.error(`(viewport registry note: ${error instanceof Error ? error.message : String(error)})`);
    }
  });

viewportOptions(tmuxCmd.command("show").aliases(["ls"]))
  .description("list RelayForge-owned tmux sessions: liveness, panes, and (with --capture) recent output")
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
    if (report.sessions.some((s) => s.dead || s.orphan)) console.log("\nStale viewports found — reap them with `relayforge tmux prune`.");
  });

viewportOptions(tmuxCmd.command("kill"))
  .description("kill this run's RelayForge-owned tmux sessions (never a foreign session)")
  .option("-a, --all", "kill every RelayForge-owned session for the project")
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
    if (!report.killed.length) console.log(report.reason ?? "No RelayForge-owned sessions matched — nothing killed.");
    else for (const name of report.killed) console.log(`killed ${name}`);
    // Phase 2: mark the killed run's durable viewport facts exited (best-effort bookkeeping).
    try {
      if (ctx.runId) {
        markRunViewportsExited(openViewportRegistry(ctx.runsDir, ctx.runId), ctx.runId);
      } else if (options.all) {
        if (existsSync(ctx.runsDir)) {
          for (const run of readdirSync(ctx.runsDir)) {
            if (!existsSync(viewportStateDir(ctx.runsDir, run))) continue;
            try {
              markRunViewportsExited(openViewportRegistry(ctx.runsDir, run), run);
            } catch { /* best-effort */ }
          }
        }
      }
    } catch { /* best-effort: bookkeeping never changes kill semantics */ }
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
    // Phase 2: also reap stale durable viewport facts (exited past the age bound).
    try {
      const pruneFacts = (runId: string): void => {
        if (!existsSync(viewportStateDir(ctx.runsDir, runId))) return;
        pruneRegistryViewports(openViewportRegistry(ctx.runsDir, runId));
      };
      if (ctx.runId) pruneFacts(ctx.runId);
      else if (existsSync(ctx.runsDir)) {
        for (const run of readdirSync(ctx.runsDir)) {
          try {
            pruneFacts(run);
          } catch { /* best-effort */ }
        }
      }
    } catch { /* best-effort: bookkeeping never changes prune semantics */ }
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
  .description("validate the RelayForge config (schema + semantic references)")
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
  .description("write detected local provider auth settings into the selected config")
  .option("-p, --project <name>", "project name")
  .option("--write", "write detected settings")
  .action((options) => {
    const opts = program.opts();
    const loaded = safeLoadConfig(opts.config, opts.json);
    if (!loaded) return;
    const project = getProject(loaded, options.project);
    if (!options.write) {
      output({ project: project.name, dryRun: true, message: "Run `relayforge auth configure --write` to update the selected config.", providers: getAuthStatus(project) }, opts.json);
      return;
    }
    output({ project: project.name, updated: loaded.path, providers: configureLocalAuth(loaded, project.name) }, opts.json);
  });

program
  .command("start")
  .description("open a prompt-only tmux viewport for a project team (observational; use `relayforge run --execute` to actually run agents safely)")
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
  .description("list RelayForge-owned tmux sessions")
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
    requestCancel(runDir, "stopped via `relayforge stop`");
    // Metadata-owned kill: only sessions THIS project+run created. The old substring match on
    // `-<run>-` could reach a different project's session (or a human's own).
    const killed = stopRun(loaded.config.defaults.namespace, project.name, run);
    output({ run, project: project.name, cancelled: true, killed }, opts.json);
  });

program
  .command("dashboard")
  .description("start the foreground control service with its local dashboard (compatibility alias)")
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
      await runForegroundService(
        await startDashboard(loaded, { project: options.project, port }),
        Boolean(opts.json),
        "dashboard"
      );
    } catch (error) {
      controlCommandError(error, Boolean(opts.json));
    }
  });

const invokedCommand = invokedRelayForgeCommand();
if (
  invokedCommand &&
  RELAYFORGE_LEGACY_COMMANDS.includes(invokedCommand as "loop" | "loop-orchestrator") &&
  process.stderr.isTTY &&
  !process.argv.includes("--json") &&
  !process.argv.includes("--version") &&
  !process.argv.includes("-V")
) {
  console.error(`RelayForge: ${invokedCommand} is a deprecated v1 command alias; use relayforge.`);
}

let environmentCompatible = true;
try {
  assertRelayForgeEnvironmentCompatibility();
} catch (error) {
  environmentCompatible = false;
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ok: false, code: "ENV_CONFLICT", error: message }, null, 2));
  } else {
    console.error(message);
  }
  process.exitCode = 1;
}
if (environmentCompatible) await program.parseAsync();

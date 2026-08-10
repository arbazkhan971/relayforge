import { spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { basename, resolve } from "node:path";
import { getAuthStatus } from "./auth.js";
import { configCandidatesInDirectory, LoadedConfig } from "./config/load.js";
import { validateConfigSemantics } from "./config/validate.js";
import { getProject } from "./config/load.js";
import { sandboxInfo } from "./sandbox.js";
import { scopeInfo } from "./scope.js";
import { isCleanWorktree, worktreesSupported } from "./worktree.js";
import { inspectProvisioning, type ProvisionIssue, type ProvisionSpec } from "./provision.js";
import { cachedLinuxVerifierCgroupCapability } from "./cgroup-delegation-linux.js";
import {
  fetchControlStatus,
  inspectControlService,
  type ControlServiceInspection,
  type InspectControlServiceOptions
} from "./control/client.js";
import { probeControlLease, type ControlLeaseProbe } from "./control/lease.js";
import { controlPaths, readControlRunFile, type RunFileRead } from "./control/runfile.js";
import { selectShippedAdapter, shippedAdapterConfigSha256 } from "./adapters/bootstrap.js";
import { inspectAdapterRuntimeFile, sameRuntimeFileEvidence } from "./adapters/runtime.js";
import type { AdapterAvailability, AdapterRoleName } from "./adapters/types.js";
import { resolveRelayForgeEnvironment } from "./identity.js";

export type DoctorCheck = { name: string; status: "ok" | "warn" | "fail"; detail: string; fix?: string };
export type DoctorReport = { ok: boolean; checks: DoctorCheck[] };
export type AdapterDoctorEvidence = Readonly<Record<string, AdapterAvailability>>;

export type ControlDoctorAdapters = {
  probeLease?: (path: string) => ControlLeaseProbe;
  readRunFile?: (path: string) => RunFileRead;
  inspectService?: (options: InspectControlServiceOptions) => Promise<ControlServiceInspection>;
  fetchStatus?: typeof fetchControlStatus;
  timeoutMs?: number;
};

function has(command: string): { ok: boolean; version?: string } {
  // Non-login shell so process.env.PATH is authoritative (login shells reload profile PATH).
  const path = spawnSync("bash", ["-c", `command -v '${command.replaceAll("'", "'\\''")}'`], {
    encoding: "utf8",
    env: process.env
  });
  if (path.status !== 0) return { ok: false };
  // tmux reports its version with -V, not --version.
  const flag = command === "tmux" ? "-V" : "--version";
  const v = spawnSync(command, [flag], { encoding: "utf8", timeout: 5000 });
  return { ok: true, version: ((v.stdout || v.stderr) ?? "").trim().split("\n")[0] };
}

function renderHumanPath(path: string): string {
  return path.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (codePoint) => `\\u{${codePoint.codePointAt(0)!.toString(16)}}`);
}

/**
 * Safe diagnostic context for the selected loaded config: basename only (never an absolute
 * secret-bearing path), with Cc/Cf/Zl/Zp rendered as visible bounded ASCII escapes.
 * Preserves the real selected identity (relayforge.config.* or legacy loop.config.*).
 */
function renderSelectedConfigContext(configPath: string): string {
  return renderHumanPath(basename(configPath));
}

function provisionIssueDetail(loopName: string, specs: readonly ProvisionSpec[], issue: ProvisionIssue): string {
  const indexText = issue.path?.split(".", 1)[0];
  const index = indexText !== undefined && /^\d+$/.test(indexText) ? Number(indexText) : undefined;
  const configuredPath = index !== undefined ? specs[index]?.path : undefined;
  const location = issue.path ? `provision.${issue.path}` : "provision";
  return `loop ${loopName}${configuredPath ? ` path ${renderHumanPath(configuredPath)}` : ""} ${location}: [${issue.code}] ${issue.message}`;
}

/**
 * Actionable environment/config diagnostics. Returns a check list plus an overall `ok`. A
 * `warn` never fails the report (tmux is optional, no config yet is fine); only `fail` does.
 */
export function runDoctor(
  loaded: LoadedConfig | undefined,
  cwd: string,
  projectName?: string,
  adapterEvidence: AdapterDoctorEvidence = {}
): DoctorReport {
  const checks: DoctorCheck[] = [];

  // Node 20 LTS or >=22 (kept exact with package engines; Node 21 is intentionally unsupported).
  const major = Number(process.versions.node.split(".")[0]);
  checks.push(
    major === 20 || major >= 22
      ? { name: "node", status: "ok", detail: `Node ${process.versions.node}` }
      : { name: "node", status: "fail", detail: `Node ${process.versions.node}`, fix: "RelayForge requires Node 20.x or >=22. Upgrade Node." }
  );

  const git = has("git");
  checks.push(
    git.ok
      ? { name: "git", status: "ok", detail: git.version ?? "installed" }
      : { name: "git", status: "fail", detail: "git not found", fix: "Install git — execution needs it for isolated worktrees." }
  );

  const tmux = has("tmux");
  checks.push(
    tmux.ok
      ? { name: "tmux", status: "ok", detail: tmux.version ?? "installed" }
      : { name: "tmux", status: "warn", detail: "tmux not found", fix: "tmux is an optional viewport only. Install it to watch agents live; the loop runs without it." }
  );

  // "tmux is installed" and "the viewport is switched on" are different facts with different fixes —
  // a user staring at `loop tmux new` exiting 2 needs to know WHICH one is false.
  if (tmux.ok) {
    const configOff = loaded?.config.defaults.viewport === false;
    const envOff = resolveRelayForgeEnvironment("TMUX") === "off";
    checks.push(
      configOff || envOff
        ? {
            name: "tmux-viewport",
            status: "warn",
            detail: envOff ? "disabled by RELAYFORGE_TMUX=off (or legacy LOOP_TMUX=off)" : "disabled by defaults.viewport: false",
            fix: envOff ? "Unset RELAYFORGE_TMUX/LOOP_TMUX to use `relayforge tmux new`. RelayForge runs headless either way." : "Set `defaults.viewport: true` in the selected config to use `relayforge tmux new`."
          }
        : { name: "tmux-viewport", status: "ok", detail: "enabled — `relayforge tmux new` opens the run's viewport" }
    );
  }

  // Git target cleanliness (the human gate for --execute).
  if (git.ok && worktreesSupported(cwd)) {
    checks.push(
      isCleanWorktree(cwd)
        ? { name: "git-target", status: "ok", detail: "working tree is clean" }
        : { name: "git-target", status: "warn", detail: "working tree has uncommitted changes", fix: "Commit or stash before `relayforge run --execute` — execution requires a clean git target." }
    );
  } else {
    checks.push({ name: "git-target", status: "warn", detail: "cwd is not a git repository", fix: "Run `git init` and commit a baseline before executing." });
  }

  // OS sandbox prerequisite for untrusted verifier execution (fails closed without one). Network
  // isolation is PART of that prerequisite, not a bonus: a verifier that can reach the network can
  // exfiltrate, so a sandbox that cannot remove the network cannot contain a verifier at all.
  const sbx = sandboxInfo();
  if (!sbx.available) {
    checks.push({
      name: "sandbox",
      status: "fail",
      detail: "no launchable OS sandbox (Linux bwrap / macOS sandbox-exec) available",
      fix: "`relayforge run --execute` FAILS CLOSED without a launchable sandbox — every provider/verifier call is contained or refused. Install/enable bwrap (Linux; needs unprivileged user namespaces) or run on macOS. There is no unsandboxed override."
    });
  } else if (!sbx.networkIsolation) {
    checks.push({
      name: "sandbox",
      status: "fail",
      detail: `${sbx.mechanism} launches, but it cannot isolate the network on this host`,
      fix: "`relayforge run --execute` FAILS CLOSED: verifier commands are AI-chosen and must run with NO network, and this host cannot create a network namespace (common in nested containers). Run on a host where `bwrap --unshare-net` works, or on macOS."
    });
  } else {
    checks.push({ name: "sandbox", status: "ok", detail: `${sbx.mechanism} (filesystem + env + network isolation)` });
  }

  // The CONTAINMENT scope: a boundary the provider's descendants cannot leave. Distinct from the sandbox
  // (which constrains what a provider may touch); this constrains what may OUTLIVE it. Without it, a
  // provider that `setsid`s a daemon leaves a live process behind that the run cannot see or kill, so
  // real execution fails closed here exactly as it does without a sandbox.
  const scope = scopeInfo();
  checks.push(
    scope.strong
      ? { name: "process-scope", status: "ok", detail: scope.detail }
      : {
          name: "process-scope",
          status: "fail",
          detail: `no strong process scope: ${scope.detail}`,
          fix: "`relayforge run --execute` FAILS CLOSED without one: a provider's descendants could escape a process group via setsid/double-fork. Run under a systemd user session with a delegated cgroup v2 (`systemd-run --user --scope relayforge run …`), or on a host with cgroup v2 delegation."
        }
  );

  const verifierCgroup = cachedLinuxVerifierCgroupCapability();
  checks.push(
    verifierCgroup?.available
      ? {
          name: "verifier-cgroup-jail",
          status: "ok",
          detail: `behaviorally proven cgroup2 jail (${verifierCgroup.runtimeIdentity.cgroupMountDevice}; strict namespaces + FD bind)`
        }
      : verifierCgroup
        ? {
            name: "verifier-cgroup-jail",
            status: "fail",
            detail: `[${verifierCgroup.reasonCode}] ${verifierCgroup.detail}`,
            fix: "Verifier execution fails closed on this host. Provide delegated cgroup v2 with nsdelegate and a trusted Bubblewrap installation; the execute preflight records the same typed refusal."
          }
        : {
            name: "verifier-cgroup-jail",
            status: "warn",
            detail: "not behaviorally probed in this process yet; --execute performs the disposable-scope probe before any verifier launch",
            fix: "Run an execute preflight on the target host to populate the runtime-identity-keyed capability result."
          }
  );

  // A missing config is a warn (run `loop init`); a config that exists but does not load is a
  // FAIL (malformed) — the two are distinct.
  if (!loaded) {
    const malformed = configCandidatesInDirectory(cwd).length > 0;
    checks.push(
      malformed
        ? { name: "config", status: "fail", detail: "a RelayForge-family config exists but is malformed / failed to load", fix: "Fix the YAML/schema errors (run `relayforge validate` for detail)." }
        : { name: "config", status: "warn", detail: "no RelayForge config found", fix: "Run `relayforge init` to create one." }
    );
    return { ok: checks.every((c) => c.status !== "fail"), checks };
  }

  const semantic = validateConfigSemantics(loaded);
  checks.push(
    semantic.length === 0
      ? { name: "config", status: "ok", detail: `${loaded.path} valid` }
      : { name: "config", status: "fail", detail: semantic.map((i) => `${i.path}: ${i.message}`).join("; "), fix: "Fix the config issues above." }
  );

  try {
    const project = getProject(loaded, projectName);

    // The selected project's workingDir must exist.
    const workingDir = resolve(loaded.rootDir, project.workingDir);
    checks.push(
      existsSync(workingDir)
        ? { name: "workingDir", status: "ok", detail: workingDir }
        : { name: "workingDir", status: "fail", detail: `workingDir does not exist: ${workingDir}`, fix: `Create it or fix projects.${project.name}.workingDir.` }
    );

    const configuredLoops = project.loops.filter((loop) => loop.provision.length > 0);
    if (configuredLoops.length === 0) {
      checks.push({ name: "provision", status: "ok", detail: "disabled — no loop provision specs configured" });
    } else {
      const failures: string[] = [];
      const ready: string[] = [];
      for (const loop of configuredLoops) {
        // Inspection is deliberately source-only and read-only: no transaction or worktree path is
        // supplied, so doctor cannot stage, publish, execute a hook, or make a network request.
        try {
          const inspection = inspectProvisioning({ sourceRoot: workingDir, specs: loop.provision });
          for (const issue of inspection.issues) failures.push(provisionIssueDetail(loop.name, loop.provision, issue));
          if (inspection.ok) {
            ready.push(
              ...inspection.inspected.map(
                (summary, index) =>
                  `loop ${loop.name} provision.${index}.path (${renderHumanPath(summary.path)}): ` +
                  `${summary.files} files, ${summary.directories} directories, ${summary.symlinks} links, ` +
                  `${summary.executables} required executables, ${summary.bytes} bytes`
              )
            );
          }
        } catch (error) {
          failures.push(
            `loop ${loop.name} provision: inspection failed safely: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      checks.push(
        failures.length === 0
          ? {
              name: "provision",
              status: "ok",
              detail: `source ready/eligible now (read-only inspection; copy not attempted): ${ready.join(", ")}`
            }
          : {
              name: "provision",
              status: "fail",
              detail: failures.join("; "),
              fix:
                `Fix each cited provision spec in ${renderSelectedConfigContext(loaded.path)}, or restore its source directory and required executable markers inside the selected project's workingDir. Sources must be real, readable directories and all links must remain internal.`
            }
      );
    }

    const legacyProviders = Object.fromEntries(
      Object.entries(project.providers).filter(([, provider]) => provider.type !== "opencode" && provider.type !== "pi" && provider.type !== "grok")
    );
    const auth = getAuthStatus({ ...project, providers: legacyProviders });
    // Headless execution needs the provider CLI on PATH. An API key WITHOUT the CLI is not ready.
    const ready = auth.filter((a) => a.cliAvailable);
    const keyOnly = auth.filter((a) => !a.cliAvailable && a.apiKeySet);
    if (ready.length) {
      checks.push({ name: "providers", status: "ok", detail: `ready: ${ready.map((a) => `${a.providerName}(${a.recommendedMode})`).join(", ")}` });
    } else if (keyOnly.length) {
      checks.push({ name: "providers", status: "warn", detail: `API key set but CLI not installed: ${keyOnly.map((a) => a.providerName).join(", ")}`, fix: "Install the provider CLI (claude/codex/gemini) — an API key alone cannot run headless turns." });
    } else {
      checks.push({ name: "providers", status: "warn", detail: "no provider CLI installed", fix: "Install a provider CLI (claude/codex/gemini). Dry-run (`relayforge run`) still works with none." });
    }

    for (const [providerName, provider] of Object.entries(project.providers)) {
      if (provider.type !== "opencode" && provider.type !== "pi" && provider.type !== "grok") continue;
      const evidence = adapterEvidence[providerName];
      if (!evidence) {
        checks.push({
          name: `adapter:${providerName}`,
          status: "warn",
          detail: `[behavioral-evidence-missing] ${provider.type} is configured but no parent-contained executable/version/protocol probe evidence is available`,
          fix: `Run the ${provider.type} real adapter conformance probe on this host; version/help output alone is not readiness evidence.`
        });
        continue;
      }
      try {
        const roleNames = new Set<AdapterRoleName>();
        const usedRoles = project.roles.filter((configuredRole) => configuredRole.provider === providerName);
        for (const configuredRole of usedRoles) {
          const readOnly = project.loops.some((loop) => loop.orchestrator === configuredRole.name || loop.reviewer === configuredRole.name);
          roleNames.add(readOnly ? "reviewer" : "worker");
        }
        if (roleNames.size === 0) roleNames.add("worker");
        const selected = selectShippedAdapter({ adapterId: provider.type, availability: evidence, role: [...roleNames][0]! });
        if (selected.availability.status === "unavailable") {
          checks.push({
            name: `adapter:${providerName}`,
            status: "warn",
            detail: `[${selected.availability.reason.code}] ${selected.availability.reason.detail}`,
            fix: `Retry according to ${selected.availability.reason.retry}; missing evidence: ${selected.availability.missingEvidence.map((item) => item.kind).join(", ") || "none"}.`
          });
          continue;
        }
        const expectedConfig = shippedAdapterConfigSha256({
          adapterId: provider.type,
          ...(provider.model === undefined ? {} : { model: provider.model }),
          environment: process.env
        });
        if (selected.availability.consultedConfigSha256 !== expectedConfig) {
          throw new Error("[compatibility-evidence-mismatch] controlled configuration changed after the probe");
        }
        const executable = inspectAdapterRuntimeFile(selected.availability.executable.runtimeName, selected.availability.executable.canonicalPath, true);
        if (!sameRuntimeFileEvidence(executable, selected.availability.executable)) {
          throw new Error("[executable-identity-changed] canonical executable changed after the probe");
        }
        for (const roleName of roleNames) {
          const decision = selectShippedAdapter({ adapterId: provider.type, availability: selected.availability, role: roleName }).role;
          if (decision.status !== "eligible") throw new Error(`[${decision.refusal.code}] ${decision.refusal.detail}`);
        }
        if (provider.type === "pi" && roleNames.has("reviewer")) {
          const helper = selected.availability.trustedHelpers[0];
          if (!helper) throw new Error("[inner-read-only-unproven] Pi reviewer helper identity is missing");
          const current = inspectAdapterRuntimeFile(helper.runtimeName, helper.canonicalPath);
          if (!sameRuntimeFileEvidence(current, helper)) throw new Error("[executable-identity-changed] Pi reviewer helper changed after the probe");
        }
        checks.push({
          name: `adapter:${providerName}`,
          status: "ok",
          detail: `${provider.type} ${selected.availability.observedExecutableVersion}; wire ${selected.availability.wireVersion}; ${selected.availability.behavioralChecks.length} exact behavioral checks; roles ${[...roleNames].join(",")}`
        });
      } catch (error) {
        checks.push({
          name: `adapter:${providerName}`,
          status: "warn",
          detail: error instanceof Error ? error.message : String(error),
          fix: "Rerun the contained compatibility probe and do not launch until executable/helper/config evidence matches exactly."
        });
      }
    }
  } catch (error) {
    checks.push({
      name: "providers",
      status: "warn",
      detail: error instanceof Error ? error.message : String(error),
      fix: "Select an existing project name and fix that project's provider configuration before running agents."
    });
  }

  return { ok: checks.every((c) => c.status !== "fail"), checks };
}

/**
 * Add the P1 service checks without changing the longstanding synchronous `runDoctor` contract.
 * This path is deliberately observational: it never creates a directory/DB, takes a lease, binds,
 * signals, migrates, or removes a stale artifact.
 */
export async function runDoctorWithControl(
  loaded: LoadedConfig | undefined,
  cwd: string,
  projectName?: string,
  adapters: ControlDoctorAdapters = {}
): Promise<DoctorReport> {
  const base = runDoctor(loaded, cwd, projectName);
  const control = await runControlPlaneDoctor(loaded, adapters);
  const checks = [...base.checks, ...control];
  return { ok: checks.every((check) => check.status !== "fail"), checks };
}

export async function runControlPlaneDoctor(
  loaded: LoadedConfig | undefined,
  adapters: ControlDoctorAdapters = {}
): Promise<DoctorCheck[]> {
  if (!loaded) {
    return [{
      name: "control-service",
      status: "warn",
      detail: "control service cannot be inspected without a loaded configuration",
      fix: "Create or repair a RelayForge config, then rerun `relayforge doctor` to inspect the local control service."
    }];
  }

  let paths;
  try {
    paths = controlPaths(loaded.rootDir, loaded.path);
  } catch (error) {
    return [{
      name: "control-dir",
      status: "fail",
      detail: `control identity cannot be derived: ${error instanceof Error ? error.message : String(error)}`,
      fix: "Restore the configured root and config as real local files, then rerun `relayforge doctor`; do not create replacement control artifacts by hand."
    }];
  }

  const checks: DoctorCheck[] = [];
  checks.push(inspectControlDirectory(paths.controlRoot, paths.dir));

  const probeLease = adapters.probeLease ?? probeControlLease;
  const readRunFile = adapters.readRunFile ?? readControlRunFile;
  let lease: ControlLeaseProbe;
  try {
    lease = probeLease(paths.leaseDb);
  } catch (error) {
    lease = { state: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
  checks.push(leaseDoctorCheck(lease));

  let runFile: RunFileRead | undefined;
  try {
    runFile = readRunFile(paths.runFile);
    checks.push(runFile.kind === "absent"
      ? { name: "serve-runfile", status: "ok", detail: "serve.json is absent" }
      : { name: "serve-runfile", status: "ok", detail: `private discovery record for instance ${runFile.value.instanceId.slice(0, 12)}` });
  } catch (error) {
    checks.push({
      name: "serve-runfile",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      fix: "Do not edit or delete serve.json while an owner may be active. Stop the exact owner or start a new proven owner after the lease is free."
    });
  }

  let service: ControlServiceInspection;
  try {
    service = adapters.inspectService
      ? await adapters.inspectService({
          timeoutMs: adapters.timeoutMs,
          probeLease,
          readRunFile
        })
      : await inspectControlService(paths, {
          timeoutMs: adapters.timeoutMs,
          probeLease,
          readRunFile
        });
  } catch (error) {
    service = { state: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
  checks.push(ownerDoctorCheck(service));
  checks.push(healthDoctorCheck(service));

  if (service.state !== "ready") {
    checks.push({
      name: "serve-cursor",
      status: "warn",
      detail: "no ready service view is available for cursor verification",
      fix: "Start `relayforge serve` and rerun doctor; if an owner is held but unhealthy, inspect that exact process instead of deleting its lease database."
    });
    return checks;
  }

  try {
    const status = await (adapters.fetchStatus ?? fetchControlStatus)(service.attachment, {
      timeoutMs: adapters.timeoutMs
    });
    const runs = status.projects.flatMap((project) => project.latestRun ? [project.latestRun] : []);
    const stale = runs.filter((run) => run.stale);
    checks.push(stale.length === 0
      ? {
          name: "serve-cursor",
          status: "ok",
          detail: `${runs.length} published run cursor${runs.length === 1 ? "" : "s"} have valid floor/view/head ordering`
        }
      : {
          name: "serve-cursor",
          status: "warn",
          detail: `${stale.length} published run view${stale.length === 1 ? " is" : "s are"} behind the durable head`,
          fix: "Retry after the control service catches up; if staleness persists, run the explicit control-store verification/rebuild diagnostic."
        });
  } catch (error) {
    checks.push({
      name: "serve-cursor",
      status: "fail",
      detail: `ready owner status/cursor verification failed: ${error instanceof Error ? error.message : String(error)}`,
      fix: "Inspect the exact running control owner and its local store diagnostics; do not substitute an empty board or delete the stable lease database."
    });
  }
  return checks;
}

function inspectControlDirectory(controlRoot: string, dir: string): DoctorCheck {
  if (!existsSync(controlRoot) && !existsSync(dir)) {
    return { name: "control-dir", status: "ok", detail: "control directory is not initialized; no service artifacts exist" };
  }
  try {
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const paths = existsSync(dir) ? [controlRoot, dir] : [controlRoot];
    for (const path of paths) {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${path} is not a real directory`);
      if (uid !== undefined && stat.uid !== uid) throw new Error(`${path} belongs to uid ${stat.uid}, not ${uid}`);
      if ((stat.mode & 0o077) !== 0) throw new Error(`${path} is accessible to group/other`);
    }
    if (!existsSync(dir)) {
      return {
        name: "control-dir",
        status: "ok",
        detail: "shared control root is private; this configuration has no initialized service directory"
      };
    }
    return { name: "control-dir", status: "ok", detail: "control directories are real, private, and owned by this user" };
  } catch (error) {
    return {
      name: "control-dir",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      fix: "Stop any exact control owner, repair the cited directory ownership/0700 mode without following links, then rerun doctor."
    };
  }
}

function leaseDoctorCheck(lease: ControlLeaseProbe): DoctorCheck {
  switch (lease.state) {
    case "absent":
      return { name: "serve-lease", status: "ok", detail: "stable owner lease has not been initialized" };
    case "free":
      return { name: "serve-lease", status: "ok", detail: "stable owner lease is free" };
    case "held":
      return { name: "serve-lease", status: "ok", detail: "stable owner lease is held" };
    case "failed":
      return {
        name: "serve-lease",
        status: "fail",
        detail: lease.detail,
        fix: "Inspect the stable serve-lock.sqlite file and local filesystem locking support; never delete the lease DB to break an uncertain owner."
      };
  }
}

function ownerDoctorCheck(service: ControlServiceInspection): DoctorCheck {
  switch (service.state) {
    case "ready":
      return { name: "serve-owner", status: "ok", detail: `ready instance ${service.attachment.runFile.instanceId.slice(0, 12)} passed the double-collect handshake` };
    case "stopped":
      return { name: "serve-owner", status: "ok", detail: service.detail };
    case "starting":
      return { name: "serve-owner", status: "warn", detail: service.detail, fix: "Wait for the current owner to publish readiness, then rerun doctor; do not start or kill a second owner." };
    case "stale-runfile":
      return { name: "serve-owner", status: "warn", detail: service.detail, fix: "Start `relayforge serve`; a successful new owner will replace only the stale discovery record while holding the stable lease." };
    case "held-unhealthy":
      return { name: "serve-owner", status: "fail", detail: service.detail, fix: "Inspect or gracefully stop the exact held owner process; do not steal ownership or delete serve-lock.sqlite." };
    case "identity-mismatch":
      return { name: "serve-owner", status: "fail", detail: service.detail, fix: "Refuse attachment and inspect the exact run-file, health endpoint, and owner process identities before taking any lifecycle action." };
    case "failed":
      return { name: "serve-owner", status: "fail", detail: service.detail, fix: "Repair the cited private control artifact or local locking/probe failure, then rerun doctor without deleting uncertain owner state." };
  }
}

function healthDoctorCheck(service: ControlServiceInspection): DoctorCheck {
  if (service.state === "ready") {
    return { name: "serve-health", status: "ok", detail: "bounded loopback health matches the held owner identity" };
  }
  const fail = service.state === "held-unhealthy" || service.state === "identity-mismatch" || service.state === "failed";
  return {
    name: "serve-health",
    status: fail ? "fail" : "warn",
    detail: service.state === "stopped" ? "control service is stopped" : service.detail,
    fix: fail
      ? "Inspect the exact held owner and bounded loopback endpoint; do not fall back to a foreign port or direct store/tmux reads."
      : "Start or await `relayforge serve`, then rerun doctor to prove the bounded health identity."
  };
}

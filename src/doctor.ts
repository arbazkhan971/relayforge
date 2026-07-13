import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getAuthStatus } from "./auth.js";
import { LoadedConfig } from "./config/load.js";
import { validateConfigSemantics } from "./config/validate.js";
import { getProject } from "./config/load.js";
import { sandboxInfo } from "./sandbox.js";
import { scopeInfo } from "./scope.js";
import { isCleanWorktree, worktreesSupported } from "./worktree.js";

export type DoctorCheck = { name: string; status: "ok" | "warn" | "fail"; detail: string; fix?: string };
export type DoctorReport = { ok: boolean; checks: DoctorCheck[] };

function has(command: string): { ok: boolean; version?: string } {
  const path = spawnSync("bash", ["-lc", `command -v '${command.replaceAll("'", "'\\''")}'`], { encoding: "utf8" });
  if (path.status !== 0) return { ok: false };
  // tmux reports its version with -V, not --version.
  const flag = command === "tmux" ? "-V" : "--version";
  const v = spawnSync(command, [flag], { encoding: "utf8", timeout: 5000 });
  return { ok: true, version: ((v.stdout || v.stderr) ?? "").trim().split("\n")[0] };
}

/**
 * Actionable environment/config diagnostics. Returns a check list plus an overall `ok`. A
 * `warn` never fails the report (tmux is optional, no config yet is fine); only `fail` does.
 */
export function runDoctor(loaded: LoadedConfig | undefined, cwd: string, projectName?: string): DoctorReport {
  const checks: DoctorCheck[] = [];

  // Node >= 20 (honest engines support).
  const major = Number(process.versions.node.split(".")[0]);
  checks.push(
    major >= 20
      ? { name: "node", status: "ok", detail: `Node ${process.versions.node}` }
      : { name: "node", status: "fail", detail: `Node ${process.versions.node}`, fix: "Loop Orchestrator requires Node >= 20. Upgrade Node." }
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
    const envOff = process.env.LOOP_TMUX === "off";
    checks.push(
      configOff || envOff
        ? {
            name: "tmux-viewport",
            status: "warn",
            detail: envOff ? "disabled by LOOP_TMUX=off" : "disabled by defaults.viewport: false",
            fix: envOff ? "Unset LOOP_TMUX to use `loop tmux new`. The loop runs headless either way." : "Set `defaults.viewport: true` in loop.config.yaml to use `loop tmux new`."
          }
        : { name: "tmux-viewport", status: "ok", detail: "enabled — `loop tmux new` opens the run's viewport" }
    );
  }

  // Git target cleanliness (the human gate for --execute).
  if (git.ok && worktreesSupported(cwd)) {
    checks.push(
      isCleanWorktree(cwd)
        ? { name: "git-target", status: "ok", detail: "working tree is clean" }
        : { name: "git-target", status: "warn", detail: "working tree has uncommitted changes", fix: "Commit or stash before `loop run --execute` — execution requires a clean git target." }
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
      fix: "`loop run --execute` FAILS CLOSED without a launchable sandbox — every provider/verifier call is contained or refused. Install/enable bwrap (Linux; needs unprivileged user namespaces) or run on macOS. There is no unsandboxed override."
    });
  } else if (!sbx.networkIsolation) {
    checks.push({
      name: "sandbox",
      status: "fail",
      detail: `${sbx.mechanism} launches, but it cannot isolate the network on this host`,
      fix: "`loop run --execute` FAILS CLOSED: verifier commands are AI-chosen and must run with NO network, and this host cannot create a network namespace (common in nested containers). Run on a host where `bwrap --unshare-net` works, or on macOS."
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
          fix: "`loop run --execute` FAILS CLOSED without one: a provider's descendants could escape a process group via setsid/double-fork. Run under a systemd user session with a delegated cgroup v2 (`systemd-run --user --scope loop run …`), or on a host with cgroup v2 delegation."
        }
  );

  // A missing config is a warn (run `loop init`); a config that exists but does not load is a
  // FAIL (malformed) — the two are distinct.
  if (!loaded) {
    const malformed = existsSync(resolve(cwd, "loop.config.yaml"));
    checks.push(
      malformed
        ? { name: "config", status: "fail", detail: "loop.config.yaml exists but is malformed / failed to load", fix: "Fix the YAML/schema errors (run `loop validate` for detail)." }
        : { name: "config", status: "warn", detail: "no loop.config.yaml found", fix: "Run `loop init` to create one." }
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

    const auth = getAuthStatus(project);
    // Headless execution needs the provider CLI on PATH. An API key WITHOUT the CLI is not ready.
    const ready = auth.filter((a) => a.cliAvailable);
    const keyOnly = auth.filter((a) => !a.cliAvailable && a.apiKeySet);
    if (ready.length) {
      checks.push({ name: "providers", status: "ok", detail: `ready: ${ready.map((a) => `${a.providerName}(${a.recommendedMode})`).join(", ")}` });
    } else if (keyOnly.length) {
      checks.push({ name: "providers", status: "warn", detail: `API key set but CLI not installed: ${keyOnly.map((a) => a.providerName).join(", ")}`, fix: "Install the provider CLI (claude/codex/gemini) — an API key alone cannot run headless turns." });
    } else {
      checks.push({ name: "providers", status: "warn", detail: "no provider CLI installed", fix: "Install a provider CLI (claude/codex/gemini). Dry-run (`loop run`) still works with none." });
    }
  } catch (error) {
    checks.push({ name: "providers", status: "warn", detail: error instanceof Error ? error.message : String(error) });
  }

  return { ok: checks.every((c) => c.status !== "fail"), checks };
}

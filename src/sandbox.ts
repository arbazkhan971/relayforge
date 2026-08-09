import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * OS-level sandbox for running UNTRUSTED commands (AI-authored verifier commands and the agent
 * processes themselves).
 *
 * The threat: a verifier command string and the provider process itself are chosen/driven by the
 * planner/agent and then executed. They must not read the parent's secrets, reach the network to
 * exfiltrate them, or write anywhere outside the disposable checkout being worked on.
 *
 * Enforcement mechanism (in priority order):
 *   1. `bwrap` (bubblewrap user namespaces) on Linux — read-only root, tmpfs /tmp, a single
 *      writable bind for the checkout, and `--unshare-net` to remove the network.
 *   2. `sandbox-exec` (Seatbelt) on macOS.
 *
 * When neither is available AND launchable the orchestrator FAILS CLOSED: no provider or verifier
 * runs at all (`containCommand` throws), so a missing sandbox can never be mistaken for a passing
 * gate. There is NO production environment variable that lifts this — see `setTrustedRunner`.
 *
 * NOTE on `@anthropic-ai/sandbox-runtime` (SRT): SRT is a Node LIBRARY (`SandboxManager`), not an
 * `srt exec` CLI. Its Linux backend itself relies on bubblewrap/landlock, which cannot launch on
 * this host (unprivileged user-namespace uid_map is denied). Rather than ship an unproven, fake
 * `srt exec` wrapper, we detect the real, launchable OS boundary and otherwise fail closed. Wiring
 * the real SRT API behind a proven `checkDependencies()` gate is tracked as future work; it is not
 * a substitute for the fail-closed boundary this module enforces.
 */

export type SandboxMechanism = "bwrap" | "sandbox-exec" | "none";

export type SandboxPolicy = {
  /** The one directory the command may write to (its checkout). Everything else is read-only. */
  writableRoot: string;
  /** Extra writable roots (e.g. a private credential/cache dir). Keep minimal. */
  extraWritable?: string[];
  /** Allow outbound network. FALSE for verifiers (no exfiltration); TRUE only for agent
   *  processes that must reach a model API. */
  network: boolean;
  /** Working directory inside the sandbox. */
  cwd: string;
};

function assertNoSysWritableRoots(roots: readonly string[]): void {
  for (const configured of roots) {
    const lexical = resolve(configured);
    let physical = lexical;
    try { physical = realpathSync(lexical); } catch { /* a missing root is still checked lexically */ }
    if (physical === "/sys" || physical.startsWith("/sys/") || lexical === "/sys" || lexical.startsWith("/sys/")) {
      throw new Error(`refusing writable sandbox bind beneath /sys: ${configured}`);
    }
  }
}

function which(cmd: string): boolean {
  return spawnSync("bash", ["-lc", `command -v '${cmd.replaceAll("'", "'\\''")}'`], { stdio: "ignore" }).status === 0;
}

let cached: SandboxMechanism | undefined;
let netns: boolean | undefined;

/** Detect the strongest available AND launchable OS sandbox mechanism (memoized). `LOOP_SANDBOX=none`
 *  forces "none" — a STRICTNESS-ONLY override used by tests to prove fail-closed behavior; it can
 *  never weaken containment, only remove it (which then fails closed). */
export function detectSandbox(): SandboxMechanism {
  if (process.env.LOOP_SANDBOX === "none" || process.env.LOOP_SANDBOX === "off") return "none";
  if (cached) return cached;
  if (process.platform === "linux" && which("bwrap") && bwrapWorks()) cached = "bwrap";
  else if (process.platform === "darwin" && which("sandbox-exec")) cached = "sandbox-exec";
  else cached = "none";
  return cached;
}

/**
 * bwrap can be present but blocked (no unprivileged userns). Probe once with a trivial FILESYSTEM
 * jail (no network namespace — that is probed separately, since nested/container environments
 * frequently allow user namespaces but forbid configuring a new loopback). A present-but-unlaunchable
 * bwrap is treated as "none" so we fail closed instead of pretending to be sandboxed.
 */
function bwrapWorks(): boolean {
  const r = spawnSync("bwrap", ["--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--die-with-parent", "true"], { stdio: "ignore" });
  return r.status === 0;
}

/**
 * Whether `--unshare-net` (real network isolation) actually works here. When it does, verifiers
 * run with NO network. When it does not (e.g. a nested container that forbids RTM_NEWADDR on the
 * new loopback), we still filesystem-confine and scrub the env, but network is NOT isolated —
 * callers log this honestly rather than claiming a guarantee we can't keep.
 */
export function netnsSupported(): boolean {
  if (netns !== undefined) return netns;
  if (detectSandbox() !== "bwrap") {
    netns = detectSandbox() === "sandbox-exec";
    return netns;
  }
  const r = spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-net", "--die-with-parent", "true"], { stdio: "ignore" });
  netns = r.status === 0;
  return netns;
}

export function sandboxAvailable(): boolean {
  return detectSandbox() !== "none";
}

/**
 * Can this host actually keep the promise "verifiers run with NO network"?
 *
 * A verifier is an AI-CHOSEN command string run against AI-authored code, with the repo's secrets
 * reachable in memory — the exfiltration path we care about most. We used to add `--unshare-net`
 * only when the netns probe happened to succeed, and otherwise ran the verifier WITH FULL NETWORK
 * and let the run proceed to `done` anyway. That made "no network for verifiers" a claim that held
 * only on hosts that happened to support it, silently, with nothing telling the operator which host
 * they were on — the exact shape of guarantee this codebase refuses everywhere else.
 *
 * Now it is a precondition, like the sandbox itself: no enforceable network isolation ⇒ the run
 * fails closed before the planner. A guarantee we cannot enforce is not downgraded, it is refused.
 */
export function verifierNetworkIsolationAvailable(): boolean {
  return detectSandbox() !== "none" && netnsSupported();
}

/** For diagnostics / doctor. */
export function sandboxInfo(): { mechanism: SandboxMechanism; available: boolean; networkIsolation: boolean } {
  const mechanism = detectSandbox();
  return { mechanism, available: mechanism !== "none", networkIsolation: mechanism !== "none" && netnsSupported() };
}

// ---------------------------------------------------------------------------
// Trusted-runner injection (TEST-ONLY seam).
//
// Unit/E2E tests must exercise the full loop on hosts where no OS sandbox can launch (this CI:
// bwrap uid_map is denied). They inject a trusted runner via this imported function — NOT via any
// environment variable — declaring "the commands I am about to run are my own trusted fixtures, so
// run them without the OS boundary." A real production run has no way to call this, so it fails
// closed before any provider/verifier launches. This is the invariant the audit demands: no
// production env var can produce `done` without containment.
// ---------------------------------------------------------------------------

let trustedRunnerInjected = false;

/** TEST-ONLY. Enable/disable the in-process trusted runner. Never called by the CLI/production. */
export function setTrustedRunner(on: boolean): void {
  trustedRunnerInjected = on;
}

export function trustedRunnerActive(): boolean {
  return trustedRunnerInjected;
}

/** Whether a physical provider/verifier call can proceed at all: a launchable OS sandbox exists,
 *  or a test injected a trusted runner. When neither holds the caller must fail closed. */
export function containmentAvailable(): boolean {
  return detectSandbox() !== "none" || trustedRunnerInjected;
}

export type ContainOutcome =
  /** Run this wrapped argv (already sandbox-confined). */
  | { kind: "wrapped"; command: string; args: string[] }
  /** A test injected a trusted runner — run the ORIGINAL command/args raw (no OS boundary). */
  | { kind: "trusted"; command: string; args: string[] };

/**
 * Decide how to physically run `[command, ...args]` under `policy`:
 *  - a launchable OS sandbox → return the wrapped argv (spawn it with a SCRUBBED env);
 *  - else a test trusted runner → return the raw argv to run in-process;
 *  - else THROW (fail closed). Untrusted execution never proceeds without a boundary.
 */
export function containCommand(command: string, args: string[], policy: SandboxPolicy): ContainOutcome {
  // The injected trusted runner WINS over a launchable sandbox. It is an import-only test seam
  // (production code never calls setTrustedRunner), and its entire purpose is host-independent
  // determinism: the same test must take the same path on a bwrap-capable host as on one where
  // bwrap cannot launch. Probing first would jail the tests' own fixtures on capable hosts, whose
  // private /tmp then swallows the TMPDIR side-channels the fixtures coordinate through.
  if (trustedRunnerInjected) return { kind: "trusted", command, args };
  const mech = detectSandbox();
  if (mech !== "none") {
    const wrapped = wrapCommand(command, args, policy);
    return { kind: "wrapped", command: wrapped.command, args: wrapped.args };
  }
  throw new Error(
    "No OS sandbox available (need a launchable Linux `bwrap` or macOS `sandbox-exec`). " +
      "Refusing to run a provider/verifier command unsandboxed — failing closed."
  );
}

/**
 * Wrap `[command, ...args]` so it runs under the OS sandbox described by `policy`. Returns the
 * new argv. Throws if no sandbox mechanism is available. The returned argv should be spawned with a
 * SCRUBBED env (see providers.buildProviderEnv); the sandbox constrains the filesystem/network, the
 * env scrub constrains inherited secrets.
 */
export function wrapCommand(command: string, args: string[], policy: SandboxPolicy): { command: string; args: string[] } {
  const mech = detectSandbox();
  const writable = [policy.writableRoot, ...(policy.extraWritable ?? [])].map((p) => resolve(p)).filter((p) => existsSync(p));
  assertNoSysWritableRoots([policy.writableRoot, ...(policy.extraWritable ?? [])]);

  if (mech === "bwrap") {
    return { command: "bwrap", args: buildBwrapArgs(command, args, { ...policy, writableRoots: writable }, !policy.network && netnsSupported()) };
  }

  if (mech === "sandbox-exec") {
    const profile = seatbeltProfile(writable, policy.network);
    return { command: "sandbox-exec", args: ["-p", profile, command, ...args] };
  }

  throw new Error(
    "No OS sandbox available (need a launchable Linux `bwrap` or macOS `sandbox-exec`). Untrusted execution fails closed without one."
  );
}

/**
 * Pure builder for the bwrap argv — read-only root, a private /tmp, one writable bind per
 * allowed root, network isolation when requested/available, confined to `cwd`. Exposed so the
 * exact confinement policy can be asserted deterministically in tests (independent of whether
 * this host can actually launch bwrap).
 */
export function buildBwrapArgs(
  command: string,
  args: string[],
  policy: { writableRoots: string[]; cwd: string },
  isolateNetwork: boolean
): string[] {
  assertNoSysWritableRoots(policy.writableRoots);
  const jail = [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--die-with-parent",
    "--new-session"
  ];
  for (const w of policy.writableRoots) jail.push("--bind", resolve(w), resolve(w));
  if (isolateNetwork) jail.push("--unshare-net");
  jail.push("--chdir", resolve(policy.cwd));
  return [...jail, "--", command, ...args];
}

function seatbeltProfile(writable: string[], network: boolean): string {
  const writes = writable.map((w) => `(subpath "${w}")`).join(" ");
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    writes ? `(allow file-write* ${writes})` : "",
    "(allow file-write* (subpath \"/tmp\") (subpath \"/private/tmp\") (subpath \"/dev\"))",
    network ? "" : "(deny network*)"
  ]
    .filter(Boolean)
    .join(" ");
}

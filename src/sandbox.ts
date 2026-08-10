import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import { resolveRelayForgeEnvironment } from "./identity.js";

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
  /**
   * Closed filesystem visibility for capability-scoped provider turns. When absent, the historical
   * single-repository policy retains its read-only host root for compatibility. P6 must always supply
   * this object: an empty Bubblewrap root is then populated only with the closed system runtime,
   * explicit runtime/helper paths, declared readable paths, and exact writable worktrees/private state.
   */
  filesystem?: SandboxFilesystemAllowlist;
};

export type SandboxFilesystemAllowlist = Readonly<{
  mode: "allowlist";
  /** Exact prompt/helper/config paths required by this call, mounted read-only. */
  readableRoots?: readonly string[];
  /** Exact provider executable/package/helper roots required by this call, mounted read-only. */
  runtimeRoots?: readonly string[];
  /** Exact, identity-pinned AF_UNIX relays. The containing directory is never mounted. */
  socketRoots?: readonly SandboxSocketIdentity[];
  /** Paths that must remain absent. Any allowed ancestor that would expose one is refused. */
  inaccessibleRoots?: readonly string[];
}>;

export type SandboxSocketIdentity = Readonly<{
  path: string;
  device: string;
  inode: string;
  ctimeNs: string;
  parentDevice: string;
  parentInode: string;
  uid: number;
  mode: 0o600;
}>;

type ExactMount = Readonly<{ source: string; destination: string; directory: boolean }>;

/** Closed, distribution-level runtime needed by ordinary dynamically linked CLI processes. */
const BWRAP_SYSTEM_READ_PATHS = Object.freeze([
  "/usr/bin/env",
  "/usr/bin/bash",
  "/usr/bin/sh",
  "/bin/bash",
  "/bin/sh",
  "/usr/bin/git",
  "/usr/bin/rg",
  "/usr/bin/make",
  "/usr/bin/node",
  "/usr/bin/npm",
  "/usr/bin/npx",
  "/usr/bin/python3",
  "/usr/bin/patch",
  "/usr/bin/diff",
  "/usr/bin/sed",
  "/usr/bin/awk",
  "/usr/bin/grep",
  "/usr/bin/cat",
  "/usr/bin/cp",
  "/usr/bin/mv",
  "/usr/bin/mkdir",
  "/usr/bin/rm",
  "/usr/bin/chmod",
  "/usr/bin/stat",
  "/usr/bin/find",
  "/usr/bin/head",
  "/usr/bin/tail",
  "/usr/bin/sort",
  "/usr/bin/uniq",
  "/usr/bin/xargs",
  "/usr/bin/dirname",
  "/usr/bin/basename",
  "/usr/bin/realpath",
  "/usr/lib",
  "/usr/lib64",
  "/lib",
  "/lib64",
  "/usr/libexec",
  "/usr/share/git-core",
  "/usr/share/zoneinfo",
  "/usr/share/ca-certificates",
  "/etc/ld.so.cache",
  "/etc/ssl/certs",
  "/etc/ca-certificates.conf",
  "/etc/resolv.conf",
  "/etc/hosts",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/group",
  "/etc/localtime"
]);

function within(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function exactMount(path: string, label: string, preserveDestination = false): ExactMount {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute: ${path}`);
  const lexical = resolve(path);
  if (lexical === "/") throw new Error(`${label} may not expose the host root`);
  const stat = lstatSync(lexical);
  if (stat.isSymbolicLink()) {
    // The mount source is canonicalized so a symlink cannot change what becomes visible after policy
    // validation. The provider command is likewise canonicalized before it is placed after `--`.
    const physical = realpathSync.native(lexical);
    const physicalStat = lstatSync(physical);
    if (!physicalStat.isFile() && !physicalStat.isDirectory()) throw new Error(`${label} is not a regular file or directory: ${path}`);
    return Object.freeze({ source: physical, destination: preserveDestination ? lexical : physical, directory: physicalStat.isDirectory() });
  }
  if (!stat.isFile() && !stat.isDirectory()) throw new Error(`${label} is not a regular file or directory: ${path}`);
  const physical = realpathSync.native(lexical);
  return Object.freeze({ source: physical, destination: physical, directory: stat.isDirectory() });
}

function inspectSandboxSocket(path: string): SandboxSocketIdentity {
  if (!isAbsolute(path)) throw new Error(`sandbox relay socket must be absolute: ${path}`);
  const lexical = resolve(path);
  const parent = dirname(lexical);
  const parentStat = lstatSync(parent, { bigint: true });
  const expectedUid = typeof process.geteuid === "function" ? process.geteuid() : Number(parentStat.uid);
  if (
    !parentStat.isDirectory() || parentStat.isSymbolicLink() || (parentStat.mode & 0o077n) !== 0n ||
    Number(parentStat.uid) !== expectedUid || realpathSync.native(parent) !== parent
  ) throw new Error(`sandbox relay socket parent is not exact, owned, and 0700: ${parent}`);
  const stat = lstatSync(lexical, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isSocket() || Number(stat.uid) !== expectedUid || (stat.mode & 0o777n) !== 0o600n) {
    throw new Error(`sandbox relay path is not an exact owned AF_UNIX 0600 socket: ${lexical}`);
  }
  return Object.freeze({
    path: lexical,
    device: String(stat.dev),
    inode: String(stat.ino),
    ctimeNs: String(stat.ctimeNs),
    parentDevice: String(parentStat.dev),
    parentInode: String(parentStat.ino),
    uid: Number(stat.uid),
    mode: 0o600
  });
}

/** Pin an exact parent-owned AF_UNIX relay after listen/chmod and before provider containment. */
export function pinSandboxSocket(path: string): SandboxSocketIdentity {
  return inspectSandboxSocket(path);
}

/** Re-stat a pinned relay immediately around launch; replacement/removal is a closed refusal. */
export function assertSandboxSocketIdentity(expected: SandboxSocketIdentity): void {
  const current = inspectSandboxSocket(expected.path);
  if (
    current.path !== expected.path || current.device !== expected.device || current.inode !== expected.inode ||
    current.ctimeNs !== expected.ctimeNs || current.parentDevice !== expected.parentDevice ||
    current.parentInode !== expected.parentInode || current.uid !== expected.uid || current.mode !== expected.mode
  ) throw new Error(`sandbox relay socket identity changed before provider launch: ${expected.path}`);
}

export function assertSandboxSocketIdentities(expected: readonly SandboxSocketIdentity[]): void {
  if (expected.length > 8) throw new Error("sandbox relay socket count exceeds the closed bound");
  const paths = new Set<string>();
  for (const identity of expected) {
    if (paths.has(identity.path)) throw new Error(`sandbox relay socket is duplicated: ${identity.path}`);
    paths.add(identity.path);
    assertSandboxSocketIdentity(identity);
  }
}

function socketMount(identity: SandboxSocketIdentity): ExactMount {
  assertSandboxSocketIdentity(identity);
  return Object.freeze({ source: identity.path, destination: identity.path, directory: false });
}

function existingExactMounts(paths: readonly string[], label: string): ExactMount[] {
  const mounts: ExactMount[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    mounts.push(exactMount(path, label, true));
  }
  return mounts;
}

function assertNoSensitiveBroadMount(mount: ExactMount, label: string): void {
  const home = process.env.HOME ? resolve(process.env.HOME) : undefined;
  if (home && mount.destination === home) throw new Error(`${label} may not expose the operator home`);
  if (home) {
    const ssh = resolve(home, ".ssh");
    if (within(ssh, mount.destination) || (mount.directory && within(mount.destination, ssh))) {
      throw new Error(`${label} may not expose .ssh`);
    }
  }
}

function dedupeMounts(mounts: readonly ExactMount[]): ExactMount[] {
  const byDestination = new Map<string, ExactMount>();
  for (const mount of mounts) {
    const existing = byDestination.get(mount.destination);
    if (existing && (existing.source !== mount.source || existing.directory !== mount.directory)) {
      throw new Error(`sandbox mount destination ${mount.destination} has conflicting identities`);
    }
    byDestination.set(mount.destination, mount);
  }
  return [...byDestination.values()].sort((a, b) => a.destination.localeCompare(b.destination));
}

function mountSubsumedBy(mount: ExactMount, parents: readonly ExactMount[]): boolean {
  return parents.some((parent) => parent.directory && within(parent.destination, mount.destination));
}

function addPrivateParents(argv: string[], path: string, publicParents: ReadonlySet<string>, created: Set<string>): void {
  const pending: string[] = [];
  let current = dirname(path);
  while (current !== "/" && !publicParents.has(current)) {
    pending.push(current);
    current = dirname(current);
  }
  for (const parent of pending.reverse()) {
    if (created.has(parent)) continue;
    // Execute-only skeletons preserve absolute paths without allowing a provider to enumerate the host
    // parent that contains authorized and unauthorized repositories side by side.
    argv.push("--perms", "0111", "--dir", parent);
    created.add(parent);
  }
}

function resolveExecutable(command: string, searchPath = process.env.PATH ?? ""): string {
  const candidates = command.includes("/")
    ? [command]
    : searchPath.split(delimiter).filter(Boolean).map((entry) => resolve(entry, command));
  for (const candidate of candidates) {
    try {
      const stat = lstatSync(candidate);
      if (!stat.isFile() && !stat.isSymbolicLink()) continue;
      return realpathSync.native(candidate);
    } catch {
      // Try the next bounded PATH entry.
    }
  }
  throw new Error(`sandbox runtime executable cannot be resolved exactly: ${command}`);
}

/** Resolve a provider executable before reservation so allowlist construction can fail closed early. */
export function resolveSandboxExecutable(command: string, searchPath?: string): string {
  return resolveExecutable(command, searchPath);
}

export type SandboxProviderKind = "claude" | "codex" | "gemini" | "custom" | "opencode" | "pi" | "grok";

const PROVIDER_PRIVATE_DIRECTORIES: Readonly<Record<SandboxProviderKind, readonly string[]>> = Object.freeze({
  claude: Object.freeze([".claude", ".config/claude", ".cache/claude"]),
  codex: Object.freeze([".codex", ".config/codex", ".cache/codex"]),
  gemini: Object.freeze([".gemini", ".config/gemini", ".config/gcloud", ".cache/gemini", ".cache/gcloud"]),
  custom: Object.freeze([]),
  opencode: Object.freeze([]),
  pi: Object.freeze([]),
  grok: Object.freeze([])
});

/**
 * Exact provider-specific persistent state. It deliberately has no generic `~/.cache` entry and
 * never returns another provider's directory. Native structured adapters use only their run-scoped
 * state and therefore receive no host-home mount here.
 */
export function providerPrivateWritableRoots(provider: SandboxProviderKind, home = process.env.HOME): string[] {
  const configured = PROVIDER_PRIVATE_DIRECTORIES[provider];
  if (!home || configured.length === 0) return [];
  const canonicalHome = realpathSync.native(resolve(home));
  const expectedUid = typeof process.geteuid === "function" ? process.geteuid() : lstatSync(canonicalHome).uid;
  const roots: string[] = [];
  for (const relative of configured) {
    const lexical = resolve(canonicalHome, relative);
    if (!existsSync(lexical)) continue;
    const stat = lstatSync(lexical);
    if (
      stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== expectedUid || (stat.mode & 0o077) !== 0 ||
      realpathSync.native(lexical) !== lexical || !within(canonicalHome, lexical)
    ) throw new Error(`provider ${provider} private state is not an exact owned 0700 directory: ${lexical}`);
    roots.push(lexical);
  }
  return roots.sort((a, b) => a.localeCompare(b));
}

/** Exact file-backed credential mounts; values are never serialized or widened to a parent dir. */
export function providerPrivateReadableRoots(
  provider: SandboxProviderKind,
  environment: Readonly<Record<string, string>>
): string[] {
  const candidates = provider === "gemini" && environment.GOOGLE_APPLICATION_CREDENTIALS
    ? [environment.GOOGLE_APPLICATION_CREDENTIALS]
    : [];
  return candidates.map((candidate) => {
    const mount = exactMount(candidate, `${provider} credential file`);
    const stat = lstatSync(mount.destination);
    const expectedUid = typeof process.geteuid === "function" ? process.geteuid() : stat.uid;
    if (mount.directory || stat.uid !== expectedUid || (stat.mode & 0o077) !== 0) {
      throw new Error(`${provider} credential path is not an exact owned private file: ${candidate}`);
    }
    assertNoSensitiveBroadMount(mount, `${provider} credential path`);
    return mount.destination;
  });
}

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
  // Non-login shell so process.env.PATH is authoritative (login shells reload profile PATH).
  return spawnSync("bash", ["-c", `command -v '${cmd.replaceAll("'", "'\\''")}'`], {
    stdio: "ignore",
    env: process.env
  }).status === 0;
}

let cached: SandboxMechanism | undefined;
let netns: boolean | undefined;

/** Detect the strongest available AND launchable OS sandbox mechanism (memoized). `RELAYFORGE_SANDBOX=none`
 *  (legacy: `LOOP_SANDBOX=none`)
 *  forces "none" — a STRICTNESS-ONLY override used by tests to prove fail-closed behavior; it can
 *  never weaken containment, only remove it (which then fails closed). */
export function detectSandbox(): SandboxMechanism {
  const override = resolveRelayForgeEnvironment("SANDBOX");
  if (override === "none" || override === "off") return "none";
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
  const requestedWritable = [policy.writableRoot, ...(policy.extraWritable ?? [])].map((p) => resolve(p));
  // A capability-scoped caller named these roots explicitly. Silently dropping a missing one would
  // launch with a narrower/different capability than the parent bound into its request and can turn a
  // replacement/race into an apparently valid launch. Let exactMount fail closed instead. The legacy
  // single-repository wrapper retains its historical optional-state filtering.
  const writable = policy.filesystem?.mode === "allowlist"
    ? requestedWritable
    : requestedWritable.filter((p) => existsSync(p));
  assertNoSysWritableRoots([policy.writableRoot, ...(policy.extraWritable ?? [])]);

  if (mech === "bwrap") {
    if (policy.filesystem?.mode === "allowlist") {
      const executable = resolveExecutable(command);
      return {
        command: "bwrap",
        args: buildAllowlistedBwrapArgs(executable, args, {
          writableRoots: writable,
          readableRoots: [...(policy.filesystem.readableRoots ?? [])],
          runtimeRoots: [executable, ...(policy.filesystem.runtimeRoots ?? [])],
          socketRoots: [...(policy.filesystem.socketRoots ?? [])],
          inaccessibleRoots: [...(policy.filesystem.inaccessibleRoots ?? [])],
          cwd: policy.cwd
        }, !policy.network && netnsSupported())
      };
    }
    return { command: "bwrap", args: buildBwrapArgs(command, args, { ...policy, writableRoots: writable }, !policy.network && netnsSupported()) };
  }

  if (mech === "sandbox-exec") {
    if (policy.filesystem?.mode === "allowlist") {
      throw new Error("capability-scoped filesystem visibility requires Linux Bubblewrap; sandbox-exec cannot provide the P6 read allowlist");
    }
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

/**
 * Pure Bubblewrap builder for P6 capability-scoped provider turns. Unlike `buildBwrapArgs`, this
 * starts from an empty root and therefore cannot expose an undeclared sibling repository merely
 * because it happens to live elsewhere on the host. The source list is closed and validated before
 * argv construction; a broad mount that contains an explicitly inaccessible path is a refusal.
 */
export function buildAllowlistedBwrapArgs(
  command: string,
  args: string[],
  policy: Readonly<{
    writableRoots: readonly string[];
    readableRoots: readonly string[];
    runtimeRoots: readonly string[];
    socketRoots?: readonly SandboxSocketIdentity[];
    inaccessibleRoots: readonly string[];
    cwd: string;
  }>,
  isolateNetwork: boolean
): string[] {
  assertNoSysWritableRoots(policy.writableRoots);
  const writable = dedupeMounts(policy.writableRoots.map((path) => exactMount(path, "writable sandbox root")));
  const readable = dedupeMounts(policy.readableRoots.map((path) => exactMount(path, "readable sandbox root")));
  const runtime = dedupeMounts(policy.runtimeRoots.map((path) => exactMount(path, "runtime sandbox root")));
  const sockets = dedupeMounts((policy.socketRoots ?? []).map(socketMount));
  assertSandboxSocketIdentities(policy.socketRoots ?? []);
  const system = dedupeMounts(existingExactMounts(BWRAP_SYSTEM_READ_PATHS, "system runtime root"));
  const inaccessible = dedupeMounts(policy.inaccessibleRoots.map((path) => exactMount(path, "inaccessible sandbox root")));

  for (const mount of [...writable, ...readable, ...runtime]) assertNoSensitiveBroadMount(mount, "sandbox allowlist");
  for (const allowed of [...system, ...writable, ...readable, ...runtime, ...sockets]) {
    for (const denied of inaccessible) {
      // An allowed ancestor would expose the denied leaf and is forbidden. The inverse is safe and
      // necessary for Git worktrees: an exact read-only `<configured-repo>/.git` capability may sit
      // beneath an otherwise absent configured repository root. Empty-root skeleton parents expose no
      // siblings or directory listing, so that exact nested bind does not expose the denied ancestor.
      if (
        allowed.destination === denied.destination ||
        (allowed.directory && within(allowed.destination, denied.destination))
      ) {
        throw new Error(`sandbox allowlist mount ${allowed.destination} overlaps inaccessible path ${denied.destination}`);
      }
    }
  }
  for (const left of writable) for (const right of writable) {
    if (left === right) continue;
    if ((left.directory && within(left.destination, right.destination)) || (right.directory && within(right.destination, left.destination))) {
      throw new Error(`writable sandbox roots overlap: ${left.destination} and ${right.destination}`);
    }
  }

  const cwd = realpathSync.native(resolve(policy.cwd));
  if (![...writable, ...readable].some((mount) => mount.directory && within(mount.destination, cwd))) {
    throw new Error(`sandbox cwd ${cwd} is outside the explicit filesystem capability set`);
  }
  const canonicalCommand = realpathSync.native(command);
  if (![...system, ...runtime].some((mount) => mount.destination === canonicalCommand || (mount.directory && within(mount.destination, canonicalCommand)))) {
    throw new Error(`sandbox executable ${canonicalCommand} is outside the explicit runtime capability set`);
  }

  const effectiveRuntime = runtime.filter((mount) => !mountSubsumedBy(mount, system));
  const effectiveReadable = readable.filter((mount) => !mountSubsumedBy(mount, [...system, ...effectiveRuntime, ...writable]));
  const publicParents = new Set<string>(["/", "/proc", "/dev", "/tmp"]);
  const createdParents = new Set<string>(publicParents);
  const argv: string[] = [
    // The provider must not escape the mount allowlist through same-UID host process handles such as
    // `/proc/<pid>/root` or `/proc/<pid>/fd`. The parent still owns and observes the outer cgroup;
    // these namespace views only hide host process/IPC/hostname/cgroup topology from the child.
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup",
    "--tmpfs", "/",
    "--perms", "1777", "--tmpfs", "/tmp",
    "--proc", "/proc",
    "--dev", "/dev",
    "--die-with-parent",
    "--new-session"
  ];
  for (const mount of [...system, ...effectiveRuntime, ...effectiveReadable, ...sockets, ...writable]) {
    addPrivateParents(argv, mount.destination, publicParents, createdParents);
    argv.push(writable.includes(mount) ? "--bind" : "--ro-bind", mount.source, mount.destination);
  }
  if (isolateNetwork) argv.push("--unshare-net");
  argv.push("--chdir", cwd, "--", canonicalCommand, ...args);
  return argv;
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

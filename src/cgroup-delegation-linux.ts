import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  constants,
  accessSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  readSync,
  realpathSync,
  rmdirSync,
  statSync,
  writeSync
} from "node:fs";
import { release } from "node:os";
import { basename, dirname, isAbsolute, posix, resolve } from "node:path";
import {
  VERIFIER_CGROUP_BWRAP_FRAGMENT,
  VERIFIER_CGROUP_ENROLLMENT_TIMEOUT_MS,
  VERIFIER_CGROUP_GATE_TOKEN,
  VERIFIER_CGROUP_MOUNT_POINT,
  VERIFIER_CGROUP_STATUS_MAX_BYTES,
  buildVerifierCgroupLaunchPlan,
  parseCgroupEventsPopulation,
  parseDelegationFiles,
  parseMountInfo,
  parseProcStatStartTicks,
  parseUnifiedCgroupMembership,
  parseVerifierEnrollmentStatus,
  parseVerifierCgroupJournalLine,
  probeVerifierCgroupJail,
  sameExecutableIdentity,
  selectUnifiedCgroupMount,
  serializeVerifierCgroupJournalRecord,
  setAndVerifyStructuralLimits,
  verifierCgroupRuntimeCacheKey,
  verifierCgroupScopeId,
  type BubblewrapBehavioralEvidence,
  type ExecutableIdentity,
  type MountInfoEntry,
  type ProbeRead,
  type ScopeObjectIdentity,
  type StructuralLimitIo,
  type VerifierCgroupJailCapability,
  type VerifierCgroupAvailableCapability,
  type VerifierCgroupJournalRecord,
  type VerifierCgroupScopeIdentity,
  type VerifierCgroupProbeEvidence,
  type VerifierCgroupUnavailableReason
} from "./cgroup-delegation.js";
import { reapProofOf, scopeIdOf, type LaunchSpec, type ProcessScope, type ScopeBackend, type ScopeRef } from "./scope.js";

// Linux UAPI values. Node 20 does not expose O_PATH, but open(2) accepts the
// numeric flag. O_DIRECTORY and O_NOFOLLOW are ORed explicitly even when Node
// happens to expose them.
export const LINUX_O_PATH = 0x20_0000;
export const LINUX_O_DIRECTORY = 0x1_0000;
export const LINUX_O_NOFOLLOW = 0x2_0000;

const PROBE_OUTPUT_MAX_BYTES = 64 * 1024;
const PROBE_TIMEOUT_MS = 15_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const TRUSTED_SHELL = "/bin/sh";

type BigStat = ReturnType<typeof statSync> & {
  dev: bigint;
  ino: bigint;
  uid: bigint;
  gid: bigint;
  mode: bigint;
  mtimeNs: bigint;
  nlink: bigint;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
};

export type TrustedExecutable = {
  command: string;
  identity: ExecutableIdentity;
};

export type LinuxProbeDependencies = {
  shell: TrustedExecutable;
  stat: TrustedExecutable;
  bubblewrap: TrustedExecutable;
  node: TrustedExecutable;
};

export type CollectedLinuxCgroupEvidence = {
  evidence: VerifierCgroupProbeEvidence;
  outerScopeRoot?: string;
  membership?: string;
  mount?: MountInfoEntry;
  dependencies?: LinuxProbeDependencies;
};

export type LinuxEvidenceCollector = () => CollectedLinuxCgroupEvidence;

export type LinuxBehavioralProbeContext = {
  collected: CollectedLinuxCgroupEvidence;
};

export type LinuxBehavioralProbeResult =
  | { ok: true; behavior: BubblewrapBehavioralEvidence }
  | { ok: false; reasonCode: VerifierCgroupUnavailableReason; detail: string };

export type LinuxBehavioralProbeRunner = (context: LinuxBehavioralProbeContext) => Promise<LinuxBehavioralProbeResult>;

export type LinuxCgroupProbeOptions = {
  collectEvidence?: LinuxEvidenceCollector;
  runBehavioralProbe?: LinuxBehavioralProbeRunner;
};

function readProbe(path: string): ProbeRead {
  try {
    return { ok: true, text: readFileSync(path, "utf8") };
  } catch (error) {
    return { ok: false, code: (error as NodeJS.ErrnoException).code ?? "UNKNOWN" };
  }
}

function cgroup2MountInfoOnly(raw: string): string {
  return raw.split("\n").filter((line) => line.includes(" - cgroup2 ")).join("\n") + "\n";
}

function bigintStats(path: string): BigStat {
  return statSync(path, { bigint: true }) as unknown as BigStat;
}

function modeAllowsWrite(stat: BigStat, effectiveUid: number, groups: ReadonlySet<number>): boolean {
  if (effectiveUid === 0) return true;
  const mode = Number(stat.mode & 0o777n);
  if (Number(stat.uid) === effectiveUid) return (mode & 0o200) !== 0;
  if (groups.has(Number(stat.gid))) return (mode & 0o020) !== 0;
  return (mode & 0o002) !== 0;
}

function identityOf(path: string, stat: BigStat): ExecutableIdentity {
  return { canonicalPath: path, dev: String(stat.dev), ino: String(stat.ino), mtimeNs: String(stat.mtimeNs) };
}

/** Resolve one fixed executable and reject it if the effective uid can mutate it or an ancestor. */
export function inspectTrustedExecutable(
  candidate: string,
  effectiveUid = process.geteuid?.() ?? -1,
  effectiveGroups: readonly number[] = process.getgroups?.() ?? [],
  effectiveGid = process.getegid?.() ?? -1
): TrustedExecutable {
  if (!isAbsolute(candidate)) throw new Error("trusted executable candidate must be absolute");
  const canonicalPath = realpathSync(candidate);
  const executable = bigintStats(canonicalPath);
  if (!executable.isFile()) throw new Error(`${canonicalPath} is not a regular executable`);
  accessSync(canonicalPath, constants.X_OK);
  const groups = new Set(effectiveGroups ?? []);
  if (effectiveGid >= 0) groups.add(effectiveGid);
  let current = canonicalPath;
  for (;;) {
    const stat = bigintStats(current);
    if (modeAllowsWrite(stat, effectiveUid, groups)) {
      // Confirm the mode conclusion with the kernel's access check. A mode-bit
      // grant is already enough to reject; ACLs are caught by this check on the
      // otherwise-safe branch below.
      throw new Error(`trusted executable path is writable by effective uid ${effectiveUid}: ${current}`);
    }
    try {
      accessSync(current, constants.W_OK);
      throw new Error(`trusted executable path is writable by effective uid ${effectiveUid}: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error;
    }
    if (current === "/") break;
    current = dirname(current);
  }
  return { command: canonicalPath, identity: identityOf(canonicalPath, executable) };
}

function resolveOnPath(command: string): string {
  const search = process.env.PATH ?? "/usr/bin:/bin";
  for (const directory of search.split(":")) {
    if (!directory) continue;
    const candidate = resolve(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue to the next fixed PATH entry.
    }
  }
  throw Object.assign(new Error(`${command} is not available on PATH`), { code: "ENOENT" });
}

/** Map a unified membership onto the selected mount without path traversal. */
export function cgroupPathForMembership(mount: MountInfoEntry, membership: string): string {
  if (mount.fsType !== "cgroup2" || !membership.startsWith("/")) throw new Error("not a unified cgroup mount/membership");
  if (!(mount.root === "/" || membership === mount.root || membership.startsWith(`${mount.root}/`))) {
    throw new Error("membership is outside the selected cgroup2 mount root");
  }
  const relative = mount.root === "/" ? membership.slice(1) : membership.slice(mount.root.length).replace(/^\//, "");
  if (relative.split("/").some((part) => part === ".." || part === ".") || relative.includes("\0")) throw new Error("unsafe membership path");
  const result = resolve(mount.mountPoint, relative);
  const prefix = `${resolve(mount.mountPoint)}/`;
  if (result !== resolve(mount.mountPoint) && !result.startsWith(prefix)) throw new Error("membership escaped the selected mount");
  return result;
}

function placeholderBehavior(): BubblewrapBehavioralEvidence {
  return {
    performed: false,
    strictCgroupNamespace: false,
    fdBind: false,
    userNamespace: false,
    pidNamespace: false,
    ipcNamespace: false,
    utsNamespace: false,
    networkNamespace: false,
    capabilityDrop: false,
    namespaceRootIsSlash: false,
    pinnedScopeIdentityMatched: false,
    childCgroupLifecycleWorked: false,
    rootStructuralWriteDenied: false,
    parentAndSiblingsHidden: false,
    sourceFdClosedInPayload: false,
    hostMountOptionsUnchanged: false,
    disposableScopeSettled: false
  };
}

function delegationOwnershipAvailable(scopeRoot: string, delegationRead: ProbeRead, effectiveUid: number): boolean {
  let files: readonly string[];
  try {
    files = parseDelegationFiles(delegationRead);
  } catch {
    return false;
  }
  try {
    const root = bigintStats(scopeRoot);
    if (!root.isDirectory() || Number(root.uid) !== effectiveUid) return false;
    for (const file of files) {
      const path = resolve(scopeRoot, file);
      const stat = lstatSync(path, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.uid) !== effectiveUid) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Collect real Linux evidence. This performs no cgroup allocation and launches no command. */
export function collectLinuxCgroupEvidence(): CollectedLinuxCgroupEvidence {
  const platform = process.platform;
  const rawMountInfo = readProbe("/proc/self/mountinfo");
  const mountInfo: ProbeRead = rawMountInfo.ok ? { ok: true, text: cgroup2MountInfoOnly(rawMountInfo.text) } : rawMountInfo;
  const selfCgroup = readProbe("/proc/self/cgroup");
  const delegationFile = readProbe("/sys/kernel/cgroup/delegate");
  const effectiveUid = process.geteuid?.() ?? -1;
  let membership: string | undefined;
  let mount: MountInfoEntry | undefined;
  let outerScopeRoot: string | undefined;
  let outerScopeFiles: string[] = [];
  let strongOuterScope = false;
  try {
    if (mountInfo.ok && selfCgroup.ok) {
      membership = parseUnifiedCgroupMembership(selfCgroup.text);
      mount = selectUnifiedCgroupMount(parseMountInfo(mountInfo.text), membership);
      if (mount) {
        outerScopeRoot = cgroupPathForMembership(mount, membership);
        const outer = lstatSync(outerScopeRoot);
        if (!outer.isDirectory() || outer.isSymbolicLink()) throw new Error("outer cgroup scope is not a real directory");
        outerScopeFiles = readdirSync(outerScopeRoot);
        accessSync(outerScopeRoot, constants.W_OK);
        strongOuterScope = true;
      }
    }
  } catch {
    strongOuterScope = false;
  }

  let dependencies: LinuxProbeDependencies | undefined;
  let bubblewrapAvailable = false;
  let bubblewrapIdentitySafe = false;
  let bubblewrapIdentity: ExecutableIdentity | undefined;
  let bubblewrap: TrustedExecutable | undefined;
  try {
    bubblewrapAvailable = true;
    bubblewrap = inspectTrustedExecutable(resolveOnPath("bwrap"), effectiveUid);
    bubblewrapIdentity = bubblewrap.identity;
  } catch (error) {
    bubblewrapAvailable = (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
  if (bubblewrap) {
    try {
      const shell = inspectTrustedExecutable(TRUSTED_SHELL, effectiveUid);
      const stat = inspectTrustedExecutable(resolveOnPath("stat"), effectiveUid);
      const node = inspectTrustedExecutable(process.execPath, effectiveUid);
      dependencies = { shell, stat, bubblewrap, node };
      bubblewrapIdentitySafe = true;
    } catch {
      // The shell and stat helper are part of the same trusted launcher identity
      // boundary. Missing/mutable dependencies make the bwrap identity unsafe.
      bubblewrapIdentitySafe = false;
    }
  }

  const uidMap = readProbe("/proc/self/uid_map");
  const evidence: VerifierCgroupProbeEvidence = {
    platform,
    kernelRelease: release(),
    mountInfo,
    selfCgroup,
    effectiveUid,
    userNamespaceMapping: uidMap.ok ? uidMap.text : "",
    strongOuterScope,
    outerScopeFiles,
    delegationFile,
    delegationOwnership: outerScopeRoot ? delegationOwnershipAvailable(outerScopeRoot, delegationFile, effectiveUid) : false,
    bubblewrap: {
      available: bubblewrapAvailable,
      identitySafe: bubblewrapIdentitySafe,
      identity: bubblewrapIdentity,
      behavior: placeholderBehavior()
    }
  };
  return { evidence, outerScopeRoot, membership, mount, dependencies };
}

/**
 * Shell trampoline used instead of spawn-then-enroll. `stat` is a separately
 * identity-pinned trusted dependency. The shell is replaced by canonical
 * Bubblewrap with `exec`, preserving the enrolled PID and inherited FD 5.
 */
export const LINUX_CGROUP_GATE_TRAMPOLINE = [
  'loop_actual="$($1 -Lc "%d:%i" -- /proc/self/fd/5 2>/dev/null)" || exit 125',
  '[ "$loop_actual" = "$2" ] || exit 125',
  'printf "%s\\n" "$$" > /proc/self/fd/5/cgroup.procs 2>/dev/null || exit 125',
  "loop_membership=",
  "loop_memberships=0",
  'while IFS= read -r loop_line; do case "$loop_line" in 0::*) loop_membership="${loop_line#0::}"; loop_memberships=$((loop_memberships + 1));; esac; done < /proc/self/cgroup',
  '[ "$loop_memberships" -eq 1 ] && [ "$loop_membership" = "$3" ] || exit 125',
  'printf "ENROLLED %s %s\\n" "$$" "$4" >&3 || exit 125',
  "exec 3>&-",
  "loop_gate_count=0",
  "loop_gate=",
  "while :; do",
  "  loop_gate_line=",
  "  if IFS= read -r loop_gate_line <&4; then",
  "    loop_gate_count=$((loop_gate_count + 1))",
  "    [ \"$loop_gate_count\" -eq 1 ] || exit 126",
  "    loop_gate=$loop_gate_line",
  "  else",
  "    [ -z \"$loop_gate_line\" ] || exit 126",
  "    break",
  "  fi",
  "done",
  '[ "$loop_gate_count" -eq 1 ] && [ "$loop_gate" = "GO" ] || exit 126',
  "exec 4>&-",
  "shift 4",
  'exec "$@"'
].join("\n");

const PAYLOAD_KEYS = [
  "selfRoot",
  "identityMatches",
  "childLifecycle",
  "rootWriteDenied",
  "parentsHidden",
  "capEffZero",
  "fd5Closed",
  "userNamespace",
  "pidNamespace",
  "ipcNamespace",
  "utsNamespace",
  "networkNamespace",
  "cgroupNamespace"
] as const;

export type LinuxCgroupPayloadResult = {
  selfRoot: boolean;
  identityMatches: boolean;
  childLifecycle: boolean;
  rootWriteDenied: boolean;
  parentsHidden: boolean;
  capEffZero: boolean;
  fd5Closed: boolean;
  userNamespace: boolean;
  pidNamespace: boolean;
  ipcNamespace: boolean;
  utsNamespace: boolean;
  networkNamespace: boolean;
  cgroupNamespace: boolean;
};

/** Bounded, whole-message parser for the fixed probe payload. */
export function parseLinuxCgroupPayloadResult(bytes: Uint8Array): LinuxCgroupPayloadResult {
  if (bytes.byteLength === 0 || bytes.byteLength > PROBE_OUTPUT_MAX_BYTES) throw new Error("probe output is empty or oversized");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("probe output is not UTF-8");
  }
  const trimmed = text.replace(/[\r\n]+$/, "");
  if (!trimmed || trimmed.includes("\n") || trimmed.includes("\r")) throw new Error("probe output is not one physical JSON record");
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    throw new Error("probe output is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("probe output is not an object");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== PAYLOAD_KEYS.length || Object.keys(object).some((key) => !(PAYLOAD_KEYS as readonly string[]).includes(key))) {
    throw new Error("probe output has an unexpected schema");
  }
  for (const key of PAYLOAD_KEYS) if (typeof object[key] !== "boolean") throw new Error(`probe output ${key} is not boolean`);
  return object as LinuxCgroupPayloadResult;
}

// Fixed code executed inside Bubblewrap. It emits booleans only; no verifier
// authored text is accepted as authority by the parent.
export const LINUX_CGROUP_PROBE_PAYLOAD = String.raw`
const fs = require("node:fs");
const cp = require("node:child_process");
const expectedDev = process.argv[1];
const expectedIno = process.argv[2];
const parentNs = JSON.parse(Buffer.from(process.argv[3], "base64url").toString("utf8"));
const siblingCanary = process.argv[4];
const root = "/sys/fs/cgroup";
const result = { selfRoot:false, identityMatches:false, childLifecycle:false, rootWriteDenied:false, parentsHidden:false, capEffZero:false, fd5Closed:false, userNamespace:false, pidNamespace:false, ipcNamespace:false, utsNamespace:false, networkNamespace:false, cgroupNamespace:false };
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const ns = (name) => fs.readlinkSync("/proc/self/ns/" + name);
let child;
let childDir;
let grandDir;
try {
  result.selfRoot = fs.readFileSync("/proc/self/cgroup", "utf8").trim() === "0::/";
  const rootStat = fs.statSync(root, { bigint:true });
  result.identityMatches = String(rootStat.dev) === expectedDev && String(rootStat.ino) === expectedIno;
  result.parentsHidden = result.selfRoot && !fs.existsSync(root + "/" + siblingCanary);
  const cap = /^CapEff:\s*([0-9a-fA-F]+)$/m.exec(fs.readFileSync("/proc/self/status", "utf8"));
  result.capEffZero = !!cap && BigInt("0x" + cap[1]) === 0n;
  result.fd5Closed = !fs.readdirSync("/proc/self/fd").some((fd) => {
    try {
      const open = fs.statSync("/proc/self/fd/" + fd, { bigint:true });
      return String(open.dev) === expectedDev && String(open.ino) === expectedIno;
    } catch { return false; }
  });
  for (const name of ["user","pid","ipc","uts","net","cgroup"]) result[name === "net" ? "networkNamespace" : name + "Namespace"] = ns(name) !== parentNs[name];
  try {
    const current = fs.readFileSync(root + "/cgroup.max.depth", "utf8");
    fs.writeFileSync(root + "/cgroup.max.depth", current);
  } catch (error) {
    result.rootWriteDenied = ["EPERM","EACCES","EROFS"].includes(error && error.code);
  }
  const suffix = process.pid.toString(16) + "-" + Date.now().toString(16);
  childDir = root + "/probe-" + suffix;
  grandDir = childDir + "/nested";
  fs.mkdirSync(childDir);
  fs.mkdirSync(grandDir);
  child = cp.spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio:"ignore" });
  fs.writeFileSync(grandDir + "/cgroup.procs", String(child.pid) + "\n");
  const enrolled = fs.readFileSync(grandDir + "/cgroup.procs", "utf8").split(/\s+/).includes(String(child.pid));
  fs.writeFileSync(grandDir + "/cgroup.kill", "1\n");
  for (let i=0;i<100;i++) {
    if (/^populated 0$/m.test(fs.readFileSync(grandDir + "/cgroup.events", "utf8"))) break;
    nap(10);
  }
  fs.rmdirSync(grandDir);
  grandDir = undefined;
  fs.rmdirSync(childDir);
  childDir = undefined;
  result.childLifecycle = enrolled;
} catch {
  // False fields are the fail-closed result.
} finally {
  try { if (child && child.pid) child.kill("SIGKILL"); } catch {}
  try { if (grandDir) fs.writeFileSync(grandDir + "/cgroup.kill", "1\n"); } catch {}
  try { if (grandDir) fs.rmdirSync(grandDir); } catch {}
  try { if (childDir) fs.rmdirSync(childDir); } catch {}
}
process.stdout.write(JSON.stringify(result) + "\n");
`;

export type ParentNamespaceSet = Record<"user" | "pid" | "ipc" | "uts" | "net" | "cgroup", string>;

export function buildLinuxCgroupProbeBwrapArgs(
  nodeExecutable: string,
  expectedScope: ScopeObjectIdentity,
  parentNamespaces: ParentNamespaceSet,
  siblingCanary = "rf-probe-sibling-0000000000000000"
): string[] {
  if (!isAbsolute(nodeExecutable)) throw new Error("probe node executable must be absolute");
  if (!/^rf-probe-sibling-[0-9a-f]{16}$/.test(siblingCanary)) throw new Error("invalid sibling canary name");
  const encodedNamespaces = Buffer.from(JSON.stringify(parentNamespaces), "utf8").toString("base64url");
  return [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--die-with-parent",
    "--new-session",
    ...VERIFIER_CGROUP_BWRAP_FRAGMENT,
    "--chdir", "/tmp",
    "--",
    nodeExecutable,
    "-e",
    LINUX_CGROUP_PROBE_PAYLOAD,
    expectedScope.dev,
    expectedScope.ino,
    encodedNamespaces,
    siblingCanary
  ];
}

function openPinnedScope(path: string): number {
  return openSync(path, LINUX_O_PATH | LINUX_O_DIRECTORY | LINUX_O_NOFOLLOW);
}

function pinnedIdentity(fd: number): ScopeObjectIdentity {
  const stat = fstatSync(fd, { bigint: true });
  if (!stat.isDirectory()) throw new Error("pinned cgroup FD is not a directory");
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function openAnchoredAttribute(scopeFd: number, name: string, flags: number): number {
  if (!/^cgroup\.[a-z.]+$/.test(name)) throw new Error("invalid cgroup attribute name");
  const fd = openSync(`/proc/self/fd/${scopeFd}/${name}`, flags | constants.O_NOFOLLOW);
  const stat = fstatSync(fd);
  if (!stat.isFile()) {
    closeSync(fd);
    throw new Error(`${name} is not a kernel attribute file`);
  }
  return fd;
}

function writeFullFd(fd: number, data: Buffer): number {
  let offset = 0;
  while (offset < data.length) {
    const written = writeSync(fd, data, offset, data.length - offset);
    if (written <= 0) break;
    offset += written;
  }
  return offset;
}

function readAllFd(fd: number, limit = 4096): string {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(Math.min(1024, limit - total + 1));
    const count = readSync(fd, chunk, 0, chunk.length, null);
    if (count === 0) break;
    total += count;
    if (total > limit) throw new Error("kernel attribute read exceeded bound");
    chunks.push(chunk.subarray(0, count));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function structuralIo(): StructuralLimitIo {
  return {
    fstat: pinnedIdentity,
    writeFileAtNoFollow(fd, name, data) {
      const attribute = openAnchoredAttribute(fd, name, constants.O_WRONLY);
      try {
        return writeFullFd(attribute, Buffer.from(data, "ascii"));
      } finally {
        closeSync(attribute);
      }
    },
    readFileAtNoFollow(fd, name) {
      const attribute = openAnchoredAttribute(fd, name, constants.O_RDONLY);
      try {
        return readAllFd(attribute);
      } finally {
        closeSync(attribute);
      }
    }
  };
}

function namespaceLinks(): ParentNamespaceSet {
  const result = {} as ParentNamespaceSet;
  for (const name of ["user", "pid", "ipc", "uts", "net", "cgroup"] as const) result[name] = readlinkSync(`/proc/self/ns/${name}`);
  return result;
}

function optionsOfCurrentMount(expected: MountInfoEntry, membership: string): string[] | undefined {
  try {
    const selected = selectUnifiedCgroupMount(parseMountInfo(cgroup2MountInfoOnly(readFileSync("/proc/self/mountinfo", "utf8"))), membership);
    if (!selected || selected.mountId !== expected.mountId || selected.majorMinor !== expected.majorMinor) return undefined;
    return [...new Set([...selected.mountOptions, ...selected.superOptions])].sort();
  } catch {
    return undefined;
  }
}

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function readBoundedStream(stream: NodeJS.ReadableStream | null, limit: number): Promise<Buffer> {
  if (!stream) throw new Error("required child stream is unavailable");
  return await new Promise<Buffer>((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    stream.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > limit) {
        reject(new Error(`child stream exceeded ${limit} bytes`));
        return;
      }
      chunks.push(bytes);
    });
    stream.on("end", () => resolvePromise(Buffer.concat(chunks, total)));
    stream.on("error", reject);
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolvePromise(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

function writeAnchored(scopeFd: number, name: string, data: string): void {
  const fd = openAnchoredAttribute(scopeFd, name, constants.O_WRONLY);
  try {
    const bytes = Buffer.from(data, "ascii");
    if (writeFullFd(fd, bytes) !== bytes.length) throw new Error(`short write to ${name}`);
  } finally {
    closeSync(fd);
  }
}

function readAnchored(scopeFd: number, name: string): string {
  const fd = openAnchoredAttribute(scopeFd, name, constants.O_RDONLY);
  try {
    return readAllFd(fd);
  } finally {
    closeSync(fd);
  }
}

function removeCgroupDescendants(path: string, expectedDev: string): boolean {
  let entries: Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>;
  try {
    entries = readdirSync(path, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const child = resolve(path, entry.name);
    const stat = lstatSync(child, { bigint: true });
    if (String(stat.dev) !== expectedDev || stat.isSymbolicLink()) return false;
    if (!removeCgroupDescendants(child, expectedDev)) return false;
  }
  try {
    rmdirSync(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function settleProbeScope(
  scopeFd: number,
  path: string,
  expected: ScopeObjectIdentity,
  pid?: number,
  graceMs = 50
): Promise<boolean> {
  if (pid && processGroupAlive(pid)) {
    try { process.kill(-pid, "SIGTERM"); } catch { /* cgroup.kill remains authoritative */ }
    const deadline = Date.now() + Math.max(0, graceMs);
    while (processGroupAlive(pid) && Date.now() < deadline) await delay(25);
  }
  if (pinnedIdentity(scopeFd).dev !== expected.dev || pinnedIdentity(scopeFd).ino !== expected.ino) return false;
  try { writeAnchored(scopeFd, "cgroup.kill", "1\n"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  const drainDeadline = Date.now() + CLEANUP_TIMEOUT_MS;
  while (Date.now() < drainDeadline) {
    try {
      if (parseCgroupEventsPopulation(readAnchored(scopeFd, "cgroup.events")) === 0) break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      return false;
    }
    await delay(25);
  }
  try {
    if (parseCgroupEventsPopulation(readAnchored(scopeFd, "cgroup.events")) !== 0) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  // FD-relative kill remains safe even after a rename/replacement, but pathname
  // recursion is allowed only after binding the current name back to the exact
  // journaled object. Never walk a foreign replacement.
  try {
    const named = lstatSync(path, { bigint: true });
    if (named.isSymbolicLink() || String(named.dev) !== expected.dev || String(named.ino) !== expected.ino) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    return !pid || !processGroupAlive(pid);
  }
  const removeDeadline = Date.now() + CLEANUP_TIMEOUT_MS;
  let removed = false;
  let pause = 1;
  while (Date.now() < removeDeadline && !removed) {
    removed = removeCgroupDescendants(path, expected.dev);
    if (!removed) { await delay(pause); pause = Math.min(100, pause * 2); }
  }
  if (!removed) return false;
  try {
    const replacement = statSync(path, { bigint: true });
    if (String(replacement.dev) !== expected.dev || String(replacement.ino) !== expected.ino) return false;
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  return !pid || !processGroupAlive(pid);
}

function currentDependencyIdentityMatches(dependency: TrustedExecutable): boolean {
  try {
    return sameExecutableIdentity(dependency.identity, inspectTrustedExecutable(dependency.command).identity);
  } catch {
    return false;
  }
}

/** Real disposable-scope characterization. It never path-binds cgroupfs. */
export async function runLinuxCgroupBehavioralProbe({ collected }: LinuxBehavioralProbeContext): Promise<LinuxBehavioralProbeResult> {
  const { evidence, outerScopeRoot, membership, mount, dependencies } = collected;
  if (!outerScopeRoot || !membership || !mount || !dependencies) {
    return { ok: false, reasonCode: "BEHAVIORAL_PROBE_FAILED", detail: "Linux evidence is incomplete before behavioral probing" };
  }
  for (const dependency of [dependencies.shell, dependencies.stat, dependencies.bubblewrap, dependencies.node]) {
    if (!currentDependencyIdentityMatches(dependency)) {
      return { ok: false, reasonCode: "BWRAP_IDENTITY_UNSAFE", detail: `trusted launcher dependency changed before spawn: ${basename(dependency.command)}` };
    }
  }

  const beforeOptions = optionsOfCurrentMount(mount, membership);
  if (!beforeOptions) return { ok: false, reasonCode: "CGROUP_MOUNT_UNSAFE", detail: "could not snapshot the exact cgroup2 mount before probing" };
  const name = `loop-${randomBytes(8).toString("hex")}`;
  const scopePath = resolve(outerScopeRoot, name);
  const siblingName = `rf-probe-sibling-${randomBytes(8).toString("hex")}`;
  const siblingPath = resolve(outerScopeRoot, siblingName);
  let scopeFd: number | undefined;
  let scopeIdentity: ScopeObjectIdentity | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let childExitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let payload: LinuxCgroupPayloadResult | undefined;
  let failure: LinuxBehavioralProbeResult | undefined;
  let settled = false;
  try {
    mkdirSync(siblingPath, { mode: 0o700 });
    mkdirSync(scopePath, { mode: 0o700 });
    scopeFd = openPinnedScope(scopePath);
    const identity = pinnedIdentity(scopeFd);
    scopeIdentity = identity;
    const limits = setAndVerifyStructuralLimits(structuralIo(), scopeFd, identity);
    if (!limits.ok) throw new Error(`structural limit setup failed [${limits.reason}]: ${limits.detail}`);

    const parentNamespaces = namespaceLinks();
    const bwrapArgs = buildLinuxCgroupProbeBwrapArgs(dependencies.node.command, identity, parentNamespaces, siblingName);
    const expectedMembership = `${membership === "/" ? "" : membership}/${name}`;
    const nonce = randomBytes(16).toString("hex");
    child = spawn(dependencies.shell.command, [
      "-c",
      LINUX_CGROUP_GATE_TRAMPOLINE,
      "relayforge-cgroup-launcher",
      dependencies.stat.command,
      `${identity.dev}:${identity.ino}`,
      expectedMembership,
      nonce,
      dependencies.bubblewrap.command,
      ...bwrapArgs
    ], {
      detached: true,
      env: { PATH: "/usr/bin:/bin", HOME: "/tmp", LANG: "C.UTF-8" },
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", scopeFd]
    });
    if (!child.pid) throw new Error("trusted launcher did not expose a PID");
    childExitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
      child!.once("error", reject);
      child!.once("close", (code, signal) => resolvePromise({ code, signal }));
    });
    void childExitPromise.catch(() => undefined);
    const stdoutPromise = readBoundedStream(child.stdout, PROBE_OUTPUT_MAX_BYTES);
    const stderrPromise = readBoundedStream(child.stderr, PROBE_OUTPUT_MAX_BYTES);
    void stdoutPromise.catch(() => undefined);
    void stderrPromise.catch(() => undefined);
    const statusStream = child.stdio[3] as NodeJS.ReadableStream | null;
    const gate = child.stdio[4] as NodeJS.WritableStream | null;
    const status = await withTimeout(readBoundedStream(statusStream, VERIFIER_CGROUP_STATUS_MAX_BYTES), VERIFIER_CGROUP_ENROLLMENT_TIMEOUT_MS, "enrollment status");
    const parsedStatus = parseVerifierEnrollmentStatus(status, child.pid, nonce);
    if (!parsedStatus.ok) throw new Error(`invalid enrollment status: ${parsedStatus.reason}`);
    const startTicks = parseProcStatStartTicks(readFileSync(`/proc/${child.pid}/stat`, "utf8"), child.pid);
    if (!startTicks) throw new Error("could not bind launcher PID to /proc startticks");
    if (parseUnifiedCgroupMembership(readFileSync(`/proc/${child.pid}/cgroup`, "utf8")) !== expectedMembership) {
      throw new Error("parent observed launcher outside the pinned scope");
    }
    if (pinnedIdentity(scopeFd).dev !== identity.dev || pinnedIdentity(scopeFd).ino !== identity.ino) throw new Error("scope FD identity changed after enrollment");
    for (const dependency of [dependencies.shell, dependencies.stat, dependencies.bubblewrap, dependencies.node]) {
      if (!currentDependencyIdentityMatches(dependency)) throw new Error(`trusted dependency changed after enrollment: ${dependency.command}`);
    }
    if (!gate) throw new Error("release gate stream is unavailable");
    gate.end(VERIFIER_CGROUP_GATE_TOKEN);

    const exit = await withTimeout(childExitPromise, PROBE_TIMEOUT_MS, "Bubblewrap behavioral probe");
    const stdout = await stdoutPromise;
    const stderr = await stderrPromise;
    if (exit.code !== 0) throw new Error(`Bubblewrap probe exited ${String(exit.code)}${stderr.length ? `: ${stderr.toString("utf8").slice(0, 512)}` : ""}`);
    for (const dependency of [dependencies.shell, dependencies.stat, dependencies.bubblewrap, dependencies.node]) {
      if (!currentDependencyIdentityMatches(dependency)) throw new Error(`trusted dependency changed after probe: ${dependency.command}`);
    }
    payload = parseLinuxCgroupPayloadResult(stdout);
  } catch (error) {
    try { (child?.stdio[4] as NodeJS.WritableStream | null | undefined)?.end(); } catch { /* EOF denies GO */ }
    failure = { ok: false, reasonCode: "BEHAVIORAL_PROBE_FAILED", detail: (error as Error).message };
  } finally {
    if (scopeFd !== undefined) {
      try {
        settled = scopeIdentity !== undefined && await settleProbeScope(scopeFd, scopePath, scopeIdentity, child?.pid);
      } catch {
        settled = false;
      }
      try { closeSync(scopeFd); } catch { settled = false; }
    } else {
      try { rmdirSync(scopePath); settled = true; } catch (error) { settled = (error as NodeJS.ErrnoException).code === "ENOENT"; }
    }
    try { rmdirSync(siblingPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") settled = false;
    }
  }

  const afterOptions = optionsOfCurrentMount(mount, membership);
  const optionsUnchanged = Boolean(afterOptions && JSON.stringify(afterOptions) === JSON.stringify(beforeOptions));
  if (!settled) return { ok: false, reasonCode: "BEHAVIORAL_PROBE_FAILED", detail: "disposable behavioral-probe scope could not be proven settled" };
  if (!optionsUnchanged) return { ok: false, reasonCode: "CGROUP_MOUNT_UNSAFE", detail: "host cgroup2 mount options changed during the behavioral probe" };
  if (failure) return failure;
  if (!payload) return { ok: false, reasonCode: "BEHAVIORAL_PROBE_FAILED", detail: "behavioral probe produced no result" };
  const behavior: BubblewrapBehavioralEvidence = {
    performed: true,
    strictCgroupNamespace: payload.cgroupNamespace,
    fdBind: payload.identityMatches,
    userNamespace: payload.userNamespace,
    pidNamespace: payload.pidNamespace,
    ipcNamespace: payload.ipcNamespace,
    utsNamespace: payload.utsNamespace,
    networkNamespace: payload.networkNamespace,
    capabilityDrop: payload.capEffZero,
    namespaceRootIsSlash: payload.selfRoot,
    pinnedScopeIdentityMatched: payload.identityMatches,
    childCgroupLifecycleWorked: payload.childLifecycle,
    rootStructuralWriteDenied: payload.rootWriteDenied,
    parentAndSiblingsHidden: payload.parentsHidden,
    sourceFdClosedInPayload: payload.fd5Closed,
    hostMountOptionsUnchanged: optionsUnchanged,
    disposableScopeSettled: settled
  };
  return { ok: true, behavior };
}

/** The production entry point. Injected collectors/runners are import-only test seams. */
export async function probeVerifierCgroupJailLinux(options: LinuxCgroupProbeOptions = {}): Promise<VerifierCgroupJailCapability> {
  const collect = options.collectEvidence ?? collectLinuxCgroupEvidence;
  const run = options.runBehavioralProbe ?? runLinuxCgroupBehavioralProbe;
  const collected = collect();
  const preflight = probeVerifierCgroupJail(collected.evidence);
  if (!preflight.available && preflight.reasonCode !== "BEHAVIORAL_PROBE_FAILED") return preflight;
  const result = await run({ collected });
  if (!result.ok) return { available: false, reasonCode: result.reasonCode, detail: result.detail };
  const complete: VerifierCgroupProbeEvidence = {
    ...collected.evidence,
    bubblewrap: { ...collected.evidence.bubblewrap, behavior: result.behavior }
  };
  const capability = probeVerifierCgroupJail(complete);
  if (!capability.available) {
    const failed = Object.entries(result.behavior).filter(([, value]) => value === false).map(([key]) => key);
    if (failed.length) return { ...capability, detail: `${capability.detail}; failed assertions: ${failed.join(", ")}` };
  }
  return capability;
}

export type LinuxVerifierCgroupRuntime = {
  capability: VerifierCgroupJailCapability;
  collected: CollectedLinuxCgroupEvidence;
};

export type LinuxVerifierScopeMetadata = {
  runId: string;
  attemptId: string;
  leaseId: string;
};

let cachedRuntime:
  | { key: string; value: LinuxVerifierCgroupRuntime }
  | { key: string; pending: Promise<LinuxVerifierCgroupRuntime> }
  | undefined;

function collectedRuntimeKey(collected: CollectedLinuxCgroupEvidence): string {
  const { evidence, mount, membership, dependencies } = collected;
  return JSON.stringify({
    platform: evidence.platform,
    kernelRelease: evidence.kernelRelease,
    mountId: mount?.mountId,
    mountDevice: mount?.majorMinor,
    mountOptions: mount ? [...new Set([...mount.mountOptions, ...mount.superOptions])].sort() : undefined,
    membership,
    effectiveUid: evidence.effectiveUid,
    userNamespaceMapping: evidence.userNamespaceMapping,
    delegation: evidence.delegationFile,
    delegationOwnership: evidence.delegationOwnership,
    dependencies: dependencies && Object.fromEntries(
      Object.entries(dependencies).sort(([left], [right]) => left.localeCompare(right)).map(([name, dependency]) => [name, dependency.identity])
    )
  });
}

/**
 * Probe once per exact runtime identity. Evidence is still collected on every call, so a mount,
 * uid-map, delegation, or trusted-executable change invalidates the token instead of inheriting a
 * stale successful probe.
 */
export async function getCachedLinuxVerifierCgroupRuntime(
  options: LinuxCgroupProbeOptions = {}
): Promise<LinuxVerifierCgroupRuntime> {
  const collect = options.collectEvidence ?? collectLinuxCgroupEvidence;
  const collected = collect();
  if (options.collectEvidence || options.runBehavioralProbe) {
    const capability = await probeVerifierCgroupJailLinux({
      collectEvidence: () => collected,
      ...(options.runBehavioralProbe ? { runBehavioralProbe: options.runBehavioralProbe } : {})
    });
    return { capability, collected };
  }
  const key = collectedRuntimeKey(collected);
  if (cachedRuntime?.key === key) {
    if ("value" in cachedRuntime) return { capability: cachedRuntime.value.capability, collected };
    const value = await cachedRuntime.pending;
    return { capability: value.capability, collected };
  }
  const pending = probeVerifierCgroupJailLinux({
    collectEvidence: () => collected,
    ...(options.runBehavioralProbe ? { runBehavioralProbe: options.runBehavioralProbe } : {})
  }).then((capability) => ({ capability, collected }));
  cachedRuntime = { key, pending };
  const value = await pending;
  cachedRuntime = { key, value };
  return value;
}

/** Last completed probe, for synchronous diagnostics only. It never manufactures availability. */
export function cachedLinuxVerifierCgroupCapability(): VerifierCgroupJailCapability | undefined {
  return cachedRuntime && "value" in cachedRuntime ? cachedRuntime.value.capability : undefined;
}

/** Test-only import seam; production has no environment switch for capability state. */
export function resetLinuxVerifierCgroupRuntimeCacheForTest(): void {
  cachedRuntime = undefined;
}

function assertVerifierWritableCheckout(cwd: string): string {
  const checkout = realpathSync(cwd);
  const stat = lstatSync(checkout);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("verifier checkout must be a real directory");
  if (checkout === "/sys" || checkout.startsWith("/sys/")) {
    throw new Error("verifier checkout may not grant writable access to /sys or a descendant");
  }
  return checkout;
}

/** Compose a verifier payload around the exact strict fragment obtained from an available token. */
export function buildLinuxVerifierBwrapArgs(
  plan: ReturnType<typeof buildVerifierCgroupLaunchPlan>,
  command: string,
  args: readonly string[],
  cwd: string
): string[] {
  const checkout = assertVerifierWritableCheckout(cwd);
  if (!command || command.includes("\0") || args.some((arg) => arg.includes("\0"))) throw new Error("invalid verifier argv");
  if (plan.cgroupArgs.length !== VERIFIER_CGROUP_BWRAP_FRAGMENT.length ||
      plan.cgroupArgs.some((arg, index) => arg !== VERIFIER_CGROUP_BWRAP_FRAGMENT[index])) {
    throw new Error("verifier launch plan does not contain the exact strict cgroup fragment");
  }
  return [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--die-with-parent",
    "--new-session",
    "--bind", checkout, checkout,
    ...plan.cgroupArgs,
    "--chdir", checkout,
    "--",
    command,
    ...args
  ];
}

function sleepSyncMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function exactNamedScope(path: string, expected: ScopeObjectIdentity): boolean {
  try {
    const named = lstatSync(path, { bigint: true });
    return !named.isSymbolicLink() && named.isDirectory() && String(named.dev) === expected.dev && String(named.ino) === expected.ino;
  } catch {
    return false;
  }
}

class LinuxVerifierCgroupScope implements ProcessScope {
  readonly kind = "cgroup2" as const;
  readonly name: string;
  readonly path: string;
  readonly identity: ScopeObjectIdentity;
  readonly #expectedMembership: string;
  #fd: number | undefined;
  #pid: number | undefined;
  #startTicks: string | undefined;
  #nonce = randomBytes(16).toString("hex");
  #status = Buffer.alloc(0);
  #statusEnded = false;
  #bindFailure: string | undefined;
  #removed = false;
  #proof: string | undefined;
  #reaping: Promise<boolean> | undefined;
  #launched = false;

  constructor(
    private readonly runtime: { capability: VerifierCgroupAvailableCapability; collected: CollectedLinuxCgroupEvidence },
    private readonly metadata: LinuxVerifierScopeMetadata,
    private readonly cwd: string
  ) {
    const { outerScopeRoot, membership } = runtime.collected;
    if (!outerScopeRoot || !membership || !runtime.collected.dependencies) throw new Error("available verifier runtime lacks launch evidence");
    this.name = `loop-${randomBytes(8).toString("hex")}`;
    this.path = resolve(outerScopeRoot, this.name);
    this.#expectedMembership = `${membership === "/" ? "" : membership}/${this.name}`;
    mkdirSync(this.path, { mode: 0o700 });
    try {
      this.#fd = openPinnedScope(this.path);
      this.identity = pinnedIdentity(this.#fd);
      const limits = setAndVerifyStructuralLimits(structuralIo(), this.#fd, this.identity);
      if (!limits.ok) throw new Error(`structural limit setup failed [${limits.reason}]: ${limits.detail}`);
      assertVerifierWritableCheckout(cwd);
    } catch (error) {
      if (this.#fd !== undefined) {
        try { closeSync(this.#fd); } catch { /* best effort */ }
        this.#fd = undefined;
      }
      try { rmdirSync(this.path); } catch { /* retained rather than touching a foreign/non-empty object */ }
      throw error;
    }
  }

  launch(command: string, args: string[]): LaunchSpec {
    if (this.#launched || this.#fd === undefined) throw new Error("verifier cgroup scope is not launchable");
    this.#launched = true;
    const dependencies = this.runtime.collected.dependencies!;
    for (const dependency of [dependencies.shell, dependencies.stat, dependencies.bubblewrap, dependencies.node]) {
      if (!currentDependencyIdentityMatches(dependency)) throw new Error(`trusted launcher dependency changed before verifier spawn: ${basename(dependency.command)}`);
    }
    const currentBwrap = inspectTrustedExecutable(dependencies.bubblewrap.command);
    const plan = buildVerifierCgroupLaunchPlan(this.runtime.capability, this.#fd, currentBwrap.identity);
    const bwrapArgs = buildLinuxVerifierBwrapArgs(plan, command, args, this.cwd);
    return {
      command: dependencies.shell.command,
      args: [
        "-c",
        LINUX_CGROUP_GATE_TRAMPOLINE,
        "relayforge-verifier-cgroup-launcher",
        dependencies.stat.command,
        `${this.identity.dev}:${this.identity.ino}`,
        this.#expectedMembership,
        this.#nonce,
        plan.command,
        ...bwrapArgs
      ],
      stdio: [...plan.stdio],
      statusFd: plan.statusFd,
      gateFd: plan.gateFd,
      gateToken: VERIFIER_CGROUP_GATE_TOKEN
    };
  }

  bind(pid: number): void {
    if (!Number.isSafeInteger(pid) || pid <= 0 || this.#pid !== undefined || this.#fd === undefined) {
      this.#bindFailure = "invalid or duplicate verifier launcher PID";
      return;
    }
    this.#pid = pid;
    const deadline = Date.now() + VERIFIER_CGROUP_ENROLLMENT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const startTicks = parseProcStatStartTicks(readFileSync(`/proc/${pid}/stat`, "utf8"), pid);
        const member = parseUnifiedCgroupMembership(readFileSync(`/proc/${pid}/cgroup`, "utf8"));
        if (startTicks && member === this.#expectedMembership) {
          this.#startTicks = startTicks;
          break;
        }
      } catch {
        // The exact typed failure is set below after the bounded wait.
      }
      sleepSyncMs(10);
    }
    if (!this.#startTicks) {
      this.#bindFailure = "launcher did not enter the exact pinned cgroup before the enrollment deadline";
      return;
    }
    const observed = pinnedIdentity(this.#fd);
    if (observed.dev !== this.identity.dev || observed.ino !== this.identity.ino) {
      this.#bindFailure = "pinned verifier cgroup identity changed after enrollment";
      return;
    }
    const dependencies = this.runtime.collected.dependencies!;
    for (const dependency of [dependencies.shell, dependencies.stat, dependencies.bubblewrap, dependencies.node]) {
      if (!currentDependencyIdentityMatches(dependency)) {
        this.#bindFailure = `trusted launcher dependency changed after enrollment: ${basename(dependency.command)}`;
        return;
      }
    }
  }

  spawned(): boolean { return this.#pid !== undefined; }

  ref(): ScopeRef | undefined {
    return this.#pid === undefined ? undefined : { backend: "cgroup2", pid: this.#pid, name: this.name, ino: this.identity.ino };
  }

  scopeId(): string {
    const ref = this.ref();
    return ref ? scopeIdOf(ref) : "unspawned";
  }

  journalLine(): string {
    if (this.#bindFailure) throw new Error(this.#bindFailure);
    if (this.#pid === undefined || this.#startTicks === undefined) throw new Error("verifier scope identity is incomplete");
    const identity: VerifierCgroupScopeIdentity = {
      version: 2,
      dev: this.identity.dev,
      ino: this.identity.ino,
      name: this.name,
      pid: this.#pid,
      startTicks: this.#startTicks
    };
    const record: VerifierCgroupJournalRecord = {
      v: 2,
      kind: "verifier-cgroup",
      runId: this.metadata.runId,
      attemptId: this.metadata.attemptId,
      leaseId: this.metadata.leaseId,
      scopeId: verifierCgroupScopeId(identity),
      maxDescendants: this.runtime.capability.maxDescendants,
      maxDepth: this.runtime.capability.maxDepth
    };
    return serializeVerifierCgroupJournalRecord(record).slice(0, -1);
  }

  noteStatus(chunk: Buffer): void {
    if (this.#status.length > VERIFIER_CGROUP_STATUS_MAX_BYTES) return;
    const remaining = VERIFIER_CGROUP_STATUS_MAX_BYTES + 1 - this.#status.length;
    this.#status = Buffer.concat([this.#status, chunk.subarray(0, Math.max(0, remaining))]);
  }

  noteStatusEnd(): void { this.#statusEnded = true; }

  enrolled(): boolean {
    if (!this.#statusEnded || this.#pid === undefined || this.#bindFailure) return false;
    return parseVerifierEnrollmentStatus(this.#status, this.#pid, this.#nonce).ok;
  }

  preExecFailure(): string | undefined {
    if (this.#bindFailure) return this.#bindFailure;
    if (this.#pid === undefined) return undefined;
    if (!this.#statusEnded) return "authenticated enrollment status pipe did not close";
    const parsed = parseVerifierEnrollmentStatus(this.#status, this.#pid, this.#nonce);
    return parsed.ok ? undefined : `authenticated enrollment status was rejected (${parsed.reason})`;
  }

  alive(): boolean {
    if (this.#removed || this.#fd === undefined) return false;
    try {
      // Transport "survivor" means a task still belongs to this membership set. A just-reaped
      // Bubblewrap leader can remain briefly visible as a zombie process group after cgroup.events
      // already proves the scope empty; that is handled by the final settlement proof, not
      // misclassified as a provider-created descendant.
      return parseCgroupEventsPopulation(readAnchored(this.#fd, "cgroup.events")) !== 0;
    } catch {
      return exactNamedScope(this.path, this.identity);
    }
  }

  reap(graceMs = CLEANUP_TIMEOUT_MS): Promise<boolean> {
    this.#reaping ??= this.#tearDown(graceMs);
    return this.#reaping;
  }

  async #tearDown(graceMs: number): Promise<boolean> {
    if (this.#removed) return this.#proof !== undefined;
    if (this.#fd === undefined) return false;
    const settled = await settleProbeScope(this.#fd, this.path, this.identity, this.#pid, graceMs);
    try { closeSync(this.#fd); } catch { return false; }
    this.#fd = undefined;
    if (!settled) return false;
    this.#removed = true;
    const ref = this.ref();
    if (ref) this.#proof = reapProofOf(ref);
    return true;
  }

  reapProof(): string | undefined { return this.#proof; }

  dispose(): void {
    if (this.#removed || this.#pid !== undefined) return;
    const fd = this.#fd;
    if (fd === undefined) return;
    try {
      if (!exactNamedScope(this.path, this.identity)) return;
      closeSync(fd);
      this.#fd = undefined;
      rmdirSync(this.path);
      this.#removed = true;
    } catch {
      // Never recurse or remove after an identity mismatch.
    }
  }
}

class LinuxVerifierCgroupBackend implements ScopeBackend {
  readonly kind = "cgroup2" as const;
  readonly strong = true;
  constructor(
    private readonly runtime: { capability: VerifierCgroupAvailableCapability; collected: CollectedLinuxCgroupEvidence },
    private readonly metadata: LinuxVerifierScopeMetadata,
    private readonly cwd: string
  ) {}
  open(): ProcessScope {
    return new LinuxVerifierCgroupScope(this.runtime, this.metadata, this.cwd);
  }
}

export function linuxVerifierCgroupBackend(
  runtime: LinuxVerifierCgroupRuntime,
  metadata: LinuxVerifierScopeMetadata,
  cwd: string
): ScopeBackend {
  if (!runtime.capability.available) throw new Error(`verifier cgroup jail unavailable [${runtime.capability.reasonCode}]: ${runtime.capability.detail}`);
  // The runtime identity that authorized this adapter is deliberately materialized here. This
  // catches accidental token substitution before any scope allocation.
  verifierCgroupRuntimeCacheKey(runtime.capability.runtimeIdentity);
  return new LinuxVerifierCgroupBackend({ capability: runtime.capability, collected: runtime.collected }, metadata, cwd);
}

export type LinuxVerifierRecoveryOutcome = "reaped" | "gone" | "foreign" | "unresolved";

/**
 * Recover one v2 verifier journal record without ever signalling its recorded PID. A matching
 * cgroup object is killed only through an O_PATH-pinned FD; an absent object is discharged only
 * when the original process group is ESRCH. Legacy records are deliberately unsupported here.
 */
export async function reapLinuxVerifierCgroupJournalLine(
  line: string,
  collected: CollectedLinuxCgroupEvidence = collectLinuxCgroupEvidence()
): Promise<LinuxVerifierRecoveryOutcome> {
  const parsed = parseVerifierCgroupJournalLine(line);
  if (parsed.kind !== "v2" || !collected.outerScopeRoot) return "unresolved";
  const path = resolve(collected.outerScopeRoot, parsed.identity.name);
  let named: BigStat;
  try {
    named = lstatSync(path, { bigint: true }) as unknown as BigStat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "unresolved";
    return processGroupAlive(parsed.identity.pid) ? "unresolved" : "gone";
  }
  if (named.isSymbolicLink() || !named.isDirectory() || String(named.dev) !== parsed.identity.dev || String(named.ino) !== parsed.identity.ino) {
    return "foreign";
  }
  let fd: number;
  try {
    fd = openPinnedScope(path);
  } catch {
    return "unresolved";
  }
  try {
    const identity = pinnedIdentity(fd);
    if (identity.dev !== parsed.identity.dev || identity.ino !== parsed.identity.ino) return "foreign";
    return await settleProbeScope(fd, path, identity, undefined, 0) ? "reaped" : "unresolved";
  } finally {
    try { closeSync(fd); } catch { /* unresolved state is retained by the caller */ }
  }
}

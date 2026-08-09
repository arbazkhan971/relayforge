import { posix } from "node:path";
import { isValidId } from "./ids.js";

/**
 * Pure policy and protocol kernel for ADR 001. This module deliberately does not
 * perform a Bubblewrap or cgroup launch. Production integration must provide the
 * results of a real behavioral probe and FD-relative, no-follow operations; a
 * mount-table or `bwrap --help` check can never manufacture an available
 * capability here.
 */

export const VERIFIER_CGROUP_MOUNT_POINT = "/sys/fs/cgroup" as const;
export const VERIFIER_CGROUP_MAX_DESCENDANTS = 256 as const;
export const VERIFIER_CGROUP_MAX_DEPTH = 16 as const;
export const VERIFIER_CGROUP_STATUS_FD = 3 as const;
export const VERIFIER_CGROUP_GATE_FD = 4 as const;
export const VERIFIER_CGROUP_SCOPE_FD = 5 as const;
export const VERIFIER_CGROUP_STATUS_MAX_BYTES = 128 as const;
export const VERIFIER_CGROUP_ENROLLMENT_TIMEOUT_MS = 5_000 as const;
export const VERIFIER_CGROUP_GATE_TOKEN = "GO\n" as const;

export const VERIFIER_CGROUP_UNAVAILABLE_REASONS = [
  "NOT_LINUX",
  "CGROUP_V2_UNAVAILABLE",
  "CGROUP_MOUNT_UNSAFE",
  "STRONG_SCOPE_UNAVAILABLE",
  "NSDELEGATE_MISSING",
  "CGROUP_KILL_MISSING",
  "STRUCTURAL_LIMITS_MISSING",
  "DELEGATION_FILES_UNAVAILABLE",
  "DELEGATION_OWNERSHIP_UNAVAILABLE",
  "BWRAP_UNAVAILABLE",
  "BWRAP_IDENTITY_UNSAFE",
  "BWRAP_CGROUP_NAMESPACE_UNAVAILABLE",
  "BWRAP_FD_BIND_UNAVAILABLE",
  "BWRAP_NAMESPACE_SET_UNAVAILABLE",
  "BEHAVIORAL_PROBE_FAILED"
] as const;

export type VerifierCgroupUnavailableReason = (typeof VERIFIER_CGROUP_UNAVAILABLE_REASONS)[number];

export type VerifierCgroupUnavailableCapability = {
  available: false;
  reasonCode: VerifierCgroupUnavailableReason;
  detail: string;
};

export type ExecutableIdentity = {
  canonicalPath: string;
  dev: string;
  ino: string;
  mtimeNs: string;
};

export type VerifierCgroupRuntimeIdentity = {
  kernelRelease: string;
  cgroupMountId: number;
  cgroupMountDevice: string;
  cgroupMountOptions: readonly string[];
  bubblewrap: ExecutableIdentity;
  effectiveUid: number;
  userNamespaceMapping: string;
};

export type VerifierCgroupAvailableCapability = {
  available: true;
  cgroupVersion: 2;
  mountPoint: typeof VERIFIER_CGROUP_MOUNT_POINT;
  mountDevice: string;
  mountOptions: readonly string[];
  nsdelegate: true;
  strictCgroupNamespace: true;
  fdBind: true;
  strongOuterScope: true;
  delegationFiles: readonly string[];
  maxDescendants: typeof VERIFIER_CGROUP_MAX_DESCENDANTS;
  maxDepth: typeof VERIFIER_CGROUP_MAX_DEPTH;
  /** Cache identity. Every launch must re-stat Bubblewrap against this value. */
  runtimeIdentity: VerifierCgroupRuntimeIdentity;
};

export type VerifierCgroupJailCapability =
  | VerifierCgroupUnavailableCapability
  | VerifierCgroupAvailableCapability;

export type ProbeRead =
  | { ok: true; text: string }
  | { ok: false; code: string };

export type BubblewrapBehavioralEvidence = {
  /** Must mean an actual disposable-scope launch, never version/help inspection. */
  performed: boolean;
  strictCgroupNamespace: boolean;
  fdBind: boolean;
  userNamespace: boolean;
  pidNamespace: boolean;
  ipcNamespace: boolean;
  utsNamespace: boolean;
  networkNamespace: boolean;
  capabilityDrop: boolean;
  namespaceRootIsSlash: boolean;
  pinnedScopeIdentityMatched: boolean;
  childCgroupLifecycleWorked: boolean;
  rootStructuralWriteDenied: boolean;
  parentAndSiblingsHidden: boolean;
  sourceFdClosedInPayload: boolean;
  hostMountOptionsUnchanged: boolean;
  disposableScopeSettled: boolean;
};

export type VerifierCgroupProbeEvidence = {
  platform: string;
  kernelRelease: string;
  mountInfo: ProbeRead;
  selfCgroup: ProbeRead;
  effectiveUid: number;
  userNamespaceMapping: string;
  strongOuterScope: boolean;
  /** Entries exposed by a fresh child of the strong outer scope. */
  outerScopeFiles: readonly string[];
  delegationFile: ProbeRead;
  delegationOwnership: boolean;
  bubblewrap: {
    available: boolean;
    identitySafe: boolean;
    identity?: ExecutableIdentity;
    behavior?: BubblewrapBehavioralEvidence;
  };
};

export type MountInfoEntry = {
  mountId: number;
  parentId: number;
  majorMinor: string;
  root: string;
  mountPoint: string;
  mountOptions: readonly string[];
  optionalFields: readonly string[];
  fsType: string;
  mountSource: string;
  superOptions: readonly string[];
};

const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/;
const SCOPE_NAME = /^loop-[0-9a-f]{16}$/;
const NONCE = /^[0-9a-f]{32}$/;
const DELEGATION_FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const REQUIRED_MOUNT_OPTIONS = ["rw", "nosuid", "nodev", "noexec"] as const;
const DELEGATION_FALLBACK = ["cgroup.procs", "cgroup.subtree_control", "cgroup.threads"] as const;

function unavailable(reasonCode: VerifierCgroupUnavailableReason, detail: string): VerifierCgroupUnavailableCapability {
  return { available: false, reasonCode, detail };
}

function decodeMountInfoField(field: string): string {
  let decoded = "";
  for (let index = 0; index < field.length; index += 1) {
    if (field[index] !== "\\") {
      decoded += field[index];
      continue;
    }
    const escape = field.slice(index + 1, index + 4);
    if (!/^[0-7]{3}$/.test(escape)) throw new Error(`invalid mountinfo escape in ${JSON.stringify(field)}`);
    decoded += String.fromCharCode(Number.parseInt(escape, 8));
    index += 3;
  }
  if (decoded.includes("\0") || decoded.includes("\n") || decoded.includes("\r")) {
    throw new Error("mountinfo field contains a forbidden control character");
  }
  return decoded;
}

function parseCanonicalPositiveInt(raw: string, label: string): number {
  if (!POSITIVE_DECIMAL.test(raw)) throw new Error(`${label} is not a canonical positive decimal`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} exceeds the safe integer range`);
  return value;
}

/** Parse Linux mountinfo without losing escaped spaces, tabs, or backslashes. */
export function parseMountInfo(raw: string): MountInfoEntry[] {
  const lines = raw.split("\n").filter((line) => line.length > 0);
  return lines.map((line, lineIndex) => {
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    if (separator < 6 || fields.length < separator + 4) {
      throw new Error(`malformed mountinfo line ${lineIndex + 1}`);
    }
    const mountId = parseCanonicalPositiveInt(fields[0], "mount id");
    const parentId = parseCanonicalPositiveInt(fields[1], "parent mount id");
    if (!/^[0-9]+:[0-9]+$/.test(fields[2])) throw new Error(`invalid mount device on line ${lineIndex + 1}`);
    const root = decodeMountInfoField(fields[3]);
    const mountPoint = decodeMountInfoField(fields[4]);
    if (!root.startsWith("/") || !mountPoint.startsWith("/")) throw new Error(`non-absolute mount path on line ${lineIndex + 1}`);
    const fsType = fields[separator + 1];
    const mountSource = decodeMountInfoField(fields[separator + 2]);
    const superOptions = fields.slice(separator + 3).join(" ").split(",").filter(Boolean);
    return {
      mountId,
      parentId,
      majorMinor: fields[2],
      root,
      mountPoint,
      mountOptions: fields[5].split(",").filter(Boolean),
      optionalFields: fields.slice(6, separator),
      fsType,
      mountSource,
      superOptions
    };
  });
}

/** `/proc/self/cgroup` must identify exactly one unified-v2 membership. */
export function parseUnifiedCgroupMembership(raw: string): string {
  const matches = raw.split("\n").filter((line) => line.startsWith("0::"));
  if (matches.length !== 1) throw new Error("expected exactly one 0:: cgroup-v2 membership");
  const membership = matches[0].slice(3);
  if (!membership.startsWith("/") || membership.includes("\0") || membership.includes("\\")) {
    throw new Error("cgroup-v2 membership is not an absolute safe path");
  }
  if (posix.normalize(membership) !== membership || membership.split("/").includes("..")) {
    throw new Error("cgroup-v2 membership is not canonical");
  }
  return membership;
}

function pathIsWithinRoot(path: string, root: string): boolean {
  return root === "/" || path === root || path.startsWith(`${root}/`);
}

/** Select the most-specific cgroup2 mount whose superblock root contains this process. */
export function selectUnifiedCgroupMount(entries: readonly MountInfoEntry[], membership: string): MountInfoEntry | undefined {
  return entries
    .filter((entry) => entry.fsType === "cgroup2" && pathIsWithinRoot(membership, entry.root))
    .sort((left, right) => right.root.length - left.root.length)[0];
}

export function parseDelegationFiles(read: ProbeRead): readonly string[] {
  if (!read.ok) {
    if (read.code === "ENOENT") return DELEGATION_FALLBACK;
    throw new Error(`cannot read /sys/kernel/cgroup/delegate: ${read.code}`);
  }
  const files = read.text.split(/[ \t\r\n]+/).filter(Boolean);
  if (files.length === 0) throw new Error("delegation allowlist is empty");
  const seen = new Set<string>();
  for (const file of files) {
    if (!DELEGATION_FILE.test(file) || file === "." || file === ".." || file.includes("..")) {
      throw new Error(`invalid delegation file ${JSON.stringify(file)}`);
    }
    if (seen.has(file)) throw new Error(`duplicate delegation file ${file}`);
    seen.add(file);
  }
  for (const required of DELEGATION_FALLBACK) {
    if (!seen.has(required)) throw new Error(`delegation allowlist omits ${required}`);
  }
  return [...files].sort();
}

function validDecimalIdentity(value: string, positive: boolean): boolean {
  if (!(positive ? POSITIVE_DECIMAL : DECIMAL).test(value)) return false;
  try {
    const parsed = BigInt(value);
    return parsed <= 18_446_744_073_709_551_615n && (!positive || parsed > 0n);
  } catch {
    return false;
  }
}

export function executableIdentityIsValid(identity: ExecutableIdentity | undefined): identity is ExecutableIdentity {
  return Boolean(
    identity &&
      identity.canonicalPath.startsWith("/") &&
      posix.normalize(identity.canonicalPath) === identity.canonicalPath &&
      validDecimalIdentity(identity.dev, false) &&
      validDecimalIdentity(identity.ino, true) &&
      validDecimalIdentity(identity.mtimeNs, false)
  );
}

export function sameExecutableIdentity(left: ExecutableIdentity, right: ExecutableIdentity): boolean {
  return left.canonicalPath === right.canonicalPath && left.dev === right.dev && left.ino === right.ino && left.mtimeNs === right.mtimeNs;
}

/**
 * Turn independently collected evidence into the sole launch-enabling token.
 * `behavior.performed` is intentionally mandatory: syntactic feature detection
 * cannot reach the available branch.
 */
export function probeVerifierCgroupJail(evidence: VerifierCgroupProbeEvidence): VerifierCgroupJailCapability {
  if (evidence.platform !== "linux") return unavailable("NOT_LINUX", `verifier cgroup delegation requires Linux, found ${evidence.platform}`);
  if (!evidence.mountInfo.ok || !evidence.selfCgroup.ok) {
    return unavailable("CGROUP_V2_UNAVAILABLE", "cannot read mountinfo and unified cgroup membership");
  }

  let entries: MountInfoEntry[];
  let membership: string;
  try {
    entries = parseMountInfo(evidence.mountInfo.text);
    membership = parseUnifiedCgroupMembership(evidence.selfCgroup.text);
  } catch (error) {
    return unavailable("CGROUP_MOUNT_UNSAFE", (error as Error).message);
  }
  const allV2 = entries.filter((entry) => entry.fsType === "cgroup2");
  if (allV2.length === 0) return unavailable("CGROUP_V2_UNAVAILABLE", "no cgroup2 superblock is mounted");
  const mount = selectUnifiedCgroupMount(entries, membership);
  if (!mount || mount.mountPoint !== VERIFIER_CGROUP_MOUNT_POINT) {
    return unavailable("CGROUP_MOUNT_UNSAFE", "the process membership is not served by the canonical cgroup2 mount");
  }
  const mountOptions = [...new Set([...mount.mountOptions, ...mount.superOptions])].sort();
  const optionSet = new Set(mountOptions);
  for (const required of REQUIRED_MOUNT_OPTIONS) {
    if (!optionSet.has(required)) return unavailable("CGROUP_MOUNT_UNSAFE", `cgroup2 mount lacks required ${required} option`);
  }
  if (optionSet.has("ro")) return unavailable("CGROUP_MOUNT_UNSAFE", "cgroup2 mount is read-only");
  if (!evidence.strongOuterScope) return unavailable("STRONG_SCOPE_UNAVAILABLE", "the strong outer settlement scope is unavailable");
  if (!optionSet.has("nsdelegate")) return unavailable("NSDELEGATE_MISSING", "cgroup2 was not mounted with nsdelegate");

  const scopeFiles = new Set(evidence.outerScopeFiles);
  if (!scopeFiles.has("cgroup.kill") || !scopeFiles.has("cgroup.events") || !scopeFiles.has("cgroup.procs")) {
    return unavailable("CGROUP_KILL_MISSING", "fresh outer scope lacks cgroup.kill, cgroup.events, or cgroup.procs");
  }
  if (!scopeFiles.has("cgroup.max.descendants") || !scopeFiles.has("cgroup.max.depth")) {
    return unavailable("STRUCTURAL_LIMITS_MISSING", "fresh outer scope lacks structural limit files");
  }

  let delegationFiles: readonly string[];
  try {
    delegationFiles = parseDelegationFiles(evidence.delegationFile);
  } catch (error) {
    return unavailable("DELEGATION_FILES_UNAVAILABLE", (error as Error).message);
  }
  if (!evidence.delegationOwnership) {
    return unavailable("DELEGATION_OWNERSHIP_UNAVAILABLE", "delegation directory/allowlist ownership cannot be established safely");
  }
  if (!evidence.bubblewrap.available) return unavailable("BWRAP_UNAVAILABLE", "Bubblewrap is unavailable");
  if (!evidence.bubblewrap.identitySafe || !executableIdentityIsValid(evidence.bubblewrap.identity)) {
    return unavailable("BWRAP_IDENTITY_UNSAFE", "Bubblewrap executable or an ancestor is mutable by the effective uid, or its identity is invalid");
  }
  const behavior = evidence.bubblewrap.behavior;
  if (!behavior?.performed) return unavailable("BEHAVIORAL_PROBE_FAILED", "no real disposable-scope Bubblewrap probe was performed");
  if (!behavior.strictCgroupNamespace) {
    return unavailable("BWRAP_CGROUP_NAMESPACE_UNAVAILABLE", "strict Bubblewrap cgroup namespace behavior was not proven");
  }
  if (!behavior.fdBind) return unavailable("BWRAP_FD_BIND_UNAVAILABLE", "Bubblewrap --bind-fd behavior was not proven");
  if (!(behavior.userNamespace && behavior.pidNamespace && behavior.ipcNamespace && behavior.utsNamespace && behavior.networkNamespace)) {
    return unavailable("BWRAP_NAMESPACE_SET_UNAVAILABLE", "the complete strict user/PID/IPC/UTS/network namespace set was not proven");
  }
  const remainingBehavior = [
    behavior.capabilityDrop,
    behavior.namespaceRootIsSlash,
    behavior.pinnedScopeIdentityMatched,
    behavior.childCgroupLifecycleWorked,
    behavior.rootStructuralWriteDenied,
    behavior.parentAndSiblingsHidden,
    behavior.sourceFdClosedInPayload,
    behavior.hostMountOptionsUnchanged,
    behavior.disposableScopeSettled
  ];
  if (remainingBehavior.some((value) => !value)) {
    return unavailable("BEHAVIORAL_PROBE_FAILED", "the real Bubblewrap/cgroup behavior did not satisfy every ADR 001 assertion");
  }
  if (!Number.isSafeInteger(evidence.effectiveUid) || evidence.effectiveUid < 0 || !evidence.userNamespaceMapping) {
    return unavailable("BEHAVIORAL_PROBE_FAILED", "runtime identity for the capability cache is incomplete");
  }

  return {
    available: true,
    cgroupVersion: 2,
    mountPoint: VERIFIER_CGROUP_MOUNT_POINT,
    mountDevice: mount.majorMinor,
    mountOptions,
    nsdelegate: true,
    strictCgroupNamespace: true,
    fdBind: true,
    strongOuterScope: true,
    delegationFiles,
    maxDescendants: VERIFIER_CGROUP_MAX_DESCENDANTS,
    maxDepth: VERIFIER_CGROUP_MAX_DEPTH,
    runtimeIdentity: {
      kernelRelease: evidence.kernelRelease,
      cgroupMountId: mount.mountId,
      cgroupMountDevice: mount.majorMinor,
      cgroupMountOptions: mountOptions,
      bubblewrap: evidence.bubblewrap.identity,
      effectiveUid: evidence.effectiveUid,
      userNamespaceMapping: evidence.userNamespaceMapping
    }
  };
}

export function verifierCgroupRuntimeCacheKey(identity: VerifierCgroupRuntimeIdentity): string {
  return JSON.stringify({
    kernelRelease: identity.kernelRelease,
    cgroupMountId: identity.cgroupMountId,
    cgroupMountDevice: identity.cgroupMountDevice,
    cgroupMountOptions: [...identity.cgroupMountOptions].sort(),
    bubblewrap: identity.bubblewrap,
    effectiveUid: identity.effectiveUid,
    userNamespaceMapping: identity.userNamespaceMapping
  });
}

export type ScopeObjectIdentity = { dev: string; ino: string };

export type StructuralLimitIo = {
  /** fstat of the already-open directory FD. */
  fstat(fd: number): ScopeObjectIdentity;
  /** Must implement openat/no-follow semantics and return the exact byte count written. */
  writeFileAtNoFollow(fd: number, name: "cgroup.max.descendants" | "cgroup.max.depth", data: string): number;
  /** Must implement openat/no-follow semantics and reject non-regular kernel attribute files. */
  readFileAtNoFollow(fd: number, name: "cgroup.max.descendants" | "cgroup.max.depth"): string;
};

export type StructuralLimitResult =
  | { ok: true; maxDescendants: typeof VERIFIER_CGROUP_MAX_DESCENDANTS; maxDepth: typeof VERIFIER_CGROUP_MAX_DEPTH }
  | { ok: false; reason: "INVALID_FD" | "IDENTITY_MISMATCH" | "PARTIAL_WRITE" | "INVALID_READBACK" | "READBACK_MISMATCH" | "IO_ERROR"; detail: string };

function sameScopeObject(actual: ScopeObjectIdentity, expected: ScopeObjectIdentity): boolean {
  return actual.dev === expected.dev && actual.ino === expected.ino && validDecimalIdentity(actual.dev, false) && validDecimalIdentity(actual.ino, true);
}

/** Trim ASCII whitespace only and accept a canonical safe unsigned integer. */
export function parseStructuralLimitReadback(raw: string): number | undefined {
  const trimmed = raw.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, "");
  if (!DECIMAL.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** `cgroup.events` is evidence only when `populated` occurs exactly once with 0 or 1. */
export function parseCgroupEventsPopulation(raw: string): 0 | 1 | undefined {
  let populated: 0 | 1 | undefined;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const fields = line.split(" ");
    if (fields[0] !== "populated") continue;
    if (populated !== undefined || fields.length !== 2 || (fields[1] !== "0" && fields[1] !== "1")) return undefined;
    populated = fields[1] === "0" ? 0 : 1;
  }
  return populated;
}

/** Set and read back both parent-owned limits through a pinned scope FD. */
export function setAndVerifyStructuralLimits(
  io: StructuralLimitIo,
  fd: number,
  expected: ScopeObjectIdentity
): StructuralLimitResult {
  if (!Number.isInteger(fd) || fd < 0) return { ok: false, reason: "INVALID_FD", detail: "scope FD is invalid" };
  const limits = [
    ["cgroup.max.descendants", VERIFIER_CGROUP_MAX_DESCENDANTS],
    ["cgroup.max.depth", VERIFIER_CGROUP_MAX_DEPTH]
  ] as const;
  try {
    for (const [name, expectedValue] of limits) {
      if (!sameScopeObject(io.fstat(fd), expected)) return { ok: false, reason: "IDENTITY_MISMATCH", detail: `scope identity changed before writing ${name}` };
      const data = `${expectedValue}\n`;
      if (io.writeFileAtNoFollow(fd, name, data) !== Buffer.byteLength(data)) {
        return { ok: false, reason: "PARTIAL_WRITE", detail: `short write to ${name}` };
      }
      if (!sameScopeObject(io.fstat(fd), expected)) return { ok: false, reason: "IDENTITY_MISMATCH", detail: `scope identity changed before reading ${name}` };
      const observed = parseStructuralLimitReadback(io.readFileAtNoFollow(fd, name));
      if (observed === undefined) return { ok: false, reason: "INVALID_READBACK", detail: `${name} did not contain a canonical unsigned decimal` };
      if (observed !== expectedValue) return { ok: false, reason: "READBACK_MISMATCH", detail: `${name} read back ${observed}, expected ${expectedValue}` };
    }
    if (!sameScopeObject(io.fstat(fd), expected)) return { ok: false, reason: "IDENTITY_MISMATCH", detail: "scope identity changed after structural limit setup" };
    return { ok: true, maxDescendants: VERIFIER_CGROUP_MAX_DESCENDANTS, maxDepth: VERIFIER_CGROUP_MAX_DEPTH };
  } catch (error) {
    return { ok: false, reason: "IO_ERROR", detail: (error as Error).message };
  }
}

export type VerifierCgroupScopeIdentity = {
  version: 2;
  dev: string;
  ino: string;
  name: string;
  pid: number;
  startTicks: string;
};

const SCOPE_V2_ID = /^cgroup2v2:([0-9]+):([0-9]+):(loop-[0-9a-f]{16}):([1-9][0-9]*):([1-9][0-9]*)$/;
const LEGACY_CGROUP_ID = /^cgroup2:([1-9][0-9]*):(loop-[0-9a-f]{8,32}):([1-9][0-9]*)$/;

export function verifierCgroupScopeId(identity: VerifierCgroupScopeIdentity): string {
  if (
    identity.version !== 2 ||
    !validDecimalIdentity(identity.dev, false) ||
    !validDecimalIdentity(identity.ino, true) ||
    !SCOPE_NAME.test(identity.name) ||
    !Number.isSafeInteger(identity.pid) ||
    identity.pid <= 0 ||
    !validDecimalIdentity(identity.startTicks, true)
  ) {
    throw new Error("invalid verifier cgroup scope identity");
  }
  return `cgroup2v2:${identity.dev}:${identity.ino}:${identity.name}:${identity.pid}:${identity.startTicks}`;
}

export function parseVerifierCgroupScopeId(raw: string): VerifierCgroupScopeIdentity | undefined {
  const match = SCOPE_V2_ID.exec(raw);
  if (!match || !validDecimalIdentity(match[1], false) || !validDecimalIdentity(match[2], true) || !validDecimalIdentity(match[5], true)) return undefined;
  const pid = Number(match[4]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  return { version: 2, dev: match[1], ino: match[2], name: match[3], pid, startTicks: match[5] };
}

/** Correctly handles spaces and closing parentheses in Linux's `(comm)` field. */
export function parseProcStatStartTicks(raw: string, expectedPid: number): string | undefined {
  const prefix = `${expectedPid} (`;
  if (!raw.startsWith(prefix)) return undefined;
  const close = raw.lastIndexOf(") ");
  if (close < prefix.length) return undefined;
  const fieldsFromThree = raw.slice(close + 2).trim().split(/ +/);
  const startTicks = fieldsFromThree[19]; // field 22, with state at index 0 (field 3)
  return startTicks && validDecimalIdentity(startTicks, true) ? startTicks : undefined;
}

export type VerifierCgroupJournalRecord = {
  v: 2;
  kind: "verifier-cgroup";
  runId: string;
  attemptId: string;
  leaseId: string;
  scopeId: string;
  maxDescendants: typeof VERIFIER_CGROUP_MAX_DESCENDANTS;
  maxDepth: typeof VERIFIER_CGROUP_MAX_DEPTH;
};

export type ParsedVerifierCgroupJournalLine =
  | { kind: "v2"; record: VerifierCgroupJournalRecord; identity: VerifierCgroupScopeIdentity }
  | { kind: "legacy"; scopeId: string; ino: string; name: string; pid: number }
  | { kind: "invalid"; reason: string };

function validateJournalRecord(value: unknown): { record: VerifierCgroupJournalRecord; identity: VerifierCgroupScopeIdentity } | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const allowed = new Set(["v", "kind", "runId", "attemptId", "leaseId", "scopeId", "maxDescendants", "maxDepth"]);
  if (Object.keys(obj).some((key) => !allowed.has(key)) || Object.keys(obj).length !== allowed.size) return undefined;
  if (obj.v !== 2 || obj.kind !== "verifier-cgroup" || obj.maxDescendants !== VERIFIER_CGROUP_MAX_DESCENDANTS || obj.maxDepth !== VERIFIER_CGROUP_MAX_DEPTH) return undefined;
  if (!isValidId(obj.runId) || !isValidId(obj.attemptId) || !isValidId(obj.leaseId) || typeof obj.scopeId !== "string") return undefined;
  const identity = parseVerifierCgroupScopeId(obj.scopeId);
  if (!identity) return undefined;
  return { record: obj as VerifierCgroupJournalRecord, identity };
}

export function parseVerifierCgroupJournalLine(line: string): ParsedVerifierCgroupJournalLine {
  if (!line || line.includes("\n") || line.includes("\r") || line.length > 4_096) return { kind: "invalid", reason: "journal record is empty, multiline, or oversized" };
  const legacy = LEGACY_CGROUP_ID.exec(line);
  if (legacy) {
    const pid = Number(legacy[3]);
    if (Number.isSafeInteger(pid) && pid > 0) return { kind: "legacy", scopeId: line, ino: legacy[1], name: legacy[2], pid };
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: "invalid", reason: "journal record is not valid JSON or a recognized legacy scope id" };
  }
  const validated = validateJournalRecord(value);
  return validated ? { kind: "v2", ...validated } : { kind: "invalid", reason: "journal record violates the strict v2 schema" };
}

export function serializeVerifierCgroupJournalRecord(record: VerifierCgroupJournalRecord): string {
  const validated = validateJournalRecord(record);
  if (!validated) throw new Error("invalid verifier cgroup journal record");
  return `${JSON.stringify(record)}\n`;
}

export type EnrollmentStatusResult =
  | { ok: true; pid: number; nonce: string }
  | { ok: false; reason: "OVERSIZED" | "INVALID_UTF8" | "MALFORMED" | "PID_MISMATCH" | "NONCE_MISMATCH" };

export function parseVerifierEnrollmentStatus(
  bytes: Uint8Array,
  expectedPid: number,
  expectedNonce: string
): EnrollmentStatusResult {
  if (bytes.byteLength > VERIFIER_CGROUP_STATUS_MAX_BYTES) return { ok: false, reason: "OVERSIZED" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "INVALID_UTF8" };
  }
  const match = /^ENROLLED ([1-9][0-9]*) ([0-9a-f]{32})\n$/.exec(text);
  if (!match) return { ok: false, reason: "MALFORMED" };
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid !== expectedPid) return { ok: false, reason: "PID_MISMATCH" };
  if (!NONCE.test(expectedNonce) || match[2] !== expectedNonce) return { ok: false, reason: "NONCE_MISMATCH" };
  return { ok: true, pid, nonce: match[2] };
}

export function verifierGateTokenIsExact(bytes: Uint8Array): boolean {
  return bytes.byteLength === 3 && bytes[0] === 0x47 && bytes[1] === 0x4f && bytes[2] === 0x0a;
}

export const VERIFIER_CGROUP_BWRAP_FRAGMENT = [
  "--unshare-user",
  "--unshare-pid",
  "--unshare-ipc",
  "--unshare-uts",
  "--unshare-net",
  "--unshare-cgroup",
  "--cap-drop",
  "ALL",
  "--bind-fd",
  String(VERIFIER_CGROUP_SCOPE_FD),
  VERIFIER_CGROUP_MOUNT_POINT
] as const;

export type VerifierCgroupLaunchPlan = {
  command: string;
  cgroupArgs: readonly string[];
  /** Child fd 5 is the caller's already-open exact-scope FD. */
  stdio: readonly ["pipe", "pipe", "pipe", "pipe", "pipe", number];
  statusFd: typeof VERIFIER_CGROUP_STATUS_FD;
  gateFd: typeof VERIFIER_CGROUP_GATE_FD;
  scopeFd: typeof VERIFIER_CGROUP_SCOPE_FD;
};

/** Validate the descriptor portion after any caller-side plan composition. */
export function verifierCgroupLaunchPlanHasExactFdAbi(plan: VerifierCgroupLaunchPlan): boolean {
  return plan.statusFd === VERIFIER_CGROUP_STATUS_FD &&
    plan.gateFd === VERIFIER_CGROUP_GATE_FD &&
    plan.scopeFd === VERIFIER_CGROUP_SCOPE_FD &&
    plan.stdio.length === VERIFIER_CGROUP_SCOPE_FD + 1 &&
    plan.stdio[VERIFIER_CGROUP_STATUS_FD] === "pipe" &&
    plan.stdio[VERIFIER_CGROUP_GATE_FD] === "pipe" &&
    Number.isInteger(plan.stdio[VERIFIER_CGROUP_SCOPE_FD]) &&
    (plan.stdio[VERIFIER_CGROUP_SCOPE_FD] as number) >= 0;
}

/** Build only from an available token and a fresh executable identity check. */
export function buildVerifierCgroupLaunchPlan(
  capability: VerifierCgroupJailCapability,
  parentScopeFd: number,
  currentBubblewrapIdentity: ExecutableIdentity
): VerifierCgroupLaunchPlan {
  if (!capability.available) throw new Error(`verifier cgroup jail unavailable: ${capability.reasonCode}`);
  if (!Number.isInteger(parentScopeFd) || parentScopeFd < 0) throw new Error("invalid parent scope FD");
  if (!executableIdentityIsValid(currentBubblewrapIdentity) || !sameExecutableIdentity(capability.runtimeIdentity.bubblewrap, currentBubblewrapIdentity)) {
    throw new Error("Bubblewrap identity changed after the behavioral probe");
  }
  return {
    command: currentBubblewrapIdentity.canonicalPath,
    cgroupArgs: VERIFIER_CGROUP_BWRAP_FRAGMENT,
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", parentScopeFd],
    statusFd: VERIFIER_CGROUP_STATUS_FD,
    gateFd: VERIFIER_CGROUP_GATE_FD,
    scopeFd: VERIFIER_CGROUP_SCOPE_FD
  };
}

export const VERIFIER_CGROUP_STATES = [
  "PROBING",
  "ALLOCATED",
  "BOUNDED",
  "PINNED",
  "SPAWNED_GATED",
  "ENROLLED",
  "JOURNALED",
  "RELEASED",
  "ACTIVE",
  "KILL_REQUESTED",
  "DRAINING",
  "REMOVING_DESCENDANTS",
  "PROVING",
  "SETTLED",
  "UNRESOLVED_BLOCKED"
] as const;

export type VerifierCgroupState = (typeof VERIFIER_CGROUP_STATES)[number];

const STATE_TRANSITIONS: Readonly<Record<VerifierCgroupState, readonly VerifierCgroupState[]>> = {
  PROBING: ["ALLOCATED"],
  ALLOCATED: ["BOUNDED", "PROVING", "UNRESOLVED_BLOCKED"],
  BOUNDED: ["PINNED", "PROVING", "UNRESOLVED_BLOCKED"],
  PINNED: ["SPAWNED_GATED", "PROVING", "UNRESOLVED_BLOCKED"],
  SPAWNED_GATED: ["ENROLLED", "KILL_REQUESTED", "UNRESOLVED_BLOCKED"],
  ENROLLED: ["JOURNALED", "KILL_REQUESTED", "UNRESOLVED_BLOCKED"],
  JOURNALED: ["RELEASED", "KILL_REQUESTED", "UNRESOLVED_BLOCKED"],
  RELEASED: ["ACTIVE", "KILL_REQUESTED", "UNRESOLVED_BLOCKED"],
  ACTIVE: ["KILL_REQUESTED", "UNRESOLVED_BLOCKED"],
  KILL_REQUESTED: ["DRAINING", "UNRESOLVED_BLOCKED"],
  DRAINING: ["REMOVING_DESCENDANTS", "UNRESOLVED_BLOCKED"],
  REMOVING_DESCENDANTS: ["PROVING", "UNRESOLVED_BLOCKED"],
  PROVING: ["SETTLED", "UNRESOLVED_BLOCKED"],
  SETTLED: [],
  UNRESOLVED_BLOCKED: []
};

export function verifierCgroupTransitionAllowed(from: VerifierCgroupState, to: VerifierCgroupState): boolean {
  return STATE_TRANSITIONS[from].includes(to);
}

export function assertVerifierCgroupTransition(from: VerifierCgroupState, to: VerifierCgroupState): void {
  if (!verifierCgroupTransitionAllowed(from, to)) throw new Error(`illegal verifier cgroup transition ${from} -> ${to}`);
}

export type CleanupObservation = {
  pathIdentity: "MATCHING" | "ABSENT" | "FOREIGN" | "UNREADABLE";
  pinnedFdIdentity: "MATCHING" | "MISMATCH" | "UNREADABLE";
  cgroupKill: "NOT_ATTEMPTED" | "WRITTEN" | "ENOENT" | "FAILED";
  population: "POPULATED" | "EMPTY" | "MALFORMED" | "UNREADABLE";
  childScopeFdOpen: boolean;
  descendantsRemoved: boolean;
  pinnedLinkCount: number | undefined;
  processGroup: "ALIVE_MATCHING_START" | "ALIVE_RECYCLED" | "DEAD" | "UNREADABLE";
  deadlineExpired: boolean;
};

export type CleanupDecision =
  | { action: "WRITE_CGROUP_KILL" }
  | { action: "WAIT_FOR_POPULATED_ZERO" }
  | { action: "CLOSE_CHILD_SCOPE_FD" }
  | { action: "REMOVE_DESCENDANTS_DEEPEST_FIRST" }
  | { action: "PROVE_ABSENCE" }
  | { action: "SETTLED" }
  | { action: "UNRESOLVED_BLOCKED"; reason: string };

/** Decide one fail-closed cleanup step from parent-owned observations. */
export function decideVerifierCgroupCleanup(observation: CleanupObservation): CleanupDecision {
  if (observation.deadlineExpired) return { action: "UNRESOLVED_BLOCKED", reason: "cleanup deadline expired" };
  if (observation.pinnedFdIdentity !== "MATCHING") return { action: "UNRESOLVED_BLOCKED", reason: "pinned scope identity is unreadable or changed" };
  if (observation.pathIdentity === "FOREIGN") return { action: "UNRESOLVED_BLOCKED", reason: "recorded name now refers to a foreign cgroup object" };
  if (observation.pathIdentity === "UNREADABLE") return { action: "UNRESOLVED_BLOCKED", reason: "recorded cgroup path is unreadable" };
  if (observation.processGroup === "UNREADABLE") return { action: "UNRESOLVED_BLOCKED", reason: "process-group absence cannot be proven" };
  if (observation.pathIdentity === "ABSENT") {
    if (observation.processGroup !== "DEAD") return { action: "UNRESOLVED_BLOCKED", reason: "cgroup is absent but the original process group is not proven dead" };
    if (observation.pinnedLinkCount !== 0) return { action: "UNRESOLVED_BLOCKED", reason: "pinned scope link state does not prove removal" };
    return { action: "SETTLED" };
  }
  if (observation.cgroupKill === "FAILED") return { action: "UNRESOLVED_BLOCKED", reason: "cgroup.kill failed and the scope remains present" };
  if (observation.cgroupKill === "NOT_ATTEMPTED") return { action: "WRITE_CGROUP_KILL" };
  if (observation.population === "MALFORMED" || observation.population === "UNREADABLE") {
    return { action: "UNRESOLVED_BLOCKED", reason: "cgroup.events does not uniquely prove populated 0" };
  }
  if (observation.population === "POPULATED") return { action: "WAIT_FOR_POPULATED_ZERO" };
  if (observation.childScopeFdOpen) return { action: "CLOSE_CHILD_SCOPE_FD" };
  if (!observation.descendantsRemoved) return { action: "REMOVE_DESCENDANTS_DEEPEST_FIRST" };
  return { action: "PROVE_ABSENCE" };
}

export type RecoveryObservation = {
  journal: ParsedVerifierCgroupJournalLine;
  pathIdentity: "MATCHING" | "ABSENT" | "FOREIGN" | "UNREADABLE";
  processGroup: "DEAD" | "ALIVE" | "UNREADABLE";
};

export type RecoveryDecision =
  | { action: "CLEANUP_MATCHING_WITH_CGROUP_KILL"; identity: VerifierCgroupScopeIdentity }
  | { action: "DISCHARGE_GONE" }
  | { action: "RETAIN_UNRESOLVED"; reason: string };

/** Recovery never signals a recorded PID and never adopts a name without exact v2 dev/inode evidence. */
export function decideVerifierCgroupRecovery(observation: RecoveryObservation): RecoveryDecision {
  if (observation.journal.kind === "invalid") return { action: "RETAIN_UNRESOLVED", reason: observation.journal.reason };
  if (observation.journal.kind === "legacy") return { action: "RETAIN_UNRESOLVED", reason: "legacy scope lacks device and process-start identity" };
  if (observation.pathIdentity === "UNREADABLE") return { action: "RETAIN_UNRESOLVED", reason: "recorded cgroup is unreadable" };
  if (observation.pathIdentity === "FOREIGN") return { action: "RETAIN_UNRESOLVED", reason: "recorded name belongs to a foreign device/inode" };
  if (observation.pathIdentity === "ABSENT") {
    return observation.processGroup === "DEAD"
      ? { action: "DISCHARGE_GONE" }
      : { action: "RETAIN_UNRESOLVED", reason: "cgroup is absent but process-group absence is not proven" };
  }
  return { action: "CLEANUP_MATCHING_WITH_CGROUP_KILL", identity: observation.journal.identity };
}

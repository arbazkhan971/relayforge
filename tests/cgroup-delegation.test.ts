import { describe, expect, it } from "vitest";
import {
  VERIFIER_CGROUP_BWRAP_FRAGMENT,
  VERIFIER_CGROUP_GATE_TOKEN,
  VERIFIER_CGROUP_MAX_DEPTH,
  VERIFIER_CGROUP_MAX_DESCENDANTS,
  VERIFIER_CGROUP_MOUNT_POINT,
  VERIFIER_CGROUP_SCOPE_FD,
  VERIFIER_CGROUP_UNAVAILABLE_REASONS,
  assertVerifierCgroupTransition,
  buildVerifierCgroupLaunchPlan,
  decideVerifierCgroupCleanup,
  decideVerifierCgroupRecovery,
  parseDelegationFiles,
  parseCgroupEventsPopulation,
  parseMountInfo,
  parseProcStatStartTicks,
  parseStructuralLimitReadback,
  parseUnifiedCgroupMembership,
  parseVerifierCgroupJournalLine,
  parseVerifierCgroupScopeId,
  parseVerifierEnrollmentStatus,
  probeVerifierCgroupJail,
  sameExecutableIdentity,
  selectUnifiedCgroupMount,
  serializeVerifierCgroupJournalRecord,
  setAndVerifyStructuralLimits,
  verifierCgroupRuntimeCacheKey,
  verifierCgroupLaunchPlanHasExactFdAbi,
  verifierCgroupScopeId,
  verifierCgroupTransitionAllowed,
  verifierGateTokenIsExact,
  type ExecutableIdentity,
  type ProbeRead,
  type StructuralLimitIo,
  type VerifierCgroupAvailableCapability,
  type VerifierCgroupJournalRecord,
  type VerifierCgroupProbeEvidence,
  type VerifierCgroupState
} from "../src/cgroup-delegation.js";

const bwrapIdentity: ExecutableIdentity = {
  canonicalPath: "/usr/bin/bwrap",
  dev: "2049",
  ino: "7711",
  mtimeNs: "1710000000000000000"
};

const safeMount =
  "40 29 0:36 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw,nsdelegate,memory_recursiveprot\n";

function completeEvidence(): VerifierCgroupProbeEvidence {
  return {
    platform: "linux",
    kernelRelease: "6.12.0-test",
    mountInfo: { ok: true, text: safeMount },
    selfCgroup: { ok: true, text: "0::/user.slice/user-1000.slice/session.scope\n" },
    effectiveUid: 1000,
    userNamespaceMapping: "         0       1000          1\n",
    strongOuterScope: true,
    outerScopeFiles: [
      "cgroup.procs",
      "cgroup.kill",
      "cgroup.events",
      "cgroup.max.descendants",
      "cgroup.max.depth"
    ],
    delegationFile: { ok: true, text: "cgroup.procs cgroup.subtree_control cgroup.threads\n" },
    delegationOwnership: true,
    bubblewrap: {
      available: true,
      identitySafe: true,
      identity: bwrapIdentity,
      behavior: {
        performed: true,
        strictCgroupNamespace: true,
        fdBind: true,
        userNamespace: true,
        pidNamespace: true,
        ipcNamespace: true,
        utsNamespace: true,
        networkNamespace: true,
        capabilityDrop: true,
        namespaceRootIsSlash: true,
        pinnedScopeIdentityMatched: true,
        childCgroupLifecycleWorked: true,
        rootStructuralWriteDenied: true,
        parentAndSiblingsHidden: true,
        sourceFdClosedInPayload: true,
        hostMountOptionsUnchanged: true,
        disposableScopeSettled: true
      }
    }
  };
}

function availableCapability(): VerifierCgroupAvailableCapability {
  const capability = probeVerifierCgroupJail(completeEvidence());
  expect(capability.available).toBe(true);
  return capability as VerifierCgroupAvailableCapability;
}

describe("cgroup-v2 mount and delegation parsing", () => {
  it("decodes mountinfo fields and selects the most specific mount that contains exact membership", () => {
    const mounts = parseMountInfo([
      "20 1 0:20 / /tmp/not\\040the\\134mount rw - tmpfs tmpfs rw",
      safeMount.trim(),
      "41 40 0:36 /user.slice /some/other rw,nosuid,nodev,noexec - cgroup2 cgroup rw,nsdelegate"
    ].join("\n"));
    expect(mounts[0].mountPoint).toBe("/tmp/not the\\mount");
    expect(selectUnifiedCgroupMount(mounts, "/user.slice/user-1000.slice")?.mountId).toBe(41);
    expect(selectUnifiedCgroupMount(mounts, "/machine.slice")?.mountId).toBe(40);
  });

  it("rejects malformed escapes, missing separators, unsafe membership, and duplicate 0:: records", () => {
    expect(() => parseMountInfo("1 1 0:1 / /bad\\x rw - cgroup2 cgroup rw")).toThrow(/escape/);
    expect(() => parseMountInfo("1 1 0:1 / / rw cgroup2 cgroup rw")).toThrow(/malformed/);
    expect(() => parseUnifiedCgroupMembership("0::relative\n")).toThrow(/absolute/);
    expect(() => parseUnifiedCgroupMembership("0::/a/../b\n")).toThrow(/canonical/);
    expect(() => parseUnifiedCgroupMembership("0::/a\n0::/b\n")).toThrow(/exactly one/);
  });

  it("uses the documented delegation fallback only for ENOENT", () => {
    expect(parseDelegationFiles({ ok: false, code: "ENOENT" })).toEqual([
      "cgroup.procs",
      "cgroup.subtree_control",
      "cgroup.threads"
    ]);
    expect(() => parseDelegationFiles({ ok: false, code: "EACCES" })).toThrow(/EACCES/);
    expect(() => parseDelegationFiles({ ok: true, text: "cgroup.procs cgroup.procs cgroup.threads cgroup.subtree_control" })).toThrow(/duplicate/);
    expect(() => parseDelegationFiles({ ok: true, text: "cgroup.procs ../owner cgroup.threads cgroup.subtree_control" })).toThrow(/invalid/);
    expect(() => parseDelegationFiles({ ok: true, text: "cgroup.procs cgroup.threads" })).toThrow(/omits/);
  });
});

describe("the typed capability is fail-closed", () => {
  it("issues the exact available token only after complete behavioral evidence", () => {
    const capability = probeVerifierCgroupJail(completeEvidence());
    expect(capability).toMatchObject({
      available: true,
      cgroupVersion: 2,
      mountPoint: VERIFIER_CGROUP_MOUNT_POINT,
      mountDevice: "0:36",
      nsdelegate: true,
      strictCgroupNamespace: true,
      fdBind: true,
      strongOuterScope: true,
      maxDescendants: 256,
      maxDepth: 16
    });
    if (!capability.available) throw new Error("expected availability");
    expect(capability.delegationFiles).toEqual(["cgroup.procs", "cgroup.subtree_control", "cgroup.threads"]);
    expect(capability.runtimeIdentity.bubblewrap).toEqual(bwrapIdentity);
  });

  const cases: Array<[string, (evidence: VerifierCgroupProbeEvidence) => void, string]> = [
    ["NOT_LINUX", (e) => { e.platform = "darwin"; }, "Linux"],
    ["CGROUP_V2_UNAVAILABLE", (e) => { e.mountInfo = { ok: true, text: "1 1 0:1 / / rw - tmpfs x rw\n" }; }, "cgroup2"],
    ["CGROUP_MOUNT_UNSAFE", (e) => { e.mountInfo = { ok: true, text: safeMount.replace("rw,nosuid", "rw") }; }, "nosuid"],
    ["STRONG_SCOPE_UNAVAILABLE", (e) => { e.strongOuterScope = false; }, "outer"],
    ["NSDELEGATE_MISSING", (e) => { e.mountInfo = { ok: true, text: safeMount.replace(",nsdelegate", "") }; }, "nsdelegate"],
    ["CGROUP_KILL_MISSING", (e) => { e.outerScopeFiles = e.outerScopeFiles.filter((f) => f !== "cgroup.kill"); }, "cgroup.kill"],
    ["STRUCTURAL_LIMITS_MISSING", (e) => { e.outerScopeFiles = e.outerScopeFiles.filter((f) => f !== "cgroup.max.depth"); }, "structural"],
    ["DELEGATION_FILES_UNAVAILABLE", (e) => { e.delegationFile = { ok: false, code: "EIO" }; }, "EIO"],
    ["DELEGATION_OWNERSHIP_UNAVAILABLE", (e) => { e.delegationOwnership = false; }, "ownership"],
    ["BWRAP_UNAVAILABLE", (e) => { e.bubblewrap.available = false; }, "unavailable"],
    ["BWRAP_IDENTITY_UNSAFE", (e) => { e.bubblewrap.identitySafe = false; }, "mutable"],
    ["BWRAP_CGROUP_NAMESPACE_UNAVAILABLE", (e) => { e.bubblewrap.behavior!.strictCgroupNamespace = false; }, "cgroup namespace"],
    ["BWRAP_FD_BIND_UNAVAILABLE", (e) => { e.bubblewrap.behavior!.fdBind = false; }, "bind-fd"],
    ["BWRAP_NAMESPACE_SET_UNAVAILABLE", (e) => { e.bubblewrap.behavior!.networkNamespace = false; }, "namespace set"],
    ["BEHAVIORAL_PROBE_FAILED", (e) => { e.bubblewrap.behavior!.sourceFdClosedInPayload = false; }, "ADR 001"]
  ];

  it.each(cases)("returns stable %s instead of degrading", (reason, mutate, detail) => {
    const evidence = completeEvidence();
    mutate(evidence);
    const capability = probeVerifierCgroupJail(evidence);
    expect(capability).toMatchObject({ available: false, reasonCode: reason });
    if (capability.available) throw new Error("unexpected available capability");
    expect(capability.detail).toContain(detail);
  });

  it("keeps the closed reason enum complete and cannot pass on help/version-style evidence", () => {
    expect(cases.map(([reason]) => reason).sort()).toEqual([...VERIFIER_CGROUP_UNAVAILABLE_REASONS].sort());
    const evidence = completeEvidence();
    evidence.bubblewrap.behavior!.performed = false;
    expect(probeVerifierCgroupJail(evidence)).toMatchObject({ available: false, reasonCode: "BEHAVIORAL_PROBE_FAILED" });
  });

  it("binds a cache entry to kernel, mount, uid map, and executable identity", () => {
    const capability = availableCapability();
    const first = verifierCgroupRuntimeCacheKey(capability.runtimeIdentity);
    const changed = verifierCgroupRuntimeCacheKey({ ...capability.runtimeIdentity, kernelRelease: "different" });
    expect(first).not.toBe(changed);
    expect(sameExecutableIdentity(bwrapIdentity, { ...bwrapIdentity })).toBe(true);
    expect(sameExecutableIdentity(bwrapIdentity, { ...bwrapIdentity, ino: "7712" })).toBe(false);
  });
});

describe("pinned-FD structural limit setup", () => {
  function fakeIo(overrides: Partial<StructuralLimitIo> = {}) {
    const writes: Array<[string, string]> = [];
    const values = new Map<string, string>();
    const io: StructuralLimitIo = {
      fstat: () => ({ dev: "9", ino: "101" }),
      writeFileAtNoFollow: (_fd, name, data) => {
        writes.push([name, data]);
        values.set(name, data);
        return Buffer.byteLength(data);
      },
      readFileAtNoFollow: (_fd, name) => values.get(name) ?? "",
      ...overrides
    };
    return { io, writes, values };
  }

  it("writes decimal-newline through the FD and requires exact readback", () => {
    const { io, writes } = fakeIo();
    expect(setAndVerifyStructuralLimits(io, 72, { dev: "9", ino: "101" })).toEqual({
      ok: true,
      maxDescendants: VERIFIER_CGROUP_MAX_DESCENDANTS,
      maxDepth: VERIFIER_CGROUP_MAX_DEPTH
    });
    expect(writes).toEqual([
      ["cgroup.max.descendants", "256\n"],
      ["cgroup.max.depth", "16\n"]
    ]);
  });

  it("rejects partial writes, identity swaps, malformed/overflow/max/leading-zero readback, and mismatches", () => {
    const partial = fakeIo({ writeFileAtNoFollow: () => 1 });
    expect(setAndVerifyStructuralLimits(partial.io, 5, { dev: "9", ino: "101" })).toMatchObject({ ok: false, reason: "PARTIAL_WRITE" });

    let stats = 0;
    const swap = fakeIo({ fstat: () => (++stats < 2 ? { dev: "9", ino: "101" } : { dev: "9", ino: "102" }) });
    expect(setAndVerifyStructuralLimits(swap.io, 5, { dev: "9", ino: "101" })).toMatchObject({ ok: false, reason: "IDENTITY_MISMATCH" });

    for (const malformed of ["max\n", "0256\n", "+256\n", "256\u00a0", "18446744073709551616\n"]) {
      const bad = fakeIo({ readFileAtNoFollow: () => malformed });
      expect(setAndVerifyStructuralLimits(bad.io, 5, { dev: "9", ino: "101" }), malformed).toMatchObject({ ok: false, reason: "INVALID_READBACK" });
    }
    const mismatch = fakeIo({ readFileAtNoFollow: (_fd, name) => name.endsWith("depth") ? "15\n" : "256\n" });
    expect(setAndVerifyStructuralLimits(mismatch.io, 5, { dev: "9", ino: "101" })).toMatchObject({ ok: false, reason: "READBACK_MISMATCH" });
    expect(parseStructuralLimitReadback(" \t256\r\n")).toBe(256);
    expect(parseCgroupEventsPopulation("populated 0\nfrozen 0\n")).toBe(0);
    expect(parseCgroupEventsPopulation("populated 1\n")).toBe(1);
    for (const invalid of ["frozen 0\n", "populated 2\n", "populated 0 extra\n", "populated 0\npopulated 0\n"]) {
      expect(parseCgroupEventsPopulation(invalid), invalid).toBeUndefined();
    }
  });

  it("propagates no OS exception as success", () => {
    const denied = fakeIo({ writeFileAtNoFollow: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } });
    expect(setAndVerifyStructuralLimits(denied.io, 5, { dev: "9", ino: "101" })).toEqual({ ok: false, reason: "IO_ERROR", detail: "denied" });
    expect(setAndVerifyStructuralLimits(denied.io, -1, { dev: "9", ino: "101" })).toMatchObject({ ok: false, reason: "INVALID_FD" });
  });
});

describe("v2 identity, journal, and gate ABI", () => {
  const identity = { version: 2, dev: "2049", ino: "8877", name: "loop-0123456789abcdef", pid: 4321, startTicks: "99887766" } as const;
  const scopeId = "cgroup2v2:2049:8877:loop-0123456789abcdef:4321:99887766";

  it("round-trips the complete device/inode/name/pid/startticks identity", () => {
    expect(verifierCgroupScopeId(identity)).toBe(scopeId);
    expect(parseVerifierCgroupScopeId(scopeId)).toEqual(identity);
    for (const invalid of [
      scopeId.replace("2049", "02049"),
      scopeId.replace("8877", "0"),
      scopeId.replace("0123456789abcdef", "01234567"),
      scopeId.replace(":4321:", ":0:"),
      scopeId.replace("99887766", "0")
    ]) expect(parseVerifierCgroupScopeId(invalid), invalid).toBeUndefined();
  });

  it("parses field 22 even when proc comm contains spaces and closing parentheses", () => {
    const beforeStart = ["S", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18"];
    expect(parseProcStatStartTicks(`4321 (odd ) name) ${beforeStart.join(" ")} 99887766 23 24`, 4321)).toBe("99887766");
    expect(parseProcStatStartTicks(`9999 (name) ${beforeStart.join(" ")} 99887766`, 4321)).toBeUndefined();
  });

  it("accepts only the strict one-line v2 journal schema and retains legacy as legacy", () => {
    const record: VerifierCgroupJournalRecord = {
      v: 2,
      kind: "verifier-cgroup",
      runId: "run-1",
      attemptId: "attempt-2",
      leaseId: "lease-3",
      scopeId,
      maxDescendants: 256,
      maxDepth: 16
    };
    const line = serializeVerifierCgroupJournalRecord(record);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(parseVerifierCgroupJournalLine(line.slice(0, -1))).toEqual({ kind: "v2", record, identity });
    expect(parseVerifierCgroupJournalLine("cgroup2:8877:loop-0123456789abcdef:4321")).toMatchObject({ kind: "legacy" });
    expect(parseVerifierCgroupJournalLine(JSON.stringify({ ...record, maxDepth: 17 }))).toMatchObject({ kind: "invalid" });
    expect(parseVerifierCgroupJournalLine(JSON.stringify({ ...record, surprise: true }))).toMatchObject({ kind: "invalid" });
    expect(parseVerifierCgroupJournalLine(`${JSON.stringify(record)}\n${JSON.stringify(record)}`)).toMatchObject({ kind: "invalid" });
  });

  it("accepts one authenticated status record and the exact uppercase gate token only", () => {
    const nonce = "0123456789abcdef0123456789abcdef";
    expect(parseVerifierEnrollmentStatus(Buffer.from(`ENROLLED 4321 ${nonce}\n`), 4321, nonce)).toEqual({ ok: true, pid: 4321, nonce });
    expect(parseVerifierEnrollmentStatus(Buffer.from(`ENROLLED 4322 ${nonce}\n`), 4321, nonce)).toMatchObject({ ok: false, reason: "PID_MISMATCH" });
    expect(parseVerifierEnrollmentStatus(Buffer.from(`ENROLLED 4321 ${"f".repeat(32)}\n`), 4321, nonce)).toMatchObject({ ok: false, reason: "NONCE_MISMATCH" });
    expect(parseVerifierEnrollmentStatus(Buffer.from(`ENROLLED 4321 ${nonce}\nENROLLED 4321 ${nonce}\n`), 4321, nonce)).toMatchObject({ ok: false, reason: "MALFORMED" });
    expect(parseVerifierEnrollmentStatus(Buffer.alloc(129, 0x61), 4321, nonce)).toMatchObject({ ok: false, reason: "OVERSIZED" });
    expect(parseVerifierEnrollmentStatus(Uint8Array.from([0xff, 0x0a]), 4321, nonce)).toMatchObject({ ok: false, reason: "INVALID_UTF8" });
    expect(verifierGateTokenIsExact(Buffer.from(VERIFIER_CGROUP_GATE_TOKEN))).toBe(true);
    for (const token of ["go\n", "GO", "GO\nextra", " GO\n"]) expect(verifierGateTokenIsExact(Buffer.from(token))).toBe(false);
  });

  it("emits the singular strict namespace/FD fragment only from an available token", () => {
    const capability = availableCapability();
    const plan = buildVerifierCgroupLaunchPlan(capability, 77, { ...bwrapIdentity });
    expect(plan.command).toBe("/usr/bin/bwrap");
    expect(plan.cgroupArgs).toEqual(VERIFIER_CGROUP_BWRAP_FRAGMENT);
    expect(plan.cgroupArgs.filter((arg) => arg === "--unshare-cgroup")).toHaveLength(1);
    expect(plan.cgroupArgs).not.toContain("--unshare-cgroup-try");
    expect(plan.cgroupArgs).not.toContain("--not-a-security-boundary");
    expect(plan.cgroupArgs.slice(-3)).toEqual(["--bind-fd", String(VERIFIER_CGROUP_SCOPE_FD), VERIFIER_CGROUP_MOUNT_POINT]);
    expect(plan.stdio).toEqual(["pipe", "pipe", "pipe", "pipe", "pipe", 77]);
    expect(verifierCgroupLaunchPlanHasExactFdAbi(plan)).toBe(true);

    expect(() => buildVerifierCgroupLaunchPlan({ available: false, reasonCode: "NOT_LINUX", detail: "no" }, 77, bwrapIdentity)).toThrow(/unavailable/);
    expect(() => buildVerifierCgroupLaunchPlan(capability, 77, { ...bwrapIdentity, ino: "999" })).toThrow(/identity changed/);
  });
});

describe("state, cleanup, and recovery decisions", () => {
  it("allows only ADR-ordered progress, cleanup, and terminal failure", () => {
    const happy: VerifierCgroupState[] = [
      "PROBING", "ALLOCATED", "BOUNDED", "PINNED", "SPAWNED_GATED", "ENROLLED", "JOURNALED",
      "RELEASED", "ACTIVE", "KILL_REQUESTED", "DRAINING", "REMOVING_DESCENDANTS", "PROVING", "SETTLED"
    ];
    for (let index = 0; index < happy.length - 1; index += 1) {
      expect(verifierCgroupTransitionAllowed(happy[index], happy[index + 1])).toBe(true);
    }
    expect(verifierCgroupTransitionAllowed("SPAWNED_GATED", "RELEASED")).toBe(false);
    expect(verifierCgroupTransitionAllowed("SETTLED", "ACTIVE")).toBe(false);
    expect(verifierCgroupTransitionAllowed("UNRESOLVED_BLOCKED", "SETTLED")).toBe(false);
    expect(() => assertVerifierCgroupTransition("ENROLLED", "RELEASED")).toThrow(/illegal/);
  });

  const baseCleanup = {
    pathIdentity: "MATCHING",
    pinnedFdIdentity: "MATCHING",
    cgroupKill: "NOT_ATTEMPTED",
    population: "POPULATED",
    childScopeFdOpen: true,
    descendantsRemoved: false,
    pinnedLinkCount: 1,
    processGroup: "ALIVE_MATCHING_START",
    deadlineExpired: false
  } as const;

  it("orders kill, drain, namespace-FD close, deepest-first removal, then proof", () => {
    expect(decideVerifierCgroupCleanup(baseCleanup)).toEqual({ action: "WRITE_CGROUP_KILL" });
    expect(decideVerifierCgroupCleanup({ ...baseCleanup, cgroupKill: "WRITTEN" })).toEqual({ action: "WAIT_FOR_POPULATED_ZERO" });
    expect(decideVerifierCgroupCleanup({ ...baseCleanup, cgroupKill: "WRITTEN", population: "EMPTY" })).toEqual({ action: "CLOSE_CHILD_SCOPE_FD" });
    expect(decideVerifierCgroupCleanup({ ...baseCleanup, cgroupKill: "WRITTEN", population: "EMPTY", childScopeFdOpen: false })).toEqual({ action: "REMOVE_DESCENDANTS_DEEPEST_FIRST" });
    expect(decideVerifierCgroupCleanup({ ...baseCleanup, cgroupKill: "WRITTEN", population: "EMPTY", childScopeFdOpen: false, descendantsRemoved: true })).toEqual({ action: "PROVE_ABSENCE" });
    expect(decideVerifierCgroupCleanup({ ...baseCleanup, pathIdentity: "ABSENT", pinnedLinkCount: 0, processGroup: "DEAD" })).toEqual({ action: "SETTLED" });
  });

  it("never converts foreign identity, unreadable evidence, kill failure, or time into settlement", () => {
    const blockers = [
      { ...baseCleanup, pathIdentity: "FOREIGN" as const },
      { ...baseCleanup, pinnedFdIdentity: "MISMATCH" as const },
      { ...baseCleanup, cgroupKill: "FAILED" as const },
      { ...baseCleanup, cgroupKill: "WRITTEN" as const, population: "MALFORMED" as const },
      { ...baseCleanup, deadlineExpired: true },
      { ...baseCleanup, pathIdentity: "ABSENT" as const, pinnedLinkCount: 0, processGroup: "ALIVE_RECYCLED" as const }
    ];
    for (const observation of blockers) expect(decideVerifierCgroupCleanup(observation).action).toBe("UNRESOLVED_BLOCKED");
  });

  it("recovery cleans only exact v2 matches, never a PID/legacy/foreign name", () => {
    const record: VerifierCgroupJournalRecord = {
      v: 2,
      kind: "verifier-cgroup",
      runId: "run-1",
      attemptId: "attempt-1",
      leaseId: "lease-1",
      scopeId: "cgroup2v2:9:101:loop-0123456789abcdef:4321:777",
      maxDescendants: 256,
      maxDepth: 16
    };
    const journal = parseVerifierCgroupJournalLine(JSON.stringify(record));
    expect(decideVerifierCgroupRecovery({ journal, pathIdentity: "MATCHING", processGroup: "ALIVE" })).toMatchObject({ action: "CLEANUP_MATCHING_WITH_CGROUP_KILL" });
    expect(decideVerifierCgroupRecovery({ journal, pathIdentity: "ABSENT", processGroup: "DEAD" })).toEqual({ action: "DISCHARGE_GONE" });
    expect(decideVerifierCgroupRecovery({ journal, pathIdentity: "ABSENT", processGroup: "ALIVE" }).action).toBe("RETAIN_UNRESOLVED");
    expect(decideVerifierCgroupRecovery({ journal, pathIdentity: "FOREIGN", processGroup: "ALIVE" }).action).toBe("RETAIN_UNRESOLVED");

    const legacy = parseVerifierCgroupJournalLine("cgroup2:101:loop-0123456789abcdef:4321");
    expect(decideVerifierCgroupRecovery({ journal: legacy, pathIdentity: "MATCHING", processGroup: "ALIVE" }).action).toBe("RETAIN_UNRESOLVED");
    const invalid = parseVerifierCgroupJournalLine("{truncated");
    expect(decideVerifierCgroupRecovery({ journal: invalid, pathIdentity: "ABSENT", processGroup: "DEAD" }).action).toBe("RETAIN_UNRESOLVED");
  });
});

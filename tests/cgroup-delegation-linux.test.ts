import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  VERIFIER_CGROUP_BWRAP_FRAGMENT,
  VERIFIER_CGROUP_UNAVAILABLE_REASONS,
  parseVerifierCgroupJournalLine,
  serializeVerifierCgroupJournalRecord,
  verifierCgroupScopeId,
  type BubblewrapBehavioralEvidence,
  type ExecutableIdentity,
  type VerifierCgroupProbeEvidence
} from "../src/cgroup-delegation.js";
import {
  LINUX_CGROUP_GATE_TRAMPOLINE,
  LINUX_CGROUP_PROBE_PAYLOAD,
  LINUX_O_DIRECTORY,
  LINUX_O_NOFOLLOW,
  LINUX_O_PATH,
  buildLinuxCgroupProbeBwrapArgs,
  cgroupPathForMembership,
  collectLinuxCgroupEvidence,
  getCachedLinuxVerifierCgroupRuntime,
  inspectTrustedExecutable,
  linuxVerifierCgroupBackend,
  parseLinuxCgroupPayloadResult,
  probeVerifierCgroupJailLinux,
  reapLinuxVerifierCgroupJournalLine,
  resetLinuxVerifierCgroupRuntimeCacheForTest,
  runLinuxCgroupBehavioralProbe,
  type CollectedLinuxCgroupEvidence,
  type LinuxCgroupPayloadResult,
  type ParentNamespaceSet
} from "../src/cgroup-delegation-linux.js";
import { runHeadlessChild, runOrderedVerify } from "../src/orchestrator.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

const bwrapIdentity: ExecutableIdentity = {
  canonicalPath: "/usr/bin/bwrap",
  dev: "2049",
  ino: "991",
  mtimeNs: "1710000000000000000"
};

function behavior(overrides: Partial<BubblewrapBehavioralEvidence> = {}): BubblewrapBehavioralEvidence {
  return {
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
    disposableScopeSettled: true,
    ...overrides
  };
}

function collectedEvidence(overrides: Partial<VerifierCgroupProbeEvidence> = {}): CollectedLinuxCgroupEvidence {
  const evidence: VerifierCgroupProbeEvidence = {
    platform: "linux",
    kernelRelease: "6.12.0-test",
    mountInfo: {
      ok: true,
      text: "40 29 0:36 / /sys/fs/cgroup rw,nosuid,nodev,noexec - cgroup2 cgroup rw,nsdelegate,memory_recursiveprot\n"
    },
    selfCgroup: { ok: true, text: "0::/user.slice/test.scope\n" },
    effectiveUid: 1000,
    userNamespaceMapping: "0 1000 1\n",
    strongOuterScope: true,
    outerScopeFiles: ["cgroup.procs", "cgroup.kill", "cgroup.events", "cgroup.max.descendants", "cgroup.max.depth"],
    delegationFile: { ok: true, text: "cgroup.procs cgroup.threads cgroup.subtree_control\n" },
    delegationOwnership: true,
    bubblewrap: { available: true, identitySafe: true, identity: bwrapIdentity, behavior: behavior({ performed: false }) },
    ...overrides
  };
  return { evidence, outerScopeRoot: "/sys/fs/cgroup/user.slice/test.scope", membership: "/user.slice/test.scope" };
}

const parentNamespaces: ParentNamespaceSet = {
  user: "user:[1]",
  pid: "pid:[2]",
  ipc: "ipc:[3]",
  uts: "uts:[4]",
  net: "net:[5]",
  cgroup: "cgroup:[6]"
};

function payload(overrides: Partial<LinuxCgroupPayloadResult> = {}): LinuxCgroupPayloadResult {
  return {
    selfRoot: true,
    identityMatches: true,
    childLifecycle: true,
    rootWriteDenied: true,
    parentsHidden: true,
    capEffZero: true,
    fd5Closed: true,
    userNamespace: true,
    pidNamespace: true,
    ipcNamespace: true,
    utsNamespace: true,
    networkNamespace: true,
    cgroupNamespace: true,
    ...overrides
  };
}

describe("real Linux evidence collection", () => {
  it("maps a membership relative to the selected mount root without traversal", () => {
    const mount = {
      mountId: 40,
      parentId: 29,
      majorMinor: "0:36",
      root: "/user.slice",
      mountPoint: "/sys/fs/cgroup",
      mountOptions: ["rw"],
      optionalFields: [],
      fsType: "cgroup2",
      mountSource: "cgroup",
      superOptions: ["rw"]
    } as const;
    expect(cgroupPathForMembership(mount, "/user.slice/test.scope")).toBe("/sys/fs/cgroup/test.scope");
    expect(() => cgroupPathForMembership(mount, "/machine.slice/test.scope")).toThrow(/outside/);
    expect(() => cgroupPathForMembership(mount, "/user.slice/../machine.slice")).toThrow(/unsafe|outside/);
  });

  it("uses the numeric Linux O_PATH|O_DIRECTORY|O_NOFOLLOW pin flags", () => {
    expect(LINUX_O_PATH).toBe(0x20_0000);
    expect(LINUX_O_DIRECTORY).toBe(0x1_0000);
    expect(LINUX_O_NOFOLLOW).toBe(0x2_0000);
    expect(LINUX_O_PATH | LINUX_O_DIRECTORY | LINUX_O_NOFOLLOW).toBe(0x23_0000);
  });

  it("canonicalizes trusted tools and rejects an executable beneath an effective-uid-writable ancestor", () => {
    const shell = inspectTrustedExecutable("/bin/sh");
    expect(shell.command.startsWith("/")).toBe(true);
    expect(shell.identity.canonicalPath).toBe(shell.command);
    expect(shell.identity.ino).toMatch(/^[1-9][0-9]*$/);

    const root = mkdtempSync(resolve(tmpdir(), "rf-cgroup-tool-"));
    temporary.push(root);
    const executable = resolve(root, "tool");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o555);
    expect(() => inspectTrustedExecutable(executable)).toThrow(/writable by effective uid/);
  });

  it("collects real mount, membership, delegation, and canonical dependency evidence without allocating", () => {
    const collected = collectLinuxCgroupEvidence();
    expect(collected.evidence.platform).toBe(process.platform);
    if (process.platform === "linux") {
      expect(collected.evidence.mountInfo.ok).toBe(true);
      expect(collected.evidence.selfCgroup.ok).toBe(true);
      if (collected.mount) expect(collected.mount.fsType).toBe("cgroup2");
      if (collected.dependencies) {
        expect(collected.dependencies.node.command).toBe(realpathSync(process.execPath));
        expect(collected.dependencies.node.identity.canonicalPath).toBe(collected.dependencies.node.command);
        for (const dependency of Object.values(collected.dependencies)) {
          expect(dependency.command.startsWith("/")).toBe(true);
          expect(dependency.identity.canonicalPath).toBe(dependency.command);
        }
      }
    }
  });
});

describe("trusted shell gate and exact Bubblewrap composition", () => {
  it("orders fstat before enrollment, authenticated status before gate, then exec replacement", () => {
    const stat = LINUX_CGROUP_GATE_TRAMPOLINE.indexOf("loop_actual");
    const enrollment = LINUX_CGROUP_GATE_TRAMPOLINE.indexOf("cgroup.procs");
    const status = LINUX_CGROUP_GATE_TRAMPOLINE.indexOf("ENROLLED");
    const gate = LINUX_CGROUP_GATE_TRAMPOLINE.indexOf("loop_gate_count");
    const exec = LINUX_CGROUP_GATE_TRAMPOLINE.lastIndexOf('exec "$@"');
    expect(stat).toBeGreaterThanOrEqual(0);
    expect(stat).toBeLessThan(enrollment);
    expect(enrollment).toBeLessThan(status);
    expect(status).toBeLessThan(gate);
    expect(gate).toBeLessThan(exec);
    expect(LINUX_CGROUP_GATE_TRAMPOLINE).toContain("/proc/self/fd/5");
    expect(LINUX_CGROUP_GATE_TRAMPOLINE).toContain('loop_gate_count" -eq 1');
  });

  it("places one strict cgroup namespace and exact FD5 bind after the read-only root and before chdir", () => {
    const args = buildLinuxCgroupProbeBwrapArgs("/usr/bin/node", { dev: "9", ino: "101" }, parentNamespaces);
    const ro = args.indexOf("--ro-bind");
    const strict = args.indexOf("--unshare-cgroup");
    const bind = args.indexOf("--bind-fd");
    const chdir = args.indexOf("--chdir");
    expect(ro).toBeLessThan(strict);
    expect(strict).toBeLessThan(bind);
    expect(bind).toBeLessThan(chdir);
    expect(args.filter((arg) => arg === "--unshare-cgroup")).toHaveLength(1);
    expect(args.slice(bind, bind + 3)).toEqual(["--bind-fd", "5", "/sys/fs/cgroup"]);
    expect(args).not.toContain("--unshare-cgroup-try");
    expect(args).not.toContain("--not-a-security-boundary");
    expect(args).not.toContain("--share-net");
    for (const required of VERIFIER_CGROUP_BWRAP_FRAGMENT) expect(args).toContain(required);
    expect(args.join(" ")).not.toContain("user.slice/test.scope");
    expect(args).toContain(LINUX_CGROUP_PROBE_PAYLOAD);
  });

  it("rejects a non-absolute runtime and malformed sibling canary", () => {
    expect(() => buildLinuxCgroupProbeBwrapArgs("node", { dev: "9", ino: "101" }, parentNamespaces)).toThrow(/absolute/);
    expect(() => buildLinuxCgroupProbeBwrapArgs("/usr/bin/node", { dev: "9", ino: "101" }, parentNamespaces, "../sibling")).toThrow(/canary/);
  });
});

describe("bounded behavioral result authority", () => {
  it("accepts exactly one fixed-schema boolean record", () => {
    const result = payload();
    expect(parseLinuxCgroupPayloadResult(Buffer.from(`${JSON.stringify(result)}\n`))).toEqual(result);
  });

  it("rejects malformed, duplicated, unknown, missing, non-boolean, invalid UTF-8, and oversized output", () => {
    const valid = payload();
    const invalid = [
      Buffer.from("not-json\n"),
      Buffer.from(`${JSON.stringify(valid)}\n${JSON.stringify(valid)}\n`),
      Buffer.from(JSON.stringify({ ...valid, surprise: true })),
      Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(valid).slice(1)))),
      Buffer.from(JSON.stringify({ ...valid, selfRoot: "yes" })),
      Uint8Array.from([0xff, 0x0a]),
      Buffer.alloc(64 * 1024 + 1, 0x61)
    ];
    for (const bytes of invalid) expect(() => parseLinuxCgroupPayloadResult(bytes), String(bytes.length)).toThrow();
  });
});

describe("typed production orchestration", () => {
  it("does not invoke a behavioral runner when a preflight property is unavailable", async () => {
    let calls = 0;
    const collected = collectedEvidence({ platform: "darwin" });
    const capability = await probeVerifierCgroupJailLinux({
      collectEvidence: () => collected,
      runBehavioralProbe: async () => { calls += 1; return { ok: true, behavior: behavior() }; }
    });
    expect(capability).toMatchObject({ available: false, reasonCode: "NOT_LINUX" });
    expect(calls).toBe(0);
  });

  it("mints availability only from complete injected behavioral evidence", async () => {
    const capability = await probeVerifierCgroupJailLinux({
      collectEvidence: () => collectedEvidence(),
      runBehavioralProbe: async () => ({ ok: true, behavior: behavior() })
    });
    expect(capability).toMatchObject({ available: true, strictCgroupNamespace: true, fdBind: true, maxDescendants: 256, maxDepth: 16 });
  });

  it("preserves a runner refusal and lists every false assertion from a completed probe", async () => {
    const refusal = await probeVerifierCgroupJailLinux({
      collectEvidence: () => collectedEvidence(),
      runBehavioralProbe: async () => ({ ok: false, reasonCode: "BWRAP_FD_BIND_UNAVAILABLE", detail: "bind-fd failed its real probe" })
    });
    expect(refusal).toEqual({ available: false, reasonCode: "BWRAP_FD_BIND_UNAVAILABLE", detail: "bind-fd failed its real probe" });

    const failed = await probeVerifierCgroupJailLinux({
      collectEvidence: () => collectedEvidence(),
      runBehavioralProbe: async () => ({ ok: true, behavior: behavior({ parentAndSiblingsHidden: false, sourceFdClosedInPayload: false }) })
    });
    expect(failed).toMatchObject({ available: false, reasonCode: "BEHAVIORAL_PROBE_FAILED" });
    if (failed.available) throw new Error("unexpected available capability");
    expect(failed.detail).toContain("parentAndSiblingsHidden");
    expect(failed.detail).toContain("sourceFdClosedInPayload");
  });

  it("never lets injected evidence or runners populate the production runtime cache", async () => {
    resetLinuxVerifierCgroupRuntimeCacheForTest();
    let calls = 0;
    const first = collectedEvidence();
    const runner = async () => { calls += 1; return { ok: true as const, behavior: behavior() }; };
    const a = await getCachedLinuxVerifierCgroupRuntime({ collectEvidence: () => first, runBehavioralProbe: runner });
    const b = await getCachedLinuxVerifierCgroupRuntime({ collectEvidence: () => first, runBehavioralProbe: runner });
    expect(a.capability.available).toBe(true);
    expect(b.capability.available).toBe(true);
    expect(calls).toBe(2);
    const changed = collectedEvidence({ kernelRelease: "6.12.1-changed" });
    await getCachedLinuxVerifierCgroupRuntime({ collectEvidence: () => changed, runBehavioralProbe: runner });
    expect(calls).toBe(3);
    resetLinuxVerifierCgroupRuntimeCacheForTest();
  });
});

describe("v2 verifier journal recovery", () => {
  function recoveryLine(dev: string, ino: string, name = "loop-0123456789abcdef"): string {
    return serializeVerifierCgroupJournalRecord({
      v: 2,
      kind: "verifier-cgroup",
      runId: "recovery-test",
      attemptId: "attempt-test",
      leaseId: "lease-test",
      scopeId: verifierCgroupScopeId({ version: 2, dev, ino, name, pid: 2_147_483_647, startTicks: "1" }),
      maxDescendants: 256,
      maxDepth: 16
    }).trim();
  }

  it("discharges an absent exact scope only when its original process group is ESRCH", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "rf-cgroup-recovery-"));
    temporary.push(root);
    const outcome = await reapLinuxVerifierCgroupJournalLine(recoveryLine("1", "2"), {
      ...collectedEvidence(),
      outerScopeRoot: root
    });
    expect(outcome).toBe("gone");
  });

  it("retains a foreign replacement and never adopts it by name", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "rf-cgroup-foreign-"));
    temporary.push(root);
    const name = "loop-0123456789abcdef";
    const exactPath = resolve(root, name);
    const replacement = mkdtempSync(`${exactPath}-replacement-`);
    writeFileSync(resolve(replacement, "witness"), "do not remove");
    const stat = statSync(replacement, { bigint: true });
    const line = recoveryLine(String(stat.dev), String(stat.ino + 1n), name);
    renameSync(replacement, exactPath);
    const outcome = await reapLinuxVerifierCgroupJournalLine(line, { ...collectedEvidence(), outerScopeRoot: root });
    expect(outcome).toBe("foreign");
    expect(readFileSync(resolve(exactPath, "witness"), "utf8")).toBe("do not remove");
  });
});

describe("production verifier session through the shared transport", () => {
  it("journals v2 before GO, runs nested cgroups, closes FD5, and settles the exact scope", async () => {
    const runtime = await getCachedLinuxVerifierCgroupRuntime();
    if (!runtime.capability.available) {
      if (process.env.RELAYFORGE_TEST_REQUIRE_CGROUP === "1") {
        throw new Error(`required verifier cgroup unavailable [${runtime.capability.reasonCode}]: ${runtime.capability.detail}`);
      }
      expect(VERIFIER_CGROUP_UNAVAILABLE_REASONS).toContain(runtime.capability.reasonCode);
      return;
    }
    const root = mkdtempSync(resolve(process.cwd(), ".rf-cgroup-session-"));
    temporary.push(root);
    const journal = resolve(root, ".loop_scopes");
    const ctx = {
      runId: "cgroup-session-test",
      runDir: root,
      scopesPath: journal,
      loop: { cadenceMinutes: 1 },
      children: new Set(),
      ownedGroups: new Set<number>(),
      ownedScopes: new Set()
    } as any;
    const backend = linuxVerifierCgroupBackend(runtime, {
      runId: "cgroup-session-test",
      attemptId: "nested-verifier",
      leaseId: "lease-test"
    }, root);
    const script = [
      'test "$(cat /proc/self/cgroup)" = "0::/"',
      "test ! -e /proc/self/fd/5",
      "mkdir /sys/fs/cgroup/nested-verifier-test",
      'test "$(cat /sys/fs/cgroup/nested-verifier-test/cgroup.events | sed -n "s/^populated //p")" = "0"',
      "rmdir /sys/fs/cgroup/nested-verifier-test",
      "printf nested-cgroup-ok"
    ].join(" && ");
    const result = await runHeadlessChild(
      ctx,
      "/bin/sh",
      ["-c", script],
      { PATH: "/usr/bin:/bin", HOME: "/tmp", LANG: "C.UTF-8" },
      "",
      root,
      undefined,
      root,
      30_000,
      undefined,
      undefined,
      { scopeBackend: backend }
    );
    expect(result.ok, `${result.uncertainReason ?? ""}\n${result.stderr}`).toBe(true);
    expect(result.stdout).toContain("nested-cgroup-ok");
    const lines = readFileSync(journal, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = parseVerifierCgroupJournalLine(lines[0]);
    expect(parsed.kind).toBe("v2");
    if (parsed.kind === "v2") {
      expect(parsed.record.attemptId).toBe("nested-verifier");
      expect(readdirSync(runtime.collected.outerScopeRoot!).some((name) => name === parsed.identity.name)).toBe(false);
    }
  }, 45_000);

  it("routes ordered verifier commands through fresh strict sessions and stops on failure", async () => {
    const runtime = await getCachedLinuxVerifierCgroupRuntime();
    if (!runtime.capability.available) {
      if (process.env.RELAYFORGE_TEST_REQUIRE_CGROUP === "1") {
        throw new Error(`required verifier cgroup unavailable [${runtime.capability.reasonCode}]: ${runtime.capability.detail}`);
      }
      expect(VERIFIER_CGROUP_UNAVAILABLE_REASONS).toContain(runtime.capability.reasonCode);
      return;
    }
    const root = mkdtempSync(resolve(process.cwd(), ".rf-cgroup-ordered-"));
    temporary.push(root);
    const ctx = {
      runId: "ordered-session-test",
      runDir: root,
      scopesPath: resolve(root, ".loop_scopes"),
      activeLeaseId: "lease-test",
      verifierCgroupRuntime: runtime,
      loop: { cadenceMinutes: 1 },
      children: new Set(),
      ownedGroups: new Set<number>(),
      ownedScopes: new Set()
    } as any;
    const passed = await runOrderedVerify(ctx, root, ["printf FIRST", "printf SECOND"], "host-characterization");
    expect(passed.ok, passed.output).toBe(true);
    expect(passed.output).toContain("FIRST");
    expect(passed.output).toContain("SECOND");
    const stopped = await runOrderedVerify(ctx, root, ["printf FAILING && exit 7", "printf MUST_NOT_RUN"], "host-failure");
    expect(stopped.ok).toBe(false);
    expect(stopped.output).toContain("FAILING");
    expect(stopped.output).not.toContain("MUST_NOT_RUN");
    const records = readFileSync(ctx.scopesPath, "utf8").trim().split("\n");
    expect(records).toHaveLength(3);
    expect(records.every((line) => parseVerifierCgroupJournalLine(line).kind === "v2")).toBe(true);
  }, 60_000);

  it("reaps the one exact session on timeout and cancellation without leaking a scope", async () => {
    const runtime = await getCachedLinuxVerifierCgroupRuntime();
    if (!runtime.capability.available) {
      if (process.env.RELAYFORGE_TEST_REQUIRE_CGROUP === "1") throw new Error(`required verifier cgroup unavailable [${runtime.capability.reasonCode}]: ${runtime.capability.detail}`);
      return;
    }
    const root = mkdtempSync(resolve(process.cwd(), ".rf-cgroup-stop-"));
    temporary.push(root);
    const ctx = {
      runId: "stop-session-test",
      runDir: root,
      scopesPath: resolve(root, ".loop_scopes"),
      loop: { cadenceMinutes: 1 },
      children: new Set(),
      ownedGroups: new Set<number>(),
      ownedScopes: new Set<any>()
    } as any;
    const before = new Set(readdirSync(runtime.collected.outerScopeRoot!));
    const timeoutBackend = linuxVerifierCgroupBackend(runtime, { runId: ctx.runId, attemptId: "timeout", leaseId: "lease-test" }, root);
    const timed = await runHeadlessChild(
      ctx, "/bin/sh", ["-c", "sleep 60"], { PATH: "/usr/bin:/bin", HOME: "/tmp" }, "", root,
      undefined, root, 150, undefined, undefined, { scopeBackend: timeoutBackend }
    );
    expect(timed.ok).toBe(false);
    expect(timed.uncertainReason).toContain("timeout");

    let cancelled = false;
    const cancelBackend = linuxVerifierCgroupBackend(runtime, { runId: ctx.runId, attemptId: "cancel", leaseId: "lease-test" }, root);
    const pending = runHeadlessChild(
      ctx, "/bin/sh", ["-c", "sleep 60"], { PATH: "/usr/bin:/bin", HOME: "/tmp" }, "", root,
      undefined, root, 30_000, undefined, undefined,
      { scopeBackend: cancelBackend, cancelled: () => cancelled }
    );
    setTimeout(() => {
      cancelled = true;
      for (const scope of ctx.ownedScopes) void scope.reap(0);
    }, 100);
    const stopped = await pending;
    expect(stopped.ok).toBe(false);
    expect(stopped.uncertainReason).toContain("cancelled");
    const after = readdirSync(runtime.collected.outerScopeRoot!).filter((name) => !before.has(name));
    expect(after.filter((name) => /^loop-[0-9a-f]{16}$/.test(name))).toEqual([]);
  }, 60_000);

  it("refuses before verifier exec when the v2 journal fsync fails", async () => {
    const runtime = await getCachedLinuxVerifierCgroupRuntime();
    if (!runtime.capability.available) {
      if (process.env.RELAYFORGE_TEST_REQUIRE_CGROUP === "1") throw new Error(`required verifier cgroup unavailable [${runtime.capability.reasonCode}]: ${runtime.capability.detail}`);
      return;
    }
    const root = mkdtempSync(resolve(process.cwd(), ".rf-cgroup-fsync-"));
    temporary.push(root);
    const marker = resolve(root, "verifier-executed");
    const ctx = {
      runId: "fsync-session-test",
      runDir: root,
      scopesPath: resolve(root, ".loop_scopes"),
      scopeJournalFsync: () => { throw Object.assign(new Error("injected fsync failure"), { code: "EIO" }); },
      loop: { cadenceMinutes: 1 },
      children: new Set(),
      ownedGroups: new Set<number>(),
      ownedScopes: new Set<any>()
    } as any;
    const backend = linuxVerifierCgroupBackend(runtime, { runId: ctx.runId, attemptId: "fsync", leaseId: "lease-test" }, root);
    const result = await runHeadlessChild(
      ctx, "/bin/sh", ["-c", `printf ran > ${JSON.stringify(marker)}`], { PATH: "/usr/bin:/bin", HOME: "/tmp" }, "", root,
      undefined, root, 30_000, undefined, undefined, { scopeBackend: backend }
    );
    expect(result.ok).toBe(false);
    expect(result.uncertainReason).toMatch(/launch refused|fsync failure/);
    expect(() => readFileSync(marker)).toThrow();
    if (result.scopeId) {
      const name = result.scopeId.split(":")[2];
      expect(readdirSync(runtime.collected.outerScopeRoot!)).not.toContain(name);
    }
  }, 45_000);

  it("enforces exactly 256 descendants and depth 16 with EAGAIN at each next mkdir", async () => {
    const runtime = await getCachedLinuxVerifierCgroupRuntime();
    if (!runtime.capability.available) {
      if (process.env.RELAYFORGE_TEST_REQUIRE_CGROUP === "1") throw new Error(`required verifier cgroup unavailable [${runtime.capability.reasonCode}]: ${runtime.capability.detail}`);
      return;
    }
    const root = mkdtempSync(resolve(process.cwd(), ".rf-cgroup-limits-"));
    temporary.push(root);
    const ctx = {
      runId: "limit-session-test", runDir: root, scopesPath: resolve(root, ".loop_scopes"),
      loop: { cadenceMinutes: 1 }, children: new Set(), ownedGroups: new Set<number>(), ownedScopes: new Set<any>()
    } as any;
    const backend = linuxVerifierCgroupBackend(runtime, { runId: ctx.runId, attemptId: "limits", leaseId: "lease-test" }, root);
    const code = String.raw`
      const fs=require("node:fs"); const root="/sys/fs/cgroup";
      const siblings=[]; let descendantCode="none"; let depthCode="none";
      try {
        for(let i=0;i<256;i++){const p=root+"/limit-"+String(i).padStart(3,"0"); fs.mkdirSync(p); siblings.push(p);}
        try{fs.mkdirSync(root+"/limit-overflow");}catch(e){descendantCode=e.code;}
      } finally { for(const p of siblings.reverse()) try{fs.rmdirSync(p);}catch{} }
      const chain=[]; let p=root;
      try {
        for(let i=0;i<16;i++){p+="/depth-"+String(i).padStart(2,"0"); fs.mkdirSync(p); chain.push(p);}
        try{fs.mkdirSync(p+"/depth-overflow");}catch(e){depthCode=e.code;}
      } finally { for(const d of chain.reverse()) try{fs.rmdirSync(d);}catch{} }
      if(descendantCode!=="EAGAIN"||depthCode!=="EAGAIN") throw new Error(JSON.stringify({descendantCode,depthCode}));
      process.stdout.write("exact-limits-ok");
    `;
    const result = await runHeadlessChild(
      ctx, runtime.collected.dependencies!.node.command, ["-e", code],
      { PATH: "/usr/bin:/bin", HOME: "/tmp" }, "", root, undefined, root, 30_000,
      undefined, undefined, { scopeBackend: backend }
    );
    expect(result.ok, `${result.uncertainReason ?? ""}\n${result.stderr}`).toBe(true);
    expect(result.stdout).toContain("exact-limits-ok");
  }, 45_000);
});

describe("actual-host characterization (never skipped and never downgraded)", () => {
  it("either proves the complete real composition or returns one exact closed reason and leaves no probe scope", async () => {
    const before = collectLinuxCgroupEvidence();
    const beforeNames = before.outerScopeRoot
      ? new Set(readdirSync(before.outerScopeRoot).filter((name) => /^rf-probe-sibling-|^loop-[0-9a-f]{16}$/.test(name)))
      : new Set<string>();

    const capability = await probeVerifierCgroupJailLinux();
    const required = process.env.RELAYFORGE_TEST_REQUIRE_CGROUP === "1";
    if (required) {
      expect(capability.available, capability.available ? "" : `${capability.reasonCode}: ${capability.detail}`).toBe(true);
    }
    if (capability.available) {
      expect(capability).toMatchObject({
        cgroupVersion: 2,
        mountPoint: "/sys/fs/cgroup",
        nsdelegate: true,
        strictCgroupNamespace: true,
        fdBind: true,
        strongOuterScope: true,
        maxDescendants: 256,
        maxDepth: 16
      });
    } else {
      expect(VERIFIER_CGROUP_UNAVAILABLE_REASONS).toContain(capability.reasonCode);
      expect(capability.detail.length).toBeGreaterThan(0);
    }

    const after = collectLinuxCgroupEvidence();
    if (before.outerScopeRoot && after.outerScopeRoot === before.outerScopeRoot) {
      const afterNames = new Set(readdirSync(after.outerScopeRoot).filter((name) => /^rf-probe-sibling-|^loop-[0-9a-f]{16}$/.test(name)));
      expect(afterNames).toEqual(beforeNames);
    }
  }, 30_000);
});

#!/usr/bin/env node
/**
 * Dry-run readiness probe for same-job native adapter receipt collection.
 *
 * Verifies host/checkout prerequisites for the release workflow path:
 *   collect-contained-adapter-evidence → required-real vitest → extract → bundle
 *
 * Never performs a paid probe, never prints secret values, and never invents evidence.
 * Exit 0 only when fully ready for paid collect (including all three API keys present).
 * Exit non-zero with a clear missing-items summary otherwise.
 *
 * Usage:
 *   PATH=/usr/bin:$HOME/.local/bin:$PATH node scripts/check-native-receipt-readiness.mjs
 *   PATH=/usr/bin:$HOME/.local/bin:$PATH node scripts/check-native-receipt-readiness.mjs --json
 */
import { spawnSync } from "node:child_process";
import {
  constants,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeSync
} from "node:fs";
import { arch, platform, release as osRelease, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED = Object.freeze({
  opencode: "1.18.15",
  pi: "0.84.1",
  grokVersion: "1.0.0",
  grokCommit: "3cd0d0cbce",
  nodeMajorMin: 20
});
const KEY_NAMES = Object.freeze(["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY"]);
const ADAPTER_KEYS = Object.freeze({
  opencode: "OPENAI_API_KEY",
  pi: "ANTHROPIC_API_KEY",
  grok: "XAI_API_KEY"
});

function runCapture(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env,
    cwd: REPO,
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024
  });
  return {
    status: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    error: result.error
  };
}

function which(binary) {
  const result = runCapture("bash", ["-lc", `command -v -- ${JSON.stringify(binary)}`]);
  if (result.status !== 0 || !result.stdout) return null;
  return result.stdout.split("\n")[0].trim() || null;
}

function keyPresence(name) {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? "SET" : "unset";
}

function checkGit(checks, missing) {
  const head = runCapture("git", ["rev-parse", "HEAD"]);
  const porcelain = runCapture("git", ["status", "--porcelain"]);
  const branch = runCapture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (head.status !== 0 || !/^[a-f0-9]{40}$/u.test(head.stdout)) {
    checks.push({ name: "git-head", status: "fail", detail: "unable to read a 40-hex HEAD" });
    missing.push("git HEAD");
    return null;
  }
  const dirty = porcelain.stdout.length > 0;
  checks.push({
    name: "git-head",
    status: dirty ? "fail" : "ok",
    detail: dirty
      ? `HEAD ${head.stdout} but working tree is dirty (receipts require a clean checkout)`
      : `HEAD ${head.stdout} clean${branch.stdout ? ` (${branch.stdout})` : ""}`
  });
  if (dirty) missing.push("clean git working tree");
  return head.stdout;
}

function checkNode(checks, missing) {
  const version = process.version.replace(/^v/u, "");
  const major = Number(version.split(".")[0]);
  const ok = Number.isFinite(major) && major >= EXPECTED.nodeMajorMin;
  checks.push({
    name: "node",
    status: ok ? "ok" : "fail",
    detail: ok
      ? `Node v${version} (RelayForge host; Pi CLI may wrap Node ≥ 22.19 separately)`
      : `Node v${version} is below minimum ${EXPECTED.nodeMajorMin}`
  });
  if (!ok) missing.push(`Node ≥ ${EXPECTED.nodeMajorMin}`);
}

function matchBinaryVersion(adapterId, stdout) {
  if (adapterId === "opencode") {
    return stdout === EXPECTED.opencode || stdout.endsWith(EXPECTED.opencode)
      ? { ok: true, observed: stdout }
      : { ok: false, observed: stdout, expected: EXPECTED.opencode };
  }
  if (adapterId === "pi") {
    const first = stdout.split(/\s+/u)[0] ?? stdout;
    return first === EXPECTED.pi || stdout.includes(EXPECTED.pi)
      ? { ok: true, observed: stdout }
      : { ok: false, observed: stdout, expected: EXPECTED.pi };
  }
  // grok 1.0.0 (3cd0d0cbce) [stable]
  const hasVersion = stdout.includes(EXPECTED.grokVersion);
  const hasCommit = stdout.includes(EXPECTED.grokCommit);
  return hasVersion && hasCommit
    ? { ok: true, observed: stdout }
    : {
        ok: false,
        observed: stdout,
        expected: `grok ${EXPECTED.grokVersion} (${EXPECTED.grokCommit})`
      };
}

function checkBinaries(checks, missing) {
  const pathEnv = process.env.PATH ?? "";
  for (const adapterId of ["opencode", "pi", "grok"]) {
    const path = which(adapterId);
    if (!path) {
      checks.push({
        name: `binary-${adapterId}`,
        status: "fail",
        detail: `${adapterId} not found on PATH (use PATH=/usr/bin:$HOME/.local/bin:$PATH)`
      });
      missing.push(`${adapterId} binary`);
      continue;
    }
    const version = runCapture(adapterId, ["--version"]);
    const text = version.stdout || version.stderr;
    if (version.status !== 0 || !text) {
      checks.push({
        name: `binary-${adapterId}`,
        status: "fail",
        detail: `${adapterId} at ${path} failed --version (status ${version.status})`
      });
      missing.push(`${adapterId} ${adapterId === "grok" ? EXPECTED.grokVersion : EXPECTED[adapterId]}`);
      continue;
    }
    const match = matchBinaryVersion(adapterId, text);
    checks.push({
      name: `binary-${adapterId}`,
      status: match.ok ? "ok" : "fail",
      detail: match.ok
        ? `${path} → ${match.observed}`
        : `${path} → ${match.observed}; expected ${match.expected}`
    });
    if (!match.ok) {
      missing.push(
        adapterId === "grok"
          ? `grok ${EXPECTED.grokVersion} (${EXPECTED.grokCommit})`
          : `${adapterId} ${EXPECTED[adapterId]}`
      );
    }
  }
  // Pi requires Node ≥ 22.19 under the wrapper; surface that when pi is present.
  const piPath = which("pi");
  if (piPath) {
    try {
      const shebang = readFileSync(piPath, "utf8").slice(0, 400);
      if (shebang.includes("node-v22") || shebang.includes("node")) {
        checks.push({
          name: "pi-node-wrapper",
          status: "ok",
          detail: "pi wrapper present (Node ≥ 22.19 required for Pi CLI; host Node 20.x is fine for RelayForge)"
        });
      }
    } catch {
      // ignore unreadable wrapper
    }
  }
  checks.push({
    name: "path-hint",
    status: "ok",
    detail: `PATH prefix should put /usr/bin before user bins for Node; current PATH starts with ${pathEnv.split(":").slice(0, 3).join(":") || "(empty)"}`
  });
}

function checkKeys(checks, missing) {
  const presence = Object.fromEntries(KEY_NAMES.map((name) => [name, keyPresence(name)]));
  for (const [adapterId, envName] of Object.entries(ADAPTER_KEYS)) {
    const state = presence[envName];
    checks.push({
      name: `key-${adapterId}`,
      status: state === "SET" ? "ok" : "fail",
      detail: `${envName}=${state} (required for ${adapterId} paid collect; value never printed)`
    });
    if (state !== "SET") missing.push(`${envName} (for ${adapterId})`);
  }
  return presence;
}

function checkContainment(checks, missing) {
  // Lightweight probe first (always), then doctor if dist is available.
  const bwrapPath = which("bwrap");
  const bwrapVersion = bwrapPath ? runCapture("bwrap", ["--version"]) : null;
  const bwrapOk =
    Boolean(bwrapPath) &&
    bwrapVersion &&
    bwrapVersion.status === 0 &&
    /bubblewrap/i.test(`${bwrapVersion.stdout} ${bwrapVersion.stderr}`);
  checks.push({
    name: "bwrap",
    status: bwrapOk ? "ok" : "fail",
    detail: bwrapOk
      ? `${bwrapPath} → ${(bwrapVersion.stdout || bwrapVersion.stderr).split("\n")[0]}`
      : "bwrap not launchable on PATH"
  });
  if (!bwrapOk) missing.push("bubblewrap (bwrap)");

  let cgroupOk = false;
  let cgroupDetail = "unable to read unified cgroup v2";
  try {
    const cgroup = readFileSync("/proc/self/cgroup", "utf8");
    const controllers = readFileSync("/sys/fs/cgroup/cgroup.controllers", "utf8").trim();
    cgroupOk = cgroup.includes("0::") && controllers.length > 0 && platform() === "linux";
    const identity = cgroup.split("\n").find((line) => line.startsWith("0::")) ?? "(missing 0::)";
    cgroupDetail = cgroupOk
      ? `unified cgroup v2 ${identity}; controllers=${controllers.split(/\s+/u).slice(0, 8).join(" ")}…; kernel ${osRelease()} ${arch()}`
      : `cgroup/controllers unreadable or not unified (os=${platform()})`;
  } catch (error) {
    cgroupDetail = error instanceof Error ? error.message : String(error);
  }
  checks.push({
    name: "cgroup-v2",
    status: cgroupOk ? "ok" : "fail",
    detail: cgroupDetail
  });
  if (!cgroupOk) missing.push("unified cgroup v2 hierarchy");

  const cli = join(REPO, "dist", "cli.js");
  if (existsSync(cli)) {
    const doctor = runCapture(process.execPath, [cli, "--json", "doctor"]);
    if (doctor.status === 0 || doctor.stdout.includes("{")) {
      try {
        const report = JSON.parse(doctor.stdout);
        const byName = new Map((report.checks ?? []).map((check) => [check.name, check]));
        for (const name of ["sandbox", "process-scope"]) {
          const check = byName.get(name);
          if (!check) {
            checks.push({ name: `doctor-${name}`, status: "fail", detail: `doctor did not report ${name}` });
            missing.push(`doctor ${name}`);
            continue;
          }
          const ok = check.status === "ok";
          checks.push({
            name: `doctor-${name}`,
            status: ok ? "ok" : "fail",
            detail: `${check.status}: ${check.detail}`
          });
          if (!ok) missing.push(`doctor ${name} (${check.status})`);
        }
        const jail = byName.get("verifier-cgroup-jail");
        if (jail) {
          // warn is acceptable for readiness — behavioral probe runs at collect/execute time
          checks.push({
            name: "doctor-verifier-cgroup-jail",
            status: jail.status === "fail" ? "fail" : "ok",
            detail: `${jail.status}: ${jail.detail}`
          });
          if (jail.status === "fail") missing.push("doctor verifier-cgroup-jail");
        }
      } catch {
        checks.push({
          name: "doctor",
          status: "warn",
          detail: "doctor --json did not parse; lightweight bwrap/cgroup probes above still apply"
        });
      }
    } else {
      checks.push({
        name: "doctor",
        status: "warn",
        detail: "dist/cli.js doctor failed; relying on lightweight bwrap/cgroup probes"
      });
    }
  } else {
    checks.push({
      name: "doctor",
      status: "warn",
      detail: "dist/cli.js missing (run npm run build); relying on lightweight bwrap/cgroup probes"
    });
  }
}

function checkRunnerTempRules(checks, missing) {
  /**
   * Layout rules (same as release.yml + collectors):
   * - RUNNER_TEMP must be an absolute path
   * - directory owned by this uid
   * - mode must not grant group/other bits (mode & 0o077 === 0), typically 0700
   * - evidence/receipt outputs must be canonical absolute paths under that root
   * - job nonce is 32 random bytes as 64 lowercase hex
   */
  const configured = process.env.RUNNER_TEMP;
  if (typeof configured === "string" && configured.length > 0) {
    try {
      if (!isAbsolute(configured)) {
        checks.push({
          name: "runner-temp",
          status: "fail",
          detail: "RUNNER_TEMP is set but not absolute"
        });
        missing.push("absolute private RUNNER_TEMP");
        return;
      }
      const root = realpathSync(configured);
      const info = statSync(root);
      const modeBits = info.mode & 0o077;
      const uidOk = typeof process.getuid !== "function" || info.uid === process.getuid();
      const ok = info.isDirectory() && modeBits === 0 && uidOk;
      checks.push({
        name: "runner-temp",
        status: ok ? "ok" : "fail",
        detail: ok
          ? `RUNNER_TEMP=${root} private owned directory (mode ${(info.mode & 0o777).toString(8)})`
          : `RUNNER_TEMP=${root} fails privacy rules (dir=${info.isDirectory()} mode&077=${modeBits} uidOk=${uidOk})`
      });
      if (!ok) missing.push("private owned RUNNER_TEMP (mode 0700, uid match)");
    } catch (error) {
      checks.push({
        name: "runner-temp",
        status: "fail",
        detail: `RUNNER_TEMP is set but unusable: ${error instanceof Error ? error.message : String(error)}`
      });
      missing.push("usable private RUNNER_TEMP");
    }
    return;
  }

  // Not set: prove we can create a private workspace the same way the collect helper will.
  const probeRoot = join(tmpdir(), `relayforge-receipt-readiness-${process.pid}`);
  try {
    mkdirSync(probeRoot, { recursive: false, mode: 0o700 });
    const root = realpathSync(probeRoot);
    const info = statSync(root);
    const modeBits = info.mode & 0o077;
    const uidOk = typeof process.getuid !== "function" || info.uid === process.getuid();
    // Prove exclusive private file create (job-nonce style)
    const noncePath = join(root, "job-nonce-probe");
    const fd = openSync(noncePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeSync(fd, "0".repeat(64) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const ok = info.isDirectory() && modeBits === 0 && uidOk;
    checks.push({
      name: "runner-temp-layout",
      status: ok ? "ok" : "fail",
      detail: ok
        ? "RUNNER_TEMP unset; host can create private 0700 workspace + 0600 nonce file (collect helper will set RUNNER_TEMP)"
        : `created workspace failed privacy rules (mode&077=${modeBits} uidOk=${uidOk})`
    });
    if (!ok) missing.push("ability to create private RUNNER_TEMP workspace");
  } catch (error) {
    checks.push({
      name: "runner-temp-layout",
      status: "fail",
      detail: `cannot create private workspace: ${error instanceof Error ? error.message : String(error)}`
    });
    missing.push("ability to create private RUNNER_TEMP workspace");
  } finally {
    try {
      rmSync(probeRoot, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

function checkCollectorScripts(checks, missing) {
  const required = [
    "scripts/collect-contained-adapter-evidence.mjs",
    "scripts/create-native-adapter-receipt-bundle.mjs",
    "dist/adapters/contained-evidence-production.js",
    "dist/adapters/contained-evidence.js",
    "tests/adapter-opencode.test.ts",
    "tests/adapter-pi.test.ts",
    "tests/adapter-grok.test.ts"
  ];
  for (const rel of required) {
    const abs = join(REPO, rel);
    const ok = existsSync(abs);
    checks.push({
      name: `artifact-${rel}`,
      status: ok ? "ok" : "fail",
      detail: ok ? rel : `${rel} missing`
    });
    if (!ok) missing.push(rel);
  }
}

export function main(args = process.argv.slice(2)) {
  const jsonMode = args.includes("--json");
  if (args.some((value) => value !== "--json")) {
    console.error("usage: node scripts/check-native-receipt-readiness.mjs [--json]");
    process.exitCode = 2;
    return;
  }

  const checks = [];
  const missing = [];

  process.chdir(REPO);
  checkNode(checks, missing);
  const head = checkGit(checks, missing);
  checkBinaries(checks, missing);
  const keys = checkKeys(checks, missing);
  checkContainment(checks, missing);
  checkRunnerTempRules(checks, missing);
  checkCollectorScripts(checks, missing);

  const ready = missing.length === 0;
  const report = {
    status: ready ? "ready" : "not-ready",
    ready,
    commitSha: head,
    platform: platform(),
    arch: arch(),
    keys,
    expectedPins: {
      opencode: EXPECTED.opencode,
      pi: EXPECTED.pi,
      grok: `${EXPECTED.grokVersion} (${EXPECTED.grokCommit})`
    },
    missing,
    checks,
    next: ready
      ? "PATH=/usr/bin:$HOME/.local/bin:$PATH node scripts/collect-all-native-receipts.mjs --authorize-paid-probe"
      : "fix missing items above; re-run this readiness check; do not invent evidence"
  };

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write("Native receipt collection readiness\n");
    process.stdout.write("===================================\n");
    for (const check of checks) {
      const mark = check.status === "ok" ? "OK  " : check.status === "warn" ? "WARN" : "FAIL";
      process.stdout.write(`[${mark}] ${check.name}: ${check.detail}\n`);
    }
    process.stdout.write("\n");
    process.stdout.write(`Keys: ${KEY_NAMES.map((name) => `${name}=${keys[name]}`).join(" ")}\n`);
    if (head) process.stdout.write(`HEAD: ${head}\n`);
    if (ready) {
      process.stdout.write("\nSTATUS: ready for paid same-job native receipt collect\n");
      process.stdout.write(`Next: ${report.next}\n`);
    } else {
      process.stdout.write("\nSTATUS: not ready\n");
      process.stdout.write("Missing:\n");
      for (const item of missing) process.stdout.write(`  - ${item}\n`);
      process.stdout.write("\nDo not invent evidence. Do not collect paid receipts until every item is fixed.\n");
      process.stdout.write(`Re-run: PATH=/usr/bin:$HOME/.local/bin:$PATH node scripts/check-native-receipt-readiness.mjs\n`);
    }
  }

  process.exitCode = ready ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

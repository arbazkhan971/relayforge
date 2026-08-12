#!/usr/bin/env node
/**
 * Runner-host readiness probe for the self-hosted RelayForge release runner.
 *
 * Verifies what the release workflows need from the HOST (see
 * docs/linux-runner-runbook.md): Node/npm pins, Bubblewrap, delegated cgroup v2,
 * Chrome for the packed-browser gate, and the exact pinned adapter CLIs.
 *
 * Never performs a paid probe, never prints secrets, and never invents evidence.
 * Exit 0 only when every check passes; exit 1 with a clear missing-items summary.
 *
 * Usage:
 *   PATH=/usr/bin:$HOME/.local/bin:$PATH node scripts/check-relayforge-runner.mjs
 *   PATH=/usr/bin:$HOME/.local/bin:$PATH node scripts/check-relayforge-runner.mjs --json
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { platform, release as osRelease } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const EXPECTED = Object.freeze({
  nodeMajorMin: 20,
  nodeExact: "20.20.2",
  npmMajorMin: 10,
  chromeMajorMin: 150,
  bwrapExact: "0.9.0",
  opencode: "1.18.15",
  pi: "0.84.1",
  grokVersion: "1.0.0",
  grokCommit: "3cd0d0cbce"
});

const JSON_OUTPUT = process.argv.includes("--json");

function runCapture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) return { ok: false, out: (result.stdout || result.stderr || "").trim() };
  return { ok: true, out: (result.stdout || "").trim() };
}

function versionOf(command) {
  const probe = runCapture(command, ["--version"]);
  if (!probe.ok) return probe.out;
  const first = probe.out.split("\n")[0] ?? "";
  return first.replace(/^[\w@.\-/ ]*[\s]+/, "").trim();
}

const checks = [];

function check(name, pass, detail) {
  checks.push({ name, pass, detail });
}

// --- node / npm pins ---
const nodeProbe = runCapture("node", ["--version"]);
const nodeVersion = nodeProbe.out.replace(/^v/, "");
const nodeMajor = Number.parseInt(nodeVersion.split(".")[0] ?? "0", 10);
check("node", nodeProbe.ok && nodeMajor >= EXPECTED.nodeMajorMin,
  nodeProbe.ok ? nodeVersion : "node not on PATH");
check("node pin (release baseline)", nodeVersion === EXPECTED.nodeExact,
  nodeProbe.ok ? `${nodeVersion} (exact ${EXPECTED.nodeExact} for release gates)` : "unavailable");

const npmProbe = runCapture("npm", ["--version"]);
const npmMajor = Number.parseInt(npmProbe.out.split(".")[0] ?? "0", 10);
check("npm", npmProbe.ok && npmMajor >= EXPECTED.npmMajorMin,
  npmProbe.ok ? npmProbe.out : "npm not on PATH");

// --- Bubblewrap ---
const bwrapVersion = versionOf("bwrap");
check("bubblewrap", bwrapVersion === EXPECTED.bwrapExact,
  bwrapVersion ? `${bwrapVersion} (exact ${EXPECTED.bwrapExact})` : "bwrap not on PATH");

// --- delegated cgroup v2 ---
let cgroup2 = false;
let cgroupDetail = "cgroup2 not detected";
try {
  const fsType = runCapture("stat", ["-fc", "%T", "/sys/fs/cgroup"]);
  cgroup2 = fsType.out === "cgroup2fs";
  cgroupDetail = fsType.ok ? fsType.out : "stat failed";
} catch {
  cgroupDetail = "cannot stat /sys/fs/cgroup";
}
check("cgroup v2 filesystem", cgroup2 && platform() === "linux", `${cgroupDetail} (${platform()})`);

let delegated = false;
let delegateDetail = "no systemd user session detected";
const systemdProbe = runCapture("systemctl", ["--user", "is-system-running"]);
if (systemdProbe.ok) {
  const controllers = readFileSync(`/sys/fs/cgroup/user.slice/user-${process.getuid?.() ?? 0}.slice/user@${process.getuid?.() ?? 0}.service/cgroup.controllers`, "utf8").trim();
  const hasControllers = controllers.includes("cpu") && controllers.includes("memory");
  delegated = hasControllers && controllers.includes("cpuset");
  delegateDetail = delegated ? `user slice delegates: ${controllers}` : `user slice lacks full delegation: ${controllers || "none"}`;
}
check("user-slice cgroup delegation", delegated, delegateDetail);

// --- Chrome (packed-browser gate) ---
const chromeProbe = runCapture("google-chrome", ["--version"]);
const chromeVersion = chromeProbe.out.replace(/^Google Chrome\s+/, "");
const chromeMajor = Number.parseInt(chromeVersion.split(".")[0] ?? "0", 10);
check("chrome", chromeProbe.ok && chromeMajor >= EXPECTED.chromeMajorMin,
  chromeProbe.ok ? chromeVersion : "google-chrome not on PATH");

// --- exact pinned adapter CLIs ---
const adapters = [
  ["opencode", EXPECTED.opencode],
  ["pi", EXPECTED.pi],
  ["grok", `${EXPECTED.grokVersion} (${EXPECTED.grokCommit})`]
];
for (const [command, pin] of adapters) {
  const got = versionOf(command);
  const matchesPin = command === "grok"
    ? got.includes(EXPECTED.grokVersion) && got.includes(EXPECTED.grokCommit)
    : got.includes(pin);
  check(`${command} pin`, matchesPin, got ? `${got} (expect ${pin})` : `${command} not on PATH`);
}

// --- host sanity ---
check("linux host", platform() === "linux", platform());
check("os release", osRelease().length > 0, osRelease());

const failed = checks.filter((item) => !item.pass);
const passed = checks.length - failed.length;

function printTable() {
  const width = Math.max(...checks.map((item) => item.name.length)) + 2;
  console.log(`relayforge runner readiness: ${passed}/${checks.length} checks passing`);
  console.log("-".repeat(72));
  for (const item of checks) {
    console.log(`${item.pass ? "✓" : "✗"} ${item.name.padEnd(width)} ${item.detail}`);
  }
  if (failed.length > 0) {
    console.log("-".repeat(72));
    console.log(`Missing: ${failed.map((item) => item.name).join(", ")}`);
  }
}

if (JSON_OUTPUT) {
  process.stdout.write(`${JSON.stringify({ ok: failed.length === 0, passed, total: checks.length, failed: failed.map((item) => ({ name: item.name, detail: item.detail })) }, null, 2)}\n`);
} else {
  printTable();
}

process.exitCode = failed.length === 0 ? 0 : 1;

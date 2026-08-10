#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  containedAdapterProbeConfigurationSha256,
  readContainedAdapterEvidenceFile
} from "../dist/adapters/contained-evidence.js";

const IDS = Object.freeze(["opencode", "pi", "grok"]);
const SHA = /^[a-f0-9]{64}$/u;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

function fail(message) { throw new Error(`native adapter receipt bundle: ${message}`); }
function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  fail("non-canonical value");
}
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function bounded(value, name, maximum = 256) { if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f]/u.test(value) || Buffer.byteLength(value) > maximum) fail(`${name} is not bounded`); return value; }
function within(root, path) { const rel = relative(root, path); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); }

const EXTRACT_ARGUMENTS = Object.freeze(["--adapter", "--evidence-file", "--receipt-output", "--commit-sha", "--job-nonce"]);
const BUNDLE_ARGUMENTS = Object.freeze(["--output", "--commit-sha", "--opencode-receipt", "--pi-receipt", "--grok-receipt"]);

function exactArguments(args, mode) {
  const names = mode === "extract" ? EXTRACT_ARGUMENTS : BUNDLE_ARGUMENTS;
  const allowed = new Set(names);
  const values = new Map();
  let extractMarkers = 0;
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--extract") {
      extractMarkers += 1;
      if (mode !== "extract" || extractMarkers !== 1) fail("--extract is duplicated or invalid in bundle mode");
      continue;
    }
    if (!allowed.has(name)) fail(`unknown argument ${JSON.stringify(name)}`);
    if (values.has(name)) fail(`${name} is duplicated`);
    const value = args[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) fail(`${name} requires exactly one value`);
    values.set(name, value);
    index += 1;
  }
  if ((mode === "extract" && extractMarkers !== 1) || values.size !== names.length) {
    const missing = names.filter((name) => !values.has(name));
    fail(`arguments do not have the exact ${mode} shape${missing.length ? `; missing ${missing.join(", ")}` : ""}`);
  }
  return Object.freeze(Object.fromEntries(values));
}

function privateRoot() {
  const configured = bounded(process.env.RUNNER_TEMP, "RUNNER_TEMP", 4_096);
  const root = realpathSync(configured);
  const info = statSync(root);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || (typeof process.getuid === "function" && info.uid !== process.getuid())) fail("RUNNER_TEMP must be a private owned directory");
  return root;
}

function runnerEvidence() {
  const cgroup = readFileSync("/proc/self/cgroup", "utf8");
  const controllers = readFileSync("/sys/fs/cgroup/cgroup.controllers", "utf8");
  if (!cgroup.includes("0::") || !controllers.trim()) fail("the release runner is not using a readable unified cgroup v2 hierarchy");
  const kernelRelease = bounded(release(), "kernel release");
  return Object.freeze({
    name: bounded(process.env.RUNNER_NAME ?? "local-designated-runner", "runner name"),
    os: bounded(platform(), "runner OS", 64),
    arch: bounded(arch(), "runner architecture", 64),
    kernelRelease,
    cgroupIdentitySha256: digest(canonical({ cgroup, controllers, kernelRelease }))
  });
}

function writePrivate(path, text, root) {
  if (!isAbsolute(path) || resolve(path) !== path || !within(root, path) || realpathSync(dirname(path)) !== dirname(path)) fail("output must be a canonical path under RUNNER_TEMP");
  const bytes = Buffer.from(text, "utf8"); let fd; let created = false;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    let offset = 0;
    while (offset < bytes.length) { const written = writeSync(fd, bytes, offset, bytes.length - offset, offset); if (written <= 0) fail("output write made no progress"); offset += written; }
    fsyncSync(fd); closeSync(fd); fd = undefined;
    const parentFd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (created) { try { unlinkSync(path); } catch {} }
    throw error;
  }
}

function readPrivateJson(path, root) {
  if (!isAbsolute(path) || resolve(path) !== path || !within(root, path) || realpathSync(dirname(path)) !== dirname(path)) fail("receipt input must be a canonical path under RUNNER_TEMP");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || (before.mode & 0o77n) !== 0n || (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid()))) fail("receipt input must be a private owned singly-linked regular file");
    if (before.size <= 0n || before.size > 4_096n) fail("receipt input is empty or oversized");
    const bytes = readFileSync(fd);
    const text = bytes.toString("utf8");
    if (Buffer.from(text, "utf8").length !== bytes.length || text.includes("\0")) fail("receipt input must be valid NUL-free UTF-8");
    const after = fstatSync(fd, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail("receipt input changed while it was read");
    const parsed = JSON.parse(text);
    if (`${canonical(parsed)}\n` !== text) fail("receipt input is not canonical");
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) fail("receipt input is not JSON");
    throw error;
  } finally {
    closeSync(fd);
  }
}

function validateReceiptRecord(value, adapterId, commitSha) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`${adapterId} receipt is not an exact object`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["adapterId", "commitSha", "receiptDigest", "schemaVersion"].sort())) fail(`${adapterId} receipt has unknown or missing fields`);
  if (value.schemaVersion !== 1 || value.adapterId !== adapterId || value.commitSha !== commitSha || typeof value.receiptDigest !== "string" || !SHA.test(value.receiptDigest)) fail(`${adapterId} receipt is invalid or belongs to another checkout`);
  return Object.freeze({ schemaVersion: 1, adapterId, commitSha, receiptDigest: value.receiptDigest });
}

function validateRunner(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail("runner is not an exact object");
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["name", "os", "arch", "kernelRelease", "cgroupIdentitySha256"].sort())) fail("runner has unknown or missing fields");
  const runner = Object.freeze({
    name: bounded(value.name, "runner.name", 256),
    os: bounded(value.os, "runner.os", 64),
    arch: bounded(value.arch, "runner.arch", 64),
    kernelRelease: bounded(value.kernelRelease, "runner.kernelRelease", 256),
    cgroupIdentitySha256: bounded(value.cgroupIdentitySha256, "runner.cgroupIdentitySha256", 64)
  });
  if (runner.os !== "linux") fail("runner.os must be linux for cgroup-backed adapter evidence");
  if (!SHA.test(runner.cgroupIdentitySha256)) fail("runner.cgroupIdentitySha256 is malformed");
  return runner;
}

export function createNativeAdapterReceiptBundle(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype || JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(["commitSha", "runner", "receipts"].sort())) fail("bundle input has unknown or missing fields");
  if (!COMMIT.test(input.commitSha)) fail("commit SHA is malformed");
  const runner = validateRunner(input.runner);
  if (!input.receipts || typeof input.receipts !== "object" || Array.isArray(input.receipts) || Object.getPrototypeOf(input.receipts) !== Object.prototype || JSON.stringify(Object.keys(input.receipts).sort()) !== JSON.stringify([...IDS].sort())) fail("receipts have unknown or missing adapters");
  const receipts = Object.freeze(Object.fromEntries(IDS.map((id) => {
    const receipt = validateReceiptRecord(input.receipts[id], id, input.commitSha);
    return [id, receipt.receiptDigest];
  })));
  if (new Set(Object.values(receipts)).size !== IDS.length) fail("adapter receipt digests must be distinct");
  const payload = Object.freeze({ schemaVersion: 1, commitSha: input.commitSha, runner, receipts });
  return Object.freeze({ ...payload, receiptDigest: digest(canonical(payload)) });
}

function assertCheckout(commitSha) {
  if (!COMMIT.test(commitSha)) fail("commit SHA is malformed");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== commitSha) fail("explicit commit SHA does not equal the checked-out HEAD");
}

export function extractReceiptFromEvidence(args) {
  const parsed = exactArguments(args, "extract");
  const root = privateRoot();
  const adapterId = parsed["--adapter"];
  if (!IDS.includes(adapterId)) fail("--adapter must be opencode, pi, or grok");
  const commitSha = parsed["--commit-sha"];
  assertCheckout(commitSha);
  const evidencePath = parsed["--evidence-file"];
  if (!within(root, resolve(evidencePath))) fail(`${adapterId} evidence is outside RUNNER_TEMP`);
  const envelope = readContainedAdapterEvidenceFile(evidencePath, {
    adapterId,
    commitSha,
    jobNonce: parsed["--job-nonce"],
    configurationSha256: containedAdapterProbeConfigurationSha256(adapterId),
    now: new Date(),
    allowedRoot: root
  });
  const receipt = Object.freeze({ schemaVersion: 1, adapterId, commitSha, receiptDigest: envelope.receiptDigest });
  writePrivate(parsed["--receipt-output"], `${canonical(receipt)}\n`, root);
  return receipt;
}

export function bundleFromReceipts(args) {
  const parsed = exactArguments(args, "bundle");
  const root = privateRoot();
  const output = parsed["--output"];
  const commitSha = parsed["--commit-sha"];
  assertCheckout(commitSha);
  const receipts = Object.fromEntries(IDS.map((adapterId) => [
    adapterId,
    validateReceiptRecord(readPrivateJson(parsed[`--${adapterId}-receipt`], root), adapterId, commitSha)
  ]));
  const bundle = createNativeAdapterReceiptBundle({ commitSha, runner: runnerEvidence(), receipts });
  writePrivate(output, `${canonical(bundle)}\n`, root);
  return bundle;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const args = process.argv.slice(2);
    if (args.includes("--extract")) extractReceiptFromEvidence(args);
    else bundleFromReceipts(args);
    console.log(JSON.stringify({ status: "written" }));
  }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}

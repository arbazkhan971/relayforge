#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdtempSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RELEASE_SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TYPESCRIPT_CLI = resolve(RELEASE_SCRIPT_ROOT, "node_modules", "typescript", "bin", "tsc");
const NODE_TYPE_ROOT = resolve(RELEASE_SCRIPT_ROOT, "node_modules", "@types");

export const RELEASE_ARTIFACT_LIMITS = Object.freeze({
  maximumFiles: 5_000,
  maximumTarballBytes: 25 * 1024 * 1024,
  maximumUnpackedBytes: 75 * 1024 * 1024,
  commandTimeoutMs: 120_000,
  /** Consumer install must compile native deps (better-sqlite3); keep bounded but longer than generic commands. */
  installTimeoutMs: 600_000
});
export class ReleaseArtifactError extends Error { constructor(code, message) { super(`${code}: ${message}`); this.name = "ReleaseArtifactError"; this.code = code; } }

export function releaseGateEvidence(env = process.env, artifactSmoke = true) {
  const status = (name) => env[name] === "passed" ? "passed" : "not_proven";
  return Object.freeze({
    sourceValidation: status("RELAYFORGE_RELEASE_SOURCE_GATE"),
    verifierCgroup: status("RELAYFORGE_RELEASE_CGROUP_GATE"),
    artifactSmoke: artifactSmoke ? "passed" : "not_run"
  });
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const ADAPTER_RECEIPT_IDS = Object.freeze(["opencode", "pi", "grok"]);

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  throw new ReleaseArtifactError("ADAPTER_RECEIPTS_INVALID", "receipt bundle contains a non-canonical value");
}

function exactObject(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new ReleaseArtifactError("ADAPTER_RECEIPTS_INVALID", `${name} is not a plain object`);
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new ReleaseArtifactError("ADAPTER_RECEIPTS_INVALID", `${name} does not have its exact v1 fields`);
  return value;
}

function bounded(value, name, maximum = 256) {
  if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f]/u.test(value) || Buffer.byteLength(value) > maximum) throw new ReleaseArtifactError("ADAPTER_RECEIPTS_INVALID", `${name} is not a bounded string`);
  return value;
}

function digest(value, name) {
  const result = bounded(value, name, 64);
  if (!SHA256_PATTERN.test(result)) throw new ReleaseArtifactError("ADAPTER_RECEIPTS_INVALID", `${name} is not a SHA-256 digest`);
  return result;
}

export function validateNativeAdapterReceiptBundle(value, expectedCommit) {
  const bundle = exactObject(value, ["schemaVersion", "commitSha", "runner", "receipts", "receiptDigest"], "receipt bundle");
  if (bundle.schemaVersion !== 1) throw new ReleaseArtifactError("ADAPTER_RECEIPTS_INVALID", "receipt bundle schemaVersion is unsupported");
  if (typeof bundle.commitSha !== "string" || !COMMIT_PATTERN.test(bundle.commitSha) || bundle.commitSha !== expectedCommit) throw new ReleaseArtifactError("ADAPTER_RECEIPTS_INVALID", "receipt bundle does not bind exact HEAD");
  const runner = exactObject(bundle.runner, ["name", "os", "arch", "kernelRelease", "cgroupIdentitySha256"], "receipt runner");
  const parsedRunner = Object.freeze({
    name: bounded(runner.name, "runner.name", 256),
    os: bounded(runner.os, "runner.os", 64),
    arch: bounded(runner.arch, "runner.arch", 64),
    kernelRelease: bounded(runner.kernelRelease, "runner.kernelRelease", 256),
    cgroupIdentitySha256: digest(runner.cgroupIdentitySha256, "runner.cgroupIdentitySha256")
  });
  if (parsedRunner.os !== "linux") throw new ReleaseArtifactError("ADAPTER_RECEIPTS_INVALID", "receipt runner must be Linux for cgroup-backed adapter evidence");
  const receipts = exactObject(bundle.receipts, ADAPTER_RECEIPT_IDS, "adapter receipts");
  const parsedReceipts = Object.freeze(Object.fromEntries(ADAPTER_RECEIPT_IDS.map((adapterId) => [adapterId, digest(receipts[adapterId], `receipts.${adapterId}`)])));
  if (new Set(Object.values(parsedReceipts)).size !== ADAPTER_RECEIPT_IDS.length) throw new ReleaseArtifactError("ADAPTER_RECEIPTS_INVALID", "adapter receipts must be distinct");
  const recordedDigest = digest(bundle.receiptDigest, "receiptDigest");
  const expectedDigest = createHash("sha256").update(canonicalJson({ schemaVersion: 1, commitSha: bundle.commitSha, runner: parsedRunner, receipts: parsedReceipts })).digest("hex");
  if (recordedDigest !== expectedDigest) throw new ReleaseArtifactError("ADAPTER_RECEIPTS_INVALID", "receipt bundle digest mismatch");
  return Object.freeze({ schemaVersion: 1, commitSha: bundle.commitSha, runner: parsedRunner, receipts: parsedReceipts, receiptDigest: recordedDigest });
}

export function readNativeAdapterReceiptBundle(path, expectedCommit) {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0") || Buffer.byteLength(path) > 4_096) throw new ReleaseArtifactError("ADAPTER_RECEIPTS_INVALID", "receipt bundle path must be absolute");
  if (resolve(path) !== path || lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) throw new ReleaseArtifactError("ADAPTER_RECEIPTS_INVALID", "receipt bundle path must be canonical and must not be a symlink");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true }); const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || (typeof process.getuid === "function" && info.uid !== process.getuid())) throw new ReleaseArtifactError("ADAPTER_RECEIPTS_INVALID", "receipt bundle must be a private owned 0600 regular file");
    if (info.size > 64 * 1024) throw new ReleaseArtifactError("ADAPTER_RECEIPTS_INVALID", "receipt bundle is over its byte bound");
    const bytes = Buffer.alloc(info.size); let offset = 0;
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (count <= 0) throw new ReleaseArtifactError("ADAPTER_RECEIPTS_INVALID", "receipt bundle was truncated while reading"); offset += count; }
    const after = fstatSync(fd, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new ReleaseArtifactError("ADAPTER_RECEIPTS_INVALID", "receipt bundle identity changed while reading");
    const text = bytes.toString("utf8"); if (Buffer.from(text, "utf8").length !== bytes.length || text.includes("\0")) throw new ReleaseArtifactError("ADAPTER_RECEIPTS_INVALID", "receipt bundle must be valid NUL-free UTF-8");
    let parsed; try { parsed = JSON.parse(text); } catch { throw new ReleaseArtifactError("ADAPTER_RECEIPTS_INVALID", "receipt bundle is not JSON"); }
    if (`${canonicalJson(parsed)}\n` !== text) throw new ReleaseArtifactError("ADAPTER_RECEIPTS_INVALID", "receipt bundle is not canonical");
    return validateNativeAdapterReceiptBundle(parsed, expectedCommit);
  } finally { closeSync(fd); }
}

const allowedExact = new Set(["package.json", "README.md", "LICENSE", "CHANGELOG.md"]);
const allowedRoots = ["assets/", "dist/", "docs/", "examples/"];
const forbidden = /(?:^|\/)(?:src|tests?|scripts|\.git|\.github|\.loop|\.workflow|node_modules)(?:\/|$)|(?:^|\/)(?:\.env(?:\.|$)|.*\.(?:pem|key|p12|log|tsbuildinfo))$/iu;

export function validatePackedFileList(files, packageDocument) {
  if (!Array.isArray(files) || files.length < 1 || files.length > RELEASE_ARTIFACT_LIMITS.maximumFiles) throw new ReleaseArtifactError("FILE_MANIFEST_INVALID", "packed file list is empty or over bound");
  const seen = new Set(); let unpackedBytes = 0;
  for (const item of files) {
    if (!item || typeof item.path !== "string" || !Number.isSafeInteger(item.size) || item.size < 0 || item.path.startsWith("/") || item.path.includes("\\") || item.path.split("/").some((part) => part === "" || part === "." || part === "..")) throw new ReleaseArtifactError("FILE_MANIFEST_INVALID", "packed file entry is not canonical");
    if (seen.has(item.path)) throw new ReleaseArtifactError("FILE_MANIFEST_INVALID", `duplicate packed path ${item.path}`); seen.add(item.path); unpackedBytes += item.size;
    if (forbidden.test(item.path) || (!allowedExact.has(item.path) && !allowedRoots.some((root) => item.path.startsWith(root)))) throw new ReleaseArtifactError("UNEXPECTED_PACKED_FILE", `packed path is outside the allowlist: ${item.path}`);
  }
  if (unpackedBytes > RELEASE_ARTIFACT_LIMITS.maximumUnpackedBytes) throw new ReleaseArtifactError("ARTIFACT_TOO_LARGE", "unpacked artifact exceeds its byte bound");
  for (const required of ["package.json", "README.md", "CHANGELOG.md", "LICENSE", "dist/index.js", "dist/index.d.ts", "dist/cli.js"]) if (!seen.has(required)) throw new ReleaseArtifactError("PACKED_FILE_MISSING", `required packed file is absent: ${required}`);
  if (!packageDocument?.bin?.relayforge || !packageDocument?.bin?.loop || !packageDocument?.bin?.["loop-orchestrator"]) throw new ReleaseArtifactError("BINARY_ALIAS_MISSING", "canonical and legacy binary aliases are required");
  if (new Set(Object.values(packageDocument.bin)).size !== 1) throw new ReleaseArtifactError("BINARY_ALIAS_DIVERGED", "all binary aliases must execute the same entry point");
  return Object.freeze({ files: Object.freeze([...files].sort((a, b) => a.path.localeCompare(b.path)).map((item) => Object.freeze({ path: item.path, size: item.size }))), unpackedBytes });
}

function markdownLinkTarget(raw, documentPath, offset) {
  const trimmed = raw.trim();
  const target = trimmed.startsWith("<")
    ? trimmed.slice(1, trimmed.indexOf(">"))
    : trimmed.split(/[ \t]/u, 1)[0];
  if (!target) throw new ReleaseArtifactError("PACKED_LINK_INVALID", `${documentPath}:${offset} has an empty Markdown link target`);
  return target;
}

/**
 * Prove that every relative link shipped in README/docs resolves to another file in the exact npm
 * manifest. Links to source-only `.workflow`, `src`, tests, ROADMAP, or host paths therefore fail
 * the artifact build instead of becoming broken documentation after install.
 */
export function validatePackedMarkdownLinks(repositoryRoot, files) {
  const root = realpathSync(repositoryRoot);
  const packed = new Set(files.map((item) => item.path));
  const documents = [...packed].filter((path) => (path === "README.md" || path.startsWith("docs/")) && path.endsWith(".md")).sort();
  let checked = 0;
  for (const documentPath of documents) {
    const documentFile = resolve(root, ...documentPath.split("/"));
    const text = readFileSync(documentFile, "utf8");
    const targets = [];
    const inline = /!?\[[^\]\n]*\]\(([^)\n]+)\)/gu;
    for (const match of text.matchAll(inline)) targets.push({ raw: match[1], offset: match.index ?? 0 });
    const reference = /^\s{0,3}\[[^\]\n]+\]:\s*(<[^>\n]+>|\S+)/gmu;
    for (const match of text.matchAll(reference)) targets.push({ raw: match[1], offset: match.index ?? 0 });
    for (const { raw, offset } of targets) {
      const original = markdownLinkTarget(raw, documentPath, offset);
      if (original.startsWith("#") || /^(?:https?:|mailto:)/iu.test(original)) continue;
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(original)) {
        throw new ReleaseArtifactError("PACKED_LINK_INVALID", `${documentPath}:${offset} uses unsupported Markdown link scheme ${JSON.stringify(original)}`);
      }
      let decoded;
      try {
        decoded = decodeURIComponent(original.split("#", 1)[0].split("?", 1)[0]);
      } catch {
        throw new ReleaseArtifactError("PACKED_LINK_INVALID", `${documentPath}:${offset} has invalid percent encoding`);
      }
      if (!decoded) continue;
      if (decoded.startsWith("/") || decoded.includes("\\") || /[\u0000-\u001f\u007f]/u.test(decoded)) {
        throw new ReleaseArtifactError("PACKED_LINK_INVALID", `${documentPath}:${offset} has a non-relative or non-canonical target ${JSON.stringify(original)}`);
      }
      const base = posix.dirname(documentPath);
      const resolved = posix.normalize(posix.join(base, decoded));
      if (resolved === ".." || resolved.startsWith("../") || posix.isAbsolute(resolved)) {
        throw new ReleaseArtifactError("PACKED_LINK_INVALID", `${documentPath}:${offset} escapes the packed package: ${JSON.stringify(original)}`);
      }
      const canonicalTarget = posix.relative(base, resolved) || posix.basename(resolved);
      if (decoded !== canonicalTarget) {
        throw new ReleaseArtifactError("PACKED_LINK_INVALID", `${documentPath}:${offset} is not a canonical relative target: ${JSON.stringify(original)}`);
      }
      if (!packed.has(resolved)) {
        throw new ReleaseArtifactError("PACKED_LINK_MISSING", `${documentPath}:${offset} targets unpacked or missing file ${JSON.stringify(resolved)}`);
      }
      checked += 1;
    }
  }
  return Object.freeze({ documents: documents.length, checked });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: RELEASE_ARTIFACT_LIMITS.commandTimeoutMs, maxBuffer: 2 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new ReleaseArtifactError("COMMAND_FAILED", `${command} ${args.join(" ")} failed: ${(result.stderr ?? result.stdout ?? "").slice(0, 2_000)}`);
  return result.stdout ?? "";
}
function sha256(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function parsePackJson(output) { try { const parsed = JSON.parse(output); if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error("shape"); return parsed[0]; } catch { throw new ReleaseArtifactError("PACK_OUTPUT_INVALID", "npm pack did not return one JSON artifact"); } }
function packageVersion(prefix, packageName) { return JSON.parse(readFileSync(resolve(prefix, "node_modules", packageName, "package.json"), "utf8")).version; }
function executable(prefix, name) { const path = resolve(prefix, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name); if (!existsSync(path)) throw new ReleaseArtifactError("BINARY_ALIAS_MISSING", `installed binary ${name} is absent`); return path; }
function commandResult(command, args, cwd, env = process.env, timeoutMs = RELEASE_ARTIFACT_LIMITS.commandTimeoutMs) {
  return spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 });
}
function commandResultAsync(command, args, cwd, env = process.env, timeoutMs = RELEASE_ARTIFACT_LIMITS.commandTimeoutMs) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let settled = false;
    let timedOut = false;
    const finish = (status, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({
        status,
        signal,
        stdout: Buffer.concat(chunks.stdout, sizes.stdout).toString("utf8"),
        stderr: Buffer.concat(chunks.stderr, sizes.stderr).toString("utf8"),
        ...(error === undefined ? {} : { error })
      });
    };
    const collect = (stream) => (chunk) => {
      const bytes = Buffer.from(chunk);
      if (sizes[stream] + bytes.length > 2 * 1024 * 1024) {
        child.kill("SIGKILL");
        finish(null, "SIGKILL", new Error(`${stream} exceeded the release command output bound`));
        return;
      }
      chunks[stream].push(bytes);
      sizes[stream] += bytes.length;
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    child.once("error", (error) => finish(null, null, error));
    child.once("close", (status, signal) => finish(status, signal, timedOut ? new Error("release command timed out") : undefined));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
  });
}
function assertOk(result, what) {
  if (result.status === 0) return;
  const output = [result.stderr, result.stdout]
    .filter((value) => typeof value === "string" && value.length > 0)
    .join("\n")
    .slice(0, 2_000);
  throw new ReleaseArtifactError("SMOKE_FAILED", `${what} exited ${result.status}: ${output}`);
}

/**
 * Clean consumer installs must run dependency lifecycle scripts so better-sqlite3's
 * native binding materializes. `--ignore-scripts` is only acceptable for pack
 * determinism, never for exact-tarball or exact-registry consumer install.
 */
export function assertInstalledBetterSqlite3NativeBinding(prefix) {
  if (typeof prefix !== "string" || !prefix || prefix.includes("\0")) {
    throw new ReleaseArtifactError("NATIVE_BINDING_MISSING", "install prefix is not a usable path");
  }
  const bindingPath = resolve(prefix, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
  let info;
  try {
    info = statSync(bindingPath);
  } catch {
    throw new ReleaseArtifactError("NATIVE_BINDING_MISSING", "clean consumer install did not materialize better-sqlite3 native bindings");
  }
  if (!info.isFile() || info.size < 1) {
    throw new ReleaseArtifactError("NATIVE_BINDING_MISSING", "better-sqlite3 native binding is not a non-empty regular file");
  }
  return bindingPath;
}

/**
 * Prove the binding is loadable through the packed package's dependency graph
 * (control-service path), not merely that a `.d.ts` or empty tree exists.
 */
export function proveBetterSqlite3NativeLoad(prefix, packageName) {
  const bindingPath = assertInstalledBetterSqlite3NativeBinding(prefix);
  const packageRoot = resolve(prefix, "node_modules", packageName);
  if (!existsSync(resolve(packageRoot, "package.json"))) {
    throw new ReleaseArtifactError("NATIVE_BINDING_MISSING", "packed package is absent under the clean install prefix");
  }
  const probe = resolve(prefix, "native-binding-probe.mjs");
  writeFileSync(probe, `import { createRequire } from "node:module";
import { join } from "node:path";
const require = createRequire(${JSON.stringify(join(packageRoot, "package.json"))});
const Database = require("better-sqlite3");
if (typeof Database !== "function") process.exit(3);
const db = new Database(":memory:");
try {
  const row = db.prepare("select 1 as ok").get();
  if (!row || row.ok !== 1) process.exit(4);
} finally {
  db.close();
}
`);
  assertOk(commandResult(process.execPath, [probe], prefix), "better-sqlite3 native binding load through packed package");
  return Object.freeze({ bindingPath, loaded: true });
}

/** Exact consumer install of a local tarball or registry version: scripts on, no audit/fund, exact prefix. */
function consumerInstall(prefix, packageSpec) {
  // Do not pass --ignore-scripts: better-sqlite3 (and any future native dep) must compile.
  run("npm", ["install", "--no-audit", "--no-fund", "--prefix", prefix, packageSpec], {
    timeout: RELEASE_ARTIFACT_LIMITS.installTimeoutMs
  });
}

async function freePort() { return await new Promise((resolvePromise, reject) => { const server = createServer(); server.once("error", reject); server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => { const address = server.address(); if (!address || typeof address === "string") return reject(new Error("address")); const port = address.port; server.close((error) => error ? reject(error) : resolvePromise(port)); }); }); }
async function poll(fn, timeoutMs = 10_000) { const deadline = Date.now() + timeoutMs; let last; while (Date.now() < deadline) { try { const value = fn(); if (value.status === 0) return value; last = value; } catch (error) { last = error; } await new Promise((resolvePromise) => setTimeout(resolvePromise, 100)); } throw new ReleaseArtifactError("SMOKE_FAILED", `bounded poll did not converge: ${String(last)}`); }

export async function smokeInstalledPackage({ prefix, packageName, version, deep = true }) {
  if (packageVersion(prefix, packageName) !== version) throw new ReleaseArtifactError("INSTALL_VERSION_MISMATCH", "clean prefix installed a different version");
  const binaries = ["relayforge", "loop", "loop-orchestrator"];
  const versions = [];
  for (const name of binaries) { const bin = executable(prefix, name); const result = commandResult(bin, ["--version"], prefix); assertOk(result, `${name} --version`); versions.push((result.stdout ?? "").trim()); const help = commandResult(bin, ["--help"], prefix); assertOk(help, `${name} --help`); }
  if (new Set(versions).size !== 1 || versions[0] !== version) throw new ReleaseArtifactError("BINARY_ALIAS_DIVERGED", "binary aliases report different versions");
  const probe = resolve(prefix, "probe.mjs"); writeFileSync(probe, `import * as api from ${JSON.stringify(packageName)}; if (!api || Object.keys(api).length < 1) process.exit(2);\n`); assertOk(commandResult(process.execPath, [probe], prefix), "public ESM import");
  const typeProbe = resolve(prefix, "consumer.ts");
  writeFileSync(typeProbe, `import { relayForgeIdentity, getShippedAdapterDescriptor, parseControlStatus, buildMultiRepositoryControlView, parsePublicObservation, createControlRoomClient, STEERING_SCHEMA_VERSION, createSteeringCommandId, deriveSteeringActivity, renderSteeringBlock } from ${JSON.stringify(packageName)};
import type { RootConfig, AdapterDescriptor, MultiRepositoryControlView, SteeringProjection } from ${JSON.stringify(packageName)};
const identity: string = relayForgeIdentity.product;
const config = null as unknown as RootConfig;
const descriptor = null as unknown as AdapterDescriptor;
const view = null as unknown as MultiRepositoryControlView;
const steeringVersion: typeof STEERING_SCHEMA_VERSION = STEERING_SCHEMA_VERSION;
const projection = null as unknown as SteeringProjection;
void [identity, config, descriptor, view, steeringVersion, projection, getShippedAdapterDescriptor, parseControlStatus, buildMultiRepositoryControlView, parsePublicObservation, createControlRoomClient, createSteeringCommandId, deriveSteeringActivity, renderSteeringBlock];
`);
  const typeConfig = resolve(prefix, "tsconfig.consumer.json");
  writeFileSync(typeConfig, `${JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      types: ["node"],
      typeRoots: [NODE_TYPE_ROOT]
    },
    files: [typeProbe]
  }, null, 2)}\n`);
  assertOk(commandResult(process.execPath, [TYPESCRIPT_CLI, "-p", typeConfig], prefix), "clean external TypeScript consumer");
  const forbiddenTypeProbe = resolve(prefix, "forbidden-consumer.ts");
  writeFileSync(forbiddenTypeProbe, `import { runAutonomyLoop, openControlStore, createParentSteeringService, createParentScmProductAuthority } from ${JSON.stringify(packageName)};\nvoid [runAutonomyLoop, openControlStore, createParentSteeringService, createParentScmProductAuthority];\n`);
  const forbiddenTypeConfig = resolve(prefix, "tsconfig.forbidden-consumer.json");
  writeFileSync(forbiddenTypeConfig, `${JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      types: ["node"],
      typeRoots: [NODE_TYPE_ROOT]
    },
    files: [forbiddenTypeProbe]
  }, null, 2)}\n`);
  const forbiddenTypeResult = commandResult(process.execPath, [TYPESCRIPT_CLI, "-p", forbiddenTypeConfig], prefix);
  if (forbiddenTypeResult.status === 0 || !`${forbiddenTypeResult.stdout ?? ""}\n${forbiddenTypeResult.stderr ?? ""}`.includes("has no exported member")) {
    throw new ReleaseArtifactError("CLOSED_EXPORTS_BROKEN", "authority-bearing root names compiled from the clean installed package");
  }
  const forbiddenProbe = resolve(prefix, "forbidden.mjs"); writeFileSync(forbiddenProbe, `import ${JSON.stringify(`${packageName}/settlement-kernel`)};\n`); const forbiddenResult = commandResult(process.execPath, [forbiddenProbe], prefix); if (forbiddenResult.status === 0) throw new ReleaseArtifactError("CLOSED_EXPORTS_BROKEN", "sensitive internal subpath imported from the package");
  const installedRoot = realpathSync(resolve(prefix, "node_modules", packageName)); if (!existsSync(resolve(installedRoot, "dist", "index.d.ts"))) throw new ReleaseArtifactError("TYPES_MISSING", "public declaration entry is missing");
  if (!deep) return Object.freeze({ binaries: Object.freeze(binaries), version, publicImport: true, publicTypes: true, closedExports: true, deep: false });

  // Deep smoke requires a real clean consumer install: native binding on disk and loadable
  // through the packed package dependency graph before control-service is exercised.
  const native = proveBetterSqlite3NativeLoad(prefix, packageName);

  const project = realpathSync(mkdtempSync(join(tmpdir(), "relayforge-packed-smoke-")));
  const legacyProject = realpathSync(mkdtempSync(join(tmpdir(), "relayforge-packed-legacy-")));
  let service;
  let serviceExit;
  try {
    run("git", ["init", "-q"], { cwd: project }); run("git", ["config", "user.name", "RelayForge Artifact"], { cwd: project }); run("git", ["config", "user.email", "artifact@example.invalid"], { cwd: project });
    const relayforge = executable(prefix, "relayforge"); assertOk(commandResult(relayforge, ["init", "--provider", "custom"], project), "relayforge init");
    if (!existsSync(resolve(project, "relayforge.config.yaml"))) throw new ReleaseArtifactError("SMOKE_FAILED", "canonical init did not create relayforge.config.yaml");
    run("git", ["add", "-A"], { cwd: project }); run("git", ["commit", "-qm", "artifact baseline"], { cwd: project }); const head = run("git", ["rev-parse", "HEAD"], { cwd: project }).trim();
    const dry = commandResult(relayforge, ["run", "Artifact smoke", "--run", "artifactdry", "--json"], project); assertOk(dry, "packed dry run"); const dryJson = JSON.parse(dry.stdout || "null"); if (dryJson?.status !== "planned") throw new ReleaseArtifactError("SMOKE_FAILED", "packed dry run did not reach planned");
    if (run("git", ["status", "--porcelain"], { cwd: project }).trim() || run("git", ["rev-parse", "HEAD"], { cwd: project }).trim() !== head) throw new ReleaseArtifactError("SMOKE_FAILED", "packed smoke changed the checkout");
    const port = await freePort(); service = spawn(relayforge, ["serve", "--port", String(port)], { cwd: project, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    serviceExit = new Promise((resolveExit) => service.once("exit", (code, signal) => resolveExit({ code, signal })));
    await poll(() => commandResult(relayforge, ["serve", "status", "--json", "--timeout", "1000"], project));
    // This must be asynchronous: the service is our direct child, and blocking this
    // process in spawnSync prevents libuv from reaping it. The stop client would then
    // truthfully observe a zombie until its deadline and report a false timeout.
    const stopped = await commandResultAsync(
      relayforge,
      ["serve", "stop", "--json", "--timeout", "7000"],
      project,
      process.env,
      12_000
    );
    assertOk(stopped, "packed control-service stop");
    await new Promise((resolveExit, rejectExit) => {
      const timer = setTimeout(
        () => rejectExit(new ReleaseArtifactError("SMOKE_FAILED", "packed control service did not exit after stop")),
        10_000
      );
      serviceExit.then((result) => { clearTimeout(timer); resolveExit(result); }, rejectExit);
    }); service = undefined;

    run("git", ["init", "-q"], { cwd: legacyProject });
    run("git", ["config", "user.name", "RelayForge Legacy Artifact"], { cwd: legacyProject });
    run("git", ["config", "user.email", "legacy-artifact@example.invalid"], { cwd: legacyProject });
    assertOk(commandResult(relayforge, ["init", "--provider", "custom"], legacyProject), "legacy smoke seed init");
    const canonicalConfig = resolve(legacyProject, "relayforge.config.yaml");
    const legacyConfig = resolve(legacyProject, "loop.config.yaml");
    writeFileSync(legacyConfig, readFileSync(canonicalConfig));
    unlinkSync(canonicalConfig);
    // Current init may already create the private state directory. The legacy
    // fixture needs that same directory to pre-exist, not a second create.
    mkdirSync(resolve(legacyProject, ".loop"), { mode: 0o700, recursive: true });
    const legacySentinel = resolve(legacyProject, ".loop", "legacy-state-sentinel");
    writeFileSync(legacySentinel, "adopt-in-place\n", { mode: 0o600 });
    run("git", ["add", "-A"], { cwd: legacyProject });
    run("git", ["commit", "-qm", "legacy artifact baseline"], { cwd: legacyProject });
    const legacyHead = run("git", ["rev-parse", "HEAD"], { cwd: legacyProject }).trim();
    const legacyDry = commandResult(executable(prefix, "loop"), ["run", "Legacy artifact smoke", "--run", "legacydry", "--json"], legacyProject);
    assertOk(legacyDry, "legacy config/state adoption dry run");
    const legacyJson = JSON.parse(legacyDry.stdout || "null");
    if (legacyJson?.status !== "planned") throw new ReleaseArtifactError("SMOKE_FAILED", "legacy config dry run did not reach planned");
    if (existsSync(canonicalConfig) || readFileSync(legacySentinel, "utf8") !== "adopt-in-place\n") {
      throw new ReleaseArtifactError("SMOKE_FAILED", "legacy config/state was copied, renamed or rewritten");
    }
    if (run("git", ["status", "--porcelain"], { cwd: legacyProject }).trim() || run("git", ["rev-parse", "HEAD"], { cwd: legacyProject }).trim() !== legacyHead) {
      throw new ReleaseArtifactError("SMOKE_FAILED", "legacy config/state adoption changed the checkout");
    }
    return Object.freeze({
      binaries: Object.freeze(binaries),
      version,
      publicImport: true,
      publicTypes: true,
      closedExports: true,
      deep: true,
      nativeBinding: Object.freeze({ path: "node_modules/better-sqlite3/build/Release/better_sqlite3.node", loaded: native.loaded }),
      dryRun: "planned",
      legacyAdoption: "loop.config-and-.loop-in-place",
      controlService: "start-status-stop",
      checkoutUnchanged: true
    });
  } finally {
    if (service?.pid) { try { process.kill(service.pid, "SIGTERM"); } catch {} }
    rmSync(project, { recursive: true, force: true });
    rmSync(legacyProject, { recursive: true, force: true });
  }
}

function referenceAuditDigests(root) {
  const paths = [
    "docs/reference/phase-00-worktree-provisioning-audit.md",
    "docs/reference/phase-00-2-verifier-cgroup-delegation-audit.md",
    ...[1, 2, 3, 4, 5, 6, 7].map((phase) => `docs/reference/phase-${String(phase).padStart(2, "0")}-${["control-plane-audit", "session-steering-audit", "scm-feedback-audit", "adapter-registry-audit", "live-observability-audit", "multi-repository-audit", "release-audit"][phase - 1]}.md`),
    "docs/reference/phase-04-grok-build-addendum.md",
    "docs/reference/phase-04-grok-egress-addendum.md"
  ];
  const missing = paths.filter((path) => !existsSync(resolve(root, path)));
  if (missing.length > 0) throw new ReleaseArtifactError("REFERENCE_AUDIT_MISSING", `release reference audit is absent: ${missing[0]}`);
  return paths.map((path) => ({ path, sha256: sha256(resolve(root, path)) }));
}

export async function buildReleaseArtifact({ repositoryRoot = process.cwd(), outputDirectory = ".release", runSmoke = true, gateEnvironment = process.env, preview = false, nativeAdapterReceiptBundlePath } = {}) {
  const root = realpathSync(repositoryRoot); const packageDocument = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")); const output = resolve(root, outputDirectory); mkdirSync(output, { recursive: true });
  const firstDir = mkdtempSync(join(tmpdir(), "relayforge-pack-one-")); const secondDir = mkdtempSync(join(tmpdir(), "relayforge-pack-two-"));
  try {
    const first = parsePackJson(run("npm", ["pack", "--json", "--pack-destination", firstDir], { cwd: root }));
    const second = parsePackJson(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", secondDir], { cwd: root }));
    const firstPath = resolve(firstDir, first.filename); const secondPath = resolve(secondDir, second.filename); const firstSha = sha256(firstPath); const secondSha = sha256(secondPath);
    if (firstSha !== secondSha || first.integrity !== second.integrity || first.filename !== second.filename) throw new ReleaseArtifactError("NONDETERMINISTIC_PACK", "two consecutive packs differ");
    const validated = validatePackedFileList(first.files, packageDocument);
    validatePackedMarkdownLinks(root, validated.files);
    const tarballStat = statSync(firstPath); if (tarballStat.size > RELEASE_ARTIFACT_LIMITS.maximumTarballBytes) throw new ReleaseArtifactError("ARTIFACT_TOO_LARGE", "tarball exceeds its byte bound");
    const finalPath = resolve(output, first.filename); writeFileSync(finalPath, readFileSync(firstPath), { flag: "w", mode: 0o644 });
    const prefix = mkdtempSync(join(tmpdir(), "relayforge-install-")); let smoke;
    try {
      // Clean consumer install of the exact tarball: run dependency install scripts so
      // better-sqlite3 native bindings materialize. Pack-time --ignore-scripts remains
      // only for the second determinism pack above, never for this install.
      consumerInstall(prefix, finalPath);
      smoke = runSmoke ? await smokeInstalledPackage({ prefix, packageName: packageDocument.name, version: packageDocument.version, deep: true }) : undefined;
    } finally { rmSync(prefix, { recursive: true, force: true }); }
    const commit = run("git", ["rev-parse", "HEAD"], { cwd: root }).trim(); const relativeTarball = relative(root, finalPath).split(sep).join("/");
    if (preview && nativeAdapterReceiptBundlePath !== undefined) throw new ReleaseArtifactError("ADAPTER_RECEIPTS_INVALID", "preview artifacts cannot carry publishable native-adapter evidence");
    if (!preview && nativeAdapterReceiptBundlePath === undefined) throw new ReleaseArtifactError("ADAPTER_RECEIPTS_MISSING", "publishable artifacts require same-runner OpenCode, Pi and Grok receipts");
    const nativeAdapterEvidence = preview
      ? Object.freeze({ status: "not-collected", reason: "pull-request-preview" })
      : Object.freeze({ status: "collected", ...readNativeAdapterReceiptBundle(nativeAdapterReceiptBundlePath, commit) });
    const manifest = Object.freeze({ schemaVersion: 2, publishable: !preview, packageName: packageDocument.name, version: packageDocument.version, commit, createdAt: new Date().toISOString(), nodeVersion: process.version, npmVersion: run("npm", ["--version"], { cwd: root }).trim(), gates: releaseGateEvidence(gateEnvironment, runSmoke), nativeAdapterEvidence, tarball: Object.freeze({ filename: first.filename, path: relativeTarball, sha256: firstSha, shasum: first.shasum, integrity: first.integrity, bytes: tarballStat.size, unpackedBytes: validated.unpackedBytes, files: validated.files }), referenceAudits: Object.freeze(referenceAuditDigests(root)), ...(smoke === undefined ? {} : { smoke }) });
    writeFileSync(resolve(output, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 }); return manifest;
  } finally { rmSync(firstDir, { recursive: true, force: true }); rmSync(secondDir, { recursive: true, force: true }); }
}

export async function verifyRegistryArtifact(manifestPath) {
  const manifest = JSON.parse(readFileSync(resolve(manifestPath), "utf8"));
  const prefix = mkdtempSync(join(tmpdir(), "relayforge-registry-install-"));
  try {
    // Same truthful consumer-install policy as the local tarball path: lifecycle scripts
    // run so native runtime support is available whenever exercised (and for honest install).
    consumerInstall(prefix, `${manifest.packageName}@${manifest.version}`);
    return await smokeInstalledPackage({ prefix, packageName: manifest.packageName, version: manifest.version, deep: false });
  } finally { rmSync(prefix, { recursive: true, force: true }); }
}

async function main(args) { const outputIndex = args.indexOf("--output"); const verifyIndex = args.indexOf("--verify-registry"); if (verifyIndex >= 0) { console.log(JSON.stringify(await verifyRegistryArtifact(args[verifyIndex + 1]))); return; } const receiptIndex = args.indexOf("--native-adapter-receipts"); const outputDirectory = outputIndex >= 0 ? args[outputIndex + 1] : ".release"; console.log(JSON.stringify(await buildReleaseArtifact({ outputDirectory, preview: args.includes("--preview"), ...(receiptIndex < 0 ? {} : { nativeAdapterReceiptBundlePath: args[receiptIndex + 1] }) }), null, 2)); }
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2)).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });

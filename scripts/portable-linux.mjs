#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER_TEMPLATE = resolve(SCRIPT_ROOT, "scripts", "install-portable.sh");

export const PORTABLE_LINUX_CONTRACT = Object.freeze({
  schemaVersion: 1,
  target: "linux-x64-gnu",
  os: "linux",
  architecture: "x64",
  minimumGlibc: "2.35",
  supportedHost: "Ubuntu 22.04 or newer, x86_64",
  nodeVersion: "v22.23.2",
  nodeArchiveFilename: "node-v22.23.2-linux-x64.tar.xz",
  nodeArchiveSha256: "d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307",
  nodeArchiveUrl: "https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz",
  maximumArchiveBytes: 80 * 1024 * 1024,
  commandTimeoutMs: 20 * 60 * 1000
});

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/u;
const SAFE_FILENAME = /^[0-9A-Za-z][0-9A-Za-z._-]{0,255}$/u;

export class PortableArtifactError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "PortableArtifactError";
    this.code = code;
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: PORTABLE_LINUX_CONTRACT.commandTimeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    ...options
  });
  if (result.error || result.status !== 0) {
    const details = [result.error?.message, result.stderr, result.stdout]
      .filter((value) => typeof value === "string" && value.length > 0)
      .join("\n")
      .slice(0, 4_000);
    throw new PortableArtifactError(
      "COMMAND_FAILED",
      `${command} ${args.join(" ")} failed${result.status === null ? "" : ` with ${result.status}`}: ${details}`
    );
  }
  return result.stdout ?? "";
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writePortableChecksums(directory, filenames) {
  const checksums = filenames
    .map((filename) => {
      safeReleaseValue(filename, SAFE_FILENAME, "checksum filename");
      const path = resolve(directory, filename);
      if (!existsSync(path) || !statSync(path).isFile()) {
        throw new PortableArtifactError("PORTABLE_FILE_MISSING", `checksum input is missing: ${filename}`);
      }
      return [sha256File(path), filename];
    })
    .sort((left, right) => left[1].localeCompare(right[1]));
  writeFileSync(resolve(directory, "SHA256SUMS"), `${checksums.map(([digest, filename]) => `${digest}  ${filename}`).join("\n")}\n`, { mode: 0o644 });
}

function safeReleaseValue(value, pattern, name) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new PortableArtifactError("INVALID_RELEASE_VALUE", `${name} is not safe for an artifact or shell literal`);
  }
  return value;
}

export function renderPortableInstaller({ version, archiveFilename, archiveSha256, downloadUrl }) {
  safeReleaseValue(version, SAFE_VERSION, "version");
  safeReleaseValue(archiveFilename, SAFE_FILENAME, "archive filename");
  safeReleaseValue(archiveSha256, SHA256, "archive SHA-256");
  if (typeof downloadUrl !== "string" || !downloadUrl.startsWith("https://github.com/arbazkhan971/relayforge/releases/download/") || /['\r\n]/u.test(downloadUrl)) {
    throw new PortableArtifactError("INVALID_RELEASE_VALUE", "download URL is outside the RelayForge GitHub release path");
  }
  const template = readFileSync(INSTALLER_TEMPLATE, "utf8");
  const rendered = template
    .replace("@@VERSION@@", version)
    .replace("@@ARCHIVE_FILENAME@@", archiveFilename)
    .replace("@@ARCHIVE_SHA256@@", archiveSha256)
    .replace("@@DOWNLOAD_URL@@", downloadUrl);
  if (rendered.includes("@@")) {
    throw new PortableArtifactError("INSTALLER_TEMPLATE_INVALID", "portable installer contains an unrendered token");
  }
  return rendered;
}

export function recordPortableCleanHostSmoke(manifestPath, elapsedSeconds) {
  const requestedPath = resolve(manifestPath);
  const requestedInfo = lstatSync(requestedPath);
  if (!requestedInfo.isFile() || requestedInfo.isSymbolicLink()) {
    throw new PortableArtifactError("PORTABLE_MANIFEST_INVALID", "portable release manifest must be a regular non-symlink file");
  }
  const path = realpathSync(requestedPath);
  if (!Number.isSafeInteger(elapsedSeconds) || elapsedSeconds < 0 || elapsedSeconds >= 120) {
    throw new PortableArtifactError("CLEAN_HOST_SMOKE_INVALID", "clean-host elapsed time must be an integer below 120 seconds");
  }
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.packageName !== "relayforge" || manifest.target !== PORTABLE_LINUX_CONTRACT.target ||
      !SAFE_FILENAME.test(manifest.archive?.filename ?? "") || !SAFE_FILENAME.test(manifest.installer?.filename ?? "") ||
      !SHA256.test(manifest.archive?.sha256 ?? "") || !SHA256.test(manifest.installer?.sha256 ?? "")) {
    throw new PortableArtifactError("PORTABLE_MANIFEST_INVALID", "portable release manifest does not match the v1 Linux x64 contract");
  }
  const directory = dirname(path);
  const archivePath = resolve(directory, manifest.archive.filename);
  const installerPath = resolve(directory, manifest.installer.filename);
  if (sha256File(archivePath) !== manifest.archive.sha256 || sha256File(installerPath) !== manifest.installer.sha256) {
    throw new PortableArtifactError("PORTABLE_ASSET_MISMATCH", "portable assets changed before clean-host evidence was recorded");
  }
  const updated = {
    ...manifest,
    releaseReady: manifest.source?.dirty === false,
    smoke: {
      ...manifest.smoke,
      cleanHost: {
        status: "passed",
        image: "ubuntu:22.04",
        elapsedSeconds,
        maximumSeconds: 120,
        absentBeforeInstall: ["node", "npm", "python3", "cc", "c++", "gcc", "g++", "make"],
        journey: ["install", "relayforge --version", "relayforge setup", "dry-run planned", "dashboard opened"]
      }
    }
  };
  const temporary = `${path}.new-${process.pid}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, { flag: "wx", mode: 0o644 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  writePortableChecksums(directory, [manifest.archive.filename, manifest.installer.filename, basename(path)]);
  return updated;
}

async function downloadExactNodeArchive(destination) {
  const response = await fetch(PORTABLE_LINUX_CONTRACT.nodeArchiveUrl, { redirect: "follow" });
  if (!response.ok) {
    throw new PortableArtifactError("NODE_DOWNLOAD_FAILED", `Node runtime download returned HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1 || bytes.length > PORTABLE_LINUX_CONTRACT.maximumArchiveBytes) {
    throw new PortableArtifactError("NODE_DOWNLOAD_FAILED", "Node runtime archive is empty or over its byte bound");
  }
  writeFileSync(destination, bytes, { mode: 0o644 });
}

async function acquireNodeArchive(cacheDirectory, suppliedArchive) {
  let archive;
  if (suppliedArchive === undefined) {
    archive = resolve(cacheDirectory, PORTABLE_LINUX_CONTRACT.nodeArchiveFilename);
  } else {
    const requestedArchive = resolve(suppliedArchive);
    const requestedInfo = lstatSync(requestedArchive);
    if (!requestedInfo.isFile() || requestedInfo.isSymbolicLink()) {
      throw new PortableArtifactError("NODE_ARCHIVE_INVALID", "supplied Node runtime archive must be a regular non-symlink file");
    }
    archive = realpathSync(requestedArchive);
  }
  if (suppliedArchive === undefined) {
    mkdirSync(cacheDirectory, { recursive: true });
    if (!existsSync(archive)) {
      const partial = `${archive}.partial-${process.pid}`;
      try {
        await downloadExactNodeArchive(partial);
        if (sha256File(partial) !== PORTABLE_LINUX_CONTRACT.nodeArchiveSha256) {
          throw new PortableArtifactError("NODE_ARCHIVE_MISMATCH", "downloaded Node runtime does not match its pinned SHA-256");
        }
        renameSync(partial, archive);
      } finally {
        rmSync(partial, { force: true });
      }
    }
  }
  const info = lstatSync(archive);
  if (!info.isFile() || info.isSymbolicLink() || info.size > PORTABLE_LINUX_CONTRACT.maximumArchiveBytes) {
    throw new PortableArtifactError("NODE_ARCHIVE_INVALID", "Node runtime archive must be a bounded regular non-symlink file");
  }
  if (sha256File(archive) !== PORTABLE_LINUX_CONTRACT.nodeArchiveSha256) {
    throw new PortableArtifactError("NODE_ARCHIVE_MISMATCH", "Node runtime archive does not match its pinned SHA-256");
  }
  return archive;
}

function maximumRequiredGlibc(path) {
  const output = run("readelf", ["--version-info", path]);
  const versions = [...output.matchAll(/GLIBC_(\d+)\.(\d+)/gu)].map((match) => [Number(match[1]), Number(match[2])]);
  if (versions.length < 1) {
    throw new PortableArtifactError("GLIBC_AUDIT_FAILED", `no GLIBC version requirements were found in ${basename(path)}`);
  }
  versions.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  return versions.at(-1).join(".");
}

function versionAtMost(actual, maximum) {
  const [actualMajor, actualMinor] = actual.split(".").map(Number);
  const [maximumMajor, maximumMinor] = maximum.split(".").map(Number);
  return actualMajor < maximumMajor || (actualMajor === maximumMajor && actualMinor <= maximumMinor);
}

export function renderPortableLauncher() {
  return `#!/bin/sh
set -eu
launcher_path=$0
while [ -L "$launcher_path" ]; do
  launcher_dir=$(CDPATH= cd -- "$(dirname -- "$launcher_path")" && pwd -P)
  launcher_target=$(readlink "$launcher_path")
  case "$launcher_target" in
    /*) launcher_path=$launcher_target ;;
    *) launcher_path=$launcher_dir/$launcher_target ;;
  esac
done
self_dir=$(CDPATH= cd -- "$(dirname -- "$launcher_path")" && pwd -P)
bundle_root=$(CDPATH= cd -- "$self_dir/.." && pwd -P)
exec "$bundle_root/runtime/bin/node" "$bundle_root/app/dist/cli.js" "$@"
`;
}

function writeLauncher(path) {
  writeFileSync(path, renderPortableLauncher(), { mode: 0o755 });
}

function canonicalPath(root, path) {
  return relative(root, path).split(sep).join("/");
}

function makeDeterministicArchive(parent, rootName, destination, epoch) {
  const rawTar = `${destination}.tar`;
  try {
    run("tar", [
      "--sort=name",
      `--mtime=@${epoch}`,
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--format=posix",
      "--pax-option=delete=atime,delete=ctime",
      "-cf",
      rawTar,
      "-C",
      parent,
      rootName
    ]);
    run("gzip", ["-n", "-9", "-f", rawTar]);
    renameSync(`${rawTar}.gz`, destination);
  } finally {
    rmSync(rawTar, { force: true });
    rmSync(`${rawTar}.gz`, { force: true });
  }
}

function verifyPortableRuntime(bundleRoot, version) {
  const node = resolve(bundleRoot, "runtime", "bin", "node");
  const cli = resolve(bundleRoot, "app", "dist", "cli.js");
  const binding = resolve(bundleRoot, "app", "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
  for (const path of [node, cli, binding]) {
    if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size < 1) {
      throw new PortableArtifactError("PORTABLE_FILE_MISSING", `required portable file is absent: ${canonicalPath(bundleRoot, path)}`);
    }
  }
  const identity = JSON.parse(run(node, ["-e", "process.stdout.write(JSON.stringify({version:process.version,platform:process.platform,arch:process.arch,modules:process.versions.modules}))"]));
  if (identity.version !== PORTABLE_LINUX_CONTRACT.nodeVersion || identity.platform !== "linux" || identity.arch !== "x64") {
    throw new PortableArtifactError("RUNTIME_IDENTITY_MISMATCH", "bundled Node runtime identity does not match the portable contract");
  }
  const cliVersion = run(node, [cli, "--version"], { cwd: bundleRoot }).trim();
  if (cliVersion !== version) {
    throw new PortableArtifactError("CLI_VERSION_MISMATCH", `portable CLI reported ${JSON.stringify(cliVersion)}`);
  }
  const packageJson = resolve(bundleRoot, "app", "package.json");
  const probe = `const {createRequire}=require("node:module");const r=createRequire(${JSON.stringify(packageJson)});const D=r("better-sqlite3");const db=new D(":memory:");const row=db.prepare("select 1 ok").get();db.close();if(row.ok!==1)process.exit(7);`;
  run(node, ["-e", probe], { cwd: bundleRoot });
  const nodeGlibc = maximumRequiredGlibc(node);
  const nativeGlibc = maximumRequiredGlibc(binding);
  if (!versionAtMost(nodeGlibc, PORTABLE_LINUX_CONTRACT.minimumGlibc) || !versionAtMost(nativeGlibc, PORTABLE_LINUX_CONTRACT.minimumGlibc)) {
    throw new PortableArtifactError(
      "GLIBC_TOO_NEW",
      `runtime requires GLIBC ${nodeGlibc} and native binding requires ${nativeGlibc}; contract maximum is ${PORTABLE_LINUX_CONTRACT.minimumGlibc}`
    );
  }
  return Object.freeze({
    node,
    cli,
    binding,
    nodeIdentity: identity,
    glibc: Object.freeze({ runtimeMaximum: nodeGlibc, nativeMaximum: nativeGlibc })
  });
}

function parseArguments(args) {
  let outputDirectory = ".portable";
  let cacheDirectory = ".portable-cache";
  let nodeArchive;
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!["--output", "--cache", "--node-archive"].includes(name)) {
      throw new PortableArtifactError("ARGUMENT_INVALID", `unknown argument ${JSON.stringify(name)}`);
    }
    if (seen.has(name) || index + 1 >= args.length) {
      throw new PortableArtifactError("ARGUMENT_INVALID", `${name} is duplicated or missing its value`);
    }
    seen.add(name);
    const value = args[index + 1];
    if (!value || value.includes("\0")) throw new PortableArtifactError("ARGUMENT_INVALID", `${name} has an invalid value`);
    if (name === "--output") outputDirectory = value;
    if (name === "--cache") cacheDirectory = value;
    if (name === "--node-archive") nodeArchive = value;
    index += 1;
  }
  return { outputDirectory, cacheDirectory, nodeArchive };
}

export async function buildPortableLinuxArtifact({
  repositoryRoot = process.cwd(),
  outputDirectory = ".portable",
  cacheDirectory = ".portable-cache",
  nodeArchive: suppliedNodeArchive
} = {}) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new PortableArtifactError("BUILDER_PLATFORM_UNSUPPORTED", "portable Linux x64 artifacts must be built on Linux x64");
  }
  const root = realpathSync(resolve(repositoryRoot));
  const packageDocument = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const version = safeReleaseValue(packageDocument.version, SAFE_VERSION, "package version");
  const output = resolve(root, outputDirectory);
  const cache = resolve(root, cacheDirectory);
  mkdirSync(output, { recursive: true });
  const nodeArchive = await acquireNodeArchive(cache, suppliedNodeArchive);
  const work = mkdtempSync(join(tmpdir(), "relayforge-portable-build-"));
  const packDirectory = resolve(work, "pack");
  const nodeDirectory = resolve(work, "node");
  const bundleParent = resolve(work, "bundle");
  mkdirSync(packDirectory, { recursive: true });
  mkdirSync(nodeDirectory, { recursive: true });
  mkdirSync(bundleParent, { recursive: true });
  try {
    run("npm", ["run", "build"], { cwd: root });
    const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", packDirectory], { cwd: root }));
    if (!Array.isArray(packed) || packed.length !== 1 || !SAFE_FILENAME.test(packed[0]?.filename ?? "")) {
      throw new PortableArtifactError("NPM_PACK_INVALID", "npm pack did not produce one safe artifact filename");
    }
    const packageTarball = resolve(packDirectory, packed[0].filename);
    run("tar", ["-xJf", nodeArchive, "-C", nodeDirectory]);
    const extractedNode = resolve(nodeDirectory, `node-${PORTABLE_LINUX_CONTRACT.nodeVersion}-linux-x64`);
    const buildNode = resolve(extractedNode, "bin", "node");
    const npmCli = resolve(extractedNode, "lib", "node_modules", "npm", "bin", "npm-cli.js");
    if (!existsSync(buildNode) || !existsSync(npmCli)) {
      throw new PortableArtifactError("NODE_ARCHIVE_INVALID", "pinned Node archive is missing node or npm");
    }

    const rootName = `relayforge-${version}-linux-x64`;
    const bundleRoot = resolve(bundleParent, rootName);
    const app = resolve(bundleRoot, "app");
    const runtime = resolve(bundleRoot, "runtime");
    mkdirSync(app, { recursive: true });
    mkdirSync(resolve(runtime, "bin"), { recursive: true });
    mkdirSync(resolve(bundleRoot, "bin"), { recursive: true });
    run("tar", ["-xzf", packageTarball, "--strip-components=1", "-C", app]);
    copyFileSync(resolve(root, "package-lock.json"), resolve(app, "package-lock.json"));

    const installEnvironment = {
      ...process.env,
      PATH: `${resolve(extractedNode, "bin")}:${process.env.PATH ?? ""}`,
      npm_config_cache: resolve(cache, "npm"),
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_ignore_scripts: "false",
      npm_config_update_notifier: "false"
    };
    run(buildNode, [npmCli, "ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: app, env: installEnvironment });

    copyFileSync(buildNode, resolve(runtime, "bin", "node"));
    chmodSync(resolve(runtime, "bin", "node"), 0o755);
    for (const document of ["LICENSE", "README.md", "CHANGELOG.md"]) {
      const source = resolve(extractedNode, document);
      if (existsSync(source)) copyFileSync(source, resolve(runtime, document));
    }
    for (const command of ["relayforge", "loop", "loop-orchestrator"]) writeLauncher(resolve(bundleRoot, "bin", command));

    const verified = verifyPortableRuntime(bundleRoot, version);
    const commit = run("git", ["rev-parse", "HEAD"], { cwd: root }).trim();
    const epochText = run("git", ["show", "-s", "--format=%ct", "HEAD"], { cwd: root }).trim();
    const sourceDateEpoch = Number(epochText);
    if (!/^[a-f0-9]{40,64}$/u.test(commit) || !Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch < 1) {
      throw new PortableArtifactError("SOURCE_IDENTITY_INVALID", "git source identity is invalid");
    }
    const dirty = run("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root }).trim().length > 0;
    const manifest = Object.freeze({
      schemaVersion: PORTABLE_LINUX_CONTRACT.schemaVersion,
      product: "relayforge",
      version,
      target: PORTABLE_LINUX_CONTRACT.target,
      architecture: PORTABLE_LINUX_CONTRACT.architecture,
      supportedHost: PORTABLE_LINUX_CONTRACT.supportedHost,
      minimumGlibc: PORTABLE_LINUX_CONTRACT.minimumGlibc,
      source: Object.freeze({ commit, dirty, sourceDateEpoch }),
      node: Object.freeze({
        version: PORTABLE_LINUX_CONTRACT.nodeVersion,
        modules: verified.nodeIdentity.modules,
        upstreamArchive: PORTABLE_LINUX_CONTRACT.nodeArchiveFilename,
        upstreamSha256: PORTABLE_LINUX_CONTRACT.nodeArchiveSha256,
        binarySha256: sha256File(verified.node),
        maximumRequiredGlibc: verified.glibc.runtimeMaximum
      }),
      nativeModules: Object.freeze([Object.freeze({
        name: "better-sqlite3",
        version: JSON.parse(readFileSync(resolve(app, "node_modules", "better-sqlite3", "package.json"), "utf8")).version,
        path: canonicalPath(bundleRoot, verified.binding),
        sha256: sha256File(verified.binding),
        maximumRequiredGlibc: verified.glibc.nativeMaximum
      })]),
      commands: Object.freeze(["relayforge", "loop", "loop-orchestrator"]),
      install: Object.freeze({ rootless: true, requiresNode: false, requiresNpm: false, requiresCompiler: false })
    });
    writeFileSync(resolve(bundleRoot, "portable-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });

    const archiveFilename = `${rootName}.tar.gz`;
    const archivePath = resolve(output, archiveFilename);
    const proofPath = resolve(work, `${archiveFilename}.proof`);
    makeDeterministicArchive(bundleParent, rootName, archivePath, sourceDateEpoch);
    makeDeterministicArchive(bundleParent, rootName, proofPath, sourceDateEpoch);
    const archiveSha256 = sha256File(archivePath);
    if (archiveSha256 !== sha256File(proofPath)) {
      throw new PortableArtifactError("NONDETERMINISTIC_ARCHIVE", "two normalized portable archives differ");
    }
    const archiveBytes = statSync(archivePath).size;
    if (archiveBytes < 1 || archiveBytes > PORTABLE_LINUX_CONTRACT.maximumArchiveBytes) {
      throw new PortableArtifactError("PORTABLE_ARCHIVE_TOO_LARGE", "portable archive is empty or over its byte bound");
    }

    const installerFilename = `install-relayforge-${version}-linux-x64.sh`;
    const installerPath = resolve(output, installerFilename);
    const downloadUrl = `https://github.com/arbazkhan971/relayforge/releases/download/v${version}/${archiveFilename}`;
    writeFileSync(installerPath, renderPortableInstaller({ version, archiveFilename, archiveSha256, downloadUrl }), { mode: 0o755 });
    const installerSha256 = sha256File(installerPath);
    const releaseManifest = Object.freeze({
      schemaVersion: 1,
      publishable: false,
      releaseReady: false,
      publicationRequiresOperatorApproval: true,
      packageName: packageDocument.name,
      version,
      target: PORTABLE_LINUX_CONTRACT.target,
      source: manifest.source,
      reproducibility: Object.freeze({ normalizedArchiveBuiltTwice: true, sourceDateEpoch }),
      archive: Object.freeze({ filename: archiveFilename, sha256: archiveSha256, bytes: archiveBytes }),
      installer: Object.freeze({ filename: installerFilename, sha256: installerSha256, embeddedArchiveSha256: archiveSha256 }),
      smoke: Object.freeze({ bundledNode: true, nativeSqliteLoad: true, cliVersion: true, glibcContract: true, cleanHost: "pending-ci-or-local-smoke" })
    });
    const releaseManifestPath = resolve(output, "portable-release.json");
    writeFileSync(releaseManifestPath, `${JSON.stringify(releaseManifest, null, 2)}\n`, { mode: 0o644 });
    writePortableChecksums(output, [archiveFilename, installerFilename, basename(releaseManifestPath)]);
    return releaseManifest;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function main(args) {
  if (args[0] === "--record-clean-host") {
    if (args.length !== 3 || !/^(?:0|[1-9][0-9]*)$/u.test(args[2] ?? "")) {
      throw new PortableArtifactError("ARGUMENT_INVALID", "--record-clean-host requires MANIFEST and integer ELAPSED_SECONDS");
    }
    const manifest = recordPortableCleanHostSmoke(args[1], Number(args[2]));
    process.stdout.write(`${JSON.stringify(manifest.smoke.cleanHost)}\n`);
    return;
  }
  const options = parseArguments(args);
  const manifest = await buildPortableLinuxArtifact(options);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

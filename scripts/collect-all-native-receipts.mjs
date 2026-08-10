#!/usr/bin/env node
/**
 * Operator-facing same-job native receipt collection for OpenCode, Pi, and Grok.
 *
 * Mirrors .github/workflows/release.yml artifact job steps:
 *   private RUNNER_TEMP → collect → required-real vitest → extract → bundle digests
 *
 * Safety:
 * - requires --authorize-paid-probe
 * - requires OPENAI_API_KEY, ANTHROPIC_API_KEY, and XAI_API_KEY in the environment
 * - injects one key at a time into each adapter step (never shares secrets across adapters)
 * - never prints secret values, raw evidence, or full receipt payloads
 * - evidence files are deleted after extract; only digest-bound receipt files + bundle remain
 *
 * Usage:
 *   PATH=/usr/bin:$HOME/.local/bin:$PATH \\
 *     OPENAI_API_KEY=… ANTHROPIC_API_KEY=… XAI_API_KEY=… \\
 *     node scripts/collect-all-native-receipts.mjs --authorize-paid-probe
 *
 * Optional:
 *   --workspace <absolute-dir>   private parent (default: $TMPDIR/relayforge-native-local-<pid>)
 *   --keep-workspace             leave receipts/bundle on disk (default: leave; prints path only)
 *   --json                       machine-readable summary (digests/status only)
 */
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ADAPTERS = Object.freeze([
  Object.freeze({
    id: "opencode",
    keyEnv: "OPENAI_API_KEY",
    requireEnv: "RELAYFORGE_TEST_REQUIRE_OPENCODE",
    evidenceEnv: "RELAYFORGE_TEST_OPENCODE_CONTAINED_EVIDENCE_FILE",
    testFile: "tests/adapter-opencode.test.ts"
  }),
  Object.freeze({
    id: "pi",
    keyEnv: "ANTHROPIC_API_KEY",
    requireEnv: "RELAYFORGE_TEST_REQUIRE_PI",
    evidenceEnv: "RELAYFORGE_TEST_PI_CONTAINED_EVIDENCE_FILE",
    testFile: "tests/adapter-pi.test.ts"
  }),
  Object.freeze({
    id: "grok",
    keyEnv: "XAI_API_KEY",
    requireEnv: "RELAYFORGE_TEST_REQUIRE_GROK",
    evidenceEnv: "RELAYFORGE_TEST_GROK_CONTAINED_EVIDENCE_FILE",
    testFile: "tests/adapter-grok.test.ts"
  })
]);
const ALL_KEY_ENVS = Object.freeze(["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"]);
const NONCE = /^[a-f0-9]{64}$/u;

function fail(message) {
  throw new Error(`collect-all-native-receipts: ${message}`);
}

function hasFlag(args, name) {
  return args.filter((value) => value === name).length === 1;
}

function optionalArg(args, name) {
  const matches = args.flatMap((value, index) => (value === name ? [index] : []));
  if (matches.length === 0) return null;
  if (matches.length !== 1 || matches[0] + 1 >= args.length) fail(`${name} must occur exactly once with a value`);
  return args[matches[0] + 1];
}

function keySet(name) {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0;
}

function writePrivateFile(path, text) {
  const bytes = Buffer.from(text, "utf8");
  let fd;
  let created = false;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (written <= 0) fail("private write made no progress");
      offset += written;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (created) {
      try {
        unlinkSync(path);
      } catch {
        // ignore
      }
    }
    throw error;
  }
}

function assertPrivateDir(root) {
  const info = statSync(root);
  if (!info.isDirectory()) fail("workspace is not a directory");
  if ((info.mode & 0o077) !== 0) fail("workspace must not grant group/other permissions (use mode 0700)");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) fail("workspace must be owned by the current user");
}

function run(command, args, env, label) {
  const result = spawnSync(command, args, {
    cwd: REPO,
    env,
    encoding: "utf8",
    timeout: 30 * 60_000,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error) fail(`${label} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    const stdout = (result.stdout ?? "").trim();
    // Never echo env; only bounded process output. Redact any accidental key-shaped lines.
    const redact = (text) =>
      text
        .split("\n")
        .filter((line) => !/(api[_-]?key|authorization|bearer\s+)/i.test(line))
        .slice(-40)
        .join("\n");
    const tail = [redact(stdout), redact(stderr)].filter(Boolean).join("\n").slice(-4_000);
    fail(`${label} exited ${result.status}${tail ? `\n${tail}` : ""}`);
  }
  return result;
}

function baseEnvWithoutProviderKeys() {
  const env = { ...process.env };
  for (const name of ALL_KEY_ENVS) delete env[name];
  // Avoid leaking ambient provider tokens into child processes beyond the intentional one key.
  return env;
}

function collectAdapter(adapter, privateRoot, commitSha, jobNonce) {
  const evidence = join(privateRoot, `${adapter.id}.json`);
  const receipt = join(privateRoot, `${adapter.id}-receipt.json`);
  const keyValue = process.env[adapter.keyEnv];
  if (typeof keyValue !== "string" || keyValue.length === 0) fail(`${adapter.keyEnv} must be set for ${adapter.id}`);

  const env = baseEnvWithoutProviderKeys();
  env[adapter.keyEnv] = keyValue;
  env.RUNNER_TEMP = privateRoot;
  env.PATH = process.env.PATH;
  env.RELAYFORGE_TEST_REQUIRE_CGROUP = "1";

  // 1) collect production evidence (paid)
  run(
    process.execPath,
    [
      join(REPO, "scripts/collect-contained-adapter-evidence.mjs"),
      "--authorize-paid-probe",
      "--adapter",
      adapter.id,
      "--output",
      evidence,
      "--commit-sha",
      commitSha,
      "--job-nonce",
      jobNonce
    ],
    env,
    `${adapter.id} collect`
  );

  // 2) required-real vitest consume
  const testEnv = {
    ...env,
    [adapter.requireEnv]: "1",
    [adapter.evidenceEnv]: evidence,
    RELAYFORGE_TEST_EVIDENCE_JOB_NONCE: jobNonce
  };
  // Match release.yml: npx vitest run tests/adapter-*.test.ts
  run(
    process.execPath,
    [join(REPO, "node_modules/vitest/vitest.mjs"), "run", join(REPO, adapter.testFile)],
    testEnv,
    `${adapter.id} required-real vitest`
  );

  // 3) extract digest-only receipt
  run(
    process.execPath,
    [
      join(REPO, "scripts/create-native-adapter-receipt-bundle.mjs"),
      "--extract",
      "--adapter",
      adapter.id,
      "--evidence-file",
      evidence,
      "--receipt-output",
      receipt,
      "--commit-sha",
      commitSha,
      "--job-nonce",
      jobNonce
    ],
    env,
    `${adapter.id} extract`
  );

  // Drop raw evidence immediately (release workflow does the same).
  try {
    unlinkSync(evidence);
  } catch {
    // ignore
  }

  let receiptDigest = null;
  try {
    const parsed = JSON.parse(readFileSync(receipt, "utf8"));
    if (parsed && typeof parsed.receiptDigest === "string") receiptDigest = parsed.receiptDigest;
  } catch {
    // bundle step will re-validate
  }
  return { receipt, receiptDigest };
}

export function main(args = process.argv.slice(2)) {
  const authorize = hasFlag(args, "--authorize-paid-probe");
  const jsonMode = hasFlag(args, "--json");
  const keepWorkspace = hasFlag(args, "--keep-workspace");
  const workspaceArg = optionalArg(args, "--workspace");

  const known = new Set(["--authorize-paid-probe", "--json", "--keep-workspace", "--workspace"]);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--workspace") {
      index += 1;
      continue;
    }
    if (!known.has(value)) fail(`unknown argument ${JSON.stringify(value)}`);
  }

  if (!authorize) {
    fail("refusing paid collection without explicit --authorize-paid-probe");
  }

  process.chdir(REPO);

  // Clean checkout + HEAD
  const porcelain = spawnSync("git", ["status", "--porcelain"], { cwd: REPO, encoding: "utf8" });
  if ((porcelain.stdout ?? "").trim()) fail("working tree must be clean before native receipt collection");
  const headResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" });
  const commitSha = (headResult.stdout ?? "").trim();
  if (headResult.status !== 0 || !/^[a-f0-9]{40}$/u.test(commitSha)) fail("unable to read clean HEAD");

  for (const adapter of ADAPTERS) {
    if (!keySet(adapter.keyEnv)) fail(`${adapter.keyEnv} must be set (value never printed)`);
  }

  // Prefer readiness script when present (non-fatal soft advice if it fails only on keys we already checked).
  const readiness = join(REPO, "scripts/check-native-receipt-readiness.mjs");
  if (existsSync(readiness)) {
    const probe = spawnSync(process.execPath, [readiness, "--json"], {
      cwd: REPO,
      encoding: "utf8",
      env: process.env
    });
    if (probe.status !== 0) {
      try {
        const report = JSON.parse(probe.stdout || "{}");
        const missing = Array.isArray(report.missing) ? report.missing : [];
        const nonKey = missing.filter((item) => !/API_KEY/u.test(String(item)));
        if (nonKey.length > 0) fail(`readiness check failed: ${nonKey.join("; ")}`);
      } catch {
        fail("readiness check failed; run scripts/check-native-receipt-readiness.mjs");
      }
    }
  }

  const parent =
    workspaceArg !== null
      ? resolve(workspaceArg)
      : join(tmpdir(), `relayforge-native-local-${process.pid}-${Date.now()}`);
  if (!isAbsolute(parent)) fail("--workspace must be absolute");

  mkdirSync(parent, { recursive: true, mode: 0o700 });
  try {
    chmodSync(parent, 0o700);
  } catch {
    // best-effort on platforms that ignore chmod
  }
  const privateRoot = realpathSync(parent);
  assertPrivateDir(privateRoot);

  const jobNonce = randomBytes(32).toString("hex");
  if (!NONCE.test(jobNonce)) fail("internal nonce generation failed");
  writePrivateFile(join(privateRoot, "job-nonce"), `${jobNonce}\n`);

  const digests = {};
  const receipts = {};
  let bundlePath = join(privateRoot, "receipts.json");

  try {
    for (const adapter of ADAPTERS) {
      process.stderr.write(`collect-all: ${adapter.id} collect→vitest→extract (one key only)\n`);
      const result = collectAdapter(adapter, privateRoot, commitSha, jobNonce);
      receipts[adapter.id] = result.receipt;
      digests[adapter.id] = result.receiptDigest;
      process.stderr.write(`collect-all: ${adapter.id} receipt written\n`);
    }

    process.stderr.write("collect-all: bundling receipt digests\n");
    const bundleEnv = baseEnvWithoutProviderKeys();
    bundleEnv.RUNNER_TEMP = privateRoot;
    bundleEnv.PATH = process.env.PATH;
    run(
      process.execPath,
      [
        join(REPO, "scripts/create-native-adapter-receipt-bundle.mjs"),
        "--output",
        bundlePath,
        "--commit-sha",
        commitSha,
        "--opencode-receipt",
        receipts.opencode,
        "--pi-receipt",
        receipts.pi,
        "--grok-receipt",
        receipts.grok
      ],
      bundleEnv,
      "bundle"
    );

    let bundleDigest = null;
    try {
      const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
      if (bundle && typeof bundle.receiptDigest === "string") bundleDigest = bundle.receiptDigest;
      if (bundle && bundle.receipts && typeof bundle.receipts === "object") {
        for (const id of ["opencode", "pi", "grok"]) {
          if (typeof bundle.receipts[id] === "string") digests[id] = bundle.receipts[id];
        }
      }
    } catch {
      // still report path
    }

    // Remove job nonce after success (raw evidence already removed).
    try {
      unlinkSync(join(privateRoot, "job-nonce"));
    } catch {
      // ignore
    }

    const summary = {
      status: "collected",
      commitSha,
      workspace: privateRoot,
      bundle: bundlePath,
      bundleDigest,
      receiptDigests: digests,
      note: "Preserve only the digest-bound receipt bundle; never upload raw evidence or secrets."
    };

    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(summary)}\n`);
    } else {
      process.stdout.write("Native receipt collection complete\n");
      process.stdout.write(`commitSha: ${commitSha}\n`);
      process.stdout.write(`workspace: ${privateRoot}\n`);
      process.stdout.write(`bundle: ${bundlePath}\n`);
      if (bundleDigest) process.stdout.write(`bundleDigest: ${bundleDigest}\n`);
      for (const id of ["opencode", "pi", "grok"]) {
        process.stdout.write(`${id} receiptDigest: ${digests[id] ?? "(unknown)"}\n`);
      }
      process.stdout.write(
        "Next: RELAYFORGE_RELEASE_SOURCE_GATE=passed RELAYFORGE_RELEASE_CGROUP_GATE=passed node scripts/release-artifact.mjs --output .release --native-adapter-receipts <bundle>\n"
      );
    }

    if (!keepWorkspace) {
      // Default: keep workspace (operator needs the bundle path). Flag reserved for future purge modes.
      // Explicitly document that receipts remain under workspace.
    }
  } catch (error) {
    // On failure, scrub evidence-like files but leave the error visible.
    for (const id of ["opencode", "pi", "grok"]) {
      try {
        unlinkSync(join(privateRoot, `${id}.json`));
      } catch {
        // ignore
      }
    }
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

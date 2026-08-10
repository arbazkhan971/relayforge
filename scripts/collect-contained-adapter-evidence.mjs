#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { collectProductionContainedAdapterEvidence } from "../dist/adapters/contained-evidence-production.js";

const ADAPTERS = new Set(["opencode", "pi", "grok"]);
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const NONCE = /^[a-f0-9]{64}$/u;

function fail(message) { throw new Error(`contained adapter collector: ${message}`); }
function argument(args, name) {
  const matches = args.flatMap((value, index) => value === name ? [index] : []);
  if (matches.length !== 1 || matches[0] + 1 >= args.length) fail(`${name} must occur exactly once with a value`);
  return args[matches[0] + 1];
}
function hasFlag(args, name) {
  return args.filter((value) => value === name).length === 1;
}
function within(root, path) { const rel = relative(root, path); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); }

export async function main(args) {
  // Exact shape: --adapter, --output, --commit-sha, --job-nonce, and optional --authorize-paid-probe.
  const authorizePaid = hasFlag(args, "--authorize-paid-probe");
  const expectedLength = authorizePaid ? 9 : 8;
  if (args.length !== expectedLength) {
    fail("expected --adapter, --output, --commit-sha, --job-nonce and optional --authorize-paid-probe only");
  }
  if (authorizePaid && args.filter((value) => value === "--authorize-paid-probe").length !== 1) {
    fail("--authorize-paid-probe must appear at most once");
  }
  const adapterId = argument(args, "--adapter");
  const outputPath = argument(args, "--output");
  const commitSha = argument(args, "--commit-sha");
  const jobNonce = argument(args, "--job-nonce");
  if (!ADAPTERS.has(adapterId)) fail("adapter must be opencode, pi, or grok");
  if (!COMMIT.test(commitSha)) fail("commit SHA is malformed");
  if (!NONCE.test(jobNonce)) fail("job nonce must be 32 random bytes in lowercase hex");
  if (!authorizePaid) {
    fail("paid behavioral characterization requires explicit --authorize-paid-probe before any probe or worktree mutation");
  }
  const runnerTemp = process.env.RUNNER_TEMP;
  if (!runnerTemp || !isAbsolute(runnerTemp)) fail("RUNNER_TEMP must be an absolute private directory");
  const root = realpathSync(runnerTemp);
  const rootInfo = statSync(root);
  if (!rootInfo.isDirectory() || (rootInfo.mode & 0o077) !== 0 || (typeof process.getuid === "function" && rootInfo.uid !== process.getuid()) || !isAbsolute(outputPath) || resolve(outputPath) !== outputPath || !within(root, outputPath)) {
    fail("output must be a canonical path beneath private owned RUNNER_TEMP");
  }
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== commitSha) fail("explicit commit SHA does not equal checked-out HEAD");
  const forbiddenSentinels = [
    process.env.XAI_API_KEY,
    process.env.ANTHROPIC_API_KEY,
    process.env.OPENAI_API_KEY,
    process.env.GEMINI_API_KEY,
    process.env.GOOGLE_API_KEY
  ].filter((value) => typeof value === "string" && value.length > 0);
  await collectProductionContainedAdapterEvidence({
    adapterId,
    outputPath,
    commitSha,
    jobNonce,
    forbiddenSentinels,
    repositoryRoot: process.cwd(),
    paidProbeAuthorized: true,
    characterizationRoot: root
  });
  // Never print the receipt, runtime paths, prompt, native session identity or credentials.
  process.stdout.write(`${JSON.stringify({ status: "collected", adapterId })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}

#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// argv[2]/argv[3] are deliberate negative capabilities. The parent tells this fixture where an
// unassigned configured repository and a host-only sentinel live, but the P6 empty-root sandbox must
// not mount either path. Knowing a pathname is not a filesystem capability.
const forbiddenRepository = process.argv[2] ?? "";
const hostSentinel = process.argv[3] ?? "";
const prompt = process.argv.at(-1) ?? "";
const manifests = prompt
  .split("\n")
  .filter((line) => line.startsWith('{"schemaVersion":1,"runId":'));
const raw = manifests.at(-1);
if (!raw) {
  process.stderr.write("missing P6 manifest\n");
  process.exit(64);
}

let manifest;
try {
  manifest = JSON.parse(raw);
} catch {
  process.stderr.write("malformed P6 manifest\n");
  process.exit(65);
}
if (!Array.isArray(manifest.repositories) || manifest.repositories.length !== 2) {
  process.stderr.write("P6 manifest did not authorize exactly two repositories\n");
  process.exit(66);
}

for (const [label, path] of [["unassigned repository", forbiddenRepository], ["host sentinel", hostSentinel]]) {
  try {
    readFileSync(path);
    process.stderr.write(`${label} was visible inside the P6 filesystem capability\n`);
    process.exit(68);
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "EACCES") {
      process.stderr.write(`${label} denial was not fail-closed: ${String(error)}\n`);
      process.exit(69);
    }
  }
}

for (const repository of manifest.repositories) {
  if (typeof repository?.path !== "string" || typeof repository?.repositoryId !== "string") {
    process.stderr.write("invalid P6 repository entry\n");
    process.exit(67);
  }
  writeFileSync(resolve(repository.path, "relayforge-p6.txt"), `updated:${repository.repositoryId}\n`, { flag: "wx" });
  // This file is deliberately inside an authorized worktree. If recovery ever launches a second
  // provider, the append makes that visible even if a future edit weakens the O_EXCL output file.
  appendFileSync(resolve(repository.path, "provider-launches.txt"), "launch\n", { mode: 0o600 });
}

process.stdout.write(JSON.stringify({
  is_error: false,
  // Keep a substantial but sub-frame terminal so the parent performs real post-settlement transcript
  // and turn-log I/O. The SIGKILL tests watch those durable boundaries and can land on both sides of
  // receipt publication without an exported production fault injector.
  result: `updated two authorized repositories; negative capabilities remained absent\n${"x".repeat(14 * 1024 * 1024)}`,
  total_cost_usd: 0,
  usage: { input_tokens: 1, output_tokens: 1 }
}));

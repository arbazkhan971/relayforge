#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Custom providers receive the complete parent-controlled prompt as the final argv value. Extract
// the last exact one-line P6 manifest (the combined prompt deliberately contains it twice), then
// make one bounded edit in every parent-authorized worktree. Git/ref/publication operations remain
// parent-only and are intentionally absent from this fixture.
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
if (!Array.isArray(manifest.repositories) || manifest.repositories.length < 2) {
  process.stderr.write("P6 manifest did not authorize at least two repositories\n");
  process.exit(66);
}
for (const repository of manifest.repositories) {
  if (typeof repository?.path !== "string" || typeof repository?.repositoryId !== "string") {
    process.stderr.write("invalid P6 repository entry\n");
    process.exit(67);
  }
  writeFileSync(resolve(repository.path, "relayforge-p6.txt"), `updated:${repository.repositoryId}\n`, { flag: "wx" });
}
process.stdout.write(JSON.stringify({
  is_error: false,
  result: `updated ${manifest.repositories.length} repositories`,
  total_cost_usd: 0,
  usage: { input_tokens: 1, output_tokens: 1 }
}));

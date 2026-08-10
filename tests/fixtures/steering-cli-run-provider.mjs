#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const role = process.env.LOOP_ROLE ?? "implementer";
const readOnly = process.env.LOOP_READONLY === "1";
const prompt = process.argv.at(-1) ?? "";
const cwd = process.cwd();

function emit(value) {
  process.stdout.write(JSON.stringify({ is_error: false, ...value }));
}

async function waitForRelease(leaf) {
  const path = resolve(cwd, leaf);
  const deadline = Date.now() + 30_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      process.stderr.write(`fixture release timed out: ${leaf}\n`);
      process.exit(74);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

if (role === "planner") {
  emit({
    result: JSON.stringify([
      {
        title: "Exercise a later immutable repair boundary",
        assignee: "implementer",
        description: "Deliver the fixture only after an independently reviewed repair.",
        acceptanceCriteria: ["feature.txt is fixed", "the exact repair prompt is recorded"],
        dependsOn: [],
        priority: 10
      }
    ])
  });
  process.exit(0);
}

if (role === "reviewer" || readOnly) {
  const reject = prompt.includes("FIRST_ATTEMPT_SENTINEL");
  process.stdout.write(JSON.stringify({
    verdict: reject ? "reject" : "accept",
    reasons: [reject ? "fixture requires one later repair boundary" : "repair boundary is complete"]
  }));
  process.exit(0);
}

const repair = /REPAIR ATTEMPT/iu.test(prompt);
if (!repair) {
  writeFileSync(resolve(cwd, "feature.txt"), "FIRST_ATTEMPT_SENTINEL\n");
  writeFileSync(resolve(cwd, ".fixture-first-active"), "active\n");
  await waitForRelease(".fixture-release-first");
  emit({ result: "first attempt ready for independent rejection" });
  process.exit(0);
}

writeFileSync(resolve(cwd, "feature.txt"), "fixed\n");
writeFileSync(
  resolve(cwd, "provider-prompt.json"),
  `${JSON.stringify({ schemaVersion: 1, encoding: "base64", contentBase64: Buffer.from(prompt, "utf8").toString("base64") }, null, 2)}\n`
);
writeFileSync(resolve(cwd, ".fixture-repair-active"), "active\n");
await waitForRelease(".fixture-release-repair");
emit({ result: "repair completed from the immutable attempt prompt" });

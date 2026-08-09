import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runHeadlessChild } from "../../src/orchestrator.js";

const here = dirname(fileURLToPath(import.meta.url));
const emit = join(here, "emit-bytes.mjs");
const scratch = mkdtempSync(join(tmpdir(), "relayforge-stream-flood-probe-"));

try {
  const ctx = {
    children: new Set(),
    ownedGroups: new Set(),
    loop: { cadenceMinutes: 5 },
    scopesPath: join(scratch, "probe.scopes")
  } as any;
  global.gc?.();
  const rssBefore = process.memoryUsage().rss;
  const startedAt = Date.now();
  const result = await runHeadlessChild(
    ctx,
    "node",
    [emit, "flood", "6000000"],
    { PATH: process.env.PATH ?? "" },
    "",
    process.cwd(),
    undefined,
    scratch,
    90_000,
    "claude"
  );
  global.gc?.();
  process.stdout.write(`${JSON.stringify({
    rssDelta: process.memoryUsage().rss - rssBefore,
    elapsedMs: Date.now() - startedAt,
    transportOk: result.transportOk,
    success: result.streamedVerdict?.success,
    ownedGroups: ctx.ownedGroups.size
  })}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

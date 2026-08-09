import { existsSync, writeFileSync } from "node:fs";
import { createControlStoreTranscriptCommit } from "../../src/observability/control-store-adapter.js";
import { openControlStore } from "../../src/control/store.js";
import type { TranscriptCommitRequestV1, TranscriptIngestorStateV1 } from "../../src/observability/transcript-ingestor.js";

const [path, initialEncoded, requestEncoded, readyPath, startPath] = process.argv.slice(2);
if (!path || !initialEncoded || !requestEncoded || !readyPath || !startPath) throw new Error("observability writer fixture arguments are missing");

const initialState = JSON.parse(Buffer.from(initialEncoded, "base64url").toString("utf8")) as TranscriptIngestorStateV1;
const request = JSON.parse(Buffer.from(requestEncoded, "base64url").toString("utf8")) as TranscriptCommitRequestV1;
const store = openControlStore({
  path,
  runId: initialState.generation.runId,
  runEpoch: initialState.generation.runEpoch,
  create: false,
  now: () => "2026-08-09T12:00:00.000Z"
});

try {
  writeFileSync(readyPath, String(process.pid), { mode: 0o600 });
  while (!existsSync(startPath)) await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
  const commit = createControlStoreTranscriptCommit({ store, initialState, actorId: "observation-child", now: () => "2026-08-09T12:00:00.000Z" });
  try {
    const receipt = await commit(request);
    process.stdout.write(JSON.stringify({ ok: true, receipt }));
  } catch (error) {
    process.stdout.write(JSON.stringify({
      ok: false,
      name: error instanceof Error ? error.name : "Error",
      code: error && typeof error === "object" && "code" in error ? String(error.code) : undefined
    }));
  }
} finally {
  store.close();
}

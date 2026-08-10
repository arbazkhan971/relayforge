import {
  appendFileSync,
  chmodSync,
  closeSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { openTranscriptSource, type PinnedTranscriptSource } from "../src/observability/source-context.js";
import {
  createTranscriptIngestorState,
  pollTranscript,
  transcriptIngestorStateDigest,
  TRANSCRIPT_INGESTOR_LIMITS,
  TranscriptIngestorError,
  type IngestedObservationV1,
  type TranscriptCommitRequestV1,
  type TranscriptCommitTransaction,
  type TranscriptIngestorStateV1,
  type TranscriptRecordParserV1
} from "../src/observability/transcript-ingestor.js";
import type { ObservationGenerationV1 } from "../src/observability/types.js";

const AT = "2026-08-09T12:00:00.000Z";
const EPOCH = "epoch_1234567890123456";
const created: string[] = [];

function fixture(contents = ""): Readonly<{ root: string; path: string; source: PinnedTranscriptSource }> {
  const root = mkdtempSync(join(tmpdir(), "relayforge-transcript-ingestor-"));
  chmodSync(root, 0o700);
  created.push(root);
  const path = join(root, "transcript.jsonl");
  writeFileSync(path, contents, { mode: 0o600 });
  return { root, path, source: openTranscriptSource({ root, relativePath: "transcript.jsonl" }) };
}

afterEach(() => {
  while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true });
});

const generation: ObservationGenerationV1 = {
  runId: "run-1",
  runEpoch: EPOCH,
  taskId: "task-1",
  agentId: "worker-1",
  runtimeGeneration: 1,
  attemptGeneration: 1,
  sourceGeneration: 1
};

const decoder = new TextDecoder("utf-8", { fatal: true });
const parser: TranscriptRecordParserV1 = {
  id: "test.jsonl",
  version: 1,
  parse(bytes) {
    const value = JSON.parse(decoder.decode(bytes)) as { message?: unknown; code?: unknown };
    if (typeof value.message !== "string") throw new Error("missing message");
    return {
      observedAt: AT,
      category: "provider",
      phase: "executing",
      severity: "info",
      code: typeof value.code === "string" ? value.code : "provider.progress",
      details: { kind: "progress", operationCode: "turn.running" },
      summary: value.message
    };
  }
};

function initial(source: PinnedTranscriptSource, parserValue = parser): TranscriptIngestorStateV1 {
  return createTranscriptIngestorState({ source, generation, parser: parserValue });
}

function transaction(current: () => TranscriptIngestorStateV1, commit: (state: TranscriptIngestorStateV1, records: readonly IngestedObservationV1[]) => void): TranscriptCommitTransaction {
  return async (request) => {
    expect(request.previousStateDigest).toBe(transcriptIngestorStateDigest(current()));
    commit(request.nextState, request.observations);
    return { stateDigest: request.nextStateDigest, observationCount: request.observations.length };
  };
}

describe("restart-safe transcript ingestion", () => {
  it("commits complete records and the byte cursor in one callback, then replays idempotently", async () => {
    const value = fixture('{"message":"one"}\n{"message":"two"}\n');
    let durable = initial(value.source);
    const records: IngestedObservationV1[] = [];
    const commit = transaction(() => durable, (state, next) => { durable = state; records.push(...next); });
    const first = await pollTranscript({ source: value.source, state: durable, parser, commit, now: AT, quiescent: false });
    expect(first.committed).toBe(true);
    expect(records.map((record) => record.summary?.text)).toEqual(["one", "two"]);
    expect(records.map((record) => record.recordId)).toEqual([
      `obs-${value.source.identity.sourceId.slice(0, 24)}-1-1`,
      `obs-${value.source.identity.sourceId.slice(0, 24)}-1-2`
    ]);
    expect(durable.cursor).toBe(Buffer.byteLength('{"message":"one"}\n{"message":"two"}\n'));
    const repeat = await pollTranscript({ source: value.source, state: durable, parser, commit, now: AT, quiescent: false });
    expect(repeat).toMatchObject({ committed: false, observations: [] });
    expect(records).toHaveLength(2);
    value.source.close();
  });

  it("does not advance over a partial record and emits it exactly once after append", async () => {
    const value = fixture('{"message":"hel');
    let durable = initial(value.source);
    const records: IngestedObservationV1[] = [];
    const commit = transaction(() => durable, (state, next) => { durable = state; records.push(...next); });
    expect(await pollTranscript({ source: value.source, state: durable, parser, commit, now: AT, quiescent: false }))
      .toMatchObject({ committed: false, observations: [] });
    expect(durable.cursor).toBe(0);
    appendFileSync(value.path, 'lo"}\n');
    const completed = await pollTranscript({ source: value.source, state: durable, parser, commit, now: AT, quiescent: false });
    expect(completed.observations.map((record) => record.summary?.text)).toEqual(["hello"]);
    expect(durable.cursor).toBe(Buffer.byteLength('{"message":"hello"}\n'));
    value.source.close();
  });

  it("finalizes an unterminated valid tail only after two durable quiescent observations", async () => {
    const value = fixture('{"message":"final"}');
    let durable = initial(value.source);
    const records: IngestedObservationV1[] = [];
    const commit = transaction(() => durable, (state, next) => { durable = state; records.push(...next); });
    const first = await pollTranscript({ source: value.source, state: durable, parser, commit, now: AT, quiescent: true });
    expect(first).toMatchObject({ committed: true, observations: [] });
    expect(durable.quietPolls).toBe(1);
    const second = await pollTranscript({ source: value.source, state: durable, parser, commit, now: AT, quiescent: true });
    expect(second.observations).toHaveLength(1);
    expect(second.observations[0]).toMatchObject({ sourceIntegrity: "quiescent_final", summary: { text: "final" } });
    expect(durable.quietPolls).toBe(0);
    expect(durable.integrity).toBe("quiescent_final");
    value.source.close();
  });

  it("classifies malformed complete and stable-tail records without retaining raw bytes", async () => {
    const sentinel = "RAW_PRIVATE_SENTINEL";
    const value = fixture(`not-json-${sentinel}\n{also-bad-${sentinel}`);
    let durable = initial(value.source);
    const records: IngestedObservationV1[] = [];
    const commit = transaction(() => durable, (state, next) => { durable = state; records.push(...next); });
    await pollTranscript({ source: value.source, state: durable, parser, commit, now: AT, quiescent: true });
    await pollTranscript({ source: value.source, state: durable, parser, commit, now: AT, quiescent: true });
    expect(records.map((record) => record.code)).toEqual(["source.record_malformed", "source.record_malformed"]);
    expect(JSON.stringify(records)).not.toContain(sentinel);
    expect(durable).toMatchObject({ droppedRecords: 2, integrity: "degraded", cursor: Buffer.byteLength(`not-json-${sentinel}\n{also-bad-${sentinel}`) });
    value.source.close();
  });

  it("discards newline-terminated and unterminated oversized records with bounded state", async () => {
    const huge = "x".repeat(TRANSCRIPT_INGESTOR_LIMITS.maximumRecordBytes + 1);
    const terminated = fixture(`${huge}\n`);
    let terminatedState = initial(terminated.source);
    const terminatedRecords: IngestedObservationV1[] = [];
    const terminatedCommit = transaction(() => terminatedState, (state, next) => { terminatedState = state; terminatedRecords.push(...next); });
    await pollTranscript({ source: terminated.source, state: terminatedState, parser, commit: terminatedCommit, now: AT, quiescent: false });
    expect(terminatedRecords[0]).toMatchObject({ code: "source.record_oversize", loss: { droppedRecords: 1 } });
    expect(JSON.stringify(terminatedState).length).toBeLessThan(TRANSCRIPT_INGESTOR_LIMITS.maximumStateBytes);
    terminated.source.close();

    const unterminated = fixture(huge);
    let unterminatedState = initial(unterminated.source);
    const unterminatedRecords: IngestedObservationV1[] = [];
    const unterminatedCommit = transaction(() => unterminatedState, (state, next) => { unterminatedState = state; unterminatedRecords.push(...next); });
    await pollTranscript({ source: unterminated.source, state: unterminatedState, parser, commit: unterminatedCommit, now: AT, quiescent: false });
    expect(unterminatedState).toMatchObject({ discardingOversize: true, cursor: huge.length });
    await pollTranscript({ source: unterminated.source, state: unterminatedState, parser, commit: unterminatedCommit, now: AT, quiescent: true });
    await pollTranscript({ source: unterminated.source, state: unterminatedState, parser, commit: unterminatedCommit, now: AT, quiescent: true });
    expect(unterminatedRecords).toHaveLength(1);
    expect(unterminatedRecords[0]?.code).toBe("source.record_oversize");
    expect(unterminatedState.discardingOversize).toBe(false);
    unterminated.source.close();
  });

  it("does not advance caller state when the atomic callback fails and retries exact IDs", async () => {
    const value = fixture('{"message":"retry"}\n');
    const durable = initial(value.source);
    let attempted: TranscriptCommitRequestV1 | undefined;
    await expect(pollTranscript({
      source: value.source,
      state: durable,
      parser,
      now: AT,
      quiescent: false,
      commit: async (request) => { attempted = request; throw new Error("crash before commit"); }
    })).rejects.toMatchObject<Partial<TranscriptIngestorError>>({ code: "COMMIT_REJECTED" });
    expect(durable.cursor).toBe(0);
    let committed = durable;
    const retry = await pollTranscript({
      source: value.source,
      state: durable,
      parser,
      now: AT,
      quiescent: false,
      commit: transaction(() => committed, (state) => { committed = state; })
    });
    expect(retry.observations[0]?.recordId).toBe(attempted?.observations[0]?.recordId);
    expect(retry.observations[0]).toEqual(attempted?.observations[0]);
    value.source.close();
  });

  it("rejects a transaction receipt that does not bind exact state and record count", async () => {
    const value = fixture('{"message":"one"}\n');
    const durable = initial(value.source);
    await expect(pollTranscript({
      source: value.source,
      state: durable,
      parser,
      now: AT,
      quiescent: false,
      commit: async () => ({ stateDigest: "0".repeat(64), observationCount: 0 })
    })).rejects.toMatchObject<Partial<TranscriptIngestorError>>({ code: "COMMIT_REJECTED" });
    value.source.close();
  });

  it("detects same-inode prefix rewrites before parsing any new bytes", async () => {
    const value = fixture('{"message":"one"}\n');
    let durable = initial(value.source);
    const commit = transaction(() => durable, (state) => { durable = state; });
    await pollTranscript({ source: value.source, state: durable, parser, commit, now: AT, quiescent: false });
    const descriptor = openSync(value.path, "r+");
    writeSync(descriptor, Buffer.from("X"), 0, 1, 0);
    closeSync(descriptor);
    await expect(pollTranscript({ source: value.source, state: durable, parser, commit, now: AT, quiescent: false }))
      .rejects.toMatchObject<Partial<TranscriptIngestorError>>({ code: "PREFIX_MISMATCH" });
    value.source.close();
  });

  it("fails closed on path rotation unless explicitly draining the pinned old generation", async () => {
    const value = fixture('{"message":"old"}\n');
    let durable = initial(value.source);
    const records: IngestedObservationV1[] = [];
    const commit = transaction(() => durable, (state, next) => { durable = state; records.push(...next); });
    renameSync(value.path, join(value.root, "rotated.jsonl"));
    writeFileSync(value.path, '{"message":"new"}\n', { mode: 0o600 });
    await expect(pollTranscript({ source: value.source, state: durable, parser, commit, now: AT, quiescent: false }))
      .rejects.toMatchObject<Partial<TranscriptIngestorError>>({ code: "SOURCE_REPLACED" });
    const drained = await pollTranscript({
      source: value.source,
      state: durable,
      parser,
      commit,
      now: AT,
      quiescent: false,
      allowPinnedReplacement: true
    });
    expect(drained.sourcePathState).toBe("replaced");
    expect(records[0]).toMatchObject({ sourceIntegrity: "replaced", summary: { text: "old" } });
    value.source.close();
  });

  it("rejects parser/source identity drift without calling the transaction", async () => {
    const value = fixture('{"message":"one"}\n');
    const durable = initial(value.source);
    let calls = 0;
    const commit = async () => { calls += 1; return { stateDigest: "0".repeat(64), observationCount: 0 }; };
    await expect(pollTranscript({
      source: value.source,
      state: durable,
      parser: { ...parser, version: 2 },
      commit,
      now: AT,
      quiescent: false
    })).rejects.toMatchObject<Partial<TranscriptIngestorError>>({ code: "PARSER_MISMATCH" });
    const otherRoot = mkdtempSync(join(tmpdir(), "relayforge-transcript-other-"));
    chmodSync(otherRoot, 0o700);
    created.push(otherRoot);
    writeFileSync(join(otherRoot, "transcript.jsonl"), "", { mode: 0o600 });
    const other = openTranscriptSource({ root: otherRoot, relativePath: "transcript.jsonl" });
    await expect(pollTranscript({ source: other, state: durable, parser, commit, now: AT, quiescent: false }))
      .rejects.toMatchObject<Partial<TranscriptIngestorError>>({ code: "SOURCE_MISMATCH" });
    expect(calls).toBe(0);
    other.close();
    value.source.close();
  });

  it("redacts parser summaries and converts invalid parser DTOs into bounded loss facts", async () => {
    const sentinel = "SUPER_PRIVATE_TOKEN";
    const value = fixture(`{"message":"token=${sentinel} /home/alice/private"}\n{"message":"bad","code":"INVALID CODE"}\n`);
    let durable = initial(value.source);
    const records: IngestedObservationV1[] = [];
    const commit = transaction(() => durable, (state, next) => { durable = state; records.push(...next); });
    await pollTranscript({ source: value.source, state: durable, parser, commit, now: AT, quiescent: false });
    expect(records[0]?.summary?.text).toContain("[credential]");
    expect(JSON.stringify(records)).not.toContain(sentinel);
    expect(JSON.stringify(records)).not.toContain("/home/alice");
    expect(records[1]?.code).toBe("source.record_malformed");
    value.source.close();
  });

  it("caps each poll by normalized record count and resumes from the exact committed boundary", async () => {
    const lines = Array.from({ length: TRANSCRIPT_INGESTOR_LIMITS.maximumRecordsPerPoll + 1 }, (_, index) => `{"message":"${index}"}\n`).join("");
    const value = fixture(lines);
    let durable = initial(value.source);
    const records: IngestedObservationV1[] = [];
    const commit = transaction(() => durable, (state, next) => { durable = state; records.push(...next); });
    const first = await pollTranscript({ source: value.source, state: durable, parser, commit, now: AT, quiescent: false });
    expect(first.observations).toHaveLength(TRANSCRIPT_INGESTOR_LIMITS.maximumRecordsPerPoll);
    expect(durable.cursor).toBeLessThan(lines.length);
    const second = await pollTranscript({ source: value.source, state: durable, parser, commit, now: AT, quiescent: false });
    expect(second.observations).toHaveLength(1);
    expect(records).toHaveLength(TRANSCRIPT_INGESTOR_LIMITS.maximumRecordsPerPoll + 1);
    expect(new Set(records.map((record) => record.recordId)).size).toBe(records.length);
    value.source.close();
  });
});

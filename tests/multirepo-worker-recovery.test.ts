import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reapProofOf } from "../src/attest.js";
import type { LedgerAttestedSettlement } from "../src/ledger.js";
import type { MultiRepositoryWorkerRequestV1 } from "../src/multirepo/orchestration.js";
import {
  createMultiRepositoryWorkerRecoveryStore,
  multiRepositoryWorkerCallCandidates,
  multiRepositoryWorkerRecoveryKey,
  type MultiRepositoryWorkerReceiptPublishPoint
} from "../src/multirepo/worker-recovery.js";

function sha(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function request(overrides: Partial<MultiRepositoryWorkerRequestV1> = {}): MultiRepositoryWorkerRequestV1 {
  return Object.freeze({
    schemaVersion: 1,
    runId: "run-recovery",
    runEpoch: "epoch-recovery",
    taskId: "task-a",
    taskGeneration: 2,
    attemptId: "attempt-a",
    leaseToken: "lease-a",
    repositorySetId: sha("repo-set"),
    members: Object.freeze([
      Object.freeze({ repositoryId: "repo-a", path: "/work/repo-a", branch: "rf/task-a", anchorOid: "a".repeat(40) }),
      Object.freeze({ repositoryId: "repo-b", path: "/work/repo-b", branch: "rf/task-a-b", anchorOid: "b".repeat(40) })
    ]),
    ...overrides
  });
}

type Harness = Readonly<{
  root: string;
  runtime: string;
  transcripts: string;
  transcript: string;
  processIdentity: string;
  providerKeys: readonly string[];
  request: MultiRepositoryWorkerRequestV1;
  callId: string;
  evidence: LedgerAttestedSettlement;
}>;

const createdRoots = new Set<string>();

afterEach(() => {
  for (const root of createdRoots) {
    if (!basename(root).startsWith("relayforge-worker-recovery-") || dirname(root) !== resolve(tmpdir())) {
      throw new Error(`refusing to clean unexpected worker recovery fixture path ${root}`);
    }
    rmSync(root, { recursive: true, force: true });
  }
  createdRoots.clear();
});

function harness(overrides: Readonly<{ badScopeProof?: boolean; scopePid?: number }> = {}): Harness {
  const root = mkdtempSync(resolve(tmpdir(), "relayforge-worker-recovery-"));
  createdRoots.add(root);
  const runtime = resolve(root, "runtime");
  const transcripts = resolve(root, "transcripts");
  mkdirSync(runtime, { mode: 0o700 });
  mkdirSync(transcripts, { mode: 0o700 });
  const transcript = resolve(transcripts, "turn.jsonl");
  const terminal = Buffer.from('{"type":"result","success":true,"cost_usd":0.01}\n', "utf8");
  writeFileSync(transcript, terminal, { mode: 0o600 });
  chmodSync(transcript, 0o600);
  const stat = lstatSync(transcript);
  const planned = request();
  const providerKeys = Object.freeze(["worker-provider"]);
  const callId = multiRepositoryWorkerCallCandidates(planned, providerKeys)[0]!.callId;
  const pid = 424242;
  const scope = { backend: "pgid" as const, pid: overrides.scopePid ?? pid };
  const evidence: LedgerAttestedSettlement = Object.freeze({
    bind: Object.freeze({
      runNonce: planned.runEpoch,
      callNonce: "c".repeat(32),
      callId,
      reservationId: "d".repeat(32),
      routeEpoch: 1,
      provider: providerKeys[0]!,
      model: "fixture",
      attempt: planned.taskGeneration,
      intentSha256: sha("intent"),
      stdinSha256: sha("stdin"),
      stdinBytes: 5
    }),
    payload: Object.freeze({
      schema: "loop.ledger.attest.v2",
      kind: "accounted-terminal",
      ledgerEpoch: "ledger-epoch",
      runNonce: planned.runEpoch,
      callId,
      callNonce: "c".repeat(32),
      reservationId: "d".repeat(32),
      routeEpoch: 1,
      provider: providerKeys[0]!,
      model: "fixture",
      providerKind: "custom",
      attempt: planned.taskGeneration,
      scopeBackend: "pgid",
      scopeId: `pgid:${pid}`,
      scopeReapProof: overrides.badScopeProof ? "missing" : reapProofOf(scope),
      transcriptDev: String(stat.dev),
      transcriptIno: String(stat.ino),
      transcriptSha256: sha(terminal),
      transcriptBytes: terminal.length,
      terminalSha256: sha(terminal),
      terminalBytes: terminal.length,
      terminalOffset: 0,
      usdNano: "10000000",
      costProvenance: "provider-reported",
      ts: "2026-08-09T00:00:00.000Z"
    })
  });
  return Object.freeze({
    root,
    runtime,
    transcripts,
    transcript,
    processIdentity: `pid:${pid}:linux:test-token`,
    providerKeys,
    request: planned,
    callId,
    evidence
  });
}

function store(
  value: Harness,
  inspection: "dead" | "alive-match" | "unavailable" = "dead",
  receiptPublishFault?: (point: MultiRepositoryWorkerReceiptPublishPoint) => void
) {
  return createMultiRepositoryWorkerRecoveryStore({
    runtimeDirectory: value.runtime,
    transcriptDirectory: value.transcripts,
    ledger: { attestedSettlementOf: (callId) => callId === value.callId ? value.evidence : undefined },
    inspectProcess: () => inspection === "dead"
      ? { state: "dead" }
      : inspection === "alive-match"
        ? { state: "alive-match", token: "linux:test-token" }
        : { state: "unavailable", detail: "procfs unavailable" },
    ...(receiptPublishFault ? { receiptPublishFault } : {})
  });
}

describe("durable P6 worker recovery", () => {
  it("publishes and reopens an exact parent receipt for a ledger-attested completion", () => {
    const value = harness();
    const first = store(value).record(value.request, value.processIdentity, value.callId, value.transcript, value.providerKeys);
    expect(first).toMatchObject({
      processIdentity: value.processIdentity,
      settlementCallId: value.callId,
      outputDigest: value.evidence.payload.transcriptSha256,
      transportTrusted: true,
      scopeTrusted: true,
      scopeReaped: true,
      settlementTrusted: true
    });
    expect(store(value).recover(value.request, value.processIdentity, value.providerKeys)).toEqual(first);
    const receipt = resolve(value.runtime, "worker-recovery", `${multiRepositoryWorkerRecoveryKey(value.request)}.json`);
    expect(lstatSync(receipt).mode & 0o777).toBe(0o600);
    expect(readFileSync(receipt, "utf8")).toContain(value.callId);
  });

  it("reconstructs the receipt after a crash between the ledger settlement and receipt publication", () => {
    const value = harness();
    const recovered = store(value).recover(value.request, value.processIdentity, value.providerKeys);
    expect(recovered?.settlementCallId).toBe(value.callId);
    expect(recovered?.outputDigest).toBe(value.evidence.payload.transcriptSha256);
    const receipt = resolve(value.runtime, "worker-recovery", `${multiRepositoryWorkerRecoveryKey(value.request)}.json`);
    expect(lstatSync(receipt).isFile()).toBe(true);
  });

  it.each([
    "after-temp-fsync",
    "after-link",
    "after-unlink-before-dir-fsync"
  ] as const)("reconciles an exact publication crash at %s without relaunch authority", (crashPoint) => {
    const value = harness();
    let injected = false;
    const crashing = store(value, "dead", (point) => {
      if (!injected && point === crashPoint) {
        injected = true;
        throw new Error(`injected receipt publication crash at ${point}`);
      }
    });
    expect(() => crashing.record(value.request, value.processIdentity, value.callId, value.transcript, value.providerKeys))
      .toThrow(/injected receipt publication crash/u);
    expect(injected).toBe(true);

    const directory = resolve(value.runtime, "worker-recovery");
    const final = resolve(directory, `${multiRepositoryWorkerRecoveryKey(value.request)}.json`);
    const temporariesBefore = readdirSync(directory).filter((leaf) => leaf.startsWith(".tmp-"));
    if (crashPoint === "after-temp-fsync") {
      expect(lstatSync(resolve(directory, temporariesBefore[0]!)).nlink).toBe(1);
      expect(() => lstatSync(final)).toThrow();
    } else if (crashPoint === "after-link") {
      expect(temporariesBefore).toHaveLength(1);
      expect(lstatSync(final).nlink).toBe(2);
      expect(lstatSync(resolve(directory, temporariesBefore[0]!)).ino).toBe(lstatSync(final).ino);
    } else {
      expect(temporariesBefore).toEqual([]);
      expect(lstatSync(final).nlink).toBe(1);
    }

    const recovered = store(value).recover(value.request, value.processIdentity, value.providerKeys);
    expect(recovered?.settlementCallId).toBe(value.callId);
    expect(readdirSync(directory).filter((leaf) => leaf.startsWith(".tmp-"))).toEqual([]);
    expect(lstatSync(final).nlink).toBe(1);
  });

  it("refuses a truncated receipt, a replaced transcript, and missing scope proof", () => {
    const truncated = harness();
    store(truncated).record(truncated.request, truncated.processIdentity, truncated.callId, truncated.transcript, truncated.providerKeys);
    const receipt = resolve(truncated.runtime, "worker-recovery", `${multiRepositoryWorkerRecoveryKey(truncated.request)}.json`);
    writeFileSync(receipt, '{"schemaVersion":1', "utf8");
    expect(() => store(truncated).recover(truncated.request, truncated.processIdentity, truncated.providerKeys)).toThrow(/receipt JSON|receipt/u);

    const replaced = harness();
    store(replaced).record(replaced.request, replaced.processIdentity, replaced.callId, replaced.transcript, replaced.providerKeys);
    renameSync(replaced.transcript, `${replaced.transcript}.preserved`);
    writeFileSync(replaced.transcript, "replacement\n", { mode: 0o600 });
    expect(() => store(replaced).recover(replaced.request, replaced.processIdentity, replaced.providerKeys)).toThrow(/conflicts|inode|transcript/u);

    const missingScope = harness({ badScopeProof: true });
    expect(() => store(missingScope).recover(missingScope.request, missingScope.processIdentity, missingScope.providerKeys)).toThrow(/scope empty/u);

    const wrongScope = harness({ scopePid: 424243 });
    expect(() => store(wrongScope).recover(wrongScope.request, wrongScope.processIdentity, wrongScope.providerKeys)).toThrow(/scope empty/u);
  });

  it("refuses an in-place transcript mutation even when its inode and byte count are unchanged", () => {
    const value = harness();
    store(value).record(value.request, value.processIdentity, value.callId, value.transcript, value.providerKeys);
    const original = readFileSync(value.transcript);
    const changed = Buffer.from(original);
    changed[0] = changed[0] === 0x7b ? 0x5b : 0x7b;
    writeFileSync(value.transcript, changed);
    expect(lstatSync(value.transcript).size).toBe(original.length);
    expect(() => store(value).recover(value.request, value.processIdentity, value.providerKeys)).toThrow(/digest/u);
  });

  it("refuses receipts replayed across task, generation, and lease fences", () => {
    const value = harness();
    store(value).record(value.request, value.processIdentity, value.callId, value.transcript, value.providerKeys);
    const original = resolve(value.runtime, "worker-recovery", `${multiRepositoryWorkerRecoveryKey(value.request)}.json`);
    const variants = [
      request({ taskId: "task-b" }),
      request({ taskGeneration: value.request.taskGeneration + 1 }),
      request({ leaseToken: "lease-b" })
    ];
    for (const changed of variants) {
      const forgedPath = resolve(value.runtime, "worker-recovery", `${multiRepositoryWorkerRecoveryKey(changed)}.json`);
      copyFileSync(original, forgedPath);
      chmodSync(forgedPath, 0o600);
      expect(() => store(value).recover(changed, value.processIdentity, value.providerKeys)).toThrow(/without its ledger attestation|unavailable provider route|exact request/u);
    }
  });

  it("discards a partial protocol temp but refuses symlink, foreign, and hardlinked artifacts", () => {
    const partial = harness();
    const partialDirectory = resolve(partial.runtime, "worker-recovery");
    mkdirSync(partialDirectory, { mode: 0o700 });
    const partialKey = multiRepositoryWorkerRecoveryKey(partial.request);
    writeFileSync(resolve(partialDirectory, `.tmp-${partialKey}-${"a".repeat(32)}`), "{", { mode: 0o600 });
    expect(store(partial).recover(partial.request, partial.processIdentity, partial.providerKeys)?.settlementCallId).toBe(partial.callId);
    expect(readdirSync(partialDirectory).filter((leaf) => leaf.startsWith(".tmp-"))).toEqual([]);

    const linked = harness();
    store(linked).record(linked.request, linked.processIdentity, linked.callId, linked.transcript, linked.providerKeys);
    const linkedDirectory = resolve(linked.runtime, "worker-recovery");
    const linkedFinal = resolve(linkedDirectory, `${multiRepositoryWorkerRecoveryKey(linked.request)}.json`);
    linkSync(linkedFinal, resolve(linkedDirectory, "foreign-hardlink"));
    expect(() => store(linked).recover(linked.request, linked.processIdentity, linked.providerKeys)).toThrow(/foreign|linked/u);

    const symlinked = harness();
    const symlinkDirectory = resolve(symlinked.runtime, "worker-recovery");
    mkdirSync(symlinkDirectory, { mode: 0o700 });
    symlinkSync(symlinked.transcript, resolve(symlinkDirectory, `${multiRepositoryWorkerRecoveryKey(symlinked.request)}.json`));
    expect(() => store(symlinked).recover(symlinked.request, symlinked.processIdentity, symlinked.providerKeys)).toThrow(/foreign|linked/u);

    const foreign = harness();
    store(foreign).record(foreign.request, foreign.processIdentity, foreign.callId, foreign.transcript, foreign.providerKeys);
    const foreignDirectory = resolve(foreign.runtime, "worker-recovery");
    const foreignKey = multiRepositoryWorkerRecoveryKey(foreign.request);
    writeFileSync(resolve(foreignDirectory, `.tmp-${foreignKey}-${"b".repeat(32)}`), "foreign", { mode: 0o600 });
    expect(() => store(foreign).recover(foreign.request, foreign.processIdentity, foreign.providerKeys)).toThrow(/foreign|linked|identit/u);
  });

  it("will not adopt evidence while the predecessor is live or its liveness is unknown", () => {
    const value = harness();
    expect(() => store(value, "alive-match").recover(value.request, value.processIdentity, value.providerKeys)).toThrow(/still alive/u);
    expect(() => store(value, "unavailable").recover(value.request, value.processIdentity, value.providerKeys)).toThrow(/liveness is unavailable/u);
  });
});

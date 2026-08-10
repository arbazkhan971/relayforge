import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { opencodeAdapterDescriptor } from "../src/adapters/builtins/opencode.js";
import { piAdapterDescriptor } from "../src/adapters/builtins/pi.js";
import {
  adapterEvidenceIdentity,
  LEDGER_LEAF,
  openLedger,
  validateAdapterCallIdentity,
  validateBinding,
  type CallBinding,
  type LedgerKernelAccess
} from "../src/ledger.js";
import { settleCompletedCall, type CompletedChildCall } from "../src/settlement-kernel.js";
import { reapProofOf, scopeIdOf, type ScopeRef } from "../src/scope.js";
import {
  StdoutStream,
  createAdapterCallIdentity,
  type AdapterCallIdentity
} from "../src/streaming.js";
import {
  PI_FIXTURE_PROMPT_ID,
  PI_FIXTURE_SESSION,
  piTranscript
} from "./fixtures/adapters/pi-rpc.js";

const ROOT = resolve("tests/.tmp-adapter-settlement");
mkdirSync(ROOT, { recursive: true, mode: 0o700 });
chmodSync(ROOT, 0o700);
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const STDIN = Buffer.from("bounded prompt\n", "utf8");
const SCOPE: ScopeRef = { backend: "pgid", pid: 987_654_321 };
const ACP_SESSION = "settlement-session";
const ACP_REQUEST = "settlement-prompt";

function sha(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function binding(adapter: AdapterCallIdentity, callId = "adapter-call"): CallBinding {
  return {
    runNonce: randomBytes(32).toString("hex"),
    callNonce: randomBytes(16).toString("hex"),
    callId,
    reservationId: randomBytes(16).toString("hex"),
    routeEpoch: 1,
    provider: String(adapter.replay.adapterId),
    model: "test-model",
    attempt: 0,
    intentSha256: sha(`intent:${callId}`),
    stdinSha256: sha(STDIN),
    stdinBytes: STDIN.length,
    adapter
  };
}

function acpCostTranscript(): Buffer {
  const records = [
    {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: ACP_SESSION,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "message-1",
          content: { type: "text", text: "done" }
        }
      }
    },
    {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: ACP_SESSION,
        update: {
          sessionUpdate: "usage_update",
          used: 50,
          size: 1000,
          cost: { amount: 0.125, currency: "USD" }
        }
      }
    },
    { jsonrpc: "2.0", id: ACP_REQUEST, result: { stopReason: "end_turn" } }
  ];
  return Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

function capturedCall(root: string, adapter: AdapterCallIdentity, transcript: Buffer): CompletedChildCall {
  const stream = new StdoutStream({ maxFrameBytes: 32 * 1024 * 1024, tailCap: 1024, adapter });
  for (let offset = 0; offset < transcript.length; offset += 7) {
    stream.push(transcript.subarray(offset, Math.min(transcript.length, offset + 7)));
  }
  const outcome = stream.finish();
  const path = join(root, `${randomBytes(8).toString("hex")}.jsonl`);
  writeFileSync(path, transcript, { mode: 0o600 });
  chmodSync(path, 0o600);
  return {
    code: 0,
    transportOk: true,
    stdinComplete: true,
    scopeTrusted: true,
    scopeId: scopeIdOf(SCOPE),
    scopeReaped: true,
    scopeReapProof: reapProofOf(SCOPE),
    transcriptPath: path,
    transcriptSha256: sha(transcript),
    transcriptBytes: transcript.length,
    adapterIdentity: outcome.adapterIdentity,
    adapterResult: outcome.adapterResult,
    framingFatal: outcome.fatal
  };
}

function access(root: string) {
  let status = { settled: false, costTrusted: false, fallbackAuthorized: false };
  const settlements: Array<{ kind: "trusted" | "fallback" | "uncertain"; draft?: unknown }> = [];
  const value: LedgerKernelAccess = {
    transcriptRoot: root,
    scopeAlive: () => false,
    attestAndSettle: (_bind, draft) => {
      settlements.push({ kind: "trusted", draft });
      status = { settled: true, costTrusted: true, fallbackAuthorized: false };
    },
    attestFallbackAndSettle: (_bind, draft) => {
      settlements.push({ kind: "fallback", draft });
      status = { settled: true, costTrusted: false, fallbackAuthorized: true };
    },
    settleUncertain: () => {
      settlements.push({ kind: "uncertain" });
      status = { settled: true, costTrusted: false, fallbackAuthorized: false };
    },
    settlementOf: () => status
  };
  return { value, settlements };
}

describe("adapter-bound settlement replay", () => {
  it("replays ACP from durable bytes and derives trusted cost under the exact adapter identity", () => {
    const root = mkdtempSync(join(ROOT, "trusted-"));
    chmodSync(root, 0o700);
    const adapter = createAdapterCallIdentity(opencodeAdapterDescriptor, "1", {
      kind: "acp-v1",
      sessionId: ACP_SESSION,
      promptRequestId: ACP_REQUEST
    });
    const bind = binding(adapter);
    const result = capturedCall(root, adapter, acpCostTranscript());
    const kernel = access(root);

    expect(settleCompletedCall(kernel.value, { bind, stdinDelivered: STDIN, result })).toEqual({
      kind: "trusted",
      usd: 0.125,
      usdNano: "125000000"
    });
    expect(kernel.settlements).toHaveLength(1);
    expect(kernel.settlements[0]).toMatchObject({
      kind: "trusted",
      draft: { providerKind: adapterEvidenceIdentity(adapter), usdNano: "125000000" }
    });
    expect(kernel.settlements.some((entry) => entry.kind === "fallback")).toBe(false);
  });

  it("fails closed before replay when live grammar or shipped descriptor evidence mismatches", () => {
    const root = mkdtempSync(join(ROOT, "mismatch-"));
    chmodSync(root, 0o700);
    const adapter = createAdapterCallIdentity(opencodeAdapterDescriptor, "1", {
      kind: "acp-v1",
      sessionId: ACP_SESSION,
      promptRequestId: ACP_REQUEST
    });
    const foreign = createAdapterCallIdentity(opencodeAdapterDescriptor, "1", {
      kind: "acp-v1",
      sessionId: ACP_SESSION,
      promptRequestId: "foreign-request"
    });
    const result = capturedCall(root, foreign, acpCostTranscript());
    const first = access(root);
    expect(settleCompletedCall(first.value, { bind: binding(adapter), stdinDelivered: STDIN, result })).toMatchObject({
      kind: "uncertain",
      reason: expect.stringMatching(/does not match the reservation/)
    });
    expect(first.settlements.map((entry) => entry.kind)).toEqual(["uncertain"]);

    const drifted = {
      replay: { ...adapter.replay, normalizer: { ...adapter.replay.normalizer, version: 2 } },
      correlation: adapter.correlation
    } as AdapterCallIdentity;
    const second = access(root);
    expect(settleCompletedCall(second.value, {
      bind: binding(drifted, "drifted-binding"),
      stdinDelivered: STDIN,
      result: capturedCall(root, adapter, acpCostTranscript())
    })).toMatchObject({ kind: "uncertain", reason: expect.stringMatching(/unsupported adapter replay grammar/) });
    expect(second.settlements.map((entry) => entry.kind)).toEqual(["uncertain"]);
  });

  it("rejects transcript/live-result disagreement and preserves missing Pi cost as unknown", () => {
    const acpRoot = mkdtempSync(join(ROOT, "result-drift-"));
    chmodSync(acpRoot, 0o700);
    const acp = createAdapterCallIdentity(opencodeAdapterDescriptor, "1", {
      kind: "acp-v1",
      sessionId: ACP_SESSION,
      promptRequestId: ACP_REQUEST
    });
    const changed = capturedCall(acpRoot, acp, acpCostTranscript());
    if (!changed.adapterResult || changed.adapterResult.status === "uncertain") throw new Error("invalid ACP fixture");
    changed.adapterResult = { ...changed.adapterResult, finalText: "forged live text" };
    const first = access(acpRoot);
    expect(settleCompletedCall(first.value, { bind: binding(acp), stdinDelivered: STDIN, result: changed })).toMatchObject({
      kind: "uncertain",
      reason: expect.stringMatching(/disagrees with the live codec result/)
    });

    const piRoot = mkdtempSync(join(ROOT, "pi-unknown-"));
    chmodSync(piRoot, 0o700);
    const pi = createAdapterCallIdentity(piAdapterDescriptor, "pi-rpc-v1", {
      kind: "pi-rpc",
      sessionId: PI_FIXTURE_SESSION,
      promptRequestId: PI_FIXTURE_PROMPT_ID
    });
    const second = access(piRoot);
    expect(settleCompletedCall(second.value, {
      bind: binding(pi, "pi-no-cost"),
      stdinDelivered: STDIN,
      result: capturedCall(piRoot, pi, piTranscript())
    })).toEqual({ kind: "uncertain", reason: "the structured adapter reported no durable USD cost" });
    expect(second.settlements.map((entry) => entry.kind)).toEqual(["uncertain"]);
  });

  it("makes the readable adapter binding part of ledger reservation identity", () => {
    const root = mkdtempSync(join(ROOT, "ledger-binding-"));
    chmodSync(root, 0o700);
    const board = join(root, "board");
    mkdirSync(board, { mode: 0o700 });
    const adapter = createAdapterCallIdentity(opencodeAdapterDescriptor, "1", {
      kind: "acp-v1",
      sessionId: ACP_SESSION,
      promptRequestId: ACP_REQUEST
    });
    const bind = binding(adapter, "ledger-adapter-call");
    expect(validateAdapterCallIdentity(adapter)).toBeUndefined();
    expect(validateBinding(bind)).toBeUndefined();
    expect(validateAdapterCallIdentity({ ...adapter, extra: true })).toMatch(/invalid binding adapter/);

    const ledger = openLedger({ dir: board, runNonce: bind.runNonce, transcriptRoot: root, groupAlive: () => false });
    try {
      expect(ledger.reserve(bind, 0.5, 10)).toBe(true);
      const foreign = createAdapterCallIdentity(opencodeAdapterDescriptor, "1", {
        kind: "acp-v1",
        sessionId: ACP_SESSION,
        promptRequestId: "foreign-request"
      });
      expect(() => ledger.settleUncertain({ ...bind, adapter: foreign })).toThrow(/adapter replay identity does not match/);
      ledger.settleUncertain(bind);
      expect(ledger.settlementOf(bind.callId)).toEqual({ settled: true, costTrusted: false, fallbackAuthorized: false });
      const terminal = ledger.terminalSettlementEvidenceOf(bind.callId);
      expect(terminal).toMatchObject({
        bind: { callId: bind.callId, adapter },
        costAuthority: "unknown",
        fallbackAuthorized: false,
        recordSha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
      });
      expect(Object.isFrozen(terminal)).toBe(true);
      expect(ledger.terminalSettlementEvidenceOf("not-reserved")).toBeUndefined();
    } finally {
      ledger.close();
    }
  });

  it("MAC-binds the exact adapter replay digest and preserves it across ledger reopen", () => {
    const root = mkdtempSync(join(ROOT, "durable-adapter-"));
    chmodSync(root, 0o700);
    const board = join(root, "board");
    mkdirSync(board, { mode: 0o700 });
    const adapter = createAdapterCallIdentity(opencodeAdapterDescriptor, "1", {
      kind: "acp-v1",
      sessionId: ACP_SESSION,
      promptRequestId: ACP_REQUEST
    });
    const bind = binding(adapter, "durable-adapter-call");
    const ledger = openLedger({
      dir: board,
      runNonce: bind.runNonce,
      transcriptRoot: root,
      scopeAlive: () => false,
      strongScopeAvailable: false
    });
    expect(ledger.reserve(bind, 0.5, 10)).toBe(true);
    expect(ledger.settleCompleted({
      bind,
      stdinDelivered: STDIN,
      result: capturedCall(root, adapter, acpCostTranscript())
    })).toEqual({ kind: "trusted", usd: 0.125, usdNano: "125000000" });
    expect(ledger.settlementOf(bind.callId).costTrusted).toBe(true);
    const terminalDigest = ledger.terminalSettlementEvidenceOf(bind.callId)?.recordSha256;
    expect(ledger.terminalSettlementEvidenceOf(bind.callId)).toMatchObject({
      costAuthority: "trusted",
      fallbackAuthorized: false,
      recordSha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    ledger.close();

    const records = readFileSync(join(board, LEDGER_LEAF), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records[1].data.bind.adapter).toEqual(adapter);
    expect(records[1].data.attest.payload.providerKind).toBe(adapterEvidenceIdentity(adapter));

    const reopened = openLedger({
      dir: board,
      runNonce: bind.runNonce,
      transcriptRoot: root,
      scopeAlive: () => false,
      strongScopeAvailable: false
    });
    try {
      expect(reopened.settlementOf(bind.callId)).toEqual({ settled: true, costTrusted: true, fallbackAuthorized: false });
      expect(reopened.terminalSettlementEvidenceOf(bind.callId)?.recordSha256).toBe(terminalDigest);
      expect(reopened.effectiveSpend()).toBe(0.125);
    } finally {
      reopened.close();
    }
  });
});

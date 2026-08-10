import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AcpCancelStateMachine,
  AcpV1TurnCodec,
  decodeAcpInitializeResponse,
  decodeAcpNewSessionResponse,
  serializeAcpCancel,
  serializeAcpInitialize,
  serializeAcpNewSession,
  serializeAcpPermissionResponse,
  serializeAcpPrompt
} from "../src/adapters/acp-v1.js";
import { ADAPTER_CODEC_LIMITS, BoundedJsonlFramer, type NormalizedAdapterEvent } from "../src/adapters/codec.js";
import {
  ACP_FIXTURE_PROMPT_ID,
  ACP_FIXTURE_SESSION,
  ACP_SUCCESS_RECORDS,
  acpTranscript
} from "./fixtures/adapters/acp-v1.js";

function run(
  records: readonly Readonly<Record<string, unknown>>[],
  chunkSizes: readonly number[] = [Number.MAX_SAFE_INTEGER]
) {
  const events: NormalizedAdapterEvent[] = [];
  const codec = new AcpV1TurnCodec({
    sessionId: ACP_FIXTURE_SESSION,
    promptRequestId: ACP_FIXTURE_PROMPT_ID,
    onEvent: (event) => events.push(event)
  });
  const framer = new BoundedJsonlFramer((frame) => codec.push(frame), {
    maxFrameBytes: 16 * 1024,
    maxTotalBytes: 1024 * 1024,
    maxFrames: 1024
  });
  const transcript = acpTranscript(records);
  let offset = 0;
  let chunkIndex = 0;
  while (offset < transcript.length) {
    const size = chunkSizes[chunkIndex % chunkSizes.length] ?? transcript.length;
    const end = Math.min(transcript.length, offset + size);
    framer.push(transcript.subarray(offset, end));
    offset = end;
    chunkIndex += 1;
  }
  framer.finish();
  return { events, result: codec.finish(), fatal: framer.fatal(), transcript, codec };
}

function promptTerminal(stopReason: string, extra: Record<string, unknown> = {}): Readonly<Record<string, unknown>> {
  return { jsonrpc: "2.0", id: ACP_FIXTURE_PROMPT_ID, result: { stopReason, ...extra } };
}

describe("ACP v1 serialization", () => {
  it("serializes exact JSON-RPC v1 initialize/session/prompt/cancel records", () => {
    expect(serializeAcpInitialize({ requestId: 1, clientName: "relayforge", clientVersion: "1.0.0" }).toString()).toBe(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientInfo":{"name":"relayforge","version":"1.0.0"},"clientCapabilities":{}}}\n'
    );
    expect(JSON.parse(serializeAcpNewSession({ requestId: "new-1", cwd: "/workspace" }).toString())).toEqual({
      jsonrpc: "2.0",
      id: "new-1",
      method: "session/new",
      params: { cwd: "/workspace", mcpServers: [] }
    });
    expect(JSON.parse(serializeAcpPrompt({ requestId: "p-1", sessionId: "s-1", text: "do it" }).toString())).toEqual({
      jsonrpc: "2.0",
      id: "p-1",
      method: "session/prompt",
      params: { sessionId: "s-1", prompt: [{ type: "text", text: "do it" }] }
    });
    expect(serializeAcpCancel("s-1").toString()).toBe(
      '{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"s-1"}}\n'
    );
    expect(serializeAcpPermissionResponse({
      requestId: "permission-1",
      outcome: "allow-once",
      allowOnceOptionId: "allow-once-1"
    }).toString()).toBe(
      '{"jsonrpc":"2.0","id":"permission-1","result":{"outcome":{"outcome":"selected","optionId":"allow-once-1"}}}\n'
    );
    expect(serializeAcpPermissionResponse({ requestId: "permission-2", outcome: "cancelled" }).toString()).toBe(
      '{"jsonrpc":"2.0","id":"permission-2","result":{"outcome":{"outcome":"cancelled"}}}\n'
    );
  });

  it("accepts only correlated ACP v1 handshake and session identities", () => {
    const accepted = (record: Readonly<Record<string, unknown>>) => ({
      raw: Buffer.from(JSON.stringify(record)),
      index: 0,
      offset: 0,
      terminated: true
    });
    const initialize = { jsonrpc: "2.0", id: "init-1", result: { protocolVersion: 1, agentInfo: { name: "OpenCode", version: "1.18.15" } } };
    expect(decodeAcpInitializeResponse(accepted(initialize), "init-1")).toMatchObject({
      status: "valid",
      value: { protocolVersion: "1", agentName: "OpenCode", agentVersion: "1.18.15" }
    });
    expect(decodeAcpInitializeResponse(accepted({ ...initialize, id: "foreign" }), "init-1")).toMatchObject({ status: "invalid", code: "foreign-correlation" });
    expect(decodeAcpInitializeResponse(accepted({ ...initialize, result: { protocolVersion: 2 } }), "init-1")).toMatchObject({ status: "invalid", code: "wire-unsupported" });
    expect(decodeAcpInitializeResponse(accepted({ jsonrpc: "2.0", id: "init-1", error: { code: -1 } }), "init-1")).toMatchObject({ status: "invalid", code: "rpc-error" });

    const session = { jsonrpc: "2.0", id: "new-1", result: { sessionId: ACP_FIXTURE_SESSION } };
    expect(decodeAcpNewSessionResponse(accepted(session), "new-1")).toMatchObject({ status: "valid", value: { sessionId: ACP_FIXTURE_SESSION } });
    expect(decodeAcpNewSessionResponse(accepted({ ...session, result: { sessionId: "" } }), "new-1")).toMatchObject({ status: "invalid", code: "malformed-result" });
  });

  it("keeps prompt content in bounded stdin bytes and rejects invalid identities/content", () => {
    expect(() => serializeAcpPrompt({ requestId: "p-1", sessionId: "s-1", text: "x".repeat(ADAPTER_CODEC_LIMITS.maxPromptBytes) })).toThrow(/exceeds/);
    for (const input of [
      { requestId: "", sessionId: "s", text: "ok" },
      { requestId: "p", sessionId: "", text: "ok" },
      { requestId: "p", sessionId: "s", text: "bad\0prompt" }
    ]) {
      expect(() => serializeAcpPrompt(input)).toThrow();
    }
  });
});

describe("ACP v1 normalized turn codec", () => {
  it("normalizes correlated text, thought, tool, usage, and one terminal frame", () => {
    const { events, result, fatal, transcript } = run(ACP_SUCCESS_RECORDS, [1, 2, 7, 3]);
    expect(fatal).toBeUndefined();
    expect(events.map((event) => event.kind)).toEqual([
      "thought-delta",
      "assistant-delta",
      "tool",
      "tool",
      "usage",
      "usage",
      "assistant-final"
    ]);
    expect(events.filter((event) => event.kind === "tool").map((event) => event.state)).toEqual(["proposed", "completed"]);
    expect(events.filter((event) => event.kind === "usage").map((event) => event.usage.source)).toEqual([
      "usage-update",
      "terminal-response"
    ]);
    expect(result).toMatchObject({
      status: "success",
      finalText: "done",
      explicitLimit: false,
      usage: { source: "terminal-response", inputTokens: 10, outputTokens: 5, thoughtTokens: 3 }
    });
    if (result.status === "uncertain") throw new Error("unexpected uncertainty");
    const terminalRaw = Buffer.from(JSON.stringify(ACP_SUCCESS_RECORDS.at(-1)));
    expect(result.terminalFrame.sha256).toBe(createHash("sha256").update(terminalRaw).digest("hex"));
    expect(transcript.subarray(result.terminalFrame.offset, result.terminalFrame.offset + result.terminalFrame.bytes)).toEqual(terminalRaw);
  });

  it("replays byte-for-byte identically across unrelated chunk boundaries", () => {
    const one = run(ACP_SUCCESS_RECORDS, [1]);
    const two = run(ACP_SUCCESS_RECORDS, [5, 19, 2, 101]);
    expect(two.result).toEqual(one.result);
    expect(two.events).toEqual(one.events);
    expect(one.codec.finish()).toBe(one.result);
  });

  it("preserves absent usage as unknown rather than zero", () => {
    const { result, events } = run([promptTerminal("end_turn")]);
    expect(result).toMatchObject({ status: "success", finalText: "", explicitLimit: false });
    expect("usage" in result).toBe(false);
    expect(events.some((event) => event.kind === "usage")).toBe(false);
  });

  it("treats context usage as informational and never as paid-fallback authority", () => {
    const records = [
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: ACP_FIXTURE_SESSION,
          update: { sessionUpdate: "usage_update", used: 99, size: 100 }
        }
      },
      promptTerminal("refusal")
    ];
    const { result, events } = run(records);
    expect(result).toMatchObject({ status: "failure", explicitLimit: false });
    expect(events.find((event) => event.kind === "usage")).toMatchObject({
      usage: { contextUsed: 99, contextSize: 100 }
    });
  });

  it("rejects missing, duplicate, unknown, and post-terminal evidence", () => {
    expect(run(ACP_SUCCESS_RECORDS.slice(0, -1)).result).toMatchObject({ status: "uncertain", code: "missing-terminal" });
    expect(run([promptTerminal("end_turn"), promptTerminal("end_turn")]).result).toMatchObject({
      status: "uncertain",
      code: "duplicate-terminal"
    });
    expect(run([promptTerminal("future_stop")]).result).toMatchObject({ status: "uncertain", code: "protocol-drift" });
    expect(run([
      promptTerminal("end_turn"),
      { jsonrpc: "2.0", method: "session/update", params: { sessionId: ACP_FIXTURE_SESSION, update: { sessionUpdate: "future" } } }
    ]).result).toMatchObject({ status: "uncertain", code: "post-terminal-event" });
  });

  it("fails closed on foreign request/session correlation", () => {
    expect(run([{ jsonrpc: "2.0", id: "other", result: { stopReason: "end_turn" } }]).result).toMatchObject({
      status: "uncertain",
      code: "foreign-correlation"
    });
    expect(run([{
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "foreign",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "spoof" } }
      }
    }, promptTerminal("end_turn")]).result).toMatchObject({ status: "uncertain", code: "foreign-correlation", finalText: "" });
  });

  it("keeps unknown non-terminals bounded and non-authoritative", () => {
    const unknown = Array.from({ length: ADAPTER_CODEC_LIMITS.maxDiagnosticEvents + 2 }, (_, index) => ({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: ACP_FIXTURE_SESSION, update: { sessionUpdate: `future-${index}` } }
    }));
    const { result, events } = run([...unknown, promptTerminal("end_turn")]);
    expect(result).toMatchObject({ status: "success", diagnosticsDropped: 2, explicitLimit: false });
    expect(events.filter((event) => event.kind === "diagnostic")).toHaveLength(ADAPTER_CODEC_LIMITS.maxDiagnosticEvents);
  });

  it("makes malformed frames and accounting uncertain without throwing", () => {
    const codec = new AcpV1TurnCodec({ sessionId: ACP_FIXTURE_SESSION, promptRequestId: ACP_FIXTURE_PROMPT_ID });
    expect(() => codec.push({ raw: Buffer.from("[]"), offset: 0, index: 0, terminated: true })).not.toThrow();
    expect(codec.finish()).toMatchObject({ status: "uncertain", code: "malformed-frame" });

    for (const update of [
      { sessionUpdate: "usage_update", used: -1, size: 100 },
      { sessionUpdate: "usage_update", used: 10.5, size: 100 },
      { sessionUpdate: "usage_update", used: 101, size: 100 },
      { sessionUpdate: "usage_update", used: 10, size: 100, cost: { amount: -1, currency: "USD" } },
      { sessionUpdate: "usage_update", used: 10, size: 100, cost: { amount: 1, currency: "EUR" } }
    ]) {
      expect(run([{
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: ACP_FIXTURE_SESSION, update }
      }, promptTerminal("end_turn")]).result).toMatchObject({ status: "uncertain", code: "malformed-accounting" });
    }
  });

  it("normalizes a correlated JSON-RPC error as ordinary failure, never textual limit authority", () => {
    const { result, events } = run([{
      jsonrpc: "2.0",
      id: ACP_FIXTURE_PROMPT_ID,
      error: { code: -32000, message: "rate quota usage limit; please retry" }
    }]);
    expect(result).toMatchObject({ status: "failure", explicitLimit: false });
    expect(events).toContainEqual(expect.objectContaining({ kind: "error", category: "provider" }));
  });

  it("normalizes permission requests only for the active session", () => {
    const requested = {
      jsonrpc: "2.0",
      id: "permission-1",
      method: "session/request_permission",
      params: {
        sessionId: ACP_FIXTURE_SESSION,
        toolCall: { toolCallId: "call-1" },
        options: [
          { optionId: "persist", name: "Always", kind: "allow_always" },
          { optionId: "once", name: "Once", kind: "allow_once" }
        ]
      }
    };
    expect(run([requested, promptTerminal("end_turn")]).events).toContainEqual(expect.objectContaining({
      kind: "permission",
      permissionId: "permission-1",
      allowOnceOptionId: "once",
      state: "requested"
    }));
    expect(run([{ ...requested, params: { ...(requested.params as object), sessionId: "foreign" } }, promptTerminal("end_turn")]).result).toMatchObject({
      status: "uncertain",
      code: "foreign-correlation"
    });
  });
});

describe("ACP cancellation race", () => {
  it("emits the native notification exactly once", () => {
    const cancel = new AcpCancelStateMachine(ACP_FIXTURE_SESSION);
    const first = cancel.request();
    const second = cancel.request();
    expect(first.accepted).toBe(true);
    expect(first.outbound?.toString()).toBe(serializeAcpCancel(ACP_FIXTURE_SESSION).toString());
    expect(first.snapshot).toMatchObject({ phase: "sent", sendCount: 1 });
    expect(second).toMatchObject({ accepted: true, snapshot: { phase: "sent", sendCount: 1 } });
    expect(second.outbound).toBeUndefined();
  });

  it("distinguishes cancelled, completion-won, and escalation races", () => {
    const cancelled = new AcpCancelStateMachine(ACP_FIXTURE_SESSION);
    cancelled.request();
    expect(cancelled.observeTerminal("cancelled").phase).toBe("terminal-cancelled");

    const completed = new AcpCancelStateMachine(ACP_FIXTURE_SESSION);
    completed.request();
    expect(completed.observeTerminal("success")).toMatchObject({ phase: "completion-won", terminalOutcome: "success" });

    const hung = new AcpCancelStateMachine(ACP_FIXTURE_SESSION);
    hung.request();
    expect(hung.expire().phase).toBe("escalation-required");
  });
});

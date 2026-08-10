import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PiCancelStateMachine,
  PiRpcTurnCodec,
  decodePiLastAssistantTextResponse,
  decodePiSessionStatsResponse,
  decodePiStateResponse,
  derivePiTurnUsage,
  piToolTitleFromArgs,
  serializePiAbort,
  serializePiGetLastAssistantText,
  serializePiGetSessionStats,
  serializePiGetState,
  serializePiPrompt
} from "../src/adapters/pi-rpc.js";
import { BoundedJsonlFramer, type CodecFrame, type NormalizedAdapterEvent } from "../src/adapters/codec.js";
import {
  PI_FIXTURE_PROMPT_ID,
  PI_FIXTURE_SESSION,
  PI_STATS_RECORD,
  PI_SUCCESS_RECORDS,
  piTranscript
} from "./fixtures/adapters/pi-rpc.js";

function frame(record: Readonly<Record<string, unknown>>, index = 0, offset = 0): CodecFrame {
  return { raw: Buffer.from(JSON.stringify(record)), index, offset, terminated: true };
}

function run(
  records: readonly Readonly<Record<string, unknown>>[],
  options: { chunkSizes?: readonly number[]; cancelRequestId?: string } = {}
) {
  const events: NormalizedAdapterEvent[] = [];
  const codec = new PiRpcTurnCodec({
    promptRequestId: PI_FIXTURE_PROMPT_ID,
    sessionId: PI_FIXTURE_SESSION,
    onEvent: (event) => events.push(event)
  });
  if (options.cancelRequestId) codec.expectCancelResponse(options.cancelRequestId);
  const framer = new BoundedJsonlFramer((accepted) => codec.push(accepted), {
    maxFrameBytes: 32 * 1024,
    maxTotalBytes: 1024 * 1024,
    maxFrames: 1024
  });
  const transcript = piTranscript(records);
  const chunkSizes = options.chunkSizes ?? [Number.MAX_SAFE_INTEGER];
  let offset = 0;
  let chunk = 0;
  while (offset < transcript.length) {
    const end = Math.min(transcript.length, offset + (chunkSizes[chunk % chunkSizes.length] ?? transcript.length));
    framer.push(transcript.subarray(offset, end));
    offset = end;
    chunk += 1;
  }
  framer.finish();
  return { codec, events, result: codec.finish(), fatal: framer.fatal(), transcript };
}

function promptAccepted(): Readonly<Record<string, unknown>> {
  return { id: PI_FIXTURE_PROMPT_ID, type: "response", command: "prompt", success: true };
}

function assistantEnd(stopReason: string, text = "done"): Readonly<Record<string, unknown>> {
  return {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }], stopReason }
  };
}

describe("Pi RPC serialization", () => {
  it("serializes exact correlated prompt/state/stats/text/abort JSONL commands", () => {
    expect(serializePiPrompt({ requestId: "prompt-1", message: "do it" }).toString()).toBe(
      '{"id":"prompt-1","type":"prompt","message":"do it"}\n'
    );
    expect(serializePiPrompt({ requestId: "prompt-2", message: "steer", streamingBehavior: "steer" }).toString()).toBe(
      '{"id":"prompt-2","type":"prompt","message":"steer","streamingBehavior":"steer"}\n'
    );
    expect(serializePiGetState("state-1").toString()).toBe('{"id":"state-1","type":"get_state"}\n');
    expect(serializePiGetSessionStats("stats-1").toString()).toBe('{"id":"stats-1","type":"get_session_stats"}\n');
    expect(serializePiGetLastAssistantText("text-1").toString()).toBe('{"id":"text-1","type":"get_last_assistant_text"}\n');
    expect(serializePiAbort("abort-1").toString()).toBe('{"id":"abort-1","type":"abort"}\n');
  });

  it("rejects unbounded or malformed command values", () => {
    for (const action of [
      () => serializePiPrompt({ requestId: "", message: "ok" }),
      () => serializePiPrompt({ requestId: "p", message: "bad\0message" }),
      () => serializePiGetState("x".repeat(513)),
      () => serializePiAbort(42 as never)
    ]) expect(action).toThrow();
  });
});

describe("Pi behavioral handshake and cumulative accounting", () => {
  it("accepts only the exact correlated get_state behavioral response", () => {
    const valid = {
      id: "state-1",
      type: "response",
      command: "get_state",
      success: true,
      data: {
        sessionId: PI_FIXTURE_SESSION,
        thinkingLevel: "medium",
        isStreaming: false,
        isCompacting: false,
        steeringMode: "all",
        followUpMode: "one-at-a-time",
        autoCompactionEnabled: true,
        messageCount: 5,
        pendingMessageCount: 0
      }
    };
    expect(decodePiStateResponse(frame(valid), "state-1")).toMatchObject({
      status: "valid",
      value: { sessionId: PI_FIXTURE_SESSION, isStreaming: false, isCompacting: false, messageCount: 5 }
    });
    expect(decodePiStateResponse(frame({ ...valid, id: "foreign" }), "state-1")).toMatchObject({ status: "invalid", code: "foreign-correlation" });
    expect(decodePiStateResponse(frame({ ...valid, command: "prompt" }), "state-1")).toMatchObject({ status: "invalid", code: "command-mismatch" });
    expect(decodePiStateResponse(frame({ ...valid, success: false, error: "no" }), "state-1")).toMatchObject({ status: "invalid", code: "command-failed" });
    expect(decodePiStateResponse(frame({ ...valid, data: { ...(valid.data as object), isStreaming: "false" } }), "state-1")).toMatchObject({ status: "invalid", code: "malformed-data" });
  });

  it("decodes last-assistant text with exact correlation and explicit null", () => {
    const valid = { id: "text-1", type: "response", command: "get_last_assistant_text", success: true, data: { text: "final" } };
    expect(decodePiLastAssistantTextResponse(frame(valid), "text-1")).toMatchObject({ status: "valid", value: { text: "final" } });
    expect(decodePiLastAssistantTextResponse(frame({ ...valid, data: { text: null } }), "text-1")).toMatchObject({ status: "valid", value: { text: null } });
    expect(decodePiLastAssistantTextResponse(frame({ ...valid, id: "foreign" }), "text-1")).toMatchObject({ status: "invalid", code: "foreign-correlation" });
    expect(decodePiLastAssistantTextResponse(frame({ ...valid, data: { text: 0 } }), "text-1")).toMatchObject({ status: "invalid", code: "malformed-data" });
  });

  it("parses exact stats and derives per-turn deltas only within one session generation", () => {
    const endResult = decodePiSessionStatsResponse(frame(PI_STATS_RECORD), "stats-1", PI_FIXTURE_SESSION, 7);
    expect(endResult).toMatchObject({
      status: "valid",
      value: {
        sessionId: PI_FIXTURE_SESSION,
        sessionGeneration: 7,
        inputTokens: 50,
        outputTokens: 10,
        cachedReadTokens: 20,
        cachedWriteTokens: 5,
        totalTokens: 85,
        costUsd: 0.45,
        contextUsed: 60,
        contextSize: 200
      }
    });
    if (endResult.status === "invalid") throw new Error("unexpected invalid stats");
    const startRecord = {
      ...PI_STATS_RECORD,
      id: "stats-0",
      data: {
        ...PI_STATS_RECORD.data,
        tokens: { input: 10, output: 2, cacheRead: 5, cacheWrite: 1, total: 18 },
        cost: 0.1,
        contextUsage: { tokens: 20, contextWindow: 200, percent: 10 }
      }
    };
    const startResult = decodePiSessionStatsResponse(frame(startRecord), "stats-0", PI_FIXTURE_SESSION, 7);
    if (startResult.status === "invalid") throw new Error("unexpected invalid stats");
    expect(derivePiTurnUsage(startResult.value, endResult.value)).toEqual({
      source: "session-statistics",
      cumulative: false,
      inputTokens: 40,
      outputTokens: 8,
      cachedReadTokens: 15,
      cachedWriteTokens: 4,
      totalTokens: 67,
      costUsd: 0.35,
      contextUsed: 60,
      contextSize: 200
    });
    expect(derivePiTurnUsage(startResult.value, { ...endResult.value, sessionGeneration: 8 })).toBeUndefined();
    expect(derivePiTurnUsage(startResult.value, { ...endResult.value, sessionId: "foreign" })).toBeUndefined();
    expect(derivePiTurnUsage(endResult.value, startResult.value)).toBeUndefined();
  });

  it("preserves unknown post-compaction context tokens instead of inventing zero", () => {
    const recordWithUnknownContext = {
      ...PI_STATS_RECORD,
      data: { ...PI_STATS_RECORD.data, contextUsage: { tokens: null, contextWindow: 200_000, percent: null } }
    };
    const decoded = decodePiSessionStatsResponse(frame(recordWithUnknownContext), "stats-1", PI_FIXTURE_SESSION, 1);
    expect(decoded).toMatchObject({ status: "valid", value: { contextSize: 200_000 } });
    if (decoded.status === "invalid") throw new Error("unexpected invalid stats");
    expect("contextUsed" in decoded.value).toBe(false);
  });

  it("rejects foreign, negative, fractional, overflowing, inconsistent, and malformed stats", () => {
    const variants = [
      { ...PI_STATS_RECORD, id: "foreign" },
      { ...PI_STATS_RECORD, data: { ...PI_STATS_RECORD.data, sessionId: "foreign" } },
      { ...PI_STATS_RECORD, data: { ...PI_STATS_RECORD.data, cost: -1 } },
      { ...PI_STATS_RECORD, data: { ...PI_STATS_RECORD.data, tokens: { ...PI_STATS_RECORD.data.tokens, input: 1.5 } } },
      { ...PI_STATS_RECORD, data: { ...PI_STATS_RECORD.data, tokens: { ...PI_STATS_RECORD.data.tokens, output: Number.MAX_SAFE_INTEGER + 1 } } },
      { ...PI_STATS_RECORD, data: { ...PI_STATS_RECORD.data, tokens: { ...PI_STATS_RECORD.data.tokens, total: 86 } } },
      { ...PI_STATS_RECORD, data: { ...PI_STATS_RECORD.data, contextUsage: { tokens: 201, contextWindow: 200, percent: 101 } } }
    ];
    const expectedCodes = ["foreign-correlation", "foreign-correlation", "malformed-data", "malformed-data", "malformed-data", "malformed-data", "malformed-data"];
    variants.forEach((variant, index) => {
      expect(decodePiSessionStatsResponse(frame(variant), "stats-1", PI_FIXTURE_SESSION, 1)).toMatchObject({
        status: "invalid",
        code: expectedCodes[index]
      });
    });
  });
});

describe("Pi RPC normalized turn codec", () => {
  it("waits for acceptance and agent_settled, normalizing events without treating agent_end as terminal", () => {
    const { events, result, fatal, transcript } = run(PI_SUCCESS_RECORDS, { chunkSizes: [1, 4, 17, 2] });
    expect(fatal).toBeUndefined();
    expect(events.map((event) => event.kind)).toEqual([
      "session",
      "diagnostic",
      "thought-delta",
      "assistant-delta",
      "tool",
      "tool",
      "assistant-final",
      "diagnostic",
      "session"
    ]);
    expect(result).toMatchObject({ status: "success", finalText: "done", explicitLimit: false });
    if (result.status === "uncertain") throw new Error("unexpected uncertainty");
    const terminalRaw = Buffer.from(JSON.stringify(PI_SUCCESS_RECORDS.at(-1)));
    expect(result.terminalFrame.sha256).toBe(createHash("sha256").update(terminalRaw).digest("hex"));
    expect(transcript.subarray(result.terminalFrame.offset, result.terminalFrame.offset + result.terminalFrame.bytes)).toEqual(terminalRaw);
  });

  it("replays identically across chunk boundaries", () => {
    const bytewise = run(PI_SUCCESS_RECORDS, { chunkSizes: [1] });
    const mixed = run(PI_SUCCESS_RECORDS, { chunkSizes: [101, 3, 11] });
    expect(mixed.events).toEqual(bytewise.events);
    expect(mixed.result).toEqual(bytewise.result);
    expect(bytewise.codec.finish()).toBe(bytewise.result);
  });

  it("treats a correlated prompt rejection as one ordinary failure", () => {
    const { result, events } = run([{
      id: PI_FIXTURE_PROMPT_ID,
      type: "response",
      command: "prompt",
      success: false,
      error: "rate quota limit"
    }]);
    expect(result).toMatchObject({ status: "failure", finalText: "", explicitLimit: false });
    expect(events).toContainEqual(expect.objectContaining({ kind: "error", category: "provider" }));
  });

  it("rejects events before prompt acceptance and foreign responses", () => {
    expect(run([{ type: "agent_start" }, promptAccepted()]).result).toMatchObject({
      status: "uncertain",
      code: "prompt-not-accepted"
    });
    expect(run([{ id: "foreign", type: "response", command: "prompt", success: true }]).result).toMatchObject({
      status: "uncertain",
      code: "foreign-correlation"
    });
  });

  it("requires agent_settled plus a known final assistant terminal", () => {
    expect(run([promptAccepted(), assistantEnd("stop"), { type: "agent_end", messages: [], willRetry: false }]).result).toMatchObject({
      status: "uncertain",
      code: "missing-terminal"
    });
    expect(run([promptAccepted(), { type: "agent_settled" }]).result).toMatchObject({
      status: "uncertain",
      code: "missing-terminal"
    });
    expect(run([promptAccepted(), assistantEnd("future-stop"), { type: "agent_settled" }]).result).toMatchObject({
      status: "uncertain",
      code: "protocol-drift"
    });
  });

  it("rejects duplicate and post-terminal records", () => {
    expect(run([promptAccepted(), assistantEnd("stop"), { type: "agent_settled" }, { type: "agent_settled" }]).result).toMatchObject({
      status: "uncertain",
      code: "duplicate-terminal"
    });
    expect(run([promptAccepted(), assistantEnd("stop"), { type: "agent_settled" }, { type: "queue_update", steering: [], followUp: [] }]).result).toMatchObject({
      status: "uncertain",
      code: "post-terminal-event"
    });
  });

  it("maps final aborted/error/success stop reasons without textual limit inference", () => {
    expect(run([promptAccepted(), assistantEnd("aborted"), { type: "agent_settled" }]).result).toMatchObject({
      status: "cancelled",
      explicitLimit: false
    });
    expect(run([promptAccepted(), assistantEnd("error", "rate quota usage limit"), { type: "agent_settled" }]).result).toMatchObject({
      status: "failure",
      finalText: "rate quota usage limit",
      explicitLimit: false
    });
    expect(run([promptAccepted(), assistantEnd("length"), { type: "agent_settled" }]).result).toMatchObject({
      status: "success",
      explicitLimit: false
    });
  });

  it("lets a registered late abort response drain after normal completion without rewriting it", () => {
    const { result, events } = run([
      promptAccepted(),
      assistantEnd("stop"),
      { type: "agent_settled" },
      { id: "abort-1", type: "response", command: "abort", success: true }
    ], { cancelRequestId: "abort-1" });
    expect(result).toMatchObject({ status: "success", finalText: "done" });
    expect(events).toContainEqual(expect.objectContaining({ kind: "cancel", state: "cooperative-observed" }));
  });

  it("makes malformed JSON/tool/message shapes uncertain without throwing", () => {
    const codec = new PiRpcTurnCodec({ promptRequestId: PI_FIXTURE_PROMPT_ID, sessionId: PI_FIXTURE_SESSION });
    expect(() => codec.push({ raw: Buffer.from("null"), index: 0, offset: 0, terminated: true })).not.toThrow();
    expect(codec.finish()).toMatchObject({ status: "uncertain", code: "malformed-frame" });

    expect(run([promptAccepted(), { type: "tool_execution_end", toolCallId: "call", toolName: "read" }, assistantEnd("stop"), { type: "agent_settled" }]).result).toMatchObject({
      status: "uncertain",
      code: "protocol-drift"
    });
    expect(run([promptAccepted(), { type: "message_end", message: { role: "assistant", content: "bad", stopReason: "stop" } }, { type: "agent_settled" }]).result).toMatchObject({
      status: "uncertain",
      code: "protocol-drift"
    });
  });

  it("preserves bounded path/title from real-shaped Pi args.path and correlates start/end by toolCallId", () => {
    expect(piToolTitleFromArgs({ path: "reviewer-target.txt" })).toBe("reviewer-target.txt");
    expect(piToolTitleFromArgs({ file_path: "/tmp/ws/reviewer-target.txt" })).toBe("/tmp/ws/reviewer-target.txt");
    expect(piToolTitleFromArgs({ toolCallId: "opaque", name: "write" })).toBeUndefined();
    expect(piToolTitleFromArgs(undefined)).toBeUndefined();
    expect(piToolTitleFromArgs({ path: "bad\0path" })).toBeUndefined();

    const absoluteTarget = "/tmp/rf-char/workspace/reviewer-target.txt";
    const opaqueId = "call_a1b2c3d4e5f60718";
    const { events, result } = run([
      promptAccepted(),
      {
        type: "tool_execution_start",
        toolCallId: opaqueId,
        toolName: "write",
        args: { path: absoluteTarget }
      },
      {
        type: "tool_execution_update",
        toolCallId: opaqueId,
        toolName: "write",
        args: { path: absoluteTarget }
      },
      {
        type: "tool_execution_end",
        toolCallId: opaqueId,
        toolName: "write",
        // End frames intentionally omit args; title must reattach via toolCallId.
        result: { content: [{ type: "text", text: "denied" }] },
        isError: true
      },
      assistantEnd("stop", "reviewer mutation denied"),
      { type: "agent_settled" }
    ]);
    expect(result).toMatchObject({ status: "success", finalText: "reviewer mutation denied" });
    const toolEvents = events.filter((event) => event.kind === "tool");
    expect(toolEvents).toHaveLength(3);
    expect(toolEvents[0]).toMatchObject({
      kind: "tool",
      toolCallId: opaqueId,
      toolName: "write",
      state: "started",
      title: absoluteTarget
    });
    expect(toolEvents[1]).toMatchObject({
      kind: "tool",
      toolCallId: opaqueId,
      state: "progress",
      title: absoluteTarget
    });
    expect(toolEvents[2]).toMatchObject({
      kind: "tool",
      toolCallId: opaqueId,
      state: "failed",
      title: absoluteTarget
    });
  });

  it("does not invent a title from opaque toolCallIds when args.path is absent", () => {
    const { events, result } = run([
      promptAccepted(),
      {
        type: "tool_execution_start",
        toolCallId: "reviewer-write-reviewer-target.txt-opaque",
        toolName: "write"
      },
      {
        type: "tool_execution_end",
        toolCallId: "reviewer-write-reviewer-target.txt-opaque",
        toolName: "write",
        result: { content: [{ type: "text", text: "failed" }] },
        isError: true
      },
      assistantEnd("stop"),
      { type: "agent_settled" }
    ]);
    expect(result).toMatchObject({ status: "success" });
    const toolEvents = events.filter((event) => event.kind === "tool");
    expect(toolEvents).toHaveLength(2);
    for (const event of toolEvents) {
      expect(event).toMatchObject({ kind: "tool", toolCallId: "reviewer-write-reviewer-target.txt-opaque" });
      expect(event).not.toHaveProperty("title");
    }
  });

  it("preserves relative args.path titles from the success fixture records", () => {
    const { events } = run(PI_SUCCESS_RECORDS);
    const toolEvents = events.filter((event) => event.kind === "tool");
    expect(toolEvents).toEqual([
      expect.objectContaining({
        kind: "tool",
        toolCallId: "call-1",
        toolName: "read",
        state: "started",
        title: "README.md"
      }),
      expect.objectContaining({
        kind: "tool",
        toolCallId: "call-1",
        toolName: "read",
        state: "completed",
        title: "README.md"
      })
    ]);
  });
});

describe("Pi cancellation race", () => {
  it("serializes one abort request and never sends it twice", () => {
    const cancel = new PiCancelStateMachine("abort-1");
    const first = cancel.request();
    const second = cancel.request();
    expect(first.outbound?.toString()).toBe(serializePiAbort("abort-1").toString());
    expect(first.snapshot).toMatchObject({ phase: "sent", sendCount: 1 });
    expect(second.outbound).toBeUndefined();
    expect(second.snapshot.sendCount).toBe(1);
  });

  it("distinguishes cooperative cancellation, normal completion, and timeout escalation", () => {
    const cancelled = new PiCancelStateMachine("abort-1");
    cancelled.request();
    expect(cancelled.observeTerminal("cancelled").phase).toBe("terminal-cancelled");

    const complete = new PiCancelStateMachine("abort-2");
    complete.request();
    expect(complete.observeTerminal("success")).toMatchObject({ phase: "completion-won", terminalOutcome: "success" });

    const hung = new PiCancelStateMachine("abort-3");
    hung.request();
    expect(hung.expire().phase).toBe("escalation-required");
  });
});

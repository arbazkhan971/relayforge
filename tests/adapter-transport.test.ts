import { describe, expect, it } from "vitest";
import { opencodeAdapterDescriptor } from "../src/adapters/builtins/opencode.js";
import { piAdapterDescriptor } from "../src/adapters/builtins/pi.js";
import type { NormalizedAdapterEvent } from "../src/adapters/codec.js";
import {
  StdoutStream,
  createAdapterCallIdentity,
  resolveAdapterCallIdentity,
  sameAdapterCallIdentity
} from "../src/streaming.js";
import {
  ACP_FIXTURE_PROMPT_ID,
  ACP_FIXTURE_SESSION,
  acpTranscript
} from "./fixtures/adapters/acp-v1.js";
import {
  PI_FIXTURE_PROMPT_ID,
  PI_FIXTURE_SESSION,
  piTranscript
} from "./fixtures/adapters/pi-rpc.js";

function chunks(bytes: Buffer, size: number): Buffer[] {
  const result: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    result.push(bytes.subarray(offset, Math.min(bytes.length, offset + size)));
  }
  return result;
}

describe("central adapter stdout transport", () => {
  it("drives the complete ACP initialize/session/prompt lifecycle from correlated frames", () => {
    const identity = createAdapterCallIdentity(opencodeAdapterDescriptor, "1", {
      kind: "acp-v1",
      initializeRequestId: "init-lifecycle",
      newSessionRequestId: "new-lifecycle",
      promptRequestId: "prompt-lifecycle"
    });
    const writes: string[] = [];
    let closed = 0;
    const stream = new StdoutStream({
      maxFrameBytes: 4096,
      tailCap: 1024,
      adapter: identity,
      protocolDriver: {
        request: { kind: "acp-v1", cwd: "/workspace", promptText: "do it" },
        write: (bytes) => writes.push(bytes.toString()),
        close: () => { closed += 1; }
      }
    });
    const records = [
      { jsonrpc: "2.0", id: "init-lifecycle", result: { protocolVersion: 1 } },
      { jsonrpc: "2.0", id: "new-lifecycle", result: { sessionId: "session-lifecycle" } },
      { jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-lifecycle", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } },
      { jsonrpc: "2.0", id: "prompt-lifecycle", result: { stopReason: "end_turn" } }
    ];
    for (const record of records.slice(0, 2)) stream.push(Buffer.from(`${JSON.stringify(record)}\n`));
    expect(stream.requestCancel()).toBe(true);
    expect(stream.requestCancel()).toBe(true);
    for (const record of records.slice(2)) stream.push(Buffer.from(`${JSON.stringify(record)}\n`));
    expect(writes).toEqual([
      '{"jsonrpc":"2.0","id":"new-lifecycle","method":"session/new","params":{"cwd":"/workspace","mcpServers":[]}}\n',
      '{"jsonrpc":"2.0","id":"prompt-lifecycle","method":"session/prompt","params":{"sessionId":"session-lifecycle","prompt":[{"type":"text","text":"do it"}]}}\n',
      '{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"session-lifecycle"}}\n'
    ]);
    expect(closed).toBe(1);
    expect(stream.finish().adapterResult).toMatchObject({ status: "success", finalText: "done" });
  });

  it("drives Pi state/stats/prompt/stats without a readiness sleep", () => {
    const identity = createAdapterCallIdentity(piAdapterDescriptor, "pi-rpc-v1", {
      kind: "pi-rpc",
      stateRequestId: "state-lifecycle",
      statisticsBeforeRequestId: "stats-before-lifecycle",
      promptRequestId: "prompt-lifecycle",
      statisticsAfterRequestId: "stats-after-lifecycle",
      cancelRequestId: "abort-lifecycle"
    });
    const writes: string[] = [];
    let closed = 0;
    const stream = new StdoutStream({
      maxFrameBytes: 4096,
      tailCap: 1024,
      adapter: identity,
      protocolDriver: {
        request: { kind: "pi-rpc", promptText: "do it" },
        write: (bytes) => writes.push(bytes.toString()),
        close: () => { closed += 1; }
      }
    });
    const stats = (id: string, after: boolean) => ({
      id,
      type: "response",
      command: "get_session_stats",
      success: true,
      data: {
        sessionId: "pi-lifecycle",
        tokens: { input: after ? 20 : 10, output: after ? 8 : 3, cacheRead: after ? 2 : 1, cacheWrite: after ? 1 : 0, total: after ? 31 : 14 },
        cost: after ? 0.25 : 0.1
      }
    });
    const records = [
      { id: "state-lifecycle", type: "response", command: "get_state", success: true, data: { sessionId: "pi-lifecycle", isStreaming: false, isCompacting: false, messageCount: 0, pendingMessageCount: 0 } },
      stats("stats-before-lifecycle", false),
      { id: "prompt-lifecycle", type: "response", command: "prompt", success: true },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } },
      { type: "agent_settled" },
      stats("stats-after-lifecycle", true)
    ];
    for (const record of records.slice(0, 2)) stream.push(Buffer.from(`${JSON.stringify(record)}\n`));
    expect(stream.requestCancel()).toBe(true);
    expect(stream.requestCancel()).toBe(true);
    for (const record of records.slice(2)) stream.push(Buffer.from(`${JSON.stringify(record)}\n`));
    expect(writes).toEqual([
      '{"id":"stats-before-lifecycle","type":"get_session_stats"}\n',
      '{"id":"prompt-lifecycle","type":"prompt","message":"do it"}\n',
      '{"id":"abort-lifecycle","type":"abort"}\n',
      '{"id":"stats-after-lifecycle","type":"get_session_stats"}\n'
    ]);
    expect(closed).toBe(1);
    expect(stream.finish().adapterResult).toMatchObject({
      status: "success",
      finalText: "done",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 17, costUsd: 0.15 }
    });
  });

  it("feeds ACP through the single raw framer, exposes normalized events, and replays identically", () => {
    const identity = createAdapterCallIdentity(opencodeAdapterDescriptor, "1", {
      kind: "acp-v1",
      sessionId: ACP_FIXTURE_SESSION,
      promptRequestId: ACP_FIXTURE_PROMPT_ID
    });
    const events: NormalizedAdapterEvent[] = [];
    const live = new StdoutStream({
      maxFrameBytes: 32 * 1024 * 1024,
      tailCap: 1024,
      adapter: identity,
      onAdapterEvent: (event) => events.push(event)
    });
    const transcript = acpTranscript();
    for (const chunk of chunks(transcript, 3)) live.push(chunk);
    const liveOutcome = live.finish();

    expect(liveOutcome.fatal).toBeUndefined();
    expect(liveOutcome.verdict).toBeUndefined();
    expect(liveOutcome.adapterResult).toMatchObject({
      status: "success",
      finalText: "done",
      explicitLimit: false,
      usage: { source: "terminal-response", inputTokens: 10, outputTokens: 5, totalTokens: 18 }
    });
    expect(events.map((event) => event.kind)).toEqual([
      "thought-delta",
      "assistant-delta",
      "tool",
      "tool",
      "usage",
      "usage",
      "assistant-final"
    ]);
    expect(liveOutcome.adapterIdentity).toEqual(identity);

    const replayed = StdoutStream.replayAdapter(identity, (push) => {
      for (const chunk of chunks(transcript, 17)) push(chunk);
    });
    expect(replayed.adapterResult).toEqual(liveOutcome.adapterResult);
    expect(replayed.adapterIdentity).toEqual(identity);
    expect(replayed.frames).toBe(liveOutcome.frames);
  });

  it("feeds Pi RPC through the same framer and preserves exact request/session correlation", () => {
    const identity = createAdapterCallIdentity(piAdapterDescriptor, "pi-rpc-v1", {
      kind: "pi-rpc",
      sessionId: PI_FIXTURE_SESSION,
      promptRequestId: PI_FIXTURE_PROMPT_ID
    });
    const events: NormalizedAdapterEvent[] = [];
    const stream = new StdoutStream({
      maxFrameBytes: 32 * 1024 * 1024,
      tailCap: 1024,
      adapter: identity,
      onAdapterEvent: (event) => events.push(event)
    });
    for (const chunk of chunks(piTranscript(), 5)) stream.push(chunk);
    const outcome = stream.finish();
    expect(outcome.adapterResult).toMatchObject({ status: "success", finalText: "done", explicitLimit: false });
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

    const foreign = createAdapterCallIdentity(piAdapterDescriptor, "pi-rpc-v1", {
      kind: "pi-rpc",
      sessionId: PI_FIXTURE_SESSION,
      promptRequestId: "foreign-prompt"
    });
    const replayedForeign = StdoutStream.replayAdapter(foreign, (push) => push(piTranscript()));
    expect(replayedForeign.adapterResult).toMatchObject({ status: "uncertain", code: "foreign-correlation" });
  });

  it("rejects descriptor/version/codec drift before consuming transcript bytes", () => {
    const valid = createAdapterCallIdentity(opencodeAdapterDescriptor, "1", {
      kind: "acp-v1",
      sessionId: ACP_FIXTURE_SESSION,
      promptRequestId: ACP_FIXTURE_PROMPT_ID
    });
    expect(Object.isFrozen(valid)).toBe(true);
    expect(Object.isFrozen(valid.replay)).toBe(true);
    expect(resolveAdapterCallIdentity(valid)).toEqual(valid);

    const badCodec = {
      replay: { ...valid.replay, codec: { ...valid.replay.codec, version: 2 } },
      correlation: valid.correlation
    };
    expect(() => resolveAdapterCallIdentity(badCodec)).toThrow(/does not match the shipped descriptor/);
    expect(() => new StdoutStream({ maxFrameBytes: 1024, tailCap: 64, adapter: badCodec as never })).toThrow(
      /does not match the shipped descriptor/
    );
    expect(sameAdapterCallIdentity(valid, { ...valid, correlation: { ...valid.correlation, sessionId: "foreign" } } as never)).toBe(false);
  });

  it("turns an oversized structured frame into fatal uncertainty with no codec terminal", () => {
    const identity = createAdapterCallIdentity(piAdapterDescriptor, "pi-rpc-v1", {
      kind: "pi-rpc",
      sessionId: PI_FIXTURE_SESSION,
      promptRequestId: PI_FIXTURE_PROMPT_ID
    });
    const stream = new StdoutStream({ maxFrameBytes: 8, tailCap: 64, adapter: identity });
    stream.push(Buffer.from("123456789\n", "utf8"));
    const outcome = stream.finish();
    expect(outcome.fatal).toMatchObject({ kind: "oversize", limitBytes: 8, observedBytes: 9 });
    expect(outcome.adapterResult).toBeUndefined();
    expect(outcome.verdict).toBeUndefined();
  });

  it("enforces total-byte/frame-count bounds and isolates event observers from protocol authority", () => {
    const identity = createAdapterCallIdentity(piAdapterDescriptor, "pi-rpc-v1", {
      kind: "pi-rpc",
      sessionId: PI_FIXTURE_SESSION,
      promptRequestId: PI_FIXTURE_PROMPT_ID
    });
    const total = new StdoutStream({
      maxFrameBytes: 1024,
      maxTotalBytes: 8,
      tailCap: 64,
      adapter: identity
    });
    total.push(Buffer.from("{}\n{}\n{}\n", "utf8"));
    expect(total.finish()).toMatchObject({ fatal: { kind: "total-limit", limitBytes: 8 }, adapterResult: undefined });

    const frames = new StdoutStream({
      maxFrameBytes: 1024,
      maxFrames: 1,
      tailCap: 64,
      adapter: identity
    });
    frames.push(Buffer.from("{}\n{}\n", "utf8"));
    expect(frames.finish()).toMatchObject({ fatal: { kind: "frame-count-limit", limitBytes: 1 }, adapterResult: undefined });

    const observed = new StdoutStream({
      maxFrameBytes: 32 * 1024 * 1024,
      tailCap: 64,
      adapter: identity,
      onAdapterEvent: () => {
        throw new Error("observer failure");
      }
    });
    observed.push(piTranscript());
    expect(observed.finish().adapterResult).toMatchObject({ status: "success", finalText: "done" });
  });
});

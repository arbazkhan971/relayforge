import { describe, expect, it } from "vitest";
import { grokAdapterDescriptor } from "../src/adapters/builtins/grok.js";
import { grokSessionMeta } from "../src/adapters/grok-acp.js";
import {
  StdoutStream,
  createAdapterCallIdentity,
  resolveAdapterCallIdentity
} from "../src/streaming.js";
import { grokTranscript } from "./fixtures/adapters/grok.js";

const lifecycleIdentity = () => createAdapterCallIdentity(grokAdapterDescriptor, "1", {
  kind: "acp-v1",
  initializeRequestId: "grok-init-lifecycle",
  newSessionRequestId: "grok-new-lifecycle",
  promptRequestId: "grok-prompt-lifecycle"
});

describe("central Grok ACP routing", () => {
  it("drives one correlated ACP lifecycle with bounded standing-prompt metadata and cooperative cancel", () => {
    const writes: string[] = [];
    let closed = 0;
    const stream = new StdoutStream({
      maxFrameBytes: 64 * 1024,
      maxTotalBytes: 1024 * 1024,
      maxFrames: 1024,
      tailCap: 1024,
      adapter: lifecycleIdentity(),
      protocolDriver: {
        request: {
          kind: "acp-v1",
          cwd: "/workspace",
          promptText: "implement safely",
          sessionMeta: grokSessionMeta("standing Grok role")
        },
        write: (bytes) => writes.push(bytes.toString()),
        close: () => { closed += 1; }
      }
    });
    const records = [
      {
        jsonrpc: "2.0",
        id: "grok-init-lifecycle",
        result: { protocolVersion: 1, _meta: { grokShell: true, agentVersion: "1.0.0" } }
      },
      { jsonrpc: "2.0", id: "grok-new-lifecycle", result: { sessionId: "grok-session-lifecycle" } },
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "grok-session-lifecycle",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } }
        }
      },
      { jsonrpc: "2.0", id: "grok-prompt-lifecycle", result: { stopReason: "end_turn" } }
    ];
    stream.push(Buffer.from(`${JSON.stringify(records[0])}\n`));
    stream.push(Buffer.from(`${JSON.stringify(records[1])}\n`));
    expect(stream.requestCancel()).toBe(true);
    expect(stream.requestCancel()).toBe(true);
    stream.push(Buffer.from(`${JSON.stringify(records[2])}\n${JSON.stringify(records[3])}\n`));

    expect(writes).toEqual([
      '{"jsonrpc":"2.0","id":"grok-new-lifecycle","method":"session/new","params":{"cwd":"/workspace","mcpServers":[],"_meta":{"systemPromptOverride":"standing Grok role"}}}\n',
      '{"jsonrpc":"2.0","id":"grok-prompt-lifecycle","method":"session/prompt","params":{"sessionId":"grok-session-lifecycle","prompt":[{"type":"text","text":"implement safely"}]}}\n',
      '{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"grok-session-lifecycle"}}\n'
    ]);
    expect(closed).toBe(1);
    expect(stream.finish().adapterResult).toMatchObject({ status: "success", finalText: "done", explicitLimit: false });
  });

  it("replays the same Grok grammar and rejects normalizer/correlation drift", () => {
    const identity = createAdapterCallIdentity(grokAdapterDescriptor, "1", {
      kind: "acp-v1",
      sessionId: "grok-session-relayforge-1",
      promptRequestId: "grok-prompt-1"
    });
    const transcript = grokTranscript();
    const live = new StdoutStream({ maxFrameBytes: 64 * 1024, tailCap: 1024, adapter: identity });
    for (let offset = 0; offset < transcript.length; offset += 3) live.push(transcript.subarray(offset, offset + 3));
    const liveResult = live.finish();
    const replay = StdoutStream.replayAdapter(identity, (push) => push(transcript));
    expect(replay.adapterResult).toEqual(liveResult.adapterResult);
    expect(replay.adapterIdentity).toEqual(identity);
    expect(resolveAdapterCallIdentity(identity)).toEqual(identity);

    const foreign = createAdapterCallIdentity(grokAdapterDescriptor, "1", {
      kind: "acp-v1",
      sessionId: "grok-session-relayforge-1",
      promptRequestId: "foreign-prompt"
    });
    expect(StdoutStream.replayAdapter(foreign, (push) => push(transcript)).adapterResult).toMatchObject({
      status: "uncertain",
      code: "foreign-correlation"
    });
    expect(() => resolveAdapterCallIdentity({
      replay: { ...identity.replay, normalizer: { ...identity.replay.normalizer, version: 2 } },
      correlation: identity.correlation
    })).toThrow(/does not match the shipped descriptor/);
  });

  it("refuses a standard ACP peer that does not identify the characterized Grok shell", () => {
    const writes: string[] = [];
    const stream = new StdoutStream({
      maxFrameBytes: 64 * 1024,
      maxTotalBytes: 1024 * 1024,
      maxFrames: 1024,
      tailCap: 1024,
      adapter: lifecycleIdentity(),
      protocolDriver: {
        request: { kind: "acp-v1", cwd: "/workspace", promptText: "do not run" },
        write: (bytes) => writes.push(bytes.toString()),
        close: () => undefined
      }
    });
    stream.push(Buffer.from(`${JSON.stringify({
      jsonrpc: "2.0",
      id: "grok-init-lifecycle",
      result: { protocolVersion: 1, agentInfo: { name: "foreign-acp", version: "1.0.0" } }
    })}\n`));
    expect(stream.finish().adapterResult).toMatchObject({
      status: "uncertain",
      code: "protocol-drift"
    });
    expect(writes).toEqual([]);
  });

  it.each([
    ["allow-once", "once", '{"jsonrpc":"2.0","id":"permission","result":{"outcome":{"outcome":"selected","optionId":"once"}}}\n'],
    ["deny", undefined, '{"jsonrpc":"2.0","id":"permission","result":{"outcome":{"outcome":"cancelled"}}}\n']
  ] as const)("keeps %s ACP permission selection parent-owned and never persists approval", (permissionPolicy, _option, expected) => {
    const writes: string[] = [];
    const stream = new StdoutStream({
      maxFrameBytes: 64 * 1024,
      maxTotalBytes: 1024 * 1024,
      maxFrames: 1024,
      tailCap: 1024,
      adapter: lifecycleIdentity(),
      protocolDriver: {
        request: { kind: "acp-v1", cwd: "/workspace", promptText: "safe turn", permissionPolicy },
        write: (bytes) => writes.push(bytes.toString()),
        close: () => undefined
      }
    });
    for (const record of [
      { jsonrpc: "2.0", id: "grok-init-lifecycle", result: { protocolVersion: 1, _meta: { grokShell: true, agentVersion: "1.0.0" } } },
      { jsonrpc: "2.0", id: "grok-new-lifecycle", result: { sessionId: "grok-session-lifecycle" } },
      {
        jsonrpc: "2.0",
        id: "permission",
        method: "session/request_permission",
        params: {
          sessionId: "grok-session-lifecycle",
          toolCall: { toolCallId: "tool" },
          options: [
            { optionId: "always", name: "Always", kind: "allow_always" },
            { optionId: "once", name: "Once", kind: "allow_once" }
          ]
        }
      },
      { jsonrpc: "2.0", id: "grok-prompt-lifecycle", result: { stopReason: "end_turn" } }
    ]) stream.push(Buffer.from(`${JSON.stringify(record)}\n`));
    expect(stream.finish().adapterResult).toMatchObject({ status: "success" });
    expect(writes).toContain(expected);
    expect(writes.join("")).not.toContain("always");
  });
});

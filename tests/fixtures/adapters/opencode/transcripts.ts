/** Independently authored OpenCode 1.18.15 native ACP v1 characterization records. */
export const OPENCODE_SESSION_ID = "ses-opencode-relayforge-1";
export const OPENCODE_PROMPT_ID = "prompt-opencode-1";

export const OPENCODE_INITIALIZE_RESPONSE = {
  jsonrpc: "2.0",
  id: "initialize-1",
  result: {
    protocolVersion: 1,
    agentInfo: { name: "OpenCode", version: "1.18.15" },
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, embeddedContext: true },
      mcpCapabilities: { http: true, sse: true }
    }
  }
} as const;

export const OPENCODE_SUCCESS_RECORDS: readonly Readonly<Record<string, unknown>>[] = [
  {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: OPENCODE_SESSION_ID,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "message-1",
        content: { type: "text", text: "inspected without writing" }
      }
    }
  },
  {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: OPENCODE_SESSION_ID,
      update: {
        sessionUpdate: "usage_update",
        used: 75,
        size: 200_000,
        cost: { amount: 0.125, currency: "USD" }
      }
    }
  },
  {
    jsonrpc: "2.0",
    id: OPENCODE_PROMPT_ID,
    result: {
      stopReason: "end_turn",
      usage: {
        inputTokens: 40,
        outputTokens: 10,
        thoughtTokens: 5,
        cachedReadTokens: 20,
        cachedWriteTokens: 2,
        totalTokens: 77
      }
    }
  }
];

export const OPENCODE_NO_USAGE_RECORDS: readonly Readonly<Record<string, unknown>>[] = [
  {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: OPENCODE_SESSION_ID,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "message-2",
        content: { type: "text", text: "usage unavailable" }
      }
    }
  },
  { jsonrpc: "2.0", id: OPENCODE_PROMPT_ID, result: { stopReason: "end_turn" } }
];

export const OPENCODE_PERMISSION_REQUEST = {
  jsonrpc: "2.0",
  id: "permission-1",
  method: "session/request_permission",
  params: {
    sessionId: OPENCODE_SESSION_ID,
    toolCall: { toolCallId: "tool-1", title: "Edit source" },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" }
    ]
  }
} as const;

export function opencodeTranscript(records: readonly Readonly<Record<string, unknown>>[]): Buffer {
  return Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

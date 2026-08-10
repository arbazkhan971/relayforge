/** Independently authored ACP v1/OpenCode-shaped characterization records. */
export const ACP_FIXTURE_SESSION = "ses-relayforge-1";
export const ACP_FIXTURE_PROMPT_ID = "prompt-1";

export const ACP_SUCCESS_RECORDS: readonly Readonly<Record<string, unknown>>[] = [
  {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: ACP_FIXTURE_SESSION,
      update: {
        sessionUpdate: "agent_thought_chunk",
        messageId: "msg-1",
        content: { type: "text", text: "checking" }
      }
    }
  },
  {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: ACP_FIXTURE_SESSION,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "msg-1",
        content: { type: "text", text: "done" }
      }
    }
  },
  {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: ACP_FIXTURE_SESSION,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        status: "pending",
        title: "Read file"
      }
    }
  },
  {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: ACP_FIXTURE_SESSION,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "completed"
      }
    }
  },
  {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: ACP_FIXTURE_SESSION,
      update: {
        sessionUpdate: "usage_update",
        used: 22,
        size: 128_000,
        cost: { amount: 0.125, currency: "USD" }
      }
    }
  },
  {
    jsonrpc: "2.0",
    id: ACP_FIXTURE_PROMPT_ID,
    result: {
      stopReason: "end_turn",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 18,
        thoughtTokens: 3
      }
    }
  }
];

export function acpTranscript(records: readonly Readonly<Record<string, unknown>>[] = ACP_SUCCESS_RECORDS): Buffer {
  return Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

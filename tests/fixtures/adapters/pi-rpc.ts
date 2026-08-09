/** Independently authored Pi 0.84.1 RPC characterization records. */
export const PI_FIXTURE_SESSION = "pi-session-1";
export const PI_FIXTURE_PROMPT_ID = "prompt-1";

export const PI_SUCCESS_RECORDS: readonly Readonly<Record<string, unknown>>[] = [
  { id: PI_FIXTURE_PROMPT_ID, type: "response", command: "prompt", success: true },
  { type: "agent_start" },
  {
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "checking" }
  },
  {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "done" }
  },
  {
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "read",
    args: { path: "README.md" }
  },
  {
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "read",
    result: { content: [{ type: "text", text: "contents" }] },
    isError: false
  },
  {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      stopReason: "stop"
    }
  },
  { type: "agent_end", messages: [], willRetry: false },
  { type: "agent_settled" }
];

export const PI_STATS_RECORD = {
  id: "stats-1",
  type: "response",
  command: "get_session_stats",
  success: true,
  data: {
    sessionId: PI_FIXTURE_SESSION,
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 1,
    toolResults: 1,
    totalMessages: 4,
    tokens: { input: 50, output: 10, cacheRead: 20, cacheWrite: 5, total: 85 },
    cost: 0.45,
    contextUsage: { tokens: 60, contextWindow: 200, percent: 30 }
  }
} as const;

export function piTranscript(records: readonly Readonly<Record<string, unknown>>[] = PI_SUCCESS_RECORDS): Buffer {
  return Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

/** Independently authored Pi 0.84.1 RPC behavioral-probe records. */
export const PI_PROBE_SESSION = "pi-probe-session-1";
export const PI_PROBE_GENERATION = 3;

export const PI_PROBE_STATE_RESPONSE = {
  id: "state-probe-1",
  type: "response",
  command: "get_state",
  success: true,
  data: {
    sessionId: PI_PROBE_SESSION,
    thinkingLevel: "medium",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "all",
    followUpMode: "one-at-a-time",
    autoCompactionEnabled: true,
    messageCount: 0,
    pendingMessageCount: 0
  }
} as const;

export const PI_PROBE_START_STATS_RESPONSE = {
  id: "stats-start-1",
  type: "response",
  command: "get_session_stats",
  success: true,
  data: {
    sessionId: PI_PROBE_SESSION,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: { input: 10, output: 2, cacheRead: 3, cacheWrite: 1, total: 16 },
    cost: 0.1,
    contextUsage: { tokens: null, contextWindow: 200_000, percent: null }
  }
} as const;

export const PI_PROBE_END_STATS_RESPONSE = {
  id: "stats-end-1",
  type: "response",
  command: "get_session_stats",
  success: true,
  data: {
    sessionId: PI_PROBE_SESSION,
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 1,
    toolResults: 1,
    totalMessages: 4,
    tokens: { input: 50, output: 12, cacheRead: 13, cacheWrite: 2, total: 77 },
    cost: 0.4,
    contextUsage: { tokens: 70, contextWindow: 200_000, percent: 0.035 }
  }
} as const;

export const PI_ADAPTER_SUCCESS_RECORDS: readonly Readonly<Record<string, unknown>>[] = [
  { id: "prompt-adapter-1", type: "response", command: "prompt", success: true },
  { type: "agent_start" },
  {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "read-only result" }
  },
  {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "read-only result" }],
      stopReason: "stop"
    }
  },
  { type: "agent_end", messages: [], willRetry: false },
  { type: "agent_settled" }
];

export function piAdapterTranscript(records: readonly Readonly<Record<string, unknown>>[]): Buffer {
  return Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

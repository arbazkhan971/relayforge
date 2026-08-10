/** Independently authored Grok Build 1.0.0 ACP v1 characterization records. */
export const GROK_FIXTURE_SESSION_ID = "grok-session-relayforge-1";
export const GROK_FIXTURE_PROMPT_ID = "grok-prompt-1";

export const GROK_INITIALIZE_RESPONSE = {
  jsonrpc: "2.0",
  id: "grok-initialize-1",
  result: {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: false, audio: false, embeddedContext: true },
      sessionCapabilities: { list: {}, resume: {}, close: {} }
    },
    _meta: {
      grokShell: true,
      agentVersion: "1.0.0",
      modelState: { currentModelId: "grok-4.5" }
    }
  }
} as const;

export const GROK_SUCCESS_RECORDS: readonly Readonly<Record<string, unknown>>[] = [
  {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: GROK_FIXTURE_SESSION_ID,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "contained Grok result" }
      }
    }
  },
  {
    jsonrpc: "2.0",
    id: GROK_FIXTURE_PROMPT_ID,
    result: { stopReason: "end_turn" }
  }
];

export function grokTranscript(records: readonly Readonly<Record<string, unknown>>[] = GROK_SUCCESS_RECORDS): Buffer {
  return Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

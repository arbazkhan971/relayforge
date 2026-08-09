#!/usr/bin/env node
let pending = "";
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const sessionId = "native-fixture-session";
const isGrok = typeof process.env.GROK_HOME === "string";
let pendingAcpPrompt;
let piTurnPending = false;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  for (;;) {
    const newline = pending.indexOf("\n");
    if (newline < 0) break;
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      write({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: isGrok ? "grok" : "fixture", version: isGrok ? "1.0.0" : "1.18.15" },
          ...(isGrok ? { _meta: { grokShell: true, agentVersion: "1.0.0" } } : {})
        }
      });
    } else if (request.method === "session/new") {
      write({ jsonrpc: "2.0", id: request.id, result: { sessionId } });
    } else if (request.method === "session/prompt") {
      if (request.params.prompt?.[0]?.text === "long turn") {
        pendingAcpPrompt = request.id;
        continue;
      }
      const text = isGrok ? "native grok result" : "native acp result";
      write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
      write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "usage_update", used: 12, size: 200000, cost: { amount: 0.125, currency: "USD" } } } });
      write({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
    } else if (request.method === "session/cancel" && pendingAcpPrompt) {
      write({ jsonrpc: "2.0", id: pendingAcpPrompt, result: { stopReason: "cancelled" } });
      pendingAcpPrompt = undefined;
    } else if (request.type === "get_state") {
      write({ id: request.id, type: "response", command: "get_state", success: true, data: { sessionId, isStreaming: false, isCompacting: false, messageCount: 0, pendingMessageCount: 0 } });
    } else if (request.type === "get_session_stats") {
      const after = request.id.endsWith("stats-after");
      write({ id: request.id, type: "response", command: "get_session_stats", success: true, data: { sessionId, tokens: { input: after ? 20 : 10, output: after ? 8 : 3, cacheRead: after ? 2 : 1, cacheWrite: after ? 1 : 0, total: after ? 31 : 14 }, cost: after ? 0.25 : 0.1, contextUsage: { tokens: after ? 31 : 14, contextWindow: 200000 } } });
    } else if (request.type === "prompt") {
      write({ id: request.id, type: "response", command: "prompt", success: true });
      if (request.message === "long turn") {
        piTurnPending = true;
        continue;
      }
      write({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "native pi result" } });
      write({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "native pi result" }], stopReason: "stop" } });
      write({ type: "agent_settled" });
    } else if (request.type === "abort" && piTurnPending) {
      write({ id: request.id, type: "response", command: "abort", success: true });
      write({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "cancelled" }], stopReason: "aborted" } });
      write({ type: "agent_settled" });
      piTurnPending = false;
    }
  }
});

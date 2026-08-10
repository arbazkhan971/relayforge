#!/usr/bin/node
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { readdirSync, writeFileSync, appendFileSync } from "node:fs";

const FIXED_PREFIX = [
  "--no-auto-update",
  "--disable-web-search",
  "--no-subagents",
  "--no-memory"
];

if (process.argv.length === 3 && process.argv[2] === "--version") {
  const wrong = process.env.XAI_API_KEY === "fixture-wrong-version";
  process.stdout.write(wrong
    ? "grok 1.0.1 (aaaaaaaaaa) [stable]\n"
    : "grok 1.0.0 (3cd0d0cbce) [stable]\n");
  process.exit(0);
}

if (process.argv.length === 4 && process.argv[2] === "version" && process.argv[3] === "--json") {
  process.stdout.write(JSON.stringify({
    currentVersion: process.env.XAI_API_KEY === "fixture-wrong-version"
      ? "1.0.1 (aaaaaaaaaa)"
      : "1.0.0 (3cd0d0cbce)",
    channel: "stable"
  }) + "\n");
  process.exit(0);
}

// Production Grok characterization always launches the closed agent stdio recipe.
for (const flag of FIXED_PREFIX) {
  if (!process.argv.includes(flag)) process.exit(64);
}
if (!process.argv.includes("agent") || !process.argv.includes("--no-leader") || !process.argv.includes("stdio")) {
  process.exit(64);
}
if (!process.argv.includes("--permission-mode")) process.exit(64);
const permissionMode = process.argv[process.argv.indexOf("--permission-mode") + 1];
if (permissionMode !== "default" && permissionMode !== "plan") process.exit(64);

// Private empty HOME/GROK_HOME are required; ambient login state is never reused.
const home = process.env.HOME ?? "";
const grokHome = process.env.GROK_HOME ?? "";
if (!home || !grokHome || home.includes("\0") || grokHome.includes("\0")) process.exit(65);
try {
  if (readdirSync(grokHome).length !== 0) process.exit(65);
} catch {
  process.exit(65);
}
for (const key of [
  "GROK_TELEMETRY_ENABLED",
  "GROK_TELEMETRY_TRACE_UPLOAD",
  "GROK_FEEDBACK_ENABLED",
  "GROK_TRACE_UPLOAD",
  "GROK_INSTRUMENTATION",
  "OTEL_SDK_DISABLED",
  "DISABLE_TELEMETRY",
  "DISABLE_FEEDBACK_COMMAND",
  "GROK_DISABLE_AUTOUPDATER",
  "GROK_PROMPT_SUGGESTIONS",
  "GROK_TURN_SUMMARY"
]) {
  if (!process.env[key]) process.exit(66);
}

const apiKey = process.env.XAI_API_KEY ?? "";
if (!apiKey) process.exit(67);
const failHandshake = apiKey === "fixture-fail-handshake";
const omitGrokMeta = apiKey === "fixture-omit-grok-meta";
const emptySuccess = apiKey === "fixture-empty-success";
const workerWriteNew = apiKey === "fixture-worker-write-new";
const workerMutate = apiKey === "fixture-worker-mutate";
const replayWrite = apiKey === "fixture-replay-write";
const reviewerUnrelated = apiKey === "fixture-reviewer-unrelated";
const reviewerGenericWrite = apiKey === "fixture-reviewer-generic-write";
const omitSessionCreate = apiKey === "fixture-omit-session-create";
const isReviewer = permissionMode === "plan";

let pending = "";
let sessionId = "grok-contained-session";
let promptId;
let permissionId;
let reviewerTarget;
let cancelCount = 0;
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const update = (value) => write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } });
const complete = (id, text, stopReason = "end_turn") => {
  if (text) update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  update({ sessionUpdate: "usage_update", used: 8, size: 200000, cost: { amount: 0.125, currency: "USD" } });
  write({ jsonrpc: "2.0", id, result: { stopReason } });
};

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
      if (failHandshake) process.exit(69);
      if (omitGrokMeta) {
        // Emit a standard ACP initialize that is not the characterized Grok shell, then exit so the
        // parent cannot invent grokShell/agentVersion from a hung partial session.
        write({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: true,
              promptCapabilities: { image: false, audio: false, embeddedContext: true }
            },
            _meta: { agentVersion: "1.0.0" }
          }
        });
        process.exit(74);
      }
      write({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: false, audio: false, embeddedContext: true },
            sessionCapabilities: { list: {}, resume: {}, close: {} }
          },
          _meta: { grokShell: true, agentVersion: "1.0.0", modelState: { currentModelId: "grok-4.5" } }
        }
      });
      continue;
    }
    if (request.method === "session/new") {
      if (omitSessionCreate) process.exit(72);
      // Standing prompt must arrive on the dedicated Grok meta channel.
      if (typeof request.params?._meta?.systemPromptOverride !== "string") process.exit(73);
      write({ jsonrpc: "2.0", id: request.id, result: { sessionId } });
      continue;
    }
    if (request.method === "session/prompt") {
      promptId = request.id;
      const text = request.params?.prompt?.[0]?.text ?? "";
      if (text.includes("RF_CHARACTERIZE_CANCEL")) continue;
      if (text.includes("RF_CHARACTERIZE_REVIEWER")) {
        if (!isReviewer) process.exit(70);
        if (reviewerUnrelated) {
          permissionId = "unrelated-permission-1";
          write({
            jsonrpc: "2.0",
            id: permissionId,
            method: "session/request_permission",
            params: {
              sessionId,
              options: [
                { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
                { optionId: "reject", kind: "reject_once", name: "Reject" }
              ]
            }
          });
          continue;
        }
        if (reviewerGenericWrite) {
          permissionId = "generic-write-permission-1";
          write({
            jsonrpc: "2.0",
            id: permissionId,
            method: "session/request_permission",
            params: {
              sessionId,
              options: [
                { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
                { optionId: "reject", kind: "reject_once", name: "Reject" }
              ]
            }
          });
          continue;
        }
        reviewerTarget = /(?:^|\s)Target:\s*(.+?)\s*$/u.exec(text)?.[1];
        if (!reviewerTarget) process.exit(70);
        permissionId = "reviewer-permission-1";
        write({
          jsonrpc: "2.0",
          id: permissionId,
          method: "session/request_permission",
          params: {
            sessionId,
            options: [
              { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
              { optionId: "reject", kind: "reject_once", name: "Reject" }
            ]
          }
        });
        continue;
      }
      if (emptySuccess) {
        write({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
        continue;
      }
      if (workerWriteNew) {
        try { writeFileSync("UNAUTHORIZED_NEW_FILE.txt", "worker wrote a new file\n"); } catch { /* sandbox may deny */ }
        complete(promptId, "contained grok acknowledgement");
        continue;
      }
      if (workerMutate) {
        try { appendFileSync("README.md", "UNAUTHORIZED MUTATION\n"); } catch { /* sandbox may deny */ }
        complete(promptId, "contained grok acknowledgement");
        continue;
      }
      if (replayWrite && text.includes("RF_CHARACTERIZE_REPLAY")) {
        try { writeFileSync("REPLAY_UNAUTHORIZED.txt", "replay wrote a new file\n"); } catch { /* sandbox may deny */ }
        complete(promptId, "contained grok acknowledgement");
        continue;
      }
      complete(promptId, "contained grok acknowledgement");
      continue;
    }
    if (permissionId !== undefined && request.id === permissionId) {
      // Reviewer plan mode: parent cancels the permission request.
      if (request.result?.outcome?.outcome !== "cancelled") process.exit(67);
      if (reviewerUnrelated) {
        update({ sessionUpdate: "tool_call", toolCallId: "unrelated-tool-1", title: "list temporary cache", status: "pending" });
        update({ sessionUpdate: "tool_call_update", toolCallId: "unrelated-tool-1", title: "cache list failed", status: "failed" });
        complete(promptId, "unrelated permission denied");
        permissionId = undefined;
        continue;
      }
      if (reviewerGenericWrite) {
        update({ sessionUpdate: "tool_call", toolCallId: "generic-write-1", title: "write file", status: "pending" });
        update({ sessionUpdate: "tool_call_update", toolCallId: "generic-write-1", title: "write file failed", status: "failed" });
        complete(promptId, "generic write denied without named target");
        permissionId = undefined;
        continue;
      }
      let denied = false;
      try { writeFileSync(reviewerTarget, "UNAUTHORIZED REVIEWER WRITE\n"); }
      catch (error) { denied = ["EACCES", "EPERM", "EROFS"].includes(error?.code); }
      if (!denied) process.exit(71);
      const targetName = basename(reviewerTarget);
      const targetBinding = createHash("sha256").update(targetName, "utf8").digest("hex").slice(0, 24);
      const toolCallId = `reviewer-write-${targetName}-${targetBinding}`;
      update({ sessionUpdate: "tool_call", toolCallId, title: `replace ${targetName}`, status: "pending" });
      update({ sessionUpdate: "tool_call_update", toolCallId, title: `kernel and parent denied ${targetName}`, status: "failed" });
      complete(promptId, "reviewer mutation denied");
      permissionId = undefined;
      reviewerTarget = undefined;
      continue;
    }
    if (request.method === "session/cancel") {
      cancelCount += 1;
      if (cancelCount !== 1) process.exit(68);
      complete(promptId, "", "cancelled");
      continue;
    }
  }
});

process.stdin.on("end", () => {
  setTimeout(() => process.exit(0), 500);
});

process.on("exit", (code) => {
  const marker = process.env.RELAYFORGE_FIXTURE_EXIT_MARKER;
  if (marker) {
    try { writeFileSync(marker, String(code ?? 0)); } catch { /* ignore */ }
  }
});

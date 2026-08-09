#!/usr/bin/node
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { writeFileSync, appendFileSync } from "node:fs";

if (process.argv.length === 3 && process.argv[2] === "--version") {
  const version = process.env.ANTHROPIC_API_KEY === "fixture-wrong-version" ? "0.84.0" : "0.84.1";
  process.stdout.write(`${version}\n`);
  process.exit(0);
}

// Production Pi characterization always launches with the closed RPC recipe.
if (!process.argv.includes("--mode") || !process.argv.includes("rpc")) process.exit(64);

const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
const failHandshake = apiKey === "fixture-fail-handshake";
const emptySuccess = apiKey === "fixture-empty-success";
const workerWriteNew = apiKey === "fixture-worker-write-new";
const workerMutate = apiKey === "fixture-worker-mutate";
const replayWrite = apiKey === "fixture-replay-write";
const reviewerUnrelated = apiKey === "fixture-reviewer-unrelated";
const reviewerGenericWrite = apiKey === "fixture-reviewer-generic-write";
const reviewerOpaqueId = apiKey === "fixture-reviewer-opaque-id";
const reviewerRelativePath = apiKey === "fixture-reviewer-relative-path";
const omitState = apiKey === "fixture-omit-state";
const omitStats = apiKey === "fixture-omit-stats";
const isReviewer = process.argv.includes("--extension");

let pending = "";
let sessionId = "pi-contained-session";
let promptId;
let promptMessage = "";
let cancelCount = 0;
let statsBeforeSeen = false;
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

const completePrompt = (id, text, stopReason = "stop") => {
  write({ id, type: "response", command: "prompt", success: true });
  if (text) {
    write({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text }
    });
  }
  write({
    type: "message_end",
    message: {
      role: "assistant",
      content: text ? [{ type: "text", text }] : [],
      stopReason
    }
  });
  write({ type: "agent_settled" });
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

    if (request.type === "get_state") {
      if (failHandshake || omitState) process.exit(69);
      write({
        id: request.id,
        type: "response",
        command: "get_state",
        success: true,
        data: {
          sessionId,
          thinkingLevel: "medium",
          isStreaming: false,
          isCompacting: false,
          steeringMode: "all",
          followUpMode: "one-at-a-time",
          autoCompactionEnabled: true,
          messageCount: 0,
          pendingMessageCount: 0
        }
      });
      continue;
    }

    if (request.type === "get_session_stats") {
      if (omitStats && !statsBeforeSeen) {
        // Fail closed immediately rather than hang the parent waiting for pre-turn stats.
        // Absence of the correlated get_session_stats response must mark readiness unproven.
        statsBeforeSeen = true;
        process.exit(73);
      }
      const after = String(request.id).includes("stats-after");
      write({
        id: request.id,
        type: "response",
        command: "get_session_stats",
        success: true,
        data: {
          sessionId,
          userMessages: after ? 1 : 0,
          assistantMessages: after ? 1 : 0,
          toolCalls: after ? 1 : 0,
          toolResults: after ? 1 : 0,
          totalMessages: after ? 4 : 0,
          tokens: {
            input: after ? 50 : 10,
            output: after ? 12 : 2,
            cacheRead: after ? 13 : 3,
            cacheWrite: after ? 2 : 1,
            total: after ? 77 : 16
          },
          cost: after ? 0.4 : 0.1,
          contextUsage: {
            tokens: after ? 70 : null,
            contextWindow: 200_000,
            percent: after ? 0.035 : null
          }
        }
      });
      continue;
    }

    if (request.type === "prompt") {
      promptId = request.id;
      promptMessage = request.message ?? "";
      if (promptMessage.includes("RF_CHARACTERIZE_CANCEL")) {
        // Stay open until the correlated abort arrives.
        write({ id: promptId, type: "response", command: "prompt", success: true });
        continue;
      }
      if (promptMessage.includes("RF_CHARACTERIZE_REVIEWER")) {
        if (!isReviewer) process.exit(70);
        if (reviewerUnrelated) {
          write({ id: promptId, type: "response", command: "prompt", success: true });
          write({
            type: "tool_execution_start",
            toolCallId: "call_unrelated_deadbeef",
            toolName: "relayforge_list",
            args: { path: "." }
          });
          write({
            type: "tool_execution_end",
            toolCallId: "call_unrelated_deadbeef",
            toolName: "relayforge_list",
            result: { content: [{ type: "text", text: "cache" }] },
            isError: true
          });
          write({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "unrelated denial" }],
              stopReason: "stop"
            }
          });
          write({ type: "agent_settled" });
          continue;
        }
        if (reviewerGenericWrite) {
          write({ id: promptId, type: "response", command: "prompt", success: true });
          write({
            type: "tool_execution_start",
            toolCallId: "call_generic_cafebabe",
            toolName: "write",
            // Wrong basename / unrelated path — must not correlate to reviewer-target.txt.
            args: { path: "something.txt" }
          });
          write({
            type: "tool_execution_end",
            toolCallId: "call_generic_cafebabe",
            toolName: "write",
            result: { content: [{ type: "text", text: "failed" }] },
            isError: true
          });
          write({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "generic write denied without named target" }],
              stopReason: "stop"
            }
          });
          write({ type: "agent_settled" });
          continue;
        }
        if (reviewerOpaqueId) {
          // Opaque toolCallId that even embeds the target basename must fail without path-bearing args.
          write({ id: promptId, type: "response", command: "prompt", success: true });
          write({
            type: "tool_execution_start",
            toolCallId: "reviewer-write-reviewer-target.txt-opaque",
            toolName: "write"
            // no args.path — opaque ID alone is never sufficient
          });
          write({
            type: "tool_execution_end",
            toolCallId: "reviewer-write-reviewer-target.txt-opaque",
            toolName: "write",
            result: { content: [{ type: "text", text: "failed" }] },
            isError: true
          });
          write({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "opaque id without path args" }],
              stopReason: "stop"
            }
          });
          write({ type: "agent_settled" });
          continue;
        }
        const reviewerTarget = /(?:^|\s)Target:\s*(.+?)\s*$/u.exec(promptMessage)?.[1];
        if (!reviewerTarget) process.exit(70);
        // Outer sandbox is read-only for reviewer; prove the kernel refused the named write.
        let denied = false;
        try { writeFileSync(reviewerTarget, "UNAUTHORIZED REVIEWER WRITE\n"); }
        catch (error) { denied = ["EACCES", "EPERM", "EROFS"].includes(error?.code); }
        if (!denied) process.exit(71);
        const targetName = basename(reviewerTarget);
        // Real Pi toolCallIds are opaque; correlation must come from args.path, not ID substrings.
        const toolCallId = `call_${createHash("sha256").update(reviewerTarget, "utf8").digest("hex").slice(0, 16)}`;
        const pathArg = reviewerRelativePath ? targetName : reviewerTarget;
        write({ id: promptId, type: "response", command: "prompt", success: true });
        write({
          type: "tool_execution_start",
          toolCallId,
          toolName: "write",
          args: { path: pathArg }
        });
        write({
          type: "tool_execution_end",
          toolCallId,
          toolName: "write",
          // End frames intentionally omit args; codec must reattach title by toolCallId.
          result: { content: [{ type: "text", text: `kernel and helper denied ${targetName}` }] },
          isError: true
        });
        write({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: "reviewer mutation denied"
          }
        });
        write({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "reviewer mutation denied" }],
            stopReason: "stop"
          }
        });
        write({ type: "agent_settled" });
        continue;
      }
      if (emptySuccess) {
        write({ id: promptId, type: "response", command: "prompt", success: true });
        write({
          type: "message_end",
          message: { role: "assistant", content: [], stopReason: "stop" }
        });
        write({ type: "agent_settled" });
        continue;
      }
      if (workerWriteNew) {
        try { writeFileSync("UNAUTHORIZED_NEW_FILE.txt", "worker wrote a new file\n"); } catch { /* sandbox may deny */ }
        completePrompt(promptId, "contained pi acknowledgement");
        continue;
      }
      if (workerMutate) {
        try { appendFileSync("README.md", "UNAUTHORIZED MUTATION\n"); } catch { /* sandbox may deny */ }
        completePrompt(promptId, "contained pi acknowledgement");
        continue;
      }
      if (replayWrite && promptMessage.includes("RF_CHARACTERIZE_REPLAY")) {
        try { writeFileSync("REPLAY_UNAUTHORIZED.txt", "replay wrote a new file\n"); } catch { /* sandbox may deny */ }
        completePrompt(promptId, "contained pi acknowledgement");
        continue;
      }
      completePrompt(promptId, "contained pi acknowledgement");
      continue;
    }

    if (request.type === "abort") {
      cancelCount += 1;
      if (cancelCount !== 1) process.exit(68);
      write({ id: request.id, type: "response", command: "abort", success: true });
      write({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "cancelled" }],
          stopReason: "aborted"
        }
      });
      write({ type: "agent_settled" });
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

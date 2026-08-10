#!/usr/bin/node
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { writeFileSync, appendFileSync } from "node:fs";

if (process.argv.length === 3 && process.argv[2] === "--version") {
  process.stdout.write("1.18.15\n");
  process.exit(0);
}

if (process.argv.length !== 3 || process.argv[2] !== "acp") process.exit(64);

// The fixture refuses to run unless the parent installed its closed inline policy. This makes the
// production-entry test exercise the same configuration/environment channel as real OpenCode.
let inline;
try { inline = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? ""); }
catch { process.exit(65); }
if (inline?.agent?.relayforge?.permission?.external_directory !== "deny") process.exit(66);
const apiKey = inline?.provider?.openai?.options?.apiKey ?? "";
const failHandshake = apiKey === "fixture-fail-handshake";
const emptySuccess = apiKey === "fixture-empty-success";
const workerWriteNew = apiKey === "fixture-worker-write-new";
const workerMutate = apiKey === "fixture-worker-mutate";
const replayWrite = apiKey === "fixture-replay-write";
const reviewerUnrelated = apiKey === "fixture-reviewer-unrelated";
const reviewerGenericWrite = apiKey === "fixture-reviewer-generic-write";
const omitSessionCreate = apiKey === "fixture-omit-session-create";
let promptCount = 0;

let pending = "";
let sessionId = "opencode-contained-session";
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
      write({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1, agentInfo: { name: "opencode", version: "1.18.15" } } });
      continue;
    }
    if (request.method === "session/new") {
      // F4: session-create is an exact durable decoded fact (session/new result), never inferred.
      // Absence mode dies without emitting session/new so characterization cannot invent session-create.
      if (omitSessionCreate) process.exit(72);
      write({ jsonrpc: "2.0", id: request.id, result: { sessionId } });
      continue;
    }
    if (request.method === "session/prompt") {
      promptId = request.id;
      promptCount += 1;
      const text = request.params?.prompt?.[0]?.text ?? "";
      if (text.includes("RF_CHARACTERIZE_CANCEL")) continue;
      if (text.includes("RF_CHARACTERIZE_REVIEWER")) {
        if (reviewerUnrelated) {
          // Synthetic unrelated permission + failed tool without naming the mutation target.
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
          // Adversarial F3: generic "write file" lifecycle with no target basename correlation.
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
        // Successful terminal with no assistant output must not prove prompt-roundtrip.
        write({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
        continue;
      }
      if (workerWriteNew) {
        try { writeFileSync("UNAUTHORIZED_NEW_FILE.txt", "worker wrote a new file\n"); } catch { /* sandbox may deny */ }
        complete(promptId, "contained opencode acknowledgement");
        continue;
      }
      if (workerMutate) {
        try { appendFileSync("README.md", "UNAUTHORIZED MUTATION\n"); } catch { /* sandbox may deny */ }
        complete(promptId, "contained opencode acknowledgement");
        continue;
      }
      // Adversarial: mutate only on the ordinary-route replay prompt (after worker/reviewer/cancel).
      if (replayWrite && text.includes("RF_CHARACTERIZE_REPLAY")) {
        try { writeFileSync("REPLAY_UNAUTHORIZED.txt", "replay wrote a new file\n"); } catch { /* sandbox may deny */ }
        complete(promptId, "contained opencode acknowledgement");
        continue;
      }
      complete(promptId, "contained opencode acknowledgement");
      continue;
    }
    if (permissionId !== undefined && request.id === permissionId) {
      if (request.result?.outcome?.outcome !== "cancelled") process.exit(67);
      if (reviewerUnrelated) {
        update({ sessionUpdate: "tool_call", toolCallId: "unrelated-tool-1", title: "list temporary cache", status: "pending" });
        update({ sessionUpdate: "tool_call_update", toolCallId: "unrelated-tool-1", title: "cache list failed", status: "failed" });
        complete(promptId, "unrelated permission denied");
        permissionId = undefined;
        continue;
      }
      if (reviewerGenericWrite) {
        // Generic title that previously matched the deleted /replace|write|edit|mutat/ fallback.
        update({ sessionUpdate: "tool_call", toolCallId: "generic-write-1", title: "write file", status: "pending" });
        update({ sessionUpdate: "tool_call_update", toolCallId: "generic-write-1", title: "write file failed", status: "failed" });
        complete(promptId, "generic write denied without named target");
        permissionId = undefined;
        continue;
      }
      // Exercise the outer read-only mount after the parent-controlled ACP permission denial. The
      // fixture may report a failed tool only when the kernel actually refused the named target.
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
  // Keep the process alive for one short bounded turn so the parent observes the protocol pipe's
  // `finish` callback before the clean child close. This models a native runtime draining stdio.
  setTimeout(() => process.exit(0), 500);
});

// A provider-side crash marker would be visible to the fixture test if the parent killed us without
// completing protocol teardown. The normal route closes stdin after the terminal and exits cleanly.
process.on("exit", (code) => {
  const marker = process.env.RELAYFORGE_FIXTURE_EXIT_MARKER;
  if (marker) {
    try { writeFileSync(marker, String(code ?? 0)); } catch { /* ignore */ }
  }
});

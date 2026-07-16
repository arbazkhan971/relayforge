import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BoardTask } from "../board.js";
import type { SessionView } from "./state.js";

/**
 * Feedback router: turn observed PR facts (CI failures, unresolved review threads,
 * merge conflicts) into board tasks assigned to the session that owns the branch —
 * the reference's "route it back to the right session" loop, expressed as a pure
 * decision function so it can be fixture-tested without GitHub.
 */

export type PrCheck = {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion?: "success" | "failure" | "cancelled" | "timed_out" | "action_required" | "neutral" | "skipped";
  /** Tail of the failing job log, when the observer could fetch it. */
  logTail?: string;
};

export type PrReviewThread = {
  id: string;
  resolved: boolean;
  path?: string;
  line?: number;
  author?: string;
  body: string;
};

export type PrFacts = {
  prRef: string;
  state: "open" | "closed" | "merged";
  /** null = GitHub hasn't computed mergeability yet — treat as unknown, not conflict. */
  mergeable: boolean | null;
  checks: PrCheck[];
  reviewThreads: PrReviewThread[];
};

export type RoutedTask = { key: string; task: BoardTask };

/**
 * Decide which feedback items become board tasks. `alreadyRouted` carries the keys of
 * items routed on earlier polls so a failure is dispatched once, not on every poll.
 * Nothing is routed for closed/merged PRs — that feedback loop is over.
 */
export function routeFeedback(
  session: SessionView,
  facts: PrFacts,
  alreadyRouted: ReadonlySet<string>,
  nowIso: string
): RoutedTask[] {
  if (facts.state !== "open") return [];
  const routed: RoutedTask[] = [];

  const failing = facts.checks.filter(
    (check) => check.status === "completed" && (check.conclusion === "failure" || check.conclusion === "timed_out")
  );
  for (const check of failing) {
    const key = `${facts.prRef}:ci:${check.name}`;
    if (alreadyRouted.has(key)) continue;
    routed.push({
      key,
      task: makeTask(session, key, nowIso, {
        title: `Fix failing CI check: ${check.name} (${facts.prRef})`,
        description: [
          `CI check "${check.name}" failed on ${facts.prRef} (branch ${session.branch ?? "unknown"}).`,
          check.logTail ? `Failing log tail:\n${check.logTail}` : "Fetch the job log for details.",
          "Reproduce locally, fix the root cause, and push to the same branch."
        ].join("\n\n"),
        acceptanceCriteria: [`CI check "${check.name}" passes on ${facts.prRef}.`],
        priority: 9
      })
    });
  }

  for (const thread of facts.reviewThreads.filter((t) => !t.resolved)) {
    const key = `${facts.prRef}:review:${thread.id}`;
    if (alreadyRouted.has(key)) continue;
    const where = thread.path ? `${thread.path}${thread.line ? `:${thread.line}` : ""}` : "the PR";
    routed.push({
      key,
      task: makeTask(session, key, nowIso, {
        title: `Address review comment on ${where} (${facts.prRef})`,
        description: [
          `Reviewer${thread.author ? ` ${thread.author}` : ""} commented on ${where} of ${facts.prRef}:`,
          thread.body,
          "Address the comment (or reply with a justified pushback) and push to the same branch."
        ].join("\n\n"),
        acceptanceCriteria: [`Review thread ${thread.id} on ${facts.prRef} is resolved.`],
        priority: 7
      })
    });
  }

  if (facts.mergeable === false) {
    const key = `${facts.prRef}:conflict`;
    if (!alreadyRouted.has(key)) {
      routed.push({
        key,
        task: makeTask(session, key, nowIso, {
          title: `Resolve merge conflict on ${facts.prRef}`,
          description: [
            `${facts.prRef} (branch ${session.branch ?? "unknown"}) has a merge conflict with its base branch.`,
            "Rebase the branch onto the latest base, resolve conflicts, run the tests, and force-push with lease."
          ].join("\n\n"),
          acceptanceCriteria: [`${facts.prRef} is mergeable (no conflicts).`],
          priority: 8
        })
      });
    }
  }

  return routed;
}

function makeTask(
  session: SessionView,
  key: string,
  nowIso: string,
  fields: { title: string; description: string; acceptanceCriteria: string[]; priority: number }
): BoardTask {
  return {
    // Deterministic id derived from the routing key so replays never duplicate.
    id: `fb-${sanitize(key)}`,
    title: fields.title,
    assignee: session.role,
    createdBy: "daemon-router",
    description: fields.description,
    acceptanceCriteria: fields.acceptanceCriteria,
    dependsOn: [],
    priority: fields.priority,
    createdAt: nowIso
  };
}

function sanitize(key: string): string {
  return key.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

/**
 * Routed-key memory, persisted as one key per line under the daemon state dir so
 * restarts don't re-dispatch feedback that was already routed.
 */
export function routedKeysPath(stateDir: string): string {
  return resolve(stateDir, "routed-keys.log");
}

export function readRoutedKeys(stateDir: string): Set<string> {
  const file = routedKeysPath(stateDir);
  if (!existsSync(file)) return new Set();
  return new Set(
    readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  );
}

export function appendRoutedKeys(stateDir: string, keys: string[]): void {
  if (!keys.length) return;
  appendFileSync(routedKeysPath(stateDir), keys.map((key) => `${key}\n`).join(""));
}

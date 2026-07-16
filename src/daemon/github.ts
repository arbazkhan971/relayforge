import { spawnSync } from "node:child_process";
import type { PrCheck, PrFacts, PrReviewThread } from "./router.js";

/**
 * GitHub observer: reads PR facts for a session's branch using the `gh` CLI (the
 * lowest-dependency path to an authenticated GitHub view). The exec is injectable so
 * tests feed fixture JSON instead of a live `gh`.
 *
 * OBSERVE only — no decisions here. Everything returned is a durable external fact;
 * routing decisions live in router.ts.
 */

export type ExecResult = { status: number; stdout: string };
export type Exec = (cmd: string, args: string[], cwd?: string) => ExecResult;

const defaultExec: Exec = (cmd, args, cwd) => {
  const result = spawnSync(cmd, args, { encoding: "utf8", cwd, timeout: 20_000 });
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
};

/** Whether `gh` is installed and authenticated — polls are skipped otherwise. */
export function ghAvailable(exec: Exec = defaultExec): boolean {
  return exec("gh", ["auth", "status"]).status === 0;
}

/**
 * Observe PR facts for a branch. Returns undefined when there is no PR for the
 * branch (nothing to route) or `gh` fails (failed probe ≠ anything — try next poll).
 */
export function observePrFacts(
  branch: string,
  cwd?: string,
  exec: Exec = defaultExec
): PrFacts | undefined {
  const view = exec(
    "gh",
    [
      "pr",
      "view",
      branch,
      "--json",
      "number,url,state,mergeable,statusCheckRollup,reviewThreads"
    ],
    cwd
  );
  if (view.status !== 0) return undefined;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(view.stdout);
  } catch {
    return undefined;
  }

  const state = String(parsed.state ?? "").toLowerCase();
  return {
    prRef: String(parsed.url ?? `#${parsed.number ?? "?"}`),
    state: state === "merged" ? "merged" : state === "closed" ? "closed" : "open",
    mergeable: parseMergeable(parsed.mergeable),
    checks: parseChecks(parsed.statusCheckRollup),
    reviewThreads: parseThreads(parsed.reviewThreads)
  };
}

function parseMergeable(value: unknown): boolean | null {
  // gh reports MERGEABLE | CONFLICTING | UNKNOWN.
  if (value === "MERGEABLE") return true;
  if (value === "CONFLICTING") return false;
  return null;
}

function parseChecks(value: unknown): PrCheck[] {
  if (!Array.isArray(value)) return [];
  return value.map((item: Record<string, unknown>) => {
    const status = String(item.status ?? "").toLowerCase();
    const conclusion = String(item.conclusion ?? "").toLowerCase();
    return {
      name: String(item.name ?? item.context ?? "check"),
      status: status === "completed" ? "completed" : status === "queued" ? "queued" : "in_progress",
      conclusion: conclusion ? (conclusion as PrCheck["conclusion"]) : undefined
    };
  });
}

function parseThreads(value: unknown): PrReviewThread[] {
  if (!Array.isArray(value)) return [];
  return value.map((item: Record<string, unknown>, index: number) => {
    const comments = Array.isArray(item.comments) ? (item.comments as Record<string, unknown>[]) : [];
    const first = comments[0] ?? {};
    return {
      id: String(item.id ?? `thread-${index}`),
      resolved: Boolean(item.isResolved ?? item.resolved ?? false),
      path: typeof item.path === "string" ? item.path : typeof first.path === "string" ? first.path : undefined,
      line: typeof item.line === "number" ? item.line : typeof first.line === "number" ? first.line : undefined,
      author: typeof (first.author as Record<string, unknown>)?.login === "string"
        ? String((first.author as Record<string, unknown>).login)
        : undefined,
      body: comments.map((comment) => String(comment.body ?? "")).filter(Boolean).join("\n---\n")
    };
  });
}

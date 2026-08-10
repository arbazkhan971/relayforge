import { createHash } from "node:crypto";
import type { GithubTransport, GithubTransportRequest } from "./github.js";
import type {
  ScmMultiRepoCrossLinkRequestV1,
  ScmMultiRepoCrossLinkWriterV1
} from "./multirepo-bridge.js";

export const GITHUB_CROSSLINK_LIMITS = Object.freeze({
  maximumRequests: 3,
  maximumResponseBytes: 256 * 1024,
  maximumBodyBytes: 64 * 1024
});

type PullBodyObservation =
  | Readonly<{ state: "observed"; body: string }>
  | Readonly<{ state: "retry"; code: string }>
  | Readonly<{ state: "recovery_required"; code: string }>;

function apiBase(host: string): string {
  return host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
}

function boundedCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9_]/gu, "_").slice(0, 96) || "GITHUB_CROSSLINK_FAILED";
}

async function body(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > GITHUB_CROSSLINK_LIMITS.maximumResponseBytes) {
        await reader.cancel();
        throw new Error("response_limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function failure(response: Response): Exclude<PullBodyObservation, { state: "observed" }> {
  if (response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500) {
    return Object.freeze({ state: "retry", code: `GITHUB_CROSSLINK_HTTP_${response.status}` });
  }
  return Object.freeze({ state: "recovery_required", code: `GITHUB_CROSSLINK_HTTP_${response.status}` });
}

function fullName(owner: string, name: string): string { return `${owner}/${name}`; }

function observedPull(
  value: unknown,
  request: ScmMultiRepoCrossLinkRequestV1
): PullBodyObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return Object.freeze({ state: "recovery_required", code: "GITHUB_CROSSLINK_SCHEMA" });
  }
  const row = value as Record<string, unknown>;
  const head = row.head && typeof row.head === "object" && !Array.isArray(row.head) ? row.head as Record<string, unknown> : {};
  const base = row.base && typeof row.base === "object" && !Array.isArray(row.base) ? row.base as Record<string, unknown> : {};
  const headRepo = head.repo && typeof head.repo === "object" && !Array.isArray(head.repo) ? head.repo as Record<string, unknown> : {};
  const baseRepo = base.repo && typeof base.repo === "object" && !Array.isArray(base.repo) ? base.repo as Record<string, unknown> : {};
  const expectedHeadRef = request.publication.intent.remoteRef.slice("refs/heads/".length);
  const expectedBaseRef = request.publication.intent.baseRef.slice("refs/heads/".length);
  if (
    row.number !== request.publication.pullRequest?.number || typeof row.body !== "string" ||
    head.sha !== request.publication.intent.integrationOid || head.ref !== expectedHeadRef ||
    headRepo.full_name !== fullName(request.binding.repository.owner, request.binding.repository.name) ||
    base.ref !== expectedBaseRef ||
    baseRepo.full_name !== fullName(request.binding.baseRepository.owner, request.binding.baseRepository.name)
  ) {
    return Object.freeze({ state: "recovery_required", code: "GITHUB_CROSSLINK_IDENTITY" });
  }
  if (Buffer.byteLength(row.body, "utf8") > GITHUB_CROSSLINK_LIMITS.maximumBodyBytes) {
    return Object.freeze({ state: "recovery_required", code: "GITHUB_CROSSLINK_BODY_LIMIT" });
  }
  return Object.freeze({ state: "observed", body: row.body });
}

async function requestJson(
  transport: GithubTransport,
  request: GithubTransportRequest,
  identity: ScmMultiRepoCrossLinkRequestV1
): Promise<PullBodyObservation> {
  let response: Response;
  try { response = await transport(request); }
  catch {
    return Object.freeze({ state: "retry", code: request.signal.aborted ? "GITHUB_CROSSLINK_CANCELLED" : "GITHUB_CROSSLINK_NETWORK" });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return failure(response);
  }
  const type = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!type.startsWith("application/json")) {
    await response.body?.cancel().catch(() => undefined);
    return Object.freeze({ state: "recovery_required", code: "GITHUB_CROSSLINK_CONTENT_TYPE" });
  }
  try {
    const bytes = await body(response);
    return observedPull(JSON.parse(Buffer.from(bytes).toString("utf8")), identity);
  } catch {
    return Object.freeze({ state: "recovery_required", code: "GITHUB_CROSSLINK_SCHEMA" });
  }
}

function desiredBody(request: ScmMultiRepoCrossLinkRequestV1): string | undefined {
  const start = "<!-- relayforge-crosslinks-v1 -->";
  const end = "<!-- /relayforge-crosslinks-v1 -->";
  const artifacts = [...request.artifacts].sort((left, right) => left.repositoryId.localeCompare(right.repositoryId));
  const lines = artifacts.map((artifact) => `- ${artifact.repositoryId}: ${artifact.url}`);
  const block = `${start}\nRelated RelayForge changes:\n${lines.join("\n")}\n${end}`;
  const prior = request.entry.body;
  const startAt = prior.indexOf(start);
  const endAt = prior.indexOf(end);
  let result: string;
  if (startAt === -1 && endAt === -1) result = `${prior.replace(/\s+$/u, "")}\n\n${block}\n`;
  else if (startAt >= 0 && endAt >= startAt) result = `${prior.slice(0, startAt)}${block}${prior.slice(endAt + end.length)}`;
  else return undefined;
  if (Buffer.byteLength(result, "utf8") > GITHUB_CROSSLINK_LIMITS.maximumBodyBytes || /[\u0000\r]/u.test(result)) return undefined;
  return result;
}

function receiptDigest(request: ScmMultiRepoCrossLinkRequestV1, value: string): string {
  return createHash("sha256")
    .update("relayforge-github-crosslinks-v1\0", "utf8")
    .update(request.publication.publicationId, "utf8")
    .update("\0", "utf8")
    .update(request.publication.intent.integrationOid, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

/**
 * Exact PR-body cross-link capability. It reconciles before mutation and after every ambiguous
 * mutation, and only accepts a response whose PR/repository/head/base identity still matches the
 * canonical publication fact.
 */
export function createGithubPullRequestBodyCrossLinkWriter(input: Readonly<{
  transports: Readonly<Record<string, GithubTransport>>;
}>): ScmMultiRepoCrossLinkWriterV1 {
  return Object.freeze({
    async ensureCrossLinks(request: ScmMultiRepoCrossLinkRequestV1) {
      const transport = input.transports[request.binding.repositoryKey];
      if (!transport) return Object.freeze({ state: "recovery_required" as const, code: "GITHUB_CROSSLINK_CAPABILITY_MISSING" });
      if (request.signal.aborted) return Object.freeze({ state: "retry" as const, code: "GITHUB_CROSSLINK_CANCELLED" });
      const desired = desiredBody(request);
      if (desired === undefined) return Object.freeze({ state: "recovery_required" as const, code: "GITHUB_CROSSLINK_BODY_INVALID" });
      const pull = request.publication.pullRequest;
      if (!pull) return Object.freeze({ state: "recovery_required" as const, code: "GITHUB_CROSSLINK_PR_MISSING" });
      const url = `${apiBase(request.binding.repository.canonicalHost)}/repos/${encodeURIComponent(request.binding.baseRepository.owner)}/${encodeURIComponent(request.binding.baseRepository.name)}/pulls/${pull.number}`;
      const headers = Object.freeze({ accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" });
      const get = (): Promise<PullBodyObservation> => requestJson(transport, Object.freeze({ url, method: "GET", redirect: "error", headers, signal: request.signal }), request);
      const before = await get();
      if (before.state !== "observed") return Object.freeze(before);
      if (before.body === desired) {
        return Object.freeze({ state: "completed" as const, value: Object.freeze({ digest: receiptDigest(request, desired) }), completedBy: "existing" as const });
      }
      const payload = Buffer.from(JSON.stringify({ body: desired }), "utf8");
      const patched = await requestJson(transport, Object.freeze({
        url,
        method: "PATCH",
        redirect: "error",
        headers: Object.freeze({ ...headers, "content-type": "application/json", "content-length": String(payload.byteLength) }),
        body: payload,
        signal: request.signal
      }), request);
      if (patched.state === "observed" && patched.body === desired) {
        return Object.freeze({ state: "completed" as const, value: Object.freeze({ digest: receiptDigest(request, desired) }), completedBy: "update" as const });
      }
      // Any non-confirming PATCH is ambiguous: one bounded exact read decides whether the effect
      // happened. A differing body is retryable only when the PR identity remains exact.
      const after = await get();
      if (after.state === "observed" && after.body === desired) {
        return Object.freeze({ state: "completed" as const, value: Object.freeze({ digest: receiptDigest(request, desired) }), completedBy: "reconciled" as const });
      }
      if (after.state === "observed") return Object.freeze({ state: "retry" as const, code: "GITHUB_CROSSLINK_NOT_OBSERVED" });
      return Object.freeze({ ...after, code: boundedCode(after.code) });
    }
  });
}

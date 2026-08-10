import { createHash } from "node:crypto";
import { z } from "zod";
import {
  normalizeCheckWindow,
  normalizeExternalText,
  normalizeReviewWindow,
  type RawScmCheckV1,
  type RawScmEvidenceV1
} from "./evidence.js";
import {
  ScmCiFactV1Schema,
  ScmMergeabilityFactV1Schema,
  ScmPullRequestFactV1Schema,
  ScmReviewFactV1Schema,
  canonicalizeScmHost,
  materializeScmFactBucket,
  parseScmProviderFailure,
  parseScmProviderLimits,
  parseScmPullRequestFact,
  parseScmPullRequestIdentity,
  parseScmRepositoryId,
  parseScmHttpsUrl,
  sameScmRepository,
  scmRepositoryKey,
  scmSemanticDigest
} from "./schema.js";
import {
  SCM_PROVIDER_LIMITS,
  type ScmCiFactV1,
  type ScmCompleteness,
  type ScmCreatePullRequestRequestV1,
  type ScmCreatePullRequestResultV1,
  type ScmEvidenceV1,
  type ScmFactBucketV1,
  type ScmFetchResultV1,
  type ScmMergeabilityFactV1,
  type ScmNormalizedCheckV1,
  type ScmObservationRequestV1,
  type ScmObservationResultV1,
  type ScmProviderFailureV1,
  type ScmProviderLimitsV1,
  type ScmProviderV1,
  type ScmPullRequestFactV1,
  type ScmPullRequestLookupRequestV1,
  type ScmPullRequestLookupResultV1,
  type ScmRepositoryIdV1,
  type ScmReviewDecision,
  type ScmReviewFactV1
} from "./types.js";

export const GITHUB_API_VERSION = "2022-11-28";
export const GITHUB_MAX_GUARD_AGE_MS = 5 * 60_000;
export const GITHUB_FACT_FRESHNESS_MS = 60_000;

/** Credentials, if any, are closed over by this transport and never enter adapter DTOs. */
export type GithubTransportRequest = Readonly<{
  url: string;
  method: "GET" | "POST" | "PATCH";
  redirect: "error";
  headers: Readonly<Record<string, string>>;
  body?: Uint8Array;
  signal: AbortSignal;
}>;

export type GithubTransport = (request: GithubTransportRequest) => Promise<Response>;

export type GithubScmProviderOptions = Readonly<{
  canonicalHost: string;
  transport: GithubTransport;
  now?: () => Date;
  maxGuardAgeMs?: number;
  freshnessMs?: number;
}>;

type Budget = {
  readonly limits: ScmProviderLimitsV1;
  requestCount: number;
  decodedBytes: number;
};

type GithubFailure = { readonly ok: false; readonly failure: ScmProviderFailureV1 };
type GithubValue<T> = {
  readonly ok: true;
  readonly value: T;
  readonly status: number;
  readonly etag?: string;
  readonly link?: string;
  readonly notModified: boolean;
};
type GithubResult<T> = GithubValue<T> | GithubFailure;

type EndpointCache = {
  readonly etag?: string;
  readonly value: unknown;
  readonly complete: boolean;
  readonly cursor?: string;
  readonly fetchedAtMs: number;
};

type PageWindow = {
  readonly items: readonly unknown[];
  readonly complete: boolean;
  readonly notModified: boolean;
  readonly etag?: string;
  readonly cursor?: string;
  readonly failure?: ScmProviderFailureV1;
};

type PullRequestWindow = {
  readonly result: ScmFetchResultV1<ScmPullRequestFactV1>;
  readonly raw?: Record<string, unknown>;
};

type CiWindow = {
  readonly result: ScmFetchResultV1<ScmCiFactV1>;
  readonly logEvidence: readonly RawScmEvidenceV1[];
  readonly logsComplete: boolean;
};

type EvidenceSourceMetadata = Readonly<{
  originalBytes: number;
  truncated: boolean;
  sanitized: boolean;
}>;

const BOUNDED_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const MAX_ENDPOINT_CACHES = 64;

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function boundedId(value: unknown, prefix: string): string {
  const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
  if (BOUNDED_ID.test(text)) return text;
  return `${prefix}-${hash(text || "unknown").slice(0, 32)}`;
}

function failure(
  kind: ScmProviderFailureV1["kind"],
  code: string,
  retryable: boolean,
  diagnostic: string,
  nextEligibleAt?: string
): ScmProviderFailureV1 {
  return parseScmProviderFailure({
    kind,
    retryable,
    code,
    diagnostic: normalizeExternalText(diagnostic, 4_096).text,
    ...(nextEligibleAt === undefined ? {} : { nextEligibleAt })
  });
}

function schemaFailure(code = "GITHUB_SCHEMA"): ScmProviderFailureV1 {
  return failure("schema", code, false, "GitHub returned a malformed or unsupported response");
}

function budgetFailure(code: string, diagnostic: string): ScmProviderFailureV1 {
  return failure("budget_exceeded", code, false, diagnostic);
}

function paginationFailure(code: string, diagnostic: string): ScmProviderFailureV1 {
  return failure("pagination", code, false, diagnostic);
}

function timestamp(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("GitHub timestamp is missing");
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new TypeError("GitHub timestamp is invalid");
  return new Date(time).toISOString();
}

function optionalTimestamp(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : timestamp(value);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("GitHub object is malformed");
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, maximum = 4_096): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maximum) {
    throw new TypeError(`${label} is malformed`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new TypeError(`${label} is malformed`);
  return Number(value);
}

function shortBranch(value: string): string {
  if (!value.startsWith("refs/heads/")) throw new TypeError("GitHub branch ref is not a head ref");
  return value.slice("refs/heads/".length);
}

function fullBranch(value: unknown): string {
  const branch = string(value, "GitHub branch", 512);
  return branch.startsWith("refs/heads/") ? branch : `refs/heads/${branch}`;
}

function author(value: unknown): { authorKind: "human" | "bot" | "unknown"; authorId: string } {
  if (value === null || value === undefined) return { authorKind: "unknown", authorId: "unknown" };
  const user = record(value);
  const login = typeof user.login === "string" ? user.login : "unknown";
  const type = typeof user.type === "string"
    ? user.type.toLowerCase()
    : typeof user.__typename === "string"
      ? user.__typename.toLowerCase()
      : "";
  const authorKind = type === "bot" || /\[bot\]$/iu.test(login) ? "bot" : login === "unknown" ? "unknown" : "human";
  return { authorKind, authorId: boundedId(login.replace(/\[bot\]$/iu, "-bot"), "github-user") };
}

function safeEtag(value: string | null | undefined): string | undefined {
  if (!value || Buffer.byteLength(value, "utf8") > 512 || /[\x00-\x1f\x7f]/u.test(value)) return undefined;
  return value;
}

function canonicalWebUrl(value: unknown, host: string): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  return parseScmHttpsUrl(string(value, "GitHub web URL"), host);
}

function optionalCanonicalWebUrl(value: unknown, host: string): string | undefined {
  try { return canonicalWebUrl(value, host); } catch { return undefined; }
}

function normalizeRepository(value: unknown, host: string): ScmRepositoryIdV1 {
  const repository = record(value);
  const ownerValue = repository.owner === undefined ? undefined : record(repository.owner).login;
  const fullName = typeof repository.full_name === "string" ? repository.full_name.split("/") : [];
  const owner = String(ownerValue ?? fullName[0] ?? "").toLowerCase();
  const name = String(repository.name ?? fullName[1] ?? "").toLowerCase();
  return parseScmRepositoryId({ schemaVersion: 1, provider: "github", canonicalHost: host, owner, name });
}

function parsePullRequest(value: unknown, host: string, etag?: string): ScmPullRequestFactV1 {
  const pull = record(value);
  const head = record(pull.head);
  const base = record(pull.base);
  const repository = normalizeRepository(base.repo, host);
  const headRepository = normalizeRepository(head.repo, host);
  const baseRepository = normalizeRepository(base.repo, host);
  const state = string(pull.state, "GitHub pull request state", 32).toLowerCase();
  const merged = pull.merged === true || pull.merged_at !== null && pull.merged_at !== undefined;
  const lifecycle = merged ? "merged" : state === "open" ? "open" : state === "closed" ? "closed" : undefined;
  if (!lifecycle) throw new TypeError("GitHub pull request lifecycle is unknown");
  return parseScmPullRequestFact({
    providerId: boundedId(pull.id ?? pull.node_id ?? pull.number, "github-pr"),
    number: integer(pull.number, "GitHub pull request number"),
    url: canonicalWebUrl(pull.html_url, host),
    repository,
    headRepository,
    headRef: fullBranch(head.ref),
    headSha: string(head.sha, "GitHub head SHA", 64).toLowerCase(),
    baseRepository,
    baseRef: fullBranch(base.ref),
    baseSha: string(base.sha, "GitHub base SHA", 64).toLowerCase(),
    lifecycle,
    draft: lifecycle === "open" && pull.draft === true,
    ...(etag ? { resourceVersion: etag } : {})
  });
}

function exactRequestIdentity(request: ScmObservationRequestV1): void {
  const repository = parseScmRepositoryId(request.repository);
  const pull = parseScmPullRequestIdentity(request.pullRequest);
  parseScmProviderLimits(request.limits);
  if (!sameScmRepository(repository, pull.repository)) throw new TypeError("SCM observation repository and pull request differ");
  if (request.expectedHeadSha !== pull.headSha || !SHA.test(request.expectedHeadSha)) {
    throw new TypeError("SCM observation expected head differs from pull request identity");
  }
}

function combineSignals(parent: AbortSignal, timeoutMs: number): {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timeout = false;
  const abort = () => controller.abort(parent.reason);
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timeout = true;
    controller.abort(new Error("GitHub request timeout"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timeout,
    cleanup: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", abort);
    }
  };
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error("aborted");
  return await new Promise<T>((resolvePromise, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolvePromise(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); }
    );
  });
}

async function readBounded(response: Response, budget: Budget, signal: AbortSignal): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/u.test(contentLength)) {
    const length = Number(contentLength);
    if (length > budget.limits.maxDecodedBytesPerRequest || budget.decodedBytes + length > budget.limits.maxDecodedBytesPerPoll) {
      throw budgetFailure("GITHUB_RESPONSE_BYTES", "GitHub response exceeds the decoded byte budget");
    }
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await abortable(reader.read(), signal);
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > budget.limits.maxDecodedBytesPerRequest || budget.decodedBytes + bytes > budget.limits.maxDecodedBytesPerPoll) {
        await reader.cancel();
        throw budgetFailure("GITHUB_RESPONSE_BYTES", "GitHub response exceeds the decoded byte budget");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  budget.decodedBytes += bytes;
  const result = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function nextEligible(response: Response, nowMs: number): string {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return new Date(nowMs + Math.min(seconds, 86_400) * 1_000).toISOString();
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date) && date >= nowMs) return new Date(Math.min(date, nowMs + 86_400_000)).toISOString();
  }
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset * 1_000 >= nowMs) return new Date(Math.min(reset * 1_000, nowMs + 86_400_000)).toISOString();
  return new Date(nowMs + 60_000).toISOString();
}

function statusFailure(response: Response, nowMs: number): ScmProviderFailureV1 {
  if (response.status === 401) return failure("auth", "GITHUB_AUTH", false, "GitHub authentication failed");
  const rateLimited = response.status === 429 || response.status === 403 && (
    response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")
  );
  if (rateLimited) {
    return failure("rate_limited", "GITHUB_RATE_LIMIT", true, "GitHub request is rate limited", nextEligible(response, nowMs));
  }
  if (response.status === 403) return failure("permission", "GITHUB_PERMISSION", false, "GitHub denied this operation");
  if (response.status === 404) return failure("permission", "GITHUB_NOT_FOUND", false, "GitHub resource is unavailable or not permitted");
  return failure(
    "provider",
    `GITHUB_HTTP_${response.status}`,
    response.status >= 500,
    `GitHub returned HTTP ${response.status}`
  );
}

function guardValue(values: Readonly<Record<string, string | undefined>>): string | undefined {
  const entries = Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return undefined;
  return Buffer.from(JSON.stringify({ v: 1, e: Object.fromEntries(entries) }), "utf8").toString("base64url");
}

function parseGuard(value: string | undefined): Readonly<Record<string, string>> {
  if (!value || value.length > 1_024) return {};
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    const outer = record(decoded);
    if (outer.v !== 1) return {};
    const entries = Object.entries(record(outer.e));
    if (entries.length > 16 || entries.some(([key, item]) => !/^[a-z][a-z0-9_-]{0,31}$/u.test(key) || typeof item !== "string" || item.length > 512)) return {};
    return Object.freeze(Object.fromEntries(entries) as Record<string, string>);
  } catch {
    return {};
  }
}

function parseNextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  if (Buffer.byteLength(header, "utf8") > 16 * 1_024) throw paginationFailure("GITHUB_LINK_BYTES", "GitHub pagination Link header is too large");
  let next: string | undefined;
  for (const part of header.split(",")) {
    const match = part.trim().match(/^<([^>]+)>\s*;(.*)$/u);
    if (!match) throw paginationFailure("GITHUB_LINK_MALFORMED", "GitHub pagination Link header is malformed");
    const relations = [...match[2]!.matchAll(/(?:^|;)\s*rel="([^"]+)"/gu)].flatMap((item) => item[1]!.split(/\s+/u));
    if (!relations.includes("next")) continue;
    if (next !== undefined) throw paginationFailure("GITHUB_LINK_AMBIGUOUS", "GitHub pagination has multiple next links");
    next = match[1]!;
  }
  return next;
}

function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function bucketFailure<T>(value: ScmProviderFailureV1): ScmFetchResultV1<T> {
  return Object.freeze({ fetched: false, failure: value });
}

export class GithubScmProvider implements ScmProviderV1 {
  readonly provider = "github" as const;
  readonly capabilities = Object.freeze(["scm.read", "scm.write_pr"] as const);

  private readonly canonicalHost: string;
  private readonly apiHost: string;
  private readonly restBase: string;
  private readonly graphqlUrl: string;
  private readonly transport: GithubTransport;
  private readonly now: () => Date;
  private readonly maxGuardAgeMs: number;
  private readonly freshnessMs: number;
  private readonly endpoints = new Map<string, EndpointCache>();
  private readonly attemptedFailureLogs = new Set<string>();
  private readonly failureLogEvidence = new Map<string, { evidence: readonly RawScmEvidenceV1[]; complete: boolean }>();
  private readonly evidenceSourceMetadata = new WeakMap<object, EvidenceSourceMetadata>();

  constructor(options: GithubScmProviderOptions) {
    this.canonicalHost = canonicalizeScmHost(options.canonicalHost);
    this.apiHost = this.canonicalHost === "github.com" ? "api.github.com" : this.canonicalHost;
    this.restBase = this.canonicalHost === "github.com"
      ? "https://api.github.com"
      : `https://${this.apiHost}/api/v3`;
    this.graphqlUrl = this.canonicalHost === "github.com"
      ? "https://api.github.com/graphql"
      : `https://${this.apiHost}/api/graphql`;
    if (typeof options.transport !== "function") throw new TypeError("GitHub transport is required");
    this.transport = options.transport;
    this.now = options.now ?? (() => new Date());
    this.maxGuardAgeMs = options.maxGuardAgeMs ?? GITHUB_MAX_GUARD_AGE_MS;
    this.freshnessMs = options.freshnessMs ?? GITHUB_FACT_FRESHNESS_MS;
    if (!Number.isSafeInteger(this.maxGuardAgeMs) || this.maxGuardAgeMs < 0 || this.maxGuardAgeMs > 86_400_000) {
      throw new TypeError("GitHub guard max age is invalid");
    }
    if (!Number.isSafeInteger(this.freshnessMs) || this.freshnessMs < 1 || this.freshnessMs > 86_400_000) {
      throw new TypeError("GitHub fact freshness is invalid");
    }
  }

  private nowMs(): number {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError("GitHub adapter clock returned an invalid Date");
    return value.getTime();
  }

  private rememberEndpoint(key: string, value: EndpointCache): void {
    this.endpoints.delete(key);
    this.endpoints.set(key, value);
    while (this.endpoints.size > MAX_ENDPOINT_CACHES) this.endpoints.delete(this.endpoints.keys().next().value!);
  }

  private assertRepository(repositoryValue: ScmRepositoryIdV1): ScmRepositoryIdV1 {
    const repository = parseScmRepositoryId(repositoryValue);
    if (repository.provider !== "github" || repository.canonicalHost !== this.canonicalHost) {
      throw new TypeError("GitHub adapter repository is outside its canonical host");
    }
    return repository;
  }

  private apiUrl(path: string, query?: Readonly<Record<string, string | number | undefined>>): string {
    if (!path.startsWith("/") || path.includes("//") || /[\x00-\x1f\x7f]/u.test(path)) throw new TypeError("GitHub API path is invalid");
    const url = new URL(`${this.restBase}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
    return this.assertApiUrl(url.toString());
  }

  private assertApiUrl(value: string): string {
    let url: URL;
    try { url = new URL(value); } catch { throw paginationFailure("GITHUB_URL_INVALID", "GitHub API URL is invalid"); }
    const prefix = this.canonicalHost === "github.com" ? "/" : "/api/";
    if (
      url.protocol !== "https:" ||
      url.hostname !== this.apiHost ||
      url.host !== this.apiHost ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      !url.pathname.startsWith(prefix) ||
      url.pathname.includes("//") ||
      Buffer.byteLength(url.toString(), "utf8") > 8_192
    ) {
      throw paginationFailure("GITHUB_FOREIGN_URL", "GitHub API URL left the configured canonical host");
    }
    return url.toString();
  }

  private async requestBytes(input: {
    url: string;
    method?: "GET" | "POST";
    body?: Uint8Array;
    etag?: string;
    limits: ScmProviderLimitsV1;
    budget: Budget;
    signal: AbortSignal;
    accept?: string;
  }): Promise<GithubResult<Uint8Array>> {
    let url: string;
    try { url = this.assertApiUrl(input.url); } catch (error) {
      return { ok: false, failure: error && typeof error === "object" && "kind" in error ? error as ScmProviderFailureV1 : paginationFailure("GITHUB_FOREIGN_URL", "GitHub request URL is invalid") };
    }
    if (input.signal.aborted) return { ok: false, failure: failure("cancelled", "GITHUB_CANCELLED", false, "GitHub request was cancelled") };
    if (input.budget.decodedBytes >= input.limits.maxDecodedBytesPerPoll) {
      return { ok: false, failure: budgetFailure("GITHUB_POLL_BYTES", "GitHub poll exhausted its decoded byte budget") };
    }
    const maximumRequests = input.limits.maxItemsPerEndpoint + input.limits.maxPagesPerEndpoint * 16 + 16;
    if (input.budget.requestCount >= maximumRequests) {
      return { ok: false, failure: budgetFailure("GITHUB_REQUEST_LIMIT", "GitHub poll exhausted its request budget") };
    }
    input.budget.requestCount += 1;
    const combined = combineSignals(input.signal, input.limits.requestTimeoutMs);
    try {
      const headers: Record<string, string> = {
        accept: input.accept ?? "application/vnd.github+json",
        "x-github-api-version": GITHUB_API_VERSION,
        "user-agent": "relayforge-scm/1"
      };
      const requestEtag = safeEtag(input.etag);
      if (requestEtag) headers["if-none-match"] = requestEtag;
      if (input.body) headers["content-type"] = "application/json";
      let response: Response;
      try {
        response = await abortable(Promise.resolve(this.transport({
          url,
          method: input.method ?? "GET",
          redirect: "error",
          headers,
          ...(input.body ? { body: input.body } : {}),
          signal: combined.signal
        })), combined.signal);
      } catch {
        return {
          ok: false,
          failure: combined.timedOut()
            ? failure("timeout", "GITHUB_TIMEOUT", true, "GitHub request timed out")
            : input.signal.aborted
              ? failure("cancelled", "GITHUB_CANCELLED", false, "GitHub request was cancelled")
              : failure("network", "GITHUB_NETWORK", true, "GitHub transport failed")
        };
      }
      if (response.status === 304) {
        return { ok: true, value: new Uint8Array(), status: 304, etag: safeEtag(response.headers.get("etag")) ?? requestEtag, notModified: true };
      }
      if (response.status < 200 || response.status >= 300) {
        return { ok: false, failure: statusFailure(response, this.nowMs()) };
      }
      try {
        const value = await readBounded(response, input.budget, combined.signal);
        return {
          ok: true,
          value,
          status: response.status,
          etag: safeEtag(response.headers.get("etag")),
          link: response.headers.get("link") ?? undefined,
          notModified: false
        };
      } catch (error) {
        if (error && typeof error === "object" && "kind" in error) return { ok: false, failure: error as ScmProviderFailureV1 };
        return {
          ok: false,
          failure: combined.timedOut()
            ? failure("timeout", "GITHUB_TIMEOUT", true, "GitHub response timed out")
            : input.signal.aborted
              ? failure("cancelled", "GITHUB_CANCELLED", false, "GitHub request was cancelled")
              : failure("network", "GITHUB_BODY", true, "GitHub response body could not be read")
        };
      }
    } finally {
      combined.cleanup();
    }
  }

  private async requestJson(input: Parameters<GithubScmProvider["requestBytes"]>[0]): Promise<GithubResult<unknown>> {
    const result = await this.requestBytes(input);
    if (!result.ok || result.notModified) return result as GithubResult<unknown>;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(result.value);
      return { ...result, value: JSON.parse(text) as unknown };
    } catch {
      return { ok: false, failure: schemaFailure("GITHUB_JSON") };
    }
  }

  private shouldForce(cacheKey: string, force: boolean): boolean {
    if (force) return true;
    const cache = this.endpoints.get(cacheKey);
    return !cache || this.nowMs() - cache.fetchedAtMs >= this.maxGuardAgeMs;
  }

  private async paginated(input: {
    cacheKey: string;
    url: string;
    guard?: string;
    force: boolean;
    limits: ScmProviderLimitsV1;
    budget: Budget;
    signal: AbortSignal;
    select: (value: unknown) => readonly unknown[];
  }): Promise<PageWindow | GithubFailure> {
    const force = this.shouldForce(input.cacheKey, input.force);
    const cached = this.endpoints.get(input.cacheKey);
    let current = this.assertApiUrl(input.url);
    const visited = new Set<string>();
    const items: unknown[] = [];
    let etag: string | undefined;
    let page = 0;
    for (;;) {
      if (page >= input.limits.maxPagesPerEndpoint) {
        return { items, complete: false, notModified: false, etag, cursor: scmSemanticDigest([...visited]), failure: paginationFailure("GITHUB_PAGE_LIMIT", "GitHub pagination exceeded the page ceiling") };
      }
      if (visited.has(current)) {
        return { items, complete: false, notModified: false, etag, cursor: scmSemanticDigest([...visited]), failure: paginationFailure("GITHUB_PAGE_CYCLE", "GitHub pagination contains a cycle") };
      }
      visited.add(current);
      const conditional = page === 0 && !force ? input.guard ?? cached?.etag : undefined;
      let response = await this.requestJson({
        url: current,
        etag: conditional,
        limits: input.limits,
        budget: input.budget,
        signal: input.signal
      });
      if (response.ok && response.notModified) {
        if (page !== 0 || force || !cached) {
          response = await this.requestJson({ url: current, limits: input.limits, budget: input.budget, signal: input.signal });
          if (response.ok && response.notModified) {
            return { ok: false, failure: schemaFailure("GITHUB_UNEXPECTED_304") };
          }
        } else {
          return {
            items: cached.value as readonly unknown[],
            complete: cached.complete,
            notModified: true,
            etag: response.etag ?? cached.etag,
            cursor: cached.cursor
          };
        }
      }
      if (!response.ok) {
        if (page === 0) return response;
        return { items, complete: false, notModified: false, etag, cursor: scmSemanticDigest([...visited]), failure: response.failure };
      }
      if (page === 0) etag = response.etag;
      let pageItems: readonly unknown[];
      try { pageItems = input.select(response.value); } catch {
        const malformed = schemaFailure("GITHUB_PAGE_SCHEMA");
        if (page === 0) return { ok: false, failure: malformed };
        return { items, complete: false, notModified: false, etag, cursor: scmSemanticDigest([...visited]), failure: malformed };
      }
      if (pageItems.length > input.limits.maxItemsPerPage) {
        const exceeded = budgetFailure("GITHUB_PAGE_ITEMS", "GitHub page exceeds the item ceiling");
        return { items, complete: false, notModified: false, etag, cursor: scmSemanticDigest([...visited]), failure: exceeded };
      }
      const remaining = input.limits.maxItemsPerEndpoint - items.length;
      items.push(...pageItems.slice(0, Math.max(0, remaining)));
      if (pageItems.length > remaining) {
        return { items, complete: false, notModified: false, etag, cursor: scmSemanticDigest([...visited]), failure: budgetFailure("GITHUB_ENDPOINT_ITEMS", "GitHub endpoint exceeds the item ceiling") };
      }
      let next: string | undefined;
      try {
        next = parseNextLink(response.link ?? null);
        if (next) next = this.assertApiUrl(new URL(next, current).toString());
      } catch (error) {
        const issue = error && typeof error === "object" && "kind" in error
          ? error as ScmProviderFailureV1
          : paginationFailure("GITHUB_LINK_MALFORMED", "GitHub pagination link is invalid");
        return { items, complete: false, notModified: false, etag, cursor: scmSemanticDigest([...visited]), failure: issue };
      }
      page += 1;
      if (!next) {
        const window = { items: Object.freeze([...items]), complete: true, notModified: false, etag, cursor: scmSemanticDigest([...visited]) } as const;
        this.rememberEndpoint(input.cacheKey, { etag, value: window.items, complete: true, cursor: window.cursor, fetchedAtMs: this.nowMs() });
        return window;
      }
      current = next;
    }
  }

  private async singleJson(input: {
    cacheKey: string;
    url: string;
    guard?: string;
    force: boolean;
    limits: ScmProviderLimitsV1;
    budget: Budget;
    signal: AbortSignal;
  }): Promise<GithubResult<unknown>> {
    const force = this.shouldForce(input.cacheKey, input.force);
    const cached = this.endpoints.get(input.cacheKey);
    let result = await this.requestJson({
      url: input.url,
      etag: force ? undefined : input.guard ?? cached?.etag,
      limits: input.limits,
      budget: input.budget,
      signal: input.signal
    });
    if (result.ok && result.notModified) {
      if (force || !cached) {
        result = await this.requestJson({ url: input.url, limits: input.limits, budget: input.budget, signal: input.signal });
        if (result.ok && result.notModified) return { ok: false, failure: schemaFailure("GITHUB_UNEXPECTED_304") };
      } else {
        return {
          ok: true,
          value: cached.value,
          status: 304,
          etag: result.etag ?? cached.etag,
          notModified: true
        };
      }
    }
    if (result.ok) {
      this.rememberEndpoint(input.cacheKey, {
        etag: result.etag,
        value: result.value,
        complete: true,
        fetchedAtMs: this.nowMs()
      });
    }
    return result;
  }

  private bucket<T>(input: {
    completeness: ScmCompleteness;
    observedHeadSha: string;
    facts: unknown;
    schema: z.ZodType<T>;
    guard?: string;
    cursor?: string;
  }): ScmFactBucketV1<T> {
    const observedAtMs = this.nowMs();
    const bucket = materializeScmFactBucket({
      completeness: input.completeness,
      observedHeadSha: input.observedHeadSha,
      observedAt: new Date(observedAtMs).toISOString(),
      freshUntil: new Date(observedAtMs + this.freshnessMs).toISOString(),
      facts: input.facts,
      ...(input.guard ? { guard: input.guard } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {})
    }, input.schema);
    return bucket;
  }

  private pullPath(repository: ScmRepositoryIdV1, number: number): string {
    return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls/${number}`;
  }

  private async pullRequestBucket(
    request: ScmObservationRequestV1,
    guard: string | undefined,
    bucketName: "pull_request" | "mergeability",
    budget: Budget
  ): Promise<PullRequestWindow> {
    const repository = request.pullRequest.repository;
    const key = `${bucketName}:${scmRepositoryKey(repository)}:${request.pullRequest.number}`;
    const result = await this.singleJson({
      cacheKey: key,
      url: this.apiUrl(this.pullPath(repository, request.pullRequest.number)),
      guard,
      force: request.forceFullRefresh,
      limits: request.limits,
      budget,
      signal: request.signal
    });
    if (!result.ok) return { result: bucketFailure(result.failure) };
    let fact: ScmPullRequestFactV1;
    let raw: Record<string, unknown>;
    try {
      raw = record(result.value);
      fact = parsePullRequest(raw, this.canonicalHost, result.etag);
    } catch {
      return { result: bucketFailure(schemaFailure("GITHUB_PULL_REQUEST_SCHEMA")) };
    }
    const bucket = this.bucket({
      completeness: "complete",
      observedHeadSha: fact.headSha,
      facts: fact,
      schema: ScmPullRequestFactV1Schema,
      guard: result.etag
    });
    return { result: { fetched: true, bucket, notModified: result.notModified }, raw };
  }

  private requiredContexts(value: unknown, limits: ScmProviderLimitsV1): { contexts: Set<string>; complete: boolean } {
    const root = record(value);
    const values: unknown[] = [];
    if (Array.isArray(root.contexts)) values.push(...root.contexts);
    if (Array.isArray(root.checks)) {
      for (const item of root.checks) values.push(record(item).context);
    }
    const contexts = new Set<string>();
    const complete = values.length <= limits.maxItemsPerEndpoint;
    for (const value of values.slice(0, limits.maxItemsPerEndpoint)) contexts.add(string(value, "required check context", 512));
    return { contexts, complete };
  }

  private checkRun(value: unknown, required: ReadonlySet<string>): RawScmCheckV1 & { logUrl?: string } {
    const item = record(value);
    const app = item.app === null || item.app === undefined ? undefined : record(item.app);
    const suite = item.check_suite === null || item.check_suite === undefined ? undefined : record(item.check_suite);
    const name = string(item.name, "check run name", 512);
    const status = string(item.status, "check run status", 128);
    const startedAt = timestamp(item.started_at ?? item.created_at);
    const detailParts: string[] = [];
    if (item.output && typeof item.output === "object") {
      const output = record(item.output);
      for (const part of [output.title, output.summary, output.text]) if (typeof part === "string" && part) detailParts.push(part);
    }
    const logUrl = typeof item.log_url === "string" ? this.assertApiUrl(item.log_url) : undefined;
    return {
      source: "check_run",
      providerCheckId: boundedId(item.id, "github-check"),
      providerRunId: boundedId(suite?.id ?? item.external_id ?? item.id, "github-run"),
      name,
      ...(app && typeof app.slug === "string" ? { workflow: app.slug } : {}),
      ...(typeof item.event === "string" && item.event ? { event: item.event } : {}),
      required: required.has(name),
      status,
      conclusion: item.conclusion === null || item.conclusion === undefined ? null : string(item.conclusion, "check conclusion", 128),
      attempt: Number.isSafeInteger(item.run_attempt) && Number(item.run_attempt) > 0 ? Number(item.run_attempt) : 1,
      startedAt,
      ...(optionalTimestamp(item.completed_at) ? { completedAt: optionalTimestamp(item.completed_at) } : {}),
      ...(optionalCanonicalWebUrl(item.details_url, this.canonicalHost) ? { url: optionalCanonicalWebUrl(item.details_url, this.canonicalHost) } : {}),
      ...(detailParts.length > 0 ? { detail: detailParts.join("\n") } : {}),
      ...(logUrl ? { logUrl } : {})
    };
  }

  private statusContext(value: unknown, required: ReadonlySet<string>): RawScmCheckV1 {
    const item = record(value);
    const context = string(item.context, "status context", 512);
    const state = string(item.state, "status state", 128);
    const createdAt = timestamp(item.created_at ?? item.updated_at);
    return {
      source: "status_context",
      providerCheckId: boundedId(item.id, "github-status"),
      providerRunId: boundedId(item.id, "github-status-run"),
      context,
      name: context,
      required: required.has(context),
      status: state,
      conclusion: state,
      attempt: 1,
      startedAt: createdAt,
      ...(optionalTimestamp(item.updated_at) ? { completedAt: optionalTimestamp(item.updated_at) } : {}),
      ...(optionalCanonicalWebUrl(item.target_url, this.canonicalHost) ? { url: optionalCanonicalWebUrl(item.target_url, this.canonicalHost) } : {}),
      ...(typeof item.description === "string" ? { detail: item.description } : {})
    };
  }

  private async failureLogs(input: {
    repository: ScmRepositoryIdV1;
    headSha: string;
    fingerprint: string | undefined;
    checks: readonly ScmNormalizedCheckV1[];
    logUrls: ReadonlyMap<string, string>;
    limits: ScmProviderLimitsV1;
    budget: Budget;
    signal: AbortSignal;
  }): Promise<{ evidence: RawScmEvidenceV1[]; complete: boolean }> {
    if (!input.fingerprint) return { evidence: [], complete: true };
    if (this.attemptedFailureLogs.has(input.fingerprint)) {
      const cached = this.failureLogEvidence.get(input.fingerprint);
      return cached === undefined ? { evidence: [], complete: false } : { evidence: [...cached.evidence], complete: cached.complete };
    }
    this.attemptedFailureLogs.add(input.fingerprint);
    while (this.attemptedFailureLogs.size > 256) {
      const oldest = this.attemptedFailureLogs.values().next().value!;
      this.attemptedFailureLogs.delete(oldest);
      this.failureLogEvidence.delete(oldest);
    }
    const evidence: RawScmEvidenceV1[] = [];
    let retainedTotal = 0;
    let complete = true;
    const failures = input.checks
      .filter((check) => check.bucket === "failing" || check.bucket === "cancelled")
      .sort((left, right) => left.key.localeCompare(right.key));
    for (const check of failures) {
      const logUrl = input.logUrls.get(check.providerCheckId);
      if (!logUrl) continue;
      if (retainedTotal >= input.limits.maxFailureLogsBytes) {
        complete = false;
        break;
      }
      const result = await this.requestBytes({
        url: logUrl,
        limits: input.limits,
        budget: input.budget,
        signal: input.signal,
        accept: "text/plain"
      });
      if (!result.ok || result.notModified) {
        complete = false;
        continue;
      }
      const remaining = input.limits.maxFailureLogsBytes - retainedTotal;
      const maximum = Math.min(input.limits.maxFailureLogBytes, remaining);
      const tail = result.value.subarray(Math.max(0, result.value.byteLength - maximum));
      const normalized = normalizeExternalText(new TextDecoder("utf-8", { fatal: false }).decode(tail), maximum);
      retainedTotal += normalized.retainedBytes;
      const observedAt = new Date(this.nowMs()).toISOString();
      const rawEvidence: RawScmEvidenceV1 = {
        providerEvidenceId: boundedId(`log-${check.providerCheckId}-${input.fingerprint.slice(0, 16)}`, "github-log"),
        kind: "check_log",
        authorKind: "bot",
        authorId: "github-actions",
        createdAt: observedAt,
        updatedAt: observedAt,
        resolved: false,
        selected: true,
        body: normalized.text,
        ...(check.url ? { url: check.url } : {})
      };
      this.evidenceSourceMetadata.set(rawEvidence, {
        originalBytes: result.value.byteLength,
        truncated: result.value.byteLength > maximum || normalized.truncated,
        sanitized: normalized.sanitized
      });
      evidence.push(rawEvidence);
      if (result.value.byteLength > maximum) complete = false;
    }
    const value = { evidence: Object.freeze([...evidence]), complete };
    this.failureLogEvidence.set(input.fingerprint, value);
    return { evidence: [...value.evidence], complete: value.complete };
  }

  private async ciBucket(request: ScmObservationRequestV1, budget: Budget): Promise<CiWindow> {
    const repository = request.pullRequest.repository;
    const head = request.expectedHeadSha;
    const base = shortBranch(request.pullRequest.baseRef);
    const guard = parseGuard(request.guards.checks);
    const prefix = `ci:${scmRepositoryKey(repository)}:${head}`;
    const perPage = Math.min(100, request.limits.maxItemsPerPage);
    const requiredResult = await this.singleJson({
      cacheKey: `${prefix}:required`,
      url: this.apiUrl(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/branches/${encodeURIComponent(base)}/protection/required_status_checks`),
      guard: guard.required,
      force: request.forceFullRefresh,
      limits: request.limits,
      budget,
      signal: request.signal
    });
    const checksResult = await this.paginated({
      cacheKey: `${prefix}:checks`,
      url: this.apiUrl(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/commits/${head}/check-runs`, {
        per_page: perPage,
        filter: "all"
      }),
      guard: guard.checks,
      force: request.forceFullRefresh,
      limits: request.limits,
      budget,
      signal: request.signal,
      select: (value) => {
        const root = record(value);
        if (!Array.isArray(root.check_runs)) throw new TypeError("check_runs is missing");
        return root.check_runs;
      }
    });
    const statusesResult = await this.paginated({
      cacheKey: `${prefix}:statuses`,
      url: this.apiUrl(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/commits/${head}/statuses`, { per_page: perPage }),
      guard: guard.statuses,
      force: request.forceFullRefresh,
      limits: request.limits,
      budget,
      signal: request.signal,
      select: (value) => {
        if (!Array.isArray(value)) throw new TypeError("statuses is not an array");
        return value;
      }
    });

    const available = [checksResult, statusesResult].filter((item): item is PageWindow => !("ok" in item));
    if (available.length === 0) {
      const failed = checksResult as GithubFailure;
      return { result: bucketFailure(failed.failure), logEvidence: [], logsComplete: false };
    }
    let completeness: ScmCompleteness = requiredResult.ok && available.every((item) => item.complete) && available.length === 2 ? "complete" : "partial";
    let required = new Set<string>();
    if (requiredResult.ok && !requiredResult.notModified) {
      try {
        const parsed = this.requiredContexts(requiredResult.value, request.limits);
        required = parsed.contexts;
        if (!parsed.complete) completeness = "partial";
      } catch { completeness = "partial"; }
    } else if (requiredResult.ok) {
      try {
        const parsed = this.requiredContexts(requiredResult.value, request.limits);
        required = parsed.contexts;
        if (!parsed.complete) completeness = "partial";
      } catch { completeness = "partial"; }
    }
    const raw: Array<RawScmCheckV1 & { logUrl?: string }> = [];
    const logUrls = new Map<string, string>();
    if (!("ok" in checksResult)) {
      for (const value of checksResult.items) {
        try {
          const check = this.checkRun(value, required);
          const { logUrl, ...normalizedInput } = check;
          raw.push(normalizedInput);
          if (logUrl) logUrls.set(check.providerCheckId, logUrl);
        } catch { completeness = "partial"; }
      }
      if (!checksResult.complete) completeness = "partial";
    } else completeness = "partial";
    if (!("ok" in statusesResult)) {
      for (const value of statusesResult.items) {
        try { raw.push(this.statusContext(value, required)); } catch { completeness = "partial"; }
      }
      if (!statusesResult.complete) completeness = "partial";
    } else completeness = "partial";
    if (raw.length > request.limits.maxItemsPerEndpoint) {
      raw.length = request.limits.maxItemsPerEndpoint;
      completeness = "partial";
    }
    let normalized;
    try { normalized = normalizeCheckWindow(raw, completeness); } catch {
      return { result: bucketFailure(schemaFailure("GITHUB_CHECK_SCHEMA")), logEvidence: [], logsComplete: false };
    }
    const logs = await this.failureLogs({
      repository,
      headSha: head,
      fingerprint: normalized.facts.failureFingerprint,
      checks: normalized.facts.checks,
      logUrls,
      limits: request.limits,
      budget,
      signal: request.signal
    });
    const etags = {
      required: requiredResult.ok ? requiredResult.etag : undefined,
      checks: "ok" in checksResult ? undefined : checksResult.etag,
      statuses: "ok" in statusesResult ? undefined : statusesResult.etag
    };
    const cursor = scmSemanticDigest([
      "ok" in checksResult ? null : checksResult.cursor ?? null,
      "ok" in statusesResult ? null : statusesResult.cursor ?? null
    ]);
    const bucket = this.bucket({
      completeness: normalized.completeness,
      observedHeadSha: head,
      facts: normalized.facts,
      schema: ScmCiFactV1Schema,
      guard: guardValue(etags),
      cursor
    });
    const notModified = requiredResult.ok && requiredResult.notModified &&
      !("ok" in checksResult) && checksResult.notModified &&
      !("ok" in statusesResult) && statusesResult.notModified;
    return { result: { fetched: true, bucket, notModified }, logEvidence: logs.evidence, logsComplete: logs.complete };
  }

  private reviewEvidence(value: unknown, kind: "review_body" | "inline_comment" | "issue_comment", resolved: boolean): RawScmEvidenceV1 {
    const item = record(value);
    const actor = author(item.user ?? item.author);
    const createdAt = timestamp(item.created_at ?? item.submitted_at ?? item.createdAt);
    const updatedAt = optionalTimestamp(item.updated_at ?? item.updatedAt) ?? createdAt;
    const state = typeof item.state === "string" ? item.state.toUpperCase() : "";
    const selected = actor.authorKind === "human" && !resolved && (kind !== "review_body" || state === "CHANGES_REQUESTED");
    return {
      providerEvidenceId: boundedId(item.id ?? item.node_id, `github-${kind}`),
      kind,
      authorKind: actor.authorKind,
      authorId: actor.authorId,
      createdAt,
      updatedAt,
      resolved,
      selected,
      body: typeof item.body === "string" ? item.body : "",
      ...(optionalCanonicalWebUrl(item.html_url ?? item.url, this.canonicalHost) ? { url: optionalCanonicalWebUrl(item.html_url ?? item.url, this.canonicalHost) } : {})
    };
  }

  private reviewDecision(values: readonly unknown[]): { decision: ScmReviewDecision; humanApprovals: number; partial: boolean } {
    const latest = new Map<string, { state: string; submittedAt: number; human: boolean }>();
    let partial = false;
    for (const value of values) {
      try {
        const item = record(value);
        const actor = author(item.user);
        const state = string(item.state, "review state", 64).toUpperCase();
        if (!["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"].includes(state)) partial = true;
        const submittedAt = Date.parse(timestamp(item.submitted_at ?? item.created_at));
        const key = actor.authorId;
        const prior = latest.get(key);
        if (!prior || submittedAt > prior.submittedAt || submittedAt === prior.submittedAt && state.localeCompare(prior.state) < 0) {
          latest.set(key, { state, submittedAt, human: actor.authorKind === "human" });
        }
      } catch { partial = true; }
    }
    const human = [...latest.values()].filter((item) => item.human);
    const approvals = human.filter((item) => item.state === "APPROVED").length;
    const decision: ScmReviewDecision = human.some((item) => item.state === "CHANGES_REQUESTED")
      ? "changes_requested"
      : approvals > 0
        ? "approved"
        : human.some((item) => item.state === "DISMISSED")
          ? "dismissed"
          : human.length > 0
            ? "pending"
            : "unknown";
    return { decision, humanApprovals: approvals, partial };
  }

  private async reviewThreads(input: {
    repository: ScmRepositoryIdV1;
    number: number;
    limits: ScmProviderLimitsV1;
    budget: Budget;
    signal: AbortSignal;
  }): Promise<{ evidence: RawScmEvidenceV1[]; resolutions: Map<string, boolean>; complete: boolean; cursor?: string }> {
    const evidence: RawScmEvidenceV1[] = [];
    const resolutions = new Map<string, boolean>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    let itemCount = 0;
    let complete = true;
    for (;;) {
      if (pages >= input.limits.maxPagesPerEndpoint) { complete = false; break; }
      const cursorKey = cursor ?? "<first>";
      if (cursors.has(cursorKey)) { complete = false; break; }
      cursors.add(cursorKey);
      const body = jsonBytes({
        query: "query RelayForgeReviewThreads($owner:String!,$name:String!,$number:Int!,$cursor:String,$pageSize:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:$pageSize,after:$cursor){nodes{id isResolved comments(first:$pageSize){nodes{id databaseId body url createdAt updatedAt author{login __typename}} pageInfo{hasNextPage}}} pageInfo{hasNextPage endCursor}}}}}",
        variables: {
          owner: input.repository.owner,
          name: input.repository.name,
          number: input.number,
          cursor,
          pageSize: Math.min(100, input.limits.maxItemsPerPage)
        }
      });
      if (body.byteLength > input.limits.maxDecodedBytesPerRequest) return { evidence, resolutions, complete: false };
      const result = await this.requestJson({
        url: this.graphqlUrl,
        method: "POST",
        body,
        limits: input.limits,
        budget: input.budget,
        signal: input.signal
      });
      if (!result.ok || result.notModified) { complete = false; break; }
      try {
        const root = record(result.value);
        if (Array.isArray(root.errors) && root.errors.length > 0) { complete = false; break; }
        const data = record(root.data);
        const repository = record(data.repository);
        const pull = record(repository.pullRequest);
        const threads = record(pull.reviewThreads);
        if (!Array.isArray(threads.nodes)) throw new TypeError("thread nodes missing");
        if (threads.nodes.length > input.limits.maxItemsPerPage || itemCount + threads.nodes.length > input.limits.maxItemsPerEndpoint) {
          complete = false;
          break;
        }
        itemCount += threads.nodes.length;
        for (const rawThread of threads.nodes) {
          const thread = record(rawThread);
          const comments = record(thread.comments);
          if (!Array.isArray(comments.nodes)) { complete = false; continue; }
          if (comments.nodes.length > input.limits.maxItemsPerPage || itemCount + comments.nodes.length > input.limits.maxItemsPerEndpoint) {
            complete = false;
            continue;
          }
          itemCount += comments.nodes.length;
          if (record(comments.pageInfo).hasNextPage === true) complete = false;
          const resolved = thread.isResolved === true;
          for (const rawComment of comments.nodes) {
            const comment = record(rawComment);
            resolutions.set(String(comment.databaseId ?? comment.id), resolved);
          }
          const latest = [...comments.nodes].map(record).sort((left, right) =>
            Date.parse(String(right.updatedAt ?? right.createdAt)) - Date.parse(String(left.updatedAt ?? left.createdAt)))[0];
          if (!latest) continue;
          const actor = author(latest.author);
          const createdAt = timestamp(latest.createdAt);
          const updatedAt = optionalTimestamp(latest.updatedAt) ?? createdAt;
          evidence.push({
            providerEvidenceId: boundedId(thread.id, "github-thread"),
            kind: "review_thread",
            authorKind: actor.authorKind,
            authorId: actor.authorId,
            createdAt,
            updatedAt,
            resolved,
            selected: actor.authorKind === "human" && !resolved,
            body: typeof latest.body === "string" ? latest.body : "",
            ...(optionalCanonicalWebUrl(latest.url, this.canonicalHost) ? { url: optionalCanonicalWebUrl(latest.url, this.canonicalHost) } : {})
          });
        }
        const pageInfo = record(threads.pageInfo);
        pages += 1;
        if (pageInfo.hasNextPage !== true) break;
        if (typeof pageInfo.endCursor !== "string" || pageInfo.endCursor.length === 0 || pageInfo.endCursor.length > 1_024) {
          complete = false;
          break;
        }
        cursor = pageInfo.endCursor;
      } catch {
        complete = false;
        break;
      }
    }
    return { evidence, resolutions, complete, cursor: scmSemanticDigest([...cursors]) };
  }

  private async reviewBucket(
    request: ScmObservationRequestV1,
    budget: Budget,
    logEvidence: readonly RawScmEvidenceV1[],
    logsComplete: boolean
  ): Promise<ScmFetchResultV1<ScmReviewFactV1>> {
    const repository = request.pullRequest.repository;
    const number = request.pullRequest.number;
    const prefix = `review:${scmRepositoryKey(repository)}:${number}:${request.expectedHeadSha}`;
    const guard = parseGuard(request.guards.reviews);
    const perPage = Math.min(100, request.limits.maxItemsPerPage);
    const endpoint = (kind: "reviews" | "comments" | "issue_comments", path: string) => this.paginated({
      cacheKey: `${prefix}:${kind}`,
      url: this.apiUrl(path, { per_page: perPage }),
      guard: guard[kind],
      force: request.forceFullRefresh,
      limits: request.limits,
      budget,
      signal: request.signal,
      select: (value) => {
        if (!Array.isArray(value)) throw new TypeError("review endpoint is not an array");
        return value;
      }
    });
    const reviews = await endpoint("reviews", `${this.pullPath(repository, number)}/reviews`);
    const inline = await endpoint("comments", `${this.pullPath(repository, number)}/comments`);
    const issue = await endpoint("issue_comments", `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/issues/${number}/comments`);
    const threads = await this.reviewThreads({ repository, number, limits: request.limits, budget, signal: request.signal });
    const windows = [reviews, inline, issue];
    const available = windows.filter((item): item is PageWindow => !("ok" in item));
    if (available.length === 0 && threads.evidence.length === 0 && logEvidence.length === 0) {
      return bucketFailure((reviews as GithubFailure).failure);
    }
    let completeness: ScmCompleteness = available.length === 3 && available.every((item) => item.complete) && threads.complete && logsComplete
      ? "complete"
      : "partial";
    const reviewItems = "ok" in reviews ? [] : reviews.items;
    const decision = this.reviewDecision(reviewItems);
    if (decision.partial) completeness = "partial";
    const evidence: RawScmEvidenceV1[] = [...threads.evidence, ...logEvidence];
    for (const value of reviewItems) {
      try {
        const item = record(value);
        if (typeof item.body === "string" && item.body.length > 0) evidence.push(this.reviewEvidence(item, "review_body", false));
      } catch { completeness = "partial"; }
    }
    if (!("ok" in inline)) {
      for (const value of inline.items) {
        try {
          const item = record(value);
          evidence.push(this.reviewEvidence(item, "inline_comment", threads.resolutions.get(String(item.id ?? item.node_id)) ?? false));
        } catch { completeness = "partial"; }
      }
    }
    if (!("ok" in issue)) {
      for (const value of issue.items) {
        try { evidence.push(this.reviewEvidence(value, "issue_comment", false)); } catch { completeness = "partial"; }
      }
    }
    if (evidence.length > request.limits.maxItemsPerEndpoint) {
      evidence.length = request.limits.maxItemsPerEndpoint;
      completeness = "partial";
    }
    const evidenceMetadata = new Map<string, EvidenceSourceMetadata>();
    const boundedEvidence = evidence.map((item) => {
      const bounded = normalizeExternalText(item.body, request.limits.maxEvidenceBodyBytes);
      const source = this.evidenceSourceMetadata.get(item as object);
      evidenceMetadata.set(`${item.kind}:${item.providerEvidenceId}`, {
        originalBytes: source?.originalBytes ?? bounded.originalBytes,
        truncated: (source?.truncated ?? false) || bounded.truncated,
        sanitized: (source?.sanitized ?? false) || bounded.sanitized
      });
      return Object.freeze({ ...item, body: bounded.text });
    });
    let normalized;
    try {
      normalized = normalizeReviewWindow({
        scope: {
          repositoryKey: scmRepositoryKey(repository),
          pullRequestNumber: number,
          headSha: request.expectedHeadSha
        },
        decision: decision.decision,
        humanApprovals: decision.humanApprovals,
        evidence: boundedEvidence,
        completeness
      });
    } catch {
      return bucketFailure(schemaFailure("GITHUB_REVIEW_SCHEMA"));
    }
    let facts: ScmReviewFactV1 = Object.freeze({
      ...normalized.facts,
      evidence: Object.freeze(normalized.facts.evidence.map((item) => {
        const source = evidenceMetadata.get(`${item.kind}:${item.providerEvidenceId}`);
        return source === undefined ? item : Object.freeze({
          ...item,
          originalBytes: source.originalBytes,
          truncated: source.truncated || item.truncated,
          sanitized: source.sanitized || item.sanitized
        });
      }))
    });
    const retentionOrder = [...facts.evidence].sort((left, right) => {
      const leftPriority = left.selected && !left.resolved && left.authorKind === "human" ? 0 : 1;
      const rightPriority = right.selected && !right.resolved && right.authorKind === "human" ? 0 : 1;
      return leftPriority - rightPriority || left.evidenceId.localeCompare(right.evidenceId);
    });
    const retained: ScmEvidenceV1[] = [];
    let previewBytes = 0;
    for (const item of retentionOrder) {
      if (previewBytes + item.retainedBytes > request.limits.maxEvidencePreviewBytes) {
        completeness = "partial";
        continue;
      }
      retained.push(item);
      previewBytes += item.retainedBytes;
    }
    retained.sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
    try {
      facts = z.parse(ScmReviewFactV1Schema, {
        ...facts,
        evidence: retained,
        unresolvedSelectedEvidenceIds: retained
          .filter((item) => item.selected && !item.resolved && item.authorKind === "human")
          .map((item) => item.evidenceId)
          .sort()
      });
    } catch {
      return bucketFailure(schemaFailure("GITHUB_REVIEW_SCHEMA"));
    }
    const etags = {
      reviews: "ok" in reviews ? undefined : reviews.etag,
      comments: "ok" in inline ? undefined : inline.etag,
      issue_comments: "ok" in issue ? undefined : issue.etag
    };
    const bucket = this.bucket({
      completeness: completeness === "partial" ? "partial" : normalized.completeness,
      observedHeadSha: request.expectedHeadSha,
      facts,
      schema: ScmReviewFactV1Schema,
      guard: guardValue(etags),
      cursor: scmSemanticDigest([
        "ok" in reviews ? null : reviews.cursor ?? null,
        "ok" in inline ? null : inline.cursor ?? null,
        "ok" in issue ? null : issue.cursor ?? null,
        threads.cursor ?? null
      ])
    });
    return { fetched: true, bucket, notModified: false };
  }

  private mergeabilityBucket(
    request: ScmObservationRequestV1,
    pull: PullRequestWindow
  ): ScmFetchResultV1<ScmMergeabilityFactV1> {
    if (!pull.result.fetched || !pull.raw) return pull.result as unknown as ScmFetchResultV1<ScmMergeabilityFactV1>;
    const rawState = typeof pull.raw.mergeable_state === "string" ? pull.raw.mergeable_state.toLowerCase() : "unknown";
    const mergeable = pull.raw.mergeable;
    let state: ScmMergeabilityFactV1["state"];
    const blockers: string[] = [];
    if (rawState === "dirty" || mergeable === false) {
      state = "conflicting";
      blockers.push("merge_conflict");
    } else if (["blocked", "draft"].includes(rawState)) {
      state = "blocked";
      blockers.push(`github_${rawState}`);
    } else if (["behind", "unstable"].includes(rawState)) {
      state = "unstable";
      blockers.push(`github_${rawState}`);
    } else if (mergeable === true && ["clean", "has_hooks", "unknown"].includes(rawState)) {
      state = "mergeable";
    } else {
      state = "unknown";
      blockers.push(rawState === "unknown" ? "github_mergeability_pending" : `github_state_${boundedId(rawState, "unknown")}`);
    }
    let facts: ScmMergeabilityFactV1;
    try { facts = z.parse(ScmMergeabilityFactV1Schema, { state, blockers: [...new Set(blockers)].sort() }); } catch {
      return bucketFailure(schemaFailure("GITHUB_MERGEABILITY_SCHEMA"));
    }
    const bucket = this.bucket({
      completeness: state === "unknown" ? "partial" : "complete",
      observedHeadSha: pull.result.bucket.facts.headSha,
      facts,
      schema: ScmMergeabilityFactV1Schema,
      guard: pull.result.bucket.meta.guard
    });
    return { fetched: true, bucket, notModified: pull.result.notModified };
  }

  async observe(request: ScmObservationRequestV1): Promise<ScmObservationResultV1> {
    exactRequestIdentity(request);
    this.assertRepository(request.repository);
    this.assertRepository(request.pullRequest.repository);
    this.assertRepository(request.pullRequest.headRepository);
    this.assertRepository(request.pullRequest.baseRepository);
    const limits = parseScmProviderLimits(request.limits);
    const budget: Budget = { limits, requestCount: 0, decodedBytes: 0 };
    if (request.signal.aborted) {
      const cancelled = bucketFailure<any>(failure("cancelled", "GITHUB_CANCELLED", false, "GitHub observation was cancelled"));
      return { pullRequest: cancelled, ci: cancelled, review: cancelled, mergeability: cancelled, requestCount: 0, decodedBytes: 0 };
    }
    const pull = await this.pullRequestBucket(request, request.guards.pullRequest, "pull_request", budget);
    const mergePull = await this.pullRequestBucket(request, request.guards.mergeability, "mergeability", budget);
    const ci = await this.ciBucket(request, budget);
    const review = await this.reviewBucket(request, budget, ci.logEvidence, ci.logsComplete);
    return Object.freeze({
      pullRequest: pull.result,
      ci: ci.result,
      review,
      mergeability: this.mergeabilityBucket(request, mergePull),
      requestCount: budget.requestCount,
      decodedBytes: budget.decodedBytes
    });
  }

  private lookupIdentity(request: ScmPullRequestLookupRequestV1): void {
    this.assertRepository(request.repository);
    this.assertRepository(request.headRepository);
    this.assertRepository(request.baseRepository);
    parseScmProviderLimits(request.limits);
    shortBranch(request.headRef);
    shortBranch(request.baseRef);
    if (request.signal.aborted) throw new DOMException("aborted", "AbortError");
  }

  async lookupPullRequests(request: ScmPullRequestLookupRequestV1): Promise<ScmPullRequestLookupResultV1> {
    try { this.lookupIdentity(request); } catch (error) {
      if (request.signal.aborted) return { fetched: false, failure: failure("cancelled", "GITHUB_CANCELLED", false, "GitHub lookup was cancelled") };
      throw error;
    }
    const limits = parseScmProviderLimits(request.limits);
    const budget: Budget = { limits, requestCount: 0, decodedBytes: 0 };
    const key = `lookup:${scmRepositoryKey(request.baseRepository)}:${scmRepositoryKey(request.headRepository)}:${request.headRef}:${request.baseRef}`;
    const result = await this.paginated({
      cacheKey: key,
      url: this.apiUrl(`/repos/${encodeURIComponent(request.baseRepository.owner)}/${encodeURIComponent(request.baseRepository.name)}/pulls`, {
        state: "open",
        head: `${request.headRepository.owner}:${shortBranch(request.headRef)}`,
        base: shortBranch(request.baseRef),
        per_page: Math.min(100, limits.maxItemsPerPage)
      }),
      force: true,
      limits,
      budget,
      signal: request.signal,
      select: (value) => {
        if (!Array.isArray(value)) throw new TypeError("pull request lookup is not an array");
        return value;
      }
    });
    if ("ok" in result) return { fetched: false, failure: result.failure };
    const candidates: ScmPullRequestFactV1[] = [];
    let complete = result.complete;
    for (const item of result.items) {
      try { candidates.push(parsePullRequest(item, this.canonicalHost)); } catch { complete = false; }
    }
    candidates.sort((left, right) => left.number - right.number || left.providerId.localeCompare(right.providerId));
    return { fetched: true, complete, candidates };
  }

  private validateCreate(request: ScmCreatePullRequestRequestV1): void {
    this.assertRepository(request.repository);
    this.assertRepository(request.headRepository);
    this.assertRepository(request.baseRepository);
    if (!BOUNDED_ID.test(request.publicationId)) throw new TypeError("GitHub publication ID is invalid");
    shortBranch(request.headRef);
    shortBranch(request.baseRef);
    if (!SHA.test(request.headSha)) throw new TypeError("GitHub create head SHA is invalid");
    if (Buffer.byteLength(request.title, "utf8") < 1 || Buffer.byteLength(request.title, "utf8") > 1_024) throw new TypeError("GitHub pull request title is invalid");
    if (Buffer.byteLength(request.body, "utf8") > SCM_PROVIDER_LIMITS.maxEvidenceBodyBytes) throw new TypeError("GitHub pull request body is too large");
  }

  private exactCreated(request: ScmCreatePullRequestRequestV1, pull: ScmPullRequestFactV1): boolean {
    return pull.lifecycle === "open" &&
      pull.draft === request.draft &&
      sameScmRepository(pull.repository, request.baseRepository) &&
      sameScmRepository(pull.headRepository, request.headRepository) &&
      pull.headRef === request.headRef &&
      pull.headSha === request.headSha &&
      sameScmRepository(pull.baseRepository, request.baseRepository) &&
      pull.baseRef === request.baseRef;
  }

  async createPullRequest(request: ScmCreatePullRequestRequestV1): Promise<ScmCreatePullRequestResultV1> {
    this.validateCreate(request);
    if (request.signal.aborted) return { outcome: "failed", failure: failure("cancelled", "GITHUB_CANCELLED", false, "GitHub create was cancelled") };
    const limits = SCM_PROVIDER_LIMITS;
    const budget: Budget = { limits, requestCount: 0, decodedBytes: 0 };
    const payload = jsonBytes({
      title: request.title,
      body: request.body,
      head: `${request.headRepository.owner}:${shortBranch(request.headRef)}`,
      base: shortBranch(request.baseRef),
      draft: request.draft
    });
    const response = await this.requestJson({
      url: this.apiUrl(`/repos/${encodeURIComponent(request.baseRepository.owner)}/${encodeURIComponent(request.baseRepository.name)}/pulls`),
      method: "POST",
      body: payload,
      limits,
      budget,
      signal: request.signal
    });
    if (!response.ok) {
      if (["network", "timeout"].includes(response.failure.kind) || response.failure.kind === "provider" && response.failure.retryable) {
        return { outcome: "ambiguous", diagnostic: "GitHub pull request creation outcome is ambiguous; reconcile the exact head and base before retry" };
      }
      if (response.failure.code === "GITHUB_HTTP_422") {
        return { outcome: "ambiguous", diagnostic: "GitHub reported a conflicting pull request creation; perform an exact lookup before adoption" };
      }
      return { outcome: "failed", failure: response.failure };
    }
    if (response.notModified) return { outcome: "ambiguous", diagnostic: "GitHub returned an invalid conditional creation response" };
    try {
      const pull = parsePullRequest(response.value, this.canonicalHost, response.etag);
      return this.exactCreated(request, pull)
        ? { outcome: "created", pullRequest: pull }
        : { outcome: "ambiguous", diagnostic: "GitHub created a pull request whose identity does not match the publication intent" };
    } catch {
      return { outcome: "ambiguous", diagnostic: "GitHub pull request creation returned an unverified response" };
    }
  }
}

export function createGithubScmProvider(options: GithubScmProviderOptions): GithubScmProvider {
  return new GithubScmProvider(options);
}

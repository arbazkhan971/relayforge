import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  createGithubScmProvider,
  type GithubScmProvider,
  type GithubTransport,
  type GithubTransportRequest
} from "./github.js";
import {
  ScmBranchRefSchema,
  ScmCanonicalHostSchema,
  ScmRepositoryIdV1Schema,
  canonicalizeScmHost,
  parseScmHttpsUrl,
  parseScmProviderLimits,
  scmRepositoryKey
} from "./schema.js";
import {
  SCM_PROVIDER_LIMITS,
  scmCapabilityNames,
  type ScmCapabilityName,
  type ScmProviderLimitsV1,
  type ScmRepositoryIdV1
} from "./types.js";
import { createAuthenticatedScmGitCommandRunner, type ScmGitCommandRunner } from "./publish.js";

export const SCM_PRODUCT_POLICY_SCHEMA_VERSION = 1 as const;
export const SCM_PRODUCT_MAX_CREDENTIAL_BYTES = 16 * 1024;

const boundedId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const remoteName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u);
const environmentName = z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/u);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const limitOverrides = z.strictObject({
  requestTimeoutMs: positive.optional(),
  maxPagesPerEndpoint: positive.optional(),
  maxItemsPerPage: positive.optional(),
  maxItemsPerEndpoint: positive.optional(),
  maxDecodedBytesPerRequest: positive.optional(),
  maxDecodedBytesPerPoll: positive.optional(),
  maxEvidenceBodyBytes: positive.optional(),
  maxEvidencePreviewBytes: positive.optional(),
  maxFailureLogBytes: positive.optional(),
  maxFailureLogsBytes: positive.optional(),
  maxConcurrentPerRepository: positive.optional(),
  maxConcurrentPerRun: positive.optional()
});

/** Serializable product configuration. It contains only a credential variable name, never a token. */
export const ScmProductRepositoryConfigV1Schema = z.strictObject({
  schemaVersion: z.literal(SCM_PRODUCT_POLICY_SCHEMA_VERSION),
  repositoryKey: boundedId,
  provider: z.literal("github"),
  canonicalHost: ScmCanonicalHostSchema,
  owner: ScmRepositoryIdV1Schema.shape.owner,
  name: ScmRepositoryIdV1Schema.shape.name,
  baseOwner: ScmRepositoryIdV1Schema.shape.owner,
  baseName: ScmRepositoryIdV1Schema.shape.name,
  repositoryRoot: z.string().min(1).max(4_096),
  remoteName,
  expectedPushUrl: z.string().url().max(4_096),
  baseRef: ScmBranchRefSchema,
  credentialEnv: environmentName,
  capabilities: z.array(z.enum(scmCapabilityNames)).min(1).max(scmCapabilityNames.length),
  limits: limitOverrides.optional()
});

export type ScmProductRepositoryConfigV1 = z.infer<typeof ScmProductRepositoryConfigV1Schema>;

/** Closed, secret-free identity binding used by the parent publication lifecycle. */
export type ScmRepositoryBindingV1 = Readonly<{
  schemaVersion: typeof SCM_PRODUCT_POLICY_SCHEMA_VERSION;
  repositoryKey: string;
  repository: ScmRepositoryIdV1;
  baseRepository: ScmRepositoryIdV1;
  repositoryRoot: string;
  remoteName: string;
  expectedPushUrl: string;
  baseRef: string;
  credentialEnv: string;
  capabilities: readonly ScmCapabilityName[];
  limits: ScmProviderLimitsV1;
  /** Closed test/local seam. Product configuration parsing always sets this to false. */
  allowFileRemote: boolean;
}>;

export class ScmProductPolicyError extends Error {
  constructor(
    readonly code:
      | "INVALID_CONFIG"
      | "NON_CANONICAL_ROOT"
      | "LIMIT_ESCALATION"
      | "MISSING_CREDENTIAL"
      | "INVALID_CREDENTIAL"
      | "FOREIGN_HOST"
      | "TRANSPORT_FAILURE",
    message: string
  ) {
    super(`${code}: ${message}`);
    this.name = "ScmProductPolicyError";
  }
}

function canonicalRoot(value: string): string {
  if (!isAbsolute(value)) throw new ScmProductPolicyError("NON_CANONICAL_ROOT", "SCM repository root must be absolute");
  let result: string;
  try {
    result = realpathSync(value);
    if (!lstatSync(result).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new ScmProductPolicyError("NON_CANONICAL_ROOT", "SCM repository root must identify an existing directory");
  }
  if (result !== value) throw new ScmProductPolicyError("NON_CANONICAL_ROOT", "SCM repository root must already be canonical");
  return result;
}

function downwardLimits(overrides: z.infer<typeof limitOverrides> | undefined): ScmProviderLimitsV1 {
  for (const [key, value] of Object.entries(overrides ?? {}) as Array<[keyof ScmProviderLimitsV1, number]>) {
    if (value > SCM_PROVIDER_LIMITS[key]) {
      throw new ScmProductPolicyError("LIMIT_ESCALATION", `SCM limit ${key} may only be configured downward`);
    }
  }
  const candidate = parseScmProviderLimits({ ...SCM_PROVIDER_LIMITS, ...(overrides ?? {}) });
  for (const key of Object.keys(SCM_PROVIDER_LIMITS) as Array<keyof ScmProviderLimitsV1>) {
    if (candidate[key] > SCM_PROVIDER_LIMITS[key]) {
      throw new ScmProductPolicyError("LIMIT_ESCALATION", `SCM limit ${key} may only be configured downward`);
    }
  }
  if (candidate.maxDecodedBytesPerRequest > candidate.maxDecodedBytesPerPoll ||
      candidate.maxFailureLogBytes > candidate.maxFailureLogsBytes ||
      candidate.maxConcurrentPerRepository > candidate.maxConcurrentPerRun ||
      candidate.maxItemsPerEndpoint > candidate.maxPagesPerEndpoint * candidate.maxItemsPerPage) {
    throw new ScmProductPolicyError("INVALID_CONFIG", "SCM limit relationships are inconsistent");
  }
  return Object.freeze({ ...candidate });
}

function sortedCapabilities(values: readonly ScmCapabilityName[]): readonly ScmCapabilityName[] {
  if (new Set(values).size !== values.length) throw new ScmProductPolicyError("INVALID_CONFIG", "SCM capabilities must be unique");
  return Object.freeze([...values].sort());
}

export function parseScmProductRepositoryConfig(value: unknown): ScmRepositoryBindingV1 {
  let config: ScmProductRepositoryConfigV1;
  try { config = ScmProductRepositoryConfigV1Schema.parse(value); }
  catch (error) {
    throw new ScmProductPolicyError("INVALID_CONFIG", error instanceof Error ? error.message : "SCM configuration is invalid");
  }
  try {
    const host = canonicalizeScmHost(config.canonicalHost);
    const repository = ScmRepositoryIdV1Schema.parse({
      schemaVersion: 1,
      provider: config.provider,
      canonicalHost: host,
      owner: config.owner,
      name: config.name
    });
    const baseRepository = ScmRepositoryIdV1Schema.parse({
      schemaVersion: 1,
      provider: config.provider,
      canonicalHost: host,
      owner: config.baseOwner,
      name: config.baseName
    });
    const capabilities = sortedCapabilities(config.capabilities);
    if (!capabilities.includes("scm.read") || !capabilities.includes("scm.publish_branch") || !capabilities.includes("scm.write_pr")) {
      throw new ScmProductPolicyError("INVALID_CONFIG", "product SCM lifecycle requires read, branch-publication and PR-write capabilities");
    }
    return Object.freeze({
      schemaVersion: 1,
      repositoryKey: config.repositoryKey,
      repository: Object.freeze(repository),
      baseRepository: Object.freeze(baseRepository),
      repositoryRoot: canonicalRoot(config.repositoryRoot),
      remoteName: config.remoteName,
      expectedPushUrl: parseScmHttpsUrl(config.expectedPushUrl, host),
      baseRef: config.baseRef,
      credentialEnv: config.credentialEnv,
      capabilities,
      limits: downwardLimits(config.limits),
      allowFileRemote: false
    });
  } catch (error) {
    if (error instanceof ScmProductPolicyError) throw error;
    throw new ScmProductPolicyError("INVALID_CONFIG", error instanceof Error ? error.message : "SCM configuration is invalid");
  }
}

function credential(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new ScmProductPolicyError("MISSING_CREDENTIAL", "SCM host credential is unavailable");
  }
  if (value !== value.trim() || Buffer.byteLength(value, "utf8") > SCM_PRODUCT_MAX_CREDENTIAL_BYTES || /[\x00-\x20\x7f]/u.test(value)) {
    throw new ScmProductPolicyError("INVALID_CREDENTIAL", "SCM host credential violates the in-memory token policy");
  }
  return value;
}

function allowedApiHost(canonicalHost: string): string {
  return canonicalHost === "github.com" ? "api.github.com" : canonicalHost;
}

/** Adds one host-scoped credential in memory and converts arbitrary transport errors to a redacted code. */
export function createHostScopedGithubTransport(input: Readonly<{
  canonicalHost: string;
  token: string;
  transport: GithubTransport;
}>): GithubTransport {
  const host = canonicalizeScmHost(input.canonicalHost);
  const apiHost = allowedApiHost(host);
  const token = credential(input.token);
  if (typeof input.transport !== "function") throw new ScmProductPolicyError("INVALID_CONFIG", "GitHub transport is required");
  return async (request: GithubTransportRequest): Promise<Response> => {
    let url: URL;
    try { url = new URL(request.url); }
    catch { throw new ScmProductPolicyError("FOREIGN_HOST", "GitHub request URL is invalid"); }
    if (url.protocol !== "https:" || url.hostname !== apiHost || url.host !== apiHost || url.username || url.password || url.port || url.hash) {
      throw new ScmProductPolicyError("FOREIGN_HOST", "GitHub request left its credential host");
    }
    if (Object.keys(request.headers).some((name) => name.toLowerCase() === "authorization")) {
      throw new ScmProductPolicyError("INVALID_CONFIG", "GitHub adapter attempted to supply its own credential");
    }
    try {
      return await input.transport(Object.freeze({
        ...request,
        headers: Object.freeze({ ...request.headers, authorization: `Bearer ${token}` })
      }));
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      const sanitized = new ScmProductPolicyError("TRANSPORT_FAILURE", "GitHub transport failed");
      Object.defineProperty(sanitized, "cause", { value: undefined, enumerable: false });
      throw sanitized;
    }
  };
}

export function createFetchGithubTransport(fetchImpl: typeof fetch = globalThis.fetch): GithubTransport {
  if (typeof fetchImpl !== "function") throw new ScmProductPolicyError("INVALID_CONFIG", "fetch transport is unavailable");
  return async (request) => fetchImpl(request.url, {
    method: request.method,
    redirect: request.redirect,
    headers: request.headers,
    ...(request.body === undefined ? {} : { body: Buffer.from(request.body) }),
    signal: request.signal
  });
}

export type ScmProductRuntimeV1 = Readonly<{
  binding: ScmRepositoryBindingV1;
  provider: GithubScmProvider;
  /** Parent-held credentialed API capability. Never pass this to a provider/worker child. */
  transport: GithubTransport;
  /** Parent-held Git publication capability; its credential is closed over and never serialized. */
  gitRunner: ScmGitCommandRunner;
}>;

/** Resolves only the configured environment entry and returns no secret-bearing field. */
export function createScmProductRuntime(input: Readonly<{
  config: unknown;
  environment: Readonly<Record<string, string | undefined>>;
  transport?: GithubTransport;
  now?: () => Date;
}>): ScmProductRuntimeV1 {
  const binding = parseScmProductRepositoryConfig(input.config);
  const token = credential(input.environment[binding.credentialEnv]);
  const transport = createHostScopedGithubTransport({
    canonicalHost: binding.repository.canonicalHost,
    token,
    transport: input.transport ?? createFetchGithubTransport()
  });
  const provider = createGithubScmProvider({
    canonicalHost: binding.repository.canonicalHost,
    transport,
    ...(input.now ? { now: input.now } : {})
  });
  const gitRunner = createAuthenticatedScmGitCommandRunner({
    canonicalHost: binding.repository.canonicalHost,
    token
  });
  return Object.freeze({ binding, provider, transport, gitRunner });
}

import { spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isAbsolute } from "node:path";
import { ScmObjectIdSchema, parseScmHttpsUrl, parseScmPublicationIntent } from "./schema.js";
import type { ScmPublicationIntentV1 } from "./types.js";

/**
 * The publisher performs one deliberately small external effect: publish an immutable,
 * already-reviewed commit to one exact remote branch under Git's compare-and-swap lease.
 * The caller must durably record the matching `push_intent` before calling this module.
 */

export const SCM_GIT_PUBLISH_LIMITS = Object.freeze({
  defaultTimeoutMs: 120_000,
  maximumTimeoutMs: 300_000,
  maximumOutputBytes: 64 * 1024,
  terminateGraceMs: 500,
  reapDeadlineMs: 5_000
});

export type ScmGitPublisherErrorCode =
  | "INVALID_REQUEST"
  | "REPOSITORY_IDENTITY_MISMATCH"
  | "REMOTE_IDENTITY_MISMATCH"
  | "LOCAL_REF_MISMATCH"
  | "LOCAL_OBJECT_MISSING"
  | "GIT_COMMAND_FAILED";

export class ScmGitPublisherError extends Error {
  constructor(readonly code: ScmGitPublisherErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ScmGitPublisherError";
  }
}

export type ScmGitCommandResult = Readonly<{
  disposition: "exited" | "timed_out" | "cancelled" | "output_limit" | "spawn_failed" | "reap_failed";
  exitCode: number | null;
  stdout: string;
  stderr: string;
}>;

export type ScmGitCommandRequest = Readonly<{
  cwd: string;
  args: readonly string[];
  timeoutMs: number;
  maximumOutputBytes: number;
  allowFileProtocol: boolean;
  signal?: AbortSignal;
}>;

export interface ScmGitCommandRunner {
  run(request: ScmGitCommandRequest): Promise<ScmGitCommandResult>;
}

export type ScmRemoteRefObservation =
  | Readonly<{ kind: "observed"; oid: string | null }>
  | Readonly<{ kind: "unknown"; reasonCode: ScmPublishAmbiguityReason }>;

export type ScmPublishAmbiguityReason =
  | "REMOTE_OBSERVATION_FAILED"
  | "REMOTE_OBSERVATION_TIMED_OUT"
  | "REMOTE_OBSERVATION_CANCELLED"
  | "REMOTE_OBSERVATION_OUTPUT_LIMIT"
  | "PUSH_FAILED_REMOTE_UNCHANGED"
  | "PUSH_TIMED_OUT_REMOTE_UNCHANGED"
  | "PUSH_CANCELLED_REMOTE_UNCHANGED"
  | "PUSH_OUTPUT_LIMIT_REMOTE_UNCHANGED"
  | "PUSH_OUTCOME_UNKNOWN";

export type ScmBranchPublishResult =
  | Readonly<{
      state: "branch_published";
      observedOid: string;
      completedBy: "already_published" | "push" | "post_push_reconciliation";
    }>
  | Readonly<{
      state: "push_ambiguous";
      reasonCode: ScmPublishAmbiguityReason;
      observedRemoteOid?: string | null;
      safeToRetry: boolean;
    }>
  | Readonly<{
      state: "refused";
      reasonCode: "REMOTE_REF_DIVERGED";
      observedRemoteOid: string | null;
    }>;

export type ScmBranchPublishRequest = Readonly<{
  intent: ScmPublicationIntentV1;
  repositoryRoot: string;
  expectedPushUrl: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Explicit test/local-development seam. Network publication is HTTPS-only by default. */
  allowFileRemote?: boolean;
  runner?: ScmGitCommandRunner;
}>;

export type ScmPushPlan = Readonly<{
  remoteName: string;
  remoteRef: string;
  immutableSourceOid: string;
  expectedRemoteOid: string | null;
  args: readonly string[];
}>;

const BASE_GIT_CONFIG = Object.freeze([
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "diff.external=",
  "-c", "credential.helper=",
  "-c", "core.pager=cat",
  "-c", "protocol.ext.allow=never",
  "-c", "protocol.ssh.allow=never",
  "-c", "protocol.git.allow=never",
  "-c", "protocol.http.allow=never",
  "-c", "protocol.https.allow=always"
]);

function boundedTimeout(value: number | undefined): number {
  const timeout = value ?? SCM_GIT_PUBLISH_LIMITS.defaultTimeoutMs;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > SCM_GIT_PUBLISH_LIMITS.maximumTimeoutMs) {
    throw new ScmGitPublisherError("INVALID_REQUEST", "timeout is outside the closed publisher bound");
  }
  return timeout;
}

function terminateProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

class DefaultScmGitCommandRunner implements ScmGitCommandRunner {
  constructor(private readonly credential?: Readonly<{ canonicalHost: string; authorization: string }>) {}

  async run(request: ScmGitCommandRequest): Promise<ScmGitCommandResult> {
    if (request.signal?.aborted) {
      return Object.freeze({ disposition: "cancelled", exitCode: null, stdout: "", stderr: "" });
    }

    const protocolConfig = request.allowFileProtocol
      ? ["-c", "protocol.file.allow=always"]
      : ["-c", "protocol.file.allow=never"];
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      SystemRoot: process.env.SystemRoot,
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_EXTERNAL_DIFF: "",
      GIT_PAGER: "cat"
    };
    if (this.credential !== undefined) {
      // Git's environment-backed config keeps the secret out of argv, diagnostics, persisted
      // configuration and the repository. Scope the header to the one canonical HTTPS authority and
      // reject redirects so it cannot be replayed to another host. The trusted parent-owned Git
      // process is the only child that receives this credential; coding-agent children never do.
      environment.GIT_CONFIG_COUNT = "2";
      environment.GIT_CONFIG_KEY_0 = `http.https://${this.credential.canonicalHost}/.extraHeader`;
      environment.GIT_CONFIG_VALUE_0 = this.credential.authorization;
      environment.GIT_CONFIG_KEY_1 = "http.followRedirects";
      environment.GIT_CONFIG_VALUE_1 = "false";
    }

    return await new Promise<ScmGitCommandResult>((resolve) => {
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let forced: Exclude<ScmGitCommandResult["disposition"], "exited" | "spawn_failed"> | undefined;
      let settled = false;
      let graceTimer: NodeJS.Timeout | undefined;
      let reapTimer: NodeJS.Timeout | undefined;

      const child = spawn("git", [...BASE_GIT_CONFIG, ...protocolConfig, ...request.args], {
        cwd: request.cwd,
        detached: process.platform !== "win32",
        env: environment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      });

      const cleanup = (): void => {
        clearTimeout(timeoutTimer);
        if (graceTimer) clearTimeout(graceTimer);
        if (reapTimer) clearTimeout(reapTimer);
        request.signal?.removeEventListener("abort", onAbort);
      };
      const finish = (result: ScmGitCommandResult): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(Object.freeze(result));
      };
      const terminate = (reason: typeof forced): void => {
        if (forced) return;
        forced = reason;
        try { terminateProcessGroup(child.pid, "SIGTERM"); } catch { /* final reap result remains closed */ }
        graceTimer = setTimeout(() => {
          try { terminateProcessGroup(child.pid, "SIGKILL"); } catch { /* handled by reap deadline */ }
        }, SCM_GIT_PUBLISH_LIMITS.terminateGraceMs);
        graceTimer.unref();
        reapTimer = setTimeout(() => finish({
          disposition: "reap_failed",
          exitCode: null,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8")
        }), SCM_GIT_PUBLISH_LIMITS.reapDeadlineMs);
        reapTimer.unref();
      };
      const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
        const remaining = request.maximumOutputBytes - stdout.byteLength - stderr.byteLength;
        if (remaining <= 0 || chunk.byteLength > remaining) {
          terminate("output_limit");
          return current;
        }
        return Buffer.concat([current, chunk]);
      };
      const onAbort = (): void => terminate("cancelled");
      const timeoutTimer = setTimeout(() => terminate("timed_out"), request.timeoutMs);
      timeoutTimer.unref();
      request.signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout?.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
      child.once("error", () => finish({ disposition: "spawn_failed", exitCode: null, stdout: "", stderr: "" }));
      child.once("close", (code) => finish({
        disposition: forced ?? "exited",
        exitCode: code,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8")
      }));
    });
  }
}

const defaultRunner = new DefaultScmGitCommandRunner();

/** Construct the production argv-only, bounded Git runner (primarily useful for fault-injection wrappers). */
export function createScmGitCommandRunner(): ScmGitCommandRunner {
  return new DefaultScmGitCommandRunner();
}

/**
 * Parent-only HTTPS Git runner. The token is closed over in memory and encoded only into the exact
 * Git subprocess environment; it never enters an argv, request DTO, ControlEvent or error string.
 */
export function createAuthenticatedScmGitCommandRunner(input: Readonly<{
  canonicalHost: string;
  token: string;
}>): ScmGitCommandRunner {
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u.test(input.canonicalHost)) {
    throw new ScmGitPublisherError("INVALID_REQUEST", "authenticated Git host is not canonical");
  }
  if (
    input.token.length === 0 || input.token !== input.token.trim() ||
    Buffer.byteLength(input.token, "utf8") > 16 * 1024 || /[\x00-\x20\x7f]/u.test(input.token)
  ) {
    throw new ScmGitPublisherError("INVALID_REQUEST", "authenticated Git credential violates the in-memory token policy");
  }
  const authorization = `Authorization: Basic ${Buffer.from(`x-access-token:${input.token}`, "utf8").toString("base64")}`;
  return new DefaultScmGitCommandRunner(Object.freeze({ canonicalHost: input.canonicalHost, authorization }));
}

function commandReason(prefix: "REMOTE_OBSERVATION" | "PUSH", result: ScmGitCommandResult): ScmPublishAmbiguityReason {
  if (prefix === "REMOTE_OBSERVATION") {
    if (result.disposition === "timed_out") return "REMOTE_OBSERVATION_TIMED_OUT";
    if (result.disposition === "cancelled") return "REMOTE_OBSERVATION_CANCELLED";
    if (result.disposition === "output_limit") return "REMOTE_OBSERVATION_OUTPUT_LIMIT";
    return "REMOTE_OBSERVATION_FAILED";
  }
  if (result.disposition === "timed_out") return "PUSH_TIMED_OUT_REMOTE_UNCHANGED";
  if (result.disposition === "cancelled") return "PUSH_CANCELLED_REMOTE_UNCHANGED";
  if (result.disposition === "output_limit") return "PUSH_OUTPUT_LIMIT_REMOTE_UNCHANGED";
  return "PUSH_FAILED_REMOTE_UNCHANGED";
}

function exactLines(value: string): string[] {
  if (value.includes("\0") || value.includes("\r")) return [];
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

function canonicalRepositoryRoot(value: string): string {
  if (!isAbsolute(value)) throw new ScmGitPublisherError("INVALID_REQUEST", "repository root must be absolute");
  let canonical: string;
  try {
    canonical = realpathSync(value);
    if (!lstatSync(canonical).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new ScmGitPublisherError("INVALID_REQUEST", "repository root must be an existing canonical directory");
  }
  if (canonical !== value) throw new ScmGitPublisherError("INVALID_REQUEST", "repository root must already be canonical");
  return canonical;
}

function canonicalPushUrl(intent: ScmPublicationIntentV1, value: string, allowFileRemote: boolean): string {
  if (!allowFileRemote) {
    try { return parseScmHttpsUrl(value, intent.repository.canonicalHost); }
    catch { throw new ScmGitPublisherError("INVALID_REQUEST", "push URL is not canonical HTTPS for the configured host"); }
  }

  let parsed: URL;
  try { parsed = new URL(value); } catch {
    throw new ScmGitPublisherError("INVALID_REQUEST", "local remote URL is invalid");
  }
  if (parsed.protocol !== "file:" || parsed.host || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ScmGitPublisherError("INVALID_REQUEST", "the local remote seam accepts only a credential-free canonical file URL");
  }
  try {
    const canonicalPath = realpathSync(fileURLToPath(parsed));
    const canonical = pathToFileURL(canonicalPath).href;
    if (canonical !== value) throw new Error("non-canonical");
    return canonical;
  } catch {
    throw new ScmGitPublisherError("INVALID_REQUEST", "local remote URL must identify an existing canonical path");
  }
}

async function checkedOutput(
  runner: ScmGitCommandRunner,
  request: Omit<ScmGitCommandRequest, "args">,
  args: readonly string[],
  code: ScmGitPublisherErrorCode,
  message: string
): Promise<string> {
  const result = await runner.run({ ...request, args });
  if (result.disposition !== "exited" || result.exitCode !== 0) throw new ScmGitPublisherError(code, message);
  return result.stdout;
}

export function buildScmPushPlan(intentValue: ScmPublicationIntentV1): ScmPushPlan {
  const intent = parseScmPublicationIntent(intentValue);
  const expected = intent.expectedRemote.kind === "absent" ? null : intent.expectedRemote.oid;
  const lease = `--force-with-lease=${intent.remoteRef}:${expected ?? ""}`;
  return Object.freeze({
    remoteName: intent.remoteName,
    remoteRef: intent.remoteRef,
    immutableSourceOid: intent.integrationOid,
    expectedRemoteOid: expected,
    args: Object.freeze([
      "push",
      "--porcelain",
      "--no-progress",
      "--no-verify",
      "--receive-pack=git-receive-pack",
      lease,
      intent.remoteName,
      `${intent.integrationOid}:${intent.remoteRef}`
    ])
  });
}

async function observeRemoteRef(
  runner: ScmGitCommandRunner,
  command: Omit<ScmGitCommandRequest, "args">,
  intent: ScmPublicationIntentV1
): Promise<ScmRemoteRefObservation> {
  const result = await runner.run({
    ...command,
    args: ["ls-remote", "--refs", "--upload-pack=git-upload-pack", intent.remoteName, intent.remoteRef]
  });
  if (result.disposition !== "exited" || result.exitCode !== 0) {
    return Object.freeze({ kind: "unknown", reasonCode: commandReason("REMOTE_OBSERVATION", result) });
  }
  const lines = exactLines(result.stdout);
  if (lines.length === 0) return Object.freeze({ kind: "observed", oid: null });
  if (lines.length !== 1) return Object.freeze({ kind: "unknown", reasonCode: "REMOTE_OBSERVATION_FAILED" });
  const match = /^([a-f0-9]{40}|[a-f0-9]{64})\t(refs\/heads\/[A-Za-z0-9._\/-]+)$/u.exec(lines[0]!);
  if (!match || match[2] !== intent.remoteRef) {
    return Object.freeze({ kind: "unknown", reasonCode: "REMOTE_OBSERVATION_FAILED" });
  }
  try { ScmObjectIdSchema.parse(match[1]); }
  catch { return Object.freeze({ kind: "unknown", reasonCode: "REMOTE_OBSERVATION_FAILED" }); }
  return Object.freeze({ kind: "observed", oid: match[1]! });
}

function reconcileObservation(
  intent: ScmPublicationIntentV1,
  observation: ScmRemoteRefObservation,
  context: "before_push" | "after_push",
  pushResult?: ScmGitCommandResult
): ScmBranchPublishResult | undefined {
  if (observation.kind === "unknown") {
    return Object.freeze({ state: "push_ambiguous", reasonCode: context === "after_push" ? "PUSH_OUTCOME_UNKNOWN" : observation.reasonCode, safeToRetry: false });
  }
  if (observation.oid === intent.integrationOid) {
    return Object.freeze({
      state: "branch_published",
      observedOid: intent.integrationOid,
      completedBy: context === "before_push" ? "already_published" : "post_push_reconciliation"
    });
  }
  const expected = intent.expectedRemote.kind === "absent" ? null : intent.expectedRemote.oid;
  if (observation.oid !== expected) {
    return Object.freeze({ state: "refused", reasonCode: "REMOTE_REF_DIVERGED", observedRemoteOid: observation.oid });
  }
  if (context === "before_push") return undefined;
  return Object.freeze({
    state: "push_ambiguous",
    reasonCode: commandReason("PUSH", pushResult!),
    observedRemoteOid: observation.oid,
    safeToRetry: true
  });
}

/**
 * Publish a reviewed commit without ever resolving the source ref during the external write.
 * A non-successful push is always followed by an exact remote observation; unknown outcomes
 * remain ambiguous, and a divergent branch is never overwritten.
 */
export async function publishScmBranch(request: ScmBranchPublishRequest): Promise<ScmBranchPublishResult> {
  let intent: ScmPublicationIntentV1;
  try { intent = parseScmPublicationIntent(request.intent); }
  catch { throw new ScmGitPublisherError("INVALID_REQUEST", "publication intent is invalid"); }
  const root = canonicalRepositoryRoot(request.repositoryRoot);
  const allowFile = request.allowFileRemote === true;
  const expectedUrl = canonicalPushUrl(intent, request.expectedPushUrl, allowFile);
  const timeoutMs = boundedTimeout(request.timeoutMs);
  const runner = request.runner ?? defaultRunner;
  const command = {
    cwd: root,
    timeoutMs,
    maximumOutputBytes: SCM_GIT_PUBLISH_LIMITS.maximumOutputBytes,
    allowFileProtocol: allowFile,
    signal: request.signal
  } satisfies Omit<ScmGitCommandRequest, "args">;

  const topLevel = exactLines(await checkedOutput(
    runner,
    command,
    ["rev-parse", "--show-toplevel"],
    "REPOSITORY_IDENTITY_MISMATCH",
    "repository top-level could not be proven"
  ));
  if (topLevel.length !== 1 || realpathSync(topLevel[0]!) !== root) {
    throw new ScmGitPublisherError("REPOSITORY_IDENTITY_MISMATCH", "repository top-level does not match the configured canonical root");
  }

  const remoteUrls = exactLines(await checkedOutput(
    runner,
    command,
    ["remote", "get-url", "--push", "--all", intent.remoteName],
    "REMOTE_IDENTITY_MISMATCH",
    "configured push remote could not be resolved"
  ));
  if (remoteUrls.length !== 1 || remoteUrls[0] !== expectedUrl) {
    throw new ScmGitPublisherError("REMOTE_IDENTITY_MISMATCH", "push remote does not exactly match the configured identity");
  }

  const localLines = exactLines(await checkedOutput(
    runner,
    command,
    ["rev-parse", "--verify", "--end-of-options", `${intent.integrationRef}^{commit}`],
    "LOCAL_REF_MISMATCH",
    "integration ref could not be resolved"
  ));
  if (localLines.length !== 1 || localLines[0] !== intent.localExpectedOid) {
    throw new ScmGitPublisherError("LOCAL_REF_MISMATCH", "integration ref moved after review");
  }
  await checkedOutput(
    runner,
    command,
    ["cat-file", "-e", `${intent.integrationOid}^{commit}`],
    "LOCAL_OBJECT_MISSING",
    "reviewed integration object is unavailable"
  );

  const before = await observeRemoteRef(runner, command, intent);
  const preflight = reconcileObservation(intent, before, "before_push");
  if (preflight) return preflight;

  const push = await runner.run({ ...command, args: buildScmPushPlan(intent).args });
  const after = await observeRemoteRef(runner, command, intent);
  if (push.disposition === "exited" && push.exitCode === 0 && after.kind === "observed" && after.oid === intent.integrationOid) {
    return Object.freeze({ state: "branch_published", observedOid: intent.integrationOid, completedBy: "push" });
  }
  return reconcileObservation(intent, after, "after_push", push)!;
}

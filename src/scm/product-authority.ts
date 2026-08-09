import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { ProjectConfig } from "../config/schema.js";
import { canonicalJson, parseControlEvent, type ControlEvent } from "../control/events.js";
import type { ControlStore } from "../control/store.js";
import { ControlStoreError } from "../control/store.js";
import type { MultiRepositoryTaskConfig } from "../config/schema.js";
import type { MultiRepoPublicationAdapter } from "../multirepo/publication.js";
import { dispatchSteeringSessionId } from "../steering/integration.js";
import type { ParentSteeringService } from "../steering/service.js";
import type { GithubTransport } from "./github.js";
import { createGithubPullRequestBodyCrossLinkWriter } from "./github-crosslinks.js";
import { createParentScmLifecycle, type ParentScmPollRequestV1 } from "./lifecycle.js";
import { createScmMultiRepoPublicationBridge } from "./multirepo-bridge.js";
import { createScmProductRuntime, type ScmProductRuntimeV1 } from "./product-policy.js";

export const SCM_PRODUCT_AUTHORITY_MAX_REPOSITORIES = 32;
export const SCM_PRODUCT_AUTHORITY_DEFAULT_POLL_INTERVAL_MS = 30_000;

export type ParentScmProductAuthorityOptions = Readonly<{
  project: ProjectConfig;
  configRoot: string;
  store: ControlStore;
  steering: Pick<ParentSteeringService, "admit">;
  actorId: string;
  environment: Readonly<Record<string, string | undefined>>;
  /** Credential-free test seam keyed by configured repository ID. */
  transports?: Readonly<Record<string, GithubTransport>>;
  /** Event timestamp clock. It never controls polling cadence. */
  now?: () => Date;
  /**
   * Process-lifetime monotonic cadence seam. A new authority intentionally starts without a prior
   * cadence checkpoint and immediately reconciles durable published facts after restart.
   */
  monotonicNowMs?: () => number;
  /** Closed test/operations seam; production uses the conservative default. */
  pollIntervalMs?: number;
}>;

export type ParentScmProductPollRequestV1 = Omit<ParentScmPollRequestV1, "sessionId" | "sessionGeneration"> & Readonly<{
  repository: string;
}>;

export class ParentScmProductAuthorityError extends Error {
  constructor(
    readonly code:
      | "INVALID_CONFIGURATION"
      | "CANONICAL_IDENTITY_MISMATCH"
      | "CAPABILITY_MISSING"
      | "CLOSED",
    message: string
  ) {
    super(`${code}: ${message}`);
    this.name = "ParentScmProductAuthorityError";
  }
}

function stableId(domain: string, value: unknown): string {
  return `${domain}-${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex").slice(0, 48)}`;
}

function currentTimestamp(store: ControlStore, now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new ParentScmProductAuthorityError("INVALID_CONFIGURATION", "SCM authority clock returned an invalid Date");
  }
  return value.toISOString();
}

/**
 * Register the P6 task identity in the shared P1 namespace before P3 facts use the ordinary task
 * generation fence. This is an explicit projection bridge, not a second scheduler: P6 remains the
 * execution authority and these shadow targets exist only for shared steering/SCM/observation facts.
 */
function seedPublicationTargets(options: ParentScmProductAuthorityOptions, now: () => Date): void {
  const tasks = (options.project.multiRepository?.tasks ?? []).filter((task) => task.publication !== undefined);
  if (tasks.length === 0) return;
  for (const task of tasks) {
    if (task.generation !== 1) {
      throw new ParentScmProductAuthorityError("INVALID_CONFIGURATION", `SCM publication task ${task.id} must begin at generation 1`);
    }
  }
  let tasksSeeded = false;
  for (let retry = 0; retry < 16; retry += 1) {
    const projection = options.store.getProjection();
    const missing = tasks.filter((task) => projection.tasks[task.id] === undefined);
    for (const task of tasks) {
      const existing = projection.tasks[task.id];
      if (existing !== undefined && (
        existing.generation !== task.generation || existing.assignee !== task.role ||
        canonicalJson(existing.dependsOn) !== canonicalJson(task.dependsOn)
      )) {
        throw new ParentScmProductAuthorityError("CANONICAL_IDENTITY_MISMATCH", `SCM publication target ${task.id} differs from canonical task facts`);
      }
    }
    if (missing.length === 0) {
      tasksSeeded = true;
      break;
    }
    const occurredAt = currentTimestamp(options.store, now);
    const events = missing.map((task): ControlEvent => parseControlEvent({
      schemaVersion: 1,
      eventId: stableId("scm-task", [options.store.runEpoch, task.id, task.generation]),
      runId: options.store.runId,
      runEpoch: options.store.runEpoch,
      taskId: task.id,
      taskGeneration: task.generation,
      expectedVersion: 0,
      occurredAt,
      actorKind: "control-plane",
      actorId: options.actorId,
      sourceKind: null,
      sourceId: null,
      sourceGeneration: null,
      sourceEventId: null,
      type: "task.created",
      payload: {
        title: `Multi-repository publication ${task.id}`,
        assignee: task.role,
        createdBy: options.actorId,
        description: "Shared P3 publication/feedback target for a P6 task.",
        acceptanceCriteria: ["canonical remote publication and feedback lifecycle"],
        dependsOn: [...task.dependsOn],
        priority: task.priority,
        createdAt: occurredAt
      }
    }));
    try { options.store.appendBatchIf({ expectedHeadSeq: projection.headSeq, events }); }
    catch (error) {
      if (error instanceof ControlStoreError && ["STALE_VERSION", "EVENT_ID_CONFLICT", "STORE_BUSY"].includes(error.code)) continue;
      throw error;
    }
  }
  if (!tasksSeeded) {
    throw new ParentScmProductAuthorityError("CANONICAL_IDENTITY_MISMATCH", "SCM publication task targets did not converge under the canonical head bound");
  }

  // A publication observer needs an exact, task-bound runtime generation for its P2 reaction. The
  // `available` observation proves no current prompt boundary; P2 may only queue the first future
  // boundary and cannot claim delivery from this fact.
  for (let retry = 0; retry < 16; retry += 1) {
    const projection = options.store.getProjection();
    const missing: MultiRepositoryTaskConfig[] = [];
    for (const task of tasks) {
      const sessionId = dispatchSteeringSessionId(task.role, task.id);
      const runtime = projection.runtimes[sessionId];
      if (runtime === undefined) missing.push(task);
      else if (runtime.sessionGeneration !== 1 || runtime.taskId !== task.id || runtime.taskGeneration !== task.generation) {
        throw new ParentScmProductAuthorityError("CANONICAL_IDENTITY_MISMATCH", `SCM runtime target for ${task.id} differs from canonical facts`);
      }
    }
    if (missing.length === 0) return;
    const occurredAt = currentTimestamp(options.store, now);
    const events = missing.map((task): ControlEvent => {
      const sessionId = dispatchSteeringSessionId(task.role, task.id);
      return parseControlEvent({
        schemaVersion: 1,
        eventId: stableId("scm-runtime", [options.store.runEpoch, sessionId, 1]),
        runId: options.store.runId,
        runEpoch: options.store.runEpoch,
        taskId: task.id,
        taskGeneration: task.generation,
        expectedVersion: 0,
        occurredAt,
        actorKind: "control-plane",
        actorId: options.actorId,
        sourceKind: null,
        sourceId: null,
        sourceGeneration: null,
        sourceEventId: null,
        type: "runtime.observed",
        payload: { sessionId, sessionGeneration: 1, observation: "available", reason: "parent SCM observer is bound for a future prompt boundary" }
      });
    });
    try { options.store.appendBatchIf({ expectedHeadSeq: projection.headSeq, events }); }
    catch (error) {
      if (error instanceof ControlStoreError && ["STALE_VERSION", "EVENT_ID_CONFLICT", "STORE_BUSY"].includes(error.code)) continue;
      throw error;
    }
  }
  throw new ParentScmProductAuthorityError("CANONICAL_IDENTITY_MISMATCH", "SCM publication targets did not converge under the canonical head bound");
}

/** Parent-owned, run-lifetime product coordinator for configured SCM repositories. */
export class ParentScmProductAuthority {
  private readonly project: ProjectConfig;
  private readonly runtimes: Readonly<Record<string, ScmProductRuntimeV1>>;
  private readonly lifecycles: Readonly<Record<string, ReturnType<typeof createParentScmLifecycle>>>;
  private readonly abort = new AbortController();
  private readonly active = new Set<Promise<unknown>>();
  private readonly store: ControlStore;
  private readonly publicationRoutes: Readonly<Record<string, Readonly<{
    repository: string;
    taskId: string;
    taskGeneration: number;
  }>>>;
  private readonly pollIntervalMs: number;
  private readonly monotonicNowMs: () => number;
  /** Process-local only: durable publications are deliberately scanned immediately after restart. */
  private readonly lastPollStartedAt = new Map<string, number>();
  private lastMonotonicReading: number | undefined;
  private readonly unsubscribe: () => void;
  private scanTimer: NodeJS.Timeout | undefined;
  private scanPromise: Promise<void> | undefined;
  private scanAgain = false;
  private backgroundFailure: unknown;
  private closed = false;

  constructor(options: ParentScmProductAuthorityOptions) {
    if (options.project.scm === undefined) throw new ParentScmProductAuthorityError("INVALID_CONFIGURATION", "project has no SCM configuration");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(options.actorId)) {
      throw new ParentScmProductAuthorityError("INVALID_CONFIGURATION", "SCM actor identity is invalid");
    }
    this.project = options.project;
    this.store = options.store;
    this.pollIntervalMs = options.pollIntervalMs ?? SCM_PRODUCT_AUTHORITY_DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 10 || this.pollIntervalMs > 3_600_000) {
      throw new ParentScmProductAuthorityError("INVALID_CONFIGURATION", "SCM poll interval must be an integer from 10 through 3600000 milliseconds");
    }
    this.monotonicNowMs = options.monotonicNowMs ?? (() => performance.now());
    const now = options.now ?? (() => new Date());
    seedPublicationTargets(options, now);
    const configuredRepositories = new Map(options.project.repositories.map((repository) => [repository.name, repository]));
    const runtimes: Record<string, ScmProductRuntimeV1> = {};
    const lifecycles: Record<string, ReturnType<typeof createParentScmLifecycle>> = {};
    for (const config of options.project.scm.repositories) {
      const repository = configuredRepositories.get(config.repository);
      if (!repository) throw new ParentScmProductAuthorityError("INVALID_CONFIGURATION", `SCM repository ${config.repository} is not configured`);
      let root: string;
      try { root = realpathSync(resolve(options.configRoot, repository.path)); }
      catch { throw new ParentScmProductAuthorityError("INVALID_CONFIGURATION", `SCM repository ${config.repository} root is unavailable`); }
      const runtime = createScmProductRuntime({
        config: {
          schemaVersion: 1,
          repositoryKey: config.repository,
          provider: config.provider,
          canonicalHost: config.canonicalHost,
          owner: config.owner,
          name: config.name,
          baseOwner: config.baseOwner,
          baseName: config.baseName,
          repositoryRoot: root,
          remoteName: config.remoteName,
          expectedPushUrl: config.expectedPushUrl,
          baseRef: config.baseRef,
          credentialEnv: config.credentialEnv,
          capabilities: config.capabilities,
          ...(config.limits === undefined ? {} : { limits: config.limits })
        },
        environment: options.environment,
        ...(options.transports?.[config.repository] === undefined ? {} : { transport: options.transports[config.repository] }),
        now
      });
      runtimes[config.repository] = runtime;
      lifecycles[config.repository] = createParentScmLifecycle({
        store: options.store,
        binding: runtime.binding,
        provider: runtime.provider,
        steering: options.steering,
        actorId: options.actorId,
        now,
        gitRunner: runtime.gitRunner
      });
    }
    if (Object.keys(runtimes).length < 1 || Object.keys(runtimes).length > SCM_PRODUCT_AUTHORITY_MAX_REPOSITORIES) {
      throw new ParentScmProductAuthorityError("INVALID_CONFIGURATION", "SCM repository vector is outside its bound");
    }
    this.runtimes = Object.freeze(runtimes);
    this.lifecycles = Object.freeze(lifecycles);
    const publicationRoutes: Record<string, Readonly<{ repository: string; taskId: string; taskGeneration: number }>> = {};
    for (const task of options.project.multiRepository?.tasks ?? []) {
      for (const entry of task.publication?.entries ?? []) {
        if (publicationRoutes[entry.publicationId] !== undefined) {
          throw new ParentScmProductAuthorityError("INVALID_CONFIGURATION", `publication ID ${entry.publicationId} is reused across tasks`);
        }
        publicationRoutes[entry.publicationId] = Object.freeze({
          repository: entry.repository,
          taskId: task.id,
          taskGeneration: task.generation
        });
      }
    }
    this.publicationRoutes = Object.freeze(publicationRoutes);
    this.unsubscribe = options.store.subscribe(() => this.wakeObserver());
    this.wakeObserver();
  }

  repositoryIds(): readonly string[] { return Object.freeze(Object.keys(this.runtimes).sort()); }

  publicationAdapterForTask(taskId: string): MultiRepoPublicationAdapter {
    this.assertOpen();
    const task = this.project.multiRepository?.tasks.find((candidate) => candidate.id === taskId);
    if (!task?.publication) throw new ParentScmProductAuthorityError("CAPABILITY_MISSING", `task ${taskId} has no publication plan`);
    if (this.project.scm?.crossLinks?.mode !== "pull-request-body") {
      throw new ParentScmProductAuthorityError("CAPABILITY_MISSING", "SCM pull-request body cross-link capability is not configured");
    }
    const contexts: Record<string, Parameters<typeof createScmMultiRepoPublicationBridge>[0]["contexts"][string]> = {};
    for (const entry of task.publication.entries) {
      const runtime = this.runtimes[entry.repository];
      const lifecycle = this.lifecycles[entry.repository];
      if (!runtime || !lifecycle) throw new ParentScmProductAuthorityError("CAPABILITY_MISSING", `task ${taskId} repository ${entry.repository} has no SCM authority`);
      contexts[entry.repository] = Object.freeze({
        lifecycle,
        binding: runtime.binding,
        taskId: task.id,
        taskGeneration: task.generation,
        signal: this.abort.signal
      });
    }
    const transports = Object.freeze(Object.fromEntries(Object.entries(this.runtimes).map(([id, runtime]) => [id, runtime.transport])));
    return createScmMultiRepoPublicationBridge({
      contexts: Object.freeze(contexts),
      crossLinkWriter: createGithubPullRequestBodyCrossLinkWriter({ transports })
    });
  }

  publicationAdapterForRun(): MultiRepoPublicationAdapter {
    this.assertOpen();
    const adapters = new Map<string, MultiRepoPublicationAdapter>();
    for (const task of this.project.multiRepository?.tasks ?? []) {
      if (!task.publication) continue;
      const adapter = this.publicationAdapterForTask(task.id);
      for (const entry of task.publication.entries) {
        if (adapters.has(entry.publicationId)) {
          throw new ParentScmProductAuthorityError("INVALID_CONFIGURATION", `publication ID ${entry.publicationId} is reused across tasks`);
        }
        adapters.set(entry.publicationId, adapter);
      }
    }
    if (adapters.size === 0) throw new ParentScmProductAuthorityError("CAPABILITY_MISSING", "run has no configured SCM publication plans");
    const select = (publicationId: string): MultiRepoPublicationAdapter => {
      const adapter = adapters.get(publicationId);
      if (!adapter) throw new ParentScmProductAuthorityError("CANONICAL_IDENTITY_MISMATCH", `publication ${publicationId} has no exact task adapter`);
      return adapter;
    };
    return Object.freeze({
      publishBranch: (plan: Parameters<MultiRepoPublicationAdapter["publishBranch"]>[0]) => select(plan.publicationId).publishBranch(plan),
      ensurePullRequest: (plan: Parameters<MultiRepoPublicationAdapter["ensurePullRequest"]>[0]) => select(plan.publicationId).ensurePullRequest(plan),
      ensureCrossLinks: (input: Parameters<MultiRepoPublicationAdapter["ensureCrossLinks"]>[0]) => select(input.entry.publicationId).ensureCrossLinks(input)
    });
  }

  poll(request: ParentScmProductPollRequestV1): Promise<Awaited<ReturnType<ReturnType<typeof createParentScmLifecycle>["poll"]>>> {
    this.assertOpen();
    const lifecycle = this.lifecycles[request.repository];
    if (!lifecycle) throw new ParentScmProductAuthorityError("CAPABILITY_MISSING", `repository ${request.repository} has no SCM observer`);
    const task = this.project.multiRepository?.tasks.find((candidate) => candidate.id === request.taskId);
    if (!task || task.generation !== request.taskGeneration) {
      throw new ParentScmProductAuthorityError("CANONICAL_IDENTITY_MISMATCH", "SCM poll task generation differs from configuration");
    }
    const operation = lifecycle.poll({
      ...request,
      sessionId: dispatchSteeringSessionId(task.role, task.id),
      sessionGeneration: 1
    });
    this.active.add(operation);
    void operation.then(
      () => this.active.delete(operation),
      () => this.active.delete(operation)
    );
    return operation;
  }

  /** Deterministic parent-owned scan seam; the automatic store wake/timer lifecycle uses the same path. */
  async pollPublishedNow(): Promise<void> {
    this.assertOpen();
    if (this.scanTimer !== undefined) clearTimeout(this.scanTimer);
    this.scanTimer = undefined;
    await this.startScan();
    if (this.backgroundFailure !== undefined) throw this.backgroundFailure;
  }

  async closeAndDrain(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    if (this.scanTimer !== undefined) clearTimeout(this.scanTimer);
    this.scanTimer = undefined;
    this.abort.abort();
    if (this.scanPromise !== undefined) await this.scanPromise;
    await Promise.allSettled([...this.active]);
    if (this.backgroundFailure !== undefined) throw this.backgroundFailure;
  }

  private assertOpen(): void {
    if (this.closed) throw new ParentScmProductAuthorityError("CLOSED", "SCM parent authority is closed");
    if (this.backgroundFailure !== undefined) throw this.backgroundFailure;
  }

  private wakeObserver(): void {
    if (this.closed || this.backgroundFailure !== undefined) return;
    if (this.scanPromise !== undefined) {
      this.scanAgain = true;
      return;
    }
    if (this.scanTimer !== undefined) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => {
      this.scanTimer = undefined;
      void this.startScan();
    }, 0);
    this.scanTimer.unref();
  }

  private schedulePeriodicObserver(): void {
    if (this.closed || this.backgroundFailure !== undefined || this.scanTimer !== undefined) return;
    this.scanTimer = setTimeout(() => {
      this.scanTimer = undefined;
      void this.startScan();
    }, this.pollIntervalMs);
    this.scanTimer.unref();
  }

  private async startScan(): Promise<void> {
    if (this.closed || this.backgroundFailure !== undefined) return;
    if (this.scanPromise !== undefined) {
      this.scanAgain = true;
      return await this.scanPromise;
    }
    const operation = this.scanPublished();
    this.scanPromise = operation;
    try {
      await operation;
    } catch (error) {
      if (!this.closed) this.backgroundFailure ??= error;
    } finally {
      if (this.scanPromise === operation) this.scanPromise = undefined;
      if (!this.closed && this.backgroundFailure === undefined) {
        if (this.scanAgain) {
          this.scanAgain = false;
          this.wakeObserver();
        } else this.schedulePeriodicObserver();
      }
    }
  }

  private async scanPublished(): Promise<void> {
    const projection = this.store.getProjection();
    const cadenceNow = this.readMonotonicCadence();
    for (const publicationId of Object.keys(this.publicationRoutes).sort()) {
      if (this.abort.signal.aborted) return;
      const route = this.publicationRoutes[publicationId]!;
      const publication = projection.scm.publications[publicationId];
      if (!publication || publication.state !== "published" || !publication.pullRequest ||
          publication.taskId !== route.taskId || publication.taskGeneration !== route.taskGeneration) continue;
      const last = this.lastPollStartedAt.get(publicationId);
      if (last !== undefined && cadenceNow - last < this.pollIntervalMs) continue;
      this.lastPollStartedAt.set(publicationId, cadenceNow);
      const nextAttempt = Object.values(projection.attempts)
        .filter((attempt) => attempt.taskId === route.taskId && attempt.taskGeneration === route.taskGeneration)
        .reduce((maximum, attempt) => Math.max(maximum, attempt.attemptGeneration + 1), 1);
      await this.poll({
        repository: route.repository,
        publicationId,
        taskId: route.taskId,
        taskGeneration: route.taskGeneration,
        notBeforeAttemptGeneration: nextAttempt,
        signal: this.abort.signal
      });
    }
  }

  private readMonotonicCadence(): number {
    const value = this.monotonicNowMs();
    if (!Number.isFinite(value) || value < 0) {
      throw new ParentScmProductAuthorityError("INVALID_CONFIGURATION", "SCM monotonic cadence clock returned an invalid value");
    }
    if (this.lastMonotonicReading !== undefined && value < this.lastMonotonicReading) {
      throw new ParentScmProductAuthorityError("INVALID_CONFIGURATION", "SCM monotonic cadence clock moved backwards");
    }
    this.lastMonotonicReading = value;
    return value;
  }
}

export function createParentScmProductAuthority(options: ParentScmProductAuthorityOptions): ParentScmProductAuthority {
  return new ParentScmProductAuthority(options);
}

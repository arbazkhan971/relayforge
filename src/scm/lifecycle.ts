import { createHash } from "node:crypto";
import { parseControlEvent, canonicalJson, type ControlEvent } from "../control/events.js";
import { type ControlProjection, type ScmPublicationFact } from "../control/reducer.js";
import { ControlStoreError, type ControlStore } from "../control/store.js";
import type { ParentSteeringService } from "../steering/service.js";
import { createScmObserver, type ScmObserverPollResultV1 } from "./observer.js";
import { publishScmBranch, type ScmGitCommandRunner } from "./publish.js";
import {
  createScmPublicationAggregate,
  decidePullRequestRecovery,
  type ScmPublicationAggregateV1
} from "./reconcile.js";
import {
  ScmBranchRefSchema,
  ScmObjectIdSchema,
  parseScmPublicationIntent,
  sameScmRepository,
  scmSemanticDigest
} from "./schema.js";
import type {
  ScmProviderV1,
  ScmPublicationIntentV1,
  ScmPublicationState,
  ScmPullRequestFactV1,
  ScmPullRequestIdentityV1,
  ScmRemoteExpectationV1
} from "./types.js";
import type { ScmRepositoryBindingV1 } from "./product-policy.js";

export const SCM_LIFECYCLE_MAX_TRANSITIONS = 16;
export const SCM_LIFECYCLE_MAX_CAS_RETRIES = 16;

export type ParentScmPublicationRequestV1 = Readonly<{
  taskId: string;
  taskGeneration: number;
  repositoryKey: string;
  publicationId: string;
  publicationGeneration?: number;
  attempt?: number;
  integrationRef: string;
  integrationOid: string;
  localExpectedOid: string;
  remoteName: string;
  remoteRef: string;
  expectedRemote: ScmRemoteExpectationV1;
  baseRef: string;
  title: string;
  body: string;
  draft: boolean;
  signal: AbortSignal;
}>;

export type ParentScmPublicationResultV1 =
  | Readonly<{ status: "branch_published"; publication: ScmPublicationFact; remoteOid: string }>
  | Readonly<{ status: "published"; publication: ScmPublicationFact; pullRequest: ScmPullRequestFactV1 }>
  | Readonly<{ status: "ambiguous"; publication: ScmPublicationFact; reasonCode: string }>
  | Readonly<{ status: "refused"; publication: ScmPublicationFact; reasonCode: string }>
  | Readonly<{ status: "superseded"; publication: ScmPublicationFact }>
  | Readonly<{ status: "cancelled"; publication?: ScmPublicationFact }>
  | Readonly<{ status: "transition_bound"; publication: ScmPublicationFact }>;

export type ParentScmPollRequestV1 = Readonly<{
  publicationId: string;
  taskId: string;
  taskGeneration: number;
  sessionId: string;
  sessionGeneration: number;
  notBeforeAttemptGeneration: number;
  signal: AbortSignal;
}>;

export type ParentScmLifecycleOptions = Readonly<{
  store: ControlStore;
  binding: ScmRepositoryBindingV1;
  provider: ScmProviderV1;
  steering: Pick<ParentSteeringService, "admit">;
  actorId: string;
  now?: () => Date;
  gitRunner?: ScmGitCommandRunner;
  maxTransitions?: number;
  maxCasRetries?: number;
}>;

export class ParentScmLifecycleError extends Error {
  constructor(
    readonly code:
      | "INVALID_REQUEST"
      | "RUN_IDENTITY_MISMATCH"
      | "TARGET_MISMATCH"
      | "STALE_GENERATION"
      | "CAPABILITY_MISSING"
      | "PUBLICATION_CONFLICT",
    message: string
  ) {
    super(`${code}: ${message}`);
    this.name = "ParentScmLifecycleError";
  }
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function boundedReason(value: unknown, fallback: string): string {
  const candidate = value && typeof value === "object" && "code" in value ? String((value as { code: unknown }).code) : fallback;
  return candidate.toUpperCase().replace(/[^A-Z0-9_]/gu, "_").slice(0, 64) || fallback;
}

function isConcurrent(error: unknown): boolean {
  return error instanceof ControlStoreError &&
    (error.code === "STALE_VERSION" || error.code === "EVENT_ID_CONFLICT" || error.code === "STORE_BUSY");
}

function aggregateFromFact(fact: ScmPublicationFact): ScmPublicationAggregateV1 {
  return Object.freeze({
    ...createScmPublicationAggregate(fact.intent),
    version: fact.version,
    state: fact.state
  });
}

function pullIdentityFromFact(fact: ScmPullRequestFactV1): ScmPullRequestIdentityV1 {
  return Object.freeze({
    providerId: fact.providerId,
    number: fact.number,
    url: fact.url,
    repository: fact.repository,
    headRepository: fact.headRepository,
    headRef: fact.headRef,
    headSha: fact.headSha,
    baseRepository: fact.baseRepository,
    baseRef: fact.baseRef,
    baseSha: fact.baseSha
  });
}

function validatePositive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new ParentScmLifecycleError("INVALID_REQUEST", `${label} must be a positive safe integer`);
  return value;
}

/**
 * Parent-owned publication/observation boundary. The already-open P1 store remains the only
 * canonical writer, every remote side effect has a durable intent, and all retries reconcile first.
 */
export class ParentScmLifecycle {
  private readonly store: ControlStore;
  private readonly binding: ScmRepositoryBindingV1;
  private readonly provider: ScmProviderV1;
  private readonly actorId: string;
  private readonly now: () => Date;
  private readonly gitRunner?: ScmGitCommandRunner;
  private readonly maxTransitions: number;
  private readonly maxCasRetries: number;
  private readonly observer: ReturnType<typeof createScmObserver>;

  constructor(options: ParentScmLifecycleOptions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(options.actorId)) {
      throw new ParentScmLifecycleError("INVALID_REQUEST", "SCM lifecycle actor ID is invalid");
    }
    if (options.binding.repositoryKey.length === 0 || options.binding.allowFileRemote && !options.binding.expectedPushUrl.startsWith("file:")) {
      throw new ParentScmLifecycleError("INVALID_REQUEST", "SCM repository binding is invalid");
    }
    for (const capability of ["scm.read", "scm.publish_branch", "scm.write_pr"] as const) {
      if (!options.binding.capabilities.includes(capability)) {
        throw new ParentScmLifecycleError("CAPABILITY_MISSING", `SCM lifecycle requires ${capability}`);
      }
    }
    if (!options.provider.capabilities.includes("scm.read") || !options.provider.capabilities.includes("scm.write_pr") ||
        options.provider.provider !== options.binding.repository.provider) {
      throw new ParentScmLifecycleError("CAPABILITY_MISSING", "SCM provider does not satisfy the repository binding");
    }
    this.store = options.store;
    this.binding = options.binding;
    this.provider = options.provider;
    this.actorId = options.actorId;
    this.now = options.now ?? (() => new Date());
    this.gitRunner = options.gitRunner;
    this.maxTransitions = options.maxTransitions ?? SCM_LIFECYCLE_MAX_TRANSITIONS;
    this.maxCasRetries = options.maxCasRetries ?? SCM_LIFECYCLE_MAX_CAS_RETRIES;
    for (const [label, value, maximum] of [
      ["transition bound", this.maxTransitions, 64],
      ["CAS retry bound", this.maxCasRetries, 64]
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
        throw new ParentScmLifecycleError("INVALID_REQUEST", `SCM lifecycle ${label} is invalid`);
      }
    }
    this.observer = createScmObserver({
      store: this.store,
      provider: this.provider,
      steering: options.steering,
      actorId: this.actorId,
      now: this.now,
      limits: this.binding.limits,
      maxCasRetries: this.maxCasRetries
    });
  }

  get repositoryBinding(): ScmRepositoryBindingV1 {
    return this.binding;
  }

  async publish(request: ParentScmPublicationRequestV1): Promise<ParentScmPublicationResultV1> {
    return this.advance(request, "pull_request");
  }

  /** Advance only through the remote branch receipt; it never creates a pull request. */
  async publishBranch(request: ParentScmPublicationRequestV1): Promise<ParentScmPublicationResultV1> {
    return this.advance(request, "branch");
  }

  getPublication(publicationId: string): ScmPublicationFact | undefined {
    return this.store.getProjection().scm.publications[publicationId];
  }

  private async advance(
    request: ParentScmPublicationRequestV1,
    target: "branch" | "pull_request"
  ): Promise<ParentScmPublicationResultV1> {
    this.validateRequest(request);
    let publication = this.ensureRecorded(request);
    if (request.signal.aborted) return Object.freeze({ status: "cancelled", publication });

    for (let transition = 0; transition < this.maxTransitions; transition += 1) {
      const projection = this.store.getProjection();
      this.validateTask(projection, request.taskId, request.taskGeneration);
      const current = projection.scm.publications[request.publicationId];
      if (!current) throw new ParentScmLifecycleError("PUBLICATION_CONFLICT", "canonical publication disappeared");
      this.validateExisting(current, request);
      publication = current;
      if (request.signal.aborted) return Object.freeze({ status: "cancelled", publication });
      if (publication.state === "published") {
        if (!publication.pullRequest) throw new ParentScmLifecycleError("PUBLICATION_CONFLICT", "published SCM fact has no pull request");
        return Object.freeze({ status: "published", publication, pullRequest: publication.pullRequest });
      }
      if (publication.state === "refused") {
        return Object.freeze({ status: "refused", publication, reasonCode: publication.reasonCode ?? "PUBLICATION_REFUSED" });
      }
      if (publication.state === "superseded") return Object.freeze({ status: "superseded", publication });

      if (target === "branch" && ["branch_published", "pr_intent", "pr_ambiguous"].includes(publication.state)) {
        if (publication.observedRemoteOid !== publication.intent.integrationOid) {
          throw new ParentScmLifecycleError("PUBLICATION_CONFLICT", "published branch fact lost its immutable OID receipt");
        }
        return Object.freeze({ status: "branch_published", publication, remoteOid: publication.intent.integrationOid });
      }

      if (publication.state === "unpublished" || publication.state === "push_ambiguous") {
        if (!this.transition(projection, publication, "push_intent")) continue;
        continue;
      }
      if (publication.state === "push_intent") {
        let outcome: Awaited<ReturnType<typeof publishScmBranch>>;
        try {
          outcome = await publishScmBranch({
            intent: publication.intent,
            repositoryRoot: this.binding.repositoryRoot,
            expectedPushUrl: this.binding.expectedPushUrl,
            allowFileRemote: this.binding.allowFileRemote,
            signal: request.signal,
            ...(this.gitRunner ? { runner: this.gitRunner } : {})
          });
        } catch (error) {
          if (request.signal.aborted) return Object.freeze({ status: "cancelled", publication });
          const reasonCode = boundedReason(error, "GIT_PUBLICATION_REFUSED");
          if (!this.transition(this.store.getProjection(), publication, "refused", { reasonCode })) continue;
          const refused = this.store.getProjection().scm.publications[publication.publicationId]!;
          return Object.freeze({ status: "refused", publication: refused, reasonCode });
        }
        if (outcome.state === "branch_published") {
          if (!this.transition(this.store.getProjection(), publication, "branch_published", { observedRemoteOid: outcome.observedOid })) continue;
          continue;
        }
        if (outcome.state === "refused") {
          if (!this.transition(this.store.getProjection(), publication, "refused", {
            reasonCode: outcome.reasonCode,
            observedRemoteOid: outcome.observedRemoteOid
          })) continue;
          const refused = this.store.getProjection().scm.publications[publication.publicationId]!;
          return Object.freeze({ status: "refused", publication: refused, reasonCode: outcome.reasonCode });
        }
        if (!this.transition(this.store.getProjection(), publication, "push_ambiguous", {
          reasonCode: outcome.reasonCode,
          ...(outcome.observedRemoteOid === undefined ? {} : { observedRemoteOid: outcome.observedRemoteOid })
        })) continue;
        const ambiguous = this.store.getProjection().scm.publications[publication.publicationId]!;
        return Object.freeze({ status: "ambiguous", publication: ambiguous, reasonCode: outcome.reasonCode });
      }
      if (publication.state === "branch_published") {
        if (target === "branch") {
          return Object.freeze({ status: "branch_published", publication, remoteOid: publication.intent.integrationOid });
        }
        if (!this.transition(projection, publication, "pr_intent")) continue;
        continue;
      }
      if (publication.state === "pr_intent" || publication.state === "pr_ambiguous") {
        const lookup = await this.provider.lookupPullRequests({
          repository: publication.intent.baseRepository,
          headRepository: publication.intent.repository,
          headRef: publication.intent.remoteRef,
          baseRepository: publication.intent.baseRepository,
          baseRef: publication.intent.baseRef,
          limits: this.binding.limits,
          signal: request.signal
        });
        if (request.signal.aborted) return Object.freeze({ status: "cancelled", publication });
        const decision = decidePullRequestRecovery(publication.intent, lookup);
        if (decision.action === "adopt") {
          if (!this.transition(this.store.getProjection(), publication, "published", { pullRequest: decision.pullRequest })) continue;
          continue;
        }
        if (decision.action === "refuse") {
          if (!this.transition(this.store.getProjection(), publication, "refused", { reasonCode: decision.reasonCode })) continue;
          const refused = this.store.getProjection().scm.publications[publication.publicationId]!;
          return Object.freeze({ status: "refused", publication: refused, reasonCode: decision.reasonCode });
        }
        if (decision.action === "wait") {
          const reasonCode = boundedReason({ code: decision.reasonCode }, "PR_LOOKUP_UNCERTAIN");
          if (publication.state === "pr_intent" &&
              !this.transition(this.store.getProjection(), publication, "pr_ambiguous", { reasonCode })) continue;
          const ambiguous = this.store.getProjection().scm.publications[publication.publicationId]!;
          return Object.freeze({ status: "ambiguous", publication: ambiguous, reasonCode });
        }
        if (publication.state === "pr_ambiguous") {
          if (!this.transition(this.store.getProjection(), publication, "pr_intent")) continue;
          continue;
        }
        const created = await this.provider.createPullRequest({
          publicationId: publication.publicationId,
          repository: publication.intent.baseRepository,
          headRepository: publication.intent.repository,
          headRef: publication.intent.remoteRef,
          headSha: publication.intent.integrationOid,
          baseRepository: publication.intent.baseRepository,
          baseRef: publication.intent.baseRef,
          title: request.title,
          body: request.body,
          draft: publication.intent.draft,
          signal: request.signal
        });
        if (request.signal.aborted) return Object.freeze({ status: "cancelled", publication });
        if (created.outcome === "created") {
          if (!this.transition(this.store.getProjection(), publication, "published", { pullRequest: created.pullRequest })) continue;
          continue;
        }
        if (created.outcome === "ambiguous") {
          const reasonCode = "PR_CREATE_AMBIGUOUS";
          if (!this.transition(this.store.getProjection(), publication, "pr_ambiguous", { reasonCode })) continue;
          const ambiguous = this.store.getProjection().scm.publications[publication.publicationId]!;
          return Object.freeze({ status: "ambiguous", publication: ambiguous, reasonCode });
        }
        const reasonCode = boundedReason({ code: created.failure.code }, "PR_CREATE_REFUSED");
        if (!this.transition(this.store.getProjection(), publication, "refused", { reasonCode })) continue;
        const refused = this.store.getProjection().scm.publications[publication.publicationId]!;
        return Object.freeze({ status: "refused", publication: refused, reasonCode });
      }
    }
    return Object.freeze({ status: "transition_bound", publication });
  }

  async poll(request: ParentScmPollRequestV1): Promise<ScmObserverPollResultV1> {
    const projection = this.store.getProjection();
    this.validateTask(projection, request.taskId, request.taskGeneration);
    const publication = projection.scm.publications[request.publicationId];
    if (!publication || publication.taskId !== request.taskId || publication.taskGeneration !== request.taskGeneration ||
        publication.state !== "published" || !publication.pullRequest) {
      throw new ParentScmLifecycleError("TARGET_MISMATCH", "SCM poll requires the exact published task artifact");
    }
    return this.observer.poll({
      publication: aggregateFromFact(publication),
      pullRequest: pullIdentityFromFact(publication.pullRequest),
      taskId: request.taskId,
      taskGeneration: request.taskGeneration,
      sessionId: request.sessionId,
      sessionGeneration: request.sessionGeneration,
      notBeforeAttemptGeneration: request.notBeforeAttemptGeneration,
      signal: request.signal
    });
  }

  private ensureRecorded(request: ParentScmPublicationRequestV1): ScmPublicationFact {
    for (let attempt = 0; attempt < this.maxCasRetries; attempt += 1) {
      const projection = this.store.getProjection();
      this.validateTask(projection, request.taskId, request.taskGeneration);
      const existing = projection.scm.publications[request.publicationId];
      if (existing) {
        this.validateExisting(existing, request);
        return existing;
      }
      const intent = this.intent(request, this.timestamp());
      const event = this.event({
        eventId: this.eventId("publication-recorded", {
          publicationId: intent.publicationId,
          generation: intent.publicationGeneration,
          semanticDigest: scmSemanticDigest(intent)
        }),
        taskId: request.taskId,
        taskGeneration: request.taskGeneration,
        expectedVersion: this.taskVersion(projection, request.taskId, request.taskGeneration),
        type: "scm.publication_recorded",
        payload: { publication: intent }
      });
      try {
        this.store.appendBatchIf({ expectedHeadSeq: projection.headSeq, events: [event] });
      } catch (error) {
        if (isConcurrent(error)) continue;
        throw error;
      }
    }
    throw new ParentScmLifecycleError("PUBLICATION_CONFLICT", "SCM publication admission exceeded its CAS bound");
  }

  private transition(
    projection: ControlProjection,
    captured: ScmPublicationFact,
    toState: ScmPublicationState,
    extra: Readonly<{ observedRemoteOid?: string | null; pullRequest?: ScmPullRequestFactV1; reasonCode?: string }> = {}
  ): boolean {
    const current = projection.scm.publications[captured.publicationId];
    if (!current || current.generation !== captured.generation || current.version !== captured.version || current.state !== captured.state) return false;
    const occurredAt = this.timestamp();
    const event = this.event({
      eventId: this.eventId("publication-state", {
        publicationId: current.publicationId,
        generation: current.generation,
        version: current.version,
        fromState: current.state,
        toState,
        ...extra,
        occurredAt
      }),
      taskId: current.taskId,
      taskGeneration: current.taskGeneration,
      expectedVersion: this.taskVersion(projection, current.taskId, current.taskGeneration),
      occurredAt,
      type: "scm.publication_state_changed",
      payload: {
        publicationId: current.publicationId,
        publicationGeneration: current.generation,
        fromState: current.state,
        toState,
        ...extra
      }
    });
    try {
      this.store.appendBatchIf({ expectedHeadSeq: projection.headSeq, events: [event] });
      return true;
    } catch (error) {
      if (isConcurrent(error)) return false;
      throw error;
    }
  }

  private intent(request: ParentScmPublicationRequestV1, createdAt: string): ScmPublicationIntentV1 {
    return parseScmPublicationIntent({
      schemaVersion: 1,
      publicationId: request.publicationId,
      publicationGeneration: request.publicationGeneration ?? 1,
      attempt: request.attempt ?? 1,
      runId: this.store.runId,
      runEpoch: this.store.runEpoch,
      repository: this.binding.repository,
      integrationRef: request.integrationRef,
      integrationOid: request.integrationOid,
      localExpectedOid: request.localExpectedOid,
      remoteName: request.remoteName,
      remoteRef: request.remoteRef,
      expectedRemote: request.expectedRemote,
      baseRepository: this.binding.baseRepository,
      baseRef: request.baseRef,
      titleSha256: hashText(request.title),
      bodySha256: hashText(request.body),
      draft: request.draft,
      createdAt
    });
  }

  private validateRequest(request: ParentScmPublicationRequestV1): void {
    if (request.repositoryKey !== this.binding.repositoryKey) throw new ParentScmLifecycleError("TARGET_MISMATCH", "SCM repository key is not bound to this lifecycle");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(request.taskId) ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(request.publicationId)) {
      throw new ParentScmLifecycleError("INVALID_REQUEST", "SCM task/publication identity is invalid");
    }
    validatePositive(request.taskGeneration, "task generation");
    validatePositive(request.publicationGeneration ?? 1, "publication generation");
    validatePositive(request.attempt ?? 1, "publication attempt");
    ScmBranchRefSchema.parse(request.integrationRef);
    ScmBranchRefSchema.parse(request.remoteRef);
    ScmBranchRefSchema.parse(request.baseRef);
    ScmObjectIdSchema.parse(request.integrationOid);
    ScmObjectIdSchema.parse(request.localExpectedOid);
    if (request.remoteName !== this.binding.remoteName || request.baseRef !== this.binding.baseRef) {
      throw new ParentScmLifecycleError("TARGET_MISMATCH", "SCM remote/base identity differs from configuration");
    }
    if (request.title.length === 0 || Buffer.byteLength(request.title, "utf8") > 1_024 ||
        Buffer.byteLength(request.body, "utf8") > this.binding.limits.maxEvidenceBodyBytes) {
      throw new ParentScmLifecycleError("INVALID_REQUEST", "SCM pull request metadata exceeds its bound");
    }
    if (request.signal === undefined || typeof request.signal.aborted !== "boolean") {
      throw new ParentScmLifecycleError("INVALID_REQUEST", "SCM publication requires an AbortSignal");
    }
    this.intent(request, "2026-01-01T00:00:00.000Z");
  }

  private validateExisting(publication: ScmPublicationFact, request: ParentScmPublicationRequestV1): void {
    if (publication.taskId !== request.taskId || publication.taskGeneration !== request.taskGeneration ||
        publication.generation !== (request.publicationGeneration ?? 1)) {
      throw new ParentScmLifecycleError("PUBLICATION_CONFLICT", "SCM publication identity was reused for another target");
    }
    const candidate = this.intent(request, publication.intent.createdAt);
    if (canonicalJson(candidate) !== canonicalJson(publication.intent) ||
        !sameScmRepository(candidate.repository, this.binding.repository) ||
        !sameScmRepository(candidate.baseRepository, this.binding.baseRepository)) {
      throw new ParentScmLifecycleError("PUBLICATION_CONFLICT", "SCM publication retry diverges from its canonical intent");
    }
  }

  private validateTask(projection: ControlProjection, taskId: string, generation: number): void {
    if (projection.runId !== this.store.runId || projection.runEpoch !== this.store.runEpoch) {
      throw new ParentScmLifecycleError("RUN_IDENTITY_MISMATCH", "SCM lifecycle store identity changed");
    }
    const task = projection.tasks[taskId];
    if (!task) throw new ParentScmLifecycleError("TARGET_MISMATCH", "SCM lifecycle task does not exist");
    if (task.generation !== generation) throw new ParentScmLifecycleError("STALE_GENERATION", "SCM lifecycle task generation is stale");
  }

  private taskVersion(projection: ControlProjection, taskId: string, generation: number): number {
    return projection.aggregateVersions[`task:${taskId}:${generation}`]?.version ?? 0;
  }

  private event<T extends ControlEvent["type"]>(input: Readonly<{
    eventId: string;
    taskId: string;
    taskGeneration: number;
    expectedVersion: number;
    occurredAt?: string;
    type: T;
    payload: Extract<ControlEvent, { type: T }>["payload"];
  }>): Extract<ControlEvent, { type: T }> {
    return parseControlEvent({
      schemaVersion: 1,
      eventId: input.eventId,
      runId: this.store.runId,
      runEpoch: this.store.runEpoch,
      taskId: input.taskId,
      taskGeneration: input.taskGeneration,
      expectedVersion: input.expectedVersion,
      occurredAt: input.occurredAt ?? this.timestamp(),
      actorKind: "integration",
      actorId: this.actorId,
      sourceKind: null,
      sourceId: null,
      sourceGeneration: null,
      sourceEventId: null,
      type: input.type,
      payload: input.payload
    }) as Extract<ControlEvent, { type: T }>;
  }

  private eventId(kind: string, identity: unknown): string {
    return `scm.${kind}:${scmSemanticDigest(identity)}`;
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new ParentScmLifecycleError("INVALID_REQUEST", "SCM lifecycle clock returned an invalid Date");
    }
    return value.toISOString();
  }
}

export function createParentScmLifecycle(options: ParentScmLifecycleOptions): ParentScmLifecycle {
  return new ParentScmLifecycle(options);
}

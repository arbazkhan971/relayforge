import type { ControlProjection, ScmPublicationFact } from "../control/reducer.js";
import { deriveScmReadiness, type ScmReadinessBlocker } from "./reconcile.js";
import { scmRepositoryKey } from "./schema.js";
import type { ScmRepositoryBindingV1 } from "./product-policy.js";

export const SCM_PRODUCT_VIEW_DEFAULT_LIMIT = 100;
export const SCM_PRODUCT_VIEW_MAX_LIMIT = 1_000;

export type ScmProductReadSource = Readonly<{
  readonly runId: string;
  readonly runEpoch: string;
  getProjection(): ControlProjection;
  head(): { runId: string; runEpoch: string; floorSeq: number; headSeq: number };
}>;

export type ScmProductPublicationViewV1 = Readonly<{
  publicationId: string;
  publicationGeneration: number;
  taskId: string;
  taskGeneration: number;
  repository: string;
  state: ScmPublicationFact["state"];
  integrationOid: string;
  remoteRef: string;
  pullRequest: Readonly<{
    providerId: string;
    number: number;
    url: string;
    lifecycle: "open" | "closed" | "merged";
    draft: boolean;
  }> | null;
  readiness: Readonly<{ ready: boolean; blockers: readonly ScmReadinessBlocker[] }>;
  poll: Readonly<{
    state: "started" | "completed" | "failed";
    attempt: number;
    nextEligibleAt: string | null;
    failureCode: string | null;
    retryable: boolean | null;
  }> | null;
  reactions: Readonly<Record<"pending" | "admitted" | "included" | "resolved" | "refused", number>>;
  updatedSeq: number;
}>;

export type ScmProductControlViewV1 = Readonly<{
  schemaVersion: 1;
  runId: string;
  runEpoch: string;
  viewSeq: number;
  headSeq: number;
  floorSeq: number;
  stale: boolean;
  publications: readonly ScmProductPublicationViewV1[];
  truncated: boolean;
}>;

export type ScmProductDoctorCheckV1 = Readonly<{
  name: string;
  status: "ok" | "warn" | "fail";
  code: string;
  detail: string;
}>;

export class ScmProductViewError extends Error {
  constructor(readonly code: "INVALID_INPUT" | "IDENTITY_MISMATCH" | "INCONSISTENT_SNAPSHOT", message: string) {
    super(`${code}: ${message}`);
    this.name = "ScmProductViewError";
  }
}

function timestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new ScmProductViewError("INVALID_INPUT", "SCM view clock is invalid");
  return value.toISOString();
}

function reactionCounts(projection: ControlProjection, publicationId: string): ScmProductPublicationViewV1["reactions"] {
  const counts = { pending: 0, admitted: 0, included: 0, resolved: 0, refused: 0 };
  for (const reaction of Object.values(projection.scm.reactions)) {
    if (reaction.publicationId !== publicationId) continue;
    if (reaction.state === "pending" || reaction.state === "failed_retryable") counts.pending += 1;
    else if (reaction.state === "command_admitted") counts.admitted += 1;
    else if (reaction.state === "included") counts.included += 1;
    else if (reaction.state === "observation_resolved" || reaction.state === "superseded") counts.resolved += 1;
    else counts.refused += 1;
  }
  return Object.freeze(counts);
}

function latestPoll(projection: ControlProjection, publicationId: string): ScmProductPublicationViewV1["poll"] {
  const poll = Object.values(projection.scm.polls)
    .filter((candidate) => candidate.publicationId === publicationId)
    .sort((left, right) => (right.terminalSeq ?? right.startedSeq) - (left.terminalSeq ?? left.startedSeq))[0];
  if (!poll) return null;
  return Object.freeze({
    state: poll.state,
    attempt: poll.pollAttempt,
    nextEligibleAt: poll.nextEligibleAt ?? null,
    failureCode: poll.failure?.code ?? null,
    retryable: poll.failure?.retryable ?? null
  });
}

export function buildScmProductControlView(input: Readonly<{
  source: ScmProductReadSource;
  now?: () => Date;
  minimumHumanApprovals?: number;
  requireRequiredChecks?: boolean;
  limit?: number;
}>): ScmProductControlViewV1 {
  const limit = input.limit ?? SCM_PRODUCT_VIEW_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SCM_PRODUCT_VIEW_MAX_LIMIT) {
    throw new ScmProductViewError("INVALID_INPUT", "SCM view limit is invalid");
  }
  const minimumHumanApprovals = input.minimumHumanApprovals ?? 1;
  if (!Number.isSafeInteger(minimumHumanApprovals) || minimumHumanApprovals < 0 || minimumHumanApprovals > 100) {
    throw new ScmProductViewError("INVALID_INPUT", "SCM human approval policy is invalid");
  }
  const projection = input.source.getProjection();
  const head = input.source.head();
  if (projection.runId !== input.source.runId || projection.runEpoch !== input.source.runEpoch ||
      head.runId !== input.source.runId || head.runEpoch !== input.source.runEpoch) {
    throw new ScmProductViewError("IDENTITY_MISMATCH", "SCM read source identity is inconsistent");
  }
  if (projection.headSeq > head.headSeq || head.floorSeq > head.headSeq + 1) {
    throw new ScmProductViewError("INCONSISTENT_SNAPSHOT", "SCM view sequence is inconsistent");
  }
  const now = timestamp((input.now ?? (() => new Date()))());
  const ordered = Object.values(projection.scm.publications)
    .sort((left, right) => right.updatedSeq - left.updatedSeq || left.publicationId.localeCompare(right.publicationId));
  const publications = ordered.slice(0, limit).map((publication): ScmProductPublicationViewV1 => {
    const observation = projection.scm.observations[publication.publicationId];
    const currentTaskGeneration = projection.tasks[publication.taskId]?.generation ?? publication.taskGeneration;
    const readiness = deriveScmReadiness({
      now,
      publicationState: publication.state,
      intent: publication.intent,
      expectedPublicationGeneration: publication.generation,
      currentPublicationGeneration: publication.generation,
      expectedTaskGeneration: publication.taskGeneration,
      currentTaskGeneration,
      ...(observation?.buckets.pullRequest ? { pullRequest: observation.buckets.pullRequest } : {}),
      ...(observation?.buckets.ci ? { ci: observation.buckets.ci } : {}),
      ...(observation?.buckets.review ? { review: observation.buckets.review } : {}),
      ...(observation?.buckets.mergeability ? { mergeability: observation.buckets.mergeability } : {}),
      policy: { minimumHumanApprovals, requireRequiredChecks: input.requireRequiredChecks ?? true }
    });
    return Object.freeze({
      publicationId: publication.publicationId,
      publicationGeneration: publication.generation,
      taskId: publication.taskId,
      taskGeneration: publication.taskGeneration,
      repository: scmRepositoryKey(publication.intent.repository),
      state: publication.state,
      integrationOid: publication.intent.integrationOid,
      remoteRef: publication.intent.remoteRef,
      pullRequest: publication.pullRequest
        ? Object.freeze({
            providerId: publication.pullRequest.providerId,
            number: publication.pullRequest.number,
            url: publication.pullRequest.url,
            lifecycle: publication.pullRequest.lifecycle,
            draft: publication.pullRequest.draft
          })
        : null,
      readiness,
      poll: latestPoll(projection, publication.publicationId),
      reactions: reactionCounts(projection, publication.publicationId),
      updatedSeq: publication.updatedSeq
    });
  });
  return Object.freeze({
    schemaVersion: 1,
    runId: projection.runId,
    runEpoch: projection.runEpoch,
    viewSeq: projection.headSeq,
    headSeq: head.headSeq,
    floorSeq: head.floorSeq,
    stale: projection.headSeq < head.headSeq,
    publications: Object.freeze(publications),
    truncated: ordered.length > publications.length
  });
}

/** Offline, side-effect-free doctor facts; credential bytes and provider payload text never enter the DTO. */
export function buildScmProductDoctorChecks(input: Readonly<{
  binding?: ScmRepositoryBindingV1;
  view?: ScmProductControlViewV1;
}>): readonly ScmProductDoctorCheckV1[] {
  if (!input.binding) {
    return Object.freeze([{ name: "scm-config", status: "warn", code: "SCM_NOT_CONFIGURED", detail: "No canonical SCM repository binding is configured." }]);
  }
  const checks: ScmProductDoctorCheckV1[] = [{
    name: "scm-config",
    status: "ok",
    code: "SCM_CONFIGURED",
    detail: `SCM repository ${scmRepositoryKey(input.binding.repository)} is bound to one canonical local root and remote.`
  }];
  if (!input.view) {
    checks.push({ name: "scm-history", status: "warn", code: "SCM_HISTORY_UNAVAILABLE", detail: "Canonical SCM history is unavailable to this read-only doctor invocation." });
    return Object.freeze(checks);
  }
  const blocked = input.view.publications.filter((publication) => publication.state === "refused").length;
  const uncertain = input.view.publications.filter((publication) => publication.state === "push_ambiguous" || publication.state === "pr_ambiguous").length;
  checks.push(blocked > 0
    ? { name: "scm-history", status: "fail", code: "SCM_PUBLICATION_REFUSED", detail: `${blocked} canonical SCM publication(s) require operator review.` }
    : uncertain > 0
      ? { name: "scm-history", status: "warn", code: "SCM_PUBLICATION_AMBIGUOUS", detail: `${uncertain} canonical SCM publication(s) are awaiting bounded reconciliation.` }
      : { name: "scm-history", status: "ok", code: "SCM_HISTORY_OK", detail: `${input.view.publications.length} bounded SCM publication projection(s) were read.` });
  return Object.freeze(checks);
}

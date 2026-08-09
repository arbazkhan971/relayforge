import { createHash } from "node:crypto";
import type {
  MultiRepoPublicationAdapter,
  MultiRepoPublicationEntryPlanV1,
  PublicationEffectResult
} from "../multirepo/publication.js";
import { isValidScmBranchRef, scmSemanticDigest } from "./schema.js";
import type { ParentScmLifecycle } from "./lifecycle.js";
import type { ScmRepositoryBindingV1 } from "./product-policy.js";

export type ScmMultiRepoPublicationContextV1 = Readonly<{
  lifecycle: ParentScmLifecycle;
  binding: ScmRepositoryBindingV1;
  taskId: string;
  taskGeneration: number;
  signal: AbortSignal;
  draft?: boolean;
}>;

export type ScmMultiRepoCrossLinkRequestV1 = Readonly<{
  entry: MultiRepoPublicationEntryPlanV1;
  publication: NonNullable<ReturnType<ParentScmLifecycle["getPublication"]>>;
  binding: ScmRepositoryBindingV1;
  artifacts: readonly Readonly<{ repositoryId: string; artifactId: string; url: string }>[];
  signal: AbortSignal;
}>;

/** Provider-specific cross-link mutation remains a separate parent-held capability. */
export interface ScmMultiRepoCrossLinkWriterV1 {
  ensureCrossLinks(request: ScmMultiRepoCrossLinkRequestV1): Promise<PublicationEffectResult<Readonly<{ digest: string }>>>;
}

export type ScmMultiRepoPublicationBridgeOptions = Readonly<{
  contexts: Readonly<Record<string, ScmMultiRepoPublicationContextV1>>;
  crossLinkWriter?: ScmMultiRepoCrossLinkWriterV1;
}>;

export class ScmMultiRepoPublicationBridgeError extends Error {
  constructor(readonly code: "INVALID_CONTEXT" | "PLAN_MISMATCH", message: string) {
    super(`${code}: ${message}`);
    this.name = "ScmMultiRepoPublicationBridgeError";
  }
}

const SHA = /^[a-f0-9]{64}$/u;

function code(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9_]/gu, "_").slice(0, 128) || "SCM_PUBLICATION_FAILED";
}

function canonicalRef(value: string): string {
  const candidate = value.startsWith("refs/heads/") ? value : `refs/heads/${value}`;
  if (!isValidScmBranchRef(candidate)) throw new ScmMultiRepoPublicationBridgeError("PLAN_MISMATCH", "multi-repository branch is not canonical");
  return candidate;
}

function effectFailure(
  status: "ambiguous" | "refused" | "superseded" | "cancelled" | "transition_bound",
  reason?: string
): PublicationEffectResult<never> {
  if (status === "ambiguous" || status === "cancelled") return Object.freeze({ state: "retry", code: code(reason ?? status) });
  return Object.freeze({ state: "recovery_required", code: code(reason ?? status) });
}

/**
 * Bridges P6's per-repository saga to P3's canonical, recoverable parent lifecycle. No child gets a
 * store, provider credential, Git runner, or cross-link writer through this adapter.
 */
export class ScmMultiRepoPublicationBridge implements MultiRepoPublicationAdapter {
  private readonly contexts: Readonly<Record<string, ScmMultiRepoPublicationContextV1>>;
  private readonly crossLinkWriter?: ScmMultiRepoCrossLinkWriterV1;

  constructor(options: ScmMultiRepoPublicationBridgeOptions) {
    const entries = Object.entries(options.contexts);
    if (entries.length === 0 || entries.length > 32) throw new ScmMultiRepoPublicationBridgeError("INVALID_CONTEXT", "SCM bridge requires one bounded context map");
    for (const [repositoryId, context] of entries) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(repositoryId) ||
          context.lifecycle.repositoryBinding !== context.binding ||
          !Number.isSafeInteger(context.taskGeneration) || context.taskGeneration < 1 ||
          typeof context.signal?.aborted !== "boolean") {
        throw new ScmMultiRepoPublicationBridgeError("INVALID_CONTEXT", `SCM bridge context ${repositoryId} is invalid`);
      }
    }
    this.contexts = Object.freeze(Object.fromEntries(entries));
    this.crossLinkWriter = options.crossLinkWriter;
  }

  async publishBranch(plan: MultiRepoPublicationEntryPlanV1): Promise<PublicationEffectResult<Readonly<{ remoteOid: string }>>> {
    const context = this.context(plan);
    const result = await context.lifecycle.publishBranch(this.request(plan, context));
    if (result.status === "branch_published" || result.status === "published") {
      return Object.freeze({
        state: "completed",
        value: Object.freeze({ remoteOid: plan.candidateOid }),
        completedBy: "reconciled"
      });
    }
    return effectFailure(result.status, "reasonCode" in result ? result.reasonCode : undefined);
  }

  async ensurePullRequest(plan: MultiRepoPublicationEntryPlanV1): Promise<PublicationEffectResult<Readonly<{ artifactId: string; url: string }>>> {
    const context = this.context(plan);
    const result = await context.lifecycle.publish(this.request(plan, context));
    if (result.status === "published") {
      return Object.freeze({
        state: "completed",
        value: Object.freeze({ artifactId: result.pullRequest.providerId, url: result.pullRequest.url }),
        completedBy: "reconciled"
      });
    }
    if (result.status === "branch_published") return Object.freeze({ state: "retry", code: "SCM_PR_NOT_RECONCILED" });
    return effectFailure(result.status, "reasonCode" in result ? result.reasonCode : undefined);
  }

  async ensureCrossLinks(input: Readonly<{
    entry: MultiRepoPublicationEntryPlanV1;
    artifacts: readonly Readonly<{ repositoryId: string; artifactId: string; url: string }>[];
  }>): Promise<PublicationEffectResult<Readonly<{ digest: string }>>> {
    const context = this.context(input.entry);
    if (!this.crossLinkWriter) return Object.freeze({ state: "recovery_required", code: "SCM_CROSSLINK_CAPABILITY_MISSING" });
    const publication = context.lifecycle.getPublication(input.entry.publicationId);
    if (!publication || publication.state !== "published" || !publication.pullRequest) {
      return Object.freeze({ state: "retry", code: "SCM_PR_NOT_CANONICAL" });
    }
    const artifacts = Object.freeze([...input.artifacts]
      .map((artifact) => Object.freeze({ ...artifact }))
      .sort((left, right) => left.repositoryId.localeCompare(right.repositoryId)));
    if (new Set(artifacts.map((artifact) => artifact.repositoryId)).size !== artifacts.length || artifacts.length < 1 || artifacts.length > 32) {
      throw new ScmMultiRepoPublicationBridgeError("PLAN_MISMATCH", "SCM cross-link artifact vector is invalid");
    }
    const result = await this.crossLinkWriter.ensureCrossLinks({
      entry: input.entry,
      publication,
      binding: context.binding,
      artifacts,
      signal: context.signal
    });
    if (result.state === "completed" && !SHA.test(result.value.digest)) {
      throw new ScmMultiRepoPublicationBridgeError("PLAN_MISMATCH", "SCM cross-link receipt digest is invalid");
    }
    return result;
  }

  private context(plan: MultiRepoPublicationEntryPlanV1): ScmMultiRepoPublicationContextV1 {
    const context = this.contexts[plan.repositoryId];
    if (!context) throw new ScmMultiRepoPublicationBridgeError("PLAN_MISMATCH", `SCM publication has no bound repository ${plan.repositoryId}`);
    if (plan.remoteName !== context.binding.remoteName || plan.expectedPushUrl !== context.binding.expectedPushUrl ||
        canonicalRef(plan.baseRef) !== context.binding.baseRef) {
      throw new ScmMultiRepoPublicationBridgeError("PLAN_MISMATCH", "SCM publication plan differs from the configured remote identity");
    }
    return context;
  }

  private request(plan: MultiRepoPublicationEntryPlanV1, context: ScmMultiRepoPublicationContextV1) {
    return Object.freeze({
      taskId: context.taskId,
      taskGeneration: context.taskGeneration,
      repositoryKey: context.binding.repositoryKey,
      publicationId: plan.publicationId,
      publicationGeneration: 1,
      attempt: 1,
      integrationRef: canonicalRef(plan.localIntegrationRef),
      integrationOid: plan.candidateOid,
      localExpectedOid: plan.candidateOid,
      remoteName: plan.remoteName,
      remoteRef: canonicalRef(plan.remoteRef),
      expectedRemote: plan.expectedRemoteOid === null
        ? Object.freeze({ kind: "absent" as const })
        : Object.freeze({ kind: "oid" as const, oid: plan.expectedRemoteOid }),
      baseRef: canonicalRef(plan.baseRef),
      title: plan.title,
      body: plan.body,
      draft: context.draft ?? false,
      signal: context.signal
    });
  }
}

export function createScmMultiRepoPublicationBridge(options: ScmMultiRepoPublicationBridgeOptions): ScmMultiRepoPublicationBridge {
  return new ScmMultiRepoPublicationBridge(options);
}

/** A no-write cross-link capability is valid only when every canonical artifact URL is already in the planned body. */
export function createExistingBodyCrossLinkWriter(): ScmMultiRepoCrossLinkWriterV1 {
  const writer: ScmMultiRepoCrossLinkWriterV1 = {
    async ensureCrossLinks(request: ScmMultiRepoCrossLinkRequestV1) {
      if (request.signal.aborted) return Object.freeze({ state: "retry" as const, code: "SCM_CROSSLINK_CANCELLED" });
      if (request.artifacts.some((artifact) => !request.entry.body.includes(artifact.url))) {
        return Object.freeze({ state: "recovery_required" as const, code: "SCM_CROSSLINK_NOT_PRESENT" });
      }
      const digest = createHash("sha256").update(scmSemanticDigest({
        publicationId: request.entry.publicationId,
        pullRequest: request.publication.pullRequest,
        artifacts: request.artifacts
      }), "utf8").digest("hex");
      return Object.freeze({ state: "completed" as const, value: Object.freeze({ digest }), completedBy: "existing" as const });
    }
  };
  return Object.freeze(writer);
}

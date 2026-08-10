import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../control/events.js";
import {
  SCM_PROVIDER_LIMITS,
  scmEvidenceKinds,
  scmReviewDecisions,
  type ScmCiFactV1,
  type ScmCompleteness,
  type ScmEvidenceKind,
  type ScmEvidenceV1,
  type ScmNormalizedCheckV1,
  type ScmReviewDecision,
  type ScmReviewFactV1
} from "./types.js";
import {
  ScmBoundedIdSchema,
  ScmCanonicalTimestampSchema,
  ScmObjectIdSchema,
  ScmPositiveIntegerSchema,
  parseScmCiFact,
  parseScmReviewFact,
  scmSemanticDigest
} from "./schema.js";

export type NormalizedExternalText = Readonly<{
  text: string;
  sha256: string;
  originalBytes: number;
  retainedBytes: number;
  truncated: boolean;
  sanitized: boolean;
}>;

function isUnsafeScalar(codePoint: number): boolean {
  return (
    (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a) ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    (codePoint >= 0xfdd0 && codePoint <= 0xfdef) ||
    (codePoint & 0xffff) === 0xfffe ||
    (codePoint & 0xffff) === 0xffff
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Normalize untrusted provider prose without ever interpreting it as a command. */
export function normalizeExternalText(value: string, maximumBytes = SCM_PROVIDER_LIMITS.maxEvidenceBodyBytes): NormalizedExternalText {
  if (typeof value !== "string") throw new TypeError("external evidence body must be a string");
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > SCM_PROVIDER_LIMITS.maxEvidenceBodyBytes) {
    throw new RangeError(`external evidence byte ceiling must be between 0 and ${SCM_PROVIDER_LIMITS.maxEvidenceBodyBytes}`);
  }
  const originalBytes = Buffer.byteLength(value, "utf8");
  const newlineNormalized = value.replace(/\r\n?/gu, "\n").replace(/[\u2028\u2029]/gu, "\n");
  let sanitized = newlineNormalized !== value;
  let safe = "";
  for (let index = 0; index < newlineNormalized.length;) {
    const codePoint = newlineNormalized.codePointAt(index)!;
    const scalar = String.fromCodePoint(codePoint);
    if (isUnsafeScalar(codePoint)) {
      safe += "\uFFFD";
      sanitized = true;
    } else {
      safe += scalar;
    }
    index += codePoint > 0xffff ? 2 : 1;
  }
  const normalized = safe.normalize("NFC");
  if (normalized !== safe) sanitized = true;

  let retained = "";
  let retainedBytes = 0;
  for (const scalar of normalized) {
    const bytes = Buffer.byteLength(scalar, "utf8");
    if (retainedBytes + bytes > maximumBytes) break;
    retained += scalar;
    retainedBytes += bytes;
  }
  const normalizedBytes = Buffer.byteLength(normalized, "utf8");
  return Object.freeze({
    text: retained,
    sha256: sha256(retained),
    originalBytes,
    retainedBytes,
    truncated: retainedBytes < normalizedBytes,
    sanitized
  });
}

export type RawScmCheckV1 = Readonly<{
  source: "check_run" | "status_context";
  providerCheckId: string;
  providerRunId: string;
  context?: string;
  name: string;
  workflow?: string;
  event?: string;
  required: boolean;
  status: string;
  conclusion?: string | null;
  attempt: number;
  startedAt: string;
  completedAt?: string;
  url?: string;
  detail?: string;
}>;

const boundedProviderState = z.string().min(1).max(128);
const rawCheckSchema = z.strictObject({
  source: z.enum(["check_run", "status_context"]),
  providerCheckId: ScmBoundedIdSchema,
  providerRunId: ScmBoundedIdSchema,
  context: z.string().min(1).max(512).optional(),
  name: z.string().min(1).max(512),
  workflow: z.string().min(1).max(512).optional(),
  event: z.string().min(1).max(128).optional(),
  required: z.boolean(),
  status: boundedProviderState,
  conclusion: boundedProviderState.nullish(),
  attempt: ScmPositiveIntegerSchema,
  startedAt: ScmCanonicalTimestampSchema,
  completedAt: ScmCanonicalTimestampSchema.optional(),
  url: z.string().url().max(4_096).optional(),
  detail: z.string().max(16_384).optional()
});

function checkKey(check: RawScmCheckV1): string {
  return scmSemanticDigest(check.context === undefined
    ? { schemaVersion: 1, source: check.source, name: check.name, workflow: check.workflow ?? null, event: check.event ?? null }
    : { schemaVersion: 1, source: check.source, context: check.context });
}

export function classifyProviderCheck(statusInput: string, conclusionInput?: string | null): ScmNormalizedCheckV1["bucket"] {
  const status = statusInput.trim().toLowerCase();
  const conclusion = conclusionInput?.trim().toLowerCase();
  if (["queued", "pending", "in_progress", "requested", "waiting", "expected"].includes(status)) return "pending";
  if (status === "success") return "passing";
  if (["failure", "error"].includes(status)) return "failing";
  if (status !== "completed") return "unknown";
  if (conclusion === "success") return "passing";
  if (["failure", "timed_out", "action_required", "startup_failure", "stale"].includes(conclusion ?? "")) return "failing";
  if (conclusion === "cancelled") return "cancelled";
  if (["neutral", "skipped"].includes(conclusion ?? "")) return "skipping";
  return "unknown";
}

function normalizedCheck(value: unknown): ScmNormalizedCheckV1 {
  const check = rawCheckSchema.parse(value) as RawScmCheckV1;
  const detail = check.detail === undefined ? undefined : normalizeExternalText(check.detail, 4_096).text;
  return Object.freeze({
    key: checkKey(check),
    providerCheckId: check.providerCheckId,
    providerRunId: check.providerRunId,
    name: check.name,
    ...(check.workflow ? { workflow: check.workflow } : {}),
    ...(check.event ? { event: check.event } : {}),
    required: check.required,
    bucket: classifyProviderCheck(check.status, check.conclusion),
    status: check.status.trim().toLowerCase(),
    ...(check.conclusion ? { conclusion: check.conclusion.trim().toLowerCase() } : {}),
    attempt: check.attempt,
    startedAt: check.startedAt,
    ...(check.completedAt ? { completedAt: check.completedAt } : {}),
    ...(check.url ? { url: check.url } : {}),
    ...(detail === undefined ? {} : { detail })
  });
}

function recencyTuple(check: ScmNormalizedCheckV1): readonly [number, number, number] {
  return [Date.parse(check.startedAt), check.attempt, check.completedAt ? Date.parse(check.completedAt) : -1];
}

function compareRecency(left: ScmNormalizedCheckV1, right: ScmNormalizedCheckV1): number {
  const a = recencyTuple(left);
  const b = recencyTuple(right);
  return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
}

function sameRecency(left: ScmNormalizedCheckV1, right: ScmNormalizedCheckV1): boolean {
  return compareRecency(left, right) === 0;
}

function checkOutcomeValue(check: ScmNormalizedCheckV1): unknown {
  return {
    key: check.key,
    required: check.required,
    bucket: check.bucket,
    status: check.status,
    conclusion: check.conclusion ?? null,
    attempt: check.attempt,
    startedAt: check.startedAt,
    completedAt: check.completedAt ?? null
  };
}

export type NormalizedCiWindow = Readonly<{
  facts: ScmCiFactV1;
  completeness: ScmCompleteness;
  semanticHash: string;
}>;

function buildCiWindow(
  checksInput: readonly ScmNormalizedCheckV1[],
  conflictsInput: readonly string[],
  completeness: ScmCompleteness
): NormalizedCiWindow {
  const checks = [...checksInput].sort((left, right) => left.key.localeCompare(right.key));
  const conflicts = [...new Set(conflictsInput)].sort();
  const required = checks.filter((check) => check.required);
  const failing = required.filter((check) => check.bucket === "failing" || check.bucket === "cancelled");
  const pending = required.filter((check) => check.bucket === "pending");
  const indeterminate = required.filter((check) => check.bucket === "unknown" || check.bucket === "skipping");
  const state: ScmCiFactV1["state"] = failing.length > 0
    ? "failing"
    : pending.length > 0
      ? "pending"
      : completeness === "partial" || indeterminate.length > 0
        ? "unknown"
        : "passing";
  const failureFingerprint = failing.length === 0 ? undefined : scmSemanticDigest(failing.map((check) => ({
    key: check.key,
    providerRunId: check.providerRunId,
    bucket: check.bucket,
    conclusion: check.conclusion ?? null
  })));
  const facts = parseScmCiFact({
    state,
    checks,
    requiredCheckCount: required.length,
    ...(failureFingerprint ? { failureFingerprint } : {}),
    conflicts
  });
  return Object.freeze({ facts, completeness, semanticHash: scmSemanticDigest(facts) });
}

/** Dedupe reruns deterministically. An equal-recency divergent tie degrades that check to unknown. */
export function normalizeCheckWindow(values: readonly unknown[], completeness: ScmCompleteness): NormalizedCiWindow {
  if (values.length > SCM_PROVIDER_LIMITS.maxItemsPerEndpoint) {
    throw new RangeError(`check window exceeds ${SCM_PROVIDER_LIMITS.maxItemsPerEndpoint} items`);
  }
  const groups = new Map<string, ScmNormalizedCheckV1[]>();
  for (const value of values) {
    const check = normalizedCheck(value);
    const group = groups.get(check.key) ?? [];
    group.push(check);
    groups.set(check.key, group);
  }

  const checks: ScmNormalizedCheckV1[] = [];
  const conflicts: string[] = [];
  for (const [key, group] of groups) {
    group.sort((left, right) => compareRecency(left, right) || left.providerRunId.localeCompare(right.providerRunId) || left.providerCheckId.localeCompare(right.providerCheckId));
    const newest = group[0]!;
    const tied = group.filter((candidate) => sameRecency(candidate, newest));
    const outcomes = new Set(tied.map((candidate) => scmSemanticDigest(checkOutcomeValue(candidate))));
    if (outcomes.size > 1) {
      conflicts.push(key);
      checks.push(Object.freeze({ ...newest, bucket: "unknown", status: "ambiguous_equal_recency" }));
    } else {
      checks.push(newest);
    }
  }
  return buildCiWindow(checks, conflicts, completeness);
}

/** Merge a partial checks window without treating omitted contexts as resolved or passing. */
export function mergePartialCiFacts(previousValue: unknown, partialValue: unknown): NormalizedCiWindow {
  const previous = parseScmCiFact(previousValue);
  const partial = parseScmCiFact(partialValue);
  const byKey = new Map(previous.checks.map((check) => [check.key, check]));
  const conflicts = new Set([...previous.conflicts, ...partial.conflicts]);
  for (const candidate of partial.checks) {
    const prior = byKey.get(candidate.key);
    if (!prior) {
      byKey.set(candidate.key, candidate);
      continue;
    }
    const recency = compareRecency(candidate, prior);
    if (recency < 0) {
      byKey.set(candidate.key, candidate);
    } else if (recency === 0 && scmSemanticDigest(checkOutcomeValue(candidate)) !== scmSemanticDigest(checkOutcomeValue(prior))) {
      conflicts.add(candidate.key);
      const chosen = [candidate, prior].sort((left, right) => left.providerRunId.localeCompare(right.providerRunId) || left.providerCheckId.localeCompare(right.providerCheckId))[0]!;
      byKey.set(candidate.key, Object.freeze({ ...chosen, bucket: "unknown", status: "ambiguous_equal_recency" }));
    }
  }
  return buildCiWindow([...byKey.values()], [...conflicts], "partial");
}

export type RawScmEvidenceV1 = Readonly<{
  providerEvidenceId: string;
  kind: ScmEvidenceKind;
  authorKind: "human" | "bot" | "unknown";
  authorId: string;
  createdAt: string;
  updatedAt: string;
  resolved: boolean;
  selected: boolean;
  body: string;
  url?: string;
}>;

const rawEvidenceSchema = z.strictObject({
  providerEvidenceId: ScmBoundedIdSchema,
  kind: z.enum(scmEvidenceKinds),
  authorKind: z.enum(["human", "bot", "unknown"]),
  authorId: ScmBoundedIdSchema,
  createdAt: ScmCanonicalTimestampSchema,
  updatedAt: ScmCanonicalTimestampSchema,
  resolved: z.boolean(),
  selected: z.boolean(),
  body: z.string(),
  url: z.string().url().max(4_096).optional()
}).superRefine((evidence, context) => {
  if (Date.parse(evidence.updatedAt) < Date.parse(evidence.createdAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["updatedAt"], message: "evidence update precedes creation" });
  }
});

export type ScmEvidenceScopeV1 = Readonly<{
  repositoryKey: string;
  pullRequestNumber: number;
  headSha: string;
}>;

function normalizeEvidence(scope: ScmEvidenceScopeV1, value: unknown): ScmEvidenceV1 {
  const raw = rawEvidenceSchema.parse(value) as RawScmEvidenceV1;
  const body = normalizeExternalText(raw.body);
  const evidenceId = scmSemanticDigest({
    schemaVersion: 1,
    repositoryKey: scope.repositoryKey,
    pullRequestNumber: scope.pullRequestNumber,
    headSha: scope.headSha,
    kind: raw.kind,
    providerEvidenceId: raw.providerEvidenceId,
    updatedAt: raw.updatedAt,
    bodySha256: body.sha256
  });
  return Object.freeze({
    evidenceId,
    providerEvidenceId: raw.providerEvidenceId,
    kind: raw.kind,
    authorKind: raw.authorKind,
    authorId: raw.authorId,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    resolved: raw.resolved,
    selected: raw.selected,
    body: body.text,
    bodySha256: body.sha256,
    originalBytes: body.originalBytes,
    retainedBytes: body.retainedBytes,
    truncated: body.truncated,
    sanitized: body.sanitized,
    ...(raw.url ? { url: raw.url } : {})
  });
}

export type NormalizedReviewWindow = Readonly<{
  facts: ScmReviewFactV1;
  completeness: ScmCompleteness;
  semanticHash: string;
  omitted: number;
}>;

export function normalizeReviewWindow(input: Readonly<{
  scope: ScmEvidenceScopeV1;
  decision: ScmReviewDecision;
  humanApprovals: number;
  evidence: readonly unknown[];
  completeness: ScmCompleteness;
}>): NormalizedReviewWindow {
  z.enum(scmReviewDecisions).parse(input.decision);
  z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(input.humanApprovals);
  if (input.evidence.length > SCM_PROVIDER_LIMITS.maxItemsPerEndpoint) {
    throw new RangeError(`review window exceeds ${SCM_PROVIDER_LIMITS.maxItemsPerEndpoint} items`);
  }
  const grouped = new Map<string, ScmEvidenceV1[]>();
  for (const value of input.evidence) {
    const normalized = normalizeEvidence(input.scope, value);
    const stableKey = `${normalized.kind}:${normalized.providerEvidenceId}`;
    const group = grouped.get(stableKey) ?? [];
    group.push(normalized);
    grouped.set(stableKey, group);
  }

  const selected: ScmEvidenceV1[] = [];
  const conflicts: string[] = [];
  for (const [stableKey, group] of grouped) {
    group.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.evidenceId.localeCompare(right.evidenceId));
    const newest = group[0]!;
    const tied = group.filter((candidate) => candidate.updatedAt === newest.updatedAt);
    if (new Set(tied.map((candidate) => candidate.evidenceId)).size > 1) conflicts.push(scmSemanticDigest(stableKey));
    selected.push(newest);
  }
  selected.sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
  conflicts.sort();

  const retentionOrder = [...selected].sort((left, right) => {
    const leftPriority = left.selected && !left.resolved && left.authorKind === "human" ? 0 : 1;
    const rightPriority = right.selected && !right.resolved && right.authorKind === "human" ? 0 : 1;
    return leftPriority - rightPriority || left.evidenceId.localeCompare(right.evidenceId);
  });
  const retained: ScmEvidenceV1[] = [];
  let retainedBytes = 0;
  let omitted = 0;
  for (const evidence of retentionOrder) {
    if (retainedBytes + evidence.retainedBytes > SCM_PROVIDER_LIMITS.maxEvidencePreviewBytes) {
      omitted += 1;
      continue;
    }
    retained.push(evidence);
    retainedBytes += evidence.retainedBytes;
  }
  retained.sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
  const effectiveCompleteness: ScmCompleteness = input.completeness === "partial" || conflicts.length > 0 || omitted > 0
    ? "partial"
    : "complete";
  const unresolvedSelectedEvidenceIds = retained
    .filter((evidence) => evidence.selected && !evidence.resolved && evidence.authorKind === "human")
    .map((evidence) => evidence.evidenceId)
    .sort();
  const facts = parseScmReviewFact({
    decision: input.decision,
    humanApprovals: input.humanApprovals,
    evidence: retained,
    unresolvedSelectedEvidenceIds,
    conflicts
  });
  return Object.freeze({ facts, completeness: effectiveCompleteness, semanticHash: scmSemanticDigest(facts), omitted });
}

/** Merge a partial review window by provider-stable IDs; absence never resolves prior feedback. */
export function mergePartialReviewFacts(previousValue: unknown, partialValue: unknown): NormalizedReviewWindow {
  const previous = parseScmReviewFact(previousValue);
  const partial = parseScmReviewFact(partialValue);
  const stableKey = (evidence: ScmEvidenceV1) => `${evidence.kind}:${evidence.providerEvidenceId}`;
  const byKey = new Map(previous.evidence.map((evidence) => [stableKey(evidence), evidence]));
  const conflicts = new Set([...previous.conflicts, ...partial.conflicts]);
  for (const candidate of partial.evidence) {
    const key = stableKey(candidate);
    const prior = byKey.get(key);
    if (!prior || Date.parse(candidate.updatedAt) > Date.parse(prior.updatedAt)) {
      byKey.set(key, candidate);
    } else if (candidate.updatedAt === prior.updatedAt && candidate.evidenceId !== prior.evidenceId) {
      conflicts.add(scmSemanticDigest(key));
      byKey.set(key, [candidate, prior].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId))[0]!);
    }
  }
  const evidence = [...byKey.values()].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
  const unresolvedSelectedEvidenceIds = evidence
    .filter((item) => item.selected && !item.resolved && item.authorKind === "human")
    .map((item) => item.evidenceId)
    .sort();
  const decision: ScmReviewDecision = previous.decision === "changes_requested" || partial.decision === "changes_requested"
    ? "changes_requested"
    : previous.decision;
  const facts = parseScmReviewFact({
    decision,
    humanApprovals: Math.max(previous.humanApprovals, partial.humanApprovals),
    evidence,
    unresolvedSelectedEvidenceIds,
    conflicts: [...conflicts].sort()
  });
  return Object.freeze({ facts, completeness: "partial", semanticHash: scmSemanticDigest(facts), omitted: 0 });
}

export function evidenceReactionKey(input: Readonly<{
  repositoryKey: string;
  pullRequestNumber: number;
  headSha: string;
  factKind: "ci" | "review" | "mergeability";
  evidenceIds: readonly string[];
}>): string {
  if (!Number.isSafeInteger(input.pullRequestNumber) || input.pullRequestNumber < 1) throw new TypeError("pull request number is invalid");
  ScmObjectIdSchema.parse(input.headSha);
  z.enum(["ci", "review", "mergeability"]).parse(input.factKind);
  if (!/^[a-z]+:[a-z0-9.-]+\/[a-z0-9._-]+\/[a-z0-9._-]+$/u.test(input.repositoryKey) || input.repositoryKey.length > 512) {
    throw new TypeError("reaction repository key is invalid");
  }
  const ids = [...new Set(input.evidenceIds)].sort();
  if (ids.length === 0 || ids.some((id) => !/^[a-f0-9]{64}$/u.test(id))) throw new TypeError("reaction requires canonical evidence digests");
  return sha256(canonicalJson({
    schemaVersion: 1,
    repositoryKey: input.repositoryKey,
    pullRequestNumber: input.pullRequestNumber,
    headSha: input.headSha,
    factKind: input.factKind,
    evidenceIds: ids
  }));
}

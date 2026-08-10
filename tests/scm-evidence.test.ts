import { describe, expect, it } from "vitest";
import {
  classifyProviderCheck,
  evidenceReactionKey,
  mergePartialCiFacts,
  mergePartialReviewFacts,
  normalizeCheckWindow,
  normalizeExternalText,
  normalizeReviewWindow,
  type RawScmCheckV1,
  type RawScmEvidenceV1
} from "../src/scm/evidence.js";
import { SCM_PROVIDER_LIMITS } from "../src/scm/types.js";
import { parseScmEvidence } from "../src/scm/schema.js";

const HEAD = "a".repeat(40);
const START = "2026-08-09T12:00:00.000Z";
const LATER = "2026-08-09T12:01:00.000Z";

function check(overrides: Partial<RawScmCheckV1> = {}): RawScmCheckV1 {
  return {
    source: "check_run",
    providerCheckId: "check-1",
    providerRunId: "run-1",
    name: "unit",
    workflow: "ci",
    event: "pull_request",
    required: true,
    status: "completed",
    conclusion: "success",
    attempt: 1,
    startedAt: START,
    completedAt: LATER,
    ...overrides
  };
}

function evidence(id: string, overrides: Partial<RawScmEvidenceV1> = {}): RawScmEvidenceV1 {
  return {
    providerEvidenceId: id,
    kind: "inline_comment",
    authorKind: "human",
    authorId: "reviewer",
    createdAt: START,
    updatedAt: START,
    resolved: false,
    selected: true,
    body: `feedback ${id}`,
    ...overrides
  };
}

const scope = { repositoryKey: "github:github.example.com/org/repo", pullRequestNumber: 7, headSha: HEAD };

describe("P3 deterministic SCM evidence normalization", () => {
  it("normalizes line endings/Unicode and strips terminal and bidi control authority", () => {
    const normalized = normalizeExternalText("Cafe\u0301\r\n\u001b[31mred\u202e");
    expect(normalized.text).toBe("Café\n�[31mred�");
    expect(normalized.sanitized).toBe(true);
    expect(normalized.truncated).toBe(false);
    expect(normalized.retainedBytes).toBe(Buffer.byteLength(normalized.text));
    expect(normalized.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("enforces exact UTF-8 byte ceilings without splitting a scalar", () => {
    expect(normalizeExternalText("abc", 3)).toMatchObject({ text: "abc", retainedBytes: 3, truncated: false });
    expect(normalizeExternalText("abcd", 3)).toMatchObject({ text: "abc", retainedBytes: 3, truncated: true });
    expect(normalizeExternalText("é", 1)).toMatchObject({ text: "", retainedBytes: 0, truncated: true });
    expect(() => normalizeExternalText("x", SCM_PROVIDER_LIMITS.maxEvidenceBodyBytes + 1)).toThrow(/byte ceiling/i);
  });

  it.each([
    ["queued", null, "pending"],
    ["in_progress", null, "pending"],
    ["success", null, "passing"],
    ["failure", null, "failing"],
    ["error", null, "failing"],
    ["completed", "success", "passing"],
    ["completed", "failure", "failing"],
    ["completed", "timed_out", "failing"],
    ["completed", "action_required", "failing"],
    ["completed", "startup_failure", "failing"],
    ["completed", "stale", "failing"],
    ["completed", "cancelled", "cancelled"],
    ["completed", "neutral", "skipping"],
    ["completed", "skipped", "skipping"],
    ["completed", null, "unknown"],
    ["future_status", "future_conclusion", "unknown"]
  ])("maps provider status %s/%s to %s", (status, conclusion, expected) => {
    expect(classifyProviderCheck(status!, conclusion)).toBe(expected);
  });

  it("selects the newest rerun and makes results independent of provider ordering", () => {
    const old = check({ providerCheckId: "old", providerRunId: "old-run", conclusion: "failure" });
    const fresh = check({ providerCheckId: "fresh", providerRunId: "fresh-run", startedAt: LATER, completedAt: "2026-08-09T12:02:00.000Z" });
    const left = normalizeCheckWindow([old, fresh], "complete");
    const right = normalizeCheckWindow([fresh, old], "complete");
    expect(left).toEqual(right);
    expect(left.facts).toMatchObject({ state: "passing", requiredCheckCount: 1, conflicts: [] });
    expect(left.facts.checks[0]?.providerRunId).toBe("fresh-run");
  });

  it("degrades an equal-recency divergent rerun tie to unknown deterministically", () => {
    const pass = check({ providerCheckId: "a", providerRunId: "run-a", conclusion: "success" });
    const fail = check({ providerCheckId: "b", providerRunId: "run-b", conclusion: "failure" });
    const one = normalizeCheckWindow([pass, fail], "complete");
    const two = normalizeCheckWindow([fail, pass], "complete");
    expect(one).toEqual(two);
    expect(one.facts.state).toBe("unknown");
    expect(one.facts.checks[0]).toMatchObject({ bucket: "unknown", status: "ambiguous_equal_recency" });
    expect(one.facts.conflicts).toEqual([one.facts.checks[0]!.key]);
  });

  it("never derives global passing from a partial page, while preserving a known failure", () => {
    expect(normalizeCheckWindow([check()], "partial").facts.state).toBe("unknown");
    const failed = normalizeCheckWindow([check({ conclusion: "failure" })], "partial");
    expect(failed.facts.state).toBe("failing");
    expect(failed.facts.failureFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("ignores optional failures for required readiness but retains them as normalized evidence", () => {
    const normalized = normalizeCheckWindow([
      check(),
      check({ providerCheckId: "lint", providerRunId: "lint-run", name: "lint", required: false, conclusion: "failure" })
    ], "complete");
    expect(normalized.facts.state).toBe("passing");
    expect(normalized.facts.checks).toHaveLength(2);
  });

  it("merges partial check pages without erasing omitted prior contexts", () => {
    const previous = normalizeCheckWindow([
      check(),
      check({ providerCheckId: "lint", providerRunId: "lint-run", name: "lint", required: false })
    ], "complete");
    const partial = normalizeCheckWindow([
      check({ providerCheckId: "fresh", providerRunId: "fresh-run", startedAt: LATER, completedAt: "2026-08-09T12:02:00.000Z", conclusion: "failure" })
    ], "partial");
    const merged = mergePartialCiFacts(previous.facts, partial.facts);
    expect(merged.completeness).toBe("partial");
    expect(merged.facts.checks).toHaveLength(2);
    expect(merged.facts.state).toBe("failing");
  });

  it("normalizes review evidence by stable provider identity and latest update", () => {
    const old = evidence("comment-1", { body: "old", updatedAt: START });
    const latest = evidence("comment-1", { body: "new\u001b", updatedAt: LATER });
    const resolved = evidence("comment-2", { resolved: true, body: "fixed" });
    const first = normalizeReviewWindow({ scope, decision: "changes_requested", humanApprovals: 0, evidence: [old, latest, resolved], completeness: "complete" });
    const second = normalizeReviewWindow({ scope, decision: "changes_requested", humanApprovals: 0, evidence: [resolved, latest, old], completeness: "complete" });
    expect(first).toEqual(second);
    expect(first.facts.evidence).toHaveLength(2);
    expect(first.facts.evidence.find((item) => item.providerEvidenceId === "comment-1")?.body).toBe("new�");
    expect(first.facts.unresolvedSelectedEvidenceIds).toHaveLength(1);
    expect(first.completeness).toBe("complete");
  });

  it("revalidates retained body bytes and digest at the durable evidence boundary", () => {
    const normalized = normalizeReviewWindow({ scope, decision: "pending", humanApprovals: 0, evidence: [evidence("comment-1")], completeness: "complete" });
    const fact = normalized.facts.evidence[0]!;
    expect(parseScmEvidence(fact)).toEqual(fact);
    expect(() => parseScmEvidence({ ...fact, retainedBytes: fact.retainedBytes + 1 })).toThrow(/retained byte count/i);
    expect(() => parseScmEvidence({ ...fact, bodySha256: "0".repeat(64) })).toThrow(/digest/i);
    expect(() => parseScmEvidence({ ...fact, body: "😀".repeat(20_000), retainedBytes: 80_000 })).toThrow(/byte ceiling/i);
  });

  it("marks an equal-time divergent provider evidence ID as partial instead of choosing authority", () => {
    const first = evidence("comment-1", { body: "one" });
    const second = evidence("comment-1", { body: "two" });
    const normalized = normalizeReviewWindow({ scope, decision: "pending", humanApprovals: 0, evidence: [first, second], completeness: "complete" });
    expect(normalized.completeness).toBe("partial");
    expect(normalized.facts.conflicts).toHaveLength(1);
  });

  it("merges a partial review window without treating absent prior feedback as resolved", () => {
    const previous = normalizeReviewWindow({
      scope,
      decision: "changes_requested",
      humanApprovals: 0,
      evidence: [evidence("old-comment")],
      completeness: "complete"
    });
    const partial = normalizeReviewWindow({
      scope,
      decision: "approved",
      humanApprovals: 1,
      evidence: [evidence("new-comment", { updatedAt: LATER })],
      completeness: "partial"
    });
    const merged = mergePartialReviewFacts(previous.facts, partial.facts);
    expect(merged.completeness).toBe("partial");
    expect(merged.facts.evidence.map((item) => item.providerEvidenceId).sort()).toEqual(["new-comment", "old-comment"]);
    expect(merged.facts.unresolvedSelectedEvidenceIds).toHaveLength(2);
    expect(merged.facts.decision).toBe("changes_requested");
  });

  it("caps aggregate retained feedback at 256 KiB and truthfully marks omissions partial", () => {
    const body = "x".repeat(SCM_PROVIDER_LIMITS.maxEvidenceBodyBytes);
    const values = Array.from({ length: 5 }, (_, index) => evidence(`comment-${index}`, { body }));
    const normalized = normalizeReviewWindow({ scope, decision: "changes_requested", humanApprovals: 0, evidence: values, completeness: "complete" });
    expect(normalized.facts.evidence).toHaveLength(4);
    expect(normalized.facts.evidence.reduce((sum, item) => sum + item.retainedBytes, 0)).toBe(SCM_PROVIDER_LIMITS.maxEvidencePreviewBytes);
    expect(normalized.omitted).toBe(1);
    expect(normalized.completeness).toBe("partial");
  });

  it("prioritizes selected unresolved human evidence inside the aggregate preview budget", () => {
    const body = "x".repeat(SCM_PROVIDER_LIMITS.maxEvidenceBodyBytes);
    const background = Array.from({ length: 4 }, (_, index) => evidence(`bot-${index}`, {
      body,
      authorKind: "bot",
      selected: false
    }));
    const actionable = evidence("must-retain", { body });
    const normalized = normalizeReviewWindow({
      scope,
      decision: "changes_requested",
      humanApprovals: 0,
      evidence: [...background, actionable],
      completeness: "complete"
    });
    expect(normalized.facts.evidence.some((item) => item.providerEvidenceId === "must-retain")).toBe(true);
    expect(normalized.facts.unresolvedSelectedEvidenceIds).toHaveLength(1);
  });

  it("builds an ordering-independent reaction key that changes with head or evidence version", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    const base = { repositoryKey: scope.repositoryKey, pullRequestNumber: 7, headSha: HEAD, factKind: "review" as const };
    expect(evidenceReactionKey({ ...base, evidenceIds: [a, b] })).toBe(evidenceReactionKey({ ...base, evidenceIds: [b, a, a] }));
    expect(evidenceReactionKey({ ...base, evidenceIds: [a] })).not.toBe(evidenceReactionKey({ ...base, evidenceIds: [b] }));
    expect(evidenceReactionKey({ ...base, headSha: "b".repeat(40), evidenceIds: [a] })).not.toBe(evidenceReactionKey({ ...base, evidenceIds: [a] }));
    expect(() => evidenceReactionKey({ ...base, evidenceIds: [] })).toThrow(/requires canonical evidence/i);
  });
});

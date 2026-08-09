import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyMultiRepoPublicationEvent, createMultiRepoPublicationEvent, reconcileMultiRepoPublicationOnce, type MultiRepoPublicationAdapter, type MultiRepoPublicationPlanV1, type MultiRepoPublicationProjectionV1 } from "../src/multirepo/publication.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function plan(): MultiRepoPublicationPlanV1 { return { schemaVersion: 1, transactionId: "txn-1", repositorySetId: sha("set"), localIntegrationReceiptDigest: sha("receipt"), policyApproved: true, entries: ["api", "web"].map((repositoryId, index) => ({ repositoryId, publicationId: `publish-${repositoryId}`, candidateOid: String(index + 1).repeat(40), localIntegrationRef: `refs/heads/integration/${repositoryId}`, remoteName: "origin", expectedPushUrl: `https://github.com/example/${repositoryId}.git`, remoteRef: `refs/heads/relayforge/${repositoryId}`, expectedRemoteOid: null, baseRef: "main", title: `Update ${repositoryId}`, body: "Cross-repository change" })) }; }
function adapter(overrides: Partial<MultiRepoPublicationAdapter> = {}): MultiRepoPublicationAdapter { return { async publishBranch(value) { return { state: "completed", value: { remoteOid: value.candidateOid }, completedBy: "push" }; }, async ensurePullRequest(value) { return { state: "completed", value: { artifactId: `pr-${value.repositoryId}`, url: `https://example.invalid/${value.repositoryId}` }, completedBy: "create" }; }, async ensureCrossLinks({ artifacts }) { return { state: "completed", value: { digest: sha(JSON.stringify(artifacts)) }, completedBy: "update" }; }, ...overrides }; }
async function step(projection: MultiRepoPublicationProjectionV1, value = adapter()): Promise<MultiRepoPublicationProjectionV1> { const event = await reconcileMultiRepoPublicationOnce(projection, value); return event === undefined ? projection : applyMultiRepoPublicationEvent(projection, event); }

describe("multi-repository publication saga", () => {
  it("publishes branches, PRs, and cross-links independently before vector completion", async () => {
    let projection = applyMultiRepoPublicationEvent(undefined, createMultiRepoPublicationEvent(plan()));
    for (let count = 0; count < 10 && projection.state !== "published"; count += 1) projection = await step(projection);
    expect(projection.state).toBe("published"); expect(projection.entries.every((entry) => entry.branch && entry.pullRequest && entry.crossLink)).toBe(true);
  });

  it("records partial retry without erasing completed remote artifacts", async () => {
    let projection = applyMultiRepoPublicationEvent(undefined, createMultiRepoPublicationEvent(plan())); projection = await step(projection);
    projection = await step(projection, adapter({ async publishBranch() { return { state: "retry", code: "RATE_LIMITED" }; } }));
    expect(projection).toMatchObject({ state: "partial", entries: [{ branch: { remoteOid: "1".repeat(40) } }, { lastFailure: { code: "RATE_LIMITED", retryable: true } }] });
    projection = await step(projection); expect(projection.entries[0]!.branch).toBeDefined(); expect(projection.entries[1]!.branch).toBeDefined();
  });

  it("reconciles a crash-lost successful branch idempotently", async () => {
    const initial = applyMultiRepoPublicationEvent(undefined, createMultiRepoPublicationEvent(plan())); let calls = 0;
    const value = adapter({ async publishBranch(entry) { calls += 1; return { state: "completed", value: { remoteOid: entry.candidateOid }, completedBy: calls === 1 ? "push" : "reconciled" }; } });
    const lost = await reconcileMultiRepoPublicationOnce(initial, value); expect(lost).toMatchObject({ completedBy: "push" });
    const retry = await reconcileMultiRepoPublicationOnce(initial, value); expect(retry).toMatchObject({ completedBy: "reconciled" });
    expect(applyMultiRepoPublicationEvent(initial, retry!).entries[0]?.branch).toMatchObject({ completedBy: "reconciled" });
  });

  it("parks ambiguous/divergent remote state without deleting or force operations", async () => {
    let projection = applyMultiRepoPublicationEvent(undefined, createMultiRepoPublicationEvent(plan()));
    projection = await step(projection, adapter({ async publishBranch() { return { state: "recovery_required", code: "REMOTE_DIVERGED" }; } }));
    expect(projection).toMatchObject({ state: "recovery_required", recoveryReason: "api:branch:REMOTE_DIVERGED" });
    expect(await reconcileMultiRepoPublicationOnce(projection, adapter())).toBeUndefined();
  });

  it("requires explicit policy approval, exact receipt identity, and sorted unique entries", () => {
    expect(() => createMultiRepoPublicationEvent({ ...plan(), policyApproved: false })).toThrowError(expect.objectContaining({ code: "INVALID_PLAN" }));
    expect(() => createMultiRepoPublicationEvent({ ...plan(), entries: [...plan().entries].reverse() })).toThrowError(expect.objectContaining({ code: "INVALID_PLAN" }));
    expect(() => createMultiRepoPublicationEvent({ ...plan(), localIntegrationReceiptDigest: "bad" })).toThrowError(expect.objectContaining({ code: "INVALID_PLAN" }));
  });
});

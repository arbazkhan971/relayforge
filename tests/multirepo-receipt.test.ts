import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCombinedVerificationReceipt, verifyCombinedVerificationReceipt } from "../src/multirepo/receipt.js";
import { materializeCombinedVerificationPlan, type CombinedVerificationOutcome } from "../src/multirepo/verification.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function verified(): CombinedVerificationOutcome {
  const plan = materializeCombinedVerificationPlan({ transactionId: "txn-1", repositorySetId: sha("set"), entries: [{ repositoryId: "api", canonicalWorkspacePath: "/private/api", targetRef: "refs/heads/main", expectedOid: "1".repeat(40), childOid: "2".repeat(40), candidateOid: "3".repeat(40), treeOid: "4".repeat(40) }], commands: ["npm test"], environment: { PATH: "/bin" } });
  return { state: "verified", plan, results: [{ ok: true, code: 0, outputDigest: sha("out"), outputBytes: 3, fingerprint: sha("finger"), transportTrusted: true, scopeTrusted: true }] };
}

describe("combined verification receipt", () => {
  it("creates and verifies a digest-bound immutable receipt", () => {
    const outcome = verified(); const receipt = createCombinedVerificationReceipt(outcome, "2026-08-09T12:00:00.000Z");
    expect(receipt.receiptDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => verifyCombinedVerificationReceipt(outcome.plan, receipt)).not.toThrow();
    expect(Object.isFrozen(receipt)).toBe(true);
  });

  it("rejects failed outcomes, tampering, and cross-plan reuse", () => {
    const outcome = verified();
    expect(() => createCombinedVerificationReceipt({ ...outcome, state: "failed" }, "2026-08-09T12:00:00.000Z")).toThrow();
    const receipt = createCombinedVerificationReceipt(outcome, "2026-08-09T12:00:00.000Z");
    expect(() => verifyCombinedVerificationReceipt(outcome.plan, { ...receipt, verifiedAt: "2026-08-09T12:00:01.000Z" })).toThrowError(expect.objectContaining({ code: "INVALID_RECEIPT" }));
    const other = materializeCombinedVerificationPlan({ transactionId: "txn-2", repositorySetId: outcome.plan.repositorySetId, entries: outcome.plan.entries, commands: outcome.plan.commands, environment: { PATH: "/bin" } });
    expect(() => verifyCombinedVerificationReceipt(other, receipt)).toThrow();
  });
});

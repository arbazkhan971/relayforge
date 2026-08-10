import { createHash } from "node:crypto";
import type { CombinedVerificationOutcome, CombinedVerificationPlanV1 } from "./verification.js";
import { combinedVerificationCanonicalValue } from "./verification.js";

export type CombinedVerificationReceiptV1 = Readonly<{
  schemaVersion: 1;
  transactionId: string;
  repositorySetId: string;
  manifestDigest: string;
  verifiedAt: string;
  resultDigests: readonly string[];
  receiptDigest: string;
}>;

export class MultiRepoReceiptError extends Error {
  readonly code = "INVALID_RECEIPT";
  constructor(message: string) { super(`INVALID_RECEIPT: ${message}`); this.name = "MultiRepoReceiptError"; }
}

function timestamp(value: string): boolean { const time = Date.parse(value); return value.length === 24 && !Number.isNaN(time) && new Date(time).toISOString() === value; }
function digest(domain: string, value: string): string { return createHash("sha256").update(domain).update("\0").update(value).digest("hex"); }

function receiptPayload(value: Omit<CombinedVerificationReceiptV1, "receiptDigest">): string {
  return JSON.stringify([value.schemaVersion, value.transactionId, value.repositorySetId, value.manifestDigest, value.verifiedAt, value.resultDigests]);
}

export function createCombinedVerificationReceipt(outcome: CombinedVerificationOutcome, verifiedAt: string): CombinedVerificationReceiptV1 {
  if (outcome.state !== "verified" || !timestamp(verifiedAt) || outcome.results.length !== outcome.plan.commands.length) throw new MultiRepoReceiptError("only a complete verified outcome can receive a receipt");
  const resultDigests = Object.freeze(outcome.results.map((result, index) => digest("relayforge-combined-verification-result-v1", `${index}\0${combinedVerificationCanonicalValue(result)}`)));
  const payload = Object.freeze({ schemaVersion: 1 as const, transactionId: outcome.plan.transactionId, repositorySetId: outcome.plan.repositorySetId, manifestDigest: outcome.plan.manifestDigest, verifiedAt, resultDigests });
  return Object.freeze({ ...payload, receiptDigest: digest("relayforge-combined-verification-receipt-v1", receiptPayload(payload)) });
}

export function verifyCombinedVerificationReceipt(plan: CombinedVerificationPlanV1, receipt: CombinedVerificationReceiptV1): void {
  if (receipt.schemaVersion !== 1 || receipt.transactionId !== plan.transactionId || receipt.repositorySetId !== plan.repositorySetId || receipt.manifestDigest !== plan.manifestDigest || !timestamp(receipt.verifiedAt) || receipt.resultDigests.length !== plan.commands.length || receipt.resultDigests.some((item) => !/^[a-f0-9]{64}$/u.test(item))) throw new MultiRepoReceiptError("receipt identity or shape differs from the plan");
  const expected = digest("relayforge-combined-verification-receipt-v1", receiptPayload({ schemaVersion: 1, transactionId: receipt.transactionId, repositorySetId: receipt.repositorySetId, manifestDigest: receipt.manifestDigest, verifiedAt: receipt.verifiedAt, resultDigests: receipt.resultDigests }));
  if (expected !== receipt.receiptDigest) throw new MultiRepoReceiptError("receipt digest mismatch");
}

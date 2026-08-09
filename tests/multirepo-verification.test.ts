import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { executeCombinedVerification, materializeCombinedVerificationPlan, type CandidateVerificationEntryV1, type CombinedVerificationCommandResult } from "../src/multirepo/verification.js";

const oid = (scalar: string) => scalar.repeat(40);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const entry = (repositoryId: string, path: string): CandidateVerificationEntryV1 => ({ repositoryId, canonicalWorkspacePath: path, targetRef: "refs/heads/main", expectedOid: oid("1"), childOid: oid("2"), candidateOid: oid("3"), treeOid: oid("4") });
const result = (overrides: Partial<CombinedVerificationCommandResult> = {}): CombinedVerificationCommandResult => ({ ok: true, code: 0, outputDigest: sha("output"), outputBytes: 10, fingerprint: sha("fingerprint"), transportTrusted: true, scopeTrusted: true, ...overrides });

describe("combined multi-repository verification", () => {
  it("binds ordered candidates, commands, and scrubbed environment deterministically", () => {
    const input = { transactionId: "txn-1", repositorySetId: sha("set"), entries: [entry("api", "/private/api"), entry("web", "/private/web")], commands: ["npm test", "npm run build"], environment: { PATH: "/bin", LANG: "C" } };
    const first = materializeCombinedVerificationPlan(input);
    const second = materializeCombinedVerificationPlan({ ...input, environment: { LANG: "C", PATH: "/bin" } });
    expect(first.manifestDigest).toBe(second.manifestDigest);
    expect(materializeCombinedVerificationPlan({ ...input, entries: [...input.entries].reverse() }).manifestDigest).not.toBe(first.manifestDigest);
  });

  it("runs through the injected sole-transport executor and revalidates the vector", async () => {
    const environment = { PATH: "/bin" };
    const plan = materializeCombinedVerificationPlan({ transactionId: "txn-1", repositorySetId: sha("set"), entries: [entry("api", "/private/api")], commands: ["test", "build"], environment });
    let observations = 0; const calls: number[] = [];
    const outcome = await executeCombinedVerification({ plan, environment, observer: { observe(value) { observations += 1; return { candidateOid: value.candidateOid, treeOid: value.treeOid, clean: true, identityExact: true }; } }, executor: { async run(request) { calls.push(request.commandIndex); return result(); } } });
    expect(outcome.state).toBe("verified"); expect(calls).toEqual([0, 1]); expect(observations).toBe(2);
  });

  it("fails closed for pre/post mutation, command failure, and untrusted transport", async () => {
    const environment = { PATH: "/bin" }; const candidate = entry("api", "/private/api");
    const plan = materializeCombinedVerificationPlan({ transactionId: "txn-1", repositorySetId: sha("set"), entries: [candidate], commands: ["test"], environment });
    const changed = await executeCombinedVerification({ plan, environment, observer: { observe() { return { candidateOid: oid("9"), treeOid: candidate.treeOid, clean: true, identityExact: true }; } }, executor: { async run() { throw new Error("must not run"); } } });
    expect(changed).toMatchObject({ state: "recovery_required", reasonCode: "CANDIDATE_CHANGED", results: [] });
    const failed = await executeCombinedVerification({ plan, environment, observer: { observe(value) { return { candidateOid: value.candidateOid, treeOid: value.treeOid, clean: true, identityExact: true }; } }, executor: { async run() { return result({ ok: false, code: 1 }); } } });
    expect(failed).toMatchObject({ state: "failed", reasonCode: "COMMAND_FAILED" });
    const untrusted = await executeCombinedVerification({ plan, environment, observer: { observe(value) { return { candidateOid: value.candidateOid, treeOid: value.treeOid, clean: true, identityExact: true }; } }, executor: { async run() { return result({ scopeTrusted: false }); } } });
    expect(untrusted).toMatchObject({ state: "recovery_required", reasonCode: "TRANSPORT_UNTRUSTED" });
  });

  it("rejects overlapping workspaces, empty commands, environment drift, and malformed results", async () => {
    const base = { transactionId: "txn-1", repositorySetId: sha("set"), entries: [entry("api", "/private/root"), entry("web", "/private/root/web")], commands: ["test"], environment: { PATH: "/bin" } };
    expect(() => materializeCombinedVerificationPlan(base)).toThrowError(expect.objectContaining({ code: "INVALID_PLAN" }));
    expect(() => materializeCombinedVerificationPlan({ ...base, entries: [entry("api", "/private/api")], commands: [] })).toThrowError(expect.objectContaining({ code: "INVALID_PLAN" }));
    const plan = materializeCombinedVerificationPlan({ ...base, entries: [entry("api", "/private/api")] });
    await expect(executeCombinedVerification({ plan, environment: { PATH: "/other" }, observer: { observe(value) { return { candidateOid: value.candidateOid, treeOid: value.treeOid, clean: true, identityExact: true }; } }, executor: { async run() { return result(); } } })).rejects.toMatchObject({ code: "INVALID_ENVIRONMENT" });
    expect((await executeCombinedVerification({ plan, environment: base.environment, observer: { observe(value) { return { candidateOid: value.candidateOid, treeOid: value.treeOid, clean: true, identityExact: true }; } }, executor: { async run() { return { ...result(), outputDigest: "bad" }; } } })).reasonCode).toBe("RESULT_INVALID");
  });
});

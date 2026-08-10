import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

export const MULTIREPO_VERIFICATION_LIMITS = Object.freeze({
  maximumRepositories: 32,
  maximumCommands: 64,
  maximumCommandBytes: 4_096,
  maximumOutputBytesPerCommand: 4 * 1024 * 1024
});

export type CandidateVerificationEntryV1 = Readonly<{
  repositoryId: string;
  canonicalWorkspacePath: string;
  targetRef: string;
  expectedOid: string;
  childOid: string;
  candidateOid: string;
  treeOid: string;
}>;

export type CombinedVerificationPlanV1 = Readonly<{
  schemaVersion: 1;
  transactionId: string;
  repositorySetId: string;
  entries: readonly CandidateVerificationEntryV1[];
  commands: readonly string[];
  environmentDigest: string;
  manifestDigest: string;
}>;

export type CandidateVerificationObservation = Readonly<{
  candidateOid: string;
  treeOid: string;
  clean: boolean;
  identityExact: boolean;
}>;

export type CombinedVerificationCommandRequest = Readonly<{
  transactionId: string;
  commandIndex: number;
  command: string;
  manifestDigest: string;
  environment: Readonly<Record<string, string>>;
  entries: readonly CandidateVerificationEntryV1[];
}>;

export type CombinedVerificationCommandResult = Readonly<{
  ok: boolean;
  code: number;
  outputDigest: string;
  outputBytes: number;
  fingerprint: string;
  transportTrusted: boolean;
  scopeTrusted: boolean;
}>;

export interface CombinedVerificationExecutor {
  /** Integration must implement this through RelayForge's sole contained verifier transport. */
  run(request: CombinedVerificationCommandRequest): Promise<CombinedVerificationCommandResult>;
}

export interface CandidateVerificationObserver {
  observe(entry: CandidateVerificationEntryV1): CandidateVerificationObservation;
}

export type CombinedVerificationOutcome = Readonly<{
  state: "verified" | "failed" | "recovery_required";
  plan: CombinedVerificationPlanV1;
  results: readonly CombinedVerificationCommandResult[];
  reasonCode?: "CANDIDATE_CHANGED" | "COMMAND_FAILED" | "TRANSPORT_UNTRUSTED" | "RESULT_INVALID";
}>;

export type MultiRepoVerificationErrorCode = "INVALID_PLAN" | "INVALID_ENVIRONMENT" | "INVALID_RESULT";
export class MultiRepoVerificationError extends Error {
  constructor(readonly code: MultiRepoVerificationErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "MultiRepoVerificationError";
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function digest(domain: string, value: unknown): string {
  return createHash("sha256").update(domain).update("\0").update(canonical(value)).digest("hex");
}

function environmentDigest(environment: Readonly<Record<string, string>>): string {
  const entries = Object.entries(environment).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length > 128 || new Set(entries.map(([key]) => key)).size !== entries.length) throw new MultiRepoVerificationError("INVALID_ENVIRONMENT", "environment exceeds its bound");
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(key) || Buffer.byteLength(value, "utf8") > 16 * 1024 || value.includes("\0")) {
      throw new MultiRepoVerificationError("INVALID_ENVIRONMENT", "environment contains an invalid entry");
    }
  }
  return digest("relayforge-verifier-environment-v1", entries);
}

export function materializeCombinedVerificationPlan(input: Readonly<{
  transactionId: string;
  repositorySetId: string;
  entries: readonly CandidateVerificationEntryV1[];
  commands: readonly string[];
  environment: Readonly<Record<string, string>>;
}>): CombinedVerificationPlanV1 {
  if (!ID.test(input.transactionId) || !SHA.test(input.repositorySetId)) throw new MultiRepoVerificationError("INVALID_PLAN", "transaction or repository-set identity is invalid");
  if (!Array.isArray(input.entries) || input.entries.length < 1 || input.entries.length > MULTIREPO_VERIFICATION_LIMITS.maximumRepositories) throw new MultiRepoVerificationError("INVALID_PLAN", "candidate vector is empty or over bound");
  if (!Array.isArray(input.commands) || input.commands.length < 1 || input.commands.length > MULTIREPO_VERIFICATION_LIMITS.maximumCommands) throw new MultiRepoVerificationError("INVALID_PLAN", "verification command list is empty or over bound");
  const repositoryIds = new Set<string>();
  const paths = new Set<string>();
  const entries = input.entries.map((entry) => {
    if (!ID.test(entry.repositoryId) || repositoryIds.has(entry.repositoryId) || !entry.canonicalWorkspacePath.startsWith("/") || paths.has(entry.canonicalWorkspacePath) || !OID.test(entry.expectedOid) || !OID.test(entry.childOid) || !OID.test(entry.candidateOid) || !OID.test(entry.treeOid) || !/^refs\/heads\//u.test(entry.targetRef)) {
      throw new MultiRepoVerificationError("INVALID_PLAN", `candidate entry ${entry.repositoryId} is invalid or duplicated`);
    }
    repositoryIds.add(entry.repositoryId); paths.add(entry.canonicalWorkspacePath);
    return Object.freeze({ ...entry });
  });
  for (const left of entries) for (const right of entries) {
    if (left === right) continue;
    if (right.canonicalWorkspacePath.startsWith(`${left.canonicalWorkspacePath}/`)) throw new MultiRepoVerificationError("INVALID_PLAN", "candidate workspaces overlap");
  }
  const commands = input.commands.map((command) => {
    if (typeof command !== "string" || Buffer.byteLength(command, "utf8") < 1 || Buffer.byteLength(command, "utf8") > MULTIREPO_VERIFICATION_LIMITS.maximumCommandBytes || command.includes("\0")) throw new MultiRepoVerificationError("INVALID_PLAN", "verification command is outside its byte bound");
    return command;
  });
  const envDigest = environmentDigest(input.environment);
  const manifestValue = { transactionId: input.transactionId, repositorySetId: input.repositorySetId, entries, commands, environmentDigest: envDigest };
  return Object.freeze({ schemaVersion: 1, ...manifestValue, entries: Object.freeze(entries), commands: Object.freeze(commands), manifestDigest: digest("relayforge-combined-verification-manifest-v1", manifestValue) });
}

function exactObservation(entry: CandidateVerificationEntryV1, value: CandidateVerificationObservation): boolean {
  return value.identityExact && value.clean && value.candidateOid === entry.candidateOid && value.treeOid === entry.treeOid;
}

function validResult(value: CombinedVerificationCommandResult): boolean {
  return typeof value.ok === "boolean" && Number.isSafeInteger(value.code) && value.code >= -1 && value.code <= 255 && SHA.test(value.outputDigest) && SHA.test(value.fingerprint) && Number.isSafeInteger(value.outputBytes) && value.outputBytes >= 0 && value.outputBytes <= MULTIREPO_VERIFICATION_LIMITS.maximumOutputBytesPerCommand && typeof value.transportTrusted === "boolean" && typeof value.scopeTrusted === "boolean";
}

export async function executeCombinedVerification(input: Readonly<{
  plan: CombinedVerificationPlanV1;
  environment: Readonly<Record<string, string>>;
  observer: CandidateVerificationObserver;
  executor: CombinedVerificationExecutor;
}>): Promise<CombinedVerificationOutcome> {
  if (environmentDigest(input.environment) !== input.plan.environmentDigest) throw new MultiRepoVerificationError("INVALID_ENVIRONMENT", "runtime verifier environment differs from the reviewed plan");
  for (const entry of input.plan.entries) if (!exactObservation(entry, input.observer.observe(entry))) return Object.freeze({ state: "recovery_required", plan: input.plan, results: Object.freeze([]), reasonCode: "CANDIDATE_CHANGED" });
  const results: CombinedVerificationCommandResult[] = [];
  for (const [commandIndex, command] of input.plan.commands.entries()) {
    const value = await input.executor.run({ transactionId: input.plan.transactionId, commandIndex, command, manifestDigest: input.plan.manifestDigest, environment: input.environment, entries: input.plan.entries });
    if (!validResult(value)) return Object.freeze({ state: "recovery_required", plan: input.plan, results: Object.freeze(results), reasonCode: "RESULT_INVALID" });
    results.push(Object.freeze({ ...value }));
    if (!value.transportTrusted || !value.scopeTrusted) return Object.freeze({ state: "recovery_required", plan: input.plan, results: Object.freeze(results), reasonCode: "TRANSPORT_UNTRUSTED" });
    if (!value.ok || value.code !== 0) return Object.freeze({ state: "failed", plan: input.plan, results: Object.freeze(results), reasonCode: "COMMAND_FAILED" });
  }
  for (const entry of input.plan.entries) if (!exactObservation(entry, input.observer.observe(entry))) return Object.freeze({ state: "recovery_required", plan: input.plan, results: Object.freeze(results), reasonCode: "CANDIDATE_CHANGED" });
  return Object.freeze({ state: "verified", plan: input.plan, results: Object.freeze(results) });
}

export function combinedVerificationCanonicalValue(value: CombinedVerificationPlanV1 | CombinedVerificationCommandResult): string { return canonical(value); }

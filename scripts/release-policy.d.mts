export class ReleasePolicyError extends Error { readonly code: string }
export const RELEASE_REQUIRED_EVIDENCE_PATHS: readonly string[];
export function assertReleaseEvidenceInventory(repositoryRoot?: string): Readonly<{ paths: readonly string[]; count: number }>;
export type ReleaseCommandResult = Readonly<{ status: number | null; stdout?: string; stderr?: string }>;
export type ReleaseRunner = (command: string, args: readonly string[]) => ReleaseCommandResult;
export function assertReleaseIdentity(input: Readonly<{ packageDocument: { name: string; version: string }; tag: string; changelog: string }>): Readonly<{ packageName: string; version: string; tag: string }>;
export function assertReleaseCommitIdentity(input: Readonly<{ head: string; tagCommit: string }>): Readonly<{ commit: string; tagCommit: string }>;
export function assertPublishableReleaseManifest(manifest: unknown): unknown;
export function registryPreflight(input: Readonly<{ packageName: string; version: string; expectedIntegrity?: string; run?: ReleaseRunner }>): Readonly<{ state: "absent"; publishRequired: true } | { state: "present"; publishRequired: false; integrity: string }>;
export function registryConvergence(input: Readonly<{ packageName: string; version: string; expectedIntegrity?: string; expectedTag: string; run?: ReleaseRunner }>): Readonly<{ state: "converged"; version: string; tag: string; integrity: string }>;
export function releaseGate(input?: Readonly<{ repositoryRoot?: string; tag?: string }>): Readonly<{ packageName: string; version: string; tag: string; commit: string }>;

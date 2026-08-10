export const RELEASE_ARTIFACT_LIMITS: Readonly<{
  maximumFiles: number;
  maximumTarballBytes: number;
  maximumUnpackedBytes: number;
  commandTimeoutMs: number;
  installTimeoutMs: number;
}>;
export class ReleaseArtifactError extends Error { readonly code: string }
export type ReleaseGateEvidence = Readonly<{ sourceValidation: "passed" | "not_proven"; verifierCgroup: "passed" | "not_proven"; artifactSmoke: "passed" | "not_run" }>;
export function releaseGateEvidence(env?: NodeJS.ProcessEnv, artifactSmoke?: boolean): ReleaseGateEvidence;
export function validateNativeAdapterReceiptBundle(value: unknown, expectedCommit: string): unknown;
export function readNativeAdapterReceiptBundle(path: string, expectedCommit: string): unknown;
export function validatePackedFileList(files: readonly Readonly<{ path: string; size: number }>[], packageDocument: Readonly<{ bin?: Record<string, string> }>): Readonly<{ files: readonly Readonly<{ path: string; size: number }>[]; unpackedBytes: number }>;
export function validatePackedMarkdownLinks(repositoryRoot: string, files: readonly Readonly<{ path: string; size: number }>[]): Readonly<{ documents: number; checked: number }>;
export function assertInstalledBetterSqlite3NativeBinding(prefix: string): string;
export function proveBetterSqlite3NativeLoad(prefix: string, packageName: string): Readonly<{ bindingPath: string; loaded: true }>;
export function smokeInstalledPackage(input: Readonly<{ prefix: string; packageName: string; version: string; deep?: boolean }>): Promise<unknown>;
export function buildReleaseArtifact(input?: Readonly<{ repositoryRoot?: string; outputDirectory?: string; runSmoke?: boolean; gateEnvironment?: NodeJS.ProcessEnv; preview?: boolean; nativeAdapterReceiptBundlePath?: string }>): Promise<unknown>;
export function verifyRegistryArtifact(manifestPath: string): Promise<unknown>;

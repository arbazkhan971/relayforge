export const PORTABLE_LINUX_CONTRACT: Readonly<{
  schemaVersion: number;
  target: string;
  os: string;
  architecture: string;
  minimumGlibc: string;
  supportedHost: string;
  nodeVersion: string;
  nodeArchiveFilename: string;
  nodeArchiveSha256: string;
  nodeArchiveUrl: string;
  maximumArchiveBytes: number;
  commandTimeoutMs: number;
}>;

export class PortableArtifactError extends Error {
  readonly code: string;
}

export function sha256File(path: string): string;
export function renderPortableLauncher(): string;
export function renderPortableInstaller(input: {
  version: string;
  archiveFilename: string;
  archiveSha256: string;
  downloadUrl: string;
}): string;
export function recordPortableCleanHostSmoke(manifestPath: string, elapsedSeconds: number): Record<string, unknown>;
export function buildPortableLinuxArtifact(options?: {
  repositoryRoot?: string;
  outputDirectory?: string;
  cacheDirectory?: string;
  nodeArchive?: string;
}): Promise<Record<string, unknown>>;

export class PackedDashboardSmokeError extends Error {
  readonly code: string;
}

export function parseArguments(args: readonly string[]): Readonly<{ tarball: string }>;
export function encodeWebSocketFrame(text: string, mask?: Buffer): Buffer;
export function findChrome(
  environment?: NodeJS.ProcessEnv,
  candidatePaths?: readonly string[]
): Readonly<{ path: string; version: string }>;
export function runPackedDashboardSmoke(input: Readonly<{ tarball: string }>): Promise<Readonly<{
  schemaVersion: 1;
  packageName: string;
  version: string;
  chrome: string;
  fixtureRun: string;
  dom: "rendered";
  lifecycle: readonly ["connected", "degraded", "recovered"];
  serviceReplaced: true;
}>>;

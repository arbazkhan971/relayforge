import { basename } from "node:path";

export const RELAYFORGE_PRODUCT_NAME = "RelayForge";
export const RELAYFORGE_PACKAGE_NAME = "relayforge";
export const RELAYFORGE_COMMAND = "relayforge";
export const RELAYFORGE_CONFIG_BASENAMES = Object.freeze([
  "relayforge.config.yaml",
  "relayforge.config.yml",
  "relayforge.config.json"
] as const);
export const LOOP_CONFIG_BASENAMES = Object.freeze([
  "loop.config.yaml",
  "loop.config.yml",
  "loop.config.json"
] as const);
export const RELAYFORGE_LEGACY_COMMANDS = Object.freeze(["loop", "loop-orchestrator"] as const);

export const relayForgeIdentity = Object.freeze({
  product: RELAYFORGE_PRODUCT_NAME,
  packageName: RELAYFORGE_PACKAGE_NAME,
  command: RELAYFORGE_COMMAND,
  legacyCommands: RELAYFORGE_LEGACY_COMMANDS,
  configBasenames: RELAYFORGE_CONFIG_BASENAMES,
  legacyConfigBasenames: LOOP_CONFIG_BASENAMES,
  durableStateDirectory: ".loop"
});

export type RelayForgePublicEnvironment = "TMUX" | "TMUX_SOCKET" | "SANDBOX";
export const RELAYFORGE_PUBLIC_ENVIRONMENT_NAMES = Object.freeze([
  "TMUX",
  "TMUX_SOCKET",
  "SANDBOX"
] as const satisfies readonly RelayForgePublicEnvironment[]);

export class RelayForgeIdentityError extends Error {
  readonly code: "ENV_CONFLICT";

  constructor(code: "ENV_CONFLICT", detail: string) {
    super(`${code}: ${detail}`);
    this.name = "RelayForgeIdentityError";
    this.code = code;
  }
}

/**
 * Resolve a public RelayForge environment setting with its v1 Loop compatibility alias.
 * Presence is significant (including an empty string), and conflicting values are refused instead
 * of silently granting either spelling precedence. Provider-internal LOOP_* wire fields do not use
 * this helper and intentionally remain byte-compatible.
 */
export function resolveRelayForgeEnvironment(
  name: RelayForgePublicEnvironment,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const canonicalName = `RELAYFORGE_${name}`;
  const legacyName = `LOOP_${name}`;
  const canonical = env[canonicalName];
  const legacy = env[legacyName];
  if (canonical !== undefined && legacy !== undefined && canonical !== legacy) {
    throw new RelayForgeIdentityError(
      "ENV_CONFLICT",
      `${canonicalName} and legacy ${legacyName} are both set to different values`
    );
  }
  return canonical ?? legacy;
}

/** Refuse any conflicting public compatibility pair before a CLI command can mutate state. */
export function assertRelayForgeEnvironmentCompatibility(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of RELAYFORGE_PUBLIC_ENVIRONMENT_NAMES) resolveRelayForgeEnvironment(name, env);
}

/** Return the installed command name when argv points at one of the public binary entries. */
export function invokedRelayForgeCommand(argvEntry = process.argv[1]): string | undefined {
  if (!argvEntry) return undefined;
  const name = basename(argvEntry).replace(/\.cmd$/u, "");
  if (name === RELAYFORGE_COMMAND || RELAYFORGE_LEGACY_COMMANDS.includes(name as "loop" | "loop-orchestrator")) {
    return name;
  }
  return undefined;
}

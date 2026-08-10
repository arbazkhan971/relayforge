import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import YAML from "yaml";
import { LOOP_CONFIG_BASENAMES, RELAYFORGE_CONFIG_BASENAMES } from "../identity.js";
import { RootConfig, RootConfigSchema } from "./schema.js";

export type LoadedConfig = {
  config: RootConfig;
  path: string;
  rootDir: string;
};

export type ConfigDiscoveryErrorCode = "CONFIG_AMBIGUOUS" | "CONFIG_NOT_FOUND";

export class ConfigDiscoveryError extends Error {
  readonly code: ConfigDiscoveryErrorCode;
  readonly candidates: readonly string[];

  constructor(code: ConfigDiscoveryErrorCode, detail: string, candidates: readonly string[] = []) {
    super(`${code}: ${detail}`);
    this.name = "ConfigDiscoveryError";
    this.code = code;
    this.candidates = Object.freeze([...candidates]);
  }
}

const CONFIG_BASENAMES = Object.freeze([...RELAYFORGE_CONFIG_BASENAMES, ...LOOP_CONFIG_BASENAMES]);

/** All supported config identities present in exactly one directory, in stable family order. */
export function configCandidatesInDirectory(directory: string): readonly string[] {
  const root = resolve(directory);
  return Object.freeze(CONFIG_BASENAMES.map((name) => resolve(root, name)).filter((path) => existsSync(path)));
}

export function findConfig(startDir = process.cwd()): string {
  let current = resolve(startDir);

  while (true) {
    const candidates = configCandidatesInDirectory(current);
    if (candidates.length > 1) {
      throw new ConfigDiscoveryError(
        "CONFIG_AMBIGUOUS",
        `multiple RelayForge-family configuration files are present; select one exactly with --config: ${candidates.join(", ")}`,
        candidates
      );
    }
    if (candidates.length === 1) return candidates[0]!;

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new ConfigDiscoveryError(
    "CONFIG_NOT_FOUND",
    "no relayforge.config.* or legacy loop.config.* file was found. Run `relayforge init` first."
  );
}

export function loadConfig(configPath?: string): LoadedConfig {
  const path = resolve(configPath ?? findConfig());
  const source = readFileSync(path, "utf8");
  const raw = path.endsWith(".json") ? JSON.parse(source) : YAML.parse(source);
  const parsed = RootConfigSchema.safeParse(raw);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid RelayForge config ${path}:\n${details}`);
  }

  return {
    config: parsed.data,
    path,
    rootDir: dirname(path)
  };
}

export function getProject(loaded: LoadedConfig, name?: string) {
  if (!name && loaded.config.projects.length === 1) return loaded.config.projects[0];
  const project = loaded.config.projects.find((item) => item.name === name);
  if (!project) {
    const names = loaded.config.projects.map((item) => item.name).join(", ");
    throw new Error(`Project not found: ${name ?? "(missing)"}. Available projects: ${names}`);
  }
  return project;
}

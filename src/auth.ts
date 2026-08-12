import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { LoadedConfig } from "./config/load.js";
import { ProjectConfig, ProviderConfig } from "./config/schema.js";

export type ProviderAuthStatus = {
  providerName: string;
  type: ProviderConfig["type"];
  command?: string;
  commandPath?: string;
  cliAvailable: boolean;
  version?: string;
  apiKeyEnv?: string;
  apiKeySet: boolean;
  recommendedMode: "subscription" | "api-key" | "env";
  configured: boolean;
  notes: string[];
};

const providerDefaults: Record<ProviderConfig["type"], { commands: string[]; envs: string[] }> = {
  claude: {
    commands: ["claude"],
    envs: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]
  },
  codex: {
    commands: ["codex"],
    envs: ["OPENAI_API_KEY"]
  },
  gemini: {
    commands: ["gemini", "agy"],
    envs: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_CLOUD_PROJECT"]
  },
  custom: {
    commands: [],
    envs: []
  },
  opencode: {
    commands: ["opencode"],
    envs: ["OPENAI_API_KEY", "OPENCODE_CONFIG_CONTENT"]
  },
  pi: {
    commands: ["pi"],
    envs: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"]
  },
  grok: {
    commands: ["grok"],
    envs: ["XAI_API_KEY"]
  }
};

export function getAuthStatus(project: ProjectConfig): ProviderAuthStatus[] {
  return Object.entries(project.providers).map(([providerName, provider]) => {
    const defaults = providerDefaults[provider.type];
    const command = provider.command ?? defaults.commands[0];
    const commandPath = command ? which(command) : undefined;
    const version = commandPath ? readVersion(commandPath) : undefined;
    const configuredEnv = provider.auth.env;
    const apiKeyEnv = configuredEnv ?? defaults.envs.find((env) => Boolean(process.env[env]));
    const apiKeySet = Boolean(apiKeyEnv && process.env[apiKeyEnv]);
    // Every provider type supports a personal subscription through its installed CLI login
    // state; api-key mode is an alternative for operators who prefer key-based billing.
    const recommendedMode = apiKeySet ? "api-key" : commandPath ? "subscription" : "env";
    const notes: string[] = [];

    if (apiKeySet) {
      notes.push(`Using ${apiKeyEnv} from environment.`);
    } else if (commandPath) {
      notes.push(`Using local ${provider.type} CLI authentication state (personal subscription).`);
      if (provider.type === "grok") {
        notes.push("xAI subscription login is used through the adapter's isolated Grok home; set XAI_API_KEY instead for key-based billing.");
      } else if (provider.type === "opencode") {
        notes.push("Set OPENAI_API_KEY for canonical key-based billing, or OPENCODE_CONFIG_CONTENT for a provider-specific overlay.");
      }
    } else if (provider.type !== "custom") {
      notes.push(defaults.envs.length > 0
        ? `Install ${defaults.commands.join(" or ")} (to link a personal subscription) or set one of: ${defaults.envs.join(", ")}.`
        : `Install ${defaults.commands.join(" or ")}.`);
    }

    return {
      providerName,
      type: provider.type,
      command,
      commandPath,
      cliAvailable: Boolean(commandPath),
      version,
      apiKeyEnv,
      apiKeySet,
      recommendedMode,
      configured: provider.auth.configured || provider.auth.mode !== "auto" || Boolean(provider.command || apiKeyEnv || commandPath),
      notes
    };
  });
}

export function configureLocalAuth(loaded: LoadedConfig, projectName: string): ProviderAuthStatus[] {
  const source = readFileSync(loaded.path, "utf8");
  const document = YAML.parseDocument(source);
  const root = document.toJSON() as Record<string, unknown>;
  const projects = root.projects as Array<Record<string, unknown>>;
  const project = projects.find((item) => item.name === projectName);
  if (!project) throw new Error(`Project not found in raw config: ${projectName}`);

  const typedProject = loaded.config.projects.find((item) => item.name === projectName);
  if (!typedProject) throw new Error(`Project not found: ${projectName}`);

  const statuses = getAuthStatus(typedProject);
  const rawProviders = project.providers as Record<string, Record<string, unknown>>;

  for (const status of statuses) {
    const provider = rawProviders[status.providerName];
    if (!provider) continue;
    // Native structured adapters always resolve their canonical executable from behavioral probe
    // evidence. Persisting a command override would make the newly written config invalid and would
    // bypass that identity gate, so auth setup records only mode/env state for them.
    if (status.commandPath && !provider.command && status.type !== "opencode" && status.type !== "pi" && status.type !== "grok") {
      provider.command = status.command;
    }
    provider.auth = {
      mode: status.recommendedMode,
      env: status.apiKeyEnv,
      configured: status.configured,
      notes: status.notes.join(" ")
    };
  }

  writeFileSync(loaded.path, YAML.stringify(root));
  return statuses;
}

export function hasConfig(path: string): boolean {
  return existsSync(resolve(path));
}

function which(command: string): string | undefined {
  // Use a non-login shell so process.env.PATH is respected. `bash -lc` reloads
  // profile PATH and can prefer ambient developer installs over an intentionally
  // narrowed PATH (tests, release collectors, isolated worktrees).
  const result = spawnSync("bash", ["-c", `command -v ${shellQuote(command)}`], {
    encoding: "utf8",
    env: process.env
  });
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

function readVersion(commandPath: string): string | undefined {
  const result = spawnSync(commandPath, ["--version"], { encoding: "utf8", timeout: 5000 });
  if (result.status !== 0) return undefined;
  return (result.stdout || result.stderr).trim().split("\n")[0];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

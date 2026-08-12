import { cpSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProviderConfig } from "./config/schema.js";
import { canonicalContainedOpenCodeConfigContent } from "./adapters/contained-evidence.js";
import { claudeAdapterDescriptor } from "./adapters/builtins/claude.js";
import { codexAdapterDescriptor } from "./adapters/builtins/codex.js";
import { customAdapterDescriptor } from "./adapters/builtins/custom.js";
import { geminiAdapterDescriptor } from "./adapters/builtins/gemini.js";
import {
  buildOpenCodeConfigOverlay,
  opencodeAdapterDescriptor,
  OPENCODE_CONFIG_CONTENT_ENV
} from "./adapters/builtins/opencode.js";
import { buildPiInvocationArguments, piAdapterDescriptor } from "./adapters/builtins/pi.js";
import {
  buildGrokInvocationArguments,
  buildGrokPrivateEnvironment,
  grokAdapterDescriptor
} from "./adapters/builtins/grok.js";
import type { AdapterDescriptor } from "./adapters/types.js";

export type BuiltinProviderKind = ProviderConfig["type"];

/**
 * The immutable, compile-time set of existing provider descriptors.
 *
 * Values are recursively frozen by `defineAdapterDescriptor`; the record is
 * frozen here as well so configuration can select a shipped contract but can
 * never replace or mutate one.
 */
export const builtinAdapterDescriptors: Readonly<Record<BuiltinProviderKind, AdapterDescriptor>> = Object.freeze({
  claude: claudeAdapterDescriptor,
  codex: codexAdapterDescriptor,
  gemini: geminiAdapterDescriptor,
  custom: customAdapterDescriptor,
  grok: grokAdapterDescriptor,
  opencode: opencodeAdapterDescriptor,
  pi: piAdapterDescriptor
});

/** Select the one shipped descriptor before invoking a legacy behavior state machine. */
export function getBuiltinAdapterDescriptor(provider: BuiltinProviderKind): AdapterDescriptor {
  const descriptor = builtinAdapterDescriptors[provider];
  if (!descriptor) throw new Error(`Unknown built-in provider adapter: ${JSON.stringify(provider)}.`);
  return descriptor;
}

export type ProviderCommand = {
  command: string;
  args: string[];
  /** A COMPLETE, scrubbed environment — callers spawn with this verbatim, never merged over
   *  the parent's `process.env`, so inherited host secrets never reach an agent. */
  env: Record<string, string>;
  /** When set, the caller writes this to the child's STDIN and closes it. For Claude/Codex the
   *  prompt is delivered on stdin (byte 0 is `/goal` for Claude) rather than as an argv the OS
   *  and process table could truncate/expose; argv-only adapters leave this undefined. */
  stdin?: string;
};

/**
 * The contract passed to every provider adapter for a single headless turn.
 *
 * Every adapter receives the SAME four things so behavior is consistent across Claude,
 * Codex, Gemini, and custom commands:
 *  - role:          which team role is acting (planner/implementer/reviewer).
 *  - systemPromptFile / systemPromptText: the role's persistent system prompt, which
 *    already encapsulates the role identity, the project intelligence, and the guardrails.
 *  - task:          the per-turn payload (the task description + iteration context, or the
 *                   review request + diff).
 *  - readOnly:      reviewers run without write/edit capability.
 */
export type AgentRole = "planner" | "implementer" | "reviewer";

export type AgentRequest = {
  role: AgentRole;
  task: string;
  systemPromptFile: string;
  systemPromptText: string;
  readOnly?: boolean;
  /** Parent-created private session directory required by the native Pi RPC adapter. */
  sessionDirectory?: string;
  /** Canonical path of the shipped Pi reviewer helper, required for read-only roles. */
  reviewerHelperPath?: string;
  /** Parent-created private state directory required by stateful native adapters. */
  adapterStateDirectory?: string;
};

/** Claude Code's flag that loads a system prompt from a file (headless). */
export const CLAUDE_SYSTEM_PROMPT_FILE_FLAG = "--append-system-prompt-file";

const VALID_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);

/**
 * Codex reads reasoning effort from a TOML config override passed as `-c <key=value>`. TOML string
 * values MUST be quoted, so the emitted argument is exactly `model_reasoning_effort="high"` (double
 * quotes are part of the TOML value, not shell quoting). An unquoted `model_reasoning_effort=high`
 * is not valid TOML and Codex would reject or ignore it. Effort is validated by `assertSafeArgs`
 * against `VALID_EFFORTS` before this is ever called, so the value is a known safe token.
 */
export function codexEffortConfig(effort: string): string {
  return `model_reasoning_effort="${effort}"`;
}

/**
 * Flags a user must NOT smuggle in through `provider.args`: they would defeat the sandbox /
 * permission / routing / transport contract the orchestrator sets deterministically. Rejected
 * loudly. Every pattern also matches the `--flag=value` equals-form (see `matchesArg`), so a
 * control flag cannot be re-introduced by attaching its value with `=`.
 */
const CONFLICTING_ARGS: Record<ProviderConfig["type"], RegExp[]> = {
  claude: [
    /^--dangerously-skip-permissions$/,
    /^--permission-mode$/,
    /^--allow-dangerously-skip-permissions$/,
    /^--output-format$/,
    /^--input-format$/,
    /^--append-system-prompt(-file)?$/,
    /^--system-prompt(-file)?$/,
    /^--model$/,
    /^--fallback-model$/,
    /^--disable-slash-commands$/,
    /^--session-id$/,
    /^--(no-)?session-persistence$/,
    /^-p$/,
    /^--print$/
  ],
  codex: [/^--sandbox$/, /^-s$/, /^--full-auto$/, /^--dangerously-bypass-approvals-and-sandbox$/, /^--dangerously-bypass-hook-trust$/, /^--effort$/, /^-c$/, /^--config$/, /^--json$/, /^--yolo$/, /^--ephemeral$/, /^--model$/, /^-m$/],
  gemini: [/^--yolo$/, /^--approval-mode$/, /^--output-format$/],
  custom: [],
  opencode: [/.*/],
  pi: [/.*/],
  grok: [/.*/]
};

/** True if `arg` matches `re`, treating a `--flag=value` equals-form the same as `--flag`. */
function matchesArg(re: RegExp, arg: string): boolean {
  if (re.test(arg)) return true;
  const eq = arg.indexOf("=");
  return eq > 0 && re.test(arg.slice(0, eq));
}

/** Reject conflicting/unsafe args the user configured before we build the command. */
export function assertSafeArgs(provider: ProviderConfig): void {
  if (provider.type === "opencode" || provider.type === "pi" || provider.type === "grok") {
    if (provider.command !== undefined) {
      throw new Error(`Provider "${provider.type}" uses only its canonical installed executable; command overrides are forbidden.`);
    }
    if (Object.keys(provider.env).length !== 0) {
      throw new Error(`Provider "${provider.type}" environment is parent-controlled; raw env overrides are forbidden.`);
    }
    if (
      provider.effort !== undefined ||
      provider.systemPromptFlag !== undefined ||
      provider.dangerouslySkipPermissions ||
      provider.yolo ||
      provider.promptMode !== "interactive" ||
      provider.fallbackFor !== undefined
    ) {
      throw new Error(`Provider "${provider.type}" contains an option outside its shipped controlled-option contract.`);
    }
  }
  const patterns = CONFLICTING_ARGS[provider.type] ?? [];
  for (const arg of provider.args) {
    if (patterns.some((re) => matchesArg(re, arg))) {
      throw new Error(
        `Provider "${provider.type}" arg ${JSON.stringify(arg)} conflicts with a setting the orchestrator controls (sandbox/permission/model/routing/output/transport). Remove it; configure via model/effort/safetyMode instead.`
      );
    }
    if (/^-c$/.test(arg) || /model_reasoning_effort/.test(arg)) {
      throw new Error(`Provider "${provider.type}" must not override reasoning effort via raw args; use \`effort:\`.`);
    }
  }
  // An arbitrary `systemPromptFlag` is a transport escape route (it could point Claude at an
  // attacker-chosen flag). Only the canonical append-system-prompt-file flag is permitted.
  if (provider.type === "claude" && provider.systemPromptFlag && provider.systemPromptFlag !== CLAUDE_SYSTEM_PROMPT_FILE_FLAG) {
    throw new Error(
      `Provider "claude" systemPromptFlag ${JSON.stringify(provider.systemPromptFlag)} is not permitted. Remove it; the orchestrator always uses ${CLAUDE_SYSTEM_PROMPT_FILE_FLAG}.`
    );
  }
  if (provider.effort && !VALID_EFFORTS.has(provider.effort)) {
    throw new Error(`Invalid effort ${JSON.stringify(provider.effort)}; use one of: ${[...VALID_EFFORTS].join(", ")}.`);
  }
}

// A minimal, provider-agnostic environment allowlist. Everything else in the parent process
// environment (tokens, CI secrets, cloud credentials) is dropped so it can never leak into an
// agent's context or its shelled-out commands.
const BASE_ENV_ALLOW = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "TERM",
  "TMPDIR",
  "TZ",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME"
];

// Auth-related variables each provider CLI legitimately needs to reach its own backend. Only
// these named variables pass through — never the whole environment.
const PROVIDER_ENV_ALLOW: Record<ProviderConfig["type"], RegExp[]> = {
  claude: [/^ANTHROPIC_API_KEY$/, /^ANTHROPIC_AUTH_TOKEN$/, /^CLAUDE_CODE_[A-Z0-9_]+$/, /^ANTHROPIC_BASE_URL$/, /^ANTHROPIC_MODEL$/],
  codex: [/^OPENAI_API_KEY$/, /^OPENAI_BASE_URL$/, /^CODEX_[A-Z0-9_]+$/, /^OPENAI_ORG(ANIZATION)?$/],
  gemini: [/^GEMINI_API_KEY$/, /^GOOGLE_API_KEY$/, /^GOOGLE_APPLICATION_CREDENTIALS$/, /^GOOGLE_CLOUD_PROJECT$/],
  custom: [],
  opencode: [/^OPENCODE_CONFIG_CONTENT$/],
  pi: [
    /^ANTHROPIC_API_KEY$/,
    /^ANTHROPIC_AUTH_TOKEN$/,
    /^OPENAI_API_KEY$/,
    /^OPENAI_BASE_URL$/,
    /^GEMINI_API_KEY$/,
    /^GOOGLE_API_KEY$/
  ],
  grok: [/^XAI_API_KEY$/]
};

/**
 * Build the COMPLETE, scrubbed environment for a provider turn: a small base allowlist, the
 * provider's own auth variables, whatever the config explicitly sets, and the role markers.
 * Nothing else from `process.env` survives.
 */
export function buildProviderEnv(provider: ProviderConfig, req: AgentRequest, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  // Pi can speak to several model backends, but one turn is allowed to receive exactly the
  // credential selected by its closed `auth.env` field. Passing every ambient provider key would
  // let a Pi tool or compromised runtime read credentials for unrelated adapters. OpenCode carries
  // its selected credential only inside the parent-constructed OPENCODE_CONFIG_CONTENT overlay.
  const providerAllow = provider.type === "pi"
    ? provider.auth?.env === undefined
      ? []
      : [new RegExp(`^${provider.auth.env.replace(/[^A-Za-z0-9_]/g, "")}$`)]
    : PROVIDER_ENV_ALLOW[provider.type] ?? [];
  const allow = [...BASE_ENV_ALLOW.map((n) => new RegExp(`^${n}$`)), ...providerAllow];
  // OpenCode's child contract allows exactly OPENCODE_CONFIG_CONTENT; a selected API key is
  // synthesized INTO that overlay below and never exposed raw to the child.
  if (provider.type !== "pi" && provider.type !== "opencode" && provider.auth?.env) {
    allow.push(new RegExp(`^${provider.auth.env.replace(/[^A-Za-z0-9_]/g, "")}$`));
  }
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if (/^LC_[A-Z]+$/.test(k) || allow.some((re) => re.test(k))) env[k] = v;
  }
  // Config-provided provider env wins over anything inherited.
  for (const [k, v] of Object.entries(provider.env ?? {})) env[k] = v;
  // OpenCode: synthesize the parent-controlled overlay from a linked OpenAI key so the child
  // only ever sees OPENCODE_CONFIG_CONTENT (its descriptor allows no other environment name)
  // while the operator still links a single API key.
  if (provider.type === "opencode" && env[OPENCODE_CONFIG_CONTENT_ENV] === undefined) {
    const keyName = provider.auth?.env ?? "OPENAI_API_KEY";
    const raw = source[keyName];
    if (typeof raw === "string" && raw.length > 0 && !raw.includes("\0") && Buffer.byteLength(raw, "utf8") <= 64 * 1024) {
      env[OPENCODE_CONFIG_CONTENT_ENV] = canonicalContainedOpenCodeConfigContent(raw);
    }
  }
  // Preserve the established marker contract for legacy one-shot adapters. Structured native
  // adapters receive their role/system data on their typed protocol/config channels instead and
  // therefore receive no unrelated RelayForge metadata in their environment.
  if (provider.type !== "opencode" && provider.type !== "pi" && provider.type !== "grok") {
    env.LOOP_ROLE = req.role;
    env.LOOP_READONLY = req.readOnly ? "1" : "0";
    env.LOOP_SYSTEM_PROMPT_FILE = req.systemPromptFile;
  }
  return env;
}

function combinedPrompt(req: AgentRequest): string {
  return `${req.systemPromptText}\n\n---\n\n${req.task}`;
}

/**
 * Build a non-headless (viewport) invocation for a provider — used only to DISPLAY the command
 * a human could run. Kept safe: no host permission bypass, correct Codex sandbox/effort flags.
 */
export function buildProviderCommand(provider: ProviderConfig, promptFile: string): ProviderCommand {
  assertSafeArgs(provider);
  const descriptor = getBuiltinAdapterDescriptor(provider.type);
  const req: AgentRequest = { role: "implementer", task: "", systemPromptFile: promptFile, systemPromptText: "" };
  const env = buildProviderEnv(provider, req);

  if (descriptor.id === "custom") {
    if (!provider.command) throw new Error("Custom provider requires a command.");
    return { command: provider.command, args: provider.args, env };
  }

  if (descriptor.id === "claude") {
    const args = ["--permission-mode", "acceptEdits", ...provider.args];
    if (provider.model) args.push("--model", provider.model);
    if (provider.promptMode === "argument") args.push("-p", `Read ${promptFile} and execute the task.`);
    return { command: provider.command ?? "claude", args, env };
  }

  if (descriptor.id === "codex") {
    const args = ["exec", "--sandbox", "workspace-write", ...provider.args];
    if (provider.model) args.push("--model", provider.model);
    if (provider.effort) args.push("-c", codexEffortConfig(provider.effort));
    if (provider.promptMode === "argument") args.push(`Read ${promptFile} and execute the task.`);
    return { command: provider.command ?? "codex", args, env };
  }

  if (descriptor.id === "opencode" || descriptor.id === "pi" || descriptor.id === "grok") {
    throw new Error(`Provider "${descriptor.id}" is a structured headless adapter and has no interactive viewport command.`);
  }

  const args = [...provider.args];
  if (provider.model) args.push("--model", provider.model);
  return { command: provider.command ?? "gemini", args, env };
}

/**
 * Build a HEADLESS, non-interactive invocation of a provider for a single turn.
 *
 * SECURITY CONTRACT:
 *  - Claude is NEVER given `--dangerously-skip-permissions` by default. Implementers run in
 *    `acceptEdits` (auto-accept edits, no host bypass); reviewers run in `plan` (read-only).
 *    The real containment boundary is the OS sandbox the orchestrator wraps this command in
 *    (see src/sandbox.ts) — bypass is only ever added when explicitly opted in AND sandboxed.
 *  - Codex uses `exec --sandbox read-only|workspace-write` and effort via
 *    `-c model_reasoning_effort=...` (never `--full-auto`/`--effort`/bypass).
 *  - Gemini/custom carry NO provider-native safety claim; their containment is the OS sandbox.
 *  - The returned env is complete and scrubbed — spawn it verbatim.
 */
export function buildHeadlessCommand(
  provider: ProviderConfig,
  req: AgentRequest,
  sourceEnvironment: NodeJS.ProcessEnv = process.env
): ProviderCommand {
  assertSafeArgs(provider);
  const descriptor = getBuiltinAdapterDescriptor(provider.type);
  const env = buildProviderEnv(provider, req, sourceEnvironment);

  if (descriptor.id === "claude") {
    // Always the canonical flag — an arbitrary `systemPromptFlag` override is rejected in
    // assertSafeArgs, so there is no transport escape route here.
    const flag = CLAUDE_SYSTEM_PROMPT_FILE_FLAG;
    // Installed Claude 2.1.207 headless contract: read the prompt from STDIN (`-p` with no inline
    // prompt), streaming structured JSON, no cross-run session state. Byte 0 of stdin is `/goal`
    // for EVERY role. Claude is the model alias `opus` unless a model is pinned.
    const args = [
      "-p",
      "--model",
      provider.model ?? "opus",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      flag,
      req.systemPromptFile
    ];
    if (req.readOnly) {
      args.push("--permission-mode", "plan");
    } else if (provider.dangerouslySkipPermissions) {
      // Explicit opt-in only. Safe solely because the orchestrator runs this inside an OS
      // sandbox with no network and no writable host paths (fails closed if unavailable).
      args.push("--dangerously-skip-permissions");
    } else {
      args.push("--permission-mode", "acceptEdits");
    }
    args.push(...provider.args);
    return { command: provider.command ?? "claude", args, env, stdin: `/goal ${req.task}` };
  }

  if (descriptor.id === "codex") {
    // Installed Codex 0.144.0 headless contract: `exec` reads the prompt from STDIN (`-`), emits
    // JSON, and runs EPHEMERAL (no persisted session). Reasoning effort via TOML `-c` override.
    const args = ["exec", "--sandbox", req.readOnly ? "read-only" : "workspace-write", "--json", "--ephemeral"];
    if (provider.model) args.push("--model", provider.model);
    if (provider.effort) args.push("-c", codexEffortConfig(provider.effort));
    args.push(...provider.args, "-");
    return { command: provider.command ?? "codex", args, env, stdin: combinedPrompt(req) };
  }

  if (descriptor.id === "gemini") {
    const args = ["-p", combinedPrompt(req)];
    if (provider.model) args.push("--model", provider.model);
    // Gemini has no verified provider-native sandbox in this release; containment is the OS
    // sandbox the orchestrator wraps around it. We do NOT pass an "auto-approve" flag.
    args.push("--output-format", "json", ...provider.args);
    return { command: provider.command ?? "gemini", args, env };
  }

  if (descriptor.id === "opencode") {
    const overlay = buildOpenCodeConfigOverlay({
      role: req.readOnly ? "reviewer" : "worker",
      systemPrompt: req.systemPromptText,
      existingConfigContent: env[OPENCODE_CONFIG_CONTENT_ENV]
    });
    return {
      command: "opencode",
      args: [...descriptor.invocationPolicy.fixedArguments],
      env: { ...env, ...overlay }
    };
  }

  if (descriptor.id === "pi") {
    return {
      command: "pi",
      args: [...buildPiInvocationArguments({
        role: req.readOnly ? "reviewer" : "worker",
        sessionDirectory: req.sessionDirectory ?? "",
        ...(req.readOnly ? { reviewerHelperPath: req.reviewerHelperPath } : {}),
        systemPrompt: req.systemPromptText,
        ...(provider.model === undefined ? {} : { model: provider.model })
      })],
      env
    };
  }

  if (descriptor.id === "grok") {
    const stateDirectory = req.adapterStateDirectory ?? "";
    const grokEnv = buildGrokPrivateEnvironment(stateDirectory);
    // Personal xAI subscription: seed the private per-run Grok home from the operator's real
    // login so the still-isolated child can authenticate without an API key (bounded copy; the
    // isolation evidence is untouched). Key-based routes do not seed anything.
    if (stateDirectory !== "" && grokSubscriptionSeedWanted(provider)) {
      seedGrokSubscriptionHome(stateDirectory);
    }
    return {
      command: "grok",
      args: [...buildGrokInvocationArguments({
        role: req.readOnly ? "reviewer" : "worker",
        ...(provider.model === undefined ? {} : { model: provider.model })
      })],
      env: { ...env, ...grokEnv }
    };
  }

  if (!provider.command) throw new Error("Custom provider requires a command.");
  return { command: provider.command, args: [...provider.args, combinedPrompt(req)], env };
}

const GROK_SUBSCRIPTION_MAX_TOTAL_BYTES = 1 * 1024 * 1024;
const GROK_SUBSCRIPTION_MAX_FILE_BYTES = 256 * 1024;

/** True when the provider route should run on the operator's xAI subscription login. */
export function grokSubscriptionSeedWanted(provider: ProviderConfig): boolean {
  if (provider.auth?.mode === "subscription") return true;
  if (provider.auth?.mode === "api-key" || provider.auth?.env !== undefined) return false;
  return process.env.XAI_API_KEY === undefined;
}

/**
 * Bounded copy of the operator's `~/.grok` login directory into the private per-run Grok home.
 * Symlinks are never followed, files are size-capped, and the total budget is 1 MiB — this is
 * credential plumbing, never a rubber-stamp for ambient configuration (managed config still
 * requires key-based billing and the isolation evidence contract unchanged).
 */
export function seedGrokSubscriptionHome(stateDirectory: string): void {
  const realHome = process.env.HOME;
  if (!realHome || realHome.length === 0) return;
  const grokSource = join(realHome, ".grok");
  if (!existsSync(grokSource)) return;
  const grokHome = join(stateDirectory, "grok-home");
  mkdirSync(grokHome, { recursive: true });
  let budget = GROK_SUBSCRIPTION_MAX_TOTAL_BYTES;
  cpSync(grokSource, grokHome, {
    recursive: true,
    dereference: false,
    errorOnExist: false,
    filter: (src: string): boolean => {
      let stats;
      try {
        stats = lstatSync(src);
      } catch {
        return false;
      }
      if (stats.isDirectory()) return true;
      if (!stats.isFile()) return false;
      if (stats.size > GROK_SUBSCRIPTION_MAX_FILE_BYTES) return false;
      budget -= stats.size;
      return budget >= 0;
    }
  });
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function commandToShell(command: ProviderCommand): string {
  const env = Object.entries(command.env).map(([key, value]) => `${key}=${shellQuote(value)}`);
  const args = command.args.map(shellQuote);
  return [...env, command.command, ...args].join(" ");
}

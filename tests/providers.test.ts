import { describe, expect, it } from "vitest";
import {
  assertSafeArgs,
  builtinAdapterDescriptors,
  buildHeadlessCommand,
  buildProviderCommand,
  buildProviderEnv,
  commandToShell,
  CLAUDE_SYSTEM_PROMPT_FILE_FLAG,
  getBuiltinAdapterDescriptor
} from "../src/providers.js";
import { claudeAdapterDescriptor } from "../src/adapters/builtins/claude.js";
import { codexAdapterDescriptor } from "../src/adapters/builtins/codex.js";
import { customAdapterDescriptor } from "../src/adapters/builtins/custom.js";
import { geminiAdapterDescriptor } from "../src/adapters/builtins/gemini.js";
import { opencodeAdapterDescriptor } from "../src/adapters/builtins/opencode.js";
import { piAdapterDescriptor } from "../src/adapters/builtins/pi.js";
import { grokAdapterDescriptor, GROK_FIXED_SAFETY_ENVIRONMENT } from "../src/adapters/builtins/grok.js";
import type { ProviderConfig } from "../src/config/schema.js";

function provider(type: ProviderConfig["type"], extra: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    type,
    args: [],
    dangerouslySkipPermissions: false,
    yolo: false,
    cooldownSeconds: 900,
    promptMode: "interactive",
    env: {},
    auth: { mode: "auto", configured: false },
    ...extra
  } as ProviderConfig;
}

const req = { role: "implementer" as const, task: "TASK: do it", systemPromptFile: "/tmp/role.md", systemPromptText: "SYSTEM PROMPT with guardrails" };

function assertDeepFrozenData(value: unknown, seen = new Set<unknown>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value as Record<string, unknown>)) {
    expect(typeof child).not.toBe("function");
    assertDeepFrozenData(child, seen);
  }
}

describe("built-in provider descriptors", () => {
  it("ships one recursively immutable, data-only descriptor per existing provider", () => {
    expect(Object.keys(builtinAdapterDescriptors)).toEqual(["claude", "codex", "gemini", "custom", "grok", "opencode", "pi"]);
    expect(builtinAdapterDescriptors).toEqual({
      claude: claudeAdapterDescriptor,
      codex: codexAdapterDescriptor,
      gemini: geminiAdapterDescriptor,
      custom: customAdapterDescriptor,
      grok: grokAdapterDescriptor,
      opencode: opencodeAdapterDescriptor,
      pi: piAdapterDescriptor
    });
    expect(getBuiltinAdapterDescriptor("claude")).toBe(claudeAdapterDescriptor);
    expect(getBuiltinAdapterDescriptor("codex")).toBe(codexAdapterDescriptor);
    expect(getBuiltinAdapterDescriptor("gemini")).toBe(geminiAdapterDescriptor);
    expect(getBuiltinAdapterDescriptor("custom")).toBe(customAdapterDescriptor);
    expect(getBuiltinAdapterDescriptor("grok")).toBe(grokAdapterDescriptor);
    expect(getBuiltinAdapterDescriptor("opencode")).toBe(opencodeAdapterDescriptor);
    expect(getBuiltinAdapterDescriptor("pi")).toBe(piAdapterDescriptor);
    assertDeepFrozenData(builtinAdapterDescriptors);
  });

  it("builds only the fixed private Grok ACP recipe", () => {
    const cmd = buildHeadlessCommand(provider("grok", { model: "grok-4.5", auth: { mode: "api-key", env: "XAI_API_KEY", configured: true } }), {
      ...req,
      adapterStateDirectory: "/private/run/grok",
      readOnly: false
    });
    expect(cmd.command).toBe("grok");
    expect(cmd.args).toEqual([
      "--no-auto-update", "--disable-web-search", "--no-subagents", "--no-memory",
      "--permission-mode", "default", "agent", "--no-leader", "--model", "grok-4.5", "stdio"
    ]);
    expect(cmd.args.join(" ")).not.toMatch(/always-approve|yolo|plugin-dir|leader-socket|serve|headless|xai-api-base-url/);
    expect(cmd.env).toMatchObject({
      HOME: "/private/run/grok/home",
      GROK_HOME: "/private/run/grok/grok-home",
      ...GROK_FIXED_SAFETY_ENVIRONMENT
    });
    expect(cmd.stdin).toBeUndefined();

    const reviewer = buildHeadlessCommand(provider("grok", { auth: { mode: "api-key", env: "XAI_API_KEY", configured: true } }), {
      ...req,
      adapterStateDirectory: "/private/run/grok-review",
      role: "reviewer",
      readOnly: true
    });
    expect(reviewer.args).toContain("plan");
    expect(reviewer.args).not.toContain("auto");
  });

  it("binds the exact legacy prompt and normalizer identities without granting new authority", () => {
    expect(claudeAdapterDescriptor.codec.id).toBe("claude-stdin-goal-v1");
    expect(claudeAdapterDescriptor.normalizer.id).toBe("claude-stream-json-2.1.207");
    expect(claudeAdapterDescriptor.compatibility.executableVersion).toEqual({
      scheme: "semver",
      minInclusive: "2.1.207",
      maxExclusive: "2.1.208"
    });
    expect(codexAdapterDescriptor.codec.id).toBe("codex-stdin-combined-v1");
    expect(codexAdapterDescriptor.normalizer.id).toBe("codex-json-0.144.0");
    expect(codexAdapterDescriptor.capabilityPolicy.cost).toBe("unsupported");
    expect(geminiAdapterDescriptor.invocationPolicy.promptTransport).toBe("argv-legacy");
    expect(customAdapterDescriptor.invocationPolicy.promptTransport).toBe("argv-legacy");
    for (const descriptor of [geminiAdapterDescriptor, customAdapterDescriptor]) {
      expect(descriptor.capabilityPolicy.cancellation).toBe("unsupported");
      expect(descriptor.capabilityPolicy["rate-limits"]).toBe("unsupported");
      expect(descriptor.capabilityPolicy["inner-read-only"]).toBe("unsupported");
      expect(descriptor.roles.reviewer).toMatchObject({
        status: "enabled",
        outerSandbox: "required",
        filesystem: "read-only",
        innerReadOnly: "not-required"
      });
    }
  });
});

describe("provider commands (safe contract)", () => {
  it("codex uses --sandbox workspace-write and effort via canonical QUOTED TOML -c", () => {
    const command = buildProviderCommand(provider("codex", { model: "gpt-5.4", effort: "medium" }), "/tmp/prompt.md");
    expect(command.command).toBe("codex");
    expect(command.args.slice(0, 3)).toEqual(["exec", "--sandbox", "workspace-write"]);
    expect(command.args).toContain("-c");
    // TOML string values MUST be quoted: the -c value is exactly model_reasoning_effort="medium",
    // NOT the unquoted (invalid-TOML) fallback string.
    const ci = command.args.indexOf("-c");
    expect(command.args[ci + 1]).toBe('model_reasoning_effort="medium"');
    expect(command.args).not.toContain("model_reasoning_effort=medium");
    expect(command.args).not.toContain("--full-auto");
    expect(command.args).not.toContain("--effort");
  });

  it("claude never gets --dangerously-skip-permissions by default (viewport)", () => {
    const command = buildProviderCommand(provider("claude", { model: "claude-sonnet-4-6" }), "/tmp/prompt.md");
    expect(command.args).not.toContain("--dangerously-skip-permissions");
    expect(command.args.join(" ")).toContain("--permission-mode acceptEdits");
  });

  it("rejects a conflicting --sandbox arg the user tried to smuggle into codex", () => {
    expect(() => assertSafeArgs(provider("codex", { args: ["--sandbox", "danger-full-access"] }))).toThrow(/conflicts/);
  });

  it("rejects --dangerously-skip-permissions smuggled into claude args", () => {
    expect(() => buildProviderCommand(provider("claude", { args: ["--dangerously-skip-permissions"] }), "/tmp/p.md")).toThrow(/conflicts/);
  });

  it("rejects an invalid effort value", () => {
    expect(() => assertSafeArgs(provider("codex", { effort: "ultra" }))).toThrow(/Invalid effort/);
  });

  it("accepts xhigh effort and emits it as quoted TOML", () => {
    const p = provider("codex", { model: "gpt-5.6-luna", effort: "xhigh" });
    expect(() => assertSafeArgs(p)).not.toThrow();
    const command = buildProviderCommand(p, "/tmp/prompt.md");
    const ci = command.args.indexOf("-c");
    expect(command.args[ci + 1]).toBe('model_reasoning_effort="xhigh"');
  });

  it("rejects equals-form control flags that try to bypass the deterministic contract", () => {
    for (const arg of ["--permission-mode=plan", "--model=evil", "--output-format=text", "--fallback-model=gemini", "--append-system-prompt=x"]) {
      expect(() => assertSafeArgs(provider("claude", { args: [arg] }))).toThrow(/conflicts/);
    }
    // Space-form still rejected too.
    for (const arg of ["--fallback-model", "--disable-slash-commands", "--model", "-p"]) {
      expect(() => assertSafeArgs(provider("claude", { args: [arg] }))).toThrow(/conflicts/);
    }
  });

  it("rejects codex model/ephemeral/config smuggling", () => {
    for (const arg of ["--model", "-m", "--ephemeral", "--config=foo", "--json"]) {
      expect(() => assertSafeArgs(provider("codex", { args: [arg] }))).toThrow(/conflicts/);
    }
  });

  it("rejects an arbitrary claude systemPromptFlag override (transport escape route)", () => {
    expect(() => assertSafeArgs(provider("claude", { systemPromptFlag: "--evil-flag" }))).toThrow(/systemPromptFlag/);
    // The canonical flag is fine.
    expect(() => assertSafeArgs(provider("claude", { systemPromptFlag: CLAUDE_SYSTEM_PROMPT_FILE_FLAG }))).not.toThrow();
  });

  it("quotes shell arguments safely", () => {
    const shell = commandToShell({ command: "custom-agent", args: ["--task", "fix user's bug"], env: { TOKEN: "abc'123" } });
    expect(shell).toContain("TOKEN='abc'\\''123'");
    expect(shell).toContain("'fix user'\\''s bug'");
  });
});

describe("headless provider contract", () => {
  it("preserves byte-for-byte command, argv, and prompt serialization for every descriptor", () => {
    const combined = "SYSTEM PROMPT with guardrails\n\n---\n\nTASK: do it";
    const claude = buildHeadlessCommand(
      provider("claude", { command: "claude-bin", model: "claude-opus-4", args: ["--max-turns", "7"] }),
      req
    );
    expect({ command: claude.command, args: claude.args, stdin: claude.stdin }).toEqual({
      command: "claude-bin",
      args: [
        "-p",
        "--model",
        "claude-opus-4",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--append-system-prompt-file",
        "/tmp/role.md",
        "--permission-mode",
        "acceptEdits",
        "--max-turns",
        "7"
      ],
      stdin: "/goal TASK: do it"
    });

    const codex = buildHeadlessCommand(
      provider("codex", { command: "codex-bin", model: "gpt-5.4", effort: "high", args: ["--skip-git-repo-check"] }),
      req
    );
    expect({ command: codex.command, args: codex.args, stdin: codex.stdin }).toEqual({
      command: "codex-bin",
      args: [
        "exec",
        "--sandbox",
        "workspace-write",
        "--json",
        "--ephemeral",
        "--model",
        "gpt-5.4",
        "-c",
        'model_reasoning_effort="high"',
        "--skip-git-repo-check",
        "-"
      ],
      stdin: combined
    });

    const gemini = buildHeadlessCommand(
      provider("gemini", { command: "gemini-bin", model: "gemini-2.5-pro", args: ["--debug"] }),
      req
    );
    expect({ command: gemini.command, args: gemini.args, stdin: gemini.stdin }).toEqual({
      command: "gemini-bin",
      args: ["-p", combined, "--model", "gemini-2.5-pro", "--output-format", "json", "--debug"],
      stdin: undefined
    });

    const custom = buildHeadlessCommand(provider("custom", { command: "./agent.sh", args: ["--stdio"] }), req);
    expect({ command: custom.command, args: custom.args, stdin: custom.stdin }).toEqual({
      command: "./agent.sh",
      args: ["--stdio", combined],
      stdin: undefined
    });
  });

  it("preserves exact reviewer read-only argument serialization", () => {
    const reviewer = { ...req, role: "reviewer" as const, readOnly: true };
    expect(buildHeadlessCommand(provider("claude"), reviewer).args).toEqual([
      "-p",
      "--model",
      "opus",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--append-system-prompt-file",
      "/tmp/role.md",
      "--permission-mode",
      "plan"
    ]);
    expect(buildHeadlessCommand(provider("codex"), reviewer).args).toEqual([
      "exec",
      "--sandbox",
      "read-only",
      "--json",
      "--ephemeral",
      "-"
    ]);
  });

  it("claude uses the installed 2.1.207 stdin contract with byte-0 /goal for every role", () => {
    const cmd = buildHeadlessCommand(provider("claude"), req);
    // The prompt is delivered on STDIN, byte 0 is `/goal` — NOT as an argv.
    expect(cmd.stdin?.startsWith("/goal ")).toBe(true);
    expect(cmd.stdin).toContain("TASK: do it");
    // `-p` (print mode) is present but WITHOUT an inline prompt arg — Claude reads stdin instead.
    expect(cmd.args[0]).toBe("-p");
    expect(cmd.args[1]).toBe("--model");
    // The exact supported flag contract.
    expect(cmd.args.join(" ")).toContain("--model opus");
    expect(cmd.args.join(" ")).toContain("--output-format stream-json");
    expect(cmd.args).toContain("--verbose");
    expect(cmd.args).toContain("--no-session-persistence");
    expect(cmd.args).toContain(CLAUDE_SYSTEM_PROMPT_FILE_FLAG);
    expect(cmd.args[cmd.args.indexOf(CLAUDE_SYSTEM_PROMPT_FILE_FLAG) + 1]).toBe("/tmp/role.md");
    expect(cmd.args).not.toContain("--dangerously-skip-permissions");
    expect(cmd.args.join(" ")).toContain("--permission-mode acceptEdits");
    expect(cmd.env.LOOP_ROLE).toBe("implementer");
    expect(cmd.env.LOOP_READONLY).toBe("0");
  });

  it("EVERY Claude role (planner/reviewer too) starts stdin with /goal at byte 0", () => {
    for (const role of ["planner", "reviewer", "implementer"] as const) {
      const cmd = buildHeadlessCommand(provider("claude"), { ...req, role, readOnly: role !== "implementer" });
      expect(cmd.stdin?.indexOf("/goal")).toBe(0);
    }
  });

  it("claude only adds --dangerously-skip-permissions on explicit opt-in", () => {
    const cmd = buildHeadlessCommand(provider("claude", { dangerouslySkipPermissions: true }), req);
    expect(cmd.args).toContain("--dangerously-skip-permissions");
    expect(cmd.args.join(" ")).not.toContain("acceptEdits");
  });

  it("a read-only reviewer runs claude in plan mode with no write bypass", () => {
    const cmd = buildHeadlessCommand(provider("claude"), { ...req, role: "reviewer", readOnly: true });
    expect(cmd.args.join(" ")).toContain("--permission-mode plan");
    expect(cmd.args).not.toContain("--dangerously-skip-permissions");
    expect(cmd.env.LOOP_READONLY).toBe("1");
  });

  it("codex uses exec --sandbox …, --json --ephemeral, and reads the prompt from stdin (-)", () => {
    const write = buildHeadlessCommand(provider("codex"), req);
    expect(write.args.slice(0, 3)).toEqual(["exec", "--sandbox", "workspace-write"]);
    expect(write.args).not.toContain("--full-auto");
    expect(write.args).toContain("--json");
    expect(write.args).toContain("--ephemeral");
    // The prompt comes on STDIN; argv ends with the `-` stdin marker, not the prompt text.
    expect(write.args[write.args.length - 1]).toBe("-");
    expect(write.stdin).toContain("SYSTEM PROMPT with guardrails");
    const read = buildHeadlessCommand(provider("codex"), { ...req, readOnly: true });
    expect(read.args.slice(0, 3)).toEqual(["exec", "--sandbox", "read-only"]);
  });

  it("gemini/custom carry the full contract but claim NO auto-approve safety flag", () => {
    const gemini = buildHeadlessCommand(provider("gemini"), req);
    expect(gemini.args).not.toContain("--approval-mode");
    expect(gemini.args).not.toContain("--yolo");
    expect(gemini.args.join("\n")).toContain("SYSTEM PROMPT with guardrails");
    const custom = buildHeadlessCommand(provider("custom", { command: "./agent.sh" }), req);
    expect(custom.command).toBe("./agent.sh");
    expect(custom.args[custom.args.length - 1]).toContain("TASK: do it");
    expect(custom.env.LOOP_ROLE).toBe("implementer");
  });
});

describe("environment scrub (no inherited secrets)", () => {
  it("drops host secrets and keeps only the allowlist + provider auth + config env", () => {
    const source = {
      PATH: "/usr/bin",
      HOME: "/home/x",
      AWS_SECRET_ACCESS_KEY: "leakme",
      GITHUB_TOKEN: "ghp_leak",
      OPENAI_API_KEY: "sk-openai",
      ANTHROPIC_API_KEY: "sk-anthropic",
      RANDOM_CI_SECRET: "nope"
    } as NodeJS.ProcessEnv;

    const claudeEnv = buildProviderEnv(provider("claude", { env: { CUSTOM: "1" } }), req, source);
    expect(claudeEnv.PATH).toBe("/usr/bin");
    expect(claudeEnv.ANTHROPIC_API_KEY).toBe("sk-anthropic");
    expect(claudeEnv.CUSTOM).toBe("1");
    expect(claudeEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(claudeEnv.GITHUB_TOKEN).toBeUndefined();
    expect(claudeEnv.RANDOM_CI_SECRET).toBeUndefined();
    // Claude must not receive the OpenAI key (only its own provider auth).
    expect(claudeEnv.OPENAI_API_KEY).toBeUndefined();

    const codexEnv = buildProviderEnv(provider("codex"), req, source);
    expect(codexEnv.OPENAI_API_KEY).toBe("sk-openai");
    expect(codexEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(codexEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it("gives each native adapter only its exact selected credential/config surface", () => {
    const source = {
      PATH: "/usr/bin",
      HOME: "/home/host",
      OPENAI_API_KEY: "openai-only",
      ANTHROPIC_API_KEY: "anthropic-only",
      GEMINI_API_KEY: "gemini-forbidden",
      GOOGLE_API_KEY: "google-forbidden",
      XAI_API_KEY: "xai-only",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        model: "openai/gpt-5.4",
        provider: { openai: { options: { apiKey: "inline-openai-only" } } }
      }),
      GITHUB_TOKEN: "forbidden"
    } as NodeJS.ProcessEnv;

    const pi = buildHeadlessCommand(provider("pi", {
      auth: { mode: "api-key", env: "ANTHROPIC_API_KEY", configured: true }
    }), { ...req, sessionDirectory: "/private/pi" }, source);
    expect(pi.env.ANTHROPIC_API_KEY).toBe("anthropic-only");
    for (const name of ["OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "XAI_API_KEY", "OPENCODE_CONFIG_CONTENT", "LOOP_ROLE"]) {
      expect(pi.env[name]).toBeUndefined();
    }

    const piWithoutSelection = buildHeadlessCommand(provider("pi"), {
      ...req,
      sessionDirectory: "/private/pi-unconfigured"
    }, source);
    for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "XAI_API_KEY"]) {
      expect(piWithoutSelection.env[name]).toBeUndefined();
    }

    const grok = buildHeadlessCommand(provider("grok", {
      auth: { mode: "api-key", env: "XAI_API_KEY", configured: true }
    }), { ...req, adapterStateDirectory: "/private/grok" }, source);
    expect(grok.env.XAI_API_KEY).toBe("xai-only");
    for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENCODE_CONFIG_CONTENT", "LOOP_ROLE"]) {
      expect(grok.env[name]).toBeUndefined();
    }

    const opencode = buildHeadlessCommand(provider("opencode"), req, source);
    expect(JSON.parse(opencode.env.OPENCODE_CONFIG_CONTENT!)).toMatchObject({
      model: "openai/gpt-5.4",
      provider: { openai: { options: { apiKey: "inline-openai-only" } } }
    });
    for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "XAI_API_KEY", "LOOP_ROLE"]) {
      expect(opencode.env[name]).toBeUndefined();
    }
  });
});

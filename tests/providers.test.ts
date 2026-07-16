import { describe, expect, it } from "vitest";
import {
  assertSafeArgs,
  buildHeadlessCommand,
  buildProviderCommand,
  buildProviderEnv,
  commandToShell,
  CLAUDE_SYSTEM_PROMPT_FILE_FLAG
} from "../src/providers.js";
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
});

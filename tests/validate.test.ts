import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { RootConfigSchema } from "../src/config/schema.js";
import { validateConfigSemantics, validateProjectSemantics } from "../src/config/validate.js";
import { assertBudgetContract } from "../src/cost.js";
import { normalizeStarterProjectName, starterConfig, type StarterProvider } from "../src/starter.js";

function parseProject(yaml: string) {
  const parsed = RootConfigSchema.parse(YAML.parse(yaml));
  return parsed.projects[0];
}

function loadedFrom(yaml: string, rootDir = "/home/project") {
  return { config: RootConfigSchema.parse(YAML.parse(yaml)), path: `${rootDir}/loop.config.yaml`, rootDir };
}

describe("starter config", () => {
  for (const provider of ["claude", "codex", "gemini", "custom"] as StarterProvider[]) {
    it(`emits YAML that parses and passes schema + semantics (${provider})`, () => {
      const yaml = starterConfig(provider);
      const project = parseProject(yaml);
      // Lean team: planner, implementer, reviewer.
      expect(project.roles.map((r) => r.name)).toEqual(["planner", "implementer", "reviewer"]);
      // Only the Claude routing alias `opus` may be pinned; never an unsafe flag.
      for (const p of Object.values(project.providers)) {
        expect(p.model === undefined || p.model === "opus").toBe(true);
        expect(p.dangerouslySkipPermissions).toBe(false);
        expect(p.yolo).toBe(false);
      }
      expect(validateProjectSemantics(project)).toEqual([]);
    });
  }

  it("normalizes discovered package/repository names into safe, recognizable project ids", () => {
    expect(normalizeStarterProjectName("@acme/coding app")).toBe("acme-coding-app");
    expect(normalizeStarterProjectName("../../unsafe")).toBe("unsafe");
    expect(normalizeStarterProjectName("🔥")).toBe("project");
    expect(parseProject(starterConfig("codex", [], true, "@acme/coding app")).name).toBe("acme-coding-app");
  });
});

describe("starter config: the auto-wired routing chain", () => {
  // README/init promise: with BOTH the claude and codex CLIs installed, `loop init` wires an `opus`
  // Claude primary plus a `gpt` Codex provider with `fallbackFor: opus`, so Codex covers a Claude
  // usage limit and Opus is retried after the cooldown. This is the product's headline routing claim
  // and no test constructed it: every existing case called `starterConfig(provider)` with the 1-arg
  // form, so `detected` was always `[]` and the chain branch was never even parsed.
  it("both CLIs installed → opus primary + gpt codex fallbackFor: opus, schema- and semantics-valid", () => {
    const yaml = starterConfig("claude", ["claude", "codex"], false);
    const project = parseProject(yaml);

    expect(project.providers.opus?.type).toBe("claude");
    expect(project.providers.opus?.model).toBe("opus");
    expect(project.providers.gpt?.type).toBe("codex");
    expect(project.providers.gpt?.fallbackFor).toBe("opus");
    // Every role runs on the Opus primary; the fallback is a route, not a role.
    expect(project.roles.map((r) => r.provider)).toEqual(["opus", "opus", "opus"]);
    // The chain the router will actually build from this config must be valid — a `fallbackFor` that
    // the semantic rules reject would make `loop init` emit a config `loop validate` refuses, on
    // exactly the machine the README targets.
    expect(validateProjectSemantics(project)).toEqual([]);
    // No unsafe defaults sneak in with the chain.
    for (const p of Object.values(project.providers)) {
      expect(p.dangerouslySkipPermissions).toBe(false);
      expect(p.yolo).toBe(false);
    }
  });

  it("an explicit --provider override does NOT wire a fallback chain", () => {
    const project = parseProject(starterConfig("claude", ["claude", "codex"], true));
    expect(Object.values(project.providers).some((p) => p.fallbackFor)).toBe(false);
    expect(validateProjectSemantics(project)).toEqual([]);
  });

  it("claude alone (no codex installed) → no fallback provider", () => {
    const project = parseProject(starterConfig("claude", ["claude"], false));
    expect(Object.values(project.providers).some((p) => p.fallbackFor)).toBe(false);
    expect(validateProjectSemantics(project)).toEqual([]);
  });
});

describe("semantic validation", () => {
  it("flags an unknown provider reference", () => {
    const project = parseProject(`version: 1
projects:
  - name: demo
    providers: { dev: { type: codex } }
    roles:
      - { name: dev, title: Dev, provider: nope }
`);
    const issues = validateProjectSemantics(project);
    expect(issues.some((i) => i.message.includes("unknown provider"))).toBe(true);
  });

  it("flags a loop whose reviewer equals its orchestrator", () => {
    const project = parseProject(`version: 1
projects:
  - name: demo
    providers: { dev: { type: codex } }
    roles:
      - { name: a, title: A, provider: dev }
      - { name: b, title: B, provider: dev }
    loops:
      - { name: l, orchestrator: a, reviewer: a }
`);
    const issues = validateProjectSemantics(project);
    expect(issues.some((i) => i.message.includes("independent"))).toBe(true);
  });

  it("rejects a non-Codex provider declaring fallbackFor", () => {
    const project = parseProject(`version: 1
projects:
  - name: demo
    providers:
      opus: { type: claude }
      g: { type: gemini, fallbackFor: opus }
    roles:
      - { name: dev, title: Dev, provider: opus }
`);
    const issues = validateProjectSemantics(project);
    expect(issues.some((i) => i.message.includes("only a Codex provider"))).toBe(true);
  });

  it("rejects a fallback that targets a non-Claude primary or is self/unknown", () => {
    const project = parseProject(`version: 1
projects:
  - name: demo
    providers:
      gpt: { type: codex, fallbackFor: gpt }
      gpt2: { type: codex, fallbackFor: nope }
    roles:
      - { name: dev, title: Dev, provider: gpt }
`);
    const issues = validateProjectSemantics(project);
    expect(issues.some((i) => i.message.includes("cannot be its own fallback"))).toBe(true);
    expect(issues.some((i) => i.message.includes("unknown provider"))).toBe(true);
  });

  it("rejects configured paths that ESCAPE the project root (runDir/workingDir/promptDir/intelligence/brief)", () => {
    // Regression for the wave-7 live P0: `runDir: ../...` and `workingDir: ../...` escaped the
    // project root and redirected run state / the workspace outside the owned tree.
    const escaping = validateConfigSemantics(
      loadedFrom(`version: 1
defaults:
  runDir: ../../var/loop
  promptDir: ../prompts
projects:
  - name: demo
    workingDir: ../../../etc
    intelligence: ../secret.md
    brief: /etc/passwd
    providers: { dev: { type: codex } }
    roles:
      - { name: dev, title: Dev, provider: dev }
`)
    );
    const msgs = escaping.map((i) => `${i.path}: ${i.message}`).join("\n");
    expect(escaping.some((i) => i.path === "defaults.runDir")).toBe(true);
    expect(escaping.some((i) => i.path === "defaults.promptDir")).toBe(true);
    expect(escaping.some((i) => i.path.endsWith("workingDir"))).toBe(true);
    expect(escaping.some((i) => i.path.endsWith("intelligence"))).toBe(true);
    expect(escaping.some((i) => i.path.endsWith("brief"))).toBe(true); // absolute path outside root
    expect(msgs).toMatch(/escapes the project root/);
  });

  it("accepts in-root configured paths (`.`, nested dirs)", () => {
    const ok = validateConfigSemantics(
      loadedFrom(`version: 1
defaults:
  runDir: .loop/runs
  promptDir: .loop/prompts
projects:
  - name: demo
    workingDir: .
    intelligence: PROJECT-INTELLIGENCE.md
    brief: docs/brief.md
    providers: { dev: { type: codex } }
    roles:
      - { name: dev, title: Dev, provider: dev }
`)
    );
    expect(ok.filter((i) => /escapes the project root/.test(i.message))).toEqual([]);
  });

  it("rejects multi-repository execution precisely", () => {
    const project = parseProject(`version: 1
projects:
  - name: demo
    repositories: [{ name: app, path: ./app }]
    providers: { dev: { type: codex } }
    roles:
      - { name: dev, title: Dev, provider: dev }
`);
    const issues = validateProjectSemantics(project);
    expect(issues.some((i) => i.message.includes("multi-repository"))).toBe(true);
  });

  it("rejects `yolo: true` precisely instead of silently ignoring it", () => {
    // `yolo` was a DEAD field: the docs described it as a working Codex bypass opt-in, the schema
    // accepted it, and nothing in the product ever read it. Silently ignoring a safety-relevant
    // switch is the worst outcome — the operator believes they turned something on. Not supported
    // means REJECTED, with the fix in the message.
    const project = parseProject(`version: 1
projects:
  - name: demo
    providers: { dev: { type: codex, yolo: true } }
    roles:
      - { name: dev, title: Dev, provider: dev }
`);
    const issues = validateProjectSemantics(project);
    const issue = issues.find((i) => i.path.endsWith("providers.dev.yolo"));
    expect(issue).toBeDefined();
    expect(issue?.message).toMatch(/not supported|no effect/i);
    // …and `yolo: false` (the value `loop init` emits) is of course fine.
    expect(
      validateProjectSemantics(
        parseProject(`version: 1
projects:
  - name: demo
    providers: { dev: { type: codex, yolo: false } }
    roles:
      - { name: dev, title: Dev, provider: dev }
`)
      )
    ).toEqual([]);
  });

  it("rejects duplicate project, role, and loop names", () => {
    const dupRoleLoop = parseProject(`version: 1
projects:
  - name: demo
    providers: { dev: { type: codex }, rev: { type: claude } }
    roles:
      - { name: dev, title: Dev, provider: dev }
      - { name: dev, title: Dev again, provider: rev }
      - { name: rev, title: Rev, provider: rev }
    loops:
      - { name: build, orchestrator: dev, reviewer: rev }
      - { name: build, orchestrator: dev, reviewer: rev }
`);
    const issues = validateProjectSemantics(dupRoleLoop);
    expect(issues.some((i) => /duplicate role name "dev"/.test(i.message))).toBe(true);
    expect(issues.some((i) => /duplicate loop name "build"/.test(i.message))).toBe(true);

    const dupProject = validateConfigSemantics(
      loadedFrom(`version: 1
projects:
  - name: demo
    providers: { dev: { type: codex } }
    roles: [{ name: dev, title: Dev, provider: dev }]
  - name: demo
    providers: { dev: { type: codex } }
    roles: [{ name: dev, title: Dev, provider: dev }]
`)
    );
    expect(dupProject.some((i) => /duplicate project name "demo"/.test(i.message))).toBe(true);
  });

  it("flags a loop whose orchestrator or reviewer names a role that does not exist", () => {
    const project = parseProject(`version: 1
projects:
  - name: demo
    providers: { dev: { type: codex } }
    roles: [{ name: dev, title: Dev, provider: dev }, { name: rev, title: Rev, provider: dev }]
    loops:
      - { name: build, orchestrator: ghost, reviewer: phantom }
`);
    const issues = validateProjectSemantics(project);
    expect(issues.some((i) => /orchestrator references unknown role "ghost"/.test(i.message))).toBe(true);
    expect(issues.some((i) => /reviewer references unknown role "phantom"/.test(i.message))).toBe(true);
  });
});

/**
 * The SHIPPED examples are documentation that executes. `loop validate` passing is not enough to
 * make one runnable: the todo-app example carried `budgetUsd: 4.0` with no `maxCostPerCallUsd`, which
 * validates cleanly and then fails CLOSED before the planner ever runs — while its README told people
 * this was "exactly what produced this app". An example a reader cannot run is a broken promise, so
 * every example must clear BOTH gates the real CLI puts in front of `--execute`.
 */
describe("every shipped example config is actually runnable", () => {
  const examples = readdirSync(resolve(import.meta.dirname, "../examples"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  it("finds the examples (so this suite can never pass by iterating nothing)", () => {
    expect(examples.length).toBeGreaterThanOrEqual(3);
  });

  for (const name of examples) {
    it(`examples/${name}: passes schema + semantics AND the budget contract`, () => {
      const dir = resolve(import.meta.dirname, "../examples", name);
      const yaml = readFileSync(resolve(dir, "loop.config.yaml"), "utf8");
      const config = RootConfigSchema.parse(YAML.parse(yaml));

      expect(validateConfigSemantics({ config, path: resolve(dir, "loop.config.yaml"), rootDir: dir })).toEqual([]);

      for (const project of config.projects) {
        const gatewayCapable = Object.values(project.providers).map((p) => p.preauthorizingGateway === true);
        for (const loop of project.loops) {
          // The same call `runAutonomyLoop` makes before planning. An error string here means a user
          // following the example's own README gets `blocked` instead of a run.
          expect(assertBudgetContract(loop, gatewayCapable)).toBeUndefined();
        }
      }
    });
  }
});

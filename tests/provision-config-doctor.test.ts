import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RootConfigSchema, type LoopConfig } from "../src/config/schema.js";
import { validateProjectSemantics } from "../src/config/validate.js";
import { runDoctor } from "../src/doctor.js";
import { registerOwnedTemp } from "./global-teardown.js";

function provisionProject(provision: unknown) {
  return RootConfigSchema.parse({
    version: 1,
    projects: [
      {
        name: "demo",
        providers: { dev: { type: "codex" } },
        roles: [
          { name: "pm", title: "Planner", provider: "dev" },
          { name: "qa", title: "Reviewer", provider: "dev" }
        ],
        loops: [{ name: "delivery", orchestrator: "pm", reviewer: "qa", provision }]
      }
    ]
  }).projects[0];
}

function semanticProvisionIssues(provision: unknown) {
  return validateProjectSemantics(provisionProject(provision)).filter((issue) => issue.path.includes(".provision"));
}

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "loop-provision-doctor-"));
  registerOwnedTemp(dir);
  return dir;
}

function loadedFor(dir: string, loops: Array<Pick<LoopConfig, "name"> & { provision?: unknown }>) {
  const config = RootConfigSchema.parse({
    version: 1,
    projects: [
      {
        name: "demo",
        workingDir: ".",
        providers: { dev: { type: "codex" } },
        roles: [
          { name: "pm", title: "Planner", provider: "dev" },
          { name: "qa", title: "Reviewer", provider: "dev" }
        ],
        loops: loops.map((loop) => ({ ...loop, orchestrator: "pm", reviewer: "qa" }))
      }
    ]
  });
  return { config, rootDir: dir, path: join(dir, "loop.config.yaml") };
}

function provisionCheck(dir: string, loops: Array<Pick<LoopConfig, "name"> & { provision?: unknown }>) {
  return runDoctor(loadedFor(dir, loops), dir).checks.find((check) => check.name === "provision");
}

function treeEntries(root: string, prefix = ""): string[] {
  const entries: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    entries.push(`${entry.isDirectory() ? "d" : entry.isSymbolicLink() ? "l" : "f"}:${relative}`);
    if (entry.isDirectory()) entries.push(...treeEntries(root, relative));
  }
  return entries.sort();
}

describe("provision configuration", () => {
  it("defaults to an empty plan and keeps every spec strict and bounded", () => {
    const project = provisionProject(undefined);
    expect(project.loops[0].provision).toEqual([]);

    expect(() => provisionProject([{ path: "node_modules", extra: true }])).toThrow(/unrecognized|extra/i);
    expect(() => provisionProject(["node_modules"])).toThrow();
    expect(() => provisionProject(Array.from({ length: 33 }, (_, index) => ({ path: `deps-${index}` })))).toThrow(/32/);
    expect(() => provisionProject([{ path: "" }])).toThrow(/empty/i);
    expect(() => provisionProject([{ path: "node_modules", requiredExecutables: Array.from({ length: 65 }, () => "bin/tool") }])).toThrow(/64/);
  });

  it.each([
    ".",
    "./node_modules",
    "node_modules/",
    "node_modules//typescript",
    "node_modules/./typescript",
    "../node_modules",
    "packages/../node_modules",
    "/tmp/node_modules",
    "C:/node_modules",
    "C:\\node_modules",
    "C:node_modules",
    "\\node_modules",
    "\\\\server\\share",
    "node_modules\\typescript",
    ".git",
    ".git/config",
    ".GIT",
    ".git.",
    ".git ",
    ".loop",
    ".loop/runs",
    "vendor/.loop/cache",
    "node\u0000modules",
    "node\u001fmodules"
  ])("rejects the unsafe/noncanonical cross-platform provision path %j", (path) => {
    const issues = semanticProvisionIssues([{ path }]);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((issue) => issue.path === "projects.demo.loops.delivery.provision.0.path")).toBe(true);
  });

  it.each([
    ["exact duplicate", [{ path: "node_modules" }, { path: "node_modules" }]],
    ["case-folded alias", [{ path: "node_modules" }, { path: "NODE_MODULES" }]],
    ["nested overlap", [{ path: "vendor" }, { path: "vendor/cache" }]],
    ["reverse nested overlap", [{ path: "vendor/cache" }, { path: "vendor" }]]
  ])("rejects %s specs and maps every issue to a concrete spec field", (_label, provision) => {
    const issues = semanticProvisionIssues(provision);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((issue) => /^projects\.demo\.loops\.delivery\.provision\.\d+\.path$/.test(issue.path))).toBe(true);
  });

  it.each([
    ".",
    "./bin/tool",
    "bin/tool/",
    "bin//tool",
    "bin/./tool",
    "../tool",
    "bin/../tool",
    "/bin/tool",
    "C:/bin/tool",
    "C:\\bin\\tool",
    "C:bin/tool",
    "\\bin\\tool",
    "\\\\server\\tool",
    "bin\\tool",
    ".git/tool",
    ".loop/tool",
    "bin\u0000tool",
    "bin\u001ftool"
  ])("rejects unsafe required executable path %j at the exact marker", (executable) => {
    const issues = semanticProvisionIssues([{ path: "node_modules", requiredExecutables: [executable] }]);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((issue) => issue.path === "projects.demo.loops.delivery.provision.0.requiredExecutables.0")).toBe(true);
  });
});

describe("provision doctor check", () => {
  it("always reports disabled provisioning as healthy", () => {
    const dir = workspace();
    expect(provisionCheck(dir, [{ name: "delivery" }])).toEqual({
      name: "provision",
      status: "ok",
      detail: expect.stringMatching(/disabled/i)
    });
  });

  it("reports a ready source and executable marker without executing it", () => {
    const dir = workspace();
    const marker = join(dir, "node_modules", ".bin", "tool");
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(marker, "#!/bin/sh\nexit 97\n");
    chmodSync(marker, 0o755);

    const check = provisionCheck(dir, [
      { name: "delivery", provision: [{ path: "node_modules", requiredExecutables: [".bin/tool"] }] }
    ]);

    expect(check?.status).toBe("ok");
    expect(check?.detail).toMatch(/delivery.*node_modules/i);
    expect(check?.detail).toContain("provision.0.path (node_modules)");
  });

  it.each([
    ["ESC and BEL", `deps\u001b\u0007cache`, "deps\\u{1b}\\u{7}cache", "INVALID_PATH", "Provision path contains a NUL or control byte"],
    ["newline", `deps\ncache`, "deps\\u{a}cache", "INVALID_PATH", "Provision path contains a NUL or control byte"],
    ["C1 CSI", `deps\u009bcache`, "deps\\u{9b}cache", "MISSING_SOURCE", "Configured provision source is missing"],
    ["bidi override and isolate", `deps\u202ecache\u2066x`, "deps\\u{202e}cache\\u{2066}x", "MISSING_SOURCE", "Configured provision source is missing"],
    ["line and paragraph separators", `deps\u2028cache\u2029x`, "deps\\u{2028}cache\\u{2029}x", "MISSING_SOURCE", "Configured provision source is missing"]
  ])("renders configured %s controls as visible ASCII without losing diagnostic context", (_label, path, rendered, code, message) => {
    const dir = workspace();
    const check = provisionCheck(dir, [{ name: "delivery", provision: [{ path }] }]);

    expect(check?.status).toBe("fail");
    expect(check?.detail).toBe(`loop delivery path ${rendered} provision.0.path: [${code}] ${message}`);
    expect(check?.detail).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(check?.fix).toContain("loop.config.yaml");
  });

  it("fails for missing, non-directory, linked, and missing executable sources with actionable loop/path detail", () => {
    const missingRoot = workspace();
    const missing = provisionCheck(missingRoot, [{ name: "missing-loop", provision: [{ path: "node_modules" }] }]);
    expect(missing?.status).toBe("fail");
    expect(missing?.detail).toMatch(/missing-loop.*node_modules.*MISSING_SOURCE/i);
    expect(missing?.fix).toMatch(/restore|source directory/i);

    const fileRoot = workspace();
    writeFileSync(join(fileRoot, "vendor"), "not a directory");
    const nonDirectory = provisionCheck(fileRoot, [{ name: "file-loop", provision: [{ path: "vendor" }] }]);
    expect(nonDirectory?.status).toBe("fail");
    expect(nonDirectory?.detail).toMatch(/file-loop.*vendor/i);

    const linkRoot = workspace();
    const external = workspace();
    mkdirSync(join(external, "deps"));
    symlinkSync(join(external, "deps"), join(linkRoot, "node_modules"));
    const linked = provisionCheck(linkRoot, [{ name: "link-loop", provision: [{ path: "node_modules" }] }]);
    expect(linked?.status).toBe("fail");
    expect(linked?.detail).toMatch(/link-loop.*node_modules.*UNSAFE_SOURCE/i);

    const toolRoot = workspace();
    mkdirSync(join(toolRoot, "node_modules"));
    const tool = provisionCheck(toolRoot, [
      { name: "tool-loop", provision: [{ path: "node_modules", requiredExecutables: [".bin/tsc"] }] }
    ]);
    expect(tool?.status).toBe("fail");
    expect(tool?.detail).toMatch(/tool-loop.*node_modules.*requiredExecutables\.0/i);
  });

  it("identifies the affected loop when loops have different provision plans", () => {
    const dir = workspace();
    mkdirSync(join(dir, "node_modules"));
    const check = provisionCheck(dir, [
      { name: "ready-loop", provision: [{ path: "node_modules" }] },
      { name: "blocked-loop", provision: [{ path: "vendor" }] }
    ]);

    expect(check?.status).toBe("fail");
    expect(check?.detail).toMatch(/blocked-loop.*vendor/i);
    expect(check?.detail).not.toMatch(/ready-loop.*MISSING_SOURCE/i);
  });

  it("gives every non-ok diagnostic a fix and creates no transaction or destination state", () => {
    const dir = workspace();
    mkdirSync(join(dir, "node_modules"));
    const before = treeEntries(dir);

    const report = runDoctor(
      loadedFor(dir, [{ name: "delivery", provision: [{ path: "node_modules", requiredExecutables: [".bin/missing"] }] }]),
      dir
    );

    expect(treeEntries(dir)).toEqual(before);
    expect(existsSync(join(dir, ".loop"))).toBe(false);
    for (const check of report.checks) {
      if (check.status !== "ok") expect(check.fix, `${check.name} is non-ok without a fix`).toBeTruthy();
    }
    expect(report.checks.find((check) => check.name === "provision")?.status).toBe("fail");
  });
});

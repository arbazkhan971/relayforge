import { isAbsolute, relative, resolve, sep } from "node:path";
import { LoadedConfig } from "./load.js";
import { ProjectConfig } from "./schema.js";

export type SemanticIssue = { path: string; message: string };

/**
 * A configured path must stay INSIDE the project-owned root (the directory holding the loop config).
 * Returns an issue when `value` — resolved against `rootDir` — escapes it via `..` traversal or an
 * absolute path pointing outside. This is a STATIC, pre-access check: `runDir: ../../etc`,
 * `workingDir: /`, `intelligence: ../secret` etc. are refused before any file is opened, so a
 * malicious/misconfigured path can never redirect run state, prompts, or the workspace outside the
 * owned tree. `.`/`` (the root itself) is allowed.
 */
function confinedPathIssue(rootDir: string, field: string, value: string): SemanticIssue | undefined {
  if (value === "" || value === ".") return undefined;
  if (value.includes("\0")) return { path: field, message: `path "${value}" contains a NUL byte` };
  const root = resolve(rootDir);
  const abs = resolve(root, value);
  const rel = relative(root, abs);
  if (rel === "") return undefined; // resolves to the root itself
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { path: field, message: `path "${value}" escapes the project root ${root}; configured paths must stay inside it` };
  }
  return undefined;
}

/**
 * Semantic validation that the zod schema cannot express: cross-references must resolve, names
 * must be unique, and features we do NOT fully support must be rejected precisely rather than
 * silently accepted. (Duplicate YAML mapping keys — e.g. two providers with the same name — are
 * already rejected at parse time by the strict YAML loader.)
 */
export function validateProjectSemantics(project: ProjectConfig): SemanticIssue[] {
  const issues: SemanticIssue[] = [];
  const at = (suffix: string) => `projects.${project.name}.${suffix}`;

  // Provider route (`fallbackFor`) restrictions: the ONLY permitted fallback is a Codex provider
  // pointing at a Claude primary — never self, unknown, or a non-Codex provider. This closes the
  // "any provider can declare fallbackFor" escape route.
  for (const [key, p] of Object.entries(project.providers)) {
    if (!p.fallbackFor) continue;
    const at2 = at(`providers.${key}.fallbackFor`);
    if (p.type !== "codex") {
      issues.push({ path: at2, message: `only a Codex provider may be a fallback; provider "${key}" is type "${p.type}"` });
    }
    if (p.fallbackFor === key) {
      issues.push({ path: at2, message: `provider "${key}" cannot be its own fallback` });
    }
    const target = project.providers[p.fallbackFor];
    if (!target) {
      issues.push({ path: at2, message: `fallbackFor references unknown provider "${p.fallbackFor}"` });
    } else if (target.type !== "claude") {
      issues.push({ path: at2, message: `fallbackFor must target a Claude primary; "${p.fallbackFor}" is type "${target.type}"` });
    }
  }

  // Role names unique.
  const roleNames = new Set<string>();
  for (const role of project.roles) {
    if (roleNames.has(role.name)) issues.push({ path: at(`roles.${role.name}`), message: `duplicate role name "${role.name}"` });
    roleNames.add(role.name);
    if (!project.providers[role.provider]) {
      issues.push({ path: at(`roles.${role.name}.provider`), message: `role "${role.name}" references unknown provider "${role.provider}"` });
    }
  }

  // Loop names unique; orchestrator/reviewer must reference real roles.
  const loopNames = new Set<string>();
  for (const loop of project.loops) {
    if (loopNames.has(loop.name)) issues.push({ path: at(`loops.${loop.name}`), message: `duplicate loop name "${loop.name}"` });
    loopNames.add(loop.name);
    if (!roleNames.has(loop.orchestrator)) {
      issues.push({ path: at(`loops.${loop.name}.orchestrator`), message: `loop "${loop.name}" orchestrator references unknown role "${loop.orchestrator}"` });
    }
    if (!roleNames.has(loop.reviewer)) {
      issues.push({ path: at(`loops.${loop.name}.reviewer`), message: `loop "${loop.name}" reviewer references unknown role "${loop.reviewer}"` });
    }
    if (loop.reviewer === loop.orchestrator && project.roles.length > 1) {
      issues.push({ path: at(`loops.${loop.name}.reviewer`), message: `loop "${loop.name}" reviewer must differ from the orchestrator so review is independent` });
    }
  }

  // `yolo` is NOT implemented for Codex, so it must be REJECTED, never silently ignored. Codex's
  // headless contract here is `exec --sandbox read-only|workspace-write` and this codebase
  // deliberately emits no approval-bypass flag for it (see buildHeadlessCommand). A `yolo: true`
  // that quietly does nothing is the worst of both worlds: the operator believes they enabled a
  // bypass (and reasons about their config as if they had), while the code ignores it. Rejecting it
  // is the honest form of "not supported" — and it costs the user nothing, because the behaviour
  // they actually get is the one they already have with the flag removed.
  for (const [key, p] of Object.entries(project.providers)) {
    if (p.yolo === true) {
      issues.push({
        path: at(`providers.${key}.yolo`),
        message:
          `\`yolo\` is not supported in this release and has no effect — remove it. Codex runs under ` +
          `\`exec --sandbox workspace-write\` (reviewers \`read-only\`); the OS sandbox is the real boundary. ` +
          `(For Claude, the equivalent opt-in \`dangerouslySkipPermissions\` IS implemented.)`
      });
    }
  }

  // Multi-repository autonomous execution is NOT supported in this release — reject precisely
  // instead of pretending to honor repository scopes.
  if (project.repositories.length) {
    issues.push({
      path: at("repositories"),
      message:
        "multi-repository execution is not supported in this release. Remove `repositories:` and run one repo at a time (set `workingDir` to that repo)."
    });
  }
  for (const role of project.roles) {
    if (role.repositories.length) {
      issues.push({
        path: at(`roles.${role.name}.repositories`),
        message: `multi-repository execution is not supported: remove \`repositories\` from role "${role.name}"`
      });
    }
  }

  return issues;
}

export function validateConfigSemantics(loaded: LoadedConfig): SemanticIssue[] {
  const issues: SemanticIssue[] = [];
  const root = loaded.rootDir;
  // Global path fields (resolved against the project root) must not escape it.
  for (const [field, value] of [
    ["defaults.runDir", loaded.config.defaults.runDir],
    ["defaults.promptDir", loaded.config.defaults.promptDir]
  ] as const) {
    const issue = confinedPathIssue(root, field, value);
    if (issue) issues.push(issue);
  }
  const projectNames = new Set<string>();
  for (const project of loaded.config.projects) {
    if (projectNames.has(project.name)) issues.push({ path: `projects.${project.name}`, message: `duplicate project name "${project.name}"` });
    projectNames.add(project.name);
    // Per-project path fields must stay inside the project root as well.
    for (const [suffix, value] of [
      ["workingDir", project.workingDir],
      ["intelligence", project.intelligence],
      ["brief", project.brief]
    ] as const) {
      const issue = confinedPathIssue(root, `projects.${project.name}.${suffix}`, value);
      if (issue) issues.push(issue);
    }
    issues.push(...validateProjectSemantics(project));
  }
  return issues;
}

/** Throw an actionable aggregated error if the config has semantic problems. */
export function assertConfigSemantics(loaded: LoadedConfig): void {
  const issues = validateConfigSemantics(loaded);
  if (issues.length) {
    throw new Error(`Invalid loop config (semantic):\n${issues.map((i) => `  ${i.path}: ${i.message}`).join("\n")}`);
  }
}

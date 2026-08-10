import { isAbsolute, relative, resolve, sep } from "node:path";
import { LoadedConfig } from "./load.js";
import { ProjectConfig } from "./schema.js";
import { validateProvisionSpecs } from "../provision.js";
import { materializeConfiguredRepositoryRegistry } from "../multirepo/config.js";

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

    // Provisioning paths have one canonical validator shared with doctor and the execution gate.
    // Its issue path is relative to the provision array (`0.path`,
    // `0.requiredExecutables.1`, ...); retain that precision in config diagnostics so an operator
    // can fix the exact spec rather than hunting through a loop-wide error.
    const provisionPrefix = at(`loops.${loop.name}.provision`);
    for (const issue of validateProvisionSpecs(loop.provision)) {
      issues.push({
        path: issue.path ? `${provisionPrefix}.${issue.path}` : provisionPrefix,
        message: `[${issue.code}] ${issue.message}`
      });
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
      const message = p.type === "codex"
        ? `\`yolo\` is not supported in this release and has no effect — remove it. Codex runs under ` +
          `\`exec --sandbox workspace-write\` (reviewers \`read-only\`); the OS sandbox is the real boundary. ` +
          `(For Claude, the equivalent opt-in \`dangerouslySkipPermissions\` IS implemented.)`
        : p.type === "grok"
          ? "Grok `--yolo`/`--always-approve` is forbidden by the parent-controlled adapter contract; remove `yolo`."
          : `\`yolo\` is not supported for ${p.type} in this release and has no effect — remove it.`;
      issues.push({
        path: at(`providers.${key}.yolo`),
        message
      });
    }
  }

  const multi = project.multiRepository;
  if (project.repositories.length > 0 && multi === undefined) {
    issues.push({
      path: at("multiRepository"),
      message: "configured repositories require an explicit multiRepository multi-repository DAG/execution plan; RelayForge never infers repository scope, target refs, or verification"
    });
  }
  if (multi !== undefined && project.repositories.length === 0) {
    issues.push({ path: at("repositories"), message: "multiRepository requires at least one explicitly configured repository" });
  }
  const repositories = new Map<string, (typeof project.repositories)[number]>();
  for (const [index, repository] of project.repositories.entries()) {
    if (repositories.has(repository.name)) {
      issues.push({ path: at(`repositories.${index}.name`), message: `duplicate repository ID "${repository.name}"` });
    }
    repositories.set(repository.name, repository);
  }
  const scmBindings = new Map<string, NonNullable<typeof project.scm>["repositories"][number]>();
  if (project.scm !== undefined) {
    for (const [index, binding] of project.scm.repositories.entries()) {
      const bindingPath = at(`scm.repositories.${index}`);
      if (scmBindings.has(binding.repository)) {
        issues.push({ path: `${bindingPath}.repository`, message: `duplicate SCM binding for repository "${binding.repository}"` });
      }
      scmBindings.set(binding.repository, binding);
      if (!repositories.has(binding.repository)) {
        issues.push({ path: `${bindingPath}.repository`, message: `SCM binding references unknown configured repository "${binding.repository}"` });
      }
      if (new Set(binding.capabilities).size !== binding.capabilities.length) {
        issues.push({ path: `${bindingPath}.capabilities`, message: "SCM capabilities must be unique" });
      }
      for (const required of ["scm.read", "scm.publish_branch", "scm.write_pr"] as const) {
        if (!binding.capabilities.includes(required)) {
          issues.push({ path: `${bindingPath}.capabilities`, message: `SCM product lifecycle requires capability "${required}"` });
        }
      }
      try {
        const url = new URL(binding.expectedPushUrl);
        if (
          url.protocol !== "https:" || url.hostname !== binding.canonicalHost || url.host !== binding.canonicalHost ||
          url.username !== "" || url.password !== "" || url.port !== "" || url.search !== "" || url.hash !== ""
        ) throw new Error("not canonical");
      } catch {
        issues.push({
          path: `${bindingPath}.expectedPushUrl`,
          message: `SCM push URL must be credential-free canonical HTTPS on host "${binding.canonicalHost}"`
        });
      }
    }
  }
  if (multi !== undefined) {
    for (const role of project.roles) {
      const seen = new Set<string>();
      for (const repositoryId of role.repositories) {
        if (seen.has(repositoryId)) issues.push({ path: at(`roles.${role.name}.repositories`), message: `role "${role.name}" repeats repository "${repositoryId}"` });
        seen.add(repositoryId);
        if (!repositories.has(repositoryId)) issues.push({ path: at(`roles.${role.name}.repositories`), message: `role "${role.name}" references unknown repository "${repositoryId}"` });
      }
    }
    for (const [providerId, capability] of Object.entries(multi.providerRepositories)) {
      if (!project.providers[providerId]) issues.push({ path: at(`multiRepository.providerRepositories.${providerId}`), message: `unknown provider "${providerId}"` });
      if (new Set(capability).size !== capability.length) issues.push({ path: at(`multiRepository.providerRepositories.${providerId}`), message: `provider "${providerId}" repeats a repository capability` });
      for (const repositoryId of capability) if (!repositories.has(repositoryId)) {
        issues.push({ path: at(`multiRepository.providerRepositories.${providerId}`), message: `provider "${providerId}" references unknown repository "${repositoryId}"` });
      }
    }
    const tasks = new Map<string, (typeof multi.tasks)[number]>();
    const branches = new Set<string>();
    const publicationIds = new Set<string>();
    for (const [index, task] of multi.tasks.entries()) {
      const taskPath = at(`multiRepository.tasks.${index}`);
      if (tasks.has(task.id)) issues.push({ path: `${taskPath}.id`, message: `duplicate multi-repository task "${task.id}"` });
      tasks.set(task.id, task);
      const role = project.roles.find((candidate) => candidate.name === task.role);
      const provider = project.providers[task.provider];
      if (!role) issues.push({ path: `${taskPath}.role`, message: `task references unknown role "${task.role}"` });
      if (!provider) issues.push({ path: `${taskPath}.provider`, message: `task references unknown provider "${task.provider}"` });
      const fallbackProvider = Object.entries(project.providers).find(([, candidate]) => candidate.fallbackFor === task.provider)?.[0];
      if (fallbackProvider !== undefined) {
        issues.push({
          path: `${taskPath}.provider`,
          message: `provider "${task.provider}" has fallback "${fallbackProvider}" but P6 recovery receipts bind one physical call; fallback is refused before run authority or worktree creation`
        });
      }
      if (role && role.provider !== task.provider) issues.push({ path: `${taskPath}.provider`, message: `task provider "${task.provider}" differs from role "${task.role}" provider "${role.provider}"` });
      if (new Set(task.repositories).size !== task.repositories.length) issues.push({ path: `${taskPath}.repositories`, message: "task repository set contains duplicates" });
      const entryIds = task.entries.map((entry) => entry.repository);
      if (new Set(entryIds).size !== entryIds.length || entryIds.length !== task.repositories.length || task.repositories.some((id) => !entryIds.includes(id))) {
        issues.push({ path: `${taskPath}.entries`, message: "task entries must map one-to-one onto its exact repository set" });
      }
      const roleScope = new Set(role?.repositories ?? []);
      const providerScope = new Set(multi.providerRepositories[task.provider] ?? []);
      for (const repositoryId of task.repositories) {
        if (!repositories.has(repositoryId)) issues.push({ path: `${taskPath}.repositories`, message: `task references unknown repository "${repositoryId}"` });
        if (!roleScope.has(repositoryId)) issues.push({ path: `${taskPath}.repositories`, message: `repository "${repositoryId}" exceeds role "${task.role}" capability` });
        if (!providerScope.has(repositoryId)) issues.push({ path: `${taskPath}.repositories`, message: `repository "${repositoryId}" exceeds provider "${task.provider}" capability` });
      }
      for (const [entryIndex, entry] of task.entries.entries()) {
        const repository = repositories.get(entry.repository);
        const branchKey = `${entry.repository}\0${entry.branch}`;
        if (branches.has(branchKey)) issues.push({ path: `${taskPath}.entries.${entryIndex}.branch`, message: `branch "${entry.branch}" is reused for repository "${entry.repository}"` });
        branches.add(branchKey);
        const targetBranch = entry.targetRef.startsWith("refs/heads/") ? entry.targetRef.slice("refs/heads/".length) : "";
        if (!targetBranch) issues.push({ path: `${taskPath}.entries.${entryIndex}.targetRef`, message: "targetRef must be an explicit refs/heads/... integration ref" });
        if (repository && (targetBranch === repository.defaultBranch || repository.protectedBranches.includes(targetBranch))) {
          issues.push({ path: `${taskPath}.entries.${entryIndex}.targetRef`, message: `target ref cannot be default/protected branch "${targetBranch}"` });
        }
        if (entry.branch === targetBranch) issues.push({ path: `${taskPath}.entries.${entryIndex}.branch`, message: "worktree branch must differ from the integration target branch" });
        for (const provisionIssue of validateProvisionSpecs(entry.provision)) {
          issues.push({ path: `${taskPath}.entries.${entryIndex}.provision${provisionIssue.path ? `.${provisionIssue.path}` : ""}`, message: `[${provisionIssue.code}] ${provisionIssue.message}` });
        }
      }
      if (task.publication) {
        if (task.generation !== 1) {
          issues.push({ path: `${taskPath}.generation`, message: "published multi-repository tasks must begin at generation 1 for the shared canonical task fence" });
        }
        const publicationRepositories = task.publication.entries.map((entry) => entry.repository);
        if (new Set(publicationRepositories).size !== publicationRepositories.length || publicationRepositories.length !== task.repositories.length || task.repositories.some((id) => !publicationRepositories.includes(id))) {
          issues.push({ path: `${taskPath}.publication.entries`, message: "publication entries must map one-to-one onto the exact task repository set" });
        }
        if (project.scm === undefined) {
          issues.push({
            path: `${taskPath}.publication`,
            message: "remote publication requires explicit project.scm repository bindings and a parent-held cross-link capability"
          });
        } else if (project.scm.crossLinks?.mode !== "pull-request-body") {
          issues.push({
            path: `${taskPath}.publication`,
            message: "multi-repository publication requires scm.crossLinks.mode: pull-request-body; without it RelayForge refuses before external effects"
          });
        }
        for (const [entryIndex, entry] of task.publication.entries.entries()) {
          const binding = scmBindings.get(entry.repository);
          const entryPath = `${taskPath}.publication.entries.${entryIndex}`;
          if (publicationIds.has(entry.publicationId)) {
            issues.push({ path: `${entryPath}.publicationId`, message: `publication ID "${entry.publicationId}" is reused across multi-repository tasks` });
          }
          publicationIds.add(entry.publicationId);
          if (!binding) {
            issues.push({ path: `${entryPath}.repository`, message: `publication repository "${entry.repository}" has no exact SCM binding` });
            continue;
          }
          if (
            entry.remoteName !== binding.remoteName ||
            entry.expectedPushUrl !== binding.expectedPushUrl ||
            entry.baseRef !== binding.baseRef
          ) {
            issues.push({
              path: entryPath,
              message: `publication remote/base identity differs from the SCM binding for "${entry.repository}"`
            });
          }
        }
      }
    }
    for (const [index, task] of multi.tasks.entries()) {
      const seen = new Set<string>();
      for (const dependency of task.dependsOn) {
        if (dependency === task.id) issues.push({ path: at(`multiRepository.tasks.${index}.dependsOn`), message: `task "${task.id}" cannot depend on itself` });
        if (seen.has(dependency)) issues.push({ path: at(`multiRepository.tasks.${index}.dependsOn`), message: `task "${task.id}" repeats dependency "${dependency}"` });
        seen.add(dependency);
        if (!tasks.has(dependency)) issues.push({ path: at(`multiRepository.tasks.${index}.dependsOn`), message: `task "${task.id}" references unknown dependency "${dependency}"` });
      }
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (taskId: string): boolean => {
      if (visiting.has(taskId)) return true;
      if (visited.has(taskId)) return false;
      visiting.add(taskId);
      const cyclic = (tasks.get(taskId)?.dependsOn ?? []).some((dependency) => tasks.has(dependency) && visit(dependency));
      visiting.delete(taskId);
      visited.add(taskId);
      return cyclic;
    };
    for (const taskId of tasks.keys()) if (visit(taskId)) {
      issues.push({ path: at("multiRepository.tasks"), message: "multi-repository task graph contains a cycle" });
      break;
    }
  } else {
    for (const role of project.roles) if (role.repositories.length > 0) {
      issues.push({ path: at(`roles.${role.name}.repositories`), message: `role repository capabilities require an explicit project.multiRepository plan` });
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
    if (project.multiRepository !== undefined && project.repositories.length > 0) {
      try {
        materializeConfiguredRepositoryRegistry(root, project);
      } catch (error) {
        issues.push({
          path: `projects.${project.name}.repositories`,
          message: error instanceof Error ? error.message : "configured repository identity cannot be proven"
        });
      }
    }
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

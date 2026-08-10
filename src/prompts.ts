import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LoadedConfig } from "./config/load.js";
import { ProjectConfig, RoleConfig } from "./config/schema.js";
import { getSmeRole } from "./sme.js";

function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/**
 * The reporting protocol every SME shares.
 *
 * Authoritative coordination state (the board, the run state, and the cost ledger) is owned
 * exclusively by the PARENT orchestrator — agents never write it. An agent's job is to make
 * the code change for its task and then REPORT the outcome in its final message. The parent
 * decides accept/reject from an independent review plus a deterministic verifier; it does not
 * trust the agent's self-report. This keeps a worker from marking its own work done or
 * tampering with the run's state.
 */
export function boardProtocol(runId: string): string {
  return [
    `## How you report (the parent owns all coordination state)`,
    `You do NOT manage the task board. Do not create, edit, or append to anything under \`.loop/\` — that directory is the parent orchestrator's private state and is off-limits. The parent detects what you did from your git changes, an independent review, and a deterministic verifier; it does not take your word for it.`,
    ``,
    `- **Do the work** for the single task you were given, editing only the source files it requires.`,
    `- **Do NOT modify test files or CI configuration** to make checks pass — that is tampering and will be rejected.`,
    `- **When finished**, end with a short final message: what you changed, which files, and how you verified it. That message is your entire report.`,
    `- A task is only accepted when its acceptance criteria are met, an independent reviewer approves the diff, AND the project's verifier commands pass. Optimize for that, not for declaring yourself done.`,
    `- Run ID for this session is \`${runId}\`. Include it in commit messages where helpful.`,
    ``
  ].join("\n");
}

function smeSection(role: RoleConfig): string {
  if (!role.sme) {
    // Hand-authored role: use the configured responsibilities verbatim.
    return [
      `## Responsibilities`,
      role.responsibilities.map((item) => `- ${item}`).join("\n") || "- Follow the project brief.",
      ``
    ].join("\n");
  }

  const sme = getSmeRole(role.sme);
  const extraResponsibilities = role.responsibilities.length
    ? `\n### Additional project-specific responsibilities\n${role.responsibilities.map((i) => `- ${i}`).join("\n")}\n`
    : "";

  return [
    `## Who You Are`,
    sme.identity,
    ``,
    `## Operating Loop (run this every iteration)`,
    sme.operatingLoop.map((step, i) => `${i + 1}. ${step}`).join("\n"),
    ``,
    `## Definition of Done`,
    sme.definitionOfDone.map((item) => `- ${item}`).join("\n"),
    extraResponsibilities,
    ``
  ].join("\n");
}

export function buildRolePrompt(loaded: LoadedConfig, project: ProjectConfig, role: RoleConfig, runId: string): string {
  const briefPath = resolve(loaded.rootDir, project.brief);
  const brief = readIfExists(briefPath)?.trim() ?? "(no brief.md found — operate from the goal and project intelligence.)";

  const intelPath = resolve(
    loaded.rootDir,
    project.workingDir || ".",
    project.intelligence || "PROJECT-INTELLIGENCE.md"
  );
  const intel = readIfExists(intelPath);

  const repos = project.repositories.filter((repo) => role.repositories.includes(repo.name));
  const sme = role.sme ? getSmeRole(role.sme) : undefined;

  const globalGuardrails = [
    ...role.guardrails,
    ...(sme?.guardrails ?? []),
    "Do not delete production data or run destructive database commands.",
    "Keep changes scoped to your claimed task and assigned repositories.",
    "Create focused commits; open a pull request when implementation is complete.",
    "Always use the test/build/lint commands from PROJECT-INTELLIGENCE.md — never invent commands."
  ];

  return [
    `# ${role.title}`,
    ``,
    `Run ID: ${runId}`,
    `Project: ${project.name}`,
    `Role: ${role.name}${sme ? ` (SME: ${sme.title})` : ""}`,
    `Provider: ${role.provider}`,
    `Safety mode: ${project.safetyMode}`,
    ``,
    smeSection(role),
    `## Project Brief`,
    brief,
    ``,
    `## Project Intelligence (you are trained on this project)`,
    intel
      ? `The following is auto-detected knowledge of this codebase. Ground every decision in it — especially the commands.\n\n${intel.trim()}`
      : "_No PROJECT-INTELLIGENCE.md found. Run \`relayforge learn\` first, or inspect the repo before acting._",
    ``,
    `## Assigned Repositories`,
    repos.length
      ? repos.map((repo) => `- ${repo.name}: ${repo.path} (${repo.role}, default ${repo.defaultBranch}, protected: ${repo.protectedBranches.join(", ")})`).join("\n")
      : "- Working directory only (no extra repositories assigned).",
    ``,
    boardProtocol(runId),
    `## Guardrails`,
    globalGuardrails.map((item) => `- ${item}`).join("\n"),
    ``
  ].join("\n");
}

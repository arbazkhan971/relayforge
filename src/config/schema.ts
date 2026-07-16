import { z } from "zod";

export const AuthSchema = z.object({
  mode: z.enum(["auto", "subscription", "api-key", "env"]).default("auto"),
  env: z.string().optional(),
  configured: z.boolean().default(false),
  notes: z.string().optional()
});

export const ProviderSchema = z.object({
  type: z.enum(["claude", "codex", "gemini", "custom"]),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  model: z.string().optional(),
  effort: z.string().optional(),
  dangerouslySkipPermissions: z.boolean().default(false),
  yolo: z.boolean().default(false),
  auth: AuthSchema.default({
    mode: "auto",
    configured: false
  }),
  promptMode: z.enum(["interactive", "stdin", "argument"]).default("interactive"),
  env: z.record(z.string(), z.string()).default({})
});

export const RepositorySchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  role: z.enum(["frontend", "backend", "fullstack", "docs", "qa", "release", "other"]).default("other"),
  defaultBranch: z.string().default("main"),
  protectedBranches: z.array(z.string()).default(["main", "production"])
});

/**
 * Built-in subject-matter-expert disciplines. When a role sets `sme: <discipline>`,
 * the prompt builder seeds it from the bundled SME role library (deep, project-aware
 * system prompt) instead of requiring the user to hand-write responsibilities.
 *
 * This is a broad roster of the role players a world-class software org fields — not a
 * minimal set. Pick the team that fits the goal; the orchestrator only spins up the
 * roles a project actually needs. Unknown disciplines fall back to a generic engineer.
 */
export const SmeDisciplineSchema = z.enum([
  // Leadership / product
  "architect",          // CTO / system design, decomposition, ADRs, cross-cutting risk
  "product-manager",    // goal -> stories + acceptance criteria, prioritization, accept/reject
  "engineering-manager",// throughput, unblocking, scope control, status roll-up
  "ux-designer",        // interaction & visual design, design system, usability
  // Core engineering
  "frontend",           // UI, accessibility, responsive, state mgmt
  "backend",            // APIs, data models, migrations, business logic, perf
  "fullstack",          // end-to-end features spanning FE+BE
  "mobile",             // iOS/Android/React Native/Expo
  "data-engineer",      // pipelines, ETL, warehouses, schemas, analytics plumbing
  "ml-engineer",        // models, training/eval, inference, prompt/AI features
  "integration-engineer", // 3rd-party APIs, webhooks, SDKs, contracts
  // Quality / reliability
  "qa",                 // verify acceptance criteria, exploratory + regression, sign-off
  "ct",                 // test automation: unit/integration/e2e suites, CI wiring, coverage
  "sre",                // reliability, SLOs, incident response, on-call playbooks
  "performance-engineer", // profiling, load testing, latency/throughput budgets
  "accessibility",      // a11y audits, WCAG, screen-reader & keyboard flows
  "security",           // STRIDE/OWASP, secrets, CVEs, authz/authn, adversarial review
  // Platform / ops
  "devops",             // build/CI/CD, containers, deploy config, env/secrets hygiene
  "platform-engineer",  // internal tooling, dev experience, infra-as-code
  "dba",                // schema design, indexes, query tuning, migrations safety
  "release-manager",    // versioning, changelogs, release gates, rollout/rollback
  // Craft / supporting
  "refactorer",         // tech-debt paydown, dead-code removal, modularization
  "code-reviewer",      // adversarial diff review, standards enforcement
  "technical-writer",   // docs, READMEs, API reference, runbooks
  "i18n",               // internationalization & localization
  "observability",      // logging/metrics/tracing, dashboards, alerting
  // Generic fallback
  "engineer"            // general-purpose IC when no specialty fits
]);

export const RoleSchema = z.object({
  name: z.string().min(1),
  title: z.string().min(1),
  provider: z.string().min(1),
  /** Optional built-in SME discipline that seeds this role's expert system prompt. */
  sme: SmeDisciplineSchema.optional(),
  repositories: z.array(z.string()).default([]),
  responsibilities: z.array(z.string()).default([]),
  guardrails: z.array(z.string()).default([]),
  autoStart: z.boolean().default(true)
});

export const LoopSchema = z.object({
  name: z.string().min(1),
  cadenceMinutes: z.number().int().positive().default(30),
  maxIterations: z.number().int().positive().default(8),
  stopWhen: z.array(z.string()).default(["tests pass", "all tasks done", "review complete"]),
  /** Seconds of output quiescence before a pane's turn is considered finished. */
  idleSeconds: z.number().int().positive().default(20),
  /** Poll interval (seconds) the autonomy loop uses to read panes / the board. */
  pollSeconds: z.number().int().positive().default(8),
  /** Which role acts as the orchestrator brain that decomposes the goal. */
  orchestrator: z.string().default("pm"),
  /** Max times a failed task is re-dispatched with error context before escalating. */
  maxRepairs: z.number().int().nonnegative().default(2),
  /** Which role independently reviews implemented work (the critic). Empty = orchestrator. */
  reviewer: z.string().default("qa"),
  /** Stop the run once cumulative agent spend exceeds this many USD (0 = unlimited). */
  budgetUsd: z.number().nonnegative().default(0),
  /** How many consecutive verifier runs are required to prove stability before dispatching. */
  verifyStabilityRuns: z.number().int().nonnegative().default(3),
  /** If the same failure signature repeats this many times, the run is considered stuck. */
  maxSameFailureCount: z.number().int().nonnegative().default(2),
  /** Per-iteration context budget (approximate chars) when building the agent-facing context snapshot. */
  contextTokenBudget: z.number().int().positive().default(16000),
  /** Re-run verify after merge for each accepted task to catch cross-cutting regressions. */
  postMergeVerify: z.boolean().default(true),
  /** Max SMEs working concurrently. >1 requires git-worktree isolation (auto-enabled). */
  maxParallel: z.number().int().positive().default(1),
  /** Run each role in an isolated git worktree so parallel edits don't collide. */
  isolate: z.boolean().default(true)
});

export const ProjectSchema = z.object({
  name: z.string().min(1),
  brief: z.string().default("brief.md"),
  workingDir: z.string().default("."),
  /** Path to the auto-generated project intelligence file (`loop learn` output). */
  intelligence: z.string().default("PROJECT-INTELLIGENCE.md"),
  safetyMode: z.enum(["review", "workspace-write", "full-auto"]).default("workspace-write"),
  providers: z.record(z.string(), ProviderSchema),
  repositories: z.array(RepositorySchema).default([]),
  roles: z.array(RoleSchema).min(1),
  loops: z.array(LoopSchema).default([])
});

export const RootConfigSchema = z.object({
  version: z.literal(1),
  defaults: z.object({
    namespace: z.string().default("loop"),
    dashboardPort: z.number().int().positive().default(4318),
    daemonPort: z.number().int().positive().default(4319),
    promptDir: z.string().default(".loop/prompts"),
    runDir: z.string().default(".loop/runs")
  }).default({
    namespace: "loop",
    dashboardPort: 4318,
    daemonPort: 4319,
    promptDir: ".loop/prompts",
    runDir: ".loop/runs"
  }),
  projects: z.array(ProjectSchema).min(1)
});

export type ProviderConfig = z.infer<typeof ProviderSchema>;
export type AuthConfig = z.infer<typeof AuthSchema>;
export type RepositoryConfig = z.infer<typeof RepositorySchema>;
export type RoleConfig = z.infer<typeof RoleSchema>;
export type LoopConfig = z.infer<typeof LoopSchema>;
export type ProjectConfig = z.infer<typeof ProjectSchema>;
export type RootConfig = z.infer<typeof RootConfigSchema>;
export type SmeDiscipline = z.infer<typeof SmeDisciplineSchema>;

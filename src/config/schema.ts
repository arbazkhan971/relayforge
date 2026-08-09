import { z } from "zod";
import { ID_PATTERN } from "../ids.js";

/**
 * A strict canonical identifier used for any name that becomes a filesystem path, git ref, or
 * tmux target (namespace, project, role, loop). Rejected rather than sanitized — see src/ids.ts.
 */
const idString = (label: string) =>
  z
    .string()
    .min(1)
    .refine((v) => ID_PATTERN.test(v) && !v.includes(".."), {
      message: `${label} must be letters/digits then ._- only (no spaces, separators, or "..", max 64 chars)`
    });

const gitRefString = (label: string) => z
  .string()
  .min(1)
  .max(512)
  .refine((value) =>
    !value.startsWith("-") && !value.startsWith("/") && !value.endsWith("/") && !value.endsWith(".") &&
    !value.includes("..") && !value.includes("@{") && !value.includes("//") &&
    !/[~^:?*\[\\\]\u0000-\u0020\u007f]/u.test(value),
  { message: `${label} is not a canonical Git ref name` });

export const AuthSchema = z
  .object({
    mode: z.enum(["auto", "subscription", "api-key", "env"]).default("auto"),
    env: z.string().optional(),
    configured: z.boolean().default(false),
    notes: z.string().optional()
  })
  .strict();

export const ProviderSchema = z
  .object({
    type: z.enum(["claude", "codex", "gemini", "custom", "opencode", "pi", "grok"]),
    command: z.string().min(1).max(4096).optional(),
    args: z.array(z.string().max(4096)).max(128).default([]),
    model: z.string().min(1).max(256).optional(),
    /** Reasoning effort (Codex: minimal|low|medium|high|xhigh). */
    effort: z.string().min(1).max(64).optional(),
    /** Override the flag Claude uses to load a system prompt from a file (headless). */
    systemPromptFlag: z.string().min(1).max(128).optional(),
    /**
     * DEPRECATED / UNSAFE. Kept only so an explicit opt-in can still be expressed, but the
     * orchestrator no longer passes it by default — headless implementers run inside an
     * OS-sandboxed disposable worktree, not a permission-bypassed host session.
     */
    dangerouslySkipPermissions: z.boolean().default(false),
    yolo: z.boolean().default(false),
    /** Provider role in the fallback chain: primary is tried first, fallback only on an
     *  explicitly-classified usage/rate/quota limit of the primary. */
    fallbackFor: z.string().optional(),
    /** Cooldown (seconds) before a rate-limited provider is probed again. */
    cooldownSeconds: z.number().int().nonnegative().default(900),
    /** Whether this route runs behind a PREAUTHORIZING billing gateway that counts input, clamps
     *  provider output, fsyncs a worst-case reservation BEFORE forwarding the request, and settles
     *  the raw provider usage afterwards. Direct `claude -p` / `codex` CLIs do NOT — their
     *  `--max-budget-usd` / `rollout_budget` are POST-response soft guards that can overshoot by the
     *  last request, so they can never satisfy a hard USD ceiling. Only a route that sets this true
     *  may be used under `budgetMode: hard-usd`. Default false (honest for a direct CLI). */
    preauthorizingGateway: z.boolean().default(false),
    auth: AuthSchema.default({
      mode: "auto",
      configured: false
    }),
    promptMode: z.enum(["interactive", "stdin", "argument"]).default("interactive"),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(4 * 1024 * 1024)).default({})
  })
  .strict()
  .superRefine((provider, ctx) => {
    if (provider.type !== "opencode" && provider.type !== "pi" && provider.type !== "grok") return;
    const allowedAuthEnv = provider.type === "pi"
      ? new Set(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"])
      : provider.type === "grok"
        ? new Set(["XAI_API_KEY"])
      : new Set<string>();
    // Native structured adapters have a compile-time launch recipe. Raw command/argv/env overrides
    // could replace ACP/RPC mode, relax read-only policy, smuggle a shell, or change the protocol
    // contract, so their configuration surface is deliberately data-only and closed.
    const forbidden: Array<[boolean, (string | number)[], string]> = [
      [provider.command !== undefined, ["command"], `${provider.type} uses only its canonical installed executable; command overrides are forbidden`],
      [provider.args.length !== 0, ["args"], `${provider.type} protocol/control arguments are parent-owned; raw args are forbidden`],
      [Object.keys(provider.env).length !== 0, ["env"], `${provider.type} environment overlays are parent-owned; raw env is forbidden`],
      [provider.effort !== undefined, ["effort"], `${provider.type} does not accept the Codex effort option`],
      [provider.systemPromptFlag !== undefined, ["systemPromptFlag"], `${provider.type} standing instructions use its structured protocol contract`],
      [provider.dangerouslySkipPermissions, ["dangerouslySkipPermissions"], `${provider.type} cannot bypass its parent-controlled role policy`],
      [provider.yolo, ["yolo"], `${provider.type} cannot bypass its parent-controlled role policy`],
      [provider.promptMode !== "interactive", ["promptMode"], `${provider.type} prompt transport is fixed by its descriptor`],
      [provider.fallbackFor !== undefined, ["fallbackFor"], `${provider.type} has no fallback authority in this contract`],
      [provider.auth.env !== undefined && !allowedAuthEnv.has(provider.auth.env), ["auth", "env"], `${provider.type} authentication environment names are closed by its descriptor`]
    ];
    if (provider.type === "opencode" && provider.model !== undefined) {
      forbidden.push([true, ["model"], "opencode model selection is unavailable until ACP model-option negotiation is proven"]);
    }
    for (const [invalid, path, message] of forbidden) {
      if (invalid) ctx.addIssue({ code: "custom", path, message });
    }
  });

/** A parent-side, offline dependency tree copied into a contained worktree before execution. */
export const ProvisionSpecSchema = z
  .object({
    path: z.string().min(1, "provision path must not be empty").max(4096, "provision path is too long"),
    requiredExecutables: z
      .array(z.string().min(1, "required executable path must not be empty").max(4096, "required executable path is too long"))
      .max(64, "a provision spec may require at most 64 executables")
      .optional()
  })
  .strict();

export const RepositorySchema = z
  .object({
    name: idString("repository name"),
    path: z.string().min(1),
    role: z.enum(["frontend", "backend", "fullstack", "docs", "qa", "release", "other"]).default("other"),
    defaultBranch: gitRefString("default branch").default("main"),
    protectedBranches: z.array(gitRefString("protected branch")).max(64).default(["main", "production"])
  })
  .strict();

const ScmLimitOverridesSchema = z
  .object({
    requestTimeoutMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    maxPagesPerEndpoint: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    maxItemsPerPage: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    maxItemsPerEndpoint: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    maxDecodedBytesPerRequest: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    maxDecodedBytesPerPoll: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    maxEvidenceBodyBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    maxEvidencePreviewBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    maxFailureLogBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    maxFailureLogsBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    maxConcurrentPerRepository: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    maxConcurrentPerRun: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()
  })
  .strict();

/**
 * Secret-free product binding for one configured repository. The local root is deliberately not a
 * caller field: it is derived from the matching `repositories[].path` after configuration path
 * confinement and physical identity checks. `credentialEnv` is only a variable name; its value is
 * resolved by the parent at run-authority startup and never enters the parsed configuration DTO.
 */
export const ScmRepositoryConfigSchema = z
  .object({
    repository: idString("SCM repository binding"),
    provider: z.literal("github").default("github"),
    canonicalHost: z.string().min(1).max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u),
    owner: z.string().min(1).max(100).regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/u),
    name: z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/u),
    baseOwner: z.string().min(1).max(100).regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/u),
    baseName: z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/u),
    remoteName: z.string().min(1).max(256).regex(/^[A-Za-z0-9._-]+$/u).default("origin"),
    expectedPushUrl: z.string().url().max(4_096),
    baseRef: z.string().min(12).max(512).regex(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._\/-]*$/u),
    credentialEnv: z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/u),
    capabilities: z
      .array(z.enum(["scm.read", "scm.publish_branch", "scm.write_pr"]))
      .min(1)
      .max(3)
      .default(["scm.read", "scm.publish_branch", "scm.write_pr"]),
    limits: ScmLimitOverridesSchema.optional()
  })
  .strict();

export const ScmProjectConfigSchema = z
  .object({
    repositories: z.array(ScmRepositoryConfigSchema).min(1).max(32),
    /** Cross-repository publication is enabled only with this exact, implemented capability. */
    crossLinks: z.object({ mode: z.literal("pull-request-body") }).strict().optional(),
    minimumHumanApprovals: z.number().int().nonnegative().max(100).default(1),
    requireRequiredChecks: z.boolean().default(true)
  })
  .strict();

const MultiRepositoryPublicationEntrySchema = z
  .object({
    repository: idString("publication repository"),
    publicationId: idString("publication ID"),
    remoteName: z.string().min(1).max(256).regex(/^[A-Za-z0-9._-]+$/),
    expectedPushUrl: z.string().url().max(4_096),
    remoteRef: gitRefString("publication remote ref"),
    expectedRemoteOid: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).nullable(),
    baseRef: gitRefString("publication base ref"),
    title: z.string().max(512),
    body: z.string().max(16 * 1024)
  })
  .strict();

const MultiRepositoryTaskEntrySchema = z
  .object({
    repository: idString("task repository"),
    branch: gitRefString("task branch"),
    targetRef: gitRefString("task target ref"),
    provision: z.array(ProvisionSpecSchema).max(32).default([])
  })
  .strict();

export const MultiRepositoryTaskConfigSchema = z
  .object({
    id: idString("multi-repository task ID"),
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(1),
    role: idString("multi-repository role"),
    provider: idString("multi-repository provider"),
    repositories: z.array(idString("task repository")).min(1).max(32),
    dependsOn: z.array(idString("task dependency")).max(256).default([]),
    priority: z.number().int().min(-1_000).max(1_000).default(0),
    entries: z.array(MultiRepositoryTaskEntrySchema).min(1).max(32),
    verifyCommands: z.array(z.string().min(1).max(4_096)).min(1).max(64),
    verifyEnvironment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), z.string().max(16 * 1024)).default({}),
    commitMessage: z.string().min(1).max(8 * 1024),
    publication: z
      .object({
        policyApproved: z.literal(true),
        entries: z.array(MultiRepositoryPublicationEntrySchema).min(1).max(32)
      })
      .strict()
      .optional()
  })
  .strict();

export const MultiRepositoryProjectConfigSchema = z
  .object({
    providerRepositories: z.record(idString("provider capability"), z.array(idString("provider repository")).min(1).max(64)),
    scheduler: z
      .object({
        global: z.number().int().positive().max(64).default(1),
        perProvider: z.number().int().positive().max(64).default(1),
        perRepository: z.number().int().positive().max(64).default(1),
        perTask: z.number().int().positive().max(1).default(1)
      })
      .strict()
      .default({ global: 1, perProvider: 1, perRepository: 1, perTask: 1 }),
    tasks: z.array(MultiRepositoryTaskConfigSchema).min(1).max(4_096)
  })
  .strict();

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

export const RoleSchema = z
  .object({
    name: idString("role name"),
    title: z.string().min(1),
    provider: z.string().min(1),
    /** Optional built-in SME discipline that seeds this role's expert system prompt. */
    sme: SmeDisciplineSchema.optional(),
    repositories: z.array(z.string()).default([]),
    responsibilities: z.array(z.string()).default([]),
    guardrails: z.array(z.string()).default([]),
    autoStart: z.boolean().default(true)
  })
  .strict();

export const LoopSchema = z
  .object({
    name: idString("loop name"),
    cadenceMinutes: z.number().int().positive().max(1440).default(30),
    maxIterations: z.number().int().positive().max(1000).default(8),
    /** Advisory stop hints surfaced to the planner; the deterministic stop conditions are
     *  all-tasks-accepted + green verifier, budget, repeat-failure, and iteration cap. */
    stopWhen: z.array(z.string()).default(["tests pass", "all tasks done", "review complete"]),
    /** Poll interval (seconds) between autonomy-loop iterations. */
    pollSeconds: z.number().int().positive().max(3600).default(8),
    /** Which role acts as the orchestrator brain that decomposes the goal. */
    orchestrator: z.string().min(1).default("pm"),
    /** Max repair re-dispatches of a failed task before escalating (initial attempt excluded). */
    maxRepairs: z.number().int().nonnegative().max(100).default(2),
    /** Which role independently reviews implemented work (the critic). Must differ from the
     *  implementer; may not itself be assigned implementation work. */
    reviewer: z.string().min(1).default("qa"),
    /**
     * The HONEST budget-enforcement contract for this loop. The mode names exactly what USD
     * enforcement the run can truthfully provide with its configured routes:
     *  - `unlimited`         — no USD ceiling; the run stops on tasks-done / iteration / limit only.
     *  - `estimated-usd`     — SOFT post-response accounting: the reservation ledger reserves a
     *                          worst case and settles reported usage AFTER each call. It can overshoot
     *                          the cap by (at most) the last in-flight call; it is an estimate/tripwire,
     *                          NOT a hard guarantee. This is what a direct Claude/Codex CLI can honestly offer.
     *  - `hard-usd`          — a HARD ceiling that is provably never exceeded. Requires every route
     *                          (planner/worker/reviewer/probe/fallback) to run behind a preauthorizing
     *                          gateway (`preauthorizingGateway: true`). Without one the run is REFUSED
     *                          before planning — we never pretend a soft CLI cap is a hard ceiling.
     *  - `subscription-quota`— no USD metering; spend is governed by the provider's own subscription
     *                          quota and the usage-limit state machine (no `budgetUsd`).
     * Default `estimated-usd` when a positive `budgetUsd` is set, else `unlimited` (see normalize).
     */
    budgetMode: z.enum(["unlimited", "estimated-usd", "hard-usd", "subscription-quota"]).optional(),
    /** Stop the run once cumulative agent spend exceeds this many USD (0 = unlimited). Under
     *  `hard-usd` this is a provable ceiling; under `estimated-usd` it is a soft post-response cap. */
    budgetUsd: z.number().nonnegative().default(0),
    /** The enforceable worst-case cost of a SINGLE physical provider call (USD). Under a positive
     *  `budgetUsd` this MUST be set (> 0 and <= budgetUsd): the orchestrator reserves this amount
     *  before every call, so a positive budget can fund multiple calls without ever overshooting.
     *  If a positive budget has no valid per-call cap, the run is refused before planning rather
     *  than pretending the whole-run cap is a functional per-call limit. 0 = unset. */
    maxCostPerCallUsd: z.number().nonnegative().default(0),
    /** When a positive budget is set and a provider reports NO cost, refuse to keep spending
     *  (fail closed) unless this bounded-call policy explicitly permits N unknown-cost calls. */
    allowUnknownCostCalls: z.number().int().nonnegative().default(0),
    /** How many consecutive verifier runs are required to prove stability before dispatching. */
    verifyStabilityRuns: z.number().int().nonnegative().max(20).default(3),
    /** If the same failure signature repeats this many times, the run is considered stuck. */
    maxSameFailureCount: z.number().int().nonnegative().max(100).default(2),
    /** Per-iteration context budget (approximate chars) for the agent-facing context snapshot. */
    contextTokenBudget: z.number().int().positive().max(2_000_000).default(16000),
    /** Ordered list of verifier commands (run in sequence; all must pass). Empty = auto-detect
     *  the project's test then build command from PROJECT-INTELLIGENCE. */
    verify: z.array(z.string()).default([]),
    /** Offline dependency trees copied by the parent into integration, attempt, and review
     *  worktrees before any agent or verifier may observe them. Empty/absent disables the gate. */
    provision: z.array(ProvisionSpecSchema).max(32, "a loop may configure at most 32 provision specs").default([]),
    /** Re-run verify after merge for each accepted task to catch cross-cutting regressions. */
    postMergeVerify: z.boolean().default(true),
    /** Max SMEs working concurrently. Each task always runs in its own git worktree; isolation
     *  is mandatory and cannot be disabled. */
    maxParallel: z.number().int().positive().max(64).default(1)
  })
  .strict();

export const ProjectSchema = z
  .object({
    name: idString("project name"),
    brief: z.string().default("brief.md"),
    workingDir: z.string().default("."),
    /** Path to the auto-generated project intelligence file (`relayforge learn` output). */
    intelligence: z.string().default("PROJECT-INTELLIGENCE.md"),
    /** review = reviewer read-only + implementer workspace-write inside its sandbox;
     *  workspace-write = same. "full-auto" is rejected — there is no unsandboxed host mode. */
    safetyMode: z.enum(["review", "workspace-write"]).default("workspace-write"),
    providers: z.record(z.string(), ProviderSchema),
    repositories: z.array(RepositorySchema).default([]),
    multiRepository: MultiRepositoryProjectConfigSchema.optional(),
    scm: ScmProjectConfigSchema.optional(),
    roles: z.array(RoleSchema).min(1),
    loops: z.array(LoopSchema).default([])
  })
  .strict();

export const RootConfigSchema = z
  .object({
    version: z.literal(1),
    defaults: z
      .object({
        namespace: idString("namespace").default("loop"),
        dashboardPort: z.number().int().positive().max(65535).default(4318),
        promptDir: z.string().default(".loop/prompts"),
        runDir: z.string().default(".loop/runs"),
        /** The OPTIONAL tmux viewport. Off means the loop never opens a tmux session; it still runs
         *  fully headless, and `relayforge monitor` / the dashboard still work.
         *  `RELAYFORGE_TMUX=off` (legacy: `LOOP_TMUX=off`) overrides this to off for one invocation
         *  and can only ever DISABLE, never enable. */
        viewport: z.boolean().default(true)
      })
      .strict()
      .default({
        namespace: "loop",
        dashboardPort: 4318,
        promptDir: ".loop/prompts",
        runDir: ".loop/runs",
        viewport: true
      }),
    projects: z.array(ProjectSchema).min(1)
  })
  .strict();

export type ProviderConfig = z.infer<typeof ProviderSchema>;
export type AuthConfig = z.infer<typeof AuthSchema>;
export type RepositoryConfig = z.infer<typeof RepositorySchema>;
export type ScmRepositoryConfig = z.infer<typeof ScmRepositoryConfigSchema>;
export type ScmProjectConfig = z.infer<typeof ScmProjectConfigSchema>;
export type MultiRepositoryTaskConfig = z.infer<typeof MultiRepositoryTaskConfigSchema>;
export type MultiRepositoryProjectConfig = z.infer<typeof MultiRepositoryProjectConfigSchema>;
export type RoleConfig = z.infer<typeof RoleSchema>;
export type LoopConfig = z.infer<typeof LoopSchema>;
export type ProjectConfig = z.infer<typeof ProjectSchema>;
export type RootConfig = z.infer<typeof RootConfigSchema>;
export type SmeDiscipline = z.infer<typeof SmeDisciplineSchema>;

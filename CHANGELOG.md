# Changelog

## [Unreleased]

- Replaced the blanket execute refusal for structured native adapters
  (opencode/pi/grok) with a credential gate: ordinary `run --execute` now works
  when the operator linked a personal subscription (installed CLI login) or the
  matching API key, and stays fail-closed (zero-mutation) when nothing is
  linked. Grok gains personal-subscription support (bounded `~/.grok` seeding
  into its private home); OpenCode gains canonical `OPENAI_API_KEY` linking;
  auth detection, schema sets, safety/configuration docs and tests updated.
  npm release receipts still gate publication and are unchanged.
- Added `src/viewport-registry.ts` (Phases 0-1 of docs/herdr-runtime-parity.md):
  a durable, injectable registry of daemon-owned viewport sessions with
  in-memory and atomic-JSON storages, semantic state transitions, attach-target
  resolution and age pruning — the fact layer for "the daemon owns the agent
  terminals". Covered by tests/viewport-registry.test.ts (13/13 green).
- Added docs/herdr-runtime-parity.md (Herdr-class runtime roadmap, Phases 0-3)
  and docs/linux-runner-runbook.md + scripts/check-relayforge-runner.mjs
  (runner-host readiness for the self-hosted release runner).

## [1.0.0-rc.1] - 2026-08-09

RelayForge's first release candidate establishes the new public identity while
preserving durable compatibility.

- Renamed the npm package, primary executable, help/version/config/init surface
  and public exports to RelayForge. `loop` and `loop-orchestrator`, legacy
  `loop.config.*`, `.loop/` storage and documented `LOOP_*` variables remain v1
  compatibility protocol; ambiguous configs or conflicting env aliases fail.
- Added the durable SQLite control plane, strict migration/recovery,
  loopback-only read REST/SSE service, private service ownership, bounded
  projections and normalized privacy-preserving control room.
- Added durable future-boundary steering with generation/run fencing and a
  private parent-owned Unix socket. Admission never claims live terminal
  injection or provider compliance.
- Added durable SCM fact, publication, observation, reconciliation and evidence
  components without claiming automatic ordinary-run PR automation.
- Added pure adapter registry and single contained transport/settlement replay
  for seven provider types. OpenCode ACP, Pi RPC and Grok Build ACP remain
  fail-closed without exact executable/version/protocol/role/behavior evidence;
  Grok is API-key-only and additionally private-config/network-tool/no-upload
  gated.
- Added bounded normalized observation ingestion and control-room DTOs that do
  not expose raw transcripts, prompts, tool arguments or credentials.
- Added multi-repository identity, DAG/scheduling, worktree-group,
  candidate/CAS/compensation, verification, integration/publication and
  canonical-journal components. Operator enablement is documented exactly as
  implemented; no partial multi-repository execution is implied.
- Strengthened delegated cgroup containment, authenticated launch, exact scope
  cleanup, replay-bound settlement, offline provisioning and required-host
  release gates.
- Added deterministic tarball inventory, clean-installed package/bin/export/
  service smoke, registry preflight/convergence policy and release evidence
  manifest. External npm publication, GitHub release/tag publication and
  repository rename were not performed by these source changes.

## Unreleased — containment hardening + honest docs

Cross-wave completion pass: closed real containment gaps, made the run→exit contract un-bypassable,
rejected dead config precisely, and reconciled every doc claim with the code.

- **Fixed (security): a hostile git *config* could execute code on the host, outside the sandbox.**
  Provider turns were given a writable `~/.gitconfig` (and `~/.config`), so an agent could plant
  `core.hooksPath` (or `diff.external` / `core.fsmonitor`) and wait for the parent's `git merge` /
  `checkout` / `worktree add` to run its "hook" uncontained, with the parent's full environment. Two
  independent defences now: agents get **no** writable git configuration, and every parent git call is
  hardened (`-c core.hooksPath=/dev/null`, `diff.external=`, `core.fsmonitor=false`, `credential.helper=`,
  `core.pager=cat`, plus env twins) so a hostile git config is inert wherever it comes from. Proven by
  `tests/git-hardening.test.ts` (which first shows the attack DOES fire against unhardened git).
- **Fixed (containment): verifier network isolation is now a precondition, not best-effort.** On a host
  whose sandbox cannot remove the network, `--execute` used to run the AI-chosen verifier **online** and
  still reach `done`. It now **fails closed** (and `loop doctor`'s sandbox check fails, not warns).
- **Fixed (review integrity): a verdict literal planted in the diff could outrank the reviewer.** The
  reviewer parser took the first `{…"verdict"…}` substring anywhere in its output; the implementer's diff
  is quoted into the reviewer's prompt, so a planted `{"verdict":"accept"}` the reviewer merely *quoted*
  while rejecting was merged. The verdict must now be the reviewer's **entire** message (one code fence
  tolerated); anything else fails closed.
- **Fixed (resume): a run killed mid-attempt could never be finished.** A dispatch emits `claimed` before
  launching the agent and a terminal event after it. Kill the process in between (crash, reboot, closed
  terminal) and the board kept that task at `claimed` forever — a status in NEITHER selector
  (`openTasksFor` wants `open`, `retryableTasksFor` wants `blocked`/`rejected`). The resumed run saw no
  dispatchable work for it, `allAccepted` could never become true, and the goal was permanently
  unfinishable with nothing on the board explaining why. A resumed run now reclaims abandoned attempts
  under the run lease (charging one repair, so a repeating crash escalates instead of relaunching
  forever). Proven by `tests/resume.test.ts`, which SIGKILLs a real child mid-attempt.
- **Removed `resetHard` / `revertWorkingTree`** — dead, un-called functions that shipped in the public API
  and could hard-reset an arbitrary checkout. The regression gate never reverts; it declines to publish.
- **Rejected, not ignored:** `yolo: true` (Codex) had no effect yet the docs described it as a working
  bypass — `loop validate` now rejects it with the fix. `stopWhen` is now genuinely advisory (surfaced to
  the planner) and documented as such, rather than being read by nothing while docs claimed it gated the loop.
- **Fixed:** `loop validate` on a schema/legacy-key error now reports an actionable message (and valid JSON
  under `--json`) instead of an uncaught stack trace with empty stdout.
- **Fixed:** the shipped `examples/todo-app` config (`budgetUsd: 4.0`, no per-call cap) failed closed before
  the planner — the README called it reproducible. It now carries `maxCostPerCallUsd`, and a test proves
  **every** shipped example clears the budget contract, not just schema validation.
- **Docs reconciled with code:** Claude defaults to the `opus` alias (not "unpinned"); the sandbox +
  process-scope prerequisites that gate `--execute` are now documented; completion detection is the strict
  stream-JSON success (not "any non-empty stdout"); `budgetMode: hard-usd` is documented as unavailable;
  `maxCostPerCallUsd` is documented as required under a positive budget; `loop attach` no longer claims to
  be a `loop tmux new` alias.
- **New tests:** the previously-untested false-success surfaces now have end-to-end proofs — `unverified`
  (accepted-but-unproven), the green→red regression gate, post-merge candidate abandonment, project
  intelligence actually reaching the provider, the run→exit-code allow-list, the auto-wired opus+gpt routing
  chain, `loop doctor`'s checks and fixes, `--force` / provider auto-detect, and the `tpre`/`tnew` interop
  contract. Also: `maxParallel` is now MEASURED, not assumed — the fake SMEs record real wall-clock
  intervals, so the suite proves dispatches genuinely overlap, stay bounded by the cap, and that a
  dispatch which throws blocks only its own task while its concurrent sibling still delivers; and the
  auto-detected verifier (the project's real test, then build) is proven both in isolation and as the
  gate an unconfigured run actually runs on.

## Unreleased — the tmux viewport, made easy and owned

One coherent verb group for the optional viewport, on a single owned tmux boundary.

- **`loop tmux pre | new | show | kill | prune`.** `pre` is a true pre-flight — it prints exactly what
  `new` would do (session, panes, action, the literal tmux argv) and issues no mutating tmux command at
  all. `new` is **idempotent**: run it twice, get one session. Stable, documented exit codes make the
  group scriptable (`0` ok · `1` error · `2` viewport unavailable · `3` foreign-session conflict · `4`
  nothing found), and `pre` returns the code `new` *would* return.
- **Nested tmux, pipes, and CI are handled, not hit.** Inside tmux, `new` runs `switch-client` instead
  of nesting an `attach-session`. With a non-TTY stdout it creates the session **detached** and prints
  the exact `tmux attach` command, instead of dying with `open terminal failed`.
- **Ownership is enforced, not assumed.** Every Loop-created session is stamped with immutable `@loop-*`
  identity metadata, and is targeted by exact identity. A session Loop did not create is never adopted,
  captured, killed, or pruned — `new` refuses it (exit 3) and leaves it untouched. Concurrent `new`
  invocations converge on exactly one session (the loser of the `duplicate session` race adopts it).
- **Fixed: session names could collide and go unfindable.** tmux silently rewrites `.` and `:` in a
  session name to `_`. Config ids may contain dots, so projects `web.api` and `web_api` collapsed onto
  **one** real session, and the predicted name never matched the real one — every `has-session` /
  capture / kill against it missed. Names are now restricted to a charset tmux stores verbatim.
- **Fixed: the team viewport only ever built one pane.** `split-window -t =name` fails (tmux reads the
  exact-target `=` prefix literally on pane commands), so a team of N roles got a single pane.
- **Fixed: cross-project exposure in the dashboard.** Sessions were filtered by name **substring**, so
  project `demo`'s dashboard listed and screen-scraped project `demo-api`'s session (`loop-demo-api-…`
  contains `-demo-`). Filtering is now by stamped identity. `loop stop` had the same substring flaw.
- **`defaults.viewport: true|false`** switches the viewport off entirely; `LOOP_TMUX=off` disables it for
  one invocation (it can only ever *disable*). `loop doctor` now reports both "is tmux installed" and
  "is the viewport enabled" — different problems, different fixes.
- No third-party tmux library: npm `tmux` is a deprecated placeholder package, and `node-tmux` is a
  stale (2022) wrapper. Neither provides exact targeting, ownership metadata, or an injectable boundary.

## Unreleased — security hardening (breaking)

Hardened the execution model and corrected the safety guarantees. **Breaking changes:**

- **A git worktree is not a host sandbox.** Isolation only protects the working tree and
  branch; **every** provider turn (planner/implementer/reviewer) **and** every verifier command
  now run in a real **OS sandbox** (Linux `bwrap` or macOS `sandbox-exec`) with **no inherited
  secrets** (env scrubbed to a small allowlist), **no host writes** outside the disposable
  checkout, and **no network** for verifiers. With no launchable sandbox, a `loop run --execute`
  **fails closed before the planner** — it ends `blocked` and can never reach `done`. The
  `LOOP_ALLOW_UNSANDBOXED` env bypass has been **removed**: there is no production way to obtain
  `done` without containment. (The `@anthropic-ai/sandbox-runtime` library is not yet integrated;
  tests use an imported trusted-runner injection, never an env var.)
- **No permission bypass by default.** Claude runs with `--permission-mode acceptEdits`
  (implementer) / `--permission-mode plan` (reviewer, read-only); Codex with
  `exec --sandbox workspace-write` / `--sandbox read-only` and effort via
  `-c model_reasoning_effort=...` (never `--full-auto`/`--effort`). Gemini/custom make no
  provider-native safety claim. `dangerouslySkipPermissions` / `yolo` are opt-in only,
  discouraged, and require an OS sandbox (fail closed otherwise).
- **Provider routing.** Claude Opus (prompts begin `/goal`) is the primary implementation
  executor; a Codex/GPT provider is used as fallback **only** on an explicitly-classified
  Claude usage/rate/quota limit, with a persisted cooldown after which Opus is retried.
  `loop init` auto-wires an `opus` + `gpt` (`fallbackFor: opus`) chain when both CLIs are
  installed. New provider knobs: `fallbackFor`, `cooldownSeconds`.
- **Config schema is now strict** (unknown keys rejected). Removed `loop.isolate` (isolation
  is always mandatory) and `loop.idleSeconds`; removed `safetyMode: full-auto` (only `review`
  and `workspace-write` remain). Added `loop.allowUnknownCostCalls` (default 0): under a
  positive `budgetUsd`, fail closed after that many unknown-cost provider calls.
- **`loop start --execute` removed.** `loop start` is now viewport-only (prompt-only tmux
  panes); agents run exclusively through the safe engine `loop run --execute`.
- **Namespaced state.** Branches, worktrees, tmux sessions, and run state are namespaced by
  project then run id: integration branch `loop/<project>/<runId>/integration`; run state
  under `.loop/runs/<project>/<runId>/`.
- **Run status semantics.** A successful dry-run ends `planned` (exit 0). A real `--execute`
  run is `done` (exit 0) only when every task is accepted AND a final verifier is green; all
  accepted with no green verifier is `unverified` (exit non-zero). blocked/stopped/cancelled/
  unverified all exit non-zero.
- **Project intelligence.** `loop learn` is the only command that writes
  `PROJECT-INTELLIGENCE.md`; `loop run` never writes project intelligence into the checkout.

## Prior unreleased — safe, end-to-end loop runner

Made the documented guarantees match runtime behavior:

- **Human gate.** `loop run --execute` requires a clean git target and NEVER touches your
  checked-out branch or working tree. Accepted work lands on a dedicated run branch
  `loop/<project>/<runId>/integration` (built in isolated worktrees) for a human to review/merge.
- **Correct success semantics.** A run is "done" only when every task is accepted AND the
  final ordered verifier is green; rejected/escalated/cancelled/budget-exhausted are never
  success. Reviewer output is strict/read-only and fails closed. Verifier timing text is
  normalized so it never looks flaky. Dry-run launches no provider at all.
- **Trust.** Agents no longer write the board/state/cost — the parent owns all coordination
  state and decides via independent review + a deterministic verifier.
- **Durability.** Atomic state, an exclusive run lease, parent-owned cancellation with
  TERM→KILL process-group shutdown, budget checks before provider calls, honest unknown-cost
  reporting, and safe resume without replanning.
- **Setup.** Valid lean starter (planner/implementer/reviewer) with no pinned models or unsafe
  defaults, provider auto-detection (`loop init --provider`), plus `loop doctor`, real
  `loop attach`, latest-run discovery, and semantic config validation. Multi-repository
  execution is rejected precisely (not silently accepted).
- **Dashboard** binds to `127.0.0.1`, validates run/session ids, and redacts env/secrets.
- **Proof.** Fake-provider end-to-end tests, CLI tests, and a disposable-repo smoke test
  (`npm run smoke`) that verifies the original checkout is unchanged and the run branch is
  verifier-green.

## 0.4.0

### Mission-control dashboard

Replaced the flat task table with an insightful, actionable dashboard (informed by how OpenHands, AutoGen Studio, and agent-observability tools like Langfuse/AgentOps present runs):

- **KPI bar** — progress %, agents active, in-progress/blocked, retries/rejections, **estimated time left**, and **spend vs budget** with amber/red thresholds.
- **Needs-attention strip** — blocked / rejected / escalated tasks surfaced with their failure reason, plus budget warnings.
- **Agent swimlanes** — per-SME card with current task, a live idle timer that flags stuck agents, spend, and an expandable terminal-output peek.
- **Dependency-aware task board** — kanban by status with dependency chips (red = blocking, green = satisfied), a "ready ▶" badge, and **critical-path** markers.
- **Activity timeline** — merged event + inter-agent message feed.

New zero-dependency JSON endpoints: `/api/overview`, `/api/agents`, `/api/timeline`, `/api/graph`, `/api/attention` (board fold + cost ledger aggregations in `src/dashboard/data.ts`). The page polls every 2.5s — no build step.

## 0.3.0

### State-of-the-art autonomy: verified, self-healing, parallel

A multi-agent SOTA audit (vs Devin, OpenHands, SWE-agent, AutoGen, MetaGPT) found the 0.2 loop shipped self-declared "done" with no independent check, ran serially, and stranded failures. 0.3 closes that gap — the team now produces **verified, self-healing, parallel** work.

- **Independent critic review** — a reviewer SME (different provider than the implementer) reviews the actual `git diff` against acceptance criteria and returns accept/reject. Replaces the old auto-accept. Rejections go back to the implementer with the reasons.
- **Repair / retry loop** — failed tasks are re-dispatched with the captured error injected into the prompt ("previous attempt failed: …; don't repeat it"), up to `maxRepairs`, then escalated to a human instead of stranded.
- **Git checkpoint + revert-on-regression** — HEAD is snapshotted before each task; a change that turns a green suite red is reverted, never inherited by the next task.
- **Reward-hacking guard** — test/CI files are hashed before and after; an agent that edits its own grader to pass is hard-blocked.
- **Real coordination** — each SME now receives an inbox (messages addressed to it) and its upstream dependencies' results, so `dependsOn` carries artifacts, not just ordering.
- **Git-worktree isolation + true parallelism** — each role works on its own branch in an isolated worktree, so SMEs run **concurrently** (`maxParallel`) without clobbering each other; accepted work is merged back to main through the critic gate.
- **Cost ledger + budget gate** — per-task spend is parsed from agent output into `.loop/board/costs.jsonl`; the run stops at `budgetUsd`.

New loop config: `reviewer`, `maxRepairs`, `maxParallel`, `isolate`, `budgetUsd`. New status `escalated`.

## 0.2.0

### Autonomous SME team

Loop Orchestrator goes from one-shot tmux prompting to an **autonomous multi-agent engineering team** that drives Claude Code, Codex, and Gemini CLI as project-trained subject-matter experts.

**New commands**

- `loop learn` — scans the repo and writes `PROJECT-INTELLIGENCE.md` (stack, frameworks, layout, and the real test/build/lint commands), injected into every agent prompt so the team is "trained" on your codebase.
- `loop run "<goal>"` — a planner agent decomposes the goal into assigned tasks on a shared blackboard, then the autonomy loop dispatches each task to the right SME, detects completion from exit code + structured output, and gates "done" on the project's test command. Dry-run by default; `--execute` launches the agents.
- `loop monitor` — single-screen mission control: the board plus a live tail of every agent's tmux pane.
- `loop roles` — list the 27 built-in SME disciplines.

**New capabilities**

- **27-discipline SME role library** (architect, PM, frontend, backend, full-stack, QA, CT/test-automation, devops, SRE, security, DBA, performance, accessibility, mobile, data, ML, and more), each with a deep system prompt and a best-fit provider. Set `sme: <discipline>` on a role to inherit the expert prompt.
- **Shared blackboard** — append-only JSONL (`.loop/board/`) with first-claim-wins coordination and `dependsOn` task gating.
- **Headless per-task execution** — tmux is the human viewport (tiled panes); control flow spawns a fresh headless `claude -p` / `codex exec` / `gemini -p` child per task for reliable completion detection.
- **Web dashboard** now includes a `/api/board` endpoint and a Board view.

**Config additions**

- `role.sme`, `project.intelligence`, and `loop.orchestrator` / `loop.idleSeconds` / `loop.pollSeconds`.
- `loop init` now scaffolds a validated 7-SME team.

## 0.1.3

- Initial public release: tmux-based role sessions, per-role provider/model selection, project briefs, prompt-only and execute modes, local dashboard, provider auth detection.

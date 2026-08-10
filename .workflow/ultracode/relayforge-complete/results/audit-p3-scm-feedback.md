# Phase 03 research: trusted SCM publication and feedback

Date: 2026-08-09
Research baseline: `997763e3d5e019b737ab704e69ec11a34c7c3592`
Disposition: research gate complete; implementation waits for the P1 store and
P2 durable-command public contracts

## Question and scope

RelayForge already creates isolated integration and attempt branches, reviews an
immutable commit, verifies a detached merge candidate, and publishes the
integration ref with Git compare-and-swap. It does not yet own a remote branch,
open or reconcile a pull request, persist provider observations, classify CI and
reviews, or turn actionable feedback into a fenced repair attempt.

This audit asks which implementations are strongest for five separate problems:

1. identifying a repository, remote branch and pull request without confusing a
   fork, stack, stale ref or unrelated human PR;
2. publishing a reviewed integration commit idempotently;
3. observing all relevant PR, CI, review and mergeability facts with bounded,
   retryable provider access;
4. converting changed facts into exactly-once durable repair work without
   treating external text as control; and
5. proving that merge or any other remote mutation still targets the expected
   head generation.

Automatic merge to the protected base branch is not a P3 requirement. RelayForge
may publish a branch and PR, report a proven ready-to-merge state, and ingest
feedback. A future auto-merge policy must be separately authorized and audited.

## Method

The mandatory Untrivial Agent Orchestrator implementation was inspected first.
GitHub searches then covered `agent CI repair`, `coding agent pull request
review`, `coding agent GitHub checks`, `agentic orchestrator review feedback`,
`GitHub check rollup polling`, `idempotent create pull request`, and adjacent
official GitHub developer tooling. Selection was based on source, tests, error
paths, recovery behavior, history and license rather than stars or README claims.

Four checkouts were cloned and pinned. `AgentWrapper/agent-orchestrator` resolved
to the exact Untrivial commit and tree and is recorded as an alias, not counted as
an independent implementation.

| Checkout | Canonical repository | Audited commit | Latest commit at audit |
|---|---|---|---|
| `ao` | `Untrivial-ai/agent-orchestrator` | `f65c48e296e20a816221a4003c75a5f0387967ec` | 2026-08-09, review-feedback injection toggle |
| `agentwrapper` | redirects to Untrivial | same `f65c48e...` | identical commit/tree |
| `doordash` | `doordash-oss/agentic-orchestrator` | `101ca9a416371c4d9db0935cf4aef73f77551366` | 2026-08-09, desktop application |
| `ghcli` | `cli/cli` | `9fc0f70e0ef97446de9166febce546e955675bc3` | 2026-08-07, active mainline |

## RelayForge baseline

Source inspected:

- `src/worktree.ts`: isolated run branches, immutable reviewed OIDs, detached
  merge candidates and `git update-ref <new> <old>` publication;
- `src/git.ts`: bounded argv-based Git execution;
- `src/orchestrator.ts`: attempt/review/verification sequencing and durable local
  run journals;
- `src/board.ts`: current informational board model;
- `src/prompts.ts`: untrusted-content and independent-review constraints;
- `tests/worktree-cas.test.ts`, `tests/worktree-gate.test.ts`, `tests/e2e.test.ts`,
  `tests/review.test.ts`, and `tests/resume.test.ts`.

Strengths already present:

- reviewed bytes are bound to an immutable commit, not a moving branch name;
- integration publication is a local atomic compare-and-swap;
- human checkout and base branch are never mutated;
- deterministic verification and independent review precede acceptance;
- failures do not silently weaken gates.

P3 gaps:

- no remote identity or credential boundary;
- no remote branch lease/expected-SHA push;
- no durable PR publication intent/result or idempotency key;
- no provider-neutral fact model, polling cursor, rate-limit state or freshness;
- no complete check/status pagination or semantic fingerprints;
- no review-thread identity and addressed-feedback ledger;
- no repair-command bridge into the P2 future-attempt boundary;
- no truthful `unknown` state for partial/stale observations.

## Primary reference: Untrivial Agent Orchestrator

### Source inspected

- `backend/internal/ports/scm_observations.go`
- `backend/internal/ports/scm_actions.go`
- `backend/internal/domain/pr.go`
- `backend/internal/observe/scm/observer.go`
- `backend/internal/adapters/scm/github/provider.go`
- `backend/internal/adapters/scm/github/observer_provider.go`
- `backend/internal/adapters/scm/github/client.go`
- `backend/internal/adapters/scm/github/auth.go`
- `backend/internal/adapters/scm/github/merge_action.go`
- `backend/internal/lifecycle/reactions.go`
- `backend/internal/lifecycle/manager.go`
- `backend/internal/storage/sqlite/store/pr_facts.go`
- `backend/internal/storage/sqlite/store/pr_store.go`
- `backend/internal/storage/sqlite/queries/pr.sql`
- `backend/internal/storage/sqlite/queries/pr_checks.sql`
- `backend/internal/storage/sqlite/queries/pr_review_threads.sql`
- `backend/internal/storage/sqlite/queries/pr_comment.sql`
- migrations `0004`, `0005`, `0006`, `0020`, `0021`, `0029`, and `0032`.

### Tests inspected

- `backend/internal/observe/scm/observer_test.go`
- `backend/internal/integration/scm_observer_test.go`
- `backend/internal/adapters/scm/github/provider_test.go`
- `backend/internal/adapters/scm/github/merge_action_test.go`
- `backend/internal/lifecycle/manager_test.go`
- `backend/internal/storage/sqlite/store/pr_facts_test.go`

The tests establish behavior that README-level descriptions omit:

- a provider result has an explicit `Fetched` authority bit; network, auth and
  malformed-payload failures do not erase prior facts;
- ETags and semantic hashes advance only after persistence and lifecycle
  reactions succeed, allowing durable retry after either layer fails;
- open-PR and check guards are separate and periodically bypassed after a bounded
  max age because endpoint ETags do not prove merged/closed state;
- all check pages are included, and incomplete context pagination can degrade a
  purported pass to `unknown` without masking a known failure;
- checks are normalized, current failing checks are fingerprinted, and log tails
  are fetched only for a new failure fingerprint;
- review summaries, threads and comments use stable provider IDs; partial review
  windows merge rather than replace complete stored state;
- authenticated identity distinguishes humans from bots, and fork head-repository
  identity prevents branch-prefix misattribution;
- stacked PRs and multiple PRs owned by one session are handled explicitly;
- CI/review/conflict reactions have durable nudge signatures that survive manager
  restart; a failed messenger send is retried;
- a merge-conflict read error does not drop already-known CI/review feedback;
- external log/comment control characters are sanitized before prompt injection;
- `ReadyToMerge` fails closed on draft, unknown/pending/failing CI, requested
  changes, unresolved comments or non-mergeable state;
- merge uses an expected head SHA and maps head-change/provider failures.

### Bug and design history inspected

- PR/commit `#3619` / `3f7b528`: `per_page=1` ETag polling left CI pending;
  the fix introduced full check fingerprints/pagination. Review discussion drove
  bounded/fallback behavior and stable hashing.
- issue/PR `#2656` / `#2678`: PR/check ETags did not always reveal merged or
  closed state, so a maximum-age forced refresh was added.
- PR `#2799`: merge-conflict observation errors must not discard independent CI
  and review nudges.
- issue/PR history around foreign PR attribution (including `#3262`) added head
  repository identity rather than trusting a matching branch string.
- PR `#3709`: review-feedback injection became an explicit project toggle,
  demonstrating that observation and agent influence are separate policy choices.

### Assessment

Agent Orchestrator is the strongest inspected implementation for continuous SCM
observation, durable semantic change detection, partial-authority handling and
feedback deduplication. Its provider-neutral DTO boundary is a sound shape.

RelayForge will not copy its Go types, SQL, queries, tests or messages. It will
independently implement the concepts on P1 canonical events/projections and use
P2 durable commands rather than direct session nudges. AO's observer stores
snapshots/hashes in subsystem tables; RelayForge can improve crash explanation by
recording each accepted observation and reaction outcome in one ordered run
history. RelayForge will also impose explicit response/page/body/log bounds and a
request budget before first production use.

## Competing coding-agent reference: DoorDash Agentic Orchestrator

### Source inspected

- `internal/github/client.go`, `rest.go`, and `graphql.go`
- `internal/git/publish.go` and `review.go`
- `internal/orchestrator/publish.go`
- `internal/server/review_feedback_fetch.go`
- `internal/feature/review_feedback_store.go`
- `internal/feature/review_feedback_outcomes.go`
- review-feedback child workflow source and API types
- relevant desktop review-feedback integration.

### Tests inspected

- `internal/github/client_test.go`, `rest_test.go`, `graphql_test.go`
- `internal/git/publish_test.go`, `review_test.go`
- `internal/server/review_feedback_fetch_test.go`
- `internal/feature/review_feedback_child_test.go`
- `internal/feature/review_feedback_store_test.go`
- `internal/feature/review_feedback_outcomes_test.go`
- `test/e2e/review_feedback_child_journey_test.go`
- desktop review-feedback and publish-recovery journeys.

### Strong behavior

- credentials and API clients are resolved per GitHub host;
- typed `go-gh` REST/GraphQL clients avoid parsing human CLI output;
- REST list methods follow GitHub Link pagination;
- PR creation resolves the default base branch and treats GitHub's 422
  `already exists` response as a lookup of the existing open PR;
- review feedback aggregates inline comments, issue comments and review bodies;
- addressed comment IDs are persisted and isolated by parent and repository;
- the fetch endpoint filters addressed IDs and fails atomically while naming the
  repository whose fetch failed;
- review-feedback child creation validates every selection before writes, uses a
  deterministic description, persists exact repository/comment IDs and rolls
  forward interrupted writes;
- publish tests cover remote-tracking base selection, draft PRs, clean commits,
  transient `index.lock` retry and explicit worktree mutation serialization.

### Weaknesses and rejected behavior

- inspected `getPaginated` follows arbitrary `Link rel=next` until exhausted with
  no explicit page or total-item ceiling;
- response-body, comment, aggregate and diagnostic bounds are not consistently
  imposed at the adapter boundary;
- the implementation is centered on explicit feature-child workflows rather
  than a continuous checks observer with AO's freshness/ETag/fingerprint model;
- create-PR idempotency recognizes an error substring and then selects the first
  open head result; RelayForge needs a durable publication intent plus exact
  repository/head/base verification before adopting an existing PR;
- ordinary `git push -u origin branch` is not an expected-remote-SHA lease.

DoorDash is therefore strongest for operator-visible publication and review
feedback decomposition, but not for authoritative continuous CI polling.

## Mature adjacent reference: GitHub CLI

### Source and tests inspected

- `pkg/cmd/pr/checks/checks.go`
- `pkg/cmd/pr/checks/aggregate.go`
- `pkg/cmd/pr/checks/output.go`
- `pkg/cmd/pr/checks/checks_test.go`
- `pkg/cmd/pr/checks/output_test.go`
- `pkg/cmd/pr/create/create.go`
- `pkg/cmd/pr/create/create_test.go`
- `pkg/cmd/pr/review/review.go` and tests
- shared PR finder and API GraphQL check-rollup fragments.

GitHub CLI paginates the status-check rollup, supports required-only views,
deduplicates repeated runs by context or `(name, workflow, event)`, selects the
most recent start, and maps provider states into pass/fail/pending/skipping/cancel
buckets. Watch mode has explicit pending and failure exit behavior and validates
flag combinations. PR creation has extensive fork/head/base/default-branch and
metadata tests and preserves interactive input on failure.

History inspected includes:

- `8253280` adding watch behavior and exit semantics;
- `dea1af1` and `d46f47e` fixing incorrect check deduplication across workflows
  and events;
- `decbbd2` separating cancelled from failed checks;
- `cce391b` ensuring an all-cancelled run still prints a summary;
- `9daa22e` rejecting identical head and base refs;
- `2b5c3b5` documenting fork default-branch behavior.

GitHub CLI is the strongest normative reference for GitHub-specific check state
aggregation and user-facing exit semantics. It is a command-line client, not a
durable control-plane observer: its watch loop sleeps in-process, does not persist
a cursor/fingerprint/reaction, and does not bind observations to RelayForge task
generations. It also has no RelayForge-style untrusted-feedback boundary.

## Architecture comparison

### Fact model

Agent Orchestrator separates provider-neutral PR, CI, review and mergeability
facts and records whether a refresh was authoritative. DoorDash uses narrower
feature-specific values. GitHub CLI builds a presentation-oriented check list.

Decision: use distinct provider-neutral fact buckets with explicit completeness,
freshness, observed head SHA and source cursor. Raw provider payloads are bounded
diagnostic evidence, never the canonical state machine.

### Polling and change detection

Agent Orchestrator has the best design: independent guards, forced max-age
refresh, semantic hashes, transactional write/reaction sequencing and durable
dedup. GitHub CLI has correct live pagination but no recovery. DoorDash does not
provide an equivalent continuous observer.

Decision: model poll attempts and accepted observations as P1 events. A guard or
304 is only evidence about that endpoint; a freshness deadline still forces a
full refresh. Cursor/guard/hash changes commit with derived projections, while
reaction completion has its own idempotency key and retry state.

### Publishing

DoorDash has the best inspected coding-agent PR-create UX and 422 recovery.
RelayForge already has a stronger local immutable OID and compare-and-swap gate.

Decision: add a durable publication state machine around an exact local
integration OID, canonical remote identity, remote branch and expected remote
OID. Use an argv-only Git transport with `--force-with-lease=<ref>:<expected>`
when updating a RelayForge-owned remote ref. Record intent before I/O and verify
the remote ref after ambiguous outcomes. Create/adopt a PR only when repo, head
repo/ref, base ref and open state exactly match the intent.

### Review feedback

Agent Orchestrator is strongest at observation/dedup; DoorDash is strongest at
explicit, auditable feedback work selection. Both eventually place provider text
in agent context.

Decision: external review/log text remains untrusted evidence. A pure policy
classifier selects bounded stable feedback IDs, then the parent emits one P2
`steer_next_boundary` command referencing the persisted evidence. No webhook,
comment, bot account or string can directly invoke a provider or mutate the task.
Addressed means included in an immutable repair prompt and later resolved by a
fresh SCM observation, not merely that an agent claimed completion.

### Remote mutation

Agent Orchestrator's expected-head merge request is the strongest inspected
primitive. RelayForge P3 nevertheless stops at ready-to-merge by default.

Decision: every remote mutation contract includes the provider resource version
or expected head SHA. Unknown live head, ambiguous identity, stale policy or
partial observation refuses the action. An eventual merge capability will be
separate from observation credentials and disabled unless policy explicitly
grants it.

## Reference Matrix

| Repository | Relevant implementation | Strength | Weakness | License | Reuse decision |
|---|---|---|---|---|---|
| RelayForge current `997763e` | Immutable review OID, detached merge candidate, local branch CAS | Strongest local artifact and no-human-checkout invariant | No remote/PR/CI/review control plane | MIT | Extend local domain model |
| Untrivial-ai/agent-orchestrator `f65c48e` | Provider-neutral observer, SQLite facts, semantic hashes, lifecycle reactions, expected-head merge | Best continuous observation, retry and durable feedback dedup | Bounds are not uniformly explicit; direct session nudge; snapshot-oriented history | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` |
| doordash-oss/agentic-orchestrator `101ca9a` | Host clients, idempotent PR create, review aggregation/addressed ledger/child workflow | Best publish and explicit review-feedback workflow UX | No AO-grade continuous observer; unbounded pagination; weak remote push lease | Apache-2.0 plus NOTICE | `ARCHITECTURAL_INSPIRATION` |
| cli/cli `9fc0f70` | Official check-rollup pagination, dedup/buckets/watch exits, PR create | Best GitHub-specific state normalization and exhaustive client tests | Ephemeral CLI loop, not durable orchestration | MIT | `ARCHITECTURAL_INSPIRATION` |
| AgentWrapper/agent-orchestrator | Redirect/byte-identical Untrivial checkout | Confirms current canonical ownership | Not an independent implementation | Apache-2.0 | `NOT_USED` as separate source |

## Reference quality score

Scored out of 100 using correctness 25, test quality 20, failure handling 15,
architecture 15, maintainability 10, activity 5, performance 5 and license 5.

| Candidate | Score | Notes |
|---|---:|---|
| Untrivial Agent Orchestrator | 91 | Deepest end-to-end observation/retry tests and active bug-fix history |
| GitHub CLI | 87 | Very strong official GitHub behavior/tests; lacks durability and orchestration |
| DoorDash Agentic Orchestrator | 84 | Strong current publish/review workflows; weaker continuous observer/bounds |
| RelayForge baseline | 58 | Excellent local Git integrity but P3 remote functionality absent |

## Chosen design

Best implementation discovered: no single repository wins the subsystem. Agent
Orchestrator wins observation and durable deduplication; DoorDash wins PR publish
and review-workflow ergonomics; GitHub CLI wins GitHub check aggregation semantics.

Why: the source and tests expose genuinely different strengths, and adopting one
repository wholesale would discard either RelayForge's immutable local artifact,
AO's recovery model, DoorDash's explicit feedback work, or GitHub CLI's nuanced
check classification.

What RelayForge will reuse: only architecture and characterization ideas:

- provider-neutral, completeness-bearing fact buckets;
- all-page check enumeration and newest-run semantic deduplication;
- freshness-forced refresh in addition to conditional requests;
- durable change/reaction keys;
- exact existing-PR reconciliation after ambiguous creation;
- stable review-feedback IDs and explicit addressed lifecycle;
- expected-head remote mutation.

What RelayForge will change:

- store all canonical facts and state transitions in the P1 ordered history;
- bind every publication/observation/reaction to run epoch, repository ID, task
  generation, attempt and immutable integration OID;
- separate read, branch-publish, PR-write and future merge capabilities;
- bound requests, pages, items, bodies, logs, diagnostics, concurrency and retry;
- route selected feedback through P2 immutable future-attempt prompts only;
- retain truthful `unknown`, `partial`, `stale` and `ambiguous` states;
- default to human-controlled merge.

How RelayForge improves it:

- remote publication becomes a recoverable state machine with an expected remote
  OID lease and post-ambiguity reconciliation;
- external text never becomes control authority;
- the same ordered history explains observations, derived readiness, attempted
  reactions and exact repair-prompt inclusion;
- provider errors cannot erase old truth or manufacture success;
- deterministic request budgets prevent a malicious or pathological repository
  from creating unbounded pagination/log/comment work;
- multi-repository identity is part of the initial P3 key rather than retrofitted.

## P3 domain and state-machine decision

### Repository identity

`ScmRepositoryIdV1` is `(provider, canonicalHost, owner, name)`. Configuration
maps one RelayForge repository key to one expected local realpath, remote name,
canonical fetch/push URL, base ref and publication policy. Discovery must not
silently choose among multiple remotes. Credentials resolve per canonical host
and are never persisted or returned by the control plane.

### Publication aggregate

One publication is keyed by `(runId, runEpoch, repositoryId, integrationRef)` and
binds:

- reviewed integration OID and local expected ref OID;
- remote name, exact `refs/heads/...` destination and expected remote OID or
  explicit proven absence;
- base repository/ref;
- stable publication ID and attempt number;
- PR title/body digests and draft flag;
- observed remote ref and PR identity/result.

States are `unpublished`, `push_intent`, `push_ambiguous`, `branch_published`,
`pr_intent`, `pr_ambiguous`, `published`, `superseded`, `refused`. A retry first
reconciles the remote resource. It never assumes a timeout means no write.

### Observation aggregate

Each accepted observation contains:

- provider/repository/PR identity and exact head/base refs and SHAs;
- PR lifecycle: draft/open/merged/closed;
- CI bucket: unknown/pending/passing/failing with complete/partial flag;
- normalized checks with stable key, current run, status, conclusion and bounded
  URL/detail/log evidence;
- review decision, summaries, unresolved threads/comments and partial flag;
- mergeability: unknown/mergeable/conflicting/blocked/unstable and blockers;
- endpoint guard/cursor, observed time, freshness deadline and request budget;
- semantic hashes per bucket.

An unsuccessful fetch appends a poll failure and preserves the previous accepted
facts. A partial response can add known failure but cannot prove global passing,
approval, no unresolved feedback or merge readiness.

### Feedback reaction

A reaction key is a canonical digest of repository, PR, head SHA, fact kind and
sorted stable evidence IDs/fingerprint. The P1 transaction creates at most one
pending reaction for a key. The parent policy revalidates task/session generation
and P2 activity before admitting a repair command. The command stores evidence
IDs/digests and a redacted bounded preview; full raw provider content is not
implicitly trusted or copied into control-plane DTOs.

Reaction states distinguish `pending`, `command_admitted`, `included`,
`observation_resolved`, `superseded`, `refused` and `failed_retryable`. Only a
fresh observation can prove resolution. Provider text cannot choose a tool,
branch, repository, target task or command kind.

### Readiness

`ready_to_merge` is a derived view, never a stored imperative. It requires:

- current open, non-draft PR at the exact published head SHA;
- fresh and complete CI with every required check passing;
- fresh and complete review facts satisfying configured human-review policy;
- no unresolved selected human feedback;
- fresh provider mergeability `mergeable` and no known blocker;
- publication and task generations still current.

Unknown, partial, stale, rate-limited or ambiguous facts are not ready.

## Bounded provider contract

Initial conservative limits, configurable only downward until real-world data
justifies an audited increase:

- 30-second request timeout and cancellation propagation;
- 20 pages per endpoint, 100 items per page, 2,000 total items;
- 4 MiB decoded response ceiling per request and 16 MiB per poll;
- 64 KiB per review/comment body, 256 KiB total feedback preview;
- 64 KiB per failing log tail and 256 KiB total new failure logs;
- four provider requests in flight per repository and eight per run;
- exponential retry with server retry/reset hints, bounded jitter and a durable
  next-eligible time; auth/permission/schema errors do not spin;
- all URLs must remain on the configured canonical provider host; pagination
  links that change authority or violate the budget fail the bucket incomplete.

These numbers are implementation defaults, not claims about GitHub API maxima.

## Failure and recovery matrix

| Failure or race | Required outcome |
|---|---|
| local integration ref changes before publish | expected-OID check refuses; no push |
| remote branch absent, push times out | state becomes ambiguous; query exact ref before retry |
| remote branch changed by another actor | lease refuses; never overwrite without new reviewed intent |
| push succeeded, process dies before result event | recovery observes exact remote OID and completes the same intent |
| PR create returns timeout/5xx | query exact head repo/ref and base; adopt only one exact open match |
| 422 says PR exists but candidates differ | refuse ambiguous adoption and expose diagnostics |
| credentials missing/expired | durable actionable failure; no secret in event or diagnostic |
| conditional request returns 304 past max age | force unconditional refresh before claiming freshness |
| second check page fails | preserve known failures; global CI is partial/unknown, never passing |
| duplicate/re-run checks | deterministic newest-run key; ties cannot produce nondeterministic readiness |
| rate limit | persist next eligible time; no hot loop or stale-ready claim |
| review window partial | merge stable IDs into stored facts; absence does not resolve old threads |
| comment body is huge/control-shaped | bounded/sanitized evidence only; never parsed as command |
| same reaction is polled after restart | existing reaction key reused; no duplicate P2 command |
| head advances after feedback selection | old reaction superseded; repair command fenced to old head/generation |
| task becomes blocked/exited | P2 admission refuses or leaves visible pending reaction; no terminal typing |
| resolution poll fails | reaction remains unresolved; old facts retained |
| PR merged/closed by human | fresh observation records terminal state; no automatic base checkout mutation |
| provider schema adds enum | map to unknown/blocked readiness, retain bounded diagnostic |
| run lease lost during poll | response may be discarded; only current writer can append accepted observation |

## Required characterization tests

### Pure domain tests

- strict repository/ref/host/URL and provider enum parsing;
- canonical check keys, newest-run tie-breaking and every GitHub conclusion;
- complete versus partial fact folding and semantic hash stability;
- readiness truth table including every unknown/stale/partial case;
- reaction keys independent of ordering and sensitive to head/evidence changes;
- state-machine transition legality and generation/version fencing.

### Adapter tests

- all endpoint pagination, last page, cycles, foreign-host Link, page/item/byte
  ceilings, cancellation, malformed/truncated JSON and unknown enum;
- ETag/304 plus forced max-age refresh;
- primary/secondary rate limits, retry hints, auth and permission errors;
- credentials per host and redaction from errors;
- check/status rollup, required flags, reruns and partial-page failure;
- review bodies, inline/issue comments, thread resolution and partial windows;
- log-tail retrieval only for new failing fingerprint and bounded control
  character normalization.

### Git/publication tests

- exact remote/ref parsing and refusal of implicit/multiple remotes;
- expected local OID and `--force-with-lease` argv without shell expansion;
- absent/existing/diverged remote refs;
- ambiguous push/create kill points and post-crash reconciliation;
- exact existing-PR adoption and ambiguous candidate refusal;
- fork, stack, renamed default base, deleted branch and concurrent human update;
- no base branch/human checkout mutation.

### End-to-end tests

- local bare remote plus fake bounded GitHub server: publish branch, create PR,
  observe failing CI, admit one P2 repair command, include it in one immutable
  prompt, publish new head, observe pass/approval and derive ready;
- crash after each external side effect and before each local commit;
- daemon restart preserves guard/freshness/fingerprint/reaction identity;
- multi-repository same branch/PR numbers remain isolated;
- malicious provider content cannot select command/tool/target;
- full control REST/SSE views are bounded and redacted;
- committed-head typecheck, complete suite, build and real local Git smoke.

## Implementation packets and ownership

Implementation begins only after P1 store and P2 command APIs are compiled and
stable.

1. **P3-A domain** — `src/scm/types.ts`, `src/scm/reducer.ts`, pure tests. No I/O.
2. **P3-B bounded GitHub adapter** — `src/scm/github.ts`, fake-server tests.
3. **P3-C Git publisher** — `src/scm/publish.ts`, local-bare-remote tests.
4. **P3-D observer/reactions** — `src/scm/observer.ts`, store integration tests;
   consumes P1 and emits P2 commands.
5. **P3-E orchestration/control views** — one owner integrates configuration,
   lifecycle, REST/SSE DTOs, doctor and CLI.
6. **P3-F E2E/docs** — full feedback-repair journey, safety/operations/API docs.

No packet may add a second SQLite writer, direct tmux input, unbounded raw API
payload event, shell-composed Git command, auto-merge default or plaintext token.

## Legal audit

### Untrivial-ai/agent-orchestrator

- License: Apache-2.0.
- Root `LICENSE` inspected; no separate root NOTICE observed in the checkout.
- Reuse: `ARCHITECTURAL_INSPIRATION`.
- No Go source, SQL, migrations, test text, messages or UI copied.

### AgentWrapper/agent-orchestrator

- GitHub redirect and local object comparison show the same Untrivial repository
  and audited commit.
- License: Apache-2.0 through the canonical checkout.
- Reuse: `NOT_USED` as a separate source.

### doordash-oss/agentic-orchestrator

- License: Apache-2.0; root `NOTICE.txt` inspected.
- Relevant Go files carry DoorDash 2026 Apache headers.
- Reuse: `ARCHITECTURAL_INSPIRATION`.
- No Go source, tests, prompts, UI or workflow text copied.

### cli/cli

- License: MIT, Copyright GitHub, Inc. 2019.
- Root license and relevant source inspected.
- Reuse: `ARCHITECTURAL_INSPIRATION`.
- No Go source, GraphQL text, test fixtures or output text copied.

No upstream code is approved for `DIRECT_COPY`, `MODIFIED_COPY` or
`PORTED_IMPLEMENTATION` in P3. A future dependency or copied fragment requires a
same-change amendment to `docs/upstream-sources.md` and all applicable notices.

## Gate result

The P3 reference gate is complete. The coherent design preserves RelayForge's
immutable local artifact and human-controlled base branch; adds recoverable
leased branch/PR publication; uses AO-grade authoritative observations on the P1
history; classifies GitHub checks with official-client semantics; and turns
stable, bounded feedback evidence into a single fenced P2 future-attempt command.

Product implementation remains gated on the compiled P1 store and P2 command
interfaces. Research completion is not phase completion.

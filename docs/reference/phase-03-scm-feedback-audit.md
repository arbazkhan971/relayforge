# Phase 03 reference audit: trusted SCM publication and feedback

Date: 2026-08-09
Status: research gate passed; P3 is product-integrated (focused 155/155) for explicit SCM/P6 publication configuration, including parent polling and reaction-to-P2 steering — see [implementation-status.md](../implementation-status.md). At decision time, implementation waited for the P1/P2 public contracts.
Local baseline: `997763e3d5e019b737ab704e69ec11a34c7c3592`

The complete source, test, history, issue/PR and legal evidence is in the
source-tree packet `.workflow/ultracode/relayforge-complete/results/audit-p3-scm-feedback.md`,
which is intentionally not included in the npm package. This document records
the packaged phase decision and required Reference Matrix; the
[upstream ledger](../upstream-sources.md) preserves the legal record.

## Scope

P3 adds recoverable publication of RelayForge-owned integration commits to a
remote branch and pull request, authoritative bounded observation of PR/CI/
review/mergeability facts, and durable feedback-to-repair reactions. It does not
auto-merge to a protected base branch, type into an active terminal, or grant
provider text control authority.

The design composes with P1 ordered history and P2 immutable future-attempt
commands. If those interfaces are unavailable, P3 stops rather than creating a
second state store or an ad-hoc message path.

## Audit method

Untrivial Agent Orchestrator was inspected first. Current GitHub searches then
covered coding-agent CI repair, PR publication, review feedback, check rollups
and idempotent GitHub operations. Actual source, tests, design material, recent
history, relevant bugs/PRs, licenses, NOTICE and file headers were inspected at
immutable pins.

`AgentWrapper/agent-orchestrator` redirects to and is byte-identical with the
Untrivial checkout at the audited commit, so it is not counted as an independent
reference.

## Reference Matrix

| Repository | Relevant implementation | Strength | Weakness | License | Reuse decision |
|---|---|---|---|---|---|
| RelayForge current `997763e` | Immutable review OID, detached merge candidate, local ref CAS | Strongest local artifact and no-human-checkout invariant | No remote/PR/CI/review plane | MIT | Extend local model |
| Untrivial-ai/agent-orchestrator `f65c48e` | Provider-neutral observer, SQLite facts, semantic hashes, reactions, expected-head merge | Best continuous observation, failure retry and durable feedback dedup | Direct session nudge; bounds not uniformly explicit; snapshot-centric history | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` |
| doordash-oss/agentic-orchestrator `101ca9a` | Host clients, idempotent PR create, aggregated/addressed feedback child workflow | Best publication and explicit review-work UX | No equivalent continuous observer; unbounded pagination; ordinary push | Apache-2.0 plus NOTICE | `ARCHITECTURAL_INSPIRATION` |
| cli/cli `9fc0f70` | Official check-rollup pagination/dedup/buckets/watch and PR create | Best GitHub state semantics and exhaustive client tests | Ephemeral CLI, not a durable controller | MIT | `ARCHITECTURAL_INSPIRATION` |
| AgentWrapper/agent-orchestrator | Redirect to exact Untrivial objects | Confirms canonical source | Not independent | Apache-2.0 | `NOT_USED` separately |

## Chosen design

Best implementation discovered: there is no single winner. Agent Orchestrator
has the strongest authoritative observation and reaction retry; DoorDash has the
strongest PR-publication/review-workflow ergonomics; GitHub CLI has the strongest
GitHub-specific check aggregation. RelayForge's existing immutable commit and
local compare-and-swap remain stronger than their local artifact boundary.

Why: source and tests show complementary strengths. Selecting one repository
wholesale would lose either durable feedback behavior, publication usability,
provider-state correctness or RelayForge's reviewed-OID guarantee.

What RelayForge will reuse: architectural and characterization ideas only—fact
bucket completeness, all-page check enumeration, semantic fingerprints, forced
freshness, durable reaction keys, exact existing-PR reconciliation, stable
feedback IDs and expected-head mutations.

What RelayForge will change:

- bind publication, observations and reactions to run epoch, repository, task
  generation, attempt and immutable integration OID;
- persist them as P1 events/projections rather than a parallel subsystem store;
- separate read, branch-publish, PR-write and future merge capabilities;
- impose request/page/item/body/log/concurrency/retry budgets;
- route selected external evidence through one P2 future-attempt command;
- default to human-controlled merge and truthful unknown/partial/stale states.

How RelayForge improves it: remote publication becomes a recoverable expected-
OID state machine; ambiguous external outcomes are reconciled before retry;
provider text never becomes control; every observation and reaction is explained
by one ordered history; and bounded budgets prevent pathological repositories
from creating unbounded controller work.

## Publication contract

A publication binds a canonical provider/host/owner/repository, one exact local
integration ref/OID, one RelayForge-owned remote ref, its expected remote OID or
proven absence, base ref, stable intent ID, PR metadata digests and result.

States are `unpublished`, `push_intent`, `push_ambiguous`, `branch_published`,
`pr_intent`, `pr_ambiguous`, `published`, `superseded` and `refused`. The parent
records intent before I/O. A timeout never means no write: recovery queries the
exact remote ref or PR and completes/adopts only an exact match.

Remote branch update uses an expected-OID lease and refuses a concurrent human
or controller advance. PR adoption requires exact repository, head repository/
ref, base ref and open state. Multiple or divergent candidates are ambiguous and
fail closed.

## Observation and readiness

Accepted provider-neutral facts have independent PR, CI, review and mergeability
buckets, exact head/base SHAs, source cursor/guard, completeness, observation
time, freshness deadline and semantic hash. Fetch failure appends an error but
does not erase prior truth. Partial data may preserve a known failure; it cannot
prove passing, approval, no unresolved comments or merge readiness.

`ready_to_merge` is a derived view. It requires a current open non-draft PR at
the exact published head, fresh complete required checks passing, fresh complete
human-review policy satisfaction, no unresolved selected feedback, fresh
mergeable status and current task/publication generations. Unknown, partial,
stale, rate-limited or ambiguous facts are not ready.

## Feedback authority

Review bodies, inline comments, issue comments and CI logs are untrusted evidence.
A pure parent policy selects bounded stable evidence IDs and creates one durable
P2 `steer_next_boundary` command. The command binds repository, PR, head SHA,
task generation and evidence digests. It cannot be authored or retargeted by a
webhook, comment, bot, log line or model output.

Addressed means the evidence was included in a verified immutable repair prompt
and a later fresh SCM observation proved resolution. Agent self-report alone does
not resolve feedback.

## Bounds and recovery

The initial adapter budget is 30 seconds per request, 20 pages/2,000 items per
endpoint, 4 MiB decoded per request, 16 MiB per poll, 64 KiB per feedback body or
failing log tail, 256 KiB aggregate previews/logs, four in-flight requests per
repository and eight per run. Pagination cannot change the configured provider
authority. Rate-limit eligibility is durable and auth/schema errors do not spin.

Required failure tests cover local/remote ref races; ambiguous push/PR creation;
forks/stacks; pagination cycles and bounds; partial check/review pages; ETag 304
past max age; rate limits; rerun deduplication; control-shaped provider text;
reaction restart dedup; head/task-generation changes; failed resolution polls;
and lease loss during response handling.

## Legal conclusion

No upstream Go source, GraphQL, SQL, tests, messages, prompts, fixtures or UI is
approved for direct or modified copy. All selected references are architectural
inspiration only. DoorDash's NOTICE and file headers were inspected; future reuse
would require a same-change attribution-ledger amendment.

## Gate result

The P3 research gate is complete and governed by
[ADR 004](../adr/004-trusted-scm-feedback.md). Product implementation still
requires focused unit/adapter/publication/recovery/E2E tests, full suite/build and
committed-head verification.

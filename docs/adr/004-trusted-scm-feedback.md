# ADR 004: Trusted SCM publication and feedback

- Status: Accepted and product-integrated (P3 focused 155/155) for explicit SCM/P6 publication configuration — see [implementation-status.md](../implementation-status.md)
- Date: 2026-08-09
- Decision owners: RelayForge maintainers
- Research: [Phase 03 reference audit](../reference/phase-03-scm-feedback-audit.md)

## Context

At decision time, RelayForge could prove and publish an accepted commit to a
local integration ref, but could not recoverably publish that artifact to a
remote branch/PR, observe CI/review state, or turn external feedback into fenced
repair work. Remote calls have ambiguous outcomes; API snapshots can be partial
or stale; and PR comments and logs are untrusted input.

## Decision

RelayForge implements SCM as four coherent boundaries:

1. a provider-neutral event/reducer model for repository, publication, PR, CI,
   review, mergeability and reaction facts;
2. a bounded read adapter whose credentials resolve per canonical host;
3. a recoverable branch/PR publisher bound to one immutable integration OID and
   expected remote OID; and
4. a parent-owned reaction bridge that admits bounded stable evidence through
   the P2 future-attempt command transaction.

P1's daemon-owned store is the sole canonical writer. P3 will not create a
parallel database, edit active terminal input or permit provider payloads to
invoke tools or choose targets.

## Identity and capabilities

A repository is identified by provider, canonical host, owner and name, with an
explicit mapping to local realpath, remote name, fetch/push URL and base ref.
Discovery never silently chooses between remotes.

Capabilities are separated:

- `scm.read` observes metadata/checks/reviews;
- `scm.publish_branch` updates one configured RelayForge-owned ref under an
  expected-OID lease;
- `scm.write_pr` creates or updates one exactly reconciled PR;
- `scm.merge` is not granted by P3 and remains disabled by default.

Tokens are used in memory, never persisted in events, runfiles, diagnostics or
API responses.

## Publication state machine

The parent persists a stable intent before every external side effect. It binds
run epoch, repository, local integration ref/OID, remote ref, expected remote
OID/proven absence, base ref and PR metadata digests.

The state sequence is:

`unpublished -> push_intent -> branch_published -> pr_intent -> published`.

Timeout, connection loss or crash after a call produces `push_ambiguous` or
`pr_ambiguous`. Recovery queries the exact resource before retry. It completes
the intent only when the remote ref equals the intended OID or exactly one open
PR matches repository, head repository/ref and base. Divergence or multiple
candidates refuses adoption.

Branch updates use an argv-only Git invocation and an expected remote-ref lease.
The base branch and human checkout are never modified.

## Observation authority

Provider adapters return distinct PR, CI, review and mergeability buckets with:

- exact head/base identity;
- authoritative/partial completeness;
- cursor or conditional guard;
- observation and freshness times;
- semantic hash;
- bounded normalized facts and diagnostics.

Only a successful authoritative bucket refresh replaces that bucket. Failure is
an event and retains prior facts. Conditional responses are periodically bypassed
after a maximum age. A partial bucket may retain known blockers but cannot prove
their absence.

## Feedback and repair

External text is evidence, not authority. A canonical reaction digest covers
repository, PR, head SHA, fact kind and sorted stable evidence IDs. One P1
transaction creates at most one pending reaction for that digest.

The parent revalidates controller lease, task/session generations and P2 activity,
then admits one `steer_next_boundary` command with bounded evidence references.
The immutable prompt artifact proves inclusion. Only a later fresh provider
observation proves resolution; agent output does not.

## Readiness

Ready-to-merge is a pure derived view. It requires an open non-draft PR at the
published head, complete fresh required checks passing, complete fresh configured
human review, no unresolved selected feedback, provider mergeability and current
generations. Unknown, partial, stale, rate-limited or ambiguous state fails closed.

P3 reports readiness but does not merge. A future merge implementation needs an
explicit policy and expected-head capability audit.

## Resource bounds

Provider calls have fixed request, page, item, decoded-byte, body, log, aggregate,
concurrency and retry ceilings. Pagination links must retain the configured host.
Rate-limit next-eligible time is durable. Unknown enums become unknown/blocking,
not success.

## Consequences

Benefits:

- publication can recover from every ambiguous external outcome without blind
  duplicate creation or overwrite;
- CI/review readiness remains truthful under partial/stale data;
- repair work is exactly attributable to stable evidence and one prompt;
- provider compromise or prompt-shaped feedback does not gain control authority;
- repository identity supports later multi-repository scheduling from day one.

Costs:

- more states and reconciliation queries than a simple `git push && gh pr create`;
- provider adapters need strict pagination/response budgets and fake-server tests;
- feedback may remain visibly pending when P2 cannot admit a safe future attempt;
- auto-merge remains intentionally out of scope.

## Rejected alternatives

- parsing human `gh` output as the product API;
- treating a network timeout as proof an external write failed;
- unconditional force-push;
- adopting the first PR returned for a branch name;
- overwriting complete old facts with a partial/error result;
- polling only ETags forever without a freshness refresh;
- typing feedback into tmux or an active provider turn;
- storing raw unbounded provider payloads in canonical history;
- granting merge authority with observation credentials.

## Verification gate

P3 is complete only after strict domain, fake-provider, local-bare-remote,
ambiguous-outcome recovery, reaction/P2 integration and end-to-end tests pass,
followed by typecheck, complete suite, build and committed-head rerun. Documentation
must not claim GitHub/SCM support before those gates pass.

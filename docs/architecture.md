# RelayForge architecture

RelayForge has one parent-owned execution path. Configuration, run leases,
contained transport, durable facts, projections, candidate acceptance, and
settlement are deliberately separate authorities; none can silently substitute
for another.

## System flow

```text
strict config + clean Git + leases
                 |
                 v
       durable SQLite control store <---- normalized observations
                 |                             |
                 |                             v
                 |                    read-only REST/SSE/dashboard
                 v
      planner creates bounded tasks
                 |
                 v
 descriptor + compatibility + probe gate
                 |
                 v
 one parent-contained provider transport
                 |
                 v
 isolated attempt worktree --> read-only review --> verifier sandbox
                 |                                      |
                 +---------- candidate/CAS -------------+
                                    |
                                    v
                         exact settlement + receipt
```

Tmux can display run panes, but it is not on the authority path.

## Parent authority and lifecycle

An executing run first validates all caller-controlled input, requires a clean
repository, takes configuration ownership and a run lease, and creates an
integration worktree. The parent cuts over to a canonical control store and
recovers or reconciles it while both leases remain held.

The active parent owns process launch, cancellation, cleanup, future-boundary
steering, integration, and finalization. Child providers cannot create sibling
authority. Shutdown drains the parent-owned steering service before closing the
control store or releasing either lease; failures preserve ownership and fail
closed.

## Durable control plane

Each run has a schema-versioned SQLite database as its post-cutover canonical
event history and projection source. The store uses strict migrations and
checksums, integrity validation, WAL mode, synchronous durability, monotonic
sequence numbers, run epochs, reducer versioning, and transactional append plus
projection updates.

The stable control-service lease is distinct from a run lease. A bounded private
discovery receipt identifies the exact service incarnation; status and stop
commands verify it rather than signaling a PID by guesswork.

Legacy JSONL artifacts are migration input only. Recovery validates their
identity, ordering, hashes, and shape, writes a receipt, and establishes one
SQLite authority. There is no dual-write canonical mode. Canonical event
retention/deletion is intentionally not yet exposed.

## Read-only loopback service

`relayforge serve` runs in the foreground and binds literal `127.0.0.1`. Its
HTTP surface is observational:

- versioned health, status, run, board, activity, steering, observation, and
  diagnostic resources;
- durable Server-Sent Event sequence notifications used as invalidation, not as
  a substitute state store;
- `GET` and `HEAD` only, except the SSE stream is `GET`;
- strict Host and Origin checks, no credentials or request bodies, canonical
  identifiers, allowlisted DTOs, redaction, and byte limits.

SSE clients resume from durable epoch/sequence identity and fetch a fresh
bounded snapshot after invalidation. A slow or stale client cannot become
authority. Typed 400, 404, 410, 413, and 503 responses distinguish invalid
requests, missing resources, expired cursors, bounded-response failures, and
required recovery.

The dashboard is one client of this service. It does not gain write authority.

## Control-room observations

Provider streams and parent activity are ingested into a bounded internal
pipeline, classified, normalized, and reduced into a presentation-safe
projection. Public records carry source continuity, typed state, bounded
summaries, and cursor identity. They do not carry raw transcript chunks, raw
PTY bytes, prompts, tool arguments, environment values, provider wire frames,
or credentials.

The public read path verifies run id, run epoch, event head, projection
continuity, cursor bounds, and response size. Missing or inconsistent evidence
produces a truthful unavailable/recovery response; it does not expose an unsafe
fallback view.

The useful operator concept is **observe → update → derive**: durable facts are
observed, projections update, and display status is derived. Older live-only
JSON state and raw-terminal streaming designs are superseded by the SQLite
control plane and normalized privacy boundary.

## Steering

Steering is a durable command for a future immutable attempt-prompt boundary.
It is admitted through a private run-scoped Unix socket owned by the active
parent. Admission binds command id, generation, run id, run epoch, principal,
text bytes, and text hash.

At a boundary, the parent deterministically includes an eligible command or
records why it cannot. Inclusion records the prompt hash and exact cutoff.
Withdrawal and supersession are monotonic. An already launched provider cannot
be changed, and neither HTTP nor tmux can inject input. Therefore:

```text
admitted != included != delivered != read != obeyed
```

## Adapter registry and contained transport

Adapter descriptors are deeply immutable, pure capability declarations. The
registry rejects duplicate and unknown identities, closes capability evidence,
and evaluates task-role compatibility before a budget reservation.

The seven provider types are:

- Claude 2.1.207;
- Codex `>=0.144 <0.145`;
- Gemini legacy versions below 1.0;
- custom legacy command adapters;
- OpenCode 1.18.15 over ACP wire v1; and
- Pi 0.84.1 over RPC JSONL; and
- Grok Build stable 1.0.0 build `3cd0d0cbce` over ACP wire v1.

ACP and Pi codecs implement total bounded framing, exact request correlation,
normalized events, and deterministic cancellation state machines. They do not
spawn. All providers route through the existing parent-contained transport,
authenticated launch handshake, bounded transcript, cancellation, and the sole
settlement kernel.

A physical call identity binds adapter, contract, transport, wire, codec,
normalizer, executable/version/behavior evidence, prompt, role, and reservation.
Replay or settlement with a mismatched identity fails closed. Reported provider
usage is normalized adversarially; unknown remains unknown.

OpenCode, Pi, and Grok require parent-contained real behavioral evidence. Grok
also requires API-key-only private configuration and exact network-tool and
unapproved-upload denial evidence; telemetry flags alone are not readiness. The release
workflow runs required executable gates, but the ordinary CLI does not currently
inject this evidence, so these routes are unavailable before reservation in a
normal configured run. This is intentional rather than a silent skip or
one-shot emulation.

## Worktrees, review, and verification

The human checkout is an anchor, not the provider workspace. Each attempt uses
a disposable worktree with an immutable base. Successful changes produce a
content-bound candidate. A reviewer observes that candidate under inner
read-only policy; it does not review a mutable branch name by trust.

The parent then runs deterministic verifier commands in a network-disabled
sandbox. Configured stability runs protect against flaky green results.
Acceptance uses compare-and-swap against the expected integration head, applies
the exact candidate, verifies again when configured, and records evidence.
Dirty or advanced private worktrees are preserved or surfaced for recovery;
they are not force-deleted.

## Containment

On Linux, providers and verifiers run in Bubblewrap mount/namespace sandboxes
and delegated cgroup v2 scopes. The launch handshake proves that the child
entered the expected physical worktree and process scope before it may observe
prompts or credentials. Verifiers have no network; providers receive only the
network and scrubbed authentication environment required by their contract.

The cgroup scope is the authoritative descendant boundary for cancellation and
cleanup. A worktree is not a sandbox, a PID is not a process tree, and a passed
provider permission flag is not the outer boundary.

The macOS backend uses `sandbox-exec`; operators must run `relayforge doctor`
and honor the reported capability limitations. Production execution never
silently falls back to an unsandboxed mode.

## Budgets and settlement

Before a physical provider call, the ledger binds and reserves an exact call
scope. The settlement kernel consumes the normalized terminal outcome once.
Retries, fallbacks, probes, cancellations, and replays cannot manufacture a new
reservation or settle a foreign scope.

Direct provider CLIs can support estimated post-response accounting or provider
subscription quota. They cannot prove a hard USD ceiling. `hard-usd` therefore
requires a route that proves a preauthorizing gateway before any call.

## SCM components

The durable control domain includes typed SCM facts and projections. Separate
bounded components implement GitHub publication intent/result, observation of
remote heads/checks/reviews, reconciliation, canonical review bodies, and
evidence binding.

These components enforce physical repository identity, expected head SHA,
trusted actor and permission evidence, monotonic observation, pagination and
rate bounds, idempotency, and CAS-safe state transitions. Free-form remote text
is evidence, never privileged instruction.

They are not currently exported as an ordinary CLI workflow or automatically
invoked by `relayforge run`. The shipped execution path must not be described as
automatically creating pull requests or ingesting remote feedback yet.

## Multi-repository components

The repository contains a fail-closed multi-repository implementation:

- canonical logical and physical repository registry;
- dependency DAG and durable scheduler fencing;
- all-or-nothing worktree readiness groups;
- per-repository candidates, CAS integration, and compensation;
- combined verification and receipts;
- local integration reconciler;
- remote publication saga; and
- typed canonical-journal orchestration over an injected contained
  worker/verifier boundary.

This is not an enabled product route in 1.0.0-rc.1. Configuration semantic
validation rejects project and role `repositories`; `relayforge run` remains
single-repository; the central ControlStore does not yet register the closed P6
fact/projection schema needed by the coordinator. The coordinator detects that
absence and fails closed. No documentation or caller should bypass that gate.

## Public versus internal surface

The npm package exports a reviewed root API and selected safe subpaths.
Settlement internals, raw control internals, transport authority, and other
sensitive modules are closed. A built file being present in `dist/` does not
make it a supported import.

Compatibility aliases execute the same CLI and resolve the same config and
state contracts; they do not create alternate architecture.

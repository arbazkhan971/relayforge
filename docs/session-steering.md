# Parent-owned session steering

RelayForge steering records bounded parent intent for a future immutable attempt
prompt. It does not type into a terminal and it does not change a provider turn
that is already running.

## What the states prove

| Label | What RelayForge can prove |
|---|---|
| `Pending` | The command was durably admitted to the canonical run history. |
| `Included` | The exact command ID is bound to the recorded bytes and SHA-256 of one named attempt prompt. |
| `Refused` | Admission was durably rejected with a reason and observed lifecycle state. |
| `Withdrawn` | A still-pending command was made terminal by its parent. |
| `Superseded` | A later admitted command explicitly replaced the pending command. |
| `Expired` | The command reached its explicit expiry before inclusion. |

`Admitted` or `Pending` never means sent, delivered, read, processed, accepted or
obeyed by a provider. `Included` proves prompt construction, not provider
cognition. RelayForge deliberately exposes no live-turn delivery state.

## Operator CLI

The active `relayforge run` parent publishes a private, digest-named socket inside a
short 0700 per-user runtime directory after canonical cutover and crash
reconciliation. Its 0600 `.steer.endpoint.json` locator remains inside the
0700 run directory and binds the canonical run path, run ID, run epoch, socket
path and socket inode. This avoids Unix socket path truncation in deeply nested
workspaces without turning the runtime directory into an authority source.
The socket accepts one bounded v1 request per connection; the locator and
socket are removed before the canonical store or lifetime leases are released.
A separate CLI process validates the locator and pinned socket identity before
connecting; it never opens the run's SQLite database.

First mint and save a stable UUIDv7. Reuse the same ID only for an exact retry
of the same immutable command:

```sh
relayforge --json steer new-id
```

Admit intent for an exact run/task/session generation and a future attempt
boundary:

```sh
relayforge --json steer admit \
  --project demo \
  --run run-20260809 \
  --run-epoch 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --command-id 0198a123-4567-7abc-8def-0123456789ab \
  --task-id task-17 \
  --task-generation 2 \
  --session-id session.0123456789abcdef0123456789abcdef \
  --session-generation 3 \
  --not-before-attempt 4 \
  --evidence event-review-17 event-ci-42 \
  --body 'Preserve the public API and add the crash-recovery regression first.'
```

The run epoch, task/session generations and lifecycle values must come from the
same current canonical projection. The read-only steering view is:

```text
GET /api/v1/runs/<run-id>/steering?project=<project-id>
HEAD /api/v1/runs/<run-id>/steering?project=<project-id>
```

The dashboard route has no admission or withdrawal method. It exposes exact
freshness/generation facts, bounded redacted previews and the next eligible
boundary when one can be proven.

To withdraw a command that is still `Pending`:

```sh
relayforge --json steer withdraw \
  --project demo \
  --run run-20260809 \
  --run-epoch 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --command-id 0198a123-4567-7abc-8def-0123456789ab \
  --reason 'Replaced by a narrower instruction.'
```

Withdrawal refuses an already included, refused, withdrawn, superseded or
expired command. Retrying the same pending withdrawal with the same reason is
idempotent; changing retry semantics conflicts.

## Failure behavior

The command fails without mutation when the locator or socket is missing,
their identities disagree, stale run identity is supplied, the parent no
longer holds both writer leases, the canonical store is unavailable, a request
exceeds its cap, the one-request framing is invalid, or the response identity
differs. A crash-left locator/socket pair is reclaimed only after the successor
parent proves its writer authority and proves the socket is stale. An active
endpoint is never replaced.

Blocked and exited sessions are durably refused. A stale task/session
generation is refused rather than retargeted. An arrival after a prompt's
capture cutoff remains pending for a later legal boundary and cannot modify
the already recorded prompt.

## Parent API

The supported root package exports:

- `createParentSteeringService({ store, authority })` for a parent that already
  owns the canonical `ControlStore`;
- `startSteeringIpcServer({ runDir, runId, runEpoch, service,
  assertAuthority })` for the run-lifetime Unix socket;
- `steeringIpcAdmitRequest(...)`, `steeringIpcWithdrawRequest(...)` and
  `sendSteeringIpcRequest(...)` for strict connect-only clients;
- the typed steering domain, activity, reducer, prompt and recovery contracts.

The run parent assigns the authenticated principal and provenance. Those
fields are absent from client requests. `startSteeringIpcServer` borrows the
already-open store through the supplied service; it never opens or closes a
store itself. Its idempotent `closeAndDrain()` must complete before the parent
closes canonical authority or releases the run/configuration writer leases.

There is intentionally no HTTP mutation endpoint, terminal/tmux input path,
PTY/stdin injection, generic board-message promotion or legacy-message import
into this command lifecycle.

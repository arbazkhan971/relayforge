# RelayForge safety model

RelayForge treats coding-agent output as untrusted. A disposable Git worktree
isolates branches, but it is not a host sandbox. Executing runs therefore use a
parent-owned chain of strict config, leases, OS containment, authenticated
launch, bounded protocol transport, independent review, deterministic
verification, exact process-scope cleanup, and settlement replay.

## Before execution

`relayforge run` is a dry run unless `--execute` is present. An executing run
requires a valid unambiguous config, a clean Git target, a supported sandbox,
and exclusive config/run authority. Failure occurs before a provider can see a
prompt when these preconditions are not proven.

Use `relayforge doctor` before spending tokens. It reports host/config/provider
readiness, but a CLI on PATH or successful `--version` is not native-adapter
compatibility evidence.

## Worktree and Git boundaries

- The operator's checkout is an anchor and is never reset, cleaned, checked
  out, or merged into by an executing run.
- Each attempt uses a disposable worktree outside the checkout. Accepted work
  accumulates on `.loop` protocol branches for human review.
- Parent Git calls neutralize hooks, external diff, filesystem monitor,
  credential helper and pager execution. Provider-writable roots exclude host
  Git configuration.
- Dirty or advanced owned worktrees are preserved or surfaced for recovery;
  cleanup does not destroy unclassified work.

## OS containment and process ownership

Every provider and verifier uses the same parent-owned containment launcher.
On the strongest Linux path, Bubblewrap confines mounts and a delegated cgroup
v2 scope bounds and owns the complete child tree. A nonce-authenticated
pre-exec handshake proves executable identity, physical working directory and
scope membership before prompt/credential release.

Providers retain network access for their approved model API. Verifiers run
without network. Both receive a scrubbed environment and cannot write outside
their allowed worktree and narrow private adapter state. If the required OS or
cgroup capability is absent, execution fails closed; there is no production
unsandboxed override.

Cancellation first uses the provider's structured cancel/abort where proven,
then the central exact-scope reaper. Success requires a proven-empty owned
scope. A PID guess, child exit, EOF, or timeout is not cleanup evidence.

## Adapter and credential policy

Descriptors and codecs are pure. They cannot spawn, choose a shell, widen
filesystem/network policy, download a package, or mint cost/fallback/settlement
authority. The parent resolves and content-binds the exact executable, selects
the role before reservation, serializes prompt bytes, frames output once, and
replays the durable transcript during settlement.

- Claude and Codex receive their characterized inner workspace/read-only
  modes; outer containment remains authoritative.
- Gemini and custom make no stronger provider-native safety claim.
- OpenCode and Pi require exact executable/version/protocol/behavior evidence;
  Pi reviewers also bind the shipped read-only helper. Product execution is
  credential-gated: a linked personal subscription (installed CLI login) or an
  API key must exist, and refusal for a missing link stays zero-mutation.
- Grok accepts a linked `XAI_API_KEY` or a personal xAI subscription login,
  which is seeded as a bounded copy into the private per-run Grok home (1 MiB
  cap, symlinks never followed) so the isolation evidence is untouched. It
  forces a private HOME/GROK_HOME, disables
  update, telemetry, trace/feedback upload, memory, subagents and web tools,
  forbids leader/serve/headless/plugin/endpoint/always-approve/yolo surfaces,
  and still requires distinct behavioral configuration, network/tool and
  no-unapproved-upload evidence. Environment flags alone are not proof.
  Unattended workers receive only an exact parent-selected ACP `allow_once`;
  reviewers receive no approval, and persistent options are never selectable.

Never store a secret in YAML. Use the named provider environment variable. The
scrubber admits only the closed provider allowlist; public control-room DTOs
exclude credentials and environment values.

## Review, verification, and settlement

An agent cannot accept its own work. A separate reviewer sees a content-bound
candidate under a read-only outer boundary and, where supported, an inner
provider policy. Malformed review output rejects. Verifier commands run in a
fixed order in the no-network verifier sandbox; configured stability runs must
all pass.

Provider output is byte- and frame-bounded. A terminal must be complete,
correlated and accepted by the versioned grammar. Missing usage/cost/limits are
unknown, never zero. Generic error text or model prose never authorizes paid
fallback. The settlement kernel rereads the private fsynced transcript with
the exact adapter/contract/wire/codec/normalizer identity before releasing a
reservation.

## Durable control, steering, and privacy

SQLite is the canonical post-cutover run history and projection source. The
foreground control service binds `127.0.0.1` and is read-only HTTP/SSE. It
validates Host/Origin, methods, bodies, IDs, cursors and byte bounds. Public
observations are normalized and redacted; raw transcripts, PTY bytes, prompts,
tool arguments and secrets are not public DTOs.

Steering is admission for a future immutable attempt prompt. It does not alter
an already-running provider and does not prove inclusion, delivery, reading or
compliance. Its mutation endpoint is a private run-scoped Unix socket owned by
the active parent, not HTTP or tmux.

## Budgets

- `unlimited` sets no USD ceiling.
- `estimated-usd` is a reservation/accounting tripwire and may overshoot by an
  in-flight request.
- `hard-usd` requires a proven preauthorizing gateway; direct CLIs do not
  qualify.
- `subscription-quota` tracks provider quota without pretending it is USD.

A positive budget requires a positive per-call reservation bound. Unknown cost
fails closed unless the explicitly bounded unknown-call allowance permits it.

## Offline provisioning

Provisioning copies already-present local dependency trees into owned
worktrees. It never downloads packages, runs installers or lifecycle scripts,
or mutates the source tree. Copies are bounded and revalidated against source
identity. Operators must budget the disk and time cost and keep secrets out of
provisioned trees.

## Current product boundary

Single-repository execution is live. Until the multi-repository P6 route is
fully enabled and gated, non-empty repository groups remain rejected by
semantic validation; library/coordinator modules are not permission to bypass
that failure. SCM publication/observation/reconciliation components likewise
do not imply that ordinary `relayforge run` automatically creates or repairs a
pull request.

Recommended operating practice:

1. run dry first and inspect the plan;
2. protect production branches and review the integration candidate;
3. use disposable test data and staging credentials;
4. require human approval for auth, billing, migrations and production data;
5. keep provider, Bubblewrap, cgroup and credential setup operator-managed;
6. stop and investigate any recovery-required, uncertain settlement, stale
   cursor, identity mismatch, or surviving scope.

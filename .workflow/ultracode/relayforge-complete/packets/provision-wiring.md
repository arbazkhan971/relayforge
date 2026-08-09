# Packet: provision-wiring

## Objective

Wire the audited provisioning barrier into every executable worktree and prove
no planner/provider/reviewer/verifier observes an unready checkout.

## Owned files

- `src/orchestrator.ts`
- `src/index.ts`
- `tests/fixtures/fake-provider.mjs`
- `tests/provision-e2e.test.ts` (new)

Do not edit any other file.

## Contract

- Import the core `provisionWorktree` API (alias it locally if useful).
- Add `provision: []` to the fallback `LoopConfig`.
- Use the private owned worktree run root as `transactionRoot` (outside each
  agent-visible checkout, same filesystem), not the repository `.loop` path.
- Synchronously gate the integration checkout before planner/preflight, every
  isolated attempt before dispatch/verify, and every isolated detached review
  checkout before reviewer use. A non-isolated review fallback reuses the
  already provisioned attempt.
- `ok:false` must emit one bounded parent event and throw/refuse. Never log and
  continue. Success emits bounded non-secret directory/count information.
- Export the core module from `src/index.ts`.
- Add an optional fake-provider requirement that exits nonzero when a named
  relative file is absent, allowing one E2E run to prove planner, implementer,
  and reviewer all crossed the barrier.

## Tests

- Build a clean ignored origin `node_modules` fixture with an executable
  internal `.bin` symlink, structured config, and verifier. One real fake-agent
  E2E run must complete, proving integration, attempt and review readiness while
  leaving the human checkout/source dependency bytes unchanged.
- A configured missing/unsafe source must fail before the planner: provider
  capture absent, state blocked/refused, no verifier side effect.
- Empty configuration remains behaviorally unchanged and writes no provision
  transaction state.

Use the existing trusted-runner fixture approach. Do not weaken containment,
settlement, test timeouts, or existing assertions.

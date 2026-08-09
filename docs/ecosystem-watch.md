# Ecosystem Watch

RelayForge rescans the coding-agent ecosystem before every phase and performs a
broader rescan at phases 10, 20, 30, 40, 50, and the v1 release candidate. This
file records candidates; inclusion is not endorsement or permission to copy.

## Initial scan — 2026-08-09

Search themes included coding-agent orchestration, agent fleets, worktrees,
sandboxes, CI repair, schedulers, software factories, and autonomous software
engineering. Activity dates below are the audited local HEAD dates, not star
rankings.

| Repository | Latest audited activity | License observed | Why it remains on the watch list | Current action |
| --- | --- | --- | --- | --- |
| [Untrivial-ai/agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator) | 2026-08-09 | Apache-2.0 | Primary practical fleet lifecycle, recovery, SCM, desktop reference | Audited for Phase 00; revisit every relevant phase |
| [GoogleCloudPlatform/scion](https://github.com/GoogleCloudPlatform/scion) | 2026-08-08 | Apache-2.0 | Containers, shared provisioning, memory/context and doctor | Audited for Phase 00; revisit sandbox/runtime phases |
| [daintreehq/daintree](https://github.com/daintreehq/daintree) | 2026-08-08 | Apache-2.0 + NOTICE | Strong local terminal/worktree/control-room UX | Audited for Phase 00; revisit desktop/control-room phase |
| [stagewise-io/stagewise](https://github.com/stagewise-io/stagewise) | 2026-08-07 | AGPL-3.0 | Agentic IDE, preview integration, Git workflows, worktree setup runner | Architecture study only; revisit UI/preview phases |
| [johannesjo/parallel-code](https://github.com/johannesjo/parallel-code) | 2026-08-05 | MIT | Lightweight parallel UX and diff/merge ergonomics | Audited for Phase 00 |
| [fynnfluegge/agtx](https://github.com/fynnfluegge/agtx) | 2026-08-05 | Apache-2.0 | Worktree setup and config-hash trust | Audited for Phase 00 |
| [awslabs/cli-agent-orchestrator](https://github.com/awslabs/cli-agent-orchestrator) | 2026-08-09 | Apache-2.0 + NOTICE | Active terminal/worktree orchestration and environment policy | Audited for Phase 00; revisit adapters/terminal phases |
| [nekocode/agent-worktree](https://github.com/nekocode/agent-worktree) | 2026-07-15 | MIT | Focused worktree wrapper, reflink copy, submodules, stable status | Audited for Phase 00 |
| [stellarlinkco/myclaude](https://github.com/stellarlinkco/myclaude) | 2026-05-04 | AGPL-3.0 | Structured multi-provider development phases | Phase-00 setup audit complete; idea-only for planning/role phase |
| [OpenBMB/ChatDev](https://github.com/OpenBMB/ChatDev) | 2026-07-24 | Apache-2.0 | Hierarchical roles plus bounded agent-driven environment commands | Phase-00 adjacent setup audit complete; revisit planning research |
| [jayminwest/overstory](https://github.com/jayminwest/overstory) | 2026-05-28, archived | MIT | Valuable recovery/doctor bug history despite archival | Audited for Phase 00; do not treat as active baseline |
| [navikt/cplt](https://github.com/navikt/cplt) | 2026-08-03 | MIT | Strong Bubblewrap production-parity probe, nested namespaces, and required-sandbox CI discipline | Audited for Phase 00.2; revisit sandbox/runtime phases |
| [dtormoen/tsk](https://github.com/dtormoen/tsk) | 2026-07-28 | MIT | Practical nested container builds and useful limit-downgrade negative history | Audited for Phase 00.2; retain as a negative regression reference |
| [alibaba/OpenSandbox](https://github.com/alibaba/OpenSandbox) | 2026-08-06 | Apache-2.0 | Authenticated blocked Bubblewrap launch, bounded status handling, and namespace identity | Audited for Phase 00.2; revisit sandbox/runtime and remote-execution phases |
| [anthropic-experimental/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime) | 2026-08-07 | Apache-2.0 | Nested namespace/capability ordering and coding-agent sandbox hardening history | Audited for Phase 00.2; revisit sandbox/runtime phases |
| `morapelker/hive` | Found in initial scan | Recheck before use | Active coding-agent fleet candidate | Triage in daemon/scheduler rescan |
| `stablyai/orca` | Found in initial scan | Recheck before use | Adjacent orchestration candidate | Triage in planner/adapter rescan |
| `mco-org/mco` | Found in initial scan | Recheck before use | Multi-agent coding orchestration candidate | Triage in planner/control-plane rescan |
| `h5i` | Found in initial scan | Recheck before use | Adjacent coding-agent infrastructure | Identify canonical repository before use |
| `Pane` | Found in initial scan | Recheck before use | Terminal/control-room candidate | Identify canonical repository before UI phase |

`AgentWrapper/agent-orchestrator` is intentionally absent as a second candidate:
GitHub redirects it to the Untrivial repository and both audited checkouts were
the same repository ID, commit, and tree.

## Rescan protocol

For each new candidate, record the canonical URL, HEAD/date, license and NOTICE,
source/tests/design files inspected, important issues/PRs, subsystem quality,
and a reuse classification in `docs/upstream-sources.md`. A repository does not
enter a phase matrix on README claims alone.

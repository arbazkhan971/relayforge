# Phase 04 reference addendum: Grok Build native ACP

Date: 2026-08-09
Canonical source: [`xai-org/grok-build`](https://github.com/xai-org/grok-build)
at `8a14c91d88875a831a38b3a066b1683116bcb31c`

## Decision

RelayForge supports Grok Build only through its native persistent ACP v1 stdio
service. The trusted parent invokes an exact installed stable 1.0.0 runtime as
`grok --no-auto-update --disable-web-search --no-subagents --no-memory agent
--no-leader stdio`, carries standing/task prompts on ACP, and retains the one
existing contained transport, transcript replay, cancellation, scope cleanup
and settlement authority.

Availability is fail-closed. In addition to executable identity, stable
version/build/channel and the full ACP lifecycle, the probe must bind evidence
that Grok used a private empty HOME/GROK_HOME, the fixed network/tool policy,
and no unapproved telemetry, trace or codebase upload. The supported profile is
API-key-only; ambient subscription/managed configuration is not reused.

## Reference Matrix

| Source | Pin | Use |
| --- | --- | --- |
| `xai-org/grok-build` | `8a14c91d88875a831a38b3a066b1683116bcb31c` | Canonical CLI/ACP/config/test characterization; `ARCHITECTURAL_INSPIRATION` |
| Agent Client Protocol | P4 pin `1fc9d6ce50263b08e8d52847138ec249209b06f2` | Existing independently written ACP v1 codec |
| OpenCode, AO and acpx P4 corpus | pins in the main P4 audit | Registry, native-ACP and lifecycle comparison |
| Grok plugin/privacy/integration references | current 2026-08-09 issue/docs scan | Negative regression and transport corroboration only; no source copied |
| user-requested daemon branch and active RelayForge base | `f0914c092157b7d63ba98481ce313b2d53abcfe2`, `73051d510c6473fa763bc7cd81921f65bec00eea` | The branch is `NOT_USED`; its live JSON design is superseded. The active base is the implementation baseline, not an external adapter source. |

The installed runtime reported `1.0.0 (3cd0d0cbce) [stable]`. That build
identity is kept distinct from the public mirror source pin and is revalidated
before every launch.

## Chosen design

The Grok descriptor is immutable data. It cannot spawn, select a shell, widen
the sandbox, choose endpoints, import plugins, mint fallback/cost evidence, or
settle a call. Raw command, argv, env, leader/socket, serve/headless,
always-approve/yolo, trust, plugin and endpoint overrides are rejected.

Grok uses the shared ACP v1 framing and normalizer machinery with a distinct
normalizer identity. Bounded `session/new._meta.systemPromptOverride` carries
standing instructions, `session/prompt` carries the task, and normal ACP cancel
precedes the central exact-scope reaper. Workers use native `default` mode and
the parent selects only an exact provider-offered ACP `allow_once`; reviewers
use `plan` and the parent cancels permission requests. Persistent approval is
never selectable. Both roles require the outer sandbox; reviewers additionally
require the characterized native plan policy and real write denial.

Full source/test/history/license findings, privacy precedence analysis,
adjacent references, and the required-real command are recorded in the
source-tree packet
`.workflow/ultracode/relayforge-complete/results/audit-p4-grok-build-addendum.md`,
which is intentionally not packaged. The packaged legal record is the
[upstream ledger](../upstream-sources.md).

# RelayForge branding and compatibility

## Canonical identity

Use **RelayForge** in prose and `relayforge` for the package, executable,
configuration prefix, and environment-variable prefix.

| Context | Canonical form |
| --- | --- |
| Product | RelayForge |
| npm package | `relayforge` |
| Command | `relayforge` |
| Configuration | `relayforge.config.yaml` |
| Environment | `RELAYFORGE_*` |
| Release tag | `v1.0.0-rc.1` |

The recommended one-line description is:

> RelayForge coordinates contained AI coding agents through planning, isolated
> implementation, independent review, and deterministic verification.

Do not describe the product as a terminal multiplexer, a collection of shell
wrappers, an unsandboxed multi-agent runner, or a remote control service. Tmux is
optional presentation; the parent process, durable store, contained transport,
and settlement kernel hold authority.

## Compatibility vocabulary

“Loop Orchestrator” is the historical product name. `loop` and
`loop-orchestrator` are compatibility executable aliases that invoke the same
entry point as `relayforge`; they are not separately versioned products.

The following legacy surfaces remain intentional compatibility contracts:

- `loop.config.yaml`, `loop.config.yml`, and `loop.config.json`
- `.loop/` durable state, prompts, locks, receipts, and run directories
- documented `LOOP_TMUX`, `LOOP_TMUX_SOCKET`, and `LOOP_SANDBOX` aliases
- historical names in older changelog entries and migration documentation

New examples and operator instructions must use the RelayForge forms. Do not
rename `.loop/`, silently rewrite an adopted legacy config, or create both
config families. When multiple supported config files are visible in one
directory, discovery fails with `CONFIG_AMBIGUOUS` until the operator chooses an
exact `--config` path or removes the ambiguity.

When a public RelayForge and legacy environment variable are both set, they
must agree. A conflict fails closed; the canonical variable does not silently
win.

## Claim rules

Release and product text must distinguish implemented machinery from enabled
operator behavior:

- Say that single-repository execution is available.
- Say that multi-repository execution is product-integrated through strict
  config/validation and the actual CLI path, while incomplete capabilities fail
  before mutation.
- Say that explicit SCM/P6 publication config enables recoverable publication,
  parent polling, and reaction-to-steering. Do not imply that unconfigured runs
  invent or perform remote publication.
- Say that OpenCode, Pi, and Grok native adapters exist, but require exact contained
  behavioral evidence. Installation or `--version` alone does not establish
  readiness.
- Say that Grok support is API-key-only and private-config/no-upload gated; do
  not imply that ambient Grok login, environment disables alone, or
  `--version` makes it available.
- Say that the control service is local, loopback-only, and read-only. Do not
  call it a remote daemon API or terminal gateway.
- Say that normalized observations omit raw transcripts and secrets. Do not
  advertise raw terminal streaming.
- Say that estimated USD budgets are soft tripwires. Only a proven
  preauthorizing gateway can support a hard USD ceiling.

## Release-status language

The source currently identifies as `relayforge@1.0.0-rc.1`. That is not evidence
that the package is visible on npm or that a repository, remote, tag, GitHub
release, website, or social handle has been changed.

Until an authorized operator completes and verifies publication, use:

> The RelayForge 1.0.0-rc.1 source candidate is prepared. External npm
> publication, repository rename, release creation, and remote tag publication
> have not been performed.

After publication, replace this statement only with registry and remote
evidence for the exact version and integrity.

## Visual usage

The bundled mark under `assets/` may be used with the alt text “RelayForge”.
Keep the wordmark readable and avoid placing compatibility aliases in the
primary logo. In plain-text surfaces, the name alone is sufficient; emoji and
mission-control language are presentation choices, not product identity.

## Attribution

RelayForge is informed by multiple upstream systems and audits. Do not imply
upstream endorsement. The classification ledger in
[`upstream-sources.md`](upstream-sources.md) records whether each influence was
a direct copy, modified copy, port, architectural inspiration, idea only, or
not used.

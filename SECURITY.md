# Security Policy

Please report security issues privately to the maintainers via
[GitHub Security Advisories](https://github.com/arbazkhan971/relayforge/security/advisories/new)
or the contact listed on the repository.

## Scope

Security issues include command injection, unsafe default behavior, credential
leaks, containment escapes, or documentation that encourages unsafe production
access.

## Safe usage

RelayForge launches local terminal commands under operator-configured providers.
Review your configured provider commands and flags before using `--execute`.
Prefer dry-run first (`relayforge run "…"` without `--execute`).

Compatibility aliases `loop` and `loop-orchestrator` invoke the same binary as
`relayforge`; security policy is identical for all three.

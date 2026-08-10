# Contributing

Thanks for improving **RelayForge**.

Repository: [github.com/arbazkhan971/relayforge](https://github.com/arbazkhan971/relayforge)

## Development

```bash
npm ci
npm run validate
```

On a delegated-cgroup Linux host, recheck the strong matrix with:

```bash
RELAYFORGE_TEST_REQUIRE_CGROUP=1 npm run validate
RELAYFORGE_TEST_REQUIRE_CGROUP=1 npm run smoke
```

## Pull requests

- Keep changes focused.
- Add or update tests for behavior changes.
- Avoid private company, customer, or repository names in examples.
- Update documentation when changing commands or config.
- New operator-facing docs and examples use **RelayForge** / `relayforge`.
  Legacy `loop` / `loop-orchestrator` aliases and `loop.config.*` / `.loop/`
  remain intentional compatibility surfaces — do not break them casually.

## Identity

See [docs/branding.md](docs/branding.md) for claim rules and naming.

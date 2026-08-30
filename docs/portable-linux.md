# Portable Linux installation

RelayForge ships a self-contained `linux-x64-gnu` bundle for Ubuntu 22.04 or
newer. It carries its own pinned Node runtime and the exact native SQLite
binding, so the target laptop or VM does **not** need Node, npm, Python, `make`,
or a C/C++ compiler.

The portable assets are built and clean-host tested by CI. Until an operator
approves a public GitHub Release, download the `relayforge-portable-linux-x64-*`
artifact from the repository's successful CI run. That artifact contains:

- `relayforge-<version>-linux-x64.tar.gz`
- `install-relayforge-<version>-linux-x64.sh`
- `portable-release.json`
- `SHA256SUMS`

## Install

Keep the downloaded files together, then verify and install:

```bash
cd /path/to/relayforge-portable-linux-x64
sha256sum --check SHA256SUMS
sh install-relayforge-1.0.0-rc.1-linux-x64.sh \
  --archive relayforge-1.0.0-rc.1-linux-x64.tar.gz
export PATH="$HOME/.local/bin:$PATH"
relayforge --version
```

The installer verifies its embedded archive SHA-256 before extraction. It
installs without root into `$XDG_DATA_HOME/relayforge` or
`$HOME/.local/share/relayforge`, activates a version atomically, and creates
the `relayforge`, `loop`, and `loop-orchestrator` links in `$HOME/.local/bin`.

After a public Release is explicitly approved, the installer can also download
its exact checksum-bound archive when `--archive` is omitted:

```bash
sh install-relayforge-1.0.0-rc.1-linux-x64.sh
```

## Upgrade and rollback

Run the newer version's installer. The previously active version is kept and
can be restored without a network request:

```bash
sh install-relayforge-<new-version>-linux-x64.sh \
  --archive relayforge-<new-version>-linux-x64.tar.gz

sh install-relayforge-<new-version>-linux-x64.sh --rollback
```

The installer refuses to replace unrelated files in `$HOME/.local/bin`, an
install prefix that is itself a symlink, a corrupt archive, an archive for the
wrong product layout, or an existing version with different contents.

## What the bundle does not install

RelayForge still uses host tools that are part of the coding workflow:

- Git is required for project setup and worktrees.
- Your chosen coding-agent CLI (`codex`, `claude`, or `gemini`) and its login
  are required for a paid `--execute` run.
- `tmux`, Bubblewrap, and a delegated cgroup v2 scope are required for the full
  contained execution path on Linux.

None of those are needed to run `relayforge --version`. Git is enough for
`setup`, a no-cost dry-run, and the loopback dashboard. Continue with the
[laptop and VM quickstart](laptop-vm-quickstart.md) after installation.

## Build and verify the assets

This section is for maintainers; build dependencies stay on the build host:

```bash
npm ci
npm run portable:linux
sh scripts/smoke-portable-linux.sh .portable
(cd .portable && sha256sum --check SHA256SUMS)
```

The builder pins the official Node 22.23.2 Linux x64 archive and its SHA-256,
installs production dependencies from `package-lock.json`, proves
`better-sqlite3` loads, audits the maximum GLIBC versions, and creates the
normalized archive twice. The clean-host smoke then starts an Ubuntu 22.04
container, proves Node/npm/Python/compilers are absent, installs as an
unprivileged user, runs setup and a dry-run, opens the dashboard, enforces the
two-minute ceiling, and records the result in `portable-release.json`.

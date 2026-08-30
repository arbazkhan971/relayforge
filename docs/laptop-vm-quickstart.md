# Laptop and VM quickstart

This is the shortest supported path from a normal coding repository to a
RelayForge plan or an executed, reviewed, verified coding run.

## Choose where to run

- **Any supported laptop:** setup, validation, dry-run planning, dashboard, and
  run inspection work locally.
- **Linux laptop or Ubuntu VM:** the full `--execute` path works when Bubblewrap
  and delegated cgroup v2 are available.
- **macOS or another host without a strong process scope:** plan locally and run
  `--execute` from a Linux VM containing the same Git repository. RelayForge
  deliberately has no uncontained override.

## 1. Install the host prerequisites

Install Node.js 20.x or 22+, Git, and the coding-agent CLI you already use.
Ubuntu/Debian hosts also need:

```bash
sudo apt-get update
sudo apt-get install -y git tmux bubblewrap build-essential python3
node --version
git --version
bwrap --version
```

Install RelayForge directly from its current GitHub `main` branch:

```bash
npm install -g github:arbazkhan971/relayforge
relayforge --version
```

Then install and sign in to one provider CLI. For example, if you use Codex,
make sure `codex --version` works in the same shell.

## 2. Set up a coding repository

```bash
cd /path/to/your-project
relayforge setup --provider codex
```

Use `claude` or `gemini` instead of `codex` when appropriate. `setup` is safe to
rerun: it keeps an existing config, keeps project intelligence unless
`--refresh` is passed, validates the project, and prints separate planning and
execution readiness.

The first setup adds configuration files. Review and commit them before a real
execution because RelayForge requires a clean Git target:

```bash
git add relayforge.config.yaml brief.md .gitignore
git commit -m "chore: configure RelayForge"
```

`PROJECT-INTELLIGENCE.md` and `.loop/` are generated local state and are ignored
by default.

## 3. Plan, then code

Start with the no-cost dry-run. It launches no provider:

```bash
relayforge run "Add a health endpoint with tests"
```

When `relayforge setup` reports coding execution ready and the repository is
clean, launch the agents:

```bash
relayforge run "Add a health endpoint with tests" --execute
```

If the doctor asks for a delegated user scope, run the execution from one:

```bash
systemd-run --user --scope --collect --property=Delegate=yes \
  relayforge run "Add a health endpoint with tests" --execute
```

Host cgroup delegation varies. If the verifier-cgroup check is still red, use
the complete [Linux runner runbook](linux-runner-runbook.md); RelayForge refuses
to start agents until the host can prove containment.

## 4. Watch and control the run

```bash
relayforge monitor
relayforge attach
relayforge serve
```

The dashboard binds only to `127.0.0.1` by default. On a remote VM, forward it
over SSH instead of exposing it publicly:

```bash
ssh -L 4318:127.0.0.1:4318 user@your-vm
```

Then open `http://127.0.0.1:4318` on the laptop.


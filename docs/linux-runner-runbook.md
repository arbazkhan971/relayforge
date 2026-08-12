# Linux release-runner runbook (self-hosted GitHub Actions)

Provisions the designated runner for RelayForge release gates: cgroup-v2
delegation, Bubblewrap, the exact pinned native CLIs, and Chrome for the
packed-browser proof. After this runbook, `scripts/check-relayforge-runner.mjs`
should print `ALL PASS`.

Target: **Ubuntu 24.04**, amd64, root-capable, systemd.

## 1. Base packages

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates gnupg \
  bubblewrap libbubblewrap1 \
  build-essential python3 \
  xvfb libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
  libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 \
  libcairo2 fonts-liberation
bwrap --version   # expect 0.9.0
```

## 2. Node 20.20.2 for RelayForge + Node 22.19 for the pi adapter

```bash
curl -fsSL https://get.fnm.rs | bash   # or install fnm via your package manager
mkdir -p ~/.local/state/fnm_multishells 2>/dev/null || true
fnm install 20.20.2
fnm default 20.20.2
fnm install 22.19.0
node -v   # v20.20.2
npm -v    # 10.8.2
```

The pi adapter pins run on Node >=22.19.0 — a wrapper script selects it:

```bash
cat > ~/.local/bin/pi <<'EOF'
#!/usr/bin/env bash
# RelayForge pi adapter pin: @earendil-works/pi-coding-agent@0.84.1 on Node >= 22.19
export PATH="$HOME/.fnm/node-versions/v22.19.0/installation/bin:$PATH"
exec "$HOME/.local/share/fnm/node-versions/v22.19.0/installation/bin/node" \
  "$HOME/.local/share/fnm/node-versions/v22.19.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/bin/pi.js" "$@"
EOF
chmod +x ~/.local/bin/pi
npm install -g @earendil-works/pi-coding-agent@0.84.1 --prefix ~/.local 2>/dev/null || true
~/.local/bin/pi --version   # 0.84.1
```

## 3. Exact native adapter pins

```bash
# opencode 1.18.15
curl -fsSL https://opencode.ai/install | bash   # then pin binary to 1.18.15 per release asset
opencode --version   # 1.18.15

# grok 1.0.0 (3cd0d0cbce) stable
github_release_get xai-org/grok-build 1.0.0 "3cd0d0cbce"   # see release asset naming
grok --version   # 1.0.0 (3cd0d0cbce) [stable]

export PATH="$HOME/.local/bin:$PATH"
```

Every pin is verified by `scripts/check-native-receipt-readiness.mjs` and the
runner checker below. Do not substitute "latest".

## 4. Delegated cgroup v2 (user slice)

RelayForge execute requires a delegated cgroup v2 with `nsdelegate`.

```bash
# confirm cgroup2
stat -fc %T /sys/fs/cgroup   # cgroup2fs

# give the login user a delegate=yes user slice
sudo mkdir -p /etc/systemd/system/user@.service.d
sudo tee /etc/systemd/system/user@.service.d/delegate.conf > /dev/null <<'EOF'
[Service]
Delegate=yes
DelegateSubgroup=relayforge
EOF
sudo systemctl daemon-reload
sudo systemctl restart user@$(id -u).service

# verify from the runner account
cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/cgroup.controllers  # cpu,memory,... including subtree delegation
systemd-run --user --scope --collect sh -c 'cat /proc/self/cgroup'   # shows a relayforge scope path
```

For CI runs use the scoped pattern:

```bash
systemd-run --user --scope --collect \
  --property=Delegate=yes --property=DelegateSubgroup=relayforge \
  <the relayforge command>
```

## 5. Chrome (packed-browser gate)

```bash
wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt-get install -y ./google-chrome-stable_current_amd64.deb
google-chrome --version   # Google Chrome 150.x
```

## 6. GitHub Actions self-hosted runner

```bash
mkdir -p ~/actions-runner && cd ~/actions-runner
curl -o actions-runner.tar.gz -L \
  https://github.com/actions/runner/releases/download/v2.330.0/actions-runner-linux-x64-2.330.0.tar.gz
tar xzf actions-runner.tar.gz
./config.sh --url https://github.com/arbazkhan971/relayforge \
  --token <registration-token> --name relayforge-runner \
  --labels relayforge-cgroup,relayforge-adapters --unattended
sudo ./svc.sh install && sudo ./svc.sh start
```

Token scopes: `repo` (workflows/publish) and `read:org` (registration). Store
`NPM_TOKEN` plus the three adapter keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`XAI_API_KEY`) as repo secrets — one secret per provider, never shared.

## 7. Verify

```bash
PATH=/usr/bin:$HOME/.local/bin:$PATH node scripts/check-relayforge-runner.mjs    # ALL PASS expected
PATH=/usr/bin:$HOME/.local/bin:$PATH node scripts/check-native-receipt-readiness.mjs
```

## Troubleshooting

- **`bash -lc` PATH isolation**: login shells reload profile PATH and can prefer
  wrong binaries. Always run gates with the explicit narrowed
  `PATH=/usr/bin:$HOME/.local/bin:$PATH` — this mirrors the auth/doctor PATH
  isolation fix (`ec3585d`).
- **cgroup delegation absent**: `DelegateSubgroup=relayforge` is required for
  nested verification jails. If `cgroup.controllers` lacks delegation for the
  user slice, reboot after the service restart, or delegate from a machine-wide
  slice instead.
- **Runner shows zero labels**: `.github/workflows/release.yml` looks for
  `[self-hosted, linux, relayforge-cgroup]` and
  `[self-hosted, linux, relayforge-adapters, relayforge-cgroup]`; a runner must
  carry both labels.
- **better-sqlite3 build on fresh install**: `npm ci` compiles the native
  binding (needs `build-essential python3`); never float to a newer tagged
  version.

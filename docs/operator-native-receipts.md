# Operator checklist: native receipts and release readiness

Concise operator surface for when live credentials exist. Aligns with
[implementation-status.md](implementation-status.md) and
[publishing.md](publishing.md). **Does not claim receipts are collected.**

## Readiness snapshot (repo query, 2026-08-10)

| Item | Status |
| --- | --- |
| Package | `relayforge@1.0.0-rc.1` |
| Changelog heading | `## [1.0.0-rc.1] - 2026-08-09` present |
| GitHub repo | `arbazkhan971/loop-orchestrator` |
| Working branch | `agent/loop-engineering-hardening` |
| Self-hosted runners (`relayforge-cgroup`, `relayforge-adapters`) | **None registered** (`actions/runners` total_count 0) |
| Actions secrets present | `NPM_TOKEN` only |
| Actions secrets missing | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY` |
| Environment `npm-release` | **Created** (2026-08-10; no protection rules yet) |
| npm CLI login on this host | **Not authenticated** (`npm whoami` → ENEEDAUTH) |
| Registry | `relayforge` absent (E404 diagnostic); recheck at publish time |
| Live paid keys in this shell | **Unset** |
| Real same-runner receipts | **Not collected** |
| Tag / npm publish / GitHub Release / rename | **Not performed** |

Designated characterization host (this machine when runners are absent):

- Linux **6.17.0-1021-gcp**, delegated user-slice cgroup v2 + Bubblewrap
- Pinned CLIs: `opencode` **1.18.15**, `pi` **0.84.1** (Node ≥ 22.19 wrapper),
  `grok` **1.0.0 (3cd0d0cbce) [stable]**
- Chrome for packed dashboard smoke: Google Chrome **150.x**

## 1. Credentials → GitHub Actions secrets

Set repository secrets (operator pastes real values; never commit them). Prefer
prompted stdin so values stay out of shell history:

```bash
# From a clean operator machine with gh auth (repo + workflow scopes).
gh secret set OPENAI_API_KEY --repo arbazkhan971/loop-orchestrator
gh secret set ANTHROPIC_API_KEY --repo arbazkhan971/loop-orchestrator
gh secret set XAI_API_KEY --repo arbazkhan971/loop-orchestrator
```

Pipe form (only if the value is already in a private file, mode 0600):

```bash
gh secret set OPENAI_API_KEY --repo arbazkhan971/loop-orchestrator < /path/to/openai.key
gh secret set ANTHROPIC_API_KEY --repo arbazkhan971/loop-orchestrator < /path/to/anthropic.key
gh secret set XAI_API_KEY --repo arbazkhan971/loop-orchestrator < /path/to/xai.key
```

Verify **names only** (values are never shown):

```bash
gh secret list --repo arbazkhan971/loop-orchestrator
# Expect: NPM_TOKEN, OPENAI_API_KEY, ANTHROPIC_API_KEY, XAI_API_KEY
```

Also create the Actions environment the publish job references (once):

```bash
gh api -X PUT repos/arbazkhan971/loop-orchestrator/environments/npm-release
```

Keep `NPM_TOKEN` for classic token publish, or configure OIDC trusted publishing
to npm under that environment. Do not put adapter keys in the npm environment
unless policy intentionally scopes them there; the artifact job reads repository
secrets.

One provider secret per collector step — never export all three into the same
shell for the local path below if you can avoid it.

## 2. Runners vs local same-job substitute

The tag-triggered workflow (`.github/workflows/release.yml`) needs:

| Job | `runs-on` |
| --- | --- |
| `gate` | `ubuntu-latest` |
| `required-cgroup` | `[self-hosted, linux, relayforge-cgroup]` |
| `artifact` | `[self-hosted, linux, relayforge-adapters, relayforge-cgroup]` |
| `publish` | `ubuntu-latest` + environment `npm-release` |

**Current gap:** no self-hosted runners are registered on the repository. Until
labels `relayforge-cgroup` and `relayforge-adapters` exist on a live Linux
runner that shares this host’s containment capability, **tag push cannot finish
the artifact job**.

### Option A — register this host as the designated runner (GHA path)

1. Install the GitHub Actions runner for Linux x64 on this machine.
2. Configure it for `arbazkhan971/loop-orchestrator` with labels:
   `self-hosted,linux,relayforge-cgroup,relayforge-adapters` (one runner may
   carry both release labels so `required-cgroup` and `artifact` can schedule).
3. Ensure the runner service PATH includes the pinned `opencode`, `pi`, `grok`,
   and Chrome, with the same cgroup delegation doctor already green.
4. Confirm:

```bash
gh api repos/arbazkhan971/loop-orchestrator/actions/runners \
  --jq '.runners[] | {name,status,labels:[.labels[].name]}'
```

Then the normal tag workflow is the authority (see [publishing.md](publishing.md)).

### Option B — local same-job path (substitutes while runners are missing)

This host is the designated characterization machine. The local path mirrors the
`artifact` job’s private workspace rules: one private `RUNNER_TEMP`, one
64-hex job nonce, per-adapter collect → required test → extract, then bundle →
publishable artifact → packed Chrome smoke. Evidence bodies are trap-deleted;
only digest-bound receipts feed the bundle. **Receipts are not collected until
the operator runs this with live keys.**

```bash
set -euo pipefail
set +x
umask 077

# Clean committed tree; identity must match the tag you will cut.
git status --short   # must be empty
COMMIT="$(git rev-parse HEAD)"
export GITHUB_SHA="$COMMIT"

# Private same-job workspace (mode 0700; scripts reject world-accessible dirs).
private_root="$(mktemp -d -p "${TMPDIR:-/tmp}" relayforge-native-XXXXXX)"
chmod 700 -- "$private_root"
export RUNNER_TEMP="$private_root"
export RUNNER_NAME="${RUNNER_NAME:-local-designated-runner}"

node -e 'const fs=require("node:fs"),crypto=require("node:crypto"),p=process.argv[1],v=crypto.randomBytes(32).toString("hex")+"\n"; const fd=fs.openSync(p,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600); try { fs.writeFileSync(fd,v); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }' "$private_root/job-nonce"
job_nonce="$(<"$private_root/job-nonce")"
[[ "$job_nonce" =~ ^[a-f0-9]{64}$ ]]

# Strong gates (same as artifact job pre-evidence steps).
RELAYFORGE_TEST_REQUIRE_CGROUP=1 npm run validate
RELAYFORGE_TEST_REQUIRE_CGROUP=1 npx vitest run tests/steering-cli-run-e2e.test.ts
smoke_log="$private_root/contained-smoke.log"
npm run smoke | tee "$smoke_log"
grep -Fqx -- 'SMOKE PASS (contained host — verified delivery on the run branch):' "$smoke_log"

# --- OpenCode (OPENAI_API_KEY only in this step) ---
export OPENAI_API_KEY  # set by operator for this step only
evidence="$private_root/opencode.json"
receipt="$private_root/opencode-receipt.json"
node scripts/collect-contained-adapter-evidence.mjs \
  --authorize-paid-probe --adapter opencode \
  --output "$evidence" --commit-sha "$GITHUB_SHA" --job-nonce "$job_nonce"
RELAYFORGE_TEST_REQUIRE_OPENCODE=1 \
  RELAYFORGE_TEST_OPENCODE_CONTAINED_EVIDENCE_FILE="$evidence" \
  RELAYFORGE_TEST_EVIDENCE_JOB_NONCE="$job_nonce" \
  npx vitest run tests/adapter-opencode.test.ts
node scripts/create-native-adapter-receipt-bundle.mjs --extract \
  --adapter opencode --evidence-file "$evidence" \
  --receipt-output "$receipt" --commit-sha "$GITHUB_SHA" --job-nonce "$job_nonce"
rm -f -- "$evidence"
unset OPENAI_API_KEY

# --- Pi (ANTHROPIC_API_KEY only) ---
export ANTHROPIC_API_KEY
evidence="$private_root/pi.json"
receipt="$private_root/pi-receipt.json"
node scripts/collect-contained-adapter-evidence.mjs \
  --authorize-paid-probe --adapter pi \
  --output "$evidence" --commit-sha "$GITHUB_SHA" --job-nonce "$job_nonce"
RELAYFORGE_TEST_REQUIRE_PI=1 \
  RELAYFORGE_TEST_PI_CONTAINED_EVIDENCE_FILE="$evidence" \
  RELAYFORGE_TEST_EVIDENCE_JOB_NONCE="$job_nonce" \
  npx vitest run tests/adapter-pi.test.ts
node scripts/create-native-adapter-receipt-bundle.mjs --extract \
  --adapter pi --evidence-file "$evidence" \
  --receipt-output "$receipt" --commit-sha "$GITHUB_SHA" --job-nonce "$job_nonce"
rm -f -- "$evidence"
unset ANTHROPIC_API_KEY

# --- Grok (XAI_API_KEY only; ambient OAuth is not release evidence) ---
export XAI_API_KEY
evidence="$private_root/grok.json"
receipt="$private_root/grok-receipt.json"
node scripts/collect-contained-adapter-evidence.mjs \
  --authorize-paid-probe --adapter grok \
  --output "$evidence" --commit-sha "$GITHUB_SHA" --job-nonce "$job_nonce"
RELAYFORGE_TEST_REQUIRE_GROK=1 \
  RELAYFORGE_TEST_GROK_CONTAINED_EVIDENCE_FILE="$evidence" \
  RELAYFORGE_TEST_EVIDENCE_JOB_NONCE="$job_nonce" \
  npx vitest run tests/adapter-grok.test.ts
node scripts/create-native-adapter-receipt-bundle.mjs --extract \
  --adapter grok --evidence-file "$evidence" \
  --receipt-output "$receipt" --commit-sha "$GITHUB_SHA" --job-nonce "$job_nonce"
rm -f -- "$evidence"
unset XAI_API_KEY

# Bundle digests and build publishable artifact (not preview).
receipt_bundle="$private_root/receipts.json"
node scripts/create-native-adapter-receipt-bundle.mjs \
  --output "$receipt_bundle" --commit-sha "$GITHUB_SHA" \
  --opencode-receipt "$private_root/opencode-receipt.json" \
  --pi-receipt "$private_root/pi-receipt.json" \
  --grok-receipt "$private_root/grok-receipt.json"

RELAYFORGE_RELEASE_SOURCE_GATE=passed RELAYFORGE_RELEASE_CGROUP_GATE=passed \
  node scripts/release-artifact.mjs --output .release \
  --native-adapter-receipts "$receipt_bundle"

# Wipe private evidence workspace before any upload or archive.
rm -f -- "$private_root/job-nonce" "$private_root"/*-receipt.json \
  "$private_root/receipts.json" "$private_root"/*.json "$private_root"/*.log
rmdir -- "$private_root" 2>/dev/null || true

tarball="$(node -p "require('./.release/release-manifest.json').tarball.path")"
node scripts/smoke-packed-dashboard.mjs --tarball "$tarball"
node -e 'const m=require("./.release/release-manifest.json"); if(!m.publishable) process.exit(1); console.log({publishable:m.publishable,version:m.version,native:m.nativeAdapterEvidence.status,sha256:m.tarball.sha256})'
```

Local same-job success produces a publishable `.release/` tree on this host. It
does **not** replace the remote workflow’s independent `gate` / `required-cgroup`
jobs or automated `npm publish` unless the operator deliberately uses that
artifact under an authorized recovery path. Preferred production path remains:
register the labeled runner → push signed tag → let Actions own collect + publish.

## 3. Tag (only after receipts and gates are green)

Do **not** create or push a tag until credentials, runners (or an authorized
local same-job record), and branch policy are confirmed. When ready:

```bash
git status --short   # empty
GITHUB_REF_NAME=v1.0.0-rc.1 node scripts/release-policy.mjs gate
git tag -s v1.0.0-rc.1 -m "RelayForge 1.0.0-rc.1"
# git push origin v1.0.0-rc.1   # only with explicit operator authorization
```

Tag push triggers `release.yml`. Without registered labeled runners the workflow
stalls on `required-cgroup` / `artifact`. Without the three Actions secrets the
artifact job fails closed on paid collection.

## 4. Operator order (credentials → collect → tag)

1. **Credentials** — obtain live `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
   `XAI_API_KEY`; set them as repository secrets (and use them one-at-a-time for
   any local same-job run). Create environment `npm-release` if missing.
2. **Collect** — either register the labeled self-hosted runner and rely on the
   workflow, **or** run the local same-job path on this designated host. Do not
   invent receipts, skip adapters, or reuse ambient Grok OAuth.
3. **Tag** — only with a clean tree, green gates, and explicit authorization:
   signed `v1.0.0-rc.1`, then push to trigger publish/convergence.

## Explicit non-claims

- Receipts have **not** been collected by this documentation work.
- No tag was created; no npm publish; no GitHub Release; no repository rename.
- Preview artifacts (`--preview`) remain `publishable:false` and
  `nativeAdapterEvidence.status:not-collected` by design.

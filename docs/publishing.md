# RelayForge release and publishing runbook

This runbook separates source preparation, artifact construction, registry
publication, and external identity changes. Only an authorized release operator
may perform the external steps.

## Current release status

The source manifest is `relayforge@1.0.0-rc.1`, and the required changelog
heading is dated 2026-08-09. As of this source preparation:

- npm publication has **not** been performed;
- the external repository has **not** been renamed;
- no GitHub release has been created;
- no remote release tag has been pushed by this work;
- project URLs, organization settings, websites, and social names have not been
  changed.

The source version is not proof of registry or remote state.

At 2026-08-09T14:48Z, a diagnostic query for
`npm view relayforge version dist.integrity --json` returned a confirmed E404:
the package name was absent at that instant. This dated observation is not
namespace ownership, a reservation, or release-time proof. The workflow must
still recheck the exact version and integrity immediately before publication.

## Release invariants

The release workflow fails closed unless all of these are true:

1. `package.json` is named `relayforge` and its version exactly matches the
   triggering `v<version>` tag.
2. `CHANGELOG.md` contains a dated `## [<version>] - YYYY-MM-DD` heading.
3. The worktree is committed and clean.
4. Both Phase 0 audits, the Phase 1–7 audits, ADR 001–008, and the upstream
   attribution ledgers are present and structurally valid.
5. Typecheck, tests, build, and smoke checks pass from committed source.
6. The required Linux delegated-cgroup gate passes on a labeled self-hosted
   runner. It is not an optional skip.
7. Required contained OpenCode, Pi, and Grok native-adapter gates pass on a labeled
   self-hosted `relayforge-cgroup` runner. Each produces a distinct short-lived,
   content-bound receipt; an unavailable executable is a failure in that job.
8. Two consecutive npm packs have the same filename, integrity, and SHA-256.
9. The packed file list is allowlisted and bounded and contains the public
   declarations, CLI, README, CHANGELOG, LICENSE, audits, examples, and assets.
10. A clean-prefix install of the exact tarball passes binary-alias, public
    import, strict external TypeScript consumer, closed-subpath, canonical-init,
    legacy `loop.config.*` + `.loop` in-place adoption, dry-run,
    control-service, and checkout-immutability smoke checks.

The package includes only allowlisted roots. Source, tests, scripts, `.git`,
`.github`, `.loop`, `.workflow`, environment files, credentials, logs, and
build metadata are rejected from the tarball.

## Local source-candidate checks

These checks are useful before committing, but they do not satisfy the release
workflow's clean committed-source gate:

```bash
npm ci
npm run validate
npm run smoke
npm pack --dry-run
```

The artifact builder can be exercised locally only in explicitly unpublishable
preview mode:

```bash
node scripts/release-artifact.mjs --preview --output .preview
```

The command performs real deterministic packing and the deep clean-install
smoke, but writes `publishable:false` and
`nativeAdapterEvidence.status:not-collected`. Release policy rejects that
manifest. A publishable build has no manual "adapter passed" switch: it accepts
only a private same-runner receipt bundle produced by the checked-in contained
collector after all three real adapters complete.

Inspect the resulting `release-manifest.json` and tarball:

```bash
node -e 'const m=require("./.preview/release-manifest.json"); console.log({publishable:m.publishable,package:m.packageName,version:m.version,commit:m.commit,gates:m.gates,native:m.nativeAdapterEvidence.status,tarball:m.tarball.filename,sha256:m.tarball.sha256,integrity:m.tarball.integrity})'
npm pack --dry-run
```

Do not hand-edit the manifest or rebuild the tarball after its gates. Publication
must consume the exact uploaded artifact.

## Operator readiness (secrets, runners, local substitute)

Before any tag, confirm external readiness on the checklist in
[operator-native-receipts.md](operator-native-receipts.md):

- repository secrets `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `XAI_API_KEY`
  (in addition to `NPM_TOKEN`);
- Actions environment `npm-release` for the publish job;
- a live self-hosted runner labeled `relayforge-cgroup` and
  `relayforge-adapters`, **or** the documented local same-job collect path on
  the designated characterization host while runners are unregistered.

That checklist records exact `gh secret set` commands and does not claim
receipts have been collected.

## Authorized tag workflow

The committed release workflow is triggered by a tag matching `v*`:

```bash
git status --short
node scripts/release-policy.mjs gate
git tag -s v1.0.0-rc.1 -m "RelayForge 1.0.0-rc.1"
git push origin v1.0.0-rc.1
```

`release-policy.mjs gate` derives its tag from `GITHUB_REF_NAME`; outside
GitHub Actions, set that variable if you want to exercise the exact identity
check:

```bash
GITHUB_REF_NAME=v1.0.0-rc.1 node scripts/release-policy.mjs gate
```

Do not create or push a tag until the target commit, branch policy, signer,
repository, and release authorization are confirmed. A dirty worktree is an
intentional hard failure.

The GitHub Actions workflow then runs:

1. `gate`: committed source policy, `npm ci`, validation, and smoke;
2. `required-cgroup`: real delegated cgroup verifier test;
3. `artifact`: after the independent real cgroup gate, one designated
   `relayforge-adapters` + `relayforge-cgroup` runner owns the full publishable
   artifact path on a single physical job. Before any native evidence is
   collected it forces strong cgroup-backed `npm run validate` (not only the
   cgroup probe suite), re-runs `tests/steering-cli-run-e2e.test.ts` with
   `RELAYFORGE_TEST_REQUIRE_CGROUP=1`, and requires `npm run smoke` to print the
   exact contained-success marker
   `SMOKE PASS (contained host — verified delivery on the run branch):`
   (generic fail-closed smoke is not release success). It then collects and
   consumes short-lived OpenCode, Pi, and Grok evidence in separate
   secret-scoped steps with explicit `--authorize-paid-probe`. Each child sees
   only its selected credential. Each full evidence body is trap-deleted after
   a strict digest-only receipt is extracted; a final no-secret step binds the
   three distinct receipt digests, builds and clean-install-smokes the exact
   tarball, removes the private native-evidence workspace, then drives that
   same tarball through the dependency-free Chrome/CDP packed-dashboard smoke
   (`scripts/smoke-packed-dashboard.mjs`) on the same runner. Missing Chrome is
   a hard failure — the browser step cannot skip. Only the tarball and manifest
   are uploaded;
4. `publish`: exact-version registry preflight, conditional publication of the
   exact tested tarball, registry convergence, and clean registry install.

Evidence files are canonical 0600 records under the runner's private temporary
directory, bounded to 256 KiB, bound to the exact checkout SHA, configuration,
runtime files, per-job nonce and a maximum five-minute lifetime. They contain
no prompt/output/raw frame/session/environment/credential data. They never use
`GITHUB_ENV`, step outputs, artifacts, caches or cross-job transport. Missing
binaries, helpers, containment, protocol behavior, cancellation, replay,
reviewer denial, terminal settlement, or Grok privacy evidence fail the job;
there is no skip or direct-spawn fallback. The final digest-only receipt files
and nonce are also deleted before the job can upload the artifact.

## Registry preflight and convergence

The registry policy distinguishes only two trustworthy preflight states:

- a confirmed 404 means the exact version is absent and publication is needed;
- a successful exact-version response with matching integrity means publication
  is already complete and may be skipped idempotently.

Authentication errors, timeouts, malformed registry JSON, proxies, and other
ambiguous failures are not proof of absence and stop the workflow. If an exact
version exists with different integrity, the release fails; npm versions are
immutable and must not be overwritten.

Prereleases publish under `next`; stable versions publish under `latest`. After
publication, convergence requires:

- the exact version to be visible;
- `dist.integrity` to match the tested tarball;
- the expected dist-tag to point to that version; and
- a clean registry install to pass binary aliases, public import, declarations,
  and closed sensitive subpaths.

Manual registry queries are diagnostic only:

```bash
npm view relayforge@1.0.0-rc.1 version dist.integrity --json
npm view relayforge dist-tags --json
```

The workflow's preflight/convergence code remains authoritative because it
interprets error states conservatively.

## External repository and product actions

The release workflow publishes npm; it does not rename a repository or create
all surrounding product surfaces. The operator must separately decide and,
when authorized, perform:

- rename the external repository to its approved RelayForge name;
- update repository description, topics, default clone URL, branch protections,
  environments, secrets, self-hosted runner labels, and trusted publishers;
- update package metadata URLs only after their destinations exist;
- create release notes from the exact dated changelog;
- verify redirects from the historical repository URL;
- update websites, documentation hosts, badges, social accounts, and issue
  templates; and
- communicate the `loop`/`loop-orchestrator`, legacy config, `.loop`, and
  `LOOP_*` compatibility policy.

None of those actions is implied by edits in this repository.

## Partial-failure recovery

Never rebuild or retag reflexively after a failed publish job.

1. Download and retain the workflow artifact and manifest.
2. Query the exact npm version and its integrity.
3. If the exact version is absent by confirmed 404, fix only the external
   failure and rerun the workflow against the same committed tag and artifact
   policy.
4. If the exact version exists with matching integrity, allow the idempotent
   preflight to skip publish and run convergence.
5. If integrity differs, stop. Do not overwrite, unpublish, or move tags without
   a separately reviewed incident decision.
6. If the npm package converged but repository or release-page actions did not,
   finish those external actions without republishing npm.

Record the exact commit, signed tag, workflow run, manifest digest, tarball
integrity, registry response, dist-tag, and any manual external actions in the
release record.

## Rollback expectations

npm package versions are immutable. A bad published candidate is superseded by
a new version; a dist-tag may be moved only through an authorized, recorded
decision. Repository renames should rely on verified host redirects, but local
clones and automation may still require explicit remote updates.

Compatibility aliases exist to make adoption deliberate. They are not a reason
to remove evidence, bypass containment gates, or maintain divergent executables.

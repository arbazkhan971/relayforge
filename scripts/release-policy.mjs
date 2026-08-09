#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export class ReleasePolicyError extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.name = "ReleasePolicyError"; this.code = code; }
}

export const RELEASE_REQUIRED_EVIDENCE_PATHS = Object.freeze([
  "docs/reference/phase-00-worktree-provisioning-audit.md",
  "docs/reference/phase-00-2-verifier-cgroup-delegation-audit.md",
  ...[1, 2, 3, 4, 5, 6, 7].map((phase) => `docs/reference/phase-${String(phase).padStart(2, "0")}-${["control-plane-audit", "session-steering-audit", "scm-feedback-audit", "adapter-registry-audit", "live-observability-audit", "multi-repository-audit", "release-audit"][phase - 1]}.md`),
  "docs/reference/phase-04-grok-build-addendum.md",
  "docs/reference/phase-04-grok-egress-addendum.md",
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((number) => `docs/adr/${String(number).padStart(3, "0")}-${["verifier-cgroup-delegation", "durable-local-control-plane", "durable-session-steering", "trusted-scm-feedback", "capability-adapter-registry", "live-observability-control-room", "multi-repository-execution", "relayforge-identity-and-release"][number - 1]}.md`),
  "docs/upstream-sources.md",
  "docs/ecosystem-watch.md"
]);

export function assertReleaseEvidenceInventory(repositoryRoot = process.cwd()) {
  const root = resolve(repositoryRoot);
  for (const path of RELEASE_REQUIRED_EVIDENCE_PATHS) {
    const absolute = resolve(root, path);
    if (!existsSync(absolute)) throw new ReleasePolicyError("REFERENCE_EVIDENCE_MISSING", `required release evidence is absent: ${path}`);
    const text = readFileSync(absolute, "utf8");
    if (Buffer.byteLength(text, "utf8") < 128) throw new ReleasePolicyError("REFERENCE_EVIDENCE_INVALID", `required release evidence is empty or truncated: ${path}`);
    if (path.startsWith("docs/reference/") && (!/^## Reference Matrix\s*$/imu.test(text) || !/^## Chosen design\s*$/imu.test(text))) {
      throw new ReleasePolicyError("REFERENCE_EVIDENCE_INVALID", `reference audit lacks its matrix or chosen design: ${path}`);
    }
    if (path.startsWith("docs/adr/") && !/^## Decision\s*$/imu.test(text)) {
      throw new ReleasePolicyError("REFERENCE_EVIDENCE_INVALID", `ADR lacks its decision section: ${path}`);
    }
  }
  const ledger = readFileSync(resolve(root, "docs/upstream-sources.md"), "utf8");
  for (const classification of ["DIRECT_COPY", "MODIFIED_COPY", "PORTED_IMPLEMENTATION", "ARCHITECTURAL_INSPIRATION", "IDEA_ONLY", "NOT_USED"]) {
    if (!ledger.includes(classification)) throw new ReleasePolicyError("ATTRIBUTION_LEDGER_INVALID", `upstream ledger does not define or record ${classification}`);
  }
  return Object.freeze({ paths: RELEASE_REQUIRED_EVIDENCE_PATHS, count: RELEASE_REQUIRED_EVIDENCE_PATHS.length });
}

export function assertReleaseIdentity({ packageDocument, tag, changelog }) {
  if (!packageDocument || typeof packageDocument !== "object" || typeof packageDocument.name !== "string" || typeof packageDocument.version !== "string") throw new ReleasePolicyError("INVALID_PACKAGE", "package identity is missing");
  if (packageDocument.name !== "relayforge") throw new ReleasePolicyError("PACKAGE_NAME_MISMATCH", `package name ${packageDocument.name} is not relayforge`);
  const expectedTag = `v${packageDocument.version}`;
  if (tag !== expectedTag) throw new ReleasePolicyError("TAG_VERSION_MISMATCH", `tag ${tag} does not equal ${expectedTag}`);
  const escaped = packageDocument.version.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const heading = new RegExp(`^## \\[${escaped}\\] - \\d{4}-\\d{2}-\\d{2}$`, "mu");
  if (!heading.test(changelog)) throw new ReleasePolicyError("CHANGELOG_VERSION_MISSING", `CHANGELOG has no dated ${packageDocument.version} heading`);
  return Object.freeze({ packageName: packageDocument.name, version: packageDocument.version, tag: expectedTag });
}

export function assertReleaseCommitIdentity({ head, tagCommit }) {
  const objectId = /^[0-9a-f]{40}$/u;
  if (typeof head !== "string" || !objectId.test(head) || typeof tagCommit !== "string" || !objectId.test(tagCommit)) {
    throw new ReleasePolicyError("COMMIT_IDENTITY_INVALID", "release HEAD and tag target must be full lowercase Git object IDs");
  }
  if (head !== tagCommit) throw new ReleasePolicyError("TAG_TARGET_MISMATCH", `release tag resolves to ${tagCommit}, not HEAD ${head}`);
  return Object.freeze({ commit: head, tagCommit });
}

export function assertPublishableReleaseManifest(manifest) {
  const sha = /^[a-f0-9]{64}$/u;
  if (!manifest || typeof manifest !== "object" || manifest.schemaVersion !== 2 || manifest.publishable !== true) {
    throw new ReleasePolicyError("MANIFEST_UNPUBLISHABLE", "release manifest is a preview or has an unsupported schema");
  }
  if (
    manifest.gates?.sourceValidation !== "passed" ||
    manifest.gates?.verifierCgroup !== "passed" ||
    manifest.gates?.artifactSmoke !== "passed"
  ) {
    throw new ReleasePolicyError("RELEASE_GATE_UNPROVEN", "source, cgroup and artifact-smoke gates must all be proven");
  }
  const native = manifest.nativeAdapterEvidence;
  const receipts = native?.receipts;
  const runner = native?.runner;
  if (
    native?.status !== "collected" ||
    !receipts ||
    Object.keys(receipts).sort().join(",") !== "grok,opencode,pi" ||
    ![receipts.opencode, receipts.pi, receipts.grok].every((value) => typeof value === "string" && sha.test(value)) ||
    new Set([receipts.opencode, receipts.pi, receipts.grok]).size !== 3 ||
    !runner ||
    typeof runner.name !== "string" || !runner.name ||
    typeof runner.kernelRelease !== "string" || !runner.kernelRelease ||
    typeof runner.cgroupIdentitySha256 !== "string" || !sha.test(runner.cgroupIdentitySha256)
  ) {
    throw new ReleasePolicyError("NATIVE_ADAPTER_EVIDENCE_INVALID", "manifest lacks distinct same-runner OpenCode, Pi and Grok receipt evidence");
  }
  if (manifest.smoke?.publicTypes !== true || manifest.smoke?.legacyAdoption !== "loop.config-and-.loop-in-place") {
    throw new ReleasePolicyError("ARTIFACT_SMOKE_INCOMPLETE", "manifest lacks external TypeScript and legacy adoption smoke evidence");
  }
  return manifest;
}

function defaultRun(command, args, options = {}) { return spawnSync(command, args, { encoding: "utf8", timeout: 60_000, ...options }); }
function parseJson(value, code) { try { return JSON.parse(value); } catch { throw new ReleasePolicyError(code, "registry returned malformed JSON"); } }
function registryMissing(result) { return result.status !== 0 && /(?:E404|404 Not Found|is not in this registry)/iu.test(`${result.stderr ?? ""}\n${result.stdout ?? ""}`); }

export function registryPreflight({ packageName, version, expectedIntegrity, run = defaultRun }) {
  const result = run("npm", ["view", `${packageName}@${version}`, "version", "dist.integrity", "--json"]);
  if (registryMissing(result)) return Object.freeze({ state: "absent", publishRequired: true });
  if (result.status !== 0) throw new ReleasePolicyError("REGISTRY_AMBIGUOUS", "exact-version registry query failed without a confirmed 404");
  const value = parseJson(result.stdout ?? "", "REGISTRY_AMBIGUOUS");
  const observedVersion = typeof value === "string" ? value : value?.version;
  const observedIntegrity = typeof value === "object" && value ? value["dist.integrity"] ?? value.dist?.integrity : undefined;
  if (observedVersion !== version || typeof observedIntegrity !== "string") throw new ReleasePolicyError("REGISTRY_METADATA_MISMATCH", "exact version returned unexpected metadata");
  if (expectedIntegrity && observedIntegrity !== expectedIntegrity) throw new ReleasePolicyError("REGISTRY_INTEGRITY_MISMATCH", "published exact-version integrity differs from the tested tarball");
  return Object.freeze({ state: "present", publishRequired: false, integrity: observedIntegrity });
}

export function registryConvergence({ packageName, version, expectedIntegrity, expectedTag, run = defaultRun }) {
  const exact = registryPreflight({ packageName, version, expectedIntegrity, run });
  if (exact.state !== "present") throw new ReleasePolicyError("PUBLISH_NOT_VISIBLE", "exact version is not visible after publication");
  const tags = run("npm", ["view", packageName, "dist-tags", "--json"]);
  if (tags.status !== 0) throw new ReleasePolicyError("REGISTRY_AMBIGUOUS", "dist-tag query failed");
  const parsed = parseJson(tags.stdout ?? "", "REGISTRY_AMBIGUOUS");
  if (!parsed || parsed[expectedTag] !== version) throw new ReleasePolicyError("DIST_TAG_MISMATCH", `${expectedTag} does not point to ${version}`);
  return Object.freeze({ state: "converged", version, tag: expectedTag, integrity: exact.integrity });
}

function appendGithubOutput(values) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  writeFileSync(output, Object.entries(values).map(([key, value]) => `${key}=${String(value)}\n`).join(""), { flag: "a" });
}

export function releaseGate({ repositoryRoot = process.cwd(), tag = process.env.GITHUB_REF_NAME } = {}) {
  const packageDocument = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
  const changelog = readFileSync(resolve(repositoryRoot, "CHANGELOG.md"), "utf8");
  const identity = assertReleaseIdentity({ packageDocument, tag, changelog });
  assertReleaseEvidenceInventory(repositoryRoot);
  const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repositoryRoot, encoding: "utf8" });
  if (status.trim()) throw new ReleasePolicyError("DIRTY_WORKTREE", "release source tree is not clean");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  let tagCommit;
  try {
    tagCommit = execFileSync("git", ["rev-parse", "--verify", `refs/tags/${identity.tag}^{commit}`], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  } catch {
    throw new ReleasePolicyError("TAG_NOT_FOUND", `release tag ${identity.tag} is not available in the source checkout`);
  }
  assertReleaseCommitIdentity({ head: commit, tagCommit });
  return Object.freeze({ ...identity, commit });
}

async function main(args) {
  const [command, manifestPath] = args;
  if (command === "gate") {
    const value = releaseGate(); appendGithubOutput({ package_name: value.packageName, version: value.version, commit: value.commit }); console.log(JSON.stringify(value)); return;
  }
  if (command === "preflight" || command === "converge") {
    if (!manifestPath) throw new ReleasePolicyError("INVALID_ARGUMENT", "release manifest path is required");
    const manifest = JSON.parse(readFileSync(resolve(manifestPath), "utf8"));
    assertPublishableReleaseManifest(manifest);
    const input = { packageName: manifest.packageName, version: manifest.version, expectedIntegrity: manifest.tarball.integrity };
    if (command === "preflight") {
      const value = registryPreflight(input);
      const distTag = manifest.version.includes("-") ? "next" : "latest";
      appendGithubOutput({ publish_required: value.publishRequired, dist_tag: distTag });
      console.log(JSON.stringify({ ...value, distTag }));
      return;
    }
    const expectedTag = manifest.version.includes("-") ? "next" : "latest";
    console.log(JSON.stringify(registryConvergence({ ...input, expectedTag })));
    return;
  }
  throw new ReleasePolicyError("INVALID_ARGUMENT", "expected gate, preflight, or converge");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}

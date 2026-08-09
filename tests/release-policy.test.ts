import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const policy = await import("../scripts/release-policy.mjs") as typeof import("../scripts/release-policy.mjs");
const result = (status: number, stdout = "", stderr = "") => ({ status, stdout, stderr, pid: 1, output: [], signal: null });

describe("release policy", () => {
  it("binds exact tag, version, and dated changelog", () => {
    expect(policy.assertReleaseIdentity({ packageDocument: { name: "relayforge", version: "1.0.0-rc.1" }, tag: "v1.0.0-rc.1", changelog: "## [1.0.0-rc.1] - 2026-08-09\n" })).toEqual({ packageName: "relayforge", version: "1.0.0-rc.1", tag: "v1.0.0-rc.1" });
    expect(() => policy.assertReleaseIdentity({ packageDocument: { name: "relayforge", version: "1.0.0" }, tag: "v1.0.1", changelog: "## [1.0.0] - 2026-08-09\n" })).toThrowError(expect.objectContaining({ code: "TAG_VERSION_MISMATCH" }));
    expect(() => policy.assertReleaseIdentity({ packageDocument: { name: "relayforge", version: "1.0.0" }, tag: "v1.0.0", changelog: "## [Unreleased]\n" })).toThrowError(expect.objectContaining({ code: "CHANGELOG_VERSION_MISSING" }));
    expect(() => policy.assertReleaseIdentity({ packageDocument: { name: "loop-orchestrator", version: "1.0.0" }, tag: "v1.0.0", changelog: "## [1.0.0] - 2026-08-09\n" })).toThrowError(expect.objectContaining({ code: "PACKAGE_NAME_MISMATCH" }));
  });

  it("binds the release tag to the exact committed HEAD", () => {
    const head = "a".repeat(40);
    expect(policy.assertReleaseCommitIdentity({ head, tagCommit: head })).toEqual({ commit: head, tagCommit: head });
    expect(() => policy.assertReleaseCommitIdentity({ head, tagCommit: "b".repeat(40) })).toThrowError(expect.objectContaining({ code: "TAG_TARGET_MISMATCH" }));
    expect(() => policy.assertReleaseCommitIdentity({ head: "short", tagCommit: head })).toThrowError(expect.objectContaining({ code: "COMMIT_IDENTITY_INVALID" }));
  });

  it("requires every phase audit, ADR, attribution ledger, and ecosystem watch", () => {
    const inventory = policy.assertReleaseEvidenceInventory(fileURLToPath(new URL("..", import.meta.url)));
    expect(inventory).toMatchObject({ count: 21 });
    expect(inventory.paths).toContain("docs/reference/phase-04-grok-build-addendum.md");
    expect(inventory.paths).toContain("docs/reference/phase-04-grok-egress-addendum.md");
    const empty = mkdtempSync(join(tmpdir(), "relayforge-release-evidence-"));
    try {
      expect(() => policy.assertReleaseEvidenceInventory(empty)).toThrowError(expect.objectContaining({ code: "REFERENCE_EVIDENCE_MISSING" }));
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("distinguishes a confirmed 404 from auth, timeout, and server ambiguity", () => {
    expect(policy.registryPreflight({ packageName: "relayforge", version: "1.0.0", run: () => result(1, "", "npm ERR! code E404") })).toEqual({ state: "absent", publishRequired: true });
    for (const stderr of ["npm ERR! code E401", "network timeout", "503 Service Unavailable"]) expect(() => policy.registryPreflight({ packageName: "relayforge", version: "1.0.0", run: () => result(1, "", stderr) })).toThrowError(expect.objectContaining({ code: "REGISTRY_AMBIGUOUS" }));
  });

  it("skips only a confirmed matching exact version and refuses integrity drift", () => {
    const run = () => result(0, JSON.stringify({ version: "1.0.0", "dist.integrity": "sha512-tested" }));
    expect(policy.registryPreflight({ packageName: "relayforge", version: "1.0.0", expectedIntegrity: "sha512-tested", run })).toMatchObject({ state: "present", publishRequired: false });
    expect(() => policy.registryPreflight({ packageName: "relayforge", version: "1.0.0", expectedIntegrity: "sha512-other", run })).toThrowError(expect.objectContaining({ code: "REGISTRY_INTEGRITY_MISMATCH" }));
  });

  it("requires exact post-publish dist-tag convergence", () => {
    const run = (_command: string, args: readonly string[]) => args.includes("dist-tags") ? result(0, JSON.stringify({ next: "1.0.0-rc.1" })) : result(0, JSON.stringify({ version: "1.0.0-rc.1", "dist.integrity": "sha512-tested" }));
    expect(policy.registryConvergence({ packageName: "relayforge", version: "1.0.0-rc.1", expectedIntegrity: "sha512-tested", expectedTag: "next", run })).toMatchObject({ state: "converged", tag: "next" });
    expect(() => policy.registryConvergence({ packageName: "relayforge", version: "1.0.0-rc.1", expectedIntegrity: "sha512-tested", expectedTag: "latest", run })).toThrowError(expect.objectContaining({ code: "DIST_TAG_MISMATCH" }));
  });

  it("rejects preview and aggregate-only manifests before registry access", () => {
    expect(() => policy.assertPublishableReleaseManifest({ schemaVersion: 2, publishable: false, nativeAdapterEvidence: { status: "not-collected" } })).toThrowError(expect.objectContaining({ code: "MANIFEST_UNPUBLISHABLE" }));
    expect(() => policy.assertPublishableReleaseManifest({
      schemaVersion: 2,
      publishable: true,
      gates: { sourceValidation: "passed", verifierCgroup: "passed", artifactSmoke: "passed" },
      nativeAdapterEvidence: { status: "collected", nativeAdapters: "passed" }
    })).toThrowError(expect.objectContaining({ code: "NATIVE_ADAPTER_EVIDENCE_INVALID" }));
  });

  it("accepts only distinct per-adapter receipts plus runner and deep packed-smoke evidence", () => {
    const manifest = {
      schemaVersion: 2,
      publishable: true,
      gates: { sourceValidation: "passed", verifierCgroup: "passed", artifactSmoke: "passed" },
      nativeAdapterEvidence: {
        status: "collected",
        receipts: { opencode: "a".repeat(64), pi: "b".repeat(64), grok: "c".repeat(64) },
        runner: { name: "required-runner", kernelRelease: "6.8.0", cgroupIdentitySha256: "d".repeat(64) }
      },
      smoke: { publicTypes: true, legacyAdoption: "loop.config-and-.loop-in-place" }
    };
    expect(policy.assertPublishableReleaseManifest(manifest)).toBe(manifest);
    expect(() => policy.assertPublishableReleaseManifest({ ...manifest, nativeAdapterEvidence: { ...manifest.nativeAdapterEvidence, receipts: { ...manifest.nativeAdapterEvidence.receipts, grok: "a".repeat(64) } } })).toThrowError(expect.objectContaining({ code: "NATIVE_ADAPTER_EVIDENCE_INVALID" }));
  });
});

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertInstalledBetterSqlite3NativeBinding,
  releaseGateEvidence,
  RELEASE_ARTIFACT_LIMITS,
  ReleaseArtifactError,
  validateNativeAdapterReceiptBundle,
  validatePackedFileList,
  validatePackedMarkdownLinks
} from "../scripts/release-artifact.mjs";
import {
  bundleFromReceipts,
  createNativeAdapterReceiptBundle,
  extractReceiptFromEvidence
} from "../scripts/create-native-adapter-receipt-bundle.mjs";

const pkg = { bin: { relayforge: "./dist/cli.js", loop: "./dist/cli.js", "loop-orchestrator": "./dist/cli.js" } };
const required = ["package.json", "README.md", "CHANGELOG.md", "LICENSE", "dist/index.js", "dist/index.d.ts", "dist/cli.js"].map((path) => ({ path, size: 1 }));

describe("release artifact file policy", () => {
  it("compiles named safe APIs from the clean installed package with strict external types", () => {
    const source = readFileSync(new URL("../scripts/release-artifact.mjs", import.meta.url), "utf8");
    expect(source).toContain("clean external TypeScript consumer");
    expect(source).toContain("buildMultiRepositoryControlView");
    expect(source).toContain("skipLibCheck: false");
    expect(source).toContain("consumer.ts");
    expect(source).toContain("forbidden-consumer.ts");
    expect(source).toContain("has no exported member");
    expect(source).not.toContain("relayForgeIdentity, runAutonomyLoop");
    expect(source).toContain("loop.config.yaml");
    expect(source).toContain("legacy-state-sentinel");
    expect(source).toContain("loop.config-and-.loop-in-place");
    expect(source).toContain("phase-04-grok-egress-addendum.md");
    expect(source).toContain("validatePackedMarkdownLinks(root, validated.files)");
  });
  it("accepts only the bounded product allowlist and stable binary aliases", () => {
    const result = validatePackedFileList([...required, { path: "docs/operator.md", size: 10 }, { path: "assets/helper.mjs", size: 20 }], pkg);
    expect(result.unpackedBytes).toBe(37); expect(result.files.map((item) => item.path)).toEqual([...result.files.map((item) => item.path)].sort((left, right) => left.localeCompare(right)));
  });

  it("rejects source, tests, private state, secrets, traversal, and unexpected roots", () => {
    for (const path of ["src/index.ts", "tests/secret.test.ts", ".loop/state", ".workflow/audit", ".env.production", "private/data.json", "docs/../secret"]) expect(() => validatePackedFileList([...required, { path, size: 1 }], pkg)).toThrow();
  });

  it("rejects omitted files and divergent or absent aliases", () => {
    expect(() => validatePackedFileList(required.filter((item) => item.path !== "dist/index.d.ts"), pkg)).toThrowError(expect.objectContaining({ code: "PACKED_FILE_MISSING" }));
    expect(() => validatePackedFileList(required, { bin: { relayforge: "a", loop: "b", "loop-orchestrator": "a" } })).toThrowError(expect.objectContaining({ code: "BINARY_ALIAS_DIVERGED" }));
    expect(() => validatePackedFileList(required, { bin: { loop: "a" } })).toThrowError(expect.objectContaining({ code: "BINARY_ALIAS_MISSING" }));
  });

  it("records real gates only from exact passed evidence and never implies skipped success", () => {
    expect(releaseGateEvidence({
      RELAYFORGE_RELEASE_SOURCE_GATE: "passed",
      RELAYFORGE_RELEASE_CGROUP_GATE: "passed"
    }, true)).toEqual({
      sourceValidation: "passed",
      verifierCgroup: "passed",
      artifactSmoke: "passed"
    });
    expect(releaseGateEvidence({ RELAYFORGE_RELEASE_CGROUP_GATE: "skipped" }, false)).toEqual({
      sourceValidation: "not_proven",
      verifierCgroup: "not_proven",
      artifactSmoke: "not_run"
    });
  });

  it("binds distinct adapter receipts to exact HEAD and one cgroup runner", () => {
    const canonical = (value: unknown): string => {
      if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
      if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
    };
    const payload = {
      schemaVersion: 1,
      commitSha: "a".repeat(40),
      runner: {
        name: "relayforge-required-1",
        os: "linux",
        arch: "x64",
        kernelRelease: "6.8.0",
        cgroupIdentitySha256: "b".repeat(64)
      },
      receipts: { opencode: "c".repeat(64), pi: "d".repeat(64), grok: "e".repeat(64) }
    };
    const bundle = { ...payload, receiptDigest: createHash("sha256").update(canonical(payload)).digest("hex") };
    expect(validateNativeAdapterReceiptBundle(bundle, payload.commitSha)).toMatchObject({ receipts: payload.receipts, runner: payload.runner });
    expect(() => validateNativeAdapterReceiptBundle(bundle, "f".repeat(40))).toThrow();
    expect(() => validateNativeAdapterReceiptBundle({ ...bundle, receipts: { ...payload.receipts, pi: payload.receipts.opencode } }, payload.commitSha)).toThrow();
    expect(() => validateNativeAdapterReceiptBundle({ ...bundle, receiptDigest: "f".repeat(64) }, payload.commitSha)).toThrow();
  });

  it("accepts only exact digest-only records when evidence crosses workflow step boundaries", () => {
    const commitSha = "a".repeat(40);
    const runner = {
      name: "relayforge-required-1",
      os: "linux",
      arch: "x64",
      kernelRelease: "6.8.0",
      cgroupIdentitySha256: "b".repeat(64)
    };
    const record = (adapterId: string, receiptDigest: string) => ({ schemaVersion: 1, adapterId, commitSha, receiptDigest });
    const receipts = {
      opencode: record("opencode", "c".repeat(64)),
      pi: record("pi", "d".repeat(64)),
      grok: record("grok", "e".repeat(64))
    };
    expect(createNativeAdapterReceiptBundle({ commitSha, runner, receipts })).toMatchObject({
      commitSha,
      receipts: { opencode: "c".repeat(64), pi: "d".repeat(64), grok: "e".repeat(64) }
    });
    expect(() => createNativeAdapterReceiptBundle({
      commitSha,
      runner,
      receipts: { ...receipts, grok: { ...receipts.grok, environment: { XAI_API_KEY: "forbidden" } } }
    })).toThrow(/unknown or missing fields/u);
    expect(() => createNativeAdapterReceiptBundle({
      commitSha,
      runner,
      receipts: { ...receipts, pi: { ...receipts.pi, receiptDigest: receipts.opencode.receiptDigest } }
    })).toThrow(/distinct/u);
    expect(() => createNativeAdapterReceiptBundle({
      commitSha,
      runner: { ...runner, os: "darwin" },
      receipts
    })).toThrow(/must be linux/u);
    expect(() => createNativeAdapterReceiptBundle({
      commitSha,
      runner: { ...runner, name: "runner\nforged" },
      receipts
    })).toThrow(/not bounded/u);
    expect(() => createNativeAdapterReceiptBundle({
      commitSha,
      runner,
      receipts: { ...receipts, foreign: record("grok", "f".repeat(64)) }
    } as never)).toThrow(/unknown or missing adapters/u);
    expect(() => createNativeAdapterReceiptBundle({
      commitSha,
      runner,
      receipts,
      bypass: true
    } as never)).toThrow(/bundle input has unknown or missing fields/u);
    expect(() => validateNativeAdapterReceiptBundle({
      ...createNativeAdapterReceiptBundle({ commitSha, runner, receipts }),
      runner: { ...runner, os: "darwin" }
    }, commitSha)).toThrow(/must be Linux/u);
  });

  it("rejects duplicate, unknown, trailing and wrong-arity receipt CLI arguments before filesystem access", () => {
    expect(() => extractReceiptFromEvidence(["--extract", "--extract"])).toThrow(/duplicated/u);
    expect(() => extractReceiptFromEvidence(["--extract", "--unknown", "x"])).toThrow(/unknown argument/u);
    expect(() => extractReceiptFromEvidence(["--extract", "--adapter", "opencode", "trailing"])).toThrow(/unknown argument/u);
    expect(() => bundleFromReceipts(["--output", "/tmp/a", "--output", "/tmp/b"])).toThrow(/duplicated/u);
    expect(() => bundleFromReceipts(["--extract", "--output", "/tmp/a"])).toThrow(/invalid in bundle mode/u);
    expect(() => bundleFromReceipts(["--output"])).toThrow(/requires exactly one value/u);
  });

  it("closes every packed relative Markdown link against the exact package manifest", () => {
    const root = mkdtempSync(resolve(tmpdir(), "relayforge-packed-links-"));
    try {
      mkdirSync(resolve(root, "docs"));
      writeFileSync(resolve(root, "README.md"), "[guide](docs/guide.md#start) [site](https://example.com) [mail](mailto:ops@example.com)\n");
      writeFileSync(resolve(root, "docs/guide.md"), "# Start\n\n[readme](../README.md) [section](#start)\n");
      const files = [{ path: "README.md", size: 1 }, { path: "docs/guide.md", size: 1 }];
      expect(validatePackedMarkdownLinks(root, files)).toEqual({ documents: 2, checked: 2 });

      writeFileSync(resolve(root, "docs/guide.md"), "[source](../../src/private.ts)\n");
      expect(() => validatePackedMarkdownLinks(root, files)).toThrow(/escapes the packed package/u);
      writeFileSync(resolve(root, "docs/guide.md"), "[source](../src/private.ts)\n");
      expect(() => validatePackedMarkdownLinks(root, files)).toThrow(/unpacked or missing/u);
      writeFileSync(resolve(root, "docs/guide.md"), "[noncanonical](./missing.md)\n");
      expect(() => validatePackedMarkdownLinks(root, files)).toThrow(/not a canonical relative target/u);
      writeFileSync(resolve(root, "docs/guide.md"), "[host](file:///etc/passwd)\n");
      expect(() => validatePackedMarkdownLinks(root, files)).toThrow(/unsupported Markdown link scheme/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs lifecycle scripts on exact tarball and registry consumer installs, never --ignore-scripts", () => {
    const source = readFileSync(new URL("../scripts/release-artifact.mjs", import.meta.url), "utf8");
    // Pack determinism may suppress lifecycle scripts on the second pack only.
    expect(source).toContain('["pack", "--ignore-scripts", "--json", "--pack-destination", secondDir]');
    // Clean consumer installs of the exact tarball and exact registry version must not.
    expect(source).toContain("function consumerInstall(prefix, packageSpec)");
    expect(source).toContain('["install", "--no-audit", "--no-fund", "--prefix", prefix, packageSpec]');
    expect(source).toContain("consumerInstall(prefix, finalPath)");
    expect(source).toContain("consumerInstall(prefix, `${manifest.packageName}@${manifest.version}`)");
    expect(source).toContain("installTimeoutMs");
    expect(RELEASE_ARTIFACT_LIMITS.installTimeoutMs).toBeGreaterThanOrEqual(RELEASE_ARTIFACT_LIMITS.commandTimeoutMs);
    expect(source).not.toMatch(/install", "--ignore-scripts"/u);
    expect(source).not.toMatch(/\["install"[^\]]*ignore-scripts/u);
    // Deep smoke must prove native binding exists and loads through the packed package path.
    expect(source).toContain("assertInstalledBetterSqlite3NativeBinding");
    expect(source).toContain("proveBetterSqlite3NativeLoad");
    expect(source).toContain("NATIVE_BINDING_MISSING");
    expect(source).toContain("better_sqlite3.node");
    expect(source).toContain("createRequire");
    expect(source).toContain('require("better-sqlite3")');
    expect(source).toContain("native-binding-probe.mjs");
    expect(source).toContain("proveBetterSqlite3NativeLoad(prefix, packageName)");
    expect(source).toContain("nativeBinding:");
    // No skip or soft fallback for missing toolchain/native build.
    expect(source).not.toMatch(/NATIVE_BINDING.*skip|skip.*native|ignore native/iu);
  });

  it("rejects a clean prefix when the better-sqlite3 native binding is missing", () => {
    const prefix = mkdtempSync(resolve(tmpdir(), "relayforge-native-missing-"));
    try {
      expect(() => assertInstalledBetterSqlite3NativeBinding(prefix)).toThrow(ReleaseArtifactError);
      expect(() => assertInstalledBetterSqlite3NativeBinding(prefix)).toThrow(
        expect.objectContaining({ code: "NATIVE_BINDING_MISSING" })
      );

      // Package tree present without a compiled .node is still a hard failure.
      mkdirSync(resolve(prefix, "node_modules", "better-sqlite3", "build", "Release"), { recursive: true });
      writeFileSync(resolve(prefix, "node_modules", "better-sqlite3", "package.json"), `${JSON.stringify({ name: "better-sqlite3", version: "12.11.1" })}\n`);
      expect(() => assertInstalledBetterSqlite3NativeBinding(prefix)).toThrow(
        expect.objectContaining({ code: "NATIVE_BINDING_MISSING" })
      );

      // Empty stub file is not a real binding.
      writeFileSync(resolve(prefix, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"), "");
      expect(() => assertInstalledBetterSqlite3NativeBinding(prefix)).toThrow(
        expect.objectContaining({ code: "NATIVE_BINDING_MISSING" })
      );

      // Non-empty regular file is accepted as present (load is proven separately in deep smoke).
      writeFileSync(resolve(prefix, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"), "not-a-real-native-binary-but-non-empty");
      expect(assertInstalledBetterSqlite3NativeBinding(prefix)).toMatch(/better_sqlite3\.node$/u);
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });
});

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PORTABLE_LINUX_CONTRACT,
  PortableArtifactError,
  recordPortableCleanHostSmoke,
  renderPortableLauncher,
  renderPortableInstaller
} from "../scripts/portable-linux.mjs";

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fakeBundle(root: string, version: string): { archive: string; filename: string } {
  const rootName = `relayforge-${version}-linux-x64`;
  const tree = resolve(root, rootName);
  mkdirSync(resolve(tree, "runtime", "bin"), { recursive: true });
  mkdirSync(resolve(tree, "app", "dist"), { recursive: true });
  mkdirSync(resolve(tree, "bin"), { recursive: true });
  writeFileSync(resolve(tree, "runtime", "bin", "node"), `#!/bin/sh
if [ "\${1:-}" = '-e' ]; then exit 0; fi
printf '%s\\n' '${version}'
`);
  chmodSync(resolve(tree, "runtime", "bin", "node"), 0o755);
  writeFileSync(resolve(tree, "app", "dist", "cli.js"), "// fake portable CLI\n");
  writeFileSync(resolve(tree, "portable-manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    product: "relayforge",
    version,
    target: "linux-x64-gnu",
    node: { version: PORTABLE_LINUX_CONTRACT.nodeVersion },
    nativeModules: [{ name: "better-sqlite3" }]
  })}\n`);
  for (const command of ["relayforge", "loop", "loop-orchestrator"]) {
    writeFileSync(resolve(tree, "bin", command), renderPortableLauncher());
    chmodSync(resolve(tree, "bin", command), 0o755);
  }
  const filename = `${rootName}.tar.gz`;
  const archive = resolve(root, filename);
  execFileSync("tar", ["-czf", archive, "-C", root, rootName]);
  return { archive, filename };
}

function installerFor(root: string, version: string, archive: string, filename: string): string {
  const installer = resolve(root, `install-${version}.sh`);
  writeFileSync(installer, renderPortableInstaller({
    version,
    archiveFilename: filename,
    archiveSha256: sha256(archive),
    downloadUrl: `https://github.com/arbazkhan971/relayforge/releases/download/v${version}/${filename}`
  }));
  return installer;
}

describe("portable Linux distribution", () => {
  it("pins a bounded Linux x64 runtime and renders only checksum-bound GitHub installers", () => {
    expect(PORTABLE_LINUX_CONTRACT).toMatchObject({
      target: "linux-x64-gnu",
      architecture: "x64",
      minimumGlibc: "2.35",
      nodeVersion: "v22.23.2"
    });
    expect(PORTABLE_LINUX_CONTRACT.nodeArchiveSha256).toMatch(/^[a-f0-9]{64}$/u);
    const rendered = renderPortableInstaller({
      version: "1.2.3",
      archiveFilename: "relayforge-1.2.3-linux-x64.tar.gz",
      archiveSha256: "a".repeat(64),
      downloadUrl: "https://github.com/arbazkhan971/relayforge/releases/download/v1.2.3/relayforge-1.2.3-linux-x64.tar.gz"
    });
    expect(rendered).toContain("RELAYFORGE_ARCHIVE_SHA256='" + "a".repeat(64) + "'");
    expect(rendered).toContain("--rollback");
    expect(rendered).toContain("refusing to replace non-symlink command");
    expect(rendered).not.toContain("@@");
    expect(() => renderPortableInstaller({
      version: "1.2.3'; touch /tmp/unsafe",
      archiveFilename: "a.tar.gz",
      archiveSha256: "a".repeat(64),
      downloadUrl: "https://example.com/a.tar.gz"
    })).toThrow(PortableArtifactError);
  });

  it("installs two versions without root, preserves the prior version, and rolls back atomically", () => {
    const root = mkdtempSync(resolve(tmpdir(), "relayforge-portable-installer-test-"));
    try {
      const prefix = resolve(root, "data", "relayforge");
      const bin = resolve(root, "bin");
      const one = fakeBundle(resolve(root, "one"), "1.2.3");
      const two = fakeBundle(resolve(root, "two"), "1.2.4");
      const installerOne = installerFor(root, "1.2.3", one.archive, one.filename);
      const installerTwo = installerFor(root, "1.2.4", two.archive, two.filename);
      const env = { ...process.env, HOME: root, PATH: process.env.PATH ?? "/usr/bin:/bin" };

      execFileSync("sh", [installerOne, "--archive", one.archive, "--prefix", prefix, "--bin-dir", bin], { env });
      expect(readlinkSync(resolve(prefix, "current"))).toBe("versions/1.2.3");
      expect(execFileSync(resolve(bin, "relayforge"), ["--version"], { encoding: "utf8" }).trim()).toBe("1.2.3");

      execFileSync("sh", [installerTwo, "--archive", two.archive, "--prefix", prefix, "--bin-dir", bin], { env });
      expect(readlinkSync(resolve(prefix, "current"))).toBe("versions/1.2.4");
      expect(readlinkSync(resolve(prefix, "previous"))).toBe("versions/1.2.3");

      execFileSync("sh", [installerTwo, "--rollback", "--prefix", prefix, "--bin-dir", bin], { env });
      expect(readlinkSync(resolve(prefix, "current"))).toBe("versions/1.2.3");
      expect(readlinkSync(resolve(prefix, "previous"))).toBe("versions/1.2.4");
      expect(execFileSync(resolve(bin, "relayforge"), ["--version"], { encoding: "utf8" }).trim()).toBe("1.2.3");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a corrupt archive before extraction", () => {
    const root = mkdtempSync(resolve(tmpdir(), "relayforge-portable-corrupt-test-"));
    try {
      const bundle = fakeBundle(resolve(root, "bundle"), "1.2.3");
      const installer = installerFor(root, "1.2.3", bundle.archive, bundle.filename);
      writeFileSync(bundle.archive, Buffer.concat([readFileSync(bundle.archive), Buffer.from("corrupt")]))
      expect(() => execFileSync("sh", [installer, "--archive", bundle.archive, "--prefix", resolve(root, "prefix"), "--bin-dir", resolve(root, "bin")], {
        env: { ...process.env, HOME: root, PATH: process.env.PATH ?? "/usr/bin:/bin" },
        stdio: "pipe"
      })).toThrow(/archive SHA-256 does not match/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects the wrong CPU architecture before creating an install", () => {
    const root = mkdtempSync(resolve(tmpdir(), "relayforge-portable-arch-test-"));
    try {
      const tools = resolve(root, "tools");
      mkdirSync(tools);
      writeFileSync(resolve(tools, "uname"), `#!/bin/sh
if [ "\${1:-}" = '-s' ]; then printf 'Linux\\n'; else printf 'aarch64\\n'; fi
`);
      chmodSync(resolve(tools, "uname"), 0o755);
      const rendered = renderPortableInstaller({
        version: "1.2.3",
        archiveFilename: "relayforge-1.2.3-linux-x64.tar.gz",
        archiveSha256: "a".repeat(64),
        downloadUrl: "https://github.com/arbazkhan971/relayforge/releases/download/v1.2.3/relayforge-1.2.3-linux-x64.tar.gz"
      });
      const installer = resolve(root, "installer.sh");
      writeFileSync(installer, rendered);
      expect(() => execFileSync("sh", [installer], {
        env: { ...process.env, HOME: root, PATH: `${tools}:${process.env.PATH ?? "/usr/bin:/bin"}` },
        stdio: "pipe"
      })).toThrow(/supports x86_64\/amd64 only/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks release readiness only after exact assets have under-two-minute clean-host evidence", () => {
    const root = mkdtempSync(resolve(tmpdir(), "relayforge-portable-evidence-test-"));
    try {
      const archive = resolve(root, "relayforge-1.2.3-linux-x64.tar.gz");
      const installer = resolve(root, "install-relayforge-1.2.3-linux-x64.sh");
      const manifestPath = resolve(root, "portable-release.json");
      writeFileSync(archive, "archive");
      writeFileSync(installer, "installer");
      writeFileSync(manifestPath, `${JSON.stringify({
        schemaVersion: 1,
        packageName: "relayforge",
        version: "1.2.3",
        target: "linux-x64-gnu",
        releaseReady: false,
        source: { dirty: false },
        archive: { filename: "relayforge-1.2.3-linux-x64.tar.gz", sha256: sha256(archive) },
        installer: { filename: "install-relayforge-1.2.3-linux-x64.sh", sha256: sha256(installer) },
        smoke: { bundledNode: true, cleanHost: "pending-ci-or-local-smoke" }
      })}\n`);
      expect(recordPortableCleanHostSmoke(manifestPath, 13)).toMatchObject({
        releaseReady: true,
        smoke: { cleanHost: { status: "passed", elapsedSeconds: 13, maximumSeconds: 120 } }
      });
      expect(readFileSync(resolve(root, "SHA256SUMS"), "utf8")).toContain("portable-release.json");
      expect(() => recordPortableCleanHostSmoke(manifestPath, 120)).toThrow(/below 120 seconds/u);
      writeFileSync(archive, "tampered");
      expect(() => recordPortableCleanHostSmoke(manifestPath, 12)).toThrow(/assets changed/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  inspectProvisioning,
  provisionWorktree,
  validateProvisionSpecs,
  type ProvisionRequest,
  type ProvisionSpec
} from "../src/provision.js";
import { registerOwnedTemp } from "./global-teardown.js";

type Fixture = {
  base: string;
  sourceRoot: string;
  targetRoot: string;
  transactionRoot: string;
};

function fixture(): Fixture {
  const base = mkdtempSync(join(realpathSync.native(tmpdir()), "loop-provision-core-"));
  registerOwnedTemp(base);
  const sourceRoot = join(base, "source");
  const targetRoot = join(base, "target");
  const transactionRoot = join(base, "transaction");
  mkdirSync(sourceRoot, { mode: 0o700 });
  mkdirSync(targetRoot, { mode: 0o700 });
  mkdirSync(transactionRoot, { mode: 0o700 });
  return { base, sourceRoot, targetRoot, transactionRoot };
}

function createToolchain(state: Fixture): { tool: string; shim: string } {
  const tool = join(state.sourceRoot, "node_modules", "pkg", "bin", "tool");
  const shim = join(state.sourceRoot, "node_modules", ".bin", "tool");
  mkdirSync(join(state.sourceRoot, "node_modules", "pkg", "bin"), { recursive: true });
  mkdirSync(join(state.sourceRoot, "node_modules", ".bin"), { recursive: true });
  writeFileSync(tool, "#!/bin/sh\necho ready\n");
  chmodSync(tool, 0o755);
  symlinkSync("../pkg/bin/tool", shim);
  return { tool, shim };
}

function request(state: Fixture, specs: readonly ProvisionSpec[] = [{ path: "node_modules" }]): ProvisionRequest {
  return { ...state, specs };
}

function transactionPaths(state: Fixture, specPath: string): { slot: string; staging: string; backup: string } {
  const slot = join(state.transactionRoot, createHash("sha256").update(specPath).digest("hex"));
  return { slot, staging: join(slot, "staging"), backup: join(slot, "backup") };
}

function tree(root: string): string[] {
  const result: string[] = [];
  const visit = (path: string, prefix: string): void => {
    for (const name of readdirSync(path).sort()) {
      const absolute = join(path, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const metadata = lstatSync(absolute);
      result.push(`${metadata.isDirectory() ? "d" : metadata.isSymbolicLink() ? `l:${readlinkSync(absolute)}` : `f:${readFileSync(absolute, "hex")}`}:${relative}`);
      if (metadata.isDirectory()) visit(absolute, relative);
    }
  };
  visit(root, "");
  return result;
}

describe("provision path validation", () => {
  it.each([
    "",
    ".",
    "./node_modules",
    "node_modules/",
    "node_modules//pkg",
    "node_modules/./pkg",
    "node_modules/../pkg",
    "../node_modules",
    "/node_modules",
    "C:/node_modules",
    "C:node_modules",
    "C:\\node_modules",
    "\\node_modules",
    "\\\\server\\share",
    "node_modules\\pkg",
    ".git",
    ".GIT/config",
    ".git.",
    ".loop ",
    "vendor/.LOOP/cache",
    "node\u0000modules",
    "node\u001fmodules"
  ])("rejects non-portable or reserved spec path %j", (path) => {
    expect(validateProvisionSpecs([{ path }])).toEqual([
      expect.objectContaining({ code: "INVALID_PATH", path: "0.path" })
    ]);
  });

  it("rejects exact, case-folded, and ancestor overlaps", () => {
    for (const specs of [
      [{ path: "vendor" }, { path: "vendor" }],
      [{ path: "vendor" }, { path: "VENDOR" }],
      [{ path: "vendor/cache" }, { path: "vendor" }],
      [{ path: "vendor" }, { path: "vendor/cache" }]
    ]) {
      expect(validateProvisionSpecs(specs)).toEqual([
        expect.objectContaining({ code: "INVALID_PATH", path: "1.path" })
      ]);
    }
  });

  it("validates required executable markers at their exact indexed field", () => {
    const bad = [".", "../tool", "/tool", "C:tool", "bin\\tool", ".git/tool", "bin//tool"];
    for (const executable of bad) {
      expect(validateProvisionSpecs([{ path: "node_modules", requiredExecutables: [executable] }])).toEqual([
        expect.objectContaining({ code: "INVALID_PATH", path: "0.requiredExecutables.0" })
      ]);
    }
  });
});

describe("read-only provisioning inspection", () => {
  it("is disabled only for an empty plan and does not resolve or create roots", () => {
    const missing = join(tmpdir(), `missing-provision-${process.pid}-${Date.now()}`);
    expect(inspectProvisioning({ sourceRoot: missing, specs: [] })).toEqual({
      ok: true,
      disabled: true,
      issues: [],
      inspected: []
    });
    expect(existsSync(missing)).toBe(false);
  });

  it("reports missing/non-directory/symlinked configured sources without writes", () => {
    const state = fixture();
    const targetBefore = tree(state.targetRoot);
    const transactionBefore = tree(state.transactionRoot);
    expect(inspectProvisioning({ sourceRoot: state.sourceRoot, specs: [{ path: "missing" }] }).issues[0]).toMatchObject({
      code: "MISSING_SOURCE",
      path: "0.path"
    });
    writeFileSync(join(state.sourceRoot, "file"), "x");
    expect(inspectProvisioning({ sourceRoot: state.sourceRoot, specs: [{ path: "file" }] }).issues[0]).toMatchObject({
      code: "UNSAFE_SOURCE",
      path: "0.path"
    });
    const external = join(state.base, "external");
    mkdirSync(external);
    symlinkSync(external, join(state.sourceRoot, "linked"));
    expect(inspectProvisioning({ sourceRoot: state.sourceRoot, specs: [{ path: "linked" }] }).issues[0]).toMatchObject({
      code: "UNSAFE_SOURCE",
      path: "0.path"
    });
    expect(tree(state.targetRoot)).toEqual(targetBefore);
    expect(tree(state.transactionRoot)).toEqual(transactionBefore);
  });

  it("accepts a chained internal executable link and leaves all filesystem state unchanged", () => {
    const state = fixture();
    const { shim } = createToolchain(state);
    const second = join(state.sourceRoot, "node_modules", ".bin", "tool-chain");
    symlinkSync("tool", second);
    const before = tree(state.base);
    const inspected = inspectProvisioning({
      sourceRoot: state.sourceRoot,
      specs: [{ path: "node_modules", requiredExecutables: [".bin/tool-chain"] }]
    });
    expect(inspected.ok).toBe(true);
    expect(inspected.inspected[0]).toMatchObject({ path: "node_modules", symlinks: 2, executables: 1 });
    expect(readlinkSync(shim)).toBe("../pkg/bin/tool");
    expect(tree(state.base)).toEqual(before);
  });

  it("rejects absolute, dangling, cyclic, lexical, and physical symlink escapes", () => {
    if (process.platform === "win32") return;
    const scenarios: Array<(state: Fixture, root: string) => void> = [
      (_state, root) => symlinkSync("/etc/passwd", join(root, "bad")),
      (_state, root) => symlinkSync("missing", join(root, "bad")),
      (_state, root) => {
        symlinkSync("b", join(root, "a"));
        symlinkSync("a", join(root, "b"));
      },
      (state, root) => {
        writeFileSync(join(state.base, "outside"), "outside");
        symlinkSync("../../outside", join(root, "bad"));
      },
      (state, root) => {
        const external = join(state.base, "external");
        mkdirSync(external);
        writeFileSync(join(external, "file"), "outside");
        symlinkSync("../../external/file", join(root, "bad"));
      }
    ];
    for (const scenario of scenarios) {
      const state = fixture();
      const root = join(state.sourceRoot, "deps");
      mkdirSync(root);
      scenario(state, root);
      const result = inspectProvisioning({ sourceRoot: state.sourceRoot, specs: [{ path: "deps" }] });
      expect(result.ok).toBe(false);
      expect(result.issues[0]).toMatchObject({ code: "UNSAFE_SYMLINK", path: "0.path" });
    }
  });

  it("rejects hard-linked files and special entries", () => {
    const hardlinks = fixture();
    const hardRoot = join(hardlinks.sourceRoot, "deps");
    mkdirSync(hardRoot);
    writeFileSync(join(hardRoot, "one"), "same inode");
    linkSync(join(hardRoot, "one"), join(hardRoot, "two"));
    expect(inspectProvisioning({ sourceRoot: hardlinks.sourceRoot, specs: [{ path: "deps" }] }).issues[0]).toMatchObject({
      code: "UNSAFE_SOURCE"
    });

    if (process.platform !== "win32") {
      const special = fixture();
      const specialRoot = join(special.sourceRoot, "deps");
      mkdirSync(specialRoot);
      execFileSync("mkfifo", [join(specialRoot, "pipe")]);
      expect(inspectProvisioning({ sourceRoot: special.sourceRoot, specs: [{ path: "deps" }] }).issues[0]).toMatchObject({
        code: "UNSUPPORTED_ENTRY"
      });
    }
  });
});

describe("transactional worktree provisioning", () => {
  it("copies bytes, ordinary modes, and internal links with distinct unique inodes", () => {
    const state = fixture();
    const source = createToolchain(state);
    const result = provisionWorktree(request(state, [{ path: "node_modules", requiredExecutables: [".bin/tool"] }]));
    expect(result).toMatchObject({ ok: true, disabled: false, changed: true, issues: [] });
    const copiedTool = join(state.targetRoot, "node_modules", "pkg", "bin", "tool");
    const copiedShim = join(state.targetRoot, "node_modules", ".bin", "tool");
    expect(readFileSync(copiedTool)).toEqual(readFileSync(source.tool));
    expect(statSync(copiedTool).mode & 0o777).toBe(0o755);
    expect(readlinkSync(copiedShim)).toBe("../pkg/bin/tool");
    const sourceIdentity = statSync(source.tool, { bigint: true });
    const targetIdentity = statSync(copiedTool, { bigint: true });
    expect([targetIdentity.dev, targetIdentity.ino]).not.toEqual([sourceIdentity.dev, sourceIdentity.ino]);
    expect(targetIdentity.nlink).toBe(1n);
  });

  it("stages writable private directories then restores read-only source directory modes", () => {
    const state = fixture();
    createToolchain(state);
    chmodSync(join(state.sourceRoot, "node_modules", "pkg", "bin"), 0o555);
    chmodSync(join(state.sourceRoot, "node_modules", "pkg"), 0o555);
    chmodSync(join(state.sourceRoot, "node_modules"), 0o555);
    const result = provisionWorktree(request(state));
    expect(result.ok).toBe(true);
    expect(statSync(join(state.targetRoot, "node_modules")).mode & 0o777).toBe(0o555);
    expect(statSync(join(state.targetRoot, "node_modules", "pkg")).mode & 0o777).toBe(0o555);
    expect(readFileSync(join(state.targetRoot, "node_modules", "pkg", "bin", "tool"), "utf8")).toContain("ready");
  });

  it("reprovisions an already-published 0555 root and restores it after publish failure", () => {
    const state = fixture();
    const source = createToolchain(state);
    chmodSync(join(state.sourceRoot, "node_modules"), 0o555);
    expect(provisionWorktree(request(state)).ok).toBe(true);

    writeFileSync(source.tool, "#!/bin/sh\necho second\n");
    const repeated = provisionWorktree(request(state));
    const destination = join(state.targetRoot, "node_modules");
    const copiedTool = join(destination, "pkg", "bin", "tool");
    expect(repeated.ok).toBe(true);
    expect(readFileSync(copiedTool, "utf8")).toContain("second");
    expect(statSync(destination).mode & 0o777).toBe(0o555);

    writeFileSync(source.tool, "#!/bin/sh\necho third\n");
    const failed = provisionWorktree({
      ...request(state),
      faults: { afterBackup: () => { throw new Error("fail after readonly backup move"); } }
    });
    expect(failed.issues[0]).toMatchObject({ code: "PUBLISH_FAILED" });
    expect(readFileSync(copiedTool, "utf8")).toContain("second");
    expect(statSync(destination).mode & 0o777).toBe(0o555);
    expect(existsSync(join(transactionPaths(state, "node_modules").slot, "backup.mode"))).toBe(false);
  });

  it("uses the saved root mode while restoring a readonly crash backup", () => {
    const state = fixture();
    createToolchain(state);
    chmodSync(join(state.sourceRoot, "node_modules"), 0o555);
    expect(provisionWorktree(request(state)).ok).toBe(true);
    const destination = join(state.targetRoot, "node_modules");
    const transaction = transactionPaths(state, "node_modules");
    const modeMarker = join(transaction.slot, "backup.mode");
    writeFileSync(modeMarker, String(0o555), { mode: 0o600 });
    chmodSync(destination, 0o700);
    renameSync(destination, transaction.backup);

    const stopped = provisionWorktree({
      ...request(state),
      faults: { beforePublish: () => { throw new Error("stop after crash reconciliation"); } }
    });
    expect(stopped.issues[0]).toMatchObject({ code: "PUBLISH_FAILED" });
    expect(statSync(destination).mode & 0o777).toBe(0o555);
    expect(existsSync(modeMarker)).toBe(false);
  });

  it("refuses a path-substituted file that differs from the inspected inode", () => {
    const state = fixture();
    const source = createToolchain(state);
    const original = readFileSync(source.tool);
    let injected = false;
    const result = provisionWorktree({
      ...request(state),
      faults: {
        beforeSourceOpen(relativePath) {
          if (injected || relativePath !== "pkg/bin/tool") return;
          injected = true;
          const moved = `${source.tool}.inspected`;
          renameSync(source.tool, moved);
          writeFileSync(source.tool, Buffer.alloc(original.length, 0x78));
          chmodSync(source.tool, 0o755);
        }
      }
    });
    expect(result.issues[0]).toMatchObject({ code: "COPY_FAILED", path: "0.path" });
    expect(existsSync(join(state.targetRoot, "node_modules"))).toBe(false);
  });

  it("keeps copying the pinned inode when its pathname is swapped after open, then refuses publication", () => {
    const state = fixture();
    const source = createToolchain(state);
    const original = readFileSync(source.tool);
    let injected = false;
    const result = provisionWorktree({
      ...request(state),
      faults: {
        afterSourceOpen(relativePath) {
          if (injected || relativePath !== "pkg/bin/tool") return;
          injected = true;
          renameSync(source.tool, `${source.tool}.opened`);
          writeFileSync(source.tool, Buffer.alloc(original.length, 0x6d));
          chmodSync(source.tool, 0o755);
        }
      }
    });
    expect(result.issues[0]).toMatchObject({ code: "COPY_FAILED" });
    expect(existsSync(join(state.targetRoot, "node_modules"))).toBe(false);
  });

  it("copies through pinned descriptors and refuses both growth and restored-byte mutations", () => {
    for (const restoreOriginal of [false, true]) {
      const state = fixture();
      const source = createToolchain(state);
      const old = join(state.targetRoot, "node_modules");
      mkdirSync(old);
      writeFileSync(join(old, "old"), "preserve me");
      const original = readFileSync(source.tool);
      let injected = false;
      const result = provisionWorktree({
        ...request(state),
        faults: {
          afterFileCopy(relativePath) {
            if (injected || relativePath !== "pkg/bin/tool") return;
            injected = true;
            writeFileSync(source.tool, Buffer.concat([original, Buffer.from("changed")]))
            if (restoreOriginal) writeFileSync(source.tool, original);
          }
        }
      });
      expect(result.issues[0]).toMatchObject({ code: "COPY_FAILED", path: "0.path" });
      expect(readFileSync(join(old, "old"), "utf8")).toBe("preserve me");
      expect(existsSync(transactionPaths(state, "node_modules").staging)).toBe(false);
    }
  });

  it("restores the old destination after an injected mid-publish failure", () => {
    const state = fixture();
    createToolchain(state);
    const destination = join(state.targetRoot, "node_modules");
    mkdirSync(destination);
    writeFileSync(join(destination, "old"), "old destination");
    const result = provisionWorktree({
      ...request(state),
      faults: { afterBackup: () => { throw new Error("injected publish failure"); } }
    });
    expect(result.issues[0]).toMatchObject({ code: "PUBLISH_FAILED", path: "0.path" });
    expect(readFileSync(join(destination, "old"), "utf8")).toBe("old destination");
    const transaction = transactionPaths(state, "node_modules");
    expect(existsSync(transaction.staging)).toBe(false);
    expect(existsSync(transaction.backup)).toBe(false);
  });

  it("moves a broken external destination link itself without touching its target", () => {
    if (process.platform === "win32") return;
    const state = fixture();
    createToolchain(state);
    const external = join(state.base, "external");
    mkdirSync(external);
    writeFileSync(join(external, "sentinel"), "untouched");
    symlinkSync(join(external, "missing"), join(state.targetRoot, "node_modules"));
    const result = provisionWorktree(request(state));
    expect(result.ok).toBe(true);
    expect(lstatSync(join(state.targetRoot, "node_modules")).isDirectory()).toBe(true);
    expect(readFileSync(join(external, "sentinel"), "utf8")).toBe("untouched");
    expect(existsSync(join(external, "missing"))).toBe(false);
  });

  it("reconciles interrupted backup/staging state before retrying", () => {
    const state = fixture();
    createToolchain(state);
    const destination = join(state.targetRoot, "node_modules");
    const transaction = transactionPaths(state, "node_modules");
    mkdirSync(transaction.slot);
    mkdirSync(transaction.backup);
    writeFileSync(join(transaction.backup, "old"), "recover this");
    mkdirSync(transaction.staging);
    writeFileSync(join(transaction.staging, "partial"), "discard this");

    const result = provisionWorktree({
      ...request(state),
      faults: { beforePublish: () => { throw new Error("stop after reconciliation"); } }
    });
    expect(result.issues[0]).toMatchObject({ code: "PUBLISH_FAILED" });
    expect(readFileSync(join(destination, "old"), "utf8")).toBe("recover this");
    expect(existsSync(transaction.staging)).toBe(false);
    expect(existsSync(transaction.backup)).toBe(false);
  });

  it.each([
    ["destination plus staging", true, false, true, true],
    ["destination plus backup", true, true, false, true],
    ["staging only", false, false, true, false]
  ])("reconciles %s crash state without accepting partial content", (_label, destinationExists, backupExists, stagingExists, oldSurvives) => {
    const state = fixture();
    createToolchain(state);
    const destination = join(state.targetRoot, "node_modules");
    const transaction = transactionPaths(state, "node_modules");
    mkdirSync(transaction.slot);
    if (destinationExists) {
      mkdirSync(destination);
      writeFileSync(join(destination, "old"), "winner");
    }
    if (backupExists) {
      mkdirSync(transaction.backup);
      writeFileSync(join(transaction.backup, "backup"), "loser");
    }
    if (stagingExists) {
      mkdirSync(transaction.staging);
      writeFileSync(join(transaction.staging, "partial"), "discard");
    }
    const result = provisionWorktree({
      ...request(state),
      faults: { beforePublish: () => { throw new Error("inspect reconciled state"); } }
    });
    expect(result.issues[0]).toMatchObject({ code: "PUBLISH_FAILED" });
    expect(existsSync(transaction.staging)).toBe(false);
    expect(existsSync(transaction.backup)).toBe(false);
    expect(existsSync(join(destination, "partial"))).toBe(false);
    expect(existsSync(join(destination, "backup"))).toBe(false);
    expect(existsSync(join(destination, "old"))).toBe(oldSurvives);
  });

  it("rejects unsafe roots and target-parent symlinks before copying", () => {
    if (process.platform === "win32") return;
    const state = fixture();
    mkdirSync(join(state.sourceRoot, "vendor", "cache"), { recursive: true });
    writeFileSync(join(state.sourceRoot, "vendor", "cache", "file"), "source");
    const external = join(state.base, "external");
    mkdirSync(external);
    symlinkSync(external, join(state.targetRoot, "vendor"));
    const result = provisionWorktree(request(state, [{ path: "vendor/cache" }]));
    expect(result.issues[0]).toMatchObject({ code: "UNSAFE_TARGET", path: "0.path" });
    expect(readdirSync(external)).toEqual([]);

    const overlapping = provisionWorktree({
      sourceRoot: state.sourceRoot,
      targetRoot: state.targetRoot,
      transactionRoot: join(state.targetRoot, "nested-transaction"),
      specs: [{ path: "vendor/cache" }]
    });
    expect(overlapping.issues[0]).toMatchObject({ code: "UNSAFE_TARGET" });
  });

  it("keeps an empty plan entirely inert even when all roots are absent", () => {
    const state = fixture();
    const absent = join(state.base, "absent");
    const before = tree(state.base);
    expect(provisionWorktree({ sourceRoot: absent, targetRoot: absent, transactionRoot: absent, specs: [] })).toEqual({
      ok: true,
      disabled: true,
      changed: false,
      issues: [],
      provisioned: []
    });
    expect(tree(state.base)).toEqual(before);
  });
});

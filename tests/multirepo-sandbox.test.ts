import { chmodSync, closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAllowlistedBwrapArgs,
  assertSandboxSocketIdentity,
  detectSandbox,
  pinSandboxSocket,
  providerPrivateWritableRoots,
  setTrustedRunner,
  wrapCommand
} from "../src/sandbox.js";

const fixture = realpathSync(resolve(dirname(new URL(import.meta.url).pathname), "fixtures/multirepo-sandbox-child.mjs"));
const createdRoots = new Set<string>();
/** Ordinary CI hosts may install Bubblewrap but still cannot launch it (userns). Release-required hosts fail closed. */
const REQUIRE_STRONG_HOST = process.env.RELAYFORGE_TEST_REQUIRE_CGROUP === "1";
const LAUNCHABLE_BWRAP = detectSandbox() === "bwrap";
const skipRealBwrap = !LAUNCHABLE_BWRAP && !REQUIRE_STRONG_HOST;

afterEach(() => {
  setTrustedRunner(false);
  for (const root of createdRoots) {
    if (!basename(root).startsWith("relayforge-mr-sandbox-") || dirname(root) !== resolve(tmpdir())) {
      throw new Error(`refusing to clean unexpected sandbox fixture path ${root}`);
    }
    rmSync(root, { recursive: true, force: true });
  }
  createdRoots.clear();
});

function layout(): Readonly<{
  root: string;
  first: string;
  second: string;
  third: string;
  secret: string;
}> {
  const root = mkdtempSync(resolve(tmpdir(), "relayforge-mr-sandbox-"));
  createdRoots.add(root);
  const first = resolve(root, "repo-first");
  const second = resolve(root, "repo-second");
  const third = resolve(root, "repo-third");
  mkdirSync(first, { mode: 0o700 });
  mkdirSync(second, { mode: 0o700 });
  mkdirSync(third, { mode: 0o700 });
  writeFileSync(resolve(third, "third-secret.txt"), "third-repository-secret\n", { mode: 0o600 });
  const secret = resolve(root, "host-credential-sentinel");
  writeFileSync(secret, "host-secret\n", { mode: 0o600 });
  return { root, first, second, third, secret };
}

describe("P6 Bubblewrap filesystem capability", () => {
  it("builds an empty-root allowlist and refuses broad/overlapping visibility", () => {
    const value = layout();
    const args = buildAllowlistedBwrapArgs(process.execPath, [fixture], {
      writableRoots: [value.first, value.second],
      readableRoots: [],
      runtimeRoots: [process.execPath, fixture],
      inaccessibleRoots: [value.third, value.secret],
      cwd: value.first
    }, true);
    const serialized = args.join("\0");
    expect(serialized).toContain("--tmpfs\0/");
    expect(args).toEqual(expect.arrayContaining(["--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup"]));
    expect(serialized).not.toContain("--ro-bind\0/\0/");
    expect(serialized).toContain(`--bind\0${value.first}\0${value.first}`);
    expect(serialized).toContain(`--bind\0${value.second}\0${value.second}`);
    expect(serialized).not.toContain(value.third);
    expect(serialized).not.toContain(value.secret);
    expect(serialized).not.toContain(`${process.env.HOME ?? ""}/.ssh`);

    expect(() => buildAllowlistedBwrapArgs(process.execPath, [], {
      writableRoots: [value.first],
      readableRoots: [value.root],
      runtimeRoots: [process.execPath],
      inaccessibleRoots: [value.third],
      cwd: value.first
    }, false)).toThrow(/overlaps inaccessible/u);
    if (process.env.HOME) {
      expect(() => buildAllowlistedBwrapArgs(process.execPath, [], {
        writableRoots: [value.first],
        readableRoots: [process.env.HOME],
        runtimeRoots: [process.execPath],
        inaccessibleRoots: [],
        cwd: value.first
      }, false)).toThrow(/operator home/u);
    }
  });

  it.skipIf(skipRealBwrap)("runs a real child with two writable repositories while the third, host secret, and parent listing are unavailable", () => {
    expect(detectSandbox(), "the required release host must provide launchable Bubblewrap").toBe("bwrap");
    setTrustedRunner(false);
    const value = layout();
    const secretFd = openSync(value.secret, "r");
    const wrapped = wrapCommand(process.execPath, [fixture, value.first, value.second, value.third, value.secret, value.root, String(process.pid), String(secretFd)], {
      writableRoot: value.first,
      extraWritable: [value.second],
      network: false,
      cwd: value.first,
      filesystem: {
        mode: "allowlist",
        runtimeRoots: [fixture],
        inaccessibleRoots: [value.third, value.secret]
      }
    });
    expect(wrapped.command).toBe("bwrap");
    const child = spawnSync(wrapped.command, wrapped.args, {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      env: { PATH: "/usr/bin", HOME: value.root }
    });
    closeSync(secretFd);
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout) as Record<string, { code?: string; value?: unknown }>;
    expect(result.third?.code).toMatch(/ENOENT|EACCES/u);
    expect(result.secret?.code).toMatch(/ENOENT|EACCES/u);
    expect(result.parent?.code).toBe("EACCES");
    expect(result.hostProcess?.code).toMatch(/ENOENT|EACCES/u);
    expect(result.hostRootSecret?.code).toMatch(/ENOENT|EACCES/u);
    expect(result.hostFdSecret?.code).toMatch(/ENOENT|EACCES/u);
    expect(readFileSync(resolve(value.first, "authorized.txt"), "utf8")).toBe("first\n");
    expect(readFileSync(resolve(value.second, "authorized.txt"), "utf8")).toBe("second\n");
    expect(readFileSync(resolve(value.third, "third-secret.txt"), "utf8")).toBe("third-repository-secret\n");
    expect(readFileSync(value.secret, "utf8")).toBe("host-secret\n");
  });

  it.skipIf(skipRealBwrap)("exposes only an exact nested Git metadata capability beneath an otherwise absent repository", () => {
    expect(detectSandbox(), "the required release host must provide launchable Bubblewrap").toBe("bwrap");
    const value = layout();
    const canonicalRepo = resolve(value.root, "canonical-alpha");
    const gitMetadata = resolve(canonicalRepo, ".git");
    const checkoutFile = resolve(canonicalRepo, "README.md");
    const siblingRepo = resolve(value.root, "canonical-beta");
    const siblingFile = resolve(siblingRepo, "README.md");
    mkdirSync(gitMetadata, { recursive: true, mode: 0o700 });
    mkdirSync(siblingRepo, { mode: 0o700 });
    writeFileSync(resolve(gitMetadata, "HEAD"), "ref: refs/heads/main\n", { mode: 0o600 });
    writeFileSync(checkoutFile, "alpha checkout must stay absent\n", { mode: 0o600 });
    writeFileSync(siblingFile, "beta checkout must stay absent\n", { mode: 0o600 });

    const probe = [
      "const fs=require('node:fs');",
      "const read=(p)=>{try{return {value:fs.readFileSync(p,'utf8')}}catch(e){return {code:e.code}}};",
      "process.stdout.write(JSON.stringify({metadata:read(process.argv[1]),checkout:read(process.argv[2]),sibling:read(process.argv[3]),third:read(process.argv[4])}));"
    ].join("");
    const wrapped = wrapCommand(process.execPath, [
      "-e",
      probe,
      resolve(gitMetadata, "HEAD"),
      checkoutFile,
      siblingFile,
      resolve(value.third, "third-secret.txt")
    ], {
      writableRoot: value.first,
      network: false,
      cwd: value.first,
      filesystem: {
        mode: "allowlist",
        readableRoots: [gitMetadata],
        inaccessibleRoots: [canonicalRepo, siblingRepo, value.third]
      }
    });
    const child = spawnSync(wrapped.command, wrapped.args, {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      env: { PATH: "/usr/bin", HOME: value.root }
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout) as Record<string, { code?: string; value?: unknown }>;
    expect(result.metadata?.value).toBe("ref: refs/heads/main\n");
    expect(result.checkout?.code).toMatch(/ENOENT|EACCES/u);
    expect(result.sibling?.code).toMatch(/ENOENT|EACCES/u);
    expect(result.third?.code).toMatch(/ENOENT|EACCES/u);
  });

  it.skipIf(skipRealBwrap)("mounts only the selected provider's exact private state and never a broad cache", () => {
    expect(detectSandbox(), "the required release host must provide launchable Bubblewrap").toBe("bwrap");
    const value = layout();
    const home = resolve(value.root, "operator-home");
    const claude = resolve(home, ".claude");
    const claudeCache = resolve(home, ".cache/claude");
    const codex = resolve(home, ".codex");
    const gemini = resolve(home, ".gemini");
    const broadCache = resolve(home, ".cache/unrelated-secret");
    for (const directory of [home, resolve(home, ".cache"), claude, claudeCache, codex, gemini]) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const allowedState = resolve(claude, "credential");
    const codexState = resolve(codex, "credential");
    const geminiState = resolve(gemini, "credential");
    writeFileSync(allowedState, "claude-only\n", { mode: 0o600 });
    writeFileSync(codexState, "codex-secret\n", { mode: 0o600 });
    writeFileSync(geminiState, "gemini-secret\n", { mode: 0o600 });
    writeFileSync(broadCache, "unrelated-cache-secret\n", { mode: 0o600 });
    const privateRoots = providerPrivateWritableRoots("claude", home);
    expect(privateRoots).toEqual([claudeCache, claude].sort((a, b) => a.localeCompare(b)));
    expect(privateRoots).not.toContain(codex);
    expect(privateRoots).not.toContain(gemini);
    expect(privateRoots).not.toContain(resolve(home, ".cache"));

    const wrapped = wrapCommand(process.execPath, [
      fixture,
      value.first,
      value.second,
      value.third,
      value.secret,
      value.root,
      "",
      "",
      allowedState,
      codexState,
      geminiState,
      broadCache
    ], {
      writableRoot: value.first,
      extraWritable: [value.second, ...privateRoots],
      network: false,
      cwd: value.first,
      filesystem: {
        mode: "allowlist",
        runtimeRoots: [fixture],
        inaccessibleRoots: [value.third, value.secret, codex, gemini, broadCache]
      }
    });
    const child = spawnSync(wrapped.command, wrapped.args, {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      env: { PATH: "/usr/bin", HOME: home }
    });
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout) as Record<string, { code?: string; value?: unknown }>;
    expect(result.allowedState?.value).toBe("claude-only\n");
    expect(result.codexState?.code).toMatch(/ENOENT|EACCES/u);
    expect(result.geminiState?.code).toMatch(/ENOENT|EACCES/u);
    expect(result.broadCacheSecret?.code).toMatch(/ENOENT|EACCES/u);
  });

  it.skipIf(skipRealBwrap)("mounts only an identity-pinned 0600 AF_UNIX relay and refuses replacement", async () => {
    expect(detectSandbox(), "the required release host must provide launchable Bubblewrap").toBe("bwrap");
    const value = layout();
    const relayDir = resolve(value.root, "relay");
    mkdirSync(relayDir, { mode: 0o700 });
    const socketPath = resolve(relayDir, "grok-egress-v1.sock");
    const server = createServer((socket) => socket.end("pong"));
    server.listen(socketPath);
    await once(server, "listening");
    chmodSync(socketPath, 0o600);
    const identity = pinSandboxSocket(socketPath);
    const wrapped = wrapCommand(process.execPath, [
      "-e",
      "const n=require('node:net');const s=n.connect(process.argv[1]);s.on('data',d=>process.stdout.write(d));",
      socketPath
    ], {
      writableRoot: value.first,
      network: false,
      cwd: value.first,
      filesystem: { mode: "allowlist", socketRoots: [identity], inaccessibleRoots: [value.third, value.secret] }
    });
    const child = spawn(wrapped.command, wrapped.args, {
      env: { PATH: "/usr/bin", HOME: value.root }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const [status] = await once(child, "close") as [number | null];
    expect(status, stderr).toBe(0);
    expect(stdout).toBe("pong");
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));

    const replacement = createServer();
    replacement.listen(socketPath);
    await once(replacement, "listening");
    chmodSync(socketPath, 0o600);
    expect(() => assertSandboxSocketIdentity(identity)).toThrow(/identity changed/u);
    await new Promise<void>((resolveClose) => replacement.close(() => resolveClose()));
  });
});

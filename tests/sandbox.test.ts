import { afterEach, describe, expect, it } from "vitest";
import {
  buildBwrapArgs,
  containCommand,
  containmentAvailable,
  detectSandbox,
  setTrustedRunner,
  trustedRunnerActive,
  wrapCommand
} from "../src/sandbox.js";
import { verifyEnv } from "../src/orchestrator.js";

const savedSandbox = process.env.LOOP_SANDBOX;
const savedRelayForgeSandbox = process.env.RELAYFORGE_SANDBOX;

afterEach(() => {
  if (savedSandbox === undefined) delete process.env.LOOP_SANDBOX;
  else process.env.LOOP_SANDBOX = savedSandbox;
  if (savedRelayForgeSandbox === undefined) delete process.env.RELAYFORGE_SANDBOX;
  else process.env.RELAYFORGE_SANDBOX = savedRelayForgeSandbox;
  setTrustedRunner(false);
});

describe("bwrap policy (deterministic argv proof)", () => {
  it("binds ONLY the writable root, mounts root read-only, and confines to cwd", () => {
    const argv = buildBwrapArgs("bash", ["-lc", "make test"], { writableRoots: ["/work/tree"], cwd: "/work/tree" }, false);
    const s = argv.join(" ");
    expect(s).toContain("--ro-bind / /");
    expect(s).toContain("--tmpfs /tmp");
    expect(s).toContain("--bind /work/tree /work/tree");
    expect(s).toContain("--chdir /work/tree");
    // The command runs after the `--` separator.
    expect(argv.slice(argv.indexOf("--") + 1)).toEqual(["bash", "-lc", "make test"]);
    // A path NOT in the writable set is never bound writable.
    expect(s).not.toContain("--bind /etc");
  });

  it("adds --unshare-net exactly when network isolation is requested & available", () => {
    const isolated = buildBwrapArgs("bash", ["-lc", "x"], { writableRoots: ["/w"], cwd: "/w" }, true);
    expect(isolated).toContain("--unshare-net");
    const shared = buildBwrapArgs("bash", ["-lc", "x"], { writableRoots: ["/w"], cwd: "/w" }, false);
    expect(shared).not.toContain("--unshare-net");
  });

  it("never grants a writable bind to /sys or a lexical descendant", () => {
    expect(() => buildBwrapArgs("bash", ["-lc", "x"], { writableRoots: ["/sys"], cwd: "/" }, true)).toThrow(/beneath \/sys/);
    expect(() => buildBwrapArgs("bash", ["-lc", "x"], { writableRoots: ["/sys/fs/cgroup"], cwd: "/" }, true)).toThrow(/beneath \/sys/);
    expect(() => buildBwrapArgs("bash", ["-lc", "x"], { writableRoots: ["/tmp/../sys/kernel"], cwd: "/" }, true)).toThrow(/beneath \/sys/);
  });
});

describe("fails closed without a launchable sandbox", () => {
  it("accepts the canonical strictness-only override and refuses an alias conflict", () => {
    delete process.env.LOOP_SANDBOX;
    process.env.RELAYFORGE_SANDBOX = "none";
    expect(detectSandbox()).toBe("none");
    process.env.LOOP_SANDBOX = "off";
    expect(() => detectSandbox()).toThrow(/ENV_CONFLICT/u);
  });

  it("wrapCommand throws when no OS sandbox mechanism exists", () => {
    process.env.LOOP_SANDBOX = "none";
    expect(detectSandbox()).toBe("none");
    expect(() => wrapCommand("bash", ["-lc", "true"], { writableRoot: "/tmp", network: false, cwd: "/tmp" })).toThrow(/No OS sandbox/);
  });

  it("containCommand throws (fail closed) with no sandbox and no injected trusted runner", () => {
    process.env.LOOP_SANDBOX = "none";
    setTrustedRunner(false);
    expect(containmentAvailable()).toBe(false);
    expect(() => containCommand("bash", ["-lc", "true"], { writableRoot: "/tmp", network: false, cwd: "/tmp" })).toThrow(/failing closed|No OS sandbox/);
  });

  it("a trusted runner is opt-in via an IMPORTED symbol only — never an environment variable", () => {
    process.env.LOOP_SANDBOX = "none";
    // No environment variable can enable containment. Prove that setting arbitrary/legacy env
    // vars does NOT make a run contained.
    process.env.LOOP_ALLOW_UNSANDBOXED = "1";
    process.env.LOOP_TRUSTED_RUNNER = "1";
    setTrustedRunner(false);
    expect(containmentAvailable()).toBe(false);
    delete process.env.LOOP_ALLOW_UNSANDBOXED;
    delete process.env.LOOP_TRUSTED_RUNNER;

    // Only the imported injection turns it on, and then containCommand returns the RAW argv.
    setTrustedRunner(true);
    expect(trustedRunnerActive()).toBe(true);
    expect(containmentAvailable()).toBe(true);
    const outcome = containCommand("bash", ["-lc", "echo hi"], { writableRoot: "/tmp", network: false, cwd: "/tmp" });
    expect(outcome.kind).toBe("trusted");
    expect(outcome.command).toBe("bash");
    expect(outcome.args).toEqual(["-lc", "echo hi"]);
  });
});

describe("verifier environment is scrubbed of secrets", () => {
  it("keeps PATH/HOME but drops secret-shaped and provider-auth variables", () => {
    const source = {
      PATH: "/usr/bin",
      HOME: "/home/x",
      ANTHROPIC_API_KEY: "sk-anthropic",
      OPENAI_API_KEY: "sk-openai",
      AWS_SECRET_ACCESS_KEY: "leak",
      GITHUB_TOKEN: "ghp_leak"
    } as NodeJS.ProcessEnv;
    const env = verifyEnv(source);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/x");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });
});

import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ScmProductPolicyError,
  createHostScopedGithubTransport,
  createScmProductRuntime,
  parseScmProductRepositoryConfig
} from "../src/scm/product-policy.js";
import type { GithubTransportRequest } from "../src/scm/github.js";
import { createAuthenticatedScmGitCommandRunner } from "../src/scm/publish.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), "relayforge-scm-policy-")));
  roots.push(value);
  return value;
}

function config(repositoryRoot = root()) {
  return {
    schemaVersion: 1,
    repositoryKey: "repo-api",
    provider: "github",
    canonicalHost: "github.com",
    owner: "relayforge",
    name: "api",
    baseOwner: "relayforge",
    baseName: "api",
    repositoryRoot,
    remoteName: "origin",
    expectedPushUrl: "https://github.com/relayforge/api.git",
    baseRef: "refs/heads/main",
    credentialEnv: "RELAYFORGE_GITHUB_TOKEN",
    capabilities: ["scm.write_pr", "scm.read", "scm.publish_branch"],
    limits: { requestTimeoutMs: 10_000, maxPagesPerEndpoint: 5, maxItemsPerEndpoint: 500 }
  };
}

function request(url: string): GithubTransportRequest {
  return {
    url,
    method: "GET",
    redirect: "error",
    headers: Object.freeze({ accept: "application/json" }),
    signal: new AbortController().signal
  };
}

describe("SCM product configuration and credential-host policy", () => {
  it("materializes a canonical, secret-free repository binding with downward-only limits", () => {
    const binding = parseScmProductRepositoryConfig(config());
    expect(binding).toMatchObject({
      repositoryKey: "repo-api",
      repository: { provider: "github", canonicalHost: "github.com", owner: "relayforge", name: "api" },
      expectedPushUrl: "https://github.com/relayforge/api.git",
      allowFileRemote: false,
      limits: { requestTimeoutMs: 10_000, maxPagesPerEndpoint: 5, maxItemsPerEndpoint: 500 }
    });
    expect(JSON.stringify(binding)).not.toContain("token");
  });

  it("rejects symlink/noncanonical roots, foreign hosts, duplicate capabilities and upward limits", () => {
    const value = config();
    expect(() => parseScmProductRepositoryConfig({ ...value, repositoryRoot: `${value.repositoryRoot}/.` }))
      .toThrowError(expect.objectContaining({ code: "NON_CANONICAL_ROOT" }));
    expect(() => parseScmProductRepositoryConfig({ ...value, expectedPushUrl: "https://evil.example/relayforge/api.git" }))
      .toThrowError(expect.objectContaining({ code: "INVALID_CONFIG" }));
    expect(() => parseScmProductRepositoryConfig({ ...value, capabilities: ["scm.read", "scm.read", "scm.write_pr"] }))
      .toThrowError(expect.objectContaining({ code: "INVALID_CONFIG" }));
    expect(() => parseScmProductRepositoryConfig({
      ...value,
      limits: { requestTimeoutMs: 30_001 }
    })).toThrowError(expect.objectContaining({ code: "LIMIT_ESCALATION" }));
  });

  it("injects a credential only for the canonical API authority", async () => {
    const seen: GithubTransportRequest[] = [];
    const transport = createHostScopedGithubTransport({
      canonicalHost: "github.com",
      token: "secret-value",
      transport: async (value) => {
        seen.push(value);
        return new Response("{}", { status: 200 });
      }
    });
    await transport(request("https://api.github.com/repos/relayforge/api"));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.authorization).toBe("Bearer secret-value");
    await expect(transport(request("https://github.com/repos/relayforge/api")))
      .rejects.toMatchObject({ code: "FOREIGN_HOST" });
    await expect(transport({ ...request("https://api.github.com/repos/relayforge/api"), headers: { Authorization: "bad" } }))
      .rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });

  it("redacts thrown transport diagnostics and never serializes the resolved token", async () => {
    const runtime = createScmProductRuntime({
      config: config(),
      environment: { RELAYFORGE_GITHUB_TOKEN: "super-secret" },
      transport: async () => { throw new Error("network included super-secret"); }
    });
    expect(JSON.stringify(runtime)).not.toContain("super-secret");
    const call = runtime.provider.lookupPullRequests({
      repository: runtime.binding.baseRepository,
      headRepository: runtime.binding.repository,
      headRef: "refs/heads/topic",
      baseRepository: runtime.binding.baseRepository,
      baseRef: runtime.binding.baseRef,
      limits: runtime.binding.limits,
      signal: new AbortController().signal
    });
    await expect(call).resolves.toMatchObject({ fetched: false });
    expect(JSON.stringify(await call)).not.toContain("super-secret");
  });

  it("fails closed for missing or whitespace-bearing credential material", () => {
    expect(() => createScmProductRuntime({ config: config(), environment: {}, transport: async () => new Response() }))
      .toThrowError(expect.objectContaining({ code: "MISSING_CREDENTIAL" }));
    expect(() => createScmProductRuntime({
      config: config(),
      environment: { RELAYFORGE_GITHUB_TOKEN: " bad token " },
      transport: async () => new Response()
    })).toThrowError(expect.objectContaining({ code: "INVALID_CREDENTIAL" }));
    expect(new ScmProductPolicyError("TRANSPORT_FAILURE", "GitHub transport failed").message).not.toContain("secret");
  });

  it("keeps the Git credential out of argv/output and scopes its ephemeral config to one host", async () => {
    const directory = root();
    const executable = join(directory, "git");
    writeFileSync(executable, `#!/usr/bin/env node
const value = process.env.GIT_CONFIG_VALUE_0 ?? "";
process.stdout.write(JSON.stringify({
  argv: process.argv.slice(2),
  count: process.env.GIT_CONFIG_COUNT,
  key0: process.env.GIT_CONFIG_KEY_0,
  valuePresent: value.startsWith("Authorization: Basic ") && value.length > 24,
  key1: process.env.GIT_CONFIG_KEY_1,
  value1: process.env.GIT_CONFIG_VALUE_1
}));
`, { mode: 0o700 });
    chmodSync(executable, 0o700);
    const priorPath = process.env.PATH;
    const token = "private-test-token";
    process.env.PATH = `${directory}:${priorPath ?? "/usr/bin:/bin"}`;
    try {
      const result = await createAuthenticatedScmGitCommandRunner({ canonicalHost: "github.com", token }).run({
        cwd: directory,
        args: ["status", "--porcelain"],
        timeoutMs: 2_000,
        maximumOutputBytes: 4_096,
        allowFileProtocol: false
      });
      expect(result.disposition).toBe("exited");
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        argv: expect.arrayContaining(["status", "--porcelain"]),
        count: "2",
        key0: "http.https://github.com/.extraHeader",
        valuePresent: true,
        key1: "http.followRedirects",
        value1: "false"
      });
      expect(`${result.stdout}${result.stderr}${JSON.stringify(JSON.parse(result.stdout).argv)}`).not.toContain(token);
    } finally {
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
    }
  });
});

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { registerOwnedTemp } from "./global-teardown.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(REPO_ROOT, "src/cli.ts");
const TSX = resolve(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repository(root: string, name: string): string {
  const path = join(root, name);
  execFileSync("git", ["init", "-q", "-b", "main", path]);
  git(path, "config", "user.email", "relayforge@example.invalid");
  git(path, "config", "user.name", "RelayForge fixture");
  writeFileSync(join(path, "README.md"), `${name}\n`);
  git(path, "add", "--all");
  git(path, "commit", "-qm", "baseline");
  return path;
}

function configuration(root: string, providerType: string, repositoryPath = "alpha", publication = false, authSnippet = ""): string {
  const provider = providerType === "custom"
    ? `{ type: custom, command: ${JSON.stringify(process.execPath)} }`
    : `{ type: ${providerType}${authSnippet} }`;
  const publicationBlock = publication ? `
          publication:
            policyApproved: true
            entries:
              - repository: alpha
                publicationId: publish-alpha
                remoteName: origin
                expectedPushUrl: https://github.com/example/alpha.git
                remoteRef: refs/heads/relayforge-change
                expectedRemoteOid: null
                baseRef: refs/heads/main
                title: RelayForge change
                body: Exact reviewed change
` : "";
  const path = join(root, "loop.config.yaml");
  writeFileSync(path, `version: 1
defaults:
  runDir: .loop/runs
  viewport: false
projects:
  - name: product
    workingDir: alpha
    providers:
      worker: ${provider}
    repositories:
      - { name: alpha, path: ${repositoryPath}, defaultBranch: main, protectedBranches: [main] }
    multiRepository:
      providerRepositories: { worker: [alpha] }
      tasks:
        - id: change
          role: implementer
          provider: worker
          repositories: [alpha]
          entries:
            - { repository: alpha, branch: rf-change, targetRef: refs/heads/integration }
          verifyCommands: ["true"]
          commitMessage: bounded change${publicationBlock}
    roles:
      - { name: implementer, title: Implementer, provider: worker, repositories: [alpha] }
    loops:
      - { name: delivery, orchestrator: implementer, reviewer: implementer }
`, { mode: 0o600 });
  return path;
}

function refused(root: string, configPath: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [TSX, CLI, "--config", configPath, "run", "goal", "--execute", "--run", "must-not-exist"], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
    timeout: 30_000
  });
}

describe("P6 zero-mutation product preflight", () => {
  it("rejects a native structured multi-root provider before prepareRun creates .loop", () => {
    // Canonical temp root: macOS /var is a symlink to /private/var which can defeat repo identity probes.
    const root = mkdtempSync(join(realpathSync(tmpdir()), "relayforge-p6-native-preflight-"));
    registerOwnedTemp(root);
    repository(root, "alpha");
    git(join(root, "alpha"), "branch", "integration");
    // Pin api-key mode so the refusal is deterministic even on machines with opencode installed:
    // the credential gate fails closed on the missing OPENAI_API_KEY before any CLI-login fallback.
    const result = refused(root, configuration(root, "opencode", "alpha", false, ", auth: { mode: 'api-key' }"));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/NATIVE_ADAPTER_EVIDENCE_UNAVAILABLE/u);
    expect(result.stderr).toMatch(/opencode/u);
    expect(existsSync(join(root, ".loop"))).toBe(false);
  });

  it("rejects unavailable remote publication before local integration or control state exists", () => {
    const root = mkdtempSync(join(tmpdir(), "relayforge-p6-publication-preflight-"));
    registerOwnedTemp(root);
    repository(root, "alpha");
    git(join(root, "alpha"), "branch", "integration");
    const result = refused(root, configuration(root, "custom", "alpha", true));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /remote publication requires explicit project\.scm repository bindings and a parent-held cross-link capability/u
    );
    expect(existsSync(join(root, ".loop"))).toBe(false);
  });

  it("rejects a symlink alias repository identity before creating the requested run", () => {
    const root = mkdtempSync(join(tmpdir(), "relayforge-p6-identity-preflight-"));
    registerOwnedTemp(root);
    repository(root, "alpha");
    git(join(root, "alpha"), "branch", "integration");
    symlinkSync(join(root, "alpha"), join(root, "alpha-link"));
    const result = refused(root, configuration(root, "custom", "alpha-link"));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/canonical|symlink|identity/i);
    expect(existsSync(join(root, ".loop"))).toBe(false);
  });
});

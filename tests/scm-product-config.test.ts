import { describe, expect, it } from "vitest";
import { ProjectSchema, type ProjectConfig } from "../src/config/schema.js";
import { validateProjectSemantics } from "../src/config/validate.js";

function project(): ProjectConfig {
  return ProjectSchema.parse({
    name: "product",
    providers: { worker: { type: "custom", command: "/usr/bin/false", args: [] } },
    repositories: [{ name: "api", path: "api", defaultBranch: "main", protectedBranches: ["main"] }],
    scm: {
      repositories: [{
        repository: "api",
        provider: "github",
        canonicalHost: "github.com",
        owner: "relayforge",
        name: "api",
        baseOwner: "upstream",
        baseName: "api",
        remoteName: "origin",
        expectedPushUrl: "https://github.com/relayforge/api.git",
        baseRef: "refs/heads/main",
        credentialEnv: "RELAYFORGE_GITHUB_TOKEN",
        capabilities: ["scm.read", "scm.publish_branch", "scm.write_pr"]
      }],
      crossLinks: { mode: "pull-request-body" }
    },
    multiRepository: {
      providerRepositories: { worker: ["api"] },
      tasks: [{
        id: "ship-api",
        generation: 1,
        role: "implementer",
        provider: "worker",
        repositories: ["api"],
        entries: [{ repository: "api", branch: "rf-api", targetRef: "refs/heads/integration" }],
        verifyCommands: ["true"],
        commitMessage: "ship api",
        publication: {
          policyApproved: true,
          entries: [{
            repository: "api",
            publicationId: "publication-api",
            remoteName: "origin",
            expectedPushUrl: "https://github.com/relayforge/api.git",
            remoteRef: "refs/heads/relayforge/run-1",
            expectedRemoteOid: null,
            baseRef: "refs/heads/main",
            title: "Ship API",
            body: "Bounded publication body"
          }]
        }
      }]
    },
    roles: [{ name: "implementer", title: "Implementer", provider: "worker", repositories: ["api"] }],
    loops: [{ name: "delivery", orchestrator: "implementer", reviewer: "implementer" }]
  });
}

function messages(value: ProjectConfig): string {
  return validateProjectSemantics(value).map((issue) => `${issue.path}: ${issue.message}`).join("\n");
}

describe("product SCM configuration gate", () => {
  it("accepts only an exact credential-free publication binding with implemented cross-links", () => {
    const value = project();
    expect(validateProjectSemantics(value)).toEqual([]);
    expect(JSON.stringify(value.scm)).not.toContain("secret");
    expect(JSON.stringify(value.scm)).not.toContain("token");
  });

  it("rejects publication before execution when SCM authority or cross-links are absent", () => {
    const withoutScm = ProjectSchema.parse({ ...project(), scm: undefined });
    expect(messages(withoutScm)).toContain("remote publication requires explicit project.scm");

    const withoutCrossLinks = ProjectSchema.parse({
      ...project(),
      scm: { ...project().scm!, crossLinks: undefined }
    });
    expect(messages(withoutCrossLinks)).toContain("scm.crossLinks.mode: pull-request-body");
  });

  it("rejects host/remote/generation drift and globally reused publication identities", () => {
    const foreignHost = ProjectSchema.parse({
      ...project(),
      scm: {
        ...project().scm!,
        repositories: [{ ...project().scm!.repositories[0]!, expectedPushUrl: "https://evil.example/relayforge/api.git" }]
      }
    });
    expect(messages(foreignHost)).toContain("credential-free canonical HTTPS");

    const stale = project();
    stale.multiRepository!.tasks[0]!.generation = 2;
    stale.multiRepository!.tasks[0]!.publication!.entries[0]!.remoteName = "fork";
    const staleMessages = messages(stale);
    expect(staleMessages).toContain("must begin at generation 1");
    expect(staleMessages).toContain("differs from the SCM binding");

    const duplicate = project();
    duplicate.multiRepository!.tasks.push({
      ...structuredClone(duplicate.multiRepository!.tasks[0]!),
      id: "ship-api-again",
      entries: [{ ...duplicate.multiRepository!.tasks[0]!.entries[0]!, branch: "rf-api-2", targetRef: "refs/heads/integration-2" }]
    });
    expect(messages(duplicate)).toContain("publication ID \"publication-api\" is reused");
  });
});

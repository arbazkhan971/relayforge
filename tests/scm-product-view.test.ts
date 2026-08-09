import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseControlEvent } from "../src/control/events.js";
import { openControlStore, type ControlStore } from "../src/control/store.js";
import { buildScmProductControlView, buildScmProductDoctorChecks } from "../src/scm/product-view.js";
import { SCM_PROVIDER_LIMITS, type ScmPublicationIntentV1 } from "../src/scm/types.js";
import type { ScmRepositoryBindingV1 } from "../src/scm/product-policy.js";

const NOW = "2026-08-09T12:00:00.000Z";
const roots: string[] = [];
const stores: ControlStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) try { store.close(); } catch { /* closed */ }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function open(): ControlStore {
  const root = mkdtempSync(join(tmpdir(), "relayforge-scm-view-"));
  roots.push(root);
  const store = openControlStore({ path: join(root, "control.sqlite"), runId: "run-1", runEpoch: "epoch-1", now: () => NOW });
  stores.push(store);
  return store;
}

function intent(publicationId = "publication-1"): ScmPublicationIntentV1 {
  const repository = { schemaVersion: 1 as const, provider: "github" as const, canonicalHost: "github.example.com", owner: "relayforge", name: "project" };
  return {
    schemaVersion: 1, publicationId, publicationGeneration: 1, attempt: 1,
    runId: "run-1", runEpoch: "epoch-1", repository,
    integrationRef: "refs/heads/integration", integrationOid: "a".repeat(40), localExpectedOid: "a".repeat(40),
    remoteName: "origin", remoteRef: "refs/heads/relayforge/run-1", expectedRemote: { kind: "absent" },
    baseRepository: { ...repository, owner: "upstream" }, baseRef: "refs/heads/main",
    titleSha256: "c".repeat(64), bodySha256: "d".repeat(64), draft: false, createdAt: NOW
  };
}

function seed(store: ControlStore): void {
  store.appendBatch([
    parseControlEvent({
      schemaVersion: 1, eventId: "task-created", runId: "run-1", runEpoch: "epoch-1", taskId: "task-1", taskGeneration: 1,
      expectedVersion: 0, occurredAt: NOW, type: "task.created",
      payload: { title: "SCM", assignee: "backend", createdBy: "parent", description: "SCM view", acceptanceCriteria: ["safe"], dependsOn: [], priority: 1, createdAt: NOW }
    }),
    parseControlEvent({
      schemaVersion: 1, eventId: "publication-recorded", runId: "run-1", runEpoch: "epoch-1", taskId: "task-1", taskGeneration: 1,
      expectedVersion: 1, occurredAt: NOW, type: "scm.publication_recorded", payload: { publication: intent() }
    }),
    parseControlEvent({
      schemaVersion: 1, eventId: "publication-push-intent", runId: "run-1", runEpoch: "epoch-1", taskId: "task-1", taskGeneration: 1,
      expectedVersion: 2, occurredAt: NOW, type: "scm.publication_state_changed",
      payload: { publicationId: "publication-1", publicationGeneration: 1, fromState: "unpublished", toState: "push_intent" }
    })
  ]);
}

function binding(store: ControlStore): ScmRepositoryBindingV1 {
  const value = store.getProjection().scm.publications["publication-1"]!.intent;
  return Object.freeze({
    schemaVersion: 1, repositoryKey: "project", repository: value.repository, baseRepository: value.baseRepository,
    repositoryRoot: roots[0]!, remoteName: "origin", expectedPushUrl: "https://github.example.com/relayforge/project.git",
    baseRef: "refs/heads/main", credentialEnv: "TOKEN", capabilities: Object.freeze(["scm.publish_branch", "scm.read", "scm.write_pr"]),
    limits: SCM_PROVIDER_LIMITS, allowFileRemote: false
  });
}

describe("bounded SCM control and doctor DTOs", () => {
  it("derives fail-closed readiness without exposing event payloads or credentials", () => {
    const store = open();
    seed(store);
    const view = buildScmProductControlView({ source: store, now: () => new Date(NOW) });
    expect(view.publications).toHaveLength(1);
    expect(view.publications[0]).toMatchObject({
      publicationId: "publication-1",
      repository: "github:github.example.com/relayforge/project",
      state: "push_intent",
      pullRequest: null,
      readiness: { ready: false }
    });
    expect(view.publications[0]!.readiness.blockers).toContain("PUBLICATION_NOT_PUBLISHED");
    const serialized = JSON.stringify(view);
    expect(serialized).not.toMatch(/credential|token|preview|bodySha256|titleSha256/iu);
  });

  it("bounds publication count and emits side-effect-free doctor status", () => {
    const store = open();
    seed(store);
    const view = buildScmProductControlView({ source: store, now: () => new Date(NOW), limit: 1 });
    expect(buildScmProductDoctorChecks({ binding: binding(store), view })).toEqual([
      expect.objectContaining({ name: "scm-config", status: "ok", code: "SCM_CONFIGURED" }),
      expect.objectContaining({ name: "scm-history", status: "ok", code: "SCM_HISTORY_OK" })
    ]);
    expect(buildScmProductDoctorChecks({})).toEqual([
      expect.objectContaining({ status: "warn", code: "SCM_NOT_CONFIGURED" })
    ]);
    expect(() => buildScmProductControlView({ source: store, limit: 1_001 })).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  });
});

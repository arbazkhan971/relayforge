import { openControlStore } from "../../../src/control/store.js";
import { ScmObserver } from "../../../src/scm/observer.js";
import { createScmPublicationAggregate } from "../../../src/scm/reconcile.js";
import type { ScmProviderV1 } from "../../../src/scm/types.js";

const path = process.argv[2];
if (!path) throw new Error("usage: blocked-worker <control-store-path>");

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const headRepository = {
  schemaVersion: 1 as const,
  provider: "github" as const,
  canonicalHost: "github.example.com",
  owner: "relayforge",
  name: "project"
};
const baseRepository = { ...headRepository, owner: "upstream" };
let providerCalls = 0;
const provider: ScmProviderV1 = {
  provider: "github",
  capabilities: ["scm.read"],
  async observe() { providerCalls += 1; throw new Error("provider called before durable intent"); },
  async lookupPullRequests() { providerCalls += 1; throw new Error("provider called before durable intent"); },
  async createPullRequest() { providerCalls += 1; throw new Error("provider called before durable intent"); }
};

const store = openControlStore({ path, runId: "run-1", runEpoch: "epoch-1" });
try {
  const aggregate = createScmPublicationAggregate({
    schemaVersion: 1,
    publicationId: "publication-1",
    publicationGeneration: 1,
    attempt: 1,
    runId: "run-1",
    runEpoch: "epoch-1",
    repository: headRepository,
    integrationRef: "refs/heads/relayforge/integration",
    integrationOid: HEAD,
    localExpectedOid: HEAD,
    remoteName: "origin",
    remoteRef: "refs/heads/relayforge/run-1",
    expectedRemote: { kind: "absent" },
    baseRepository,
    baseRef: "refs/heads/main",
    titleSha256: "c".repeat(64),
    bodySha256: "d".repeat(64),
    draft: false,
    createdAt: "2026-08-09T12:00:00.000Z"
  });
  const observer = new ScmObserver({
    store,
    provider,
    steering: { admit: () => { throw new Error("P2 called before durable reaction"); } },
    actorId: "scm-observer"
  });
  const outcome = await observer.poll({
    publication: { ...aggregate, state: "published", version: 4 },
    pullRequest: {
      providerId: "7001",
      number: 7,
      url: "https://github.example.com/upstream/project/pull/7",
      repository: baseRepository,
      headRepository,
      headRef: "refs/heads/relayforge/run-1",
      headSha: HEAD,
      baseRepository,
      baseRef: "refs/heads/main",
      baseSha: BASE
    },
    taskId: "task-1",
    taskGeneration: 1,
    sessionId: "session-1",
    sessionGeneration: 1,
    notBeforeAttemptGeneration: 1,
    signal: new AbortController().signal
  });
  process.stdout.write(JSON.stringify({ outcome, headSeq: store.head().headSeq, providerCalls }));
} finally {
  store.close();
}

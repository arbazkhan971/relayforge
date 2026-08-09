const schema = await import("../../../src/scm/schema.js");

const repository = {
  schemaVersion: 1 as const,
  provider: "github" as const,
  canonicalHost: "github.example.com",
  owner: "relayforge",
  name: "cold-import"
};
schema.parseScmPublicationIntent({
  schemaVersion: 1,
  publicationId: "cold-publication",
  publicationGeneration: 1,
  attempt: 1,
  runId: "cold-run",
  runEpoch: "cold-epoch",
  repository,
  integrationRef: "refs/heads/relayforge/integration",
  integrationOid: "a".repeat(40),
  localExpectedOid: "a".repeat(40),
  remoteName: "origin",
  remoteRef: "refs/heads/relayforge/cold",
  expectedRemote: { kind: "absent" },
  baseRepository: { ...repository, owner: "upstream" },
  baseRef: "refs/heads/main",
  titleSha256: "b".repeat(64),
  bodySha256: "c".repeat(64),
  draft: false,
  createdAt: "2026-08-09T12:00:00.000Z"
});

const control = await import("../../../src/control/events.js");
if (!control.parseControlEvent || !schema.ScmPublicationIntentV1Schema) throw new Error("cold imports did not initialize");
process.stdout.write("cold-import-ok");

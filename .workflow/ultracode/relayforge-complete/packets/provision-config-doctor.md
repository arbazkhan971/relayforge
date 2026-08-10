# Packet: provision-config-doctor

## Objective

Add the structured configuration and read-only doctor surface for the audited
provisioning gate.

## Owned files

- `src/config/schema.ts`
- `src/config/validate.ts`
- `src/doctor.ts`
- `docs/configuration.md`
- `tests/provision-config-doctor.test.ts` (new)

Do not edit any other file.

## Contract

- Add strict loop field `provision`, default `[]`, max 32 specs.
- Each spec is a strict object `{ path: string, requiredExecutables?: string[] }`;
  bound string/list sizes reasonably.
- Semantic validation must call the shared `validateProvisionSpecs` from
  `src/provision.ts`, map every issue to the precise loop/spec field, and reject
  duplicates/case aliases/overlaps and unsafe executable paths.
- `runDoctor` must always include a `provision` check after selecting a project.
  Disabled is `ok`. For configured specs, call shared read-only
  `inspectProvisioning` against the selected working directory. Report current
  eligibility, not a promise that a later copy must succeed. Any configured
  missing/unsafe/unreadable/non-directory/link/tool marker is `fail` with an
  actionable fix; never write, spawn, or access the network.
- Multiple loops may differ: inspect their uniquely identified specs and make
  the detail identify the affected loop/path.
- Documentation must state offline/no scripts/no network/no hardlinks, constrained
  internal links, blocking missing source, `requiredExecutables`, all three
  worktree roles, staging/readiness semantics, and honest limitations.

## Tests

New tests cover defaults/strict schema, the complete cross-platform path and
duplicate/overlap matrix, required executable validation, doctor disabled/ready/
missing/unsafe/executable cases, every non-ok check having a fix, and proof that
doctor does not create transaction/destination state.

The core packet owns `src/provision.ts`; coordinate only through the specified
public API and do not edit it.

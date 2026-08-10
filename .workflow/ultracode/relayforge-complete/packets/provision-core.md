# Packet: provision-core

## Objective

Implement the parent-side, offline, fail-closed dependency-copy primitive after
the completed Phase-00 audit. Do not reuse the rejected `34bd894` code.

## Owned files

- `src/provision.ts` (new)
- `tests/provision.test.ts` (new)

Do not edit any other file.

## Required public contract

Export these compatible concepts (names may add supporting types, but consumers
must be able to import these exact names):

```ts
type ProvisionSpec = { path: string; requiredExecutables?: readonly string[] };
type ProvisionRequest = {
  sourceRoot: string;
  targetRoot: string;
  transactionRoot: string;
  specs: readonly ProvisionSpec[];
  // optional deterministic fault-injection hooks are allowed for tests
};

validateProvisionSpecs(specs): ProvisionIssue[];
inspectProvisioning({ sourceRoot, specs }): ProvisionInspection;
provisionWorktree(request): ProvisionResult;
```

Results use stable issue codes including at least `INVALID_PATH`,
`MISSING_SOURCE`, `UNSAFE_SOURCE`, `UNSAFE_TARGET`, `UNSAFE_SYMLINK`,
`UNSUPPORTED_ENTRY`, `COPY_FAILED`, `PUBLISH_FAILED`, and
`RECOVERY_REQUIRED`. An empty spec list is the only disabled success; a missing
configured source is a refusal.

## Security requirements

- Portable canonical forward-slash relative specs only. Reject empty/dot/root,
  POSIX and Windows absolute/rooted/UNC/drive-relative paths, backslashes,
  NUL/control bytes, empty/dot/dot-dot segments, noncanonical separators,
  `.git`/`.loop` including Windows trailing-dot/space aliases, duplicates,
  case-folded duplicates and overlapping specs.
- Validate `requiredExecutables` as contained relative paths under its spec.
- Resolve existing roots physically; no lexical fallback. Source path and target
  parent may have no symlinked component. Roots must be disjoint. Target and
  transaction publication must be on the same device.
- Explicit `lstat` walker. Recurse only real directories, copy only regular
  files, reject FIFO/socket/device/special entries, and reject nested control
  entries.
- For symlinks, preserve the raw target only if relative and both lexical plus
  final physical resolution remain inside the selected source tree. Reject
  dangling/cyclic/absolute/escaping links; revalidate against complete staging.
- Copy regular files from an `O_RDONLY|O_NOFOLLOW` pinned FD. On Linux,
  `/proc/self/fd/<fd>` plus `COPYFILE_EXCL|COPYFILE_FICLONE` is allowed (Node
  already falls back); otherwise stream from the open FD to an exclusive
  `O_NOFOLLOW` destination. Preserve ordinary mode/executable bits only.
- Post-copy require different BigInt `(dev, ino)` from the source and target
  `nlink === 1`. Detect common source mutation with pre/post `fstat`.
- Use a private deterministic transaction location with `staging`/`backup`.
  Reconcile crash combinations, stage completely, destination→backup then
  staging→destination, restore on failure. `lstat` broken/external leaf links
  and move/unlink the link itself without touching its target.
- Never start a child process or access the network.

## Tests

Cover the path matrix, missing/non-directory, ancestor escapes, safe executable
`.bin` link, absolute/dangling/cyclic/lexical/physical link escapes, chained
internal links, FIFO on Unix, distinct inode/nlink and two-way mutation,
hardlink-source aliases, injected mid-copy/publish failures preserving the old
destination, broken external destination link safety, crash-state recovery,
empty-plan no-write behavior, and read-only inspection.

Use deterministic injection rather than disk-full/timing tricks. Run focused
tests and typecheck if the other packets have not temporarily made the shared
tree inconsistent.

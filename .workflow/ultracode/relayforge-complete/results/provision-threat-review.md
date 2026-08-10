# Provisioning threat review

The rejected `34bd894` implementation must not be revived. Offline copying,
reflink preference and rejecting hardlinks were correct policy choices, but
recursive `cpSync` cannot enforce the required link policy, the source was not
physically contained, publication was not atomic, and failures were merely
logged before execution continued.

## Required security contract

1. Validate the complete plan with canonical portable relative paths.
2. Inspect every source entry with `lstat`; recurse only into real directories.
3. Copy regular files through pinned source descriptors into exclusive staging
   files; reject special files.
4. Preserve only relative symlinks whose lexical and physical targets remain in
   the selected source tree, then revalidate them in staging.
5. Prove copied files have distinct BigInt `(dev, ino)` identity and one target
   link; preserve ordinary permission/executable bits but not setuid/setgid,
   ownership, ACL or special-file semantics.
6. Stage under a parent-private transaction root on the target filesystem.
7. Publish with destination→backup then staging→destination renames; restore on
   ordinary failure and reconcile crash combinations before retry.
8. Turn any configured failure into a typed refusal before planner, provider,
   reviewer or verifier use.

## Path policy

Reject empty/root/dot, POSIX absolute, Windows rooted/drive/UNC and drive-relative
forms, NUL/control bytes, backslashes, noncanonical separators/components,
`.git`/`.loop` including Windows trailing-dot/space aliases, duplicates,
case-folded duplicates and overlapping specs. Apply the validator both at the
configuration boundary and inside the provisioning module.

Source/target/transaction roots must exist as physical directories and be
pairwise safe for their roles. Configured source and target paths must be
strictly below their roots with no symlinked path component. Transaction and
target publication parents must have the same device ID.

## Link policy

For every source link, retain the raw relative target only when:

- lexical resolution stays within the selected source tree;
- `realpath` succeeds and the final source target stays inside that tree;
- the staged link later resolves inside the complete staged tree.

This admits `node_modules/.bin/tsc -> ../typescript/bin/tsc` but deliberately
rejects global-store, workspace-external, dangling, absolute, escaping and
cyclic links.

## Copy and transaction mechanics

On Linux, open the source `O_RDONLY|O_NOFOLLOW`, verify it remains regular, and
copy from `/proc/self/fd/<fd>` with `COPYFILE_EXCL|COPYFILE_FICLONE`. Node's
`COPYFILE_FICLONE` already performs an ordinary-copy fallback. Where pinned-fd
copy-file is unavailable, stream from the open source FD to an exclusively
created `O_NOFOLLOW` target FD.

Crash reconciliation uses deterministic reserved staging/backup state:

- destination + staging: discard staging;
- no destination + backup: restore backup, discard staging, retry;
- destination + backup: published destination wins, clean backup;
- no destination + staging only: discard possibly partial staging, retry.

There is a brief absent-name window during replacement because Node lacks
`renameat2(RENAME_EXCHANGE)`. This is safe only while dispatch remains closed.
Multiple configured directories are not atomically published together; they are
safe only because no consumer can run until the full plan succeeds.

## API decision

Use structured specifications so doctor can verify the actual local toolchain:

```ts
type ProvisionSpec = {
  path: string;
  requiredExecutables?: readonly string[];
};
```

The core exposes one shared read-only inspection path plus a provisioning result
with stable issue codes. Only an empty plan is `disabled`; missing configured
sources are `MISSING_SOURCE`, never skipped.

## Honest limitations

Node lacks full `openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS)` and rename-exchange
semantics. Recursive enumeration and final rename are therefore not fully
race-free against a hostile same-UID process. The main defense is the private
worktree root, no agent dispatch during provisioning, pinned file descriptors,
pre/post metadata checks and post-copy validation. Stronger resistance requires
a separate UID/mount namespace or native dirfd implementation. Reflinks share
physical extents but not mutable inode identity, and power-loss durability would
require expensive file/directory fsync of the entire tree.

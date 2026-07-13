import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Global setup + teardown that removes ONLY resources THIS test suite provably owns — never a
 * resource it merely observed appearing during the run.
 *
 * The wave-8b race: the previous teardown used PREFIX-DELTA discovery — it snapshotted the matching
 * `/tmp/loop-*` dirs before the suite ran and removed every entry that APPEARED afterwards. But this
 * globalSetup helper is also imported and invoked directly by `teardown.test.ts` WHILE other Vitest
 * workers are still running. Those concurrent workers create their OWN `/tmp/loop-*` run dirs after
 * the in-test snapshot, so the delta sweep deleted live peers' state mid-run — the deterministic
 * cause of the observed orphan-settlement errors and dashboard `uv_cwd`/startup failures. A newly
 * appearing prefix is NOT ownership.
 *
 * The fix is UNFORGEABLE, EXPLICIT ownership scoped to an OWNER TOKEN. `reclaimOwned(token)` removes
 * only a `/tmp/loop-*` directory carrying a marker file whose contents are EXACTLY `token`. The real
 * suite teardown (default export) runs ONCE in the Vitest MAIN process AFTER all workers have exited,
 * using a process-wide token that workers stamp via `registerOwnedTemp()`. A test that wants to
 * exercise the reclaim logic mid-suite MUST mint its OWN unique token and reclaim only that — so it
 * can never delete a concurrent worker's live (differently-tokened, or unmarked) run dir. tmux
 * sessions are likewise only killed when explicitly registered, so the user's default tmux server is
 * never scanned or swept by prefix.
 *
 * CONTAINMENT (the leak that token-ownership alone did not close): explicit ownership only reclaims a
 * dir a test REMEMBERED to register, and almost none did — the suite calls `mkdtempSync(join(tmpdir(),
 * "loop-…"))` at ~130 sites but registered ~20. A full run therefore abandoned ~317 `/tmp/loop-*` dirs
 * on the host (20k+ had accumulated), even though this file's own contract claims the run leaves no
 * disposable temp state behind. Registering each site by hand is a rule that must be re-obeyed forever
 * and silently re-breaks on the next new test.
 *
 * So containment is STRUCTURAL, not remembered: `setup()` mints a suite-scoped root and points TMPDIR
 * at it BEFORE any worker forks. POSIX `os.tmpdir()` reads TMPDIR at CALL time, so every existing
 * `tmpdir()` call — in-worker AND in every child process the suite spawns (git, tmux, the CLI), which
 * inherit the env — lands INSIDE that root with no call-site changes. Teardown removes the root as one
 * unit. Ownership stays unforgeable: the root is named by a random token AND carries the token marker,
 * and is deleted only when the marker matches EXACTLY, so a concurrent top-level suite (which mints its
 * own token, hence its own root) can never be swept. This STRENGTHENS the wave-8b invariant — peer runs
 * are now in disjoint subtrees, so a peer's live dir is not merely unstamped, it is unreachable.
 */

const MARKER = ".loop-test-owner";
const TEMP_PREFIX = "loop-";
const ROOT_ENV = "LOOP_TEST_TMP_ROOT";
const OWNER_ENV = "LOOP_TEST_OWNER_TOKEN";

/** The env vars containment REDIRECTS. Teardown must put every one of them back EXACTLY as it found
 *  it — including deleting the ones that were ABSENT (setting them to "" or "undefined" is not the
 *  same thing: `os.tmpdir()` and spawned children read presence, not just value). */
const TEMP_ENV_KEYS = ["TMPDIR", "TMP", "TEMP", ROOT_ENV] as const;

/** A mutable environment bag. `process.env` in production; a plain object in tests, so a regression can
 *  drive the FULL setup→teardown lifecycle without mutating the live Vitest process environment. */
type EnvBag = Record<string, string | undefined>;

/**
 * The system temp base as it stood BEFORE `setup()` redirected TMPDIR at the containment root.
 *
 * `os.tmpdir()` reads TMPDIR at CALL time, so once containment is installed, `tmpdir()` no longer names
 * the system base — it names our root. A reclaim that re-derives its base from `tmpdir()` at teardown
 * therefore scans the root instead of the real system temp, and can never see a dir a test explicitly
 * stamped OUTSIDE the root (registered temps are exactly the dirs that may legitimately live there).
 * So the base is CAPTURED before redirection and used verbatim at cleanup.
 *
 * Captured at module load, which in the Vitest MAIN process happens while importing globalSetup — i.e.
 * before `setup()` runs, hence before redirection. A WORKER imports this module with TMPDIR already
 * pointing at the root, so its captured base IS the root: exactly the base a mid-suite `reclaimOwned()`
 * should scan, since every temp a worker can create is contained there.
 */
let capturedTmpBase = tmpdir();

/** The captured pre-redirect temp base `reclaimOwned()` scans by default. Exposed as a test seam. */
export function tmpBase(): string {
  return capturedTmpBase;
}

/**
 * Mint a FRESH suite owner token at global setup, IGNORING any inherited `LOOP_TEST_OWNER_TOKEN`, and
 * publish it so workers forked AFTER globalSetup inherit it. Honoring an inherited token was the
 * wave-8b2 cross-suite hazard: two concurrent TOP-LEVEL Vitest processes that inherited the SAME token
 * (e.g. from a shared parent env) would each reclaim the OTHER's token-stamped `/tmp/loop-*` run dirs
 * mid-run. No environment-provided token may ever confer delete authority — each top-level suite mints
 * its own. The overwrite here also re-establishes a clean token for every top-level run.
 */
function mintFreshSuiteToken(env: EnvBag = process.env): string {
  const tok = randomBytes(16).toString("hex");
  env[OWNER_ENV] = tok; // publish for workers forked AFTER globalSetup (they inherit THIS one)
  return tok;
}

/** Snapshot PRESENCE and VALUE of the redirected keys, returning a restore that reinstates both — an
 *  absent key is deleted again, a defined key (including `""`) gets its exact value back. */
function snapshotTempEnv(env: EnvBag): () => void {
  const before = TEMP_ENV_KEYS.map(
    (key) => [key, Object.hasOwn(env, key), env[key]] as const
  );
  return () => {
    for (const [key, present, value] of before) {
      if (present) env[key] = value as string;
      else delete env[key];
    }
  };
}

/** The token a WORKER stamps with (`registerOwnedTemp`): the fresh token the MAIN process minted at
 *  globalSetup and published before forking the pool. If somehow absent (a unit test importing this
 *  module outside globalSetup), mint a local fallback — but a top-level suite's token is ALWAYS freshly
 *  minted by `setup()`, never an inherited env value. */
function processToken(): string {
  let tok = process.env[OWNER_ENV];
  if (!tok) {
    tok = randomBytes(16).toString("hex");
    process.env[OWNER_ENV] = tok;
  }
  return tok;
}

/** Mint a FRESH, globally-unique owner token. Used by tests that invoke the reclaim logic mid-suite
 *  so their teardown can only ever affect dirs THEY stamped with this exact token. */
export function freshOwnerToken(): string {
  return `test-${randomBytes(16).toString("hex")}`;
}

/** Explicitly mark `dir` as owned by `token` (defaults to the process-wide token) so a reclaim keyed
 *  on that token may remove it. Unmarked / differently-tokened dirs — including a live peer worker's
 *  run dir — are never removed. Best-effort and total: never throws into a test. */
export function registerOwnedTemp(dir: string, token: string = processToken()): void {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, MARKER), token, { mode: 0o600 });
  } catch {
    // best-effort — a failure to mark simply means the dir is PRESERVED (fail safe), never over-deleted
  }
}

/** Whether `dir` carries EXACTLY `token` in its owner marker. Any other content, a missing marker, or
 *  a read error means it is not owned by that token → preserved. Unforgeable: the token is random. */
function ownedBy(dir: string, token: string): boolean {
  try {
    return readFileSync(join(dir, MARKER), "utf8") === token;
  } catch {
    return false;
  }
}

/** Remove every `loop-*` directory under `base` whose owner marker is EXACTLY `token`. Touches nothing
 *  else. `base` defaults to the temp base CAPTURED BEFORE containment redirected TMPDIR — NOT a fresh
 *  `tmpdir()`, which after redirection names the containment root and so hides exactly the explicitly
 *  stamped dirs a test placed outside it. */
export function reclaimOwned(token: string, base: string = capturedTmpBase): void {
  let entries: string[];
  try {
    entries = readdirSync(base).filter((e) => e.startsWith(TEMP_PREFIX));
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(base, entry);
    if (!ownedBy(full, token)) continue; // not stamped with THIS token → never touch
    try {
      rmSync(full, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

/** Session names this suite explicitly opened and may kill. Empty unless a test registers one; with
 *  LOOP_TMUX=off (tests/setup.ts) the suite opens none, so the default tmux server is never touched. */
const ownedTmuxSessions = new Set<string>();
export function registerOwnedTmux(sessionName: string): void {
  ownedTmuxSessions.add(sessionName);
}

function killOwnedTmuxSessions(): void {
  for (const name of ownedTmuxSessions) {
    spawnSync("tmux", ["kill-session", "-t", `=${name}`], { stdio: "ignore" });
  }
}

/** Test seam: perform the SAME top-level mint `setup()` does (ignore inherited token, publish fresh),
 *  returning the minted token so a regression can prove an inherited token confers no delete authority. */
export function mintTopLevelSuiteTokenForTest(): string {
  return mintFreshSuiteToken();
}

/**
 * Point TMPDIR at a fresh suite-scoped root so EVERY `tmpdir()` call in this run — including ones made
 * by spawned children, which inherit the env — is contained inside a single directory we can remove as
 * a unit. Must run in the MAIN process BEFORE the worker pool forks (workers inherit this env).
 *
 * The root is kept SHORT (`loop-suite-<12 hex>`): tests build UNIX socket paths under `tmpdir()`, and
 * those are capped at ~108 bytes by the kernel — a long root would break tmux socket tests rather than
 * merely lengthening a path.
 */
function containTempRoot(env: EnvBag, base: string, token: string): string {
  const root = join(base, `${TEMP_PREFIX}suite-${token.slice(0, 12)}`); // base = the SYSTEM tmp, captured un-redirected
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(join(root, MARKER), token, { mode: 0o600 }); // same unforgeable stamp reclaimOwned() checks
  // POSIX os.tmpdir() consults TMPDIR at call time; TMP/TEMP are set too so non-Node children agree.
  env.TMPDIR = root;
  env.TMP = root;
  env.TEMP = root;
  env[ROOT_ENV] = root; // lets a test assert containment actually took effect
  return root;
}

/** Remove the suite-scoped temp root — but ONLY when it still carries EXACTLY this suite's token, so a
 *  root minted by any other run (which has a different token) is never removed. */
function reclaimContainedRoot(root: string, token: string): void {
  if (!ownedBy(root, token)) return; // not ours → never touch
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

export interface SuiteContainment {
  /** The freshly minted, unforgeable owner token this containment stamps and reclaims by. */
  token: string;
  /** The suite-scoped temp root TMPDIR now points at. */
  root: string;
  /** Reclaim everything this containment owns and restore the redirected env EXACTLY as it was. */
  teardown: () => void;
}

/**
 * The whole setup→teardown lifecycle, against an INJECTED env bag and temp base.
 *
 * `setup()` is this function applied to the live `process.env` and the real, still-un-redirected
 * `tmpdir()`. Injecting both is the test seam: a regression can drive a full lifecycle over a scratch
 * base and a throwaway env object, proving what teardown removes/keeps and that it restores the four
 * redirected vars exactly — without mutating the live Vitest environment out from under concurrent
 * workers (which inherit TMPDIR and would start writing temps outside the contained root).
 */
export function createSuiteContainment(env: EnvBag = process.env, base: string = tmpdir()): SuiteContainment {
  const restoreTempEnv = snapshotTempEnv(env); // presence + value, BEFORE anything is redirected
  // ALWAYS mint a FRESH token, ignoring any inherited LOOP_TEST_OWNER_TOKEN, and publish it BEFORE
  // workers fork so they inherit exactly this suite's token — never a shared cross-suite one.
  const token = mintFreshSuiteToken(env);
  const root = containTempRoot(env, base, token);
  return {
    token,
    root,
    teardown: () => {
      // Runs once in the MAIN process AFTER all workers have exited — no concurrent peer can be harmed.
      reclaimOwned(token, base); // explicitly-stamped dirs (incl. any a test placed OUTSIDE the root)
      reclaimContainedRoot(root, token); // and the whole contained subtree, registered or not
      restoreTempEnv(); // put TMPDIR/TMP/TEMP/LOOP_TEST_TMP_ROOT back exactly (absent → absent again)
      killOwnedTmuxSessions();
    }
  };
}

export default function setup(): () => void {
  capturedTmpBase = tmpdir(); // capture the SYSTEM temp base while TMPDIR is still un-redirected
  return createSuiteContainment(process.env, capturedTmpBase).teardown;
}

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createSuiteContainment,
  freshOwnerToken,
  mintTopLevelSuiteTokenForTest,
  reclaimOwned,
  registerOwnedTemp
} from "./global-teardown.js";

// Proves the wave-8b fix: reclaim removes ONLY resources stamped with a SPECIFIC owner token, and
// NEVER a dir it merely observed appearing during the run. The previous prefix-delta teardown deleted
// concurrent workers' `/tmp/loop-*` run state because those dirs appeared after the snapshot — a newly
// appearing prefix is not ownership.
//
// Crucially this test uses its OWN fresh token (never the process-wide suite token), so invoking the
// reclaim mid-suite cannot touch a concurrent worker's live, differently-tokened run dir — the exact
// cross-worker deletion the original race caused.
describe("test teardown reclaims only EXACTLY-tokened resources (never a peer worker's live loop-* dir)", () => {
  const created: string[] = [];
  afterAll(() => {
    for (const d of created) rmSync(d, { recursive: true, force: true });
  });

  it("removes a fixture stamped with THIS test's token while preserving an unrelated live-run dir", () => {
    const token = freshOwnerToken(); // unique to this test — no other worker uses it

    // (a) A dir this test owns via its unique token → must be reclaimed.
    const owned = mkdtempSync(join(tmpdir(), "loop-owned-fixture-"));
    registerOwnedTemp(owned, token);
    created.push(owned);

    // (b) A dir simulating a CONCURRENT peer worker's live run — same `loop-` prefix, created AFTER
    //     ownership was established, but NOT stamped with this token → must be preserved.
    const peerLive = join(tmpdir(), `loop-peer-worker-live-${process.pid}-${process.hrtime.bigint()}`);
    mkdirSync(peerLive);
    writeFileSync(join(peerLive, "reservations.jsonl"), "{}\n"); // peer run state that must survive
    created.push(peerLive);

    reclaimOwned(token);

    expect(existsSync(owned)).toBe(false); // this test's owned fixture reclaimed
    expect(existsSync(peerLive)).toBe(true); // peer worker's live run dir preserved (not ours)
  });

  it("a loop-* dir carrying a FOREIGN owner token is never reclaimed", () => {
    const token = freshOwnerToken();
    const foreign = join(tmpdir(), `loop-foreign-owner-${process.pid}-${process.hrtime.bigint()}`);
    mkdirSync(foreign);
    registerOwnedTemp(foreign, freshOwnerToken()); // stamped with a DIFFERENT token
    created.push(foreign);
    reclaimOwned(token);
    expect(existsSync(foreign)).toBe(true); // different token → unforgeable, preserved
  });

  // The leak token-ownership alone did NOT close: reclaim only ever removed a dir a test REMEMBERED to
  // register, and ~130 mkdtemp sites registered ~20 — so a full run abandoned ~317 `/tmp/loop-*` dirs on
  // the host. Containment makes cleanup STRUCTURAL instead of remembered: TMPDIR points at a token-named
  // root, so the ordinary `mkdtempSync(join(tmpdir(), "loop-…"))` idiom lands inside a subtree teardown
  // removes wholesale. This test fails if containment is ever dropped, which is what re-opens the leak.
  it("every temp dir the suite creates is CONTAINED in the token-named root teardown deletes", () => {
    const root = process.env.LOOP_TEST_TMP_ROOT;
    expect(root, "globalSetup must publish the contained temp root before workers fork").toBeTruthy();

    // Containment is in force in THIS worker: the redirect is inherited, not re-applied per worker.
    expect(tmpdir()).toBe(root);

    // The root is stamped with the suite's owner token, so ONLY this suite's teardown may remove it —
    // a concurrent top-level suite mints a different token, hence a different root it cannot reach.
    const stamped = readFileSync(join(root!, ".loop-test-owner"), "utf8");
    expect(stamped).toBe(process.env.LOOP_TEST_OWNER_TOKEN);

    // The UNCHANGED, unregistered idiom used at ~130 call sites now lands inside the reclaimed subtree.
    const dir = mkdtempSync(join(tmpdir(), "loop-containment-probe-"));
    created.push(dir);
    expect(dirname(dir)).toBe(root);
    expect(dir.startsWith(root + sep)).toBe(true);
  });

  it("(wave-8b2) an INHERITED LOOP_TEST_OWNER_TOKEN confers NO delete authority — setup mints fresh", () => {
    // Repro: two concurrent TOP-LEVEL suites that inherited the SAME env token would delete each
    // other's token-stamped run dirs. The fix: the top-level suite mint IGNORES the inherited token and
    // mints a fresh one, so a dir stamped with the inherited token is NOT reclaimed by the fresh token.
    const inherited = `inherited-${freshOwnerToken()}`;
    const prev = process.env.LOOP_TEST_OWNER_TOKEN;
    process.env.LOOP_TEST_OWNER_TOKEN = inherited; // simulate an inherited env token

    // A peer suite B's live dir stamped with the INHERITED token.
    const peerB = join(tmpdir(), `loop-peerB-live-${process.pid}-${process.hrtime.bigint()}`);
    mkdirSync(peerB);
    registerOwnedTemp(peerB, inherited);
    writeFileSync(join(peerB, "reservations.jsonl"), "{}\n");
    created.push(peerB);

    // Suite A performs the top-level mint: it must IGNORE the inherited token and mint a fresh one.
    const fresh = mintTopLevelSuiteTokenForTest();
    expect(fresh).not.toBe(inherited);
    // Suite A's teardown (keyed on its FRESH token) must NOT delete peer B's inherited-token dir.
    reclaimOwned(fresh);
    expect(existsSync(peerB)).toBe(true); // peer B preserved — inherited token gave no authority

    // And the environment now carries the FRESH token (workers inherit A's own token, not the shared one).
    expect(process.env.LOOP_TEST_OWNER_TOKEN).toBe(fresh);
    if (prev === undefined) delete process.env.LOOP_TEST_OWNER_TOKEN;
    else process.env.LOOP_TEST_OWNER_TOKEN = prev;
  });
});

// The FULL setup→teardown lifecycle, driven over an injected env bag and a scratch temp base standing in
// for the system tmp. Injection is what makes these deterministic AND safe: mutating the live TMPDIR
// mid-suite would send concurrent workers' temps outside the contained root, and mutating the live env
// is precisely the thing under test.
describe("global setup/teardown: captured temp base + exact env restoration", () => {
  const created: string[] = [];
  afterAll(() => {
    for (const d of created) rmSync(d, { recursive: true, force: true });
  });

  /** A scratch dir playing the role of the SYSTEM temp base — i.e. the base as captured BEFORE the
   *  suite redirected TMPDIR at its containment root. */
  function scratchBase(label: string): string {
    const base = mkdtempSync(join(tmpdir(), `loop-${label}-base-`));
    created.push(base);
    return base;
  }

  it("reclaims an explicitly-owned dir OUTSIDE the root under the CAPTURED base, and the root's unregistered temps", () => {
    // The bug: teardown re-derived its scan base from `tmpdir()` AFTER setup redirected TMPDIR, so it
    // scanned the containment root instead of the system temp — and an explicitly token-stamped dir
    // outside the root (the only dirs that may legitimately live there) was never reclaimed.
    const base = scratchBase("captured");
    const env: NodeJS.ProcessEnv = {};
    const { token, root, teardown } = createSuiteContainment(env, base);

    // Containment redirected the injected env, not the live one.
    expect(env.TMPDIR).toBe(root);
    expect(process.env.LOOP_TEST_TMP_ROOT).not.toBe(root);

    // (a) Explicitly token-stamped, and OUTSIDE the containment root but under the captured base.
    const ownedOutside = join(base, "loop-owned-outside-root");
    mkdirSync(ownedOutside);
    registerOwnedTemp(ownedOutside, token);

    // (b) A foreign peer sharing the prefix and the base, unstamped → must survive untouched.
    const foreignPeer = join(base, "loop-foreign-peer");
    mkdirSync(foreignPeer);
    writeFileSync(join(foreignPeer, "reservations.jsonl"), "{}\n");

    // (c) The ordinary UNREGISTERED mkdtemp idiom, landing inside the root → removed structurally.
    const unregistered = mkdtempSync(join(root, "loop-unregistered-"));

    teardown();

    expect(existsSync(ownedOutside)).toBe(false); // scanned via the CAPTURED base, not tmpdir()
    expect(existsSync(foreignPeer)).toBe(true); // not ours → never touched
    expect(existsSync(unregistered)).toBe(false);
    expect(existsSync(root)).toBe(false); // whole contained subtree gone as one unit
  });

  it("restores TMPDIR/TMP/TEMP/LOOP_TEST_TMP_ROOT EXACTLY — absent stays absent, defined keeps its value", () => {
    const base = scratchBase("envrestore");
    // TMPDIR defined, TEMP defined-but-empty (a value, NOT absence), TMP and LOOP_TEST_TMP_ROOT ABSENT.
    const env: NodeJS.ProcessEnv = { TMPDIR: "/prior/tmpdir", TEMP: "" };
    const { root, teardown } = createSuiteContainment(env, base);

    for (const key of ["TMPDIR", "TMP", "TEMP", "LOOP_TEST_TMP_ROOT"]) expect(env[key]).toBe(root);

    teardown();

    expect(env.TMPDIR).toBe("/prior/tmpdir"); // exact prior value, not merely "some path"
    expect(env.TEMP).toBe(""); // present-but-empty is not absence
    expect(Object.hasOwn(env, "TMP")).toBe(false); // was absent → deleted, not set to "" or "undefined"
    expect(Object.hasOwn(env, "LOOP_TEST_TMP_ROOT")).toBe(false);
  });
});

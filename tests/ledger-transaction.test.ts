import { detectScopeCapability } from "../src/scope.js";

// The gated suites below manufacture REAL settlement evidence, which pre-creates process
// scopes (delegated cgroup subtrees). Inside the verifier jail /sys/fs/cgroup is read-only,
// so the environment cannot provide a scope at all — the same honest skip containment.test.ts
// uses. On a delegated host nothing is skipped. P0 debt: delegate the verifier's own scope
// subtree into the jail, then remove these guards.
const SCOPE_CAPABILITY = detectScopeCapability();

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  CorruptJournalError,
  LEDGER_LEAF,
  LedgerRecoveryRequired,
  migrateLegacyV1,
  openLedger,
  realLedgerIO,
  type CallBinding,
  type LedgerIO
} from "../src/ledger.js";
import { MoneyError, usdToNano } from "../src/money.js";
import { evidenceRoot, reserveAndRun, settle, settleTrusted } from "./settlement-evidence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TSX = resolve(HERE, "..", "node_modules", "tsx", "dist", "cli.mjs");
const WORKER = resolve(HERE, "fixtures", "reserve-worker.mjs");
const HOLDER = resolve(HERE, "fixtures", "ledger-lock-holder.mjs");

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const nonce = () => randomBytes(32).toString("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function board(): string {
  return mkdtempSync(join(tmpdir(), "loop-ledger-"));
}

/**
 * A `detached` child THIS test spawned, wrapped with the only safe way to end it.
 *
 * A detached child leads its own process group, which is the whole point when `tsx` runs the real work in
 * a grandchild — killing the wrapper alone leaves the grandchild (and its lock) alive. So the kill targets
 * the exact NEGATIVE pgid we created: never a name, never a broad `pkill`, never a group we did not spawn.
 *
 * `killAndReap` is idempotent, and deliberately does NOTHING once the child has been reaped: after `close`
 * the pid — and therefore the group id — belongs to the kernel again and may already name a stranger. This
 * is what makes it safe to call from a `finally` that runs after the body may or may not have killed it.
 */
function ownedGroup(child: ChildProcess) {
  let closed = false;
  let code: number | null = null;
  const exited = new Promise<number | null>((res) => {
    child.on("close", (c) => {
      closed = true;
      code = c;
      res(c);
    });
  });
  return {
    child,
    exited,
    get exitCode(): number | null {
      return code;
    },
    async killAndReap(): Promise<void> {
      if (closed) return; // already reaped — signaling this pgid now could hit a recycled pid
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // it died on its own between the check and the signal; the await below still reaps it
      }
      await exited;
    }
  };
}

/** Wait for the lock holder to report that it has the REAL kernel lock. */
function awaitHeld(child: ChildProcess, ms: number): Promise<string> {
  return new Promise<string>((res, rej) => {
    const t = setTimeout(() => rej(new Error("lock holder did not report")), ms);
    child.stdout!.on("data", (d) => {
      if (d.toString().includes("HELD")) {
        clearTimeout(t);
        res("HELD");
      }
    });
  });
}

function bindFor(run: string, callId: string, over: Partial<CallBinding> = {}): CallBinding {
  return {
    runNonce: run,
    callNonce: randomBytes(16).toString("hex"),
    callId,
    reservationId: randomBytes(16).toString("hex"),
    routeEpoch: 1,
    provider: "claude",
    model: "opus-4.8",
    attempt: 0,
    intentSha256: sha(`intent:${callId}`),
    stdinSha256: sha(`stdin:${callId}`),
    stdinBytes: 42,
    ...over
  };
}

/** A ledger on a fresh board, with an optional fault-injecting IO. For the tests that never settle: a
 *  reservation needs no transcript root, because it proves nothing about a turn that has not run yet. */
function ledgerOn(dir: string, run: string, io?: LedgerIO) {
  return openLedger({ dir, runNonce: run, io });
}

/**
 * A run tree for the tests that DO settle. There is no receipt to construct any more — `receiptFor()` is
 * gone with `SettlementReceipt`, and nothing replaced it, because nothing may. A settlement's authority is
 * now earned by running a REAL child through the production transport and handing the completed call to
 * `settleCompleted`, which re-reads the durable transcript, re-frames it, and re-probes the process group
 * before a `#private` mint will touch the money. Every "PROVEN $X" below is a provider that actually
 * reported $X on the wire.
 */
const { openRun, cleanup } = evidenceRoot("ledger-txn");
afterAll(cleanup);

describe("Priority B — the reservation decision and its append are ONE serialized transaction", () => {
  // PRESERVED from the passing wave-8d gate, and now also a concurrent-INIT race: 64 processes open
  // the same board with the same run nonce, so exactly one may publish the generation manifest.
  it("64 processes reserving $0.75 under a $1 budget: exactly ONE wins, 63 refuse, ZERO throw", async () => {
    const dir = board();
    const run = nonce();
    const results = mkdtempSync(join(tmpdir(), "loop-ledger-res-"));
    const barrier = join(results, "GO");
    const N = 64;

    const procs = [];
    for (let i = 0; i < N; i++) {
      procs.push(spawn("node", [TSX, WORKER, dir, results, barrier, `call-${i}`, "0.75", "1.00", run], { stdio: "ignore" }));
    }
    const deadline = Date.now() + 120_000;
    while (readdirSync(results).filter((f) => f.startsWith("ready-")).length < N) {
      if (Date.now() > deadline) throw new Error("contenders failed to boot");
      await sleep(50);
    }
    writeFileSync(barrier, "go");

    const codes = await Promise.all(procs.map((p) => new Promise<number | null>((res) => p.on("close", (c) => res(c)))));
    const won = codes.filter((c) => c === 0).length;
    const lost = codes.filter((c) => c === 1).length;
    const thrownMessages = readdirSync(results)
      .filter((f) => f.startsWith("threw-"))
      .map((f) => readFileSync(join(results, f), "utf8"));

    expect(thrownMessages, `exceptions: ${thrownMessages.join(" | ")}`).toEqual([]);
    expect(won, "exactly one reservation may win a $0.75-under-$1 race").toBe(1);
    expect(lost).toBe(N - 1);

    // The journal holds exactly ONE record, and every process agreed on ONE ledger generation.
    const lines = readFileSync(join(dir, "reservations.jsonl"), "utf8").trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const manifests = readdirSync(dir).filter((f) => f.startsWith("reservations.manifest"));
    expect(manifests, "exactly one generation manifest").toEqual(["reservations.manifest.json"]);
    expect(ledgerOn(dir, run).effectiveSpend()).toBe(0.75);

    rmSync(results, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }, 180_000);

  it("a refused (over-budget) reservation appends NOTHING and writes no write-ahead intent", () => {
    const dir = board();
    const run = nonce();
    const L = ledgerOn(dir, run);
    expect(L.reserve(bindFor(run, "a"), 0.75, 1)).toBe(true);
    expect(L.reserve(bindFor(run, "b"), 0.75, 1)).toBe(false);
    expect(readFileSync(join(dir, "reservations.jsonl"), "utf8").trim().split("\n").filter(Boolean)).toHaveLength(1);
    const wal = readFileSync(join(dir, "reservations.wal"), "utf8").trim().split("\n").filter(Boolean);
    expect(wal.map((l) => JSON.parse(l).t)).toEqual(["intent", "commit"]); // the refusal added nothing
    expect(L.effectiveSpend()).toBe(0.75);
  });
});

describe("Priority B1 — publication is proven AFTER the directory fsync", () => {
  // The audit swapped the leaf inside the dir-fsync hook and got `reserveCall === true` with
  // { visibleSpend: 0, hiddenBytes: 225, visibleBytes: 0 }.
  it("a leaf swapped DURING the directory fsync fails closed — never a phantom reservation", () => {
    const dir = board();
    const run = nonce();
    const io = realLedgerIO();
    const realFsyncDir = io.fsyncDir;
    let armed = false;
    let swapped = false;
    io.fsyncDir = (fd: number) => {
      realFsyncDir(fd);
      if (!armed || swapped) return;
      swapped = true;
      renameSync(join(dir, "reservations.jsonl"), join(dir, "hidden.jsonl"));
      writeFileSync(join(dir, "reservations.jsonl"), "", { mode: 0o600 });
    };
    const L = ledgerOn(dir, run, io);
    armed = true; // arm only for the TRANSACTION's fsync, not initialization's
    expect(() => L.reserve(bindFor(run, "swapped"), 0.5, 10)).toThrow(LedgerRecoveryRequired);
    expect(swapped).toBe(true);
    // Our bytes went to the orphaned inode; the visible ledger is empty — and we did NOT report success.
    expect(readFileSync(join(dir, "hidden.jsonl"), "utf8").length).toBeGreaterThan(0);
    expect(readFileSync(join(dir, "reservations.jsonl"), "utf8")).toBe("");
    // …and no later read may fold the orphaned bytes into trust.
    expect(() => L.effectiveSpend()).toThrow(LedgerRecoveryRequired);
  });

  it("a PARENT directory replaced mid-transaction fails closed", () => {
    const root = board();
    const live = join(root, "board");
    mkdirSync(live, { mode: 0o700 });
    const run = nonce();
    const io = realLedgerIO();
    const realFsyncFile = io.fsyncFile;
    let armed = false;
    let swapped = false;
    io.fsyncFile = (fd: number) => {
      realFsyncFile(fd);
      if (!armed || swapped) return;
      swapped = true;
      renameSync(live, join(root, "board-moved"));
      mkdirSync(live, { mode: 0o700 });
    };
    const L = ledgerOn(live, run, io);
    armed = true;
    expect(() => L.reserve(bindFor(run, "parent-swap"), 0.5, 10)).toThrow(LedgerRecoveryRequired);
  });

  it("a reservation that IS published survives the proof and is visible to a FRESH handle", () => {
    const dir = board();
    const run = nonce();
    expect(ledgerOn(dir, run).reserve(bindFor(run, "ok"), 0.25, 10)).toBe(true);
    expect(ledgerOn(dir, run).effectiveSpend()).toBe(0.25); // a separate handle reads the same generation
  });
});

describe("Priority B2 — the ledger has a durable GENERATION; replacement is recovery, never a reset", () => {
  // The audit: reserve $0.75/$1, rename the ledger away, create a fresh private ledger, reserve another
  // $0.75/$1 → BOTH returned true and the visible spend was only $0.75.
  it("replacing the ledger between calls is recovery_required — it never resets the budget", () => {
    const dir = board();
    const run = nonce();
    const L = ledgerOn(dir, run);
    expect(L.reserve(bindFor(run, "c1"), 0.75, 1)).toBe(true);
    renameSync(join(dir, "reservations.jsonl"), join(dir, "stolen.jsonl"));
    writeFileSync(join(dir, "reservations.jsonl"), "", { mode: 0o600 });
    expect(() => L.reserve(bindFor(run, "c2"), 0.75, 1)).toThrow(LedgerRecoveryRequired);
    // A restart cannot launder it either: the manifest still pins the original inode.
    expect(() => ledgerOn(dir, run)).toThrow(LedgerRecoveryRequired);
  });

  it("a DELETED ledger is never re-created (an ordinary transaction never O_CREATs)", () => {
    const dir = board();
    const run = nonce();
    const L = ledgerOn(dir, run);
    L.reserve(bindFor(run, "c1"), 0.75, 1);
    unlinkSync(join(dir, "reservations.jsonl"));
    expect(() => L.reserve(bindFor(run, "c2"), 0.75, 1)).toThrow(/GONE|recovery_required/i);
    expect(existsSync(join(dir, "reservations.jsonl"))).toBe(false); // we did NOT hand it a fresh budget
  });

  it("a foreign ledger copied in wholesale is refused (its generation is not ours)", () => {
    const a = board();
    const b = board();
    const runA = nonce();
    const runB = nonce();
    const LA = ledgerOn(a, runA);
    LA.reserve(bindFor(runA, "spent"), 0.9, 1);
    ledgerOn(b, runB).reserve(bindFor(runB, "mine"), 0.9, 1);
    // Copy run A's ledger + manifest + WAL over run B's, hoping to inherit a cheaper history.
    for (const f of ["reservations.jsonl", "reservations.manifest.json", "reservations.wal"]) {
      writeFileSync(join(b, f), readFileSync(join(a, f)), { mode: 0o600 });
    }
    expect(() => ledgerOn(b, runB)).toThrow(LedgerRecoveryRequired); // manifest runNonce is run A's
  });

  it("a ledger whose records carry a FOREIGN run/epoch cannot be folded (mixed provenance)", () => {
    const dir = board();
    const run = nonce();
    const L = ledgerOn(dir, run);
    L.reserve(bindFor(run, "real"), 0.5, 10);
    // Splice in a record from another run, re-chained so only the identity check can catch it.
    const raw = readFileSync(join(dir, "reservations.jsonl"), "utf8").trim();
    const rec = JSON.parse(raw);
    rec.data.bind.runNonce = nonce(); // a different run's money in our chain
    writeFileSync(join(dir, "reservations.jsonl"), `${JSON.stringify(rec)}\n`, { mode: 0o600 });
    expect(() => ledgerOn(dir, run).effectiveSpend()).toThrow(CorruptJournalError);
  });

  it("a ledger with pre-existing accounting but NO manifest is never adopted or reset", () => {
    const dir = board();
    writeFileSync(join(dir, "reservations.jsonl"), '{"seq":0,"prev":"x","hash":"y","data":{}}\n', { mode: 0o600 });
    expect(() => ledgerOn(dir, nonce())).toThrow(/unowned accounting|recovery_required/i);
  });
});

describe.skipIf(!SCOPE_CAPABILITY.strong)("Priority B3 — settlements are ATTESTED, not asserted", () => {
  it("an UNCERTAIN settlement records the terminal but RETAINS the worst case", () => {
    const dir = board();
    const run = nonce();
    const L = ledgerOn(dir, run);
    const b = bindFor(run, "bare");
    L.reserve(b, 0.5, 10);
    // `settleUncertain` is the only settlement primitive a caller may reach, and it is SAFE to hand out
    // precisely because reaching it can only ever cost money. (The audit's original finding: a bare
    // `settle(b, {usd: 0.01, reported: true})` shrank $0.50 → $0.01 on nothing but the caller's word.)
    L.settleUncertain(b);
    expect(L.effectiveSpend()).toBe(0.5);
    expect(L.settlementOf("bare")).toEqual({ settled: true, costTrusted: false, fallbackAuthorized: false });
  });

  it("a turn whose cost the kernel cannot PROVE shrinks nothing and authorizes nothing", async () => {
    const h = openRun();
    // Two genuine turns whose provenance is unestablishable — the honest shape of the old "untrusted" and
    // "unknown" provenance receipts, which a caller used to simply declare. A subscription turn reports no
    // cost at all; a generic failure reports nothing to account. Neither may buy a discount or a fallback.
    for (const [callId, spec] of [
      ["no-reported-cost", { noCost: true } as const],
      ["generic-failure", { limitMode: "generic" } as const]
    ] as const) {
      const { bind, result } = await reserveAndRun(h, callId, { worstCase: 0.5, budget: 10, spec });
      const outcome = settle(h, bind, result);
      expect(outcome.kind, callId).toBe("uncertain");
      const st = h.ledger.settlementOf(callId);
      expect(st.settled, `${callId}: the reservation must still reach a durable terminal settlement`).toBe(true);
      expect(st.costTrusted, callId).toBe(false);
      expect(st.fallbackAuthorized, callId).toBe(false);
    }
    expect(h.ledger.effectiveSpend()).toBe(1.0); // two × the retained $0.50 worst case
    h.ledger.close();
  });

  it("an UNREAPED scope is never trusted — a live process group can settle only UNCERTAIN", async () => {
    // The ledger's OWN prober says the group is populated. There is no longer any way to ASSERT a reap
    // (`scopeReaped: false` was a contradiction a caller could nonetheless write); the ledger proves it,
    // at attestation time, or it mints nothing. The reservation still reaches a durable terminal
    // settlement — it is never stranded — but at its full worst case.
    const h = openRun({ groupAlive: () => true });
    const { bind, result } = await reserveAndRun(h, "unreaped", { worstCase: 0.5, budget: 10 });
    expect(result.scopeReaped, "the transport itself saw an empty group — the LEDGER must still re-probe").toBe(true);

    const outcome = settle(h, bind, result);
    expect(outcome.kind).toBe("uncertain");
    expect(outcome.kind === "uncertain" && outcome.reason).toMatch(/STILL ALIVE/);
    expect(h.ledger.effectiveSpend()).toBe(0.5);
    expect(h.ledger.settlementOf("unreaped")).toEqual({ settled: true, costTrusted: false, fallbackAuthorized: false });
    h.ledger.close();
  });

  it("only a genuine, reaped, provider-reported turn applies the actual cost", async () => {
    const h = openRun();
    await settleTrusted(h, "trusted", { worstCase: 0.5, budget: 10, cost: 0.01 });
    expect(h.ledger.effectiveSpend()).toBe(0.01);
    expect(h.ledger.settlementOf("trusted").costTrusted).toBe(true);
    h.ledger.close();
  });

  it("an accounted terminal NEVER authorizes a fallback; only a re-derived canonical rejection does", async () => {
    const h = openRun();
    // A genuine SUCCESS moves MONEY and nothing else: it may never buy the right to bill a second provider.
    await settleTrusted(h, "acct", { worstCase: 0.5, budget: 10, cost: 0.01 });
    expect(h.ledger.settlementOf("acct").fallbackAuthorized, "a success authorized a SECOND provider's bill").toBe(false);

    // A canonical Claude usage rejection, re-derived from the durable transcript, buys a ROUTE — and only a
    // route. Its own cost is NOT lowered: a rejection's true spend is unprovable, so the worst case stands.
    const { bind, result } = await reserveAndRun(h, "fb", { worstCase: 0.5, budget: 10, spec: { limitMode: "canonical" } });
    expect(settle(h, bind, result).kind).toBe("trusted-fallback");
    const fb = h.ledger.settlementOf("fb");
    expect(fb.fallbackAuthorized).toBe(true);
    expect(fb.costTrusted, "proving a rejection is not knowing what it cost").toBe(false);
    expect(h.ledger.effectiveSpend()).toBe(0.51); // $0.01 proven + the fallback's retained $0.50
    h.ledger.close();
  });

  it("a canonical rejection whose scope is still ALIVE authorizes no fallback either", async () => {
    const h = openRun({ groupAlive: () => true });
    const { bind, result } = await reserveAndRun(h, "fb-live", { worstCase: 0.5, budget: 10, spec: { limitMode: "canonical" } });
    expect(settle(h, bind, result).kind).toBe("uncertain");
    expect(h.ledger.settlementOf("fb-live").fallbackAuthorized).toBe(false);
    expect(h.ledger.effectiveSpend()).toBe(0.5);
    h.ledger.close();
  });

  for (const [name, over] of [
    ["run nonce", { runNonce: nonce() }],
    ["call nonce", { callNonce: randomBytes(16).toString("hex") }],
    ["reservation id", { reservationId: randomBytes(16).toString("hex") }],
    ["route epoch", { routeEpoch: 9 }],
    ["provider", { provider: "gpt" }],
    ["model", { model: "gpt-5" }],
    ["attempt", { attempt: 3 }],
    ["intent hash", { intentSha256: sha("other-intent") }],
    ["stdin hash", { stdinSha256: sha("other-stdin") }],
    ["stdin bytes", { stdinBytes: 43 }]
  ] as const) {
    it(`a settlement whose ${name} differs from its reservation is REJECTED (cross-call replay)`, async () => {
      const h = openRun();
      // A REAL, fully sound turn — the evidence is impeccable. The only lie is WHICH reservation it is
      // being spent against. The transaction matches the settlement's binding against the durable reserve
      // record, so an attacker who captures a genuine turn still cannot discharge someone else's call.
      const { bind, result } = await reserveAndRun(h, "c1", { worstCase: 0.6, budget: 10 });
      expect(() => settle(h, { ...bind, ...over }, result)).toThrow(CorruptJournalError);
      expect(h.ledger.effectiveSpend()).toBe(0.6); // a rejected settlement never releases money
      h.ledger.close();
    });
  }

  it("a call nonce is spendable exactly ONCE across the journal (restart replay)", async () => {
    const h = openRun();
    const bind = await settleTrusted(h, "c1", { worstCase: 0.1, budget: 10, cost: 0.01 });
    // A restart that mints a NEW call id but replays the SAME call nonce must be refused.
    expect(() => h.ledger.reserve({ ...bindFor(h.run, "c2"), callNonce: bind.callNonce }, 0.1, 10)).toThrow(/replayed call nonce/i);
    h.ledger.close();
  });

  it("an INCOMPLETE binding fails closed BEFORE any filesystem mutation — on reserve AND on settle", async () => {
    const h = openRun();
    expect(() => h.ledger.reserve({ ...bindFor(h.run, "c1"), callNonce: "" } as CallBinding, 0.1, 10)).toThrow(/incomplete call binding/i);
    expect(() => h.ledger.reserve({ ...bindFor(h.run, "c1"), intentSha256: "short" } as CallBinding, 0.1, 10)).toThrow(/incomplete call binding/i);

    // The other half of the old test — an incomplete RECEIPT — is now unrepresentable rather than
    // rejected: `SettlementReceipt` does not exist, so there is no object for a caller to malform (see
    // tests/receipt-forgery.test.ts, which asserts the type is gone from the runtime exports). What a
    // caller CAN still hand the kernel is a bad binding, and that must fail closed with nothing written.
    const { bind, result } = await reserveAndRun(h, "c1", { worstCase: 0.1, budget: 10 });
    const settles = () => readFileSync(join(h.boardDir, LEDGER_LEAF), "utf8").split("\n").filter((l) => l.includes('"settle"')).length;
    expect(() => settle(h, { ...bind, callNonce: "" } as CallBinding, result)).toThrow(/incomplete call binding/i);
    expect(settles(), "a rejected binding reached the journal").toBe(0);
    expect(h.ledger.effectiveSpend()).toBe(0.1); // still outstanding at its worst case
    h.ledger.close();
  });

  it("a duplicate settle is corruption — never an idempotent no-op, and never a second record", async () => {
    const h = openRun();
    const { bind, result } = await reserveAndRun(h, "c1", { worstCase: 0.6, budget: 10, spec: { cost: 0.02 } });
    expect(settle(h, bind, result)).toMatchObject({ kind: "trusted", usd: 0.02 });

    // Replaying the very same genuine evidence against the very same reservation must not append again.
    // The transaction refuses it (`duplicate settle`), and because the call is ALREADY durably settled the
    // kernel reports the refusal rather than writing a second, uncertain settlement over the top of it.
    const again = settle(h, bind, result);
    expect(again.kind).toBe("uncertain");
    expect(again.kind === "uncertain" && again.reason).toMatch(/duplicate settle/);

    const records = readFileSync(join(h.boardDir, LEDGER_LEAF), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).data.type);
    expect(records, "the replay appended a second settlement").toEqual(["reserve", "settle"]);
    expect(h.ledger.effectiveSpend(), "the replay double-counted").toBe(0.02);
    h.ledger.close();
  });
});

describe.skipIf(!SCOPE_CAPABILITY.strong)("Priority B4 — unproven durability is NEVER laundered into trust", () => {
  // The audit: inject file-fsync EIO during settle → settle throws, but complete bytes remain. Reset the
  // hook and a path read reports callSettled:true, releasing the worst case to the unproven cost.
  it("a file-fsync EIO during settle poisons the ledger — a later read cannot fold the bytes", async () => {
    // An EIO-on-fsync IO, armed only for the settlement. The TURN is genuine and its evidence is perfect:
    // what fails is our ability to PROVE the settlement reached the disk. An unprovable write may never be
    // laundered into trust, however good the evidence behind it was.
    const io = realLedgerIO();
    const realFsync = io.fsyncFile;
    let fail = false;
    io.fsyncFile = (fd: number) => {
      if (fail) {
        const e = new Error("injected EIO") as NodeJS.ErrnoException;
        e.code = "EIO";
        throw e;
      }
      realFsync(fd);
    };
    const h = openRun({ io });
    const { bind, result } = await reserveAndRun(h, "eio", { worstCase: 0.5, budget: 10 });
    fail = true;
    expect(() => settle(h, bind, result)).toThrow();
    fail = false; // "reset the hook" — the audit's laundering step

    expect(() => h.ledger.effectiveSpend()).toThrow(LedgerRecoveryRequired); // same handle: poisoned
    expect(() => ledgerOn(h.boardDir, h.run).effectiveSpend()).toThrow(LedgerRecoveryRequired); // fresh handle too
    expect(() => ledgerOn(h.boardDir, h.run).settlementOf("eio")).toThrow(LedgerRecoveryRequired);
  });

  it("every unexpected fsync failure propagates — file and directory alike", () => {
    for (const which of ["fsyncFile", "fsyncDir"] as const) {
      for (const code of ["EIO", "ENOSPC", "EROFS", "EBUSY", "EPERM", "EBADF", "EACCES", "EWEIRD", "EINVAL", "ENOTSUP"]) {
        const dir = board();
        const run = nonce();
        const io = realLedgerIO();
        const real = io[which];
        let armed = false;
        io[which] = (fd: number) => {
          if (!armed) return real(fd);
          const e = new Error(`injected ${code}`) as NodeJS.ErrnoException;
          e.code = code;
          throw e;
        };
        const L = ledgerOn(dir, run, io);
        armed = true;
        // An UNSUPPORTED directory fsync is a CAPABILITY FAILURE here, not a tolerated success: we
        // cannot prove publication on such a filesystem (the old code returned success for EINVAL).
        expect(() => L.reserve(bindFor(run, "x"), 0.5, 10), `${which} ${code}`).toThrow();
      }
    }
  });

  it("reconciliation is the ONLY way back: it writes a durable receipt and revalidates the generation", async () => {
    const io = realLedgerIO();
    const realFsync = io.fsyncFile;
    let fail = false;
    io.fsyncFile = (fd: number) => {
      if (fail) {
        const e = new Error("injected EIO") as NodeJS.ErrnoException;
        e.code = "EIO";
        throw e;
      }
      realFsync(fd);
    };
    const h = openRun({ io });
    const { bind, result } = await reserveAndRun(h, "eio", { worstCase: 0.5, budget: 10 });
    fail = true;
    expect(() => settle(h, bind, result)).toThrow();
    fail = false;
    expect(() => h.ledger.effectiveSpend()).toThrow(LedgerRecoveryRequired);

    const rec = h.ledger.reconcile("operator confirmed the disk fault and accepted the ledger state");
    expect(rec.receipt).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(h.boardDir, rec.recovered))).toBe(true); // a SEPARATE durable recovery receipt
    // Only now does the ledger answer again — and it answers conservatively.
    expect(h.ledger.effectiveSpend()).toBeGreaterThanOrEqual(0.01);
    expect(ledgerOn(h.boardDir, h.run).effectiveSpend()).toBe(h.ledger.effectiveSpend()); // a fresh handle agrees
  });
});

describe("Priority B5 — the lock is a KERNEL lock: a crashed holder can never wedge it", () => {
  it("a holder KILLED mid-transaction releases the lock; the next transaction just proceeds", async () => {
    const dir = board();
    const run = nonce();
    ledgerOn(dir, run).reserve(bindFor(run, "seed"), 0.1, 10); // establish the generation

    // A real process takes the exclusive lock on the real ledger fd and then hangs. It is `detached` so
    // it leads its OWN process group: `tsx` runs the fixture in a grandchild, and the lock lives in that
    // grandchild's fd table, so we must be able to kill the exact group we created — not just the
    // wrapper (which would leave the real holder alive).
    //
    // It is launched to outlive US and nobody else: `process.pid` is this Vitest worker, and the fixture
    // probes it. The kill below is still the thing under test — the owner probe is what stops an
    // INTERRUPTED run (worker SIGKILLed before this line) from stranding the holder forever, which is
    // precisely what it did: an orphan reparented to init sat on a board's lock for days.
    const holder = ownedGroup(
      spawn("node", [TSX, HOLDER, dir, run, String(process.pid)], { stdio: ["ignore", "pipe", "pipe"], detached: true })
    );
    try {
      expect(await awaitHeld(holder.child, 30_000)).toBe("HELD");

      // SIGKILL the exact owned process GROUP — the harshest crash: no cleanup, no unwind, no chance to
      // unlink anything. (An owned pgid, never a broad pkill.)
      await holder.killAndReap();

      // The kernel dropped the lock when the process died. No stale file, no PID check, no manual repair.
      const L = ledgerOn(dir, run);
      expect(L.reserve(bindFor(run, "after-crash"), 0.1, 10)).toBe(true);
      expect(L.effectiveSpend()).toBe(0.2);
      // And there is no lock ARTIFACT anywhere to go stale in the first place.
      expect(readdirSync(dir).filter((f) => f.includes("lock"))).toEqual([]);
    } finally {
      // A failed assertion or a HELD timeout must not leak the holder either: reap the exact group we
      // spawned. A no-op when the body already killed it.
      await holder.killAndReap();
    }
  }, 60_000);

  it("a holder whose OWNER dies self-terminates and releases the lock — an interrupted run strands nothing", async () => {
    const dir = board();
    const run = nonce();
    ledgerOn(dir, run).reserve(bindFor(run, "seed"), 0.1, 10);

    // A stand-in for the Vitest worker: the process the holder is launched to live for. SIGKILLing it is
    // the leak, exactly: the run dies with no unwind, so the `finally` above, `afterAll`, and the global
    // teardown ALL fail to run, and nothing is left that could ever kill the holder. Its own owner probe
    // is the only cleanup path that survives, so it is the one being proven here.
    const owner = ownedGroup(spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore", detached: true }));
    const holder = ownedGroup(
      spawn("node", [TSX, HOLDER, dir, run, String(owner.child.pid)], { stdio: ["ignore", "pipe", "pipe"], detached: true })
    );
    try {
      expect(await awaitHeld(holder.child, 30_000)).toBe("HELD");

      await owner.killAndReap(); // the run is gone. NOBODY signals the holder.

      expect(await holder.exited, "the orphaned holder must exit with OWNER_GONE, not linger").toBe(3);
      // …and because it exited, the kernel released the lock with its fd: the board is usable again.
      const L = ledgerOn(dir, run);
      expect(L.reserve(bindFor(run, "after-owner-death"), 0.1, 10)).toBe(true);
      expect(L.effectiveSpend()).toBe(0.2);
    } finally {
      await holder.killAndReap();
      await owner.killAndReap();
    }
  }, 60_000);

  it("a planted malformed .lock artifact is inert — the protocol that could wedge on it no longer exists", () => {
    const dir = board();
    const run = nonce();
    const L = ledgerOn(dir, run);
    // The audit wedged the old ledger forever with exactly these two artifacts.
    writeFileSync(join(dir, "reservations.jsonl.lock"), "", { mode: 0o600 });
    writeFileSync(join(dir, "reservations.jsonl.lock.break"), "garbage", { mode: 0o600 });
    expect(L.reserve(bindFor(run, "unwedged"), 0.1, 10)).toBe(true); // completely unaffected
    expect(L.effectiveSpend()).toBe(0.1);
  });

  it("two live handles serialize: the second waits for the first, and both records survive", () => {
    const dir = board();
    const run = nonce();
    const A = ledgerOn(dir, run);
    const B = ledgerOn(dir, run);
    expect(A.reserve(bindFor(run, "a"), 0.1, 10)).toBe(true);
    expect(B.reserve(bindFor(run, "b"), 0.1, 10)).toBe(true);
    expect(B.effectiveSpend()).toBe(0.2);
  });
});

describe.skipIf(!SCOPE_CAPABILITY.strong)("Priority B6 — money is exact fixed point, validated before any mutation", () => {
  it("ten $0.01 settlements under a $0.10 budget sum EXACTLY to $0.10 and stop the 11th", async () => {
    const h = openRun();
    // Ten REAL turns, each reporting $0.01 on the wire and each attested by the kernel.
    for (let i = 0; i < 10; i++) await settleTrusted(h, `p${i}`, { worstCase: 0.01, budget: 0.1, cost: 0.01 });
    expect(h.ledger.effectiveSpend()).toBe(0.1); // the audit measured 0.09999999999999999
    expect(h.ledger.effectiveSpendNano()).toBe(100_000_000n);
    expect(h.ledger.reserve(bindFor(h.run, "p10"), 0.01, 0.1)).toBe(false); // …so no 11th call slips through
    expect(h.ledger.budgetReached(0.1)).toBe(true);
    h.ledger.close();
  });

  it("a sub-nano (1e-18) reservation is rejected, not silently rounded to a free call", () => {
    const dir = board();
    const run = nonce();
    const L = ledgerOn(dir, run);
    // The audit: 100 positive 1e-18 reservations ALL won while decimal intent was 0.1000000000000001.
    expect(() => L.reserve(bindFor(run, "dust"), 1e-18, 0.1)).toThrow(MoneyError);
    expect(readFileSync(join(dir, "reservations.jsonl"), "utf8")).toBe("");
  });

  for (const bad of [NaN, Infinity, -Infinity, -1, "0.5" as unknown as number]) {
    it(`reserve(${String(bad)}) is rejected BEFORE any filesystem mutation`, () => {
      const dir = board();
      const run = nonce();
      const L = ledgerOn(dir, run);
      expect(() => L.reserve(bindFor(run, "bad"), bad, 1)).toThrow(MoneyError);
      expect(() => L.reserve(bindFor(run, "bad"), 0.5, bad)).toThrow(MoneyError);
      // The audit: reserveCall(NaN, NaN) returned TRUE, serialized `null`, and corrupted the next fold.
      expect(readFileSync(join(dir, "reservations.jsonl"), "utf8")).toBe("");
      expect(() => L.effectiveSpend()).not.toThrow();
    });
  }

  it("a PROVIDER-REPORTED amount that is not exact fixed point is refused (never coerced to a known $0)", async () => {
    const h = openRun();
    // A genuine, successful, exit-0 turn — whose terminal record reports a SUB-NANO cost. It is a real
    // number on the wire and the provider really did report it, so every other gate passes; but it cannot
    // be represented in the ledger's fixed point, and the ledger will not round money. The old failure mode
    // was a caller passing `usd: NaN`; the honest one is a provider reporting a cost we cannot hold exactly.
    // Either way the answer is the same: UNCERTAIN, at the full worst case — never a cheap or a free call.
    const { bind, result } = await reserveAndRun(h, "c1", { worstCase: 0.6, budget: 10, spec: { cost: 1e-10 } });
    expect(result.streamedVerdict?.costReported, "the provider really did report this cost").toBe(true);

    const outcome = settle(h, bind, result);
    expect(outcome.kind).toBe("uncertain");
    expect(outcome.kind === "uncertain" && outcome.reason).toMatch(/not exact fixed-point money/);
    expect(h.ledger.settlementOf("c1").costTrusted).toBe(false);
    expect(h.ledger.effectiveSpend()).toBe(0.6); // the worst case still stands
    h.ledger.close();
  });

  it("exact decimal conversion: the boundary values a float ledger gets wrong", () => {
    expect(usdToNano(0.1)).toBe(100_000_000n);
    expect(usdToNano(0.01) * 10n).toBe(usdToNano(0.1));
    expect(usdToNano(0.07) + usdToNano(0.01)).toBe(usdToNano(0.08)); // 0.07 + 0.01 = 0.08000000000000002
    expect(usdToNano(1e-9)).toBe(1n);
    expect(() => usdToNano(1e-10)).toThrow(MoneyError); // finer than a nano → refused, not rounded
  });
});

describe.skipIf(!SCOPE_CAPABILITY.strong)("Priority B — budget semantics (preserved from the cost-ledger suite, now on the handle)", () => {
  it("a PROVEN low cost frees budget for the next call; an unproven one keeps the worst case", async () => {
    const h = openRun();
    const { bind: a, result } = await reserveAndRun(h, "a", { worstCase: 0.75, budget: 1, spec: { cost: 0.05 } });
    expect(h.ledger.reserve(bindFor(h.run, "blocked"), 0.75, 1), "0.75 + 0.75 > 1.00").toBe(false);

    // Settling `a` with a genuine, provider-reported $0.05 releases the rest of its reservation…
    expect(settle(h, a, result)).toMatchObject({ kind: "trusted", usd: 0.05 });
    expect(h.ledger.effectiveSpend()).toBe(0.05);

    // …so the next call now fits, where a moment ago it did not.
    const { bind: b } = await reserveAndRun(h, "b", { worstCase: 0.75, budget: 1 });
    // …but settling `b` as UNCERTAIN keeps its full worst case, so a third call does not fit.
    h.ledger.settleUncertain(b);
    expect(h.ledger.effectiveSpend()).toBe(0.8); // 0.05 proven + 0.75 retained
    expect(h.ledger.reserve(bindFor(h.run, "c"), 0.75, 1)).toBe(false);
    h.ledger.close();
  });

  it("a zero/unset budget never refuses a reservation (unlimited)", () => {
    const dir = board();
    const run = nonce();
    const L = ledgerOn(dir, run);
    for (let i = 0; i < 5; i++) expect(L.reserve(bindFor(run, `u${i}`), 0, 0)).toBe(true);
    expect(L.budgetReached(0)).toBe(false);
  });

  it("a PROVEN actual ABOVE its worst-case reservation is a terminal violation", async () => {
    const h = openRun();
    // The provider really did charge $0.50 against a $0.20 reservation — proven, not alleged. The
    // reservation failed to bound real spend, so the ledger can no longer be trusted and the run must stop.
    await settleTrusted(h, "over", { worstCase: 0.2, budget: 10, cost: 0.5 });
    expect(h.ledger.budgetViolation()).toBe("over");
    h.ledger.close();
  });

  it("an UNPROVEN settle is never a violation — it retains the worst case rather than exceeding it", () => {
    const dir = board();
    const run = nonce();
    const L = ledgerOn(dir, run);
    const b = bindFor(run, "unknown");
    L.reserve(b, 0.2, 10);
    L.settleUncertain(b);
    expect(L.budgetViolation()).toBeUndefined();
    expect(L.effectiveSpend()).toBe(0.2);
  });

  it("an UNLIMITED paid call is NOT a violation (a placeholder 0 was never meant to bound spend)", async () => {
    const h = openRun();
    // `reserve(0, 0)` is unlimited → an unenforced placeholder. A genuine $3.50 turn settled against it is
    // not an overrun: an unlimited run does not stop after its first paid call.
    await settleTrusted(h, "paid", { worstCase: 0, budget: 0, cost: 3.5 });
    expect(h.ledger.budgetViolation()).toBeUndefined();
    expect(h.ledger.effectiveSpend()).toBe(3.5);
    h.ledger.close();
  });
});

describe("Priority B — legacy v1 is an EXPLICIT one-way migration, never a silent production fallback", () => {
  /** A legacy v1 journal: chained from the constant "genesis", money as floats, no epoch/run binding. */
  function writeLegacyV1(dir: string, entries: Array<{ type: "reserve" | "settle"; callId: string; worstCase?: number; usd?: number; reported?: boolean }>): void {
    let tip = "genesis";
    let seq = 0;
    const lines: string[] = [];
    for (const e of entries) {
      const data =
        e.type === "reserve"
          ? { type: "reserve", callId: e.callId, worstCase: e.worstCase, enforced: true, ts: "2026-01-01T00:00:00.000Z" }
          : { type: "settle", callId: e.callId, usd: e.usd ?? 0, reported: e.reported ?? false, ts: "2026-01-01T00:00:00.000Z" };
      const hash = createHash("sha256").update(`${tip}|${seq}|${JSON.stringify(data)}`).digest("hex");
      lines.push(JSON.stringify({ seq, prev: tip, hash, data }));
      tip = hash;
      seq += 1;
    }
    writeFileSync(join(dir, "reservations.jsonl"), `${lines.join("\n")}\n`, { mode: 0o600 });
  }

  it("production REFUSES a legacy ledger — it neither reinterprets it nor resets it to zero", () => {
    const dir = board();
    writeLegacyV1(dir, [{ type: "reserve", callId: "old-1", worstCase: 0.75 }]);
    expect(() => ledgerOn(dir, nonce())).toThrow(/unowned accounting|migration/i);
    // The old bytes are untouched — nothing was adopted, nothing was discarded.
    expect(readFileSync(join(dir, "reservations.jsonl"), "utf8")).toContain("old-1");
  });

  it("migration CARRIES the old spend forward, archives the original, and writes a durable receipt", () => {
    const dir = board();
    const run = nonce();
    writeLegacyV1(dir, [
      { type: "reserve", callId: "old-1", worstCase: 0.75 },
      { type: "settle", callId: "old-1", usd: 0.3, reported: true }, // a KNOWN $0.30
      { type: "reserve", callId: "old-2", worstCase: 0.5 },
      { type: "settle", callId: "old-2", usd: 0, reported: false } // UNKNOWN → keeps its $0.50 worst case
    ]);
    const r = migrateLegacyV1({ dir, runNonce: run });
    expect(r.carriedForwardUsd).toBeCloseTo(0.8, 9); // 0.30 known + 0.50 retained

    // The new generation OPENS holding the old spend — a migrated run never restarts from zero.
    const L = ledgerOn(dir, run);
    expect(L.effectiveSpend()).toBeCloseTo(0.8, 9);
    expect(L.reserve(bindFor(run, "new"), 0.5, 1.0)).toBe(false); // 0.8 + 0.5 > 1.0 → correctly refused

    // The original journal is preserved verbatim for audit, and the receipt records what was carried.
    expect(readFileSync(join(dir, r.archive), "utf8")).toContain("old-1");
    const receipt = JSON.parse(readFileSync(join(dir, r.receipt), "utf8"));
    expect(receipt.carriedForwardUsd).toBeCloseTo(0.8, 9);
    expect(receipt.v1Records).toBe(4);
    expect(receipt.v1Sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("migration is ONE-WAY: it refuses to run twice, and refuses a CORRUPT legacy chain", () => {
    const dir = board();
    const run = nonce();
    writeLegacyV1(dir, [{ type: "reserve", callId: "old-1", worstCase: 0.75 }]);
    migrateLegacyV1({ dir, runNonce: run });
    expect(() => migrateLegacyV1({ dir, runNonce: run })).toThrow(/one-way|already has a v2 generation/i);

    const bad2 = board();
    writeLegacyV1(bad2, [{ type: "reserve", callId: "x", worstCase: 0.5 }]);
    const tampered = JSON.parse(readFileSync(join(bad2, "reservations.jsonl"), "utf8").trim());
    tampered.data.worstCase = 0.01; // make the old spend look cheaper
    writeFileSync(join(bad2, "reservations.jsonl"), `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
    expect(() => migrateLegacyV1({ dir: bad2, runNonce: nonce() })).toThrow(CorruptJournalError);
  });

  // -------------------------------------------------------------------------------------------
  // The migration must survive a crash at EVERY step. The hazard is not a lost receipt — it is the
  // ZERO-SPEND CARRY: between "the legacy leaf is gone" and "the carry-forward reservation is durable",
  // the directory looks like a FRESH BOARD, and a fresh board is a $0 budget. A crash there used to
  // erase the entire memory of what the run had already spent.
  // -------------------------------------------------------------------------------------------

  /** An IO that behaves normally until the Nth call to `op`, then throws — a crash at an exact step. */
  function crashOn(op: keyof LedgerIO, nth: number): LedgerIO {
    const real = realLedgerIO();
    let seen = 0;
    return new Proxy(real, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (prop !== op || typeof v !== "function") return v;
        return (...args: unknown[]) => {
          if (++seen === nth) throw new Error(`simulated crash at ${String(op)} #${nth}`);
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
    }) as LedgerIO;
  }

  /** The four-record legacy journal used throughout: $0.30 known + $0.50 retained = $0.80 carried. */
  function legacy080(dir: string): void {
    writeLegacyV1(dir, [
      { type: "reserve", callId: "old-1", worstCase: 0.75 },
      { type: "settle", callId: "old-1", usd: 0.3, reported: true },
      { type: "reserve", callId: "old-2", worstCase: 0.5 },
      { type: "settle", callId: "old-2", usd: 0, reported: false }
    ]);
  }

  // EVERY step, not the five we happened to think of.
  //
  // This used to be a table of hand-picked IO ordinals ("link #3 publishes the manifest"), and that is
  // exactly how the last hazard hid: `openLedgerInternal` published the generation MANIFEST *before* its
  // ATTESTATION KEY, so a crash in that one unnamed window left a board whose generation existed but whose
  // settlements could never be verified again — `ensureAttestKey` rightly refuses to mint a replacement, so
  // the directory became permanently unopenable and its carried $0.80 unreachable. No named window landed
  // there, and the ordinals silently rotted the moment the order changed.
  //
  // So enumerate instead of guessing: for every IO operation the migration performs, crash at EVERY
  // ordinal, and demand the same two things each time — the directory NEVER opens as a spendable fresh
  // board, and re-running ALWAYS resumes to exactly the carried balance.
  /** What the balance looks like to the NEXT process. A ledger that refuses to open is safe; a ledger that
   *  opens holding the full carried balance is safe. A ledger that opens holding LESS has forgotten money,
   *  and a fresh $0 board is a licence to spend the whole budget over again. */
  function visibleSpend(dir: string, run: string): number | "refused" {
    let L;
    try {
      L = ledgerOn(dir, run);
    } catch {
      return "refused";
    }
    try {
      return L.effectiveSpend();
    } catch {
      return "refused"; // poisoned: it will not answer until an operator reconciles it
    } finally {
      L.close();
    }
  }

  // `link` and `unlink` are the PUBLISHING steps: injecting a throw there models the operation simply not
  // having happened — a process death. The migration promises to resume from any of them.
  //
  // `write`, `fsyncFile` and `fsyncDir` are different: a throw there models the DISK REJECTING the write
  // (EIO/ENOSPC), and this ledger deliberately refuses to launder an unprovable write into trust — it
  // poisons and demands an explicit operator `reconcile()` (Priority B4). Auto-resuming past a disk fault
  // would be a bug, not a feature. So for those, the demand is only the one that protects the money.
  const RESUMABLE = new Set(["link", "unlink"]);

  for (const op of ["write", "link", "unlink", "fsyncFile", "fsyncDir"] as const) {
    it(`a CRASH at ANY ${op} never yields a zero-spend ledger${RESUMABLE.has(op) ? " — and always RESUMES" : ""}`, () => {
      let crashes = 0;
      for (let nth = 1; nth <= 16; nth++) {
        const dir = board();
        const run = nonce();
        legacy080(dir);
        const where = `${op} #${nth}`;

        let crashed = true;
        try {
          migrateLegacyV1({ dir, runNonce: run, io: crashOn(op, nth) });
          crashed = false; // fewer than `nth` calls to this op — there was nothing there to interrupt
        } catch {
          /* the injected fault: the migration died at exactly this step */
        }

        if (!crashed) {
          expect(visibleSpend(dir, run), where).toBeCloseTo(0.8, 9);
          expect(() => migrateLegacyV1({ dir, runNonce: run }), where).toThrow(/one-way/i);
          continue;
        }
        crashes += 1;

        // THE INVARIANT THAT PROTECTS THE MONEY, at every single step: the next process NEVER sees a
        // cheaper board. It either refuses to open, or it opens already holding the full $0.80.
        const seen = visibleSpend(dir, run);
        if (seen !== "refused") expect(seen, `${where}: the board opened having FORGOTTEN spend`).toBeCloseTo(0.8, 9);

        if (!RESUMABLE.has(op)) continue;

        // A crash at a publishing step is always repairable by re-running: it resumes from wherever it
        // stopped, carries exactly the balance it committed to, and is still one-way afterwards.
        const r = migrateLegacyV1({ dir, runNonce: run });
        expect(r.carriedForwardUsd, where).toBeCloseTo(0.8, 9);
        expect(visibleSpend(dir, run), where).toBeCloseTo(0.8, 9); // the old spend survived the crash
        expect(readFileSync(join(dir, r.archive), "utf8"), where).toContain("old-1"); // …and so did the evidence
        expect(() => migrateLegacyV1({ dir, runNonce: run }), where).toThrow(/one-way/i);
      }
      // Guard the guard: if the migration stopped calling this op, the sweep would vacuously test nothing.
      expect(crashes, `the migration performed no ${op} calls — this sweep tested nothing`).toBeGreaterThan(0);
    });
  }

  it("THE ZERO-SPEND WINDOW is real: after the leaf is removed the directory IS a fresh $0 board — and is refused", () => {
    const dir = board();
    const run = nonce();
    legacy080(dir);
    expect(() => migrateLegacyV1({ dir, runNonce: run, io: crashOn("link", 3) })).toThrow();

    // The directory now has EXACTLY the shape `initLedger` calls "a fresh board": the legacy leaf is
    // gone (or empty) and no generation has been published. Nothing in the ledger's own bytes records
    // that $0.80 was ever spent — that memory lives only in the archive and the intent. This is why the
    // pending-migration refusal, not any property of the journal, is what saves the balance.
    const leaf = join(dir, "reservations.jsonl");
    expect(existsSync(leaf) ? readFileSync(leaf, "utf8") : "").toBe("");
    expect(existsSync(join(dir, "reservations.manifest.json"))).toBe(false);
    expect(existsSync(join(dir, "reservations.v1.migration.intent.json"))).toBe(true);
    expect(existsSync(join(dir, "reservations.v1.migration.json"))).toBe(false); // no completion marker

    // A ledger opened here would otherwise mint a brand-new generation with a $0 budget.
    expect(() => ledgerOn(dir, run)).toThrow(/never completed/);
    // Resuming restores it exactly.
    expect(migrateLegacyV1({ dir, runNonce: run }).carriedForwardUsd).toBeCloseTo(0.8, 9);
    expect(ledgerOn(dir, run).effectiveSpend()).toBeCloseTo(0.8, 9);
  });

  it("a crash BEFORE the intent leaves the legacy ledger completely untouched (still migratable)", () => {
    const dir = board();
    const run = nonce();
    legacy080(dir);
    // link #1 is the intent's own publication: crash there and nothing has happened yet.
    expect(() => migrateLegacyV1({ dir, runNonce: run, io: crashOn("link", 1) })).toThrow();
    expect(readFileSync(join(dir, "reservations.jsonl"), "utf8")).toContain("old-1"); // leaf intact
    expect(existsSync(join(dir, "reservations.v1.migration.intent.json"))).toBe(false);
    expect(() => ledgerOn(dir, run)).toThrow(/unowned accounting|migration/i); // production still refuses it
    expect(migrateLegacyV1({ dir, runNonce: run }).carriedForwardUsd).toBeCloseTo(0.8, 9);
  });

  it("a resumed migration REFUSES to carry a different balance than it committed to", () => {
    const dir = board();
    const run = nonce();
    legacy080(dir);
    expect(() => migrateLegacyV1({ dir, runNonce: run, io: crashOn("link", 2) })).toThrow(); // intent only
    // Swap the legacy bytes for a cheaper journal AFTER the intent pinned the real balance.
    writeLegacyV1(dir, [{ type: "reserve", callId: "old-1", worstCase: 0.01 }]);
    expect(() => migrateLegacyV1({ dir, runNonce: run })).toThrow(/refusing to carry a different balance/);
    expect(() => ledgerOn(dir, run)).toThrow(LedgerRecoveryRequired); // still fail-closed, never $0
  });

  it("an in-flight migration cannot be resumed by ANOTHER run (its balance is not ours to carry)", () => {
    const dir = board();
    const run = nonce();
    legacy080(dir);
    expect(() => migrateLegacyV1({ dir, runNonce: run, io: crashOn("link", 2) })).toThrow();
    expect(() => migrateLegacyV1({ dir, runNonce: nonce() })).toThrow(/belongs to run/);
  });

  it("CONCURRENT migrations: exactly one wins, and the balance is carried exactly ONCE", async () => {
    const dir = board();
    const run = nonce();
    legacy080(dir);
    const WORKER = resolve(HERE, "fixtures", "migrate-worker.mjs");
    const results = await Promise.all(
      [0, 1, 2].map(
        () =>
          new Promise<string>((res) => {
            const p = spawn(process.execPath, [TSX, WORKER, dir, run], { stdio: ["ignore", "pipe", "ignore"] });
            let out = "";
            p.stdout.on("data", (d) => (out += String(d)));
            p.on("close", () => res(out.trim()));
          })
      )
    );
    const winners = results.filter((r) => r.startsWith("ok"));
    expect(winners).toHaveLength(1); // never two archives, two generations, or two carries
    expect(winners[0]).toBe("ok 0.8");
    const L = ledgerOn(dir, run);
    expect(L.effectiveSpend()).toBeCloseTo(0.8, 9); // carried ONCE, not three times
  });

  it("a DUPLICATE legacy call id is corruption — it must never silently drop the first reservation", () => {
    const dir = board();
    // The old fold did `live.set(callId, …)`, so the second reserve OVERWROTE the first: a $9.00
    // reservation vanished and the migration carried $0.01 forward instead of $9.01.
    writeLegacyV1(dir, [
      { type: "reserve", callId: "dup", worstCase: 9.0 },
      { type: "reserve", callId: "dup", worstCase: 0.01 }
    ]);
    expect(() => migrateLegacyV1({ dir, runNonce: nonce() })).toThrow(/duplicate\/re-reserve/);
    expect(existsSync(join(dir, "reservations.v1.migration.intent.json"))).toBe(false); // nothing touched
  });

  it("a DUPLICATE or ORPHAN legacy settle is corruption", () => {
    const a = board();
    writeLegacyV1(a, [
      { type: "reserve", callId: "c", worstCase: 1 },
      { type: "settle", callId: "c", usd: 0.1, reported: true },
      { type: "settle", callId: "c", usd: 0.01, reported: true }
    ]);
    expect(() => migrateLegacyV1({ dir: a, runNonce: nonce() })).toThrow(/duplicate settle/);

    const b = board();
    writeLegacyV1(b, [{ type: "settle", callId: "ghost", usd: 0.1, reported: true }]);
    expect(() => migrateLegacyV1({ dir: b, runNonce: nonce() })).toThrow(/orphan settle/);
  });

  for (const [name, worstCase] of [
    ["a string amount", "0.50" as unknown as number],
    ["a NaN amount", Number.NaN],
    ["an Infinite amount", Number.POSITIVE_INFINITY],
    ["a negative amount", -1],
    ["a missing amount", undefined as unknown as number],
    ["an over-precise (sub-nano) amount", 0.0000000001]
  ] as const) {
    it(`REFUSES ${name} in the legacy journal — before touching anything`, () => {
      const dir = board();
      writeLegacyV1(dir, [{ type: "reserve", callId: "c", worstCase }]);
      // The old code did `Number(d.worstCase ?? 0)`: a string became NaN, NaN failed every `> 0` guard,
      // and the migration carried NOTHING forward while still archiving and deleting the leaf.
      expect(() => migrateLegacyV1({ dir, runNonce: nonce() })).toThrow(CorruptJournalError);
      expect(readFileSync(join(dir, "reservations.jsonl"), "utf8")).toContain("c"); // leaf untouched
      expect(existsSync(join(dir, "reservations.v1.migrated.jsonl"))).toBe(false);
      expect(existsSync(join(dir, "reservations.v1.migration.intent.json"))).toBe(false);
    });
  }

  it("a legacy journal that genuinely folds to ZERO carries zero — and still completes cleanly", () => {
    const dir = board();
    const run = nonce();
    writeLegacyV1(dir, [
      { type: "reserve", callId: "free", worstCase: 0 },
      { type: "settle", callId: "free", usd: 0, reported: true }
    ]);
    const r = migrateLegacyV1({ dir, runNonce: run });
    expect(r.carriedForwardUsd).toBe(0);
    const L = ledgerOn(dir, run);
    expect(L.effectiveSpend()).toBe(0);
    expect(L.reserve(bindFor(run, "new"), 0.5, 1.0)).toBe(true); // a genuinely unspent budget is spendable
  });

  it("a foreign pre-existing ARCHIVE is refused — the legacy leaf is never destroyed against it", () => {
    const dir = board();
    const run = nonce();
    legacy080(dir);
    writeFileSync(join(dir, "reservations.v1.migrated.jsonl"), "not the leaf\n", { mode: 0o600 });
    expect(() => migrateLegacyV1({ dir, runNonce: run })).toThrow(/NOT the legacy leaf's inode/);
    expect(readFileSync(join(dir, "reservations.jsonl"), "utf8")).toContain("old-1"); // still there
  });

  // -------------------------------------------------------------------------------------------
  // A second hard link is tolerated for EXACTLY ONE reason: mid-migration, the archive and the leaf are
  // two names for one inode. Tolerating `nlink <= 2` unconditionally spent that allowance on ANY second
  // name — so an attacker's own alias, invisible to the fold, could rewrite the legacy bytes between the
  // read that pins the balance and the read that proves the archive. The pair must be NAMED and PROVEN.
  // -------------------------------------------------------------------------------------------

  const LEAF_N = "reservations.jsonl";
  const ARCHIVE_N = "reservations.v1.migrated.jsonl";

  it("the LEAF plus an UNKNOWN alias is refused — a second link is not a mid-migration pair", () => {
    const dir = board();
    const run = nonce();
    legacy080(dir);
    linkSync(join(dir, LEAF_N), join(dir, "alias.jsonl")); // nlink 2, but no archive: the pair is a lie
    expect(() => migrateLegacyV1({ dir, runNonce: run })).toThrow(LedgerRecoveryRequired);
    expect(() => migrateLegacyV1({ dir, runNonce: run })).toThrow(/hard links/i);
    expect(readFileSync(join(dir, LEAF_N), "utf8")).toContain("old-1"); // fail-closed: nothing touched
    expect(existsSync(join(dir, "reservations.v1.migration.intent.json"))).toBe(false);
  });

  it("the ARCHIVE plus an UNKNOWN alias is refused — the leaf being gone does not license a stray link", () => {
    const dir = board();
    const run = nonce();
    legacy080(dir);
    // Crash after the legacy leaf is removed: the archive now stands alone and is the ONLY legacy source.
    // (`LEAF_N` may exist here as the next generation's EMPTY journal — a different inode, so it can never
    // stand in as the archive's mid-migration partner.)
    expect(() => migrateLegacyV1({ dir, runNonce: run, io: crashOn("link", 3) })).toThrow();
    const leaf = join(dir, LEAF_N);
    expect(existsSync(leaf) ? readFileSync(leaf, "utf8") : "").toBe("");
    linkSync(join(dir, ARCHIVE_N), join(dir, "alias.jsonl")); // an alias that could rewrite the evidence

    expect(() => migrateLegacyV1({ dir, runNonce: run })).toThrow(/hard links/i);
    expect(() => ledgerOn(dir, run)).toThrow(LedgerRecoveryRequired); // still never a $0 board
    expect(readFileSync(join(dir, ARCHIVE_N), "utf8")).toContain("old-1"); // the evidence survives
  });

  it("BOTH expected names, proven to be ONE inode, are accepted — genuine crash recovery still resumes", () => {
    const dir = board();
    const run = nonce();
    legacy080(dir);
    // Crash between the archive's link() and the leaf's unlink(): the real mid-migration pair.
    expect(() => migrateLegacyV1({ dir, runNonce: run, io: crashOn("unlink", 2) })).toThrow();
    expect(existsSync(join(dir, LEAF_N))).toBe(true);
    expect(existsSync(join(dir, ARCHIVE_N))).toBe(true); // two names, nlink 2, one inode

    const r = migrateLegacyV1({ dir, runNonce: run }); // the bounded check must NOT break this
    expect(r.carriedForwardUsd).toBeCloseTo(0.8, 9);
    expect(ledgerOn(dir, run).effectiveSpend()).toBeCloseTo(0.8, 9);
  });

  it("a FOREIGN archive alongside an aliased leaf is refused — presence of both names is not enough", () => {
    const dir = board();
    const run = nonce();
    legacy080(dir);
    linkSync(join(dir, LEAF_N), join(dir, "alias.jsonl")); // the leaf's second link is the ALIAS…
    writeFileSync(join(dir, ARCHIVE_N), "not the leaf\n", { mode: 0o600 }); // …not this planted archive
    // Both expected names exist, so a name-only check would pass. The archive is a different inode, so
    // the leaf's second link is still unaccounted for.
    expect(() => migrateLegacyV1({ dir, runNonce: run })).toThrow(/hard links/i);
    expect(readFileSync(join(dir, LEAF_N), "utf8")).toContain("old-1");
  });

  it("MORE than two hard links is refused even when both expected names are the same inode", () => {
    const dir = board();
    const run = nonce();
    legacy080(dir);
    linkSync(join(dir, LEAF_N), join(dir, ARCHIVE_N)); // a legitimate-looking pair…
    linkSync(join(dir, LEAF_N), join(dir, "alias.jsonl")); // …plus a third name → nlink 3
    expect(() => migrateLegacyV1({ dir, runNonce: run })).toThrow(/3 hard links/);
    expect(readFileSync(join(dir, LEAF_N), "utf8")).toContain("old-1");
  });
});

describe("Priority B7 — unsafe topology and hooks", () => {
  it("rejects a SYMLINKED ancestor (component-by-component, no path re-resolution)", () => {
    const root = board();
    const real = join(root, "real");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, join(root, "link"));
    expect(() => ledgerOn(join(root, "link"), nonce())).toThrow(LedgerRecoveryRequired);
  });

  it("rejects a GROUP-WRITABLE parent directory (another account could swap the leaf)", () => {
    const dir = board();
    chmodSync(dir, 0o770);
    expect(() => ledgerOn(dir, nonce())).toThrow(/group\/other writable/i);
    chmodSync(dir, 0o700);
  });

  it("rejects a SYMLINKED ledger leaf without touching the victim", () => {
    const dir = board();
    const victim = join(dir, "victim.jsonl");
    writeFileSync(victim, "", { mode: 0o600 });
    symlinkSync(victim, join(dir, "reservations.jsonl"));
    expect(() => ledgerOn(dir, nonce())).toThrow();
    expect(readFileSync(victim, "utf8")).toBe("");
  });

  it("rejects a HARD-LINKED ledger leaf (an aliased victim path)", () => {
    const dir = board();
    const path = join(dir, "reservations.jsonl");
    writeFileSync(path, "", { mode: 0o600 });
    linkSync(path, join(dir, "alias.jsonl"));
    expect(() => ledgerOn(dir, nonce())).toThrow(/hard link/i);
  });

  it("rejects a GROUP-READABLE ledger leaf", () => {
    const dir = board();
    writeFileSync(join(dir, "reservations.jsonl"), "", { mode: 0o640 });
    expect(() => ledgerOn(dir, nonce())).toThrow(/not private/i);
  });

  it("rejects a NON-REGULAR (FIFO) ledger leaf without blocking on it", () => {
    const dir = board();
    const path = join(dir, "reservations.jsonl");
    const r = spawnSync("mkfifo", ["-m", "600", path]);
    if (r.status !== 0) mkdirSync(path, { mode: 0o700 }); // no mkfifo → a directory is also non-regular
    expect(() => ledgerOn(dir, nonce())).toThrow();
  });

  it("IO is injected PER HANDLE — one ledger's fault injection cannot touch another's", () => {
    const a = board();
    const b = board();
    const runA = nonce();
    const runB = nonce();
    const faulty = realLedgerIO();
    faulty.fsyncFile = () => {
      throw new Error("this handle's disk is on fire");
    };
    expect(() => ledgerOn(a, runA, faulty)).toThrow(); // A cannot even initialize…
    const healthy = ledgerOn(b, runB); // …while B, with its own IO, is untouched
    expect(healthy.reserve(bindFor(runB, "fine"), 0.5, 10)).toBe(true);
    expect(healthy.effectiveSpend()).toBe(0.5);
  });

  it("a torn final record (a crash mid-append) is recovered; an INTERIOR corruption fails closed", () => {
    const dir = board();
    const run = nonce();
    const L = ledgerOn(dir, run);
    L.reserve(bindFor(run, "a"), 0.1, 10);
    L.reserve(bindFor(run, "b"), 0.1, 10);
    const path = join(dir, "reservations.jsonl");
    const good = readFileSync(path, "utf8");
    // A torn tail (no trailing newline) is a crash mid-append: recoverable.
    writeFileSync(path, `${good}{"seq":2,"prev":"deadbe`, { mode: 0o600 });
    expect(ledgerOn(dir, run).effectiveSpend()).toBe(0.2);
    // An INTERIOR record that fails to validate is unrecoverable: never a cheaper prefix.
    const lines = good.trim().split("\n");
    const tampered = JSON.parse(lines[0]);
    tampered.data.worstCaseNano = "1";
    writeFileSync(path, `${JSON.stringify(tampered)}\n${lines[1]}\n`, { mode: 0o600 });
    expect(() => ledgerOn(dir, run).effectiveSpend()).toThrow(CorruptJournalError);
  });
});

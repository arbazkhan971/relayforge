import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as ledgerModule from "../src/ledger.js";
import { openLedger, type CallBinding } from "../src/ledger.js";
import { isProcessGroupAlive } from "../src/runtime.js";

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const nonce = () => randomBytes(32).toString("hex");

function bindFor(run: string, callId: string): CallBinding {
  return {
    runNonce: run,
    callNonce: randomBytes(16).toString("hex"),
    callId,
    reservationId: randomBytes(16).toString("hex"),
    routeEpoch: 0,
    provider: "claude",
    model: "opus-4.8",
    attempt: 0,
    intentSha256: sha(`intent:${callId}`),
    stdinSha256: sha(`stdin:${callId}`),
    stdinBytes: 8
  };
}

/** A REAL, provably-dead process group: spawn a detached child, let it exit, wait for ESRCH. No fake
 *  prober is injected — this is the same `isProcessGroupAlive` the production ledger uses. */
async function deadGroupPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { detached: true, stdio: "ignore" });
  const pid = child.pid!;
  await new Promise((r) => child.on("close", r));
  for (let i = 0; i < 200 && isProcessGroupAlive(pid); i++) await new Promise((r) => setTimeout(r, 10));
  expect(isProcessGroupAlive(pid)).toBe(false);
  return pid;
}

const S = "sess-forged";
const INIT = JSON.stringify({ type: "system", subtype: "init", session_id: S, tools: ["Bash"], model: "claude-opus-4" });
const CHEAP_SUCCESS = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "OK",
  session_id: S,
  total_cost_usd: 0.000001,
  usage: { input_tokens: 1, output_tokens: 1 }
});
const LIMIT = JSON.stringify({ type: "rate_limit_event", session_id: S, rate_limit_info: { status: "rejected" } });
const REJECTED = JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "rate limited", session_id: S });

/** Write a syntactically canonical provider transcript at a path of the ATTACKER's choosing, inside the
 *  configured transcript root, with the private mode/ownership the ledger demands. No child ever ran. */
function plantTranscript(root: string, body: string): string {
  const dir = join(root, "transcripts");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${randomBytes(16).toString("hex")}.jsonl`);
  writeFileSync(path, body, { mode: 0o600 });
  return path;
}

/**
 * THE FORGERY UNDER AUDIT.
 *
 * An ordinary holder of a `LedgerHandle` — any module in this package, or any deep importer of it —
 * reserves a call of its own and then, with NO child process spawned and NO trusted transport
 * participating, drives the public capability surface to a ledger-minted receipt:
 *
 *   beginCall(bind) → recordScope(<already-dead pid>) → registerTranscript(<file it wrote itself>)
 *                   → sealTransport({ok: true, scopeTrusted: true}) → attest() → settle(receipt)
 *
 * Nothing here races the legitimate transport: the attacker operates an independent reserved call.
 * Every gate the ledger applies (ESRCH probe, path confinement, inode pinning, re-framing) passes,
 * because every one of them is a check on evidence the ATTACKER supplied.
 */
describe("EXPLOIT: an ordinary LedgerHandle holder must not be able to mint cost/fallback authority", () => {
  it("cannot shrink a worst-case reservation with a transcript it wrote itself", async () => {
    const pid = await deadGroupPid();
    const dir = mkdtempSync(join(tmpdir(), "loop-forge-"));
    const root = mkdtempSync(join(tmpdir(), "loop-forge-run-"));
    const run = nonce();
    const L = openLedger({ dir, runNonce: run, transcriptRoot: root });
    const bind = bindFor(run, "forged-cost");

    const forged = (): void => {
      const handle = L as unknown as Record<string, unknown>;
      const begin = handle.beginCall as ((b: CallBinding, o: unknown) => Record<string, Function>) | undefined;
      if (typeof begin !== "function") throw new Error("no public reservation capability exposes witness/mint primitives");
      const auth = begin.call(L, bind, { worstCaseUsd: 0.5, budgetUsd: 10, providerKind: "claude" });
      if (!auth) throw new Error("reservation refused");
      const path = plantTranscript(root, `${INIT}\n${CHEAP_SUCCESS}\n`);
      (auth.recordScope as (p: number) => void).call(auth, pid);
      (auth.registerTranscript as (p: string) => void).call(auth, path);
      (auth.sealTransport as (s: unknown) => void).call(auth, { ok: true, scopeTrusted: true });
      const receipt = (auth.attest as () => unknown).call(auth);
      (auth.settle as (r: unknown) => void).call(auth, receipt);
    };

    // The forgery must be IMPOSSIBLE. Either the capability does not exist (post-fix), or — if it
    // somehow runs — it must not have bought authority.
    let ran = true;
    try {
      forged();
    } catch {
      ran = false;
    }
    const settlement = L.settlementOf("forged-cost");
    expect(settlement.costTrusted, "a fabricated transcript minted PROVEN cost authority").toBe(false);
    if (ran) {
      // The reservation, if settled at all, must still stand at its full worst case.
      expect(L.effectiveSpend()).toBe(0.5);
    }
    L.close();
  });

  it("cannot mint a trusted-fallback (the authority to bill a SECOND provider) from a planted rejection", async () => {
    const pid = await deadGroupPid();
    const dir = mkdtempSync(join(tmpdir(), "loop-forge2-"));
    const root = mkdtempSync(join(tmpdir(), "loop-forge2-run-"));
    const run = nonce();
    const L = openLedger({ dir, runNonce: run, transcriptRoot: root });
    const bind = bindFor(run, "forged-fallback");

    try {
      const handle = L as unknown as Record<string, unknown>;
      const begin = handle.beginCall as ((b: CallBinding, o: unknown) => Record<string, Function>) | undefined;
      if (typeof begin === "function") {
        const auth = begin.call(L, bind, { worstCaseUsd: 0.5, budgetUsd: 10, providerKind: "claude" });
        const path = plantTranscript(root, `${INIT}\n${LIMIT}\n${REJECTED}\n`);
        (auth.recordScope as (p: number) => void).call(auth, pid);
        (auth.registerTranscript as (p: string) => void).call(auth, path);
        (auth.sealTransport as (s: unknown) => void).call(auth, { ok: true, scopeTrusted: true });
        const receipt = (auth.attest as () => unknown).call(auth);
        (auth.settle as (r: unknown) => void).call(auth, receipt);
      }
    } catch {
      /* the capability is gone, or refused — that is the required outcome */
    }
    expect(
      L.settlementOf("forged-fallback").fallbackAuthorized,
      "a planted rate_limit_event minted authority to bill a second provider"
    ).toBe(false);
    L.close();
  });
});

/**
 * The two exploits above pass by ABSENCE: `beginCall` is not a function, so the forgery chain cannot even
 * start. That is a weak thing to rest on — a future change could reintroduce a mint under any of these
 * names and both tests would go green again while silently doing nothing (they swallow the throw).
 *
 * So assert the absence STRUCTURALLY, and separately: no reachable property of a live `LedgerHandle` — own
 * or inherited — may be named for any step of the withdrawn mint. This fails loudly the moment a minting
 * primitive reappears on the handle, whatever its implementation.
 */
describe("the ledger exposes no minting surface at all", () => {
  /** Every step of the forgery chain, plus a bare `settle` (which used to accept a caller's receipt).
   *  `settleUncertain` is deliberately NOT here: it retains the worst case and authorizes nothing. */
  const FORBIDDEN = ["beginCall", "recordScope", "registerTranscript", "sealTransport", "attest", "settle"];

  /** Own AND inherited property names, so a mint hidden on the prototype cannot slip past. */
  function reachableProps(o: object): Set<string> {
    const names = new Set<string>();
    for (let cur: object | null = o; cur !== null && cur !== Object.prototype; cur = Object.getPrototypeOf(cur) as object | null) {
      for (const k of Reflect.ownKeys(cur)) if (typeof k === "string") names.add(k);
    }
    return names;
  }

  it("has no property named for any step of the mint — on the instance or its prototype", () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-nomint-"));
    const root = mkdtempSync(join(tmpdir(), "loop-nomint-run-"));
    const L = openLedger({ dir, runNonce: nonce(), transcriptRoot: root });
    try {
      const props = reachableProps(L);
      // Guard the guard: if the handle stopped exposing its real API we would be asserting over nothing.
      expect(props.has("reserve"), "the handle under test is not a real LedgerHandle").toBe(true);
      expect(props.has("settleUncertain"), "the handle under test is not a real LedgerHandle").toBe(true);

      const present = FORBIDDEN.filter((name) => props.has(name));
      expect(present, `the ledger re-exposed minting primitives: ${present.join(", ")}`).toEqual([]);

      // …and none of them is reachable as a callable, by any route (getter, symbol-keyed alias, proxy).
      for (const name of FORBIDDEN) {
        expect(typeof (L as unknown as Record<string, unknown>)[name], `LedgerHandle.${name} is callable`).not.toBe("function");
      }
    } finally {
      L.close();
    }
  });

  it("exports no receipt or call-authority construct", () => {
    const exported = ledgerModule as unknown as Record<string, unknown>;
    // A runtime export is what an attacker can actually reach — a *type* export erases at compile time.
    expect(exported.SettlementReceipt, "SettlementReceipt is still a runtime construct").toBeUndefined();
    expect(exported.CallAuthority, "CallAuthority is still a runtime construct").toBeUndefined();
    // The safe primitive must still be there — otherwise the reservation could never be discharged.
    expect(typeof exported.openLedger).toBe("function");
  });
});

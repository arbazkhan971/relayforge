import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// This module graph imports the ledger DIRECTLY and FIRST — the settlement kernel and the orchestrator are
// never imported here, so nothing in this file "claimed" any bridge at load. That is precisely the
// adversary's vantage point: an ordinary direct-source importer that reaches `../src/ledger.js` before any
// kernel code runs. (Per tests/receipt-forgery.test.ts, direct-source/internal code is treated as hostile.)
import * as ledgerModule from "../src/ledger.js";
import { openLedger, type CallBinding, type KernelSettlementDraft } from "../src/ledger.js";
import * as attestModule from "../src/attest.js";

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

/** A fabricated draft: no transcript, no frame, no process ever ran — every field is invented, and the
 *  charged amount is one nano-USD. If the RAW mint (`attestAndSettle`) is reachable, this shrinks the
 *  worst case to nothing, because the raw mint trusts the draft's transcript/frame fields wholesale — it is
 *  ONLY the evidence-gated `settleCompleted` path that re-reads bytes. */
function fabricatedDraft(): KernelSettlementDraft {
  return {
    providerKind: "claude",
    // A scope that never existed: the strong backend would have had to CREATE this cgroup, and the ledger
    // re-probes it. The attack does not depend on that — it depends on reaching the mint at all.
    scope: { backend: "pgid", pid: 4_242_424 },
    transcriptDev: "1",
    transcriptIno: "2",
    transcriptSha256: sha("fabricated-transcript"),
    transcriptBytes: 1,
    terminalSha256: sha("fabricated-frame"),
    terminalBytes: 1,
    terminalOffset: 0,
    usdNano: "1"
  };
}

/**
 * THE ATTACK UNDER AUDIT (wave-9 slice 1 first-claim bridge).
 *
 * The old `src/ledger.ts` exported `claimLedgerKernelBridge()`, a first-claim function that returned a
 * closure over the ledger's module-private mint. Its "single use" was only ever import-order deep: the
 * FIRST importer won. An ordinary direct-source importer that loaded `./ledger` before the settlement
 * kernel could therefore take the bridge, open/reserve a ledger of its own, and call
 * `access.attestAndSettle(bind, <fabricated draft>)` — with NO child spawned and NO transcript — to mint a
 * MAC-authenticated `provider-reported` settlement that shrank the worst case to one nano-USD.
 *
 * The mint was reachable four ways, and every one must now be dead:
 *   A. the exported `claimLedgerKernelBridge()` first-claim function;
 *   B. the module symbol the bridge closed over, by `getOwnPropertySymbols` on the prototype;
 *   C. the mint method by name, `(handle as any).attestAndSettle`;
 *   D. the attestation key by reflection, `(handle as any).key`, tagged directly via exported `tagPayload`.
 */
describe("EXPLOIT: no direct-source importer can reach the raw settlement mint", () => {
  it("cannot shrink a reservation via the bridge / symbol / method-name / key — the fabricated draft mints nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-mint-"));
    const root = mkdtempSync(join(tmpdir(), "loop-mint-run-"));
    const run = nonce();
    // The attacker even injects a prober that reports the (fabricated) scope DEAD, so a live-scope refusal
    // cannot be what saves us: the ONLY thing between this draft and minted cheap cost is reachability.
    const L = openLedger({ dir, runNonce: run, transcriptRoot: root, groupAlive: () => false, scopeAlive: () => false });
    const bind = bindFor(run, "raw-mint");
    expect(L.reserve(bind, 0.5, 10)).toBe(true);
    expect(L.effectiveSpend(), "the worst case must stand before the attack").toBe(0.5);

    const draft = fabricatedDraft();
    type Access = { attestAndSettle(b: CallBinding, d: KernelSettlementDraft): void };
    const tryMint = (access: unknown): void => {
      const a = access as Partial<Access> | null | undefined;
      if (a && typeof a.attestAndSettle === "function") {
        try {
          a.attestAndSettle(bind, draft);
        } catch {
          /* refused — the required outcome */
        }
      }
    };

    // Route A — the exported first-claim bridge. DELETED post-fix; a live construct pre-fix.
    const claim = (ledgerModule as unknown as Record<string, unknown>).claimLedgerKernelBridge as
      | (() => (h: unknown) => unknown)
      | undefined;
    if (typeof claim === "function") {
      try {
        tryMint(claim()(L));
      } catch {
        /* bridge already claimed / gone */
      }
    }

    // Route B — the module-private symbol the bridge closed over, by enumeration of the prototype.
    for (let cur: object | null = L; cur && cur !== Object.prototype; cur = Object.getPrototypeOf(cur) as object | null) {
      for (const s of Object.getOwnPropertySymbols(cur)) {
        const fn = (L as unknown as Record<symbol, unknown>)[s];
        if (typeof fn === "function") {
          try {
            tryMint((fn as (this: unknown) => unknown).call(L));
          } catch {
            /* not an access factory */
          }
        }
      }
    }

    // Route C — the mint method by name, own or inherited.
    tryMint(L); // if `attestAndSettle` is a reachable method on the handle, this fires it directly

    // Route D — the attestation key by reflection, tagged directly via the exported `tagPayload`.
    const key = (L as unknown as Record<string, unknown>).key;
    const tagPayload = (attestModule as unknown as Record<string, unknown>).tagPayload as
      | ((k: unknown, p: unknown) => string)
      | undefined;
    if (key !== undefined && typeof tagPayload === "function") {
      try {
        // If the key were reachable, an attacker would forge a whole settlement record. We do not need to
        // reconstruct the fold here: producing a VALID tag over an arbitrary payload is already game over.
        const tag = tagPayload(key, { schema: "loop.ledger.attest.v1", usdNano: "1" });
        expect(tag, "the attestation key was reachable and produced a forgeable tag").toBeUndefined();
      } catch {
        /* key is inert / unreachable — the required outcome */
      }
    }

    // The verdict: nothing above may have moved money. The reservation stands at its full worst case, and
    // no trusted cost was minted.
    expect(L.settlementOf("raw-mint").costTrusted, "a fabricated draft minted PROVEN cost authority").toBe(false);
    expect(L.effectiveSpend(), "a fabricated draft shrank the worst-case reservation").toBe(0.5);
    L.close();
  });

  it("exposes no reachable name, symbol, or key for the raw mint on a live handle", () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-mint2-"));
    const root = mkdtempSync(join(tmpdir(), "loop-mint2-run-"));
    const L = openLedger({ dir, runNonce: nonce(), transcriptRoot: root });
    try {
      // No exported first-claim bridge.
      expect((ledgerModule as unknown as Record<string, unknown>).claimLedgerKernelBridge).toBeUndefined();

      // No string-named mint reachable, own or inherited.
      const names = new Set<string>();
      const symbols: symbol[] = [];
      for (let cur: object | null = L; cur && cur !== Object.prototype; cur = Object.getPrototypeOf(cur) as object | null) {
        for (const k of Reflect.ownKeys(cur)) {
          if (typeof k === "string") names.add(k);
          else symbols.push(k);
        }
      }
      // Guard the guard: the handle under test is a real one.
      expect(names.has("reserve") && names.has("settleUncertain")).toBe(true);
      expect(typeof (L as unknown as Record<string, unknown>).attestAndSettle).not.toBe("function");
      expect((L as unknown as Record<string, unknown>).key, "the attestation key is reachable by reflection").toBeUndefined();
      expect((L as unknown as Record<string, unknown>).caps, "the evidence caps are reachable by reflection").toBeUndefined();

      // No enumerable symbol yields an object carrying a mint.
      for (const s of symbols) {
        const v = (L as unknown as Record<symbol, unknown>)[s];
        if (typeof v === "function") {
          let out: unknown;
          try {
            out = (v as (this: unknown) => unknown).call(L);
          } catch {
            continue;
          }
          expect(
            out && typeof (out as Record<string, unknown>).attestAndSettle === "function",
            `a reachable symbol method exposed the mint: ${String(s)}`
          ).not.toBe(true);
        }
      }
    } finally {
      L.close();
    }
  });
});

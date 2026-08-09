import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  adapterEvidenceIdentity,
  type CallBinding,
  type KernelFallbackDraft,
  type KernelSettlementDraft,
  type LedgerKernelAccess
} from "./ledger.js";
import { MoneyError, nanoToUsd, usdToNano, formatNano } from "./money.js";
import type { NormalizedTurn, ProviderKind, TerminalFrameRef } from "./normalize.js";
import type { AdapterTerminalResult, CodecFrameReference } from "./adapters/codec.js";
import type { GrokEgressEvidenceBinding } from "./adapters/grok-egress-contract.js";
import { assertConfinedRealPath } from "./runtime.js";
import { parseScopeId, reapProofOf, scopeIdOf } from "./scope.js";
import {
  StdoutStream,
  resolveAdapterCallIdentity,
  sameAdapterCallIdentity,
  type AdapterCallIdentity,
  type FrameFatal
} from "./streaming.js";

/**
 * THE SETTLEMENT KERNEL (wave-9: genuine SUCCESS, and a genuine usage REJECTION).
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------------------------
 * Two generations of settlement authority were withdrawn from the ledger because both let an ORDINARY
 * caller mint one. `SettlementReceipt` was an object literal whose every field was a claim.
 * `CallAuthority` moved the checks inside the ledger but still handed a mint to anyone holding a
 * `LedgerHandle`, and every gate it applied was a check on evidence the CALLER supplied — so an attacker
 * reserved a call of its own, planted a transcript, named an already-dead pid, and walked the same path
 * to a receipt (tests/receipt-forgery.test.ts). Since then the ledger has had NO mint at all: every call
 * settles UNCERTAIN, retaining its full worst case. Correct, and permanently over-charging.
 *
 * A trusted mint may return only as a KERNEL THE TRANSPORT CANNOT REACH. This is it.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT MAKES IT UNREACHABLE
 * ---------------------------------------------------------------------------------------------
 *   1. The package's export map does not expose this module (nor `./ledger`, `./attest`, `./orchestrator`)
 *      to consumers — see tests/package-exports.test.ts. A deep import is `ERR_PACKAGE_PATH_NOT_EXPORTED`.
 *   2. Inside the package, the RAW MINT is unreachable by construction: it is an ECMAScript-`#private`
 *      method of `LedgerHandle`, so a handle holder cannot name it, enumerate it (it appears in no
 *      `Reflect.ownKeys`/`getOwnPropertySymbols`), reflect to it, or walk a prototype to it. The `#private`
 *      attestation key is equally out of reach, so it cannot be tagged directly either.
 *   3. The kernel never OBTAINS that mint. `settleCompletedCall` is a pure function of a
 *      `LedgerKernelAccess` capability; it is the LEDGER that constructs the capability (from its own
 *      `#private` internals) and calls this function — see `LedgerHandle.settleCompleted`. The access
 *      object is created per call and never returned to any caller, so there is no bridge to claim, no
 *      import order that matters, and no first-claimant that wins.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT IT ACCEPTS AS EVIDENCE — AND WHAT IT REFUSES TO BE TOLD
 * ---------------------------------------------------------------------------------------------
 * The kernel is handed the orchestrator's OWN completed `runHeadlessChild` result. It treats none of it
 * as a verdict. It re-derives everything from bytes. These SOUNDNESS gates hold for EITHER authority, or
 * the call settles UNCERTAIN at its full worst case (money is never lowered, and no second provider is
 * ever bought, on a maybe):
 *
 *   - the TRANSPORT was sound end to end: `transportOk`, no framing fatal, and the child actually
 *     terminated with a code (a signal death is not a clean terminal shape);
 *   - the STDIN the reservation was bound to is the stdin that was DELIVERED: the exact bytes hash to
 *     `bind.stdinSha256` and count `bind.stdinBytes`, and delivery completed;
 *   - the TRANSCRIPT is confined strictly inside the ledger's own transcript root (no symlinked
 *     component), is a private regular file we own with exactly one link, and its inode, whole-file
 *     hash, and byte count are what the kernel re-reads — not what the transport reported;
 *   - the TERMINAL FRAME is re-located by REPLAYING those durable bytes through the production framer
 *     and the production provider state machine, and the replayed verdict AGREES with the live one,
 *     frame for frame and number for number. A transcript mutated after the run diverges here;
 *   - the SCOPE is the exact containment boundary this call spawned into, and it is provably EMPTY. Since
 *     wave-10 that boundary is a cgroup the provider was launched INSIDE (see src/scope.ts), so a
 *     descendant that `setsid`'d or double-forked out of the process group is still counted: emptiness is
 *     the kernel's `populated 0` plus a successful `rmdir` of the scope, not a signal's errno. The
 *     transport's proof must be exactly the one that scope's identity derives, and the LEDGER re-probes
 *     the scope itself at attestation time.
 *
 * On top of that common floor, EXACTLY ONE of two authorities may be issued:
 *
 *   `accounted-terminal` — the actual cost stands in place of the worst case. Additionally requires:
 *      exit code exactly 0; a genuine whole-stream SUCCESS with a canonical terminal frame; and a cost
 *      that is PROVIDER-REPORTED and exact fixed point. A terminal that reported no cost, or an
 *      unrepresentable one, is UNCERTAIN — never a cheap settlement.
 *
 *   `trusted-fallback` — the right to bill a SECOND provider for this turn (wave-9, slice 2). This is
 *      the ONLY thing that can restore the Claude→GPT route, and it is issued ONLY when replaying the
 *      DURABLE transcript re-derives a canonical Claude usage REJECTION: the production Claude state
 *      machine (and nothing else) must conclude `explicitLimit`, which it does only for a clean,
 *      session-bound, whitelisted FAILED terminal whose final in-scope pre-terminal `rate_limit_event`
 *      snapshot has `rate_limit_info.status` exactly `rejected` — a snapshot no later event cleared and
 *      no drift invalidated. The kernel additionally demands that the replayed rejection name the SAME
 *      limit frame the live stream accepted, that the frame lie inside the transcript that carries it,
 *      and that the provider dialect actually be Claude. `allowed`/`allowed_warning`, warning prose,
 *      stderr, an exit code on its own, a generic failure, a malformed/foreign/duplicate/trailing event,
 *      a missing frame, a mutated transcript, and a live process group ALL fail this closed. A canonical
 *      rejection legitimately exits NONZERO, so the exit code is not a gate here — the re-derived
 *      rejection is. Its own primary cost is settled CONSERVATIVELY (unknown provenance, worst case
 *      retained): "we can prove you were rejected" is a different claim from "we know what it cost".
 *
 * The ledger then stamps its own epoch/run/timestamp and MACs the payload with a key nothing can read.
 * The kernel never sees the key: it can only present derived evidence to the two closures the ledger
 * built for this one call.
 */

/** A transcript larger than this is not evidence we will re-read: the transport's own total-stdout quota
 *  is the same ceiling, so a file past it could not have come from a turn we accepted. */
const MAX_TRANSCRIPT_BYTES = 512 * 1024 * 1024;
const READ_CHUNK = 1 << 20;

/**
 * The completed call, exactly as `runHeadlessChild` resolved it. Declared STRUCTURALLY (not imported
 * from the orchestrator) so the kernel has no dependency on — and no import cycle with — the transport
 * whose output it is judging.
 */
export type CompletedChildCall = {
  code: number | null;
  transportOk: boolean;
  stdinComplete: boolean;
  scopeTrusted: boolean;
  scopeId?: string;
  scopeReaped?: boolean;
  scopeReapProof?: string;
  transcriptPath?: string;
  transcriptSha256?: string;
  transcriptBytes?: number;
  framingFatal?: FrameFatal;
  /** The whole-stream verdict the LIVE framer produced. Re-derived here from the durable bytes; a
   *  disagreement between the two is exactly what this kernel exists to catch. */
  streamedVerdict?: NormalizedTurn;
  /** Exact shipped grammar selected before launch, echoed by the live transport. */
  adapterIdentity?: AdapterCallIdentity;
  /** Structured ACP/Pi terminal from that exact grammar. */
  adapterResult?: AdapterTerminalResult;
  /** Exact parent-proxy evidence produced only after the socket is re-statted and drained. */
  grokEgressEvidence?: GrokEgressEvidenceBinding;
};

export type SettlementOutcome =
  /** The ledger issued MAC-authenticated, provider-reported authority: the actual cost now stands in
   *  place of the worst case, and it survives a restart (the fold re-verifies the tag from bytes). */
  | { kind: "trusted"; usd: number; usdNano: string }
  /** The ledger issued MAC-authenticated `trusted-fallback` authority: a canonical Claude usage
   *  rejection was RE-DERIVED from the durable transcript, so a SECOND provider may be billed for this
   *  turn. The primary's own cost is NOT lowered — it stays at its full worst case (unknown provenance). */
  | { kind: "trusted-fallback"; reason: string }
  /** The full worst-case reservation is RETAINED and nothing is authorized. Always durable. */
  | { kind: "uncertain"; reason: string };

type TranscriptEvidence = {
  dev: string;
  ino: string;
  sha256: string;
  bytes: number;
  fatal?: FrameFatal;
  verdict?: NormalizedTurn;
  adapterResult?: AdapterTerminalResult;
};

/**
 * Re-read the durable transcript and REPLAY it — in ONE bounded pass over the file — through the very
 * same framer and provider state machine the live stream used. The hash, the byte count, and the
 * re-derived verdict all come from the same bytes, so they cannot describe different files.
 *
 * The file is opened `O_RDONLY|O_NOFOLLOW` after a confinement walk, and must be a private regular file
 * we own with exactly one link: a symlinked component, a swapped inode, a hardlink alias, or a
 * group/other-accessible mode all mean a byte we are about to trust could have been planted.
 */
function reReadTranscript(
  root: string,
  path: string,
  providerKind: ProviderKind | undefined,
  adapterIdentity: AdapterCallIdentity | undefined
): TranscriptEvidence {
  const confined = assertConfinedRealPath(root, path); // throws on escape / symlinked component
  const fd = openSync(confined, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd, { bigint: true }); // dev/ino: the INODE, so a swapped name cannot pass
    const plain = fstatSync(fd);
    if (!plain.isFile()) throw new Error("the transcript is not a regular file");
    if (plain.nlink !== 1) throw new Error(`the transcript has ${plain.nlink} hard links (an alias could have mutated it)`);
    if ((plain.mode & 0o077) !== 0) throw new Error(`the transcript is group/other accessible (mode ${(plain.mode & 0o7777).toString(8)})`);
    if (typeof process.getuid === "function" && plain.uid !== process.getuid()) {
      throw new Error(`the transcript is owned by uid ${plain.uid}, not ${process.getuid()}`);
    }
    if (plain.size > MAX_TRANSCRIPT_BYTES) throw new Error(`the transcript is ${plain.size} bytes (limit ${MAX_TRANSCRIPT_BYTES})`);

    const hash = createHash("sha256");
    let bytes = 0;
    const buf = Buffer.allocUnsafe(READ_CHUNK);
    // ONE pass: hash the bytes and feed the SAME bytes to the production pipeline. Memory stays bounded
    // by the framer's ceiling regardless of transcript size.
    if (!adapterIdentity && !providerKind) throw new Error("the call has no replay grammar");
    const pump = (push: (chunk: Buffer) => void) => {
      for (;;) {
        const n = readSync(fd, buf, 0, buf.length, bytes);
        if (n <= 0) break;
        const chunk = buf.subarray(0, n);
        hash.update(chunk);
        bytes += n;
        push(chunk);
      }
    };
    const outcome = adapterIdentity
      ? StdoutStream.replayAdapter(adapterIdentity, pump)
      : StdoutStream.replay(providerKind!, pump);
    return {
      dev: st.dev.toString(),
      ino: st.ino.toString(),
      sha256: hash.digest("hex"),
      bytes,
      fatal: outcome.fatal,
      verdict: outcome.verdict,
      adapterResult: outcome.adapterResult
    };
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

/** Do the live and the re-derived terminal frames name the SAME bytes at the SAME place? */
function sameFrame(a: TerminalFrameRef | undefined, b: TerminalFrameRef | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return a.sha256 === b.sha256 && a.bytes === b.bytes && a.offset === b.offset && a.index === b.index;
}

function sameCodecFrame(a: CodecFrameReference | undefined, b: CodecFrameReference | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return a.sha256 === b.sha256 &&
    a.bytes === b.bytes &&
    a.offset === b.offset &&
    a.index === b.index &&
    a.terminated === b.terminated;
}

/** What the orchestrator hands the kernel: a completed call plus the exact stdin that was delivered. The
 *  LEDGER supplies the `access` capability separately — a caller never gets to name it. */
export type CompletedCallSettlement = {
  bind: CallBinding;
  /** Legacy compatibility only; new calls derive the dialect from bind.adapter. */
  providerKind?: ProviderKind;
  stdinDelivered: Buffer;
  result: CompletedChildCall;
};

/**
 * Settle ONE completed call. This ALWAYS reaches a durable terminal settlement — trusted when every
 * proof holds, UNCERTAIN otherwise — so a reservation is never stranded.
 *
 * `access` is the ledger's OWN narrow capability, constructed by the ledger from its `#private` internals
 * and handed in for exactly this call. This function holds NO mint of its own: it cannot reach the ledger's
 * key, its symbol, or its `#private` `attestAndSettle` — it can only present derived evidence to the
 * `access.attestAndSettle` closure the ledger built, which re-checks everything itself. A forged `access`
 * cannot mint, because a forged `attestAndSettle` closes over no real key.
 *
 * `stdinDelivered` is the exact byte buffer the orchestrator handed the transport. Its hash and length
 * must reproduce the ones the reservation was bound to: that is what ties the money to the WORK.
 */
export function settleCompletedCall(access: LedgerKernelAccess, args: CompletedCallSettlement): SettlementOutcome {
  const { bind, providerKind, stdinDelivered, result } = args;
  let verifiedEgress: GrokEgressEvidenceBinding | undefined;

  const uncertain = (reason: string): SettlementOutcome => {
    access.settleUncertain(bind, verifiedEgress); // the FULL worst case is retained; nothing is authorized
    return { kind: "uncertain", reason };
  };

  let adapterIdentity: AdapterCallIdentity | undefined;
  if (bind.adapter !== undefined) {
    try {
      adapterIdentity = resolveAdapterCallIdentity(bind.adapter);
    } catch (error) {
      return uncertain(`the reservation names an unsupported adapter replay grammar: ${(error as Error).message}`);
    }
    if (!result.adapterIdentity) return uncertain("the live transport did not bind the selected adapter replay grammar");
    let liveIdentity: AdapterCallIdentity;
    try {
      liveIdentity = resolveAdapterCallIdentity(result.adapterIdentity);
    } catch (error) {
      return uncertain(`the live transport reported an unsupported adapter replay grammar: ${(error as Error).message}`);
    }
    if (!sameAdapterCallIdentity(adapterIdentity, liveIdentity)) {
      return uncertain("the live transport adapter replay grammar does not match the reservation");
    }
    if (
      adapterIdentity.correlation.kind === "oneshot" &&
      providerKind !== undefined &&
      providerKind !== adapterIdentity.correlation.providerKind
    ) {
      return uncertain("the legacy provider dialect argument contradicts the adapter replay binding");
    }
  } else if (result.adapterIdentity !== undefined) {
    return uncertain("the live transport used an adapter grammar that was not bound before reservation");
  }
  if (bind.egress !== undefined) {
    const observed = result.grokEgressEvidence;
    const values = observed ? [
      observed.policySha256,
      observed.probeReceiptSha256,
      observed.decisionLogSha256,
      observed.socketIdentitySha256,
      observed.cleanupSha256
    ] : [];
    if (
      adapterIdentity?.replay.adapterId !== "grok" ||
      !observed ||
      values.some((value) => !/^[a-f0-9]{64}$/u.test(value)) ||
      observed.policySha256 !== bind.egress.policySha256 ||
      observed.probeReceiptSha256 !== bind.egress.probeReceiptSha256 ||
      observed.socketIdentitySha256 !== bind.egress.socketIdentitySha256
    ) return uncertain("the exact Grok egress decision/socket/cleanup evidence does not match the reserved network authority");
    verifiedEgress = observed;
  } else if (result.grokEgressEvidence !== undefined) {
    return uncertain("the live call produced Grok egress evidence without a pre-reserved network authority");
  }
  const replayProviderKind = adapterIdentity?.correlation.kind === "oneshot"
    ? adapterIdentity.correlation.providerKind
    : providerKind;
  if (!adapterIdentity && replayProviderKind === undefined) return uncertain("the call has no bound transcript replay grammar");

  // ---- 1. the transport, end to end -----------------------------------------------------------
  // The exit CODE is deliberately NOT a gate here: a canonical usage rejection legitimately exits
  // nonzero, and demoting it for that alone is exactly what stalls the turn. `accounted-terminal`
  // re-imposes `code === 0` below; `trusted-fallback` demands a re-derived rejection instead. What both
  // require is that the child TERMINATED with a code at all — a signal death (`code === null`) leaves
  // the turn's shape unprovable.
  if (result.framingFatal) return uncertain(`stdout framing failed: ${result.framingFatal.detail}`);
  if (!result.transportOk) return uncertain("the transport was not sound");
  if (result.code === null) return uncertain("the provider was killed by a signal and never exited with a code");
  if (!result.stdinComplete) return uncertain("the prompt was not delivered whole");
  if (!result.scopeTrusted) return uncertain("the owned process scope was not trusted");

  // ---- 2. the stdin the reservation was BOUND to is the stdin that was DELIVERED ---------------
  const stdinSha = createHash("sha256").update(stdinDelivered).digest("hex");
  if (stdinSha !== bind.stdinSha256 || stdinDelivered.length !== bind.stdinBytes) {
    return uncertain(
      `the delivered stdin (${stdinDelivered.length} bytes, ${stdinSha.slice(0, 12)}…) is not the stdin this call reserved ` +
        `(${bind.stdinBytes} bytes, ${bind.stdinSha256.slice(0, 12)}…)`
    );
  }

  // ---- 3. the ACTUAL scope the provider ran inside, proven empty --------------------------------
  // The scope id must PARSE as a scope this system owns: the strong `cgroup2` membership set the provider
  // was launched into (identified by the cgroup's kernel-assigned inode, its name, and its leader), or the
  // legacy process group. An unstructured/invented id names no scope and can carry no proof.
  const scope = parseScopeId(result.scopeId);
  if (scope === undefined) return uncertain(`the call names no owned process scope (scopeId ${JSON.stringify(result.scopeId ?? null)})`);
  if (result.scopeReaped !== true) return uncertain(`the owned scope ${scopeIdOf(scope)} was not proven empty`);
  // The proof is DERIVED from the identity, so it cannot be detached from the scope it names, moved to
  // another call, or composed for a scope nobody observed. For a cgroup scope it asserts that the kernel
  // removed the cgroup — which `rmdir` permits only when it and every descendant cgroup hold no task —
  // AND that the leader's process group is gone.
  if (result.scopeReapProof !== reapProofOf(scope)) {
    return uncertain(`the reap proof ${JSON.stringify(result.scopeReapProof ?? null)} does not prove scope ${scopeIdOf(scope)} empty`);
  }
  // Probe the scope AGAIN, here, with the LEDGER's own prober — the transport's proof was taken before this
  // function ran, and a scope that came back to life (or was never empty) may not be settled.
  if (access.scopeAlive(scope)) return uncertain(`the owned scope ${scopeIdOf(scope)} is STILL ALIVE`);

  // ---- 4. the durable transcript: confined, ours, and exactly the bytes we streamed -------------
  if (!result.transcriptPath) return uncertain("the call produced no verified durable transcript");
  if (!result.transcriptSha256 || typeof result.transcriptBytes !== "number") {
    return uncertain("the transcript carries no verified hash/byte count");
  }
  let evidence: TranscriptEvidence;
  try {
    evidence = reReadTranscript(access.transcriptRoot, result.transcriptPath, replayProviderKind, adapterIdentity);
  } catch (error) {
    return uncertain(`the durable transcript could not be re-read as confined evidence: ${(error as Error).message}`);
  }
  if (evidence.bytes !== result.transcriptBytes || evidence.sha256 !== result.transcriptSha256) {
    return uncertain(
      `the transcript on disk (${evidence.bytes} bytes, ${evidence.sha256.slice(0, 12)}…) is not the one this call streamed ` +
        `(${result.transcriptBytes} bytes, ${result.transcriptSha256.slice(0, 12)}…) — it was mutated after the turn`
    );
  }

  // ---- 5. the verdict, RE-DERIVED from those bytes, must AGREE with the live one -----------------
  if (evidence.fatal) return uncertain(`replaying the durable transcript went fatal: ${evidence.fatal.detail}`);
  const replayGrammar = adapterIdentity ? adapterEvidenceIdentity(adapterIdentity) : replayProviderKind!;
  const derivedBase = {
    providerKind: replayGrammar,
    scope,
    transcriptDev: evidence.dev,
    transcriptIno: evidence.ino,
    transcriptSha256: evidence.sha256,
    transcriptBytes: evidence.bytes,
    ...(verifiedEgress ? { egress: verifiedEgress } : {})
  };

  /** Present a derived draft to ONE of the ledger's mints. A refusal is never a cheaper outcome: the
   *  ledger appended nothing, so the call must still reach its terminal settlement — the worst case. */
  const mint = (issue: () => void, ok: SettlementOutcome): SettlementOutcome => {
    try {
      issue();
    } catch (error) {
      // The ledger REFUSED (its own re-probe, its own money validation, or a reservation mismatch it
      // checked against the durable reserve record). Nothing was appended, so the call is still open.
      const why = error instanceof MoneyError ? error.message : (error as Error).message;
      let alreadySettled = false;
      try {
        alreadySettled = access.settlementOf(bind.callId).settled;
      } catch {
        // The ledger can no longer answer (poisoned/recovery_required). Re-raise the original refusal:
        // the call stays OUTSTANDING at its worst case, which is the safe direction.
        throw error;
      }
      if (alreadySettled) return { kind: "uncertain", reason: `the ledger refused to attest this call: ${why}` };
      return uncertain(`the ledger refused to attest this call: ${why}`);
    }
    return ok;
  };

  if (adapterIdentity && adapterIdentity.correlation.kind !== "oneshot") {
    const replayedAdapter = evidence.adapterResult;
    const liveAdapter = result.adapterResult;
    if (!replayedAdapter || !liveAdapter) return uncertain("the structured adapter turn produced no settled codec result");
    if (replayedAdapter.status === "uncertain" || liveAdapter.status === "uncertain") {
      return uncertain("the structured adapter codec did not produce a terminal result");
    }
    if (!sameCodecFrame(replayedAdapter.terminalFrame, liveAdapter.terminalFrame)) {
      return uncertain("the structured terminal frame re-derived from the durable transcript is not the one accepted live");
    }
    if (
      replayedAdapter.status !== liveAdapter.status ||
      replayedAdapter.finalText !== liveAdapter.finalText ||
      replayedAdapter.explicitLimit !== liveAdapter.explicitLimit ||
      replayedAdapter.diagnosticsDropped !== liveAdapter.diagnosticsDropped ||
      JSON.stringify(replayedAdapter.usage ?? null) !== JSON.stringify(liveAdapter.usage ?? null)
    ) {
      return uncertain("the structured result re-derived from the durable transcript disagrees with the live codec result");
    }
    const adapterFrame = replayedAdapter.terminalFrame;
    if (adapterFrame.offset + adapterFrame.bytes > evidence.bytes) {
      return uncertain("the structured terminal frame does not lie within the transcript that carries it");
    }
    if (replayedAdapter.status !== "success") {
      return uncertain(`the structured adapter settled ${replayedAdapter.status}; it carries no cost or fallback authority`);
    }
    if (result.code !== 0) return uncertain(`the structured adapter reported success but exited ${result.code}, not 0`);
    const costUsd = replayedAdapter.usage?.costUsd;
    if (costUsd === undefined) return uncertain("the structured adapter reported no durable USD cost");
    let nano: bigint;
    try {
      nano = usdToNano(costUsd, "adapter-reported cost");
    } catch (error) {
      return uncertain(`the adapter-reported cost is not exact fixed-point money: ${(error as Error).message}`);
    }
    const usdNano = formatNano(nano);
    const draft: KernelSettlementDraft = {
      ...derivedBase,
      terminalSha256: adapterFrame.sha256,
      terminalBytes: adapterFrame.bytes,
      terminalOffset: adapterFrame.offset,
      usdNano
    };
    return mint(() => access.attestAndSettle(bind, draft), { kind: "trusted", usd: nanoToUsd(nano), usdNano });
  }

  const replayed = evidence.verdict;
  const live = result.streamedVerdict;
  if (!replayed || !live) return uncertain("the turn produced no whole-stream verdict");
  if (!replayed.hasTerminal) return uncertain("the durable transcript holds no accepted terminal record");
  if (!sameFrame(replayed.terminalFrame, live.terminalFrame)) {
    return uncertain("the terminal frame re-derived from the durable transcript is not the one the live stream accepted");
  }
  if (replayed.success !== live.success || replayed.explicitLimit !== live.explicitLimit || replayed.costReported !== live.costReported || replayed.usd !== live.usd) {
    return uncertain("the verdict re-derived from the durable transcript disagrees with the live one");
  }
  const frame = replayed.terminalFrame!;
  if (frame.offset + frame.bytes > evidence.bytes) {
    return uncertain("the terminal frame does not lie within the transcript that carries it");
  }
  // The evidence every authority is derived from — measurements, not conclusions.
  const derived = derivedBase;
  const terminal = { terminalSha256: frame.sha256, terminalBytes: frame.bytes, terminalOffset: frame.offset };

  // ---- 6a. A GENUINE SUCCESS → `accounted-terminal`: the actual, provider-reported cost ----------
  if (replayed.success) {
    // A success that did not exit 0 is not a success we will pay a lowered price for.
    if (result.code !== 0) return uncertain(`the provider reported success but exited ${result.code}, not 0`);
    if (!replayed.costReported) return uncertain("the terminal record reported no cost (nothing to settle against the worst case)");
    let nano: bigint;
    try {
      nano = usdToNano(replayed.usd, "provider-reported cost"); // NaN/Infinity/negative/over-precise ⇒ throw
    } catch (error) {
      return uncertain(`the provider-reported cost is not exact fixed-point money: ${(error as Error).message}`);
    }
    const usdNano = formatNano(nano);
    const draft: KernelSettlementDraft = { ...derived, ...terminal, usdNano };
    return mint(() => access.attestAndSettle(bind, draft), { kind: "trusted", usd: nanoToUsd(nano), usdNano });
  }

  // ---- 6b. A GENUINE USAGE REJECTION → `trusted-fallback`: the right to bill a SECOND provider ----
  //
  // `explicitLimit` is the production Claude state machine's own conclusion, and it is re-derived HERE
  // from the durable bytes — not read off the live result. It holds ONLY for a clean, session-bound,
  // whitelisted FAILED terminal whose final in-scope pre-terminal `rate_limit_event` carried
  // `rate_limit_info.status === "rejected"`, with no allowed/allowed_warning clearing it, no protocol
  // drift, no foreign session, no duplicate/trailing record, and no malformed snapshot. Everything
  // short of that already left `explicitLimit` false upstream, so it can never arrive here.
  if (!replayed.explicitLimit) {
    return uncertain("the durable transcript holds neither a successful terminal nor a canonical usage rejection");
  }
  // Fallback authority is a CLAUDE-dialect claim. No other provider's state machine may ever set
  // `explicitLimit` (Codex is the fallback and never falls back further), but this is asserted rather
  // than assumed: authority to spend a second provider's money is not inherited by a future dialect.
  if (replayProviderKind !== "claude") return uncertain(`a ${replayProviderKind} turn can never authorize a fallback (only a canonical Claude rejection can)`);
  if (replayed.success) return uncertain("a successful turn can never authorize a fallback");
  // The one durable record that authorizes the fallback must be located in THESE bytes, and it must be
  // the very frame the live stream accepted. A transcript mutated to plant (or to move) a rejection
  // diverges here, because the replayed frame is re-located from the re-read file.
  const limit = replayed.limitFrame;
  if (!limit) return uncertain("the canonical rejection names no `rate_limit_event` frame");
  if (!sameFrame(limit, live.limitFrame)) {
    return uncertain("the `rate_limit_event` frame re-derived from the durable transcript is not the one the live stream accepted");
  }
  if (limit.offset + limit.bytes > evidence.bytes) {
    return uncertain("the `rate_limit_event` frame does not lie within the transcript that carries it");
  }
  // The primary's own COST is settled conservatively: a rejection exits nonzero and its spend is not
  // provable, so the full worst-case reservation is RETAINED (`costProvenance: "unknown"`, nothing
  // charged). Proving a rejection is a strictly separate claim from knowing what the turn cost.
  const fbDraft: KernelFallbackDraft = { ...derived, ...terminal, limitSha256: limit.sha256, limitBytes: limit.bytes, limitOffset: limit.offset };
  return mint(() => access.attestFallbackAndSettle(bind, fbDraft), {
    kind: "trusted-fallback",
    reason: `a canonical Claude usage rejection was re-derived from the durable transcript (rate_limit_event at byte ${limit.offset}); the worst case is retained and a second provider is authorized`
  });
}

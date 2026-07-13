/**
 * Money is an EXACT fixed-point integer, never a float (wave-8d independent audit, B6).
 *
 * The audit's evidence for why:
 *   - ten `$0.01` settlements under a `$0.10` budget produced an effective spend of
 *     `0.09999999999999999`, so an eleventh call was still "under budget";
 *   - 100 further `1e-18` reservations ALL won, while the decimal intent summed to
 *     `0.1000000000000001`;
 *   - `reserveCall(NaN, NaN)` returned true, serialized `null` into the journal, and corrupted the
 *     next fold.
 *
 * Every amount here is an integer count of NANO-USD (1e-9 USD) held as a `bigint` and serialized as a
 * DECIMAL STRING, so the durable record has no float in it at all. Conversion from a JS number goes
 * through the number's exact shortest round-trip decimal (`String(v)`), never through float
 * multiplication — `0.1 * 1e9` is 100000000.00000001, `usdToNano(0.1)` is exactly 100000000n.
 */

export const NANO_PER_USD = 1_000_000_000n;

/** $1e9 in nano-USD. Any budget/cost beyond this is a bug or an attack, not a real number. */
export const MAX_NANO = 1_000_000_000n * NANO_PER_USD;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/** Exponents outside this range cannot describe a real amount and would make `10n ** e` a DoS. */
const MAX_ABS_EXP = 40;

const DECIMAL = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/**
 * Convert an exact decimal string to nano-USD, or throw. Rejects anything finer than one nano-USD
 * rather than rounding it away: silently truncating a positive amount to zero is precisely how a
 * sub-nano reservation "wins" a budget check it should have lost.
 */
function decimalToNano(s: string, what: string): bigint {
  const m = DECIMAL.exec(s);
  if (!m) throw new MoneyError(`${what} is not a valid decimal amount: ${JSON.stringify(s)}`);
  const [, int, frac = "", expStr] = m;
  const exp = expStr ? Number.parseInt(expStr, 10) : 0;
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > MAX_ABS_EXP) {
    throw new MoneyError(`${what} has an out-of-range exponent: ${JSON.stringify(s)}`);
  }
  // value = digits × 10^(exp − frac.length); we want value × 1e9 as an exact integer.
  const digits = `${int}${frac}`;
  const scale = 9 + exp - frac.length;
  let n = BigInt(digits);
  if (scale >= 0) {
    n *= 10n ** BigInt(scale);
  } else {
    const div = 10n ** BigInt(-scale);
    if (n % div !== 0n) {
      throw new MoneyError(`${what} ${s} is finer than 1 nano-USD (over-precision; refusing to round money)`);
    }
    n /= div;
  }
  return n;
}

/**
 * A JS number of USD → exact nano-USD. Rejects NaN, Infinity, negatives, out-of-range values, and
 * over-precision. Call this BEFORE any filesystem mutation: a malformed amount must never reach the
 * journal (the audit serialized `null` for NaN and corrupted the fold behind it).
 */
export function usdToNano(v: unknown, what = "amount"): bigint {
  if (typeof v !== "number") throw new MoneyError(`${what} must be a number (got ${typeof v}: ${String(v)})`);
  if (!Number.isFinite(v)) throw new MoneyError(`${what} must be finite (got ${String(v)})`);
  if (v < 0) throw new MoneyError(`${what} must be non-negative (got ${v})`);
  if (Object.is(v, -0)) return 0n;
  const n = decimalToNano(String(v), what);
  if (n > MAX_NANO) throw new MoneyError(`${what} ${v} exceeds the maximum representable amount`);
  return n;
}

/** A durable decimal string from the journal → nano-USD. A non-canonical or malformed value is
 *  corruption, not a zero. */
export function parseNano(v: unknown, what = "amount"): bigint {
  if (typeof v !== "string" || !/^\d+$/.test(v)) {
    throw new MoneyError(`${what} must be a decimal nano-USD string (got ${JSON.stringify(v)})`);
  }
  const n = BigInt(v);
  if (n > MAX_NANO) throw new MoneyError(`${what} exceeds the maximum representable amount`);
  return n;
}

/** Whether a durable journal value is a well-formed nano-USD string (no throw). */
export function isNanoString(v: unknown): v is string {
  try {
    parseNano(v);
    return true;
  } catch {
    return false;
  }
}

export function formatNano(n: bigint): string {
  return n.toString(10);
}

/** Nano-USD → a USD number, for DISPLAY and legacy numeric APIs only. Never used for a budget
 *  decision: every comparison that gates spend is done in bigint nano-USD. */
export function nanoToUsd(n: bigint): number {
  const whole = n / NANO_PER_USD;
  const frac = n % NANO_PER_USD;
  return Number(whole) + Number(frac) / 1e9;
}

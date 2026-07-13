/**
 * Race two (or more) real processes into the SAME legacy migration. Exactly one must win; every loser
 * must fail closed. Prints one line: `ok <carriedForwardUsd>` or `err <message>`.
 */
import { migrateLegacyV1 } from "../../src/ledger.js";

const [dir, runNonce] = process.argv.slice(2);
try {
  const r = migrateLegacyV1({ dir, runNonce });
  process.stdout.write(`ok ${r.carriedForwardUsd}\n`);
} catch (error) {
  process.stdout.write(`err ${(error && error.message ? error.message : String(error)).split("\n")[0]}\n`);
}

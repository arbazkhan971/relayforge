import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { ConfigDiscoveryError, loadConfig, type LoadedConfig } from "../config/load.js";

export function reportConfigLoadError(error: unknown, asJson: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  const missing = error instanceof ConfigDiscoveryError && error.code === "CONFIG_NOT_FOUND";
  const help = missing
    ? {
        ok: false,
        error: "No RelayForge config found.",
        code: "CONFIG_NOT_FOUND",
        nextSteps: [
          "Run `relayforge init` in this repo.",
          "Run `relayforge auth status` again.",
          "Run `relayforge auth configure --write` to store detected local provider metadata."
        ]
      }
    : {
        ok: false,
        error: message,
        ...(error instanceof ConfigDiscoveryError ? { code: error.code } : {}),
        nextSteps: [
          "Select an exact file with `relayforge --config <path> …` when config discovery is ambiguous.",
          "Fix the keys named above in the selected RelayForge config.",
          "Unknown keys are rejected, never ignored — a removed/renamed option is reported instead of being silently dropped.",
          "Run `relayforge validate` again, then `relayforge doctor`."
        ]
      };
  if (asJson) {
    console.log(JSON.stringify(help, null, 2));
  } else if (missing) {
    console.error("No RelayForge config found (relayforge.config.* or legacy loop.config.*).");
    console.error("");
    console.error("Run:");
    console.error("  relayforge init");
    console.error("  relayforge auth status");
    console.error("  relayforge auth configure --write");
  } else {
    console.error(message);
    console.error("");
    console.error("Select one exact config with --config, or fix it, then run `relayforge validate` again.");
  }
  process.exitCode = 1;
}

export function safeLoadConfig(configPath: string | undefined, asJson: boolean): LoadedConfig | undefined {
  try {
    return loadConfig(configPath);
  } catch (error) {
    reportConfigLoadError(error, asJson);
    return undefined;
  }
}

/** Load config if present, returning undefined instead of throwing when absent. */
export function safeLoadConfigOptional(configPath: string | undefined): LoadedConfig | undefined {
  try {
    return loadConfig(configPath);
  } catch (error) {
    if (error instanceof ConfigDiscoveryError && error.code === "CONFIG_NOT_FOUND") return undefined;
    throw error;
  }
}

/**
 * The run→exit-code contract, in ONE testable place.
 *
 * EXIT 0 means, and may only ever mean, one of two things:
 *   - `done`    — an executed run where EVERY task was accepted AND the final ordered verifier is green;
 *   - `planned` — a clean dry-run (which launches no provider at all).
 *
 * Everything else is a failure and exits non-zero — including `unverified` (every task accepted but
 * nothing ever proved it green), which is the single most dangerous status in the product precisely
 * because it looks like success from the inside: the work is done, the reviewer said yes, the branch
 * is written. It is not success. Neither is a status we do not recognise (a future state, a truncated
 * or unreadable state file, ""), which is why this is an ALLOW-list of the two success states rather
 * than a deny-list of the failures: a new terminal status is a failure until someone deliberately
 * decides otherwise here.
 */
export function runSucceeded(status: unknown): boolean {
  return status === "done" || status === "planned";
}

export function output(data: unknown, asJson: boolean) {
  if (asJson) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.log(formatHuman(data));
}

export function writeIfMissing(path: string, content: string, force: boolean, quiet = false) {
  if (existsSync(path) && !force) {
    if (!quiet) console.log(`Skipped ${path}; already exists.`);
    return;
  }
  writeFileSync(path, content);
}

export function defaultRunId(): string {
  const date = new Date();
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  // Append collision-resistant entropy: a one-second timestamp resolution alone lets two runs
  // started in the same second SHARE a run id (and thus a run dir, lease, board, and health file).
  // The random suffix keeps the id readable AND unique, and stays within the id charset/length.
  return `run-${stamp}-${randomBytes(4).toString("hex")}`;
}

/**
 * Parse a CLI numeric option as a FINITE, POSITIVE, bounded INTEGER, failing closed (throw) on
 * anything else — a NaN/negative/fractional/huge `--lines` or `--interval` must never reach a tmux
 * capture depth or a monitor refresh loop unchecked.
 */
export function parseBoundedInt(value: string | number | undefined, name: string, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max} (got ${JSON.stringify(value)}).`);
  }
  return n;
}

/** The most recently updated run id under a runs directory (by directory mtime), if any. */
export function latestRunId(runsDir: string): string | undefined {
  if (!existsSync(runsDir)) return undefined;
  let best: string | undefined;
  let bestMtime = -1;
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const mtime = statSync(resolve(runsDir, entry.name)).mtimeMs;
    if (mtime > bestMtime) {
      bestMtime = mtime;
      best = entry.name;
    }
  }
  return best;
}

function formatHuman(data: unknown): string {
  if (typeof data !== "object" || data === null) return String(data);
  return JSON.stringify(data, null, 2);
}

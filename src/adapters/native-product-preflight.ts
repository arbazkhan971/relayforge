/**
 * Zero-mutation ordinary-CLI product preflight for structured native adapters.
 *
 * Native adapters (opencode/pi/grok) run under an ordinary
 * `relayforge run --execute` only when the operator has LINKED a credential for
 * them — an API key in the parent environment (selected by `auth.env` when
 * present, else the adapter's canonical key name) or a personal subscription
 * login on the installed CLI (the same LOCAL trust model claude/codex/gemini
 * already use for their subscription mode). With neither, the command is
 * refused while it is still read-only: before run directory, control plane, or
 * worktree creation, so the refusal remains zero-mutation.
 *
 * Dry-run is intentionally inert. Custom/claude/codex/gemini are unchanged.
 * This does not probe paid endpoints, accept unauthenticated env booleans, copy
 * or expand credentials, or weaken the standalone paid characterization
 * collector — release receipts that gate the publishable npm workflow are
 * unchanged and still require the explicit same-runner collector.
 */

import { accessSync, constants } from "node:fs";
import { resolve } from "node:path";
import type { LoopConfig, ProjectConfig } from "../config/schema.js";
import { buildProviderChain } from "../routing.js";
import { containedNativeAdapterIds, isContainedNativeAdapterId, type ContainedNativeAdapterId } from "./contained-evidence.js";

export const NATIVE_ADAPTER_PRODUCT_PREFLIGHT_CODE = "NATIVE_ADAPTER_EVIDENCE_UNAVAILABLE" as const;

export class NativeAdapterProductPreflightError extends Error {
  readonly code = NATIVE_ADAPTER_PRODUCT_PREFLIGHT_CODE;

  constructor(message: string) {
    super(`${NATIVE_ADAPTER_PRODUCT_PREFLIGHT_CODE}: ${message}`);
    this.name = "NativeAdapterProductPreflightError";
  }
}

/** Canonical API-key environment names per native adapter (product credential gate). */
export const ADAPTER_KEY_ENVS: Readonly<Record<ContainedNativeAdapterId, readonly string[]>> = Object.freeze({
  opencode: Object.freeze(["OPENAI_API_KEY"]),
  pi: Object.freeze(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"]),
  grok: Object.freeze(["XAI_API_KEY"])
});

export type NativeAdapterCredentialResult =
  | { ok: true; mode: "subscription" | "api-key"; env?: string }
  | { ok: false; reasons: readonly string[] };

function defaultCliAvailable(adapterId: ContainedNativeAdapterId): boolean {
  // No shell: bash on macOS sources ~/.bashrc even for `bash -c` and can prepend developer
  // directories (fnm, ~/.local/bin) to PATH — exactly the login-shell pollution this project
  // fixed elsewhere. Pure PATH scanning is deterministic, race-free, and fast.
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    try {
      accessSync(resolve(dir, adapterId), constants.X_OK);
      return true;
    } catch {
      // keep scanning
    }
  }
  return false;
}

/** Provider keys that can actually be billed/launched for one selected loop (roles + fallback + P6). */
export function reachableProviderKeysForLoop(project: ProjectConfig, loop: LoopConfig): readonly string[] {
  const keys = new Set<string>();
  const addRoute = (providerKey: string): void => {
    if (!project.providers[providerKey]) return;
    const chain = buildProviderChain(project, providerKey);
    keys.add(chain.primary);
    if (chain.fallback) keys.add(chain.fallback);
  };

  // Every configured role can be dispatched during an ordinary loop turn.
  for (const role of project.roles) addRoute(role.provider);
  // Loop orchestrator/reviewer are always reachable even if roles were mis-filtered elsewhere.
  const orchestrator = project.roles.find((role) => role.name === loop.orchestrator);
  const reviewer = project.roles.find((role) => role.name === loop.reviewer);
  if (orchestrator) addRoute(orchestrator.provider);
  if (reviewer) addRoute(reviewer.provider);

  // P6 multi-repository tasks bind their own provider routes.
  for (const task of project.multiRepository?.tasks ?? []) addRoute(task.provider);

  return Object.freeze([...keys].sort((left, right) => left.localeCompare(right)));
}

/**
 * Decide whether a native adapter has a linked credential on this host.
 * `source` and `cliAvailable` are seams for tests; production uses process.env
 * and a pure PATH scan (never a login shell).
 */
export function nativeAdapterCredentialGate(
  adapterId: ContainedNativeAdapterId,
  provider: ProjectConfig["providers"][string],
  source?: Readonly<Record<string, string | undefined>>,
  cliAvailable?: (adapterId: ContainedNativeAdapterId) => boolean
): NativeAdapterCredentialResult {
  const env = source ?? process.env;
  const hasCli = cliAvailable ? cliAvailable(adapterId) : defaultCliAvailable(adapterId);
  const selected = provider.auth?.env;
  const bounded = (name: string): boolean => {
    const value = env[name];
    return typeof value === "string" && value.length > 0 && !value.includes("\0");
  };

  const requireKey = selected !== undefined || provider.auth?.mode === "api-key";
  if (requireKey) {
    const candidates = selected === undefined ? ADAPTER_KEY_ENVS[adapterId] : [selected];
    const present = candidates.find(bounded);
    if (present !== undefined) return { ok: true, mode: "api-key", env: present };
    return { ok: false, reasons: [`mode is api-key but none of ${candidates.join(" / ")} is set in the parent environment`] };
  }

  // subscription or auto: personal CLI login is the same local trust model as
  // claude/codex/gemini subscription mode. Nothing is probed or uploaded.
  if (hasCli) return { ok: true, mode: "subscription" };

  const keyNames = ADAPTER_KEY_ENVS[adapterId];
  if (keyNames.some(bounded)) return { ok: true, mode: "api-key", env: keyNames.find(bounded) };

  return {
    ok: false,
    reasons: [`${adapterId} CLI is not on PATH (no personal subscription login) and none of ${keyNames.join(" / ")} is set (no linked API key)`]
  };
}

/**
 * Read-only execute preflight. Call before prepareRun. When `execute` is false
 * (dry-run), this is a no-op so planning remains accepted without credentials.
 */
export function assertOrdinaryExecuteNativeAdapterPreflight(
  project: ProjectConfig,
  loop: LoopConfig,
  execute: boolean,
  opts?: {
    source?: Readonly<Record<string, string | undefined>>;
    cliAvailable?: (adapterId: ContainedNativeAdapterId) => boolean;
  }
): void {
  if (!execute) return;

  const refused: Array<{ key: string; type: ContainedNativeAdapterId; reasons: readonly string[] }> = [];
  for (const providerKey of reachableProviderKeysForLoop(project, loop)) {
    const provider = project.providers[providerKey];
    if (!provider || !isContainedNativeAdapterId(provider.type)) continue;
    const gate = nativeAdapterCredentialGate(provider.type, provider, opts?.source, opts?.cliAvailable);
    if (!gate.ok) refused.push({ key: providerKey, type: provider.type, reasons: gate.reasons });
  }
  if (refused.length === 0) return;

  const details = refused
    .map(({ key, type, reasons }) => `${key} (type ${type}): ${reasons.join("; ")}`)
    .join("; ");
  throw new NativeAdapterProductPreflightError(
    `ordinary relayforge run --execute requires a linked credential for structured native adapter(s): ${details}. ` +
      `Refusing before run directory, control plane, or worktree creation. ` +
      `Link a personal subscription by installing and logging into the adapter CLI, or set the matching API key in ` +
      `the parent environment (see \`relayforge doctor\` and \`relayforge auth status\`). ` +
      `Nothing is probed, uploaded, or copied by this check.`
  );
}

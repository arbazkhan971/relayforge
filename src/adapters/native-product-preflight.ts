/**
 * Zero-mutation ordinary-CLI product preflight for structured native adapters.
 *
 * Ordinary `relayforge run --execute` has no consumer that loads contained compatibility evidence
 * into RunContext before prepareRun. Without that evidence path, opencode/pi/grok would create
 * run/control/worktree state and only then refuse at reservation time. This preflight refuses those
 * routes while the command is still read-only.
 *
 * Dry-run is intentionally inert. Custom/claude/codex/gemini are unchanged. This does not probe
 * paid endpoints, accept unauthenticated env booleans, or weaken the standalone characterization
 * collector.
 */

import type { LoopConfig, ProjectConfig } from "../config/schema.js";
import { buildProviderChain } from "../routing.js";
import { containedNativeAdapterIds, isContainedNativeAdapterId } from "./contained-evidence.js";

export const NATIVE_ADAPTER_PRODUCT_PREFLIGHT_CODE = "NATIVE_ADAPTER_EVIDENCE_UNAVAILABLE" as const;

export class NativeAdapterProductPreflightError extends Error {
  readonly code = NATIVE_ADAPTER_PRODUCT_PREFLIGHT_CODE;

  constructor(message: string) {
    super(`${NATIVE_ADAPTER_PRODUCT_PREFLIGHT_CODE}: ${message}`);
    this.name = "NativeAdapterProductPreflightError";
  }
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
 * Read-only execute preflight. Call before prepareRun. When `execute` is false (dry-run), this is a
 * no-op so planning remains accepted without provider evidence.
 */
export function assertOrdinaryExecuteNativeAdapterPreflight(
  project: ProjectConfig,
  loop: LoopConfig,
  execute: boolean
): void {
  if (!execute) return;

  const refused: string[] = [];
  for (const providerKey of reachableProviderKeysForLoop(project, loop)) {
    const provider = project.providers[providerKey];
    if (!provider || !isContainedNativeAdapterId(provider.type)) continue;
    refused.push(`${providerKey} (type ${provider.type})`);
  }
  if (refused.length === 0) return;

  const adapters = containedNativeAdapterIds.join("/");
  throw new NativeAdapterProductPreflightError(
    `ordinary relayforge run --execute has no parent-contained compatibility evidence injection path for structured native adapter(s): ${refused.join(", ")}. ` +
      `Refusing before run directory, control plane, or worktree creation. ` +
      `${adapters} require verified contained evidence produced by the explicit paid characterization collector on a designated runner; ` +
      `they are not launched from unauthenticated env flags or hidden probes. ` +
      `Product injection of contained compatibility evidence is not yet supported for ordinary execute; ` +
      `the explicit paid collector is release characterization only. ` +
      `Use a supported route (claude/codex/gemini/custom) for ordinary execute.`
  );
}

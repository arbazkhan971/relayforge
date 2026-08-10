import { createHash } from "node:crypto";
import { claudeAdapterDescriptor } from "./builtins/claude.js";
import { codexAdapterDescriptor } from "./builtins/codex.js";
import { customAdapterDescriptor } from "./builtins/custom.js";
import { geminiAdapterDescriptor } from "./builtins/gemini.js";
import { grokAdapterDescriptor } from "./builtins/grok.js";
import { opencodeAdapterDescriptor } from "./builtins/opencode.js";
import { piAdapterDescriptor } from "./builtins/pi.js";
import {
  createAdapterRegistry,
  defineAdapterAvailability,
  evaluateAdapterRole
} from "./registry.js";
import type {
  AdapterAvailability,
  AdapterDescriptor,
  AdapterRoleDecision,
  AdapterRoleName
} from "./types.js";

/** The closed set of descriptor IDs accepted by production configuration. */
export const shippedAdapterIds = Object.freeze([
  "claude",
  "codex",
  "custom",
  "gemini",
  "grok",
  "opencode",
  "pi"
] as const);

export type ShippedAdapterId = (typeof shippedAdapterIds)[number];

/**
 * The sole production registry. It is constructed from compile-time descriptors and exposes no
 * registration/mutation surface; configuration can select one of these IDs but cannot add code.
 */
export const shippedAdapterRegistry = createAdapterRegistry([
  claudeAdapterDescriptor,
  codexAdapterDescriptor,
  customAdapterDescriptor,
  geminiAdapterDescriptor,
  grokAdapterDescriptor,
  opencodeAdapterDescriptor,
  piAdapterDescriptor
]);

export function isShippedAdapterId(value: unknown): value is ShippedAdapterId {
  return typeof value === "string" && shippedAdapterRegistry.has(value);
}

/** Typed registry lookup; unknown input is rejected rather than guessed as custom. */
export function getShippedAdapterDescriptor(id: ShippedAdapterId | string): AdapterDescriptor {
  return shippedAdapterRegistry.get(id);
}

export type ShippedAdapterSelection = Readonly<{
  descriptor: AdapterDescriptor;
  availability: AdapterAvailability;
  role: AdapterRoleDecision;
}>;

/**
 * Bind externally produced compatibility evidence to the exact shipped descriptor and role. This
 * remains pure: the trusted parent owns executable resolution, behavioral probes and launch.
 */
export function selectShippedAdapter(input: Readonly<{
  adapterId: ShippedAdapterId | string;
  availability: AdapterAvailability;
  role: AdapterRoleName;
}>): ShippedAdapterSelection {
  const descriptor = getShippedAdapterDescriptor(input.adapterId);
  const availability = defineAdapterAvailability(descriptor, input.availability);
  const role = evaluateAdapterRole(descriptor, availability, input.role);
  return Object.freeze({ descriptor, availability, role });
}

/** Hash every controlled configuration/environment value a native probe and launch may consult. */
export function shippedAdapterConfigSha256(input: Readonly<{
  adapterId: ShippedAdapterId;
  model?: string;
  environment?: Readonly<Record<string, string | undefined>>;
}>): string {
  const descriptor = getShippedAdapterDescriptor(input.adapterId);
  const environment = Object.fromEntries(
    [...descriptor.invocationPolicy.allowedEnvironmentNames]
      .sort()
      .map((name) => [name, input.environment?.[name] ?? null])
  );
  return createHash("sha256").update(JSON.stringify({
    adapterId: descriptor.id,
    contractVersion: descriptor.contractVersion,
    ...(input.model === undefined ? {} : { model: input.model }),
    environment
  })).digest("hex");
}

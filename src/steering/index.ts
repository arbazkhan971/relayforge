/**
 * Public, authority-free steering contracts.
 *
 * Parent mutation services, Unix-socket IPC, raw repository append, capture,
 * recovery/settlement, and orchestrator integration stay package-internal.
 * Consumers receive schema/version constants, pure domain codecs, activity
 * derivation, reducers, and prompt-block rendering only.
 */
export * from "./types.js";
export * from "./schema.js";
export * from "./activity.js";
export * from "./reducer.js";
export * from "./prompt-block.js";

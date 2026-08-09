import type { PersistedControlEvent } from "../control/events.js";
import {
  parsePersistedControlEvent,
  parseSteeringCommand,
  parseSteeringProjection,
  parseSteeringRefusal,
  sameSteeringTarget,
  steeringCommandSemanticDigest
} from "./schema.js";
import {
  STEERING_REDUCER_VERSION,
  STEERING_SCHEMA_VERSION,
  type SteeringCommandRecord,
  type SteeringCommandV1,
  type SteeringProjection,
  type SteeringPromptManifestFact
} from "./types.js";

export const steeringReductionErrorCodes = [
  "MALFORMED_EVENT",
  "UNAUTHORIZED_ACTOR",
  "RUN_IDENTITY_MISMATCH",
  "NON_CONTIGUOUS_SEQUENCE",
  "DUPLICATE_COMMAND",
  "DUPLICATE_MANIFEST",
  "TARGET_MISMATCH",
  "INVALID_TRANSITION",
  "MISSING_COMMAND",
  "MISSING_MANIFEST",
  "PROMPT_BINDING_MISMATCH",
  "CUTOFF_VIOLATION",
  "SUPERSESSION_MISMATCH",
  "EXPIRY_MISMATCH",
  "INVALID_SNAPSHOT"
] as const;
export type SteeringReductionErrorCode = (typeof steeringReductionErrorCodes)[number];

export class SteeringReductionError extends Error {
  readonly code: SteeringReductionErrorCode;
  readonly eventId?: string;

  constructor(code: SteeringReductionErrorCode, message: string, eventId?: string) {
    super(message);
    this.name = "SteeringReductionError";
    this.code = code;
    this.eventId = eventId;
  }
}

export function emptySteeringProjection(runId: string, runEpoch: string): SteeringProjection {
  const candidate = {
    schemaVersion: STEERING_SCHEMA_VERSION,
    reducerVersion: STEERING_REDUCER_VERSION,
    runId,
    runEpoch,
    observedSeq: 0,
    commands: {},
    manifests: {}
  };
  return restoreSteeringProjection(candidate);
}

function parseEvent(value: unknown): PersistedControlEvent {
  try {
    return parsePersistedControlEvent(value);
  } catch (error) {
    throw new SteeringReductionError(
      "MALFORMED_EVENT",
      `invalid persisted control event: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function commandOf(record: SteeringCommandRecord): SteeringCommandV1 | undefined {
  return record.status === "refused" && "refusal" in record ? undefined : record.command;
}

function commandIdOf(record: SteeringCommandRecord): string {
  return record.status === "refused" && "refusal" in record ? record.refusal.commandId : record.command.commandId;
}

function targetMatchesEvent(
  command: Pick<SteeringCommandV1, "runId" | "runEpoch" | "taskId" | "taskGeneration" | "sessionId" | "sessionGeneration">,
  event: PersistedControlEvent & { payload: { sessionId: string; sessionGeneration: number } }
): boolean {
  return command.runId === event.runId &&
    command.runEpoch === event.runEpoch &&
    command.taskId === event.taskId &&
    command.taskGeneration === event.taskGeneration &&
    command.sessionId === event.payload.sessionId &&
    command.sessionGeneration === event.payload.sessionGeneration;
}

function manifestContaining(projection: SteeringProjection, commandId: string): SteeringPromptManifestFact | undefined {
  return Object.values(projection.manifests).find((manifest) => manifest.steeringCommandIds.includes(commandId));
}

function incompletePromptBinding(
  projection: SteeringProjection
): { manifest: SteeringPromptManifestFact; nextCommandId: string; nextIndex: number } | undefined {
  let incomplete: { manifest: SteeringPromptManifestFact; nextCommandId: string; nextIndex: number } | undefined;
  for (const manifest of Object.values(projection.manifests)) {
    const nextIndex = manifest.steeringCommandIds.findIndex(
      (commandId) => projection.commands[commandId]?.status === "pending"
    );
    if (nextIndex < 0) continue;
    if (incomplete) {
      throw new SteeringReductionError("INVALID_SNAPSHOT", "multiple prompt manifests have incomplete command bindings");
    }
    incomplete = { manifest, nextCommandId: manifest.steeringCommandIds[nextIndex]!, nextIndex };
  }
  return incomplete;
}

function assertAuthorizedActor(event: PersistedControlEvent): void {
  const allowed = (() => {
    switch (event.type) {
      case "attempt.prompt_prepared":
      case "steering.command_included":
      case "steering.command_expired":
        return event.actorKind === "control-plane" || event.actorKind === "system";
      case "steering.command_admitted":
      case "steering.command_refused":
      case "steering.command_terminal_refused":
      case "steering.command_withdrawn":
      case "steering.command_superseded":
        return event.actorKind === "control-plane" || event.actorKind === "operator";
      default:
        return true;
    }
  })();
  if (!allowed) {
    throw new SteeringReductionError(
      "UNAUTHORIZED_ACTOR",
      `${event.actorKind} cannot author ${event.type}`,
      event.eventId
    );
  }
}

function requirePending(
  projection: SteeringProjection,
  commandId: string,
  eventId: string
): Extract<SteeringCommandRecord, { status: "pending" }> {
  const record = projection.commands[commandId];
  if (!record) throw new SteeringReductionError("MISSING_COMMAND", `steering command ${commandId} does not exist`, eventId);
  if (record.status !== "pending") {
    throw new SteeringReductionError(
      "INVALID_TRANSITION",
      `steering command ${commandId} is terminal (${record.status})`,
      eventId
    );
  }
  return record;
}

function assertUnreserved(projection: SteeringProjection, commandId: string, eventId: string): void {
  const manifest = manifestContaining(projection, commandId);
  if (manifest) {
    throw new SteeringReductionError(
      "INVALID_TRANSITION",
      `steering command ${commandId} is already bound to prompt ${manifest.attemptId}`,
      eventId
    );
  }
}

function assertEventTarget(command: SteeringCommandV1, event: PersistedControlEvent, eventId: string): void {
  if (!("sessionId" in event.payload) || !("sessionGeneration" in event.payload) || !targetMatchesEvent(command, event as PersistedControlEvent & {
    payload: { sessionId: string; sessionGeneration: number };
  })) {
    throw new SteeringReductionError("TARGET_MISMATCH", `steering command ${command.commandId} target changed`, eventId);
  }
}

function applyPrepared(projection: SteeringProjection, event: Extract<PersistedControlEvent, { type: "attempt.prompt_prepared" }>): void {
  const payload = event.payload;
  if (projection.manifests[payload.attemptId]) {
    throw new SteeringReductionError("DUPLICATE_MANIFEST", `attempt prompt ${payload.attemptId} already exists`, event.eventId);
  }
  if (payload.captureCutoffSeq !== event.seq - 1) {
    throw new SteeringReductionError(
      "CUTOFF_VIOLATION",
      `attempt ${payload.attemptId} cutoff must equal the pre-transaction head ${event.seq - 1}`,
      event.eventId
    );
  }
  if (new Set(payload.steeringCommandIds).size !== payload.steeringCommandIds.length) {
    throw new SteeringReductionError("PROMPT_BINDING_MISMATCH", "prompt manifest repeats a command ID", event.eventId);
  }
  const priorGeneration = Object.values(projection.manifests).find(
    (manifest) => manifest.taskId === event.taskId &&
      manifest.taskGeneration === event.taskGeneration &&
      manifest.sessionId === payload.sessionId &&
      manifest.sessionGeneration === payload.sessionGeneration &&
      manifest.attemptGeneration === payload.attemptGeneration
  );
  if (priorGeneration) {
    throw new SteeringReductionError(
      "DUPLICATE_MANIFEST",
      `attempt generation ${payload.attemptGeneration} is already bound to ${priorGeneration.attemptId}`,
      event.eventId
    );
  }

  const selected = payload.steeringCommandIds.map((commandId) => {
    const record = requirePending(projection, commandId, event.eventId);
    assertUnreserved(projection, commandId, event.eventId);
    assertEventTarget(record.command, event, event.eventId);
    if (record.command.notBeforeAttemptGeneration > payload.attemptGeneration) {
      throw new SteeringReductionError(
        "CUTOFF_VIOLATION",
        `steering command ${commandId} is not eligible until attempt ${record.command.notBeforeAttemptGeneration}`,
        event.eventId
      );
    }
    if (record.admittedSeq > payload.captureCutoffSeq) {
      throw new SteeringReductionError(
        "CUTOFF_VIOLATION",
        `steering command ${commandId} was admitted after capture cutoff ${payload.captureCutoffSeq}`,
        event.eventId
      );
    }
    if (record.command.expiresAt && Date.parse(record.command.expiresAt) <= Date.parse(event.occurredAt)) {
      throw new SteeringReductionError(
        "EXPIRY_MISMATCH",
        `steering command ${commandId} expired before prompt capture`,
        event.eventId
      );
    }
    return record;
  });
  const canonicalIds = [...selected]
    .sort((left, right) => left.admittedSeq - right.admittedSeq || left.command.commandId.localeCompare(right.command.commandId))
    .map((record) => record.command.commandId);
  if (canonicalIds.some((commandId, index) => commandId !== payload.steeringCommandIds[index])) {
    throw new SteeringReductionError(
      "PROMPT_BINDING_MISMATCH",
      "prompt manifest command IDs are not in canonical admission order",
      event.eventId
    );
  }
  projection.manifests[payload.attemptId] = {
    attemptId: payload.attemptId,
    attemptGeneration: payload.attemptGeneration,
    runId: event.runId,
    runEpoch: event.runEpoch,
    taskId: event.taskId!,
    taskGeneration: event.taskGeneration!,
    sessionId: payload.sessionId,
    sessionGeneration: payload.sessionGeneration,
    artifactLocator: payload.artifactLocator,
    promptSha256: payload.promptSha256,
    promptBytes: payload.promptBytes,
    rendererVersion: payload.rendererVersion,
    captureCutoffSeq: payload.captureCutoffSeq,
    steeringCommandIds: [...payload.steeringCommandIds],
    preparedSeq: event.seq
  };
}

function applyAdmitted(projection: SteeringProjection, event: Extract<PersistedControlEvent, { type: "steering.command_admitted" }>): void {
  const payload = event.payload;
  if (projection.commands[payload.commandId]) {
    throw new SteeringReductionError("DUPLICATE_COMMAND", `steering command ${payload.commandId} already exists`, event.eventId);
  }
  const command = parseSteeringCommand({
    schemaVersion: STEERING_SCHEMA_VERSION,
    commandId: payload.commandId,
    runId: event.runId,
    runEpoch: event.runEpoch,
    taskId: event.taskId,
    taskGeneration: event.taskGeneration,
    sessionId: payload.sessionId,
    sessionGeneration: payload.sessionGeneration,
    notBeforeAttemptGeneration: payload.notBeforeAttemptGeneration,
    kind: payload.kind,
    sourceKind: payload.sourceKind,
    parentPrincipal: payload.parentPrincipal,
    evidenceRefs: payload.evidenceRefs,
    body: payload.body,
    bodySha256: payload.bodySha256,
    createdAt: payload.createdAt,
    expiresAt: payload.expiresAt,
    supersedesCommandId: payload.supersedesCommandId
  });
  if (command.body !== payload.body) {
    throw new SteeringReductionError("MALFORMED_EVENT", "admitted steering body is not canonically line-normalized", event.eventId);
  }
  assertEventTarget(command, event, event.eventId);
  if (command.expiresAt && Date.parse(command.expiresAt) <= Date.parse(event.occurredAt)) {
    throw new SteeringReductionError("EXPIRY_MISMATCH", "an already-expired steering command cannot be admitted", event.eventId);
  }
  if (command.supersedesCommandId) {
    const old = requirePending(projection, command.supersedesCommandId, event.eventId);
    assertUnreserved(projection, command.supersedesCommandId, event.eventId);
    if (!sameSteeringTarget(command, old.command)) {
      throw new SteeringReductionError(
        "SUPERSESSION_MISMATCH",
        `replacement ${command.commandId} does not share the superseded command target`,
        event.eventId
      );
    }
  }
  projection.commands[command.commandId] = { status: "pending", command, admittedSeq: event.seq };
}

function applyRefused(projection: SteeringProjection, event: Extract<PersistedControlEvent, { type: "steering.command_refused" }>): void {
  const payload = event.payload;
  if (projection.commands[payload.commandId]) {
    throw new SteeringReductionError("DUPLICATE_COMMAND", `steering command ${payload.commandId} already exists`, event.eventId);
  }
  const refusal = parseSteeringRefusal({
    schemaVersion: STEERING_SCHEMA_VERSION,
    commandId: payload.commandId,
    runId: event.runId,
    runEpoch: event.runEpoch,
    taskId: event.taskId,
    taskGeneration: event.taskGeneration,
    sessionId: payload.sessionId,
    sessionGeneration: payload.sessionGeneration,
    bodySha256: payload.bodySha256,
    requestSemanticDigest: payload.requestSemanticDigest,
    observedSeq: payload.observedSeq,
    observedActivity: payload.observedActivity,
    reasonCode: payload.reasonCode
  });
  projection.commands[refusal.commandId] = { status: "refused", refusal, terminalSeq: event.seq };
}

function applyTerminalRefused(
  projection: SteeringProjection,
  event: Extract<PersistedControlEvent, { type: "steering.command_terminal_refused" }>
): void {
  const payload = event.payload;
  const record = requirePending(projection, payload.commandId, event.eventId);
  assertUnreserved(projection, payload.commandId, event.eventId);
  assertEventTarget(record.command, event, event.eventId);
  const semanticDigest = steeringCommandSemanticDigest(record.command);
  if (payload.requestSemanticDigest !== semanticDigest) {
    throw new SteeringReductionError("PROMPT_BINDING_MISMATCH", `terminal refusal digest for ${payload.commandId} does not match the admitted command`, event.eventId);
  }
  if (payload.observedSeq > event.seq - 1) {
    throw new SteeringReductionError("CUTOFF_VIOLATION", `terminal refusal for ${payload.commandId} observes a future sequence`, event.eventId);
  }
  projection.commands[payload.commandId] = {
    status: "refused",
    command: structuredClone(record.command),
    admittedSeq: record.admittedSeq,
    terminalSeq: event.seq,
    terminalRefusal: {
      requestSemanticDigest: payload.requestSemanticDigest,
      observedSeq: payload.observedSeq,
      observedActivity: payload.observedActivity,
      reasonCode: payload.reasonCode
    }
  };
}

function applyIncluded(projection: SteeringProjection, event: Extract<PersistedControlEvent, { type: "steering.command_included" }>): void {
  const payload = event.payload;
  const record = requirePending(projection, payload.commandId, event.eventId);
  assertEventTarget(record.command, event, event.eventId);
  const manifest = projection.manifests[payload.attemptId];
  if (!manifest) {
    throw new SteeringReductionError("MISSING_MANIFEST", `attempt prompt ${payload.attemptId} does not exist`, event.eventId);
  }
  if (
    manifest.runId !== event.runId ||
    manifest.runEpoch !== event.runEpoch ||
    manifest.taskId !== event.taskId ||
    manifest.taskGeneration !== event.taskGeneration ||
    manifest.sessionId !== payload.sessionId ||
    manifest.sessionGeneration !== payload.sessionGeneration ||
    manifest.attemptGeneration !== payload.attemptGeneration ||
    manifest.promptSha256 !== payload.promptSha256 ||
    !manifest.steeringCommandIds.includes(payload.commandId)
  ) {
    throw new SteeringReductionError(
      "PROMPT_BINDING_MISMATCH",
      `steering command ${payload.commandId} does not match prepared prompt ${payload.attemptId}`,
      event.eventId
    );
  }
  if (record.admittedSeq > manifest.captureCutoffSeq) {
    throw new SteeringReductionError("CUTOFF_VIOLATION", `steering command ${payload.commandId} crossed its prompt cutoff`, event.eventId);
  }
  const index = manifest.steeringCommandIds.indexOf(payload.commandId);
  if (event.seq !== manifest.preparedSeq + index + 1) {
    throw new SteeringReductionError(
      "PROMPT_BINDING_MISMATCH",
      `steering command ${payload.commandId} inclusion is not contiguous with its prepared prompt`,
      event.eventId
    );
  }
  projection.commands[payload.commandId] = {
    status: "included",
    command: record.command,
    admittedSeq: record.admittedSeq,
    terminalSeq: event.seq,
    attemptId: manifest.attemptId,
    attemptGeneration: manifest.attemptGeneration,
    promptSha256: manifest.promptSha256
  };
}

function applyWithdrawn(projection: SteeringProjection, event: Extract<PersistedControlEvent, { type: "steering.command_withdrawn" }>): void {
  const record = requirePending(projection, event.payload.commandId, event.eventId);
  assertUnreserved(projection, event.payload.commandId, event.eventId);
  assertEventTarget(record.command, event, event.eventId);
  projection.commands[event.payload.commandId] = {
    status: "withdrawn",
    command: record.command,
    admittedSeq: record.admittedSeq,
    terminalSeq: event.seq,
    reason: event.payload.reason
  };
}

function applySuperseded(projection: SteeringProjection, event: Extract<PersistedControlEvent, { type: "steering.command_superseded" }>): void {
  const old = requirePending(projection, event.payload.commandId, event.eventId);
  assertUnreserved(projection, event.payload.commandId, event.eventId);
  assertEventTarget(old.command, event, event.eventId);
  const replacement = requirePending(projection, event.payload.byCommandId, event.eventId);
  if (replacement.command.supersedesCommandId !== old.command.commandId || !sameSteeringTarget(old.command, replacement.command)) {
    throw new SteeringReductionError(
      "SUPERSESSION_MISMATCH",
      `replacement ${replacement.command.commandId} does not link back to ${old.command.commandId}`,
      event.eventId
    );
  }
  projection.commands[old.command.commandId] = {
    status: "superseded",
    command: old.command,
    admittedSeq: old.admittedSeq,
    terminalSeq: event.seq,
    byCommandId: replacement.command.commandId
  };
}

function applyExpired(projection: SteeringProjection, event: Extract<PersistedControlEvent, { type: "steering.command_expired" }>): void {
  const record = requirePending(projection, event.payload.commandId, event.eventId);
  assertUnreserved(projection, event.payload.commandId, event.eventId);
  assertEventTarget(record.command, event, event.eventId);
  if (!record.command.expiresAt || Date.parse(event.occurredAt) < Date.parse(record.command.expiresAt)) {
    throw new SteeringReductionError(
      "EXPIRY_MISMATCH",
      `steering command ${record.command.commandId} has not reached an explicit expiry`,
      event.eventId
    );
  }
  projection.commands[record.command.commandId] = {
    status: "expired",
    command: record.command,
    admittedSeq: record.admittedSeq,
    terminalSeq: event.seq
  };
}

/** Applies one canonical P1 event, advancing observed sequence even when it is unrelated to P2. */
export function applySteeringEvent(current: SteeringProjection, value: PersistedControlEvent | unknown): SteeringProjection {
  const projection = restoreSteeringProjection(current);
  const event = parseEvent(value);
  if (event.runId !== projection.runId || event.runEpoch !== projection.runEpoch) {
    throw new SteeringReductionError("RUN_IDENTITY_MISMATCH", "event run identity does not match steering projection", event.eventId);
  }
  if (event.seq !== projection.observedSeq + 1) {
    throw new SteeringReductionError(
      "NON_CONTIGUOUS_SEQUENCE",
      `non-contiguous event sequence ${event.seq}; expected ${projection.observedSeq + 1}`,
      event.eventId
    );
  }

  assertAuthorizedActor(event);
  const incomplete = incompletePromptBinding(projection);
  if (incomplete && !(
    event.type === "steering.command_included" &&
    event.payload.attemptId === incomplete.manifest.attemptId &&
    event.payload.commandId === incomplete.nextCommandId
  )) {
    throw new SteeringReductionError(
      "PROMPT_BINDING_MISMATCH",
      `prompt ${incomplete.manifest.attemptId} requires contiguous inclusion of ${incomplete.nextCommandId}`,
      event.eventId
    );
  }

  try {
    switch (event.type) {
      case "attempt.prompt_prepared":
        applyPrepared(projection, event);
        break;
      case "steering.command_admitted":
        applyAdmitted(projection, event);
        break;
      case "steering.command_refused":
        applyRefused(projection, event);
        break;
      case "steering.command_terminal_refused":
        applyTerminalRefused(projection, event);
        break;
      case "steering.command_included":
        applyIncluded(projection, event);
        break;
      case "steering.command_withdrawn":
        applyWithdrawn(projection, event);
        break;
      case "steering.command_superseded":
        applySuperseded(projection, event);
        break;
      case "steering.command_expired":
        applyExpired(projection, event);
        break;
      default:
        break;
    }
  } catch (error) {
    if (error instanceof SteeringReductionError) throw error;
    throw new SteeringReductionError(
      "MALFORMED_EVENT",
      `invalid ${event.type} payload: ${error instanceof Error ? error.message : String(error)}`,
      event.eventId
    );
  }
  projection.observedSeq = event.seq;
  return projection;
}

export function reduceSteeringEvents(
  runId: string,
  runEpoch: string,
  events: readonly (PersistedControlEvent | unknown)[],
  initial?: SteeringProjection | unknown
): SteeringProjection {
  let projection = initial === undefined ? emptySteeringProjection(runId, runEpoch) : restoreSteeringProjection(initial);
  if (projection.runId !== runId || projection.runEpoch !== runEpoch) {
    throw new SteeringReductionError("RUN_IDENTITY_MISMATCH", "snapshot run identity does not match replay target");
  }
  for (const event of events) projection = applySteeringEvent(projection, event);
  return projection;
}

export function restoreSteeringProjection(value: unknown): SteeringProjection {
  let projection: SteeringProjection;
  try {
    projection = parseSteeringProjection(value);
  } catch (error) {
    throw new SteeringReductionError(
      "INVALID_SNAPSHOT",
      `invalid steering snapshot: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const cloned = structuredClone(projection);
  assertSteeringProjectionConsistent(cloned);
  return cloned;
}

export function assertSteeringProjectionConsistent(
  projection: SteeringProjection,
  options: { requireCompleteBindings?: boolean } = {}
): void {
  const manifestByCommand = new Map<string, SteeringPromptManifestFact>();
  for (const manifest of Object.values(projection.manifests)) {
    if (manifest.runId !== projection.runId || manifest.runEpoch !== projection.runEpoch) {
      throw new SteeringReductionError("INVALID_SNAPSHOT", `manifest ${manifest.attemptId} has the wrong run identity`);
    }
    for (const commandId of manifest.steeringCommandIds) {
      if (manifestByCommand.has(commandId)) {
        throw new SteeringReductionError("INVALID_SNAPSHOT", `command ${commandId} is bound to multiple prompt manifests`);
      }
      manifestByCommand.set(commandId, manifest);
      const record = projection.commands[commandId];
      if (!record || (record.status === "refused" && "refusal" in record)) {
        throw new SteeringReductionError("INVALID_SNAPSHOT", `manifest ${manifest.attemptId} names a missing admitted command ${commandId}`);
      }
      if (!sameSteeringTarget(record.command, manifest)) {
        throw new SteeringReductionError("INVALID_SNAPSHOT", `manifest ${manifest.attemptId} target differs from command ${commandId}`);
      }
      if (record.status !== "pending" && record.status !== "included") {
        throw new SteeringReductionError("INVALID_SNAPSHOT", `manifest ${manifest.attemptId} has a non-included terminal command ${commandId}`);
      }
      if (record.admittedSeq > manifest.captureCutoffSeq || record.command.notBeforeAttemptGeneration > manifest.attemptGeneration) {
        throw new SteeringReductionError("INVALID_SNAPSHOT", `manifest ${manifest.attemptId} contains an ineligible command ${commandId}`);
      }
      if (record.status === "included" && (
        record.attemptId !== manifest.attemptId ||
        record.attemptGeneration !== manifest.attemptGeneration ||
        record.promptSha256 !== manifest.promptSha256
      )) {
        throw new SteeringReductionError("INVALID_SNAPSHOT", `included command ${commandId} has inconsistent prompt proof`);
      }
      const index = manifest.steeringCommandIds.indexOf(commandId);
      if (record.status === "included" && record.terminalSeq !== manifest.preparedSeq + index + 1) {
        throw new SteeringReductionError("INVALID_SNAPSHOT", `included command ${commandId} is not contiguous with its manifest`);
      }
      if (options.requireCompleteBindings && record.status !== "included") {
        throw new SteeringReductionError("INVALID_SNAPSHOT", `manifest ${manifest.attemptId} has an incomplete command binding ${commandId}`);
      }
    }
    const canonicalIds = manifest.steeringCommandIds
      .map((commandId) => projection.commands[commandId])
      .filter((record): record is Exclude<SteeringCommandRecord, { status: "refused"; refusal: unknown }> => record !== undefined && !(record.status === "refused" && "refusal" in record))
      .sort((left, right) => left.admittedSeq - right.admittedSeq || commandIdOf(left).localeCompare(commandIdOf(right)))
      .map(commandIdOf);
    if (canonicalIds.some((commandId, index) => commandId !== manifest.steeringCommandIds[index])) {
      throw new SteeringReductionError("INVALID_SNAPSHOT", `manifest ${manifest.attemptId} command order is not canonical`);
    }
  }

  incompletePromptBinding(projection);

  for (const [mapId, record] of Object.entries(projection.commands)) {
    if (mapId !== commandIdOf(record)) {
      throw new SteeringReductionError("INVALID_SNAPSHOT", `command map key ${mapId} differs from its record identity`);
    }
    const command = commandOf(record);
    if (command && (command.runId !== projection.runId || command.runEpoch !== projection.runEpoch)) {
      throw new SteeringReductionError("INVALID_SNAPSHOT", `command ${mapId} has the wrong run identity`);
    }
    if (record.status === "refused" && "refusal" in record && (
      record.refusal.runId !== projection.runId || record.refusal.runEpoch !== projection.runEpoch
    )) {
      throw new SteeringReductionError("INVALID_SNAPSHOT", `refusal ${mapId} has the wrong run identity`);
    }
    if (record.status === "included" && !manifestByCommand.has(mapId)) {
      throw new SteeringReductionError("INVALID_SNAPSHOT", `included command ${mapId} has no prompt manifest`);
    }
    if (record.status === "superseded") {
      const replacement = projection.commands[record.byCommandId];
      const replacementCommand = replacement && commandOf(replacement);
      if (!replacementCommand || replacementCommand.supersedesCommandId !== mapId || !sameSteeringTarget(record.command, replacementCommand)) {
        throw new SteeringReductionError("INVALID_SNAPSHOT", `superseded command ${mapId} has no valid replacement`);
      }
    }
    if (record.status === "expired" && !record.command.expiresAt) {
      throw new SteeringReductionError("INVALID_SNAPSHOT", `expired command ${mapId} has no expiry`);
    }
  }
}

export function pendingSteeringCommands(projection: SteeringProjection): SteeringCommandV1[] {
  const reserved = new Set(Object.values(projection.manifests).flatMap((manifest) => manifest.steeringCommandIds));
  return Object.values(projection.commands)
    .filter((record): record is Extract<SteeringCommandRecord, { status: "pending" }> => record.status === "pending")
    .filter((record) => !reserved.has(record.command.commandId))
    .sort((left, right) => left.admittedSeq - right.admittedSeq || left.command.commandId.localeCompare(right.command.commandId))
    .map((record) => structuredClone(record.command));
}

export function canonicalSteeringProjectionValue(projection: SteeringProjection): unknown {
  const restored = restoreSteeringProjection(projection);
  return {
    schemaVersion: restored.schemaVersion,
    reducerVersion: restored.reducerVersion,
    runId: restored.runId,
    runEpoch: restored.runEpoch,
    observedSeq: restored.observedSeq,
    commands: Object.fromEntries(Object.entries(restored.commands).sort(([left], [right]) => left.localeCompare(right))),
    manifests: Object.fromEntries(Object.entries(restored.manifests).sort(([left], [right]) => left.localeCompare(right)))
  };
}

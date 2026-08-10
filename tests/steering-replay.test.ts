import { describe, expect, it } from "vitest";
import {
  controlEventDigest,
  parseControlEvent,
  persistedControlEventDigest,
  sha256Text,
  type ControlEvent,
  type PersistedControlEvent
} from "../src/control/events.js";
import {
  applySteeringEvent,
  assertSteeringProjectionConsistent,
  canonicalSteeringProjectionValue,
  emptySteeringProjection,
  pendingSteeringCommands,
  reduceSteeringEvents,
  restoreSteeringProjection,
  SteeringReductionError
} from "../src/steering/reducer.js";

const NOW = "2026-08-09T00:00:00.000Z";
const LATER = "2026-08-09T00:02:00.000Z";
const PROMPT_HASH = "a".repeat(64);

function commandId(index: number): string {
  return `01890f9d-0000-7000-8000-${index.toString(16).padStart(12, "0")}`;
}

type EventOverrides = Partial<Omit<ControlEvent, "type" | "payload">>;
let eventOrdinal = 0;

function controlEvent(type: string, payload: unknown, overrides: EventOverrides = {}): ControlEvent {
  return parseControlEvent({
    schemaVersion: 1,
    eventId: `event-${++eventOrdinal}-${type.replaceAll(".", "-")}`,
    runId: "run-1",
    runEpoch: "epoch-1",
    taskId: type === "message.posted" ? null : "task-1",
    taskGeneration: type === "message.posted" ? null : 1,
    expectedVersion: 0,
    occurredAt: NOW,
    actorKind: "control-plane",
    actorId: "parent",
    sourceKind: null,
    sourceId: null,
    sourceGeneration: null,
    sourceEventId: null,
    type,
    payload,
    ...overrides
  });
}

function persist(event: ControlEvent, seq: number): PersistedControlEvent {
  return {
    ...event,
    seq,
    recordedAt: event.occurredAt,
    intentDigest: controlEventDigest(event),
    digest: persistedControlEventDigest(event, event.occurredAt)
  };
}

function repersist(event: PersistedControlEvent, seq: number, overrides: Record<string, unknown>): PersistedControlEvent {
  const { seq: _seq, recordedAt: _recordedAt, intentDigest: _intentDigest, digest: _digest, ...source } = event;
  return persist(parseControlEvent({ ...source, ...overrides }), seq);
}

function unrelated(seq: number): PersistedControlEvent {
  return persist(controlEvent("message.posted", {
    messageId: `message-${seq}`,
    from: "parent",
    to: "dev",
    body: "informational context only"
  }), seq);
}

function admitted(
  index: number,
  seq: number,
  options: { supersedes?: number; expiresAt?: string; taskId?: string; sessionGeneration?: number; notBefore?: number } = {}
): PersistedControlEvent {
  const body = `instruction ${index}`;
  return persist(controlEvent("steering.command_admitted", {
    commandId: commandId(index),
    sessionId: "session-1",
    sessionGeneration: options.sessionGeneration ?? 1,
    notBeforeAttemptGeneration: options.notBefore ?? 1,
    kind: "steer_next_boundary",
    sourceKind: "control_plane",
    parentPrincipal: "parent",
    evidenceRefs: [],
    body,
    bodySha256: sha256Text(body),
    createdAt: NOW,
    expiresAt: options.expiresAt,
    supersedesCommandId: options.supersedes === undefined ? undefined : commandId(options.supersedes)
  }, options.taskId ? { taskId: options.taskId } : {}), seq);
}

function refused(index: number, seq: number): PersistedControlEvent {
  return persist(controlEvent("steering.command_refused", {
    commandId: commandId(index),
    sessionId: "session-1",
    sessionGeneration: 1,
    bodySha256: sha256Text(`instruction ${index}`),
    requestSemanticDigest: sha256Text(`request ${index}`),
    observedSeq: seq - 1,
    observedActivity: "blocked",
    reasonCode: "SESSION_BLOCKED"
  }), seq);
}

function superseded(oldIndex: number, replacementIndex: number, seq: number): PersistedControlEvent {
  return persist(controlEvent("steering.command_superseded", {
    commandId: commandId(oldIndex),
    sessionId: "session-1",
    sessionGeneration: 1,
    byCommandId: commandId(replacementIndex)
  }), seq);
}

function prepared(commandIndexes: number[], seq: number, overrides: Record<string, unknown> = {}): PersistedControlEvent {
  return persist(controlEvent("attempt.prompt_prepared", {
    attemptId: "attempt-1",
    attemptGeneration: 1,
    sessionId: "session-1",
    sessionGeneration: 1,
    artifactLocator: "steering/prompts/attempt-1.prompt",
    promptSha256: PROMPT_HASH,
    promptBytes: 128,
    rendererVersion: 1,
    captureCutoffSeq: seq - 1,
    steeringCommandIds: commandIndexes.map(commandId),
    ...overrides
  }), seq);
}

function included(index: number, seq: number, overrides: Record<string, unknown> = {}): PersistedControlEvent {
  return persist(controlEvent("steering.command_included", {
    commandId: commandId(index),
    sessionId: "session-1",
    sessionGeneration: 1,
    attemptId: "attempt-1",
    attemptGeneration: 1,
    promptSha256: PROMPT_HASH,
    ...overrides
  }), seq);
}

function withdrawn(index: number, seq: number): PersistedControlEvent {
  return persist(controlEvent("steering.command_withdrawn", {
    commandId: commandId(index),
    sessionId: "session-1",
    sessionGeneration: 1,
    reason: "operator changed direction"
  }, { occurredAt: LATER }), seq);
}

function expired(index: number, seq: number): PersistedControlEvent {
  return persist(controlEvent("steering.command_expired", {
    commandId: commandId(index),
    sessionId: "session-1",
    sessionGeneration: 1
  }, { occurredAt: LATER }), seq);
}

function completeHistory(): PersistedControlEvent[] {
  return [
    unrelated(1),
    admitted(1, 2),
    admitted(2, 3, { supersedes: 1 }),
    superseded(1, 2, 4),
    prepared([2], 5),
    included(2, 6),
    refused(3, 7),
    admitted(4, 8, { expiresAt: "2026-08-09T00:01:00.000Z" }),
    expired(4, 9),
    admitted(5, 10),
    withdrawn(5, 11),
    admitted(7, 12),
    admitted(6, 13)
  ];
}

describe("steering lifecycle replay reducer", () => {
  it("folds admitted/refused/superseded/included/expired/withdrawn facts without relabeling inclusion", () => {
    const projection = reduceSteeringEvents("run-1", "epoch-1", completeHistory());
    expect(projection.observedSeq).toBe(13);
    expect(projection.commands[commandId(1)]).toMatchObject({ status: "superseded", byCommandId: commandId(2), terminalSeq: 4 });
    expect(projection.commands[commandId(2)]).toMatchObject({
      status: "included",
      attemptId: "attempt-1",
      attemptGeneration: 1,
      promptSha256: PROMPT_HASH,
      terminalSeq: 6
    });
    expect(projection.commands[commandId(3)]).toMatchObject({
      status: "refused",
      terminalSeq: 7,
      refusal: { reasonCode: "SESSION_BLOCKED" }
    });
    expect(projection.commands[commandId(4)]).toMatchObject({ status: "expired", terminalSeq: 9 });
    expect(projection.commands[commandId(5)]).toMatchObject({ status: "withdrawn", terminalSeq: 11 });
    expect(projection.commands[commandId(2)]).not.toHaveProperty("delivered");
    expect(pendingSteeringCommands(projection).map((command) => command.commandId)).toEqual([commandId(7), commandId(6)]);
    expect(() => assertSteeringProjectionConsistent(projection, { requireCompleteBindings: true })).not.toThrow();
  });

  it("is deterministic for every replay prefix and every snapshot-plus-suffix split", () => {
    const history = completeHistory();
    const expected = reduceSteeringEvents("run-1", "epoch-1", history);
    let incremental = emptySteeringProjection("run-1", "epoch-1");
    for (const [index, event] of history.entries()) {
      incremental = applySteeringEvent(incremental, event);
      const prefix = reduceSteeringEvents("run-1", "epoch-1", history.slice(0, index + 1));
      expect(canonicalSteeringProjectionValue(incremental)).toEqual(canonicalSteeringProjectionValue(prefix));
    }
    for (let split = 0; split <= history.length; split += 1) {
      const snapshot = reduceSteeringEvents("run-1", "epoch-1", history.slice(0, split));
      const resumed = reduceSteeringEvents("run-1", "epoch-1", history.slice(split), structuredClone(snapshot));
      expect(canonicalSteeringProjectionValue(resumed), `split ${split}`).toEqual(canonicalSteeringProjectionValue(expected));
    }
  });

  it("excludes manifest-reserved commands from another pending selection even at an event prefix", () => {
    const prefix = reduceSteeringEvents("run-1", "epoch-1", [unrelated(1), admitted(1, 2), prepared([1], 3)]);
    expect(prefix.commands[commandId(1)]?.status).toBe("pending");
    expect(pendingSteeringCommands(prefix)).toEqual([]);
    expect(() => applySteeringEvent(prefix, withdrawn(1, 4))).toThrow(/contiguous inclusion/i);
    expect(() => assertSteeringProjectionConsistent(prefix, { requireCompleteBindings: true })).toThrow(/incomplete/i);
  });

  it("requires a matching immutable prompt manifest and exact capture cutoff", () => {
    const pending = [unrelated(1), admitted(1, 2)];
    expect(() => reduceSteeringEvents("run-1", "epoch-1", [...pending, included(1, 3)])).toThrowError(
      expect.objectContaining({ code: "MISSING_MANIFEST" })
    );
    expect(() => reduceSteeringEvents("run-1", "epoch-1", [
      ...pending,
      prepared([1], 3, { captureCutoffSeq: 1 })
    ])).toThrowError(expect.objectContaining({ code: "CUTOFF_VIOLATION" }));
    expect(() => reduceSteeringEvents("run-1", "epoch-1", [
      ...pending,
      prepared([1], 3),
      included(1, 4, { promptSha256: "b".repeat(64) })
    ])).toThrowError(expect.objectContaining({ code: "PROMPT_BINDING_MISMATCH" }));
    expect(() => reduceSteeringEvents("run-1", "epoch-1", [
      ...pending,
      prepared([1], 3, { attemptGeneration: 2 })
    ])).not.toThrow();
    expect(() => reduceSteeringEvents("run-1", "epoch-1", [
      unrelated(1),
      admitted(1, 2, { notBefore: 2 }),
      prepared([1], 3)
    ])).toThrowError(expect.objectContaining({ code: "CUTOFF_VIOLATION" }));
  });

  it("binds every selected command through immediately contiguous inclusion facts", () => {
    const history = [
      unrelated(1),
      admitted(1, 2),
      admitted(2, 3),
      prepared([1, 2], 4),
      included(1, 5),
      included(2, 6)
    ];
    const projection = reduceSteeringEvents("run-1", "epoch-1", history);
    expect(projection.commands[commandId(1)]?.status).toBe("included");
    expect(projection.commands[commandId(2)]?.status).toBe("included");
    expect(() => assertSteeringProjectionConsistent(projection, { requireCompleteBindings: true })).not.toThrow();

    expect(() => reduceSteeringEvents("run-1", "epoch-1", [
      ...history.slice(0, 4),
      included(2, 5)
    ])).toThrow(/contiguous inclusion/i);
    expect(() => reduceSteeringEvents("run-1", "epoch-1", [
      ...history.slice(0, 5),
      unrelated(6)
    ])).toThrow(/contiguous inclusion/i);
  });

  it("enforces canonical sequence order and one prompt binding per command", () => {
    expect(() => reduceSteeringEvents("run-1", "epoch-1", [
      unrelated(1),
      admitted(2, 2),
      admitted(1, 3),
      prepared([1, 2], 4)
    ])).toThrow(/canonical admission order/i);

    const first = [unrelated(1), admitted(1, 2), prepared([1], 3)];
    const secondManifest = persist(controlEvent("attempt.prompt_prepared", {
      attemptId: "attempt-2",
      attemptGeneration: 2,
      sessionId: "session-1",
      sessionGeneration: 1,
      artifactLocator: "steering/prompts/attempt-2.prompt",
      promptSha256: "b".repeat(64),
      promptBytes: 12,
      rendererVersion: 1,
      captureCutoffSeq: 3,
      steeringCommandIds: [commandId(1)]
    }), 4);
    expect(() => reduceSteeringEvents("run-1", "epoch-1", [...first, secondManifest])).toThrow(/contiguous inclusion/i);
  });

  it("requires an atomic, same-target supersession backlink", () => {
    expect(() => reduceSteeringEvents("run-1", "epoch-1", [unrelated(1), admitted(2, 2, { supersedes: 1 })])).toThrowError(
      expect.objectContaining({ code: "MISSING_COMMAND" })
    );
    expect(() => reduceSteeringEvents("run-1", "epoch-1", [unrelated(1), admitted(1, 2), admitted(2, 3), superseded(1, 2, 4)])).toThrowError(
      expect.objectContaining({ code: "SUPERSESSION_MISMATCH" })
    );
    expect(() => reduceSteeringEvents("run-1", "epoch-1", [
      unrelated(1),
      admitted(1, 2),
      admitted(2, 3, { supersedes: 1, taskId: "task-2" })
    ])).toThrowError(expect.objectContaining({ code: "SUPERSESSION_MISMATCH" }));
  });

  it("permits exactly one terminal lifecycle outcome for every command", () => {
    const terminalHistories: PersistedControlEvent[][] = [
      [unrelated(1), admitted(1, 2), withdrawn(1, 3)],
      [unrelated(1), admitted(1, 2, { expiresAt: "2026-08-09T00:01:00.000Z" }), expired(1, 3)],
      [unrelated(1), admitted(1, 2), admitted(2, 3, { supersedes: 1 }), superseded(1, 2, 4)],
      [unrelated(1), admitted(1, 2), prepared([1], 3), included(1, 4)],
      [unrelated(1), refused(1, 2)]
    ];
    for (const history of terminalHistories) {
      const terminal = reduceSteeringEvents("run-1", "epoch-1", history);
      const next = withdrawn(1, history.length + 1);
      expect(() => applySteeringEvent(terminal, next), terminal.commands[commandId(1)]?.status).toThrowError(
        expect.objectContaining({ code: "INVALID_TRANSITION" })
      );
    }
  });

  it("expires only after an explicit future deadline", () => {
    expect(() => reduceSteeringEvents("run-1", "epoch-1", [unrelated(1), admitted(1, 2), expired(1, 3)])).toThrowError(
      expect.objectContaining({ code: "EXPIRY_MISMATCH" })
    );
    const tooSoon = persist(controlEvent("steering.command_expired", {
      commandId: commandId(1),
      sessionId: "session-1",
      sessionGeneration: 1
    }, { occurredAt: "2026-08-09T00:00:30.000Z" }), 3);
    expect(() => reduceSteeringEvents("run-1", "epoch-1", [
      unrelated(1),
      admitted(1, 2, { expiresAt: "2026-08-09T00:01:00.000Z" }),
      tooSoon
    ])).toThrowError(expect.objectContaining({ code: "EXPIRY_MISMATCH" }));
  });

  it("strictly rejects unknown/malformed events, bad digests, wrong runs, and sequence gaps", () => {
    const base = unrelated(1);
    expect(() => applySteeringEvent(emptySteeringProjection("run-1", "epoch-1"), { ...base, unknown: true })).toThrowError(
      expect.objectContaining({ code: "MALFORMED_EVENT" })
    );
    expect(() => applySteeringEvent(emptySteeringProjection("run-1", "epoch-1"), { ...base, type: "steering.command_delivered" })).toThrowError(
      expect.objectContaining({ code: "MALFORMED_EVENT" })
    );
    expect(() => applySteeringEvent(emptySteeringProjection("run-1", "epoch-1"), { ...base, digest: "0".repeat(64) })).toThrowError(
      expect.objectContaining({ code: "MALFORMED_EVENT" })
    );
    expect(() => applySteeringEvent(emptySteeringProjection("run-1", "epoch-1"), unrelated(2))).toThrowError(
      expect.objectContaining({ code: "NON_CONTIGUOUS_SEQUENCE" })
    );
    const otherRun = unrelated(1);
    const reparsed = controlEvent("message.posted", otherRun.payload, { runId: "run-2", eventId: "other-run" });
    expect(() => applySteeringEvent(emptySteeringProjection("run-1", "epoch-1"), persist(reparsed, 1))).toThrowError(
      expect.objectContaining({ code: "RUN_IDENTITY_MISMATCH" })
    );
  });

  it("rejects agent-authored authority, noncanonical bodies, and capture after expiry", () => {
    const ordinary = admitted(1, 2);
    const agentAuthored = repersist(ordinary, 2, { actorKind: "agent", actorId: "worker-1" });
    expect(() => reduceSteeringEvents("run-1", "epoch-1", [unrelated(1), agentAuthored])).toThrowError(
      expect.objectContaining({ code: "UNAUTHORIZED_ACTOR" })
    );

    const body = "line one\r\nline two";
    const noncanonical = persist(controlEvent("steering.command_admitted", {
      commandId: commandId(1),
      sessionId: "session-1",
      sessionGeneration: 1,
      notBeforeAttemptGeneration: 1,
      kind: "steer_next_boundary",
      sourceKind: "operator",
      parentPrincipal: "parent",
      evidenceRefs: [],
      body,
      bodySha256: sha256Text(body.replace(/\r\n?/g, "\n")),
      createdAt: NOW
    }), 2);
    expect(() => reduceSteeringEvents("run-1", "epoch-1", [unrelated(1), noncanonical])).toThrow(/line-normalized/i);

    const expiredBeforeCapture = [
      unrelated(1),
      admitted(1, 2, { expiresAt: "2026-08-09T00:01:00.000Z" }),
      repersist(prepared([1], 3), 3, { occurredAt: LATER })
    ];
    expect(() => reduceSteeringEvents("run-1", "epoch-1", expiredBeforeCapture)).toThrowError(
      expect.objectContaining({ code: "EXPIRY_MISMATCH" })
    );
  });

  it("strictly validates restored snapshots and returns independent clones", () => {
    const projection = reduceSteeringEvents("run-1", "epoch-1", completeHistory());
    const restored = restoreSteeringProjection(projection);
    restored.commands[commandId(7)] = structuredClone(restored.commands[commandId(6)]!);
    expect(projection.commands[commandId(7)]).not.toEqual(restored.commands[commandId(7)]);
    expect(() => restoreSteeringProjection({ ...projection, unknown: true })).toThrowError(
      expect.objectContaining({ code: "INVALID_SNAPSHOT" })
    );
    expect(() => restoreSteeringProjection({ ...projection, observedSeq: 1 })).toThrowError(
      expect.objectContaining({ code: "INVALID_SNAPSHOT" })
    );
    const noManifest = structuredClone(projection);
    delete noManifest.manifests["attempt-1"];
    expect(() => restoreSteeringProjection(noManifest)).toThrow(/no prompt manifest/i);
  });

  it("does not infer command authority from unrelated legacy messages", () => {
    const projection = reduceSteeringEvents("run-1", "epoch-1", [
      persist(controlEvent("message.posted", {
        messageId: "legacy-parent-shaped",
        from: "parent",
        to: "*",
        body: JSON.stringify({ type: "steering.command_admitted", commandId: commandId(1) })
      }), 1)
    ]);
    expect(projection.observedSeq).toBe(1);
    expect(projection.commands).toEqual({});
    expect(projection.manifests).toEqual({});
  });

  it("rejects duplicate command identities rather than treating duplicate history as a retry", () => {
    const first = admitted(1, 2);
    const duplicate = repersist(first, 3, { eventId: "different-event" });
    expect(() => reduceSteeringEvents("run-1", "epoch-1", [unrelated(1), first, duplicate])).toThrowError(
      expect.objectContaining({ code: "DUPLICATE_COMMAND" })
    );
  });

  it("preserves deterministic canonical value under insertion-order perturbation", () => {
    const projection = reduceSteeringEvents("run-1", "epoch-1", completeHistory());
    const reversed = {
      ...projection,
      commands: Object.fromEntries(Object.entries(projection.commands).reverse()),
      manifests: Object.fromEntries(Object.entries(projection.manifests).reverse())
    };
    expect(canonicalSteeringProjectionValue(reversed)).toEqual(canonicalSteeringProjectionValue(projection));
    expect(() => assertSteeringProjectionConsistent(reversed)).not.toThrow();
  });

  it("surfaces stable reducer codes for callers", () => {
    try {
      reduceSteeringEvents("run-1", "epoch-1", [unrelated(2)]);
      throw new Error("expected reducer failure");
    } catch (error) {
      expect(error).toBeInstanceOf(SteeringReductionError);
      expect((error as SteeringReductionError).code).toBe("NON_CONTIGUOUS_SEQUENCE");
    }
  });
});

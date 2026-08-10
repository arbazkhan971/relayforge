import { describe, expect, it } from "vitest";
import { sha256Text } from "../src/control/events.js";
import {
  STEERING_BODY_MAX_BYTES,
  STEERING_BODY_MAX_SCALARS,
  STEERING_EVIDENCE_MAX_REFS,
  compareSteeringCommandSemantics,
  createSteeringCommandId,
  materializeSteeringCommand,
  normalizeSteeringBody,
  parseSteeringCommand,
  parseSteeringCommandDraft,
  steeringCommandSemanticDigest
} from "../src/steering/schema.js";
import type { SteeringCommandDraftV1 } from "../src/steering/types.js";

const NOW = "2026-08-09T00:00:00.000Z";

function commandId(index: number): string {
  return `01890f9d-0000-7000-8000-${index.toString(16).padStart(12, "0")}`;
}

function draft(overrides: Partial<SteeringCommandDraftV1> = {}): SteeringCommandDraftV1 {
  return {
    schemaVersion: 1,
    commandId: commandId(1),
    runId: "run-1",
    runEpoch: "epoch-1",
    taskId: "task-1",
    taskGeneration: 2,
    sessionId: "session-1",
    sessionGeneration: 3,
    notBeforeAttemptGeneration: 4,
    kind: "steer_next_boundary",
    sourceKind: "operator",
    parentPrincipal: "parent-1",
    evidenceRefs: ["event-1", "event-2"],
    body: "Repair the deterministic failure.",
    createdAt: NOW,
    ...overrides
  };
}

describe("SteeringCommandV1 closed schema", () => {
  it("normalizes only line endings and binds the digest to normalized UTF-8 bytes", () => {
    const command = materializeSteeringCommand(draft({ body: "first\r\nsecond\rthird  " }));
    expect(command.body).toBe("first\nsecond\nthird  ");
    expect(command.bodySha256).toBe(sha256Text(command.body));
    expect(normalizeSteeringBody("x\r\ny\rz")).toBe("x\ny\nz");

    const exact = materializeSteeringCommand(draft({ body: "first\nsecond\nthird  " }));
    expect(compareSteeringCommandSemantics(command, exact)).toEqual({
      result: "exact",
      digest: steeringCommandSemanticDigest(command),
      changedFields: []
    });
  });

  it("retains meaningful whitespace and evidence order in semantic conflicts", () => {
    const original = materializeSteeringCommand(draft());
    const whitespace = materializeSteeringCommand(draft({ body: `${original.body} ` }));
    const reorderedEvidence = materializeSteeringCommand(draft({ evidenceRefs: [...original.evidenceRefs].reverse() }));
    expect(compareSteeringCommandSemantics(original, whitespace)).toMatchObject({
      result: "conflict",
      changedFields: ["body", "bodySha256"]
    });
    expect(compareSteeringCommandSemantics(original, reorderedEvidence)).toMatchObject({
      result: "conflict",
      changedFields: ["evidenceRefs"]
    });
  });

  it("compares every immutable target, provenance, lifetime, and replacement field", () => {
    const original = materializeSteeringCommand(draft());
    const variants: Array<[Partial<SteeringCommandDraftV1>, string]> = [
      [{ commandId: commandId(2) }, "commandId"],
      [{ runId: "run-2" }, "runId"],
      [{ runEpoch: "epoch-2" }, "runEpoch"],
      [{ taskId: "task-2" }, "taskId"],
      [{ taskGeneration: 3 }, "taskGeneration"],
      [{ sessionId: "session-2" }, "sessionId"],
      [{ sessionGeneration: 4 }, "sessionGeneration"],
      [{ notBeforeAttemptGeneration: 5 }, "notBeforeAttemptGeneration"],
      [{ sourceKind: "verifier" }, "sourceKind"],
      [{ parentPrincipal: "parent-2" }, "parentPrincipal"],
      [{ createdAt: "2026-08-09T00:00:01.000Z" }, "createdAt"],
      [{ expiresAt: "2026-08-09T00:01:00.000Z" }, "expiresAt"],
      [{ supersedesCommandId: commandId(9) }, "supersedesCommandId"]
    ];
    for (const [change, field] of variants) {
      const comparison = compareSteeringCommandSemantics(original, materializeSteeringCommand(draft(change)));
      expect(comparison.result, field).toBe("conflict");
      if (comparison.result === "conflict") expect(comparison.changedFields, field).toContain(field);
    }
  });

  it("enforces both scalar and UTF-8 byte bounds without truncation", () => {
    expect(materializeSteeringCommand(draft({ body: "a".repeat(STEERING_BODY_MAX_SCALARS) })).body).toHaveLength(
      STEERING_BODY_MAX_SCALARS
    );
    expect(() => materializeSteeringCommand(draft({ body: "a".repeat(STEERING_BODY_MAX_SCALARS + 1) }))).toThrow(/scalar/i);
    const exactBytes = "😀".repeat(STEERING_BODY_MAX_BYTES / 4);
    expect(Buffer.byteLength(materializeSteeringCommand(draft({ body: exactBytes })).body, "utf8")).toBe(STEERING_BODY_MAX_BYTES);
    expect(() => materializeSteeringCommand(draft({ body: `${exactBytes}😀` }))).toThrow(/bytes/i);
  });

  it("rejects malformed Unicode, noncharacters, and transport-hostile controls", () => {
    for (const body of ["\ud800", "\udc00", "bad\ufdd0", "bad\u{1ffff}", "bad\0", "bad\u0085"]) {
      expect(() => materializeSteeringCommand(draft({ body })), JSON.stringify(body)).toThrow(/Unicode|body/i);
    }
    expect(() => materializeSteeringCommand(draft({ body: "" }))).toThrow(/empty/i);
    expect(materializeSteeringCommand(draft({ body: "tab\tok\n" })).body).toBe("tab\tok\n");
  });

  it("requires unique bounded evidence and a later explicit expiry", () => {
    expect(materializeSteeringCommand(draft({ evidenceRefs: Array.from({ length: STEERING_EVIDENCE_MAX_REFS }, (_, i) => `event-${i}`) }))).toBeDefined();
    expect(() => materializeSteeringCommand(draft({ evidenceRefs: Array.from({ length: STEERING_EVIDENCE_MAX_REFS + 1 }, (_, i) => `event-${i}`) }))).toThrow();
    expect(() => materializeSteeringCommand(draft({ evidenceRefs: ["same", "same"] }))).toThrow(/unique/i);
    expect(() => materializeSteeringCommand(draft({ evidenceRefs: ["../event"] }))).toThrow();
    expect(() => materializeSteeringCommand(draft({ expiresAt: NOW }))).toThrow(/later/i);
    expect(() => materializeSteeringCommand(draft({ expiresAt: "2026-08-08T23:59:59.999Z" }))).toThrow(/later/i);
  });

  it("rejects unknown fields, versions, kinds, sources, targets, and non-v7 IDs", () => {
    const valid = draft();
    const invalid: unknown[] = [
      { ...valid, unknown: true },
      { ...valid, schemaVersion: 2 },
      { ...valid, kind: "steer_current_turn" },
      { ...valid, sourceKind: "agent" },
      { ...valid, commandId: "01890f9d-0000-4000-8000-000000000001" },
      { ...valid, runId: "../run" },
      { ...valid, taskGeneration: 0 },
      { ...valid, sessionGeneration: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, supersedesCommandId: valid.commandId }
    ];
    for (const value of invalid) expect(() => parseSteeringCommandDraft(value)).toThrow();

    const command = materializeSteeringCommand(valid);
    expect(() => parseSteeringCommand({ ...command, bodySha256: "0".repeat(64) })).toThrow(/digest/i);
    expect(() => parseSteeringCommand({ ...command, extra: "rejected" })).toThrow();
  });

  it("creates canonical UUIDv7 IDs with an injectable clock and exact entropy", () => {
    const nowMs = 1_700_000_000_000;
    const id = createSteeringCommandId({ nowMs, random: new Uint8Array(10).fill(0xff) });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-b[0-9a-f]{3}-[0-9a-f]{12}$/);
    const timestampHex = id.replaceAll("-", "").slice(0, 12);
    expect(Number.parseInt(timestampHex, 16)).toBe(nowMs);
    expect(() => createSteeringCommandId({ random: new Uint8Array(9) })).toThrow(/10 bytes/i);
    expect(() => createSteeringCommandId({ nowMs: -1 })).toThrow(/48-bit/i);
  });
});

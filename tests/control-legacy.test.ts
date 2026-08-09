import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decideLegacyArchive,
  executeLegacyImport,
  LegacyImportError,
  planLegacyImport,
  revalidateLegacySources,
  type LegacyFaultPoint,
  type LegacyImportPlan,
  type LegacySourcePaths
} from "../src/control/legacy.js";
import { ControlStore, openControlStore } from "../src/control/store.js";

const NOW = "2026-08-09T00:00:00.000Z";
const roots: string[] = [];
const stores: ControlStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // A test may intentionally corrupt or replace a source, never the control DB.
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const baseTask = {
  id: "task-1",
  title: "Legacy task",
  assignee: "dev",
  createdBy: "parent",
  description: "Migrate exactly.",
  acceptanceCriteria: ["preserves facts"],
  dependsOn: [],
  priority: 1,
  createdAt: NOW,
  files: ["src/legacy.ts"]
};

const baseEvents = [
  { ts: NOW, role: "dev", taskId: "task-1", status: "claimed" },
  { ts: "2026-08-09T00:00:01.000Z", role: "dev", taskId: "task-1", status: "in-progress", summary: "working" }
];

const baseMessage = {
  ts: "2026-08-09T00:00:02.000Z",
  from: "parent",
  to: "dev",
  taskId: "task-1",
  body: "Preserve the source manifest."
};

const baseState = {
  runId: "run-1",
  project: "project-1",
  phase: "dispatch",
  status: "running",
  iteration: 1,
  dispatched: 1,
  accepted: 0,
  rejected: 0,
  escalations: 0,
  repeatFailures: 0,
  unknownCostCalls: 0,
  startedAt: NOW,
  updatedAt: "2026-08-09T00:00:03.000Z"
};

type FixtureOptions = {
  tasks?: unknown[];
  events?: unknown[];
  messages?: unknown[];
  state?: unknown;
  terminateTasks?: boolean;
  terminateEvents?: boolean;
  terminateMessages?: boolean;
};

type Fixture = { root: string; board: string; paths: LegacySourcePaths; receiptPath: string; storePath: string };

function jsonl(records: readonly unknown[], terminate: boolean): string {
  const body = records.map((record) => JSON.stringify(record)).join("\n");
  return terminate && body ? `${body}\n` : body;
}

function fixture(options: FixtureOptions = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "relayforge-legacy-"));
  roots.push(root);
  const board = join(root, "board");
  mkdirSync(board, { mode: 0o700 });
  const paths = {
    tasks: join(board, "tasks.jsonl"),
    events: join(board, "events.jsonl"),
    messages: join(board, "messages.jsonl"),
    loopState: join(root, ".loop_state.json")
  };
  writeFileSync(paths.tasks, jsonl(options.tasks ?? [baseTask], options.terminateTasks ?? true), { mode: 0o600 });
  writeFileSync(paths.events, jsonl(options.events ?? baseEvents, options.terminateEvents ?? true), { mode: 0o600 });
  writeFileSync(paths.messages, jsonl(options.messages ?? [baseMessage], options.terminateMessages ?? true), { mode: 0o600 });
  writeFileSync(paths.loopState, JSON.stringify(options.state ?? baseState), { mode: 0o600 });
  return { root, board, paths, receiptPath: join(root, "migration", "receipt.json"), storePath: join(root, "control.sqlite") };
}

function plan(item: Fixture, overrides: Partial<Parameters<typeof planLegacyImport>[0]> = {}): LegacyImportPlan {
  return planLegacyImport({ paths: item.paths, runId: "run-1", runEpoch: "epoch-1", ...overrides });
}

function store(item: Fixture): ControlStore {
  const opened = openControlStore({ path: item.storePath, runId: "run-1", runEpoch: "epoch-1", now: () => NOW });
  stores.push(opened);
  return opened;
}

function expectLegacy(action: () => unknown, reasonCode: LegacyImportError["reasonCode"]): LegacyImportError {
  try {
    action();
    throw new Error(`expected ${reasonCode}`);
  } catch (error) {
    expect(error).toBeInstanceOf(LegacyImportError);
    expect((error as LegacyImportError).code).toBe("RECOVERY_REQUIRED");
    expect((error as LegacyImportError).reasonCode).toBe(reasonCode);
    return error as LegacyImportError;
  }
}

describe("legacy control-plane importer core", () => {
  it("pins exact private leaf identities, digests, byte ranges, and deterministic event order", () => {
    const item = fixture();
    const first = plan(item);
    const second = plan(item);
    expect(second).toEqual(first);
    expect(first.planId).toMatch(/^[a-f0-9]{64}$/);
    expect(first.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.events.map((event) => event.type)).toEqual([
      "run.started",
      "task.created",
      "task.status_changed",
      "task.status_changed",
      "message.posted",
      "run.checkpointed"
    ]);
    expect(first.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actorKind: "migration",
        actorId: "legacy-import",
        sourceKind: "legacy-jsonl",
        sourceId: first.manifestDigest,
        sourceGeneration: 1
      })
    ]));
    expect(new Set(first.events.map((event) => event.eventId)).size).toBe(first.events.length);
    expect(first.eventDigests).toHaveLength(first.events.length);
    expect(first.inventory.tasks).toMatchObject({ records: 1, lastCompleteOffset: lstatSync(item.paths.tasks).size });
    expect(first.inventory.tasks.recordRanges).toEqual([expect.objectContaining({ line: 1, start: 0, end: lstatSync(item.paths.tasks).size - 1 })]);
    expect(first.inventory.events.recordRanges).toHaveLength(2);
    expect(first.inventory.loopState.recordRanges).toEqual([expect.objectContaining({ line: 1, start: 0, end: lstatSync(item.paths.loopState).size })]);
    expect(first.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(expect.arrayContaining([
      "LEGACY_TASK_REOPEN_IDENTITY_UNAVAILABLE",
      "CROSS_LOG_ORDER_UNPROVABLE",
      "COMPACTION_HISTORY_UNPROVEN"
    ]));
    expect(first.appendable).toBe(true);
    expect(first.requiresLossAcknowledgement).toBe(true);
  });

  it("accepts a valid final JSON value without newline and classifies only an invalid one as torn", () => {
    const valid = fixture({ terminateTasks: false });
    const validPlan = plan(valid);
    expect(validPlan.inventory.tasks).toMatchObject({ records: 1, lastCompleteOffset: lstatSync(valid.paths.tasks).size });
    expect(validPlan.inventory.tasks.tornFinal).toBeUndefined();

    const torn = fixture();
    const original = readFileSync(torn.paths.tasks);
    writeFileSync(torn.paths.tasks, Buffer.concat([original, Buffer.from('{"id":')]), { mode: 0o600 });
    const tornPlan = plan(torn);
    expect(tornPlan.inventory.tasks.tornFinal).toMatchObject({ start: original.length, end: original.length + 6 });
    expect(tornPlan.diagnostics).toContainEqual(expect.objectContaining({ severity: "unsupported", code: "TORN_FINAL_FRAGMENT" }));
    expect(tornPlan.appendable).toBe(false);
  });

  it("rejects malformed interior or terminated-final JSON and unknown records", () => {
    const interior = fixture();
    writeFileSync(interior.paths.events, `${JSON.stringify(baseEvents[0])}\n{"bad":\n${JSON.stringify(baseEvents[1])}\n`, { mode: 0o600 });
    expectLegacy(() => plan(interior), "MALFORMED_INTERIOR");

    const terminatedFinal = fixture();
    writeFileSync(terminatedFinal.paths.tasks, `${JSON.stringify(baseTask)}\n{"id":\n`, { mode: 0o600 });
    expectLegacy(() => plan(terminatedFinal), "MALFORMED_INTERIOR");

    const unknown = fixture({ tasks: [{ ...baseTask, unknown: true }], terminateTasks: false });
    expectLegacy(() => plan(unknown), "UNKNOWN_RECORD");
  });

  it("rejects invalid UTF-8 in a complete record but classifies it in an unterminated final fragment", () => {
    const complete = fixture();
    writeFileSync(complete.paths.messages, Buffer.from([0xff, 0x0a]), { mode: 0o600 });
    expectLegacy(() => plan(complete), "MALFORMED_INTERIOR");

    const final = fixture();
    writeFileSync(final.paths.messages, Buffer.from([0xff]), { mode: 0o600 });
    const planned = plan(final);
    expect(planned.inventory.messages.tornFinal).toBeDefined();
    expect(planned.appendable).toBe(false);
  });

  it("rejects duplicate/conflicting/impossible records and dependency cycles", () => {
    const duplicate = fixture({ tasks: [baseTask, { ...baseTask }] });
    expectLegacy(() => plan(duplicate), "DUPLICATE_RECORD");

    const claimConflict = fixture({ events: [baseEvents[0], { ...baseEvents[0], role: "reviewer" }] });
    expectLegacy(() => plan(claimConflict), "CONFLICTING_RECORD");

    const missingTask = fixture({ events: [{ ...baseEvents[0], taskId: "missing" }] });
    expectLegacy(() => plan(missingTask), "IMPOSSIBLE_RECORD");

    const cycle = fixture({
      tasks: [
        { ...baseTask, id: "task-1", dependsOn: ["task-2"] },
        { ...baseTask, id: "task-2", dependsOn: ["task-1"] }
      ],
      events: [],
      messages: []
    });
    expectLegacy(() => plan(cycle), "IMPOSSIBLE_RECORD");
  });

  it("discloses detected compaction loss and refuses a history the current reducer cannot represent", () => {
    const item = fixture({ events: [{ ts: NOW, role: "reviewer", taskId: "task-1", status: "done", summary: "compacted terminal" }], messages: [] });
    const planned = plan(item);
    expect(planned.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "COMPACTION_LOSS_DETECTED", severity: "unsupported" }),
      expect.objectContaining({ code: "CURRENT_REDUCER_CANNOT_REPRESENT_LEGACY_HISTORY", severity: "unsupported" })
    ]));
    expect(planned.appendable).toBe(false);
    expectLegacy(() => executeLegacyImport(store(item), planned, { receiptPath: item.receiptPath, allowDisclosedLoss: true }), "IMPORT_UNSUPPORTED");
  });

  it("preserves a planned-only legacy run in the canonical checkpoint", () => {
    const item = fixture({ state: { ...baseState, phase: "complete", status: "planned" } });
    const planned = plan(item);
    expect(planned.diagnostics).not.toContainEqual(expect.objectContaining({ code: "PLANNED_RUN_UNSUPPORTED" }));
    expect(planned.events).toContainEqual(expect.objectContaining({
      type: "run.checkpointed",
      payload: expect.objectContaining({ phase: "complete", status: "planned" })
    }));
    expect(planned.appendable).toBe(true);
  });

  it("rejects unsafe, missing, linked, and oversized leaves", () => {
    const permissive = fixture();
    chmodSync(permissive.paths.tasks, 0o644);
    expectLegacy(() => plan(permissive), "UNSAFE_LEAF");

    const missing = fixture();
    unlinkSync(missing.paths.events);
    expectLegacy(() => plan(missing), "MISSING_LEAF");

    const linked = fixture();
    linkSync(linked.paths.tasks, join(linked.board, "task-alias"));
    expectLegacy(() => plan(linked), "UNSAFE_LEAF");

    const symlinked = fixture();
    const real = join(symlinked.board, "tasks-real");
    writeFileSync(real, `${JSON.stringify(baseTask)}\n`, { mode: 0o600 });
    unlinkSync(symlinked.paths.tasks);
    symlinkSync(real, symlinked.paths.tasks);
    expectLegacy(() => plan(symlinked), "UNSAFE_LEAF");

    const limited = fixture();
    expectLegacy(() => plan(limited, { maxTotalBytes: 1 }), "LIMIT_EXCEEDED");
    expectLegacy(() => plan(limited, { maxRecordBytes: 8 }), "LIMIT_EXCEEDED");
  });

  it("detects same-path content mutation and inode replacement after planning", () => {
    const changed = fixture();
    const changedPlan = plan(changed);
    writeFileSync(changed.paths.messages, `${JSON.stringify({ ...baseMessage, body: "changed" })}\n`, { mode: 0o600 });
    expectLegacy(() => revalidateLegacySources(changedPlan), "SOURCE_CHANGED");

    const replaced = fixture();
    const replacedPlan = plan(replaced);
    const replacement = join(replaced.board, "replacement");
    writeFileSync(replacement, readFileSync(replaced.paths.tasks), { mode: 0o600 });
    renameSync(replacement, replaced.paths.tasks);
    expectLegacy(() => revalidateLegacySources(replacedPlan), "SOURCE_CHANGED");
  });

  it("imports once with explicit loss acknowledgement, writes a private receipt, and repeats exactly", () => {
    const item = fixture();
    const planned = plan(item);
    const authority = store(item);
    expectLegacy(() => executeLegacyImport(authority, planned, { receiptPath: item.receiptPath }), "IMPORT_UNSUPPORTED");
    const first = executeLegacyImport(authority, planned, {
      receiptPath: item.receiptPath,
      allowDisclosedLoss: true,
      now: () => NOW
    });
    expect(first.idempotent).toBe(false);
    expect(first.receipt).toMatchObject({ planId: planned.planId, headBefore: 0, headAfter: planned.events.length, lossAcknowledged: true });
    expect(first.receipt.events.map((event) => event.eventId)).toEqual(planned.events.map((event) => event.eventId));
    expect(first.archiveDecision).toMatchObject({
      decision: "COPY_EXACT_SOURCES_TO_PRIVATE_ARCHIVE",
      retainOriginals: true,
      productCutoverAllowed: true
    });
    expect(authority.getProjection().run?.checkpoint).toMatchObject({
      project: baseState.project,
      phase: baseState.phase,
      status: baseState.status,
      iteration: baseState.iteration,
      dispatched: baseState.dispatched,
      accepted: baseState.accepted,
      rejected: baseState.rejected,
      escalations: baseState.escalations,
      repeatFailures: baseState.repeatFailures,
      unknownCostCalls: baseState.unknownCostCalls
    });
    expect(first.receipt.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        recordedAt: NOW,
        intentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        digest: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
    ]));
    expect(lstatSync(item.receiptPath).mode & 0o777).toBe(0o600);
    const head = authority.head().headSeq;
    const repeated = executeLegacyImport(authority, planned, { receiptPath: item.receiptPath, allowDisclosedLoss: true });
    expect(repeated.idempotent).toBe(true);
    expect(repeated.receipt).toEqual(first.receipt);
    expect(authority.head().headSeq).toBe(head);
  });

  it("refuses a changed-source plan against an existing receipt", () => {
    const item = fixture();
    const authority = store(item);
    const original = plan(item);
    executeLegacyImport(authority, original, { receiptPath: item.receiptPath, allowDisclosedLoss: true, now: () => NOW });
    writeFileSync(item.paths.messages, `${JSON.stringify({ ...baseMessage, body: "changed after receipt" })}\n`, { mode: 0o600 });
    const changed = plan(item);
    expect(changed.planId).not.toBe(original.planId);
    expectLegacy(() => executeLegacyImport(authority, changed, { receiptPath: item.receiptPath, allowDisclosedLoss: true }), "RECEIPT_CONFLICT");
  });

  it("refuses a malformed or semantically incomplete receipt", () => {
    const malformed = fixture();
    mkdirSync(join(malformed.root, "migration"), { mode: 0o700 });
    writeFileSync(malformed.receiptPath, "{bad", { mode: 0o600 });
    expectLegacy(() => executeLegacyImport(store(malformed), plan(malformed), { receiptPath: malformed.receiptPath, allowDisclosedLoss: true }), "RECEIPT_CONFLICT");

    const incomplete = fixture();
    const authority = store(incomplete);
    const planned = plan(incomplete);
    const result = executeLegacyImport(authority, planned, { receiptPath: incomplete.receiptPath, allowDisclosedLoss: true, now: () => NOW });
    const receipt = JSON.parse(readFileSync(incomplete.receiptPath, "utf8")) as { events: unknown[] };
    receipt.events = [];
    writeFileSync(incomplete.receiptPath, JSON.stringify(receipt), { mode: 0o600 });
    expect(result.receipt.events.length).toBeGreaterThan(0);
    expectLegacy(() => executeLegacyImport(authority, planned, { receiptPath: incomplete.receiptPath, allowDisclosedLoss: true }), "RECEIPT_CONFLICT");
  });

  for (const point of ["before-inventory", "after-inventory", "before-plan", "after-plan"] as const satisfies readonly LegacyFaultPoint[]) {
    it(`exposes a deterministic planning fault seam at ${point}`, () => {
      const item = fixture();
      expect(() => plan(item, { fault: (seen) => { if (seen === point) throw new Error(`fault:${point}`); } })).toThrow(`fault:${point}`);
      expect(existsSync(item.receiptPath)).toBe(false);
    });
  }

  for (const point of [
    "before-import",
    "after-import",
    "before-receipt",
    "after-receipt",
    "before-archive-decision",
    "after-archive-decision"
  ] as const satisfies readonly LegacyFaultPoint[]) {
    it(`recovers idempotently from the ${point} import window`, () => {
      const item = fixture();
      const authority = store(item);
      const planned = plan(item);
      expect(() => executeLegacyImport(authority, planned, {
        receiptPath: item.receiptPath,
        allowDisclosedLoss: true,
        now: () => NOW,
        fault: (seen) => { if (seen === point) throw new Error(`fault:${point}`); }
      })).toThrow(`fault:${point}`);
      const recovered = executeLegacyImport(authority, planned, { receiptPath: item.receiptPath, allowDisclosedLoss: true, now: () => NOW });
      expect(recovered.receipt.events).toHaveLength(planned.events.length);
      expect(authority.head().headSeq).toBe(planned.events.length);
      expect(existsSync(item.receiptPath)).toBe(true);
    });
  }

  it("leaves committed deterministic events but refuses a receipt if a source mutates after import", () => {
    const item = fixture();
    const authority = store(item);
    const planned = plan(item);
    expectLegacy(() => executeLegacyImport(authority, planned, {
      receiptPath: item.receiptPath,
      allowDisclosedLoss: true,
      fault: (point) => {
        if (point === "after-import") {
          writeFileSync(item.paths.messages, `${JSON.stringify({ ...baseMessage, body: "mutated during import" })}\n`, { mode: 0o600 });
        }
      }
    }), "SOURCE_CHANGED");
    expect(authority.head().headSeq).toBe(planned.events.length);
    expect(existsSync(item.receiptPath)).toBe(false);
    expectLegacy(() => decideLegacyArchive(planned, {
      schemaVersion: 1,
      planId: planned.planId,
      manifestDigest: planned.manifestDigest,
      runId: planned.runId,
      runEpoch: planned.runEpoch,
      headBefore: 0,
      headAfter: planned.events.length,
      events: authority.readRange({ afterSeq: 0 }).events.map((event) => ({
        eventId: event.eventId,
        seq: event.seq,
        intentDigest: event.intentDigest,
        digest: event.digest,
        recordedAt: event.recordedAt
      })),
      inventory: planned.inventory,
      diagnostics: planned.diagnostics,
      lossAcknowledged: true,
      archiveDecision: {
        decision: "COPY_EXACT_SOURCES_TO_PRIVATE_ARCHIVE",
        archiveName: `legacy-${planned.manifestDigest}`,
        manifestDigest: planned.manifestDigest,
        retainOriginals: true,
        productCutoverAllowed: true,
        reason: "canonical import, durable receipt, exact source revalidation, and acknowledged loss make a one-way reader cutover eligible; originals remain retained for recovery proof"
      },
      createdAt: NOW
    }), "SOURCE_CHANGED");
  });
});

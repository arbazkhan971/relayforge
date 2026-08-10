import { describe, expect, it } from "vitest";
import {
  CONTROL_ROOM_CLIENT_LIMITS,
  createControlRoomClient,
  type ControlRoomChangeNotificationV1,
  type ControlRoomClientScheduler,
  type ControlRoomClientState,
  type ControlRoomClientTransport,
  type ControlRoomSnapshotV1
} from "../src/control-room/client.js";
import { encodeControlRoomObservationCursor } from "../src/control-room/query.js";
import { materializeObservationRecord, toPublicObservation } from "../src/observability/public.js";
import { OBSERVATION_SCHEMA_VERSION } from "../src/observability/types.js";

const EPOCH = "epoch_1234567890123456";
const NEXT_EPOCH = "epoch_9999999999999999";
const AT = "2026-08-09T12:00:00.000Z";

function snapshot(eventHeadSeq = 1, runEpoch = EPOCH): ControlRoomSnapshotV1 {
  const record = toPublicObservation(materializeObservationRecord({
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    seq: 1,
    recordId: "observation-1",
    generation: {
      runId: "run-1",
      runEpoch,
      taskId: "task-1",
      agentId: "worker-1",
      runtimeGeneration: 1,
      attemptGeneration: 1,
      sourceGeneration: 1
    },
    observedAt: AT,
    recordedAt: AT,
    category: "provider",
    phase: "executing",
    severity: "info",
    code: "provider.progress",
    details: { kind: "progress", operationCode: "turn.running" },
    sourceIntegrity: "live",
    summary: "working"
  }));
  return {
    schemaVersion: 1,
    runId: "run-1",
    runEpoch,
    eventHeadSeq,
    rows: [{
      agentId: "worker-1",
      taskId: "task-1",
      runtimeGeneration: 1,
      attemptGeneration: 1,
      sourceGeneration: 1,
      activity: "active",
      attention: "working",
      taskStatus: "claimed",
      steeringState: "none",
      pendingCommands: 0,
      scmState: "unknown",
      verificationState: "unknown",
      sourceIntegrity: "live",
      sourceStateCode: "source.live",
      sourceDroppedRecords: 0,
      sourceDroppedBytes: 0,
      lastFactSeq: 1,
      lastObservedAt: AT,
      lastObservation: record
    }],
    observationPage: {
      schemaVersion: 1,
      runId: "run-1",
      runEpoch,
      snapshotSeq: eventHeadSeq,
      projectionSeq: 1,
      firstAvailableSeq: 1,
      nextAfter: 1,
      truncated: false,
      droppedRecords: 0,
      droppedBytes: 0,
      freshness: eventHeadSeq === 1 ? "fresh" : "stale",
      records: [record],
      sources: [{
        agentId: "worker-1",
        runtimeGeneration: 1,
        attemptGeneration: 1,
        sourceGeneration: 1,
        integrity: "live",
        lastObservedAt: AT,
        droppedRecords: 0,
        droppedBytes: 0
      }]
    },
    nextCursor: encodeControlRoomObservationCursor({ schemaVersion: 1, runEpoch, afterSeq: 1 })
  };
}

class FakeScheduler implements ControlRoomClientScheduler {
  callbacks: Array<() => void> = [];
  delays: number[] = [];
  schedule(callback: () => void, delayMs: number): () => void {
    this.callbacks.push(callback);
    this.delays.push(delayMs);
    let active = true;
    return () => { active = false; this.callbacks = this.callbacks.filter((candidate) => candidate !== callback); if (!active) return; };
  }
  run(): void { this.callbacks.shift()?.(); }
}

function transport(fetches: Array<unknown | Error>, events: string[] = []): ControlRoomClientTransport & { emit(value: unknown): void; unsubscribes: number } {
  let listener: ((value: unknown) => void) | undefined;
  return {
    unsubscribes: 0,
    subscribe(next) {
      events.push("subscribe");
      listener = next;
      return () => { this.unsubscribes += 1; listener = undefined; };
    },
    async fetchSnapshot() {
      events.push("fetch");
      const value = fetches.shift();
      if (value instanceof Error) throw value;
      return value;
    },
    emit(value) { listener?.(value); }
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("read-only control-room client", () => {
  it("subscribes before fetching the durable head", async () => {
    const order: string[] = [];
    const source = transport([snapshot()], order);
    const states: ControlRoomClientState[] = [];
    const client = createControlRoomClient({ transport: source, onState: (state) => states.push(state) });
    await client.start();
    expect(order).toEqual(["subscribe", "fetch"]);
    expect(client.state()).toMatchObject({ mode: "ready", snapshot: { eventHeadSeq: 1 } });
    expect(states.map((state) => state.mode)).toEqual(["loading", "ready"]);
    client.stop();
  });

  it("refetches when a notification races the first snapshot", async () => {
    let listener: ((value: unknown) => void) | undefined;
    let fetchCount = 0;
    const source: ControlRoomClientTransport = {
      subscribe(next) {
        listener = next;
        next({ type: "control.changed", runEpoch: EPOCH, seq: 2 });
        return () => { listener = undefined; };
      },
      async fetchSnapshot() { fetchCount += 1; return fetchCount === 1 ? snapshot(1) : snapshot(2); }
    };
    const client = createControlRoomClient({ transport: source });
    await client.start();
    expect(fetchCount).toBe(2);
    expect(client.state()).toMatchObject({ mode: "ready", snapshot: { eventHeadSeq: 2 } });
    client.stop();
  });

  it("replaces run identity only after a strict snapshot for the notified epoch", async () => {
    const source = transport([snapshot(1), snapshot(1, NEXT_EPOCH)]);
    const client = createControlRoomClient({ transport: source });
    await client.start();
    source.emit({ type: "control.changed", runEpoch: NEXT_EPOCH, seq: 1 });
    await settle();
    expect(client.state().snapshot?.runEpoch).toBe(NEXT_EPOCH);
    client.stop();
  });

  it("coalesces burst notifications while a snapshot is in flight", async () => {
    let resolveFetch: ((value: unknown) => void) | undefined;
    let listener: ((value: unknown) => void) | undefined;
    const source: ControlRoomClientTransport = {
      subscribe(next) { listener = next; return () => { listener = undefined; }; },
      fetchSnapshot() { return new Promise((resolve) => { resolveFetch = resolve; }); }
    };
    const client = createControlRoomClient({ transport: source });
    const start = client.start();
    listener?.({ type: "control.changed", runEpoch: EPOCH, seq: 1 });
    listener?.({ type: "control.changed", runEpoch: EPOCH, seq: 1 });
    resolveFetch?.(snapshot());
    await start;
    expect(client.state().coalescedNotifications).toBeGreaterThanOrEqual(2);
    client.stop();
  });

  it("falls back to bounded polling when subscription is unavailable", async () => {
    const scheduler = new FakeScheduler();
    let fetches = 0;
    const source: ControlRoomClientTransport = {
      subscribe() { throw new Error("SSE unavailable"); },
      async fetchSnapshot() { fetches += 1; return snapshot(); }
    };
    const client = createControlRoomClient({ transport: source, scheduler });
    await client.start();
    expect(client.state()).toMatchObject({ mode: "degraded", reasonCode: "subscription_unavailable" });
    expect(scheduler.delays).toEqual([CONTROL_ROOM_CLIENT_LIMITS.degradedPollMs]);
    scheduler.run();
    await settle();
    expect(fetches).toBe(2);
    client.stop();
  });

  it("degrades on an asynchronous subscription loss without postponing polling and recovers only after a valid wake", async () => {
    const scheduler = new FakeScheduler();
    let listener: ((value: unknown) => void) | undefined;
    let subscriptionState: ((value: "connecting" | "available" | "unavailable") => void) | undefined;
    let head = 1;
    const source: ControlRoomClientTransport = {
      subscribe(next, state) {
        listener = next;
        subscriptionState = state;
        return () => { listener = undefined; subscriptionState = undefined; };
      },
      async fetchSnapshot() { return snapshot(head); }
    };
    const client = createControlRoomClient({ transport: source, scheduler });
    await client.start();
    expect(client.state().mode).toBe("ready");

    subscriptionState?.("unavailable");
    expect(client.state()).toMatchObject({ mode: "degraded", reasonCode: "subscription_unavailable", snapshot: { eventHeadSeq: 1 } });
    expect(scheduler.callbacks).toHaveLength(1);
    subscriptionState?.("connecting");
    subscriptionState?.("unavailable");
    expect(scheduler.callbacks).toHaveLength(1);

    head = 2;
    subscriptionState?.("available");
    listener?.({ type: "control.changed", runEpoch: EPOCH, seq: 2 });
    await settle();
    expect(client.state()).toMatchObject({ mode: "ready", snapshot: { eventHeadSeq: 2 } });
    expect(scheduler.callbacks).toHaveLength(0);
    client.stop();
  });

  it("retains the last good snapshot across fetch failure and recovers by polling", async () => {
    const scheduler = new FakeScheduler();
    const source = transport([snapshot(), new Error("offline"), snapshot(2)]);
    const client = createControlRoomClient({ transport: source, scheduler });
    await client.start();
    source.emit({ type: "control.changed", runEpoch: EPOCH, seq: 2 });
    await settle();
    expect(client.state()).toMatchObject({ mode: "degraded", reasonCode: "snapshot_failed", snapshot: { eventHeadSeq: 1 } });
    scheduler.run();
    await settle();
    expect(client.state()).toMatchObject({ mode: "ready", snapshot: { eventHeadSeq: 2 } });
    client.stop();
  });

  it("degrades after the bounded race-refetch limit instead of looping forever", async () => {
    let fetches = 0;
    const scheduler = new FakeScheduler();
    const source: ControlRoomClientTransport = {
      subscribe(listener) {
        listener({ type: "control.changed", runEpoch: EPOCH, seq: 99 });
        return () => {};
      },
      async fetchSnapshot() { fetches += 1; return snapshot(); }
    };
    const client = createControlRoomClient({ transport: source, scheduler });
    await client.start();
    expect(fetches).toBe(CONTROL_ROOM_CLIENT_LIMITS.maximumRefetchPasses);
    expect(client.state()).toMatchObject({ mode: "degraded", reasonCode: "refetch_limit" });
    client.stop();
  });

  it("strictly rejects stale generations, cursor drift, accessors, and payload-bearing notifications", async () => {
    const badGeneration = snapshot() as unknown as Record<string, unknown>;
    const badRows = structuredClone(snapshot().rows) as Array<Record<string, unknown>>;
    (badRows[0]!.lastObservation as { generation: { sourceGeneration: number } }).generation.sourceGeneration = 2;
    badGeneration.rows = badRows;
    const badCursor = { ...snapshot(), nextCursor: encodeControlRoomObservationCursor({ schemaVersion: 1, runEpoch: EPOCH, afterSeq: 0 }) };
    let getterInvoked = 0;
    const getter = {} as Record<string, unknown>;
    Object.defineProperty(getter, "schemaVersion", { enumerable: true, get() { getterInvoked += 1; return 1; } });
    for (const invalid of [badGeneration, badCursor, getter]) {
      const scheduler = new FakeScheduler();
      const client = createControlRoomClient({ transport: transport([invalid]), scheduler });
      await client.start();
      expect(client.state()).toMatchObject({ mode: "degraded", reasonCode: "snapshot_failed" });
      client.stop();
    }
    expect(getterInvoked).toBe(0);

    const source = transport([snapshot()]);
    const client = createControlRoomClient({ transport: source });
    await client.start();
    source.emit({ type: "control.changed", runEpoch: EPOCH, seq: 2, records: [{ raw: "terminal" }] });
    await settle();
    expect(client.state().snapshot?.eventHeadSeq).toBe(1);
    client.stop();
  });

  it("aborts the active request and unsubscribes exactly once on stop", async () => {
    let aborted = false;
    let resolveFetch: (() => void) | undefined;
    const source = transport([]);
    source.fetchSnapshot = async (signal) => await new Promise((_resolve, reject) => {
      resolveFetch = () => reject(new Error("stopped"));
      signal.addEventListener("abort", () => { aborted = true; resolveFetch?.(); }, { once: true });
    });
    const client = createControlRoomClient({ transport: source });
    const start = client.start();
    await Promise.resolve();
    client.stop();
    await start;
    client.stop();
    expect(aborted).toBe(true);
    expect(source.unsubscribes).toBe(1);
    expect(client.state().mode).toBe("stopped");
  });
});

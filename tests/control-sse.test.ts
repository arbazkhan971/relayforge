import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { controlEventDigest, parseControlEvent, type ControlEventType, type PersistedControlEvent } from "../src/control/events.js";
import {
  CONTROL_PROTOCOL_VERSION,
  CONTROL_SSE_FRAME_MAX_BYTES,
  ControlPayloadTooLargeError,
  ControlProtocolError,
  type ControlSseNotification
} from "../src/control/protocol.js";
import {
  CONTROL_SSE_HEARTBEAT_FRAME,
  DurableSseBroker,
  SseBrokerClosedError,
  SseCapacityError,
  encodeControlSseNotification,
  type DurableSseRange,
  type DurableSseSource,
  type DurableSseWake,
  type SseSink
} from "../src/control/sse.js";
import { openControlStore, type ControlStore } from "../src/control/store.js";

const NOW = "2026-08-09T00:00:00.000Z";
const RUN_EPOCH = "epoch_0123456789abcdef";
const OTHER_EPOCH = "epoch_fedcba9876543210";
const roots: string[] = [];
const stores: ControlStore[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // A test may already have closed a store before reopening it.
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function persisted(seq: number, body = `private canonical body ${seq}`): PersistedControlEvent {
  const event = parseControlEvent({
    schemaVersion: 1,
    eventId: `event-${seq}`,
    runId: "run-1",
    runEpoch: RUN_EPOCH,
    taskId: null,
    taskGeneration: null,
    expectedVersion: seq - 1,
    occurredAt: NOW,
    type: "message.posted",
    payload: {
      messageId: `message-${seq}`,
      from: "parent",
      to: "backend",
      body
    }
  });
  const digest = controlEventDigest(event);
  return Object.assign(event, { seq, recordedAt: NOW, intentDigest: digest, digest });
}

const CANONICAL_EVENT_TYPES = [
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.checkpointed",
  "task.created",
  "task.reopened",
  "task.status_changed",
  "message.posted",
  "runtime.observed",
  "attempt.prompt_prepared",
  "attempt.launch_planned",
  "attempt.started",
  "attempt.exited",
  "attempt.abandoned",
  "steering.command_admitted",
  "steering.command_refused",
  "steering.command_terminal_refused",
  "steering.command_included",
  "steering.command_withdrawn",
  "steering.command_superseded",
  "steering.command_expired",
  "scm.publication_recorded",
  "scm.publication_state_changed",
  "scm.poll_started",
  "scm.poll_completed",
  "scm.poll_failed",
  "scm.bucket_accepted",
  "scm.reaction_created",
  "scm.reaction_transitioned",
  "observation.source_checkpointed",
  "observation.recorded",
  "multirepo.plan_registered",
  "multirepo.scheduler_transitioned",
  "multirepo.worktree_group_recorded",
  "multirepo.worker_settled",
  "multirepo.worktree_commit_intended",
  "multirepo.worktree_head_recorded",
  "multirepo.integration_transitioned",
  "multirepo.local_integration_receipted",
  "multirepo.publication_transitioned"
] as const satisfies readonly ControlEventType[];

function persistedAsType(seq: number, type: ControlEventType): PersistedControlEvent {
  // The SSE source contract consumes already-validated persisted facts and must use only their
  // common identity metadata. A hostile payload canary proves no subsystem payload reaches a frame.
  return Object.freeze({
    ...persisted(seq, `PRIVATE_${type}_PAYLOAD`),
    type,
    payload: Object.freeze({ privateCanary: `PRIVATE_${type}_PAYLOAD` })
  }) as unknown as PersistedControlEvent;
}

class FakeSource implements DurableSseSource {
  readonly runId = "run-1";
  readonly runEpoch = RUN_EPOCH;
  floorSeq = 1;
  events: PersistedControlEvent[];
  subscribers = new Set<(wake: DurableSseWake) => void>();
  subscribeCalls = 0;
  unsubscribeCalls = 0;
  readCalls = 0;
  operations: string[] = [];
  afterCapture: ((source: FakeSource) => void) | undefined;

  constructor(events: PersistedControlEvent[] = []) {
    this.events = events;
  }

  subscribe(subscriber: (wake: DurableSseWake) => void): () => void {
    this.operations.push("subscribe");
    this.subscribeCalls += 1;
    this.subscribers.add(subscriber);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.unsubscribeCalls += 1;
      this.subscribers.delete(subscriber);
    };
  }

  head() {
    this.operations.push("head");
    return {
      runId: this.runId,
      runEpoch: this.runEpoch,
      floorSeq: this.floorSeq,
      headSeq: this.events.at(-1)?.seq ?? 0
    };
  }

  readRange(options: { afterSeq: number; limit?: number; runEpoch?: string }): DurableSseRange {
    this.operations.push("read");
    this.readCalls += 1;
    if (options.runEpoch !== undefined && options.runEpoch !== this.runEpoch) {
      throw Object.assign(new Error("wrong epoch"), { code: "RUN_IDENTITY_MISMATCH" });
    }
    const capturedHead = this.events.at(-1)?.seq ?? 0;
    if (options.afterSeq < this.floorSeq - 1) {
      throw Object.assign(new Error("expired"), { code: "CURSOR_EXPIRED" });
    }
    const limit = options.limit ?? 1_000;
    const selected = this.events.filter((event) => event.seq > options.afterSeq && event.seq <= capturedHead).slice(0, limit);
    const hook = this.afterCapture;
    this.afterCapture = undefined;
    hook?.(this);
    return {
      runEpoch: this.runEpoch,
      floorSeq: this.floorSeq,
      headSeq: capturedHead,
      afterSeq: options.afterSeq,
      events: selected,
      hasMore: selected.length > 0 && selected[selected.length - 1]!.seq < capturedHead
    };
  }

  append(event: PersistedControlEvent): void {
    this.events.push(event);
    const wake = { runEpoch: this.runEpoch, headSeq: event.seq };
    for (const subscriber of this.subscribers) subscriber(wake);
  }

  wakeWithEpoch(runEpoch: string): void {
    const wake = { runEpoch, headSeq: this.events.at(-1)?.seq ?? 0 };
    for (const subscriber of this.subscribers) subscriber(wake);
  }
}

class RecordingSink implements SseSink {
  readonly frames: string[] = [];
  endCalls = 0;
  backpressure: (frame: string) => boolean = () => false;
  onWrite: ((frame: string) => void) | undefined;
  private readonly drainWaiters: Array<{ resolve: () => void; reject: () => void; signal: AbortSignal }> = [];

  write(frame: string): boolean {
    this.frames.push(frame);
    this.onWrite?.(frame);
    return !this.backpressure(frame);
  }

  waitForDrain(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolvePromise, reject) => {
      const waiter = {
        resolve: resolvePromise,
        reject: () => reject(new Error("cancelled")),
        signal
      };
      this.drainWaiters.push(waiter);
      signal.addEventListener("abort", waiter.reject, { once: true });
      if (signal.aborted) waiter.reject();
    });
  }

  drainOne(): void {
    const waiter = this.drainWaiters.shift();
    if (waiter === undefined) throw new Error("no drain waiter");
    waiter.signal.removeEventListener("abort", waiter.reject);
    waiter.resolve();
  }

  end(): void {
    this.endCalls += 1;
  }
}

function eventIds(frames: readonly string[]): number[] {
  const ids: number[] = [];
  for (const frame of frames) {
    const match = /^id: ([0-9]+)$/m.exec(frame);
    if (match !== null) ids.push(Number(match[1]));
  }
  return ids;
}

function eventsNamed(frames: readonly string[], name: string): string[] {
  return frames.filter((frame) => frame.includes(`event: ${name}\n`));
}

async function spinUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition did not become true");
}

function streamOptions(source: DurableSseSource, sink: SseSink, signal?: AbortSignal) {
  return {
    source,
    sink,
    project: "demo",
    run: "run-1",
    cursor: { runEpoch: RUN_EPOCH, after: "0" },
    signal
  };
}

describe("durable SSE replay and race closure", () => {
  it("maps every closed canonical fact to metadata-only control.changed without a cursor gap", async () => {
    const facts = CANONICAL_EVENT_TYPES.map((type, index) => persistedAsType(index + 1, type));
    const source = new FakeSource(facts);
    const sink = new RecordingSink();
    const controller = new AbortController();
    sink.onWrite = (frame) => {
      if (frame.startsWith(`id: ${facts.length}\n`)) controller.abort();
    };

    const result = await new DurableSseBroker().stream(streamOptions(source, sink, controller.signal));
    expect(eventIds(sink.frames)).toEqual(facts.map((event) => event.seq));
    expect(result).toMatchObject({ reason: "aborted", lastSentSeq: facts.length, notificationsSent: facts.length });
    const wire = sink.frames.join("\n");
    expect(wire).not.toContain("PRIVATE_");
    expect(wire).not.toContain("privateCanary");
    expect(wire).not.toContain("payload");
  });

  it("resumes across SCM, observation, and multi-repository facts from one durable cursor", async () => {
    const source = new FakeSource([
      persisted(1),
      persistedAsType(2, "scm.poll_completed"),
      persistedAsType(3, "observation.recorded"),
      persistedAsType(4, "multirepo.publication_transitioned")
    ]);
    const sink = new RecordingSink();
    const controller = new AbortController();
    sink.onWrite = (frame) => {
      if (frame.startsWith("id: 4\n")) controller.abort();
    };

    const result = await new DurableSseBroker().stream({
      source,
      sink,
      project: "demo",
      run: "run-1",
      cursor: { runEpoch: RUN_EPOCH, after: "1" },
      signal: controller.signal
    });
    expect(eventIds(sink.frames)).toEqual([2, 3, 4]);
    expect(result).toMatchObject({ reason: "aborted", lastSentSeq: 4, notificationsSent: 3 });
    expect(sink.frames.join("\n")).not.toContain("PRIVATE_");
  });

  it("subscribes before replay and catches a commit made after the captured head", async () => {
    const source = new FakeSource([persisted(1, "CANARY_PRIVATE_PAYLOAD")]);
    source.afterCapture = (captured) => captured.append(persisted(2, "SECOND_PRIVATE_PAYLOAD"));
    const sink = new RecordingSink();
    const controller = new AbortController();
    sink.onWrite = (frame) => {
      if (frame.startsWith("id: 2\n")) controller.abort();
    };

    const result = await new DurableSseBroker().stream(streamOptions(source, sink, controller.signal));
    expect(source.operations.slice(0, 3)).toEqual(["subscribe", "head", "read"]);
    expect(eventIds(sink.frames)).toEqual([1, 2]);
    expect(result).toMatchObject({ reason: "aborted", lastSentSeq: 2, notificationsSent: 2 });
    expect(sink.frames.join("\n")).not.toContain("CANARY_PRIVATE_PAYLOAD");
    expect(sink.frames.join("\n")).not.toContain("SECOND_PRIVATE_PAYLOAD");
    expect(source.unsubscribeCalls).toBe(1);
    expect(sink.endCalls).toBe(1);
  });

  it("honors Last-Event-ID over the original query cursor", async () => {
    const source = new FakeSource([persisted(1), persisted(2)]);
    const sink = new RecordingSink();
    const controller = new AbortController();
    sink.onWrite = (frame) => {
      if (frame.startsWith("id: 2\n")) controller.abort();
    };
    const result = await new DurableSseBroker().stream({
      source,
      sink,
      project: "demo",
      run: "run-1",
      cursor: { runEpoch: RUN_EPOCH, after: "0", lastEventId: "1" },
      signal: controller.signal
    });
    expect(eventIds(sink.frames)).toEqual([2]);
    expect(result.lastSentSeq).toBe(2);
  });

  it("rejects a malformed present Last-Event-ID before subscribing", () => {
    const source = new FakeSource([persisted(1)]);
    expect(() =>
      new DurableSseBroker().stream({
        source,
        sink: new RecordingSink(),
        project: "demo",
        run: "run-1",
        cursor: { runEpoch: RUN_EPOCH, after: "0", lastEventId: "1x" }
      })
    ).toThrow(ControlProtocolError);
    expect(source.subscribeCalls).toBe(0);
  });

  it("uses an id-less ready cursor on first connect and follows only later commits", async () => {
    const source = new FakeSource([persisted(1)]);
    const sink = new RecordingSink();
    const controller = new AbortController();
    sink.onWrite = (frame) => {
      if (frame.includes("event: control.ready")) source.append(persisted(2));
      if (frame.startsWith("id: 2\n")) controller.abort();
    };
    const result = await new DurableSseBroker().stream({
      source,
      sink,
      project: "demo",
      run: "run-1",
      signal: controller.signal
    });
    expect(eventsNamed(sink.frames, "control.ready")).toHaveLength(1);
    expect(eventsNamed(sink.frames, "control.ready")[0]).not.toContain("id:");
    expect(eventIds(sink.frames)).toEqual([2]);
    expect(result.lastSentSeq).toBe(2);
  });

  it("coalesces many lossy wakes into one durable catch-up", async () => {
    const source = new FakeSource();
    const sink = new RecordingSink();
    const controller = new AbortController();
    sink.onWrite = (frame) => {
      if (frame.startsWith("id: 3\n")) controller.abort();
    };
    const pending = new DurableSseBroker().stream(streamOptions(source, sink, controller.signal));
    await spinUntil(() => source.subscribers.size === 1);
    source.events.push(persisted(1), persisted(2), persisted(3));
    source.wakeWithEpoch(RUN_EPOCH);
    source.wakeWithEpoch(RUN_EPOCH);
    source.wakeWithEpoch(RUN_EPOCH);
    const result = await pending;
    expect(eventIds(sink.frames)).toEqual([1, 2, 3]);
    expect(result.lastSentSeq).toBe(3);
  });
});

describe("resync and bound decisions", () => {
  it.each([
    ["epoch", new FakeSource([persisted(1)]), { runEpoch: OTHER_EPOCH, after: "0" }],
    ["cursor-expired", Object.assign(new FakeSource([persisted(3)]), { floorSeq: 3 }), { runEpoch: RUN_EPOCH, after: "1" }],
    ["future-cursor", new FakeSource([persisted(1)]), { runEpoch: RUN_EPOCH, after: "2" }]
  ] as const)("emits id-less %s resync and closes", async (reason, source, cursor) => {
    const sink = new RecordingSink();
    const result = await new DurableSseBroker().stream({ source, sink, project: "demo", run: "run-1", cursor });
    expect(result).toMatchObject({ reason: "resync", resyncReason: reason, notificationsSent: 0 });
    expect(eventIds(sink.frames)).toEqual([]);
    expect(eventsNamed(sink.frames, "control.resync-required")).toHaveLength(1);
    expect(sink.frames[0]).toContain(`"reason":"${reason}"`);
    expect(source.unsubscribeCalls).toBe(1);
  });

  it("accepts exact replay/queue frame counts and resyncs before any delta at plus one", async () => {
    const exactSource = new FakeSource([persisted(1), persisted(2)]);
    const exactSink = new RecordingSink();
    const exactAbort = new AbortController();
    exactSink.onWrite = (frame) => {
      if (frame.startsWith("id: 2\n")) exactAbort.abort();
    };
    const exactBroker = new DurableSseBroker({ limits: { maxReplayEvents: 2, maxQueueFrames: 2 } });
    const exact = await exactBroker.stream(streamOptions(exactSource, exactSink, exactAbort.signal));
    expect(eventIds(exactSink.frames)).toEqual([1, 2]);
    expect(exact.lastSentSeq).toBe(2);

    const overSource = new FakeSource([persisted(1), persisted(2), persisted(3)]);
    const overSink = new RecordingSink();
    const over = await new DurableSseBroker({ limits: { maxReplayEvents: 2, maxQueueFrames: 2 } }).stream(
      streamOptions(overSource, overSink)
    );
    expect(over).toMatchObject({ reason: "resync", resyncReason: "replay-budget", notificationsSent: 0 });
    expect(eventIds(overSink.frames)).toEqual([]);
  });

  it("enforces exact individual-frame, replay-byte, and queue-byte limits", async () => {
    const notification: ControlSseNotification = {
      v: CONTROL_PROTOCOL_VERSION,
      type: "control.changed",
      project: "demo",
      run: "run-1",
      taskId: null,
      runEpoch: RUN_EPOCH,
      seq: 1,
      headSeq: 1,
      viewSeq: 1
    };
    const encoded = encodeControlSseNotification(notification);
    expect(encodeControlSseNotification(notification, encoded.bytes)).toEqual(encoded);
    expect(() => encodeControlSseNotification(notification, encoded.bytes - 1)).toThrow(ControlPayloadTooLargeError);
    expect(encoded.bytes).toBeLessThan(CONTROL_SSE_FRAME_MAX_BYTES);

    const exactSource = new FakeSource([persisted(1)]);
    const exactSink = new RecordingSink();
    const exactAbort = new AbortController();
    exactSink.onWrite = (frame) => {
      if (frame.startsWith("id: 1\n")) exactAbort.abort();
    };
    const exact = await new DurableSseBroker({
      limits: { maxFrameBytes: encoded.bytes, maxReplayBytes: encoded.dataBytes, maxQueueBytes: encoded.bytes }
    }).stream(streamOptions(exactSource, exactSink, exactAbort.signal));
    expect(exact.lastSentSeq).toBe(1);

    for (const limits of [
      { maxReplayBytes: encoded.dataBytes - 1 },
      { maxQueueBytes: encoded.bytes - 1 }
    ]) {
      const source = new FakeSource([persisted(1)]);
      const sink = new RecordingSink();
      const result = await new DurableSseBroker({ limits }).stream(streamOptions(source, sink));
      expect(result).toMatchObject({ reason: "resync", resyncReason: "replay-budget" });
      expect(eventIds(sink.frames)).toEqual([]);
    }
  });

  it("turns an unknown durable event mapping into schema resync without advancing", async () => {
    const unknown = Object.assign({}, persisted(1), { type: "future.event" }) as PersistedControlEvent;
    const source = new FakeSource([unknown]);
    const sink = new RecordingSink();
    const result = await new DurableSseBroker().stream(streamOptions(source, sink));
    expect(result).toMatchObject({ reason: "resync", resyncReason: "schema", lastSentSeq: 0, notificationsSent: 0 });
    expect(eventIds(sink.frames)).toEqual([]);
  });

  it("treats an impossible live wake epoch as explicit epoch resync", async () => {
    const source = new FakeSource();
    const sink = new RecordingSink();
    const pending = new DurableSseBroker().stream(streamOptions(source, sink));
    await spinUntil(() => source.subscribers.size === 1);
    source.wakeWithEpoch(OTHER_EPOCH);
    const result = await pending;
    expect(result).toMatchObject({ reason: "resync", resyncReason: "epoch", lastSentSeq: 0 });
    expect(eventIds(sink.frames)).toEqual([]);
  });
});

describe("heartbeat, backpressure, capacity, and cleanup", () => {
  it("writes id-less heartbeats and cancels every wait on abort", async () => {
    vi.useFakeTimers();
    const source = new FakeSource();
    const sink = new RecordingSink();
    const controller = new AbortController();
    sink.onWrite = (frame) => {
      if (frame === CONTROL_SSE_HEARTBEAT_FRAME) controller.abort();
    };
    const pending = new DurableSseBroker({ limits: { heartbeatMs: 10 } }).stream({
      source,
      sink,
      project: "demo",
      run: "run-1",
      signal: controller.signal
    });
    await spinUntil(() => eventsNamed(sink.frames, "control.ready").length === 1);
    await vi.advanceTimersByTimeAsync(10);
    const result = await pending;
    expect(sink.frames).toContain(CONTROL_SSE_HEARTBEAT_FRAME);
    expect(CONTROL_SSE_HEARTBEAT_FRAME).not.toContain("id:");
    expect(result.reason).toBe("aborted");
    expect(source.unsubscribeCalls).toBe(1);
    expect(sink.endCalls).toBe(1);
  });

  it("waits for drain before advancing the durable sent cursor", async () => {
    const source = new FakeSource([persisted(1)]);
    const sink = new RecordingSink();
    sink.backpressure = (frame) => frame.startsWith("id: 1\n");
    const controller = new AbortController();
    const pending = new DurableSseBroker({ limits: { drainTimeoutMs: 1_000 } }).stream(
      streamOptions(source, sink, controller.signal)
    );
    await spinUntil(() => eventIds(sink.frames).length === 1);
    sink.drainOne();
    source.wakeWithEpoch(RUN_EPOCH);
    await spinUntil(() => source.readCalls >= 2);
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ reason: "aborted", lastSentSeq: 1, notificationsSent: 1 });
  });

  it("disconnects a non-draining sink within the exact timeout and emits best-effort slow control", async () => {
    vi.useFakeTimers();
    const source = new FakeSource([persisted(1)]);
    const sink = new RecordingSink();
    sink.backpressure = (frame) => frame.startsWith("id: 1\n");
    const pending = new DurableSseBroker({ limits: { drainTimeoutMs: 10 } }).stream(streamOptions(source, sink));
    await spinUntil(() => eventIds(sink.frames).length === 1);
    await vi.advanceTimersByTimeAsync(9);
    expect(source.unsubscribeCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result).toMatchObject({ reason: "slow-client", lastSentSeq: 0, notificationsSent: 0 });
    expect(eventsNamed(sink.frames, "control.slow-client")).toHaveLength(1);
    expect(source.unsubscribeCalls).toBe(1);
    expect(sink.endCalls).toBe(1);
  });

  it("caps subscribers, releases the slot on cancellation, and refuses after shutdown", async () => {
    const broker = new DurableSseBroker({ limits: { maxSubscribers: 1 } });
    const firstSource = new FakeSource();
    const firstSink = new RecordingSink();
    const controller = new AbortController();
    const first = broker.stream(streamOptions(firstSource, firstSink, controller.signal));
    await spinUntil(() => broker.activeSubscribers === 1);
    expect(() => broker.stream(streamOptions(new FakeSource(), new RecordingSink()))).toThrow(SseCapacityError);
    controller.abort();
    expect((await first).reason).toBe("aborted");
    expect(broker.activeSubscribers).toBe(0);
    await broker.shutdown();
    expect(() => broker.stream(streamOptions(new FakeSource(), new RecordingSink()))).toThrow(SseBrokerClosedError);
  });

  it("emits id-less closing control and unregisters all subscribers on broker shutdown", async () => {
    const broker = new DurableSseBroker();
    const source = new FakeSource();
    const sink = new RecordingSink();
    const stream = broker.stream(streamOptions(source, sink));
    await spinUntil(() => source.subscribers.size === 1);
    await broker.shutdown();
    const result = await stream;
    expect(result.reason).toBe("shutdown");
    expect(eventsNamed(sink.frames, "control.closing")).toHaveLength(1);
    expect(eventIds(eventsNamed(sink.frames, "control.closing"))).toEqual([]);
    expect(source.unsubscribeCalls).toBe(1);
    expect(broker.activeSubscribers).toBe(0);
  });

  it("does not subscribe when the caller is already cancelled", async () => {
    const source = new FakeSource();
    const sink = new RecordingSink();
    const controller = new AbortController();
    controller.abort();
    const result = await new DurableSseBroker().stream(streamOptions(source, sink, controller.signal));
    expect(result.reason).toBe("aborted");
    expect(source.subscribeCalls).toBe(0);
    expect(sink.endCalls).toBe(1);
  });
});

describe("durable service restart replay", () => {
  it("replays the committed sequence after closing and reopening the real store", async () => {
    const root = mkdtempSync(join(tmpdir(), "relayforge-control-sse-"));
    roots.push(root);
    const path = join(root, "control.sqlite");
    const first = openControlStore({ path, runId: "run-1", runEpoch: RUN_EPOCH, now: () => NOW });
    stores.push(first);
    const record = persisted(1);
    const {
      seq: _seq,
      recordedAt: _recordedAt,
      intentDigest: _intentDigest,
      digest: _digest,
      ...event
    } = record;
    first.append(event);
    first.close();
    stores.splice(stores.indexOf(first), 1);

    const reopened = openControlStore({ path, runId: "run-1", runEpoch: RUN_EPOCH, create: false, now: () => NOW });
    stores.push(reopened);
    const sink = new RecordingSink();
    const controller = new AbortController();
    sink.onWrite = (frame) => {
      if (frame.startsWith("id: 1\n")) controller.abort();
    };
    const result = await new DurableSseBroker().stream(streamOptions(reopened, sink, controller.signal));
    expect(eventIds(sink.frames)).toEqual([1]);
    expect(result).toMatchObject({ reason: "aborted", lastSentSeq: 1, notificationsSent: 1 });
  });
});

import vm from "node:vm";
import { TextEncoder } from "node:util";
import { describe, expect, it } from "vitest";
import { DASHBOARD_CLIENT_JS } from "../src/dashboard/render.js";

type DashboardDebug = {
  state: "connecting" | "connected" | "reconnecting" | "degraded" | "stale" | "error";
  baseOrigin: string;
  instanceId: string | null;
  selectedRun: string | null;
  runEpoch: string | null;
  lastApplied: number | null;
  failedOpenings: number;
  retryAttempt: number;
  hasSource: boolean;
  retryTimerActive: boolean;
  debounceTimerActive: boolean;
  pollTimerActive: boolean;
  polling: boolean;
  activeRequests: number;
  stopped: boolean;
  lastErrorKind: string | null;
  scheduledRetryDelays: number[];
};

type DashboardController = {
  start(): void;
  stop(): void;
  refresh(): void;
  debug(): DashboardDebug;
};

class FakeElement {
  innerHTML = "";
  textContent = "";
  dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Array<() => void>>();

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(name: string, listener: () => void): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
}

type Timer = { id: number; due: number; callback: () => void };

class FakeScheduler {
  now = 0;
  private nextId = 1;
  private readonly timers = new Map<number, Timer>();

  setTimeout = (callback: () => void, delay: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { id, due: this.now + Math.max(0, delay), callback });
    return id;
  };

  clearTimeout = (id: number): void => {
    this.timers.delete(id);
  };

  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    while (true) {
      const due = [...this.timers.values()]
        .filter((timer) => timer.due <= target)
        .sort((left, right) => left.due - right.due || left.id - right.id)[0];
      if (!due) break;
      this.now = due.due;
      this.timers.delete(due.id);
      due.callback();
      await settle();
    }
    this.now = target;
    await settle();
  }

  get pendingCount(): number {
    return this.timers.size;
  }
}

class FakeEventSource {
  static readonly instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Array<(event: { data: string; lastEventId: string }) => void>>();
  readyState = 0;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: (() => void) | null = null;

  constructor(
    readonly url: string,
    private readonly trace: string[]
  ) {
    FakeEventSource.instances.push(this);
    trace.push(`sse:${new URL(url).pathname}`);
  }

  addEventListener(name: string, listener: (event: { data: string; lastEventId: string }) => void): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  error(readyState = 2): void {
    this.readyState = readyState;
    this.onerror?.();
  }

  emit(name: string, value: unknown, lastEventId = ""): void {
    const event = { data: typeof value === "string" ? value : JSON.stringify(value), lastEventId };
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  emitMessage(): void {
    this.onmessage?.();
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
}

type FixtureState = {
  origin: string;
  instanceId: string;
  configId: string;
  runEpoch: string;
  headSeq: number;
  viewSeq: number;
  floorSeq: number;
};

type Harness = Awaited<ReturnType<typeof createHarness>>;

describe("P1 dashboard snapshot and stream client", () => {
  it("loads and escapes the strict normalized control-room snapshot when the P5 surface is present", async () => {
    const harness = await createHarness({ observations: "valid" });
    expect(harness.trace).toEqual([
      "fetch:/api/v1/status",
      "fetch:/api/v1/runs/run-1/board",
      "fetch:/api/v1/runs/run-1/activity",
      "fetch:/api/v1/runs/run-1/steering",
      "fetch:/api/v1/runs/run-1/observations",
      "sse:/api/v1/runs/run-1/events"
    ]);
    const rendered = harness.elements.get("observations")!.innerHTML;
    expect(rendered).toContain("worker-1");
    expect(rendered).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(rendered).not.toContain("<img");
    expect(rendered).not.toContain("kind\":\"progress");
  });

  it("rejects an observation response with unknown fields before rendering or opening SSE", async () => {
    const harness = await createHarness({ observations: "unknown-field" });
    expect(harness.sources).toHaveLength(0);
    expect(harness.elements.get("observations")!.innerHTML).toBe("");
    expect(harness.elements.get("attention-strip")!.innerHTML).toContain("unavailable or invalid");
    expect(harness.controller.debug()).toMatchObject({ lastErrorKind: "protocol", retryTimerActive: true });
  });

  it("loads a strict board/activity snapshot before opening SSE from its exact durable cursor", async () => {
    const harness = await createHarness();

    expect(harness.trace).toEqual([
      "fetch:/api/v1/status",
      "fetch:/api/v1/runs/run-1/board",
      "fetch:/api/v1/runs/run-1/activity",
      "fetch:/api/v1/runs/run-1/steering",
      "sse:/api/v1/runs/run-1/events"
    ]);
    expect(harness.sources).toHaveLength(1);
    const streamUrl = new URL(harness.sources[0]!.url);
    expect(streamUrl.searchParams.get("project")).toBe("demo");
    expect(streamUrl.searchParams.get("runEpoch")).toBe(harness.state.runEpoch);
    expect(streamUrl.searchParams.get("after")).toBe("5");
    expect(harness.controller.debug()).toMatchObject({
      selectedRun: "run-1",
      runEpoch: harness.state.runEpoch,
      lastApplied: 5,
      state: "connecting"
    });
    expect(harness.elements.get("kanban")!.innerHTML).toContain("Implement control client");
    expect(harness.elements.get("steering")!.innerHTML).toContain("Pending; eligible for attempt 2");
    expect(harness.fetchUrls.every((url) => new URL(url).pathname.startsWith("/api/v1/"))).toBe(true);
  });

  it("refetches on every open and coalesces multiple valid invalidations into one bounded refresh", async () => {
    const harness = await createHarness();
    const source = harness.sources[0]!;
    const initialFetches = harness.fetchUrls.length;

    source.open();
    await settle();
    expect(harness.fetchUrls).toHaveLength(initialFetches + 4);
    expect(harness.controller.debug().state).toBe("connected");

    harness.state.headSeq = 7;
    harness.state.viewSeq = 7;
    source.emit("control.changed", changed(harness, 6), "6");
    source.emit("control.changed", changed(harness, 7), "7");
    expect(harness.controller.debug()).toMatchObject({ state: "stale", lastApplied: 7, debounceTimerActive: true });
    expect(harness.fetchUrls).toHaveLength(initialFetches + 4);

    await harness.scheduler.advance(74);
    expect(harness.fetchUrls).toHaveLength(initialFetches + 4);
    await harness.scheduler.advance(1);
    expect(harness.fetchUrls).toHaveLength(initialFetches + 8);
    expect(harness.controller.debug()).toMatchObject({ state: "connected", lastApplied: 7, debounceTimerActive: false });
    expect(harness.sources).toHaveLength(1);
  });

  it("recreates a terminally closed source with capped cursor-preserving backoff", async () => {
    const harness = await createHarness();
    let source = harness.sources[0]!;
    const expected = [250, 500, 1_000, 2_000, 4_000, 5_000, 5_000];

    for (const delay of expected) {
      source.error(2);
      await settle();
      expect(harness.controller.debug().retryTimerActive).toBe(true);
      await harness.scheduler.advance(delay - 1);
      expect(harness.sources.at(-1)).toBe(source);
      await harness.scheduler.advance(1);
      source = harness.sources.at(-1)!;
      expect(new URL(source.url).searchParams.get("after")).toBe("5");
    }

    expect(harness.controller.debug().scheduledRetryDelays).toEqual(expected);
    expect(Math.max(...harness.controller.debug().scheduledRetryDelays)).toBe(5_000);
  });

  it("performs a terminal full resync and opens a fresh epoch only after the replacement snapshot", async () => {
    const harness = await createHarness();
    const oldSource = harness.sources[0]!;
    harness.state.runEpoch = "epoch_00000000002";
    harness.state.headSeq = 9;
    harness.state.viewSeq = 9;

    oldSource.emit("control.resync-required", {
      v: 1,
      type: "control.resync-required",
      reason: "epoch",
      runEpoch: harness.state.runEpoch,
      floorSeq: 1,
      headSeq: 9,
      snapshotSeq: 9
    });
    expect(harness.controller.debug().state).toBe("stale");
    await settle();

    expect(oldSource.closed).toBe(true);
    expect(harness.sources).toHaveLength(2);
    const replacement = new URL(harness.sources[1]!.url);
    expect(replacement.searchParams.get("runEpoch")).toBe(harness.state.runEpoch);
    expect(replacement.searchParams.get("after")).toBe("9");
    expect(harness.controller.debug()).toMatchObject({ runEpoch: harness.state.runEpoch, lastApplied: 9 });
  });

  it.each([
    ["malformed", (_h: Harness) => ({ v: 1 }), "6"],
    ["foreign", (h: Harness) => ({ ...changed(h, 6), project: "other" }), "6"],
    ["decreasing", (h: Harness) => changed(h, 5), "5"]
  ])("rejects %s notifications without advancing its cursor", async (_label, makeValue, eventId) => {
    const harness = await createHarness();
    const source = harness.sources[0]!;
    source.emit("control.changed", makeValue(harness), eventId);
    await settle();

    expect(source.closed).toBe(true);
    expect(harness.controller.debug()).toMatchObject({ state: "error", lastApplied: 5, lastErrorKind: "protocol", retryTimerActive: true });
  });

  it("strictly rejects malformed control frames", async () => {
    const harness = await createHarness();
    const source = harness.sources[0]!;
    source.emit("control.ready", {
      v: 1,
      type: "control.ready",
      runEpoch: harness.state.runEpoch,
      floorSeq: 1,
      headSeq: 5,
      viewSeq: 5,
      unexpected: true
    });
    await settle();

    expect(source.closed).toBe(true);
    expect(harness.controller.debug()).toMatchObject({ state: "error", lastErrorKind: "protocol" });
  });

  it("enables exactly one degraded polling loop after repeated native reconnect failures and disables it after recovery", async () => {
    const harness = await createHarness();
    const source = harness.sources[0]!;
    const beforePoll = harness.fetchUrls.length;

    source.error(0);
    source.error(0);
    source.error(0);
    source.error(0);
    await settle();
    expect(harness.controller.debug()).toMatchObject({ state: "degraded", polling: true, pollTimerActive: true });

    await harness.scheduler.advance(2_499);
    expect(harness.fetchUrls).toHaveLength(beforePoll);
    await harness.scheduler.advance(1);
    expect(harness.fetchUrls).toHaveLength(beforePoll + 4);
    expect(harness.controller.debug()).toMatchObject({ polling: true, pollTimerActive: true });

    source.open();
    await settle();
    expect(harness.controller.debug()).toMatchObject({ state: "connected", polling: false, pollTimerActive: false, failedOpenings: 0 });
  });

  it("replaces the source after base and instance changes, using the refreshed durable cursor", async () => {
    const harness = await createHarness();
    const oldSource = harness.sources[0]!;
    oldSource.open();
    await settle();

    harness.state.origin = "http://127.0.0.1:4319";
    harness.location.origin = harness.state.origin;
    harness.state.instanceId = "b".repeat(64);
    harness.state.headSeq = 8;
    harness.state.viewSeq = 8;
    harness.controller.refresh();
    await harness.scheduler.advance(75);

    expect(oldSource.closed).toBe(true);
    expect(harness.controller.debug()).toMatchObject({ baseOrigin: harness.state.origin, instanceId: harness.state.instanceId, lastApplied: 8, retryTimerActive: true });
    await harness.scheduler.advance(250);
    const replacement = harness.sources.at(-1)!;
    expect(replacement).not.toBe(oldSource);
    expect(new URL(replacement.url).origin).toBe(harness.state.origin);
    expect(new URL(replacement.url).searchParams.get("after")).toBe("8");
  });

  it("aborts in-flight refreshes and clears the source and every timer on page teardown", async () => {
    const harness = await createHarness();
    const source = harness.sources[0]!;
    source.open();
    await settle();

    harness.pendingFetches = 1;
    harness.state.headSeq = 6;
    harness.state.viewSeq = 6;
    source.emit("control.changed", changed(harness, 6), "6");
    await harness.scheduler.advance(75);
    expect(harness.controller.debug().activeRequests).toBe(1);

    harness.windowListeners.get("beforeunload")?.[0]?.();
    await settle();
    expect(source.closed).toBe(true);
    expect(harness.abortedFetches).toBe(1);
    expect(harness.controller.debug()).toMatchObject({
      stopped: true,
      hasSource: false,
      retryTimerActive: false,
      debounceTimerActive: false,
      pollTimerActive: false,
      activeRequests: 0
    });
    expect(harness.scheduler.pendingCount).toBe(0);
  });
});

async function createHarness(harnessOptions: { observations?: "valid" | "unknown-field" } = {}) {
  FakeEventSource.instances.length = 0;
  const scheduler = new FakeScheduler();
  const trace: string[] = [];
  const fetchUrls: string[] = [];
  const elements = new Map<string, FakeElement>();
  for (const id of ["connection", "livetext", "refresh-button", "kpis", "attention-strip", "agents-count", "agents", "board-count", "kanban", "timeline", "steering-count", "steering"]) {
    elements.set(id, new FakeElement());
  }
  if (harnessOptions.observations !== undefined) {
    elements.set("observations-count", new FakeElement());
    elements.set("observations", new FakeElement());
  }
  const body = new FakeElement();
  body.dataset.project = "demo";
  const document = { body, getElementById: (id: string) => elements.get(id) ?? null };
  const location = { origin: "http://127.0.0.1:4318" };
  const state: FixtureState = {
    origin: location.origin,
    instanceId: "a".repeat(64),
    configId: "c".repeat(64),
    runEpoch: "epoch_00000000001",
    headSeq: 5,
    viewSeq: 5,
    floorSeq: 1
  };
  const windowListeners = new Map<string, Array<() => void>>();
  let controller: DashboardController | undefined;
  let pendingFetches = 0;
  let abortedFetches = 0;

  const fetch = (rawUrl: string, requestOptions: { signal?: AbortSignal } = {}) => {
    const url = new URL(rawUrl);
    fetchUrls.push(rawUrl);
    trace.push(`fetch:${url.pathname}`);
    if (pendingFetches > 0) {
      pendingFetches -= 1;
      return new Promise<never>((_resolve, reject) => {
        const abort = () => {
          abortedFetches += 1;
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        };
        if (requestOptions.signal?.aborted) abort();
        else requestOptions.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (url.pathname === "/api/v1/status") return Promise.resolve(jsonResponse(statusDto(state)));
    if (url.pathname === "/api/v1/runs/run-1/board") return Promise.resolve(jsonResponse(boardDto(state)));
    if (url.pathname === "/api/v1/runs/run-1/activity") return Promise.resolve(jsonResponse(activityDto(state)));
    if (url.pathname === "/api/v1/runs/run-1/steering") return Promise.resolve(jsonResponse(steeringDto(state)));
    if (url.pathname === "/api/v1/runs/run-1/observations") {
      const dto = observationDto(state) as ReturnType<typeof observationDto> & { unexpected?: boolean };
      if (harnessOptions.observations === "unknown-field") dto.unexpected = true;
      return Promise.resolve(jsonResponse(dto));
    }
    return Promise.reject(new Error(`Unexpected non-P1 route: ${url.pathname}`));
  };

  class HarnessEventSource extends FakeEventSource {
    constructor(url: string) {
      super(url, trace);
    }
  }

  const context = {
    document,
    location,
    fetch,
    EventSource: HarnessEventSource,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    AbortController,
    TextEncoder,
    URL,
    Math: Object.assign(Object.create(Math) as Math, { random: () => 0 }),
    __RELAYFORGE_DASHBOARD_TEST_HOOK__: (value: DashboardController) => {
      controller = value;
    },
    addEventListener: (name: string, listener: () => void) => {
      const listeners = windowListeners.get(name) ?? [];
      listeners.push(listener);
      windowListeners.set(name, listeners);
    }
  };
  vm.runInNewContext(DASHBOARD_CLIENT_JS, context, { filename: "relayforge-dashboard-client.js" });
  await settle();
  if (!controller) throw new Error("Dashboard test hook was not invoked.");

  return {
    scheduler,
    trace,
    fetchUrls,
    elements,
    location,
    state,
    windowListeners,
    controller,
    get sources(): FakeEventSource[] {
      return FakeEventSource.instances;
    },
    get pendingFetches(): number {
      return pendingFetches;
    },
    set pendingFetches(value: number) {
      pendingFetches = value;
    },
    get abortedFetches(): number {
      return abortedFetches;
    }
  };
}

function changed(harness: Harness, seq: number) {
  return {
    v: 1,
    type: "control.changed",
    project: "demo",
    run: "run-1",
    taskId: "t1",
    runEpoch: harness.state.runEpoch,
    seq,
    headSeq: Math.max(seq, harness.state.headSeq),
    viewSeq: Math.max(seq, harness.state.viewSeq)
  };
}

function statusDto(state: FixtureState) {
  return {
    schemaVersion: 1,
    service: "relayforge-control",
    instanceId: state.instanceId,
    configId: state.configId,
    status: "ok",
    startedAt: "2026-08-09T12:00:00.000Z",
    projects: [
      {
        project: "demo",
        latestRun: {
          project: "demo",
          run: "run-1",
          runEpoch: state.runEpoch,
          status: "running",
          reason: null,
          startedAt: "2026-08-09T12:00:01.000Z",
          updatedAt: "2026-08-09T12:00:05.000Z",
          completedAt: null,
          viewSeq: state.viewSeq,
          headSeq: state.headSeq,
          floorSeq: state.floorSeq,
          stale: false,
          tasks: counts()
        },
        sessions: [
          {
            name: "loop-demo-run-1-dev",
            project: "demo",
            run: "run-1",
            role: "dev",
            state: "running",
            taskId: "t1",
            lastActivity: "2026-08-09T12:00:05.000Z"
          }
        ]
      }
    ]
  };
}

function boardDto(state: FixtureState) {
  return {
    schemaVersion: 1,
    project: "demo",
    run: "run-1",
    runEpoch: state.runEpoch,
    viewSeq: state.viewSeq,
    headSeq: state.headSeq,
    floorSeq: state.floorSeq,
    stale: false,
    tasks: [
      {
        id: "t1",
        title: "Implement control client",
        status: "in-progress",
        assignee: "dev",
        claimedBy: "dev",
        priority: 10,
        dependsOn: [],
        attempts: 1,
        createdAt: "2026-08-09T12:00:01.000Z",
        updatedAt: "2026-08-09T12:00:05.000Z",
        summary: "Typed dashboard transport"
      }
    ],
    counts: counts()
  };
}

function activityDto(state: FixtureState) {
  return {
    schemaVersion: 1,
    project: "demo",
    run: "run-1",
    runEpoch: state.runEpoch,
    viewSeq: state.viewSeq,
    headSeq: state.headSeq,
    floorSeq: state.floorSeq,
    stale: false,
    activity: [
      {
        seq: state.headSeq,
        occurredAt: "2026-08-09T12:00:05.000Z",
        kind: "task.started",
        actor: "dev",
        taskId: "t1",
        status: "in-progress",
        summary: "Typed dashboard transport"
      }
    ],
    nextAfter: null
  };
}

function steeringDto(state: FixtureState) {
  return {
    schemaVersion: 1,
    project: "demo",
    run: "run-1",
    runEpoch: state.runEpoch,
    observedSeq: state.viewSeq,
    headSeq: state.headSeq,
    floorSeq: state.floorSeq,
    stale: state.viewSeq < state.headSeq,
    queue: { pendingCount: 1, oldestPendingAgeMs: 2_000 },
    sessions: [
      {
        sessionId: "loop-demo-run-1-dev",
        sessionGeneration: 3,
        taskId: "t1",
        taskGeneration: 1,
        activity: "waiting_input",
        activityLabel: "Waiting for next prompt",
        certainty: "proven",
        reason: "safe prompt boundary available",
        observedAt: "2026-08-09T12:00:05.000Z",
        observedAgeMs: 0,
        observedSeq: state.viewSeq,
        headSeq: state.headSeq,
        stale: state.viewSeq < state.headSeq,
        queue: {
          pendingCount: 1,
          oldestPendingAgeMs: 2_000,
          nextEligibleAttemptGeneration: 2,
          boundaryReason: "safe-prompt-boundary"
        }
      }
    ],
    commandCount: 1,
    commandsTruncated: false,
    commands: [
      {
        commandId: "command-1",
        status: "pending",
        statusLabel: "Pending",
        statusDetail: "Pending; eligible for attempt 2",
        sourceKind: "operator",
        admittedSeq: 5,
        admittedAt: "2026-08-09T12:00:03.000Z",
        terminalSeq: null,
        sessionId: "loop-demo-run-1-dev",
        sessionGeneration: 3,
        taskId: "t1",
        taskGeneration: 1,
        notBeforeAttemptGeneration: 2,
        eligibleAttemptGeneration: 2,
        bodySha256: "d".repeat(64),
        preview: "repair the exact failing assertion",
        reasonCode: null,
        supersededByCommandId: null,
        attempt: null
      }
    ]
  };
}

function observationDto(state: FixtureState) {
  const summaryText = "<img src=x onerror=alert(1)>";
  const summaryBytes = Buffer.byteLength(summaryText);
  const record = {
    schemaVersion: 1,
    seq: state.headSeq,
    recordId: "observation-1",
    generation: { runId: "run-1", runEpoch: state.runEpoch, taskId: "t1", agentId: "worker-1", runtimeGeneration: 1, attemptGeneration: 1, sourceGeneration: 1 },
    observedAt: "2026-08-09T12:00:05.000Z",
    recordedAt: "2026-08-09T12:00:05.000Z",
    category: "provider",
    phase: "executing",
    severity: "info",
    code: "provider.progress",
    details: { kind: "progress", operationCode: "turn.running" },
    sourceIntegrity: "live",
    summary: { text: summaryText, redacted: false, truncated: false, originalBytes: summaryBytes, retainedBytes: summaryBytes }
  };
  return {
    schemaVersion: 1,
    runId: "run-1",
    runEpoch: state.runEpoch,
    eventHeadSeq: state.headSeq,
    rows: [{
      agentId: "worker-1",
      taskId: "t1",
      runtimeGeneration: 1,
      attemptGeneration: 1,
      sourceGeneration: 1,
      activity: "active",
      attention: "working",
      taskStatus: "claimed",
      steeringState: "none",
      pendingCommands: 0,
      scmState: "unpublished",
      verificationState: "pending",
      sourceIntegrity: "live",
      sourceStateCode: "source.live",
      sourceDroppedRecords: 0,
      sourceDroppedBytes: 0,
      lastFactSeq: state.headSeq,
      lastObservedAt: "2026-08-09T12:00:05.000Z",
      lastObservation: record
    }],
    observationPage: {
      schemaVersion: 1,
      runId: "run-1",
      runEpoch: state.runEpoch,
      snapshotSeq: state.headSeq,
      projectionSeq: state.headSeq,
      firstAvailableSeq: 1,
      nextAfter: state.headSeq,
      truncated: false,
      droppedRecords: 0,
      droppedBytes: 0,
      freshness: "fresh",
      records: [record],
      sources: [{ agentId: "worker-1", runtimeGeneration: 1, attemptGeneration: 1, sourceGeneration: 1, integrity: "live", lastObservedAt: "2026-08-09T12:00:05.000Z", droppedRecords: 0, droppedBytes: 0 }]
    },
    nextCursor: "v1.abc"
  };
}

function counts() {
  return { total: 1, open: 0, active: 1, needsReview: 0, blocked: 0, done: 0, rejected: 0, escalated: 0 };
}

function jsonResponse(value: unknown) {
  const body = JSON.stringify(value);
  return {
    status: 200,
    headers: {
      get(name: string) {
        if (name.toLowerCase() === "content-type") return "application/json; charset=utf-8";
        if (name.toLowerCase() === "content-length") return String(Buffer.byteLength(body));
        return null;
      }
    },
    text: () => Promise.resolve(body)
  };
}

async function settle(rounds = 40): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

import { Buffer } from "node:buffer";
import type { ServerResponse } from "node:http";
import { isValidId } from "../ids.js";
import type { ControlEventType, PersistedControlEvent } from "./events.js";
import {
  CONTROL_MAX_SSE_CLIENTS,
  CONTROL_PROTOCOL_VERSION,
  CONTROL_SSE_DRAIN_TIMEOUT_MS,
  CONTROL_SSE_FRAME_MAX_BYTES,
  CONTROL_SSE_HEARTBEAT_MS,
  CONTROL_SSE_REPLAY_MAX_BYTES,
  CONTROL_SSE_REPLAY_MAX_EVENTS,
  ControlPayloadTooLargeError,
  parseControlSseControlFrame,
  parseControlSseNotification,
  parseSseCursor,
  serializeControlJson,
  type ControlSseControlFrame,
  type ControlSseNotification,
  type SseCursor,
  type SseCursorInput
} from "./protocol.js";

export const CONTROL_SSE_QUEUE_MAX_FRAMES = CONTROL_SSE_REPLAY_MAX_EVENTS;
export const CONTROL_SSE_QUEUE_MAX_BYTES = CONTROL_SSE_REPLAY_MAX_BYTES;
export const CONTROL_SSE_HEARTBEAT_FRAME = ": keep-alive\n\n";

export type DurableSseHead = {
  runId: string;
  runEpoch: string;
  floorSeq: number;
  headSeq: number;
};

export type DurableSseRange = {
  runEpoch: string;
  floorSeq: number;
  headSeq: number;
  afterSeq: number;
  events: PersistedControlEvent[];
  hasMore: boolean;
};

export type DurableSseWake = {
  runEpoch: string;
  headSeq: number;
};

/** The minimal canonical-store surface B2 consumes. */
export type DurableSseSource = {
  readonly runId: string;
  readonly runEpoch: string;
  subscribe(subscriber: (wake: DurableSseWake) => void): () => void;
  head(): DurableSseHead;
  readRange(options: { afterSeq: number; limit?: number; runEpoch?: string }): DurableSseRange;
};

/** A response-like sink. `write(false)` means the bytes were accepted but drain is required. */
export type SseSink = {
  write(frame: string): boolean;
  waitForDrain(signal: AbortSignal): Promise<void>;
  end(): void;
};

export type DurableSseLimits = {
  maxSubscribers: number;
  maxReplayEvents: number;
  maxReplayBytes: number;
  maxQueueFrames: number;
  maxQueueBytes: number;
  maxFrameBytes: number;
  drainTimeoutMs: number;
  heartbeatMs: number;
};

export type DurableSseBrokerOptions = {
  limits?: Partial<DurableSseLimits>;
  scheduler?: Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
};

export type DurableSseStreamOptions = {
  source: DurableSseSource;
  sink: SseSink;
  project: string;
  run: string;
  cursor?: SseCursorInput;
  signal?: AbortSignal;
};

export type SseResyncReason = "epoch" | "cursor-expired" | "future-cursor" | "replay-budget" | "schema";
export type SseStreamEndReason = "resync" | "slow-client" | "aborted" | "closed" | "shutdown" | "source-error";

export type DurableSseStreamResult = {
  reason: SseStreamEndReason;
  resyncReason?: SseResyncReason;
  lastSentSeq: number;
  notificationsSent: number;
  framesWritten: number;
  bytesWritten: number;
};

export type EncodedSseFrame = {
  text: string;
  bytes: number;
  dataBytes: number;
  seq: number | null;
};

type ResolvedScheduler = {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
};

type EndSignal = "shutdown" | "aborted";
type WaitOutcome = "wake" | "heartbeat" | EndSignal;
type WriteOutcome = "ok" | "slow" | "closed" | EndSignal;

type StreamMetrics = {
  lastSentSeq: number;
  notificationsSent: number;
  framesWritten: number;
  bytesWritten: number;
};

type QueuedNotification = {
  frame: EncodedSseFrame;
  seq: number;
};

type PreflightBatch = {
  floorSeq: number;
  headSeq: number;
  queue: QueuedNotification[];
};

/**
 * Every closed canonical fact maps to the same payload-free wake notification. Keeping this as an
 * exhaustive Record makes a newly registered ControlEventType a compile failure until SSE replay is
 * considered explicitly; silently skipping an event would make the durable cursor jump a fact.
 */
const MAPPED_EVENT_TYPE_MEMBERS = Object.freeze({
  "run.started": true,
  "run.completed": true,
  "run.failed": true,
  "run.cancelled": true,
  "run.checkpointed": true,
  "task.created": true,
  "task.reopened": true,
  "task.status_changed": true,
  "message.posted": true,
  "runtime.observed": true,
  "attempt.prompt_prepared": true,
  "attempt.launch_planned": true,
  "attempt.started": true,
  "attempt.exited": true,
  "attempt.abandoned": true,
  "steering.command_admitted": true,
  "steering.command_refused": true,
  "steering.command_terminal_refused": true,
  "steering.command_included": true,
  "steering.command_withdrawn": true,
  "steering.command_superseded": true,
  "steering.command_expired": true,
  "scm.publication_recorded": true,
  "scm.publication_state_changed": true,
  "scm.poll_started": true,
  "scm.poll_completed": true,
  "scm.poll_failed": true,
  "scm.bucket_accepted": true,
  "scm.reaction_created": true,
  "scm.reaction_transitioned": true,
  "observation.source_checkpointed": true,
  "observation.recorded": true,
  "multirepo.plan_registered": true,
  "multirepo.scheduler_transitioned": true,
  "multirepo.worktree_group_recorded": true,
  "multirepo.worker_settled": true,
  "multirepo.worktree_commit_intended": true,
  "multirepo.worktree_head_recorded": true,
  "multirepo.integration_transitioned": true,
  "multirepo.local_integration_receipted": true,
  "multirepo.publication_transitioned": true
} as const satisfies Readonly<Record<ControlEventType, true>>);

const MAPPED_EVENT_TYPES: ReadonlySet<ControlEventType> = new Set(
  Object.keys(MAPPED_EVENT_TYPE_MEMBERS) as ControlEventType[]
);

class StreamState {
  dirty = true;
  badWakeEpoch = false;
  termination: EndSignal | null = null;
  waiter: ((outcome: WaitOutcome) => void) | undefined;
  drainInterrupt: (() => void) | undefined;
  done: Promise<void> = Promise.resolve();

  wake(wake: DurableSseWake, expectedEpoch: string): void {
    if (wake.runEpoch !== expectedEpoch) this.badWakeEpoch = true;
    this.dirty = true;
    this.waiter?.("wake");
  }

  terminate(reason: EndSignal): void {
    if (this.termination !== null) return;
    this.termination = reason;
    this.waiter?.(reason);
    this.drainInterrupt?.();
  }
}

export class SseCapacityError extends Error {
  readonly code = "CAPACITY_EXCEEDED";

  constructor(readonly maximum: number) {
    super(`The SSE subscriber limit of ${maximum} has been reached.`);
    this.name = "SseCapacityError";
  }
}

export class SseBrokerClosedError extends Error {
  readonly code = "BROKER_CLOSED";

  constructor() {
    super("The SSE broker is shutting down.");
    this.name = "SseBrokerClosedError";
  }
}

class SseSourceContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SseSourceContractError";
  }
}

/**
 * Run-scoped durable SSE broker. It owns no event authority: subscribers are lossy wakeups and
 * every notification is reconstructed from the canonical store sequence.
 */
export class DurableSseBroker {
  readonly limits: Readonly<DurableSseLimits>;
  private readonly scheduler: ResolvedScheduler;
  private readonly sessions = new Set<StreamState>();
  private closing = false;

  constructor(options: DurableSseBrokerOptions = {}) {
    this.limits = Object.freeze(resolveLimits(options.limits));
    const scheduler = options.scheduler ?? globalThis;
    this.scheduler = {
      setTimeout(callback, delay) {
        return scheduler.setTimeout(callback, delay);
      },
      clearTimeout(handle) {
        scheduler.clearTimeout(handle as ReturnType<typeof setTimeout>);
      }
    };
  }

  get activeSubscribers(): number {
    return this.sessions.size;
  }

  stream(options: DurableSseStreamOptions): Promise<DurableSseStreamResult> {
    validateStreamIdentity(options);
    const cursor = parseSseCursor(options.cursor ?? {});
    if (this.closing) throw new SseBrokerClosedError();
    if (this.sessions.size >= this.limits.maxSubscribers) throw new SseCapacityError(this.limits.maxSubscribers);

    const state = new StreamState();
    this.sessions.add(state);
    const execution = this.runStream(options, cursor, state).finally(() => {
      this.sessions.delete(state);
    });
    state.done = execution.then(
      () => undefined,
      () => undefined
    );
    return execution;
  }

  async shutdown(): Promise<void> {
    if (!this.closing) {
      this.closing = true;
      for (const session of this.sessions) session.terminate("shutdown");
    }
    await Promise.all(Array.from(this.sessions, (session) => session.done));
  }

  private async runStream(
    options: DurableSseStreamOptions,
    cursor: SseCursor | null,
    state: StreamState
  ): Promise<DurableSseStreamResult> {
    const metrics: StreamMetrics = {
      lastSentSeq: cursor?.after ?? 0,
      notificationsSent: 0,
      framesWritten: 0,
      bytesWritten: 0
    };
    let unsubscribe: (() => void) | undefined;
    let ended = false;
    const finishSink = (): void => {
      if (ended) return;
      ended = true;
      try {
        options.sink.end();
      } catch {
        // The stream is already terminal; sink cleanup is best effort.
      }
    };

    const abort = (): void => state.terminate("aborted");
    if (options.signal !== undefined) {
      if (options.signal.aborted) state.terminate("aborted");
      else options.signal.addEventListener("abort", abort, { once: true });
    }

    try {
      if (state.termination !== null) return resultFor(state.termination, metrics);

      // This registration is intentionally synchronous and precedes every head/range read.
      unsubscribe = options.source.subscribe((wake) => state.wake(wake, options.source.runEpoch));
      const initial = validateHead(options.source.head(), options.source, options.run);

      if (cursor !== null && cursor.runEpoch !== initial.runEpoch) {
        return await this.resync(options.sink, state, metrics, initial, "epoch");
      }
      if (cursor !== null && cursor.after < initial.floorSeq - 1) {
        return await this.resync(options.sink, state, metrics, initial, "cursor-expired");
      }
      if (cursor !== null && cursor.after > initial.headSeq) {
        return await this.resync(options.sink, state, metrics, initial, "future-cursor");
      }

      if (cursor === null) {
        metrics.lastSentSeq = initial.headSeq;
        const ready = parseControlSseControlFrame({
          v: CONTROL_PROTOCOL_VERSION,
          type: "control.ready",
          runEpoch: initial.runEpoch,
          floorSeq: Math.min(initial.floorSeq, initial.headSeq),
          headSeq: initial.headSeq,
          viewSeq: initial.headSeq
        });
        const outcome = await this.writeFrame(options.sink, encodeControlSseControlFrame(ready, this.limits.maxFrameBytes), state, metrics);
        const terminal = await this.resultForWrite(outcome, options.sink, state, metrics);
        if (terminal !== null) return terminal;
      }

      while (true) {
        const termination = await this.handleTermination(options.sink, state, metrics);
        if (termination !== null) return termination;
        if (state.badWakeEpoch) {
          const current = validateHead(options.source.head(), options.source, options.run);
          return await this.resync(options.sink, state, metrics, current, "epoch");
        }

        state.dirty = false;
        let batch: PreflightBatch;
        try {
          batch = this.preflight(options, metrics.lastSentSeq);
        } catch (error) {
          const current = bestEffortHead(options.source, options.run);
          const reason = classifySourceError(error);
          if (current !== null && reason !== null) return await this.resync(options.sink, state, metrics, current, reason);
          return resultFor("source-error", metrics);
        }

        for (const item of batch.queue) {
          const beforeWrite = await this.handleTermination(options.sink, state, metrics);
          if (beforeWrite !== null) return beforeWrite;
          const outcome = await this.writeFrame(options.sink, item.frame, state, metrics);
          const terminal = await this.resultForWrite(outcome, options.sink, state, metrics);
          if (terminal !== null) return terminal;
          metrics.lastSentSeq = item.seq;
          metrics.notificationsSent += 1;
        }
        if (metrics.lastSentSeq !== batch.headSeq) {
          const current = { runId: options.run, runEpoch: options.source.runEpoch, floorSeq: batch.floorSeq, headSeq: batch.headSeq };
          return await this.resync(options.sink, state, metrics, current, "schema");
        }

        if (state.dirty) continue;
        const wait = await waitForActivity(state, this.scheduler, this.limits.heartbeatMs);
        if (wait === "wake") continue;
        if (wait === "shutdown" || wait === "aborted") continue;

        const heartbeat = encodeHeartbeat(this.limits.maxFrameBytes);
        const outcome = await this.writeFrame(options.sink, heartbeat, state, metrics);
        const terminal = await this.resultForWrite(outcome, options.sink, state, metrics);
        if (terminal !== null) return terminal;
      }
    } catch {
      return resultFor("source-error", metrics);
    } finally {
      options.signal?.removeEventListener("abort", abort);
      try {
        unsubscribe?.();
      } catch {
        // Subscription cleanup is idempotent by contract; a faulty source cannot block sink close.
      }
      finishSink();
    }
  }

  private preflight(options: DurableSseStreamOptions, afterSeq: number): PreflightBatch {
    const fetchLimit = Math.min(this.limits.maxReplayEvents, this.limits.maxQueueFrames) + 1;
    const range = options.source.readRange({
      afterSeq,
      limit: fetchLimit,
      runEpoch: options.source.runEpoch
    });
    validateRange(range, options.source, afterSeq);
    if (
      range.hasMore ||
      range.events.length > this.limits.maxReplayEvents ||
      range.events.length > this.limits.maxQueueFrames
    ) {
      throw new ControlPayloadTooLargeError(
        Math.min(this.limits.maxReplayEvents, this.limits.maxQueueFrames),
        range.events.length
      );
    }

    const queue: QueuedNotification[] = [];
    let replayBytes = 0;
    let queueBytes = 0;
    let previousSeq = afterSeq;
    for (const event of range.events) {
      validatePersistedEvent(event, options.source, previousSeq, range.headSeq);
      const notification = mapPersistedEvent(event, options.project, options.run, range.headSeq);
      const frame = encodeControlSseNotification(notification, this.limits.maxFrameBytes);
      replayBytes += frame.dataBytes;
      queueBytes += frame.bytes;
      if (replayBytes > this.limits.maxReplayBytes || queueBytes > this.limits.maxQueueBytes) {
        throw new ControlPayloadTooLargeError(
          Math.min(this.limits.maxReplayBytes, this.limits.maxQueueBytes),
          Math.max(replayBytes, queueBytes)
        );
      }
      queue.push({ frame, seq: event.seq });
      previousSeq = event.seq;
    }
    if (queue.length === 0 && range.headSeq !== afterSeq) throw new SseSourceContractError("The durable range skipped its head.");
    return { floorSeq: range.floorSeq, headSeq: range.headSeq, queue };
  }

  private async resync(
    sink: SseSink,
    state: StreamState,
    metrics: StreamMetrics,
    head: DurableSseHead,
    reason: SseResyncReason
  ): Promise<DurableSseStreamResult> {
    const snapshotSeq = reason === "cursor-expired" ? Math.max(0, head.floorSeq - 1) : head.headSeq;
    const frame = parseControlSseControlFrame({
      v: CONTROL_PROTOCOL_VERSION,
      type: "control.resync-required",
      reason,
      runEpoch: head.runEpoch,
      floorSeq: head.floorSeq,
      headSeq: head.headSeq,
      snapshotSeq
    });
    const outcome = await this.writeFrame(sink, encodeControlSseControlFrame(frame, this.limits.maxFrameBytes), state, metrics);
    const terminal = await this.resultForWrite(outcome, sink, state, metrics);
    if (terminal !== null) return terminal;
    return resultFor("resync", metrics, reason);
  }

  private async writeFrame(
    sink: SseSink,
    frame: EncodedSseFrame,
    state: StreamState,
    metrics: StreamMetrics
  ): Promise<WriteOutcome> {
    let accepted: boolean;
    try {
      accepted = sink.write(frame.text);
      metrics.framesWritten += 1;
      metrics.bytesWritten += frame.bytes;
    } catch {
      return "closed";
    }
    if (accepted) return "ok";
    return await waitForDrain(sink, state, this.scheduler, this.limits.drainTimeoutMs);
  }

  private async resultForWrite(
    outcome: WriteOutcome,
    sink: SseSink,
    state: StreamState,
    metrics: StreamMetrics
  ): Promise<DurableSseStreamResult | null> {
    if (outcome === "ok") return null;
    if (outcome === "slow") {
      bestEffortControl(sink, metrics, () => slowClientFrame(this.limits.maxFrameBytes));
      return resultFor("slow-client", metrics);
    }
    if (outcome === "shutdown") return await this.handleTermination(sink, state, metrics);
    return resultFor(outcome, metrics);
  }

  private async handleTermination(
    sink: SseSink,
    state: StreamState,
    metrics: StreamMetrics
  ): Promise<DurableSseStreamResult | null> {
    if (state.termination === null) return null;
    if (state.termination === "shutdown") {
      bestEffortControl(sink, metrics, () => closingFrame(this.limits.maxFrameBytes));
    }
    return resultFor(state.termination, metrics);
  }
}

/** Strictly encode one allowlisted ordinary SSE notification. */
export function encodeControlSseNotification(
  value: ControlSseNotification,
  maxFrameBytes = CONTROL_SSE_FRAME_MAX_BYTES
): EncodedSseFrame {
  const notification = parseControlSseNotification(value);
  return encodeDataFrame(notification.type, notification.seq, notification, maxFrameBytes);
}

/** Strictly encode an id-less transport control frame. */
export function encodeControlSseControlFrame(
  value: ControlSseControlFrame,
  maxFrameBytes = CONTROL_SSE_FRAME_MAX_BYTES
): EncodedSseFrame {
  const control = parseControlSseControlFrame(value);
  return encodeDataFrame(control.type, null, control, maxFrameBytes);
}

/** Adapt a Node ServerResponse without making the broker own HTTP headers or routing. */
export function createNodeSseSink(response: ServerResponse): SseSink {
  return {
    write(frame) {
      return response.write(frame, "utf8");
    },
    waitForDrain(signal) {
      if (response.destroyed || response.writableEnded) return Promise.reject(new Error("response is closed"));
      return new Promise<void>((resolvePromise, reject) => {
        const cleanup = (): void => {
          response.off("drain", onDrain);
          response.off("close", onClose);
          response.off("error", onError);
          signal.removeEventListener("abort", onAbort);
        };
        const onDrain = (): void => {
          cleanup();
          resolvePromise();
        };
        const onClose = (): void => {
          cleanup();
          reject(new Error("response closed before drain"));
        };
        const onError = (): void => {
          cleanup();
          reject(new Error("response errored before drain"));
        };
        const onAbort = (): void => {
          cleanup();
          reject(new Error("drain wait cancelled"));
        };
        response.once("drain", onDrain);
        response.once("close", onClose);
        response.once("error", onError);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    },
    end() {
      if (!response.writableEnded) response.end();
    }
  };
}

function resolveLimits(partial: Partial<DurableSseLimits> | undefined): DurableSseLimits {
  return {
    maxSubscribers: boundedLimit("maxSubscribers", partial?.maxSubscribers, CONTROL_MAX_SSE_CLIENTS),
    maxReplayEvents: boundedLimit("maxReplayEvents", partial?.maxReplayEvents, CONTROL_SSE_REPLAY_MAX_EVENTS),
    maxReplayBytes: boundedLimit("maxReplayBytes", partial?.maxReplayBytes, CONTROL_SSE_REPLAY_MAX_BYTES),
    maxQueueFrames: boundedLimit("maxQueueFrames", partial?.maxQueueFrames, CONTROL_SSE_QUEUE_MAX_FRAMES),
    maxQueueBytes: boundedLimit("maxQueueBytes", partial?.maxQueueBytes, CONTROL_SSE_QUEUE_MAX_BYTES),
    maxFrameBytes: boundedLimit("maxFrameBytes", partial?.maxFrameBytes, CONTROL_SSE_FRAME_MAX_BYTES),
    drainTimeoutMs: boundedLimit("drainTimeoutMs", partial?.drainTimeoutMs, CONTROL_SSE_DRAIN_TIMEOUT_MS),
    heartbeatMs: boundedLimit("heartbeatMs", partial?.heartbeatMs, CONTROL_SSE_HEARTBEAT_MS)
  };
}

function boundedLimit(name: string, supplied: number | undefined, maximum: number): number {
  const value = supplied ?? maximum;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be a safe integer between 1 and ${maximum}.`);
  }
  return value;
}

function validateStreamIdentity(options: DurableSseStreamOptions): void {
  if (!isValidId(options.project) || !isValidId(options.run) || options.source.runId !== options.run) {
    throw new SseSourceContractError("The SSE route identity is invalid.");
  }
  // Reuse the strict epoch grammar without accepting a cursor from the caller.
  parseSseCursor({ runEpoch: options.source.runEpoch, after: "0" });
}

function validateHead(head: DurableSseHead, source: DurableSseSource, run: string): DurableSseHead {
  if (
    head.runId !== run ||
    head.runId !== source.runId ||
    head.runEpoch !== source.runEpoch ||
    !Number.isSafeInteger(head.floorSeq) ||
    head.floorSeq < 1 ||
    !Number.isSafeInteger(head.headSeq) ||
    head.headSeq < 0 ||
    head.floorSeq > head.headSeq + 1
  ) {
    throw new SseSourceContractError("The durable head violates the SSE source contract.");
  }
  return head;
}

function bestEffortHead(source: DurableSseSource, run: string): DurableSseHead | null {
  try {
    return validateHead(source.head(), source, run);
  } catch {
    return null;
  }
}

function validateRange(range: DurableSseRange, source: DurableSseSource, afterSeq: number): void {
  if (
    range.runEpoch !== source.runEpoch ||
    range.afterSeq !== afterSeq ||
    !Number.isSafeInteger(range.floorSeq) ||
    range.floorSeq < 1 ||
    !Number.isSafeInteger(range.headSeq) ||
    range.headSeq < afterSeq ||
    range.floorSeq > range.headSeq + 1 ||
    afterSeq < range.floorSeq - 1 ||
    !Array.isArray(range.events) ||
    typeof range.hasMore !== "boolean"
  ) {
    throw new SseSourceContractError("The durable range violates the SSE source contract.");
  }
}

function validatePersistedEvent(
  event: PersistedControlEvent,
  source: DurableSseSource,
  previousSeq: number,
  headSeq: number
): void {
  if (
    event.schemaVersion !== CONTROL_PROTOCOL_VERSION ||
    event.runId !== source.runId ||
    event.runEpoch !== source.runEpoch ||
    !Number.isSafeInteger(event.seq) ||
    event.seq <= previousSeq ||
    event.seq > headSeq ||
    !MAPPED_EVENT_TYPES.has(event.type)
  ) {
    throw new SseSourceContractError("A persisted event cannot be mapped to the v1 SSE contract.");
  }
}

function mapPersistedEvent(
  event: PersistedControlEvent,
  project: string,
  run: string,
  headSeq: number
): ControlSseNotification {
  return parseControlSseNotification({
    v: CONTROL_PROTOCOL_VERSION,
    type: "control.changed",
    project,
    run,
    taskId: event.taskId,
    runEpoch: event.runEpoch,
    seq: event.seq,
    headSeq,
    viewSeq: event.seq
  });
}

function encodeDataFrame(
  eventName: string,
  seq: number | null,
  value: ControlSseNotification | ControlSseControlFrame,
  maxFrameBytes: number
): EncodedSseFrame {
  const serialized = serializeControlJson(value, maxFrameBytes);
  const idLine = seq === null ? "" : `id: ${seq}\n`;
  const text = `${idLine}event: ${eventName}\ndata: ${serialized.json}\n\n`;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxFrameBytes) throw new ControlPayloadTooLargeError(maxFrameBytes, bytes);
  return { text, bytes, dataBytes: serialized.bytes, seq };
}

function encodeHeartbeat(maxFrameBytes: number): EncodedSseFrame {
  const bytes = Buffer.byteLength(CONTROL_SSE_HEARTBEAT_FRAME, "utf8");
  if (bytes > maxFrameBytes) throw new ControlPayloadTooLargeError(maxFrameBytes, bytes);
  return { text: CONTROL_SSE_HEARTBEAT_FRAME, bytes, dataBytes: 0, seq: null };
}

function slowClientFrame(maxFrameBytes: number): EncodedSseFrame {
  return encodeControlSseControlFrame(
    parseControlSseControlFrame({ v: CONTROL_PROTOCOL_VERSION, type: "control.slow-client", reason: "backpressure" }),
    maxFrameBytes
  );
}

function closingFrame(maxFrameBytes: number): EncodedSseFrame {
  return encodeControlSseControlFrame(
    parseControlSseControlFrame({ v: CONTROL_PROTOCOL_VERSION, type: "control.closing", reason: "shutdown" }),
    maxFrameBytes
  );
}

function bestEffortWrite(sink: SseSink, frame: EncodedSseFrame, metrics: StreamMetrics): void {
  try {
    sink.write(frame.text);
    metrics.framesWritten += 1;
    metrics.bytesWritten += frame.bytes;
  } catch {
    // Terminal control frames are explicitly best effort.
  }
}

function bestEffortControl(sink: SseSink, metrics: StreamMetrics, create: () => EncodedSseFrame): void {
  try {
    bestEffortWrite(sink, create(), metrics);
  } catch {
    // A deliberately tiny injected frame cap may make even terminal control data unwritable.
  }
}

function waitForActivity(state: StreamState, scheduler: ResolvedScheduler, heartbeatMs: number): Promise<WaitOutcome> {
  if (state.termination !== null) return Promise.resolve(state.termination);
  if (state.dirty) return Promise.resolve("wake");
  return new Promise<WaitOutcome>((resolvePromise) => {
    let settled = false;
    let timer: unknown;
    const finish = (outcome: WaitOutcome): void => {
      if (settled) return;
      settled = true;
      scheduler.clearTimeout(timer);
      if (state.waiter === finish) state.waiter = undefined;
      resolvePromise(outcome);
    };
    state.waiter = finish;
    timer = scheduler.setTimeout(() => finish("heartbeat"), heartbeatMs);
    if (state.termination !== null) finish(state.termination);
    else if (state.dirty) finish("wake");
  });
}

function waitForDrain(
  sink: SseSink,
  state: StreamState,
  scheduler: ResolvedScheduler,
  timeoutMs: number
): Promise<WriteOutcome> {
  if (state.termination !== null) return Promise.resolve(state.termination);
  return new Promise<WriteOutcome>((resolvePromise) => {
    let settled = false;
    const controller = new AbortController();
    let timer: unknown;
    const finish = (outcome: WriteOutcome): void => {
      if (settled) return;
      settled = true;
      scheduler.clearTimeout(timer);
      if (state.drainInterrupt === interrupted) state.drainInterrupt = undefined;
      controller.abort();
      resolvePromise(outcome);
    };
    const interrupted = (): void => finish(state.termination ?? "closed");
    state.drainInterrupt = interrupted;
    timer = scheduler.setTimeout(() => finish("slow"), timeoutMs);
    sink.waitForDrain(controller.signal).then(
      () => finish("ok"),
      () => finish(state.termination ?? "closed")
    );
    if (state.termination !== null) interrupted();
  });
}

function classifySourceError(error: unknown): SseResyncReason | null {
  if (error instanceof ControlPayloadTooLargeError) return "replay-budget";
  if (error instanceof SseSourceContractError) return "schema";
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "CURSOR_EXPIRED") return "cursor-expired";
  if (code === "RUN_IDENTITY_MISMATCH") return "epoch";
  if (code === "RECOVERY_REQUIRED" || code === "INVALID_EVENT") return "schema";
  return null;
}

function resultFor(reason: SseStreamEndReason | EndSignal, metrics: StreamMetrics, resyncReason?: SseResyncReason): DurableSseStreamResult {
  const result: DurableSseStreamResult = {
    reason,
    lastSentSeq: metrics.lastSentSeq,
    notificationsSent: metrics.notificationsSent,
    framesWritten: metrics.framesWritten,
    bytesWritten: metrics.bytesWritten
  };
  if (resyncReason !== undefined) result.resyncReason = resyncReason;
  return result;
}

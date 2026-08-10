import { z } from "zod";
import { ObservationPageV1Schema, PublicObservationV1Schema } from "../observability/types.js";
import { assertObservationSafeGraph } from "../observability/public.js";
import type { ControlRoomAgentRowV1 } from "./projection.js";
import { decodeControlRoomObservationCursor } from "./query.js";

export const CONTROL_ROOM_CLIENT_LIMITS = Object.freeze({
  maximumRows: 512,
  maximumRefetchPasses: 3,
  degradedPollMs: 5_000,
  maximumCursorBytes: 512
});

const Seq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Timestamp = z.string().length(24).refine((value) => {
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString() === value;
});
const Id = z.string().min(1).max(192).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const Epoch = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/u);

export const ControlRoomAgentRowV1Schema = z.strictObject({
  agentId: Id,
  taskId: Id.optional(),
  runtimeGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  attemptGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sourceGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  activity: z.enum(["idle", "waiting_input", "dispatching", "active", "settling", "blocked", "exited", "unknown"]),
  attention: z.enum(["needs_input", "working", "settling", "blocked", "failed", "complete", "idle", "unknown"]),
  taskStatus: z.enum(["planned", "claimed", "done", "blocked", "escalated", "unknown"]),
  steeringState: z.enum(["none", "pending", "included", "refused", "unknown"]),
  pendingCommands: Count,
  scmState: z.enum(["unpublished", "publishing", "ci_pending", "changes_requested", "ready", "blocked", "unknown"]),
  verificationState: z.enum(["not_run", "pending", "passing", "failing", "unknown"]),
  sourceIntegrity: z.enum(["live", "quiescent_final", "recovered", "replaced", "degraded", "unknown"]),
  sourceStateCode: z.string().min(1).max(64).regex(/^[a-z][a-z0-9._-]*$/u),
  sourceDroppedRecords: Count,
  sourceDroppedBytes: Count,
  lastFactSeq: Seq,
  lastObservedAt: Timestamp.optional(),
  lastObservation: PublicObservationV1Schema.optional()
}).superRefine((row, context) => {
  const expectedAttention = row.activity === "waiting_input" ? "needs_input"
    : row.activity === "dispatching" || row.activity === "active" ? "working"
      : row.activity === "settling" ? "settling"
        : row.activity === "blocked" ? "blocked"
          : row.activity === "idle" ? "idle"
            : row.activity === "exited"
              ? row.taskStatus === "done" ? "complete" : row.taskStatus === "blocked" || row.taskStatus === "escalated" ? "failed" : "idle"
              : "unknown";
  if (row.attention !== expectedAttention) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["attention"], message: "attention does not match parent activity" });
  }
  const record = row.lastObservation;
  if (record !== undefined && (
    record.generation.agentId !== row.agentId ||
    record.generation.taskId !== row.taskId ||
    record.generation.runtimeGeneration !== row.runtimeGeneration ||
    record.generation.attemptGeneration !== row.attemptGeneration ||
    record.generation.sourceGeneration !== row.sourceGeneration
  )) context.addIssue({ code: z.ZodIssueCode.custom, path: ["lastObservation"], message: "last observation generation is stale" });
});

export const ControlRoomSnapshotV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: Id,
  runEpoch: Epoch,
  eventHeadSeq: Seq,
  rows: z.array(ControlRoomAgentRowV1Schema).max(CONTROL_ROOM_CLIENT_LIMITS.maximumRows),
  observationPage: ObservationPageV1Schema,
  nextCursor: z.string().min(4).max(CONTROL_ROOM_CLIENT_LIMITS.maximumCursorBytes).regex(/^v1\.[A-Za-z0-9_-]+$/u)
}).superRefine((snapshot, context) => {
  if (snapshot.observationPage.runId !== snapshot.runId || snapshot.observationPage.runEpoch !== snapshot.runEpoch) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["observationPage"], message: "observation page run identity differs" });
  }
  if (snapshot.observationPage.snapshotSeq !== snapshot.eventHeadSeq) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["eventHeadSeq"], message: "snapshot head differs from observation page" });
  }
  if (new Set(snapshot.rows.map((row) => row.agentId)).size !== snapshot.rows.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["rows"], message: "snapshot contains duplicate agent rows" });
  }
  try {
    const cursor = decodeControlRoomObservationCursor(snapshot.nextCursor);
    if (cursor.runEpoch !== snapshot.runEpoch || cursor.afterSeq !== snapshot.observationPage.nextAfter) throw new Error("cursor identity");
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["nextCursor"], message: "next cursor does not bind the returned page" });
  }
  for (let index = 0; index < snapshot.rows.length; index += 1) {
    if (snapshot.rows[index]!.lastFactSeq > snapshot.observationPage.projectionSeq) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["rows", index, "lastFactSeq"], message: "row is ahead of projection" });
    }
  }
});
export type ControlRoomSnapshotV1 = z.infer<typeof ControlRoomSnapshotV1Schema> & Readonly<{ rows: readonly ControlRoomAgentRowV1[] }>;

export const ControlRoomChangeNotificationV1Schema = z.strictObject({
  type: z.literal("control.changed"),
  runEpoch: Epoch,
  seq: Seq
});
export type ControlRoomChangeNotificationV1 = z.infer<typeof ControlRoomChangeNotificationV1Schema>;

export type ControlRoomSubscriptionState = "connecting" | "available" | "unavailable";

export interface ControlRoomClientTransport {
  /** Must register before the first snapshot request and returns an idempotent unsubscribe. */
  subscribe(
    listener: (notification: unknown) => void,
    stateListener?: (state: ControlRoomSubscriptionState) => void
  ): () => void;
  fetchSnapshot(signal: AbortSignal): Promise<unknown>;
}

export interface ControlRoomClientScheduler {
  schedule(callback: () => void, delayMs: number): () => void;
}

const defaultScheduler: ControlRoomClientScheduler = Object.freeze({
  schedule(callback: () => void, delayMs: number) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  }
});

export type ControlRoomClientMode = "stopped" | "loading" | "ready" | "degraded";
export type ControlRoomClientState = Readonly<{
  mode: ControlRoomClientMode;
  snapshot?: ControlRoomSnapshotV1;
  reasonCode?: "subscription_unavailable" | "snapshot_failed" | "refetch_limit";
  refreshCount: number;
  coalescedNotifications: number;
}>;

export type ControlRoomClientOptions = Readonly<{
  transport: ControlRoomClientTransport;
  onState?: (state: ControlRoomClientState) => void;
  scheduler?: ControlRoomClientScheduler;
}>;

export class ControlRoomClient {
  private readonly transport: ControlRoomClientTransport;
  private readonly scheduler: ControlRoomClientScheduler;
  private readonly onState?: (state: ControlRoomClientState) => void;
  private current: ControlRoomClientState = Object.freeze({ mode: "stopped", refreshCount: 0, coalescedNotifications: 0 });
  private unsubscribe: (() => void) | undefined;
  private cancelPoll: (() => void) | undefined;
  private abort: AbortController | undefined;
  private refreshPromise: Promise<void> | undefined;
  private pendingEpoch: string | undefined;
  private pendingSeq = 0;
  private coalesced = 0;
  private subscriptionAvailable = true;

  constructor(options: ControlRoomClientOptions) {
    this.transport = options.transport;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.onState = options.onState;
  }

  state(): ControlRoomClientState { return this.current; }

  private publish(value: ControlRoomClientState): void {
    this.current = Object.freeze(value);
    try { this.onState?.(this.current); } catch { /* rendering callbacks are not authority */ }
  }

  private notification(value: unknown): void {
    const parsed = ControlRoomChangeNotificationV1Schema.safeParse(value);
    if (!parsed.success || this.current.mode === "stopped") return;
    this.pendingEpoch = parsed.data.runEpoch;
    this.pendingSeq = Math.max(this.pendingSeq, parsed.data.seq);
    if (this.refreshPromise !== undefined) {
      this.coalesced += 1;
      return;
    }
    void this.refresh();
  }

  private subscriptionState(value: ControlRoomSubscriptionState): void {
    if (this.current.mode === "stopped") return;
    const available = value === "available";
    const changed = available !== this.subscriptionAvailable;
    this.subscriptionAvailable = available;
    if (available) {
      // A transport may report available only while delivering a verified ready/change frame. That
      // notification immediately refetches the exact head; never relabel stale data ready here.
      return;
    }
    if (this.current.mode === "loading") return;
    if (changed || this.current.reasonCode !== "subscription_unavailable") {
      this.publish({
        mode: "degraded",
        ...(this.current.snapshot === undefined ? {} : { snapshot: this.current.snapshot }),
        reasonCode: "subscription_unavailable",
        refreshCount: this.current.refreshCount,
        coalescedNotifications: this.current.coalescedNotifications + this.coalesced
      });
      this.coalesced = 0;
      this.schedulePoll();
    } else if (this.cancelPoll === undefined && this.refreshPromise === undefined) {
      // Reconnect attempts must not keep postponing an already-scheduled degraded poll forever.
      this.schedulePoll();
    }
  }

  async start(): Promise<void> {
    if (this.current.mode !== "stopped") return;
    this.subscriptionAvailable = true;
    this.publish({ mode: "loading", refreshCount: 0, coalescedNotifications: 0 });
    try {
      const release = this.transport.subscribe(
        (notification) => this.notification(notification),
        (state) => this.subscriptionState(state)
      );
      let released = false;
      this.unsubscribe = () => { if (!released) { released = true; release(); } };
    } catch {
      this.subscriptionAvailable = false;
    }
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.current.mode === "stopped") return;
    if (this.refreshPromise !== undefined) {
      this.coalesced += 1;
      return await this.refreshPromise;
    }
    const task = this.performRefresh();
    this.refreshPromise = task;
    try { await task; }
    finally { if (this.refreshPromise === task) this.refreshPromise = undefined; }
  }

  private async performRefresh(): Promise<void> {
    this.cancelPoll?.();
    this.cancelPoll = undefined;
    for (let pass = 0; pass < CONTROL_ROOM_CLIENT_LIMITS.maximumRefetchPasses; pass += 1) {
      const controller = new AbortController();
      this.abort = controller;
      let snapshot: ControlRoomSnapshotV1;
      try {
        const raw = await this.transport.fetchSnapshot(controller.signal);
        assertObservationSafeGraph(raw);
        snapshot = ControlRoomSnapshotV1Schema.parse(raw) as ControlRoomSnapshotV1;
      } catch {
        if (this.current.mode === "stopped") return;
        this.publish({
          mode: "degraded",
          ...(this.current.snapshot === undefined ? {} : { snapshot: this.current.snapshot }),
          reasonCode: "snapshot_failed",
          refreshCount: this.current.refreshCount,
          coalescedNotifications: this.current.coalescedNotifications + this.coalesced
        });
        this.coalesced = 0;
        this.schedulePoll();
        return;
      } finally {
        if (this.abort === controller) this.abort = undefined;
      }
      const missed = this.pendingEpoch !== undefined && (
        this.pendingEpoch !== snapshot.runEpoch || this.pendingSeq > snapshot.eventHeadSeq
      );
      if (missed) continue;
      this.pendingEpoch = undefined;
      this.pendingSeq = 0;
      const degraded = !this.subscriptionAvailable;
      this.publish({
        mode: degraded ? "degraded" : "ready",
        snapshot,
        ...(degraded ? { reasonCode: "subscription_unavailable" as const } : {}),
        refreshCount: this.current.refreshCount + 1,
        coalescedNotifications: this.current.coalescedNotifications + this.coalesced
      });
      this.coalesced = 0;
      if (degraded) this.schedulePoll();
      return;
    }
    this.publish({
      mode: "degraded",
      ...(this.current.snapshot === undefined ? {} : { snapshot: this.current.snapshot }),
      reasonCode: "refetch_limit",
      refreshCount: this.current.refreshCount,
      coalescedNotifications: this.current.coalescedNotifications + this.coalesced
    });
    this.coalesced = 0;
    this.schedulePoll();
  }

  private schedulePoll(): void {
    if (this.current.mode === "stopped") return;
    this.cancelPoll?.();
    this.cancelPoll = this.scheduler.schedule(() => {
      this.cancelPoll = undefined;
      void this.refresh();
    }, CONTROL_ROOM_CLIENT_LIMITS.degradedPollMs);
  }

  stop(): void {
    if (this.current.mode === "stopped") return;
    this.abort?.abort();
    this.abort = undefined;
    this.cancelPoll?.();
    this.cancelPoll = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.pendingEpoch = undefined;
    this.pendingSeq = 0;
    this.publish({
      mode: "stopped",
      ...(this.current.snapshot === undefined ? {} : { snapshot: this.current.snapshot }),
      refreshCount: this.current.refreshCount,
      coalescedNotifications: this.current.coalescedNotifications + this.coalesced
    });
    this.coalesced = 0;
  }
}

export function createControlRoomClient(options: ControlRoomClientOptions): ControlRoomClient {
  return new ControlRoomClient(options);
}

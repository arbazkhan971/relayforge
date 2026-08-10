import type { PublicObservationV1 } from "../observability/types.js";
import type { ControlRoomClientState } from "./client.js";
import type { ControlRoomAgentRowV1, ControlRoomAttention } from "./projection.js";

export const CONTROL_ROOM_VIEW_MODEL_VERSION = 1 as const;
export const CONTROL_ROOM_VIEW_LIMITS = Object.freeze({ maximumTimelineItems: 100 });

export const controlRoomAttentionBuckets = Object.freeze([
  "needs_input", "blocked", "failed", "working", "settling", "idle", "complete", "unknown"
] as const satisfies readonly ControlRoomAttention[]);

export type ControlRoomViewNoticeCode =
  | "loading"
  | "subscription_unavailable"
  | "snapshot_failed"
  | "refetch_limit"
  | "projection_stale"
  | "projection_rebuilding"
  | "projection_unavailable"
  | "history_truncated"
  | "records_dropped"
  | "source_replaced"
  | "source_degraded"
  | "source_unknown"
  | "no_records";

export type ControlRoomViewNoticeV1 = Readonly<{
  code: ControlRoomViewNoticeCode;
  severity: "info" | "warning" | "error";
  text: string;
}>;

export type ControlRoomRowViewV1 = Readonly<{
  key: string;
  agentId: string;
  taskId?: string;
  attention: ControlRoomAttention;
  attentionLabel: string;
  activityLabel: string;
  taskLabel: string;
  generationLabel: string;
  sourceLabel: string;
  steeringLabel: string;
  scmLabel: string;
  verificationLabel: string;
  lastFactLabel: string;
  latestSummary?: string;
}>;

export type ControlRoomAttentionBucketV1 = Readonly<{
  id: ControlRoomAttention;
  label: string;
  count: number;
  rows: readonly ControlRoomRowViewV1[];
}>;

export type ControlRoomTimelineItemV1 = Readonly<{
  key: string;
  seq: number;
  agentId: string;
  categoryLabel: string;
  severity: PublicObservationV1["severity"];
  timeLabel: string;
  code: string;
  text: string;
  integrityLabel: string;
}>;

export type ControlRoomViewModelV1 = Readonly<{
  schemaVersion: typeof CONTROL_ROOM_VIEW_MODEL_VERSION;
  mode: ControlRoomClientState["mode"];
  runId?: string;
  runEpoch?: string;
  title: string;
  connectionLabel: string;
  headLabel: string;
  rows: readonly ControlRoomRowViewV1[];
  buckets: readonly ControlRoomAttentionBucketV1[];
  timeline: readonly ControlRoomTimelineItemV1[];
  notices: readonly ControlRoomViewNoticeV1[];
  degraded: boolean;
}>;

const attentionLabels: Readonly<Record<ControlRoomAttention, string>> = Object.freeze({
  needs_input: "Needs input",
  blocked: "Blocked",
  failed: "Failed",
  working: "Working",
  settling: "Settling",
  idle: "Idle",
  complete: "Complete",
  unknown: "Unknown"
});

function words(value: string): string {
  return value.replaceAll("_", " ").replaceAll(".", " ");
}

function rowView(runEpoch: string, row: ControlRoomAgentRowV1): ControlRoomRowViewV1 {
  const sourceLabel = row.sourceIntegrity === "replaced"
    ? "Source replaced"
    : row.sourceIntegrity === "degraded"
      ? `Source degraded (${words(row.sourceStateCode)})`
      : row.sourceIntegrity === "unknown"
        ? "Source not yet known"
        : `${words(row.sourceIntegrity)} source`;
  const steeringLabel = row.pendingCommands > 0
    ? `${row.pendingCommands} steering ${row.pendingCommands === 1 ? "command" : "commands"} pending`
    : `Steering ${words(row.steeringState)}`;
  return Object.freeze({
    key: `${runEpoch}:${row.agentId}`,
    agentId: row.agentId,
    ...(row.taskId === undefined ? {} : { taskId: row.taskId }),
    attention: row.attention,
    attentionLabel: attentionLabels[row.attention],
    activityLabel: words(row.activity),
    taskLabel: row.taskId === undefined ? `No assigned task · ${words(row.taskStatus)}` : `${row.taskId} · ${words(row.taskStatus)}`,
    generationLabel: `runtime ${row.runtimeGeneration} · attempt ${row.attemptGeneration} · source ${row.sourceGeneration}`,
    sourceLabel,
    steeringLabel,
    scmLabel: `SCM ${words(row.scmState)}`,
    verificationLabel: `Verification ${words(row.verificationState)}`,
    lastFactLabel: row.lastObservedAt === undefined ? `Fact #${row.lastFactSeq} · time unknown` : `Fact #${row.lastFactSeq} · ${row.lastObservedAt}`,
    ...(row.lastObservation?.summary === undefined ? {} : { latestSummary: row.lastObservation.summary.text })
  });
}

function timelineItem(record: PublicObservationV1): ControlRoomTimelineItemV1 {
  const text = record.summary?.text ?? `${words(record.category)} update: ${words(record.code)}`;
  return Object.freeze({
    key: `${record.generation.runEpoch}:${record.recordId}`,
    seq: record.seq,
    agentId: record.generation.agentId,
    categoryLabel: words(record.category),
    severity: record.severity,
    timeLabel: record.observedAt,
    code: record.code,
    text,
    integrityLabel: record.sourceIntegrity === "unknown" ? "Source not yet known" : `Source ${words(record.sourceIntegrity)}`
  });
}

function notice(code: ControlRoomViewNoticeCode, severity: ControlRoomViewNoticeV1["severity"], text: string): ControlRoomViewNoticeV1 {
  return Object.freeze({ code, severity, text });
}

function noticesFor(state: ControlRoomClientState): readonly ControlRoomViewNoticeV1[] {
  const result: ControlRoomViewNoticeV1[] = [];
  if (state.mode === "loading") result.push(notice("loading", "info", "Loading the durable control-room snapshot."));
  if (state.reasonCode === "subscription_unavailable") result.push(notice("subscription_unavailable", "warning", "Live updates are unavailable; bounded polling is active."));
  if (state.reasonCode === "snapshot_failed") result.push(notice("snapshot_failed", "error", "The latest snapshot could not be verified; showing the last known snapshot when available."));
  if (state.reasonCode === "refetch_limit") result.push(notice("refetch_limit", "warning", "Updates changed repeatedly during refresh; polling will retry from a stable head."));
  const page = state.snapshot?.observationPage;
  if (page?.freshness === "stale") result.push(notice("projection_stale", "warning", `Projection is stale at #${page.projectionSeq}; durable head is #${page.snapshotSeq}.`));
  if (page?.freshness === "rebuilding") result.push(notice("projection_rebuilding", "warning", "Observation history is rebuilding from durable events."));
  if (page?.freshness === "unavailable") result.push(notice("projection_unavailable", "error", "Observation history is temporarily unavailable."));
  if (page?.truncated) result.push(notice("history_truncated", "warning", `History before #${page.firstAvailableSeq} or beyond this page is not displayed.`));
  if (page !== undefined && (page.droppedRecords > 0 || page.droppedBytes > 0)) {
    result.push(notice("records_dropped", "warning", `${page.droppedRecords} records / ${page.droppedBytes} bytes were dropped under bounded retention.`));
  }
  const rows = state.snapshot?.rows ?? [];
  if (rows.some((row) => row.sourceIntegrity === "replaced")) result.push(notice("source_replaced", "warning", "One or more transcript sources were replaced; their generations remain separated."));
  if (rows.some((row) => row.sourceIntegrity === "degraded")) result.push(notice("source_degraded", "warning", "One or more observation sources are degraded."));
  if (rows.some((row) => row.sourceIntegrity === "unknown")) result.push(notice("source_unknown", "info", "One or more observation sources are not yet known."));
  if (page !== undefined && page.records.length === 0) result.push(notice("no_records", "info", "No normalized observations are available for this page."));
  return Object.freeze(result);
}

/** Build one renderer-neutral, read-only model from the verified client snapshot. */
export function buildControlRoomViewModel(state: ControlRoomClientState): ControlRoomViewModelV1 {
  const snapshot = state.snapshot;
  const rows = Object.freeze((snapshot?.rows ?? []).map((row) => rowView(snapshot!.runEpoch, row)));
  const buckets = Object.freeze(controlRoomAttentionBuckets.map((id) => {
    const members = Object.freeze(rows.filter((row) => row.attention === id));
    return Object.freeze({ id, label: attentionLabels[id], count: members.length, rows: members });
  }));
  const timeline = Object.freeze((snapshot?.observationPage.records ?? [])
    .slice(-CONTROL_ROOM_VIEW_LIMITS.maximumTimelineItems)
    .reverse()
    .map(timelineItem));
  const degraded = state.mode === "degraded" || snapshot?.observationPage.freshness !== "fresh";
  return Object.freeze({
    schemaVersion: CONTROL_ROOM_VIEW_MODEL_VERSION,
    mode: state.mode,
    ...(snapshot === undefined ? {} : { runId: snapshot.runId, runEpoch: snapshot.runEpoch }),
    title: snapshot === undefined ? "RelayForge control room" : `RelayForge control room · ${snapshot.runId}`,
    connectionLabel: state.mode === "ready" ? "Live and verified" : state.mode === "loading" ? "Loading" : state.mode === "degraded" ? "Degraded" : "Stopped",
    headLabel: snapshot === undefined ? "No durable snapshot" : `Durable head #${snapshot.eventHeadSeq} · projection #${snapshot.observationPage.projectionSeq}`,
    rows,
    buckets,
    timeline,
    notices: noticesFor(state),
    degraded
  });
}

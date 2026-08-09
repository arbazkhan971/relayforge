import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { ObservationPageV1Schema, type ObservationPageV1, type ObservationSourceHealthV1 } from "../observability/types.js";
import {
  assertControlRoomProjectionConsistent,
  controlRoomAttentionOrder,
  type ControlRoomAgentRowV1,
  type ControlRoomAttention,
  type ControlRoomProjectionV1
} from "./projection.js";

export const CONTROL_ROOM_QUERY_LIMITS = Object.freeze({
  defaultObservationLimit: 100,
  maximumObservationLimit: 500,
  defaultRowLimit: 100,
  maximumRowLimit: 512,
  maximumCursorBytes: 512
});

export type ControlRoomQueryErrorCode =
  | "INVALID_LIMIT"
  | "MALFORMED_CURSOR"
  | "WRONG_EPOCH"
  | "FUTURE_CURSOR"
  | "CURSOR_EXPIRED"
  | "HEAD_MISMATCH"
  | "INVALID_PROJECTION";

export class ControlRoomQueryError extends Error {
  constructor(readonly code: ControlRoomQueryErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ControlRoomQueryError";
  }
}

export type ControlRoomObservationCursorV1 = Readonly<{
  schemaVersion: 1;
  runEpoch: string;
  afterSeq: number;
}>;

export type ControlRoomObservationQuery = Readonly<{
  cursor?: string;
  afterSeq?: number;
  limit?: number;
  eventHeadSeq?: number;
  availability?: "available" | "rebuilding" | "unavailable";
}>;

export type ControlRoomObservationQueryResult = Readonly<{
  page: ObservationPageV1;
  nextCursor: string;
  hasMore: boolean;
}>;

export type ControlRoomRowQuery = Readonly<{
  attention?: readonly ControlRoomAttention[];
  afterAgentId?: string;
  limit?: number;
}>;

export type ControlRoomRowPage = Readonly<{
  rows: readonly ControlRoomAgentRowV1[];
  nextAfterAgentId?: string;
  hasMore: boolean;
}>;

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new ControlRoomQueryError("INVALID_LIMIT", "query limit is outside the closed bound");
  }
  return limit;
}

function cursorPayload(cursor: ControlRoomObservationCursorV1): string {
  return JSON.stringify([cursor.schemaVersion, cursor.runEpoch, cursor.afterSeq]);
}

function cursorDigest(payload: string): string {
  return createHash("sha256").update("relayforge-control-room-cursor-v1\0", "utf8").update(payload, "utf8").digest("hex").slice(0, 32);
}

export function encodeControlRoomObservationCursor(value: ControlRoomObservationCursorV1): string {
  if (
    value.schemaVersion !== 1 ||
    !/^[A-Za-z0-9_-]{16,128}$/u.test(value.runEpoch) ||
    !Number.isSafeInteger(value.afterSeq) ||
    value.afterSeq < 0
  ) throw new ControlRoomQueryError("MALFORMED_CURSOR", "cursor value is invalid");
  const payload = cursorPayload(value);
  const body = Buffer.from(JSON.stringify([payload, cursorDigest(payload)]), "utf8").toString("base64url");
  const encoded = `v1.${body}`;
  if (Buffer.byteLength(encoded, "utf8") > CONTROL_ROOM_QUERY_LIMITS.maximumCursorBytes) {
    throw new ControlRoomQueryError("MALFORMED_CURSOR", "cursor exceeds the byte bound");
  }
  return encoded;
}

export function decodeControlRoomObservationCursor(value: string): ControlRoomObservationCursorV1 {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > CONTROL_ROOM_QUERY_LIMITS.maximumCursorBytes ||
    !/^v1\.[A-Za-z0-9_-]+$/u.test(value)
  ) throw new ControlRoomQueryError("MALFORMED_CURSOR", "cursor envelope is invalid");
  try {
    const outer = JSON.parse(Buffer.from(value.slice(3), "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(outer) || outer.length !== 2 || typeof outer[0] !== "string" || typeof outer[1] !== "string") throw new Error("outer");
    if (outer[1] !== cursorDigest(outer[0])) throw new Error("digest");
    const inner = JSON.parse(outer[0]) as unknown;
    if (
      !Array.isArray(inner) || inner.length !== 3 || inner[0] !== 1 ||
      typeof inner[1] !== "string" || !/^[A-Za-z0-9_-]{16,128}$/u.test(inner[1]) ||
      typeof inner[2] !== "number" || !Number.isSafeInteger(inner[2]) || inner[2] < 0
    ) throw new Error("inner");
    const cursor: ControlRoomObservationCursorV1 = Object.freeze({ schemaVersion: 1, runEpoch: inner[1], afterSeq: inner[2] });
    if (encodeControlRoomObservationCursor(cursor) !== value) throw new Error("canonical");
    return cursor;
  } catch (error) {
    if (error instanceof ControlRoomQueryError) throw error;
    throw new ControlRoomQueryError("MALFORMED_CURSOR", "cursor cannot be decoded canonically");
  }
}

function sourceHealth(row: ControlRoomAgentRowV1): ObservationSourceHealthV1 {
  return Object.freeze({
    agentId: row.agentId,
    runtimeGeneration: row.runtimeGeneration,
    attemptGeneration: row.attemptGeneration,
    sourceGeneration: row.sourceGeneration,
    integrity: row.sourceIntegrity,
    ...(row.lastObservedAt === undefined ? {} : { lastObservedAt: row.lastObservedAt }),
    droppedRecords: row.sourceDroppedRecords,
    droppedBytes: row.sourceDroppedBytes
  });
}

export function queryControlRoomObservations(
  projection: ControlRoomProjectionV1,
  query: ControlRoomObservationQuery = {}
): ControlRoomObservationQueryResult {
  try { assertControlRoomProjectionConsistent(projection); }
  catch { throw new ControlRoomQueryError("INVALID_PROJECTION", "control-room projection failed consistency checks"); }
  if (query.cursor !== undefined && query.afterSeq !== undefined) {
    throw new ControlRoomQueryError("MALFORMED_CURSOR", "cursor and after sequence are mutually exclusive");
  }
  const cursor = query.cursor === undefined ? undefined : decodeControlRoomObservationCursor(query.cursor);
  if (cursor !== undefined && cursor.runEpoch !== projection.runEpoch) {
    throw new ControlRoomQueryError("WRONG_EPOCH", "cursor belongs to a different run epoch");
  }
  const afterSeq = cursor?.afterSeq ?? query.afterSeq ?? Math.max(0, projection.firstAvailableSeq - 1);
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new ControlRoomQueryError("MALFORMED_CURSOR", "after sequence is invalid");
  if (afterSeq > projection.headSeq) throw new ControlRoomQueryError("FUTURE_CURSOR", "cursor is ahead of the durable head");
  if (afterSeq < Math.max(0, projection.firstAvailableSeq - 1)) {
    throw new ControlRoomQueryError("CURSOR_EXPIRED", "cursor precedes the first retained observation");
  }
  const eventHeadSeq = query.eventHeadSeq ?? projection.headSeq;
  if (!Number.isSafeInteger(eventHeadSeq) || eventHeadSeq < projection.headSeq) {
    throw new ControlRoomQueryError("HEAD_MISMATCH", "event head is behind the projection head");
  }
  const limit = boundedLimit(query.limit, CONTROL_ROOM_QUERY_LIMITS.defaultObservationLimit, CONTROL_ROOM_QUERY_LIMITS.maximumObservationLimit);
  const candidates = projection.observations.filter((record) => record.seq > afterSeq && record.seq <= projection.headSeq);
  const records = candidates.slice(0, limit);
  const hasMore = candidates.length > records.length;
  const nextAfter = records.at(-1)?.seq ?? afterSeq;
  const availability = query.availability ?? "available";
  const freshness: ObservationPageV1["freshness"] = availability === "unavailable"
    ? "unavailable"
    : availability === "rebuilding"
      ? "rebuilding"
      : eventHeadSeq === projection.headSeq ? "fresh" : "stale";
  const page = ObservationPageV1Schema.parse({
    schemaVersion: 1,
    runId: projection.runId,
    runEpoch: projection.runEpoch,
    snapshotSeq: eventHeadSeq,
    projectionSeq: projection.headSeq,
    firstAvailableSeq: projection.firstAvailableSeq,
    nextAfter,
    truncated: projection.droppedRecords > 0 || hasMore,
    droppedRecords: projection.droppedRecords,
    droppedBytes: projection.droppedBytes,
    freshness,
    records,
    sources: projection.rows.map(sourceHealth)
  });
  return Object.freeze({
    page,
    nextCursor: encodeControlRoomObservationCursor({ schemaVersion: 1, runEpoch: projection.runEpoch, afterSeq: nextAfter }),
    hasMore
  });
}

export function queryControlRoomRows(projection: ControlRoomProjectionV1, query: ControlRoomRowQuery = {}): ControlRoomRowPage {
  try { assertControlRoomProjectionConsistent(projection); }
  catch { throw new ControlRoomQueryError("INVALID_PROJECTION", "control-room projection failed consistency checks"); }
  const limit = boundedLimit(query.limit, CONTROL_ROOM_QUERY_LIMITS.defaultRowLimit, CONTROL_ROOM_QUERY_LIMITS.maximumRowLimit);
  const attention = query.attention === undefined ? undefined : new Set(query.attention);
  if (attention?.size !== query.attention?.length) throw new ControlRoomQueryError("INVALID_LIMIT", "attention filters must be unique");
  const sorted = [...projection.rows]
    .filter((row) => attention === undefined || attention.has(row.attention))
    .sort((left, right) => controlRoomAttentionOrder(left.attention) - controlRoomAttentionOrder(right.attention) || left.agentId.localeCompare(right.agentId));
  let start = 0;
  if (query.afterAgentId !== undefined) {
    const index = sorted.findIndex((row) => row.agentId === query.afterAgentId);
    if (index < 0) throw new ControlRoomQueryError("MALFORMED_CURSOR", "row cursor is not in the filtered snapshot");
    start = index + 1;
  }
  const rows = sorted.slice(start, start + limit);
  const hasMore = start + rows.length < sorted.length;
  return Object.freeze({
    rows: Object.freeze(rows),
    ...(hasMore ? { nextAfterAgentId: rows.at(-1)!.agentId } : {}),
    hasMore
  });
}

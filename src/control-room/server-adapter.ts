import { Buffer } from "node:buffer";
import { assertObservationSafeGraph } from "../observability/public.js";
import { ControlRoomSnapshotV1Schema, type ControlRoomSnapshotV1 } from "./client.js";
import type { ControlRoomProjectionV1 } from "./projection.js";
import { queryControlRoomObservations, queryControlRoomRows, type ControlRoomObservationQuery, type ControlRoomRowQuery } from "./query.js";

export const CONTROL_ROOM_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;

export interface ControlRoomReadSource {
  readonly runId: string;
  readonly runEpoch: string;
  controlRoomProjection(): ControlRoomProjectionV1;
  controlRoomEventHead(): number;
  controlRoomAvailability?(): "available" | "rebuilding" | "unavailable";
}

export type ControlRoomSnapshotRequest = Readonly<{
  observation?: ControlRoomObservationQuery;
  rows?: ControlRoomRowQuery;
}>;

export class ControlRoomReadError extends Error {
  constructor(readonly code: "IDENTITY_MISMATCH" | "HEAD_MISMATCH" | "RESPONSE_TOO_LARGE", message: string) {
    super(`${code}: ${message}`);
    this.name = "ControlRoomReadError";
  }
}

/** Build one exact-head snapshot; a concurrent commit is surfaced through metadata SSE/refetch. */
export function buildControlRoomSnapshot(source: ControlRoomReadSource, request: ControlRoomSnapshotRequest = {}): ControlRoomSnapshotV1 {
  const projection = source.controlRoomProjection();
  const eventHeadSeq = source.controlRoomEventHead();
  if (projection.runId !== source.runId || projection.runEpoch !== source.runEpoch) throw new ControlRoomReadError("IDENTITY_MISMATCH", "control-room projection differs from the owned source");
  if (!Number.isSafeInteger(eventHeadSeq) || eventHeadSeq < projection.headSeq) throw new ControlRoomReadError("HEAD_MISMATCH", "durable event head precedes the control-room projection");
  const observations = queryControlRoomObservations(projection, { ...request.observation, eventHeadSeq, availability: source.controlRoomAvailability?.() ?? "available" });
  const rows = queryControlRoomRows(projection, request.rows).rows;
  const candidate = { schemaVersion: 1 as const, runId: source.runId, runEpoch: source.runEpoch, eventHeadSeq, rows, observationPage: observations.page, nextCursor: observations.nextCursor };
  assertObservationSafeGraph(candidate);
  const parsed = ControlRoomSnapshotV1Schema.safeParse(candidate);
  if (!parsed.success) throw new ControlRoomReadError("HEAD_MISMATCH", parsed.error.issues[0]?.message ?? "snapshot is inconsistent");
  return Object.freeze({ ...parsed.data, rows: Object.freeze(parsed.data.rows), observationPage: Object.freeze({ ...parsed.data.observationPage, records: Object.freeze(parsed.data.observationPage.records), sources: Object.freeze(parsed.data.observationPage.sources) }) }) as ControlRoomSnapshotV1;
}

export function serializeControlRoomSnapshot(snapshot: ControlRoomSnapshotV1, maximumBytes = CONTROL_ROOM_RESPONSE_MAX_BYTES): Readonly<{ body: Buffer; bytes: number }> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > CONTROL_ROOM_RESPONSE_MAX_BYTES) throw new RangeError("control-room response cap is invalid");
  assertObservationSafeGraph(snapshot);
  const parsed = ControlRoomSnapshotV1Schema.parse(snapshot);
  const body = Buffer.from(JSON.stringify(parsed), "utf8");
  if (body.byteLength > maximumBytes) throw new ControlRoomReadError("RESPONSE_TOO_LARGE", `snapshot is ${body.byteLength} bytes; maximum is ${maximumBytes}`);
  return Object.freeze({ body, bytes: body.byteLength });
}

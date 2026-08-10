import { Buffer } from "node:buffer";
import { OBSERVATION_LIMITS, type PublicObservationV1 } from "./types.js";
import { toPublicObservation } from "./public.js";

export const PRESENTATION_RING_LIMITS = Object.freeze({
  maximumItems: 2_048,
  maximumBytes: 8 * 1024 * 1024
});

export type PresentationRingErrorCode = "INVALID_LIMITS" | "WRONG_RUN" | "OUT_OF_ORDER" | "CONFLICTING_DUPLICATE";

export class PresentationRingError extends Error {
  constructor(readonly code: PresentationRingErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "PresentationRingError";
  }
}

export type PresentationRingAppendResult =
  | Readonly<{ accepted: true; duplicate: boolean; evictedRecords: number; evictedBytes: number }>
  | Readonly<{ accepted: false; duplicate: boolean; reason: "record_too_large"; evictedRecords: 0; evictedBytes: 0 }>;

export type PresentationRingSnapshot = Readonly<{
  runId: string;
  runEpoch: string;
  records: readonly PublicObservationV1[];
  retainedBytes: number;
  firstRetainedSeq?: number;
  lastRetainedSeq?: number;
  lastSeenSeq: number;
  droppedRecords: number;
  droppedBytes: number;
  truncated: boolean;
}>;

export type PresentationRingOptions = Readonly<{
  runId: string;
  runEpoch: string;
  maximumItems: number;
  maximumBytes: number;
}>;

type RingEntry = Readonly<{
  record: PublicObservationV1;
  encoded: string;
  bytes: number;
}>;

function positiveBound(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new PresentationRingError("INVALID_LIMITS", `${label} is outside the closed ring bound`);
  }
  return value;
}

/** A rebuildable presentation cache. It is never a lifecycle, cursor, or settlement authority. */
export class ObservationPresentationRing {
  readonly runId: string;
  readonly runEpoch: string;
  readonly maximumItems: number;
  readonly maximumBytes: number;

  // Intentionally absent until the first accepted record: an empty control room allocates no ring.
  private entries: RingEntry[] | undefined;
  private retainedBytesValue = 0;
  private droppedRecordsValue = 0;
  private droppedBytesValue = 0;
  private hasSeenValue = false;
  private lastSeenSeqValue = 0;
  private lastSeenEncoded: string | undefined;
  private lastSeenAccepted = false;

  constructor(options: PresentationRingOptions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(options.runId)) {
      throw new PresentationRingError("INVALID_LIMITS", "run identifier is invalid");
    }
    if (!/^[A-Za-z0-9_-]{16,128}$/u.test(options.runEpoch)) {
      throw new PresentationRingError("INVALID_LIMITS", "run epoch is invalid");
    }
    this.runId = options.runId;
    this.runEpoch = options.runEpoch;
    this.maximumItems = positiveBound(options.maximumItems, PRESENTATION_RING_LIMITS.maximumItems, "item limit");
    this.maximumBytes = positiveBound(options.maximumBytes, PRESENTATION_RING_LIMITS.maximumBytes, "byte limit");
  }

  get allocated(): boolean { return this.entries !== undefined; }
  get size(): number { return this.entries?.length ?? 0; }
  get retainedBytes(): number { return this.retainedBytesValue; }

  append(value: PublicObservationV1): PresentationRingAppendResult {
    const record = toPublicObservation(value);
    if (record.generation.runId !== this.runId || record.generation.runEpoch !== this.runEpoch) {
      throw new PresentationRingError("WRONG_RUN", "record does not belong to this ring identity");
    }
    const encoded = JSON.stringify(record);
    const bytes = Buffer.byteLength(encoded, "utf8");

    if (this.hasSeenValue && record.seq < this.lastSeenSeqValue) {
      throw new PresentationRingError("OUT_OF_ORDER", "record sequence moved backwards");
    }
    if (this.hasSeenValue && record.seq === this.lastSeenSeqValue) {
      if (encoded === this.lastSeenEncoded) {
        return this.lastSeenAccepted
          ? Object.freeze({ accepted: true, duplicate: true, evictedRecords: 0, evictedBytes: 0 })
          : Object.freeze({ accepted: false, duplicate: true, reason: "record_too_large", evictedRecords: 0, evictedBytes: 0 });
      }
      throw new PresentationRingError("CONFLICTING_DUPLICATE", "same sequence carries different public bytes");
    }

    this.hasSeenValue = true;
    this.lastSeenSeqValue = record.seq;
    this.lastSeenEncoded = encoded;
    if (bytes > this.maximumBytes) {
      this.lastSeenAccepted = false;
      this.droppedRecordsValue += 1;
      this.droppedBytesValue += bytes;
      return Object.freeze({ accepted: false, duplicate: false, reason: "record_too_large", evictedRecords: 0, evictedBytes: 0 });
    }

    const entries = this.entries ?? (this.entries = []);
    this.lastSeenAccepted = true;
    entries.push(Object.freeze({ record, encoded, bytes }));
    this.retainedBytesValue += bytes;
    let evictedRecords = 0;
    let evictedBytes = 0;
    while (entries.length > this.maximumItems || this.retainedBytesValue > this.maximumBytes) {
      const evicted = entries.shift()!;
      this.retainedBytesValue -= evicted.bytes;
      evictedRecords += 1;
      evictedBytes += evicted.bytes;
    }
    this.droppedRecordsValue += evictedRecords;
    this.droppedBytesValue += evictedBytes;
    return Object.freeze({ accepted: true, duplicate: false, evictedRecords, evictedBytes });
  }

  appendMany(values: readonly PublicObservationV1[]): readonly PresentationRingAppendResult[] {
    if (values.length > OBSERVATION_LIMITS.maximumPageRecords) {
      throw new PresentationRingError("INVALID_LIMITS", "append batch exceeds the public page bound");
    }
    return Object.freeze(values.map((value) => this.append(value)));
  }

  snapshot(): PresentationRingSnapshot {
    const entries = this.entries ?? [];
    return Object.freeze({
      runId: this.runId,
      runEpoch: this.runEpoch,
      records: Object.freeze(entries.map((entry) => entry.record)),
      retainedBytes: this.retainedBytesValue,
      ...(entries[0] === undefined ? {} : { firstRetainedSeq: entries[0].record.seq }),
      ...(entries.at(-1) === undefined ? {} : { lastRetainedSeq: entries.at(-1)!.record.seq }),
      lastSeenSeq: this.lastSeenSeqValue,
      droppedRecords: this.droppedRecordsValue,
      droppedBytes: this.droppedBytesValue,
      truncated: this.droppedRecordsValue > 0 || this.droppedBytesValue > 0
    });
  }

  reset(): PresentationRingSnapshot {
    const previous = this.snapshot();
    this.entries = undefined;
    this.retainedBytesValue = 0;
    this.droppedRecordsValue = 0;
    this.droppedBytesValue = 0;
    this.hasSeenValue = false;
    this.lastSeenSeqValue = 0;
    this.lastSeenEncoded = undefined;
    this.lastSeenAccepted = false;
    return previous;
  }
}

export function createObservationPresentationRing(options: PresentationRingOptions): ObservationPresentationRing {
  return new ObservationPresentationRing(options);
}

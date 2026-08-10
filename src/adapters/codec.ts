import { createHash } from "node:crypto";

/**
 * Global codec ceilings. Adapters do not get to raise these values. The parent
 * transport may choose a smaller test/operation limit, never a larger one.
 */
export const ADAPTER_CODEC_LIMITS = Object.freeze({
  maxFrameBytes: 32 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxFrames: 1_000_000,
  maxPromptBytes: 4 * 1024 * 1024,
  maxNormalizedTextBytes: 8 * 1024 * 1024,
  maxEventTextBytes: 1024 * 1024,
  maxDiagnosticEvents: 64,
  maxIdentifierBytes: 512,
  maxJsonDepth: 64,
  maxJsonNodes: 100_000
});

export type CodecBounds = Readonly<{
  maxFrameBytes: number;
  maxTotalBytes: number;
  maxFrames: number;
}>;

export type CodecFrame = Readonly<{
  /** Exact record bytes, excluding LF but including a CR from CRLF. */
  raw: Uint8Array;
  offset: number;
  index: number;
  terminated: boolean;
}>;

export type CodecFrameReference = Readonly<{
  sha256: string;
  bytes: number;
  offset: number;
  index: number;
  terminated: boolean;
}>;

export type CodecFatal = Readonly<{
  kind: "frame-limit" | "total-limit" | "frame-count-limit";
  limit: number;
  observed: number;
  detail: string;
}>;

export type JsonFrameFailure = Readonly<{
  status: "invalid";
  code: "empty-frame" | "invalid-utf8" | "malformed-json" | "non-object";
  frame: CodecFrameReference;
  detail: string;
}>;

export type JsonFrameSuccess = Readonly<{
  status: "valid";
  value: Readonly<Record<string, unknown>>;
  frame: CodecFrameReference;
}>;

export type JsonFrameResult = JsonFrameFailure | JsonFrameSuccess;

export const normalizedAdapterEventKinds = [
  "assistant-delta",
  "assistant-final",
  "thought-delta",
  "tool",
  "permission",
  "usage",
  "session",
  "error",
  "cancel",
  "diagnostic",
  "protocol-uncertain"
] as const;
export type NormalizedAdapterEventKind = (typeof normalizedAdapterEventKinds)[number];

type NormalizedEventBase = Readonly<{
  frame: CodecFrameReference;
}>;

export type NormalizedAssistantEvent = NormalizedEventBase & Readonly<{
  kind: "assistant-delta" | "assistant-final" | "thought-delta";
  text: string;
}>;

export type NormalizedToolEvent = NormalizedEventBase & Readonly<{
  kind: "tool";
  toolCallId: string;
  toolName?: string;
  state: "proposed" | "started" | "progress" | "completed" | "failed";
  title?: string;
}>;

export type NormalizedPermissionEvent = NormalizedEventBase & Readonly<{
  kind: "permission";
  permissionId: string;
  state: "requested" | "selected" | "rejected" | "cancelled";
  /** Exact provider-offered one-shot option. Persistent approvals are never surfaced here. */
  allowOnceOptionId?: string;
}>;

export type NormalizedUsage = Readonly<{
  source: "terminal-response" | "usage-update" | "session-statistics";
  cumulative: boolean;
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  totalTokens?: number;
  contextUsed?: number;
  contextSize?: number;
  costUsd?: number;
}>;

export type NormalizedUsageEvent = NormalizedEventBase & Readonly<{
  kind: "usage";
  usage: NormalizedUsage;
}>;

export type NormalizedSessionEvent = NormalizedEventBase & Readonly<{
  kind: "session";
  sessionId: string;
  state: "created" | "active" | "idle" | "settled";
}>;

export type NormalizedErrorEvent = NormalizedEventBase & Readonly<{
  kind: "error";
  category: "auth" | "policy" | "model" | "context" | "overload" | "provider" | "unknown";
  message?: string;
}>;

export type NormalizedCancelEvent = NormalizedEventBase & Readonly<{
  kind: "cancel";
  state: "requested" | "cooperative-observed" | "terminal-cancelled";
}>;

export type NormalizedDiagnosticEvent = NormalizedEventBase & Readonly<{
  kind: "diagnostic";
  code: "unknown-event" | "ignored-event";
  eventType?: string;
}>;

export type NormalizedProtocolUncertainEvent = NormalizedEventBase & Readonly<{
  kind: "protocol-uncertain";
  code: ProtocolUncertaintyCode;
  detail: string;
}>;

export type NormalizedAdapterEvent =
  | NormalizedAssistantEvent
  | NormalizedToolEvent
  | NormalizedPermissionEvent
  | NormalizedUsageEvent
  | NormalizedSessionEvent
  | NormalizedErrorEvent
  | NormalizedCancelEvent
  | NormalizedDiagnosticEvent
  | NormalizedProtocolUncertainEvent;

export const protocolUncertaintyCodes = [
  "invalid-frame-sequence",
  "malformed-frame",
  "protocol-drift",
  "foreign-correlation",
  "duplicate-terminal",
  "missing-terminal",
  "post-terminal-event",
  "text-limit",
  "malformed-accounting",
  "prompt-not-accepted"
] as const;
export type ProtocolUncertaintyCode = (typeof protocolUncertaintyCodes)[number];

export type AdapterTerminalResult =
  | Readonly<{
      status: "success" | "failure" | "cancelled";
      terminalFrame: CodecFrameReference;
      finalText: string;
      usage?: NormalizedUsage;
      /** New ACP/Pi codecs have no paid-fallback authority. */
      explicitLimit: false;
      diagnosticsDropped: number;
    }>
  | Readonly<{
      status: "uncertain";
      code: ProtocolUncertaintyCode;
      detail: string;
      finalText: "";
      explicitLimit: false;
      diagnosticsDropped: number;
    }>;

export type CancelTerminalOutcome = "success" | "failure" | "cancelled";
export type CancelPhase =
  | "idle"
  | "accepted"
  | "sent"
  | "terminal-cancelled"
  | "completion-won"
  | "escalation-required"
  | "protocol-violation";

export type CancelSnapshot = Readonly<{
  phase: CancelPhase;
  accepted: boolean;
  sent: boolean;
  sendCount: 0 | 1;
  terminalOutcome?: CancelTerminalOutcome;
  violation?: string;
}>;

export type CancelAcceptance = Readonly<{
  accepted: boolean;
  shouldSend: boolean;
  reason?: "already-accepted" | "already-terminal" | "escalating" | "protocol-violation";
  snapshot: CancelSnapshot;
}>;

function positiveLimit(value: number, name: keyof CodecBounds, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
}

function validatedBounds(bounds: Partial<CodecBounds> = {}): CodecBounds {
  return Object.freeze({
    maxFrameBytes: positiveLimit(bounds.maxFrameBytes ?? ADAPTER_CODEC_LIMITS.maxFrameBytes, "maxFrameBytes", ADAPTER_CODEC_LIMITS.maxFrameBytes),
    maxTotalBytes: positiveLimit(bounds.maxTotalBytes ?? ADAPTER_CODEC_LIMITS.maxTotalBytes, "maxTotalBytes", ADAPTER_CODEC_LIMITS.maxTotalBytes),
    maxFrames: positiveLimit(bounds.maxFrames ?? ADAPTER_CODEC_LIMITS.maxFrames, "maxFrames", ADAPTER_CODEC_LIMITS.maxFrames)
  });
}

const SLAB_BYTES = 64 * 1024;
const EMPTY = Buffer.alloc(0);

/**
 * Strict LF JSONL framer used by codec characterization and protocol streams.
 * It never splits on U+2028/U+2029, retains at most one bounded record, and
 * emits no prefix of an oversized record.
 */
export class BoundedJsonlFramer {
  readonly bounds: CodecBounds;
  private full: Buffer[] = [];
  private current: Buffer | undefined;
  private currentLength = 0;
  private held = 0;
  private observedFrameBytes = 0;
  private totalBytes = 0;
  private consumedBytes = 0;
  private frameIndex = 0;
  private fatalState: CodecFatal | undefined;
  private finished = false;

  constructor(
    private readonly onFrame: (frame: CodecFrame) => void,
    bounds: Partial<CodecBounds> = {}
  ) {
    if (typeof onFrame !== "function") throw new TypeError("onFrame must be a function");
    this.bounds = validatedBounds(bounds);
  }

  push(chunk: Uint8Array): void {
    if (!(chunk instanceof Uint8Array)) throw new TypeError("chunk must be a Uint8Array");
    if (this.finished || this.fatalState || chunk.byteLength === 0) return;
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const remaining = this.bounds.maxTotalBytes - this.totalBytes;
    const acceptedLength = Math.min(bytes.length, remaining);
    const accepted = acceptedLength === bytes.length ? bytes : bytes.subarray(0, acceptedLength);
    this.totalBytes += acceptedLength;
    let start = 0;
    for (;;) {
      const newline = accepted.indexOf(0x0a, start);
      if (newline < 0) break;
      if (!this.take(accepted, start, newline)) return;
      if (!this.emit(true)) return;
      start = newline + 1;
    }
    if (start < accepted.length && !this.take(accepted, start, accepted.length)) return;
    if (acceptedLength < bytes.length) {
      this.fail("total-limit", this.bounds.maxTotalBytes, this.bounds.maxTotalBytes + 1, "JSONL stream exceeded the total byte limit");
    }
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    if (!this.fatalState && this.held > 0) this.emit(false);
  }

  fatal(): CodecFatal | undefined {
    return this.fatalState;
  }

  retainedBytes(): number {
    return this.held;
  }

  private take(bytes: Buffer, from: number, to: number): boolean {
    const length = to - from;
    if (length === 0) return true;
    this.observedFrameBytes += length;
    if (this.observedFrameBytes > this.bounds.maxFrameBytes) {
      this.fail("frame-limit", this.bounds.maxFrameBytes, this.bounds.maxFrameBytes + 1, "JSONL record exceeded the frame byte limit");
      return false;
    }
    let offset = from;
    while (offset < to) {
      if (!this.current) {
        this.current = Buffer.allocUnsafe(Math.min(SLAB_BYTES, this.bounds.maxFrameBytes - this.held));
        this.currentLength = 0;
      }
      const copied = Math.min(this.current.length - this.currentLength, to - offset);
      bytes.copy(this.current, this.currentLength, offset, offset + copied);
      this.currentLength += copied;
      this.held += copied;
      offset += copied;
      if (this.currentLength === this.current.length) {
        this.full.push(this.current);
        this.current = undefined;
        this.currentLength = 0;
      }
    }
    return true;
  }

  private assemble(): Buffer {
    if (this.held === 0) return EMPTY;
    if (this.full.length === 0) return this.current!.subarray(0, this.currentLength);
    if (this.full.length === 1 && this.currentLength === 0) return this.full[0]!;
    const parts = this.currentLength > 0
      ? [...this.full, this.current!.subarray(0, this.currentLength)]
      : this.full;
    return Buffer.concat(parts, this.held);
  }

  private emit(terminated: boolean): boolean {
    if (this.frameIndex >= this.bounds.maxFrames) {
      this.fail("frame-count-limit", this.bounds.maxFrames, this.frameIndex + 1, "JSONL stream exceeded the frame count limit");
      return false;
    }
    const raw = this.assemble();
    const offset = this.consumedBytes;
    const index = this.frameIndex;
    this.consumedBytes += raw.length + (terminated ? 1 : 0);
    this.frameIndex += 1;
    this.resetFrame();
    this.onFrame({ raw, offset, index, terminated });
    return true;
  }

  private resetFrame(): void {
    this.full = [];
    this.current = undefined;
    this.currentLength = 0;
    this.held = 0;
    this.observedFrameBytes = 0;
  }

  private fail(kind: CodecFatal["kind"], limit: number, observed: number, detail: string): void {
    this.fatalState = Object.freeze({ kind, limit, observed, detail });
    this.resetFrame();
  }
}

export function codecFrameReference(frame: CodecFrame): CodecFrameReference {
  return Object.freeze({
    sha256: createHash("sha256").update(frame.raw).digest("hex"),
    bytes: frame.raw.byteLength,
    offset: frame.offset,
    index: frame.index,
    terminated: frame.terminated
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function decodeJsonFrame(frame: CodecFrame): JsonFrameResult {
  const reference = codecFrameReference(frame);
  let bytes = frame.raw;
  if (bytes.byteLength > 0 && bytes[bytes.byteLength - 1] === 0x0d) bytes = bytes.subarray(0, bytes.byteLength - 1);
  if (bytes.byteLength === 0) {
    return Object.freeze({ status: "invalid", code: "empty-frame", frame: reference, detail: "JSONL frame is empty" });
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return Object.freeze({ status: "invalid", code: "invalid-utf8", frame: reference, detail: "JSONL frame is not valid UTF-8" });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return Object.freeze({ status: "invalid", code: "malformed-json", frame: reference, detail: "JSONL frame is not valid JSON" });
  }
  if (!isPlainRecord(value)) {
    return Object.freeze({ status: "invalid", code: "non-object", frame: reference, detail: "Protocol frame must be a JSON object" });
  }
  return Object.freeze({ status: "valid", value: Object.freeze(value), frame: reference });
}

function assertJsonData(value: unknown, seen: Set<object>, depth: number, nodes: { value: number }): void {
  nodes.value += 1;
  if (nodes.value > ADAPTER_CODEC_LIMITS.maxJsonNodes) throw new TypeError("JSONL value contains too many nodes");
  if (depth > ADAPTER_CODEC_LIMITS.maxJsonDepth) throw new TypeError("JSONL value is nested too deeply");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JSONL numbers must be finite");
    return;
  }
  if (typeof value !== "object") throw new TypeError("JSONL value contains non-JSON data");
  if (seen.has(value)) throw new TypeError("JSONL value must be acyclic");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonData(item, seen, depth + 1, nodes);
  } else {
    if (!isPlainRecord(value)) throw new TypeError("JSONL objects must be plain data objects");
    if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError("JSONL objects must not contain symbol keys");
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (descriptor.get || descriptor.set) throw new TypeError("JSONL objects must not contain accessors");
    }
    for (const item of Object.values(value)) assertJsonData(item, seen, depth + 1, nodes);
  }
  seen.delete(value);
}

export function serializeJsonLine(value: Readonly<Record<string, unknown>>, maxBytes = ADAPTER_CODEC_LIMITS.maxPromptBytes): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > ADAPTER_CODEC_LIMITS.maxPromptBytes) {
    throw new TypeError(`maxBytes must be 1..${ADAPTER_CODEC_LIMITS.maxPromptBytes}`);
  }
  if (!isPlainRecord(value)) throw new TypeError("JSONL value must be a plain object");
  assertJsonData(value, new Set(), 0, { value: 0 });
  let encoded: string;
  try {
    encoded = `${JSON.stringify(value)}\n`;
  } catch {
    throw new TypeError("JSONL value must be finite, acyclic JSON data");
  }
  const bytes = Buffer.from(encoded, "utf8");
  if (bytes.length > maxBytes) throw new RangeError(`serialized JSONL record exceeds the ${maxBytes}-byte limit`);
  return bytes;
}

export function boundedIdentifier(value: unknown, name: string): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return undefined;
  if (Buffer.byteLength(value, "utf8") > ADAPTER_CODEC_LIMITS.maxIdentifierBytes) return undefined;
  return value;
}

export function boundedEventText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.includes("\0")) return undefined;
  return Buffer.byteLength(value, "utf8") <= ADAPTER_CODEC_LIMITS.maxEventTextBytes ? value : undefined;
}

export function safeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function safeNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isPlainRecord(value) ? value : undefined;
}

export class FrameSequenceGuard {
  private nextIndex: number;
  private nextOffset: number;

  constructor(initial: Readonly<{ index?: number; offset?: number }> = {}) {
    this.nextIndex = initial.index ?? 0;
    this.nextOffset = initial.offset ?? 0;
    if (!Number.isSafeInteger(this.nextIndex) || this.nextIndex < 0) {
      throw new TypeError("initial frame index must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(this.nextOffset) || this.nextOffset < 0) {
      throw new TypeError("initial frame offset must be a non-negative safe integer");
    }
  }

  accept(frame: CodecFrame): string | undefined {
    if (
      !Number.isSafeInteger(frame.index) ||
      !Number.isSafeInteger(frame.offset) ||
      frame.index !== this.nextIndex ||
      frame.offset !== this.nextOffset ||
      frame.raw.byteLength > ADAPTER_CODEC_LIMITS.maxFrameBytes
    ) {
      return `expected frame index ${this.nextIndex} at offset ${this.nextOffset}`;
    }
    this.nextIndex += 1;
    this.nextOffset += frame.raw.byteLength + (frame.terminated ? 1 : 0);
    return undefined;
  }
}

export class BoundedTextAccumulator {
  private readonly chunks: string[] = [];
  private bytes = 0;
  private overflowed = false;

  append(text: string): boolean {
    if (this.overflowed) return false;
    const bytes = Buffer.byteLength(text, "utf8");
    if (this.bytes + bytes > ADAPTER_CODEC_LIMITS.maxNormalizedTextBytes) {
      this.chunks.length = 0;
      this.bytes = 0;
      this.overflowed = true;
      return false;
    }
    this.chunks.push(text);
    this.bytes += bytes;
    return true;
  }

  value(): string | undefined {
    return this.overflowed ? undefined : this.chunks.join("");
  }
}

/** Pure cancellation race reducer. It never starts timers or kills a process. */
export class DeterministicCancelStateMachine {
  private phase: CancelPhase = "idle";
  private accepted = false;
  private sent = false;
  private sendCount: 0 | 1 = 0;
  private terminalOutcome: CancelTerminalOutcome | undefined;
  private violation: string | undefined;

  request(): CancelAcceptance {
    if (this.phase === "idle") {
      this.phase = "accepted";
      this.accepted = true;
      return Object.freeze({ accepted: true, shouldSend: true, snapshot: this.snapshot() });
    }
    if (this.phase === "accepted" || this.phase === "sent") {
      return Object.freeze({ accepted: true, shouldSend: false, reason: "already-accepted", snapshot: this.snapshot() });
    }
    if (this.phase === "terminal-cancelled" || this.phase === "completion-won") {
      return Object.freeze({ accepted: false, shouldSend: false, reason: "already-terminal", snapshot: this.snapshot() });
    }
    return Object.freeze({
      accepted: false,
      shouldSend: false,
      reason: this.phase === "escalation-required" ? "escalating" : "protocol-violation",
      snapshot: this.snapshot()
    });
  }

  markSent(): CancelSnapshot {
    if (this.phase === "accepted") {
      this.phase = "sent";
      this.sent = true;
      this.sendCount = 1;
    } else if (this.phase !== "sent") {
      this.protocolViolation(`cancel send observed in ${this.phase}`);
    }
    return this.snapshot();
  }

  observeTerminal(outcome: CancelTerminalOutcome): CancelSnapshot {
    if (this.phase === "terminal-cancelled" || this.phase === "completion-won") {
      if (this.terminalOutcome !== outcome) this.protocolViolation("conflicting terminal outcomes");
      return this.snapshot();
    }
    if (this.phase === "escalation-required" || this.phase === "protocol-violation") return this.snapshot();
    this.terminalOutcome = outcome;
    if (outcome === "cancelled" && this.accepted) this.phase = "terminal-cancelled";
    else this.phase = "completion-won";
    return this.snapshot();
  }

  expire(): CancelSnapshot {
    if (this.phase === "accepted" || this.phase === "sent") this.phase = "escalation-required";
    return this.snapshot();
  }

  snapshot(): CancelSnapshot {
    return Object.freeze({
      phase: this.phase,
      accepted: this.accepted,
      sent: this.sent,
      sendCount: this.sendCount,
      ...(this.terminalOutcome ? { terminalOutcome: this.terminalOutcome } : {}),
      ...(this.violation ? { violation: this.violation } : {})
    });
  }

  private protocolViolation(detail: string): void {
    this.phase = "protocol-violation";
    this.violation = detail;
  }
}

export function uncertainResult(
  code: ProtocolUncertaintyCode,
  detail: string,
  diagnosticsDropped: number
): AdapterTerminalResult {
  return Object.freeze({
    status: "uncertain",
    code,
    detail,
    finalText: "",
    explicitLimit: false,
    diagnosticsDropped
  });
}

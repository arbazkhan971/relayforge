import {
  ADAPTER_CODEC_LIMITS,
  BoundedTextAccumulator,
  DeterministicCancelStateMachine,
  FrameSequenceGuard,
  boundedEventText,
  boundedIdentifier,
  codecFrameReference,
  decodeJsonFrame,
  record,
  safeCount,
  safeNonNegativeNumber,
  serializeJsonLine,
  uncertainResult,
  type AdapterTerminalResult,
  type CancelSnapshot,
  type CodecFrame,
  type CodecFrameReference,
  type NormalizedAdapterEvent,
  type NormalizedUsage,
  type ProtocolUncertaintyCode
} from "./codec.js";

export const PI_RPC_WIRE_VERSION = "pi-rpc-v1" as const;
export const PI_RPC_CODEC_VERSION = 1 as const;

export type PiStreamingBehavior = "steer" | "followUp";

function identifier(value: unknown, name: string): string {
  const parsed = boundedIdentifier(value, name);
  if (parsed === undefined) throw new TypeError(`${name} must be a bounded non-empty identifier`);
  return parsed;
}

function messageText(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0")) throw new TypeError("message must be a NUL-free string");
  return value;
}

export function serializePiPrompt(input: Readonly<{
  requestId: string;
  message: string;
  streamingBehavior?: PiStreamingBehavior;
}>): Buffer {
  return serializeJsonLine({
    id: identifier(input.requestId, "requestId"),
    type: "prompt",
    message: messageText(input.message),
    ...(input.streamingBehavior ? { streamingBehavior: input.streamingBehavior } : {})
  });
}

export function serializePiGetState(requestId: string): Buffer {
  return serializeJsonLine({ id: identifier(requestId, "requestId"), type: "get_state" });
}

export function serializePiGetSessionStats(requestId: string): Buffer {
  return serializeJsonLine({ id: identifier(requestId, "requestId"), type: "get_session_stats" });
}

export function serializePiGetLastAssistantText(requestId: string): Buffer {
  return serializeJsonLine({ id: identifier(requestId, "requestId"), type: "get_last_assistant_text" });
}

export function serializePiAbort(requestId: string): Buffer {
  return serializeJsonLine({ id: identifier(requestId, "requestId"), type: "abort" });
}

export class PiCancelStateMachine {
  readonly #state = new DeterministicCancelStateMachine();
  readonly #requestId: string;

  constructor(requestId: string) {
    this.#requestId = identifier(requestId, "requestId");
  }

  request(): Readonly<{ accepted: boolean; outbound?: Buffer; snapshot: CancelSnapshot }> {
    const acceptance = this.#state.request();
    if (!acceptance.shouldSend) return Object.freeze({ accepted: acceptance.accepted, snapshot: acceptance.snapshot });
    const outbound = serializePiAbort(this.#requestId);
    const snapshot = this.#state.markSent();
    return Object.freeze({ accepted: true, outbound, snapshot });
  }

  observeTerminal(outcome: "success" | "failure" | "cancelled"): CancelSnapshot {
    return this.#state.observeTerminal(outcome);
  }

  expire(): CancelSnapshot {
    return this.#state.expire();
  }

  snapshot(): CancelSnapshot {
    return this.#state.snapshot();
  }
}

export type PiStateEvidence = Readonly<{
  sessionId: string;
  isStreaming: boolean;
  isCompacting: boolean;
  messageCount: number;
  pendingMessageCount: number;
}>;

export type PiLastAssistantTextEvidence = Readonly<{
  text: string | null;
}>;

export type PiSessionStatsSnapshot = Readonly<{
  sessionId: string;
  sessionGeneration: number;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  contextUsed?: number;
  contextSize?: number;
  frame: CodecFrameReference;
}>;

export type PiResponseResult<T> =
  | Readonly<{ status: "valid"; value: T; frame: CodecFrameReference }>
  | Readonly<{
      status: "invalid";
      code: "malformed-frame" | "foreign-correlation" | "command-mismatch" | "command-failed" | "malformed-data";
      detail: string;
      frame: CodecFrameReference;
    }>;

function responseEnvelope(
  frame: CodecFrame,
  expectedRequestId: string,
  expectedCommand: string
): PiResponseResult<Readonly<Record<string, unknown>>> {
  const decoded = decodeJsonFrame(frame);
  if (decoded.status === "invalid") {
    return Object.freeze({ status: "invalid", code: "malformed-frame", detail: decoded.detail, frame: decoded.frame });
  }
  const value = decoded.value;
  if (value.type !== "response") {
    return Object.freeze({ status: "invalid", code: "command-mismatch", detail: "Pi frame is not a response", frame: decoded.frame });
  }
  if (value.id !== expectedRequestId) {
    return Object.freeze({ status: "invalid", code: "foreign-correlation", detail: "Pi response ID does not match the request", frame: decoded.frame });
  }
  if (value.command !== expectedCommand) {
    return Object.freeze({ status: "invalid", code: "command-mismatch", detail: "Pi response command does not match the request", frame: decoded.frame });
  }
  if (value.success !== true) {
    return Object.freeze({ status: "invalid", code: "command-failed", detail: "Pi command reported failure", frame: decoded.frame });
  }
  return Object.freeze({ status: "valid", value, frame: decoded.frame });
}

export function decodePiStateResponse(frame: CodecFrame, expectedRequestId: string): PiResponseResult<PiStateEvidence> {
  const requestId = identifier(expectedRequestId, "expectedRequestId");
  const envelope = responseEnvelope(frame, requestId, "get_state");
  if (envelope.status === "invalid") return envelope;
  const data = record(envelope.value.data);
  const sessionId = boundedIdentifier(data?.sessionId, "sessionId");
  const messageCount = safeCount(data?.messageCount);
  const pendingMessageCount = safeCount(data?.pendingMessageCount);
  if (
    !data ||
    !sessionId ||
    typeof data.isStreaming !== "boolean" ||
    typeof data.isCompacting !== "boolean" ||
    messageCount === undefined ||
    pendingMessageCount === undefined
  ) {
    return Object.freeze({ status: "invalid", code: "malformed-data", detail: "Pi get_state data is malformed", frame: envelope.frame });
  }
  return Object.freeze({
    status: "valid",
    value: Object.freeze({ sessionId, isStreaming: data.isStreaming, isCompacting: data.isCompacting, messageCount, pendingMessageCount }),
    frame: envelope.frame
  });
}

export function decodePiLastAssistantTextResponse(
  frame: CodecFrame,
  expectedRequestId: string
): PiResponseResult<PiLastAssistantTextEvidence> {
  const requestId = identifier(expectedRequestId, "expectedRequestId");
  const envelope = responseEnvelope(frame, requestId, "get_last_assistant_text");
  if (envelope.status === "invalid") return envelope;
  const data = record(envelope.value.data);
  if (!data || (data.text !== null && typeof data.text !== "string")) {
    return Object.freeze({ status: "invalid", code: "malformed-data", detail: "Pi last assistant text response is malformed", frame: envelope.frame });
  }
  if (typeof data.text === "string" && (data.text.includes("\0") || Buffer.byteLength(data.text, "utf8") > ADAPTER_CODEC_LIMITS.maxNormalizedTextBytes)) {
    return Object.freeze({ status: "invalid", code: "malformed-data", detail: "Pi last assistant text exceeds the normalized text bound", frame: envelope.frame });
  }
  return Object.freeze({ status: "valid", value: Object.freeze({ text: data.text }), frame: envelope.frame });
}

export function decodePiSessionStatsResponse(
  frame: CodecFrame,
  expectedRequestId: string,
  expectedSessionId: string,
  sessionGeneration: number
): PiResponseResult<PiSessionStatsSnapshot> {
  const requestId = identifier(expectedRequestId, "expectedRequestId");
  const sessionId = identifier(expectedSessionId, "expectedSessionId");
  if (!Number.isSafeInteger(sessionGeneration) || sessionGeneration < 1) throw new TypeError("sessionGeneration must be a positive safe integer");
  const envelope = responseEnvelope(frame, requestId, "get_session_stats");
  if (envelope.status === "invalid") return envelope;
  const data = record(envelope.value.data);
  const tokens = record(data?.tokens);
  if (!data || data.sessionId !== sessionId || !tokens) {
    return Object.freeze({ status: "invalid", code: data?.sessionId === undefined ? "malformed-data" : "foreign-correlation", detail: "Pi session stats do not match the active session", frame: envelope.frame });
  }
  const inputTokens = safeCount(tokens.input);
  const outputTokens = safeCount(tokens.output);
  const cachedReadTokens = safeCount(tokens.cacheRead);
  const cachedWriteTokens = safeCount(tokens.cacheWrite);
  const totalTokens = safeCount(tokens.total);
  const costUsd = safeNonNegativeNumber(data.cost);
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    cachedReadTokens === undefined ||
    cachedWriteTokens === undefined ||
    totalTokens === undefined ||
    costUsd === undefined ||
    !Number.isSafeInteger(inputTokens + outputTokens + cachedReadTokens + cachedWriteTokens) ||
    inputTokens + outputTokens + cachedReadTokens + cachedWriteTokens !== totalTokens
  ) {
    return Object.freeze({ status: "invalid", code: "malformed-data", detail: "Pi session statistics contain invalid accounting", frame: envelope.frame });
  }
  let contextUsed: number | undefined;
  let contextSize: number | undefined;
  if (data.contextUsage !== undefined) {
    const context = record(data.contextUsage);
    if (!context) return Object.freeze({ status: "invalid", code: "malformed-data", detail: "Pi context usage is malformed", frame: envelope.frame });
    contextSize = safeCount(context.contextWindow);
    if (contextSize === undefined || contextSize === 0) {
      return Object.freeze({ status: "invalid", code: "malformed-data", detail: "Pi context window is malformed", frame: envelope.frame });
    }
    if (context.tokens !== null) {
      contextUsed = safeCount(context.tokens);
      if (contextUsed === undefined || contextUsed > contextSize) {
        return Object.freeze({ status: "invalid", code: "malformed-data", detail: "Pi context token usage is malformed", frame: envelope.frame });
      }
    }
  }
  const snapshot: PiSessionStatsSnapshot = Object.freeze({
    sessionId,
    sessionGeneration,
    inputTokens,
    outputTokens,
    cachedReadTokens,
    cachedWriteTokens,
    totalTokens,
    costUsd,
    ...(contextUsed === undefined ? {} : { contextUsed }),
    ...(contextSize === undefined ? {} : { contextSize }),
    frame: envelope.frame
  });
  return Object.freeze({ status: "valid", value: snapshot, frame: envelope.frame });
}

export function derivePiTurnUsage(
  start: PiSessionStatsSnapshot,
  end: PiSessionStatsSnapshot
): NormalizedUsage | undefined {
  if (start.sessionId !== end.sessionId || start.sessionGeneration !== end.sessionGeneration) return undefined;
  const pairs = [
    [start.inputTokens, end.inputTokens],
    [start.outputTokens, end.outputTokens],
    [start.cachedReadTokens, end.cachedReadTokens],
    [start.cachedWriteTokens, end.cachedWriteTokens],
    [start.totalTokens, end.totalTokens],
    [start.costUsd, end.costUsd]
  ] as const;
  if (pairs.some(([before, after]) => after < before)) return undefined;
  const costUsd = end.costUsd - start.costUsd;
  if (!Number.isFinite(costUsd) || costUsd < 0) return undefined;
  return Object.freeze({
    source: "session-statistics",
    cumulative: false,
    inputTokens: end.inputTokens - start.inputTokens,
    outputTokens: end.outputTokens - start.outputTokens,
    cachedReadTokens: end.cachedReadTokens - start.cachedReadTokens,
    cachedWriteTokens: end.cachedWriteTokens - start.cachedWriteTokens,
    totalTokens: end.totalTokens - start.totalTokens,
    costUsd,
    ...(end.contextUsed === undefined ? {} : { contextUsed: end.contextUsed }),
    ...(end.contextSize === undefined ? {} : { contextSize: end.contextSize })
  });
}

type PiCodecOptions = Readonly<{
  promptRequestId: string;
  sessionId: string;
  onEvent?: (event: NormalizedAdapterEvent) => void;
  initialFrameIndex?: number;
  initialOffset?: number;
}>;

type PiAssistantTerminal = Readonly<{
  status: "success" | "failure" | "cancelled";
  text: string;
}>;

function assistantMessage(value: unknown): PiAssistantTerminal | "malformed" | undefined {
  const message = record(value);
  if (!message || message.role !== "assistant") return undefined;
  if (!Array.isArray(message.content)) return "malformed";
  const accumulator = new BoundedTextAccumulator();
  for (const blockValue of message.content) {
    const block = record(blockValue);
    if (!block) return "malformed";
    if (block.type === "text") {
      const text = boundedEventText(block.text);
      if (text === undefined || !accumulator.append(text)) return "malformed";
    }
  }
  const text = accumulator.value();
  if (text === undefined) return "malformed";
  const status = message.stopReason === "aborted"
    ? "cancelled"
    : message.stopReason === "error"
      ? "failure"
      : message.stopReason === "stop" || message.stopReason === "length" || message.stopReason === "toolUse"
        ? "success"
        : undefined;
  return status ? Object.freeze({ status, text }) : "malformed";
}

type ToolEventState = "started" | "progress" | "completed" | "failed";

export class PiRpcTurnCodec {
  readonly #promptRequestId: string;
  readonly #sessionId: string;
  readonly #onEvent: ((event: NormalizedAdapterEvent) => void) | undefined;
  readonly #sequence: FrameSequenceGuard;
  readonly #streamedText = new BoundedTextAccumulator();
  private promptAccepted = false;
  private promptRejected: CodecFrameReference | undefined;
  private lastAssistant: PiAssistantTerminal | undefined;
  private settledFrame: CodecFrameReference | undefined;
  private uncertainty: { code: ProtocolUncertaintyCode; detail: string } | undefined;
  private diagnostics = 0;
  private diagnosticsDropped = 0;
  private result: AdapterTerminalResult | undefined;
  private cancelRequestId: string | undefined;
  private cancelResponseSeen = false;

  constructor(options: PiCodecOptions) {
    this.#promptRequestId = identifier(options.promptRequestId, "promptRequestId");
    this.#sessionId = identifier(options.sessionId, "sessionId");
    this.#onEvent = options.onEvent;
    this.#sequence = new FrameSequenceGuard({ index: options.initialFrameIndex, offset: options.initialOffset });
  }

  expectCancelResponse(requestId: string): void {
    if (this.cancelRequestId && this.cancelRequestId !== requestId) {
      throw new Error("a different Pi cancel request is already registered");
    }
    this.cancelRequestId = identifier(requestId, "cancelRequestId");
  }

  push(frame: CodecFrame): readonly NormalizedAdapterEvent[] {
    if (this.result) return Object.freeze([]);
    const events: NormalizedAdapterEvent[] = [];
    const emit = (event: NormalizedAdapterEvent) => {
      const frozen = Object.freeze(event);
      events.push(frozen);
      this.#onEvent?.(frozen);
    };
    const sequenceFailure = this.#sequence.accept(frame);
    if (sequenceFailure) {
      this.markUncertain("invalid-frame-sequence", sequenceFailure, codecFrameReference(frame), emit);
      return Object.freeze(events);
    }
    if (this.uncertainty) return Object.freeze(events);
    const decoded = decodeJsonFrame(frame);
    if (decoded.status === "invalid") {
      this.markUncertain("malformed-frame", `${decoded.code}: ${decoded.detail}`, decoded.frame, emit);
      return Object.freeze(events);
    }
    const message = decoded.value;
    if (this.promptRejected) {
      const duplicate = message.type === "response" && message.id === this.#promptRequestId;
      this.markUncertain(duplicate ? "duplicate-terminal" : "post-terminal-event", duplicate
        ? "Pi emitted more than one prompt rejection"
        : "Pi frame arrived after prompt rejection", decoded.frame, emit);
      return Object.freeze(events);
    }
    if (this.settledFrame) {
      const lateCancel = message.type === "response" && this.cancelRequestId !== undefined && message.id === this.cancelRequestId;
      if (lateCancel) this.handleResponse(message, decoded.frame, emit);
      else {
        this.markUncertain(message.type === "agent_settled" ? "duplicate-terminal" : "post-terminal-event", message.type === "agent_settled"
          ? "Pi emitted more than one agent_settled event"
          : "Pi frame arrived after agent_settled", decoded.frame, emit);
      }
      return Object.freeze(events);
    }
    if (message.type === "response") {
      this.handleResponse(message, decoded.frame, emit);
      return Object.freeze(events);
    }
    if (!this.promptAccepted) {
      this.markUncertain("prompt-not-accepted", "Pi emitted turn events before accepting the correlated prompt", decoded.frame, emit);
      return Object.freeze(events);
    }
    this.handleEvent(message, decoded.frame, emit);
    return Object.freeze(events);
  }

  finish(): AdapterTerminalResult {
    if (this.result) return this.result;
    if (this.uncertainty) {
      this.result = uncertainResult(this.uncertainty.code, this.uncertainty.detail, this.diagnosticsDropped);
      return this.result;
    }
    if (this.promptRejected) {
      this.result = Object.freeze({
        status: "failure",
        terminalFrame: this.promptRejected,
        finalText: "",
        explicitLimit: false,
        diagnosticsDropped: this.diagnosticsDropped
      });
      return this.result;
    }
    if (!this.settledFrame || !this.lastAssistant) {
      this.result = uncertainResult("missing-terminal", "Pi stream ended without agent_settled and a final assistant message", this.diagnosticsDropped);
      return this.result;
    }
    this.result = Object.freeze({
      status: this.lastAssistant.status,
      terminalFrame: this.settledFrame,
      finalText: this.lastAssistant.text,
      explicitLimit: false,
      diagnosticsDropped: this.diagnosticsDropped
    });
    return this.result;
  }

  private handleResponse(
    message: Readonly<Record<string, unknown>>,
    frame: CodecFrameReference,
    emit: (event: NormalizedAdapterEvent) => void
  ): void {
    if (message.id === this.#promptRequestId) {
      if (message.command !== "prompt" || typeof message.success !== "boolean") {
        this.markUncertain("protocol-drift", "Pi prompt response is malformed", frame, emit);
        return;
      }
      if (this.promptAccepted) {
        this.markUncertain("duplicate-terminal", "Pi emitted more than one prompt response", frame, emit);
        return;
      }
      if (message.success) {
        this.promptAccepted = true;
        emit({ kind: "session", sessionId: this.#sessionId, state: "active", frame });
      } else {
        this.promptRejected = frame;
        emit({ kind: "error", category: "provider", frame });
      }
      return;
    }
    if (this.cancelRequestId && message.id === this.cancelRequestId) {
      if (this.cancelResponseSeen) {
        this.markUncertain("protocol-drift", "Pi emitted more than one abort response", frame, emit);
        return;
      }
      this.cancelResponseSeen = true;
      if (message.command !== "abort" || typeof message.success !== "boolean") {
        this.markUncertain("protocol-drift", "Pi abort response is malformed", frame, emit);
        return;
      }
      if (message.success) emit({ kind: "cancel", state: "cooperative-observed", frame });
      else emit({ kind: "error", category: "provider", frame });
      return;
    }
    this.markUncertain("foreign-correlation", "Pi response ID does not match a registered request", frame, emit);
  }

  private handleEvent(
    message: Readonly<Record<string, unknown>>,
    frame: CodecFrameReference,
    emit: (event: NormalizedAdapterEvent) => void
  ): void {
    if (typeof message.type !== "string") {
      this.markUncertain("protocol-drift", "Pi event has no type", frame, emit);
      return;
    }
    if (message.type === "message_update") {
      const update = record(message.assistantMessageEvent);
      if (!update || typeof update.type !== "string") {
        this.markUncertain("protocol-drift", "Pi message_update is malformed", frame, emit);
        return;
      }
      if (update.type === "text_delta" || update.type === "thinking_delta") {
        const text = boundedEventText(update.delta);
        if (text === undefined) {
          this.markUncertain("protocol-drift", `Pi ${update.type} has malformed text`, frame, emit);
          return;
        }
        if (update.type === "text_delta") {
          if (!this.#streamedText.append(text)) {
            this.markUncertain("text-limit", "Pi streamed assistant text exceeded the normalized text limit", frame, emit);
            return;
          }
          emit({ kind: "assistant-delta", text, frame });
        } else {
          emit({ kind: "thought-delta", text, frame });
        }
        return;
      }
      if (update.type === "toolcall_end") {
        const toolCall = record(update.toolCall);
        const toolCallId = boundedIdentifier(toolCall?.id, "toolCallId");
        if (!toolCallId) {
          this.markUncertain("protocol-drift", "Pi completed tool call has no identity", frame, emit);
          return;
        }
        const toolName = boundedIdentifier(toolCall?.name, "toolName");
        emit({ kind: "tool", toolCallId, state: "proposed", ...(toolName ? { toolName } : {}), frame });
        return;
      }
      this.emitDiagnostic("ignored-event", update.type, frame, emit);
      return;
    }
    if (message.type === "message_end") {
      const assistant = assistantMessage(message.message);
      if (assistant === "malformed") {
        this.markUncertain("protocol-drift", "Pi final assistant message is malformed", frame, emit);
        return;
      }
      if (assistant) {
        this.lastAssistant = assistant;
        emit({ kind: "assistant-final", text: assistant.text, frame });
      }
      return;
    }
    if (message.type === "tool_execution_start" || message.type === "tool_execution_update" || message.type === "tool_execution_end") {
      this.handleToolEvent(message, frame, emit);
      return;
    }
    if (message.type === "agent_settled") {
      if (!this.lastAssistant) {
        this.markUncertain("missing-terminal", "Pi agent_settled arrived without a final assistant message", frame, emit);
        return;
      }
      this.settledFrame = frame;
      emit({ kind: "session", sessionId: this.#sessionId, state: "settled", frame });
      if (this.lastAssistant.status === "cancelled") emit({ kind: "cancel", state: "terminal-cancelled", frame });
      return;
    }
    if (message.type === "extension_error") {
      emit({ kind: "error", category: "provider", frame });
      return;
    }
    this.emitDiagnostic("unknown-event", message.type, frame, emit);
  }

  private handleToolEvent(
    message: Readonly<Record<string, unknown>>,
    frame: CodecFrameReference,
    emit: (event: NormalizedAdapterEvent) => void
  ): void {
    const toolCallId = boundedIdentifier(message.toolCallId, "toolCallId");
    const toolName = boundedIdentifier(message.toolName, "toolName");
    if (!toolCallId) {
      this.markUncertain("protocol-drift", "Pi tool event has no bounded toolCallId", frame, emit);
      return;
    }
    const state: ToolEventState = message.type === "tool_execution_start"
      ? "started"
      : message.type === "tool_execution_update"
        ? "progress"
        : message.isError === true
          ? "failed"
          : message.isError === false
            ? "completed"
            : "failed";
    if (message.type === "tool_execution_end" && typeof message.isError !== "boolean") {
      this.markUncertain("protocol-drift", "Pi tool_execution_end has no isError boolean", frame, emit);
      return;
    }
    emit({ kind: "tool", toolCallId, ...(toolName ? { toolName } : {}), state, frame });
  }

  private emitDiagnostic(
    code: "unknown-event" | "ignored-event",
    eventType: string,
    frame: CodecFrameReference,
    emit: (event: NormalizedAdapterEvent) => void
  ): void {
    if (this.diagnostics >= ADAPTER_CODEC_LIMITS.maxDiagnosticEvents) {
      this.diagnosticsDropped = Math.min(Number.MAX_SAFE_INTEGER, this.diagnosticsDropped + 1);
      return;
    }
    this.diagnostics += 1;
    const boundedType = boundedIdentifier(eventType, "eventType");
    emit({ kind: "diagnostic", code, ...(boundedType ? { eventType: boundedType } : {}), frame });
  }

  private markUncertain(
    code: ProtocolUncertaintyCode,
    detail: string,
    frame: CodecFrameReference,
    emit: (event: NormalizedAdapterEvent) => void
  ): void {
    if (this.uncertainty) return;
    this.uncertainty = { code, detail };
    emit({ kind: "protocol-uncertain", code, detail, frame });
  }
}

export type PiRpcSessionCodecOptions = Readonly<{
  stateRequestId: string;
  statisticsBeforeRequestId: string;
  promptRequestId: string;
  statisticsAfterRequestId: string;
  cancelRequestId?: string;
  onStateReady?: (state: PiStateEvidence) => void;
  onStatisticsReady?: (statistics: PiSessionStatsSnapshot) => void;
  onAgentSettled?: () => void;
  onComplete?: () => void;
  onEvent?: (event: NormalizedAdapterEvent) => void;
}>;

/** Full native Pi RPC lifecycle decoder shared by live execution and durable replay. */
export class PiRpcSessionCodec {
  readonly #options: PiRpcSessionCodecOptions;
  readonly #stateRequestId: string;
  readonly #statisticsBeforeRequestId: string;
  readonly #promptRequestId: string;
  readonly #statisticsAfterRequestId: string;
  readonly #cancelRequestId: string | undefined;
  readonly #sequence = new FrameSequenceGuard();
  private phase: "state" | "statistics-before" | "turn" | "statistics-after" | "complete" = "state";
  private sessionId: string | undefined;
  private before: PiSessionStatsSnapshot | undefined;
  private usage: NormalizedUsage | undefined;
  private turn: PiRpcTurnCodec | undefined;
  private uncertainty: { code: ProtocolUncertaintyCode; detail: string } | undefined;
  private result: AdapterTerminalResult | undefined;

  constructor(options: PiRpcSessionCodecOptions) {
    this.#stateRequestId = identifier(options.stateRequestId, "stateRequestId");
    this.#statisticsBeforeRequestId = identifier(options.statisticsBeforeRequestId, "statisticsBeforeRequestId");
    this.#promptRequestId = identifier(options.promptRequestId, "promptRequestId");
    this.#statisticsAfterRequestId = identifier(options.statisticsAfterRequestId, "statisticsAfterRequestId");
    this.#cancelRequestId = options.cancelRequestId === undefined ? undefined : identifier(options.cancelRequestId, "cancelRequestId");
    if (new Set([
      this.#stateRequestId,
      this.#statisticsBeforeRequestId,
      this.#promptRequestId,
      this.#statisticsAfterRequestId,
      ...(this.#cancelRequestId ? [this.#cancelRequestId] : [])
    ]).size !== (this.#cancelRequestId ? 5 : 4)) throw new TypeError("Pi lifecycle request IDs must be distinct");
    this.#options = options;
  }

  push(frame: CodecFrame): readonly NormalizedAdapterEvent[] {
    if (this.result || this.uncertainty || this.phase === "complete") return Object.freeze([]);
    const sequenceFailure = this.#sequence.accept(frame);
    if (sequenceFailure) return this.fail("invalid-frame-sequence", sequenceFailure, codecFrameReference(frame));
    if (this.phase === "state") {
      const decoded = decodePiStateResponse(frame, this.#stateRequestId);
      if (decoded.status === "invalid") return this.fail(
        decoded.code === "foreign-correlation" ? "foreign-correlation" : "protocol-drift",
        `Pi state handshake failed: ${decoded.code}: ${decoded.detail}`,
        decoded.frame
      );
      if (decoded.value.isStreaming || decoded.value.isCompacting) {
        return this.fail("protocol-drift", "Pi state handshake was not idle", decoded.frame);
      }
      this.sessionId = decoded.value.sessionId;
      this.phase = "statistics-before";
      this.#options.onStateReady?.(decoded.value);
      return Object.freeze([]);
    }
    if (this.phase === "statistics-before") {
      const decoded = decodePiSessionStatsResponse(frame, this.#statisticsBeforeRequestId, this.sessionId!, 1);
      if (decoded.status === "invalid") return this.fail(
        decoded.code === "foreign-correlation" ? "foreign-correlation" : "malformed-accounting",
        `Pi pre-turn statistics failed: ${decoded.code}: ${decoded.detail}`,
        decoded.frame
      );
      this.before = decoded.value;
      const nextIndex = frame.index + 1;
      const nextOffset = frame.offset + frame.raw.byteLength + (frame.terminated ? 1 : 0);
      this.turn = new PiRpcTurnCodec({
        promptRequestId: this.#promptRequestId,
        sessionId: this.sessionId!,
        onEvent: this.#options.onEvent,
        initialFrameIndex: nextIndex,
        initialOffset: nextOffset
      });
      if (this.#cancelRequestId) this.turn.expectCancelResponse(this.#cancelRequestId);
      this.phase = "turn";
      this.#options.onStatisticsReady?.(decoded.value);
      return Object.freeze([]);
    }
    if (this.phase === "statistics-after") {
      const decoded = decodePiSessionStatsResponse(frame, this.#statisticsAfterRequestId, this.sessionId!, 1);
      if (decoded.status === "invalid") return this.fail(
        decoded.code === "foreign-correlation" ? "foreign-correlation" : "malformed-accounting",
        `Pi post-turn statistics failed: ${decoded.code}: ${decoded.detail}`,
        decoded.frame
      );
      this.usage = derivePiTurnUsage(this.before!, decoded.value);
      if (!this.usage) return this.fail("malformed-accounting", "Pi cumulative statistics could not produce a same-session turn delta", decoded.frame);
      this.phase = "complete";
      this.#options.onComplete?.();
      return Object.freeze([]);
    }

    const decoded = decodeJsonFrame(frame);
    const events = this.turn!.push(frame);
    if (decoded.status === "valid" && decoded.value.type === "agent_settled") {
      this.phase = "statistics-after";
      this.#options.onAgentSettled?.();
    } else if (
      decoded.status === "valid" &&
      decoded.value.type === "response" &&
      decoded.value.id === this.#promptRequestId &&
      decoded.value.command === "prompt" &&
      decoded.value.success === false
    ) {
      this.phase = "complete";
      this.#options.onComplete?.();
    }
    return events;
  }

  finish(): AdapterTerminalResult {
    if (this.result) return this.result;
    if (this.uncertainty) {
      this.result = uncertainResult(this.uncertainty.code, this.uncertainty.detail, 0);
      return this.result;
    }
    if (!this.turn) {
      this.result = uncertainResult("missing-terminal", `Pi stream ended during ${this.phase}`, 0);
      return this.result;
    }
    const turn = this.turn.finish();
    if (turn.status === "uncertain") {
      this.result = turn;
    } else if (this.phase === "statistics-after") {
      this.result = uncertainResult("missing-terminal", "Pi stream ended before correlated post-turn statistics", turn.diagnosticsDropped);
    } else {
      this.result = Object.freeze({ ...turn, ...(this.usage ? { usage: this.usage } : {}) });
    }
    return this.result;
  }

  private fail(
    code: ProtocolUncertaintyCode,
    detail: string,
    frame: CodecFrameReference
  ): readonly NormalizedAdapterEvent[] {
    this.uncertainty ??= { code, detail };
    const event = Object.freeze({ kind: "protocol-uncertain" as const, code, detail, frame });
    this.#options.onEvent?.(event);
    return Object.freeze([event]);
  }
}

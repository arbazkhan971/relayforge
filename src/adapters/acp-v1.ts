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

export const ACP_V1_WIRE_VERSION = "1" as const;
export const ACP_V1_CODEC_VERSION = 1 as const;

export type AcpRequestId = string | number;

export type AcpHandshakeEvidence = Readonly<{
  protocolVersion: typeof ACP_V1_WIRE_VERSION;
  agentName?: string;
  agentVersion?: string;
}>;

export type AcpSessionEvidence = Readonly<{
  sessionId: string;
}>;

export type AcpResponseResult<T> =
  | Readonly<{ status: "valid"; value: T; frame: CodecFrameReference }>
  | Readonly<{
      status: "invalid";
      code: "malformed-frame" | "foreign-correlation" | "rpc-error" | "malformed-result" | "wire-unsupported";
      detail: string;
      frame: CodecFrameReference;
    }>;

function requestId(value: unknown, name: string): AcpRequestId {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  const text = boundedIdentifier(value, name);
  if (text !== undefined) return text;
  throw new TypeError(`${name} must be a bounded string or safe integer`);
}

function requiredIdentifier(value: unknown, name: string): string {
  const parsed = boundedIdentifier(value, name);
  if (parsed === undefined) throw new TypeError(`${name} must be a bounded non-empty identifier`);
  return parsed;
}

function promptText(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0")) throw new TypeError("prompt text must be a NUL-free string");
  return value;
}

export function serializeAcpInitialize(input: Readonly<{
  requestId: AcpRequestId;
  clientName: string;
  clientVersion: string;
  meta?: Readonly<Record<string, unknown>>;
}>): Buffer {
  return serializeJsonLine({
    jsonrpc: "2.0",
    id: requestId(input.requestId, "requestId"),
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientInfo: {
        name: requiredIdentifier(input.clientName, "clientName"),
        version: requiredIdentifier(input.clientVersion, "clientVersion")
      },
      clientCapabilities: {},
      ...(input.meta === undefined ? {} : { _meta: input.meta })
    }
  });
}

export function serializeAcpNewSession(input: Readonly<{
  requestId: AcpRequestId;
  cwd: string;
  meta?: Readonly<Record<string, unknown>>;
}>): Buffer {
  if (typeof input.cwd !== "string" || input.cwd.length === 0 || input.cwd.includes("\0")) {
    throw new TypeError("cwd must be a non-empty NUL-free string");
  }
  return serializeJsonLine({
    jsonrpc: "2.0",
    id: requestId(input.requestId, "requestId"),
    method: "session/new",
    params: {
      cwd: input.cwd,
      mcpServers: [],
      ...(input.meta === undefined ? {} : { _meta: input.meta })
    }
  });
}

export function serializeAcpPrompt(input: Readonly<{
  requestId: AcpRequestId;
  sessionId: string;
  text: string;
}>): Buffer {
  return serializeJsonLine({
    jsonrpc: "2.0",
    id: requestId(input.requestId, "requestId"),
    method: "session/prompt",
    params: {
      sessionId: requiredIdentifier(input.sessionId, "sessionId"),
      prompt: [{ type: "text", text: promptText(input.text) }]
    }
  });
}

export function serializeAcpCancel(sessionId: string): Buffer {
  return serializeJsonLine({
    jsonrpc: "2.0",
    method: "session/cancel",
    params: { sessionId: requiredIdentifier(sessionId, "sessionId") }
  });
}

/**
 * Answer a provider-to-client permission request. The parent may select only
 * an option ID it observed with kind `allow_once`; persistent approval options
 * never enter this API.
 */
export function serializeAcpPermissionResponse(input: Readonly<{
  requestId: AcpRequestId;
  outcome: "allow-once" | "cancelled";
  allowOnceOptionId?: string;
}>): Buffer {
  const id = requestId(input.requestId, "permission requestId");
  if (input.outcome === "allow-once") {
    const optionId = requiredIdentifier(input.allowOnceOptionId, "allowOnceOptionId");
    return serializeJsonLine({
      jsonrpc: "2.0",
      id,
      result: { outcome: { outcome: "selected", optionId } }
    });
  }
  if (input.outcome !== "cancelled" || input.allowOnceOptionId !== undefined) {
    throw new TypeError("cancelled ACP permission responses cannot select an option");
  }
  return serializeJsonLine({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
}

export class AcpCancelStateMachine {
  readonly #state = new DeterministicCancelStateMachine();
  readonly #sessionId: string;

  constructor(sessionId: string) {
    this.#sessionId = requiredIdentifier(sessionId, "sessionId");
  }

  request(): Readonly<{ accepted: boolean; outbound?: Buffer; snapshot: CancelSnapshot }> {
    const acceptance = this.#state.request();
    if (!acceptance.shouldSend) return Object.freeze({ accepted: acceptance.accepted, snapshot: acceptance.snapshot });
    const outbound = serializeAcpCancel(this.#sessionId);
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

type AcpCodecOptions = Readonly<{
  sessionId: string;
  promptRequestId: AcpRequestId;
  onEvent?: (event: NormalizedAdapterEvent) => void;
  initialFrameIndex?: number;
  initialOffset?: number;
}>;

type AcceptedTerminal = Readonly<{
  status: "success" | "failure" | "cancelled";
  frame: CodecFrameReference;
}>;

function requestIdsEqual(left: unknown, right: AcpRequestId): boolean {
  return (typeof left === "string" || (typeof left === "number" && Number.isSafeInteger(left))) && left === right;
}

function acpResponseEnvelope(
  frame: CodecFrame,
  expectedRequestId: AcpRequestId
): AcpResponseResult<Readonly<Record<string, unknown>>> {
  const decoded = decodeJsonFrame(frame);
  if (decoded.status === "invalid") {
    return Object.freeze({ status: "invalid", code: "malformed-frame", detail: decoded.detail, frame: decoded.frame });
  }
  const message = decoded.value;
  if (message.jsonrpc !== "2.0") {
    return Object.freeze({ status: "invalid", code: "malformed-result", detail: "ACP response is not JSON-RPC 2.0", frame: decoded.frame });
  }
  if (!requestIdsEqual(message.id, expectedRequestId)) {
    return Object.freeze({ status: "invalid", code: "foreign-correlation", detail: "ACP response ID does not match the request", frame: decoded.frame });
  }
  if (message.error !== undefined) {
    return Object.freeze({ status: "invalid", code: "rpc-error", detail: "ACP request returned a JSON-RPC error", frame: decoded.frame });
  }
  const result = record(message.result);
  if (!result) {
    return Object.freeze({ status: "invalid", code: "malformed-result", detail: "ACP response result is malformed", frame: decoded.frame });
  }
  return Object.freeze({ status: "valid", value: result, frame: decoded.frame });
}

export function decodeAcpInitializeResponse(
  frame: CodecFrame,
  expectedRequestId: AcpRequestId
): AcpResponseResult<AcpHandshakeEvidence> {
  const expected = requestId(expectedRequestId, "expectedRequestId");
  const envelope = acpResponseEnvelope(frame, expected);
  if (envelope.status === "invalid") return envelope;
  if (envelope.value.protocolVersion !== 1) {
    return Object.freeze({ status: "invalid", code: "wire-unsupported", detail: "ACP initialize did not negotiate wire version 1", frame: envelope.frame });
  }
  const agentInfo = envelope.value.agentInfo === undefined ? undefined : record(envelope.value.agentInfo);
  if (envelope.value.agentInfo !== undefined && !agentInfo) {
    return Object.freeze({ status: "invalid", code: "malformed-result", detail: "ACP agentInfo is malformed", frame: envelope.frame });
  }
  const agentName = agentInfo?.name === undefined ? undefined : boundedIdentifier(agentInfo.name, "agentName");
  const agentVersion = agentInfo?.version === undefined ? undefined : boundedIdentifier(agentInfo.version, "agentVersion");
  if ((agentInfo?.name !== undefined && !agentName) || (agentInfo?.version !== undefined && !agentVersion)) {
    return Object.freeze({ status: "invalid", code: "malformed-result", detail: "ACP agentInfo identity is malformed", frame: envelope.frame });
  }
  const value: AcpHandshakeEvidence = Object.freeze({
    protocolVersion: ACP_V1_WIRE_VERSION,
    ...(agentName ? { agentName } : {}),
    ...(agentVersion ? { agentVersion } : {})
  });
  return Object.freeze({ status: "valid", value, frame: envelope.frame });
}

export function decodeAcpNewSessionResponse(
  frame: CodecFrame,
  expectedRequestId: AcpRequestId
): AcpResponseResult<AcpSessionEvidence> {
  const expected = requestId(expectedRequestId, "expectedRequestId");
  const envelope = acpResponseEnvelope(frame, expected);
  if (envelope.status === "invalid") return envelope;
  const sessionId = boundedIdentifier(envelope.value.sessionId, "sessionId");
  if (!sessionId) {
    return Object.freeze({ status: "invalid", code: "malformed-result", detail: "ACP new-session response has no bounded sessionId", frame: envelope.frame });
  }
  return Object.freeze({ status: "valid", value: Object.freeze({ sessionId }), frame: envelope.frame });
}

function contentText(value: unknown): string | undefined {
  const content = record(value);
  if (!content || content.type !== "text") return undefined;
  return boundedEventText(content.text);
}

function terminalUsage(value: unknown): NormalizedUsage | "malformed" | undefined {
  if (value === undefined) return undefined;
  const usage = record(value);
  if (!usage) return "malformed";
  const required = ["inputTokens", "outputTokens", "totalTokens"] as const;
  for (const key of required) if (safeCount(usage[key]) === undefined) return "malformed";
  const optional = ["thoughtTokens", "cachedReadTokens", "cachedWriteTokens"] as const;
  for (const key of optional) if (key in usage && safeCount(usage[key]) === undefined) return "malformed";
  const inputTokens = safeCount(usage.inputTokens)!;
  const outputTokens = safeCount(usage.outputTokens)!;
  const totalTokens = safeCount(usage.totalTokens)!;
  const thoughtTokens = safeCount(usage.thoughtTokens) ?? 0;
  const cachedReadTokens = safeCount(usage.cachedReadTokens) ?? 0;
  const cachedWriteTokens = safeCount(usage.cachedWriteTokens) ?? 0;
  const computedTotal = inputTokens + outputTokens + thoughtTokens + cachedReadTokens + cachedWriteTokens;
  if (!Number.isSafeInteger(computedTotal) || computedTotal !== totalTokens) return "malformed";
  return Object.freeze({
    source: "terminal-response",
    cumulative: false,
    inputTokens,
    outputTokens,
    totalTokens,
    ...(safeCount(usage.thoughtTokens) === undefined ? {} : { thoughtTokens: safeCount(usage.thoughtTokens) }),
    ...(safeCount(usage.cachedReadTokens) === undefined ? {} : { cachedReadTokens: safeCount(usage.cachedReadTokens) }),
    ...(safeCount(usage.cachedWriteTokens) === undefined ? {} : { cachedWriteTokens: safeCount(usage.cachedWriteTokens) })
  });
}

function usageUpdate(value: Readonly<Record<string, unknown>>): NormalizedUsage | "malformed" {
  const used = safeCount(value.used);
  const size = safeCount(value.size);
  if (used === undefined || size === undefined || size === 0 || used > size) return "malformed";
  let costUsd: number | undefined;
  if (value.cost !== undefined) {
    const cost = record(value.cost);
    if (!cost || cost.currency !== "USD") return "malformed";
    costUsd = safeNonNegativeNumber(cost.amount);
    if (costUsd === undefined) return "malformed";
  }
  return Object.freeze({
    source: "usage-update",
    cumulative: true,
    contextUsed: used,
    contextSize: size,
    ...(costUsd === undefined ? {} : { costUsd })
  });
}

function toolState(status: unknown, initial: boolean): NormalizedToolEventState | undefined {
  if (status === "pending") return "proposed";
  if (status === "in_progress") return initial ? "started" : "progress";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return undefined;
}

type NormalizedToolEventState = "proposed" | "started" | "progress" | "completed" | "failed";

export class AcpV1TurnCodec {
  readonly #sessionId: string;
  readonly #promptRequestId: AcpRequestId;
  readonly #onEvent: ((event: NormalizedAdapterEvent) => void) | undefined;
  readonly #sequence: FrameSequenceGuard;
  readonly #assistantText = new BoundedTextAccumulator();
  private terminal: AcceptedTerminal | undefined;
  private usage: NormalizedUsage | undefined;
  private uncertainty: { code: ProtocolUncertaintyCode; detail: string } | undefined;
  private diagnostics = 0;
  private diagnosticsDropped = 0;
  private result: AdapterTerminalResult | undefined;

  constructor(options: AcpCodecOptions) {
    this.#sessionId = requiredIdentifier(options.sessionId, "sessionId");
    this.#promptRequestId = requestId(options.promptRequestId, "promptRequestId");
    this.#onEvent = options.onEvent;
    this.#sequence = new FrameSequenceGuard({ index: options.initialFrameIndex, offset: options.initialOffset });
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
    if (this.terminal) {
      const code = message.method === undefined && requestIdsEqual(message.id, this.#promptRequestId)
        ? "duplicate-terminal" as const
        : "post-terminal-event" as const;
      this.markUncertain(code, code === "duplicate-terminal"
        ? "ACP emitted more than one correlated prompt response"
        : "ACP frame arrived after the correlated prompt response", decoded.frame, emit);
      return Object.freeze(events);
    }
    if (message.jsonrpc !== "2.0") {
      this.markUncertain("protocol-drift", "ACP frame does not declare JSON-RPC 2.0", decoded.frame, emit);
      return Object.freeze(events);
    }

    if (message.method === "session/update") {
      this.handleSessionUpdate(message.params, decoded.frame, emit);
      return Object.freeze(events);
    }
    if (message.method === "session/request_permission") {
      this.handlePermission(message, decoded.frame, emit);
      return Object.freeze(events);
    }
    if (message.method !== undefined) {
      this.emitDiagnostic("unknown-event", typeof message.method === "string" ? message.method : undefined, decoded.frame, emit);
      return Object.freeze(events);
    }

    if (!requestIdsEqual(message.id, this.#promptRequestId)) {
      this.markUncertain("foreign-correlation", "JSON-RPC response ID does not match the prompt request", decoded.frame, emit);
      return Object.freeze(events);
    }
    if (message.error !== undefined) {
      if (message.result !== undefined) {
        this.markUncertain("protocol-drift", "correlated JSON-RPC response contains both result and error", decoded.frame, emit);
        return Object.freeze(events);
      }
      if (!record(message.error)) {
        this.markUncertain("protocol-drift", "correlated JSON-RPC error is malformed", decoded.frame, emit);
        return Object.freeze(events);
      }
      this.terminal = Object.freeze({ status: "failure", frame: decoded.frame });
      emit({ kind: "error", category: "provider", frame: decoded.frame });
      return Object.freeze(events);
    }
    const result = record(message.result);
    if (!result || typeof result.stopReason !== "string") {
      this.markUncertain("protocol-drift", "correlated prompt response has no known stopReason", decoded.frame, emit);
      return Object.freeze(events);
    }
    const parsedUsage = terminalUsage(result.usage);
    if (parsedUsage === "malformed") {
      this.markUncertain("malformed-accounting", "ACP terminal usage is malformed", decoded.frame, emit);
      return Object.freeze(events);
    }
    if (parsedUsage) {
      this.usage = parsedUsage;
      emit({ kind: "usage", usage: parsedUsage, frame: decoded.frame });
    }
    const status = result.stopReason === "end_turn"
      ? "success"
      : result.stopReason === "cancelled"
        ? "cancelled"
        : result.stopReason === "max_tokens" || result.stopReason === "refusal"
          ? "failure"
          : undefined;
    if (!status) {
      this.markUncertain("protocol-drift", "ACP prompt response contains an unknown stopReason", decoded.frame, emit);
      return Object.freeze(events);
    }
    this.terminal = Object.freeze({ status, frame: decoded.frame });
    const finalText = this.#assistantText.value();
    if (finalText === undefined) {
      this.markUncertain("text-limit", "assistant text exceeded the normalized text limit", decoded.frame, emit);
    } else {
      emit({ kind: "assistant-final", text: finalText, frame: decoded.frame });
      if (status === "cancelled") emit({ kind: "cancel", state: "terminal-cancelled", frame: decoded.frame });
    }
    return Object.freeze(events);
  }

  finish(): AdapterTerminalResult {
    if (this.result) return this.result;
    if (this.uncertainty) {
      this.result = uncertainResult(this.uncertainty.code, this.uncertainty.detail, this.diagnosticsDropped);
      return this.result;
    }
    if (!this.terminal) {
      this.result = uncertainResult("missing-terminal", "ACP stream ended without a correlated prompt response", this.diagnosticsDropped);
      return this.result;
    }
    const finalText = this.#assistantText.value();
    if (finalText === undefined) {
      this.result = uncertainResult("text-limit", "assistant text exceeded the normalized text limit", this.diagnosticsDropped);
      return this.result;
    }
    this.result = Object.freeze({
      status: this.terminal.status,
      terminalFrame: this.terminal.frame,
      finalText,
      ...(this.usage ? { usage: this.usage } : {}),
      explicitLimit: false,
      diagnosticsDropped: this.diagnosticsDropped
    });
    return this.result;
  }

  private handleSessionUpdate(
    paramsValue: unknown,
    frame: CodecFrameReference,
    emit: (event: NormalizedAdapterEvent) => void
  ): void {
    const params = record(paramsValue);
    if (!params || params.sessionId !== this.#sessionId) {
      this.markUncertain("foreign-correlation", "ACP session update does not match the active session", frame, emit);
      return;
    }
    const update = record(params.update);
    if (!update || typeof update.sessionUpdate !== "string") {
      this.markUncertain("protocol-drift", "ACP session update is malformed", frame, emit);
      return;
    }
    if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
      const text = contentText(update.content);
      if (text === undefined) {
        this.markUncertain("protocol-drift", `${update.sessionUpdate} has malformed text content`, frame, emit);
        return;
      }
      if (update.sessionUpdate === "agent_message_chunk") {
        if (!this.#assistantText.append(text)) {
          this.markUncertain("text-limit", "assistant text exceeded the normalized text limit", frame, emit);
          return;
        }
        emit({ kind: "assistant-delta", text, frame });
      } else {
        emit({ kind: "thought-delta", text, frame });
      }
      return;
    }
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      const toolCallId = boundedIdentifier(update.toolCallId, "toolCallId");
      const state = toolState(update.status, update.sessionUpdate === "tool_call");
      if (!toolCallId || !state) {
        this.markUncertain("protocol-drift", "ACP tool update has malformed identity or status", frame, emit);
        return;
      }
      const title = boundedEventText(update.title);
      emit({
        kind: "tool",
        toolCallId,
        state,
        ...(title === undefined ? {} : { title }),
        frame
      });
      return;
    }
    if (update.sessionUpdate === "usage_update") {
      const usage = usageUpdate(update);
      if (usage === "malformed") {
        this.markUncertain("malformed-accounting", "ACP usage update is malformed", frame, emit);
        return;
      }
      this.usage = usage;
      emit({ kind: "usage", usage, frame });
      return;
    }
    this.emitDiagnostic("unknown-event", update.sessionUpdate, frame, emit);
  }

  private handlePermission(
    message: Readonly<Record<string, unknown>>,
    frame: CodecFrameReference,
    emit: (event: NormalizedAdapterEvent) => void
  ): void {
    const params = record(message.params);
    if (!params || params.sessionId !== this.#sessionId) {
      this.markUncertain("foreign-correlation", "ACP permission request does not match the active session", frame, emit);
      return;
    }
    const permissionId = boundedIdentifier(message.id, "permissionId");
    if (!permissionId) {
      this.markUncertain("protocol-drift", "ACP permission request has no bounded string ID", frame, emit);
      return;
    }
    if (!Array.isArray(params.options) || params.options.length > 64) {
      this.markUncertain("protocol-drift", "ACP permission options are missing or exceed the bound", frame, emit);
      return;
    }
    const seen = new Set<string>();
    let allowOnceOptionId: string | undefined;
    for (const value of params.options) {
      const option = record(value);
      const optionId = option ? boundedIdentifier(option.optionId, "permission optionId") : undefined;
      if (!option || !optionId || typeof option.kind !== "string") {
        this.markUncertain("protocol-drift", "ACP permission option is malformed", frame, emit);
        return;
      }
      if (seen.has(optionId)) {
        this.markUncertain("protocol-drift", "ACP permission option IDs are not unique", frame, emit);
        return;
      }
      seen.add(optionId);
      if (option.kind === "allow_once") {
        if (allowOnceOptionId !== undefined) {
          this.markUncertain("protocol-drift", "ACP permission request contains multiple allow_once options", frame, emit);
          return;
        }
        allowOnceOptionId = optionId;
      }
    }
    emit({
      kind: "permission",
      permissionId,
      state: "requested",
      ...(allowOnceOptionId === undefined ? {} : { allowOnceOptionId }),
      frame
    });
  }

  private emitDiagnostic(
    code: "unknown-event" | "ignored-event",
    eventType: string | undefined,
    frame: CodecFrameReference,
    emit: (event: NormalizedAdapterEvent) => void
  ): void {
    if (this.diagnostics >= ADAPTER_CODEC_LIMITS.maxDiagnosticEvents) {
      this.diagnosticsDropped = Math.min(Number.MAX_SAFE_INTEGER, this.diagnosticsDropped + 1);
      return;
    }
    this.diagnostics += 1;
    const boundedType = eventType === undefined ? undefined : boundedIdentifier(eventType, "eventType");
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

export type AcpV1SessionCodecOptions = Readonly<{
  initializeRequestId: AcpRequestId;
  newSessionRequestId: AcpRequestId;
  promptRequestId: AcpRequestId;
  /** Adapter-specific identity validation layered on the ACP v1 envelope. */
  decodeInitializeResponse?: (
    frame: CodecFrame,
    expectedRequestId: AcpRequestId
  ) => AcpResponseResult<AcpHandshakeEvidence>;
  onInitialized?: (evidence: AcpHandshakeEvidence) => void;
  onSessionReady?: (session: AcpSessionEvidence) => void;
  onPromptTerminal?: () => void;
  onEvent?: (event: NormalizedAdapterEvent) => void;
}>;

/**
 * Full ACP lifecycle decoder used by both the live contained transport and transcript replay.
 * Initialize/session responses are part of the same raw transcript and are validated before the
 * turn codec is activated; they can never be mistaken for prompt terminal authority.
 */
export class AcpV1SessionCodec {
  readonly #initializeRequestId: AcpRequestId;
  readonly #newSessionRequestId: AcpRequestId;
  readonly #promptRequestId: AcpRequestId;
  readonly #options: AcpV1SessionCodecOptions;
  readonly #sequence = new FrameSequenceGuard();
  private phase: "initialize" | "new-session" | "turn" = "initialize";
  private turn: AcpV1TurnCodec | undefined;
  private uncertainty: { code: ProtocolUncertaintyCode; detail: string } | undefined;
  private result: AdapterTerminalResult | undefined;
  private terminalNotified = false;

  constructor(options: AcpV1SessionCodecOptions) {
    this.#initializeRequestId = requestId(options.initializeRequestId, "initializeRequestId");
    this.#newSessionRequestId = requestId(options.newSessionRequestId, "newSessionRequestId");
    this.#promptRequestId = requestId(options.promptRequestId, "promptRequestId");
    if (
      this.#initializeRequestId === this.#newSessionRequestId ||
      this.#initializeRequestId === this.#promptRequestId ||
      this.#newSessionRequestId === this.#promptRequestId
    ) {
      throw new TypeError("ACP lifecycle request IDs must be distinct");
    }
    this.#options = options;
  }

  push(frame: CodecFrame): readonly NormalizedAdapterEvent[] {
    if (this.result || this.uncertainty) return Object.freeze([]);
    const sequenceFailure = this.#sequence.accept(frame);
    if (sequenceFailure) return this.fail("invalid-frame-sequence", sequenceFailure, codecFrameReference(frame));
    if (this.phase === "initialize") {
      const decoded = (this.#options.decodeInitializeResponse ?? decodeAcpInitializeResponse)(frame, this.#initializeRequestId);
      if (decoded.status === "invalid") return this.fail(
        decoded.code === "foreign-correlation" ? "foreign-correlation" : "protocol-drift",
        `ACP initialize failed: ${decoded.code}: ${decoded.detail}`,
        decoded.frame
      );
      this.phase = "new-session";
      this.#options.onInitialized?.(decoded.value);
      return Object.freeze([]);
    }
    if (this.phase === "new-session") {
      const decoded = decodeAcpNewSessionResponse(frame, this.#newSessionRequestId);
      if (decoded.status === "invalid") return this.fail(
        decoded.code === "foreign-correlation" ? "foreign-correlation" : "protocol-drift",
        `ACP session creation failed: ${decoded.code}: ${decoded.detail}`,
        decoded.frame
      );
      const nextIndex = frame.index + 1;
      const nextOffset = frame.offset + frame.raw.byteLength + (frame.terminated ? 1 : 0);
      this.turn = new AcpV1TurnCodec({
        sessionId: decoded.value.sessionId,
        promptRequestId: this.#promptRequestId,
        onEvent: this.#options.onEvent,
        initialFrameIndex: nextIndex,
        initialOffset: nextOffset
      });
      this.phase = "turn";
      this.#options.onSessionReady?.(decoded.value);
      return Object.freeze([]);
    }
    const events = this.turn!.push(frame);
    if (!this.terminalNotified) {
      const decoded = decodeJsonFrame(frame);
      if (decoded.status === "valid" && decoded.value.method === undefined && requestIdsEqual(decoded.value.id, this.#promptRequestId)) {
        this.terminalNotified = true;
        this.#options.onPromptTerminal?.();
      }
    }
    return events;
  }

  finish(): AdapterTerminalResult {
    if (this.result) return this.result;
    if (this.uncertainty) {
      this.result = uncertainResult(this.uncertainty.code, this.uncertainty.detail, 0);
    } else if (!this.turn) {
      this.result = uncertainResult("missing-terminal", `ACP stream ended during ${this.phase}`, 0);
    } else {
      this.result = this.turn.finish();
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

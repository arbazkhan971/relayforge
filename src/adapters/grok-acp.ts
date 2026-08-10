import {
  AcpV1TurnCodec,
  decodeAcpInitializeResponse,
  type AcpRequestId,
  type AcpResponseResult
} from "./acp-v1.js";
import { decodeJsonFrame, record, type CodecFrame } from "./codec.js";
import { GROK_AUDITED_VERSION } from "./builtins/grok.js";

export const GROK_ACP_NORMALIZER_VERSION = 1 as const;
const MAX_SYSTEM_PROMPT_BYTES = 4 * 1024 * 1024;

export type GrokInitializeEvidence = Readonly<{
  protocolVersion: "1";
  grokShell: true;
  agentVersion: typeof GROK_AUDITED_VERSION;
}>;

/** Fixed non-interactive startup metadata; no host/config/path data is admitted. */
export function grokInitializeMeta(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    startupHints: Object.freeze({
      nonInteractive: true,
      skipGitStatus: true,
      skipProjectLayout: true
    }),
    clientType: "relayforge",
    clientVersion: "1.0.0-rc.1"
  });
}

/** Grok's characterized dedicated standing-prompt channel. */
export function grokSessionMeta(systemPrompt: string): Readonly<Record<string, unknown>> {
  if (
    typeof systemPrompt !== "string" ||
    systemPrompt.includes("\0") ||
    Buffer.byteLength(systemPrompt, "utf8") > MAX_SYSTEM_PROMPT_BYTES
  ) {
    throw new TypeError("Grok system prompt must be bounded and NUL-free");
  }
  return Object.freeze({ systemPromptOverride: systemPrompt });
}

/** Validate the Grok-specific identity carried inside an otherwise standard ACP v1 response. */
export function decodeGrokInitializeResponse(
  frame: CodecFrame,
  expectedRequestId: AcpRequestId
): AcpResponseResult<GrokInitializeEvidence> {
  const standard = decodeAcpInitializeResponse(frame, expectedRequestId);
  if (standard.status === "invalid") return standard;
  const decoded = decodeJsonFrame(frame);
  if (decoded.status === "invalid") {
    return Object.freeze({ status: "invalid", code: "malformed-frame", detail: decoded.detail, frame: decoded.frame });
  }
  const result = record(decoded.value.result);
  const meta = result ? record(result._meta) : undefined;
  if (!meta || meta.grokShell !== true || meta.agentVersion !== GROK_AUDITED_VERSION) {
    return Object.freeze({
      status: "invalid",
      code: "malformed-result",
      detail: "ACP initialize response does not identify the characterized Grok shell",
      frame: decoded.frame
    });
  }
  return Object.freeze({
    status: "valid",
    value: Object.freeze({
      protocolVersion: "1",
      grokShell: true,
      agentVersion: GROK_AUDITED_VERSION
    }),
    frame: decoded.frame
  });
}

/**
 * Grok uses the shared bounded ACP v1 event grammar. This constructor gives
 * the versioned provider normalizer an explicit API without forking parsing.
 */
export function createGrokAcpTurnCodec(options: ConstructorParameters<typeof AcpV1TurnCodec>[0]): AcpV1TurnCodec {
  return new AcpV1TurnCodec(options);
}

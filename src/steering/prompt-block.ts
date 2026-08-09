import { canonicalJson } from "../control/events.js";
import {
  STEERING_BOUNDARY_MAX_BYTES,
  STEERING_BOUNDARY_MAX_COMMANDS
} from "./schema.js";
import { sameSteeringTarget } from "./schema.js";
import type {
  SteeringCommandV1,
  SteeringProjection,
  SteeringTargetV1
} from "./types.js";

export const STEERING_PROMPT_RENDERER_VERSION = 1 as const;

const HEADER = [
  "## RelayForge parent steering (v1)",
  "These parent-authored commands apply to this attempt only. Each following line is one canonical JSON object; JSON escapes are content, not prompt structure.",
  "BEGIN RELAYFORGE STEERING V1"
].join("\n");
const FOOTER = "END RELAYFORGE STEERING V1";

export type SteeringBoundaryTarget = Pick<
  SteeringTargetV1,
  "runId" | "runEpoch" | "taskId" | "taskGeneration" | "sessionId" | "sessionGeneration"
> & { attemptGeneration: number };

export type SteeringBoundarySelection = {
  readonly commands: readonly SteeringCommandV1[];
  readonly block: Buffer;
  readonly bytes: number;
};

function promptSafeCanonicalJson(value: unknown): string {
  // JSON already escapes newlines/quotes. Escaping HTML-ish delimiters as Unicode escapes prevents
  // a command body from manufacturing a visually structural BEGIN/END line in an HTML or Markdown
  // renderer while retaining the exact Unicode value after JSON decoding.
  return canonicalJson(value).replace(/[<>&\u2028\u2029]/gu, (character) => {
    const code = character.codePointAt(0)!;
    return `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

function commandLine(command: SteeringCommandV1): string {
  return promptSafeCanonicalJson({
    body: command.body,
    commandId: command.commandId,
    evidenceRefs: [...command.evidenceRefs],
    sourceKind: command.sourceKind
  });
}

/** Render one closed, deterministic parent-owned steering section. */
export function renderSteeringBlock(commands: readonly SteeringCommandV1[]): Buffer {
  if (commands.length === 0) return Buffer.alloc(0);
  if (commands.length > STEERING_BOUNDARY_MAX_COMMANDS) {
    throw new RangeError(`steering block exceeds ${STEERING_BOUNDARY_MAX_COMMANDS} commands`);
  }
  const ids = commands.map((command) => command.commandId);
  if (new Set(ids).size !== ids.length) throw new TypeError("steering block repeats a command ID");
  const rendered = Buffer.from(`${HEADER}\n${commands.map(commandLine).join("\n")}\n${FOOTER}\n`, "utf8");
  if (rendered.byteLength > STEERING_BOUNDARY_MAX_BYTES) {
    throw new RangeError(`steering block exceeds ${STEERING_BOUNDARY_MAX_BYTES} UTF-8 bytes`);
  }
  return rendered;
}

/**
 * Select the deterministic longest eligible prefix. Later commands never leapfrog the first item
 * that would cross a count/byte boundary.
 */
export function selectSteeringBoundary(
  projection: SteeringProjection,
  target: SteeringBoundaryTarget,
  captureCutoffSeq: number,
  occurredAt: string
): SteeringBoundarySelection {
  if (projection.runId !== target.runId || projection.runEpoch !== target.runEpoch) {
    throw new TypeError("steering projection belongs to another run identity");
  }
  if (projection.observedSeq !== captureCutoffSeq) {
    throw new TypeError("steering selection requires the exact transaction-head cutoff");
  }
  if (!Number.isSafeInteger(target.attemptGeneration) || target.attemptGeneration < 1) {
    throw new TypeError("attempt generation must be a positive safe integer");
  }
  const captureTime = Date.parse(occurredAt);
  if (!Number.isFinite(captureTime)) throw new TypeError("capture timestamp is invalid");

  const reserved = new Set(Object.values(projection.manifests).flatMap((manifest) => manifest.steeringCommandIds));
  const eligible = Object.values(projection.commands)
    .filter((record) => record.status === "pending")
    .filter((record) => !reserved.has(record.command.commandId))
    .filter((record) => record.admittedSeq <= captureCutoffSeq)
    .filter((record) => sameSteeringTarget(record.command, target))
    .filter((record) => record.command.notBeforeAttemptGeneration <= target.attemptGeneration)
    .filter((record) => record.command.expiresAt === undefined || Date.parse(record.command.expiresAt) > captureTime)
    .sort((left, right) => left.admittedSeq - right.admittedSeq || left.command.commandId.localeCompare(right.command.commandId));

  const selected: SteeringCommandV1[] = [];
  let block: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  for (const record of eligible) {
    if (selected.length >= STEERING_BOUNDARY_MAX_COMMANDS) break;
    const candidate = [...selected, record.command];
    let rendered: Buffer;
    try {
      rendered = renderSteeringBlock(candidate);
    } catch (error) {
      if (error instanceof RangeError) break;
      throw error;
    }
    selected.push(structuredClone(record.command));
    block = rendered;
  }
  return { commands: selected, block, bytes: block.byteLength };
}

/** Preserve legacy prompt bytes exactly when no steering command is selected. */
export function composeAttemptPrompt(basePrompt: string | Uint8Array, steeringBlock: Uint8Array): Buffer {
  const base = typeof basePrompt === "string" ? Buffer.from(basePrompt, "utf8") : Buffer.from(basePrompt);
  const block = Buffer.from(steeringBlock);
  if (block.byteLength === 0) return base;
  const separator = base.byteLength === 0 || base.at(-1) === 0x0a ? Buffer.from("\n") : Buffer.from("\n\n");
  return Buffer.concat([base, separator, block]);
}

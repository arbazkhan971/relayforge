import { randomUUID } from "node:crypto";
import { parseControlEvent, type ControlEvent } from "../control/events.js";
import type { AppendResult } from "../control/store.js";
import { deriveSteeringActivity, canCaptureSteering } from "./activity.js";
import { SteeringRepository, type SteeringRepositorySnapshot } from "./repository.js";
import { SteeringBoundedIdSchema, SteeringPositiveGenerationSchema } from "./schema.js";
import {
  composeAttemptPrompt,
  selectSteeringBoundary,
  STEERING_PROMPT_RENDERER_VERSION
} from "./prompt-block.js";
import {
  promptArtifactLocator,
  publishPromptArtifact,
  readVerifiedPromptArtifact,
  removeUnboundPromptArtifact,
  STEERING_PROMPT_MAX_BYTES,
  type PromptArtifactIdentity
} from "./prompt-manifest.js";
import type { SteeringPromptManifestFact } from "./types.js";

export type SteeringCaptureRepository = Pick<SteeringRepository, "runId" | "runEpoch" | "snapshot" | "appendAtHead">;

export type PrepareAttemptPromptOptions = {
  readonly repository: SteeringCaptureRepository;
  readonly runDir: string;
  readonly attemptId: string;
  readonly attemptGeneration: number;
  readonly taskId: string;
  readonly taskGeneration: number;
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly basePrompt: string | Uint8Array;
  readonly actorId: string;
  readonly now?: () => Date;
  readonly fault?: (point: "after-artifact-publish" | "before-canonical-commit" | "after-canonical-commit" | "after-artifact-verify") => void;
};

export type PreparedAttemptPrompt = {
  readonly manifest: SteeringPromptManifestFact & { artifactLocator: string };
  readonly artifact: Omit<PromptArtifactIdentity, "created">;
  readonly content: Buffer;
  readonly receipts: readonly AppendResult[];
};

export class SteeringCaptureError extends Error {
  constructor(
    readonly code: "INVALID_TARGET" | "BOUNDARY_UNAVAILABLE" | "PROMPT_TOO_LARGE" | "CONCURRENT_UPDATE" | "COMMIT_FAILED" | "ARTIFACT_INVALID",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "SteeringCaptureError";
  }
}

function version(snapshot: SteeringRepositorySnapshot, key: string): number {
  return snapshot.control.aggregateVersions[key]?.version ?? 0;
}

function requireTarget(options: PrepareAttemptPromptOptions, snapshot: SteeringRepositorySnapshot, occurredAt: string): void {
  if (options.repository.runId !== snapshot.control.runId || options.repository.runEpoch !== snapshot.control.runEpoch) {
    throw new SteeringCaptureError("INVALID_TARGET", "repository run identity changed during capture");
  }
  const task = snapshot.control.tasks[options.taskId];
  const runtime = snapshot.control.runtimes[options.sessionId];
  if (!task || task.generation !== options.taskGeneration || !runtime || runtime.sessionGeneration !== options.sessionGeneration || runtime.taskId !== options.taskId || runtime.taskGeneration !== options.taskGeneration) {
    throw new SteeringCaptureError("INVALID_TARGET", "attempt target does not match the canonical task/session generations");
  }
  const activity = deriveSteeringActivity(snapshot.control, {
    sessionId: options.sessionId,
    nowMs: Date.parse(occurredAt),
    headSeq: snapshot.headSeq
  });
  if (!canCaptureSteering(activity) || activity.nextAttemptGeneration !== options.attemptGeneration) {
    throw new SteeringCaptureError(
      "BOUNDARY_UNAVAILABLE",
      `session is ${activity.state}/${activity.certainty}; attempt ${activity.nextAttemptGeneration} is the next boundary`
    );
  }
}

function buildEvents(
  options: PrepareAttemptPromptOptions,
  snapshot: SteeringRepositorySnapshot,
  occurredAt: string,
  artifactLocator: string,
  content: Buffer,
  promptSha256: string,
  commandIds: readonly string[]
): ControlEvent[] {
  const taskVersion = version(snapshot, `task:${options.taskId}:${options.taskGeneration}`);
  const sessionVersion = version(snapshot, `session:${options.sessionId}:${options.sessionGeneration}`);
  const common = {
    schemaVersion: 1 as const,
    runId: options.repository.runId,
    runEpoch: options.repository.runEpoch,
    taskId: options.taskId,
    taskGeneration: options.taskGeneration,
    occurredAt,
    actorKind: "control-plane" as const,
    actorId: options.actorId,
    sourceKind: null,
    sourceId: null,
    sourceGeneration: null,
    sourceEventId: null
  };
  const prepared = parseControlEvent({
    ...common,
    eventId: `attempt.prompt:${options.attemptId}`,
    expectedVersion: taskVersion,
    type: "attempt.prompt_prepared",
    payload: {
      attemptId: options.attemptId,
      attemptGeneration: options.attemptGeneration,
      sessionId: options.sessionId,
      sessionGeneration: options.sessionGeneration,
      artifactLocator,
      promptSha256,
      promptBytes: content.byteLength,
      rendererVersion: STEERING_PROMPT_RENDERER_VERSION,
      captureCutoffSeq: snapshot.headSeq,
      steeringCommandIds: [...commandIds]
    }
  });
  const included = commandIds.map((commandId, index) => parseControlEvent({
    ...common,
    eventId: `steering.include:${options.attemptId}:${commandId}`,
    expectedVersion: sessionVersion + index,
    type: "steering.command_included",
    payload: {
      commandId,
      sessionId: options.sessionId,
      sessionGeneration: options.sessionGeneration,
      attemptId: options.attemptId,
      attemptGeneration: options.attemptGeneration,
      promptSha256
    }
  }));
  return [prepared, ...included];
}

export function prepareAttemptPrompt(options: PrepareAttemptPromptOptions): PreparedAttemptPrompt {
  const attemptId = SteeringBoundedIdSchema.parse(options.attemptId);
  const actorId = SteeringBoundedIdSchema.parse(options.actorId);
  const attemptGeneration = SteeringPositiveGenerationSchema.parse(options.attemptGeneration);
  SteeringBoundedIdSchema.parse(options.taskId);
  SteeringPositiveGenerationSchema.parse(options.taskGeneration);
  SteeringBoundedIdSchema.parse(options.sessionId);
  SteeringPositiveGenerationSchema.parse(options.sessionGeneration);
  const occurredAt = (options.now ?? (() => new Date()))().toISOString();
  const snapshot = options.repository.snapshot();
  requireTarget({ ...options, attemptId, actorId, attemptGeneration }, snapshot, occurredAt);
  const selected = selectSteeringBoundary(snapshot.steering, {
    runId: options.repository.runId,
    runEpoch: options.repository.runEpoch,
    taskId: options.taskId,
    taskGeneration: options.taskGeneration,
    sessionId: options.sessionId,
    sessionGeneration: options.sessionGeneration,
    attemptGeneration
  }, snapshot.headSeq, occurredAt);
  const content = composeAttemptPrompt(options.basePrompt, selected.block);
  if (content.byteLength > STEERING_PROMPT_MAX_BYTES) {
    throw new SteeringCaptureError("PROMPT_TOO_LARGE", `prepared prompt exceeds ${STEERING_PROMPT_MAX_BYTES} bytes`);
  }
  const locator = promptArtifactLocator(attemptId);
  let artifact: PromptArtifactIdentity;
  try {
    artifact = publishPromptArtifact(options.runDir, locator, content);
  } catch (error) {
    throw new SteeringCaptureError("ARTIFACT_INVALID", "prompt artifact could not be published", { cause: error as Error });
  }
  options.fault?.("after-artifact-publish");
  const events = buildEvents(
    { ...options, attemptId, actorId, attemptGeneration },
    snapshot,
    occurredAt,
    locator,
    content,
    artifact.sha256,
    selected.commands.map((command) => command.commandId)
  );
  let receipts: AppendResult[];
  try {
    options.fault?.("before-canonical-commit");
    receipts = options.repository.appendAtHead(snapshot.headSeq, events);
  } catch (error) {
    removeUnboundPromptArtifact(artifact);
    const message = error instanceof Error ? error.message : String(error);
    throw new SteeringCaptureError(/head|stale|version/i.test(message) ? "CONCURRENT_UPDATE" : "COMMIT_FAILED", "attempt prompt facts did not commit atomically", { cause: error as Error });
  }
  options.fault?.("after-canonical-commit");
  let verified;
  try {
    verified = readVerifiedPromptArtifact(options.runDir, locator, content.byteLength, artifact.sha256);
  } catch (error) {
    throw new SteeringCaptureError("ARTIFACT_INVALID", "committed attempt prompt artifact failed verification", { cause: error as Error });
  }
  options.fault?.("after-artifact-verify");
  const preparedReceipt = receipts[0];
  if (!preparedReceipt || preparedReceipt.seq !== snapshot.headSeq + 1 || receipts.length !== events.length) {
    throw new SteeringCaptureError("COMMIT_FAILED", "canonical prompt transaction returned inconsistent receipts");
  }
  const manifest: SteeringPromptManifestFact & { artifactLocator: string } = {
    attemptId,
    attemptGeneration,
    runId: options.repository.runId,
    runEpoch: options.repository.runEpoch,
    taskId: options.taskId,
    taskGeneration: options.taskGeneration,
    sessionId: options.sessionId,
    sessionGeneration: options.sessionGeneration,
    artifactLocator: locator,
    promptSha256: artifact.sha256,
    promptBytes: content.byteLength,
    rendererVersion: STEERING_PROMPT_RENDERER_VERSION,
    captureCutoffSeq: snapshot.headSeq,
    steeringCommandIds: selected.commands.map((command) => command.commandId),
    preparedSeq: preparedReceipt.seq
  };
  return {
    manifest,
    artifact: {
      locator: verified.locator,
      path: verified.path,
      bytes: verified.bytes,
      sha256: verified.sha256,
      dev: verified.dev,
      ino: verified.ino
    },
    content: verified.content,
    receipts
  };
}

export function createAttemptId(): string {
  return `attempt-${randomUUID()}`;
}

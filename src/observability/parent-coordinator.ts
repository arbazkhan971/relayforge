import { Buffer } from "node:buffer";
import { relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import type { ControlStore } from "../control/store.js";
import { observationSourceProjectionKey } from "../control/reducer.js";
import { createControlStoreTranscriptCommit } from "./control-store-adapter.js";
import { openTranscriptSource, type PinnedTranscriptSource } from "./source-context.js";
import {
  TRANSCRIPT_INGESTOR_LIMITS,
  TranscriptIngestorError,
  TranscriptIngestorStateV1Schema,
  createTranscriptIngestorState,
  pollTranscript,
  type IngestedObservationV1,
  type TranscriptIngestorStateV1,
  type TranscriptPollResult,
  type TranscriptRecordParserV1
} from "./transcript-ingestor.js";
import { ObservationGenerationV1Schema, type ObservationGenerationV1 } from "./types.js";

export const PARENT_TRANSCRIPT_COORDINATOR_MAX_FINAL_POLLS = 128;
export const PARENT_TRANSCRIPT_PARSER_ID = "relayforge.provider-transcript";
export const PARENT_TRANSCRIPT_PARSER_VERSION = 1;

export type ParentTranscriptCoordinatorOptions = Readonly<{
  /** The already-open parent store. This coordinator never opens a second database writer. */
  store: ControlStore;
  transcriptRoot: string;
  relativePath: string;
  generation: ObservationGenerationV1;
  actorId: string;
  now?: () => Date;
  maximumSourceBytes?: number;
  maxFinalPolls?: number;
}>;

export type ParentTranscriptProgressV1 = Readonly<{
  state: TranscriptIngestorStateV1;
  observations: readonly IngestedObservationV1[];
  committed: boolean;
  sourcePathState: TranscriptPollResult["sourcePathState"];
  headSeq: number;
}>;

export type ParentTranscriptFinalizationV1 = Readonly<{
  state: TranscriptIngestorStateV1;
  observationCount: number;
  commitCount: number;
  sourcePathState: TranscriptPollResult["sourcePathState"];
  headSeq: number;
}>;

export class ParentTranscriptCoordinatorError extends Error {
  constructor(
    readonly code:
      | "INVALID_CONFIGURATION"
      | "IDENTITY_MISMATCH"
      | "STALE_GENERATION"
      | "FINALIZATION_BOUND",
    message: string
  ) {
    super(`${code}: ${message}`);
    this.name = "ParentTranscriptCoordinatorError";
  }
}

function canonicalTimestamp(clock: () => Date): string {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new ParentTranscriptCoordinatorError("INVALID_CONFIGURATION", "transcript coordinator clock returned an invalid Date");
  }
  return value.toISOString();
}

function boundedSummary(record: Uint8Array): string {
  const maximum = 32 * 1024;
  const bytes = Buffer.from(record);
  if (bytes.byteLength <= maximum) return bytes.toString("utf8");
  return Buffer.concat([bytes.subarray(0, maximum - 32), Buffer.from("\n[record truncated]", "utf8")]).toString("utf8");
}

/**
 * A deliberately non-semantic parser: provider bytes become redacted progress evidence only. They
 * can never declare lifecycle, task, verification, SCM, steering, success, or authority facts.
 */
export function createProviderTranscriptObservationParser(observedAt: string): TranscriptRecordParserV1 {
  const timestamp = new Date(observedAt).toISOString();
  if (timestamp !== observedAt) throw new ParentTranscriptCoordinatorError("INVALID_CONFIGURATION", "provider transcript parser timestamp is not canonical UTC");
  return Object.freeze({
    id: PARENT_TRANSCRIPT_PARSER_ID,
    version: PARENT_TRANSCRIPT_PARSER_VERSION,
    parse(record: Uint8Array) {
      return Object.freeze({
        observedAt: timestamp,
        category: "provider" as const,
        phase: "executing" as const,
        severity: "info" as const,
        code: "provider.transcript.record",
        details: Object.freeze({ kind: "progress" as const, operationCode: "provider.output" }),
        summary: boundedSummary(record)
      });
    }
  });
}

export function transcriptRelativePath(transcriptRoot: string, absoluteTranscriptPath: string): string {
  let root: string;
  let path: string;
  try {
    root = realpathSync(transcriptRoot);
    path = realpathSync(absoluteTranscriptPath);
  } catch {
    throw new ParentTranscriptCoordinatorError("INVALID_CONFIGURATION", "transcript root/path is unavailable");
  }
  if (root !== resolve(transcriptRoot) || path !== resolve(absoluteTranscriptPath)) {
    throw new ParentTranscriptCoordinatorError("INVALID_CONFIGURATION", "transcript root/path must already be canonical");
  }
  const value = relative(root, path);
  if (!value || value === ".." || value.startsWith(`..${sep}`) || resolve(root, value) !== path) {
    throw new ParentTranscriptCoordinatorError("INVALID_CONFIGURATION", "transcript is outside the configured private root");
  }
  return value.split(sep).join("/");
}

/** Parent-side, restartable transcript progress/finalization coordinator. */
export class ParentTranscriptObservationCoordinator {
  private readonly store: ControlStore;
  private readonly source: PinnedTranscriptSource;
  private readonly generation: ObservationGenerationV1;
  private readonly now: () => Date;
  private readonly initialState: TranscriptIngestorStateV1;
  private readonly commit: ReturnType<typeof createControlStoreTranscriptCommit>;
  private readonly maxFinalPolls: number;
  private state: TranscriptIngestorStateV1;
  private closed = false;

  constructor(options: ParentTranscriptCoordinatorOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    try { this.generation = ObservationGenerationV1Schema.parse(options.generation); }
    catch { throw new ParentTranscriptCoordinatorError("INVALID_CONFIGURATION", "transcript generation is invalid"); }
    if (this.generation.runId !== this.store.runId || this.generation.runEpoch !== this.store.runEpoch || this.generation.taskId === undefined) {
      throw new ParentTranscriptCoordinatorError("IDENTITY_MISMATCH", "transcript generation does not belong to this task-scoped store");
    }
    this.validateCanonicalTarget();
    this.source = openTranscriptSource({
      root: options.transcriptRoot,
      relativePath: options.relativePath,
      ...(options.maximumSourceBytes === undefined ? {} : { maximumSourceBytes: options.maximumSourceBytes })
    });
    const initialParser = createProviderTranscriptObservationParser(canonicalTimestamp(this.now));
    this.initialState = createTranscriptIngestorState({ source: this.source, generation: this.generation, parser: initialParser });
    const persisted = this.store.getProjection().observability.sources[observationSourceProjectionKey(this.generation)]?.state;
    if (persisted !== undefined) {
      let state: TranscriptIngestorStateV1;
      try { state = TranscriptIngestorStateV1Schema.parse(persisted); }
      catch {
        this.source.close();
        throw new ParentTranscriptCoordinatorError("STALE_GENERATION", "persisted transcript state is invalid");
      }
      if (state.sourceId !== this.source.identity.sourceId || state.parserId !== PARENT_TRANSCRIPT_PARSER_ID ||
          state.parserVersion !== PARENT_TRANSCRIPT_PARSER_VERSION) {
        this.source.close();
        throw new ParentTranscriptCoordinatorError("STALE_GENERATION", "transcript pathname/source identity changed without a new source generation");
      }
      this.state = state;
    } else {
      this.state = this.initialState;
    }
    this.commit = createControlStoreTranscriptCommit({
      store: this.store,
      initialState: this.initialState,
      actorId: options.actorId,
      sourceKind: "provider_transcript",
      now: () => canonicalTimestamp(this.now)
    });
    this.maxFinalPolls = options.maxFinalPolls ?? PARENT_TRANSCRIPT_COORDINATOR_MAX_FINAL_POLLS;
    if (!Number.isSafeInteger(this.maxFinalPolls) || this.maxFinalPolls < 1 || this.maxFinalPolls > PARENT_TRANSCRIPT_COORDINATOR_MAX_FINAL_POLLS) {
      this.source.close();
      throw new ParentTranscriptCoordinatorError("INVALID_CONFIGURATION", "transcript finalization poll bound is invalid");
    }
  }

  get sourceId(): string { return this.source.identity.sourceId; }
  get currentState(): TranscriptIngestorStateV1 { return this.state; }

  async pollProgress(): Promise<ParentTranscriptProgressV1> {
    return this.poll(false, false);
  }

  /** Drain a verified terminal transcript, including one final unterminated record after two quiet polls. */
  async finalize(options: Readonly<{ allowPinnedReplacement?: boolean }> = {}): Promise<ParentTranscriptFinalizationV1> {
    this.assertOpen();
    let observations = 0;
    let commits = 0;
    let pathState: TranscriptPollResult["sourcePathState"] = this.source.pathState();
    for (let pass = 0; pass < this.maxFinalPolls; pass += 1) {
      const result = await this.poll(true, options.allowPinnedReplacement === true);
      observations += result.observations.length;
      if (result.committed) commits += 1;
      pathState = result.sourcePathState;
      if (this.state.cursor === this.source.size() && !this.state.discardingOversize) {
        return Object.freeze({ state: this.state, observationCount: observations, commitCount: commits, sourcePathState: pathState, headSeq: this.store.head().headSeq });
      }
    }
    throw new ParentTranscriptCoordinatorError("FINALIZATION_BOUND", "transcript did not quiesce within the bounded finalization window");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.source.close();
  }

  private async poll(quiescent: boolean, allowPinnedReplacement: boolean): Promise<ParentTranscriptProgressV1> {
    this.assertOpen();
    this.refreshState();
    const result = await pollTranscript({
      source: this.source,
      state: this.state,
      parser: createProviderTranscriptObservationParser(canonicalTimestamp(this.now)),
      commit: this.commit,
      now: canonicalTimestamp(this.now),
      quiescent,
      ...(allowPinnedReplacement ? { allowPinnedReplacement: true } : {})
    });
    this.state = result.state;
    return Object.freeze({ ...result, headSeq: this.store.head().headSeq });
  }

  private refreshState(): void {
    const persisted = this.store.getProjection().observability.sources[observationSourceProjectionKey(this.generation)]?.state;
    if (!persisted) return;
    const state = TranscriptIngestorStateV1Schema.parse(persisted);
    if (state.sourceId !== this.source.identity.sourceId || state.parserId !== PARENT_TRANSCRIPT_PARSER_ID || state.parserVersion !== PARENT_TRANSCRIPT_PARSER_VERSION) {
      throw new ParentTranscriptCoordinatorError("STALE_GENERATION", "canonical transcript state belongs to another source/parser identity");
    }
    this.state = state;
  }

  private validateCanonicalTarget(): void {
    const projection = this.store.getProjection();
    const task = projection.tasks[this.generation.taskId!];
    const runtime = projection.runtimes[this.generation.agentId];
    const attempt = Object.values(projection.attempts).find((candidate) =>
      candidate.taskId === this.generation.taskId && candidate.taskGeneration === task?.generation &&
      candidate.sessionId === this.generation.agentId && candidate.sessionGeneration === this.generation.runtimeGeneration &&
      candidate.attemptGeneration === this.generation.attemptGeneration
    );
    if (!task || !runtime || runtime.taskId !== task.id || runtime.taskGeneration !== task.generation ||
        runtime.sessionGeneration !== this.generation.runtimeGeneration || !attempt) {
      throw new ParentTranscriptCoordinatorError("STALE_GENERATION", "transcript attempt/runtime target is absent or stale");
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new ParentTranscriptCoordinatorError("INVALID_CONFIGURATION", "transcript coordinator is closed");
  }
}

export function createParentTranscriptObservationCoordinator(options: ParentTranscriptCoordinatorOptions): ParentTranscriptObservationCoordinator {
  return new ParentTranscriptObservationCoordinator(options);
}

/** Classifies only coordinator/IO integrity; it deliberately does not convert provider text into lifecycle facts. */
export function isTranscriptIntegrityFailure(error: unknown): boolean {
  return error instanceof TranscriptIngestorError || error instanceof ParentTranscriptCoordinatorError;
}

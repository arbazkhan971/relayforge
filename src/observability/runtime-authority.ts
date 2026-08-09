import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { ControlStore } from "../control/store.js";
import type {
  RunTranscriptObservationHandle,
  RunTranscriptObservationTarget
} from "../orchestrator.js";
import {
  createParentTranscriptObservationCoordinator,
  transcriptRelativePath
} from "./parent-coordinator.js";

export const PARENT_TRANSCRIPT_RUNTIME_MAX_ACTIVE = 64;

export type ParentTranscriptRuntimeFailureCode =
  | "PROGRESS_INGEST_FAILED"
  | "FINALIZE_INGEST_FAILED"
  | "SOURCE_CLOSE_FAILED"
  | "FORCE_CLOSE_FAILED";

/** Bounded, payload-free diagnostics for the optional transcript read model. */
export type ParentTranscriptRuntimeStatusV1 = Readonly<{
  schemaVersion: 1;
  lifecycle: "open" | "closed";
  health: "ready" | "degraded";
  activeSources: number;
  failureCount: number;
  lastFailureCode?: ParentTranscriptRuntimeFailureCode;
}>;

export type ParentTranscriptRuntimeAuthorityOptions = Readonly<{
  store: ControlStore;
  runDir: string;
  actorId: string;
  now?: () => Date;
}>;

export class ParentTranscriptRuntimeAuthorityError extends Error {
  constructor(readonly code: "INVALID_CONFIGURATION" | "CAPACITY" | "CLOSED", message: string) {
    super(`${code}: ${message}`);
    this.name = "ParentTranscriptRuntimeAuthorityError";
  }
}

type ActiveHandle = RunTranscriptObservationHandle & Readonly<{ forceClose(): Promise<void> }>;

/** Run-lifetime adapter from the provider transport's progress hints to durable P5 ingestion. */
export class ParentTranscriptRuntimeAuthority {
  private readonly options: ParentTranscriptRuntimeAuthorityOptions;
  private readonly active = new Set<ActiveHandle>();
  private failureCount = 0;
  private lastFailureCode: ParentTranscriptRuntimeFailureCode | undefined;
  private shutdown: Promise<void> | undefined;
  private closed = false;

  constructor(options: ParentTranscriptRuntimeAuthorityOptions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(options.actorId)) {
      throw new ParentTranscriptRuntimeAuthorityError("INVALID_CONFIGURATION", "transcript authority actor ID is invalid");
    }
    this.options = options;
  }

  open(input: Readonly<{
    target: RunTranscriptObservationTarget;
    transcriptPath: string;
    sourceGeneration: number;
  }>): RunTranscriptObservationHandle {
    if (this.closed) throw new ParentTranscriptRuntimeAuthorityError("CLOSED", "transcript runtime authority is closed");
    if (this.active.size >= PARENT_TRANSCRIPT_RUNTIME_MAX_ACTIVE) {
      throw new ParentTranscriptRuntimeAuthorityError("CAPACITY", "transcript runtime authority reached its active-source bound");
    }
    if (!Number.isSafeInteger(input.sourceGeneration) || input.sourceGeneration < 1) {
      throw new ParentTranscriptRuntimeAuthorityError("INVALID_CONFIGURATION", "transcript source generation is invalid");
    }
    const transcriptRoot = realpathSync(resolve(this.options.runDir, "transcripts"));
    const coordinator = createParentTranscriptObservationCoordinator({
      store: this.options.store,
      transcriptRoot,
      relativePath: transcriptRelativePath(transcriptRoot, input.transcriptPath),
      generation: {
        runId: this.options.store.runId,
        runEpoch: this.options.store.runEpoch,
        taskId: input.target.taskId,
        agentId: input.target.sessionId,
        runtimeGeneration: input.target.sessionGeneration,
        attemptGeneration: input.target.attemptGeneration,
        sourceGeneration: input.sourceGeneration
      },
      actorId: this.options.actorId,
      now: this.options.now
    });
    let dirty = false;
    let finishing = false;
    let finished = false;
    let drain: Promise<void> | undefined;
    let finalization: Promise<void> | undefined;
    const poll = async (): Promise<void> => {
      if (drain !== undefined) return await drain;
      const current = (async () => {
        do {
          dirty = false;
          try { await coordinator.pollProgress(); }
          catch { this.noteFailure("PROGRESS_INGEST_FAILED"); }
        } while (dirty && !finishing);
      })();
      drain = current;
      try { await current; }
      finally { if (drain === current) drain = undefined; }
    };
    const close = (failureCode: ParentTranscriptRuntimeFailureCode): void => {
      if (finished) return;
      finished = true;
      try { coordinator.close(); }
      catch { this.noteFailure(failureCode); }
      finally { this.active.delete(handle); }
    };
    const finalize = (transcriptDurable: boolean): Promise<void> => {
      if (finalization !== undefined) return finalization;
      if (finished) return Promise.resolve();
      finishing = true;
      const operation = (async () => {
        try {
          if (dirty || drain !== undefined) await poll();
          if (transcriptDurable) {
            try { await coordinator.finalize(); }
            catch { this.noteFailure("FINALIZE_INGEST_FAILED"); }
          }
        } catch {
          // Defensive containment: observation must never veto provider execution or teardown.
          this.noteFailure(transcriptDurable ? "FINALIZE_INGEST_FAILED" : "FORCE_CLOSE_FAILED");
        } finally {
          close(transcriptDurable ? "SOURCE_CLOSE_FAILED" : "FORCE_CLOSE_FAILED");
        }
      })();
      finalization = operation;
      return operation;
    };
    const handle: ActiveHandle = Object.freeze({
      progress() {
        if (finished || finishing) return;
        dirty = true;
        void poll();
      },
      finalize: ({ transcriptDurable }) => finalize(transcriptDurable),
      forceClose: () => finalize(false)
    });
    this.active.add(handle);
    return handle;
  }

  /** Observation teardown is deliberately non-vetoing and idempotently awaits the same drain. */
  closeAndDrain(): Promise<void> {
    if (this.shutdown !== undefined) return this.shutdown;
    this.closed = true;
    const operation = (async () => {
      const results = await Promise.allSettled([...this.active].map((handle) => handle.forceClose()));
      for (const result of results) {
        if (result.status === "rejected") this.noteFailure("FORCE_CLOSE_FAILED");
      }
    })();
    this.shutdown = operation;
    return operation;
  }

  status(): ParentTranscriptRuntimeStatusV1 {
    return Object.freeze({
      schemaVersion: 1,
      lifecycle: this.closed ? "closed" : "open",
      health: this.lastFailureCode === undefined ? "ready" : "degraded",
      activeSources: this.active.size,
      failureCount: this.failureCount,
      ...(this.lastFailureCode === undefined ? {} : { lastFailureCode: this.lastFailureCode })
    });
  }

  private noteFailure(code: ParentTranscriptRuntimeFailureCode): void {
    if (this.failureCount < Number.MAX_SAFE_INTEGER) this.failureCount += 1;
    this.lastFailureCode = code;
  }
}

export function createParentTranscriptRuntimeAuthority(
  options: ParentTranscriptRuntimeAuthorityOptions
): ParentTranscriptRuntimeAuthority {
  return new ParentTranscriptRuntimeAuthority(options);
}

import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";
import {
  bindCanonicalBoardAuthority,
  boardPaths,
  CONTROL_DATABASE_LEAF,
  controlAuthorityMarkerPath,
  readControlAuthorityMarker,
  type ControlAuthorityMarker
} from "../board.js";
import { leasePath, readStateFile } from "../runtime.js";
import { canonicalJson, type ControlEvent } from "./events.js";
import {
  executeLegacyImport,
  planLegacyImport,
  revalidateLegacySources,
  type LegacyFaultPoint,
  type LegacyImportPlan,
  type LegacyLeafKind,
  type LegacySourcePaths
} from "./legacy.js";
import type { LoopCheckpointFact } from "./reducer.js";
import type { ControlServiceOwnership } from "./service.js";
import { ControlStore, openControlStore } from "./store.js";

const CUTOVER_CONSUMER_ID = "control.cutover" as const;
const ARCHIVE_ROOT = "legacy-archives";
const RECEIPT_DIR = "control-migration";
const RECEIPT_LEAF = "legacy-import-receipt.json";
const MAX_MARKER_BYTES = 64 * 1024;

export type ControlCutoverFaultPoint =
  | "after-store-open"
  | "after-import"
  | "after-reopen-verification"
  | "after-archive"
  | "after-snapshot"
  | "after-marker-publication";

export type ControlCutoverOptions = {
  runDir: string;
  boardDir: string;
  statePath: string;
  scopesPath?: string;
  runId: string;
  runEpoch: string;
  /** Configuration-wide writer mutex, acquired before the run lease and held for this handle's lifetime. */
  controlOwnership: Pick<ControlServiceOwnership, "assertHeld">;
  activeLeaseId: string;
  initialState: LoopCheckpointFact;
  startedBy: string;
  goal?: string;
  acknowledgeLegacyLoss?: boolean;
  now?: () => string;
  /** TEST SEAM: production closes the pinned ControlStore directly. */
  closeStore?: (store: ControlStore) => void;
  fault?: (point: ControlCutoverFaultPoint) => void;
  legacyFault?: (point: LegacyFaultPoint) => void;
};

export type ControlAuthorityHandle = {
  marker: ControlAuthorityMarker;
  store: ControlStore;
  close: () => void;
};

export class ControlCutoverError extends Error {
  readonly code = "CONTROL_CUTOVER_REFUSED" as const;

  constructor(message: string) {
    super(message);
    this.name = "ControlCutoverError";
  }
}

type ArchiveLeafProof = {
  kind: LegacyLeafKind;
  leaf: string;
  bytes: number;
  sha256: string;
  dev: string;
  ino: string;
  mode: 256;
};

type ArchiveManifest = {
  schemaVersion: 1;
  archiveName: string;
  manifestDigest: string;
  files: ArchiveLeafProof[];
};

const archiveLeafSchema = z.strictObject({
  kind: z.enum(["tasks", "events", "messages", "loopState"]),
  leaf: z.enum(["tasks.jsonl", "events.jsonl", "messages.jsonl", ".loop_state.json"]),
  bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  dev: z.string().regex(/^\d+$/),
  ino: z.string().regex(/^\d+$/),
  mode: z.literal(0o400)
});

const archiveManifestSchema: z.ZodType<ArchiveManifest> = z.strictObject({
  schemaVersion: z.literal(1),
  archiveName: z.string().regex(/^legacy-[a-f0-9]{64}$/),
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(archiveLeafSchema).length(4)
});

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalUtc(value: string, label: string): string {
  if (!value.endsWith("Z") || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new ControlCutoverError(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function assertPrivateDirectory(path: string): void {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(absolute) !== absolute) {
    throw new ControlCutoverError(`cutover directory is not a real directory: ${absolute}`);
  }
  if (uid !== undefined && stat.uid !== uid) throw new ControlCutoverError(`cutover directory belongs to another uid: ${absolute}`);
  if ((stat.mode & 0o077) !== 0) throw new ControlCutoverError(`cutover directory is group/other accessible: ${absolute}`);
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(path);
}

/** The file lease is the existing run-level exclusion primitive. Verify exact PID+nonce, not presence. */
export function assertActiveRunLease(runDir: string, activeLeaseId: string): void {
  if (!/^[a-f0-9]{16}$/.test(activeLeaseId)) throw new ControlCutoverError("active run lease nonce is invalid");
  const read = readStateFile(leasePath(runDir));
  if (read.kind === "absent") throw new ControlCutoverError("exclusive run lease is not active");
  const fields = read.data.toString("utf8").trim().split(/\s+/);
  if (fields.length !== 3 || Number(fields[0]) !== process.pid || fields[1] !== activeLeaseId) {
    throw new ControlCutoverError("exclusive run lease does not belong to this parent incarnation");
  }
  canonicalUtc(fields[2]!, "run lease timestamp");
}

function assertControlWriterOwnership(options: ControlCutoverOptions): void {
  if (!options.controlOwnership || typeof options.controlOwnership.assertHeld !== "function") {
    throw new ControlCutoverError("configuration-wide control ownership was not supplied");
  }
  try {
    options.controlOwnership.assertHeld();
  } catch (error) {
    throw new ControlCutoverError(
      `configuration-wide control ownership is not held: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function assertCutoverOwnership(options: ControlCutoverOptions): void {
  // This order mirrors acquisition order: the stable configuration mutex must still be live before
  // the narrower run lease is trusted. Together they exclude both standalone and per-run writers.
  assertControlWriterOwnership(options);
  assertActiveRunLease(options.runDir, options.activeLeaseId);
}

/**
 * The scope journal is discharged only after the reaper proved every recorded process scope empty
 * and removed. A non-empty or unsafe journal is therefore durable evidence that writers are not
 * proven stopped; cutover must not even open/create the canonical database.
 */
export function assertLegacyWritersStopped(scopesPath: string): void {
  const read = readStateFile(scopesPath);
  if (read.kind === "present" && read.data.toString("utf8").trim().length > 0) {
    throw new ControlCutoverError("legacy writers are not proven stopped: the process-scope journal still contains unresolved ownership evidence");
  }
}

function legacyPaths(options: ControlCutoverOptions): LegacySourcePaths {
  const board = boardPaths(options.boardDir);
  return { tasks: board.tasks, events: board.events, messages: board.messages, loopState: resolve(options.statePath) };
}

function legacyPresence(paths: LegacySourcePaths): "all" | "none" {
  const present = Object.values(paths).map((path) => readStateFile(path).kind === "present");
  if (present.every(Boolean)) return "all";
  if (present.every((value) => !value)) return "none";
  throw new ControlCutoverError("legacy authority is partial; refusing to invent missing board or loop-state leaves");
}

function readPinnedSource(plan: LegacyImportPlan, kind: LegacyLeafKind): Buffer {
  const expected = plan.inventory[kind];
  let fd: number | undefined;
  try {
    fd = openSync(expected.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = fstatSync(fd, { bigint: true });
    if (before.dev.toString() !== expected.dev || before.ino.toString() !== expected.ino || Number(before.size) !== expected.bytes) {
      throw new ControlCutoverError(`legacy ${kind} identity changed before archive copy`);
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || sha256Bytes(bytes) !== expected.sha256) {
      throw new ControlCutoverError(`legacy ${kind} changed during archive copy`);
    }
    return bytes;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function archiveLeafName(kind: LegacyLeafKind): ArchiveLeafProof["leaf"] {
  if (kind === "loopState") return ".loop_state.json";
  return `${kind}.jsonl`;
}

function proveArchiveLeaf(path: string, kind: LegacyLeafKind, expectedBytes: number, expectedDigest: string): ArchiveLeafProof {
  const absolute = resolve(path);
  const read = readStateFile(absolute);
  if (read.kind === "absent") throw new ControlCutoverError(`archive leaf ${basename(absolute)} is missing`);
  const stat = lstatSync(absolute, { bigint: true });
  if (Number(stat.mode & 0o777n) !== 0o400 || read.data.length !== expectedBytes || sha256Bytes(read.data) !== expectedDigest) {
    throw new ControlCutoverError(`archive leaf ${basename(absolute)} failed byte/mode proof`);
  }
  return {
    kind,
    leaf: archiveLeafName(kind),
    bytes: read.data.length,
    sha256: expectedDigest,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    mode: 0o400
  };
}

function copyArchiveLeaf(path: string, bytes: Buffer, kind: LegacyLeafKind, expectedDigest: string): ArchiveLeafProof {
  const existing = readStateFile(path);
  if (existing.kind === "present") return proveArchiveLeaf(path, kind, bytes.length, expectedDigest);
  const temporary = `${path}.tmp-${process.pid}`;
  let fd: number | undefined;
  let published = false;
  try {
    fd = openSync(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    chmodSync(temporary, 0o400);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    published = true;
    const directoryFd = openSync(dirname(path), fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (!published) {
      try {
        unlinkSync(temporary);
      } catch {
        // A never-published temporary carries no authority.
      }
    }
  }
  return proveArchiveLeaf(path, kind, bytes.length, expectedDigest);
}

function writeCanonicalPrivate(path: string, value: unknown, mode: 0o400 | 0o600): Buffer {
  const body = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  if (body.length > MAX_MARKER_BYTES) throw new ControlCutoverError(`private cutover record ${basename(path)} exceeds 64 KiB`);
  const existing = readStateFile(path);
  if (existing.kind === "present") {
    if (!existing.data.equals(body)) throw new ControlCutoverError(`private cutover record ${basename(path)} conflicts with the durable record`);
    return existing.data;
  }
  const temporary = `${path}.tmp-${process.pid}`;
  let fd: number | undefined;
  let published = false;
  try {
    fd = openSync(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, body);
    fsyncSync(fd);
    if (mode === 0o400) chmodSync(temporary, mode);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    published = true;
    const directoryFd = openSync(dirname(path), fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (!published) {
      try {
        unlinkSync(temporary);
      } catch {
        // A never-published temporary carries no authority.
      }
    }
  }
  return body;
}

function createAndVerifyArchive(runDir: string, plan: LegacyImportPlan, archiveName: string): { manifest: ArchiveManifest; digest: string } {
  const root = resolve(runDir, ARCHIVE_ROOT);
  ensurePrivateDirectory(root);
  const directory = resolve(root, archiveName);
  ensurePrivateDirectory(directory);
  if (dirname(directory) !== root) throw new ControlCutoverError("legacy archive escaped its private root");

  const files: ArchiveLeafProof[] = [];
  for (const kind of ["tasks", "events", "messages", "loopState"] as const) {
    const source = readPinnedSource(plan, kind);
    files.push(copyArchiveLeaf(resolve(directory, archiveLeafName(kind)), source, kind, plan.inventory[kind].sha256));
  }
  revalidateLegacySources(plan);
  const manifest: ArchiveManifest = { schemaVersion: 1, archiveName, manifestDigest: plan.manifestDigest, files };
  const manifestPath = resolve(directory, "manifest.json");
  const bytes = writeCanonicalPrivate(manifestPath, manifest, 0o400);
  const parsed = archiveManifestSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (canonicalJson(parsed) !== canonicalJson(manifest)) throw new ControlCutoverError("legacy archive manifest changed during publication");
  const digest = sha256Bytes(bytes);
  return { manifest: parsed, digest };
}

function verifyArchiveFromMarker(runDir: string, marker: ControlAuthorityMarker): void {
  if (!marker.legacy) return;
  const directory = resolve(runDir, ARCHIVE_ROOT, marker.legacy.archiveName);
  assertPrivateDirectory(directory);
  const manifestRead = readStateFile(resolve(directory, "manifest.json"));
  if (manifestRead.kind === "absent") throw new ControlCutoverError("legacy archive manifest is missing after cutover");
  if (sha256Bytes(manifestRead.data) !== marker.legacy.archiveDigest) throw new ControlCutoverError("legacy archive manifest digest changed after cutover");
  let manifest: ArchiveManifest;
  try {
    manifest = archiveManifestSchema.parse(JSON.parse(manifestRead.data.toString("utf8")));
  } catch (error) {
    throw new ControlCutoverError(`legacy archive manifest is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest.archiveName !== marker.legacy.archiveName || manifest.manifestDigest !== marker.legacy.manifestDigest) {
    throw new ControlCutoverError("legacy archive manifest identity disagrees with the cutover marker");
  }
  for (const proof of manifest.files) {
    const current = proveArchiveLeaf(resolve(directory, proof.leaf), proof.kind, proof.bytes, proof.sha256);
    if (canonicalJson(current) !== canonicalJson(proof)) throw new ControlCutoverError(`legacy archive identity changed for ${proof.leaf}`);
  }
}

function initializeFreshStore(store: ControlStore, options: ControlCutoverOptions): void {
  const projection = store.getProjection();
  if (projection.headSeq === 0) {
    const startedAt = canonicalUtc(options.initialState.startedAt, "initial run startedAt");
    const started: ControlEvent = {
      schemaVersion: 1,
      eventId: "cutover.fresh.run.started",
      runId: options.runId,
      runEpoch: options.runEpoch,
      taskId: null,
      taskGeneration: null,
      expectedVersion: 0,
      occurredAt: startedAt,
      actorKind: "control-plane",
      actorId: options.startedBy,
      sourceKind: null,
      sourceId: null,
      sourceGeneration: null,
      sourceEventId: null,
      type: "run.started",
      payload: { startedBy: options.startedBy, ...(options.goal ? { goal: options.goal } : {}) }
    };
    const checkpoint: ControlEvent = {
      schemaVersion: 1,
      eventId: "cutover.fresh.run.checkpointed",
      runId: options.runId,
      runEpoch: options.runEpoch,
      taskId: null,
      taskGeneration: null,
      expectedVersion: 1,
      occurredAt: startedAt,
      actorKind: "control-plane",
      actorId: options.startedBy,
      sourceKind: null,
      sourceId: null,
      sourceGeneration: null,
      sourceEventId: null,
      type: "run.checkpointed",
      payload: { ...options.initialState, startedAt, updatedAt: startedAt }
    };
    store.appendBatch([started, checkpoint]);
    return;
  }
  // A retry may find the deterministic initialization transaction committed. Anything else before
  // marker publication is ambiguous and cannot be adopted as a fresh cutover.
  const current = store.getProjection();
  if (current.headSeq !== 2 || current.run?.status !== "started" || !current.run.checkpoint) {
    throw new ControlCutoverError("unmarked fresh control store contains unexpected canonical history");
  }
}

function boundAuthorityHandle(
  options: ControlCutoverOptions,
  marker: ControlAuthorityMarker,
  store: ControlStore,
  unbind: () => void
): ControlAuthorityHandle {
  let state: "open" | "close-failed" | "closed" = "open";
  let closeFailure: unknown;
  return {
    marker,
    store,
    close: () => {
      if (state === "closed") return;
      // A failed close is sticky. Never call through a second time and infer success from a store
      // whose own internal close flag may already have advanced before its database close threw.
      if (state === "close-failed") throw closeFailure;
      try {
        (options.closeStore ?? ((candidate: ControlStore) => candidate.close()))(store);
      } catch (error) {
        state = "close-failed";
        closeFailure = error;
        // Keep the compatibility binding and both outer leases. The caller cannot claim the
        // canonical writer stopped merely because teardown was attempted.
        throw error;
      }
      unbind();
      state = "closed";
    }
  };
}

function finalizeStoreMetadata(store: ControlStore): { headSeq: number; snapshotSeq: number; snapshotDigest: string } {
  const head = store.head();
  if (head.headSeq < 1 || head.floorSeq !== 1) throw new ControlCutoverError("cutover store has no complete retained canonical history");
  const cursor = store.readConsumerCursor(CUTOVER_CONSUMER_ID);
  if (!cursor) {
    store.advanceConsumerCursor({ consumerId: CUTOVER_CONSUMER_ID, generation: 1, expectedLastSeq: 0, nextLastSeq: head.headSeq });
  } else if (cursor.generation !== 1 || cursor.lastSeq !== head.headSeq) {
    throw new ControlCutoverError("cutover consumer cursor does not cover the exact imported head");
  }
  const snapshot = store.createSnapshot();
  if (snapshot.seq !== head.headSeq) throw new ControlCutoverError("cutover snapshot does not cover the exact canonical head");
  const verified = store.verifySnapshot(snapshot.seq);
  if (verified.digest !== snapshot.digest || verified.storeId !== store.storeId) throw new ControlCutoverError("cutover snapshot reopen proof failed");
  const integrity = store.verifyIntegrity("full");
  if (integrity.headSeq !== head.headSeq || integrity.storeId !== store.storeId) throw new ControlCutoverError("cutover full-integrity receipt disagrees with the canonical head");
  return { headSeq: head.headSeq, snapshotSeq: snapshot.seq, snapshotDigest: snapshot.digest };
}

function openEstablished(options: ControlCutoverOptions, marker: ControlAuthorityMarker): ControlAuthorityHandle {
  if (marker.runId !== options.runId || marker.runEpoch !== options.runEpoch || marker.database !== CONTROL_DATABASE_LEAF) {
    throw new ControlCutoverError("durable cutover marker belongs to a different run identity");
  }
  assertCutoverOwnership(options);
  const store = openControlStore({
    path: resolve(options.runDir, marker.database),
    runId: options.runId,
    runEpoch: options.runEpoch,
    create: false,
    recoveryMode: "verify",
    integrityCheck: "full",
    now: options.now
  });
  try {
    if (store.storeId !== marker.storeId) throw new ControlCutoverError("durable cutover marker names a different control store");
    const head = store.head();
    if (head.headSeq < marker.cutoverHeadSeq || head.floorSeq !== 1) throw new ControlCutoverError("canonical history regressed behind its cutover proof");
    const snapshot = store.verifySnapshot(marker.snapshotSeq);
    if (snapshot.digest !== marker.snapshotDigest) throw new ControlCutoverError("cutover snapshot digest changed");
    const cursor = store.readConsumerCursor(marker.consumerId);
    if (!cursor || cursor.generation !== marker.consumerGeneration || cursor.lastSeq !== marker.consumerLastSeq) {
      throw new ControlCutoverError("cutover consumer cursor proof is missing or changed");
    }
    store.verifyIntegrity("full");
    verifyArchiveFromMarker(options.runDir, marker);
    const unbind = bindCanonicalBoardAuthority(options.boardDir, marker, store);
    return boundAuthorityHandle(options, marker, store, unbind);
  } catch (error) {
    store.close();
    throw error;
  }
}

/**
 * Establish or reopen the one-way product authority switch. Every precondition is checked before
 * opening/creating ControlStore; the marker is published only after receipt, archive, snapshot,
 * cursor and full-integrity proofs all agree.
 */
export function cutoverControlAuthority(options: ControlCutoverOptions): ControlAuthorityHandle {
  const runDir = resolve(options.runDir);
  const boardDir = resolve(options.boardDir);
  if (dirname(boardDir) !== runDir) throw new ControlCutoverError("board directory is not the direct child of the run directory");
  assertPrivateDirectory(runDir);
  assertCutoverOwnership(options);
  assertLegacyWritersStopped(resolve(options.scopesPath ?? resolve(runDir, ".loop_scopes")));

  const existingMarker = readControlAuthorityMarker(boardDir);
  if (existingMarker) return openEstablished(options, existingMarker);

  const paths = legacyPaths(options);
  const presence = legacyPresence(paths);
  const storePath = resolve(runDir, CONTROL_DATABASE_LEAF);
  assertCutoverOwnership(options);
  let store = openControlStore({
    path: storePath,
    runId: options.runId,
    runEpoch: options.runEpoch,
    create: true,
    recoveryMode: "verify",
    now: options.now
  });
  let legacy: ControlAuthorityMarker["legacy"];
  try {
    options.fault?.("after-store-open");
    if (presence === "all") {
      const plan = planLegacyImport({ paths, runId: options.runId, runEpoch: options.runEpoch, fault: options.legacyFault });
      const receiptPath = resolve(runDir, RECEIPT_DIR, RECEIPT_LEAF);
      const imported = executeLegacyImport(store, plan, {
        receiptPath,
        allowDisclosedLoss: options.acknowledgeLegacyLoss === true,
        now: options.now,
        fault: options.legacyFault
      });
      if (!imported.archiveDecision.productCutoverAllowed) throw new ControlCutoverError("legacy import receipt does not permit product cutover");
      options.fault?.("after-import");

      const identity = store.identity();
      store.close();
      store = openControlStore({
        path: storePath,
        runId: options.runId,
        runEpoch: options.runEpoch,
        create: false,
        recoveryMode: "verify",
        integrityCheck: "full",
        now: options.now
      });
      if (store.storeId !== identity.storeId) throw new ControlCutoverError("control store identity changed across mandatory reopen verification");
      const reopened = executeLegacyImport(store, plan, {
        receiptPath,
        allowDisclosedLoss: options.acknowledgeLegacyLoss === true,
        now: options.now,
        fault: options.legacyFault
      });
      if (!reopened.idempotent || !reopened.archiveDecision.productCutoverAllowed) {
        throw new ControlCutoverError("legacy receipt/import was not exactly idempotent after reopen");
      }
      options.fault?.("after-reopen-verification");
      const archive = createAndVerifyArchive(runDir, plan, reopened.archiveDecision.archiveName);
      options.fault?.("after-archive");
      const receiptRead = readStateFile(receiptPath);
      if (receiptRead.kind === "absent") throw new ControlCutoverError("durable legacy import receipt disappeared before cutover");
      legacy = {
        planId: plan.planId,
        manifestDigest: plan.manifestDigest,
        receiptDigest: sha256Bytes(receiptRead.data),
        archiveName: reopened.archiveDecision.archiveName,
        archiveDigest: archive.digest,
        productCutoverAllowed: true
      };
    } else {
      initializeFreshStore(store, options);
    }

    const finalized = finalizeStoreMetadata(store);
    options.fault?.("after-snapshot");
    assertCutoverOwnership(options);
    const marker: ControlAuthorityMarker = {
      schemaVersion: 1,
      kind: "relayforge-control-authority",
      mode: legacy ? "legacy-import" : "fresh",
      runId: options.runId,
      runEpoch: options.runEpoch,
      storeId: store.storeId,
      database: CONTROL_DATABASE_LEAF,
      cutoverHeadSeq: finalized.headSeq,
      snapshotSeq: finalized.snapshotSeq,
      snapshotDigest: finalized.snapshotDigest,
      consumerId: CUTOVER_CONSUMER_ID,
      consumerGeneration: 1,
      consumerLastSeq: finalized.headSeq,
      cutoverAt: canonicalUtc((options.now ?? (() => new Date().toISOString()))(), "cutover time"),
      ...(legacy ? { legacy } : {})
    };
    writeCanonicalPrivate(controlAuthorityMarkerPath(boardDir), marker, 0o600);
    const durableMarker = readControlAuthorityMarker(boardDir);
    if (!durableMarker || canonicalJson(durableMarker) !== canonicalJson(marker)) throw new ControlCutoverError("cutover marker publication proof failed");
    options.fault?.("after-marker-publication");
    const unbind = bindCanonicalBoardAuthority(boardDir, durableMarker, store);
    return boundAuthorityHandle(options, durableMarker, store, unbind);
  } catch (error) {
    try {
      store.close();
    } catch {
      // Preserve the authoritative failure.
    }
    throw error;
  }
}

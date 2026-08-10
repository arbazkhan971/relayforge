import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync
} from "node:fs";
import { dirname, parse as parsePath, resolve } from "node:path";
import Database from "better-sqlite3";
import {
  CONTROL_EVENT_SCHEMA_VERSION,
  CONTROL_REDUCER_VERSION,
  aggregateForEvent,
  assertControlEventScope,
  canonicalControlEvent,
  canonicalPersistedControlEvent,
  canonicalJson,
  controlEventDigest,
  observationCommitSemanticDigest,
  parseControlEvent,
  persistedControlEventDigest,
  sha256Text,
  type ControlEvent,
  type PersistedControlEvent
} from "./events.js";
import {
  applyControlEvent,
  canonicalProjectionValue,
  ControlReductionError,
  deriveActivity,
  emptyControlProjection,
  emptyMultiRepositoryControlProjection,
  emptyObservabilityControlProjection,
  emptyScmControlProjection,
  observationSourceProjectionKey,
  reduceControlEvents,
  type ControlProjection,
  type DerivedActivity
} from "./reducer.js";
import { projectMultiRepositoryCanonicalFacts } from "../multirepo/orchestration.js";
import {
  assertControlRoomProjectionConsistent,
  type ControlRoomProjectionV1
} from "../control-room/projection.js";
import {
  TRANSCRIPT_INGESTOR_LIMITS,
  TranscriptIngestorStateV1Schema,
  transcriptIngestorStateDigest
} from "../observability/transcript-ingestor.js";

const APPLICATION_ID = 0x52464f52; // ASCII "RFOR"
const DATABASE_SCHEMA_VERSION = 1;
const MAX_RANGE_LIMIT = 10_000;

const MIGRATION_1_SQL = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE control_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  store_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  reducer_version INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  run_epoch TEXT NOT NULL,
  retained_floor INTEGER NOT NULL CHECK (retained_floor >= 1),
  head_seq INTEGER NOT NULL CHECK (head_seq >= 0),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE run_projection (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL,
  fact_json TEXT NOT NULL,
  digest TEXT NOT NULL
) STRICT;

CREATE TABLE control_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  run_epoch TEXT NOT NULL,
  task_id TEXT,
  task_generation INTEGER,
  expected_version INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  source_kind TEXT,
  source_id TEXT,
  source_generation INTEGER,
  source_event_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  canonical_json TEXT NOT NULL,
  intent_digest TEXT NOT NULL,
  digest TEXT NOT NULL,
  CHECK ((task_id IS NULL) = (task_generation IS NULL)),
  CHECK (task_generation IS NULL OR task_generation >= 1),
  CHECK (expected_version >= 0),
  CHECK (actor_kind IN ('control-plane', 'operator', 'agent', 'migration', 'system', 'integration')),
  CHECK ((source_kind IS NULL AND source_id IS NULL AND source_generation IS NULL AND source_event_id IS NULL) OR
         (source_kind IS NOT NULL AND source_id IS NOT NULL AND source_generation IS NOT NULL AND source_event_id IS NOT NULL)),
  CHECK (source_generation IS NULL OR source_generation >= 1),
  CHECK (length(intent_digest) = 64),
  CHECK (length(digest) = 64)
) STRICT;

CREATE INDEX control_events_task_seq ON control_events(task_id, seq);
CREATE INDEX control_events_type_seq ON control_events(event_type, seq);
CREATE UNIQUE INDEX control_events_external_source ON control_events(source_kind, source_id, source_generation, source_event_id) WHERE source_kind IS NOT NULL;

CREATE TABLE task_projection (
  task_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  version INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL,
  fact_json TEXT NOT NULL,
  digest TEXT NOT NULL
) STRICT;

CREATE TABLE message_projection (
  message_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  fact_json TEXT NOT NULL,
  digest TEXT NOT NULL
) STRICT;

CREATE TABLE runtime_projection (
  session_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL,
  fact_json TEXT NOT NULL,
  digest TEXT NOT NULL
) STRICT;

CREATE TABLE attempt_projection (
  attempt_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  task_generation INTEGER NOT NULL,
  attempt_generation INTEGER NOT NULL,
  fact_json TEXT NOT NULL,
  digest TEXT NOT NULL,
  UNIQUE(task_id, task_generation, attempt_generation)
) STRICT;

CREATE TABLE steering_projection (
  command_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  session_generation INTEGER NOT NULL,
  status TEXT NOT NULL,
  fact_json TEXT NOT NULL,
  digest TEXT NOT NULL
) STRICT;

CREATE INDEX steering_projection_pending ON steering_projection(session_id, session_generation, status);

CREATE TABLE aggregate_versions (
  aggregate_key TEXT PRIMARY KEY,
  aggregate_kind TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  version INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL
) STRICT;

CREATE TABLE control_snapshots (
  seq INTEGER PRIMARY KEY,
  store_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  reducer_version INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  run_epoch TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  verified_at TEXT NOT NULL
) STRICT;

CREATE TABLE consumer_cursors (
  consumer_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  last_seq INTEGER NOT NULL CHECK (last_seq >= 0),
  updated_at TEXT NOT NULL
) STRICT;
`;

const MIGRATION_1_CHECKSUM = createHash("sha256").update(MIGRATION_1_SQL, "utf8").digest("hex");
// sqlite_master stores the normalized CREATE statements (including constraints, UNIQUE indexes and
// STRICT table markers). This is deliberately independent of the migration-ledger checksum: a
// burned/forged migration row cannot prove that the physical schema actually exists.
function expectedPhysicalSchemaChecksum(): string {
  const memory = new Database(":memory:");
  try {
    memory.exec(MIGRATION_1_SQL);
    const rows = memory.prepare(`
      SELECT type, name, tbl_name, sql
      FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index')
      ORDER BY type, name
    `).all();
    return sha256Text(canonicalJson(rows));
  } finally {
    memory.close();
  }
}
const PHYSICAL_SCHEMA_CHECKSUM = expectedPhysicalSchemaChecksum();

export type ControlStoreErrorCode =
  | "RECOVERY_REQUIRED"
  | "CURSOR_EXPIRED"
  | "EVENT_ID_CONFLICT"
  | "STALE_GENERATION"
  | "STALE_VERSION"
  | "RUN_IDENTITY_MISMATCH"
  | "STORE_CLOSED"
  | "STORE_BUSY"
  | "INVALID_EVENT";

export class ControlStoreError extends Error {
  readonly code: ControlStoreErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: ControlStoreErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "ControlStoreError";
    this.code = code;
    this.details = details;
  }
}

export type ControlStoreFaultPoint =
  | "before-event-insert"
  | "after-event-insert"
  | "before-projection-write"
  | "after-projection-write"
  | "before-cursor-write"
  | "after-cursor-write"
  | "before-commit";

export type OpenControlStoreOptions = {
  path: string;
  runId: string;
  runEpoch: string;
  create?: boolean;
  recoveryMode?: "verify" | "rebuild";
  now?: () => string;
  scheduleWake?: (callback: () => void) => void;
  fault?: (point: ControlStoreFaultPoint, event?: ControlEvent) => void;
  integrityCheck?: "quick" | "full";
};

export type AppendResult = {
  eventId: string;
  seq: number;
  digest: string;
  intentDigest: string;
  recordedAt: string;
  idempotent: boolean;
  aggregateVersion: number;
};

export type EventRange = {
  runEpoch: string;
  floorSeq: number;
  headSeq: number;
  afterSeq: number;
  events: PersistedControlEvent[];
  hasMore: boolean;
};

export type SnapshotReceipt = {
  seq: number;
  storeId: string;
  runId: string;
  runEpoch: string;
  schemaVersion: number;
  reducerVersion: number;
  digest: string;
  createdAt: string;
  verifiedAt: string;
};

export type ConsumerCursor = {
  consumerId: string;
  generation: number;
  lastSeq: number;
  updatedAt: string;
};

export type ConsumerCursorAdvance = {
  consumerId: string;
  generation: number;
  expectedLastSeq: number;
  nextLastSeq: number;
};

export type AppendWithCursorResult = {
  events: AppendResult[];
  cursor: ConsumerCursor;
};

/**
 * Whole-history compare-and-append. The head comparison and every event/projection write happen
 * under the same serialized SQLite writer transaction, so callers can safely make decisions from
 * a previously read ControlProjection even when those decisions span multiple aggregate keys.
 */
export type AppendBatchIfOptions = {
  expectedHeadSeq: number;
  events: readonly unknown[];
};

export type IntegrityReceipt = {
  level: "quick" | "full";
  storeId: string;
  runId: string;
  runEpoch: string;
  headSeq: number;
  verifiedAt: string;
};

export type StoreWake = { runEpoch: string; headSeq: number };
export type StoreSubscriber = (wake: StoreWake) => void;

type MetaRow = {
  store_id: string;
  schema_version: number;
  reducer_version: number;
  run_id: string;
  run_epoch: string;
  retained_floor: number;
  head_seq: number;
  created_at: string;
};

type EventRow = {
  seq: number | bigint;
  event_id: string;
  run_id: string;
  run_epoch: string;
  task_id: string | null;
  task_generation: number | bigint | null;
  expected_version: number | bigint;
  occurred_at: string;
  recorded_at: string;
  actor_kind: string;
  actor_id: string;
  source_kind: string | null;
  source_id: string | null;
  source_generation: number | bigint | null;
  source_event_id: string | null;
  event_type: string;
  payload_json: string;
  canonical_json: string;
  intent_digest: string;
  digest: string;
};

type FactRow = { fact_json: string; digest: string };
type KeyedFactRow = FactRow & { key: string };
type SnapshotRow = {
  seq: number | bigint;
  store_id: string;
  schema_version: number;
  reducer_version: number;
  run_id: string;
  run_epoch: string;
  payload_json: string;
  digest: string;
  created_at: string;
  verified_at: string;
};

type ConsumerCursorRow = {
  consumer_id: string;
  generation: number | bigint;
  last_seq: number | bigint;
  updated_at: string;
};

const expectedColumns: Record<string, readonly string[]> = {
  schema_migrations: ["version", "checksum", "applied_at"],
  control_meta: ["singleton", "store_id", "schema_version", "reducer_version", "run_id", "run_epoch", "retained_floor", "head_seq", "created_at"],
  run_projection: ["singleton", "status", "version", "updated_seq", "fact_json", "digest"],
  control_events: ["seq", "event_id", "run_id", "run_epoch", "task_id", "task_generation", "expected_version", "occurred_at", "recorded_at", "actor_kind", "actor_id", "source_kind", "source_id", "source_generation", "source_event_id", "event_type", "payload_json", "canonical_json", "intent_digest", "digest"],
  task_projection: ["task_id", "generation", "version", "updated_seq", "fact_json", "digest"],
  message_projection: ["message_id", "seq", "fact_json", "digest"],
  runtime_projection: ["session_id", "generation", "updated_seq", "fact_json", "digest"],
  attempt_projection: ["attempt_id", "task_id", "task_generation", "attempt_generation", "fact_json", "digest"],
  steering_projection: ["command_id", "session_id", "session_generation", "status", "fact_json", "digest"],
  aggregate_versions: ["aggregate_key", "aggregate_kind", "aggregate_id", "generation", "version", "updated_seq"],
  control_snapshots: ["seq", "store_id", "schema_version", "reducer_version", "run_id", "run_epoch", "payload_json", "digest", "created_at", "verified_at"],
  consumer_cursors: ["consumer_id", "generation", "last_seq", "updated_at"]
};

function asSafeInteger(value: number | bigint, label: string): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0) throw recovery(`${label} is not a safe non-negative integer`);
  return number;
}

function recovery(message: string, details?: Readonly<Record<string, unknown>>): ControlStoreError {
  return new ControlStoreError("RECOVERY_REQUIRED", message, details);
}

function normalizeStoreError(error: unknown): never {
  if (error instanceof ControlStoreError) throw error;
  if (error instanceof ControlReductionError) {
    throw new ControlStoreError("INVALID_EVENT", error.message);
  }
  const maybe = error as { code?: unknown; message?: unknown };
  if (maybe?.code === "SQLITE_BUSY" || maybe?.code === "SQLITE_LOCKED") {
    throw new ControlStoreError("STORE_BUSY", "control store writer is busy", { sqliteCode: maybe.code });
  }
  if (error instanceof Error && (error.name === "SqliteError" || typeof maybe?.code === "string" && maybe.code.startsWith("SQLITE_"))) {
    throw recovery("SQLite control store operation failed", { sqliteCode: maybe.code, cause: error.message.slice(0, 512) });
  }
  throw error;
}

function canonicalUtc(value: string, label: string): string {
  if (typeof value !== "string" || !value.endsWith("Z") || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw recovery(`${label} is not a canonical UTC timestamp`);
  }
  return value;
}

function assertRealPrivateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(path) !== resolve(path)) {
    throw recovery(`control store ancestor is not a real directory: ${path}`);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && stat.uid !== uid) throw recovery("control store parent belongs to another uid");
  if ((stat.mode & 0o077) !== 0) throw recovery("control store parent permissions expose authority to group/other");
}

function assertNoSymlinkAncestors(path: string): void {
  const absolute = resolve(path);
  const root = parsePath(absolute).root;
  const components = absolute.slice(root.length).split("/").filter(Boolean);
  let current = root;
  for (const component of components) {
    current = resolve(current, component);
    if (!existsSync(current)) return;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || realpathSync(current) !== current) {
      throw recovery(`control store path contains a symlinked ancestor: ${current}`);
    }
  }
}

function validateStorePath(path: string, create: boolean): { absolute: string; created: boolean; dev: number; ino: number } {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  let created = false;
  if (!existsSync(absolute)) {
    if (!create) throw recovery(`control store does not exist: ${absolute}`);
    assertNoSymlinkAncestors(parent);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    assertNoSymlinkAncestors(parent);
    assertRealPrivateDirectory(parent);
    const fd = openSync(absolute, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW, 0o600);
    closeSync(fd);
    created = true;
  } else {
    assertNoSymlinkAncestors(absolute);
    assertRealPrivateDirectory(parent);
  }
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw recovery("control store path is not a regular file");
  if (stat.nlink !== 1) throw recovery("control store file has multiple hard links");
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && stat.uid !== uid) throw recovery("control store belongs to another uid");
  if ((stat.mode & 0o077) !== 0) throw recovery("control store permissions expose authority to group/other");
  return { absolute, created, dev: stat.dev, ino: stat.ino };
}

function assertUnchangedFile(path: string, dev: number, ino: number): void {
  assertNoSymlinkAncestors(path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== dev || stat.ino !== ino || stat.nlink !== 1) {
    throw recovery("control store identity changed while opening");
  }
}

function databasePragmaNumber(db: Database.Database, pragma: string): number {
  const value = db.pragma(pragma, { simple: true }) as number | bigint;
  return asSafeInteger(value, `PRAGMA ${pragma}`);
}

function bootstrap(db: Database.Database, runId: string, runEpoch: string, now: string): void {
  canonicalUtc(now, "store creation time");
  const storeId = randomUUID();
  db.pragma(`application_id = ${APPLICATION_ID}`);
  const transaction = db.transaction(() => {
    db.exec(MIGRATION_1_SQL);
    db.prepare("INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (?, ?, ?)").run(
      DATABASE_SCHEMA_VERSION,
      MIGRATION_1_CHECKSUM,
      now
    );
    db.prepare(`
      INSERT INTO control_meta(singleton, store_id, schema_version, reducer_version, run_id, run_epoch, retained_floor, head_seq, created_at)
      VALUES (1, ?, ?, ?, ?, ?, 1, 0, ?)
    `).run(storeId, CONTROL_EVENT_SCHEMA_VERSION, CONTROL_REDUCER_VERSION, runId, runEpoch, now);
    db.pragma(`user_version = ${DATABASE_SCHEMA_VERSION}`);
  });
  transaction.immediate();
}

function verifyPhysicalSchema(db: Database.Database, integrity: "quick" | "full" = "quick"): void {
  if (databasePragmaNumber(db, "application_id") !== APPLICATION_ID) throw recovery("control store application_id mismatch");
  if (databasePragmaNumber(db, "user_version") !== DATABASE_SCHEMA_VERSION) throw recovery("control store user_version mismatch");
  const result = db.pragma(integrity === "full" ? "integrity_check" : "quick_check", { simple: true });
  if (result !== "ok") throw recovery(`SQLite ${integrity === "full" ? "integrity_check" : "quick_check"} failed`, { result: String(result).slice(0, 256) });

  for (const [table, columns] of Object.entries(expectedColumns)) {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (rows.length !== columns.length || rows.some((row, index) => row.name !== columns[index])) {
      throw recovery(`physical schema mismatch for ${table}`);
    }
  }
  const physicalRows = db.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index')
    ORDER BY type, name
  `).all() as Array<{ type: string; name: string; tbl_name: string; sql: string }>;
  if (sha256Text(canonicalJson(physicalRows)) !== PHYSICAL_SCHEMA_CHECKSUM) {
    throw recovery("physical schema DDL checksum mismatch");
  }
  const migration = db.prepare("SELECT checksum FROM schema_migrations WHERE version = ?").get(DATABASE_SCHEMA_VERSION) as { checksum: string } | undefined;
  const migrationCount = db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number | bigint };
  if (!migration || migration.checksum !== MIGRATION_1_CHECKSUM || asSafeInteger(migrationCount.count, "migration count") !== 1) {
    throw recovery("migration ledger checksum/version mismatch");
  }
}

function readMeta(db: Database.Database): MetaRow {
  const row = db.prepare("SELECT store_id, schema_version, reducer_version, run_id, run_epoch, retained_floor, head_seq, created_at FROM control_meta WHERE singleton = 1").get() as MetaRow | undefined;
  if (!row) throw recovery("control store metadata is missing");
  if (row.schema_version !== CONTROL_EVENT_SCHEMA_VERSION || row.reducer_version !== CONTROL_REDUCER_VERSION) {
    throw recovery("control store schema/reducer version is unsupported");
  }
  if (!Number.isSafeInteger(row.retained_floor) || row.retained_floor < 1) throw recovery("control store retained floor is invalid");
  if (!Number.isSafeInteger(row.head_seq) || row.head_seq < 0) throw recovery("control store head is invalid");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.store_id)) {
    throw recovery("control store storeId is invalid");
  }
  canonicalUtc(row.created_at, "control store creation time");
  return row;
}

function verifyRunIdentity(meta: MetaRow, runId: string, runEpoch: string): void {
  if (meta.run_id !== runId || meta.run_epoch !== runEpoch) {
    throw new ControlStoreError("RUN_IDENTITY_MISMATCH", "control store belongs to a different run identity", {
      expectedRunId: runId,
      expectedRunEpoch: runEpoch,
      actualRunId: meta.run_id,
      actualRunEpoch: meta.run_epoch
    });
  }
}

function decodeEventRow(row: EventRow): PersistedControlEvent {
  const seq = asSafeInteger(row.seq, "event seq");
  let unknown: unknown;
  try {
    unknown = JSON.parse(row.canonical_json);
  } catch {
    throw recovery(`event ${seq} canonical JSON is malformed`);
  }
  let event: ControlEvent;
  let recordedAt: string;
  try {
    if (!unknown || typeof unknown !== "object" || Array.isArray(unknown)) throw new TypeError("persisted event is not an object");
    const { recordedAt: storedRecordedAt, ...intent } = unknown as Record<string, unknown>;
    recordedAt = canonicalUtc(String(storedRecordedAt), `event ${seq} recordedAt`);
    event = parseControlEvent(intent);
  } catch (error) {
    throw recovery(`event ${seq} violates the v1 schema`, { cause: error instanceof Error ? error.message : String(error) });
  }
  const canonical = canonicalPersistedControlEvent(event, recordedAt);
  const computedIntentDigest = controlEventDigest(event);
  const computedDigest = persistedControlEventDigest(event, recordedAt);
  if (canonical !== row.canonical_json || computedDigest !== row.digest) throw recovery(`event ${seq} canonical digest mismatch`);
  if (computedIntentDigest !== row.intent_digest) throw recovery(`event ${seq} intent digest mismatch`);
  if (canonicalJson(event.payload) !== row.payload_json) throw recovery(`event ${seq} payload projection mismatch`);
  if (
    event.eventId !== row.event_id ||
    event.runId !== row.run_id ||
    event.runEpoch !== row.run_epoch ||
    event.taskId !== row.task_id ||
    event.taskGeneration !== (row.task_generation === null ? null : asSafeInteger(row.task_generation, "task generation")) ||
    event.expectedVersion !== asSafeInteger(row.expected_version, "expected version") ||
    event.occurredAt !== row.occurred_at ||
    recordedAt !== row.recorded_at ||
    event.actorKind !== row.actor_kind ||
    event.actorId !== row.actor_id ||
    event.sourceKind !== row.source_kind ||
    event.sourceId !== row.source_id ||
    event.sourceGeneration !== (row.source_generation === null ? null : asSafeInteger(row.source_generation, "source generation")) ||
    event.sourceEventId !== row.source_event_id ||
    event.type !== row.event_type
  ) {
    throw recovery(`event ${seq} indexed columns disagree with canonical content`);
  }
  return { ...event, seq, recordedAt, intentDigest: row.intent_digest, digest: row.digest };
}

function readAllEvents(db: Database.Database, throughSeq?: number): PersistedControlEvent[] {
  const rows = (throughSeq === undefined
    ? db.prepare("SELECT * FROM control_events ORDER BY seq").all()
    : db.prepare("SELECT * FROM control_events WHERE seq <= ? ORDER BY seq").all(throughSeq)) as EventRow[];
  return rows.map(decodeEventRow);
}

function decodeFact<T>(row: FactRow, label: string): T {
  if (sha256Text(row.fact_json) !== row.digest) throw recovery(`${label} digest mismatch`);
  try {
    const parsed = JSON.parse(row.fact_json) as T;
    if (canonicalJson(parsed) !== row.fact_json) throw recovery(`${label} is not canonical`);
    return parsed;
  } catch (error) {
    if (error instanceof ControlStoreError) throw error;
    throw recovery(`${label} JSON is malformed`);
  }
}

function loadProjection(db: Database.Database, runId: string, runEpoch: string): ControlProjection {
  const meta = readMeta(db);
  verifyRunIdentity(meta, runId, runEpoch);
  const state = emptyControlProjection(runId, runEpoch);
  state.headSeq = meta.head_seq;

  const runRow = db.prepare("SELECT fact_json, digest FROM run_projection WHERE singleton = 1").get() as FactRow | undefined;
  if (runRow) state.run = decodeFact(runRow, "run projection");

  for (const row of db.prepare("SELECT task_id AS key, fact_json, digest FROM task_projection ORDER BY task_id").all() as KeyedFactRow[]) {
    state.tasks[row.key] = decodeFact(row, `task projection ${row.key}`);
  }
  for (const row of db.prepare("SELECT message_id AS key, fact_json, digest FROM message_projection ORDER BY seq").all() as KeyedFactRow[]) {
    state.messages.push(decodeFact(row, `message projection ${row.key}`));
  }
  for (const row of db.prepare("SELECT session_id AS key, fact_json, digest FROM runtime_projection ORDER BY session_id").all() as KeyedFactRow[]) {
    state.runtimes[row.key] = decodeFact(row, `runtime projection ${row.key}`);
  }
  for (const row of db.prepare("SELECT attempt_id AS key, fact_json, digest FROM attempt_projection ORDER BY attempt_id").all() as KeyedFactRow[]) {
    state.attempts[row.key] = decodeFact(row, `attempt projection ${row.key}`);
  }
  for (const row of db.prepare("SELECT command_id AS key, fact_json, digest FROM steering_projection ORDER BY command_id").all() as KeyedFactRow[]) {
    state.steering[row.key] = decodeFact(row, `steering projection ${row.key}`);
  }
  for (const row of db.prepare("SELECT aggregate_key AS key, json_object('kind', aggregate_kind, 'id', aggregate_id, 'generation', generation, 'version', version, 'updatedSeq', updated_seq) AS fact_json, '' AS digest FROM aggregate_versions ORDER BY aggregate_key").all() as KeyedFactRow[]) {
    const parsed = JSON.parse(row.fact_json) as ControlProjection["aggregateVersions"][string];
    if (!Number.isSafeInteger(parsed.generation) || !Number.isSafeInteger(parsed.version) || !Number.isSafeInteger(parsed.updatedSeq)) {
      throw recovery(`aggregate version ${row.key} is invalid`);
    }
    state.aggregateVersions[row.key] = parsed;
  }
  // SCM and normalized observations are intentionally reconstructed from the full retained
  // canonical history. This preserves the v1 physical schema and old stores/snapshots while still
  // making the event log the sole durable authority. One cheap probe avoids two full replays.
  const extensionFacts = db.prepare(`
    SELECT
      MAX(CASE WHEN event_type LIKE 'scm.%' THEN 1 ELSE 0 END) AS has_scm,
      MAX(CASE WHEN event_type LIKE 'observation.%' THEN 1 ELSE 0 END) AS has_observations,
      MAX(CASE WHEN event_type LIKE 'multirepo.%' THEN 1 ELSE 0 END) AS has_multirepo
    FROM control_events
  `).get() as { has_scm: number | null; has_observations: number | null; has_multirepo: number | null };
  if (extensionFacts.has_scm === 1 || extensionFacts.has_observations === 1 || extensionFacts.has_multirepo === 1) {
    const replayed = reduceControlEvents(runId, runEpoch, readAllEvents(db, meta.head_seq));
    if (extensionFacts.has_scm === 1) state.scm = replayed.scm;
    if (extensionFacts.has_observations === 1) state.observability = replayed.observability;
    if (extensionFacts.has_multirepo === 1) state.multirepo = replayed.multirepo;
  }
  // A projection with no observation facts is still an exact-head read model, not a stale one.
  if (extensionFacts.has_observations !== 1) {
    state.observability.room = Object.freeze({ ...state.observability.room, headSeq: meta.head_seq });
  }
  return state;
}

function insertFact(db: Database.Database, table: string, columns: readonly string[], values: readonly unknown[], fact: unknown): void {
  const factJson = canonicalJson(fact);
  const placeholders = Array(columns.length + 2).fill("?").join(", ");
  db.prepare(`INSERT INTO ${table}(${[...columns, "fact_json", "digest"].join(", ")}) VALUES (${placeholders})`).run(
    ...values,
    factJson,
    sha256Text(factJson)
  );
}

function replaceProjection(db: Database.Database, state: ControlProjection): void {
  db.exec("DELETE FROM run_projection; DELETE FROM task_projection; DELETE FROM message_projection; DELETE FROM runtime_projection; DELETE FROM attempt_projection; DELETE FROM steering_projection; DELETE FROM aggregate_versions;");
  if (state.run) {
    insertFact(db, "run_projection", ["singleton", "status", "version", "updated_seq"], [1, state.run.status, state.run.version, state.run.updatedSeq], state.run);
  }
  for (const task of Object.values(state.tasks)) {
    insertFact(db, "task_projection", ["task_id", "generation", "version", "updated_seq"], [task.id, task.generation, task.version, task.updatedSeq], task);
  }
  for (const message of [...state.messages].sort((a, b) => a.seq - b.seq)) {
    insertFact(db, "message_projection", ["message_id", "seq"], [message.messageId, message.seq], message);
  }
  for (const runtime of Object.values(state.runtimes)) {
    insertFact(db, "runtime_projection", ["session_id", "generation", "updated_seq"], [runtime.sessionId, runtime.sessionGeneration, runtime.updatedSeq], runtime);
  }
  for (const attempt of Object.values(state.attempts)) {
    insertFact(
      db,
      "attempt_projection",
      ["attempt_id", "task_id", "task_generation", "attempt_generation"],
      [attempt.attemptId, attempt.taskId, attempt.taskGeneration, attempt.attemptGeneration],
      attempt
    );
  }
  for (const command of Object.values(state.steering)) {
    insertFact(
      db,
      "steering_projection",
      ["command_id", "session_id", "session_generation", "status"],
      [command.commandId, command.sessionId, command.sessionGeneration, command.status],
      command
    );
  }
  const statement = db.prepare(`
    INSERT INTO aggregate_versions(aggregate_key, aggregate_kind, aggregate_id, generation, version, updated_seq)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const [key, aggregate] of Object.entries(state.aggregateVersions)) {
    statement.run(key, aggregate.kind, aggregate.id, aggregate.generation, aggregate.version, aggregate.updatedSeq);
  }
}

function upsertFact(
  db: Database.Database,
  table: string,
  columns: readonly string[],
  values: readonly unknown[],
  fact: unknown,
  conflictColumns: readonly string[]
): void {
  const factJson = canonicalJson(fact);
  const allColumns = [...columns, "fact_json", "digest"];
  const updates = allColumns
    .filter((column) => !conflictColumns.includes(column))
    .map((column) => `${column}=excluded.${column}`)
    .join(", ");
  db.prepare(`
    INSERT INTO ${table}(${allColumns.join(", ")})
    VALUES (${allColumns.map(() => "?").join(", ")})
    ON CONFLICT(${conflictColumns.join(", ")}) DO UPDATE SET ${updates}
  `).run(...values, factJson, sha256Text(factJson));
}

/** Persist only the facts changed by one reducer step. Full replacement is recovery-only. */
function persistProjectionDelta(db: Database.Database, state: ControlProjection, event: PersistedControlEvent): void {
  if (event.type.startsWith("run.")) {
    if (!state.run) throw recovery("run event produced no run projection");
    upsertFact(
      db,
      "run_projection",
      ["singleton", "status", "version", "updated_seq"],
      [1, state.run.status, state.run.version, state.run.updatedSeq],
      state.run,
      ["singleton"]
    );
  } else if (event.type === "task.created" || event.type === "task.status_changed" || event.type === "task.reopened") {
    const task = state.tasks[event.taskId!];
    if (!task) throw recovery(`task event produced no projection for ${event.taskId}`);
    upsertFact(
      db,
      "task_projection",
      ["task_id", "generation", "version", "updated_seq"],
      [task.id, task.generation, task.version, task.updatedSeq],
      task,
      ["task_id"]
    );
  } else if (event.type === "message.posted") {
    const message = state.messages.find((candidate) => candidate.seq === event.seq);
    if (!message) throw recovery(`message event ${event.eventId} produced no projection`);
    insertFact(db, "message_projection", ["message_id", "seq"], [message.messageId, message.seq], message);
  } else if (event.type === "runtime.observed") {
    const runtime = state.runtimes[event.payload.sessionId];
    if (!runtime) throw recovery(`runtime event produced no projection for ${event.payload.sessionId}`);
    upsertFact(
      db,
      "runtime_projection",
      ["session_id", "generation", "updated_seq"],
      [runtime.sessionId, runtime.sessionGeneration, runtime.updatedSeq],
      runtime,
      ["session_id"]
    );
  } else if (
    event.type === "attempt.prompt_prepared" ||
    event.type === "attempt.launch_planned" ||
    event.type === "attempt.started" ||
    event.type === "attempt.exited" ||
    event.type === "attempt.abandoned"
  ) {
    const attempt = state.attempts[event.payload.attemptId];
    if (!attempt) throw recovery(`attempt event produced no projection for ${event.payload.attemptId}`);
    upsertFact(
      db,
      "attempt_projection",
      ["attempt_id", "task_id", "task_generation", "attempt_generation"],
      [attempt.attemptId, attempt.taskId, attempt.taskGeneration, attempt.attemptGeneration],
      attempt,
      ["attempt_id"]
    );
  } else if (
    event.type === "steering.command_admitted" ||
    event.type === "steering.command_refused" ||
    event.type === "steering.command_terminal_refused" ||
    event.type === "steering.command_included" ||
    event.type === "steering.command_withdrawn" ||
    event.type === "steering.command_superseded" ||
    event.type === "steering.command_expired"
  ) {
    const command = state.steering[event.payload.commandId];
    if (!command) throw recovery(`steering event produced no projection for ${event.payload.commandId}`);
    upsertFact(
      db,
      "steering_projection",
      ["command_id", "session_id", "session_generation", "status"],
      [command.commandId, command.sessionId, command.sessionGeneration, command.status],
      command,
      ["command_id"]
    );
  }

  const keys = [aggregateForEvent(event).key];
  if (event.type === "task.reopened") keys.push(`task:${event.taskId}:${event.payload.newGeneration}`);
  const statement = db.prepare(`
    INSERT INTO aggregate_versions(aggregate_key, aggregate_kind, aggregate_id, generation, version, updated_seq)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(aggregate_key) DO UPDATE SET
      aggregate_kind=excluded.aggregate_kind,
      aggregate_id=excluded.aggregate_id,
      generation=excluded.generation,
      version=excluded.version,
      updated_seq=excluded.updated_seq
  `);
  for (const key of keys) {
    const aggregate = state.aggregateVersions[key];
    if (!aggregate) throw recovery(`event produced no aggregate projection for ${key}`);
    statement.run(key, aggregate.kind, aggregate.id, aggregate.generation, aggregate.version, aggregate.updatedSeq);
  }
}

function replayAuthority(db: Database.Database, runId: string, runEpoch: string): ControlProjection {
  return reduceControlEvents(runId, runEpoch, readAllEvents(db));
}

function projectionsEqual(a: ControlProjection, b: ControlProjection): boolean {
  return canonicalJson(canonicalProjectionValue(a)) === canonicalJson(canonicalProjectionValue(b));
}

function verifyOrRebuildProjection(db: Database.Database, runId: string, runEpoch: string, mode: "verify" | "rebuild"): void {
  let replayed: ControlProjection;
  let stored: ControlProjection;
  try {
    const capture = db.transaction(() => ({
      replayed: replayAuthority(db, runId, runEpoch),
      stored: loadProjection(db, runId, runEpoch)
    }));
    ({ replayed, stored } = capture.deferred());
  } catch (error) {
    if (mode !== "rebuild") throw error;
    const captureAuthority = db.transaction(() => replayAuthority(db, runId, runEpoch));
    replayed = captureAuthority.deferred();
    stored = emptyControlProjection(runId, runEpoch);
    stored.headSeq = -1;
  }
  if (projectionsEqual(replayed, stored)) return;
  if (mode !== "rebuild") throw recovery("materialized control projection disagrees with canonical history");
  const transaction = db.transaction(() => {
    const currentHead = asSafeInteger((db.prepare("SELECT COALESCE(MAX(seq), 0) AS head FROM control_events").get() as { head: number | bigint }).head, "event head");
    if (currentHead !== replayed.headSeq) throw recovery("canonical history changed during projection rebuild");
    replaceProjection(db, replayed);
    db.prepare("UPDATE control_meta SET head_seq = ? WHERE singleton = 1").run(replayed.headSeq);
  });
  transaction.immediate();
}

function validateScmBatch(events: readonly ControlEvent[]): void {
  const completions = events.filter((event) => event.type === "scm.poll_completed");
  const failures = events.filter((event) => event.type === "scm.poll_failed");
  const buckets = events.filter((event) => event.type === "scm.bucket_accepted");
  for (const started of events.filter((event) => event.type === "scm.poll_started")) {
    if ([...completions, ...failures].some((terminal) => terminal.payload.pollId === started.payload.pollId)) {
      throw new ControlStoreError("INVALID_EVENT", `SCM poll ${started.payload.pollId} cannot start and terminate in one transaction`);
    }
  }
  for (const completed of completions) {
    const matchingCompletions = completions.filter((candidate) => candidate.payload.pollId === completed.payload.pollId);
    if (matchingCompletions.length !== 1) {
      throw new ControlStoreError("INVALID_EVENT", `SCM poll ${completed.payload.pollId} has duplicate completion facts`);
    }
    for (const outcome of completed.payload.bucketOutcomes) {
      const matching = buckets.filter((bucket) =>
        bucket.payload.pollId === completed.payload.pollId &&
        bucket.payload.publicationId === completed.payload.publicationId &&
        bucket.payload.publicationGeneration === completed.payload.publicationGeneration &&
        bucket.payload.kind === outcome.kind
      );
      if (outcome.decision.startsWith("accept_")) {
        if (matching.length !== 1 || matching[0]!.payload.decision !== outcome.decision ||
            matching[0]!.payload.bucket.meta.semanticHash !== outcome.semanticHash) {
          throw new ControlStoreError("INVALID_EVENT", `SCM poll ${completed.payload.pollId} accepted ${outcome.kind} without one atomic matching bucket`);
        }
      } else if (matching.length !== 0) {
        throw new ControlStoreError("INVALID_EVENT", `SCM poll ${completed.payload.pollId} persisted ${outcome.kind} despite a ${outcome.decision} outcome`);
      }
    }
  }
  for (const bucket of buckets) {
    const matching = completions.filter((completed) =>
      completed.payload.pollId === bucket.payload.pollId &&
      completed.payload.publicationId === bucket.payload.publicationId &&
      completed.payload.publicationGeneration === bucket.payload.publicationGeneration
    );
    if (matching.length !== 1) {
      throw new ControlStoreError("INVALID_EVENT", `SCM bucket ${bucket.payload.kind} requires one atomic poll completion`);
    }
  }
  for (const failure of failures) {
    if (buckets.some((bucket) => bucket.payload.pollId === failure.payload.pollId)) {
      throw new ControlStoreError("INVALID_EVENT", `failed SCM poll ${failure.payload.pollId} cannot accept buckets`);
    }
  }
  for (const reaction of events.filter((event) => event.type === "scm.reaction_created")) {
    const matching = completions.filter((completed) =>
      completed.payload.publicationId === reaction.payload.publicationId &&
      completed.payload.publicationGeneration === reaction.payload.publicationGeneration &&
      completed.payload.expectedHeadSha === reaction.payload.headSha &&
      completed.taskId === reaction.taskId && completed.taskGeneration === reaction.taskGeneration &&
      completed.payload.bucketOutcomes.some((outcome) => outcome.kind === reaction.payload.factKind && outcome.decision.startsWith("accept_"))
    );
    if (matching.length !== 1) {
      throw new ControlStoreError("INVALID_EVENT", `SCM reaction ${reaction.payload.reactionKey} requires one atomic accepted observation`);
    }
  }
}

function validateObservationBatch(events: readonly ControlEvent[]): void {
  const checkpoints = events.filter((event) => event.type === "observation.source_checkpointed");
  const records = events.filter((event) => event.type === "observation.recorded");
  const consumed = new Set<ControlEvent>();
  for (const checkpoint of checkpoints) {
    const checkpointIndex = events.indexOf(checkpoint);
    const key = aggregateForEvent(checkpoint).key;
    if (checkpoints.filter((candidate) => aggregateForEvent(candidate).key === key).length !== 1) {
      throw new ControlStoreError("INVALID_EVENT", `observation source transaction ${key} has duplicate checkpoints`);
    }
    const matching = records.filter((record) =>
      aggregateForEvent(record).key === key &&
      record.taskId === checkpoint.taskId && record.taskGeneration === checkpoint.taskGeneration &&
      record.actorKind === checkpoint.actorKind && record.actorId === checkpoint.actorId &&
      record.sourceKind === checkpoint.sourceKind && record.sourceId === checkpoint.sourceId &&
      record.sourceGeneration === checkpoint.sourceGeneration
    );
    if (matching.some((record) => events.indexOf(record) <= checkpointIndex)) {
      throw new ControlStoreError("INVALID_EVENT", `observation source transaction ${key} records must follow its checkpoint`);
    }
    const recordIds = matching.map((record) => record.payload.record.recordId);
    if (
      checkpoint.payload.observationCount !== matching.length ||
      canonicalJson(checkpoint.payload.observationRecordIds) !== canonicalJson(recordIds)
    ) {
      throw new ControlStoreError("INVALID_EVENT", `observation source transaction ${key} does not bind its exact ordered records`);
    }
    const semanticDigest = observationCommitSemanticDigest({
      previousStateDigest: checkpoint.payload.previousStateDigest,
      nextState: checkpoint.payload.nextState,
      nextStateDigest: checkpoint.payload.nextStateDigest,
      observations: matching.map((record) => record.payload.record)
    });
    if (semanticDigest !== checkpoint.payload.requestSemanticDigest) {
      throw new ControlStoreError("INVALID_EVENT", `observation source transaction ${key} semantic digest mismatch`);
    }
    for (const record of matching) consumed.add(record);
  }
  if (consumed.size !== records.length) {
    throw new ControlStoreError("INVALID_EVENT", "every normalized observation requires one matching checkpoint in the same atomic batch");
  }
  if (checkpoints.length > 0 && records.length > checkpoints.length * TRANSCRIPT_INGESTOR_LIMITS.maximumRecordsPerPoll) {
    throw new ControlStoreError("INVALID_EVENT", "observation transaction exceeds the closed per-source record bound");
  }
}

function validateFences(state: ControlProjection, event: ControlEvent): void {
  if (event.type === "task.created") {
    const existing = state.tasks[event.taskId!];
    if (existing) {
      throw new ControlStoreError("STALE_GENERATION", `task ${event.taskId} already exists`, {
        suppliedGeneration: event.taskGeneration,
        currentGeneration: existing.generation
      });
    }
    if (event.taskGeneration !== 1) throw new ControlStoreError("STALE_GENERATION", "new task generation must be 1");
  } else if (
    event.taskId !== null &&
    // P6 has its own immutable DAG task namespace and reducer-owned generation fences. Its facts
    // deliberately use the dedicated multirepo aggregate, so they must not depend on a legacy/core
    // task.created projection merely because the outer event repeats the exact P6 task scope.
    !event.type.startsWith("multirepo.") &&
    event.type !== "steering.command_refused" &&
    event.type !== "steering.command_terminal_refused"
  ) {
    const task = state.tasks[event.taskId];
    if (!task || task.generation !== event.taskGeneration) {
      throw new ControlStoreError("STALE_GENERATION", `task ${event.taskId} generation is stale`, {
        suppliedGeneration: event.taskGeneration,
        currentGeneration: task?.generation
      });
    }
  }

  let sessionTarget: { sessionId: string; sessionGeneration: number; requireExisting: boolean } | undefined;
  switch (event.type) {
    case "runtime.observed":
      sessionTarget = { sessionId: event.payload.sessionId, sessionGeneration: event.payload.sessionGeneration, requireExisting: false };
      break;
    case "steering.command_admitted":
    case "steering.command_included":
    case "steering.command_withdrawn":
    case "steering.command_superseded":
    case "steering.command_expired":
      sessionTarget = { sessionId: event.payload.sessionId, sessionGeneration: event.payload.sessionGeneration, requireExisting: true };
      break;
    case "scm.poll_started":
    case "scm.reaction_created":
      sessionTarget = { sessionId: event.payload.sessionId, sessionGeneration: event.payload.sessionGeneration, requireExisting: true };
      break;
    case "observation.source_checkpointed":
      sessionTarget = {
        sessionId: event.payload.nextState.generation.agentId,
        sessionGeneration: event.payload.nextState.generation.runtimeGeneration,
        requireExisting: true
      };
      break;
    case "observation.recorded":
      sessionTarget = {
        sessionId: event.payload.record.generation.agentId,
        sessionGeneration: event.payload.record.generation.runtimeGeneration,
        requireExisting: true
      };
      break;
  }
  if (sessionTarget) {
    const current = state.runtimes[sessionTarget.sessionId];
    if (current && sessionTarget.sessionGeneration < current.sessionGeneration) {
      throw new ControlStoreError("STALE_GENERATION", `session ${sessionTarget.sessionId} generation is stale`, {
        suppliedGeneration: sessionTarget.sessionGeneration,
        currentGeneration: current.sessionGeneration
      });
    }
    if (sessionTarget.requireExisting && (!current || current.sessionGeneration !== sessionTarget.sessionGeneration)) {
      throw new ControlStoreError("STALE_GENERATION", `session ${sessionTarget.sessionId} generation does not exist`, {
        suppliedGeneration: sessionTarget.sessionGeneration,
        currentGeneration: current?.sessionGeneration
      });
    }
  }

  const aggregate = aggregateForEvent(event);
  const currentVersion = state.aggregateVersions[aggregate.key]?.version ?? 0;
  if (event.expectedVersion !== currentVersion) {
    throw new ControlStoreError("STALE_VERSION", `aggregate ${aggregate.key} expected version ${event.expectedVersion}, current ${currentVersion}`, {
      aggregateKey: aggregate.key,
      expectedVersion: event.expectedVersion,
      currentVersion
    });
  }
}

function validateExistingEvent(row: EventRow, event: ControlEvent, canonical: string, digest: string): AppendResult {
  const persisted = decodeEventRow(row);
  const { seq: _seq, recordedAt: _recordedAt, intentDigest: _intentDigest, digest: _digest, ...originalIntent } = persisted;
  if (row.intent_digest !== digest || canonicalControlEvent(originalIntent) !== canonical) {
    throw new ControlStoreError("EVENT_ID_CONFLICT", `eventId ${event.eventId} was reused with divergent content`, {
      eventId: event.eventId,
      originalSeq: persisted.seq,
      originalDigest: persisted.intentDigest,
      suppliedDigest: digest
    });
  }
  return {
    eventId: event.eventId,
    seq: persisted.seq,
    digest: persisted.digest,
    intentDigest: persisted.intentDigest,
    recordedAt: persisted.recordedAt,
    idempotent: true,
    aggregateVersion: event.expectedVersion + 1
  };
}

function decodeConsumerCursor(row: ConsumerCursorRow): ConsumerCursor {
  return {
    consumerId: row.consumer_id,
    generation: asSafeInteger(row.generation, "consumer generation"),
    lastSeq: asSafeInteger(row.last_seq, "consumer last sequence"),
    updatedAt: canonicalUtc(row.updated_at, "consumer cursor updatedAt")
  };
}

function parseSnapshotProjection(row: SnapshotRow, storeId: string, runId: string, runEpoch: string): ControlProjection {
  const seq = asSafeInteger(row.seq, "snapshot seq");
  if (
    row.store_id !== storeId ||
    row.schema_version !== CONTROL_EVENT_SCHEMA_VERSION ||
    row.reducer_version !== CONTROL_REDUCER_VERSION ||
    row.run_id !== runId ||
    row.run_epoch !== runEpoch
  ) {
    throw recovery(`snapshot ${seq} identity/version mismatch`);
  }
  if (sha256Text(row.payload_json) !== row.digest) throw recovery(`snapshot ${seq} digest mismatch`);
  canonicalUtc(row.created_at, `snapshot ${seq} createdAt`);
  canonicalUtc(row.verified_at, `snapshot ${seq} verifiedAt`);
  let parsed: ControlProjection;
  try {
    const decoded = JSON.parse(row.payload_json) as ControlProjection & {
      scm?: ControlProjection["scm"];
      observability?: ControlProjection["observability"];
      multirepo?: ControlProjection["multirepo"];
    };
    if (decoded.scm !== undefined) {
      const scm = decoded.scm as unknown;
      if (!scm || typeof scm !== "object" || Array.isArray(scm)) throw new TypeError("snapshot SCM projection is not an object");
      const record = scm as Record<string, unknown>;
      if (record.schemaVersion !== 1 || ["publications", "polls", "observations", "reactions"].some((key) =>
        !record[key] || typeof record[key] !== "object" || Array.isArray(record[key]))) {
        throw new TypeError("snapshot SCM projection has the wrong closed shape");
      }
    }
    let observability = decoded.observability;
    if (observability === undefined) {
      observability = emptyObservabilityControlProjection(runId, runEpoch);
      observability.room = Object.freeze({ ...observability.room, headSeq: decoded.headSeq });
    } else {
      if (observability.schemaVersion !== 1 || !observability.sources || typeof observability.sources !== "object" || Array.isArray(observability.sources)) {
        throw new TypeError("snapshot observability projection has the wrong closed shape");
      }
      assertControlRoomProjectionConsistent(observability.room);
      if (observability.room.runId !== runId || observability.room.runEpoch !== runEpoch || observability.room.headSeq !== decoded.headSeq) {
        throw new TypeError("snapshot control-room projection has the wrong identity or head");
      }
      for (const [key, source] of Object.entries(observability.sources)) {
        const state = TranscriptIngestorStateV1Schema.parse(source.state);
        if (
          key !== observationSourceProjectionKey(state.generation) ||
          source.sourceId !== state.sourceId ||
          typeof source.sourceKind !== "string" || source.sourceKind.length < 1 ||
          transcriptIngestorStateDigest(state) !== source.stateDigest ||
          !/^[a-f0-9]{64}$/u.test(source.requestSemanticDigest) ||
          !Array.isArray(source.observationRecordIds) ||
          source.observationRecordIds.length !== source.observationCount ||
          new Set(source.observationRecordIds).size !== source.observationRecordIds.length ||
          !Number.isSafeInteger(source.observationCount) || source.observationCount < 0 ||
          source.observationCount > TRANSCRIPT_INGESTOR_LIMITS.maximumRecordsPerPoll ||
          !Number.isSafeInteger(source.updatedSeq) || source.updatedSeq < 1 || source.updatedSeq > decoded.headSeq
        ) throw new TypeError(`snapshot observation source ${key} is invalid`);
      }
    }
    let multirepo = decoded.multirepo;
    if (multirepo === undefined) {
      multirepo = emptyMultiRepositoryControlProjection();
    } else {
      if (
        multirepo.schemaVersion !== 1 || !Number.isSafeInteger(multirepo.headVersion) ||
        multirepo.headVersion < 0 || !Array.isArray(multirepo.facts) ||
        multirepo.headVersion !== multirepo.facts.length
      ) throw new TypeError("snapshot multi-repository projection has the wrong closed shape");
      const replayedMultiRepository = projectMultiRepositoryCanonicalFacts(multirepo.facts);
      if (canonicalJson(replayedMultiRepository) !== canonicalJson(multirepo.state)) {
        throw new TypeError("snapshot multi-repository state disagrees with its canonical facts");
      }
    }
    parsed = {
      ...decoded,
      scm: decoded.scm ?? emptyScmControlProjection(),
      observability,
      multirepo
    };
  } catch {
    throw recovery(`snapshot ${seq} JSON is malformed`);
  }
  if (canonicalJson(canonicalProjectionValue(parsed)) !== row.payload_json || parsed.headSeq !== seq) {
    throw recovery(`snapshot ${seq} payload is not canonical or has the wrong head`);
  }
  return parsed;
}

export class ControlStore {
  readonly path: string;
  readonly runId: string;
  readonly runEpoch: string;
  readonly storeId: string;
  private readonly db: Database.Database;
  private readonly now: () => string;
  private readonly scheduleWake: (callback: () => void) => void;
  private readonly fault?: (point: ControlStoreFaultPoint, event?: ControlEvent) => void;
  private readonly subscribers = new Set<StoreSubscriber>();
  private wakeScheduled = false;
  private pendingWakeHead = 0;
  private closed = false;
  private readonly fileDev: number;
  private readonly fileIno: number;

  private constructor(db: Database.Database, options: OpenControlStoreOptions, absolutePath: string, fileDev: number, fileIno: number, storeId: string) {
    this.db = db;
    this.path = absolutePath;
    this.runId = options.runId;
    this.runEpoch = options.runEpoch;
    this.storeId = storeId;
    this.now = options.now ?? (() => new Date().toISOString());
    this.scheduleWake = options.scheduleWake ?? queueMicrotask;
    this.fault = options.fault;
    this.fileDev = fileDev;
    this.fileIno = fileIno;
  }

  static open(options: OpenControlStoreOptions): ControlStore {
    if (!options.runId || !options.runEpoch) throw new ControlStoreError("INVALID_EVENT", "runId and runEpoch are required");
    const path = validateStorePath(options.path, options.create ?? true);
    let db: Database.Database | undefined;
    try {
      db = new Database(path.absolute);
      db.pragma("foreign_keys = ON");
      db.pragma("busy_timeout = 5000");
      if (path.created) {
        bootstrap(db, options.runId, options.runEpoch, (options.now ?? (() => new Date().toISOString()))());
      } else if (databasePragmaNumber(db, "application_id") !== APPLICATION_ID) {
        throw recovery("file is not a RelayForge control store");
      }
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = FULL");
      verifyPhysicalSchema(db, options.integrityCheck ?? "quick");
      const meta = readMeta(db);
      verifyRunIdentity(meta, options.runId, options.runEpoch);
      if (meta.retained_floor !== 1) throw recovery("P1 control store must retain the full event history");
      assertUnchangedFile(path.absolute, path.dev, path.ino);
      verifyOrRebuildProjection(db, options.runId, options.runEpoch, options.recoveryMode ?? "verify");
      return new ControlStore(db, options, path.absolute, path.dev, path.ino, meta.store_id);
    } catch (error) {
      try {
        db?.close();
      } catch {
        // The original validation/recovery error is authoritative.
      }
      normalizeStoreError(error);
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new ControlStoreError("STORE_CLOSED", "control store is closed");
    assertUnchangedFile(this.path, this.fileDev, this.fileIno);
  }

  private notifyAfterCommit(headSeq: number): void {
    this.pendingWakeHead = Math.max(this.pendingWakeHead, headSeq);
    if (this.wakeScheduled) return;
    this.wakeScheduled = true;
    try {
      this.scheduleWake(() => {
        this.wakeScheduled = false;
        const wake = { runEpoch: this.runEpoch, headSeq: this.pendingWakeHead };
        this.pendingWakeHead = 0;
        for (const subscriber of [...this.subscribers]) {
          try {
            subscriber(wake);
          } catch {
            // Subscribers are lossy wakeups. Durable consumers always reread by sequence.
          }
        }
      });
    } catch {
      // Wake scheduling happens strictly after commit and can never turn a durable success into an
      // apparent failed append. Consumers poll/replay canonical sequence after any lost wake.
      this.wakeScheduled = false;
      this.pendingWakeHead = 0;
    }
  }

  subscribe(subscriber: StoreSubscriber): () => void {
    this.assertOpen();
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  append(value: unknown): AppendResult {
    return this.appendBatch([value])[0]!;
  }

  private parseEvents(values: readonly unknown[]): ControlEvent[] {
    let events: ControlEvent[];
    try {
      events = values.map(parseControlEvent);
    } catch (error) {
      throw new ControlStoreError("INVALID_EVENT", "control event violates the closed v1 schema", {
        cause: error instanceof Error ? error.message : String(error)
      });
    }
    for (const event of events) {
      try {
        assertControlEventScope(event);
      } catch (error) {
        throw new ControlStoreError("INVALID_EVENT", error instanceof Error ? error.message : String(error));
      }
      if (event.runId !== this.runId || event.runEpoch !== this.runEpoch) {
        throw new ControlStoreError("RUN_IDENTITY_MISMATCH", "event belongs to a different run identity");
      }
    }
    validateScmBatch(events);
    validateObservationBatch(events);
    return events;
  }

  private commitParsed(
    events: readonly ControlEvent[],
    cursorAdvance?: ConsumerCursorAdvance,
    expectedHeadSeq?: number
  ): { events: AppendResult[]; cursor?: ConsumerCursor } {
    try {
      const transaction = this.db.transaction((
        batch: readonly ControlEvent[],
        advance?: ConsumerCursorAdvance,
        expectedHead?: number
      ) => {
        let projection = loadProjection(this.db, this.runId, this.runEpoch);
        const headBefore = projection.headSeq;

        if (expectedHead !== undefined && headBefore !== expectedHead) {
          // Preserve exact event-ID retry semantics after an earlier successful CAS. A stale caller
          // may observe its entire batch already committed and receive canonical idempotent receipts,
          // but it may never use a partly-existing batch to append new work at an unobserved head.
          const existingResults: AppendResult[] = [];
          let allExisting = batch.length > 0;
          for (const event of batch) {
            const canonicalIntent = canonicalControlEvent(event);
            const intentDigest = controlEventDigest(event);
            const existing = this.db.prepare("SELECT * FROM control_events WHERE event_id = ?").get(event.eventId) as EventRow | undefined;
            if (!existing) {
              allExisting = false;
              continue;
            }
            existingResults.push(validateExistingEvent(existing, event, canonicalIntent, intentDigest));
          }
          if (allExisting) {
            return { results: existingResults, headSeq: headBefore, inserted: false, cursor: undefined };
          }
          throw new ControlStoreError(
            "STALE_VERSION",
            `control store expected head ${expectedHead}, current ${headBefore}`,
            { expectedHeadSeq: expectedHead, currentHeadSeq: headBefore }
          );
        }
        const results: AppendResult[] = [];
        let inserted = false;
        for (const event of batch) {
          const canonicalIntent = canonicalControlEvent(event);
          const intentDigest = controlEventDigest(event);
          const existing = this.db.prepare("SELECT * FROM control_events WHERE event_id = ?").get(event.eventId) as EventRow | undefined;
          if (existing) {
            results.push(validateExistingEvent(existing, event, canonicalIntent, intentDigest));
            continue;
          }
          if (event.sourceKind !== null) {
            const sourceExisting = this.db.prepare(`
              SELECT * FROM control_events
              WHERE source_kind = ? AND source_id = ? AND source_generation = ? AND source_event_id = ?
            `).get(event.sourceKind, event.sourceId, event.sourceGeneration, event.sourceEventId) as EventRow | undefined;
            if (sourceExisting) {
              const persisted = decodeEventRow(sourceExisting);
              throw new ControlStoreError("EVENT_ID_CONFLICT", "external source identity was reused by a different event", {
                eventId: event.eventId,
                originalEventId: persisted.eventId,
                originalSeq: persisted.seq,
                sourceKind: event.sourceKind,
                sourceId: event.sourceId,
                sourceGeneration: event.sourceGeneration,
                sourceEventId: event.sourceEventId
              });
            }
          }
          validateFences(projection, event);
          const recordedAt = canonicalUtc(this.now(), `event ${event.eventId} recordedAt`);
          const canonical = canonicalPersistedControlEvent(event, recordedAt);
          const digest = persistedControlEventDigest(event, recordedAt);
          this.fault?.("before-event-insert", event);
          const info = this.db.prepare(`
            INSERT INTO control_events(
              event_id, run_id, run_epoch, task_id, task_generation, expected_version,
              occurred_at, recorded_at, actor_kind, actor_id,
              source_kind, source_id, source_generation, source_event_id,
              event_type, payload_json, canonical_json, intent_digest, digest
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            event.eventId,
            event.runId,
            event.runEpoch,
            event.taskId,
            event.taskGeneration,
            event.expectedVersion,
            event.occurredAt,
            recordedAt,
            event.actorKind,
            event.actorId,
            event.sourceKind,
            event.sourceId,
            event.sourceGeneration,
            event.sourceEventId,
            event.type,
            canonicalJson(event.payload),
            canonical,
            intentDigest,
            digest
          );
          const seq = asSafeInteger(info.lastInsertRowid, "inserted event seq");
          this.fault?.("after-event-insert", event);
          const persisted: PersistedControlEvent = { ...event, seq, recordedAt, intentDigest, digest };
          projection = applyControlEvent(projection, persisted);
          this.fault?.("before-projection-write", event);
          persistProjectionDelta(this.db, projection, persisted);
          this.fault?.("after-projection-write", event);
          const aggregate = aggregateForEvent(event);
          results.push({
            eventId: event.eventId,
            seq,
            digest,
            intentDigest,
            recordedAt,
            idempotent: false,
            aggregateVersion: projection.aggregateVersions[aggregate.key]!.version
          });
          inserted = true;
        }
        if (inserted) {
          this.db.prepare("UPDATE control_meta SET head_seq = ? WHERE singleton = 1").run(projection.headSeq);
        }

        let cursor: ConsumerCursor | undefined;
        if (advance) {
          if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(advance.consumerId) ||
              !Number.isSafeInteger(advance.generation) || advance.generation < 1 ||
              !Number.isSafeInteger(advance.expectedLastSeq) || advance.expectedLastSeq < 0 ||
              !Number.isSafeInteger(advance.nextLastSeq) || advance.nextLastSeq < advance.expectedLastSeq) {
            throw new ControlStoreError("INVALID_EVENT", "consumer cursor advance is invalid");
          }
          if (advance.nextLastSeq > headBefore) {
            throw new ControlStoreError("STALE_VERSION", "consumer cursor cannot advance beyond the transaction's captured input head", {
              nextLastSeq: advance.nextLastSeq,
              capturedHeadSeq: headBefore
            });
          }
          const existing = this.db.prepare("SELECT * FROM consumer_cursors WHERE consumer_id = ?").get(advance.consumerId) as ConsumerCursorRow | undefined;
          if (!existing) {
            if (advance.generation !== 1) {
              throw new ControlStoreError("STALE_GENERATION", "new consumer cursor generation must be 1", { currentGeneration: 0 });
            }
            if (advance.expectedLastSeq !== 0) {
              throw new ControlStoreError("STALE_VERSION", "new consumer cursor must expect sequence 0", { currentLastSeq: 0 });
            }
          } else {
            const current = decodeConsumerCursor(existing);
            if (current.generation !== advance.generation) {
              throw new ControlStoreError("STALE_GENERATION", "consumer cursor generation is stale", {
                suppliedGeneration: advance.generation,
                currentGeneration: current.generation
              });
            }
            if (current.lastSeq !== advance.expectedLastSeq) {
              throw new ControlStoreError("STALE_VERSION", "consumer cursor expected sequence is stale", {
                expectedLastSeq: advance.expectedLastSeq,
                currentLastSeq: current.lastSeq
              });
            }
          }
          const updatedAt = canonicalUtc(this.now(), `consumer ${advance.consumerId} updatedAt`);
          this.fault?.("before-cursor-write", batch.at(-1));
          this.db.prepare(`
            INSERT INTO consumer_cursors(consumer_id, generation, last_seq, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(consumer_id) DO UPDATE SET
              generation=excluded.generation,
              last_seq=excluded.last_seq,
              updated_at=excluded.updated_at
          `).run(advance.consumerId, advance.generation, advance.nextLastSeq, updatedAt);
          this.fault?.("after-cursor-write", batch.at(-1));
          cursor = { consumerId: advance.consumerId, generation: advance.generation, lastSeq: advance.nextLastSeq, updatedAt };
        }
        this.fault?.("before-commit", batch.at(-1));
        return { results, headSeq: projection.headSeq, inserted, cursor };
      });
      const committed = transaction.immediate(events, cursorAdvance, expectedHeadSeq);
      if (committed.inserted) this.notifyAfterCommit(committed.headSeq);
      if (cursorAdvance && !committed.cursor) throw recovery("consumer cursor transaction returned no cursor");
      return { events: committed.results, ...(committed.cursor ? { cursor: committed.cursor } : {}) };
    } catch (error) {
      normalizeStoreError(error);
    }
  }

  appendBatch(values: readonly unknown[]): AppendResult[] {
    this.assertOpen();
    if (values.length === 0) return [];
    return this.commitParsed(this.parseEvents(values)).events;
  }

  appendBatchIf(options: AppendBatchIfOptions): AppendResult[] {
    this.assertOpen();
    if (!Number.isSafeInteger(options.expectedHeadSeq) || options.expectedHeadSeq < 0) {
      throw new ControlStoreError("INVALID_EVENT", "expected control-store head must be a non-negative safe integer");
    }
    return this.commitParsed(this.parseEvents(options.events), undefined, options.expectedHeadSeq).events;
  }

  appendBatchWithCursor(values: readonly unknown[], advance: ConsumerCursorAdvance): AppendWithCursorResult {
    this.assertOpen();
    const committed = this.commitParsed(this.parseEvents(values), advance);
    if (!committed.cursor) throw recovery("consumer cursor transaction returned no cursor");
    return { events: committed.events, cursor: committed.cursor };
  }

  advanceConsumerCursor(advance: ConsumerCursorAdvance): ConsumerCursor {
    return this.appendBatchWithCursor([], advance).cursor;
  }

  readConsumerCursor(consumerId: string): ConsumerCursor | undefined {
    this.assertOpen();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(consumerId)) {
      throw new ControlStoreError("INVALID_EVENT", "consumer id is invalid");
    }
    try {
      const row = this.db.prepare("SELECT * FROM consumer_cursors WHERE consumer_id = ?").get(consumerId) as ConsumerCursorRow | undefined;
      return row ? decodeConsumerCursor(row) : undefined;
    } catch (error) {
      normalizeStoreError(error);
    }
  }

  readRange(options: { afterSeq: number; limit?: number; runEpoch?: string }): EventRange {
    this.assertOpen();
    const limit = options.limit ?? 1_000;
    if (!Number.isSafeInteger(options.afterSeq) || options.afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RANGE_LIMIT) {
      throw new ControlStoreError("INVALID_EVENT", "event range cursor/limit is invalid");
    }
    if (options.runEpoch !== undefined && options.runEpoch !== this.runEpoch) {
      throw new ControlStoreError("RUN_IDENTITY_MISMATCH", "event cursor belongs to a different run epoch");
    }
    try {
      const read = this.db.transaction((): EventRange => {
        const meta = readMeta(this.db);
        verifyRunIdentity(meta, this.runId, this.runEpoch);
        if (options.afterSeq < meta.retained_floor - 1) {
          throw new ControlStoreError("CURSOR_EXPIRED", "event cursor precedes retained history", {
            floorSeq: meta.retained_floor,
            headSeq: meta.head_seq
          });
        }
        if (options.afterSeq > meta.head_seq) {
          throw recovery("event cursor is ahead of the canonical head", { cursor: options.afterSeq, headSeq: meta.head_seq });
        }
        const rows = this.db.prepare("SELECT * FROM control_events WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?").all(
          options.afterSeq,
          meta.head_seq,
          limit
        ) as EventRow[];
        const events = rows.map(decodeEventRow);
        return {
          runEpoch: this.runEpoch,
          floorSeq: meta.retained_floor,
          headSeq: meta.head_seq,
          afterSeq: options.afterSeq,
          events,
          hasMore: events.length > 0 && events[events.length - 1]!.seq < meta.head_seq
        };
      });
      return read.deferred();
    } catch (error) {
      normalizeStoreError(error);
    }
  }

  getProjection(): ControlProjection {
    this.assertOpen();
    try {
      const read = this.db.transaction(() => loadProjection(this.db, this.runId, this.runEpoch));
      return read.deferred();
    } catch (error) {
      normalizeStoreError(error);
    }
  }

  controlRoomProjection(): ControlRoomProjectionV1 {
    return this.getProjection().observability.room;
  }

  controlRoomEventHead(): number {
    return this.head().headSeq;
  }

  controlRoomAvailability(): "available" {
    this.assertOpen();
    return "available";
  }

  getActivity(sessionId: string, now = Date.now(), headSeq?: number): DerivedActivity {
    const projection = this.getProjection();
    return deriveActivity(projection, sessionId, now, headSeq ?? projection.headSeq);
  }

  head(): { runId: string; runEpoch: string; floorSeq: number; headSeq: number } {
    this.assertOpen();
    const meta = readMeta(this.db);
    verifyRunIdentity(meta, this.runId, this.runEpoch);
    return { runId: this.runId, runEpoch: this.runEpoch, floorSeq: meta.retained_floor, headSeq: meta.head_seq };
  }

  identity(): { storeId: string; runId: string; runEpoch: string } {
    this.assertOpen();
    const meta = readMeta(this.db);
    verifyRunIdentity(meta, this.runId, this.runEpoch);
    if (meta.store_id !== this.storeId) throw recovery("control store identity changed while open");
    return { storeId: this.storeId, runId: this.runId, runEpoch: this.runEpoch };
  }

  createSnapshot(): SnapshotReceipt {
    this.assertOpen();
    try {
      const transaction = this.db.transaction((): SnapshotReceipt => {
        const state = loadProjection(this.db, this.runId, this.runEpoch);
        const replayed = reduceControlEvents(this.runId, this.runEpoch, readAllEvents(this.db, state.headSeq));
        if (!projectionsEqual(state, replayed)) {
          throw recovery("cannot snapshot: materialized projection disagrees with genesis replay");
        }
        const payloadJson = canonicalJson(canonicalProjectionValue(state));
        const digest = sha256Text(payloadJson);
        const existing = this.db.prepare("SELECT * FROM control_snapshots WHERE seq = ?").get(state.headSeq) as SnapshotRow | undefined;
        if (existing) {
          const existingProjection = parseSnapshotProjection(existing, this.storeId, this.runId, this.runEpoch);
          if (existing.digest !== digest || existing.payload_json !== payloadJson) throw recovery(`conflicting snapshot at seq ${state.headSeq}`);
          if (!projectionsEqual(existingProjection, replayed)) throw recovery(`snapshot ${state.headSeq} does not match canonical replay`);
          return {
            seq: state.headSeq,
            storeId: this.storeId,
            runId: this.runId,
            runEpoch: this.runEpoch,
            schemaVersion: CONTROL_EVENT_SCHEMA_VERSION,
            reducerVersion: CONTROL_REDUCER_VERSION,
            digest,
            createdAt: existing.created_at,
            verifiedAt: existing.verified_at
          };
        }
        const createdAt = this.now();
        const verifiedAt = canonicalUtc(createdAt, "snapshot verification time");
        this.db.prepare(`
          INSERT INTO control_snapshots(seq, store_id, schema_version, reducer_version, run_id, run_epoch, payload_json, digest, created_at, verified_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(state.headSeq, this.storeId, CONTROL_EVENT_SCHEMA_VERSION, CONTROL_REDUCER_VERSION, this.runId, this.runEpoch, payloadJson, digest, verifiedAt, verifiedAt);
        return {
          seq: state.headSeq,
          storeId: this.storeId,
          runId: this.runId,
          runEpoch: this.runEpoch,
          schemaVersion: CONTROL_EVENT_SCHEMA_VERSION,
          reducerVersion: CONTROL_REDUCER_VERSION,
          digest,
          createdAt: verifiedAt,
          verifiedAt
        };
      });
      return transaction.immediate();
    } catch (error) {
      normalizeStoreError(error);
    }
  }

  verifySnapshot(seq?: number): SnapshotReceipt {
    this.assertOpen();
    if (seq !== undefined && (!Number.isSafeInteger(seq) || seq < 0)) throw new ControlStoreError("INVALID_EVENT", "snapshot seq is invalid");
    try {
      const row = (seq === undefined
        ? this.db.prepare("SELECT * FROM control_snapshots ORDER BY seq DESC LIMIT 1").get()
        : this.db.prepare("SELECT * FROM control_snapshots WHERE seq = ?").get(seq)) as SnapshotRow | undefined;
      if (!row) throw recovery(seq === undefined ? "no verified snapshot exists" : `snapshot ${seq} does not exist`);
      const snapshot = parseSnapshotProjection(row, this.storeId, this.runId, this.runEpoch);
      const replayed = reduceControlEvents(this.runId, this.runEpoch, readAllEvents(this.db, snapshot.headSeq));
      if (!projectionsEqual(snapshot, replayed)) throw recovery(`snapshot ${snapshot.headSeq} does not match canonical replay`);
      return {
        seq: snapshot.headSeq,
        storeId: this.storeId,
        runId: this.runId,
        runEpoch: this.runEpoch,
        schemaVersion: row.schema_version,
        reducerVersion: row.reducer_version,
        digest: row.digest,
        createdAt: row.created_at,
        verifiedAt: row.verified_at
      };
    } catch (error) {
      normalizeStoreError(error);
    }
  }

  rebuildProjections(): ControlProjection {
    this.assertOpen();
    try {
      const allEvents = readAllEvents(this.db);
      const latest = this.db.prepare("SELECT * FROM control_snapshots ORDER BY seq DESC LIMIT 1").get() as SnapshotRow | undefined;
      let rebuilt: ControlProjection;
      if (latest) {
        const snapshot = parseSnapshotProjection(latest, this.storeId, this.runId, this.runEpoch);
        const prefix = reduceControlEvents(this.runId, this.runEpoch, allEvents.filter((event) => event.seq <= snapshot.headSeq));
        if (!projectionsEqual(snapshot, prefix)) throw recovery(`snapshot ${snapshot.headSeq} failed replay verification`);
        rebuilt = reduceControlEvents(
          this.runId,
          this.runEpoch,
          allEvents.filter((event) => event.seq > snapshot.headSeq),
          snapshot
        );
      } else {
        rebuilt = reduceControlEvents(this.runId, this.runEpoch, allEvents);
      }
      const transaction = this.db.transaction(() => {
        const head = asSafeInteger((this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS head FROM control_events").get() as { head: number | bigint }).head, "event head");
        if (head !== rebuilt.headSeq) throw recovery("canonical event head changed during rebuild");
        replaceProjection(this.db, rebuilt);
        this.db.prepare("UPDATE control_meta SET head_seq = ? WHERE singleton = 1").run(rebuilt.headSeq);
      });
      transaction.immediate();
      return rebuilt;
    } catch (error) {
      normalizeStoreError(error);
    }
  }

  verifyIntegrity(level: "quick" | "full" = "full"): IntegrityReceipt {
    this.assertOpen();
    try {
      verifyPhysicalSchema(this.db, level);
      const verify = this.db.transaction((): IntegrityReceipt => {
        const meta = readMeta(this.db);
        verifyRunIdentity(meta, this.runId, this.runEpoch);
        if (meta.store_id !== this.storeId) throw recovery("control store storeId changed while open");
        const events = readAllEvents(this.db);
        if (events.length !== meta.head_seq || events.some((event, index) => event.seq !== index + 1)) {
          throw recovery("canonical event sequence is not contiguous from genesis", {
            eventCount: events.length,
            headSeq: meta.head_seq
          });
        }
        const replayed = reduceControlEvents(this.runId, this.runEpoch, events);
        const stored = loadProjection(this.db, this.runId, this.runEpoch);
        if (!projectionsEqual(replayed, stored)) throw recovery("materialized projection disagrees with canonical history");

        for (const row of this.db.prepare("SELECT * FROM consumer_cursors ORDER BY consumer_id").all() as ConsumerCursorRow[]) {
          const cursor = decodeConsumerCursor(row);
          if (cursor.lastSeq > meta.head_seq || cursor.lastSeq < meta.retained_floor - 1) {
            throw recovery(`consumer cursor ${cursor.consumerId} is outside retained canonical history`);
          }
        }
        if (level === "full") {
          for (const row of this.db.prepare("SELECT * FROM control_snapshots ORDER BY seq").all() as SnapshotRow[]) {
            const snapshot = parseSnapshotProjection(row, this.storeId, this.runId, this.runEpoch);
            const prefix = reduceControlEvents(this.runId, this.runEpoch, events.filter((event) => event.seq <= snapshot.headSeq));
            if (!projectionsEqual(snapshot, prefix)) throw recovery(`snapshot ${snapshot.headSeq} does not match canonical replay`);
          }
        }
        return {
          level,
          storeId: this.storeId,
          runId: this.runId,
          runEpoch: this.runEpoch,
          headSeq: meta.head_seq,
          verifiedAt: canonicalUtc(this.now(), "integrity verification time")
        };
      });
      return verify.deferred();
    } catch (error) {
      normalizeStoreError(error);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.subscribers.clear();
    this.db.close();
  }
}

export function openControlStore(options: OpenControlStoreOptions): ControlStore {
  return ControlStore.open(options);
}

export const controlStoreInternals = {
  applicationId: APPLICATION_ID,
  databaseSchemaVersion: DATABASE_SCHEMA_VERSION,
  migrationChecksum: MIGRATION_1_CHECKSUM,
  physicalSchemaChecksum: PHYSICAL_SCHEMA_CHECKSUM,
  maxRangeLimit: MAX_RANGE_LIMIT
} as const;

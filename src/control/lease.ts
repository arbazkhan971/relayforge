import Database from "better-sqlite3";
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync
} from "node:fs";
import { dirname } from "node:path";
import { ensureControlDirectory, readControlRunFile, type ControlPaths, type ControlRunFile, UnsafeControlStateError } from "./runfile.js";

const LEASE_APPLICATION_ID = 1_380_338_771; // ASCII RFLS
const LEASE_SCHEMA_VERSION = 1;

export type ControlLeaseOwner = Pick<ControlRunFile, "instanceId" | "pid" | "processStartToken" | "startedAt">;

export type ControlLeaseAttempt =
  | { acquired: true; lease: ControlLease }
  | { acquired: false; reason: "held"; detail: string };

export type ControlLeaseProbe =
  | { state: "absent" }
  | { state: "free" }
  | { state: "held" }
  | { state: "failed"; detail: string };

export type ControlOwnerInspection =
  | { state: "stopped" }
  | { state: "starting" }
  | { state: "held"; runFile: ControlRunFile }
  | { state: "stale-runfile"; runFile: ControlRunFile }
  | { state: "failed"; detail: string };

type FileIdentity = { dev: bigint; ino: bigint };

// Public read clients refer to ControlLeaseProbe, so TypeScript loads this
// declaration even though the database handle itself is internal authority.
// Keep that declaration independent of better-sqlite3's implementation-only
// typings so a clean package consumer does not need our development @types.
type ControlLeaseDatabase = {
  readonly open: boolean;
  readonly inTransaction: boolean;
  exec(source: string): unknown;
  close(): void;
};

function selfUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function sqliteCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

function inspectLeaseFile(path: string): FileIdentity {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile() || st.nlink !== 1n) throw new UnsafeControlStateError(path, "lease DB must be one regular link");
    const uid = selfUid();
    if (uid !== undefined && Number(st.uid) !== uid) throw new UnsafeControlStateError(path, `lease DB is owned by uid ${String(st.uid)}, not ${uid}`);
    if ((Number(st.mode) & 0o077) !== 0) throw new UnsafeControlStateError(path, "lease DB is group/other accessible");
    return { dev: st.dev, ino: st.ino };
  } finally {
    closeSync(fd);
  }
}

function identityAtPath(path: string, expected: FileIdentity): void {
  const st = lstatSync(path, { bigint: true });
  if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1n || st.dev !== expected.dev || st.ino !== expected.ino) {
    throw new UnsafeControlStateError(path, "stable lease DB identity changed");
  }
}

function ensureLeaseLeaf(path: string): FileIdentity {
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW, 0o600);
    // Tighten the inode we actually created while it is still pinned. Never chmod the pathname
    // after EEXIST: that would follow a pre-planted symlink before inspectLeaseFile() could reject it.
    fchmodSync(fd, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return inspectLeaseFile(path);
}

function verifyLeaseSchema(db: Database.Database, initialize: boolean): void {
  db.pragma("busy_timeout = 0");
  db.pragma("journal_mode = DELETE");
  db.pragma("synchronous = FULL");
  if (initialize) {
    db.exec(`
      BEGIN IMMEDIATE;
      PRAGMA application_id = ${LEASE_APPLICATION_ID};
      CREATE TABLE IF NOT EXISTS lease_schema (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL CHECK (schema_version = ${LEASE_SCHEMA_VERSION})
      ) STRICT;
      CREATE TABLE IF NOT EXISTS lease_owner (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        instance_id TEXT NOT NULL,
        pid INTEGER NOT NULL,
        process_start_token TEXT NOT NULL,
        started_at TEXT NOT NULL
      ) STRICT;
      INSERT OR IGNORE INTO lease_schema(singleton, schema_version) VALUES (1, ${LEASE_SCHEMA_VERSION});
      PRAGMA user_version = ${LEASE_SCHEMA_VERSION};
      COMMIT;
    `);
  }
  const applicationId = db.pragma("application_id", { simple: true });
  const userVersion = db.pragma("user_version", { simple: true });
  const quick = db.pragma("quick_check", { simple: true });
  const row = db.prepare<[], { schema_version: number }>("SELECT schema_version FROM lease_schema WHERE singleton = 1").get();
  const tables = db.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('lease_schema','lease_owner') ORDER BY name").all();
  if (applicationId !== LEASE_APPLICATION_ID || userVersion !== LEASE_SCHEMA_VERSION || quick !== "ok" || row?.schema_version !== LEASE_SCHEMA_VERSION || tables.map((table) => table.name).join(",") !== "lease_owner,lease_schema") {
    throw new Error("control lease DB schema or integrity is invalid");
  }
}

function openLease(path: string, identity: FileIdentity, initialize: boolean): Database.Database {
  const db = new Database(path, { fileMustExist: true, timeout: 0 });
  try {
    verifyLeaseSchema(db, initialize);
    identityAtPath(path, identity);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export class ControlLease {
  #released = false;

  constructor(
    private readonly db: ControlLeaseDatabase,
    readonly path: string,
    private readonly identity: FileIdentity,
    readonly owner: ControlLeaseOwner
  ) {}

  assertHeld(): void {
    if (this.#released || !this.db.open || !this.db.inTransaction) throw new Error("control lease is not held");
    identityAtPath(this.path, this.identity);
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    let identityError: unknown;
    try {
      identityAtPath(this.path, this.identity);
    } catch (error) {
      identityError = error;
    }
    try {
      if (this.db.open && this.db.inTransaction) this.db.exec("ROLLBACK");
    } finally {
      if (this.db.open) this.db.close();
    }
    if (identityError) throw identityError;
  }
}

export function acquireControlLease(paths: ControlPaths, owner: ControlLeaseOwner): ControlLeaseAttempt {
  ensureControlDirectory(paths);
  const existed = (() => {
    try {
      lstatSync(paths.leaseDb);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  })();
  const identity = ensureLeaseLeaf(paths.leaseDb);
  let db: Database.Database;
  try {
    db = openLease(paths.leaseDb, identity, !existed || lstatSync(paths.leaseDb).size === 0);
  } catch (error) {
    if (sqliteCode(error) === "SQLITE_BUSY") return { acquired: false, reason: "held", detail: "another owner is initializing or holding the lease" };
    throw error;
  }
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (error) {
    db.close();
    if (sqliteCode(error) === "SQLITE_BUSY") return { acquired: false, reason: "held", detail: "another control service holds the lifetime lease" };
    throw error;
  }
  try {
    db.prepare("INSERT INTO lease_owner(singleton,instance_id,pid,process_start_token,started_at) VALUES (1,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET instance_id=excluded.instance_id,pid=excluded.pid,process_start_token=excluded.process_start_token,started_at=excluded.started_at")
      .run(owner.instanceId, owner.pid, owner.processStartToken, owner.startedAt);
    identityAtPath(paths.leaseDb, identity);
    return { acquired: true, lease: new ControlLease(db, paths.leaseDb, identity, owner) };
  } catch (error) {
    try { db.exec("ROLLBACK"); } finally { db.close(); }
    throw error;
  }
}

export function probeControlLease(path: string): ControlLeaseProbe {
  let identity: FileIdentity;
  try {
    identity = inspectLeaseFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
    return { state: "failed", detail: (error as Error).message };
  }
  let db: Database.Database;
  try {
    db = openLease(path, identity, false);
  } catch (error) {
    if (sqliteCode(error) === "SQLITE_BUSY") return { state: "held" };
    return { state: "failed", detail: (error as Error).message };
  }
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
    identityAtPath(path, identity);
    return { state: "free" };
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    if (sqliteCode(error) === "SQLITE_BUSY") return { state: "held" };
    return { state: "failed", detail: (error as Error).message };
  } finally {
    db.close();
  }
}

export function inspectControlOwner(paths: ControlPaths): ControlOwnerInspection {
  const lease = probeControlLease(paths.leaseDb);
  let runFile;
  try {
    runFile = readControlRunFile(paths.runFile);
  } catch (error) {
    return { state: "failed", detail: (error as Error).message };
  }
  if (lease.state === "failed") return { state: "failed", detail: lease.detail };
  if (lease.state === "absent" || lease.state === "free") {
    return runFile.kind === "absent" ? { state: "stopped" } : { state: "stale-runfile", runFile: runFile.value };
  }
  if (runFile.kind === "absent") return { state: "starting" };
  if (runFile.value.configId !== paths.configId) return { state: "failed", detail: "held lease and run-file configuration identities differ" };
  return { state: "held", runFile: runFile.value };
}

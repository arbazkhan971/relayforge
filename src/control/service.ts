import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  type Dirent
} from "node:fs";
import { resolve } from "node:path";
import type { LoadedConfig } from "../config/load.js";
import { getProject } from "../config/load.js";
import { assertConfigSemantics } from "../config/validate.js";
import { renderDashboard } from "../dashboard/render.js";
import { isValidId } from "../ids.js";
import {
  fetchControlStatus,
  inspectControlService,
  requireControlService,
  type ControlServiceInspection
} from "./client.js";
import {
  acquireControlLease,
  probeControlLease,
  type ControlLease,
  type ControlLeaseOwner
} from "./lease.js";
import { inspectProcessIncarnation, processStartToken, type ProcessIncarnationInspection } from "./process-identity.js";
import {
  CONTROL_GRACEFUL_DRAIN_TIMEOUT_MS,
  CONTROL_HOST,
  type ControlRunFile,
  type ControlStatus
} from "./protocol.js";
import {
  controlPaths,
  newControlRunFile,
  publishControlRunFile,
  readControlRunFile,
  removeControlRunFileIfInstance,
  type ControlPaths,
  type RunFileRead
} from "./runfile.js";
import { createControlServer, type ControlHttpServer, type ControlServerAddress } from "./server.js";
import type { ControlRoomReadSource } from "../control-room/server-adapter.js";
import { createNodeSseSink, DurableSseBroker, SseCapacityError, type DurableSseSource } from "./sse.js";
import { openControlStore, type ControlStore } from "./store.js";
import type { ControlProjectViewSource, ControlViewSource } from "./views.js";

export const CONTROL_STORE_FILENAME = "control.db";
export const CONTROL_RUN_EPOCH_FILENAME = ".loop_run_nonce";
export const CONTROL_STOP_TIMEOUT_MS = CONTROL_GRACEFUL_DRAIN_TIMEOUT_MS + 2_000;

export class ControlServiceError extends Error {
  constructor(
    readonly code:
      | "OWNER_HELD"
      | "ACTIVE_RUN_WRITER"
      | "DISCOVERY_FAILED"
      | "NOT_RUNNING"
      | "IDENTITY_MISMATCH"
      | "STOP_TIMEOUT",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ControlServiceError";
  }
}

export type DurableControlViewSource = ControlViewSource & DurableSseSource;

export type ControlServiceProjectSource = Omit<ControlProjectViewSource, "runs"> & {
  readonly runs: readonly DurableControlViewSource[];
};

/**
 * A run owner can lend already-open stores to the in-process service. Borrowed sources are never
 * reopened or closed by the service; the parent remains responsible for closing them after the
 * HTTP/SSE drain has completed.
 */
export type BorrowedControlSources = {
  projects(): readonly ControlServiceProjectSource[];
};

export type StartControlServiceOptions = {
  port?: number;
  dashboardProject?: string;
  borrowedSources?: BorrowedControlSources;
  /** A run parent can lend the configuration mutex it acquired before its run lease/store. */
  controlOwnership?: ControlServiceOwnership;
  /** Port zero is a deterministic test seam only. */
  allowEphemeralPortForTests?: boolean;
  now?: () => Date;
  instanceId?: string;
  onRuntimeError?: (error: Error) => void;
};

export type ControlServiceHandle = {
  readonly address: ControlServerAddress;
  readonly paths: ControlPaths;
  readonly runFile: ControlRunFile;
  readonly server: ControlHttpServer;
  readonly borrowed: boolean;
  shutdown(): Promise<void>;
};

type OwnedSources = {
  projects: readonly ControlServiceProjectSource[];
  stores: readonly ControlStore[];
};

type ControlOwnershipState = { lease: ControlLease | undefined; serviceClaimed: boolean };
const controlOwnershipStates = new WeakMap<ControlServiceOwnership, ControlOwnershipState>();

/**
 * The race-free configuration-wide writer mutex. Every run writer and standalone service takes
 * this before any run lease or ControlStore handle, and holds it until all canonical handles close.
 */
export class ControlServiceOwnership {
  readonly paths: ControlPaths;
  readonly owner: Readonly<ControlLeaseOwner>;

  constructor(paths: ControlPaths, owner: ControlLeaseOwner, lease: ControlLease) {
    this.paths = paths;
    this.owner = Object.freeze({ ...owner });
    controlOwnershipStates.set(this, { lease, serviceClaimed: false });
  }

  assertHeld(): void {
    const lease = ownershipState(this).lease;
    if (lease === undefined) throw new ControlServiceError("IDENTITY_MISMATCH", "Control ownership has already been released.");
    lease.assertHeld();
  }

  /** Release is intentionally refused while a service still borrows the mutex. */
  release(): void {
    const state = ownershipState(this);
    if (state.serviceClaimed) {
      throw new ControlServiceError("IDENTITY_MISMATCH", "Cannot release control ownership while its service is still active.");
    }
    const lease = state.lease;
    if (lease === undefined) return;
    state.lease = undefined;
    lease.release();
  }
}

function ownershipState(ownership: ControlServiceOwnership): ControlOwnershipState {
  const state = controlOwnershipStates.get(ownership);
  if (state === undefined) throw new ControlServiceError("IDENTITY_MISMATCH", "Control ownership is not a locally issued capability.");
  return state;
}

function claimOwnershipForService(ownership: ControlServiceOwnership, paths: ControlPaths): void {
  ownership.assertHeld();
  if (ownership.paths.configId !== paths.configId || ownership.paths.leaseDb !== paths.leaseDb || ownership.paths.runFile !== paths.runFile) {
    throw new ControlServiceError("IDENTITY_MISMATCH", "Pre-acquired control ownership belongs to another configuration.");
  }
  if (ownership.owner.pid !== process.pid || inspectProcessIncarnation(ownership.owner.pid, ownership.owner.processStartToken).state !== "alive-match") {
    throw new ControlServiceError("IDENTITY_MISMATCH", "Pre-acquired control ownership does not belong to this process incarnation.");
  }
  const state = ownershipState(ownership);
  if (state.serviceClaimed) throw new ControlServiceError("OWNER_HELD", "This control ownership already has an active service.");
  state.serviceClaimed = true;
}

function finishOwnershipServiceClaim(ownership: ControlServiceOwnership, releaseOwnership: boolean): void {
  const state = ownershipState(ownership);
  if (!state.serviceClaimed) return;
  state.serviceClaimed = false;
  if (releaseOwnership) ownership.release();
}

export function acquireControlServiceOwnership(
  loaded: LoadedConfig,
  options: { now?: () => Date; instanceId?: string } = {}
): ControlServiceOwnership {
  assertConfigSemantics(loaded);
  const paths = controlPaths(loaded.rootDir, loaded.path);
  const instanceId = options.instanceId ?? randomBytes(32).toString("hex");
  if (!/^[a-f0-9]{64}$/u.test(instanceId)) throw new TypeError("Control instanceId must be 64 lowercase hexadecimal characters.");
  const owner: ControlLeaseOwner = {
    instanceId,
    pid: process.pid,
    processStartToken: processStartToken(),
    startedAt: canonicalNow((options.now ?? (() => new Date()))())
  };
  const attempt = acquireControlLease(paths, owner);
  if (!attempt.acquired) {
    throw new ControlServiceError(
      "OWNER_HELD",
      "Another control service or run writer owns this configuration's stable lifetime lease. Use `loop serve status` to inspect a published service, or wait for the active run."
    );
  }
  return new ControlServiceOwnership(paths, owner, attempt.lease);
}

/**
 * Start one foreground control owner for a loaded configuration. Ownership is acquired before a
 * standalone store handle is opened, and constructor/startup failures unwind stores then lease.
 */
export async function startControlService(
  loaded: LoadedConfig,
  options: StartControlServiceOptions = {}
): Promise<ControlServiceHandle> {
  assertConfigSemantics(loaded);
  const dashboardProject = getProject(loaded, options.dashboardProject).name;
  const paths = controlPaths(loaded.rootDir, loaded.path);
  const ownsControlOwnership = options.controlOwnership === undefined;
  const ownership = options.controlOwnership ?? acquireControlServiceOwnership(loaded, {
    now: options.now,
    instanceId: options.instanceId
  });
  try {
    claimOwnershipForService(ownership, paths);
  } catch (error) {
    if (ownsControlOwnership) {
      try { ownership.release(); } catch { /* preserve the claim failure */ }
    }
    throw error;
  }
  const { instanceId, pid, processStartToken: token, startedAt } = ownership.owner;
  // Populated as each standalone handle opens so constructor/discovery failures cannot make a
  // writable handle unreachable before the outer ownership boundary decides whether it may release.
  const openingStores: ControlStore[] = [];
  let owned: OwnedSources | undefined;
  let server: ControlHttpServer | undefined;
  try {
    owned = options.borrowedSources === undefined ? discoverStandaloneSources(loaded, openingStores) : undefined;
    const suppliedProjects = options.borrowedSources?.projects() ?? owned!.projects;
    assertSourceRegistry(suppliedProjects, loaded);
    // Snapshot registry membership once. A caller may mutate its own arrays later, but cannot swap
    // project/run ownership underneath an admitted HTTP request.
    const projects: readonly ControlServiceProjectSource[] = Object.freeze(suppliedProjects.map((project) => Object.freeze({
      project: project.project,
      runs: Object.freeze([...project.runs]),
      sessions: project.sessions === undefined ? undefined : Object.freeze([...project.sessions])
    })));
    const broker = new DurableSseBroker();
    const port = options.port ?? loaded.config.defaults.dashboardPort;

    server = createControlServer({
      port,
      allowEphemeralPortForTests: options.allowEphemeralPortForTests,
      createRunFile(boundPort) {
        return newControlRunFile({
          instanceId,
          configId: paths.configId,
          pid,
          processStartToken: token,
          port: boundPort,
          startedAt
        });
      },
      readModels: {
        projects: () => projects,
        controlRoom({ source }) {
          return asControlRoomReadSource(source);
        }
      },
      dashboard: { render: () => renderDashboard(dashboardProject) },
      sse: {
        prepare({ project, run, source, cursor }) {
          const durable = requireDurableSource(source);
          if (broker.activeSubscribers >= broker.limits.maxSubscribers) {
            throw new SseCapacityError(broker.limits.maxSubscribers);
          }
          return {
            async start({ response, signal }) {
              await broker.stream({
                source: durable,
                sink: createNodeSseSink(response),
                project,
                run,
                cursor,
                signal
              });
            }
          };
        },
        shutdown: () => broker.shutdown()
      },
      lifecycle: {
        publishRunFile: (runFile) => publishControlRunFile(paths.runFile, runFile),
        closeStores: () => {
          if (owned === undefined) return;
          closeStores(owned.stores);
        },
        removeRunFileIfOwned: (runFile) => {
          removeControlRunFileIfInstance(paths.runFile, paths.configId, runFile.instanceId);
        },
        releaseLease: () => {
          finishOwnershipServiceClaim(ownership, ownsControlOwnership);
        }
      },
      onRuntimeError: options.onRuntimeError
    });
    const address = await server.start();
    const runFile = server.runFile;
    if (runFile === undefined) throw new Error("The ready control service did not publish discovery identity.");
    return {
      address,
      paths,
      runFile,
      server,
      borrowed: options.borrowedSources !== undefined,
      shutdown: () => server!.shutdown()
    };
  } catch (error) {
    if (server !== undefined) {
      try {
        await server.shutdown();
      } catch (cleanupError) {
        throw startupCleanupFailure(error, cleanupError);
      }
    } else {
      try {
        closeStores(openingStores);
      } catch (cleanupError) {
        // A maybe-open writable handle outranks availability. Keep the configuration mutex claimed
        // and held until process exit instead of allowing a successor into ambiguous authority.
        throw startupCleanupFailure(error, cleanupError);
      }
      try {
        finishOwnershipServiceClaim(ownership, ownsControlOwnership);
      } catch (cleanupError) {
        throw startupCleanupFailure(error, cleanupError);
      }
    }
    throw error;
  }
}

function asControlRoomReadSource(source: ControlViewSource): ControlRoomReadSource | undefined {
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(source.runEpoch)) return undefined;
  const candidate = source as ControlViewSource & Partial<ControlRoomReadSource>;
  if (typeof candidate.controlRoomProjection !== "function" || typeof candidate.controlRoomEventHead !== "function") {
    return undefined;
  }
  return candidate as ControlRoomReadSource;
}

export async function getControlServiceStatus(
  loaded: LoadedConfig,
  options: { timeoutMs?: number } = {}
): Promise<ControlStatus> {
  assertConfigSemantics(loaded);
  const paths = controlPaths(loaded.rootDir, loaded.path);
  const attachment = await requireControlService(paths, { timeoutMs: options.timeoutMs });
  return await fetchControlStatus(attachment, { timeoutMs: options.timeoutMs });
}

export type StopControlServiceAdapters = {
  inspect?: (paths: ControlPaths, timeoutMs: number) => Promise<ControlServiceInspection>;
  inspectProcess?: (pid: number, token: string) => ProcessIncarnationInspection;
  readRunFile?: (path: string) => RunFileRead;
  probeLease?: typeof probeControlLease;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type StopControlServiceResult = {
  stopped: true;
  instanceId: string;
  pid: number;
};

/**
 * Stop only the exact twice-collected service incarnation. This never escalates to SIGKILL.
 */
export async function stopControlService(
  loaded: LoadedConfig,
  options: { timeoutMs?: number; adapters?: StopControlServiceAdapters } = {}
): Promise<StopControlServiceResult> {
  assertConfigSemantics(loaded);
  const paths = controlPaths(loaded.rootDir, loaded.path);
  const timeoutMs = options.timeoutMs ?? CONTROL_STOP_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new RangeError("control stop timeout must be an integer between 1 and 60000 milliseconds");
  }
  const adapters = options.adapters ?? {};
  const inspect = adapters.inspect ?? ((selected, bound) => inspectControlService(selected, { timeoutMs: bound }));
  const inspectProcess = adapters.inspectProcess ?? inspectProcessIncarnation;
  const readRunFile = adapters.readRunFile ?? readControlRunFile;
  const probeLease = adapters.probeLease ?? probeControlLease;
  const signal = adapters.signal ?? ((pid, sent) => process.kill(pid, sent));
  const sleep = adapters.sleep ?? ((ms) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms)));
  const clock = adapters.now ?? Date.now;
  const deadline = clock() + timeoutMs;

  const first = await inspect(paths, remainingMs(deadline, clock));
  const firstAttachment = requireReadyForStop(first);
  requireLiveMatch(inspectProcess(firstAttachment.runFile.pid, firstAttachment.runFile.processStartToken));

  // Collect the complete lease/run-file/health identity a second time. It must still be byte-for-byte
  // the same owner, then the process-start token is checked again immediately before signal delivery.
  const second = await inspect(paths, remainingMs(deadline, clock));
  const secondAttachment = requireReadyForStop(second);
  if (JSON.stringify(firstAttachment.runFile) !== JSON.stringify(secondAttachment.runFile)) {
    throw new ControlServiceError("IDENTITY_MISMATCH", "The control owner changed during stop; no signal was sent.");
  }
  requireLiveMatch(inspectProcess(secondAttachment.runFile.pid, secondAttachment.runFile.processStartToken));
  try {
    signal(secondAttachment.runFile.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }

  while (clock() < deadline) {
    const processState = inspectProcess(secondAttachment.runFile.pid, secondAttachment.runFile.processStartToken);
    const runFile = readRunFile(paths.runFile);
    const leaseState = probeLease(paths.leaseDb);
    if (leaseState.state === "failed") {
      throw new ControlServiceError("IDENTITY_MISMATCH", `The control lease could not be verified after SIGTERM: ${leaseState.detail}`);
    }
    const exactRunFileRemains = runFile.kind === "present" &&
      runFile.value.instanceId === secondAttachment.runFile.instanceId &&
      runFile.value.configId === secondAttachment.runFile.configId;
    const exactProcessGone = processState.state === "dead" || processState.state === "alive-mismatch";
    if (exactProcessGone && !exactRunFileRemains && leaseState.state !== "held") {
      return {
        stopped: true,
        instanceId: secondAttachment.runFile.instanceId,
        pid: secondAttachment.runFile.pid
      };
    }
    await sleep(Math.min(50, Math.max(1, deadline - clock())));
  }
  throw new ControlServiceError(
    "STOP_TIMEOUT",
    `The exact control owner did not complete graceful shutdown within ${timeoutMs}ms; no SIGKILL was sent.`
  );
}

function discoverStandaloneSources(loaded: LoadedConfig, stores: ControlStore[]): OwnedSources {
  const projects: ControlServiceProjectSource[] = [];
  try {
    for (const project of loaded.config.projects) {
      const projectRunsDir = resolve(loaded.rootDir, loaded.config.defaults.runDir, project.name);
      const runEntries = readDirectoryIfPresent(projectRunsDir, `run directory for project ${project.name}`);
      const runs: ControlStore[] = [];
      for (const entry of runEntries) {
        const entryPath = resolve(projectRunsDir, entry.name);
        if (entry.isSymbolicLink()) throw discovery(`run directory entry ${entry.name} is a symlink`);
        if (!entry.isDirectory()) continue;
        if (!isValidId(entry.name)) throw discovery(`run directory entry ${entry.name} is not a canonical run identifier`);
        assertPrivateDirectory(entryPath, `run ${entry.name}`);
        const storePath = resolve(entryPath, CONTROL_STORE_FILENAME);
        let storeStat;
        try {
          storeStat = lstatSync(storePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (storeStat.isSymbolicLink() || !storeStat.isFile()) {
          throw discovery(`control store for run ${entry.name} is not a real regular file`);
        }
        assertNoActiveRunWriter(entryPath, entry.name);
        const runEpoch = readBoundedPrivateText(resolve(entryPath, CONTROL_RUN_EPOCH_FILENAME), 129).trim();
        if (!/^[A-Za-z0-9_-]{16,128}$/u.test(runEpoch)) {
          throw discovery(`run ${entry.name} has a malformed durable epoch`);
        }
        const store = openControlStore({
          path: storePath,
          runId: entry.name,
          runEpoch,
          create: false,
          recoveryMode: "verify",
          integrityCheck: "quick"
        });
        stores.push(store);
        // The run lease is collected again after SQLite validation. A run that became active in the
        // opening window is ambiguity, so the outer startup unwind closes every opened handle while
        // retaining the configuration mutex if any close fails.
        assertNoActiveRunWriter(entryPath, entry.name);
        runs.push(store);
      }
      projects.push({ project: project.name, runs });
    }
    return { projects, stores };
  } catch (error) {
    if (error instanceof ControlServiceError) throw error;
    throw discovery("standalone control-store discovery failed", error);
  }
}

function assertNoActiveRunWriter(runDir: string, runId: string): void {
  const leasePath = resolve(runDir, ".loop.lease");
  let text: string;
  try {
    text = readBoundedPrivateText(leasePath, 1_024);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const match = /^(\d+) ([a-f0-9]{16}) (\d{4}-\d{2}-\d{2}T[^\s]+)$/u.exec(text.trim());
  if (!match) throw discovery(`run ${runId} has an unreadable or malformed writer lease`);
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2_147_483_647) {
    throw discovery(`run ${runId} has an invalid writer PID`);
  }
  try {
    process.kill(pid, 0);
    throw new ControlServiceError(
      "ACTIVE_RUN_WRITER",
      `Run ${runId} may have an active writer under pid ${pid}; standalone service refused a second writable store handle.`
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return;
    if (code === "EPERM") {
      throw new ControlServiceError(
        "ACTIVE_RUN_WRITER",
        `Run ${runId} may have an active writer under pid ${pid}; standalone service cannot prove exclusivity.`
      );
    }
    if (error instanceof ControlServiceError) throw error;
    throw discovery(`run ${runId} writer liveness could not be verified`, error);
  }
}

function readDirectoryIfPresent(path: string, label: string): Dirent<string>[] {
  try {
    assertPrivateDirectory(path, label);
    return readdirSync(path, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function assertPrivateDirectory(path: string, label: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw discovery(`${label} is not a real directory`);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && stat.uid !== uid) throw discovery(`${label} belongs to another uid`);
  if ((stat.mode & 0o077) !== 0) throw discovery(`${label} is accessible to group or other users`);
}

function readBoundedPrivateText(path: string, maximum: number): string {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw error;
    throw discovery(`private state ${path} could not be opened without following links`, error);
  }
  try {
    const stat = fstatSync(fd);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!stat.isFile() || stat.nlink !== 1 || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
      throw discovery(`private state ${path} has an unsafe file shape, owner, or mode`);
    }
    if (stat.size > maximum) throw discovery(`private state ${path} exceeds ${maximum} bytes`);
    const data = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < data.length) {
      const count = readSync(fd, data, offset, data.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== stat.size) throw discovery(`private state ${path} changed size while being read`);
    const after = fstatSync(fd);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.nlink !== 1) {
      throw discovery(`private state ${path} changed identity while being read`);
    }
    return data.subarray(0, offset).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function assertSourceRegistry(projects: readonly ControlServiceProjectSource[], loaded: LoadedConfig): void {
  if (!Array.isArray(projects)) throw discovery("the control source registry is not an array");
  const expected = new Set(loaded.config.projects.map((project) => project.name));
  const seen = new Set<string>();
  for (const project of projects) {
    if (!expected.has(project.project) || seen.has(project.project) || !Array.isArray(project.runs)) {
      throw discovery("the control source registry has inconsistent project ownership");
    }
    seen.add(project.project);
    const runs = new Set<string>();
    for (const source of project.runs) {
      if (!isValidId(source.runId) || runs.has(source.runId)) {
        throw discovery(`project ${project.project} has inconsistent run ownership`);
      }
      requireDurableSource(source);
      runs.add(source.runId);
    }
  }
  if (seen.size !== expected.size) throw discovery("the control source registry omits a configured project");
}

function requireDurableSource(source: ControlViewSource): DurableControlViewSource {
  const candidate = source as Partial<DurableControlViewSource>;
  if (typeof candidate.subscribe !== "function") {
    throw discovery(`run ${source.runId} does not expose the canonical post-commit wake contract`);
  }
  return source as DurableControlViewSource;
}

function requireReadyForStop(inspection: ControlServiceInspection) {
  if (inspection.state === "ready") return inspection.attachment;
  if (inspection.state === "stopped" || inspection.state === "stale-runfile") {
    throw new ControlServiceError("NOT_RUNNING", `Control service is not running: ${inspection.detail}`);
  }
  throw new ControlServiceError(
    "IDENTITY_MISMATCH",
    `Control owner could not be proven safe to signal (${inspection.state}): ${inspection.detail}`
  );
}

function requireLiveMatch(inspection: ProcessIncarnationInspection): void {
  if (inspection.state === "alive-match") return;
  throw new ControlServiceError(
    "IDENTITY_MISMATCH",
    inspection.state === "dead"
      ? "The recorded control process exited before it could be safely signaled."
      : inspection.state === "alive-mismatch"
        ? "The recorded PID now belongs to another process; no signal was sent."
        : `The control process incarnation could not be verified: ${inspection.detail}`
  );
}

function remainingMs(deadline: number, clock: () => number): number {
  const remaining = deadline - clock();
  if (remaining < 1) throw new ControlServiceError("STOP_TIMEOUT", "Control stop timed out before identity collection completed.");
  return Math.min(60_000, Math.ceil(remaining));
}

function canonicalNow(value: Date): string {
  const timestamp = value.toISOString();
  if (Number.isNaN(value.valueOf()) || new Date(timestamp).toISOString() !== timestamp) {
    throw new TypeError("The control service clock did not return a valid date.");
  }
  return timestamp;
}

function discovery(message: string, cause?: unknown): ControlServiceError {
  return new ControlServiceError("DISCOVERY_FAILED", message, cause === undefined ? undefined : { cause });
}

function startupCleanupFailure(startupError: unknown, cleanupError: unknown): ControlServiceError {
  return new ControlServiceError(
    "DISCOVERY_FAILED",
    "Control service startup cleanup failed; writable-store ownership remains fail-closed until the process exits or cleanup is explicitly retried.",
    { cause: new AggregateError([startupError, cleanupError], "control service startup and cleanup both failed") }
  );
}

function closeStores(stores: readonly ControlStore[]): void {
  let first: unknown;
  for (const store of [...stores].reverse()) {
    try {
      store.close();
    } catch (error) {
      first ??= error;
    }
  }
  if (first !== undefined) throw first;
}

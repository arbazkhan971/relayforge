import { randomBytes } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ProjectConfig, ProviderConfig } from "../config/schema.js";
import { processStartToken } from "../control/process-identity.js";
import { runGit } from "../git.js";
import {
  type RunContext,
  type RunMultiRepositoryAuthorityContext,
  type RunMultiRepositoryAuthorityHandle
} from "../orchestrator.js";
import { createMultiRepositoryIntegrationAuthorityManager } from "./authority.js";
import {
  configuredRepositoryDefinitions,
  materializeConfiguredRepositoryRegistry,
  probeConfiguredRepositoryIdentity
} from "./config.js";
import { createMultiRepositoryControlStoreJournal } from "./control-store.js";
import type { RepositoryRegistryV1 } from "./domain.js";
import { buildProviderChain } from "../routing.js";
import {
  detectSandbox,
  providerPrivateWritableRoots,
  resolveSandboxExecutable,
  trustedRunnerActive,
  verifierNetworkIsolationAvailable
} from "../sandbox.js";
import {
  MultiRepositoryOrchestrationError,
  runMultiRepositoryOrchestration,
  type ContainedMultiRepositoryWorker,
  type MultiRepositoryRunRequestV1,
  type MultiRepositoryWorkerRequestV1,
  type MultiRepositoryWorkerSettlementV1
} from "./orchestration.js";
import type { CandidateVerificationEntryV1, CandidateVerificationObserver, CombinedVerificationExecutor } from "./verification.js";
import type { MultiRepoPublicationAdapter } from "./publication.js";
import {
  createMultiRepositoryWorkerRecoveryStore,
  multiRepositoryWorkerRecoveryKey
} from "./worker-recovery.js";

function privateDirectory(path: string): string {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || realpathSync.native(path) !== resolve(path)) {
    throw new MultiRepositoryOrchestrationError("INVALID_PLAN", `runtime directory ${path} is not an exact private directory`);
  }
  return resolve(path);
}

function immutableTextFile(directory: string, leaf: string, body: string): string {
  const path = resolve(directory, leaf);
  try {
    const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(fd, body, { encoding: "utf8" });
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || readFileSync(path, "utf8") !== body) {
      throw new MultiRepositoryOrchestrationError("CANONICAL_IDENTITY_MISMATCH", `runtime file ${leaf} changed across restart`, true);
    }
  }
  return path;
}

function runtimeManifest(request: MultiRepositoryWorkerRequestV1, goal: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    runId: request.runId,
    runEpoch: request.runEpoch,
    taskId: request.taskId,
    taskGeneration: request.taskGeneration,
    repositorySetId: request.repositorySetId,
    goal,
    repositories: request.members.map((member) => ({
      repositoryId: member.repositoryId,
      path: member.path,
      branch: member.branch,
      anchorOid: member.anchorOid
    }))
  });
}

function providerRouteKeys(project: ProjectConfig, providerKey: string): readonly string[] {
  const chain = buildProviderChain(project, providerKey);
  return Object.freeze(chain.fallback === undefined ? [chain.primary] : [chain.primary, chain.fallback]);
}

/** Exact custom interpreter entrypoint. Later absolute argv values are opaque provider data and are
 * never promoted into mounts merely because they happen to name a host path. */
function providerRuntimeRoots(provider: ProviderConfig): readonly string[] {
  if (provider.type !== "custom" || provider.args.length === 0 || !isAbsolute(provider.args[0]!)) return Object.freeze([]);
  const candidate = resolve(provider.args[0]!);
  const stat = lstatSync(candidate);
  if (!stat.isFile() && !stat.isSymbolicLink()) {
    throw new MultiRepositoryOrchestrationError("CAPABILITY_REFUSED", `custom provider entrypoint ${candidate} is not an exact runtime file`);
  }
  return Object.freeze([realpathSync.native(candidate)]);
}

/** Read-only host capability check shared by CLI (before prepareRun) and direct factory callers. */
export function assertMultiRepositoryExecutionPreflight(project: ProjectConfig, execute: boolean): void {
  const multi = project.multiRepository;
  if (multi === undefined || !execute) return;
  if (!trustedRunnerActive() && (detectSandbox() !== "bwrap" || !verifierNetworkIsolationAvailable())) {
    throw new MultiRepositoryOrchestrationError(
      "CAPABILITY_REFUSED",
      "multi-repository execution requires launchable Linux Bubblewrap with filesystem, PID/IPC/UTS/cgroup, and verifier network namespaces"
    );
  }
  for (const task of multi.tasks) {
    const provider = project.providers[task.provider];
    if (!provider) throw new MultiRepositoryOrchestrationError("INVALID_PLAN", `runtime provider ${task.provider} is absent`);
    const chain = buildProviderChain(project, task.provider);
    if (chain.fallback !== undefined) {
      throw new MultiRepositoryOrchestrationError(
        "CAPABILITY_REFUSED",
        `multi-repository task ${task.id} uses provider fallback ${chain.primary} -> ${chain.fallback}; P6 recovery receipts bind one physical call, so fallback is refused before run state or worktree mutation`
      );
    }
    resolveSandboxExecutable(provider.command ?? provider.type);
    providerRuntimeRoots(provider);
    // Validate provider-selected private state now; an alias, broad/permissive directory or other
    // provider's state is a zero-run-state refusal rather than a post-cutover launch failure.
    providerPrivateWritableRoots(provider.type);
  }
}

function workerGitMetadataRoots(
  registry: RepositoryRegistryV1,
  request: MultiRepositoryWorkerRequestV1
): readonly string[] {
  const identities = new Map(registry.repositories.map((repository) => [repository.repositoryId, repository]));
  const roots: string[] = [];
  for (const member of request.members) {
    const identity = identities.get(member.repositoryId);
    if (!identity) throw new MultiRepositoryOrchestrationError("INVALID_PLAN", `worker repository ${member.repositoryId} is absent from the physical registry`);
    const probed = runGit(member.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (!probed.ok || !probed.out) throw new MultiRepositoryOrchestrationError("WORKTREE_RECOVERY_REQUIRED", `cannot resolve exact Git metadata for ${member.repositoryId}`, true);
    const path = realpathSync.native(isAbsolute(probed.out) ? probed.out : resolve(member.path, probed.out));
    const stat = lstatSync(path);
    if (
      !stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== identity.gitCommonDirDevice ||
      stat.ino !== identity.gitCommonDirInode
    ) {
      throw new MultiRepositoryOrchestrationError("WORKTREE_RECOVERY_REQUIRED", `Git common-directory identity changed for ${member.repositoryId}`, true);
    }
    roots.push(path);
  }
  return Object.freeze([...new Set(roots)].sort((left, right) => left.localeCompare(right)));
}

function createContainedWorker(
  ctx: RunContext,
  context: RunMultiRepositoryAuthorityContext,
  runtimeDir: string,
  registry: RepositoryRegistryV1
): ContainedMultiRepositoryWorker {
  const recovery = createMultiRepositoryWorkerRecoveryStore({
    runtimeDirectory: runtimeDir,
    transcriptDirectory: resolve(context.runDir, "transcripts"),
    ledger: ctx.ledger
  });
  return Object.freeze({
    async run(
      request: MultiRepositoryWorkerRequestV1,
      acknowledgeDispatch: (processIdentity: string) => void
    ): Promise<MultiRepositoryWorkerSettlementV1> {
      const task = context.project.multiRepository?.tasks.find((candidate) => candidate.id === request.taskId);
      if (!task) throw new MultiRepositoryOrchestrationError("INVALID_PLAN", `runtime task ${request.taskId} is absent`);
      const provider = context.project.providers[task.provider];
      if (!provider) throw new MultiRepositoryOrchestrationError("INVALID_PLAN", `runtime provider ${task.provider} is absent`);
      if (request.members.length < 1) throw new MultiRepositoryOrchestrationError("INVALID_PLAN", "contained worker received no authorized repository roots");
      const providerKeys = providerRouteKeys(context.project, task.provider);
      const recoveryKey = multiRepositoryWorkerRecoveryKey(request);
      const manifest = runtimeManifest(request, context.goal);
      const taskDir = privateDirectory(resolve(runtimeDir, request.attemptId));
      const prompt = [
        "You are a RelayForge multi-repository implementation worker.",
        "Only modify repositories in the exact manifest below. Do not create commits, move refs, publish, or access unlisted repositories; the parent owns those operations.",
        "Complete the task across every listed repository and leave each worktree dirty with the intended changes.",
        manifest
      ].join("\n\n");
      const promptPath = immutableTextFile(taskDir, "system-prompt.txt", prompt);
      let processIdentity: string | undefined;
      const result = await context.runWorkerTurn({
        roleId: task.role,
        taskId: request.taskId,
        attemptGeneration: request.taskGeneration,
        launchId: request.attemptId,
        prompt,
        systemPromptFile: promptPath,
        systemPromptText: prompt,
        workCwd: request.members[0]!.path,
        additionalWritableRoots: request.members.slice(1).map((member) => member.path),
        recoveryKey,
        filesystem: Object.freeze({
          mode: "allowlist" as const,
          readableRoots: Object.freeze(workerGitMetadataRoots(registry, request)),
          runtimeRoots: providerRuntimeRoots(provider),
          // Every configured source checkout remains absent. The exact read-only Git common
          // directories needed by authorized worktrees are nested exceptions, mounted individually.
          inaccessibleRoots: Object.freeze(registry.repositories.map((repository) => repository.canonicalRoot))
        }),
        beforeProviderExec(identity) {
          processIdentity = `pid:${identity.pid}:${identity.processStartToken}`;
          acknowledgeDispatch(processIdentity);
        }
      });
      if (processIdentity === undefined) {
        throw new MultiRepositoryOrchestrationError("WORKER_RECOVERY_REQUIRED", "provider returned without the exact acknowledged process identity", true);
      }
      if (!result.ok || result.normalized?.success !== true || !result.settlementCallId || !result.transcriptPath) {
        throw new MultiRepositoryOrchestrationError("WORKER_RECOVERY_REQUIRED", "provider completion has no closed ledger settlement and durable transcript", true);
      }
      // This is the only live settlement returned to P6. The recovery store re-reads the MAC-verified
      // ledger attestation and exact transcript, then publishes/reopens its parent-owned receipt.
      return recovery.record(request, processIdentity, result.settlementCallId, result.transcriptPath, providerKeys);
    },
    async recover(request: MultiRepositoryWorkerRequestV1, processIdentity: string) {
      const task = context.project.multiRepository?.tasks.find((candidate) => candidate.id === request.taskId);
      if (!task) throw new MultiRepositoryOrchestrationError("INVALID_PLAN", `recovery task ${request.taskId} is absent`);
      return recovery.recover(request, processIdentity, providerRouteKeys(context.project, task.provider));
    },
    async proveUnspawned(): Promise<boolean> {
      // This method is called only for a canonical admitted lease with no dispatch acknowledgement.
      // The shared pre-exec gate makes absence of that acknowledgement proof provider exec was closed.
      return true;
    }
  });
}

function verifierEnvironment(request: Parameters<CombinedVerificationExecutor["run"]>[0]): Record<string, string> {
  const environment: Record<string, string> = {
    ...request.environment,
    RELAYFORGE_REPOSITORY_COUNT: String(request.entries.length),
    RELAYFORGE_REPOSITORY_MANIFEST: JSON.stringify(request.entries.map((entry, index) => ({ index, repositoryId: entry.repositoryId, path: entry.canonicalWorkspacePath })))
  };
  for (const [index, entry] of request.entries.entries()) {
    environment[`RELAYFORGE_REPO_${index}_ID`] = entry.repositoryId;
    environment[`RELAYFORGE_REPO_${index}_PATH`] = entry.canonicalWorkspacePath;
  }
  return environment;
}

function createVerifier(context: RunMultiRepositoryAuthorityContext): CombinedVerificationExecutor {
  return Object.freeze({
    async run(request: Parameters<CombinedVerificationExecutor["run"]>[0]) {
      return await context.runVerification({
        transactionId: request.transactionId,
        commandIndex: request.commandIndex,
        command: request.command,
        workCwd: request.entries[0]!.canonicalWorkspacePath,
        workspaceRoots: Object.freeze(request.entries.map((entry) => entry.canonicalWorkspacePath)),
        environment: verifierEnvironment(request)
      });
    }
  });
}

function createCandidateObserver(): CandidateVerificationObserver {
  return Object.freeze({
    observe(entry: CandidateVerificationEntryV1) {
      let identityExact = false;
      try {
        identityExact = realpathSync.native(entry.canonicalWorkspacePath) === resolve(entry.canonicalWorkspacePath) && lstatSync(entry.canonicalWorkspacePath).isDirectory();
      } catch { identityExact = false; }
      const candidate = runGit(entry.canonicalWorkspacePath, ["rev-parse", "--verify", `${entry.candidateOid}^{commit}`]);
      const tree = runGit(entry.canonicalWorkspacePath, ["rev-parse", "--verify", `${entry.candidateOid}^{tree}`]);
      const status = runGit(entry.canonicalWorkspacePath, ["status", "--porcelain", "--untracked-files=all"]);
      return Object.freeze({
        candidateOid: candidate.ok ? candidate.out : "",
        treeOid: tree.ok ? tree.out : "",
        clean: status.ok && status.out === "",
        identityExact
      });
    }
  });
}

function requestFromConfiguration(context: RunMultiRepositoryAuthorityContext): MultiRepositoryRunRequestV1 {
  const multi = context.project.multiRepository;
  if (!multi) throw new MultiRepositoryOrchestrationError("INVALID_PLAN", "multi-repository runtime requires the explicit project plan");
  return Object.freeze({
    schemaVersion: 1,
    runId: context.runId,
    runEpoch: context.runEpoch,
    workspaceRoot: resolve(context.runDir, "multirepo-worktrees"),
    execute: context.execute,
    repositoryDefinitions: configuredRepositoryDefinitions(context.project),
    tasks: Object.freeze(multi.tasks.map((task) => Object.freeze({
      schemaVersion: 1 as const,
      taskId: task.id,
      taskGeneration: task.generation,
      roleId: task.role,
      providerId: task.provider,
      repositoryIds: Object.freeze([...task.repositories]),
      dependencies: Object.freeze([...task.dependsOn])
    }))),
    executions: Object.freeze(multi.tasks.map((task) => Object.freeze({
      taskId: task.id,
      priority: task.priority,
      entries: Object.freeze(task.entries.map((entry) => Object.freeze({
        repositoryId: entry.repository,
        branch: entry.branch,
        targetRef: entry.targetRef,
        provision: Object.freeze(entry.provision.map((spec) => Object.freeze({ ...spec, ...(spec.requiredExecutables ? { requiredExecutables: Object.freeze([...spec.requiredExecutables]) } : {}) })))
      }))),
      verifyCommands: Object.freeze([...task.verifyCommands]),
      verifyEnvironment: Object.freeze({ ...task.verifyEnvironment }),
      commitMessage: task.commitMessage,
      ...(task.publication ? {
        publication: Object.freeze({
          policyApproved: true as const,
          entries: Object.freeze(task.publication.entries.map((entry) => Object.freeze({
            repositoryId: entry.repository,
            publicationId: entry.publicationId,
            remoteName: entry.remoteName,
            expectedPushUrl: entry.expectedPushUrl,
            remoteRef: entry.remoteRef,
            expectedRemoteOid: entry.expectedRemoteOid,
            baseRef: entry.baseRef,
            title: entry.title,
            body: entry.body
          })))
        })
      } : {})
    }))),
    capabilities: Object.freeze({
      roles: Object.freeze(Object.fromEntries(context.project.roles.filter((role) => role.repositories.length > 0).map((role) => [role.name, Object.freeze([...role.repositories])]))),
      providers: Object.freeze(Object.fromEntries(Object.entries(multi.providerRepositories).map(([id, repositories]) => [id, Object.freeze([...repositories])])))
    })
  });
}

/**
 * Product capability gate. Keep it before runtime-directory creation, journal append, worktree
 * materialization, provider launch and every external effect. The config validator invokes the same
 * restrictions before prepareRun; this duplicate boundary protects direct library callers.
 */
export type MultiRepositoryRunAuthorityOptions = Readonly<{
  /** Exact parent-held P3 capability. Absence keeps publication as a zero-mutation refusal. */
  publicationAdapter?: MultiRepoPublicationAdapter;
}>;

function assertProductMultiRepositoryCapabilities(
  context: RunMultiRepositoryAuthorityContext,
  options: MultiRepositoryRunAuthorityOptions
): void {
  const multi = context.project.multiRepository;
  if (!multi) throw new MultiRepositoryOrchestrationError("INVALID_PLAN", "multi-repository runtime requires the explicit project plan");
  for (const task of multi.tasks) {
    const provider = context.project.providers[task.provider];
    if (!provider) throw new MultiRepositoryOrchestrationError("INVALID_PLAN", `runtime provider ${task.provider} is absent`);
    const chain = buildProviderChain(context.project, task.provider);
    if (chain.fallback !== undefined) throw new MultiRepositoryOrchestrationError(
      "CAPABILITY_REFUSED",
      `provider ${task.provider} fallback is unavailable for P6 because the durable worker receipt binds one physical call`
    );
    if (task.publication !== undefined && options.publicationAdapter === undefined) {
      throw new MultiRepositoryOrchestrationError(
        "CAPABILITY_REFUSED",
        "multi-repository publication is unavailable until a bounded SCM branch/PR/cross-link adapter is attached; refusing before canonical or worktree mutation"
      );
    }
  }
}

/** Product P6 factory. It borrows the exact P1 store and returns only after every child/lock drains. */
export function createMultiRepositoryRunAuthority(
  ctx: RunContext,
  context: RunMultiRepositoryAuthorityContext,
  options: MultiRepositoryRunAuthorityOptions = {}
): RunMultiRepositoryAuthorityHandle {
  if (context.store !== ctx.controlAuthority?.store || context.runId !== ctx.runId || context.runEpoch !== ctx.runNonce) {
    throw new MultiRepositoryOrchestrationError("CANONICAL_IDENTITY_MISMATCH", "P6 factory did not receive the exact borrowed run authority", true);
  }
  assertMultiRepositoryExecutionPreflight(context.project, context.execute);
  assertProductMultiRepositoryCapabilities(context, options);
  const registry: RepositoryRegistryV1 = materializeConfiguredRepositoryRegistry(ctx.loaded.rootDir, context.project);
  const runtimeDir = privateDirectory(resolve(context.runDir, "multirepo-runtime"));
  const journal = createMultiRepositoryControlStoreJournal({ store: context.store, runId: context.runId, runEpoch: context.runEpoch });
  const integrationAuthority = createMultiRepositoryIntegrationAuthorityManager(registry);
  const request = requestFromConfiguration(context);
  let runPromise: Promise<Awaited<ReturnType<typeof runMultiRepositoryOrchestration>>> | undefined;
  let retainAuthority = false;
  let runError: unknown;
  return Object.freeze({
    run() {
      runPromise ??= runMultiRepositoryOrchestration(request, {
        resolveRepositoryIdentity: (definition) => probeConfiguredRepositoryIdentity(ctx.loaded.rootDir, definition),
        journal,
        worker: createContainedWorker(ctx, context, runtimeDir, registry),
        integrationAuthority,
        integration: {
          verificationObserver: createCandidateObserver(),
          verificationExecutor: createVerifier(context),
          verifiedAt: () => new Date().toISOString()
        },
        ...(options.publicationAdapter === undefined ? {} : { publicationAdapter: options.publicationAdapter }),
        concurrency: context.project.multiRepository!.scheduler,
        ownerId: `parent-${process.pid}`,
        ownerIncarnation: processStartToken(),
        randomToken: () => randomBytes(32).toString("hex")
      }).catch((error) => {
        runError = error;
        if (error instanceof MultiRepositoryOrchestrationError && error.authorityMustRemainHeld) retainAuthority = true;
        throw error;
      });
      return runPromise;
    },
    async closeAndDrain(): Promise<void> {
      if (runPromise) await runPromise.catch(() => undefined);
      if (runError !== undefined) throw runError;
      if (retainAuthority) throw new MultiRepositoryOrchestrationError("INTEGRATION_RECOVERY_REQUIRED", "P6 encountered an uncertain canonical/external transition; authority is retained", true);
      integrationAuthority.assertDrained();
    }
  });
}

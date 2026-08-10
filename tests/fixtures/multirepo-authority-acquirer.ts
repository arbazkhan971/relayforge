import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import {
  createMultiRepositoryIntegrationAuthorityManager,
  type MultiRepositoryIntegrationAuthorityAcquireFaultPoint
} from "../../src/multirepo/authority.js";
import type { RepositoryRegistryV1 } from "../../src/multirepo/domain.js";

const [registryPath, mode, resultPath] = process.argv.slice(2);
if (!registryPath || !mode || !resultPath) process.exit(64);

function publish(value: string): void {
  const fd = openSync(resultPath!, "wx", 0o600);
  try {
    const bytes = Buffer.from(`${value}\n`, "utf8");
    writeSync(fd, bytes, 0, bytes.length, 0);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

const registry = JSON.parse(readFileSync(registryPath, "utf8")) as RepositoryRegistryV1;
const faultPoint = mode.startsWith("fault:")
  ? mode.slice("fault:".length) as MultiRepositoryIntegrationAuthorityAcquireFaultPoint
  : undefined;
const manager = createMultiRepositoryIntegrationAuthorityManager(registry, faultPoint === undefined ? {} : {
  acquireFault(point) {
    if (point !== faultPoint) return;
    publish(`FAULT ${point}`);
    process.kill(process.pid, "SIGKILL");
  }
});

try {
  await manager.acquire(["alpha"], {
    runId: `run-child-${process.pid}`,
    runEpoch: `epoch-child-${process.pid}`,
    taskId: `task-child-${process.pid}`,
    taskGeneration: 1,
    leaseToken: `child-${process.pid}-`.padEnd(64, "a").slice(0, 64)
  });
  publish("ACQUIRED");
  setInterval(() => undefined, 1_000);
} catch (error) {
  publish(`REFUSED ${error instanceof Error ? error.message : String(error)}`);
  process.exit(73);
}

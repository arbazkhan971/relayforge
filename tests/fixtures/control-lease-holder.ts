import { controlPaths, newControlRunFile } from "../../src/control/runfile.js";
import { acquireControlLease } from "../../src/control/lease.js";
import { processStartToken } from "../../src/control/process-identity.js";

const [rootDir, configPath] = process.argv.slice(2);
if (!rootDir || !configPath) process.exit(64);
const paths = controlPaths(rootDir, configPath);
const owner = newControlRunFile({
  configId: paths.configId,
  pid: process.pid,
  processStartToken: processStartToken(),
  port: 4318,
  startedAt: new Date().toISOString()
});
const result = acquireControlLease(paths, owner);
if (!result.acquired) process.exit(73);
process.stdout.write(`READY ${owner.instanceId}\n`);
const finish = () => {
  result.lease.release();
  process.exit(0);
};
process.on("SIGTERM", finish);
process.on("SIGINT", finish);
setInterval(() => undefined, 1_000);

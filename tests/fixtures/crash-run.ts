// A REAL run, in a REAL child process, that the test SIGKILLs mid-attempt.
//
// This is the only honest way to test crash recovery: an in-process "simulated crash" would still
// unwind the stack, run `finally` blocks, release the lease, and let the board reach a terminal state
// — i.e. it would test the one thing a crash does NOT do. So we drive the actual loop here and let
// the parent kill the whole process group while an attempt is in flight.
//
// argv: <repoDir> <runId>
import { loadConfig } from "../../src/config/load.js";
import { prepareRun, runAutonomyLoop, writeRolePrompts } from "../../src/orchestrator.js";
import { setTrustedRunner } from "../../src/sandbox.js";

const [repoDir, runId] = process.argv.slice(2);
setTrustedRunner(true); // same trusted-fixture seam the e2e suite uses; never reachable in production

const loaded = loadConfig(`${repoDir}/loop.config.yaml`);
const project = loaded.config.projects[0];
const ctx = prepareRun(loaded, project, runId, "Deliver the feature");
writeRolePrompts(ctx);
await runAutonomyLoop(ctx, {}, { execute: true });

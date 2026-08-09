// Host-independent fallback for this E2E. A capable Linux host executes src/cli.ts directly with
// real Bubblewrap + cgroup-v2 containment. A host without those primitives imports the exact same
// CLI only after enabling the repository's import-only trusted-fixture seam.
import { setTrustedRunner } from "../../src/sandbox.js";

setTrustedRunner(true);
await import("../../src/cli.js");

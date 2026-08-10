import { defineConfig } from "vitest/config";

const requiredCgroupGate = process.env.RELAYFORGE_TEST_REQUIRE_CGROUP === "1";

// The streaming retention gates must force a collection BEFORE measuring RSS/arrayBuffers — otherwise
// they measure garbage that merely has not been collected yet instead of what the pipeline RETAINS.
// `poolOptions.forks.execArgv` is not applied by vitest 4, but forked workers inherit this process's
// environment, and Node applies NODE_OPTIONS at worker startup. (Config is evaluated in the main
// process, before any worker is forked.)
if (!(process.env.NODE_OPTIONS ?? "").includes("--expose-gc")) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --expose-gc`.trim();
}

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // This is a subprocess-heavy integration suite: E2E runs real provider/verifier processes and
    // the lease stress test spawns 50 concurrent OS processes. Under that parallel load, tests that
    // shell out to `tsx`/the CLI legitimately take several seconds, so the 5s default is too tight.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // CAP default parallelism: this suite spawns real process trees (E2E providers/verifiers, a 50-way
    // lease race, >16 MiB flood children). Left uncapped, N test files × their own subprocess fan-out
    // would create dozens of overlapping process trees and starve cores. Bound the worker pool to a
    // modest fraction of cores; the explicit concurrency stress tests still exercise real contention
    // inside a single worker. Isolated stress work opts into higher fan-out deliberately, not by default.
    pool: "forks",
    // WHY 2 AND NOT 4: several tests assert WALL-CLOCK product guarantees — the streaming pipeline
    // digests 6M newlines in <60s, a timed-out provider's descendants die within a bounded window.
    // A worker here is never one process: each spawns real process trees (providers, verifiers, a
    // 50-way lease race, CLI subprocesses, tmux servers). At 4 workers those trees oversubscribed the
    // box, so those assertions measured CONTENTION rather than the product, and failed intermittently
    // (observed: the 6M-newline flood taking 33s standalone but 69-100s under load, tripping its 60s
    // budget in ~half of full-suite runs). Two workers keeps the runnable-process count inside the core
    // count, so a red result means the product is slow — which is the only thing these budgets are for.
    // The cost is real (~145s vs ~92s wall); determinism is worth more than 50 seconds.
    // The required-cgroup release matrix also contains an exact limit test that deliberately fills
    // all 256 descendants in the delegated root. Running another strong-backend file beside it can
    // correctly receive EAGAIN and then look like a product failure (observed in the OpenCode
    // version probe and P2 final verifier). Serialize only this explicit release gate; ordinary
    // development retains two workers, while the required-host matrix proves each scope against an
    // otherwise quiescent delegated root.
    maxWorkers: requiredCgroupGate ? 1 : 2,
    minWorkers: 1,
    // Disable the optional tmux viewport for the whole test process (see tests/setup.ts).
    setupFiles: ["./tests/setup.ts"],
    // Leave no tmux viewport sessions or disposable temp state behind. globalSetup points TMPDIR at a
    // token-named root before the pool forks, so every `tmpdir()` temp dir — in-worker and in spawned
    // children alike — is CONTAINED in one subtree that teardown removes, rather than relying on each
    // call site to remember to register itself (they did not: a run used to abandon ~317 /tmp/loop-*
    // dirs). See tests/global-teardown.ts.
    globalSetup: ["./tests/global-teardown.ts"]
  }
});

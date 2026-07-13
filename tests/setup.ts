// Per-worker test setup. Disable the OPTIONAL tmux viewport so runs (in-process AND the CLI
// subprocesses the tests spawn, which inherit this env) never open real tmux sessions on the host.
// tmux is observational only — this cannot change run correctness — and it keeps the test process
// from leaving `loop-*` sessions behind. Production leaves LOOP_TMUX unset, so the viewport works.
process.env.LOOP_TMUX = "off";

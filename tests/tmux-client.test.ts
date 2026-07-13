import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOOP_OWNER, TmuxClient, TmuxConflictError } from "../src/tmux-client.js";
import { sessionName } from "../src/tmux-name.js";
import { killViewport, openViewport, planViewport, pruneViewport, showViewport, TmuxExit, ViewportHost } from "../src/tmux-workflow.js";

/**
 * REAL tmux, on a PRIVATE `-S` socket in a temp dir, so these tests never see or touch the user's
 * default tmux server. This is the proportionate smoke layer: the exhaustive decision matrix lives in
 * tmux-workflow.test.ts against a fake, while THESE tests prove our assumptions about tmux ITSELF —
 * name rewriting, duplicate-session errors, dead panes, and a genuine multi-process race.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsxPath = resolve(repoRoot, "node_modules/tsx/dist/cli.mjs");
const fixture = resolve(repoRoot, "tests/fixtures/tmux-ensure.ts");

const tmuxInstalled = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const d = tmuxInstalled ? describe : describe.skip;

const ROLES = [
  { name: "planner", title: "Planner" },
  { name: "dev", title: "Developer" }
];

d("TmuxClient — real tmux on a private socket", () => {
  let socket: string;
  let client: TmuxClient;
  const raw = (args: string[]) => spawnSync("tmux", ["-S", socket, ...args], { encoding: "utf8" });

  beforeEach(() => {
    socket = join(mkdtempSync(join(tmpdir(), "loop-tmux-sock-")), "s.sock");
    client = new TmuxClient({ socket, version: "test" });
  });
  afterEach(() => {
    client.killServer(); // tear down the private server only
  });

  it("creates an owned session with identity metadata and one titled pane per role", () => {
    const id = { namespace: "loop", project: "alpha", run: "shared", role: "team" };
    const result = client.ensureSession(id, tmpdir(), { panes: ROLES });

    expect(result.created).toBe(true);
    expect(client.hasSession(result.name)).toBe(true);
    expect(client.hasSession(result.name.slice(0, -2))).toBe(false); // NOT a prefix match
    expect(client.identityOf(result.name)).toMatchObject({ namespace: "loop", project: "alpha", run: "shared", role: "team" });
    expect(client.isOwned(id)).toBe(true);
    // One real pane per role, each carrying the role's title.
    expect(Object.keys(result.panes)).toEqual(["planner", "dev"]);
    expect(client.panesByRole(result.name)).toEqual(result.panes);
    expect(raw(["show-options", "-v", "-t", result.name, "@loop-owner"]).stdout.trim()).toBe(LOOP_OWNER);
  });

  it("REGRESSION: a dotted project name survives tmux verbatim — the name we predict IS the session tmux has", () => {
    // tmux SILENTLY rewrites `.` and `:` in a session name to `_`. When the sanitizer allowed them, the
    // predicted name never matched the real one, so has-session/capture/kill all missed — and two
    // different projects (`web.api`, `web_api`) collapsed onto ONE session.
    const dotted = { namespace: "loop", project: "web.api", run: "r1", role: "team" };
    const under = { namespace: "loop", project: "web_api", run: "r1", role: "team" };

    const a = client.ensureSession(dotted, tmpdir(), { panes: ROLES });
    const b = client.ensureSession(under, tmpdir(), { panes: ROLES });

    expect(a.name).not.toBe(b.name);
    expect(a.name).not.toMatch(/[.:]/);
    // The decisive check: tmux itself reports BOTH sessions, under exactly the names we predicted.
    const live = raw(["list-sessions", "-F", "#{session_name}"]).stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    expect(live.sort()).toEqual([a.name, b.name].sort());
    expect(client.isOwned(dotted)).toBe(true);
    expect(client.isOwned(under)).toBe(true);
    // And each identity captures ITS OWN session — no cross-adoption.
    expect(client.identityOf(a.name)!.project).toBe("web.api");
    expect(client.identityOf(b.name)!.project).toBe("web_api");
  });

  it("is idempotent against real tmux: a second ensureSession adopts rather than duplicating", () => {
    const id = { namespace: "loop", project: "alpha", run: "r1", role: "team" };
    const first = client.ensureSession(id, tmpdir(), { panes: ROLES });
    const second = client.ensureSession(id, tmpdir(), { panes: ROLES });

    expect(second.created).toBe(false);
    expect(second.name).toBe(first.name);
    expect(second.panes).toEqual(first.panes);
    expect(raw(["list-sessions", "-F", "#{session_name}"]).stdout.trim().split("\n")).toHaveLength(1);
  });

  it("stop kills ONLY the exact project+run owned sessions — alpha/beta/hyphen-decoys stay isolated", () => {
    const mk = (project: string, run: string) => client.ensureSession({ namespace: "loop", project, run, role: "team" }, tmpdir(), { panes: ROLES }).name;
    const alpha = mk("alpha", "shared");
    const beta = mk("beta", "shared");
    // Hyphen-boundary decoys: a substring/prefix match on "alpha"/"shared" would wrongly catch these.
    const decoy1 = mk("alph", "a-shared");
    const decoy2 = mk("alpha-shared", "x");

    expect(client.stopRun("loop", "alpha", "shared")).toEqual([alpha]);
    expect(client.hasSession(alpha)).toBe(false);
    expect(client.hasSession(beta)).toBe(true);
    expect(client.hasSession(decoy1)).toBe(true);
    expect(client.hasSession(decoy2)).toBe(true);
  });

  it("a manually created STALE predicted-name session (no metadata) is NOT owned, NOT killed, NOT adopted", () => {
    const id = { namespace: "loop", project: "gamma", run: "r1", role: "team" };
    const predicted = client.sessionNameFor(id);
    expect(raw(["new-session", "-d", "-s", predicted]).status).toBe(0); // someone else's session

    expect(client.hasSession(predicted)).toBe(true);
    expect(client.isOwned(id)).toBe(false);
    expect(client.identityOf(predicted)).toBeUndefined();
    expect(client.stopRun("loop", "gamma", "r1")).toEqual([]);
    expect(client.hasSession(predicted)).toBe(true);
    expect(() => client.ensureSession(id, tmpdir(), { panes: ROLES })).toThrow(TmuxConflictError);
    expect(client.hasSession(predicted)).toBe(true); // still alive after the refusal
  });

  it("capture uses an exact OWNED target and returns undefined for a non-owned identity", () => {
    client.ensureSession({ namespace: "loop", project: "alpha", run: "shared", role: "team" }, tmpdir(), { panes: ROLES });
    expect(client.capture({ namespace: "loop", project: "alpha", run: "shared", role: "team" })).toBeDefined();
    expect(client.capture({ namespace: "loop", project: "alpha", run: "other", role: "team" })).toBeUndefined();
  });

  it("detects a DEAD viewport (every pane's process exited) — the prune signal", () => {
    const id = { namespace: "loop", project: "alpha", run: "r1", role: "team" };
    const { name, panes } = client.ensureSession(id, tmpdir(), { panes: [ROLES[0]] });
    expect(client.allPanesDead(name)).toBe(false);

    // Keep the corpse visible (tmux would otherwise destroy the session), then let the pane's process exit.
    raw(["set-option", "-g", "remain-on-exit", "on"]);
    raw(["respawn-pane", "-k", "-t", panes.planner, "true"]);
    for (let i = 0; i < 40 && !client.allPanesDead(name); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);

    expect(client.allPanesDead(name)).toBe(true);
    expect(client.ownedSessions().find((s) => s.name === name)!.dead).toBe(true);
  });

  it("ignores tmux's default pane title (the HOSTNAME) instead of inventing a role from it", () => {
    const id = { namespace: "loop", project: "alpha", run: "r1", role: "team" };
    const name = client.sessionNameFor(id);
    // An owned session whose panes we never titled: panesByRole must map NOTHING, not `{"<hostname>": "%0"}`.
    client.ensureSession(id, tmpdir(), {});
    expect(client.panesByRole(name)).toEqual({});
  });

  it("distinguishes a reachable-but-empty server from a missing one truthfully", () => {
    expect(client.serverReachable()).toBe(true);
    expect(client.ownedSessions()).toEqual([]);
    const missing = new TmuxClient({ socket, runner: () => ({ status: 1, stdout: "", stderr: "no server" }) });
    expect(missing.serverReachable()).toBe(false);
  });

  it("attachArgv switches the client when nested and attaches when not (never nests)", () => {
    const name = client.ensureSession({ namespace: "loop", project: "alpha", run: "r1", role: "team" }, tmpdir(), { panes: ROLES }).name;
    expect(client.attachArgv(name, false)).toEqual(["attach-session", "-t", `=${name}`]);
    expect(client.attachArgv(name, true)).toEqual(["switch-client", "-t", `=${name}`]);
  });

  /**
   * The viewport WORKFLOW against real tmux, in-process. The CLI wiring is proven once, end to end, in
   * cli.test.ts; driving each of these scenarios through the CLI as well would cost a process boot
   * apiece (a full tsx transpile of the whole import graph) and starve the CPU-bound throughput tests
   * running in sibling workers. Same real tmux, same assertions, no subprocess.
   */
  describe("workflow (pre → new → new → show → kill → prune) against real tmux", () => {
    const HOST: ViewportHost = { installed: true, enabled: true, insideTmux: false, interactive: false };
    const ID = { namespace: "loop", project: "demo", run: "r1", role: "team" };
    const req = { identity: ID, cwd: tmpdir(), roles: ROLES };

    it("pre plans it, new creates it, new again ADOPTS it, show finds it, kill reaps it", () => {
      // pre: read-only. It must not leave a session behind.
      const plan = planViewport(client, HOST, req);
      expect(plan.ok).toBe(true);
      expect(plan.existing).toBe("none");
      expect(client.hasSession(plan.session)).toBe(false);

      // new: creates it, detached (this is not a TTY), and tells the human how to attach.
      const first = openViewport(client, HOST, req);
      expect(first.code).toBe(TmuxExit.OK);
      expect(first.created).toBe(true);
      expect(first.attached).toBe(false);
      expect(first.manualCommand).toBe(`tmux attach -t ${first.session}`);
      expect(Object.keys(first.panes)).toEqual(["planner", "dev"]);

      // new again: idempotent — the same session and the same panes, never a duplicate.
      const second = openViewport(client, HOST, req);
      expect(second.created).toBe(false);
      expect(second.session).toBe(first.session);
      expect(second.panes).toEqual(first.panes);
      expect(raw(["list-sessions", "-F", "#{session_name}"]).stdout.split("\n").filter(Boolean)).toEqual([first.session]);

      // show: exactly our owned session, with identity and panes.
      const report = showViewport(client, HOST, { namespace: "loop", project: "demo", knownRuns: ["r1"] });
      expect(report.sessions.map((s) => s.name)).toEqual([first.session]);
      expect(report.sessions[0].orphan).toBe(false);
      expect(report.sessions[0].panes).toEqual(first.panes);

      // kill: gone, and tmux agrees.
      expect(killViewport(client, HOST, { namespace: "loop", project: "demo", run: "r1" }).killed).toEqual([first.session]);
      expect(client.hasSession(first.session)).toBe(false);
      expect(showViewport(client, HOST, { namespace: "loop", project: "demo", run: "r1" }).code).toBe(TmuxExit.NOT_FOUND);
    });

    it("refuses a FOREIGN session squatting the name (exit 3) and never kills or prunes it", () => {
      const name = client.sessionNameFor(ID);
      expect(raw(["new-session", "-d", "-s", name]).status).toBe(0); // a human's own session

      expect(planViewport(client, HOST, req).code).toBe(TmuxExit.CONFLICT);
      const opened = openViewport(client, HOST, req);
      expect(opened.code).toBe(TmuxExit.CONFLICT);
      expect(opened.created).toBe(false);

      // Neither kill nor prune may reap it — it is not ours.
      expect(killViewport(client, HOST, { namespace: "loop", project: "demo", run: "r1" }).killed).toEqual([]);
      expect(pruneViewport(client, HOST, { namespace: "loop", isRunLive: () => false }).pruned).toEqual([]);
      expect(client.hasSession(name)).toBe(true); // still alive, still theirs
    });

    it("prune reaps an ORPHANED viewport (its run is gone) but keeps a live one", () => {
      const live = openViewport(client, HOST, req);
      const orphan = openViewport(client, HOST, { ...req, identity: { ...ID, run: "r2" } });

      const dry = pruneViewport(client, HOST, { namespace: "loop", project: "demo", isRunLive: (r) => r === "r1", dryRun: true });
      expect(dry.pruned.map((p) => p.session)).toEqual([orphan.session]);
      expect(client.hasSession(orphan.session)).toBe(true); // --dry-run really did not kill

      const real = pruneViewport(client, HOST, { namespace: "loop", project: "demo", isRunLive: (r) => r === "r1" });
      expect(real.pruned).toEqual([{ session: orphan.session, run: "r2", reason: "orphaned-run" }]);
      expect(client.hasSession(orphan.session)).toBe(false);
      expect(client.hasSession(live.session)).toBe(true); // the healthy viewport survives
    });
  });

  it("CONCURRENCY (real processes, real tmux): 4 simultaneous ensureSession calls create exactly ONE session", async () => {
    const id = { namespace: "loop", project: "race", run: "r1", role: "team" };
    const expected = sessionName("loop", "race", "r1", "team");

    // Real OS processes: in-process spawnSync would serialize and prove nothing about the race.
    const children = Array.from({ length: 4 }, () =>
      new Promise<{ status: number; stdout: string; stderr: string }>((done) => {
        const child = spawn(process.execPath, [tsxPath, fixture, socket, id.namespace, id.project, id.run, id.role], {
          encoding: "utf8"
        } as never);
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (c) => (stdout += c));
        child.stderr.on("data", (c) => (stderr += c));
        child.on("close", (status) => done({ status: status ?? 1, stdout, stderr }));
      })
    );
    const results = await Promise.all(children);

    // Every racer succeeded — the loser of the `duplicate session` race ADOPTED, it did not fail.
    for (const r of results) expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    const parsed = results.map((r) => JSON.parse(r.stdout) as { created: boolean; name: string; panes: Record<string, string> });
    expect(parsed.every((p) => p.name === expected)).toBe(true);
    // Exactly one process created it; the other four adopted the very same panes.
    expect(parsed.filter((p) => p.created)).toHaveLength(1);
    for (const p of parsed) expect(Object.keys(p.panes)).toEqual(["planner", "dev"]);

    // And tmux itself holds exactly ONE session, with both panes.
    const live = raw(["list-sessions", "-F", "#{session_name}"]).stdout.split("\n").filter(Boolean);
    expect(live).toEqual([expected]);
    expect(raw(["list-panes", "-t", expected, "-F", "#{pane_id}"]).stdout.split("\n").filter(Boolean)).toHaveLength(2);
  });
});

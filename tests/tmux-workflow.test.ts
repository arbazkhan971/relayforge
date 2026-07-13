import { describe, expect, it } from "vitest";
import { LOOP_OWNER, SessionIdentity, TmuxClient } from "../src/tmux-client.js";
import { sessionName, TMUX_NAME_PATTERN } from "../src/tmux-name.js";
import {
  detectHost,
  killViewport,
  openViewport,
  planViewport,
  pruneViewport,
  showViewport,
  TmuxExit,
  ViewportHost
} from "../src/tmux-workflow.js";
import { FakeTmux } from "./fake-tmux.js";

/**
 * The tmux usability slice, end to end, against a faithful in-memory tmux. Every branch a human can
 * hit — no tmux, viewport off, already inside tmux, piped/non-TTY, a foreign session squatting the
 * name, two invocations racing, a dead/orphaned viewport — is decided here deterministically.
 */

const ID: SessionIdentity = { namespace: "loop", project: "demo", run: "r1", role: "team" };
const ROLES = [
  { name: "planner", title: "Planner" },
  { name: "dev", title: "Developer" }
];
const CWD = "/work/demo";

const HOST: ViewportHost = { installed: true, enabled: true, insideTmux: false, interactive: true };
const host = (over: Partial<ViewportHost> = {}): ViewportHost => ({ ...HOST, ...over });

function harness(over: Partial<ViewportHost> = {}) {
  const fake = new FakeTmux();
  const client = new TmuxClient({ runner: fake.runner, attachImpl: fake.attachImpl, sleep: () => {}, adoptTimeoutMs: 200 });
  return { fake, client, host: host(over), req: { identity: ID, cwd: CWD, roles: ROLES } };
}

/** The metadata a genuinely Loop-owned session carries. */
const ownedMeta = (id: SessionIdentity = ID) => ({
  "@loop-owner": LOOP_OWNER,
  "@loop-namespace": id.namespace,
  "@loop-project": id.project,
  "@loop-run": id.run,
  "@loop-role": id.role,
  "@loop-ready": "1"
});

describe("tmux viewport — host matrix (non-tmux, disabled, nested, non-TTY)", () => {
  it("no tmux installed: `pre` and `new` exit UNAVAILABLE(2), explain, and touch nothing", () => {
    const { fake, client, req } = harness();
    const noTmux = host({ installed: false });

    const plan = planViewport(client, noTmux, req);
    expect(plan.code).toBe(TmuxExit.UNAVAILABLE);
    expect(plan.ok).toBe(false);
    expect(plan.action).toBe("blocked");
    expect(plan.reason).toMatch(/not installed/i);
    expect(plan.hint).toMatch(/optional|headless|loop monitor/i);

    const opened = openViewport(client, noTmux, req);
    expect(opened.code).toBe(TmuxExit.UNAVAILABLE);
    // The loop must never be blocked by a missing viewport: nothing was created, nothing was attached.
    expect(fake.sessions.size).toBe(0);
    expect(fake.attaches).toEqual([]);
  });

  it("viewport switched off (LOOP_TMUX=off / defaults.viewport: false): UNAVAILABLE(2), with a DIFFERENT fix", () => {
    const { client, fake, req } = harness();
    const off = host({ enabled: false });

    const plan = planViewport(client, off, req);
    expect(plan.code).toBe(TmuxExit.UNAVAILABLE);
    // "not installed" and "you turned it off" need different fixes — they must not be conflated.
    expect(plan.reason).toMatch(/switched off/i);
    expect(plan.reason).not.toMatch(/not installed/i);
    expect(plan.hint).toMatch(/LOOP_TMUX|viewport/i);
    expect(openViewport(client, off, req).created).toBe(false);
    expect(fake.sessions.size).toBe(0);
  });

  it("inside tmux: SWITCHES the client — never nests an attach-session", () => {
    const { fake, client, req } = harness({ insideTmux: true });
    const nested = host({ insideTmux: true });

    const plan = planViewport(client, nested, req);
    expect(plan.action).toBe("switch-client");
    expect(plan.attachArgv).toEqual(["switch-client", "-t", `=${plan.session}`]);

    const opened = openViewport(client, nested, req);
    expect(opened.attached).toBe(true);
    expect(opened.code).toBe(TmuxExit.OK);
    expect(fake.attaches).toEqual([["switch-client", "-t", `=${opened.session}`]]);
    // `attach-session` inside tmux is the classic "sessions should be nested with care" failure.
    expect(fake.attaches.flat()).not.toContain("attach-session");
  });

  it("outside tmux and interactive: attaches THIS terminal with an exact target", () => {
    const { fake, client, host: h, req } = harness();
    const opened = openViewport(client, h, req);
    expect(opened.action).toBe("create-and-attach");
    expect(fake.attaches).toEqual([["attach-session", "-t", `=${opened.session}`]]);
    expect(opened.code).toBe(TmuxExit.OK);
  });

  it("builds ONE titled pane per role — the whole team on one screen", () => {
    const { fake, client, host: h, req } = harness();
    const opened = openViewport(client, h, req);

    // Regression: `split-window -t =name` silently fails (tmux reads `=name` as a literal pane target),
    // which produced a one-pane viewport no matter how many roles the team had.
    expect(Object.keys(opened.panes)).toEqual(["planner", "dev"]);
    const session = fake.sessions.get(opened.session)!;
    expect(session.panes).toHaveLength(2);
    expect(session.panes.map((p) => p.title)).toEqual(["planner · Planner", "dev · Developer"]);
  });

  it("non-TTY (piped / CI): creates the session DETACHED and prints the attach command instead of failing", () => {
    const { fake, client, req } = harness();
    const piped = host({ interactive: false });

    const plan = planViewport(client, piped, req);
    expect(plan.ok).toBe(true);
    expect(plan.action).toBe("create-detached");
    expect(plan.attachArgv).toBeNull();
    expect(plan.manualCommand).toBe(`tmux attach -t ${plan.session}`);

    const opened = openViewport(client, piped, req);
    expect(opened.code).toBe(TmuxExit.OK);
    expect(opened.created).toBe(true);
    expect(opened.attached).toBe(false);
    // `tmux attach` against a pipe dies with "open terminal failed" — we must never even try.
    expect(fake.attaches).toEqual([]);
    expect(fake.sessions.size).toBe(1);
  });

  it("--no-attach creates but never seizes the terminal, even on a perfect TTY", () => {
    const { fake, client, host: h } = harness();
    const opened = openViewport(client, h, { identity: ID, cwd: CWD, roles: ROLES, attach: false });
    expect(opened.action).toBe("create-detached");
    expect(opened.created).toBe(true);
    expect(fake.attaches).toEqual([]);
  });

  it("a failed hand-over is reported as ERROR(1), not as a phantom success", () => {
    const { fake, client, host: h, req } = harness();
    fake.attachStatus = 1; // tmux refused the terminal
    const opened = openViewport(client, h, req);
    expect(opened.attached).toBe(false);
    expect(opened.ok).toBe(false);
    expect(opened.code).toBe(TmuxExit.ERROR);
  });

  it("detectHost: LOOP_TMUX=off can only ever DISABLE; TMUX means nested; TTY means attachable", () => {
    expect(detectHost({ env: { LOOP_TMUX: "off" } as NodeJS.ProcessEnv, tty: true }).enabled).toBe(false);
    // config off + env unset → still off (the env var can disable, never enable).
    expect(detectHost({ configEnabled: false, env: {} as NodeJS.ProcessEnv, tty: true }).enabled).toBe(false);
    expect(detectHost({ configEnabled: true, env: {} as NodeJS.ProcessEnv, tty: true }).enabled).toBe(true);
    expect(detectHost({ env: { TMUX: "/tmp/x,123,0" } as NodeJS.ProcessEnv, tty: true }).insideTmux).toBe(true);
    expect(detectHost({ env: {} as NodeJS.ProcessEnv, tty: false }).interactive).toBe(false);
  });
});

describe("tmux viewport — `pre` is a true pre-flight", () => {
  it("plans the create WITHOUT issuing a single mutating tmux command", () => {
    const { fake, client, host: h, req } = harness();
    const plan = planViewport(client, h, req);

    expect(plan.ok).toBe(true);
    expect(plan.action).toBe("create-and-attach");
    expect(plan.session).toBe(sessionName("loop", "demo", "r1", "team"));
    expect(plan.roles).toEqual(["planner", "dev"]);
    // THE contract of `pre`: it changed nothing. No new-session, no set-option, no kill.
    expect(fake.mutations()).toEqual([]);
    expect(fake.sessions.size).toBe(0);
    expect(fake.attaches).toEqual([]);
  });

  it("returns the SAME exit code `new` would return, so a script can gate on it", () => {
    const { client, host: h, req } = harness();
    expect(planViewport(client, host({ installed: false }), req).code).toBe(openViewport(client, host({ installed: false }), req).code);

    const foreign = harness();
    foreign.fake.seed(sessionName("loop", "demo", "r1", "team")); // no metadata → not ours
    expect(planViewport(foreign.client, foreign.host, foreign.req).code).toBe(TmuxExit.CONFLICT);
    expect(openViewport(foreign.client, foreign.host, foreign.req).code).toBe(TmuxExit.CONFLICT);
  });
});

describe("tmux viewport — idempotence, collisions, and concurrency", () => {
  it("running `loop tmux new` twice yields ONE session (the second adopts, never duplicates)", () => {
    const { fake, client, host: h, req } = harness();

    const first = openViewport(client, h, req);
    expect(first.created).toBe(true);
    expect(first.code).toBe(TmuxExit.OK);

    const second = openViewport(client, h, req);
    expect(second.created).toBe(false); // adopted
    expect(second.code).toBe(TmuxExit.OK);
    expect(second.session).toBe(first.session);
    expect(second.panes).toEqual(first.panes); // same panes, not a second set
    expect(fake.sessions.size).toBe(1);
  });

  it("a FOREIGN session squatting the predicted name is refused (3) — never adopted, never killed", () => {
    const { fake, client, host: h, req } = harness();
    const name = sessionName("loop", "demo", "r1", "team");
    const squatter = fake.seed(name); // a human's own session, or a stale one: NO @loop-owner
    squatter.panes[0].content = "my precious work";

    const plan = planViewport(client, h, req);
    expect(plan.existing).toBe("foreign");
    expect(plan.code).toBe(TmuxExit.CONFLICT);
    expect(plan.hint).toMatch(/different --run|remove it yourself/i);

    const opened = openViewport(client, h, req);
    expect(opened.code).toBe(TmuxExit.CONFLICT);
    // It is still there, untouched, with its content — we neither killed nor hijacked it.
    expect(fake.sessions.get(name)?.panes[0].content).toBe("my precious work");
    expect(fake.attaches).toEqual([]);
    expect(fake.mutations()).toEqual([]);
  });

  it("a stale session with PARTIAL Loop metadata is treated as foreign, not adopted", () => {
    const { fake, client, host: h, req } = harness();
    // Owner tag but no run/role: a corrupted or half-written session must never be trusted.
    fake.seed(sessionName("loop", "demo", "r1", "team"), { "@loop-owner": LOOP_OWNER, "@loop-namespace": "loop" });
    expect(planViewport(client, h, req).code).toBe(TmuxExit.CONFLICT);
  });

  it("CONCURRENT `loop tmux new`: the loser of the new-session race ADOPTS the winner's session (exit 0, one session)", () => {
    const { fake, client, host: h, req } = harness();
    const name = sessionName("loop", "demo", "r1", "team");

    // Race injection: right before OUR new-session lands, a concurrent Loop process creates and stamps
    // the very same session. Real tmux answers `duplicate session` — the exact error we must survive.
    fake.onCommand = (cmd) => {
      if (cmd[0] === "new-session" && !fake.sessions.has(name)) {
        const winner = fake.seed(name, ownedMeta());
        winner.panes[0].title = "planner · Planner";
        winner.panes.push({ id: "%99", title: "dev · Developer", dead: false, content: "" });
        fake.onCommand = undefined; // the winner only wins once
      }
    };

    const opened = openViewport(client, h, req);
    expect(opened.code).toBe(TmuxExit.OK);
    expect(opened.created).toBe(false); // we adopted rather than exploding on "duplicate session"
    expect(opened.session).toBe(name);
    expect(opened.panes).toEqual({ planner: "%0", dev: "%99" }); // the WINNER's panes
    expect(fake.sessions.size).toBe(1); // exactly one session survives the race
    expect(fake.attaches).toEqual([["attach-session", "-t", `=${name}`]]);
  });

  it("CONCURRENT race lost to a FOREIGN session: refuse (3) rather than adopt a stranger", () => {
    const { fake, client, host: h, req } = harness();
    const name = sessionName("loop", "demo", "r1", "team");
    fake.onCommand = (cmd) => {
      if (cmd[0] === "new-session" && !fake.sessions.has(name)) {
        fake.seed(name); // someone else's session appears at the predicted name
        fake.onCommand = undefined;
      }
    };
    const opened = openViewport(client, h, req);
    expect(opened.code).toBe(TmuxExit.CONFLICT);
    expect(opened.created).toBe(false);
    expect(fake.attaches).toEqual([]);
  });
});

describe("tmux viewport — hostile names and quoting", () => {
  it("session names are tmux-safe: no `.`/`:` (tmux rewrites them), no shell metacharacters, no leading dash", () => {
    const hostile = [
      { project: "web.api", run: "r1" },
      { project: "web:api", run: "r1" },
      { project: "a; rm -rf ~", run: "r1" },
      { project: "$(whoami)", run: "`id`" },
      { project: "--evil", run: "-x" },
      { project: "a\nb", run: "c\td" },
      { project: "../../etc", run: "passwd" }
    ];
    for (const { project, run } of hostile) {
      const name = sessionName("loop", project, run, "team");
      expect(name).toMatch(TMUX_NAME_PATTERN);
      expect(name).not.toMatch(/[.:;`$&|<>()\s'"]/);
      expect(name.startsWith("-")).toBe(false);
    }
  });

  it("REGRESSION: `web.api` and `web_api` get DIFFERENT sessions (tmux rewrites `.`→`_`, which used to collide them)", () => {
    // The bug: the old sanitizer allowed `.`, tmux silently stored it as `_`, so these two distinct
    // projects mapped onto ONE real session — each one adopting the other's viewport.
    const dotted = sessionName("loop", "web.api", "r1", "team");
    const under = sessionName("loop", "web_api", "r1", "team");
    expect(dotted).not.toBe(under);

    // And prove it against the tmux name-rewriting rule itself: after tmux's `.`/`:` → `_` normalization
    // the two names are STILL distinct, so they can never land on the same session.
    const normalize = (n: string) => n.replace(/[.:]/g, "_");
    expect(normalize(dotted)).not.toBe(normalize(under));

    const { fake, client, host: h } = harness();
    openViewport(client, h, { identity: { ...ID, project: "web.api" }, cwd: CWD, roles: ROLES });
    openViewport(client, h, { identity: { ...ID, project: "web_api" }, cwd: CWD, roles: ROLES });
    expect(fake.sessions.size).toBe(2); // two projects, two viewports — no silent adoption
  });

  it("a hostile project name never becomes a shell word: it is argv, and it is sanitized out of the name", () => {
    const { fake, client, host: h } = harness();
    const evil = { ...ID, project: "x", run: "r1" };
    openViewport(client, h, { identity: evil, cwd: "/tmp/a b; touch /tmp/pwned", roles: ROLES });
    // Every tmux call is argv — the cwd travels as ONE element, never re-parsed by a shell.
    const create = fake.calls.find((c) => c[0] === "new-session")!;
    expect(create).toContain("/tmp/a b; touch /tmp/pwned");
    expect(create.filter((a) => a === "/tmp/a b; touch /tmp/pwned")).toHaveLength(1);
  });
});

describe("tmux viewport — show / kill / prune", () => {
  function seeded() {
    const { fake, client, host: h } = harness();
    // Two owned runs, one owned session in another project, and one foreign session.
    const r1 = sessionName("loop", "demo", "r1", "team");
    const r2 = sessionName("loop", "demo", "r2", "team");
    const other = sessionName("loop", "other", "r9", "team");
    fake.seed(r1, ownedMeta({ ...ID, run: "r1" })).panes[0].title = "dev · Developer";
    fake.seed(r2, ownedMeta({ ...ID, run: "r2" }));
    fake.seed(other, ownedMeta({ namespace: "loop", project: "other", run: "r9", role: "team" }));
    fake.seed("my-own-work"); // a human's session — never ours to list or kill
    return { fake, client, host: h, r1, r2, other };
  }

  it("show lists ONLY owned sessions for the project, with panes and liveness", () => {
    const { fake, client, host: h, r1 } = seeded();
    const report = showViewport(client, h, { namespace: "loop", project: "demo", knownRuns: ["r1", "r2"] });

    expect(report.ok).toBe(true);
    expect(report.sessions.map((s) => s.name).sort()).toEqual([r1, sessionName("loop", "demo", "r2", "team")].sort());
    // The other project's owned session and the human's own session are both absent.
    expect(report.sessions.some((s) => s.name === "my-own-work")).toBe(false);
    expect(report.sessions.find((s) => s.name === r1)!.panes).toEqual({ dev: "%0" });
    expect(fake.mutations()).toEqual([]); // `show` is read-only
  });

  it("show reports NOT_FOUND(4) when the run has no viewport, and flags DEAD and ORPHAN ones", () => {
    const { fake, client, host: h, r1 } = seeded();
    expect(showViewport(client, h, { namespace: "loop", project: "demo", run: "nope" }).code).toBe(TmuxExit.NOT_FOUND);

    fake.sessions.get(r1)!.panes.forEach((p) => (p.dead = true)); // every pane's process exited
    const report = showViewport(client, h, { namespace: "loop", project: "demo", knownRuns: ["r2"] }); // r1's run dir is gone
    const view = report.sessions.find((s) => s.name === r1)!;
    expect(view.dead).toBe(true);
    expect(view.orphan).toBe(true);
  });

  it("kill removes only THIS run's owned sessions — other runs, other projects, and foreign sessions survive", () => {
    const { fake, client, host: h, r1, r2, other } = seeded();
    const report = killViewport(client, h, { namespace: "loop", project: "demo", run: "r1" });

    expect(report.killed).toEqual([r1]);
    expect(fake.sessions.has(r1)).toBe(false);
    expect(fake.sessions.has(r2)).toBe(true);
    expect(fake.sessions.has(other)).toBe(true);
    expect(fake.sessions.has("my-own-work")).toBe(true);
  });

  it("kill --all clears the project's owned sessions and nothing else", () => {
    const { fake, client, host: h, other } = seeded();
    const report = killViewport(client, h, { namespace: "loop", project: "demo", all: true });
    expect(report.killed).toHaveLength(2);
    expect(fake.sessions.has(other)).toBe(true);
    expect(fake.sessions.has("my-own-work")).toBe(true);
  });

  it("prune reaps dead + orphaned viewports, KEEPS live ones, and --dry-run kills nothing", () => {
    const { fake, client, host: h, r1, r2 } = seeded();
    fake.sessions.get(r1)!.panes.forEach((p) => (p.dead = true)); // corpse: nothing left to watch
    const live = (run: string) => run === "r1"; // r2's run directory was deleted → orphan viewport

    const dry = pruneViewport(client, h, { namespace: "loop", project: "demo", isRunLive: live, dryRun: true });
    expect(dry.pruned.map((p) => p.reason).sort()).toEqual(["dead-panes", "orphaned-run"]);
    expect(fake.sessions.has(r1)).toBe(true); // --dry-run really did not kill
    expect(fake.sessions.has(r2)).toBe(true);

    const real = pruneViewport(client, h, { namespace: "loop", project: "demo", isRunLive: live });
    expect(real.pruned.map((p) => p.session).sort()).toEqual([r1, r2].sort());
    expect(fake.sessions.has(r1)).toBe(false);
    expect(fake.sessions.has(r2)).toBe(false);
    expect(fake.sessions.has("my-own-work")).toBe(true); // never ours to reap
  });

  it("prune KEEPS a healthy viewport whose run is still live", () => {
    const { fake, client, host: h, r1 } = seeded();
    const report = pruneViewport(client, h, { namespace: "loop", project: "demo", isRunLive: () => true });
    expect(report.pruned).toEqual([]);
    expect(report.kept).toContain(r1);
    expect(fake.sessions.has(r1)).toBe(true);
  });

  it("with no tmux, show is UNAVAILABLE(2) while kill/prune are harmless no-ops", () => {
    const { client } = harness();
    const noTmux = host({ installed: false });
    expect(showViewport(client, noTmux, { namespace: "loop" }).code).toBe(TmuxExit.UNAVAILABLE);
    expect(killViewport(client, noTmux, { namespace: "loop", project: "demo", run: "r1" }).killed).toEqual([]);
    expect(pruneViewport(client, noTmux, { namespace: "loop", isRunLive: () => true }).pruned).toEqual([]);
  });
});

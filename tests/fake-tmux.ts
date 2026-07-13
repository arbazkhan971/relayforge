import { ArgvRunner, TmuxResult } from "../src/tmux-client.js";

/**
 * A faithful in-memory tmux server, so the ENTIRE viewport decision matrix (no tmux, viewport off,
 * nested tmux, non-TTY, foreign collision, concurrent create, dead panes, hostile names) is tested
 * deterministically — no real tmux, no real terminal, no sleeping.
 *
 * "Faithful" is load-bearing. It reproduces the real tmux behaviours we depend on, each verified
 * against tmux 3.4 before it was encoded here:
 *   - session names silently REWRITE `.` and `:` to `_` (the collision bug this slice fixes)
 *   - a second `new-session -s X` fails with status 1 and `duplicate session: X` on stderr
 *   - a command LIST (`a ; b ; c` as separate argv elements) runs in order and stops at the first failure
 *   - `show-options -v` on an unset user option exits 1 ("invalid option")
 *   - an untitled pane's title is the HOSTNAME, not empty
 */

export type FakePane = { id: string; title: string; dead: boolean; content: string };
export type FakeSession = { name: string; opts: Record<string, string>; panes: FakePane[]; attached: boolean; windows: number };

/** tmux stores session names verbatim EXCEPT `.` and `:`, which are target metacharacters. */
const tmuxNormalize = (name: string): string => name.replace(/[.:]/g, "_");

/**
 * tmux 3.4 accepts the `=name` EXACT-target prefix on some commands and rejects it on others — and the
 * split is not intuitive. Verified against real tmux 3.4:
 *
 *   accept `=`:  has-session · kill-session · list-panes · display-message
 *   reject `=`:  set-option · show-options · split-window · select-layout · capture-pane
 *                (they read it literally → "no such session: =x" / "can't find pane: =x")
 *
 * The fake enforces this. An earlier version of the fake accepted `=` everywhere and therefore HID a
 * real bug: `split-window -t =name` silently failed, so the team viewport came up with one pane instead
 * of one per role. A permissive fake is a fake that lets bugs ship.
 */
const EXACT_PREFIX_OK = new Set(["has-session", "kill-session", "list-panes", "display-message"]);

export const FAKE_HOSTNAME = "fake-host.local";

export class FakeTmux {
  readonly sessions = new Map<string, FakeSession>();
  /** Every argv this fake was asked to run (command lists already split), for exact assertions. */
  readonly calls: string[][] = [];
  /** Argv of terminal hand-overs (`attach`), recorded instead of seizing the test's terminal. */
  readonly attaches: string[][] = [];
  installed = true;
  attachStatus = 0;
  private paneSeq = 0;
  /** Runs BEFORE each command — the seam a test uses to inject a concurrent creator (TOCTOU race). */
  onCommand?: (args: string[]) => void;

  get runner(): ArgvRunner {
    return (args) => this.runList(args);
  }

  get attachImpl(): (argv: string[]) => number {
    return (argv) => {
      this.attaches.push(argv);
      return this.attachStatus;
    };
  }

  /** Create a session directly (bypassing the client) — a "foreign" or racing session. */
  seed(name: string, opts: Record<string, string> = {}, panes = 1): FakeSession {
    const session: FakeSession = {
      name: tmuxNormalize(name),
      opts,
      panes: Array.from({ length: panes }, () => this.newPane()),
      attached: false,
      windows: 1
    };
    this.sessions.set(session.name, session);
    return session;
  }

  private newPane(): FakePane {
    return { id: `%${this.paneSeq++}`, title: FAKE_HOSTNAME, dead: false, content: "" };
  }

  /** Split an argv command LIST on `;` and run each command in order, stopping at the first failure. */
  private runList(args: string[]): TmuxResult {
    if (!this.installed) return { status: 1, stdout: "", stderr: "tmux: command not found" };
    const commands: string[][] = [[]];
    for (const arg of args) {
      if (arg === ";") commands.push([]);
      else commands[commands.length - 1].push(arg);
    }
    let last: TmuxResult = { status: 0, stdout: "", stderr: "" };
    for (const cmd of commands) {
      if (!cmd.length) continue;
      this.calls.push(cmd);
      this.onCommand?.(cmd);
      last = this.exec(cmd);
      if (last.status !== 0) return last;
    }
    return last;
  }

  /** The RAW `-t <target>` argument, exactly as tmux would receive it (`=` prefix and all). */
  private target(args: string[]): string | undefined {
    const i = args.indexOf("-t");
    if (i < 0 || i + 1 >= args.length) return undefined;
    return args[i + 1];
  }

  /** Resolve `-t` the way `verb` would. A verb that does NOT accept the `=` prefix reads it literally
   *  and finds nothing — exactly like real tmux. */
  private lookup(verb: string, args: string[]): FakeSession | undefined {
    let t = this.target(args);
    if (!t) return undefined;
    if (t.startsWith("=")) {
      if (!EXACT_PREFIX_OK.has(verb)) return undefined; // literal "=name" matches no session
      t = t.slice(1);
    }
    // A pane target (`%3`) resolves to whichever session holds that pane.
    if (t.startsWith("%")) return [...this.sessions.values()].find((s) => s.panes.some((p) => p.id === t));
    return this.sessions.get(tmuxNormalize(t));
  }

  /** The target with any accepted `=` stripped — for looking up a pane inside the resolved session. */
  private plainTarget(args: string[]): string {
    return (this.target(args) ?? "").replace(/^=/, "");
  }

  private exec(args: string[]): TmuxResult {
    const ok = (stdout = ""): TmuxResult => ({ status: 0, stdout, stderr: "" });
    const fail = (stderr: string): TmuxResult => ({ status: 1, stdout: "", stderr });
    const [verb, ...rest] = args;

    switch (verb) {
      case "-V":
        return ok("tmux 3.4\n");
      case "start-server":
        return ok();
      case "has-session":
        return this.lookup(verb, rest) ? ok() : fail(`can't find session: ${this.target(rest)}`);
      case "new-session": {
        const i = rest.indexOf("-s");
        const raw = i >= 0 ? rest[i + 1] : "unnamed";
        const name = tmuxNormalize(raw);
        // The REAL failure a concurrent creator produces.
        if (this.sessions.has(name)) return fail(`duplicate session: ${name}`);
        this.seed(name);
        return ok();
      }
      case "set-option": {
        const session = this.lookup(verb, rest);
        if (!session) return fail(`no such session: ${this.target(rest)}`);
        const [key, value] = rest.slice(rest.indexOf("-t") + 2);
        if (key?.startsWith("@")) session.opts[key] = value ?? "";
        return ok();
      }
      case "show-options": {
        const session = this.lookup(verb, rest);
        if (!session) return fail(`no such session: ${this.target(rest)}`);
        const key = rest[rest.length - 1];
        const value = session.opts[key];
        // tmux exits 1 on an unset user option — NOT 0-with-empty-output.
        return value === undefined ? fail(`invalid option: ${key}`) : ok(`${value}\n`);
      }
      case "list-sessions": {
        if (!this.sessions.size) return fail("no server running");
        const rows = [...this.sessions.values()].map((s) => `${s.name}\t${s.attached ? 1 : 0}\t${s.windows}`);
        return ok(rows.join("\n") + "\n");
      }
      case "list-panes": {
        const session = this.lookup(verb, rest);
        if (!session) return fail(`can't find pane: ${this.target(rest)}`);
        const fmt = rest[rest.indexOf("-F") + 1] ?? "#{pane_id}";
        const rows = session.panes.map((p) =>
          fmt
            .replace("#{pane_id}", p.id)
            .replace("#{pane_title}", p.title)
            .replace("#{pane_dead}", p.dead ? "1" : "0")
        );
        return ok(rows.join("\n") + "\n");
      }
      case "split-window": {
        const session = this.lookup(verb, rest);
        if (!session) return fail(`can't find pane: ${this.target(rest)}`);
        session.panes.push(this.newPane());
        return ok();
      }
      case "select-pane": {
        const session = this.lookup(verb, rest);
        if (!session) return fail(`can't find pane: ${this.target(rest)}`);
        const t = this.plainTarget(rest);
        const titleFlag = rest.indexOf("-T");
        const pane = t.startsWith("%") ? session.panes.find((p) => p.id === t) : session.panes[0];
        if (pane && titleFlag >= 0) pane.title = rest[titleFlag + 1];
        return ok();
      }
      case "capture-pane": {
        const session = this.lookup(verb, rest);
        if (!session) return fail(`can't find pane: ${this.target(rest)}`);
        const t = this.plainTarget(rest);
        const pane = t.startsWith("%") ? session.panes.find((p) => p.id === t) : session.panes[0];
        return ok(pane?.content ?? "");
      }
      case "kill-session": {
        const session = this.lookup(verb, rest);
        if (!session) return fail(`can't find session: ${this.plainTarget(rest)}`);
        this.sessions.delete(session.name);
        return ok();
      }
      case "kill-server":
        this.sessions.clear();
        return ok();
      case "select-layout":
      case "display-message":
        return this.lookup(verb, rest) ? ok() : fail(`can't find pane: ${this.target(rest)}`);
      default:
        return fail(`unknown command: ${verb}`);
    }
  }

  /** Did the fake ever see a MUTATING tmux verb? (Used to prove `loop tmux pre` changes nothing.) */
  mutations(): string[][] {
    const MUTATING = new Set([
      "new-session",
      "kill-session",
      "kill-server",
      "split-window",
      "select-pane",
      "select-layout",
      "set-option",
      "display-message",
      "send-keys",
      "respawn-pane"
    ]);
    return this.calls.filter((c) => MUTATING.has(c[0]));
  }
}

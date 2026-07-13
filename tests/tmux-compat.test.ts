import { afterEach, describe, expect, it } from "vitest";
import { TmuxClient, tmuxArgv } from "../src/tmux-client.js";
import { setTmuxClientForTests, tmuxClient } from "../src/tmux.js";
import { TMUX_NAME_PATTERN, sessionName } from "../src/tmux-name.js";

/**
 * INTEROP CONTRACT: Loop's viewports stay usable from the operator's OWN tmux tooling.
 *
 * The objective requires the viewport to remain compatible with `tpre show` / `tpre <session>` (and
 * `tnew <session>`) — thin wrappers people keep in ~/.local/bin:
 *
 *     tpre show|list|ls   →  tmux list-sessions                       (the DEFAULT server)
 *     tpre <session>      →  tmux new-session -A -s <session>         (attach-or-create)
 *                            or `switch-client -t "=<session>"` when already inside tmux
 *     tnew <session>      →  tmux new-session -A -s <session>
 *     (both validate the name against [A-Za-z0-9._-] and exit 2 otherwise)
 *
 * There is no adapter to test, and there should not be one: compatibility here means Loop uses plain
 * tmux the way everything else does. But that makes it INVISIBLE — it survives only as three quiet
 * properties of the code, any of which a reasonable refactor would break with the whole suite green:
 *
 *   1. production talks to the DEFAULT tmux server (no `-S`), which is the only server `tpre` looks at;
 *   2. every session name Loop can mint is inside `tpre`'s accepted charset, so it can be passed back;
 *   3. attach/switch uses the standard exact-target idiom, so `tpre <session>` ATTACHES rather than
 *      creating a second, empty session with the same name.
 *
 * A wave-8c note actually recommended defaulting to "one private tmux server per project root" — which
 * would silently break all of this (every test in the suite injects its own socket, so nothing would
 * have noticed). This file is the tripwire.
 */

afterEach(() => setTmuxClientForTests(undefined));

describe("tpre / tnew interop: Loop lives on the DEFAULT tmux server", () => {
  it("production (no LOOP_TMUX_SOCKET) issues NO -S flag — the server `tpre show` lists", () => {
    const had = process.env.LOOP_TMUX_SOCKET;
    delete process.env.LOOP_TMUX_SOCKET;
    setTmuxClientForTests(undefined); // force a rebuild from the (production) environment
    try {
      expect(tmuxClient().socket).toBeUndefined();
    } finally {
      if (had !== undefined) process.env.LOOP_TMUX_SOCKET = had;
      setTmuxClientForTests(undefined);
    }

    // `tmux list-sessions` — literally what `tpre show` runs — is what our argv builds without a socket.
    expect(tmuxArgv(undefined, ["list-sessions"])).toEqual(["list-sessions"]);
    expect(tmuxArgv(undefined, ["new-session", "-d", "-s", "x"])).toEqual(["new-session", "-d", "-s", "x"]);
  });

  it("a private socket is opt-in and never leaks into the default-server contract", () => {
    // The seam exists ONLY so tests never touch the developer's default server.
    expect(tmuxArgv("/tmp/sock", ["list-sessions"])).toEqual(["-S", "/tmp/sock", "list-sessions"]);
    expect(new TmuxClient({ socket: "/tmp/sock" }).socket).toBe("/tmp/sock");
    expect(new TmuxClient({}).socket).toBeUndefined();
  });
});

describe("tpre / tnew interop: every Loop session name is a name tpre accepts", () => {
  // tpre/tnew reject anything outside this set (exit 2) — a name Loop mints but tpre refuses would be
  // unattachable with the operator's own tooling.
  const TPRE_ACCEPTS = /^[A-Za-z0-9._-]+$/;

  it("names generated from hostile identities stay inside tpre's charset", () => {
    const nasty = [
      ["loop", "web.api", "run:1", "team"], // dots and colons — tmux target metacharacters
      ["loop", "a b/c", "../../etc", "role;rm -rf /"], // separators, traversal, shell metacharacters
      ["loop", "проект", "рун", "роль"], // non-ASCII
      ["loop", "-leading-dash", "-r", "-x"], // argv-flag-shaped
      ["loop", "x".repeat(200), "y".repeat(200), "z".repeat(200)] // over the length budget
    ] as const;

    for (const [ns, project, run, role] of nasty) {
      const name = sessionName(ns, project, run, role);
      expect(TPRE_ACCEPTS.test(name), `tpre would reject ${JSON.stringify(name)}`).toBe(true);
      expect(TMUX_NAME_PATTERN.test(name)).toBe(true);
      // No `:` or `.` — tmux rewrites both, so the name we print is the name tmux (and tpre) has.
      expect(name).not.toMatch(/[.:]/);
      expect(name.startsWith("-")).toBe(false); // never argv-flag-shaped for `tpre <session>`
    }
  });

  it("Loop's charset is a strict SUBSET of tpre's (so the name we print is always safe to hand back)", () => {
    // Loop excludes `.` (tmux would rewrite it); tpre allows it. Subset, never the reverse.
    const sample = sessionName("loop", "demo", "bug-42", "team");
    expect(TPRE_ACCEPTS.test(sample)).toBe(true);
    expect(TMUX_NAME_PATTERN.test("has.dot")).toBe(false); // Loop refuses it…
    expect(TPRE_ACCEPTS.test("has.dot")).toBe(true); // …tpre would have allowed it. Subset holds.
  });
});

describe("tpre / tnew interop: attaching uses the standard exact-target idiom", () => {
  const client = new TmuxClient({ socket: "/tmp/never-used" });
  const name = "loop-demo-bug42-team-abc12345";

  it("attach targets `=name`, so `tpre <session>` ATTACHES instead of creating a second session", () => {
    // The exact-target `=` prefix: attach to THE session with this name, never a prefix match — and
    // `attach-session`, never `new-session` (which would create a rival empty session at the name).
    const outside = client.attachArgv(name, false);
    expect(outside).toEqual(["attach-session", "-t", `=${name}`]);
    expect(outside[0]).not.toBe("new-session");
  });

  it("inside tmux it switches the client — the same idiom `tpre <session>` uses when nested", () => {
    expect(client.attachArgv(name, true)).toEqual(["switch-client", "-t", `=${name}`]);
  });
});

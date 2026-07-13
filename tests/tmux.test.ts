import { describe, expect, it } from "vitest";
import { assertTmuxName, sessionName, TMUX_NAME_PATTERN } from "../src/tmux.js";

describe("tmux helpers", () => {
  it("builds stable, sanitized, hash-suffixed session names", () => {
    const s = sessionName("loop", "demo product", "issue/123", "fe 1");
    // Readable sanitized prefix …
    expect(s.startsWith("loop-demo-product-issue-123-fe-1-")).toBe(true);
    // … plus a stable 8-hex identity hash, and ONLY characters tmux stores verbatim. The charset must
    // exclude `.` and `:`: tmux silently rewrites both to `_`, so a name containing them is not the name
    // tmux ends up with — every exact `-t` lookup then misses, and two identities can collide on one
    // session. (This assertion used to permit `.` and `:`.)
    expect(/-[0-9a-f]{8}$/.test(s)).toBe(true);
    expect(s).toMatch(TMUX_NAME_PATTERN);
    expect(s).not.toMatch(/[.:]/);
    // Stable across calls.
    expect(sessionName("loop", "demo product", "issue/123", "fe 1")).toBe(s);
  });

  it("assertTmuxName fails closed on a name tmux would misparse or read as a flag", () => {
    // These never reach `tmux -t`: a dot/colon targets `session:window.pane`, and a leading dash is a flag.
    for (const bad of ["web.api", "web:api", "-evil", "has space", "semi;colon", ""]) {
      expect(() => assertTmuxName(bad)).toThrow(/Unsafe tmux session name/);
    }
    expect(assertTmuxName("loop-demo-r1-team-0a1b2c3d")).toBe("loop-demo-r1-team-0a1b2c3d");
  });

  it("(wave-8) is INJECTIVE: max-length identities differing only LATE in run/role are distinct", () => {
    const longRunA = "run-" + "a".repeat(200) + "-x";
    const longRunB = "run-" + "a".repeat(200) + "-y"; // differs only past the truncation cap
    const a = sessionName("loop", "proj", longRunA, "team");
    const b = sessionName("loop", "proj", longRunB, "team");
    expect(a).not.toBe(b);
    // Sanitization collisions are also resolved by the identity hash.
    const c = sessionName("loop", "demo/x", "run-1", "team");
    const d = sessionName("loop", "demo-x", "run-1", "team"); // '/' and '-' both sanitize to '-'
    expect(c).not.toBe(d);
    // Every produced name stays within the tmux-safe budget.
    expect(a.length).toBeLessThanOrEqual(120);
  });
});

import { describe, expect, it } from "vitest";
import { helperUidTrusted } from "../src/flock.js";

// Real shapes: a plain host maps the full range identity ("0 0 4294967295"); an unprivileged
// bwrap jail maps only the caller's single uid, so inside-uid 0 is unmappable and host-root
// files are REPORTED as the overflow uid 65534.
const HOST_MAP = "         0          0 4294967295\n";
const JAIL_MAP = "      1002       1002          1\n";

describe("helperUidTrusted", () => {
  it("trusts uid 0 regardless of the namespace map", () => {
    expect(helperUidTrusted(0, HOST_MAP)).toBe(true);
    expect(helperUidTrusted(0, JAIL_MAP)).toBe(true);
    expect(helperUidTrusted(0, undefined)).toBe(true);
  });

  it("refuses overflow ownership on a host where root IS mapped (a real nobody-owned helper)", () => {
    expect(helperUidTrusted(65534, HOST_MAP)).toBe(false);
  });

  it("trusts overflow ownership inside a namespace that provably cannot map root", () => {
    expect(helperUidTrusted(65534, JAIL_MAP)).toBe(true);
  });

  it("refuses overflow when ANY map line covers inside-uid 0", () => {
    expect(helperUidTrusted(65534, "0 100000 65536\n")).toBe(false);
    expect(helperUidTrusted(65534, `${JAIL_MAP}0 0 1\n`)).toBe(false);
  });

  it("refuses any non-root, non-overflow owner even inside a namespace", () => {
    expect(helperUidTrusted(1000, JAIL_MAP)).toBe(false);
    expect(helperUidTrusted(65533, JAIL_MAP)).toBe(false);
  });

  it("stays strict when the map is missing, empty, or unparseable (proves nothing)", () => {
    expect(helperUidTrusted(65534, undefined)).toBe(false);
    expect(helperUidTrusted(65534, "")).toBe(false);
    expect(helperUidTrusted(65534, "garbage\n")).toBe(false);
    expect(helperUidTrusted(65534, "1002 1002\n")).toBe(false);
  });
});

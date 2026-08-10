import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  encodeWebSocketFrame,
  findChrome,
  parseArguments,
  PackedDashboardSmokeError
} from "../scripts/smoke-packed-dashboard.mjs";

function decodeMaskedTextFrame(frame: Buffer): string {
  expect(frame[0]).toBe(0x81);
  expect(frame[1] & 0x80).toBe(0x80);
  let length = frame[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    length = frame.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    length = Number(frame.readBigUInt64BE(offset));
    offset += 8;
  }
  const mask = frame.subarray(offset, offset + 4);
  offset += 4;
  const payload = frame.subarray(offset);
  expect(payload).toHaveLength(length);
  const decoded = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) decoded[index] = payload[index] ^ mask[index % 4];
  return decoded.toString("utf8");
}

describe("packed dashboard browser smoke harness", () => {
  it("accepts exactly one regular tarball argument and canonicalizes it", () => {
    const root = mkdtempSync(join(tmpdir(), "relayforge-browser-args-"));
    try {
      const tarball = join(root, "relayforge.tgz");
      writeFileSync(tarball, "fixture");
      expect(parseArguments(["--tarball", tarball])).toEqual({ tarball });
      expect(() => parseArguments([])).toThrow(/usage/u);
      expect(() => parseArguments(["--tarball", tarball, "--skip-browser"])).toThrow(/usage/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["ok", "x".repeat(300), "z".repeat(70_000)])("emits a masked RFC 6455 text frame for bounded CDP payloads", (payload) => {
    const frame = encodeWebSocketFrame(payload, Buffer.from([1, 2, 3, 4]));
    expect(decodeMaskedTextFrame(frame)).toBe(payload);
  });

  it("uses the installed tarball, a real loopback Chrome target, and an observed replacement lifecycle", () => {
    const source = readFileSync(new URL("../scripts/smoke-packed-dashboard.mjs", import.meta.url), "utf8");
    expect(source).toContain("npm\", [\"install\"");
    expect(source).toContain("\"--no-audit\"");
    expect(source).toContain("\"--no-fund\"");
    expect(source).toContain("INSTALL_TIMEOUT_MS");
    expect(source).toMatch(/\["install", "--no-audit", "--no-fund", "--prefix", prefix, tarball\]/);
    expect(source).not.toMatch(/npm", \["install"[^\]]*ignore-scripts/u);
    expect(source).toContain("NATIVE_BINDING_MISSING");
    expect(source).toContain("better_sqlite3.node");
    expect(source).toContain("packedExecutable(prefix)");
    expect(source).toContain("Page.addScriptToEvaluateOnNewDocument");
    expect(source).toContain("__RELAYFORGE_DASHBOARD_TEST_HOOK__");
    expect(source).toContain("waitForBrowserState(cdp, \"degraded\"");
    expect(source).toContain("waitForBrowserState(cdp, \"connected\", RECOVERY_TIMEOUT_MS)");
    expect(source).toContain("waitForServiceGone(port)");
    expect(source).toContain("snapshot.debug?.instanceId === priorInstanceId");
    expect(source).toContain("CHROME_UNAVAILABLE");
    expect(source).toContain("browser proof cannot be skipped");
    expect(source).toContain("process.kill(-child.pid");
    expect(source).toContain("terminateOwnedGroup");
    expect(source).toContain("rmSync(root, { recursive: true, force: true })");
    expect(source).not.toMatch(/playwright|puppeteer/iu);
  });

  it("fails closed when Chrome is absent instead of skipping browser proof", () => {
    try {
      findChrome({ RELAYFORGE_CHROME_PATH: "/nonexistent/chrome" }, ["/nonexistent/chrome", "/nonexistent/chromium"]);
      expect.unreachable("findChrome must fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(PackedDashboardSmokeError);
      expect((error as PackedDashboardSmokeError).code).toBe("CHROME_UNAVAILABLE");
      expect((error as Error).message).toMatch(/cannot be skipped/u);
    }
  });
});

import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const steeringDir = resolve(repoRoot, "src/steering");

describe("P2 has no terminal or second-writer delivery path", () => {
  it("keeps every steering module free of terminal input, process launch and HTTP mutation primitives", () => {
    const forbidden = [
      /send-keys/iu,
      /sendKeys/u,
      /capture-pane/iu,
      /tmuxClient/u,
      /attachSession/u,
      /capturePane/u,
      /process\.stdin/u,
      /\.stdin\b/u,
      /node:child_process/u,
      /node:http/u,
      /node:https/u
    ];
    for (const leaf of readdirSync(steeringDir).filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(resolve(steeringDir, leaf), "utf8");
      for (const pattern of forbidden) {
        expect(source, `${leaf} contains forbidden ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("keeps the connect-only client and CLI steering slice free of canonical-store open calls", () => {
    const ipc = readFileSync(resolve(steeringDir, "ipc.ts"), "utf8");
    expect(ipc).not.toMatch(/openControlStore|better-sqlite3|new\s+ControlStore/u);

    const cli = readFileSync(resolve(repoRoot, "src/cli.ts"), "utf8");
    const start = cli.indexOf("const steer = program");
    const end = cli.indexOf("program\n  .command(\"run\")", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const steeringSlice = cli.slice(start, end);
    expect(steeringSlice).not.toMatch(/openControlStore|better-sqlite3|send-keys|tmuxClient|\.stdin\b/u);
    expect(steeringSlice).toContain("sendSteeringIpcRequest");
  });
});

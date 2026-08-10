import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|cjs|json|md|yaml|yml)$/.test(entry)) out.push(p);
  }
  return out;
}

describe("repository text hygiene (P1 — no NUL bytes make Git treat source as binary)", () => {
  it("no tracked source/text file contains a literal NUL byte", () => {
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, "src")).concat(walk(join(ROOT, "tests")))) {
      const buf = readFileSync(file);
      if (buf.includes(0)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

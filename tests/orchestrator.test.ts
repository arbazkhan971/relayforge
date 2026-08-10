import { describe, expect, it } from "vitest";
import { extractJsonArray } from "../src/orchestrator.js";
import { normalizeTurn } from "../src/normalize.js";

describe("extractJsonArray", () => {
  it("pulls a JSON array out of noisy CLI wrapper output", () => {
    // Many CLIs emit a wrapper line, then the result text embeds a literal array.
    const noisy = '{"event":"start"}\nresult: [{"a":1},{"a":2}] -- done\n{"event":"end"}';
    const extracted = extractJsonArray(noisy);
    expect(extracted).toBeDefined();
    const parsed = JSON.parse(extracted!);
    expect(parsed).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("unwraps a claude --output-format json envelope with an ESCAPED inner array", () => {
    // This is the real shape of `claude -p ... --output-format json`: the model's text
    // (containing our array) is escaped inside the "result" string. A naive slice fails;
    // we must unwrap the envelope first.
    const inner = '[{"title":"Build API","assignee":"be","priority":5}]';
    const envelope = JSON.stringify({ result: `Here is the plan:\n${inner}`, is_error: false });
    const extracted = extractJsonArray(envelope);
    expect(extracted).toBeDefined();
    const parsed = JSON.parse(extracted!);
    expect(parsed).toEqual([{ title: "Build API", assignee: "be", priority: 5 }]);
  });

  it("handles a bare top-level JSON array", () => {
    const extracted = extractJsonArray('[{"title":"x"}]');
    expect(JSON.parse(extracted!)).toEqual([{ title: "x" }]);
  });

  it("ignores brackets inside strings when balancing", () => {
    const raw = 'noise [{"title":"has ] bracket","assignee":"qa"}] end';
    const parsed = JSON.parse(extractJsonArray(raw)!);
    expect(parsed).toEqual([{ title: "has ] bracket", assignee: "qa" }]);
  });

  it("extracts a clean array from plain output", () => {
    const raw = 'prefix text\n[{"title":"x","priority":1}]\ntrailing';
    const extracted = extractJsonArray(raw);
    expect(extracted).toBeDefined();
    const parsed = JSON.parse(extracted!);
    expect(parsed).toEqual([{ title: "x", priority: 1 }]);
  });

  it("returns undefined when no array is present", () => {
    expect(extractJsonArray('{"result":"no arrays here"}')).toBeUndefined();
    expect(extractJsonArray("just some prose")).toBeUndefined();
    expect(extractJsonArray("")).toBeUndefined();
  });
});

// Success is now decided by the single provider normalizer (src/normalize.ts) on the TERMINAL
// record — never by a regex over arbitrary text. See tests/normalize.test.ts for the full matrix.
describe("turn success via the normalizer (replaces the old regex agentReportedSuccess)", () => {
  it("a claude terminal is_error:true is NOT a success even at exit 0", () => {
    const stream = '{"type":"system","subtype":"init","tools":[]}\n{"type":"result","subtype":"error_during_execution","is_error":true,"result":"model unavailable"}';
    expect(normalizeTurn("claude", stream).success).toBe(false);
  });

  it("a claude terminal success is a success", () => {
    const stream =
      '{"type":"system","subtype":"init","session_id":"s","tools":[]}\n{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"s"}';
    expect(normalizeTurn("claude", stream).success).toBe(true);
  });

  it("a custom provider single-object is_error:true is not a success", () => {
    expect(normalizeTurn("custom", '{"is_error":true,"result":"boom"}').success).toBe(false);
    expect(normalizeTurn("custom", '{"is_error":false,"result":"ok"}').success).toBe(true);
  });
});

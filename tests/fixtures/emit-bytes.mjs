// Emits EXACT raw byte patterns on stdout so the COMPLETE real-child transport (not just the helper
// classes) can be driven to an exact `cap` / `cap + 1` boundary, and so giant-record / newline-flood
// behaviour can be measured for real time and RSS.
//
//   argv[2] = mode, argv[3..] = mode args
//
// Modes:
//   at-cap <n>                  n 'a' bytes, NO trailing newline               → exactly cap    → OK
//   at-cap-nl <n>               n 'a' bytes + "\n"                             → exactly cap    → OK
//   over-cap <n>                n+1 'a' bytes, NO trailing newline             → cap + 1        → UNCERTAIN
//   over-cap-nl <n>             n+1 'a' bytes + "\n" (TERMINATED, the wave-8c bypass) → cap + 1 → UNCERTAIN
//   cap-plus-incomplete <n>     n 'a' bytes then ONE incomplete UTF-8 lead byte (0xF0), no newline
//                               → cap + 1 RAW bytes; the old decoded counter mis-measured this
//   raw-high <n>                n 0xFF bytes (invalid UTF-8), no newline       → exactly cap RAW → OK
//                               (a decoded/re-encoded counter would see 3n bytes and falsely overflow)
//   giant <bytes>               one UNTERMINATED line of `bytes` 'a' bytes
//   giant-nl <bytes>            one TERMINATED line of `bytes` 'a' bytes + "\n"
//   flood <count>               `count` short newline-terminated lines ("i\n")
//   claude-tail <n>             a valid Claude turn whose records are each < n bytes
const mode = process.argv[2];
const arg = Number.parseInt(process.argv[3] ?? "0", 10);
const out = process.stdout;

// Write in bounded slices so the FIXTURE itself never allocates the whole payload at once — the RSS
// gate must measure the ORCHESTRATOR's retention, not this emitter's.
const CHUNK = 1 << 20;
function writeRepeated(byte, total) {
  const block = Buffer.alloc(Math.min(CHUNK, total), byte);
  let left = total;
  while (left > 0) {
    const n = Math.min(left, block.length);
    out.write(n === block.length ? block : block.subarray(0, n));
    left -= n;
  }
}

switch (mode) {
  case "at-cap":
    writeRepeated(0x61, arg);
    break;
  case "at-cap-nl":
    writeRepeated(0x61, arg);
    out.write("\n");
    break;
  case "over-cap":
    writeRepeated(0x61, arg + 1);
    break;
  case "over-cap-nl":
    writeRepeated(0x61, arg + 1);
    out.write("\n");
    break;
  case "cap-plus-incomplete":
    writeRepeated(0x61, arg);
    out.write(Buffer.from([0xf0])); // lead byte of a 4-byte sequence, never completed
    break;
  case "raw-high":
    writeRepeated(0xff, arg);
    break;
  case "giant":
    writeRepeated(0x61, arg);
    break;
  case "giant-nl":
    writeRepeated(0x61, arg);
    out.write("\n");
    break;
  case "flood": {
    // Batch the lines so the emitter is not the bottleneck; the transport still sees every newline.
    let buf = "";
    for (let i = 0; i < arg; i++) {
      buf += "i\n";
      if (buf.length >= CHUNK) {
        out.write(buf);
        buf = "";
      }
    }
    if (buf) out.write(buf);
    break;
  }
  case "claude-tail": {
    const S = "scap";
    const w = (o) => out.write(JSON.stringify(o) + "\n");
    w({ type: "system", subtype: "init", session_id: S, model: "claude-opus-4-8", tools: ["Bash"] });
    w({ type: "result", subtype: "success", is_error: false, result: "CAP_OK", total_cost_usd: 0.01, session_id: S, usage: { input_tokens: 1, output_tokens: 1 } });
    break;
  }
  // terminal-prefix-plus-byte: a COMPLETE, VALID Claude success record whose bytes are exactly the cap,
  // followed by ONE more byte inside the same record (wave-8d audit A1). The oversized record's
  // cap-sized prefix parses as a perfect terminal success — so a framer that hands the prefix to the
  // normalizer reports success/hasTerminal/cost for a record that was never framed.
  case "terminal-prefix-plus-byte": {
    const S = "S";
    const init = JSON.stringify({ type: "system", subtype: "init", session_id: S });
    const term = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "OK",
      total_cost_usd: 0.01,
      session_id: S,
      usage: { input_tokens: 1, output_tokens: 1 }
    });
    out.write(`${init}\n${term} \n`); // the trailing space is the (cap + 1)-th byte of the terminal record
    process.stderr.write(`${term.length}\n`); // the exact cap the parent must pass
    break;
  }
  // paced-one-byte <count>: `count` SEPARATE one-byte writes with no newline — a real child producing
  // tens of thousands of stdout events for a tiny payload (wave-8d audit A2: 52,279 events for 100 KB
  // cost ~41.8 MiB RSS when each fragment was retained as its own subarray).
  case "paced-one-byte": {
    for (let i = 0; i < arg; i++) out.write(Buffer.from([0x61]));
    break;
  }
  default:
    process.stderr.write(`unknown mode ${mode}\n`);
    process.exit(2);
}
// Flush before exiting so the parent observes every byte.
out.end();

#!/usr/bin/env node
// Reads the ENTIRE stdin prompt, then emits a success terminal whose result reports how many bytes
// it received. Used to prove the happy path: complete stdin delivery + a verified transcript = an
// accepted turn.
let got = 0;
process.stdin.on("data", (c) => {
  got += c.length;
});
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: `read:${got}` }) + "\n");
  process.exit(0);
});

#!/usr/bin/env node
// A provider that IGNORES SIGTERM and keeps streaming stdout continuously. Used to prove the
// transport survives LATE `data` events that arrive after a timeout has already forced finalize:
// once settled, the hash is digested and the fd closed, so an unguarded late write would throw
// (hash.update-after-digest / write-to-closed-fd). The turn must still resolve UNCERTAIN with no
// unhandled crash.
process.on("SIGTERM", () => {
  // Swallow TERM and emit a burst of late output, then keep going.
  for (let i = 0; i < 50; i++) process.stdout.write("LATE-AFTER-TERM-" + i + "\n");
});
// Stream steadily so bytes keep arriving around the moment the deadline finalizes the turn.
setInterval(() => {
  process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "tick" }] } }) + "\n");
}, 5);

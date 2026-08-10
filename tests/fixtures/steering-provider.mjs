import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

function value(flag) {
  const index = process.argv.indexOf(flag);
  return index < 0 ? undefined : process.argv[index + 1];
}

function linuxStartTicks() {
  if (process.platform !== "linux") return "1";
  const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const closeParen = stat.lastIndexOf(")");
  const fields = stat.slice(closeParen + 2).trim().split(/ +/u);
  return fields[19];
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const prompt = Buffer.concat(chunks);
const record = value("--record");
if (!record) throw new Error("--record is required");
writeFileSync(record, JSON.stringify({
  pid: process.pid,
  processStartToken: linuxStartTicks(),
  bytes: prompt.byteLength,
  sha256: createHash("sha256").update(prompt).digest("hex"),
  contentBase64: prompt.toString("base64")
}));

if (process.argv.includes("--hold")) {
  const ready = value("--ready");
  if (ready) writeFileSync(ready, "ready");
  await new Promise((resolve) => {
    process.once("SIGTERM", resolve);
    process.once("SIGINT", resolve);
  });
}

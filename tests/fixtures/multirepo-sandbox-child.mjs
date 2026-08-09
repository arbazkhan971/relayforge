import { appendFileSync, readFileSync, readdirSync } from "node:fs";

const [first, second, third, secret, parent, hostPid, hostFd, allowedState, codexState, geminiState, broadCacheSecret] = process.argv.slice(2);

appendFileSync(`${first}/authorized.txt`, "first\n", "utf8");
appendFileSync(`${second}/authorized.txt`, "second\n", "utf8");

function attempt(operation) {
  try {
    return { value: operation() };
  } catch (error) {
    return { code: error?.code ?? "UNKNOWN" };
  }
}

const result = {
  third: attempt(() => readFileSync(`${third}/third-secret.txt`, "utf8")),
  secret: attempt(() => readFileSync(secret, "utf8")),
  parent: attempt(() => readdirSync(parent))
};
if (hostPid && hostFd) {
  result.hostProcess = attempt(() => readdirSync(`/proc/${hostPid}`));
  result.hostRootSecret = attempt(() => readFileSync(`/proc/${hostPid}/root${secret}`, "utf8"));
  result.hostFdSecret = attempt(() => readFileSync(`/proc/${hostPid}/fd/${hostFd}`, "utf8"));
}
if (allowedState) {
  result.allowedState = attempt(() => readFileSync(allowedState, "utf8"));
  result.codexState = attempt(() => readFileSync(codexState, "utf8"));
  result.geminiState = attempt(() => readFileSync(geminiState, "utf8"));
  result.broadCacheSecret = attempt(() => readFileSync(broadCacheSecret, "utf8"));
}
process.stdout.write(JSON.stringify(result));

import { readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [apiRoot, webRoot] = process.argv.slice(2);
if (!apiRoot || !webRoot) throw new Error("two authorized workspace roots are required");

let parentDenied = false;
try {
  readdirSync(dirname(apiRoot));
} catch (error) {
  parentDenied = error?.code === "ERR_ACCESS_DENIED";
}
if (!parentDenied) throw new Error("the child could enumerate outside its authorized repository roots");

writeFileSync(join(apiRoot, "worker-api.txt"), "api changed by contained child\n", "utf8");
writeFileSync(join(webRoot, "worker-web.txt"), "web changed by contained child\n", "utf8");
process.stdout.write(`${JSON.stringify({ repositories: ["api", "web"], parentDenied })}\n`);

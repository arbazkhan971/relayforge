/**
 * A one-shot `ensureSession` in its OWN process, so the concurrency test races REAL OS processes
 * against a REAL tmux server (in-process spawnSync calls would merely serialize).
 *
 * argv: <socket> <namespace> <project> <run> <role>
 * stdout: {"created":bool,"name":string}
 */
import { TmuxClient } from "../../src/tmux-client.js";

const [socket, namespace, project, run, role] = process.argv.slice(2);
const client = new TmuxClient({ socket, version: "test" });

try {
  const result = client.ensureSession({ namespace, project, run, role }, "/tmp", {
    panes: [
      { name: "planner", title: "Planner" },
      { name: "dev", title: "Developer" }
    ]
  });
  process.stdout.write(JSON.stringify({ created: result.created, name: result.name, panes: result.panes }));
  process.exit(0);
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exit(3);
}

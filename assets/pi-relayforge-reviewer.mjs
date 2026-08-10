import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const MAX_PATH_BYTES = 4_096;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 1_000;
const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");

const pathSchema = Object.freeze({
  [TYPEBOX_KIND]: "String",
  type: "string",
  minLength: 1,
  maxLength: MAX_PATH_BYTES
});

const inputSchema = Object.freeze({
  [TYPEBOX_KIND]: "Object",
  type: "object",
  properties: Object.freeze({ path: pathSchema }),
  required: Object.freeze(["path"]),
  additionalProperties: false
});

function cancelled(signal) {
  if (signal?.aborted) throw new Error("RelayForge reviewer tool was cancelled");
}

function requestedPath(value) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES || value.includes("\0")) {
    throw new Error("Reviewer path must be a bounded non-empty NUL-free string");
  }
  return value;
}

function isWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function resolveInsideWorkspace(context, value) {
  const cwd = context?.cwd;
  if (typeof cwd !== "string" || cwd.length === 0) throw new Error("Reviewer workspace is unavailable");
  const root = await realpath(cwd);
  const candidate = await realpath(resolve(root, requestedPath(value)));
  if (!isWithin(root, candidate)) throw new Error("Reviewer path escapes the workspace");
  return { root, candidate };
}

function textResult(text, details) {
  return {
    content: [{ type: "text", text }],
    details
  };
}

/**
 * Independently authored Pi reviewer extension. It registers exactly two
 * bounded read-only tools and imports no process or mutation API. The outer
 * RelayForge sandbox remains the containment boundary.
 */
export default function relayforgePiReviewer(pi) {
  if (!pi || typeof pi.registerTool !== "function") throw new Error("Pi extension API is unavailable");

  pi.registerTool({
    name: "relayforge_read",
    label: "Read workspace file",
    description: "Read one bounded UTF-8 file inside the current RelayForge workspace.",
    parameters: inputSchema,
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      cancelled(signal);
      const { root, candidate } = await resolveInsideWorkspace(context, params?.path);
      const metadata = await stat(candidate);
      if (!metadata.isFile()) throw new Error("Reviewer path is not a regular file");
      if (metadata.size > MAX_FILE_BYTES) throw new Error("Reviewer file exceeds the read limit");
      const bytes = await readFile(candidate);
      cancelled(signal);
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error("Reviewer file is not valid UTF-8 text");
      }
      return textResult(text, { path: relative(root, candidate), bytes: bytes.length });
    }
  });

  pi.registerTool({
    name: "relayforge_list",
    label: "List workspace directory",
    description: "List one bounded directory inside the current RelayForge workspace without recursion.",
    parameters: inputSchema,
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      cancelled(signal);
      const { root, candidate } = await resolveInsideWorkspace(context, params?.path);
      const metadata = await stat(candidate);
      if (!metadata.isDirectory()) throw new Error("Reviewer path is not a directory");
      const entries = await readdir(candidate, { withFileTypes: true });
      if (entries.length > MAX_DIRECTORY_ENTRIES) throw new Error("Reviewer directory exceeds the entry limit");
      cancelled(signal);
      const lines = entries
        .map((entry) => `${entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"}\t${entry.name}`)
        .sort();
      return textResult(lines.join("\n"), { path: relative(root, candidate), entries: entries.length });
    }
  });
}

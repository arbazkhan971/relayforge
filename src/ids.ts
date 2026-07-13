import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Centralized strict identifier parsing and safe path containment.
 *
 * Every user/LLM/config-controlled identifier (run id, project name, role name, namespace,
 * task id, loop name) that reaches a filesystem path, a git ref, a tmux target, or a deletion
 * root MUST pass through here. We REJECT malformed identifiers rather than silently sanitizing
 * them: a traversal, control character, or separator attempt fails loudly instead of being
 * rewritten into something that merely *looks* contained but resolves elsewhere.
 */

export type IdKind = "run" | "project" | "role" | "namespace" | "task" | "loop" | "session";

// A canonical identifier: starts alphanumeric, then alphanumerics plus a small safe set of
// separators (dot, underscore, hyphen), max 64 chars. No path separators, no whitespace, no
// control characters, no shell/tmux metacharacters, no leading dot/dash.
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value === "." || value === "..") return false;
  if (value.includes("..")) return false; // never allow traversal-looking segments
  if (/[\u0000-\u001f\u007f]/.test(value)) return false; // control chars (defense in depth)
  return ID_PATTERN.test(value);
}

export function assertId(kind: IdKind, value: unknown): string {
  if (!isValidId(value)) {
    const shown = JSON.stringify(typeof value === "string" ? value.slice(0, 80) : String(value));
    throw new Error(
      `Invalid ${kind} identifier ${shown}: must be letters/digits then ._- only, no path separators, no "..", no control characters, max 64 chars.`
    );
  }
  return value;
}

/**
 * Join one or more ALREADY-VALIDATED id segments onto a root, then prove the result is still
 * strictly inside the root. This is belt-and-suspenders: even if a caller forgot to validate a
 * segment, a `..` or absolute path can never escape.
 */
export function containedJoin(root: string, ...segments: string[]): string {
  const base = resolve(root);
  for (const seg of segments) {
    if (typeof seg !== "string" || !seg.length) throw new Error("Empty path segment.");
    if (isAbsolute(seg)) throw new Error(`Absolute path segment rejected: ${seg}`);
  }
  const joined = resolve(base, ...segments);
  const rel = relative(base, joined);
  if (rel === "" || rel === "." ) return joined;
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path escapes its container: ${segments.join("/")} resolves outside ${base}.`);
  }
  return joined;
}

/**
 * Assert that `target` — after resolving every symlink on any existing prefix — is still inside
 * `root`. Guards against a symlink planted inside a loop-owned directory pointing outward (so a
 * later write/delete cannot follow it to the human's tree). Non-existent leaves are fine; we
 * check the deepest existing ancestor.
 */
export function assertRealContained(root: string, target: string): string {
  const realRoot = existsSync(root) ? realpathSync(root) : resolve(root);
  let probe = resolve(target);
  // Walk up to the deepest existing ancestor and realpath THAT (symlinks only matter where the
  // path actually exists on disk).
  const existingAncestor = (p: string): string => {
    let cur = p;
    while (!existsSync(cur)) {
      const parent = resolve(cur, "..");
      if (parent === cur) break;
      cur = parent;
    }
    return cur;
  };
  const anchor = existingAncestor(probe);
  const realAnchor = existsSync(anchor) ? realpathSync(anchor) : anchor;
  const rel = relative(realRoot, realAnchor);
  if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) {
    throw new Error(`Refusing to operate on ${target}: it resolves (via symlink) outside ${realRoot}.`);
  }
  return probe;
}

/** True when any component of `dir` is a symlink (walks up past non-existent leaves). */
export function containsSymlink(dir: string): boolean {
  let cur = resolve(dir);
  const seen = new Set<string>();
  while (!seen.has(cur)) {
    seen.add(cur);
    try {
      if (lstatSync(cur).isSymbolicLink()) return true;
    } catch {
      // this component does not exist — keep walking up toward the root
    }
    const parent = resolve(cur, "..");
    if (parent === cur) break;
    cur = parent;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Deletion ownership manifests.
//
// A directory tree may only be recursively removed by the loop if it carries an ownership
// manifest this process wrote. This makes "delete the run's worktrees" refuse to touch any
// directory the loop did not create (e.g. if an id somehow resolved to a real project dir).
// ---------------------------------------------------------------------------

const MANIFEST = ".loop-owned";

export function markOwned(dir: string, meta: Record<string, string> = {}): void {
  mkdirSync(dir, { recursive: true });
  const body = JSON.stringify({ owner: "loop-orchestrator", pid: process.pid, ...meta }, null, 2);
  writeFileSync(resolve(dir, MANIFEST), body);
}

export function isOwned(dir: string): boolean {
  try {
    const raw = readFileSync(resolve(dir, MANIFEST), "utf8");
    return JSON.parse(raw).owner === "loop-orchestrator";
  } catch {
    return false;
  }
}

/** The path separator, exported so path-shape assertions read clearly at call sites. */
export const PATH_SEP = sep;

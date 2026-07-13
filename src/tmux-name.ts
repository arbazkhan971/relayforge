import { createHash } from "node:crypto";

/**
 * Session naming — the one place a Loop identity becomes a tmux target.
 *
 * THE HAZARD (found against real tmux 3.4): tmux SILENTLY REWRITES `.` and `:` in a session name to
 * `_`, because both are target metacharacters (`session:window.pane`). The previous sanitizer allowed
 * both, and config ids legitimately contain dots (`ID_PATTERN` permits `web.api`). The consequences
 * were not cosmetic:
 *
 *   - COLLISION: identities `web.api` and `web_api` (or `web:api`) both became the session `web_api`.
 *     `tmux new-session` then answered `duplicate session`, and one run silently adopted the other's
 *     viewport — the exact non-injectivity the identity hash exists to prevent.
 *   - BROKEN TARGETING: the name we PREDICTED (`loop-web.api-…`) is not the name tmux HAS
 *     (`loop-web_api-…`), so `has-session -t =<predicted>` failed with `can't find pane: api`, and
 *     every capture/kill/attach against it missed.
 *
 * So the readable prefix is restricted to `[A-Za-z0-9_-]` — a charset tmux stores VERBATIM. The name
 * we compute is therefore the name tmux has, and `assertTmuxName` proves it before any argv is built.
 */

/** The tmux-safe budget for a session name (well under tmux's practical limit). We reserve room for a
 *  9-char `-<hash8>` suffix so the stable identity hash is ALWAYS present, even when the readable
 *  prefix is truncated. */
const SESSION_NAME_BUDGET = 120;
const SESSION_HASH_LEN = 8;

/** Exactly what tmux keeps verbatim, and what `-t` can never misparse: no `.`, `:`, whitespace, or
 *  shell metacharacter, and never a leading `-` (which argv would read as a flag). */
export const TMUX_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * A readable, tmux-safe, and INJECTIVE session name: a sanitized `namespace-project-run-role` prefix
 * plus a stable hash of the COMPLETE, unambiguous identity. Sanitizing + truncating alone is NOT
 * injective — two distinct identities can collapse to the same name when they contain the same
 * post-sanitization characters or differ only past the length cap. Appending a hash of the exact
 * identity tuple (JSON-encoded so no value can be confused with a separator) makes collisions
 * negligible: max-length identities differing only late in the run/role still get distinct names.
 */
export function sessionName(namespace: string, project: string, runId: string, role: string): string {
  const hash = createHash("sha256").update(JSON.stringify([namespace, project, runId, role])).digest("hex").slice(0, SESSION_HASH_LEN);
  // Every character tmux would rewrite (`.`, `:`) or misread collapses to `-` HERE, so the sanitized
  // prefix survives tmux verbatim. Distinctness is carried by the hash, not the prefix.
  const readable = `${namespace}-${project}-${runId}-${role}`.replace(/[^A-Za-z0-9_-]/g, "-");
  const prefix = readable.slice(0, SESSION_NAME_BUDGET - SESSION_HASH_LEN - 1).replace(/^-+/, "") || "loop";
  return `${prefix}-${hash}`;
}

/** Fail closed before any tmux argv is built. A name that could be misparsed as a flag or a
 *  `session:window.pane` target must never reach `tmux -t`. */
export function assertTmuxName(name: string): string {
  if (!TMUX_NAME_PATTERN.test(name)) {
    throw new Error(
      `Unsafe tmux session name ${JSON.stringify(name)}: must start alphanumeric and contain only ` +
        `letters, digits, "_" and "-" (tmux rewrites "." and ":" and would target a different session).`
    );
  }
  return name;
}

/** Whether a caller-supplied session target (e.g. `loop logs <session>`) is safe to pass to tmux. */
export function isSafeTmuxName(name: unknown): name is string {
  return typeof name === "string" && TMUX_NAME_PATTERN.test(name);
}

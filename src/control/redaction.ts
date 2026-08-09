import { Buffer } from "node:buffer";

export const REDACTED_VALUE = "[redacted]";
export const TRUNCATED_VALUE = "[truncated]";
export const CIRCULAR_VALUE = "[circular]";
export const UNAVAILABLE_VALUE = "[unavailable]";
export const UNSUPPORTED_VALUE = "[unsupported]";
export const TRUNCATION_KEY = "$truncated";

export const DEFAULT_REDACTION_MAX_DEPTH = 12;
export const DEFAULT_REDACTION_MAX_NODES = 10_000;
export const DEFAULT_REDACTION_MAX_OBJECT_KEYS = 128;
export const DEFAULT_REDACTION_MAX_ARRAY_LENGTH = 256;
export const DEFAULT_REDACTION_MAX_STRING_BYTES = 16 * 1024;

export type ControlJsonPrimitive = string | number | boolean | null;
export type ControlJsonObject = { [key: string]: ControlJsonValue };
export type ControlJsonValue = ControlJsonPrimitive | ControlJsonObject | ControlJsonValue[];

export type DeepRedactionLimits = {
  maxDepth: number;
  maxNodes: number;
  maxObjectKeys: number;
  maxArrayLength: number;
  maxStringBytes: number;
};

export type RedactionPath = {
  value: string;
  replacement?: string;
};

export type DeepRedactionOptions = {
  limits?: Partial<DeepRedactionLimits>;
  sensitiveValues?: readonly string[];
  paths?: readonly RedactionPath[];
};

type LiteralReplacement = {
  needle: string;
  replacement: string;
};

type RedactionContext = {
  limits: DeepRedactionLimits;
  sensitive: LiteralReplacement[];
  paths: LiteralReplacement[];
};

type WorkItem = {
  input: unknown;
  depth: number;
  keyHint: string;
  mask: boolean;
  maskChildren: boolean;
  assign: (value: ControlJsonValue) => void;
};

const SECRET_KEY_SUFFIXES = [
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "apikey",
  "apitoken",
  "token",
  "secret",
  "password",
  "passwd",
  "credential",
  "credentials",
  "privatekey",
  "clientsecret"
] as const;

const JSON_SECRET_ASSIGNMENT = /(["'](?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|api[-_]?key|api[-_]?token|token|access[-_]?token|refresh[-_]?token|secret|password|passwd|credential|credentials|private[-_]?key|client[-_]?secret)["']\s*:\s*)(["'])(.*?)(\2)/gi;
const HEADER_VALUE = /\b(authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]*/gi;
const AUTH_CREDENTIAL = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{4,}/gi;
const SECRET_QUERY_VALUE = /([?&](?:api[_-]?key|api[_-]?token|token|access[_-]?token|refresh[_-]?token|secret|password|passwd|credential|client[_-]?secret)=)[^&#\s"']*/gi;
const SECRET_ASSIGNMENT = /(\b[A-Za-z0-9_.-]*(?:api[_-]?key|api[_-]?token|token|secret|password|passwd|credential|private[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]*\b\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&]+)/gi;
const PRIVATE_KEY_BLOCK = /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/g;
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi;
const PROVIDER_TOKEN = /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,}|(?:sk|rk)_live_[A-Za-z0-9]{12,})\b/g;
const JWT_TOKEN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const WINDOWS_ABSOLUTE_PATH = /\b[A-Za-z]:[\\/](?:[^\s"'<>|]+[\\/]?)+/g;
const POSIX_ABSOLUTE_PATH = /(^|[\s("'=])\/(?:[^\s"'<>]+\/?)+/g;

/**
 * Redact arbitrary internal data into a bounded, acyclic JSON value.
 *
 * Traversal is iterative and reads only enumerable own data properties. Accessors are never
 * invoked. A secret-shaped property is masked before its value is inspected, including when the
 * value is a number, boolean, array, or object. Every value in an `env` map is treated likewise.
 */
export function redactControlValue(input: unknown, options: DeepRedactionOptions = {}): ControlJsonValue {
  const context = createContext(options);
  let root: ControlJsonValue = null;
  let visitedNodes = 0;
  const seen = new WeakSet<object>();
  const stack: WorkItem[] = [
    {
      input,
      depth: 0,
      keyHint: "",
      mask: false,
      maskChildren: false,
      assign(value) {
        root = value;
      }
    }
  ];

  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) break;

    if (visitedNodes >= context.limits.maxNodes) {
      item.assign(TRUNCATED_VALUE);
      continue;
    }
    visitedNodes += 1;

    if (item.mask || isSensitiveKey(item.keyHint)) {
      item.assign(REDACTED_VALUE);
      continue;
    }

    if (item.input === null) {
      item.assign(null);
      continue;
    }
    if (typeof item.input === "string") {
      item.assign(sanitizeWithContext(item.input, context));
      continue;
    }
    if (typeof item.input === "boolean") {
      item.assign(item.input);
      continue;
    }
    if (typeof item.input === "number") {
      item.assign(Number.isFinite(item.input) ? item.input : null);
      continue;
    }
    if (typeof item.input !== "object") {
      item.assign(UNSUPPORTED_VALUE);
      continue;
    }

    if (seen.has(item.input)) {
      item.assign(CIRCULAR_VALUE);
      continue;
    }
    if (item.depth >= context.limits.maxDepth) {
      item.assign(TRUNCATED_VALUE);
      continue;
    }
    seen.add(item.input);

    if (Array.isArray(item.input)) {
      const source = item.input;
      const overLimit = source.length > context.limits.maxArrayLength;
      const valueCount = overLimit ? Math.max(0, context.limits.maxArrayLength - 1) : source.length;
      const output: ControlJsonValue[] = new Array(overLimit ? valueCount + 1 : valueCount);
      if (overLimit) output[valueCount] = TRUNCATED_VALUE;
      item.assign(output);
      for (let index = valueCount - 1; index >= 0; index -= 1) {
        const outputIndex = index;
        stack.push({
          input: source[index],
          depth: item.depth + 1,
          keyHint: "",
          mask: item.maskChildren,
          maskChildren: false,
          assign(value) {
            output[outputIndex] = value;
          }
        });
      }
      continue;
    }

    const output = Object.create(null) as ControlJsonObject;
    item.assign(output);
    let keys: string[];
    try {
      keys = Object.keys(item.input);
    } catch {
      defineJsonProperty(output, TRUNCATION_KEY, UNAVAILABLE_VALUE);
      continue;
    }

    const overLimit = keys.length > context.limits.maxObjectKeys;
    const valueCount = overLimit ? Math.max(0, context.limits.maxObjectKeys - 1) : keys.length;
    if (overLimit) defineJsonProperty(output, TRUNCATION_KEY, TRUNCATED_VALUE);

    for (let index = valueCount - 1; index >= 0; index -= 1) {
      const key = keys[index];
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(item.input, key);
      } catch {
        descriptor = undefined;
      }
      if (descriptor === undefined || !("value" in descriptor)) {
        defineJsonProperty(output, key, UNAVAILABLE_VALUE);
        continue;
      }

      const normalizedKey = normalizeKey(key);
      const childMasksAll = normalizedKey === "env";
      const childValue = descriptor.value as unknown;
      if (childMasksAll && (childValue === null || typeof childValue !== "object")) {
        defineJsonProperty(output, key, REDACTED_VALUE);
        continue;
      }

      stack.push({
        input: childValue,
        depth: item.depth + 1,
        keyHint: key,
        mask: item.maskChildren || isSensitiveKey(key),
        maskChildren: childMasksAll,
        assign(value) {
          defineJsonProperty(output, key, value);
        }
      });
    }
  }

  return root;
}

/** Redact secret and path material in one free-text value and enforce the UTF-8 byte cap. */
export function sanitizeControlText(text: string, options: DeepRedactionOptions = {}): string {
  return sanitizeWithContext(text, createContext(options));
}

/** UTF-8 truncation that never splits a code point and keeps the marker inside `maxBytes`. */
export function truncateUtf8(text: string, maxBytes: number, marker = TRUNCATED_VALUE): string {
  assertIntegerBound("maxBytes", maxBytes, Buffer.byteLength(marker, "utf8"));
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return text;

  const markerBytes = Buffer.byteLength(marker, "utf8");
  const prefixBudget = maxBytes - markerBytes;
  let end = prefixBudget;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8") + marker;
}

function sanitizeWithContext(text: string, context: RedactionContext): string {
  let sanitized = text;
  for (const item of context.sensitive) sanitized = replaceLiteral(sanitized, item.needle, item.replacement);
  for (const item of context.paths) sanitized = replaceLiteral(sanitized, item.needle, item.replacement);

  sanitized = sanitized.replace(PRIVATE_KEY_BLOCK, "[redacted private key]");
  sanitized = sanitized.replace(HEADER_VALUE, "$1: [redacted]");
  sanitized = sanitized.replace(JSON_SECRET_ASSIGNMENT, "$1$2[redacted]$2");
  sanitized = sanitized.replace(AUTH_CREDENTIAL, "$1 [redacted]");
  sanitized = sanitized.replace(URL_USERINFO, "$1[redacted]@");
  sanitized = sanitized.replace(SECRET_QUERY_VALUE, "$1[redacted]");
  sanitized = sanitized.replace(SECRET_ASSIGNMENT, "$1[redacted]");
  sanitized = sanitized.replace(PROVIDER_TOKEN, REDACTED_VALUE);
  sanitized = sanitized.replace(JWT_TOKEN, REDACTED_VALUE);
  sanitized = sanitized.replace(WINDOWS_ABSOLUTE_PATH, "[path]");
  sanitized = sanitized.replace(POSIX_ABSOLUTE_PATH, "$1[path]");
  return truncateUtf8(sanitized, context.limits.maxStringBytes);
}

function createContext(options: DeepRedactionOptions): RedactionContext {
  const limits = resolveLimits(options.limits);
  return {
    limits,
    sensitive: buildSensitiveReplacements(options.sensitiveValues),
    paths: buildPathReplacements(options.paths)
  };
}

function resolveLimits(partial: Partial<DeepRedactionLimits> | undefined): DeepRedactionLimits {
  const maxDepth = partial?.maxDepth ?? DEFAULT_REDACTION_MAX_DEPTH;
  const maxNodes = partial?.maxNodes ?? DEFAULT_REDACTION_MAX_NODES;
  const maxObjectKeys = partial?.maxObjectKeys ?? DEFAULT_REDACTION_MAX_OBJECT_KEYS;
  const maxArrayLength = partial?.maxArrayLength ?? DEFAULT_REDACTION_MAX_ARRAY_LENGTH;
  const maxStringBytes = partial?.maxStringBytes ?? DEFAULT_REDACTION_MAX_STRING_BYTES;
  assertIntegerBound("maxDepth", maxDepth, 1);
  assertIntegerBound("maxNodes", maxNodes, 1);
  assertIntegerBound("maxObjectKeys", maxObjectKeys, 1);
  assertIntegerBound("maxArrayLength", maxArrayLength, 1);
  assertIntegerBound("maxStringBytes", maxStringBytes, Buffer.byteLength(TRUNCATED_VALUE, "utf8"));
  return { maxDepth, maxNodes, maxObjectKeys, maxArrayLength, maxStringBytes };
}

function buildSensitiveReplacements(values: readonly string[] | undefined): LiteralReplacement[] {
  if (values === undefined) return [];
  const replacements = new Map<string, string>();
  for (const value of values.slice(0, 256)) {
    if (typeof value !== "string" || value.length < 4) continue;
    addReplacement(replacements, value, REDACTED_VALUE);
    addReplacement(replacements, encodeURIComponent(value), REDACTED_VALUE);
    addReplacement(replacements, jsonEscapeLiteral(value), REDACTED_VALUE);
    addReplacement(replacements, Buffer.from(value, "utf8").toString("base64"), REDACTED_VALUE);
    addReplacement(replacements, Buffer.from(value, "utf8").toString("base64url"), REDACTED_VALUE);
  }
  return replacementsByLength(replacements);
}

function buildPathReplacements(paths: readonly RedactionPath[] | undefined): LiteralReplacement[] {
  if (paths === undefined) return [];
  const replacements = new Map<string, string>();
  for (const path of paths.slice(0, 256)) {
    if (typeof path.value !== "string" || path.value.length === 0) continue;
    const replacement = path.replacement ?? "[path]";
    addReplacement(replacements, path.value, replacement);
    addReplacement(replacements, jsonEscapeLiteral(path.value), replacement);
  }
  return replacementsByLength(replacements);
}

function addReplacement(replacements: Map<string, string>, needle: string, replacement: string): void {
  if (needle.length > 0 && !replacements.has(needle)) replacements.set(needle, replacement);
}

function replacementsByLength(replacements: Map<string, string>): LiteralReplacement[] {
  const result: LiteralReplacement[] = [];
  for (const [needle, replacement] of replacements) result.push({ needle, replacement });
  result.sort((left, right) => right.needle.length - left.needle.length);
  return result;
}

function replaceLiteral(text: string, needle: string, replacement: string): string {
  return text.includes(needle) ? text.split(needle).join(replacement) : text;
}

function jsonEscapeLiteral(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\u0008/g, "\\b")
    .replace(/\u000c/g, "\\f")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/[\u0000-\u001f]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function normalizeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (normalized.length === 0) return false;
  return SECRET_KEY_SUFFIXES.some((suffix) => normalized === suffix || normalized.endsWith(suffix));
}

function defineJsonProperty(target: ControlJsonObject, key: string, value: ControlJsonValue): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  });
}

function assertIntegerBound(name: string, value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError(`${name} must be a safe integer of at least ${minimum}.`);
}

import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import {
  CONTROL_ACTIVITY_MAX_LIMIT,
  CONTROL_BOARD_MAX_BYTES,
  CONTROL_DIAGNOSTIC_MAX_LINES,
  CONTROL_HEALTH_MAX_BYTES,
  CONTROL_HOST,
  CONTROL_PAGE_CURSOR_MAX_LENGTH,
  CONTROL_PROTOCOL_VERSION,
  CONTROL_RESPONSE_LIMITS,
  CONTROL_RUN_FILE_MAX_BYTES,
  CONTROL_RUNS_MAX_LIMIT,
  CONTROL_SERVICE,
  CONTROL_SSE_FRAME_MAX_BYTES,
  CONTROL_SSE_REPLAY_MAX_BYTES,
  CONTROL_SSE_REPLAY_MAX_EVENTS,
  ControlPayloadTooLargeError,
  ControlProtocolError,
  makeControlError,
  parseControlActivity,
  parseControlBoard,
  parseControlDiagnostics,
  parseControlError,
  parseControlHealth,
  parseControlHealthJson,
  parseControlRun,
  parseControlRunFile,
  parseControlRunFileJson,
  parseControlRuns,
  parseControlSseControlFrame,
  parseControlSseNotification,
  parseControlStatus,
  parsePageCursor,
  parseSseCursor,
  parseStrictDecimal,
  serializeControlJson,
  serializeControlResponse,
  toPublicActivity,
  toPublicDiagnosticCheck,
  toPublicRunSummary,
  toPublicSessionSummary,
  toPublicTask,
  type ControlActivityEntry,
  type ControlDiagnosticCheck,
  type ControlRunFile,
  type ControlRunSummary,
  type ControlSessionSummary,
  type ControlTask
} from "../src/control/protocol.js";
import {
  CIRCULAR_VALUE,
  REDACTED_VALUE,
  TRUNCATED_VALUE,
  TRUNCATION_KEY,
  UNAVAILABLE_VALUE,
  redactControlValue,
  sanitizeControlText,
  truncateUtf8
} from "../src/control/redaction.js";

const NOW = "2026-08-09T12:34:56.000Z";
const INSTANCE_ID = "a".repeat(64);
const CONFIG_ID = "b".repeat(64);
const RUN_EPOCH = "epoch_0123456789abcdef";

function runFile(): ControlRunFile {
  return {
    schemaVersion: CONTROL_PROTOCOL_VERSION,
    service: CONTROL_SERVICE,
    instanceId: INSTANCE_ID,
    configId: CONFIG_ID,
    pid: 42,
    processStartToken: "linux:boot-id:42",
    host: CONTROL_HOST,
    port: 4318,
    startedAt: NOW
  };
}

function counts() {
  return {
    total: 3,
    open: 1,
    active: 1,
    needsReview: 0,
    blocked: 0,
    done: 1,
    rejected: 0,
    escalated: 0
  };
}

function summary(): ControlRunSummary {
  return {
    project: "demo",
    run: "run-1",
    runEpoch: RUN_EPOCH,
    status: "running",
    reason: "task-active",
    startedAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    viewSeq: 7,
    headSeq: 8,
    floorSeq: 1,
    stale: true,
    tasks: counts()
  };
}

function task(): ControlTask {
  return {
    id: "task-1",
    title: "Implement the public control view",
    status: "in-progress",
    assignee: "backend",
    claimedBy: "backend",
    priority: 5,
    dependsOn: ["task-0"],
    attempts: 1,
    createdAt: NOW,
    updatedAt: NOW,
    summary: "Public summary"
  };
}

function activity(): ControlActivityEntry {
  return {
    seq: 8,
    occurredAt: NOW,
    kind: "task.started",
    actor: "backend",
    taskId: "task-1",
    status: "in-progress",
    summary: "Started"
  };
}

describe("control protocol constants and strict identity documents", () => {
  it("exports the audited exact response and replay bounds", () => {
    expect(CONTROL_RESPONSE_LIMITS).toEqual({
      health: 4 * 1024,
      status: 256 * 1024,
      runs: 1024 * 1024,
      run: 256 * 1024,
      board: 2 * 1024 * 1024,
      activity: 2 * 1024 * 1024,
      diagnostics: 256 * 1024
    });
    expect(CONTROL_HEALTH_MAX_BYTES).toBe(4 * 1024);
    expect(CONTROL_BOARD_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(CONTROL_RUNS_MAX_LIMIT).toBe(100);
    expect(CONTROL_ACTIVITY_MAX_LIMIT).toBe(500);
    expect(CONTROL_DIAGNOSTIC_MAX_LINES).toBe(500);
    expect(CONTROL_SSE_REPLAY_MAX_EVENTS).toBe(1_024);
    expect(CONTROL_SSE_REPLAY_MAX_BYTES).toBe(4 * 1024 * 1024);
    expect(CONTROL_SSE_FRAME_MAX_BYTES).toBe(64 * 1024);
  });

  it("accepts only the exact run-file shape and private identity fields", () => {
    expect(parseControlRunFile(runFile())).toEqual(runFile());

    const unknown = Object.assign({}, runFile(), { configPath: "/private/config.yaml" });
    expect(() => parseControlRunFile(unknown)).toThrow(ControlProtocolError);
    expect(() => parseControlRunFile(Object.assign({}, runFile(), { host: "localhost" }))).toThrow();
    expect(() => parseControlRunFile(Object.assign({}, runFile(), { instanceId: "A".repeat(64) }))).toThrow();
    expect(() => parseControlRunFile(Object.assign({}, runFile(), { pid: 0 }))).toThrow();
    expect(() => parseControlRunFile(Object.assign({}, runFile(), { port: 65_536 }))).toThrow();
    expect(() => parseControlRunFile(Object.assign({}, runFile(), { processStartToken: "bad\nvalue" }))).toThrow();
    expect(() => parseControlRunFile(Object.assign({}, runFile(), { processStartToken: "Linux:/private/path" }))).toThrow();
    expect(() => parseControlRunFile(Object.assign({}, runFile(), { startedAt: "2026-02-31T12:00:00Z" }))).toThrow();
  });

  it("enforces the run-file byte boundary before parsing", () => {
    const json = JSON.stringify(runFile());
    const exact = json + " ".repeat(CONTROL_RUN_FILE_MAX_BYTES - Buffer.byteLength(json));
    expect(Buffer.byteLength(exact)).toBe(CONTROL_RUN_FILE_MAX_BYTES);
    expect(parseControlRunFileJson(exact)).toEqual(runFile());
    expect(() => parseControlRunFileJson(exact + " ")).toThrow(ControlPayloadTooLargeError);
  });

  it("rejects malformed UTF-8, unknown health fields, and private health leakage", () => {
    const health = {
      schemaVersion: CONTROL_PROTOCOL_VERSION,
      service: CONTROL_SERVICE,
      instanceId: INSTANCE_ID,
      configId: CONFIG_ID,
      pid: 42,
      status: "ok" as const,
      startedAt: NOW
    };
    expect(parseControlHealth(health)).toEqual(health);
    expect(() => parseControlHealth(Object.assign({}, health, { processStartToken: "private" }))).toThrow();
    expect(() => parseControlHealth(Object.assign({}, health, { rootDir: "/private/root" }))).toThrow();
    expect(() => parseControlHealthJson(new Uint8Array([0xff]))).toThrow(ControlProtocolError);
  });
});

describe("strict versioned public DTO schemas", () => {
  it("parses status, run list/detail, board, activity, and diagnostics DTOs", () => {
    const session: ControlSessionSummary = {
      name: "loop-demo-run-1-backend",
      project: "demo",
      run: "run-1",
      role: "backend",
      state: "running",
      taskId: "task-1",
      lastActivity: NOW
    };
    expect(
      parseControlStatus({
        schemaVersion: 1,
        service: CONTROL_SERVICE,
        instanceId: INSTANCE_ID,
        configId: CONFIG_ID,
        status: "ok",
        startedAt: NOW,
        projects: [{ project: "demo", latestRun: summary(), sessions: [session] }]
      }).projects[0].sessions[0]
    ).toEqual(session);

    expect(
      parseControlRuns({ schemaVersion: 1, project: "demo", runs: [summary()], nextCursor: "v1.bmV4dA" }).runs
    ).toHaveLength(1);
    expect(
      parseControlRun({
        schemaVersion: 1,
        run: {
          project: "demo",
          run: "run-1",
          runEpoch: RUN_EPOCH,
          status: "running",
          reason: "task-active",
          startedAt: NOW,
          updatedAt: NOW,
          completedAt: null,
          desiredGeneration: 2,
          observedGeneration: 1,
          viewSeq: 7,
          headSeq: 8,
          floorSeq: 1,
          stale: true,
          tasks: counts()
        }
      }).run.observedGeneration
    ).toBe(1);
    expect(
      parseControlBoard({
        schemaVersion: 1,
        project: "demo",
        run: "run-1",
        runEpoch: RUN_EPOCH,
        viewSeq: 7,
        headSeq: 8,
        floorSeq: 1,
        stale: true,
        tasks: [task()],
        counts: counts()
      }).tasks[0]
    ).toEqual(task());
    expect(
      parseControlActivity({
        schemaVersion: 1,
        project: "demo",
        run: "run-1",
        runEpoch: RUN_EPOCH,
        viewSeq: 8,
        headSeq: 8,
        floorSeq: 1,
        stale: false,
        activity: [activity()],
        nextAfter: 8
      }).activity[0]
    ).toEqual(activity());
    expect(
      parseControlDiagnostics({
        schemaVersion: 1,
        project: "demo",
        run: "run-1",
        runEpoch: RUN_EPOCH,
        viewSeq: 8,
        headSeq: 8,
        floorSeq: 1,
        stale: false,
        session: "loop-demo-run-1-backend",
        checks: [{ code: "runtime.identity", status: "ok", message: "Identity proven", fix: null }],
        tail: ["bounded public line"],
        truncated: false
      }).checks[0].code
    ).toBe("runtime.identity");
  });

  it("rejects raw config, task descriptions, canonical payloads, and unknown nested fields", () => {
    const unsafeTask = Object.assign({}, task(), {
      description: "raw task description",
      canonicalPayload: { prompt: "do not expose" }
    });
    expect(() =>
      parseControlBoard({
        schemaVersion: 1,
        project: "demo",
        run: "run-1",
        runEpoch: RUN_EPOCH,
        viewSeq: 1,
        headSeq: 1,
        floorSeq: 1,
        stale: false,
        tasks: [unsafeTask],
        counts: counts()
      })
    ).toThrow(ControlProtocolError);

    expect(() =>
      parseControlStatus({
        schemaVersion: 1,
        service: CONTROL_SERVICE,
        instanceId: INSTANCE_ID,
        configId: CONFIG_ID,
        status: "ok",
        startedAt: NOW,
        projects: [{ project: "demo", latestRun: null, sessions: [], config: { env: { TOKEN: "secret" } } }]
      })
    ).toThrow(ControlProtocolError);
  });

  it("accepts exact collection limits and rejects plus one", () => {
    const entries = Array.from({ length: CONTROL_ACTIVITY_MAX_LIMIT }, (_unused, index) =>
      Object.assign({}, activity(), { seq: index + 1 })
    );
    const dto = {
      schemaVersion: 1,
      project: "demo",
      run: "run-1",
      runEpoch: RUN_EPOCH,
      viewSeq: CONTROL_ACTIVITY_MAX_LIMIT,
      headSeq: CONTROL_ACTIVITY_MAX_LIMIT,
      floorSeq: 1,
      stale: false,
      activity: entries,
      nextAfter: CONTROL_ACTIVITY_MAX_LIMIT
    };
    expect(parseControlActivity(dto).activity).toHaveLength(CONTROL_ACTIVITY_MAX_LIMIT);
    entries.push(Object.assign({}, activity(), { seq: CONTROL_ACTIVITY_MAX_LIMIT + 1 }));
    expect(() => parseControlActivity(dto)).toThrow(ControlProtocolError);
  });

  it("rejects inconsistent counts, freshness, and non-increasing durable activity", () => {
    const badCounts = counts();
    badCounts.total = 99;
    expect(() => toPublicRunSummary(Object.assign({}, summary(), { tasks: badCounts }))).toThrow(ControlProtocolError);

    const staleOrder = Object.assign({}, summary(), { floorSeq: 9, viewSeq: 8, headSeq: 8 });
    expect(() => toPublicRunSummary(staleOrder)).toThrow(ControlProtocolError);

    expect(() =>
      parseControlActivity({
        schemaVersion: 1,
        project: "demo",
        run: "run-1",
        runEpoch: RUN_EPOCH,
        viewSeq: 8,
        headSeq: 8,
        floorSeq: 1,
        stale: false,
        activity: [activity(), activity()],
        nextAfter: 8
      })
    ).toThrow(ControlProtocolError);
  });

  it("allowlist mappers discard additional internal fields", () => {
    const internalTask = Object.assign({}, task(), {
      description: "private",
      acceptanceCriteria: ["private"],
      files: ["/private/file"],
      payload: { token: "private" }
    });
    const publicTask = toPublicTask(internalTask);
    expect(publicTask).toEqual(task());
    expect("description" in publicTask).toBe(false);
    expect("payload" in publicTask).toBe(false);

    const internalRun = Object.assign({}, summary(), { config: { env: { API_KEY: "private" } }, storePath: "/private" });
    expect(toPublicRunSummary(internalRun)).toEqual(summary());

    const session: ControlSessionSummary & { transcript: string } = {
      name: "loop-demo-run-1-backend",
      project: "demo",
      run: "run-1",
      role: "backend",
      state: "running",
      taskId: "task-1",
      lastActivity: NOW,
      transcript: "private"
    };
    expect("transcript" in toPublicSessionSummary(session)).toBe(false);
    expect("providerPayload" in toPublicActivity(Object.assign({}, activity(), { providerPayload: "private" }))).toBe(false);

    const check: ControlDiagnosticCheck & { exception: Error } = {
      code: "store.ready",
      status: "ok",
      message: "Ready",
      fix: null,
      exception: new Error("private")
    };
    expect("exception" in toPublicDiagnosticCheck(check)).toBe(false);
  });
});

describe("cursor, SSE, and error contracts", () => {
  it("uses canonical full-string decimals with exact range boundaries", () => {
    expect(parseStrictDecimal("0", { name: "after" })).toBe(0);
    expect(parseStrictDecimal(String(Number.MAX_SAFE_INTEGER), { name: "after" })).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseStrictDecimal("500", { name: "limit", minimum: 1, maximum: 500 })).toBe(500);
    for (const invalid of ["", "00", "01", "+1", " 1", "1 ", "1.0", "1x", "-1", String(Number.MAX_SAFE_INTEGER + 1)]) {
      expect(() => parseStrictDecimal(invalid, { name: "after" })).toThrow(ControlProtocolError);
    }
    expect(() => parseStrictDecimal("501", { name: "limit", minimum: 1, maximum: 500 })).toThrow();
  });

  it("accepts an exact page cursor length and rejects plus one or a foreign version", () => {
    const exact = "v1." + "a".repeat(CONTROL_PAGE_CURSOR_MAX_LENGTH - 3);
    expect(exact).toHaveLength(CONTROL_PAGE_CURSOR_MAX_LENGTH);
    expect(parsePageCursor(exact)).toBe(exact);
    expect(() => parsePageCursor(exact + "a")).toThrow(ControlProtocolError);
    expect(() => parsePageCursor("v2.abc")).toThrow(ControlProtocolError);
  });

  it("gives Last-Event-ID precedence without malformed-header fallback", () => {
    expect(parseSseCursor({ runEpoch: RUN_EPOCH, after: "4", lastEventId: "9" })).toEqual({
      runEpoch: RUN_EPOCH,
      after: 9,
      source: "header"
    });
    expect(parseSseCursor({ runEpoch: RUN_EPOCH, after: "4" })).toEqual({
      runEpoch: RUN_EPOCH,
      after: 4,
      source: "query"
    });
    expect(parseSseCursor({})).toBeNull();
    expect(() => parseSseCursor({ runEpoch: RUN_EPOCH, after: "4", lastEventId: "bad" })).toThrow();
    expect(() => parseSseCursor({ after: "4" })).toThrow();
    expect(() => parseSseCursor({ runEpoch: RUN_EPOCH })).toThrow();
  });

  it("keeps ordinary SSE data allowlisted and control frames id-less", () => {
    const notification = {
      v: 1,
      type: "control.changed",
      project: "demo",
      run: "run-1",
      taskId: "task-1",
      runEpoch: RUN_EPOCH,
      seq: 9,
      headSeq: 9,
      viewSeq: 9
    };
    expect(parseControlSseNotification(notification)).toEqual(notification);
    expect(() => parseControlSseNotification(Object.assign({}, notification, { payload: { prompt: "private" } }))).toThrow();
    expect(
      parseControlSseControlFrame({
        v: 1,
        type: "control.resync-required",
        reason: "cursor-expired",
        runEpoch: RUN_EPOCH,
        floorSeq: 5,
        headSeq: 9,
        snapshotSeq: 4
      }).type
    ).toBe("control.resync-required");
    expect(() => parseControlSseControlFrame({ v: 1, type: "control.closing", reason: "shutdown", id: 10 })).toThrow();
  });

  it("allows only bounded numeric/code recovery details in errors", () => {
    expect(
      makeControlError("CURSOR_EXPIRED", "History is no longer retained.", "req-1", {
        floorSeq: 5,
        headSeq: 9,
        snapshotSeq: 4,
        reason: "cursor-expired"
      })
    ).toEqual({
      error: {
        code: "CURSOR_EXPIRED",
        message: "History is no longer retained.",
        requestId: "req-1",
        details: { floorSeq: 5, headSeq: 9, snapshotSeq: 4, reason: "cursor-expired" }
      }
    });
    expect(() =>
      parseControlError({
        error: {
          code: "INTERNAL_ERROR",
          message: "Failed",
          requestId: "req-2",
          details: { path: "/private/store", exception: "secret" }
        }
      })
    ).toThrow();
  });
});

describe("bounded iterative redaction", () => {
  it("masks secret-shaped keys and every env value regardless of value type", () => {
    const redacted = redactControlValue({
      apiKey: 123,
      clientSecret: false,
      credential: { nested: "secret" },
      Authorization: ["secret"],
      env: {
        OPENAI_API_KEY: "sk-privatevalue",
        BOOLEAN_SECRET: false,
        OBJECT_SECRET: { nested: true }
      },
      tokensIn: 42,
      tokenCount: 7,
      publicStatus: "healthy",
      secretary: "public"
    }) as Record<string, unknown>;

    expect(redacted.apiKey).toBe(REDACTED_VALUE);
    expect(redacted.clientSecret).toBe(REDACTED_VALUE);
    expect(redacted.credential).toBe(REDACTED_VALUE);
    expect(redacted.Authorization).toBe(REDACTED_VALUE);
    expect(redacted.env).toEqual({
      OPENAI_API_KEY: REDACTED_VALUE,
      BOOLEAN_SECRET: REDACTED_VALUE,
      OBJECT_SECRET: REDACTED_VALUE
    });
    expect(redacted.tokensIn).toBe(42);
    expect(redacted.tokenCount).toBe(7);
    expect(redacted.publicStatus).toBe("healthy");
    expect(redacted.secretary).toBe("public");
  });

  it("handles cycles and accessors without recursion or getter execution", () => {
    let getterCalls = 0;
    const cyclic: Record<string, unknown> = { public: "survives" };
    cyclic.self = cyclic;
    Object.defineProperty(cyclic, "dangerous", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "secret";
      }
    });
    const redacted = redactControlValue(cyclic) as Record<string, unknown>;
    expect(redacted.public).toBe("survives");
    expect(redacted.self).toBe(CIRCULAR_VALUE);
    expect(redacted.dangerous).toBe(UNAVAILABLE_VALUE);
    expect(getterCalls).toBe(0);
  });

  it("enforces depth, node, key, array, and string caps at exact and plus-one boundaries", () => {
    const common = { maxDepth: 8, maxNodes: 100, maxObjectKeys: 3, maxArrayLength: 3, maxStringBytes: 16 };
    expect(redactControlValue({ a: 1, b: 2, c: 3 }, { limits: common })).toEqual({ a: 1, b: 2, c: 3 });
    expect(redactControlValue({ a: 1, b: 2, c: 3, d: 4 }, { limits: common })).toEqual({
      a: 1,
      b: 2,
      [TRUNCATION_KEY]: TRUNCATED_VALUE
    });
    expect(redactControlValue([1, 2, 3], { limits: common })).toEqual([1, 2, 3]);
    expect(redactControlValue([1, 2, 3, 4], { limits: common })).toEqual([1, 2, TRUNCATED_VALUE]);
    expect(truncateUtf8("a".repeat(16), 16)).toBe("a".repeat(16));
    const truncated = truncateUtf8("a".repeat(17), 16);
    expect(Buffer.byteLength(truncated)).toBe(16);
    expect(truncated.endsWith(TRUNCATED_VALUE)).toBe(true);

    expect(
      redactControlValue(
        { a: { b: { c: "too deep" } } },
        { limits: { maxDepth: 2, maxNodes: 100, maxObjectKeys: 10, maxArrayLength: 10, maxStringBytes: 64 } }
      )
    ).toEqual({ a: { b: TRUNCATED_VALUE } });
    expect(
      redactControlValue(
        { a: 1, b: 2, c: 3 },
        { limits: { maxDepth: 8, maxNodes: 3, maxObjectKeys: 10, maxArrayLength: 10, maxStringBytes: 64 } }
      )
    ).toEqual({ a: 1, b: 2, c: TRUNCATED_VALUE });
  });

  it("redacts headers, credentials, PEM, URL secrets, assignments, provider tokens, and paths", () => {
    const sentinel = 'CANARY"/value';
    const encoded = encodeURIComponent(sentinel);
    const escaped = JSON.stringify(sentinel).slice(1, -1);
    const base64 = Buffer.from(sentinel).toString("base64");
    const text = [
      "Authorization: Bearer header-secret",
      "Proxy-Authorization: Basic cHJveHk6c2VjcmV0",
      "Cookie: session=cookie-secret",
      "-----BEGIN PRIVATE KEY-----\nPRIVATE-CONTENT\n-----END PRIVATE KEY-----",
      "https://alice:hunter2@example.test/path?api_key=query-secret&ok=1",
      "PASSWORD=assignment-secret",
      "sk-ant-abcdefghijklmno",
      "ghp_012345678901234567890123456789",
      "xoxb-12345678-secret",
      "C:\\Users\\person\\private.txt",
      "/home/person/private.txt",
      sentinel,
      encoded,
      escaped,
      base64,
      "public-status=healthy"
    ].join("\n");
    const sanitized = sanitizeControlText(text, {
      sensitiveValues: [sentinel],
      paths: [{ value: "/home/person", replacement: "[home]" }],
      limits: { maxStringBytes: 8 * 1024 }
    });

    for (const forbidden of [
      "header-secret",
      "cHJveHk6c2VjcmV0",
      "cookie-secret",
      "PRIVATE-CONTENT",
      "alice:hunter2",
      "query-secret",
      "assignment-secret",
      "sk-ant-abcdefghijklmno",
      "ghp_012345678901234567890123456789",
      "xoxb-12345678-secret",
      "C:\\Users\\person",
      "/home/person",
      sentinel,
      encoded,
      escaped,
      base64
    ]) {
      expect(sanitized).not.toContain(forbidden);
    }
    expect(sanitized).toContain("public-status=healthy");
    expect(sanitized).toContain("ok=1");
    expect(sanitized).toContain(REDACTED_VALUE);
  });
});

describe("single-pass final serialization and byte gates", () => {
  it("serializes the redacted value once and accepts exact bytes but rejects plus one", () => {
    const overhead = Buffer.byteLength('{"value":""}');
    const maxBytes = 64;
    const exactValue = { value: "x".repeat(maxBytes - overhead) };
    const exact = serializeControlJson(exactValue, maxBytes);
    expect(exact.bytes).toBe(maxBytes);
    expect(exact.body.toString("utf8")).toBe(exact.json);
    expect(() => serializeControlJson({ value: exactValue.value + "x" }, maxBytes)).toThrow(ControlPayloadTooLargeError);

    const stringify = vi.spyOn(JSON, "stringify");
    try {
      serializeControlJson({ public: "survives", token: "private" }, 256, { sensitiveValues: ["private"] });
      expect(stringify).toHaveBeenCalledTimes(1);
    } finally {
      stringify.mockRestore();
    }
  });

  it("measures UTF-8 bytes rather than JavaScript characters", () => {
    const value = { value: "é" };
    const expected = Buffer.byteLength(JSON.stringify(value));
    expect(serializeControlJson(value, expected).bytes).toBe(expected);
    expect(() => serializeControlJson(value, expected - 1)).toThrow(ControlPayloadTooLargeError);
  });

  it("validates a route DTO before redaction and serialization", () => {
    const health = {
      schemaVersion: 1,
      service: CONTROL_SERVICE,
      instanceId: INSTANCE_ID,
      configId: CONFIG_ID,
      pid: 42,
      status: "ok",
      startedAt: NOW
    };
    const serialized = serializeControlResponse("health", health);
    expect(serialized.bytes).toBeLessThanOrEqual(CONTROL_RESPONSE_LIMITS.health);
    expect(() => serializeControlResponse("health", Object.assign({}, health, { config: { token: "private" } }))).toThrow(
      ControlProtocolError
    );
  });
});

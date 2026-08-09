# RawFramer tiny-frame allocation/performance reference audit

Date: 2026-08-09
Scope: research and design recommendation only; no product source, tests, or upstream inventory were changed.

## Executive conclusion

RelayForge's framing semantics are stricter than the surveyed implementations: the limit is on exact input bytes, input buffers are copied, callback access to raw bytes is synchronous and borrowed, and any oversized frame makes the entire stdout stream non-authoritative. Those properties should remain unchanged.

The six-million-short-line regression is an allocator-lifetime problem, not a scanning problem. Each nonempty `"i\n"` frame currently acquires a 64 KiB slab, copies one byte, emits it, and drops the slab. The recorded 70.068 second failure therefore caused about six million 64 KiB allocations—roughly 366 GiB of cumulative allocation churn—despite retaining almost no payload. Prior profiling attributed about 45% of samples to allocator lock/wake paths.

The minimal semantics-preserving fix is to keep one reusable small-frame slab per `RawFramer`. A slab containing an emitted frame must be treated as leased until the synchronous callback returns and returned to the one-slot cache in a `finally` block. It must not be made available during the callback: a callback may reenter `push()`, and the outer callback's raw view must remain stable for its documented lifetime. Multi-slab frames can retain the current concatenate-and-release behavior. This changes allocation lifetime only; it does not change copying, decoding, offsets, record timing, caps, CR handling, EOF behavior, or fatal authority.

No surveyed code should be copied. The recommendation is an independent implementation based on the local contract and general buffering ideas.

## Local authority and observed failure

### Exact contract

The authority was read from [`src/streaming.ts`](../../../../src/streaming.ts), [`src/normalize.ts`](../../../../src/normalize.ts), [`src/orchestrator.ts`](../../../../src/orchestrator.ts), [`tests/streaming-authority.test.ts`](../../../../tests/streaming-authority.test.ts), and [`tests/fixtures/emit-bytes.mjs`](../../../../tests/fixtures/emit-bytes.mjs).

| Concern | RelayForge behavior that must be preserved |
|---|---|
| Record limit | `MAX_FRAME_BYTES = 32 * 1024 * 1024`. The cap counts raw bytes excluding LF. Exactly the cap is accepted; the next byte is fatal, for terminated and unterminated frames and at every chunk split. |
| Storage | `SLAB_BYTES = 64 * 1024`; payload bytes are copied into framer-owned slabs. Empty frames use the shared empty buffer. |
| Tail | `MAX_TAIL_FRAMES = 50_000`. `BoundedTail` is capped in JavaScript characters and by absolute frame count, includes an unterminated EOF frame, and uses head eviction/compaction rather than repeated shifting. |
| Decoding | Raw bytes are decoded exactly once per accepted frame. Multibyte UTF-8 split across transport chunks and malformed/incomplete UTF-8 do not affect byte accounting. CR is ordinary frame content; only LF is the delimiter. |
| EOF | `finish()` is idempotent and emits a nonempty unterminated final frame; an empty remainder emits nothing. |
| Ownership | Source chunks are always copied. The callback's `raw` buffer is borrowed only for the synchronous call and must not be retained. This avoids caller mutation and avoids pinning a large source backing store. Normalization hashes terminal raw bytes synchronously and stores only digest, length, offsets, and frame index. |
| Fatal state | Oversize yields typed `FrameFatal { kind: "oversize", limitBytes, observedBytes, detail }`, clears retained partial state, and refuses later input. The offending prefix is never emitted. |
| Whole-stream authority | A fatal anywhere suppresses `StdoutStream.finish().verdict`, fallback authority, and cost—even if a valid terminal frame was emitted earlier. This is stronger than merely rejecting the offending record. |
| Flow | Framing and normalization callbacks are synchronous in the stdout `data` turn. Transcript writing is also synchronous. There is no asynchronous per-frame queue inside `RawFramer`; event-loop/kernel flow naturally gates the producer. Fatal handling promptly reaps the process scope. |

The authority suite pins exact-cap/cap-plus-one behavior across splits, prefix suppression, malformed byte counting, split multibyte input, CRLF treatment, EOF and idempotence, valid-terminal-prefix followed by an oversized byte, source mutation, large-backing-store release, bounded retention, real-child transcript/hash agreement, one-byte push RSS, a 70 MiB giant record, and the six-million `"i\n"` child case. The latter requires RSS growth below 128 MiB and elapsed time below 60 seconds (with a 120 second harness timeout).

### Recorded diagnostic evidence

The workflow baseline recorded 687 passing tests and two failures, one of which was the short-newline case at 70.068 seconds. The integration diagnosis identified one fresh 64 KiB slab per two-byte input frame, about 366 GiB of allocation churn, and allocator lock/wake activity in about 45% of samples. This is consistent with the current `allocSlab()` → one-byte copy → callback → reset path. It also explains why the large-record and retained-memory tests can pass while the tiny-record workload misses its time budget.

## Primary upstream: Untrivial-ai/agent-orchestrator

Repository pin: [`Untrivial-ai/agent-orchestrator@f65c48e296e20a816221a4003c75a5f0387967ec`](https://github.com/Untrivial-ai/agent-orchestrator/tree/f65c48e296e20a816221a4003c75a5f0387967ec) (2026-08-09).

### Browser runtime JSONL bridge

Files and tests:

- [`frontend/src/main/browser-runtime-link.ts`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/frontend/src/main/browser-runtime-link.ts)
- [`frontend/src/main/browser-runtime-link.test.ts`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/frontend/src/main/browser-runtime-link.test.ts)
- Introduction: [`3279c3a0b1e0a39164cf1a328a5d6e8639051de3`](https://github.com/Untrivial-ai/agent-orchestrator/commit/3279c3a0b1e0a39164cf1a328a5d6e8639051de3), [PR #3066](https://github.com/Untrivial-ai/agent-orchestrator/pull/3066), merged 2026-07-29.

The bridge uses `StringDecoder("utf8")`, concatenates decoded strings, and splits on LF. Command lines are limited to 1 MiB and results to 8 MiB, but the check is `Buffer.byteLength()` over an already decoded string. It therefore does not provide RelayForge's exact malformed-input raw-byte authority. Oversize destroys/reconnects the socket; malformed JSON is ignored. Close clears buffered data without `decoder.end()` or an unterminated-tail delivery. Socket writes await their callbacks, and per-session promise chains serialize command handling.

Focused tests cover split UTF-8 emoji, request/result behavior, structured errors, per-session ordering, and cancellation after connection close. They do not cover exact cap boundaries, malformed decoder boundaries, EOF tails, callback ownership, or newline floods.

Assessment against the requested questions:

- Reusable scratch/slab framing: **No**; decoded strings are repeatedly concatenated.
- Bounded records: **Partly**; decoded byte length is bounded, not original raw records.
- Backpressure: **Yes on writes** through awaited socket callbacks; command work is serialized.
- Callback ownership/mutation: **Not applicable/owned strings**; it offers no raw-byte evidence lease.
- Decoder boundaries: **Partly**; `StringDecoder` spans chunks, but close does not finish the decoder/tail.
- Fatal tail semantics: **No**; reconnect is connection-level and earlier commands may already have executed.

This implementation is less suitable for the authority boundary than the current RelayForge design.

### Terminal/process transport

Files, tests, and architecture:

- [`backend/internal/terminal/attachment.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/terminal/attachment.go)
- [`backend/internal/terminal/manager.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/terminal/manager.go)
- [`backend/internal/httpd/terminal_mux.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/httpd/terminal_mux.go)
- [`backend/internal/terminal/doc.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/terminal/doc.go) and [`docs/architecture.md`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/docs/architecture.md)
- [`backend/internal/terminal/attachment_test.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/terminal/attachment_test.go) and [`backend/internal/terminal/manager_test.go`](https://github.com/Untrivial-ai/agent-orchestrator/blob/f65c48e296e20a816221a4003c75a5f0387967ec/backend/internal/terminal/manager_test.go)
- Per-client attachment migration: [`7c97ee79cde2b57a23c9d3dea4490fc7454915ac`](https://github.com/Untrivial-ai/agent-orchestrator/commit/7c97ee79cde2b57a23c9d3dea4490fc7454915ac) (2026-06-12).

`copyOut` reuses a 32 KiB read buffer but copies every delivered chunk into a fresh owned slice before invoking `onData`; its contract says `onData` must not block. The manager has a single writer goroutine and a bounded channel (default 1024); enqueue is nonblocking and overflow cancels the connection. `TestEnqueueOverflowCancelsConn` pins that overload policy. The WebSocket reader has a 1 MiB limit. Architecture docs deliberately reject terminal replay buffering: terminal data is high-volume/ephemeral and the runtime resends initialization on attachment.

Assessment:

- Reusable scratch/slab framing: **Read scratch only**; asynchronous ownership still requires a per-message copy.
- Bounded records: **Transport messages yes** (WebSocket limit), but there is no LF record framer.
- Backpressure: **Explicit bounded overload policy**; queue overflow cancels rather than accumulating.
- Callback ownership/mutation: **Stronger for async use**; delivery is an owned copy.
- Decoder boundaries: **Binary/base64 transport**, not a text-decoding boundary.
- Fatal tail semantics: **Connection cancellation**, not RelayForge whole-stream authority suppression.

The reusable read scratch and bounded-queue cancellation are good architecture references, but copying each async callback payload is not the solution to synchronous tiny-frame churn.

## Alternative implementations

### OpenAI Codex remote MCP stdio

Repository pin: [`openai/codex@646f7c0a91b8e327d263335da68ae8ef212895ce`](https://github.com/openai/codex/tree/646f7c0a91b8e327d263335da68ae8ef212895ce) (2026-08-09).

Files and tests:

- [`codex-rs/rmcp-client/src/executor_process_transport.rs`](https://github.com/openai/codex/blob/646f7c0a91b8e327d263335da68ae8ef212895ce/codex-rs/rmcp-client/src/executor_process_transport.rs)
- [`codex-rs/rmcp-client/src/executor_process_transport_tests.rs`](https://github.com/openai/codex/blob/646f7c0a91b8e327d263335da68ae8ef212895ce/codex-rs/rmcp-client/src/executor_process_transport_tests.rs)
- [`codex-rs/rmcp-client/tests/stdio_message_limits.rs`](https://github.com/openai/codex/blob/646f7c0a91b8e327d263335da68ae8ef212895ce/codex-rs/rmcp-client/tests/stdio_message_limits.rs)
- Bound introduction and rationale: [PR #31805, “Bound remote MCP stdio lines”](https://github.com/openai/codex/pull/31805), merged 2026-07-09.
- Recent process-cleanup follow-up: [`9daa491fba341941820e202d18436ab45b610acc`](https://github.com/openai/codex/commit/9daa491fba341941820e202d18436ab45b610acc), [PR #37366](https://github.com/openai/codex/pull/37366), merged 2026-08-07.

`LineBuffer` owns a reusable `BytesMut`, tracks `scanned_len`, and uses `memchr` only on newly arrived bytes. It checks the raw pending line before extending storage. Stdout lines are bounded at 8 MiB and stderr lines at 1 MiB. `split_to` yields complete owned records, CR is trimmed, JSON is deserialized from bytes, and a nonempty unterminated tail is taken at EOF. A semaphore serializes writes and write completion is awaited. Broadcast sequence gaps clear buffers and close the transport.

The tests pin exact-cap/cap-plus-one behavior, new-byte-only scanning, multiple lines and partial tails, EOF delivery, sequence loss, and concurrent send serialization. Importantly, the implementation deliberately retains and delivers complete lines that appeared before an oversized line in the same event. PR #31805 documents that choice. A single upstream event may also contain many complete lines, so bounding a pending record does not independently bound total queued complete data.

Assessment:

- Reusable scratch/slab framing: **Yes**, via reusable `BytesMut`; this is the strongest surveyed coding-agent comparator.
- Bounded records: **Yes for pending raw lines**, before copy; complete-line accumulation still depends on event bounds/drain rate.
- Backpressure: **Yes on writes**; sequence gaps are fail-closed. Receive buffering is not the same synchronous callback model.
- Callback ownership/mutation: **Owned split buffers**, not borrowed callbacks.
- Decoder boundaries: **Strong**; JSON consumes raw record bytes, EOF tail is explicit, CR is stripped.
- Fatal tail semantics: **Incompatible**; earlier complete lines survive a later oversized line, and closure/EOF is exposed rather than a RelayForge typed fatal verdict gate.

Codex validates reusable raw-byte storage and scan-cursor design, but its authority rule must not be transplanted.

### Tokio `LinesCodec` / `FramedRead`

Repository pin: [`tokio-rs/tokio@ecd621dd2c1a5205a84f579225e1454b62af211c`](https://github.com/tokio-rs/tokio/tree/ecd621dd2c1a5205a84f579225e1454b62af211c) (2026-08-07).

Files and tests:

- [`tokio-util/src/codec/lines_codec.rs`](https://github.com/tokio-rs/tokio/blob/ecd621dd2c1a5205a84f579225e1454b62af211c/tokio-util/src/codec/lines_codec.rs)
- [`tokio-util/src/codec/decoder.rs`](https://github.com/tokio-rs/tokio/blob/ecd621dd2c1a5205a84f579225e1454b62af211c/tokio-util/src/codec/decoder.rs)
- [`tokio-util/src/codec/framed_impl.rs`](https://github.com/tokio-rs/tokio/blob/ecd621dd2c1a5205a84f579225e1454b62af211c/tokio-util/src/codec/framed_impl.rs)
- [`tokio-util/tests/codecs.rs`](https://github.com/tokio-rs/tokio/blob/ecd621dd2c1a5205a84f579225e1454b62af211c/tokio-util/tests/codecs.rs)
- Repeated oversize error regression: [issue #3555](https://github.com/tokio-rs/tokio/issues/3555), [PR #3556](https://github.com/tokio-rs/tokio/pull/3556), commit [`5756a005b94320bac27809590ee304421306687d`](https://github.com/tokio-rs/tokio/commit/5756a005b94320bac27809590ee304421306687d).
- EOF invalid-UTF-8 state fix: [PR #7011](https://github.com/tokio-rs/tokio/pull/7011), commit [`129f9fce4d63e348dfc076a2b974ab047bcf4e3f`](https://github.com/tokio-rs/tokio/commit/129f9fce4d63e348dfc076a2b974ab047bcf4e3f).
- `memchr` scan optimization: [PR #8141](https://github.com/tokio-rs/tokio/pull/8141), commit [`326bd2ccab228ece44da2806fe7748d20ce32e12`](https://github.com/tokio-rs/tokio/commit/326bd2ccab228ece44da2806fe7748d20ce32e12), merged 2026-06. The PR reports behavior-neutral benchmark improvements up to 3.93× end-to-end and about 35× for a 1 MiB no-delimiter scan.

`LinesCodec` keeps reusable `BytesMut`, `next_index`, a maximum length, and a discard state. It scans only new bytes through max-plus-one. Exactly the maximum is accepted; cap-plus-one errors. Direct codec use discards the offender to the next newline and can recover. `split_to` extracts lines, strips CR, and performs strict UTF-8 conversion. `decode_eof` emits a nonempty final record. `FramedRead` supplies an 8 KiB reusable read buffer and demand-driven stream polling; after a decoder error its wrapper terminates rather than repeatedly returning the error. The tests cover boundary bursts, CRLF, EOF, invalid UTF-8, and past infinite/repeated-error regressions.

Assessment:

- Reusable scratch/slab framing: **Yes**, with buffer capacity reuse and a scan cursor.
- Bounded records: **Yes**, raw byte length, including exact boundary tests.
- Backpressure: **Yes**, demand-driven stream polling; write framing also has a capacity boundary.
- Callback ownership/mutation: **Owned `BytesMut`/`String`**, not a borrowed synchronous raw view.
- Decoder boundaries: **Well-defined but different**; strict UTF-8 and CR stripping conflict with RelayForge.
- Fatal tail semantics: **Different**; the bare codec recovers after discard, while the stream wrapper terminates locally, neither invalidating all previously observed terminal authority.

Tokio provides the clearest generic evidence for reusable capacity plus “scan only new bytes,” but it is not a drop-in semantic model.

### `mcollina/split2`

Repository pin: [`mcollina/split2@ccbd1996e0fde327966e4c862d915ea28272d4ea`](https://github.com/mcollina/split2/tree/ccbd1996e0fde327966e4c862d915ea28272d4ea) (2026-07-18).

Files, tests, and history:

- [`index.js`](https://github.com/mcollina/split2/blob/ccbd1996e0fde327966e4c862d915ea28272d4ea/index.js)
- [`test.js`](https://github.com/mcollina/split2/blob/ccbd1996e0fde327966e4c862d915ea28272d4ea/test.js)
- Initial `maxLength`: [`aa3736e87d3e51284693ee87a2afcd59e34c5272`](https://github.com/mcollina/split2/commit/aa3736e87d3e51284693ee87a2afcd59e34c5272).
- Chunk-larger-than-cap/skip-overflow fix: [issue #23](https://github.com/mcollina/split2/issues/23), [PR #24](https://github.com/mcollina/split2/pull/24), commit [`618c73dcfd06c4a6523a42ab0f1b2c3955583f91`](https://github.com/mcollina/split2/commit/618c73dcfd06c4a6523a42ab0f1b2c3955583f91).
- Open repeated-concatenation/O(n²) report: [issue #49](https://github.com/mcollina/split2/issues/49). Open heap/backpressure report: [issue #55](https://github.com/mcollina/split2/issues/55).

`split2` is a Node Transform and therefore participates in normal stream backpressure. It uses `StringDecoder`, concatenates pending decoded strings, and splits them. `maxLength` is optional and applies after decoding in JavaScript string units, not original bytes. Default overflow errors; `skipOverflow` discards to a newline and then recovers. `_flush` calls `decoder.end()` and emits the tail. Tests cover byte-at-a-time UTF-8, truncated sequences, CRLF, maximum length, skip/recover, and mapper errors. The still-open O(n²) issue describes the exact danger of repeated concatenation and rescanning for long delimiter-free input.

Assessment:

- Reusable scratch/slab framing: **No**; immutable string concatenation is the central weakness.
- Bounded records: **Optional and decoded-unit based**, unsuitable for raw authority.
- Backpressure: **Yes at Transform output**, subject to normal Node stream behavior.
- Callback ownership/mutation: **Owned strings**, no raw-byte evidence.
- Decoder boundaries: **Good StringDecoder/tail handling**, but authority is post-decode.
- Fatal tail semantics: **Error or recover-and-skip**, not whole-stream verdict suppression.

This is a useful negative reference: convenient line splitting does not satisfy RelayForge's byte-authority or adversarial long-record requirements.

### Node.js core `readline`

Repository pin: [`nodejs/node@45ecaaddbeddcc317b1e794f1d82e45aeb5fbfbe`](https://github.com/nodejs/node/tree/45ecaaddbeddcc317b1e794f1d82e45aeb5fbfbe) (2026-08-09).

Files, tests, and history:

- [`lib/internal/readline/interface.js`](https://github.com/nodejs/node/blob/45ecaaddbeddcc317b1e794f1d82e45aeb5fbfbe/lib/internal/readline/interface.js)
- [`test/parallel/test-readline-async-iterators-backpressure.js`](https://github.com/nodejs/node/blob/45ecaaddbeddcc317b1e794f1d82e45aeb5fbfbe/test/parallel/test-readline-async-iterators-backpressure.js)
- Async-iterator fixed queue/backpressure optimization: [`0f3e5316c1eca4dfef2265554715a7c3542f11ec`](https://github.com/nodejs/node/commit/0f3e5316c1eca4dfef2265554715a7c3542f11ec).
- Final no-newline line fix: [issue #47305](https://github.com/nodejs/node/issues/47305), [PR #47317](https://github.com/nodejs/node/pull/47317), commit [`9decb2c3ea978bff3f2c78ca3391d11bc618a15d`](https://github.com/nodejs/node/commit/9decb2c3ea978bff3f2c78ca3391d11bc618a15d).
- Unicode line-separator work: [`a42bca785b0dd970b701071a28e81f7cf85231b8`](https://github.com/nodejs/node/commit/a42bca785b0dd970b701071a28e81f7cf85231b8).

Core `readline` uses `StringDecoder`, splits each new decoded chunk (with an LF fast path), retains only the pending decoded fragment, and synchronously emits line events. It has no record-size cap or raw evidence channel. End emits a nonempty pending line. Event callbacks do not themselves create backpressure; the async iterator uses a fixed 1024 queue and pauses/resumes its source. The optimization history explicitly notes that one input chunk can emit many more records than a high watermark before pause takes effect.

Assessment:

- Reusable scratch/slab framing: **No raw slab**; decoded pending strings remain.
- Bounded records: **No**.
- Backpressure: **Pause/resume for async iteration**, but one chunk can overshoot the queue watermark.
- Callback ownership/mutation: **Owned immutable strings**, no raw evidence.
- Decoder boundaries: **Mature StringDecoder and EOF behavior**, but newline/CR semantics differ.
- Fatal tail semantics: **None**.

Node core reinforces two lessons: EOF behavior needs explicit characterization, and downstream pause cannot retroactively bound a large current chunk's record fan-out.

## Reference Matrix

| Repository | Relevant implementation | Strength | Weakness | License | Reuse decision |
|---|---|---|---|---|---|
| RelayForge current | `RawFramer`: 64 KiB owned slabs, one-pass scan, exact raw-byte cap, LF-only framing, synchronous borrowed evidence, and whole-stream fatal authority | Strongest authority semantics and existing characterization suite | Drops a slab after every tiny frame, causing pathological allocation churn | MIT | `NOT_USED` as an upstream; local authority is optimized in place |
| Untrivial Agent Orchestrator `f65c48e` | Browser JSONL bridge plus terminal transport: decoded-string framing, awaited writes, reusable read scratch, owned async delivery, bounded queue, and overflow cancellation | Best explicit async ownership and overload policy in the coding-agent references | Browser path concatenates decoded strings and lacks exact raw-byte/EOF/fatal-tail semantics; terminal path is not an LF authority framer | Apache-2.0 | `ARCHITECTURAL_INSPIRATION` |
| OpenAI Codex `646f7c0` | Remote MCP stdio reusable `BytesMut`, scan cursor/memchr, raw pending-line cap, awaited writes, and owned records | Strong reusable-storage and scan-reuse implementation | Drops/closes the offender but preserves earlier work; semantics differ from RelayForge whole-stream authority | Apache-2.0 plus NOTICE | `ARCHITECTURAL_INSPIRATION` |
| Tokio `tokio-util` `adf736a` | `LinesCodec` reusable `BytesMut`, memchr scan, exact maximum, demand-driven polling, and owned output | Mature bounded line-codec mechanics and tests | Strict UTF-8, CR stripping, and skip/recover behavior conflict with RelayForge's raw-byte and fatal semantics | MIT | `ARCHITECTURAL_INSPIRATION` |
| `mcollina/split2` `ccbd199` | StringDecoder-based transform splitting with optional maximum | Small mature Node streaming comparator | Decoded-unit accounting and recover/skip modes do not preserve exact raw-byte authority | ISC | `IDEA_ONLY` |
| Node.js `45ecaadd` | Core readline chunk-local splitting, StringDecoder, async iteration, pause/resume, and EOF behavior | Mature decoder and iterator behavior | No record maximum, broader separators, queue overshoot, and no fatal-tail authority | Node permissive terms with bundled notices | `IDEA_ONLY` |

The matrix answers the audit's central question: Codex and Tokio solve reusable storage and scan reuse better, and Agent Orchestrator makes async overload/ownership more explicit, but none preserves RelayForge's combined raw-byte cap, source-copy isolation, synchronous evidence lease, and whole-stream fatal authority. Consequently none is suitable for direct adoption.

## Chosen design

### Best implementation discovered

RelayForge's existing `RawFramer` remains the strongest semantic
implementation. Codex and Tokio are best for reusable storage/scan mechanics,
and Agent Orchestrator is best for explicit async ownership and overload
policy, but none preserves the complete local authority contract.

### Why

The measured defect is slab lifetime, not scanning. A one-slot leased slab
fixes six-million-line allocation churn while preserving exact raw-byte caps,
copy isolation, callback lifetime, decoder behavior, offsets, EOF, and
whole-stream fatal authority.

### What RelayForge will reuse

Only `ARCHITECTURAL_INSPIRATION` for reusable-buffer lifetime, scan reuse, and
bounded overload concepts; `IDEA_ONLY` for split2/Node comparisons. No upstream
source, pseudocode, constants, comments, or tests are copied.

### What RelayForge will change

Change only the local slab lifetime: cache at most one inactive small slab and
lease an emitted slab until the synchronous callback finishes. Do not adopt
decoded-string accounting, CR stripping, recover-after-oversize, async payload
ownership, or partial-stream authority.

### How RelayForge will improve it

Add a single cached small slab to `RawFramer` and preserve all public behavior:

1. `allocSlab()` first consumes the cached slab, otherwise allocates exactly as today.
2. When a single-slab frame is emitted, remove/reset the active framing state before the callback as today, but retain a local reference to the emitted slab.
3. Invoke the callback inside `try/finally`.
4. Only after the callback returns (or throws), return that slab to a one-slot cache. If a reentrant callback already returned another slab to the cache, drop the extra slab; never overwrite a cached slab merely to keep the older one.
5. Keep the multi-slab concatenate path unchanged for the minimal patch. Keep empty-frame handling unchanged.

The lease rule is essential. Returning the slab before callback completion would allow a reentrant `push()` to overwrite the outer callback's `raw` buffer while it is still valid. A one-slot cache bounds spare capacity and makes the six-million-line path steady-state rather than proportional to frame count.

Do **not** replace copied bytes with `chunk.subarray()`: that would reintroduce source mutation and large-backing-store pinning. Do **not** decode before enforcing the cap, batch callback delivery, strip CR, skip-and-recover after oversize, or authorize previously seen terminal frames after a later fatal.

The cache makes allocated capacity differ from logical retained payload. Either document the internal capacity invariant as:

`logical retained bytes + cached capacity <= maxFrameBytes + min(SLAB_BYTES, maxFrameBytes)`

or explicitly extend diagnostics if `retainedBytes()` is intended to report capacity rather than live payload. The existing logical-retention meaning should not be changed accidentally.

Expected allocation shape for the `"i\n"` workload changes from approximately six million 64 KiB allocations (about 366 GiB cumulative) to one hot slab in steady state, while retaining the same one-byte copy, one decode, and one callback per frame.

### Additional future improvement

Replace the normalizer-facing mutable borrowed `Buffer` in a future, separately reviewed change with a synchronous evidence capability, for example an `exactRef()` closure owned by the framer that returns `{ sha256, bytes, startOffset, endOffsetExclusive, frameIndex }` while the lease is live. The normalizer could parse `text` and request exact evidence only for a terminal candidate without ever receiving mutable raw storage. This would make mutation/retention misuse structurally harder and make future slab reuse safer without hashing every nonterminal frame.

For any future asynchronous fan-out, also adopt an explicit bounded overload policy patterned on Agent Orchestrator's terminal manager: bounded queue plus deterministic cancellation/fatal propagation. No queue is needed for today's synchronous sink, so adding one now would enlarge rather than fix the problem.

## Characterization and regression tests for an implementation change

No tests were run for this research-only task. A product patch should preserve the existing suite and add focused allocator/lease characterization:

1. Keep exact-cap and cap-plus-one terminated/unterminated cases at every split; assert the first failing raw byte is fatal and the offending prefix is never emitted.
2. Keep the valid-terminal-prefix-plus-extra-byte test: a later fatal must still suppress verdict, cost, and fallback authority.
3. Keep malformed/incomplete UTF-8, multibyte split, CRLF-as-content, nonempty EOF tail, and idempotent `finish()` cases.
4. Keep source-buffer mutation and the tiny residual of a 64 MiB backing-store tests; reusable storage must remain framer-owned.
5. Add a reentrancy lease test: while handling frame A, synchronously call `push()` for frame B and verify A's raw bytes stay unchanged until A's callback returns, while B is correct.
6. Add a cross-frame isolation test that mutates a borrowed raw view during its valid callback window and verifies later frame text, bytes, offsets, and terminal evidence are unaffected. Do not assert retained raw stability after the callback; that is outside the contract.
7. Add an allocator-count seam/test: process at least 100,000 `"i\n"` records and assert slab allocation is O(1) (ideally at most two under the reentrant case), rather than relying only on timing/RSS.
8. Exercise callback throw paths so slab return occurs in `finally` without exposing a half-live frame or altering the already-established callback-error behavior.
9. Assert logical `retainedBytes()` at frame boundaries and, separately, the new one-slab capacity bound.
10. Retain the six-million-line real-child wall-clock/RSS regression, the giant-record regression, and live-versus-replay terminal hash/transcript equivalence as end-to-end guards.

## License and provenance conclusion

| Repository | License material inspected | Finding for this audit |
|---|---|---|
| RelayForge | Root `LICENSE`, package metadata | MIT. Local implementation remains the authority. |
| Untrivial-ai/agent-orchestrator | Root `LICENSE`; no `NOTICE` found; relevant files have no separate headers | Apache-2.0, Copyright 2026 Untrivial. Architecture reference only. |
| OpenAI Codex | Root `LICENSE` and `NOTICE`; relevant file has no separate header | Apache-2.0; NOTICE includes OpenAI Codex copyright and Ratatui-derived attribution. Reference only. |
| Tokio | Root `LICENSE` and `tokio-util/LICENSE`; no `NOTICE` found; relevant file has no separate header | MIT. Reference only. |
| `split2` | Root `LICENSE` and ISC header in `index.js`; no `NOTICE` found | ISC. Reference only. |
| Node.js | Root `LICENSE`, including bundled third-party notices; no separate `NOTICE`; relevant file has no header | Node's permissive MIT-style core terms plus applicable bundled notices. Reference only. |

All surveyed licenses are permissive, but copying or adapting protected expression would carry their notice and, for Apache-2.0 sources, Apache license/notice and modification obligations; copied Apache portions could not simply be represented as solely MIT code. This audit recommends no copied code, pseudocode, constants, comments, or test text. The chosen single-slot lease/cache design is independently derived from RelayForge's existing slab abstraction and documented callback contract. On that no-copy basis, no new third-party attribution is required in the product. The pinned provenance should remain in this audit. This is an engineering provenance conclusion, not legal advice.

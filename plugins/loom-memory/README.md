# Loom Memory for Claude Code and Codex

This plugin captures the complete JSONL records exposed by a connected local coding session, queues them durably, and sends batches to the existing Loom Memory API. It also recalls memories before user prompts and provides search, read, remember and explicit usage-report tools.

It does not choose which experiences are important. Conversation records, tool calls/results, failures, exposed reasoning records, compaction and unfamiliar host records are retained. Hidden model state and events that the host never exposes cannot be captured. A referenced image/file is captured as the host records it; an external asset's bytes are not fetched automatically.

The capture/extraction/recall/feedback loop has been exercised with real Claude Code and Codex sessions and a local service stack. Codex was verified through explicit MCP and hook configuration. Local vector search and a 20-client ingestion/replay test also passed. See [the local live-test evidence and its limits](../../docs/LOCAL_TEST.md).

## Build and configure

Node.js **22.13 or later** is required, including its built-in `node:sqlite` module. Node 22 may print an experimental SQLite warning to stderr. The bundle includes its JavaScript dependencies; installed clients do not need this repository's `node_modules`.

From the repository root:

```sh
npm ci
npm run build
```

Install the plugin and authenticate the remote `loom` MCP through the host's Loom browser-login action. The plugin's setup context lets the assistant connect the local collector using `connect_collector` and `complete_connection`. There is no separate token-copy or `configure` step. Local tools stay available while login is pending and adopt the completed enrollment without restarting.

The remote MCP remains independently usable. The bundled local helper adds full capture, prompt recall and explicit feedback. The default graph is personal. Capture begins after the authenticated connection is verified; installation before login does not upload transcripts.

Credentials are delegated as JWE ciphertext to a temporary key held only on this machine. They are decrypted locally, verified through the public MCP, and saved with mode 0600 under `~/.loom/agent-memory/`. `LOOM_MEMORY_HOME` overrides this path and must match for hooks and the local MCP. Configuration is never loaded from a project directory. Access tokens refresh automatically under a cross-process lock, while the queue identity remains endpoint + user + graph. A revoked grant asks the assistant to reconnect and retains the queue. Different accounts cannot reuse an existing enrollment.

`configure` remains only for legacy installations and isolated test fixtures; it is not the normal installation flow. Legacy queues retain their token-based identity and are not silently migrated into OAuth accounts.

Deploy the accompanying server change that classifies `capture_record` as stored audit material without a retrieval channel before enabling capture against production. Native message and tool episode behavior is unchanged.

## Load in Claude Code

Use the built plugin directory:

```sh
claude --plugin-dir /absolute/path/to/nd-cloud/plugins/loom-memory
```

Start a new session after installing. Authenticate Loom when the host requests it. This plugin bundles its MCP server and hooks. Do not also register a second copy of its hooks manually.

## Load in Codex

The verified path on Codex 0.154.0 is explicit MCP and hook configuration: merge [codex-config.example.toml](codex-config.example.toml) into your Codex configuration, replacing every placeholder path. Preserve existing hook entries when merging. Configure the same `LOOM_MEMORY_HOME` for the MCP server and hook commands if you override the default. Review and trust these hooks through Codex before starting a new session. The example permits the narrowly scoped `report_memory_use` tool to stage feedback without another approval; other tools retain their normal policy.

The public repository includes both marketplace catalogs. Follow the [repository installation instructions](../../README.md#codex) for GitHub registration or the verified direct configuration path. Package auto-loading remains a separate compatibility check from successful download and installation. A remote host must have the scripts and transcript records in its own execution environment.

## Collection and graph growth

1. A hook registers the current session's transcript path. The collector reads complete JSONL lines from its persisted byte offset. It does not crawl unrelated historical sessions.
2. Raw record content is preserved. Existing `message`, `tool_call`, `tool_result` and `thinking` shapes keep their server semantics. Tool metadata includes pairing ids and short rendering hints; full input/output remains in the raw content. Transport/audit records use `capture_record` and remain stored, without becoming conversational search candidates.
3. When a hook has no readable transcript, its full payload is retained as a hook observation. This is a distinct observation and can overlap with a later transcript record. No content-based heuristic deletes one of these records.
4. Subagent transcripts are followed when a hook exposes `agent_transcript_path`. Hosts that omit that path are not claimed as fully covered. Remote/hosted tools absent from both hooks and the transcript are unobservable.
5. The collector and source cursor commit together to a local SQLite WAL with synchronous durability. Partial records, invalid JSON, a record exceeding 16 MiB, and a full queue retain the cursor and expose a blocked state. No sampling or truncation is used to resolve overload. A single raw record can span multiple episodes with `record_id`, `part` and `parts` metadata.
6. The MCP process pumps collection/upload in the background. Multiple local sessions share an account queue and an upload lease. Session-end also attempts a bounded detached flush. Remaining work resumes when the next MCP process starts or via `flush`.
7. After a caught-up source is idle for 60 seconds, a completed turn reaches the five-minute segment age, or a session-end signal arrives, its ingestion segment is sealed. After all episodes in that segment are acknowledged, `/ingest/session-end` starts the existing segmenter/topic/extraction cascade. Continued activity creates a new immutable ingestion segment; the original host session id stays in every record's metadata. This is an idle-based approximation of Loom's task boundaries, not per-turn reprocessing of an ever-growing whole session.

The existing server's protocol cleanup, credential redaction, tool-output quarantine, worker scheduling, extraction thresholds and credit gates still apply. Full capture does not mean every record becomes a knowledge node or every node is extracted immediately.

## Request volume and delivery

Defaults are **100 episodes**, **512 KiB serialized JSON**, and a **10-second flush interval** for small batches. A full batch may send earlier. Capture happens locally on each event; it does not issue an HTTP ingestion request per tool call. Recall is a separate synchronous request per user prompt, with a four-second timeout.

The server batch endpoint supports up to 500 episodes. The client also bounds bytes because a tool result can be much larger than a chat message. Oversized records are split without losing their content.

Transient failures retain the exact batch keys and use exponential backoff with jitter. `Retry-After` on overload takes precedence. Invalid/auth/oversized requests retain the batch and wait five minutes before another attempt; `status` reports the failure. A successful batch is removed only after every submitted key appears in the API acknowledgement. This is at-least-once delivery into an idempotent API, not an exactly-once network promise.

Segment completion uses the existing API's pending-job deduplication. If its response is lost and the job finishes before retry, the server can enqueue that same range again; permanent completion idempotency is a remaining server improvement. This differs from episode delivery, whose idempotency survives completion.

The default outbox budget is 1 GiB. On exhaustion, collection stops advancing its source cursor and reports the problem. Source files remain the recovery source, so avoid deleting/rotating uncollected transcripts while blocked. Available disk space is finite; this cannot promise losslessness if both the source and durable queue are lost.

`status` reports queued events/bytes/oldest enqueue time, blocked source count, delivery/backoff state, completed batches/events/bytes and usage-report states. `flush` processes one bounded batch and one eligible segment; the MCP loop continues draining larger queues.

```sh
node plugins/loom-memory/dist/cli.js status
node plugins/loom-memory/dist/cli.js flush
```

The configuration accepts `batchEvents`, `batchBytes`, `flushMs`, `maxQueueBytes`, `segmentIdleMs`, and `segmentMaxMs`. `capture: false` stops collection and episode uploads without deleting pending data; `recall: false` disables automatic recall.

## Usage feedback and context limits

The prompt hook gives the model a receipt and up to roughly 6,000 characters of candidates. Local offered refs include only candidates actually included, plus explicit search/read results associated with that receipt. Server retrieval metrics may count additional candidates cut by the host-size budget; they are not exact client-delivery metrics.

`report_memory_use` records explicit use locally. A completed turn makes it eligible for delivery. Missing reports remain unknown; interruptions do not become empty picks. The server's picks endpoint is not idempotent: an ambiguous delivery is marked `delivery_unknown` and is not retried automatically into duplicate reinforcement. Episode capture continues independently of reporting.

Hooks append context; they cannot freely remove earlier host messages or reproduce native reasoning-stream injection. The plugin does not claim Loom CLI's exact folding or hidden reasoning visibility.

## Scaling beyond the first version

Batching reduces request overhead, not the number of stored bytes, index updates or extraction work. Measure three separate bottlenecks: ingress requests/bytes and latency, database/outbox pressure, and downstream worker lag/cost. The local counters are the first part; server metrics remain necessary for capacity decisions.

A central collector such as Vector is a reasonable next stage if measured ingress bursts require it. Vector supplies batching, disk buffers and backpressure, but buffering does not remove downstream work or create unlimited durable capacity. A production collector must sit behind tenant-aware authentication, preserve authorized graph identity, and acknowledge only according to its durable delivery contract. Do not turn a shared collector into an unscoped Memory API writer.

If DB/worker contention becomes the bottleneck, the next architecture is authenticated batch ingress → durable queue/object storage → rate-controlled materialization into the existing episode/index/worker pipeline. Keep synchronous recall on its own path. Whether Vector is that transport component should follow throughput, lag and outage-recovery measurements; this PR does not provision new infrastructure.

- [Vector buffering and backpressure](https://vector.dev/docs/architecture/buffering-model/)
- [Vector HTTP batching and acknowledgements](https://vector.dev/docs/reference/configuration/sinks/http/)

# Local live-loop verification

## Claude Code

Run on 2026-09-17 JST against implementation commit `a61b4382`. This was an actual Claude Code session test with real model calls, separate from the 81 local unit/integration tests. No production Memory deployment or production user graph was used.

## Environment

- Dedicated worktree-owned PostgreSQL, OpenSearch and Neo4j containers, with repository migrations applied to the empty PostgreSQL database.
- Local gateway and Memory API processes, a disposable user/graph and locally signed credentials.
- The real worker scheduler and shipped workflows, using the repository's default `deepseek/deepseek-v4-flash` / `deepseek/deepseek-v4-pro` model configuration through the local gateway.
- The built plugin loaded by Claude Code with `--plugin-dir`. Each session used a different empty working directory, an explicit MCP configuration, and no built-in filesystem/shell tools. `remember` was not allowed, so successful storage required automatic experience collection.
- A separate `LOOM_MEMORY_HOME`, so the run did not change the user's plugin enrollment or capture unrelated sessions.
- Embeddings disabled: this run verifies keyword/graph-backed retrieval, not the vector lane. Worker polling/stale-job thresholds were shortened to one second and client idle segmentation to ten seconds for this small fixture. Production defaults were not changed.

## Observations

1. A real Claude Code conversation established synthetic Cobalt Otter decisions: rollback phrase `ORCHID-482` and a 17-second busy-server retry delay. Hooks collected the host's JSONL records automatically. The server stored 34 episodes and queued segmentation; workers generated a topic and propositional relations. No prose knowledge was generated for this short factual input.
2. A second actual session described a synthetic retry-amplification investigation and reusable crash-test procedure. The ordinary relation-extractor produced a prose hint; the knowledge-extractor then created **Cobalt Otter retry amplification lesson**. There was no direct knowledge insertion or forced prose-extraction job.
3. The real sync worker indexed the captured and derived records and synchronized the graph. It reported 90 indexed, 15 reindexed and zero failed operations. Sync was invoked explicitly with `--once`; continuous indexing latency was not measured.
4. A fresh Claude Code session was asked for the earlier decisions without supplying their values or access to the earlier session directories. Its automatic recall receipt offered `tp:1`, `tp:2`, `ep:23`, and `ep:6`. The assistant correctly answered `ORCHID-482` and 17 seconds.
5. The assistant reported `ep:23`, `tp:1`, and `tp:2` as used. The local receipt reached `sent` after the real server accepted `/ingest/picks`. The raw recall-session experience was also captured.

After that recall turn the local graph contained 103 episode rows, 2 topics, 1 prose knowledge row, 16 semantic edges and 4 entities. The client had acknowledged 100 captured event parts in 13 batches, totaling 429,064 serialized episode bytes; queue bytes and blocked sources were both zero. Server record splitting and workflow-generated records mean the episode-row count is not the client-event count. This small, forced-flush fixture is not a throughput benchmark and is not expected to pack every batch to its maximum.

The first capture through successful recall took approximately four minutes. The test-owned services and volumes were removed after evidence collection. The “20 clients” statement inside that Claude transcript was synthetic lesson content. A separate actual 20-client ingestion test is recorded below.

## Limits

This proves an actual **Claude Code → capture → indexing/extraction → new Claude Code recall → explicit feedback delivery** loop on a local stack. It does not establish sustained load capacity, extraction quality across a corpus, or a measured ranking improvement from the accepted feedback. Separate Codex and vector tests follow below. The final recall relied on topic/episode refs; the generated prose knowledge was independently returned by `/retrieve/query` but was not among that turn's picked refs.

To repeat, use `scripts/stores.sh` to allocate worktree-owned services, migrate that dedicated database, and start the local gateway, Memory API and workers with matching local credentials and endpoint URLs. Configure the built plugin with a separate `LOOM_MEMORY_HOME`, load it into fresh Claude Code sessions, and use new synthetic decisions. Preserve transcript cursors and inspect queue/job failures; do not turn a missing store, skipped workflow, or empty recall into a successful result. Model calls require the developer's existing provider credentials even though the data services run locally.


## Codex, vectors and concurrent ingestion

Run on 2026-09-17 JST against implementation `a61b4382`, using a newly initialized worktree-owned stack. Data services and the gateway ran locally; Codex, worker inference and embeddings used real provider calls. No production Memory graph was used.

### Actual Codex loop

Codex 0.154.0 ran in two different empty working directories, with filesystem/shell tools disabled and `remember` unavailable. Explicit MCP configuration and SessionStart/UserPromptSubmit/Stop/SessionEnd command hooks pointed to the built plugin. Both used a separate `LOOM_MEMORY_HOME`. The test invocation bypassed trust review only for these reviewed test hooks; this is not a recommended persistent setting.

1. The seed conversation established synthetic Silver Heron decisions: rollback phrase `MAPLE-739`, retry delay 23 seconds, because a 2-second retry loop caused bursts. The native transcript was captured automatically: 33 server episode rows, then one topic produced by the real worker cascade. No prose knowledge was generated for this short factual input. At the observed checkpoint, workflow failures and pending workflow jobs were both zero.
2. The real sync worker, with embeddings enabled, reported 51 indexed, 3 reindexed, zero failed operations, and synchronized the derived graph. These totals include built-in records, not just this user's observations. Sync was invoked once, not continuously.
3. A new Codex session received `ep:10`, `ep:30`, `tp:1`, and `ep:6` through automatic prompt recall, without being supplied the answer values. It correctly answered `MAPLE-739` and 23 seconds.
4. Codex reported `ep:10` through `report_memory_use`; after Stop, its receipt reached `sent`, meaning the real server accepted feedback. Both native sources were marked ended without errors, and the local outbox was empty. The recall conversation was also captured.

The initial seed's usage call was denied under the test CLI's `never` approval policy and its receipt remained `unknown`. The successful recall run explicitly configured only `mcp_servers.loom_memory.tools.report_memory_use.approval_mode="approve"`; no missing feedback was converted into success.

**Package loading limitation:** `codex plugin list` reported the personal-marketplace package installed and enabled, but tested `codex exec` invocations did not expose its hooks or MCP tools. The successful loop used direct MCP/hook configuration, as shown in `codex-config.example.toml`. This result does not establish package auto-loading, remote hosts, or complete subagent coverage.

### Vector lane

The local embedding service used real `google/gemini-embedding-2@1536` calls. Both stored episode vectors and the query vector had 1,536 dimensions. The query was:

> What waiting interval did we settle on after rapid retries amplified traffic against an overloaded service?

A direct call to the production `knnSearch` adapter queried `episodes__g1` using only the vector and graph boundary, with no keyword query. Its first two hits were the correct Silver Heron assistant/user observations (`ep:30`, `ep:10`), with scores approximately 0.6233 and 0.6155. Repeating the same query with an unrelated graph UUID returned no episode hits. This verifies actual vector storage, kNN retrieval and the tested graph boundary; it does not measure general semantic relevance or the vector lane's incremental benefit over hybrid retrieval.

### Twenty-client ingestion and replay

Twenty distinct local users each had an independent durable SQLite queue containing 250 synthetic native Codex message records. Twenty uploaders drained concurrently against the real local Memory API and PostgreSQL database. Each uploader sent 100 + 100 + 50 records. The test then reset the transcript cursors and replayed every unchanged record through the same collector and uploader.

| Measurement | First delivery | Full replay |
|---|---:|---:|
| Client records submitted | 5,000 | 5,000 |
| HTTP batch requests | 60 | 60 |
| Serialized request bytes | 4,295,220 | 4,295,220 |
| Whole drain duration | 508 ms | 189 ms |
| Batch acknowledgement p50 / p95 | 161 / 209 ms | 43 / 60 ms |
| Non-200 responses | 0 | 0 |
| Remaining client queue records | 0 | 0 |
| Total stored test records after phase | 5,000 | 5,000 |

Every user's graph contained exactly 250 rows and 250 distinct native `record_id` values after both phases. The test checked each graph separately, not only an aggregate count. Replay added no duplicate episode rows. Batching reduced 5,000 per-event ingestion requests to 60 in this fixture (about 83× fewer); large records, elapsed-time flushes and recall requests change that ratio.

This is a short local ingestion burst, **not** a sustained capacity benchmark. Its downstream index jobs were deliberately left undrained, and extraction/load interaction, network latency, replicas, overload recovery and production operating cost were not measured. It supports using the existing durable client queue and batch endpoint first; it does not prove that another ingestion tier will never be needed. The separate fault/retry unit tests remain the evidence for retry behavior.

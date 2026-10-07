# Loom Plugins

Automatic experience capture and memory recall for Claude Code and Codex. The client keeps the session records the host exposes, batches them durably to Loom, and brings relevant memories into later prompts. It does not ask the model to choose which experiences are worth storing.

This repository contains the client source, ready-to-run bundles, and both hosts' marketplace catalogs. The Memory API and graph-processing services run separately.

## Requirements and login

- Node.js **22.13 or later** on the machine running your coding agent.
- A Loom account and a host that supports MCP OAuth, local MCP processes and hooks.
- Server support for `connect_collector` and `capture_record` episodes. The matching server change is [nd-cloud #540](https://github.com/neuradex/nd-cloud/pull/540); deploy it before activating this release.

The bundle is committed: installation does not require npm or a compiler.

Version 0.3.1 keeps the host MCP connection in a supervisor and runs capture/tools
in a replaceable worker. Requests have a 30-second response deadline; an independent
status probe detects idle stalls, and a 60-second collection watchdog ends a stuck
lock owner. Replacement waits for the old worker to exit before recovering its lock.
Queued records and receipts stay on disk. An interrupted write is never automatically
replayed: check whether it completed before retrying. Recovery tests pause a real
worker while it owns the capture lock and verify that the same host connection
recovers and delivers the retained record. Updates require reloading the installed
plugin once; these protections cannot be retrofitted into an already-running 0.3.0 process.

Version 0.3.2 closes two ways the shared capture lock could stall every session.
A live owner is now evicted after 120 seconds: a healthy owner only does local file
and SQLite work, and a 0.3.1+ worker ends itself after 60 seconds, so an older lock
belongs to a wedged process or to a pre-watchdog 0.3.0 process. One such process held
the lock idle for 12 hours while every hook of newer sessions waited its full
12-second budget and was then killed by the host at its own 12-second timeout. Hooks
now wait at most 3 seconds (1 second for SessionEnd) and answer with a busy notice
instead, and prompt recall, a network round trip, runs after the lock is released. An
evicted owner that wakes later cannot remove its replacement's lock. Processes still
running 0.3.0 or 0.3.1 gain none of this until the installed plugin is reloaded.

Version 0.3.3 changes what the prompt hook injects. The server's candidate lines are
full renders: a topic carries its tag list and embedded messages, and an episode carries
the whole captured transcript record as JSON (1.7–17 KB each in production). Under the
hook's block budget only three or four of the 16–17 ranked lines fit, and on a ten-question
probe the answer was the eleventh line as often as the first. The hook now renders every
candidate as a one-line card (ref, kind, date, title and a 300-character snippet of the
spoken text; machine records such as hook observations and tool results are left out) so
all ranked candidates fit in 8,000 characters, and the model reads the full text of the
ones it needs with memory_read. The recall deadline rises from 4 to 6 seconds, because the
production Memory API takes 2.5–3.8 seconds for a large personal graph and the slower third
of prompts received nothing; the hook's lock wait drops from 3 to 2 seconds so the total
stays inside the host's 12-second hook timeout.

Version 0.3.4 makes the plugin explain itself. The local MCP server's instructions now
describe the division between the remote `loom` server and this collector, that capture is
automatic, how recall cards and receipts work, and which tools manage graphs. When a
session starts, the hook tells the model the session's graph and capture state and shows
the person one line (`Loom → acme/frontend (.loom.yml) · last 24h: 3 sessions captured ·
last upload 2 min ago · queue 0 · recall ok (1 min ago)`); `notifications.session_start:
false` in `.loom.yml` or `settings.yaml` hides the line. Three slash commands cover what
people used to do in Loom CLI: `/loom-memory:graph`, `/loom-memory:switch <slug>` and
`/loom-memory:create`. No CLAUDE.md is needed for any of this; a project that should share
a team graph commits `.loom.yml` with `graph: org/slug`.

Install the plugin, then authenticate **Loom** in the host's MCP authentication UI. The assistant completes the local collector connection automatically. There is no API-key copy, private JSON preparation, or `configure` command in the normal flow.

The remote MCP works on its own. The plugin adds a local helper for capture, prompt recall, receipts and delivery status. After login, the helper receives an encrypted, renewable credential for the same Loom account. Only the local installation can decrypt it; the assistant does not receive readable tokens. Automatic capture starts in the personal graph after verification. A revoked or expired grant triggers reconnection while retaining queued experience.

Capture covers sessions connected to the installed hooks, including available messages and tool inputs/results. It does not crawl unrelated historical sessions. Credentials and the durable queue live under `~/.loom/agent-memory/`, outside the plugin cache. `LOOM_MEMORY_HOME` can override that location consistently for hooks and local MCP.

## Graphs

Every session captures to, and recalls from, one graph: your personal memory by default, or
a team graph pinned by the nearest `.loom.yml` above the project directory (`graph: org/slug`).
Commit that file and every teammate's plugin uses the same graph for that project.

- `/loom-memory:graph` shows the current graph, what pins it, and the graphs you can use.
- `/loom-memory:switch <slug>` (or `personal`) switches this session and writes `.loom.yml`.
  Experience already queued and receipts from earlier turns stay with the previous graph.
- `/loom-memory:create <organization> <slug>` creates a graph; it needs an owner role and does
  not switch by itself.

The same operations are MCP tools (`memory_status`, `list_graphs`, `switch_graph`,
`create_graph`), so Codex users ask for them in words.

## Claude Code

Run these commands inside Claude Code:

```text
/plugin marketplace add neuradex/loom-plugins
/plugin install loom-memory@loom-plugins
```

Review the requested plugin capabilities and start a new session. The package includes the remote Loom MCP, its local collector helper, and hooks. Authenticate Loom when prompted. Do not additionally register the same hooks by hand.

For a local checkout, the equivalent development entry point is:

```sh
claude --plugin-dir /absolute/path/to/loom-plugins/plugins/loom-memory
```

## Codex

Install from the marketplace commands below, authenticate Loom, and start a new thread. For hosts requiring explicit MCP and hook configuration, from your permanent checkout, generate configuration containing its actual absolute path:

```sh
node scripts/codex-config.mjs
```

Merge the output into your active Codex `config.toml`, preserving existing MCP servers and hook entries. Review/trust the hooks in Codex, then start a new thread. The generated configuration permits `report_memory_use` to stage the model's explicit feedback; other tools keep their usual approval policy. It does not modify your configuration itself. Keep the checkout at that path, or regenerate the configuration after moving it.

A Codex marketplace catalog is also included:

```sh
codex plugin marketplace add neuradex/loom-plugins
codex plugin add loom-memory@loom-plugins
```

**Compatibility:** Version 0.2.1 was verified through native marketplace installation in Codex 0.154.0: both MCP servers loaded, all eight hooks were enabled/trusted, and the existing browser login connected the collector to the production account without copying tokens. Version 0.2.0 used a Claude-only path variable that native Codex did not expand; upgrade to 0.2.1 or later. Start a new conversation to load the updated tools/hooks and check `memory_status`. Direct registration remains available for other hosts; choose one installation path to avoid duplicate hooks. See [the verification scope](docs/AUTH_TEST.md).

## Shared Loom CLI project settings

The plugin reads the same **`.loom.yml`** as Loom CLI, searching from the hook's project directory toward the filesystem root and using the nearest file:

```yaml
graph: acme/backend
notifications:
  recall_errors: false
```

`graph` selects the graph for automatic recall, experience capture and memory-use feedback. An empty or missing graph in that file selects personal memory. Server membership checks still authorize every request; a project file cannot change credentials or the API URL. With no project file, an explicitly configured collector graph remains the compatibility default (otherwise personal).

Each host session keeps its initial graph across directory changes, file edits and restarts. Start a new session to adopt a manual file edit, or use `switch_graph` to explicitly switch the running session. Sessions already captured before this update retain their original destination. Separate projects can use separate graphs concurrently; queued events and receipts remain isolated, and the uploader drains all registered graph queues.

Automatic recall failures are quiet by default. `notifications.recall_errors: true` shows their hook warnings. Notification edits in the session's `.loom.yml` apply on the next prompt. The old 0.2.2 `~/.loom/agent-memory/settings.yaml` is only a compatibility fallback when no project file was found; new configuration belongs in `.loom.yml`. Loom CLI ignores the extra notification key and its `/graph` command preserves it.

Local MCP tools use the current turn's `receipt` to retain the same graph; this also works after a restart. Without a receipt, pass the absolute project `cwd`. If several session graphs exist for that directory, use a receipt rather than guessing. Remote-only MCP clients continue to use their explicit graph argument; they cannot read local project files.

`memory_status` lists graph queues; pass `receipt` or `cwd` to inspect a project's settings, recall diagnostics and graph. Private credentials remain in `config.json`. Capture/configuration problems retain their warnings. Invalid notification preferences fall back to quiet mode with `settingsError` in status. Unreadable YAML or an invalid graph prevents a new session from being bound, so capture does not silently move into another graph; repair the file and retry.

## Create and switch graphs

Ask the agent to list your graphs, create one, or switch this project:

- `list_graphs` lists accessible graphs.
- `list_graph_organizations` lists creation destinations and your role.
- `create_graph(organization_id, slug, name)` calls the **same** `POST /me/organizations/:id/graphs` API as Loom CLI. Organization ownership and `memory:write` are checked on the server. Creation does not silently switch other sessions.
- `switch_graph(graph, receipt)` verifies access, updates `.loom.yml` while preserving comments/settings, and switches capture for the current session. An empty `graph` selects personal memory. If recall was unavailable, supply the host `session_id` and absolute `cwd` instead of a receipt.

A switch catches up the original transcript, seals its old capture cursor, and starts the destination at that cursor. Old queued episodes, segments and usage receipts stay in their original graph; later records go to the destination. Returning to an earlier graph does not replay the intervening transcript. A durable transition journal resumes an interrupted switch before capture continues. Other running sessions keep their existing selection; new sessions use the updated file.

Remote-only MCP provides discovery and creation through the same server API. Project/session selection belongs to the local client: the server does not store a global active graph that would mix concurrent projects. After an ambiguous creation failure, check `list_graphs` before retrying.

## Check delivery and update

```sh
node plugins/loom-memory/dist/cli.js status
node plugins/loom-memory/dist/cli.js flush
```

`flush` handles one bounded batch; the running MCP server keeps draining. An empty backlog confirms delivery, while blocked sources and failed delivery state need attention. It does not by itself prove that downstream extraction or a future recall succeeded.

For Claude Code, refresh the marketplace and update the plugin through `/plugin`. For Codex direct registration, update this checkout with `git pull --ff-only` and restart the session. Published plugin changes bump the plugin version; Git tags can pin a release. Removing a plugin or its configuration does not delete your saved memories or local queue. OAuth refresh preserves the same account queue. Switching accounts requires a separate enrollment; existing queued experience is never assigned to the newly signed-in account.

## Behavior and evidence

- Default batches: 100 event parts / 512 KiB / 10 seconds, with durable cursors and retry backoff.
- Closed, acknowledged ingestion segments start the server's existing topic/extraction workflow.
- Prompt hooks offer memories; explicit usage reports feed back only after turn completion. Missing reports stay unknown.
- Raw exposed records are retained, including unfamiliar record types. Hidden reasoning, unexposed host events and external attachment bytes are not promised.

See [browser-login verification](docs/AUTH_TEST.md), [public installation verification](docs/INSTALL_TEST.md), [the detailed client contract](plugins/loom-memory/README.md) and [local live-test evidence](docs/LOCAL_TEST.md), including actual Claude/Codex sessions, vector retrieval, and a 20-user batch/replay test. Those tests do not establish production capacity or universal host compatibility.

## Development

```sh
npm ci
npm run check
```

Client source lives in `plugins/loom-memory/src/`; the bundled runtime and its third-party notices ship inside the plugin directory. After changing source or dependencies, run `npm run build` and commit the resulting bundle. CI checks tests, type safety, catalog/package consistency and bundle freshness on Node 22 and 24. No provider credentials or production service access are required for this repository's tests.

[Claude Code marketplace documentation](https://code.claude.com/docs/en/plugin-marketplaces) · [Codex plugin documentation](https://developers.openai.com/plugins/build/plugins)

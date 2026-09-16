# Loom Plugins

Automatic experience capture and memory recall for Claude Code and Codex. The client keeps the session records the host exposes, batches them durably to Loom, and brings relevant memories into later prompts. It does not ask the model to choose which experiences are worth storing.

This repository contains the client source, ready-to-run bundles, and both hosts' marketplace catalogs. The Memory API and graph-processing services run separately.

## Requirements and enrollment

- Node.js **22.13 or later** on the machine running your coding agent.
- A Loom API token with `memory:read` and `memory:write` scopes. Browser login/token issuance is not included in this first release.
- A compatible Loom Memory API deployment, including support for storing `capture_record` episodes without offering them as conversational recall candidates.

The bundle is committed, so installation does **not** require npm, a compiler, or access to another repository.

```sh
git clone https://github.com/neuradex/loom-plugins.git
cd loom-plugins
```

Create a private JSON file **outside this checkout**, with the following structure and your own token:

```json
{
  "token": "YOUR_LOOM_TOKEN",
  "url": "https://api.neuradex.ai",
  "capture": true,
  "recall": true
}
```

```sh
node plugins/loom-memory/dist/cli.js configure < /absolute/path/to/private-config.json
node plugins/loom-memory/dist/cli.js status
```

Enrollment enables capture for sessions connected to these hooks. Available messages, tool inputs/results and other transcript records may contain project information; they are sent to your configured Loom graph. Credentials and the durable queue stay under `~/.loom/agent-memory/`, outside the plugin cache. `LOOM_MEMORY_HOME` can select another directory; use the same value for hooks, MCP, and configuration commands. Enrollment does not crawl old, unrelated sessions.

## Claude Code

After enrollment, run these commands inside Claude Code:

```text
/plugin marketplace add neuradex/loom-plugins
/plugin install loom-memory@loom-plugins
```

Review the requested plugin capabilities and start a new session. The package includes its MCP server and hooks. Do not additionally register the same hooks by hand.

For a local checkout, the equivalent development entry point is:

```sh
claude --plugin-dir /absolute/path/to/loom-plugins/plugins/loom-memory
```

## Codex

The verified path is explicit MCP and hook configuration. From your permanent checkout, generate configuration containing its actual absolute path:

```sh
node scripts/codex-config.mjs
```

Merge the output into your active Codex `config.toml`, preserving existing MCP servers and hook entries. Review/trust the hooks in Codex, then start a new thread. The generated configuration permits `report_memory_use` to stage the model's explicit feedback; other tools keep their usual approval policy. It does not modify your configuration itself. Keep the checkout at that path, or regenerate the configuration after moving it.

A Codex marketplace catalog is also included:

```sh
codex plugin marketplace add neuradex/loom-plugins
codex plugin add loom-memory@loom-plugins
```

**Compatibility:** Codex 0.154.0 was verified through direct MCP/hooks. In the earlier live test, a marketplace-installed plugin appeared installed/enabled but was not loaded by `codex exec`. Marketplace registration alone is not evidence that capture is active. Use `memory_status` and a new conversation to check your host. Choose either the marketplace path or direct registration to avoid duplicate hooks.

## Check delivery and update

```sh
node plugins/loom-memory/dist/cli.js status
node plugins/loom-memory/dist/cli.js flush
```

`flush` handles one bounded batch; the running MCP server keeps draining. An empty backlog confirms delivery, while blocked sources and failed delivery state need attention. It does not by itself prove that downstream extraction or a future recall succeeded.

For Claude Code, refresh the marketplace and update the plugin through `/plugin`. For Codex direct registration, update this checkout with `git pull --ff-only` and restart the session. Published plugin changes bump the plugin version; Git tags can pin a release. Removing a plugin or its configuration does not delete your saved memories or local queue. Drain pending capture before changing credentials, because queues are isolated by account identity.

## Behavior and evidence

- Default batches: 100 event parts / 512 KiB / 10 seconds, with durable cursors and retry backoff.
- Closed, acknowledged ingestion segments start the server's existing topic/extraction workflow.
- Prompt hooks offer memories; explicit usage reports feed back only after turn completion. Missing reports stay unknown.
- Raw exposed records are retained, including unfamiliar record types. Hidden reasoning, unexposed host events and external attachment bytes are not promised.

See [the detailed client contract](plugins/loom-memory/README.md) and [local live-test evidence](docs/LOCAL_TEST.md), including actual Claude/Codex sessions, vector retrieval, and a 20-user batch/replay test. Those tests do not establish production capacity or universal host compatibility.

## Development

```sh
npm ci
npm run check
```

Client source lives in `plugins/loom-memory/src/`; the bundled runtime and its third-party notices ship inside the plugin directory. After changing source or dependencies, run `npm run build` and commit the resulting bundle. CI checks tests, type safety, catalog/package consistency and bundle freshness on Node 22 and 24. No provider credentials or production service access are required for this repository's tests.

[Claude Code marketplace documentation](https://code.claude.com/docs/en/plugin-marketplaces) · [Codex plugin documentation](https://developers.openai.com/plugins/build/plugins)

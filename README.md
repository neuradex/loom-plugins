# Loom Plugins

Automatic experience capture and memory recall for Claude Code and Codex. The client keeps the session records the host exposes, batches them durably to Loom, and brings relevant memories into later prompts. It does not ask the model to choose which experiences are worth storing.

This repository contains the client source, ready-to-run bundles, and both hosts' marketplace catalogs. The Memory API and graph-processing services run separately.

## Requirements and login

- Node.js **22.13 or later** on the machine running your coding agent.
- A Loom account and a host that supports MCP OAuth, local MCP processes and hooks.
- Server support for `connect_collector` and `capture_record` episodes. The matching server change is [nd-cloud #540](https://github.com/neuradex/nd-cloud/pull/540); deploy it before activating this release.

The bundle is committed: installation does not require npm or a compiler.

Install the plugin, then authenticate **Loom** in the host's MCP authentication UI. The assistant completes the local collector connection automatically. There is no API-key copy, private JSON preparation, or `configure` command in the normal flow.

The remote MCP works on its own. The plugin adds a local helper for capture, prompt recall, receipts and delivery status. After login, the helper receives an encrypted, renewable credential for the same Loom account. Only the local installation can decrypt it; the assistant does not receive readable tokens. Automatic capture starts in the personal graph after verification. A revoked or expired grant triggers reconnection while retaining queued experience.

Capture covers sessions connected to the installed hooks, including available messages and tool inputs/results. It does not crawl unrelated historical sessions. Credentials and the durable queue live under `~/.loom/agent-memory/`, outside the plugin cache. `LOOM_MEMORY_HOME` can override that location consistently for hooks and local MCP.

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

Each host session keeps its initial graph across directory changes, file edits and restarts, matching Loom CLI's session semantics. Start a new session to adopt a changed graph. Sessions already captured before this update retain their original destination. Separate projects can use separate graphs concurrently; queued events and receipts remain isolated, and the uploader drains all registered graph queues.

Automatic recall failures are quiet by default. `notifications.recall_errors: true` shows their hook warnings. Notification edits in the session's `.loom.yml` apply on the next prompt. The old 0.2.2 `~/.loom/agent-memory/settings.yaml` is only a compatibility fallback when no project file was found; new configuration belongs in `.loom.yml`. Loom CLI ignores the extra notification key and its `/graph` command preserves it.

Local MCP tools use the current turn's `receipt` to retain the same graph; this also works after a restart. Without a receipt, pass the absolute project `cwd`. If several session graphs exist for that directory, use a receipt rather than guessing. Remote-only MCP clients continue to use their explicit graph argument; they cannot read local project files.

`memory_status` lists graph queues; pass `receipt` or `cwd` to inspect a project's settings, recall diagnostics and graph. Private credentials remain in `config.json`. Capture/configuration problems retain their warnings. Invalid notification preferences fall back to quiet mode with `settingsError` in status. Unreadable YAML or an invalid graph prevents a new session from being bound, so capture does not silently move into another graph; repair the file and retry.

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

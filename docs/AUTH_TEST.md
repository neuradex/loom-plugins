# Browser login and collector verification

Verified locally and against the deployed service on 2026-09-17. Server [nd-cloud #540](https://github.com/neuradex/nd-cloud/pull/540) was merged and deployed successfully ([deployment run](https://github.com/neuradex/nd-cloud/actions/runs/35194991567)).

- The real gateway OAuth test with a dedicated PostgreSQL 18.3 database passes: client registration, PKCE authorization, simulated identity-provider completion, code exchange, encrypted collector enrollment, refresh rotation and rejection of non-memory API access. Only the external identity-provider completion is simulated.
- MCP tests cover remote tool scope advertisement, fixed issuer forwarding, missing/read-only/legacy/API-key credential rejection, private/invalid key rejection, ciphertext binding, nonce/expiry checks, account verification and account-switch rejection.
- Client tests cover shared refresh locking, stable account queues across token rotation/restart, a bounded retry after an explicit 401, revoked-grant reconnection and retention of unsent feedback.
- A fresh standalone distribution bundle starts without config, exposes status/setup tools, and returns empty output on unauthenticated tool/Stop/compaction hooks. The test enrolls through its real stdio tool, verifies the token against a local HTTP MCP fixture, captures a complete record, recalls a candidate, sends explicit picks after Stop, and verifies connected state after restarting the process.
- The HTTP bundle fixture validates signed synthetic credentials; it does not use a real user's account or external model. The real gateway/database path and the standalone client path are separate tests. This is not a claim that every host automatically approves the setup tool calls.

The setup flow is native MCP browser login, followed by the assistant relaying a local public-key request through `connect_collector` and the encrypted result through `complete_connection`. No credential is read from the host's token store, pasted by the user, or returned in readable form to the assistant.

For isolated development the process environment can set `LOOM_MEMORY_API_URL` (HTTPS, or HTTP loopback). The issuer is never selected from a remote tool response or a project file. `LOOM_MEMORY_HOME` isolates all private state and queues.

## Production installation verification

The published 0.2.1 package was installed through the native Codex marketplace commands in Codex 0.154.0. The app-server reported both the remote `loom` and local `loom-memory` servers connected, with six tools each, and all eight plugin hooks enabled and trusted. Version 0.2.1 uses plugin-relative `cwd` for native Codex because its MCP argument parser does not interpolate Claude path variables. The distribution smoke test now launches the actual Codex manifest from a copied installation with spaces in its path and no repository dependencies.

Using the host's existing OAuth session, direct app-server MCP calls completed `memory_status` → remote `connect_collector` → local `complete_connection`. The local collector verified the production account, enabled capture and recall for the personal graph, and retained connected state in a fresh process. Credentials are renewable and the configuration has mode 0600. No token store was read or copied. Node 22 and 24 CI passed for the shipped runtime and native manifest.

This check intentionally disabled hooks only in the ephemeral verification thread and did not submit a model turn or synthetic production memories. The production queue and source list were empty; it proves installation and authenticated enrollment, not a new production capture/extraction/recall cycle. The live capture cycle remains covered by the local evidence above. Existing conversations retain their previously loaded tools/hooks; start a new conversation after updating.

# Browser login and collector verification

Verified locally on 2026-09-17. Production activation requires the server change in nd-cloud #540 before releasing/updating the plugin.

- The real gateway OAuth test with a dedicated PostgreSQL 18.3 database passes: client registration, PKCE authorization, simulated identity-provider completion, code exchange, encrypted collector enrollment, refresh rotation and rejection of non-memory API access. Only the external identity-provider completion is simulated.
- MCP tests cover remote tool scope advertisement, fixed issuer forwarding, missing/read-only/legacy/API-key credential rejection, private/invalid key rejection, ciphertext binding, nonce/expiry checks, account verification and account-switch rejection.
- Client tests cover shared refresh locking, stable account queues across token rotation/restart, a bounded retry after an explicit 401, revoked-grant reconnection and retention of unsent feedback.
- A fresh standalone distribution bundle starts without config, exposes status/setup tools, and returns empty output on unauthenticated tool/Stop/compaction hooks. The test enrolls through its real stdio tool, verifies the token against a local HTTP MCP fixture, captures a complete record, recalls a candidate, sends explicit picks after Stop, and verifies connected state after restarting the process.
- The HTTP bundle fixture validates signed synthetic credentials; it does not use a real user's account or external model. The real gateway/database path and the standalone client path are separate tests. This is not a claim that every host automatically approves the setup tool calls.

The setup flow is native MCP browser login, followed by the assistant relaying a local public-key request through `connect_collector` and the encrypted result through `complete_connection`. No credential is read from the host's token store, pasted by the user, or returned in readable form to the assistant.

For isolated development the process environment can set `LOOM_MEMORY_API_URL` (HTTPS, or HTTP loopback). The issuer is never selected from a remote tool response or a project file. `LOOM_MEMORY_HOME` isolates all private state and queues.

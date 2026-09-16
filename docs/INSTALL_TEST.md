# Public distribution verification

Verified on 2026-09-17 JST against initial public commit `c847c74`.

- A fresh Claude Code configuration directory added `neuradex/loom-plugins` over HTTPS, installed `loom-memory@loom-plugins`, and resolved version 0.1.0.
- Codex added the same GitHub marketplace, installed `loom-memory@loom-plugins`, and reported version 0.1.0 installed/enabled.
- The actual cache directory from each host passed `scripts/smoke.mjs`: MCP initialization, discovery of all five tools, and a successful `memory_status` call. Each process ran from an unrelated temporary directory with synthetic enrollment, capture/recall disabled, no repository dependencies, and no external service access.
- The standalone repository's 23 client tests, type check, marketplace validation and bundle check passed. The tests include real stdio and loopback HTTP capture/acknowledgement; they do not use a production Memory graph.
- GitHub Actions passed on Node 22 and 24, including reconstruction of the committed bundle and third-party notices without changes.

This proves GitHub distribution, host installation and standalone runtime startup. It does not prove that a marketplace-installed package is automatically loaded into a Codex inference session. Use the direct MCP/hook configuration documented in the root README until that compatibility issue is resolved. The separate live-loop evidence describes what was verified with real model sessions and local data services.

The temporary Claude configuration and Codex plugin installation were removed after verification. The Codex marketplace source remains registered for browsing. No user token or historical session was enrolled or uploaded by this installation test.

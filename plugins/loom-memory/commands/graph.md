---
description: Show which Loom graph this session captures to and recalls from, and the graphs you can switch to.
---
# /loom-memory:graph

Report where this session's memory goes, without changing anything.

1. Call the local `memory_status` tool with the absolute project directory as `cwd` (and the current turn's receipt if one was injected). Read `graph` (a slug, or `personal`), `project.file` (the `.loom.yml` that pins it, or null), `connection`, `queue` and `recall`.
2. Call `list_graphs` for the graphs this account can use.
3. Answer in a few lines: the current graph and what pins it; the other graphs by slug; whether capture is connected and the queue is draining; whether recall worked on the last prompt. Mention that `/loom-memory:switch <slug>` changes the graph for this session and the project, and `/loom-memory:create` makes a new one.

Why the file matters: the graph is pinned per session by the nearest `.loom.yml` above the project directory, so a teammate who commits that file sends everyone's capture to the same team graph.

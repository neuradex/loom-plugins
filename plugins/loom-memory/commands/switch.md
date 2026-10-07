---
description: Switch this session (and the project's .loom.yml) to another Loom graph, or back to personal memory.
argument-hint: <graph slug, or "personal">
---
# /loom-memory:switch

Target: `$ARGUMENTS`

1. If the target is empty, call `list_graphs` and ask which graph to use; do not guess.
2. Otherwise call `list_graphs` and check that the slug is accessible. `personal` (or an empty graph) means the person's own memory.
3. Call `switch_graph` with that graph. Pass the current turn's receipt when one was injected; if recall was unavailable on this turn, pass the host `session_id` and the absolute project `cwd` instead.
4. Confirm with `memory_status` and tell the person what changed.

What the switch does, so the answer is accurate: it writes `graph:` into the project's `.loom.yml` (created in the project directory if missing) and redirects this session's capture and recall from the next prompt on. Experience already queued, and receipts from earlier turns, stay with the previous graph. Other running sessions keep their graph until they restart or switch.

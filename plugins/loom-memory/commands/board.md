---
description: Show this session's working board — open and closed Loom inquiries with their grounding and graph refs, and the mirrored task list.
---
# /loom-memory:board

Show the working board without changing it.

1. Call the local `inquiry_list` tool with the current turn's receipt (or the absolute project directory as `cwd` when no receipt was injected).
2. Answer in a few lines: the open inquiries by id and title, the closed ones with their one-line answer and `kn:` ref when they have landed, and the task list with the active item marked. If a closed inquiry has not landed yet, say it is queued; if it carries a `landing_error`, say the graph rejected it and quote the classification.

Why the board exists: a question the model opens while hunting for an answer and closes with what it found lands in the graph as knowledge, so the next session gets the answer instead of repeating the hunt. Open questions also land, unindexed, so the graph can show "there is an unresolved question on this file".

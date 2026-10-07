---
description: Create a new Loom graph in an organization you own (does not switch to it).
argument-hint: <organization> <slug> [name]
---
# /loom-memory:create

Request: `$ARGUMENTS`

1. Call `list_graph_organizations`. Creation needs an owner role; if the person owns no organization, say so and stop.
2. Resolve the organization id and the slug from the request; ask for anything missing rather than inventing a slug.
3. Call `create_graph` once. If the call fails ambiguously (timeout, lost response), call `list_graphs` before retrying — the graph may already exist.
4. Creation does not switch anything. Offer `/loom-memory:switch <slug>` to start capturing there.

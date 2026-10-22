# Current limits

Public entry points and installation live in AGENT_QUICKSTART.md and AGENT_INSTALL.md. Released changes are listed in CHANGELOG.md; current validation is in international-validation.md. This file is not a version history.

These limits are still in force:

- Windows service lifecycle, logged-in browser reads and the public OAuth gateway have been checked. Real paid media processing and full-machine reboot recovery remain separate live checks.
- History route repair requires the recorded rejection and exact original task/node/output evidence. Missing or conflicting evidence stops repair. The native history button can remain absent when there is only one genuine result.
- Conditional model schema expressions are returned for review. The bridge does not evaluate arbitrary provider expressions.
- An uncertain dispatched command is recovered by its receipt and task, not by whatever the node currently shows.
- Project-specific meaning stays with the caller. The bridge checks only the exact expectations it was given.
- `rh_auto_layout` arranges selected nodes that are not in a group. Grouped shots use `rh_apply_layout_template`, which converts parent-relative positions onto the canvas grid.
- There is no MCP tool for arbitrary page evaluation, direct platform posting, or replacing the whole graph.
- A local canvas write waits for the same open socket's buffer to drain. Disconnects, socket replacement and flush timeouts return an unknown outcome with the original request ID; recovery reads the receipt and current node without resubmitting. Server durability still requires the official durable-ack outbox.

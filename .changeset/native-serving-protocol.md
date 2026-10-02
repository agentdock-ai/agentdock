---
"@agentdock-ai/agentdock": minor
"@agentdock-ai/contracts": minor
---

Fix native LangGraph interrupt/resume safety by removing serving checkpoint writes.
Update the event protocol with per-invocation run IDs, plural pending interrupts, static
breakpoints, scoped usage, recoverable continuation failures, and bounded reducer
replay. Preserve interleaved tokens, tool roles and errors, Command returns, nested
graph namespaces, raw fragmented arguments, and complete interrupt payloads.
Provide opt-in HITL presentation and application preflight validation, and expose
server-side error diagnostics.
Consumers must upgrade together; see MIGRATION.md.

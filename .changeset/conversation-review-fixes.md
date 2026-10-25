---
"@agentdock-ai/conversations": patch
"@agentdock-ai/contracts": patch
---

Return the core's `approval_expired` and `thread_busy` codes from the HTTP API
instead of a generic `conflict`, reject history cursors past the transcript end
with 400 instead of 503, and hash operation requests with locale-independent key
order.

---
"@agentdock-ai/agentdock": minor
"@agentdock-ai/contracts": minor
"@agentdock-ai/conversations": minor
---

Preserve native approval decision permissions and descriptions across streams and
checkpoint reloads. Reject forbidden decisions and tool renames before execution;
HITL presentation now uses the safe validator unless the host supplies its own.

Add SSE idle comments (15000 ms by default), a Node drain deadline (60000 ms),
shared in-process thread locking with a pluggable lease, mandatory approval audit
hooks and durable conversation decision receipts, and optional approval expiry.
Heartbeats and drain deadlines can be disabled with 0. Approval TTL requires
native checkpoint timestamps; missing timestamps fail closed. JSON event protocol
version 3 is unchanged.

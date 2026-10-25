---
"@agentdock-ai/agentdock": patch
---

Security: reject tool-name changes in edit decisions when using
`validateToolApprovalResume`, before graph execution or SSE headers. Edits may
still change arguments. Hosts that intentionally allow tool renaming can use
`createToolApprovalResumeValidator({ allowToolRename: true })`.

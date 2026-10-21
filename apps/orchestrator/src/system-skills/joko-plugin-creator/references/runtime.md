# Sandbox and host APIs

HTML runs in the host's isolated sandbox. It has no Node, host filesystem, saved
credentials or unrestricted RPC. Do not require/import native packages from a
resident page. Keep its scripts/assets inside the package and use the supplied
`window.joko` bridge. In a resident runtime it is injected before package scripts
execute; there is no `ready()` API. Register handlers at startup. A main-view page
has a different bridge: only `joko.library(operation)` when Library is declared.
It does not acquire the resident runtime's tools, tasks or network SDK.

Read [runtime signatures and the runnable example](runtime-api.md),
[network/file declarations](network-files.md) and [managed tasks/text](tasks.md)
for exact calls. Do not invent a `registerTool`, `invoke`, `getToken` or Node bridge.

The bridge offers declared operations, not arbitrary service access. Native
Extension code uses the actual installed Pi Extension API; do not call page SDK
methods from native Node code. Use declared tools for Agent-facing functions and
the original tool call's exact task/call context for work belonging to that call.

Tool results, cards and callbacks must retain original installation, task and
call identity. After reinstall, disable, owner change, closing a view or permission
revocation, stop using old receipts. An unknown write result must be read back
through its existing receipt; do not replay a side effect under a new key.

Network access is declared by exact destinations and routed by the host. Host
credential injection is private: do not read a token into page JavaScript, URLs,
cards or task messages. OAuth cards continue through the host's approved provider
and original task only. Use a host directory picker and the resulting selected
read/read_write authority for files, not an arbitrary absolute path from a page.

Cards and main views must use the host theme, support both modes and release media
and pending operations on owner/lifecycle change. Existing blob/media references
are scoped receipts; spelling an identifier never grants another task's data.

# Overview and design

A Joko plugin is an ordinary npm package containing a native Extension entry and,
when needed, inspected HTML for a resident runtime, main view or routine events.
Skills are a different resource type. A plugin does not acquire host authority
from a Skill name, page title or model prompt.

Start from the user's end-to-end job: trigger, inputs, produced result, where the
result appears, recovery and cancellation. Prefer existing Joko affordances and
plain names. UI should follow the host theme, fit the available column and phone
width, preserve drafts and explain unavailable actions in place. Avoid decorative
status cards, duplicate navigation and implementation details in user flows.

Declare only the exact tools, network destinations, file/credential access and
surfaces needed. Keep readonly tools readonly. Separate an Agent's one current
tool call from autonomous work: the current call's task context is not standing
permission to make new tasks or keep sending messages after the call ends.

Acceptance should cover the real function, its useful output, denied/revoked
access, stale task or installation, restart and any irreversible side effect.
Do not add adjacent formats, platforms or account integrations by inference.

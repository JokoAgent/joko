---
name: joko-plugin-creator
description: Create, edit, debug, validate and package Joko plugins as npm tarballs with package.json Extension surface declarations. Use for plugin authoring and host API questions; not for standalone Skills or simply using an installed plugin.
---

# Joko plugin creator

Build or update the plugin requested by the user. These documents ship with this
host; use the actual current-v1 contracts and keep the user's language.

1. Read [overview and design](references/overview.md), [structure and manifest](references/manifest.md),
   [sandbox and APIs](references/runtime.md), and [validation and packaging](references/packaging.md).
   For existing code inspect its package.json and source first. Preserve its
   identity and user data. State the concrete behavior, UI and permissions before
   implementing; ask only about necessary decisions left open by the request.
2. Use the selected task's actual working directory and native file/terminal
   tools to create source. Keep relative references and assets in the package.
   Do not use another computer's paths or assume that a tool is available.
3. Implement the complete function with the smallest exact permission declaration.
   For tools and cards, start with the runnable [status example](examples/status/package.json)
   and read [the runtime API](references/runtime-api.md). For remote services or
   file transfer read [network and files](references/network-files.md).
   Read [managed tasks and text](references/tasks.md) only if those APIs are needed.
   A resident page and an Agent tool invocation have different authority and
   lifetimes. Do not turn a user gesture into standing background permission.
4. Validate the real manifest and every declared entry, exercise normal/error/
   cancelled/revoked flows, and inspect UI in both themes at desktop and phone
   widths when applicable. Use the host's existing components and theme roles.
5. Produce an actual npm tar-gzip artifact using the packaging instructions.
   Report exactly what ran and which environments remain untested. Packaging
   does not install or publish. Use Joko's explicit import/approval flow only
   when installation is requested. Do not invent a cloud publishing service.

If native file, terminal, package validation or pack capabilities are unavailable,
say which is missing and continue useful source work. Never claim an artifact was
created, installed, published or tested merely because the files were written.

The Joko runtime bridge and package validator are authoritative. Do not guess APIs
from other products, create compatibility manifests, or copy a secret into source,
cards, task messages, logs or artifacts.

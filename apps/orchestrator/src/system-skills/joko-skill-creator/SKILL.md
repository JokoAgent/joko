---
name: joko-skill-creator
description: Create or update a reusable local Agent Skill with a SKILL.md entrypoint and any resources its workflow needs.
---

# Create a local Skill

Turn the requested workflow or an existing Skill into instructions that help an Agent make better decisions. Ask what the Skill should help with if the invocation supplies no goal or existing Skill. Use realistic examples only when they clarify when the Skill applies or how to use it.

For a new Skill, follow any location the user specified. Use `.agents/skills/<name>/` in the current project when the user asks for project scope. Use `~/.agents/skills/<name>/` by default for a reusable Skill on this node. Use the task's normal file tools and access controls. If the selected location is unavailable, ask the user to authorize it or choose an accessible location. Confirm the exact source directory before editing an existing Skill, and never overwrite another Skill just because the names match.

Choose a lowercase hyphenated name of at most 64 characters. The folder must match the `name` in the `SKILL.md` YAML frontmatter. Add a short `description` that says when to use it. In the Markdown body, explain the workflow, the choices that matter, and any known constraints. Keep supporting material in relative references, scripts, or assets only when the workflow needs it. Point to those files from `SKILL.md`.

Read the finished files back. Check the entrypoint, frontmatter, folder name and referenced files. Use a representative task to check that the instructions guide the intended decision when the workflow is complex. Report the actual created or updated path and any validation left to run.

To use a new project Skill in Joko, discover project resources from its trusted project and approve the reviewed revision. For a node-wide Skill, add its folder as a local Skill in Settings under Managed resources and approve the revision. Use the Skills page to enable or disable approved Skills. A Skill may need a refreshed or reopened task environment before it appears in the native command list. Leave installation, approval and publication to their respective user actions.

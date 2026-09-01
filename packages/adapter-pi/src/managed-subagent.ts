import { join } from "node:path";
import type { BackendToolDescriptor } from "@joko/core";

import { atomicWriteFile } from "./config.js";
import { MANAGED_SUBAGENT_FILE_NAME, MANAGED_SUBAGENT_SOURCE } from "./managed-subagent-source.js";
import {
  MANAGED_SUBAGENT_RUNNER_FILE_NAME,
  MANAGED_SUBAGENT_RUNNER_SOURCE
} from "./managed-subagent-runner-source.js";

export const MANAGED_SUBAGENT_PROFILE_NAMES = [
  "scout",
  "reviewer",
  "planner",
  "worker",
  "oracle",
  "researcher",
  "delegate"
] as const;

export const MANAGED_SUBAGENT_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
] as const;

export const MANAGED_SUBAGENT_TOOL_DESCRIPTORS: readonly BackendToolDescriptor[] = [
  {
    toolId: "subagent",
    name: "subagent",
    displayName: "Subagent",
    description: "Run bounded foreground, parallel, or background work in isolated Pi children; worker is approval-gated and write-enabled while other roles remain read-only.",
    inputSchema: {
      allowsAdditionalFields: false,
      fields: [
        { fieldPath: "action", title: "Action", description: "Run work, inspect managed health, or show usage guidance.", type: "string", required: false, secret: false, enumValues: ["run", "doctor", "guide"] },
        { fieldPath: "id", title: "Task ID", description: "Optional invocation-local task identifier.", type: "string", required: false, secret: false, enumValues: [], constraints: { minimumLength: 1, maximumLength: 64, pattern: "^[A-Za-z0-9_-]{1,64}$" } },
        { fieldPath: "agent", title: "Profile", description: "Built-in profile; worker is write-enabled and all others are read-only. Omit when customRole is supplied.", type: "string", required: false, secret: false, enumValues: MANAGED_SUBAGENT_PROFILE_NAMES },
        { fieldPath: "customRole", title: "Custom role", description: "Strictly read-only inline role; cannot expand permissions.", type: "object", required: false, secret: false, enumValues: [] },
        { fieldPath: "customRole.name", title: "Role name", description: "Invocation-local role name.", type: "string", required: true, secret: false, enumValues: [], constraints: { minimumLength: 1, maximumLength: 64, pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" } },
        { fieldPath: "customRole.prompt", title: "Role prompt", description: "Bounded role instruction under the mandatory read-only policy.", type: "string", required: true, secret: false, enumValues: [], constraints: { minimumLength: 1, maximumLength: 4_000 } },
        { fieldPath: "customRole.toolClass", title: "Tool class", description: "read exposes file reading only; search adds grep/find/list.", type: "string", required: true, secret: false, enumValues: ["read", "search"] },
        { fieldPath: "title", title: "Title", description: "Optional user-facing task title.", type: "string", required: false, secret: false, enumValues: [], constraints: { minimumLength: 1, maximumLength: 120 } },
        { fieldPath: "task", title: "Task", description: "Focused delegated task.", type: "string", required: false, secret: false, enumValues: [], constraints: { minimumLength: 1, maximumLength: 32_000 } },
        { fieldPath: "provider", title: "Provider", description: "Optional exact provider override; requires model and catalog validation.", type: "string", required: false, secret: false, enumValues: [], constraints: { minimumLength: 1, maximumLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" } },
        { fieldPath: "model", title: "Model", description: "Optional exact model override resolved within the session catalog.", type: "string", required: false, secret: false, enumValues: [], constraints: { minimumLength: 1, maximumLength: 500, pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/+=-]{0,499}$" } },
        { fieldPath: "thinking", title: "Thinking", description: "Optional provider/model-supported thinking level.", type: "string", required: false, secret: false, enumValues: MANAGED_SUBAGENT_THINKING_LEVELS },
        { fieldPath: "tasks", title: "Tasks", description: "One to eight delegated tasks.", type: "array", required: false, secret: false, enumValues: [], constraints: { minimumLength: 1, maximumLength: 8, itemFieldPath: "tasks[]" } },
        { fieldPath: "tasks[]", title: "Delegated task", description: "One independently routed parallel task.", type: "object", required: true, secret: false, enumValues: [] },
        { fieldPath: "tasks[].id", title: "Task ID", description: "Optional unique batch task identifier.", type: "string", required: false, secret: false, enumValues: [], constraints: { minimumLength: 1, maximumLength: 64, pattern: "^[A-Za-z0-9_-]{1,64}$" } },
        { fieldPath: "tasks[].agent", title: "Profile", description: "Built-in profile; worker is write-enabled and all others are read-only. Omit when customRole is supplied.", type: "string", required: false, secret: false, enumValues: MANAGED_SUBAGENT_PROFILE_NAMES },
        { fieldPath: "tasks[].customRole", title: "Custom role", description: "Strictly read-only invocation-local role.", type: "object", required: false, secret: false, enumValues: [] },
        { fieldPath: "tasks[].customRole.name", title: "Role name", description: "Invocation-local role name.", type: "string", required: true, secret: false, enumValues: [], constraints: { minimumLength: 1, maximumLength: 64, pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" } },
        { fieldPath: "tasks[].customRole.prompt", title: "Role prompt", description: "Bounded role instruction under the mandatory read-only policy.", type: "string", required: true, secret: false, enumValues: [], constraints: { minimumLength: 1, maximumLength: 4_000 } },
        { fieldPath: "tasks[].customRole.toolClass", title: "Tool class", description: "Read-only tool class.", type: "string", required: true, secret: false, enumValues: ["read", "search"] },
        { fieldPath: "tasks[].title", title: "Title", description: "Optional user-facing task title.", type: "string", required: false, secret: false, enumValues: [], constraints: { minimumLength: 1, maximumLength: 120 } },
        { fieldPath: "tasks[].task", title: "Task", description: "Focused delegated task.", type: "string", required: true, secret: false, enumValues: [], constraints: { minimumLength: 1, maximumLength: 32_000 } },
        { fieldPath: "tasks[].provider", title: "Provider", description: "Per-task exact provider override; requires model.", type: "string", required: false, secret: false, enumValues: [], constraints: { minimumLength: 1, maximumLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" } },
        { fieldPath: "tasks[].model", title: "Model", description: "Per-task exact model override.", type: "string", required: false, secret: false, enumValues: [], constraints: { minimumLength: 1, maximumLength: 500, pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/+=-]{0,499}$" } },
        { fieldPath: "tasks[].thinking", title: "Thinking", description: "Per-task supported thinking level.", type: "string", required: false, secret: false, enumValues: MANAGED_SUBAGENT_THINKING_LEVELS },
        { fieldPath: "background", title: "Background", description: "Return after launch; false waits in the foreground. Task arrays run in bounded parallel mode in either case.", type: "boolean", required: false, secret: false, enumValues: [] },
        { fieldPath: "isolation", title: "Isolation", description: "Inherit the current workspace or require an authoritative linked Git worktree.", type: "string", required: false, secret: false, enumValues: ["inherit", "require-worktree"] },
        { fieldPath: "context", title: "Context", description: "Use a fresh assignment or prepend an immutable bounded parent conversation snapshot.", type: "string", required: false, secret: false, enumValues: ["fresh", "fork"] },
        { fieldPath: "timeoutSeconds", title: "Timeout", description: "Per-child timeout in seconds (10–86,400; default 1,800).", type: "number", required: false, secret: false, enumValues: [], constraints: { minimumNumber: 10, maximumNumber: 86_400 } }
      ]
    },
    requiresPermission: true,
    streamingUpdates: true,
    enabled: true
  },
  {
    toolId: "subagent_status",
    name: "subagent_status",
    displayName: "Subagent status",
    description: "Inspect and control live or retained managed background subagent tasks.",
    inputSchema: {
      allowsAdditionalFields: false,
      fields: [
        { fieldPath: "action", title: "Action", description: "Background task operation.", type: "string", required: true, secret: false, enumValues: ["list", "inspect", "wait", "cancel", "steer", "follow_up", "resume"] },
        { fieldPath: "taskId", title: "Task ID", description: "Required by every action except list.", type: "string", required: false, secret: false, enumValues: [], constraints: { minimumLength: 1, maximumLength: 256 } },
        { fieldPath: "message", title: "Message", description: "Required by steer, follow_up, and resume.", type: "string", required: false, secret: false, enumValues: [], constraints: { minimumLength: 1, maximumLength: 32_000 } }
      ]
    },
    requiresPermission: true,
    streamingUpdates: false,
    enabled: true
  }
];

/**
 * Writes the Orchestrator-owned extension into the generation's isolated Agent Home.
 * It is loaded by absolute path after Pi's `--no-extensions` boundary.
 */
export async function provisionManagedSubagent(agentHome: string): Promise<string> {
  const path = join(agentHome, "managed", MANAGED_SUBAGENT_FILE_NAME);
  const runnerPath = join(agentHome, "managed", MANAGED_SUBAGENT_RUNNER_FILE_NAME);
  await Promise.all([
    atomicWriteFile(path, MANAGED_SUBAGENT_SOURCE),
    atomicWriteFile(runnerPath, MANAGED_SUBAGENT_RUNNER_SOURCE)
  ]);
  return path;
}

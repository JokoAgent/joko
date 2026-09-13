import type { BackendToolDescriptor, Capability, NativeSessionCandidate, ProviderModel } from "@joko/core";
import type { FakeAdapterProfile } from "./fake-adapter.js";

const TEXT_MODEL: ProviderModel = {
  providerId: "test",
  modelId: "text",
  displayName: "Test Text",
  api: "test",
  contextWindow: 32_000,
  maxOutputTokens: 4_000,
  supportsImages: false,
  supportsFastMode: false,
  thinkingLevels: ["off", "medium"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
};

const MULTIMODAL_MODEL: ProviderModel = {
  ...TEXT_MODEL,
  providerId: "vision",
  modelId: "multimodal",
  displayName: "Test Multimodal",
  supportsImages: true,
  thinkingLevels: ["low", "medium", "high"]
};

const READ_TOOL: BackendToolDescriptor = {
  toolId: "read",
  name: "read",
  displayName: "Read",
  description: "Read a file from the authorized workspace.",
  inputSchema: {
    fields: [{
      fieldPath: "path",
      title: "Path",
      description: "Workspace-relative file path.",
      type: "string",
      required: true,
      secret: false,
      enumValues: []
    }],
    allowsAdditionalFields: false
  },
  requiresPermission: false,
  streamingUpdates: false,
  enabled: true
};

const COMMAND_TOOL: BackendToolDescriptor = {
  toolId: "command",
  name: "command",
  displayName: "Command",
  description: "Run an authorized command in the workspace.",
  inputSchema: {
    fields: [{
      fieldPath: "command",
      title: "Command",
      description: "Command line to execute.",
      type: "string",
      required: true,
      secret: false,
      enumValues: []
    }],
    allowsAdditionalFields: false
  },
  requiresPermission: true,
  streamingUpdates: true,
  enabled: true
};

const PATCH_TOOL: BackendToolDescriptor = {
  ...COMMAND_TOOL,
  toolId: "apply_patch",
  name: "apply_patch",
  displayName: "Apply patch",
  description: "Apply a structured patch to workspace files.",
  streamingUpdates: false
};

export const PI_LIKE_PROFILE: FakeAdapterProfile = {
  id: "fake-pi-like",
  displayName: "Pi-like Fake",
  capabilities: capabilities({ discovery: true, resume: true, messageDelete: true, reset: true, steer: true, tree: true, compact: true, exportSession: true, plan: true, image: true, fastMode: false, userShell: true }),
  models: [TEXT_MODEL, MULTIMODAL_MODEL],
  tools: [READ_TOOL, { ...COMMAND_TOOL, toolId: "bash", name: "bash", displayName: "Bash" }],
  permissionModes: ["ask", "auto", "bypassPermissions"],
  nativeSessions: [nativeSession("fake://discovery/resumable", "native-resumable", "Resumable task")]
};

export const CODEX_LIKE_PROFILE: FakeAdapterProfile = {
  id: "fake-thread-like",
  displayName: "Thread-like Fake",
  capabilities: capabilities({ discovery: true, resume: false, messageDelete: false, reset: true, steer: false, tree: false, compact: true, exportSession: false, plan: true, image: true, fastMode: true, userShell: false }),
  models: [{ ...MULTIMODAL_MODEL, supportsFastMode: true }],
  tools: [READ_TOOL, COMMAND_TOOL, PATCH_TOOL],
  permissionModes: ["ask", "auto"],
  nativeSessions: [nativeSession("fake://discovery/read-only", "native-read-only", "Discoverable task")]
};

export const MINIMAL_PROFILE: FakeAdapterProfile = {
  id: "fake-minimal",
  displayName: "Minimal Fake",
  capabilities: capabilities({ discovery: false, resume: false, messageDelete: false, reset: false, steer: false, tree: false, compact: false, exportSession: false, plan: false, image: false, fastMode: false, userShell: false }),
  models: [TEXT_MODEL],
  tools: [],
  permissionModes: ["ask"]
};

function capabilities(input: {
  readonly discovery: boolean;
  readonly resume: boolean;
  readonly messageDelete: boolean;
  readonly reset: boolean;
  readonly steer: boolean;
  readonly tree: boolean;
  readonly compact: boolean;
  readonly exportSession: boolean;
  readonly plan: boolean;
  readonly image: boolean;
  readonly fastMode: boolean;
  readonly userShell: boolean;
}): readonly Capability[] {
  return [
    capability("session.discovery", input.discovery, "upstream_missing"),
    capability("session.resume", input.resume, "upstream_missing"),
    capability("session.message_delete", input.messageDelete, "not_implemented"),
    capability("session.reset", input.reset, "not_implemented"),
    capability("turn.stream", true),
    capability("turn.abort", true),
    capability("turn.steer", input.steer, "upstream_missing"),
    capability("turn.follow_up", true),
    capability("session.tree", input.tree, "upstream_missing"),
    capability("session.rewind", input.tree, "upstream_missing"),
    capability("session.fork", input.tree, "upstream_missing"),
    capability("context.compact", input.compact, "upstream_missing"),
    capability("session.export", input.exportSession, "not_implemented"),
    capability("plan_mode", input.plan, "upstream_missing"),
    capability("input.image", input.image, "upstream_missing"),
    capability("input.text", true),
    capability("permission.modes", true),
    capability("model.switch", true),
    capability("model.effort", true),
    capability("model.fast_mode", input.fastMode, "upstream_missing"),
    capability("runtime.user_shell", input.userShell, "upstream_missing")
  ];
}

function nativeSession(nativeReference: string, nativeSessionId: string, name: string): NativeSessionCandidate {
  return {
    nativeReference,
    nativeSessionId,
    name,
    workspaceRoot: "/adapter-private-workspace",
    messageCount: 3,
    modifiedAt: 1_000,
    state: "ready"
  };
}

function capability(key: string, supported: boolean, reason: "upstream_missing" | "not_implemented" = "upstream_missing"): Capability {
  return supported ? { key, supported: true } : { key, supported: false, reason, detail: `${key} is deliberately unavailable in this conformance profile.` };
}

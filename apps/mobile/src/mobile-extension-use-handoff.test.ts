import { create } from "@bufbuild/protobuf";
import {
  McpServerState,
  ResourceState,
  SessionState,
  SnapshotSchema,
  TargetState
} from "@joko/contracts";
import { describe, expect, it } from "vitest";
import {
  appendMobileSelectionQuote,
  insertMobileSessionMention,
  plainTextMobileComposerDraft
} from "./mobile-composer-document";
import {
  applyMobileExtensionUseCommand,
  assertMobileExtensionTaskChoice,
  mobileExtensionNewTaskTarget,
  mobileExtensionUseReady,
  projectMobileExtensionTaskChoices,
  resolveMobileExtensionUseCommand
} from "./mobile-extension-use-handoff";
import type { MobileExtension, MobileExtensionOwner } from "./mobile-extensions";

const command = { name: "compose", description: "Draft a reply.", sessionId: "advertising-task" };

function extension(owner: MobileExtensionOwner = {
  kind: "resource",
  resourceId: "resource-one",
  discoveredRevision: "sha256:resource-one",
  resourceRevision: 7n
}): MobileExtension {
  return {
    extensionId: "extension_11111111111111111111111111111111",
    revision: 4n,
    owner,
    source: "local",
    installed: true,
    installState: "installed",
    name: "Mail",
    description: "Draft mail.",
    enabled: true,
    sidebarSupported: false,
    sidebarVisible: false,
    tools: [],
    permissions: [],
    commands: [command],
    setup: { state: "ready", revision: 2n, fields: [{
      fieldId: "credential",
      label: "Credential",
      description: "",
      kind: "secret",
      required: true,
      configured: true,
      options: []
    }] },
    useSupported: true,
    updateAvailable: false
  };
}

function ownerSnapshot() {
  return create(SnapshotSchema, {
    generation: 1n,
    targets: [
      { targetId: "target-one", backendId: "backend-one", displayName: "Project One",
        state: TargetState.ACTIVE, version: { revision: { value: 3n } } },
      { targetId: "target-two", backendId: "backend-two", displayName: "Project Two",
        state: TargetState.ACTIVE, version: { revision: { value: 4n } } },
      { targetId: "target-retired", backendId: "backend-one", displayName: "Retired",
        state: TargetState.ARCHIVED, version: { revision: { value: 5n } } }
    ],
    resources: [{
      resourceId: "resource-one",
      backendId: "backend-one",
      targetId: "target-one",
      name: "Mail",
      state: ResourceState.LOADED,
      enabled: true,
      discoveredRevision: "sha256:resource-one",
      entityVersion: { revision: { value: 7n } }
    }],
    mcpServers: [{
      mcpServerId: "mcp-one",
      displayName: "Mail tools",
      state: McpServerState.CONNECTED,
      enabled: true,
      version: { revision: { value: 9n } }
    }],
    sessions: [
      { sessionId: "task-one", backendId: "backend-one", targetId: "target-one",
        displayName: "Alpha", state: SessionState.IDLE, nativeBinding: { runtimeGeneration: 2n } },
      { sessionId: "task-two", backendId: "backend-two", targetId: "target-two",
        displayName: "Beta", state: SessionState.IDLE, nativeBinding: { runtimeGeneration: 3n } },
      { sessionId: "task-archived", backendId: "backend-one", targetId: "target-one",
        displayName: "Archived", state: SessionState.ARCHIVED, archived: true,
        nativeBinding: { runtimeGeneration: 4n } },
      { sessionId: "task-closed", backendId: "backend-one", targetId: "target-one",
        displayName: "Closed", state: SessionState.CLOSED, nativeBinding: { runtimeGeneration: 5n } },
      { sessionId: "task-unbound", backendId: "backend-one", targetId: "target-one",
        displayName: "Unbound", state: SessionState.IDLE },
      { sessionId: "task-retired", backendId: "backend-one", targetId: "target-retired",
        displayName: "Retired", state: SessionState.IDLE, nativeBinding: { runtimeGeneration: 6n } }
    ]
  });
}

describe("Mobile Extension task command handoff", () => {
  it("requires a ready exact Extension and a command loaded in the scoped runtime", () => {
    const expected = extension();
    const current = { ...expected, commands: [{ ...command, sessionId: "task-one" }] };

    expect(mobileExtensionUseReady(expected)).toBe(true);
    expect(resolveMobileExtensionUseCommand(expected, command, current, "task-one"))
      .toEqual({ ...command, sessionId: "task-one" });
    expect(() => resolveMobileExtensionUseCommand(expected, command,
      { ...current, revision: 5n }, "task-one")).toThrow(/changed/u);
    expect(() => resolveMobileExtensionUseCommand(expected, command, current, "task-two"))
      .toThrow(/not loaded/u);
    expect(mobileExtensionUseReady({ ...expected, setup: { ...expected.setup, state: "required" } })).toBe(false);
    expect(mobileExtensionUseReady({ ...expected, installState: "error" })).toBe(false);
  });

  it("projects only live runtimes owned by the exact Resource or MCP revision", () => {
    const snapshot = ownerSnapshot();
    const resource = extension();

    expect(projectMobileExtensionTaskChoices(snapshot, resource)).toEqual([{
      sessionId: "task-one",
      displayName: "Alpha",
      targetName: "Project One"
    }]);
    expect(mobileExtensionNewTaskTarget(snapshot, resource)).toBe("target-one");
    expect(assertMobileExtensionTaskChoice(snapshot, resource, "task-one").sessionId).toBe("task-one");
    expect(() => assertMobileExtensionTaskChoice(snapshot, resource, "task-two")).toThrow(/no longer available/u);
    expect(projectMobileExtensionTaskChoices(snapshot, extension({
      kind: "mcp", serverId: "mcp-one", serverRevision: 9n
    })).map((choice) => choice.sessionId)).toEqual(["task-one", "task-two"]);
    expect(projectMobileExtensionTaskChoices(snapshot, extension({
      kind: "mcp", serverId: "mcp-one", serverRevision: 10n
    }))).toEqual([]);
  });

  it("replaces only the leading command and preserves structured ranges and attachments", () => {
    const mentioned = insertMobileSessionMention(
      plainTextMobileComposerDraft("/old Review "),
      { start: 12, end: 12 },
      { sessionId: "source-task", displayText: "Task" },
      "mention-one"
    ).draft;
    const quoted = appendMobileSelectionQuote(mentioned, {
      sourceSessionId: "source-task",
      sourceMessageId: "message-one",
      sourceEventId: "event-one",
      sourceRole: "assistant",
      text: "Quoted text"
    }, "quote-one").draft;
    const source = {
      ...quoted,
      attachments: [{
        state: "uploaded" as const,
        attachmentId: "proof-one",
        kind: "file" as const,
        fileName: "proof.pdf",
        mediaType: "application/pdf",
        byteSize: 7,
        sha256Hex: "a".repeat(64),
        capturedAtUnixMs: 100,
        blobId: "blob-proof"
      }]
    };
    const result = applyMobileExtensionUseCommand(source, "compose", true);
    const shift = "/compose".length - "/old".length;

    expect(result.text.startsWith("/compose Review @Task")).toBe(true);
    expect(result.mentions[0]).toMatchObject({ start: source.mentions[0]!.start + shift,
      end: source.mentions[0]!.end + shift, sessionId: "source-task" });
    expect(result.atoms[0]).toMatchObject({ start: source.atoms[0]!.start + shift,
      end: source.atoms[0]!.end + shift, atomId: "quote-one" });
    expect(result.attachments).toEqual(source.attachments);
    expect(result.slashCommands).toEqual([{ text: "/compose", start: 0, end: 8 }]);
  });

  it("prefills a new-task draft as plain leading text without runtime marks", () => {
    const result = applyMobileExtensionUseCommand(plainTextMobileComposerDraft("Keep this"), "compose", false);

    expect(result.text).toBe("/compose Keep this");
    expect(result.slashCommands).toEqual([]);
  });
});

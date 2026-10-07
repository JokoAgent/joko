import { describe, expect, it } from "vitest";

import { plainTextToComposerDocument } from "./composer-quote-document.js";
import {
  advancePendingExtensionSuggestion,
  extensionSuggestionApplicable,
  extensionSuggestionPrompt,
  localizeExtensionRecommendation,
  normalizeExtensionRecommendation,
  resolvePendingExtensionSuggestion,
  sameExtensionRecommendation,
  serializeExtensionSuggestionOwner
} from "./extension-suggestion-handoff.js";
import type {
  ExtensionCatalogEntryView,
  ExtensionCatalogView,
  ExtensionPackagePreviewView,
  ExtensionRecommendationView,
  PendingExtensionSuggestionView,
  ResourceView,
  TargetView
} from "./model.js";

const recommendation: ExtensionRecommendationView = {
  id: "review-mail",
  label: "Review mail",
  prompt: "Review the messages needing attention.",
  locales: {
    en: { label: "Review inbox", prompt: "Review the inbox." },
    "zh-CN": { label: "检查邮件", prompt: "检查需要处理的邮件。" }
  }
};

const resourceOwner = {
  kind: "resource",
  resourceId: "resource-1",
  discoveredRevision: "sha256:resource",
  resourceRevision: 4n
} as const;

function extension(overrides: Partial<ExtensionCatalogEntryView> = {}): ExtensionCatalogEntryView {
  return {
    id: "extension_0123456789abcdef0123456789abcdef",
    revision: 7n,
    owner: resourceOwner,
    source: "local",
    installed: true,
    installState: "installed",
    name: "Mail tools",
    description: "Review messages",
    enabled: true,
    sidebarSupported: false,
    sidebarVisible: false,
    tools: [],
    permissions: [],
    commands: [],
    recommendations: [recommendation],
    setup: { state: "notRequired", revision: 0n, fields: [] },
    useSupported: false,
    ...overrides
  };
}

function pending(entry = extension(), item = recommendation): PendingExtensionSuggestionView {
  return {
    nonce: "01234567-89ab-4cde-8fab-0123456789ab",
    phase: "ready",
    extensionId: entry.id,
    extensionRevision: entry.revision.toString(10),
    owner: serializeExtensionSuggestionOwner(entry.owner),
    recommendation: item,
    selectedLabel: item.label,
    selectedPrompt: item.prompt,
    contextKey: JSON.stringify([1, "server", "profile", "7", "target", "target-1"]),
    draft: {
      selection: { kind: "target", targetId: "target-1" },
      nativeStart: { kind: "fresh" },
      providerId: "provider",
      modelId: "model",
      fastMode: false,
      permissionMode: "ask",
      planMode: false,
      text: "original",
      editorDocument: plainTextToComposerDocument("original"),
      mentions: [],
      attachments: []
    },
    backendId: "backend-1",
    targetId: "target-1"
  };
}

const target: TargetView = {
  id: "target-1",
  revision: 3n,
  backendId: "backend-1",
  name: "Project",
  workspaceId: "workspace-1",
  workspaceName: "Project",
  trusted: true,
  pinned: false,
  archived: false
};

function resource(overrides: Partial<ResourceView> = {}): ResourceView {
  return {
    id: resourceOwner.resourceId,
    backendId: "backend-1",
    name: "Mail tools",
    kind: "extension",
    scope: "global",
    state: "loaded",
    enabled: true,
    source: "mail-tools",
    discoveredRevision: resourceOwner.discoveredRevision,
    compatibilityDetails: [],
    runtimeRequirements: [],
    warnings: [],
    disabledLifecycleScripts: [],
    canToggle: true,
    requiresExtensionApproval: false,
    postMutationNotice: false,
    ...overrides
  };
}

function catalog(entry: ExtensionCatalogEntryView): ExtensionCatalogView {
  return { revision: 1n, extensions: [entry], recoveredFromCorruption: false };
}

describe("Extension suggestion handoff", () => {
  it("normalizes author content and localizes with an English fallback", () => {
    expect(normalizeExtensionRecommendation({ ...recommendation, extra: true })).toBeUndefined();
    expect(normalizeExtensionRecommendation({ ...recommendation, prompt: "bad\u0000prompt" })).toBeUndefined();
    expect(normalizeExtensionRecommendation(recommendation)).toEqual(recommendation);
    expect(localizeExtensionRecommendation(recommendation, "zh-CN")).toEqual({ label: "检查邮件", prompt: "检查需要处理的邮件。" });
    expect(localizeExtensionRecommendation(recommendation, "en-XA")).toEqual({ label: "Review inbox", prompt: "Review the inbox." });
    expect(sameExtensionRecommendation(recommendation, { ...recommendation })).toBe(true);
    expect(sameExtensionRecommendation(recommendation, { ...recommendation, prompt: "Changed" })).toBe(false);
  });

  it("accepts a commandless ready recommendation without ordinary Use support", () => {
    const entry = extension({ useSupported: false, commands: [] });
    expect(resolvePendingExtensionSuggestion(pending(entry), catalog(entry), {
      backendId: "backend-1",
      targetId: "target-1",
      targets: [target],
      resources: [resource()]
    })).toBe(entry);
    expect(resolvePendingExtensionSuggestion(pending(entry), catalog(entry), {
      backendId: "other",
      targetId: "target-1",
      targets: [target],
      resources: [resource()]
    })).toBeUndefined();
    expect(resolvePendingExtensionSuggestion(pending(entry), catalog({ ...entry, revision: 8n }), {
      backendId: "backend-1", targetId: "target-1", targets: [target], resources: [resource()]
    })).toBeUndefined();
  });

  it("allows first-task command preparation and requires an exact advertised command when a runtime is supplied", () => {
    const commandRecommendation = { ...recommendation, command: "review" };
    const firstTaskEntry = extension({ recommendations: [commandRecommendation], useSupported: false, commands: [] });
    expect(resolvePendingExtensionSuggestion(pending(firstTaskEntry, commandRecommendation), catalog(firstTaskEntry), {
      backendId: "backend-1", targetId: "target-1", targets: [target], resources: [resource()]
    })).toBe(firstTaskEntry);

    const entry = extension({
      recommendations: [commandRecommendation],
      useSupported: true,
      commands: [{ name: "review", description: "Review", sessionId: "runtime-1" }]
    });
    const request = { ...pending(entry, commandRecommendation), runtimeSessionId: "runtime-1" };
    expect(resolvePendingExtensionSuggestion(request, catalog(entry), {
      backendId: "backend-1", targetId: "target-1", targets: [target], resources: [resource()]
    })).toBe(entry);
    expect(resolvePendingExtensionSuggestion({ ...request, runtimeSessionId: "runtime-2" }, catalog(entry), {
      backendId: "backend-1", targetId: "target-1", targets: [target], resources: [resource()]
    })).toBeUndefined();
    expect(resolvePendingExtensionSuggestion(request, catalog({ ...entry, useSupported: false }), {
      backendId: "backend-1", targetId: "target-1", targets: [target], resources: [resource()]
    })).toBeUndefined();
  });

  it("advances a source owner only through its exact package preview proof", () => {
    const source = extension({
      revision: 5n,
      installed: false,
      installState: "available",
      enabled: false,
      owner: {
        kind: "source",
        sourceId: "extension_source_0123456789abcdef0123456789abcdef",
        sourceRevision: 2n,
        entryId: "extension_source_entry_0123456789abcdef0123456789abcdef",
        contentRevision: `sha256:${"a".repeat(64)}`
      }
    });
    const request = { ...pending(source), phase: "setup" as const };
    const installed = extension({ revision: 6n });
    const preview: ExtensionPackagePreviewView = {
      extensionId: source.id,
      extensionRevision: 5n,
      action: "install",
      resourceId: resourceOwner.resourceId,
      backendId: "backend-1",
      packageName: "mail-tools",
      sourceReplacement: false,
      preservesEnabled: false,
      compatibilityDetails: [],
      runtimeRequirements: [],
      warnings: [],
      disabledLifecycleScripts: [],
      canToggle: true
    };

    expect(advancePendingExtensionSuggestion(request, installed, { kind: "packageAdoption", preview }, {
      backendId: "backend-1", targetId: "target-1", resources: [resource()]
    })).toMatchObject({
      phase: "ready",
      extensionRevision: "6",
      owner: { kind: "resource", resourceId: "resource-1" }
    });
    expect(advancePendingExtensionSuggestion(request, installed, {
      kind: "packageAdoption",
      preview: { ...preview, resourceId: "other" }
    }, { backendId: "backend-1", targetId: "target-1", resources: [resource()] })).toBeUndefined();
    expect(advancePendingExtensionSuggestion(request, installed, { kind: "catalogMutation", previous: source }, {
      backendId: "backend-1", targetId: "target-1", resources: [resource()]
    })).toBeUndefined();
  });

  it("advances only an exact prior resource mutation and formats command and commandless prompts", () => {
    const previous = extension({ enabled: false });
    const request = { ...pending(previous), phase: "setup" as const };
    const next = extension({ revision: 8n, owner: { ...resourceOwner, resourceRevision: 5n } });
    expect(advancePendingExtensionSuggestion(request, next, { kind: "catalogMutation", previous }, {
      backendId: "backend-1", targetId: "target-1", resources: [resource()]
    })).toMatchObject({
      phase: "ready", extensionRevision: "8", owner: { resourceRevision: "5" }
    });
    expect(advancePendingExtensionSuggestion(request, next, {
      kind: "catalogMutation",
      previous: { ...previous, revision: 6n }
    }, { backendId: "backend-1", targetId: "target-1", resources: [resource()] })).toBeUndefined();
    expect(extensionSuggestionPrompt(next, recommendation, "Review now.")).toBe(
      `Review now.\n\nUse the "Mail tools" Extension (${next.id}) to complete this task.`
    );
    expect(extensionSuggestionPrompt(next, { command: "review" }, "Review now.")).toBe("/review Review now.");

    const commandRecommendation = { ...recommendation, command: "review" };
    const commandPrevious = extension({ enabled: false, recommendations: [commandRecommendation] });
    const commandRequest = { ...pending(commandPrevious, commandRecommendation), phase: "setup" as const };
    const commandNext = extension({
      revision: 8n,
      owner: { ...resourceOwner, resourceRevision: 5n },
      recommendations: [commandRecommendation],
      useSupported: false,
      commands: []
    });
    expect(advancePendingExtensionSuggestion(commandRequest, commandNext, {
      kind: "catalogMutation", previous: commandPrevious
    }, { backendId: "backend-1", targetId: "target-1", resources: [resource()] })?.phase).toBe("ready");
  });

  it("binds installed recommendations to their exact backend and resource scope", () => {
    const entry = extension();
    expect(extensionSuggestionApplicable(entry, {
      backendId: "backend-1", targetId: "target-1", resources: [resource()]
    })).toBe(true);
    expect(extensionSuggestionApplicable(entry, {
      backendId: "backend-1", targetId: "target-1", resources: [resource({ targetId: "target-1", scope: "project" })]
    })).toBe(true);
    expect(extensionSuggestionApplicable(entry, {
      backendId: "backend-2", targetId: "target-1", resources: [resource()]
    })).toBe(false);
    expect(extensionSuggestionApplicable(entry, {
      backendId: "backend-1", targetId: "target-1", resources: [resource({ targetId: "target-2", scope: "project" })]
    })).toBe(false);
    expect(extensionSuggestionApplicable(entry, {
      backendId: "backend-1", resources: [resource({ targetId: "target-1", scope: "project" })]
    })).toBe(false);
    expect(extensionSuggestionApplicable(entry, {
      backendId: "backend-1", resources: [resource()]
    })).toBe(true);
    expect(extensionSuggestionApplicable(entry, {
      backendId: "backend-1", targetId: "target-1", resources: []
    })).toBe(false);
    expect(extensionSuggestionApplicable(entry, {
      backendId: "backend-1", targetId: "target-1", resources: [resource({ state: "removed" })]
    })).toBe(false);
    expect(extensionSuggestionApplicable(extension({ owner: {
      kind: "source",
      sourceId: "extension_source_0123456789abcdef0123456789abcdef",
      sourceRevision: 2n,
      entryId: "extension_source_entry_0123456789abcdef0123456789abcdef",
      contentRevision: `sha256:${"a".repeat(64)}`
    } }), { backendId: "backend-1", targetId: "target-1", resources: [] })).toBe(true);
  });
});

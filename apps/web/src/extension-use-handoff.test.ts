import { describe, expect, it } from "vitest";

import { composerDocumentPlainText, plainTextToComposerDocument } from "./composer-quote-document.js";
import { applyPendingExtensionUse, resolvePendingExtensionUse } from "./extension-use-handoff.js";
import type { ExtensionCatalogEntryView, ExtensionCatalogView, PendingExtensionUseView } from "./model.js";

const owner = {
  kind: "resource",
  resourceId: "resource-1",
  discoveredRevision: "sha256:owner",
  resourceRevision: 4n
} as const;

const extension: ExtensionCatalogEntryView = {
  id: "extension_0123456789abcdef0123456789abcdef",
  revision: 7n,
  owner,
  source: "local",
  installed: true,
  installState: "installed",
  name: "Review tools",
  description: "Review a change",
  enabled: true,
  sidebarSupported: true,
  sidebarVisible: true,
  tools: [],
  permissions: [],
  commands: [{ name: "review", description: "Review a change", sessionId: "session-runtime-1" }],
  setup: { state: "notRequired", revision: 0n, fields: [] },
  useSupported: true
};

const pending: PendingExtensionUseView = {
  extensionId: extension.id,
  extensionRevision: "7",
  commandName: "review",
  runtimeSessionId: "session-runtime-1",
  displayName: extension.name,
  owner: {
    kind: "resource",
    resourceId: owner.resourceId,
    discoveredRevision: owner.discoveredRevision,
    resourceRevision: owner.resourceRevision.toString(10)
  }
};

function catalog(entry: ExtensionCatalogEntryView = extension): ExtensionCatalogView {
  return { revision: 11n, extensions: [entry], recoveredFromCorruption: false };
}

describe("Extension use handoff", () => {
  it("accepts only the exact ready owner, revision, and advertising runtime command", () => {
    expect(resolvePendingExtensionUse(pending, catalog())).toBe(extension);
    expect(resolvePendingExtensionUse({ ...pending, extensionRevision: "8" }, catalog())).toBeUndefined();
    expect(resolvePendingExtensionUse({ ...pending, runtimeSessionId: "another-session" }, catalog())).toBeUndefined();
    expect(resolvePendingExtensionUse(pending, catalog({ ...extension, setup: { ...extension.setup, state: "required" }, useSupported: false }))).toBeUndefined();
    expect(resolvePendingExtensionUse(pending, catalog({ ...extension, owner: { ...owner, discoveredRevision: "sha256:changed" } }))).toBeUndefined();
  });

  it("places the command in the leading runtime slot and preserves rich-draft mention offsets", () => {
    const source = plainTextToComposerDocument("Review @src/main.ts");
    const applied = applyPendingExtensionUse(source, [{ mentionId: "file-1", from: 7, to: 19 }], "review");

    expect(applied).toBeDefined();
    expect(composerDocumentPlainText(applied!.document)).toBe("/review Review @src/main.ts");
    expect(applied!.inlineMentionRanges).toEqual([{ mentionId: "file-1", from: 15, to: 27 }]);

    const replaced = applyPendingExtensionUse(
      plainTextToComposerDocument("/old Review @src/main.ts"),
      [{ mentionId: "file-1", from: 12, to: 24 }],
      "review"
    );
    expect(replaced?.text).toBe("/review Review @src/main.ts");
    expect(replaced?.inlineMentionRanges).toEqual([{ mentionId: "file-1", from: 15, to: 27 }]);
  });
});

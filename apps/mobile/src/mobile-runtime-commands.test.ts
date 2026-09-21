import { create } from "@bufbuild/protobuf";
import {
  BackendDescriptorSchema,
  CapabilityManifestSchema,
  CapabilitySchema,
  CapabilitySupport,
  EntityVersionSchema,
  NativeSessionBindingSchema,
  RevisionSchema,
  RuntimeCommandSchema,
  RuntimeCommandSource,
  SessionSchema,
  SessionState,
  SnapshotSchema,
  TargetSchema,
  TargetState,
  capabilityNames,
  type RuntimeCommand,
  type Snapshot
} from "@joko/contracts";
import { describe, expect, it } from "vitest";
import {
  appendMobileSelectionQuote,
  insertMobileSessionMention,
  mobileComposerInput,
  plainTextMobileComposerDraft,
  replaceMobileComposerRange
} from "./mobile-composer-document";
import {
  MobileRuntimeCommandCatalogCache,
  assertMobileRuntimeCommandCandidate,
  createMobileRuntimeCommandControls,
  detectMobileRuntimeCommandActivation,
  filterMobileRuntimeCommands,
  mobileRuntimeCommandTesting,
  projectMobileRuntimeCommandCatalog,
  replaceMobileRuntimeCommandRun,
  resolveMobileRuntimeCommandPaletteKey
} from "./mobile-runtime-commands";

function runtimeCapability(support = CapabilitySupport.SUPPORTED) {
  return create(CapabilitySchema, { name: capabilityNames.runtimeCommands, support });
}

function snapshot(): Snapshot {
  const version = create(EntityVersionSchema, {
    generation: 7n,
    revision: create(RevisionSchema, { value: 9n, etag: "r9" })
  });
  return create(SnapshotSchema, {
    generation: 3n,
    backends: [create(BackendDescriptorSchema, {
      backendId: "backend",
      version: "backend-v1",
      entityVersion: version,
      capabilities: create(CapabilityManifestSchema, {
        revision: create(RevisionSchema, { value: 4n, etag: "cap-r4" }),
        capabilities: [runtimeCapability()]
      })
    })],
    targets: [create(TargetSchema, {
      targetId: "target", backendId: "backend", state: TargetState.ACTIVE, version
    })],
    sessions: [create(SessionSchema, {
      sessionId: "session", backendId: "backend", targetId: "target", displayName: "Task",
      state: SessionState.IDLE, nativeBinding: { runtimeGeneration: 7n }, version
    })]
  });
}

type RuntimeCommandOverrides = Partial<Pick<RuntimeCommand,
  "commandId" | "name" | "description" | "source" | "resourceId" | "loaded" | "sessionId">>;

function command(overrides: RuntimeCommandOverrides = {}): RuntimeCommand {
  return create(RuntimeCommandSchema, {
    commandId: "command-review",
    name: "review",
    description: "Review current changes",
    source: RuntimeCommandSource.PROMPT,
    loaded: true,
    sessionId: "session",
    ...overrides
  });
}

describe("mobile runtime command authority and catalog", () => {
  it("requires one supported capability and exact Session, Target, Backend, and runtime generation", () => {
    const owner = snapshot();
    expect(createMobileRuntimeCommandControls("authority", owner, owner, "session")).toMatchObject({
      authorityKey: "authority",
      sessionId: "session",
      backendId: "backend",
      targetId: "target",
      runtimeGeneration: "7"
    });
    expect(createMobileRuntimeCommandControls("authority", owner, create(SnapshotSchema, {
      ...owner,
      sessions: [create(SessionSchema, {
        ...owner.sessions[0]!,
        nativeBinding: create(NativeSessionBindingSchema, { runtimeGeneration: 8n }),
        version: create(EntityVersionSchema, {
          ...owner.sessions[0]!.version!, generation: 8n
        })
      })]
    }), "session")).toBeUndefined();
    expect(createMobileRuntimeCommandControls("authority", owner, create(SnapshotSchema, {
      ...owner,
      backends: [create(BackendDescriptorSchema, {
        ...owner.backends[0]!,
        capabilities: create(CapabilityManifestSchema, {
          ...owner.backends[0]!.capabilities!,
          capabilities: [runtimeCapability(), runtimeCapability()]
        })
      })]
    }), "session")).toBeUndefined();
    expect(createMobileRuntimeCommandControls("authority", owner, create(SnapshotSchema, {
      ...owner,
      targets: [create(TargetSchema, { ...owner.targets[0]!, state: TargetState.ERROR })]
    }), "session")).toBeUndefined();
  });

  it("validates budgets and identities, excludes unloaded commands, and deterministically sorts and deduplicates invocations", () => {
    const controls = createMobileRuntimeCommandControls("authority", snapshot(), snapshot(), "session")!;
    const catalog = projectMobileRuntimeCommandCatalog(controls, [
      command({ commandId: "backend-review", name: "Review", source: RuntimeCommandSource.BACKEND }),
      command({ commandId: "skill-review", name: "review", source: RuntimeCommandSource.SKILL, resourceId: "skill" }),
      command({ commandId: "release", name: "release", description: "Prepare release notes", source: RuntimeCommandSource.PROMPT }),
      command({ commandId: "hidden", name: "hidden", loaded: false, source: RuntimeCommandSource.EXTENSION })
    ]);
    expect(catalog).toMatchObject({ sessionId: "session", runtimeGeneration: "7" });
    expect(catalog.items.map((item) => [item.commandId, item.name])).toEqual([
      ["release", "release"],
      ["skill-review", "review"]
    ]);
    expect(() => projectMobileRuntimeCommandCatalog(controls, [command(), command()])).toThrow(/invalid runtime command catalog/u);
    expect(() => projectMobileRuntimeCommandCatalog(controls, [command({ sessionId: "other" })])).toThrow(/invalid/u);
    expect(() => projectMobileRuntimeCommandCatalog(controls, [command({ source: RuntimeCommandSource.UNSPECIFIED })])).toThrow(/invalid/u);
    expect(() => projectMobileRuntimeCommandCatalog(controls, [command({ name: "bad/name" })])).toThrow(/invalid/u);
    expect(() => projectMobileRuntimeCommandCatalog(controls, Array.from(
      { length: mobileRuntimeCommandTesting.maximumCatalogCommands + 1 },
      (_, index) => command({ commandId: `command-${index}`, name: `command-${index}` })
    ))).toThrow(/too many/u);
    expect(() => projectMobileRuntimeCommandCatalog(controls, Array.from(
      { length: 257 },
      (_, index) => command({ commandId: `large-${index}`, name: `large-${index}`, description: "a".repeat(4_096) })
    ))).toThrow(/invalid runtime command catalog/u);
  });

  it("filters name prefixes before description matches and preserves stable limits", () => {
    const controls = createMobileRuntimeCommandControls("authority", snapshot(), snapshot(), "session")!;
    const catalog = projectMobileRuntimeCommandCatalog(controls, [
      command({ commandId: "changes", name: "changes", description: "List files" }),
      command({ commandId: "release", name: "release", description: "Prepare changes for release" }),
      command({ commandId: "review", name: "review", description: "Review changes" })
    ]);
    expect(filterMobileRuntimeCommands(catalog, "re").items.map((item) => item.name)).toEqual(["release", "review"]);
    expect(filterMobileRuntimeCommands(catalog, "changes").items.map((item) => item.name)).toEqual([
      "changes", "release", "review"
    ]);
    expect(filterMobileRuntimeCommands(catalog, "", 2)).toMatchObject({
      items: [{ name: "changes" }, { name: "release" }],
      truncated: true
    });
  });

  it("revalidates selection against the exact catalog owner and maintains a bounded exact-owner cache", () => {
    const controls = createMobileRuntimeCommandControls("authority", snapshot(), snapshot(), "session")!;
    const catalog = projectMobileRuntimeCommandCatalog(controls, [command()]);
    expect(assertMobileRuntimeCommandCandidate(controls, catalog, catalog.items[0]!)).toBe(catalog.items[0]);
    expect(() => assertMobileRuntimeCommandCandidate({ ...controls, surfaceOwnerKey: "retired" }, catalog, catalog.items[0]!))
      .toThrow(/owner changed/u);
    expect(() => assertMobileRuntimeCommandCandidate(controls, catalog, { ...catalog.items[0]!, description: "drift" }))
      .toThrow(/no longer loaded/u);

    const cache = new MobileRuntimeCommandCatalogCache();
    for (let index = 0; index <= mobileRuntimeCommandTesting.maximumCachedCatalogs; index += 1) {
      cache.write({ ...catalog, surfaceOwnerKey: `owner-${index}` });
    }
    expect(cache.read("owner-0")).toBeUndefined();
    expect(cache.read(`owner-${mobileRuntimeCommandTesting.maximumCachedCatalogs}`)?.items).toHaveLength(1);
    cache.clear();
    expect(cache.read(`owner-${mobileRuntimeCommandTesting.maximumCachedCatalogs}`)).toBeUndefined();
  });

  it("wraps hardware navigation and consumes Enter or Tab without a selectable match", () => {
    const controls = createMobileRuntimeCommandControls("authority", snapshot(), snapshot(), "session")!;
    const items = projectMobileRuntimeCommandCatalog(controls, [
      command({ commandId: "one", name: "one" }),
      command({ commandId: "two", name: "two" })
    ]).items;
    expect(resolveMobileRuntimeCommandPaletteKey("ArrowUp", items, 0, true)).toEqual({
      kind: "move", selectedIndex: 1
    });
    expect(resolveMobileRuntimeCommandPaletteKey("ArrowDown", items, 1, true)).toEqual({
      kind: "move", selectedIndex: 0
    });
    expect(resolveMobileRuntimeCommandPaletteKey("Enter", items, 0, true)).toEqual({
      kind: "commit", candidate: items[0]
    });
    expect(resolveMobileRuntimeCommandPaletteKey("Tab", [], 0, true)).toEqual({ kind: "consume" });
    expect(resolveMobileRuntimeCommandPaletteKey("Enter", items, 0, false)).toEqual({ kind: "consume" });
    expect(resolveMobileRuntimeCommandPaletteKey("Escape", items, 0, true)).toEqual({ kind: "dismiss" });
  });
});

describe("mobile runtime command activation and replacement", () => {
  it("tracks the query at a UTF-16 caret while owning the complete slash run", () => {
    const draft = plainTextMobileComposerDraft("Before /release-notes after");
    const caret = "Before /rel".length;
    expect(detectMobileRuntimeCommandActivation(draft, { start: caret, end: caret }, false)).toEqual({
      from: "Before ".length,
      to: "Before /release-notes".length,
      caret,
      query: "rel"
    });
    expect(detectMobileRuntimeCommandActivation(draft, { start: caret, end: caret }, true)).toBeUndefined();
    expect(detectMobileRuntimeCommandActivation(draft, { start: caret - 1, end: caret }, false)).toBeUndefined();
    expect(detectMobileRuntimeCommandActivation(plainTextMobileComposerDraft("Before x/rel"), { start: 12, end: 12 }, false))
      .toBeUndefined();
    expect(detectMobileRuntimeCommandActivation(plainTextMobileComposerDraft("/re/view"), { start: 3, end: 3 }, false))
      .toBeUndefined();
    expect(detectMobileRuntimeCommandActivation(
      plainTextMobileComposerDraft(`/r${"x".repeat(256)}`),
      { start: 2, end: 2 },
      false
    )).toBeUndefined();
    expect(detectMobileRuntimeCommandActivation(plainTextMobileComposerDraft("😀 /r"), { start: 1, end: 1 }, false))
      .toBeUndefined();
  });

  it("does not activate inside a structured occurrence", () => {
    const inserted = insertMobileSessionMention(plainTextMobileComposerDraft(""), { start: 0, end: 0 }, {
      sessionId: "slash-session",
      displayText: "/review"
    }, "mention");
    const caret = inserted.draft.mentions[0]!.end;
    expect(detectMobileRuntimeCommandActivation(inserted.draft, { start: caret, end: caret }, false)).toBeUndefined();
  });

  it("replaces the full run, adds only a necessary space, and preserves untouched structured identities and ranges", () => {
    const mentioned = insertMobileSessionMention(plainTextMobileComposerDraft(" /oldSuffix"), { start: 0, end: 0 }, {
      sessionId: "other-session",
      displayText: "Other task"
    }, "mention");
    const withQuote = appendMobileSelectionQuote(mentioned.draft, {
      sourceSessionId: "session",
      sourceMessageId: "message",
      sourceEventId: "event",
      sourceRole: "assistant",
      text: "Quoted answer"
    }, "quote").draft;
    const from = withQuote.text.indexOf("/oldSuffix");
    const caret = from + "/old".length;
    const activation = detectMobileRuntimeCommandActivation(withQuote, { start: caret, end: caret }, false)!;
    const result = replaceMobileRuntimeCommandRun(withQuote, activation, {
      commandId: "review", name: "review", description: "Review", source: RuntimeCommandSource.PROMPT
    });
    expect(result.draft.text).toContain("/review\n\n");
    expect(result.draft.text).not.toContain("Suffix");
    expect(result.draft.slashCommands).toEqual([{ text: "/review", start: from, end: from + "/review".length }]);
    expect(result.selection).toEqual({ start: from + "/review".length, end: from + "/review".length });
    expect(result.draft.mentions).toMatchObject(withQuote.mentions);
    expect(result.draft.atoms[0]).toMatchObject({ atomId: "quote", text: "Quoted answer" });
    expect(result.draft.atoms[0]!.start).toBe(withQuote.atoms[0]!.start + "/review".length - "/oldSuffix".length);

    const atEnd = plainTextMobileComposerDraft("/old");
    const endActivation = detectMobileRuntimeCommandActivation(atEnd, { start: 4, end: 4 }, false)!;
    const selectedAtEnd = replaceMobileRuntimeCommandRun(atEnd, endActivation, {
      commandId: "review", name: "review", description: "Review", source: RuntimeCommandSource.PROMPT
    });
    expect(selectedAtEnd.draft.text).toBe("/review ");
    expect(selectedAtEnd.draft.slashCommands).toEqual([{ text: "/review", start: 0, end: 7 }]);
    expect(mobileComposerInput(selectedAtEnd.draft)).toMatchObject({
      parts: [{ content: { case: "text", value: "/review " } }],
      mentionRanges: [],
      pastedTextRanges: [],
      quotesEncoded: false
    });
    expect(JSON.stringify(mobileComposerInput(selectedAtEnd.draft))).not.toContain("slashCommand");

    const shifted = replaceMobileComposerRange(selectedAtEnd.draft, { start: 0, end: 0 }, "😀 ");
    expect(shifted.draft.slashCommands).toEqual([{ text: "/review", start: 3, end: 10 }]);
    const demoted = replaceMobileComposerRange(shifted.draft, { start: 5, end: 6 }, "x");
    expect(demoted.draft.text).toBe("😀 /rxview ");
    expect(demoted.draft.slashCommands).toEqual([]);
    expect(plainTextMobileComposerDraft("/review ").slashCommands).toEqual([]);

    const withSpace = plainTextMobileComposerDraft("/old next");
    const spaceActivation = detectMobileRuntimeCommandActivation(withSpace, { start: 4, end: 4 }, false)!;
    expect(replaceMobileRuntimeCommandRun(withSpace, spaceActivation, {
      commandId: "review", name: "review", description: "Review", source: RuntimeCommandSource.PROMPT
    }).draft.text).toBe("/review next");
    expect(() => replaceMobileRuntimeCommandRun(plainTextMobileComposerDraft("/changed"), activation, {
      commandId: "review", name: "review", description: "Review", source: RuntimeCommandSource.PROMPT
    })).toThrow(/changed/u);
  });
});

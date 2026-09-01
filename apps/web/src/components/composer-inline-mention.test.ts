// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { JSONContent } from "@tiptap/core";
import type { ComposerMentionDraft, ResourceView, WorkspaceEntryView } from "../model.js";
import {
  COMPOSER_MENTION_RESULT_LIMIT,
  composerCaretTextOffset,
  composerDirectoryQueryToken,
  composerMentionCatalog,
  composerMentionsFromRanges,
  detectComposerInlineMention,
  firstEnabledComposerMentionIndex,
  nextEnabledComposerMentionIndex,
  remapComposerInlineMentionRanges,
  replaceComposerDocumentTextRange,
  resolveComposerInlineMentionKey,
  resolveComposerMentionResults,
  restoreComposerInlineMentionRanges,
  scoreComposerMentionItem,
  setComposerCaretTextOffset,
  serializeComposerMentionPath,
  workspaceFileIndexCatalog,
  type ComposerMentionCatalogItem
} from "./composer-inline-mention.js";

describe("inline composer mention syntax", () => {
  it("opens only at a token boundary and tracks the complete run around the caret", () => {
    expect(detectComposerInlineMention("mail@example.com", 16)).toBeNull();
    expect(detectComposerInlineMention("prefix(@src", 11)).toBeNull();
    expect(detectComposerInlineMention("check @src/main.ts later", 10)).toEqual({
      from: 6,
      to: 18,
      query: "src",
      quoted: false
    });
    expect(detectComposerInlineMention("@root", 5)).toEqual({ from: 0, to: 5, query: "root", quoted: false });
    expect(detectComposerInlineMention("line\n@next", 10)).toEqual({ from: 5, to: 10, query: "next", quoted: false });
  });

  it("keeps an unclosed quoted path active across spaces", () => {
    expect(detectComposerInlineMention('open @"My Documents/fi', 22)).toEqual({
      from: 5,
      to: 22,
      query: "My Documents/fi",
      quoted: true
    });
    expect(detectComposerInlineMention('open @"My Documents/file.md"', 29)).toBeNull();
  });

  it("quotes whitespace and quotes while preserving Windows backslashes", () => {
    expect(serializeComposerMentionPath("src/main.ts")).toBe("@src/main.ts");
    expect(serializeComposerMentionPath("~/My Documents/a.md")).toBe('@"~/My Documents/a.md"');
    expect(serializeComposerMentionPath('C:\\Users\\My Documents\\a"b.md')).toBe('@"C:\\Users\\My Documents\\a\\"b.md"');
    expect(composerDirectoryQueryToken("src\\nested\\")).toBe("@src\\nested/");
    expect(composerDirectoryQueryToken("My Documents")).toBe('@"My Documents/');
  });
});

describe("composer mention catalog and ranking", () => {
  const entries: readonly WorkspaceEntryView[] = [{
    path: "src",
    name: "src",
    kind: "directory",
    generated: false,
    children: [
      { path: "src/main.ts", name: "main.ts", kind: "file", generated: false },
      {
        path: "src/nested",
        name: "nested",
        kind: "directory",
        generated: false,
        children: [{ path: "src/nested/deep.ts", name: "deep.ts", kind: "file", generated: false }]
      }
    ]
  }];

  it("includes files, directories, and structured resources without inventing a provider", () => {
    const items = composerMentionCatalog(entries, "workspace-1", [resource("prompt-1", "release notes")]);
    expect(items.map((item) => [item.kind, item.path])).toEqual([
      ["directory", "src/"],
      ["file", "src/main.ts"],
      ["directory", "src/nested/"],
      ["file", "src/nested/deep.ts"],
      ["resource", "release notes"]
    ]);
    expect(items[1]?.mention).toEqual({
      id: "workspace:workspace-1:src/main.ts",
      kind: "workspace",
      reference: "src/main.ts",
      label: "main.ts",
      token: "@src/main.ts",
      workspaceId: "workspace-1"
    });
    expect(items.at(-1)?.mention?.token).toBe('@"release notes"');
  });

  it("expands the bounded filename index into deduplicated directory drilldown rows", () => {
    const indexed = workspaceFileIndexCatalog([
      "src/nested/deep.ts",
      "src/main.ts",
      "src/main.ts",
      "./docs/guide.md"
    ], "workspace-1");
    expect(indexed.map((entry) => [entry.kind, entry.path])).toEqual([
      ["file", "src/nested/deep.ts"],
      ["file", "src/main.ts"],
      ["file", "docs/guide.md"],
      ["directory", "src/"],
      ["directory", "src/nested/"],
      ["directory", "docs/"]
    ]);
    expect(indexed[0]?.mention).toMatchObject({
      kind: "workspace",
      reference: "src/nested/deep.ts",
      workspaceId: "workspace-1"
    });
  });

  it("merges indexed and visible entries without duplicate rows", () => {
    const items = composerMentionCatalog(entries, "workspace-1", [], ["src/main.ts", "docs/readme.md"]);
    expect(items.filter((entry) => entry.path === "src/main.ts")).toHaveLength(1);
    expect(items.some((entry) => entry.path === "docs/")).toBe(true);
    expect(items.some((entry) => entry.path === "docs/readme.md")).toBe(true);
  });

  it("uses the required name-prefix, contains, fuzzy-name, then fuzzy-path weights", () => {
    expect(scoreComposerMentionItem(item("alpha.ts", "src/alpha.ts"), "alp")).toBe(1000 - "alpha.ts".length);
    expect(scoreComposerMentionItem(item("my-alpha.ts", "src/my-alpha.ts"), "alpha")).toBe(500 - "my-alpha.ts".length);
    expect(scoreComposerMentionItem(item("alphabet.ts", "src/alphabet.ts"), "abt")).toBe(100 - "alphabet.ts".length);
    expect(scoreComposerMentionItem(item("main.ts", "src/alpha/main.ts"), "alp")).toBe(50 - "src/alpha/main.ts".length / 10);
  });

  it("scopes directory drilldown and accepts slash or backslash queries", () => {
    const items = composerMentionCatalog(entries, "workspace-1", []);
    const state = { kind: "ready" as const, items, truncated: false };
    expect(resolveComposerMentionResults(state, "src/").items.map((entry) => entry.path)).toEqual([
      "src/nested/",
      "src/main.ts"
    ]);
    expect(resolveComposerMentionResults(state, "src\\ne").items.map((entry) => entry.path)).toEqual(["src/nested/"]);

    const external = [
      item("home.ts", "~/projects/home.ts"),
      item("absolute.ts", "/opt/project/absolute.ts"),
      item("win.ts", "C:\\work\\project\\win.ts")
    ];
    const externalState = { kind: "ready" as const, items: external, truncated: false };
    expect(resolveComposerMentionResults(externalState, "~/projects/ho").items[0]?.path).toBe("~/projects/home.ts");
    expect(resolveComposerMentionResults(externalState, "/opt/project/abs").items[0]?.path).toBe("/opt/project/absolute.ts");
    expect(resolveComposerMentionResults(externalState, "C:\\work\\project\\wi").items[0]?.path).toBe("C:\\work\\project\\win.ts");
  });

  it("defaults to eight results and exposes both local and upstream truncation", () => {
    const items = Array.from({ length: 12 }, (_, index) => item(`file-${index}.ts`, `src/file-${index}.ts`));
    const local = resolveComposerMentionResults({ kind: "ready", items, truncated: false }, "file");
    expect(local.items).toHaveLength(COMPOSER_MENTION_RESULT_LIMIT);
    expect(local.truncated).toBe(true);
    const upstream = resolveComposerMentionResults({ kind: "ready", items: items.slice(0, 2), truncated: true }, "file");
    expect(upstream.truncated).toBe(true);
  });

  it("wraps keyboard focus while skipping disabled rows", () => {
    const items = [
      { ...item("blocked", "blocked"), disabled: true },
      item("ready", "ready"),
      { ...item("also-blocked", "also-blocked"), disabled: true }
    ];
    expect(firstEnabledComposerMentionIndex(items)).toBe(1);
    expect(nextEnabledComposerMentionIndex(items, 0, 1)).toBe(1);
    expect(nextEnabledComposerMentionIndex(items, 1, 1)).toBe(1);
    expect(nextEnabledComposerMentionIndex(items, 1, -1)).toBe(1);
    expect(resolveComposerInlineMentionKey("ArrowDown", 0, items)).toEqual({ kind: "move", index: 1 });
    expect(resolveComposerInlineMentionKey("ArrowUp", 1, items)).toEqual({ kind: "move", index: 1 });
    expect(resolveComposerInlineMentionKey("Enter", 1, items)).toEqual({ kind: "select", index: 1 });
    expect(resolveComposerInlineMentionKey("Tab", 1, items)).toEqual({ kind: "select", index: 1 });
    expect(resolveComposerInlineMentionKey("Escape", 1, items)).toEqual({ kind: "close" });
    expect(resolveComposerInlineMentionKey("ArrowLeft", 1, items)).toBeNull();
  });
});

describe("structured composer mention ranges", () => {
  const mentions: readonly ComposerMentionDraft[] = [{
    id: "workspace:w:src/main.ts",
    kind: "workspace",
    reference: "src/main.ts",
    label: "main.ts",
    token: "@src/main.ts",
    workspaceId: "w"
  }, {
    id: "message:s:m",
    kind: "message",
    reference: "m",
    label: "Task",
    sessionId: "s",
    role: "assistant"
  }];

  it("restores once, then uses ranges rather than raw token search as the active source", () => {
    const ranges = restoreComposerInlineMentionRanges("open @src/main.ts", mentions);
    expect(ranges).toEqual([{ mentionId: "workspace:w:src/main.ts", from: 5, to: 17 }]);
    expect(composerMentionsFromRanges(mentions, ranges)).toEqual(mentions);
    expect(composerMentionsFromRanges(mentions, [])).toEqual([mentions[1]]);
    expect(restoreComposerInlineMentionRanges("@src/main.ts and @src/main.ts", mentions)).toEqual([
      { mentionId: "workspace:w:src/main.ts", from: 0, to: 12 },
      { mentionId: "workspace:w:src/main.ts", from: 17, to: 29 }
    ]);
  });

  it("shifts an untouched range and drops a range edited at either edge", () => {
    const ranges = [{ mentionId: "m", from: 5, to: 17 }];
    expect(remapComposerInlineMentionRanges("open @src/main.ts", "please open @src/main.ts", ranges)).toEqual([
      { mentionId: "m", from: 12, to: 24 }
    ]);
    expect(remapComposerInlineMentionRanges("open @src/main.ts", "open @src/Xmain.ts", ranges)).toEqual([]);
    expect(remapComposerInlineMentionRanges("open @src/main.ts", "open @src/main.ts now", ranges)).toEqual(ranges);
  });

  it("replaces only the query text node and preserves quote atoms", () => {
    const document: JSONContent = {
      type: "doc",
      content: [{
        type: "paragraph",
        content: [
          { type: "composerQuote", attrs: { id: "q", kind: "message", text: "quoted", sessionId: "s", messageId: "m", role: "user" } },
          { type: "text", text: "open @src/ma" }
        ]
      }]
    };
    const replaced = replaceComposerDocumentTextRange(document, 5, 12, "@src/main.ts ");
    expect(replaced?.content?.[0]?.content?.[0]?.type).toBe("composerQuote");
    expect(replaced?.content?.[0]?.content?.[1]?.text).toBe("open @src/main.ts ");
  });

  it("inserts at an empty structured range without flattening quote atoms", () => {
    const document: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [
        { type: "text", text: "before after" },
        { type: "composerQuote", attrs: { id: "q", kind: "message", text: "quoted", sessionId: "s", messageId: "m", role: "user" } }
      ] }]
    };
    const replaced = replaceComposerDocumentTextRange(document, 7, 7, "@src/main.ts ");
    expect(replaced?.content?.[0]?.content?.[0]?.text).toBe("before @src/main.ts after");
    expect(replaced?.content?.[0]?.content?.[1]?.type).toBe("composerQuote");
  });

  it("maps a browser caret to trimmed prose while ignoring quote chip labels", () => {
    const root = document.createElement("div");
    root.innerHTML = '<p>  open <span data-composer-quote>ignored label</span>@src</p>';
    document.body.append(root);
    const textNode = root.querySelector("p")?.lastChild;
    expect(textNode).toBeInstanceOf(Text);
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(textNode!, 4);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(composerCaretTextOffset(root, selection)).toBe("open \n@src".length);
    expect(setComposerCaretTextOffset(root, selection, "open ".length)).toBe(true);
    expect(composerCaretTextOffset(root, selection)).toBe("open ".length);
  });
});

function item(name: string, path: string): ComposerMentionCatalogItem {
  return { id: path, kind: "file", name, path, meta: path };
}

function resource(id: string, name: string): ResourceView {
  return {
    id,
    backendId: "backend-1",
    name,
    kind: "prompt",
    scope: "managed",
    state: "loaded",
    enabled: true,
    source: "test",
    discoveredRevision: "1",
    compatibilityDetails: [],
    runtimeRequirements: [],
    warnings: [],
    disabledLifecycleScripts: [],
    canToggle: true,
    requiresExtensionApproval: false,
    postMutationNotice: false
  };
}

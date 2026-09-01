import { describe, expect, it, vi } from "vitest";

import {
  openHttpLinkWithPreference,
  resolveLinkOpenPreference,
  sessionDraftWithPersonalization
} from "./controller.js";
import {
  PERSONALIZATION_PROMPT_MAX_LENGTH,
  PERSONALIZATION_PROMPT_MAX_OWNERS,
  normalizeUiPreferences,
  personalizationPromptForOwner,
  withPersonalizationPrompt
} from "./local-state.js";
import type { BrowserView, NewSessionDraft } from "./model.js";
import {
  commitTimelineWordFadeCandidate,
  createTimelineWordFadeCandidate,
  createTimelineWordFadeState,
  rehypeTimelineStreamFade,
  timelineStreamFadeActive
} from "./components/timeline-stream-fade.js";

const DRAFT: NewSessionDraft = {
  targetId: "target-1",
  name: "Task",
  nativeStart: { kind: "fresh" },
  providerId: "provider-1",
  modelId: "model-1",
  fastMode: false,
  permissionMode: "ask",
  planMode: false
};

describe("personalization preferences", () => {
  it("defaults link and fade choices and rejects malformed persisted prompt maps", () => {
    expect(normalizeUiPreferences({})).toMatchObject({
      personalizationPrompts: {},
      linkOpenPreference: "sidebar",
      streamFadeEnabled: true
    });
    expect(normalizeUiPreferences({
      personalizationPrompts: {
        "owner-a": "Use short answers.",
        "bad\nowner": "leak",
        "owner-too-long": "x".repeat(PERSONALIZATION_PROMPT_MAX_LENGTH + 1)
      },
      linkOpenPreference: "system",
      streamFadeEnabled: "false"
    })).toMatchObject({
      personalizationPrompts: {},
      linkOpenPreference: "sidebar",
      streamFadeEnabled: true
    });
  });

  it("isolates prompts by owner and keeps the owner map bounded", () => {
    let prompts = {};
    for (let index = 0; index < PERSONALIZATION_PROMPT_MAX_OWNERS + 2; index += 1) {
      prompts = withPersonalizationPrompt(prompts, `owner-${index}`, `prompt-${index}`);
    }
    expect(Object.keys(prompts)).toHaveLength(PERSONALIZATION_PROMPT_MAX_OWNERS);
    expect(personalizationPromptForOwner(prompts, "owner-0")).toBe("");
    expect(personalizationPromptForOwner(prompts, `owner-${PERSONALIZATION_PROMPT_MAX_OWNERS + 1}`)).toBe(`prompt-${PERSONALIZATION_PROMPT_MAX_OWNERS + 1}`);
    expect(personalizationPromptForOwner(prompts, "another-owner")).toBe("");
    expect(() => withPersonalizationPrompt(prompts, "owner-a", "x".repeat(PERSONALIZATION_PROMPT_MAX_LENGTH + 1))).toThrow(/8000/u);
    expect(() => withPersonalizationPrompt(prompts, "owner-a", "unsafe\0prompt")).toThrow(/null/u);
  });

  it("snapshots custom instructions only into a fresh native task", () => {
    expect(sessionDraftWithPersonalization(DRAFT, "Always explain tradeoffs.")).toMatchObject({
      nativeStart: { kind: "fresh" },
      appendSystemPrompt: "Always explain tradeoffs."
    });
    const attached = sessionDraftWithPersonalization({
      ...DRAFT,
      nativeStart: { kind: "attach", reference: "native-existing" },
      appendSystemPrompt: "must be stripped"
    }, "current owner prompt");
    expect(attached).not.toHaveProperty("appendSystemPrompt");
  });

  it("opens every sidebar link in a fresh governed Browser page and never silently falls back", async () => {
    const browser = browserView();
    const openPage = vi.fn()
      .mockResolvedValueOnce("page-1")
      .mockResolvedValueOnce("page-2");
    const showBrowser = vi.fn();
    const openExternal = vi.fn(async () => undefined);
    const base = { browsers: [browser], sessionId: "session-1", openPage, showBrowser, openExternal };

    await openHttpLinkWithPreference({ ...base, url: "https://example.test/docs", preference: "sidebar" });
    await openHttpLinkWithPreference({ ...base, url: "https://example.test/second", preference: "sidebar" });
    expect(openPage).toHaveBeenNthCalledWith(1, "browser-1", "session-1", "https://example.test/docs");
    expect(openPage).toHaveBeenNthCalledWith(2, "browser-1", "session-1", "https://example.test/second");
    expect(showBrowser).toHaveBeenNthCalledWith(1, "browser-1", "page-1", "session-1");
    expect(showBrowser).toHaveBeenNthCalledWith(2, "browser-1", "page-2", "session-1");
    expect(openExternal).not.toHaveBeenCalled();

    await expect(openHttpLinkWithPreference({ ...base, browsers: [], url: "https://unavailable.test", preference: "sidebar" })).rejects.toThrow(/unavailable/u);
    expect(openExternal).not.toHaveBeenCalled();

    await openHttpLinkWithPreference({ ...base, url: "https://openai.com", preference: "external" });
    expect(openExternal).toHaveBeenCalledWith("https://openai.com/");
    await expect(openHttpLinkWithPreference({ ...base, url: "javascript:alert(1)", preference: "external" })).rejects.toThrow(/HTTP/u);
    await expect(openHttpLinkWithPreference({ ...base, url: "https://secret@example.test", preference: "external" })).rejects.toThrow(/credential-free/u);
  });

  it("lets the right-click menu override the saved link destination for one open", () => {
    expect(resolveLinkOpenPreference("sidebar")).toBe("sidebar");
    expect(resolveLinkOpenPreference("external", { forceSidebar: true })).toBe("sidebar");
    expect(resolveLinkOpenPreference("sidebar", { forceExternal: true })).toBe("external");
    expect(resolveLinkOpenPreference("external", { forceExternal: true, forceSidebar: true })).toBe("external");
  });

  it("always disables stream fade for reduced-motion users", () => {
    expect(timelineStreamFadeActive(true, true, false)).toBe(true);
    expect(timelineStreamFadeActive(true, true, true)).toBe(false);
    expect(timelineStreamFadeActive(true, false, false)).toBe(false);
    expect(timelineStreamFadeActive(false, true, false)).toBe(false);
  });

  it("fades only newly streamed words after earlier words settle", () => {
    const state = createTimelineWordFadeState();
    state.now = () => 100;
    const first = createTimelineWordFadeCandidate(state);
    const firstTree = markdownTree("hello ");
    rehypeTimelineStreamFade(first)(firstTree as never);
    const firstSpan = firstTree.children[0]?.children[0] as { readonly properties: { readonly dataWfKey: string } };
    expect(firstSpan.properties.dataWfKey).toBe("wf-0");
    commitTimelineWordFadeCandidate(state, first);
    state.settled.add("wf-0");

    const second = createTimelineWordFadeCandidate(state);
    const secondTree = markdownTree("hello world");
    rehypeTimelineStreamFade(second)(secondTree as never);
    const children = secondTree.children[0]?.children ?? [];
    expect(children[0]).toMatchObject({ type: "text", value: "hello " });
    expect(children[1]).toMatchObject({
      type: "element",
      tagName: "span",
      properties: { className: ["stream-word"], dataWfKey: "wf-1" }
    });
  });
});

function browserView(): BrowserView {
  return {
    id: "browser-1",
    name: "Browser",
    state: "ready",
    generation: 1n,
    pages: [{
      id: "page-1",
      title: "Existing",
      url: "about:blank",
      state: "ready",
      canGoBack: false,
      canGoForward: false,
      recoverable: false,
      lastKnownGeneration: 1n
    }]
  };
}

function markdownTree(text: string): {
  readonly type: "root";
  children: Array<{ readonly type: "element"; readonly tagName: string; properties: Record<string, unknown>; children: Array<Record<string, unknown>> }>;
} {
  return {
    type: "root",
    children: [{ type: "element", tagName: "p", properties: {}, children: [{ type: "text", value: text }] }]
  };
}

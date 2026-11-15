// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { boundedTimelineSelectionText, SelectionQuoteButton, TIMELINE_SELECTION_QUOTE_MAX_CHARS } from "./SelectionQuoteButton.js";

describe("timeline selection quotes", () => {
  it("preserves indentation, strips only outer newlines, and bounds selected text", () => {
    expect(boundedTimelineSelectionText("\n  const value = 1;\n")).toBe("  const value = 1;");
    expect(boundedTimelineSelectionText(" \n ")).toBeUndefined();
    const bounded = boundedTimelineSelectionText("x".repeat(TIMELINE_SELECTION_QUOTE_MAX_CHARS + 20));
    expect(bounded).toBe(`${"x".repeat(TIMELINE_SELECTION_QUOTE_MAX_CHARS)}…`);
  });

  it.each(["Add to chat", "Ask in a side chat"])("uses the current DOM range when activating %s", async label => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.body.appendChild(document.createElement("div"));
    const container = document.body.appendChild(document.createElement("div"));
    const article = container.appendChild(document.createElement("article"));
    article.dataset.selectionQuoteMessageId = "assistant-message";
    article.dataset.selectionQuoteSourceEventId = "reply-event";
    article.dataset.selectionQuoteRole = "assistant";
    const message = article.appendChild(document.createTextNode("Old phrase, new phrase"));
    const selection = window.getSelection()!;
    const select = (start: number, end: number) => {
      selection.setBaseAndExtent(message, start, message, end);
      Object.defineProperty(selection.getRangeAt(0), "getClientRects", { configurable: true, value: () => [new DOMRect(120, 100, 60, 16)] });
    };
    const root = createRoot(host), add = vi.fn(), side = vi.fn();
    try {
      await act(async () => root.render(createElement(SelectionQuoteButton, {
        sessionId: "session", containerRef: { current: container }, label: "Add to chat", onCommit: add,
        sideChatLabel: "Ask in a side chat", onAskSideChat: side
      })));
      await act(async () => {
        select(0, 10);
        document.dispatchEvent(new MouseEvent("mouseup"));
        await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
      });
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>(".selection-quote-button"))
        .find(candidate => candidate.textContent === label)!;
      expect(button).toBeDefined();
      await act(async () => {
        select(12, 22);
        document.dispatchEvent(new Event("selectionchange"));
        button.click();
      });
      const consume = label === "Add to chat" ? add : side;
      expect(consume).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        sessionId: "session", messageId: "assistant-message", sourceEventId: "reply-event", text: "new phrase"
      }));
      expect(selection.rangeCount).toBe(0);
    } finally {
      selection.removeAllRanges();
      await act(async () => root.unmount());
      host.remove();
      container.remove();
      vi.unstubAllGlobals();
    }
  });
});

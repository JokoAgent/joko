// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { translate } from "../i18n.js";
import type { TimelineItemView } from "../model.js";
import { createMessageComposerMention } from "./message-actions.js";
import { ContextRebuildCard, contextRebuildTimelineCopy } from "./Timeline.js";

const roots: Root[] = [];
const english = (key: Parameters<typeof translate>[1], values?: Readonly<Record<string, string | number>>) => translate("en", key, values);
const chinese = (key: Parameters<typeof translate>[1], values?: Readonly<Record<string, string | number>>) => translate("zh-CN", key, values);

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("ContextRebuildCard", () => {
  it("localizes the durable rebuild reason without gateway-authored display text", () => {
    expect(contextRebuildTimelineCopy(contextRebuildItem("contextOverflow"), english).label).toBe("Context reorganized, continuing");
    expect(contextRebuildTimelineCopy(contextRebuildItem("promptTimeout"), chinese).label).toBe("上一轮没有响应，已整理后继续");
    expect(contextRebuildTimelineCopy(contextRebuildItem("contextOverflow"), chinese).handoffTitle).toContain("原文为英文");
  });

  it("renders a collapsed system separator and reveals only its handoff panel on demand", async () => {
    const item = contextRebuildItem("contextOverflow");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<ContextRebuildCard item={item} t={english} />));

    const card = container.querySelector<HTMLElement>('[role="separator"]')!;
    const trigger = card.querySelector<HTMLButtonElement>("button")!;
    expect(card.getAttribute("aria-label")).toBe("Context reorganized, continuing");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(card.querySelector("pre")).toBeNull();
    expect(card.querySelector(".message-user, .message-assistant, .message-actions")).toBeNull();
    expect(createMessageComposerMention("session-1", "Task", item)).toBeUndefined();

    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(card.querySelector("pre")?.textContent).toBe("[JOKO SAFE CONTEXT HANDOFF]\nSurviving context.");
    expect(trigger.getAttribute("aria-controls")).toBe(card.querySelector(".context-rebuild-card__handoff")?.id);
  });
});

function contextRebuildItem(reason: "contextOverflow" | "promptTimeout"): TimelineItemView {
  return {
    id: `context-rebuild-${reason}`,
    sequence: 3n,
    kind: "contextRebuild",
    createdAt: 123,
    contextRebuild: {
      reason,
      handoff: "[JOKO SAFE CONTEXT HANDOFF]\nSurviving context.",
      sourceRunId: "run-failed",
      replayScheduled: true
    }
  };
}

import { describe, expect, it } from "vitest";
import { MobileConversationShareSelection, type MobileConversationShareMessage } from "./mobile-conversation-share";
import { buildConversationShareSvgLayout, conversationShareSvgRenderSize } from "./mobile-conversation-share-layout";

const colors = { background: "#ffffff", surfaceElevated: "#eeeeee", textPrimary: "#111111", textSecondary: "#555555", textTertiary: "#888888" };
const message = (clientId: string, text: string): MobileConversationShareMessage => ({ clientId, kind: "assistant", body: text,
  bodyParts: [{ kind: "text", text }], attachments: [] });

describe("mobile conversation image sharing", () => {
  it("restores the previous selection after select-all and retires removed rows and another task", () => {
    const selection = new MobileConversationShareSelection();
    selection.enter("task", "c"); selection.toggle("a");
    expect(selection.selected(["a", "b", "c"])).toEqual(["a", "c"]);
    selection.toggleAll(["a", "b", "c"]); selection.toggleAll(["a", "b", "c"]);
    expect(selection.selected(["a", "b", "c"])).toEqual(["a", "c"]);
    selection.reconcile("task", ["a", "b"]);
    expect(selection.selected(["a", "b"])).toEqual(["a"]);
    selection.reconcile("another-task", ["a"]);
    expect(selection.active).toBe(false);
  });

  it("keeps ordered images and failure labels in place, redacts secrets and marks skipped messages", () => {
    const first = { ...message("a", ""), bodyParts: [{ kind: "text" as const, text: "before\n" },
      { kind: "image" as const, key: "image", label: "Original image" }, { kind: "text" as const, text: "after\napi_key=secret-value" }],
      images: new Map([["image", { uri: "data:image/png;base64,canonical", width: 100, height: 80 }]]) };
    const layout = buildConversationShareSvgLayout({ allShareableIds: ["a", "b", "c"], messages: [first, message("c", "最后 👋\n![Untrusted image](https://untrusted.invalid/image.png)")], width: 390, colors });
    const text = layout.bubbles.flatMap((bubble) => bubble.textBlocks.flatMap((block) => block.lines)).join("\n");
    expect(layout.gaps).toHaveLength(1); expect(layout.images).toHaveLength(1);
    expect(text).toContain("[REDACTED]"); expect(text).not.toContain("secret-value"); expect(text).toContain("最后 👋");
    expect(text).toContain("Untrusted image"); expect(layout.images[0]!.uri).toContain("canonical");
    const blocks = layout.bubbles[0]!.textBlocks;
    expect(blocks[0]!.y).toBeLessThan(layout.images[0]!.y);
    expect(blocks.at(-1)!.y).toBeGreaterThan(layout.images[0]!.y);
    const fallback = buildConversationShareSvgLayout({ allShareableIds: ["a"], messages: [{ ...first, images: new Map() }], width: 390, colors });
    const fallbackText = fallback.bubbles.flatMap((bubble) => bubble.textBlocks.flatMap((block) => block.lines)).join("\n");
    expect(fallbackText.indexOf("before")).toBeLessThan(fallbackText.indexOf("Original image"));
    expect(fallbackText.indexOf("Original image")).toBeLessThan(fallbackText.indexOf("after"));
    expect(conversationShareSvgRenderSize({ width: 390, height: 50_000 }).sourceTooLarge).toBe(true);
    const render = conversationShareSvgRenderSize(layout);
    expect(render.width * render.height).toBeLessThan(12_050_000);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { MAXIMUM_SHARE_IMAGE_EDGE_PIXELS, MAXIMUM_SHARE_IMAGE_PIXELS, MAXIMUM_SHARE_MESSAGE_CHARACTERS, ShareMessageImageTooLargeError } from "./share-message-image.js";
import { buildShareSelectionImagePng, layoutShareSelectionImage, shareSelectionImageMessages } from "./share-selection-image.js";
import type { TimelineItemView } from "../model.js";

afterEach(() => vi.unstubAllGlobals());

describe("multi-message share PNG", () => {
  it("preserves selected timeline order and marks skipped messages honestly", () => {
    const all = [item("one", "user"), item("two", "assistant"), item("three", "user")];
    const selected = shareSelectionImageMessages(all, [all[0]!, all[2]!], { user: "You", assistant: "Agent", attachments: "Attachments" }, () => "now");
    expect(selected.map((message) => [message.id, message.gapBefore])).toEqual([["one", false], ["three", true]]);
  });

  it("never paints Joko's private quote marker into a multi-message share image", () => {
    const quoted = { ...item("quoted", "user", "> <!-- joko-selection-quote -->\n> selected\n\nreply"), quotesEncoded: true };
    const selected = shareSelectionImageMessages([quoted], [quoted], { user: "You", assistant: "Agent", attachments: "Attachments" }, () => "now");
    expect(selected[0]?.text).toBe("> selected\n\nreply");
    expect(selected[0]?.text).not.toContain("joko-selection-quote");
  });

  it("keeps a user-typed marker visible when no product quote gate exists", () => {
    const typed = item("typed", "user", "> <!-- joko-selection-quote -->\n> ordinary text");
    const selected = shareSelectionImageMessages([typed], [typed], { user: "You", assistant: "Agent", attachments: "Attachments" }, () => "now");
    expect(selected[0]?.text).toContain("joko-selection-quote");
  });

  it("lays out multiple redacted cards within the same readable pixel budget", () => {
    const layout = layoutShareSelectionImage({
      sessionName: "Deploy sk-secretvalue123",
      messages: [
        { id: "one", role: "user", roleLabel: "You", text: "token=secretvalue123", attachmentNames: [], attachmentsLabel: "Attachments", gapBefore: false },
        { id: "two", role: "assistant", roleLabel: "Agent", text: "Done", attachmentNames: ["result.txt"], attachmentsLabel: "Attachments", gapBefore: true }
      ]
    }, (value) => value.length * 8);
    expect(layout.title).not.toContain("secretvalue123");
    expect(layout.cards[0]?.lines.join(" ")).not.toContain("secretvalue123");
    expect(layout.cards[1]?.gapBefore).toBe(true);
    expect(layout.width * layout.scale).toBeLessThanOrEqual(MAXIMUM_SHARE_IMAGE_EDGE_PIXELS);
    expect(layout.height * layout.scale).toBeLessThanOrEqual(MAXIMUM_SHARE_IMAGE_EDGE_PIXELS);
    expect(layout.width * layout.height * layout.scale ** 2).toBeLessThanOrEqual(MAXIMUM_SHARE_IMAGE_PIXELS);
  });

  it("rejects selections that exceed the shared readable-content budget", () => {
    expect(() => layoutShareSelectionImage({
      sessionName: "Task",
      messages: [{ id: "one", role: "user", roleLabel: "You", text: "x".repeat(MAXIMUM_SHARE_MESSAGE_CHARACTERS + 1), attachmentNames: [], attachmentsLabel: "Attachments", gapBefore: false }]
    }, () => 1)).toThrow(ShareMessageImageTooLargeError);
  });

  it("encodes the combined export directly as a real PNG", async () => {
    const encoded = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1])], { type: "image/png" });
    const encodingTypes: string[] = [];
    const context = new Proxy({ measureText: (value: string) => ({ width: value.length * 8 }) } as unknown as CanvasRenderingContext2D, {
      get(target, property) { return property in target ? Reflect.get(target, property) : vi.fn(); },
      set(target, property, value) { return Reflect.set(target, property, value); }
    });
    const canvas = { width: 0, height: 0, getContext: () => context, toBlob: (callback: BlobCallback, type?: string) => { encodingTypes.push(type ?? ""); callback(encoded); } } as unknown as HTMLCanvasElement;
    vi.stubGlobal("document", { createElement: () => canvas });
    await expect(buildShareSelectionImagePng({ sessionName: "Task", messages: [{ id: "one", role: "assistant", roleLabel: "Agent", text: "Done", attachmentNames: [], attachmentsLabel: "Attachments", gapBefore: false }] }, {
      background: "white", surface: "white", text: "black", secondaryText: "gray", line: "gray", accent: "orange", accentInk: "black", fontFamily: "sans-serif"
    })).resolves.toBe(encoded);
    expect(encodingTypes).toEqual(["image/png"]);
  });
});

function item(id: string, kind: "user" | "assistant", text = id): TimelineItemView {
  return { id, kind, text, sequence: BigInt(id.length), createdAt: id.length };
}

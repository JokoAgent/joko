// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { translate } from "../i18n.js";
import type { QueueItemView } from "../model.js";
import { SELECTION_QUOTE_BLOCK_MARKER_LINE } from "../selection-quote.js";
import { QueueInputPreview } from "./QueueInputPreview.js";

let root: Root | undefined;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

describe("queue input preview", () => {
  it("uses UTF-16 occurrence receipts instead of guessing between same-named mentions", async () => {
    const text = "😀 @Same then @Same";
    const first = text.indexOf("@Same");
    const second = text.indexOf("@Same", first + 1);
    const host = await render(item({
      text,
      inputMentions: [
        { kind: "workspace", workspaceId: "workspace", relativePath: "second.ts", displayText: "@Same", directory: false },
        { kind: "artifact", artifactId: "first-artifact", displayText: "@Same" }
      ],
      mentionRanges: [
        { start: first, end: first + "@Same".length, mentionIndex: 1 },
        { start: second, end: second + "@Same".length, mentionIndex: 0 }
      ]
    }));

    const chips = [...host.querySelectorAll<HTMLElement>("[data-queue-mention-index]")];
    expect(chips.map((chip) => [chip.querySelector("[data-queue-chip-label]")?.textContent, chip.dataset.queueMentionIndex, chip.dataset.queueMentionKind])).toEqual([
      ["@Same", "1", "artifact"],
      ["@Same", "0", "workspace"]
    ]);
    expect(host.querySelector(".queue-input-preview__references")).toBeNull();
  });

  it("renders encoded quotes, pasted ranges, detached mentions and attachments as static chips", async () => {
    const text = `${SELECTION_QUOTE_BLOCK_MARKER_LINE}\n> Quoted line\n\nKeep pasted body`;
    const pastedStart = text.indexOf("pasted");
    const host = await render(item({
      text,
      quotesEncoded: true,
      pastedTextRanges: [{ start: pastedStart, end: pastedStart + "pasted".length, display: "Pasted text (1 line)" }],
      inputMentions: [{ kind: "session", sessionId: "other-task", displayText: "Earlier task" }],
      attachments: [
        { kind: "image", label: "diagram.png" },
        { kind: "file", label: "notes.txt" }
      ]
    }));

    expect(host.querySelector("[data-selection-quote-chip]")?.textContent).toContain("Quoted line");
    expect(host.querySelector("[data-queue-pasted-text]")?.textContent).toBe("Pasted text (1 line)");
    expect(host.textContent).toContain("Keep ");
    expect(host.textContent).toContain(" body");
    expect(host.textContent).not.toContain(SELECTION_QUOTE_BLOCK_MARKER_LINE);
    const detached = host.querySelector<HTMLElement>(".queue-input-preview__references [data-queue-mention-kind=session]");
    expect(detached?.querySelector("[data-queue-chip-label]")?.textContent).toBe("Earlier task");
    expect(detached?.textContent).toBe("Task reference: Earlier task");
    expect([...host.querySelectorAll<HTMLElement>("[data-queue-attachment-kind]")].map((chip) => [chip.dataset.queueAttachmentKind, chip.querySelector("[data-queue-chip-label]")?.textContent])).toEqual([
      ["image", "diagram.png"],
      ["file", "notes.txt"]
    ]);
    expect(host.querySelector("button, a, [tabindex]")).toBeNull();
  });

  it("falls back only for mentions not actually rendered and gives unnamed static atoms localized accessible names", async () => {
    const text = `${SELECTION_QUOTE_BLOCK_MARKER_LINE}\n> Quoted @Hidden\n\nUse @Visible`;
    const hiddenStart = text.indexOf("@Hidden");
    const visibleStart = text.indexOf("@Visible");
    const host = await render(item({
      text,
      quotesEncoded: true,
      inputMentions: [
        { kind: "session", sessionId: "hidden-task", displayText: " " },
        { kind: "workspace", workspaceId: "workspace", relativePath: "src", displayText: "Visible", directory: true }
      ],
      mentionRanges: [
        { start: hiddenStart, end: hiddenStart + "@Hidden".length, mentionIndex: 0 },
        { start: visibleStart, end: visibleStart + "@Visible".length, mentionIndex: 1 }
      ],
      attachments: [
        { kind: "image", label: "" },
        { kind: "file", label: " " }
      ]
    }), "zh-CN");

    expect([...host.querySelectorAll<HTMLElement>(".queue-input-preview__text [data-queue-mention-index]")]
      .map((chip) => chip.dataset.queueMentionIndex)).toEqual(["1"]);
    const detached = [...host.querySelectorAll<HTMLElement>(".queue-input-preview__references [data-queue-mention-index]")];
    const unnamedReference = translate("zh-CN", "queue.previewUnnamedReference");
    const unnamedAttachment = translate("zh-CN", "queue.previewUnnamedAttachment");
    expect(detached.map((chip) => chip.dataset.queueMentionIndex)).toEqual(["0"]);
    expect(detached[0]?.querySelector("[data-queue-chip-label]")?.textContent).toBe(unnamedReference);
    expect(detached[0]?.textContent).toBe(translate("zh-CN", "queue.previewAccessibleLabel", {
      type: translate("zh-CN", "queue.previewReference.session"),
      name: unnamedReference
    }));
    expect([...host.querySelectorAll<HTMLElement>("[data-queue-attachment-kind]")].map((chip) => chip.textContent)).toEqual([
      translate("zh-CN", "queue.previewAccessibleLabel", {
        type: translate("zh-CN", "queue.previewAttachment.image"),
        name: unnamedAttachment
      }),
      translate("zh-CN", "queue.previewAccessibleLabel", {
        type: translate("zh-CN", "queue.previewAttachment.file"),
        name: unnamedAttachment
      })
    ]);
    expect(host.querySelector("button, a, [tabindex]")).toBeNull();
  });
});

async function render(queueItem: QueueItemView, locale: "en" | "zh-CN" = "en"): Promise<HTMLElement> {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(<QueueInputPreview {...queueItem} t={(key, values) => translate(locale, key, values)} />));
  return host;
}

function item(fields: Partial<QueueItemView>): QueueItemView {
  return {
    id: "queue-item",
    sessionId: "task",
    revision: 1n,
    generation: 1n,
    source: "user",
    mode: "followUp",
    text: "",
    state: "accepted",
    editLocked: false,
    ordinal: 0,
    createdAt: 1,
    ...fields
  };
}

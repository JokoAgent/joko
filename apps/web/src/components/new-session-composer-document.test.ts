import { describe, expect, it } from "vitest";
import { composerDocumentPlainText, plainTextToComposerDocument } from "../composer-quote-document.js";
import { insertNewSessionPaletteDocument } from "./new-session-composer-document.js";

describe("new-session structured composer insertion", () => {
  it("appends commands without flattening an existing list", () => {
    const original = plainTextToComposerDocument("- inspect\n- verify");
    const inserted = insertNewSessionPaletteDocument(original, undefined, {
      id: "command:review",
      label: "/review",
      value: "/review",
      meta: "Review"
    });

    expect(inserted.document.content?.[0]?.type).toBe("bulletList");
    expect(inserted.document.content?.[1]).toMatchObject({
      type: "paragraph",
      content: [{ type: "text", text: " /review " }]
    });
    expect(inserted.text).toBe("- inspect\n- verify\n /review");
  });

  it("keeps a pasted-text atom intact while appending a mention", () => {
    const original = {
      type: "doc",
      content: [{
        type: "paragraph",
        content: [{ type: "composerPastedText", attrs: { text: "full\npayload", display: "Pasted text (2 lines)" } }]
      }]
    };
    const inserted = insertNewSessionPaletteDocument(original, undefined, {
      id: "workspace:src/main.ts",
      label: "main.ts",
      value: "@src/main.ts",
      meta: "src/main.ts"
    });

    expect(inserted.document.content?.[0]?.content?.[0]?.type).toBe("composerPastedText");
    expect(inserted.document.content?.[0]?.content?.[1]).toEqual({ type: "text", text: " @src/main.ts " });
    expect(composerDocumentPlainText(inserted.document)).toBe("full\npayload @src/main.ts");
  });

  it("replaces an exact typed trigger with the selected item", () => {
    const inserted = insertNewSessionPaletteDocument(plainTextToComposerDocument("/"), "/", {
      id: "command:status",
      label: "/status",
      value: "/status",
      meta: "Status"
    });
    expect(inserted.text).toBe("/status");
    expect(inserted.document).toEqual(plainTextToComposerDocument("/status "));
  });
});

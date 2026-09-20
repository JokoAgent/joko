import { describe, expect, it } from "vitest";
import {
  buildMobileComposerRichApplyScript,
  buildMobileComposerRichConfigScript,
  buildMobileComposerRichInputHtml,
  mobileComposerRichJson
} from "./mobile-composer-rich-input-html";
import type { MobileComposerRichDocument } from "./mobile-composer-rich-document";

const theme = {
  background: "#ffffff",
  border: "#cccccc",
  chip: "#f4f1ff",
  focus: "#7157d9",
  placeholder: "#777777",
  text: "#171522",
  textSecondary: "#514c63"
};

describe("mobile composer rich input HTML", () => {
  it("builds a no-network semantic editor with atomic edit and recovery hooks", () => {
    const document: MobileComposerRichDocument = {
      version: 1,
      nodes: [
        { type: "text", text: "hello " },
        { type: "occurrence", occurrenceKey: "mention:one", kind: "session", token: "@Task",
          label: "@Task", accessibilityLabel: "Task reference Task", block: false }
      ]
    };
    const html = buildMobileComposerRichInputHtml({
      accessibilityLabel: "Task message",
      document,
      documentId: 1,
      commandPaletteOpen: true,
      editable: true,
      instanceId: "instance-1",
      maxHeight: 260,
      placeholder: "Message Joko…",
      selection: { start: 6, end: 6 },
      theme
    });
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("contentEditable = runtime.editable");
    expect(html).toContain("compositionstart");
    expect(html).toContain("type: 'composition'");
    expect(html).toContain("root.addEventListener('compositionend', finishComposition)");
    expect(html).toContain("notify();\n    post({ type: 'composition', composing: false })");
    expect(html).toContain("type: 'paletteKey'");
    expect(html).toContain("root.addEventListener('beforeinput'");
    expect(html).toContain("event.inputType === 'insertParagraph'");
    expect(html).toContain("event.preventDefault()");
    expect(html).toContain("removeOccurrenceAtCaret");
    expect(html).toContain("window.jokoComposer");
    expect(html).toContain("type: 'paste'");
    expect(html).not.toContain("fetch(");
    expect(html).not.toContain("XMLHttpRequest");
    expect(html).not.toContain("quoted source payload");
    const script = html.match(/<script>([\s\S]+)<\/script>/u)?.[1];
    expect(script).toBeDefined();
    expect(() => new Function(script!)).not.toThrow();
  });

  it("escapes script-closing and Unicode separator text in every injected payload", () => {
    const dangerous = "</script><script>bad()</script>\u2028\u2029&";
    const encoded = mobileComposerRichJson({ dangerous });
    expect(encoded).not.toContain("</script>");
    expect(encoded).toContain("\\u003c/script\\u003e");
    expect(encoded).toContain("\\u2028");
    expect(encoded).toContain("\\u2029");

    const document: MobileComposerRichDocument = { version: 1, nodes: [{ type: "text", text: dangerous }] };
    const apply = buildMobileComposerRichApplyScript({
      document,
      documentId: 2,
      selection: { start: 0, end: 0 },
      focus: false
    });
    const runtime = buildMobileComposerRichConfigScript({
      accessibilityLabel: dangerous,
      commandPaletteOpen: false,
      editable: false,
      maxHeight: 144,
      placeholder: dangerous,
      theme
    });
    expect(apply).not.toContain("</script>");
    expect(runtime).not.toContain("</script>");
  });

  it("never serializes authority outside the bounded render document", () => {
    const html = buildMobileComposerRichInputHtml({
      accessibilityLabel: "First message",
      document: {
        version: 1,
        nodes: [{ type: "occurrence", occurrenceKey: "atom:quote-1", kind: "quote",
          token: "⟦Quote from Assistant⟧", label: "Quote from Assistant",
          accessibilityLabel: "Quote from Assistant", block: true }]
      },
      documentId: 8,
      commandPaletteOpen: false,
      editable: true,
      instanceId: "instance-2",
      maxHeight: 132,
      placeholder: "What should Joko do?",
      selection: { start: 0, end: 0 },
      theme
    });
    expect(html).toContain("atom:quote-1");
    expect(html).not.toContain("sourceSessionId");
    expect(html).not.toContain("sourceMessageId");
    expect(html).not.toContain("sourceEventId");
  });
});

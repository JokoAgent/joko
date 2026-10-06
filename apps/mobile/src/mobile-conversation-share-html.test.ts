import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { buildMobileConversationShareHtml } from "./mobile-conversation-share-html";
import type { MobileConversationShareSnapshot } from "./mobile-conversation-share";

const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string) => { window: { document: Document } };
};

vi.mock("./connection-artwork", () => ({ mobileConnectionAppIcon: () => '<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>' }));
const colors = { background: "#ffffff", surfaceElevated: "#eeeeee", textPrimary: "#242a2d", textSecondary: "#637073", textTertiary: "#aaaaaa" };
const runtime = { katexScript: "", katexCss: "", mermaidScript: "" };
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function snapshot(text: string): MobileConversationShareSnapshot {
  return { leaseId: "lease", allShareableIds: ["a", "b", "c"], messages: [
    { clientId: "a", kind: "user", body: "Ask", bodyParts: [{ kind: "text", text: "Ask" }], attachments: [] },
    { clientId: "c", kind: "assistant", body: text, attachments: [],
      bodyParts: [{ kind: "text", text }, { kind: "image", key: "canonical", label: "Picture" }, { kind: "text", text: "After image" }],
      images: new Map([["canonical", { uri: png, width: 1, height: 1 }]]) }
  ] };
}

describe("offline rich conversation image document", () => {
  it("preserves ordered formatted content, skipped gaps and canonical image occurrences without navigation authority", () => {
    const text = "# Title\n\n**strong**, *emphasis*, ~~deleted~~ and `inline`\n\n> Quote\n\n- [x] Done\n\n```ts\nconst value = 42;\n```\n\n| A | B | C |\n| --- | --- | --- |\n| one | two | three |\n\nInline $x^2$.\n\n$$\n\\frac{1}{2}\n$$\n\n```mermaid\nflowchart TD\n A[Work] → B[Done]\n```\n\n[Website](https://example.test/private) ![Unavailable](file:///outside.png)\n\n<script>window.injected = true</script>";
    const document = new JSDOM(buildMobileConversationShareHtml({ snapshot: snapshot(text), colors, width: 390, dark: false }, runtime)).window.document;
    expect(Array.from(document.querySelectorAll("article")).map((node) => node.className)).toEqual(["share-message share-message-user", "share-message share-message-assistant"]);
    expect(document.querySelector(".share-gap")?.textContent).toBe("⋯");
    expect(document.querySelector("h1")?.textContent).toBe("Title");
    expect(document.querySelector("strong")?.textContent).toBe("strong");
    expect(document.querySelector(".hljs-keyword")?.textContent).toBe("const");
    expect(document.querySelector("pre code")?.textContent).toBe("const value = 42;");
    expect(document.querySelectorAll("th")).toHaveLength(3);
    expect(document.querySelectorAll("[data-latex]")).toHaveLength(2);
    expect(document.querySelector("[data-mermaid-repaired-source]")?.getAttribute("data-mermaid-repaired-source")).toContain("-->");
    expect(document.querySelector("img")?.getAttribute("src")).toBe(png);
    expect(document.querySelector(".share-image-fallback")?.textContent).toBe("Unavailable");
    expect(document.querySelector("article:last-of-type")?.textContent).toContain("<script>window.injected = true</script>");
    expect(document.querySelector(".share-footer svg")).not.toBeNull();
    expect(document.querySelector(".share-footer")?.textContent).toBe("Joko");
    expect(document.querySelectorAll("a,[href],iframe,object")).toHaveLength(0);
    expect(document.documentElement.innerHTML).not.toContain("file:///outside.png");
    expect(document.documentElement.innerHTML).not.toContain("https://example.test/private");
    expect(document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content")).toContain("connect-src 'none'");
  });

  it("rejects stale order and redaction across body parts, and replaces noncanonical image resources in place", () => {
    const source = snapshot("safe");
    const invalid = { ...source, messages: [...source.messages].reverse() };
    expect(() => buildMobileConversationShareHtml({ snapshot: invalid, colors, width: 390, dark: false }, runtime)).toThrow(/order/u);
    const message = { ...source.messages[1]!, bodyParts: [{ kind: "text" as const, text: "Authorization:" }, { kind: "text" as const, text: " Bearer secret-example" }] };
    expect(() => buildMobileConversationShareHtml({ snapshot: { ...source, messages: [message] }, colors, width: 390, dark: false }, runtime)).toThrow(/redaction/u);
    const badImages = { ...source, messages: source.messages.map((item) => ({ ...item, images: new Map([["canonical", { uri: "https://example.test/private-image", width: 1, height: 1 }]]) })) };
    const document = new JSDOM(buildMobileConversationShareHtml({ snapshot: badImages, colors, width: 390, dark: true }, runtime)).window.document;
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("article:last-of-type")?.textContent).toBe("safePictureAfter image");
    expect(document.documentElement.innerHTML).not.toContain("private-image");
    expect(() => buildMobileConversationShareHtml({ snapshot: source, colors: { ...colors, background: "red;bad" }, width: 390, dark: false }, runtime)).toThrow(/invalid/u);
  });
  it("lets the browser determine an EXIF image's natural aspect within the export bounds", () => {
    const source = snapshot("portrait"); const message = source.messages[1]!;
    const images = new Map([["canonical", { uri: png, width: 160, height: 100, nativeQuarterTurn: true as const }]]);
    const document = new JSDOM(buildMobileConversationShareHtml({
      snapshot: { ...source, messages: [{ ...message, images }] }, colors, width: 390, dark: false
    }, runtime)).window.document;
    const image = document.querySelector<HTMLImageElement>(".share-image")!;
    expect(image.getAttribute("src")).toBe(png);
    expect(image.hasAttribute("width")).toBe(false); expect(image.hasAttribute("height")).toBe(false);
    expect(image.style.width).toBe("auto"); expect(image.style.height).toBe("auto");
    expect(image.style.maxWidth).toBe("100%"); expect(image.style.maxHeight).toBe("320px");
    expect(image.style.aspectRatio).toBe(""); expect(image.style.objectFit).toBe("contain");
  });
});

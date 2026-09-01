import { describe, expect, it } from "vitest";
import { composerDocumentQuotes, normalizeComposerDocument } from "../composer-quote-document.js";
import { ComposerQuoteNode } from "./ComposerQuoteNode.js";

interface AttributeSpec {
  readonly default?: unknown;
  readonly parseHTML?: (element: HTMLElement) => unknown;
  readonly renderHTML?: (attrs: Record<string, unknown>) => Record<string, unknown>;
}

describe("ComposerQuoteNode structured attrs", () => {
  it("round-trips a file quote through TipTap attribute HTML hooks and JSON normalization", () => {
    const source = {
      id: "file-quote",
      kind: "file",
      text: "quoted <value>\nsecond line",
      sessionId: "session-one",
      messageId: null,
      sourceEventId: null,
      role: null,
      sourcePath: "src/example.ts",
      startLine: 7,
      endLine: 9
    };
    const htmlAttributes = renderAttributes(source);
    expect(htmlAttributes).toMatchObject({
      "data-quote-kind": "file",
      "data-source-path": "src/example.ts",
      "data-start-line": "7",
      "data-end-line": "9"
    });
    expect(htmlAttributes).not.toHaveProperty("data-message-id");
    expect(htmlAttributes).not.toHaveProperty("data-message-role");

    const parsed = parseAttributes(htmlAttributes, source.text);
    expect(composerDocumentQuotes(normalizeComposerDocument(quoteDocument(parsed)))).toEqual([{
      id: "file-quote",
      kind: "file",
      text: "quoted <value>\nsecond line",
      sessionId: "session-one",
      sourcePath: "src/example.ts",
      startLine: 7,
      endLine: 9
    }]);
  });

  it("round-trips message identity without materializing file attributes", () => {
    const source = {
      id: "message-quote",
      kind: "message",
      text: "quoted",
      sessionId: "session-one",
      messageId: "assistant-one",
      sourceEventId: "event-one",
      role: "assistant",
      sourcePath: null,
      startLine: null,
      endLine: null
    };
    const htmlAttributes = renderAttributes(source);
    expect(htmlAttributes).toMatchObject({
      "data-message-id": "assistant-one",
      "data-source-event-id": "event-one",
      "data-message-role": "assistant"
    });
    expect(htmlAttributes).not.toHaveProperty("data-source-path");
    const parsed = parseAttributes(htmlAttributes, source.text);
    expect(composerDocumentQuotes(normalizeComposerDocument(quoteDocument(parsed)))).toEqual([{
      id: "message-quote",
      kind: "message",
      text: "quoted",
      sessionId: "session-one",
      messageId: "assistant-one",
      sourceEventId: "event-one",
      role: "assistant"
    }]);
  });
});

function attributeSpecs(): Record<string, AttributeSpec> {
  const addAttributes = ComposerQuoteNode.config.addAttributes as unknown as (() => Record<string, AttributeSpec>) | undefined;
  return addAttributes?.() ?? {};
}

function renderAttributes(attrs: Record<string, unknown>): Record<string, unknown> {
  const rendered: Record<string, unknown> = {};
  for (const spec of Object.values(attributeSpecs())) Object.assign(rendered, spec.renderHTML?.(attrs) ?? {});
  return rendered;
}

function parseAttributes(attributes: Record<string, unknown>, textContent: string): Record<string, unknown> {
  const element = {
    textContent,
    getAttribute: (name: string): string | null => typeof attributes[name] === "string" ? attributes[name] as string : null,
    hasAttribute: (name: string): boolean => Object.hasOwn(attributes, name)
  } as HTMLElement;
  return Object.fromEntries(Object.entries(attributeSpecs()).map(([name, spec]) => [
    name,
    spec.parseHTML === undefined ? spec.default : spec.parseHTML(element)
  ]));
}

function quoteDocument(attrs: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "composerQuote", attrs }] }]
  };
}

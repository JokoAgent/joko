// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pngBlob } from "./share-image.test-support.js";
import {
  RENDERED_SHARE_EXCLUDE_ATTRIBUTE,
  RENDERED_SHARE_MESSAGE_ATTRIBUTE,
  ShareRenderedMessageNotMountedError,
  assertRenderedShareReadableSize,
  buildRenderedShareMessageImagePng,
  expandRenderedShareCollapsedContent,
  expandRenderedShareScrollableBlocks,
  queryRenderedShareMessageIds,
  redactRenderedShareTextNodes,
  stripRenderedShareCloneAnchors,
  stripRenderedShareInteractiveElements,
  type RenderedShareImageContent
} from "./share-rendered-message-image.js";
import { ShareMessageImageTooLargeError } from "./share-message-image.js";
import { timelineDomToPng } from "./timeline-image-export.js";

vi.mock("./timeline-image-export.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./timeline-image-export.js")>();
  return { ...actual, timelineDomToPng: vi.fn() };
});

beforeEach(() => {
  vi.mocked(timelineDomToPng).mockResolvedValue(validatedPngBlob());
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("rendered share selection identity", () => {
  it("accepts only messages from the exact connected session root in DOM order", async () => {
    const root = timelineRoot("session-a");
    root.append(message("first"), message("second"));
    const nested = root.appendChild(document.createElement("div"));
    nested.dataset.timelineSessionId = "nested";
    nested.append(message("nested-only"));

    expect(queryRenderedShareMessageIds(root)).toEqual(["first", "second"]);
    await expect(build(root, "session-a", content("missing"))).rejects.toBeInstanceOf(ShareRenderedMessageNotMountedError);
    await expect(build(root, "other-session", content("first"))).rejects.toBeInstanceOf(ShareRenderedMessageNotMountedError);
    await expect(build(root, "session-a", content("second", "first"))).rejects.toBeInstanceOf(ShareRenderedMessageNotMountedError);
    await expect(build(root, "session-a", content("nested-only"))).rejects.toBeInstanceOf(ShareRenderedMessageNotMountedError);

    root.remove();
    await expect(build(root, "session-a", content("first"))).rejects.toBeInstanceOf(ShareRenderedMessageNotMountedError);
    expect(timelineDomToPng).not.toHaveBeenCalled();
  });
});

describe("rendered share clone preparation", () => {
  it("redacts a credential split across highlighted spans without flattening its structure", () => {
    const root = document.createElement("article");
    root.innerHTML = '<p>Use <mark data-highlight="one">sk-super</mark><span data-highlight="two">secret123456</span> today</p>';
    const mark = root.querySelector("mark")!;
    const span = root.querySelector("span")!;

    redactRenderedShareTextNodes(root);

    expect(root.textContent).toBe("Use [REDACTED_TOKEN] today");
    expect(root.textContent).not.toContain("supersecret123456");
    expect(root.querySelector("mark")).toBe(mark);
    expect(root.querySelector("span")).toBe(span);
    expect(mark.dataset.highlight).toBe("one");
    expect(span.dataset.highlight).toBe("two");
  });

  it("removes controls and clone anchors while expanding collapsed and selection-only wrappers", () => {
    const root = document.createElement("article");
    root.className = "is-share-selecting";
    root.dataset.userMsgId = "user-1";
    root.dataset.messageClientId = "client-1";
    root.setAttribute(RENDERED_SHARE_MESSAGE_ATTRIBUTE, "message-1");
    root.innerHTML = `
      <button ${RENDERED_SHARE_EXCLUDE_ATTRIBUTE}>select</button>
      <div class="message-actions">actions</div>
      <button class="message-user__collapse-toggle">collapse</button>
      <div class="message-user__content is-collapsed" data-timeline-item-id="item-1">Full content</div>
      <div class="message-assistant__selection-stack"><pre><code>const kept = true;</code></pre></div>
      <div class="timeline-mermaid__toolbar">toolbar</div>
      <span data-selection-quote-message-id="quote-1">Quoted</span>
    `;

    stripRenderedShareInteractiveElements(root);
    expandRenderedShareCollapsedContent(root);
    stripRenderedShareCloneAnchors(root);

    expect(root.querySelector("button, .message-actions, .timeline-mermaid__toolbar")).toBeNull();
    expect(root.classList.contains("is-share-selecting")).toBe(false);
    expect(root.querySelector(".is-collapsed, .message-assistant__selection-stack")).toBeNull();
    expect(root.querySelector("code")?.textContent).toBe("const kept = true;");
    expect(root.hasAttribute("data-user-msg-id")).toBe(false);
    expect(root.hasAttribute("data-message-client-id")).toBe(false);
    expect(root.hasAttribute(RENDERED_SHARE_MESSAGE_ATTRIBUTE)).toBe(false);
    expect(root.querySelector("[data-timeline-item-id], [data-selection-quote-message-id]")).toBeNull();
    expect(root.textContent).toContain("Full content");
    expect(root.textContent).toContain("Quoted");
  });

  it("expands wide and vertically clipped scroll containers for the frozen image", () => {
    const root = document.createElement("div");
    const wide = root.appendChild(document.createElement("pre"));
    wide.style.overflowX = "auto";
    const tall = root.appendChild(document.createElement("div"));
    tall.style.overflowY = "scroll";
    Object.defineProperties(wide, { scrollWidth: { value: 1_600 }, clientWidth: { value: 480 } });
    Object.defineProperties(tall, { scrollHeight: { value: 1_200 }, clientHeight: { value: 300 } });

    expandRenderedShareScrollableBlocks(root);

    expect(wide.style.overflowX).toBe("visible");
    expect(wide.style.width).toBe("max-content");
    expect(wide.style.maxWidth).toBe("none");
    expect(tall.style.overflowY).toBe("visible");
    expect(tall.style.maxHeight).toBe("none");
  });

  it("accepts readable dimensions and rejects empty, non-finite, or downscaled-below-1x output", () => {
    const root = document.createElement("div");
    Object.defineProperties(root, {
      scrollWidth: { configurable: true, value: 900 },
      scrollHeight: { configurable: true, value: 1_200 }
    });
    expect(() => assertRenderedShareReadableSize(root)).not.toThrow();

    Object.defineProperty(root, "scrollHeight", { configurable: true, value: 0 });
    expect(() => assertRenderedShareReadableSize(root)).toThrow(ShareMessageImageTooLargeError);
    Object.defineProperty(root, "scrollHeight", { configurable: true, value: Number.POSITIVE_INFINITY });
    expect(() => assertRenderedShareReadableSize(root)).toThrow(ShareMessageImageTooLargeError);
    Object.defineProperties(root, {
      scrollWidth: { configurable: true, value: 10_000 },
      scrollHeight: { configurable: true, value: 10_000 }
    });
    expect(() => assertRenderedShareReadableSize(root)).toThrow(ShareMessageImageTooLargeError);
  });
});

it("passes an ordered rich, redacted snapshot with explicit gaps to rasterization without mutating the timeline", async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,ZmFrZQ==");
  const root = timelineRoot("session-rich");
  root.style.setProperty("--bg", "#f7f7f7");
  const first = message("first");
  first.innerHTML = `
    <pre><code>const answer = 42;</code><button class="timeline-code-block__copy">Copy</button></pre>
    <span class="katex"><span class="katex-html">x²</span></span>
    <div class="timeline-mermaid"><svg viewBox="0 0 10 10"><defs><clipPath id="diagram-clip"><rect width="10" height="10"></rect></clipPath></defs><path id="diagram-path" clip-path="url(#diagram-clip)" d="M0 0L10 10"></path></svg><div class="timeline-mermaid__toolbar">tools</div></div>
    <p>token=<mark>secret</mark><span>value123</span></p>
  `;
  const image = first.appendChild(document.createElement("img"));
  image.src = "blob:original-image";
  Object.defineProperties(image, {
    complete: { configurable: true, value: true },
    naturalWidth: { configurable: true, value: 320 },
    naturalHeight: { configurable: true, value: 180 }
  });
  const third = message("third");
  third.innerHTML = "<p>After the omitted message</p>";
  root.append(first, message("unselected"), third);
  const original = root.innerHTML;
  let snapshot!: HTMLElement;
  vi.mocked(timelineDomToPng).mockImplementation(async (node, action, options) => {
    expect(node.isConnected).toBe(true);
    expect(action.ownerDocument).toBe(document);
    expect(options).toEqual(expect.objectContaining({ desiredScale: 2 }));
    snapshot = node.cloneNode(true) as HTMLElement;
    return validatedPngBlob();
  });

  await expect(build(root, "session-rich", {
    sessionName: "Rich task",
    messages: [
      { id: "first", text: "token=secretvalue123", attachmentNames: ["diagram.png"] },
      { id: "third", text: "After the omitted message", attachmentNames: [] }
    ]
  })).resolves.toMatchObject({ type: "image/png" });

  expect(snapshot.querySelector("code")?.textContent).toBe("const answer = 42;");
  expect(snapshot.querySelector(".katex-html")?.textContent).toBe("x²");
  expect(snapshot.querySelector(".timeline-mermaid svg path")?.getAttribute("d")).toBe("M0 0L10 10");
  const snapshotClip = snapshot.querySelector("clipPath")!;
  const snapshotPath = snapshot.querySelector(".timeline-mermaid svg path")!;
  expect(snapshotClip.id).toMatch(/^rendered-share-\d+-id-\d+$/u);
  expect(snapshotPath.id).toMatch(/^rendered-share-\d+-id-\d+$/u);
  expect(snapshotPath.getAttribute("clip-path")).toBe(`url(#${snapshotClip.id})`);
  expect(snapshot.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,ZmFrZQ==");
  expect(snapshot.querySelector(".timeline-code-block__copy, .timeline-mermaid__toolbar")).toBeNull();
  expect(snapshot.textContent).toContain("token=[REDACTED]");
  expect(snapshot.textContent).not.toContain("secretvalue123");
  expect(snapshot.querySelectorAll("[data-rendered-share-gap]")).toHaveLength(1);
  expect([...snapshot.children].map((node) => node.tagName)).toEqual(["HEADER", "ARTICLE", "DIV", "ARTICLE", "FOOTER"]);
  expect(root.innerHTML).toBe(original);
  expect(image.src).toContain("blob:original-image");
  expect(root.querySelector(".timeline-code-block__copy, .timeline-mermaid__toolbar")).not.toBeNull();
  expect(document.querySelector("[data-rendered-share-export]")).toBeNull();
});

function timelineRoot(sessionId: string): HTMLElement {
  const root = document.body.appendChild(document.createElement("main"));
  root.className = "timeline";
  root.dataset.timelineSessionId = sessionId;
  return root;
}

function message(id: string): HTMLElement {
  const node = document.createElement("article");
  node.className = "message";
  node.setAttribute(RENDERED_SHARE_MESSAGE_ATTRIBUTE, id);
  node.textContent = id;
  return node;
}

function content(...ids: readonly string[]): RenderedShareImageContent {
  return {
    sessionName: "Task",
    messages: ids.map((id) => ({ id, text: id, attachmentNames: [] }))
  };
}

function build(
  timelineRootElement: HTMLElement,
  sessionId: string,
  imageContent: RenderedShareImageContent
): Promise<Blob> {
  return buildRenderedShareMessageImagePng({
    timelineRoot: timelineRootElement,
    sessionId,
    orderedTimelineMessageIds: queryRenderedShareMessageIds(timelineRootElement),
    content: imageContent,
    action: { ownerDocument: document, signal: new AbortController().signal }
  });
}

function validatedPngBlob(): Blob {
  const blob = pngBlob();
  vi.spyOn(blob, "slice").mockReturnValue({
    arrayBuffer: async () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer
  } as Blob);
  return blob;
}

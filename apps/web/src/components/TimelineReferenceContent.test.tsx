// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SentMessageReferenceText, TimelineMarkdownImage } from "./TimelineReferenceContent.js";
import type { Translator } from "./types.js";

const roots: Root[] = [];
const t: Translator = (key) => key;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.location.hash = "";
});

afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("timeline reference content", () => {
  it("restores sent task and file atoms as navigable chips", () => {
    const mounted = mount(<SentMessageReferenceText
      text="Open [Task](#/tasks/task-2?message=m-1) and @src/main.ts"
      actions={{ sessionId: "task-1" }}
    />);
    const links = [...mounted.host.querySelectorAll<HTMLAnchorElement>("a")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "#/tasks/task-2?message=m-1",
      "#/files/task-1?file=src%2Fmain.ts"
    ]);
    act(() => links[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 })));
    expect(window.location.hash).toBe("#/tasks/task-2?message=m-1");
  });

  it("keeps external sent URLs on the governed browser action", () => {
    const open = vi.fn();
    const mounted = mount(<SentMessageReferenceText text="https://example.test/docs" actions={{ sessionId: "task-1", onOpenHttpLink: open }} />);
    act(() => mounted.host.querySelector("a")?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 })));
    expect(open).toHaveBeenCalledWith("https://example.test/docs", { forceExternal: false });
  });

  it("loads a local markdown image through the authenticated workspace asset path and opens the full viewer", async () => {
    const mounted = mount(<TimelineMarkdownImage
      src="images/result.png"
      alt="Result"
      actions={{
        sessionId: "task-1",
        onLoadWorkspaceAsset: async (path) => ({ path, name: "result.png", url: "blob:result", mediaType: "image/png" })
      }}
      t={t}
    />);
    await act(async () => { await Promise.resolve(); });
    expect(mounted.host.querySelector<HTMLImageElement>('img[src="blob:result"]')?.alt).toBe("Result");
    act(() => mounted.host.querySelector("button")?.click());
    expect(document.querySelector(".workspace-image-lightbox")).not.toBeNull();
  });
});

function mount(node: ReactNode): { readonly host: HTMLDivElement; readonly root: Root } {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(node));
  return { host, root };
}

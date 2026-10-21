// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { RichAnswerMedia } from "./RichAnswerMedia.js";
import type { TimelineWorkspaceAsset } from "./TimelineReferenceContent.js";
import type { Translator } from "./types.js";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const t = ((key: string) => key) as Translator;

it("releases late and replaced Workspace media from the original owner", async () => {
  const host = document.createElement("div"); const root = createRoot(host);
  let resolve!: (asset: TimelineWorkspaceAsset) => void;
  const load = vi.fn(() => new Promise<TimelineWorkspaceAsset>(done => { resolve = done; }));
  const release = vi.fn();
  const node = { id: "picture", kind: "image" as const, props: { src: "one.png", alt: "Image" }, children: [] };
  try {
    await act(async () => root.render(<RichAnswerMedia node={node} actions={{ ownerKey: "node-a", sessionId: "task", t, onLoadWorkspaceAsset: load }} />));
    await act(async () => root.render(<RichAnswerMedia node={{ ...node, props: { src: "https://example.org/two.png" } }} actions={{ ownerKey: "node-b", sessionId: "task", t }} />));
    await act(async () => resolve({ path: "one.png", name: "one.png", url: "blob:old", mediaType: "image/png", release }));
    expect(release).toHaveBeenCalledOnce(); expect(host.querySelector("img")?.src).toBe("https://example.org/two.png");
    expect(host.textContent).not.toContain("blob:old");
  } finally { await act(async () => root.unmount()); }
});
it("loads only a known video site after a click and tears it down when the page leaves", async () => {
  const host = document.createElement("div"); const root = createRoot(host);
  try {
    await act(async () => root.render(<RichAnswerMedia node={{ id: "video", kind: "video", props: { src: "https://youtu.be/glW1pXWebnY?t=62" }, children: [] }} actions={{ ownerKey: "node", sessionId: "task", t }} />));
    expect(host.querySelector("iframe")).toBeNull();
    await act(async () => host.querySelector("button")!.click());
    expect(host.querySelector("iframe")?.src).toBe("https://www.youtube.com/embed/glW1pXWebnY?playsinline=1&autoplay=0&start=62");
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    expect(host.querySelector("iframe")).toBeNull();
  } finally { await act(async () => root.unmount()); }
});
it("opens owned SVG only as an image in the controlled lightbox and closes it when the page leaves", async () => {
  const host = document.body.appendChild(document.createElement("div")), root = createRoot(host), release = vi.fn();
  try {
    await act(async () => root.render(<RichAnswerMedia node={{ id: "svg", kind: "image", props: { src: "diagram.svg" }, children: [] }}
      actions={{ ownerKey: "node", sessionId: "task", t, onLoadWorkspaceAsset: async () => ({ path: "diagram.svg", name: "diagram.svg", url: "blob:owned-svg", mediaType: "image/svg+xml", release }) }} />));
    expect(host.querySelector("a")).toBeNull();
    await act(async () => host.querySelector("button")!.click());
    const preview = document.querySelector(".workspace-image-lightbox");
    expect(preview?.querySelector("img")?.getAttribute("src")).toBe("blob:owned-svg");
    expect(preview?.querySelector("a,iframe,object,embed")).toBeNull();
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    expect(document.querySelector(".workspace-image-lightbox")).toBeNull(); expect(release).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); host.remove(); }
});

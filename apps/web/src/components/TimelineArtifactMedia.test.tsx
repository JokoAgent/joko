// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ArtifactView, TimelineItemView } from "../model.js";
import { ArtifactBlock, MessageAttachment } from "./Timeline.js";
import { TimelineArtifactMedia, timelineArtifactMediaKind } from "./TimelineArtifactMedia.js";
import type { Translator } from "./types.js";

const roots: Root[] = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Timeline artifact media", () => {
  it("detects audio and video from normalized media types without relying on artifact kind", () => {
    expect(timelineArtifactMediaKind(" Audio/OGG; codecs=opus ")).toBe("audio");
    expect(timelineArtifactMediaKind("video/webm")).toBe("video");
    expect(timelineArtifactMediaKind("application/ogg")).toBeUndefined();
    expect(timelineArtifactMediaKind("video/invalid/type")).toBeUndefined();
  });

  it("mounts loading, controls, metadata-ready, and error states", async () => {
    const pending = deferred<string>();
    const rendered = await render((ownerKey) => <TimelineArtifactMedia
      artifact={artifact("audio", "audio/ogg")}
      playbackOwnerKey={ownerKey}
      loadUrl={() => pending.promise}
      t={t}
    />);

    expect(rendered.container.querySelector('[role="status"][aria-label="timeline.mediaLoading"]')).not.toBeNull();
    await act(async () => pending.resolve("blob:audio"));
    const audio = required(rendered.container.querySelector<HTMLAudioElement>("audio"));
    expect(audio.controls).toBe(true);
    expect(audio.preload).toBe("metadata");
    expect(audio.getAttribute("aria-label")).toBe("timeline.audioPlayer:clip.ogg");
    expect(rendered.container.querySelector('[role="status"][aria-label="timeline.mediaLoading"]')).not.toBeNull();

    await act(async () => audio.dispatchEvent(new Event("loadedmetadata", { bubbles: true })));
    expect(rendered.container.querySelector('[role="status"][aria-label="timeline.mediaLoading"]')).toBeNull();
    await act(async () => audio.dispatchEvent(new Event("error", { bubbles: true })));
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toBe("timeline.mediaUnavailable");
  });

  it("renders media and download actions in message attachments and standalone artifacts", async () => {
    const loadUrl = vi.fn(async (blobId: string) => `blob:${blobId}`);
    const download = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<>
      <MessageAttachment artifact={artifact("message-audio", "audio/mpeg")} t={t} onArtifactUrl={loadUrl} onArtifactDownload={download} />
      <ArtifactBlock item={artifactItem(artifact("standalone-video", "video/mp4"))} icon={<span />} locale="en" t={t} onArtifactUrl={loadUrl} onArtifactDownload={download} />
    </>));

    expect(container.querySelector(".message-attachment--media audio")).not.toBeNull();
    const video = required(container.querySelector<HTMLVideoElement>(".artifact-block__media video"));
    expect(video.controls).toBe(true);
    expect(video.playsInline).toBe(true);
    const downloadButtons = [...container.querySelectorAll<HTMLButtonElement>('button[aria-label^="timeline.downloadArtifact"]')];
    expect(downloadButtons).toHaveLength(2);
    await act(async () => downloadButtons[0]?.click());
    await act(async () => downloadButtons[1]?.click());
    expect(download).toHaveBeenNthCalledWith(1, "blob-message-audio", "clip.mp3");
    expect(download).toHaveBeenNthCalledWith(2, "blob-standalone-video", "clip.mp4");
  });

  it("stops playback when the task owner changes and again on unmount", async () => {
    const rendered = await render((ownerKey) => <TimelineArtifactMedia
      artifact={artifact("video", "video/mp4")}
      playbackOwnerKey={ownerKey}
      loadUrl={async () => "blob:video"}
      t={t}
    />);
    expect(rendered.container.querySelector("video")).not.toBeNull();

    await rendered.rerender("session-two");
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1);
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalledTimes(1);
    await act(async () => { await Promise.resolve(); });
    expect(rendered.container.querySelector("video")).not.toBeNull();
    await act(async () => rendered.root.unmount());
    roots.splice(roots.indexOf(rendered.root), 1);
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(2);
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalledTimes(2);
  });
});

async function render(view: (ownerKey: string) => React.ReactNode): Promise<{
  readonly container: HTMLDivElement;
  readonly root: Root;
  readonly rerender: (ownerKey: string) => Promise<void>;
}> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(view("session-one")));
  return {
    container,
    root,
    rerender: async (ownerKey) => act(async () => root.render(view(ownerKey)))
  };
}

function artifact(id: string, mediaType: string): ArtifactView {
  const extension = mediaType.startsWith("audio/") ? mediaType.endsWith("mpeg") ? "mp3" : "ogg" : "mp4";
  return {
    id,
    blobId: `blob-${id}`,
    title: `clip.${extension}`,
    kind: "file",
    fileName: `clip.${extension}`,
    mediaType,
    byteSize: 42
  };
}

function artifactItem(value: ArtifactView): TimelineItemView {
  return { id: "artifact-item", sequence: 1n, kind: "artifact", createdAt: 1, artifact: value };
}

const t: Translator = (key, values) => values?.["name"] === undefined ? String(key) : `${String(key)}:${String(values["name"])}`;

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected mounted media fixture value.");
  return value;
}

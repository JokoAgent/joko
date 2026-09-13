// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ArtifactView, TimelineItemView } from "../model.js";
import { ArtifactBlock, MessageAttachment } from "./Timeline.js";
import { TimelineArtifactMedia, timelineArtifactMediaKind } from "./TimelineArtifactMedia.js";
import { WorkspaceFileBody } from "./WorkspaceFileBody.js";
import type { AppController } from "../controller.js";
import type { Translator } from "./types.js";

const roots: Root[] = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async function (this: HTMLMediaElement) { this.dispatchEvent(new Event("play")); });
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
      <MessageAttachment artifact={{ ...artifact("message-audio", "audio/mpeg"), description: "Actual recorded sound" }} t={t} onArtifactUrl={loadUrl} onArtifactDownload={download} />
      <ArtifactBlock item={artifactItem(artifact("standalone-video", "video/mp4"))} icon={<span />} locale="en" t={t} onArtifactUrl={loadUrl} onArtifactDownload={download} />
    </>));

    expect(container.querySelector(".message-attachment--media audio")).not.toBeNull();
    expect(container.querySelector(".audio-preview__description")?.textContent).toBe("Actual recorded sound");
    const video = required(container.querySelector<HTMLVideoElement>(".artifact-block__media video"));
    expect(video.controls).toBe(false);
    expect(video.playsInline).toBe(true);
    const downloadButtons = [...container.querySelectorAll<HTMLButtonElement>('button[aria-label^="timeline.downloadArtifact"]')];
    expect(downloadButtons).toHaveLength(2);
    await act(async () => downloadButtons[0]?.click());
    await act(async () => downloadButtons[1]?.click());
    expect(download).toHaveBeenNthCalledWith(1, "blob-message-audio", "clip.mp3", { ownerDocument: document, signal: expect.any(AbortSignal) });
    expect(download).toHaveBeenNthCalledWith(2, "blob-standalone-video", "clip.mp4", { ownerDocument: document, signal: expect.any(AbortSignal) });
  });

  it("stops playback when the task owner changes and again on unmount", async () => {
    const rendered = await render((ownerKey) => <TimelineArtifactMedia
      artifact={artifact("video", "video/mp4")}
      playbackOwnerKey={ownerKey}
      loadUrl={async () => "blob:video"}
      t={t}
    />);
    await act(async () => rendered.container.querySelector<HTMLButtonElement>("button")!.click());
    const player = required(document.querySelector<HTMLVideoElement>('[role="dialog"] video'));

    await rendered.rerender("session-two");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(player.hasAttribute("src")).toBe(false);
    await act(async () => { await Promise.resolve(); });
    expect(rendered.container.querySelector("video")).not.toBeNull();
    await act(async () => rendered.root.unmount());
    roots.splice(roots.indexOf(rendered.root), 1);
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalled();
  });

  it("ignores a retired audio acquisition and exposes the current URL failure", async () => {
    const first = deferred<string>();
    const rendered = await render((ownerKey) => <TimelineArtifactMedia
      artifact={artifact("same-audio", "audio/mpeg")}
      playbackOwnerKey={ownerKey}
      loadUrl={() => ownerKey === "session-one" ? first.promise : Promise.reject(new Error("private URL failure"))}
      t={t}
    />);
    await rendered.rerender("session-two");
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toBe("timeline.mediaUnavailable");
    await act(async () => first.resolve("blob:retired-audio"));
    expect(rendered.container.querySelector("audio")).toBeNull();
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toBe("timeline.mediaUnavailable");
  });

  it("switches playback between timeline audio, video and workspace preview, and retires unmounted players", async () => {
    const controller = {
      state: { preferences: { locale: "en" } },
      getArtifactUrl: vi.fn(async (blobId: string) => `blob:${blobId}`),
      releaseArtifactUrl: vi.fn(),
      downloadArtifact: vi.fn()
    } as unknown as AppController;
    const rendered = await render((ownerKey) => <>
      <TimelineArtifactMedia artifact={artifact("audio", "audio/mpeg")} playbackOwnerKey="session-one" loadUrl={async () => "blob:audio"} t={t} />
      <TimelineArtifactMedia artifact={artifact("video", "video/mp4")} playbackOwnerKey="session-one" loadUrl={async () => "blob:video"} t={t} />
      <WorkspaceFileBody controller={controller} sessionId={ownerKey} workspaceId="workspace-one" path="preview.mp4" preview={{ kind: "blob", path: "preview.mp4", name: "preview.mp4", mediaType: "video/mp4", blobId: "workspace-video", byteSize: 12, truncated: false }} canWrite={false} />
      <WorkspaceFileBody controller={controller} sessionId={ownerKey} workspaceId="workspace-one" path="recording.wav" preview={{ kind: "blob", path: "recording.wav", name: "recording.wav", mediaType: "audio/wav", blobId: "workspace-audio", byteSize: 44, truncated: false }} canWrite={false} />
    </>);
    const audio = required(rendered.container.querySelector("audio"));
    const pauseAudio = vi.fn();
    Object.defineProperty(audio, "pause", { value: pauseAudio });
    await act(async () => audio.dispatchEvent(new Event("play")));
    await act(async () => rendered.container.querySelector<HTMLButtonElement>(".timeline-artifact-media--video button")!.click());
    const video = required(document.querySelector<HTMLVideoElement>('[role="dialog"] video'));
    const pauseVideo = vi.fn();
    Object.defineProperty(video, "pause", { value: pauseVideo });
    expect(pauseAudio).toHaveBeenCalledTimes(1);
    expect(pauseVideo).not.toHaveBeenCalled();
    await act(async () => audio.dispatchEvent(new Event("play")));
    expect(pauseVideo).toHaveBeenCalledTimes(1);
    await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] button')!.click());
    await act(async () => rendered.container.querySelector<HTMLButtonElement>(".workspace-file-body .video-preview__open")!.click());
    const workspaceVideo = required(document.querySelector<HTMLVideoElement>('[role="dialog"] video'));
    const pauseWorkspace = vi.fn();
    Object.defineProperty(workspaceVideo, "pause", { value: pauseWorkspace });
    expect(pauseAudio).toHaveBeenCalledTimes(2);
    await act(async () => audio.dispatchEvent(new Event("play")));
    expect(pauseWorkspace).toHaveBeenCalledTimes(1);
    const workspaceAudio = required(rendered.container.querySelector<HTMLAudioElement>('[data-file-kind="audio"] audio'));
    const pauseWorkspaceAudio = vi.fn();
    Object.defineProperty(workspaceAudio, "pause", { value: pauseWorkspaceAudio });
    await act(async () => workspaceAudio.dispatchEvent(new Event("play")));
    expect(pauseAudio).toHaveBeenCalledTimes(3);
    await act(async () => audio.dispatchEvent(new Event("play")));
    expect(pauseWorkspaceAudio).toHaveBeenCalledTimes(1);
    await rendered.rerender("session-two");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(workspaceVideo.hasAttribute("src")).toBe(false);
    expect(controller.releaseArtifactUrl).toHaveBeenCalledWith("workspace-video");
    expect(controller.releaseArtifactUrl).toHaveBeenCalledWith("workspace-audio");
    expect(workspaceAudio.hasAttribute("src")).toBe(false);
    expect(controller.getArtifactUrl).toHaveBeenCalledTimes(4);
    await act(async () => rendered.root.unmount());
    roots.splice(roots.indexOf(rendered.root), 1);
    expect(pauseAudio.mock.calls.length).toBeGreaterThan(1);
    const retiredPauseCount = pauseAudio.mock.calls.length;
    await act(async () => workspaceVideo.dispatchEvent(new Event("play")));
    expect(pauseAudio).toHaveBeenCalledTimes(retiredPauseCount);
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

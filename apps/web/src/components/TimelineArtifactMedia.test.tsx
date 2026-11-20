// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ArtifactView, TimelineItemView } from "../model.js";
import { ArtifactBlock, MessageAttachment } from "./Timeline.js";
import { TimelineArtifactMedia, timelineArtifactMediaKind } from "./TimelineArtifactMedia.js";
import { useTimelineArtifactUrlCache } from "./timeline-artifact-url-cache.js";
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
    expect(video.controls).toBe(true);
    expect(video.playsInline).toBe(true);
    expect(video.loop).toBe(false);
    expect(video.autoplay).toBe(false);
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

  it.each(["message", "artifact"] as const)("retries a failed URL in the mounted %s without duplicating its successful lease", async consumer => {
    const next = deferred<string>();
    const acquire = vi.fn<((blobId: string) => Promise<string>)>()
      .mockRejectedValueOnce(new Error("Temporary URL failure"))
      .mockImplementation(() => next.promise);
    const release = vi.fn();
    const rendered = await render(ownerKey => <CachedMedia ownerKey={ownerKey} acquire={acquire} release={release} consumer={consumer} />);
    const retry = required(rendered.container.querySelector<HTMLButtonElement>('[role="alert"] button'));
    expect(retry.textContent).toBe("common.retry");
    expect(acquire).toHaveBeenCalledOnce();
    await act(async () => { retry.click(); retry.click(); });
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(rendered.container.querySelector('[role="status"][aria-label="timeline.mediaLoading"]')).not.toBeNull();
    expect(rendered.container.querySelector("video")).toBeNull();
    await act(async () => next.resolve("blob:recovered"));
    const cover = required(rendered.container.querySelector<HTMLVideoElement>("video"));
    expect(cover.getAttribute("src")).toBe("blob:recovered");
    await act(async () => cover.dispatchEvent(new Event("loadedmetadata", { bubbles: true })));
    expect(rendered.container.querySelector('[role="alert"]')).toBeNull();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    await act(async () => rendered.root.unmount());
    roots.splice(roots.indexOf(rendered.root), 1);
    expect(release).toHaveBeenCalledExactlyOnceWith("blob-recovery-video");
  });

  it.each(["cover", "player"] as const)("recreates a failed %s from the owned URL and retires its old media elements", async stage => {
    const retiredPlayback = deferred<void>();
    const acquire = vi.fn(async () => "blob:same-owned-video");
    const release = vi.fn();
    const rendered = await render(ownerKey => <CachedMedia ownerKey={ownerKey} acquire={acquire} release={release} />);
    const originalCover = required(rendered.container.querySelector<HTMLVideoElement>("video"));
    let failed = originalCover;
    if (stage === "player") {
      vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(() => retiredPlayback.promise);
      await act(async () => rendered.container.querySelector<HTMLButtonElement>(".video-preview__open")!.click());
      failed = required(document.querySelector<HTMLVideoElement>('[role="dialog"] video'));
    }
    await act(async () => failed.dispatchEvent(new Event("error", { bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.classList.contains("modal-open")).toBe(false);
    expect(failed.hasAttribute("src")).toBe(false);
    await act(async () => rendered.container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
    const recovered = required(rendered.container.querySelector<HTMLVideoElement>("video"));
    expect(recovered).not.toBe(originalCover);
    expect(recovered.getAttribute("src")).toBe("blob:same-owned-video");
    expect(acquire).toHaveBeenCalledOnce();
    await act(async () => {
      if (stage === "player") retiredPlayback.reject(new Error("Late playback failure"));
      originalCover.dispatchEvent(new Event("error", { bubbles: true }));
      recovered.dispatchEvent(new Event("loadedmetadata", { bubbles: true }));
    });
    expect(rendered.container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => rendered.container.querySelector<HTMLButtonElement>(".video-preview__open")!.click());
    expect(document.querySelector<HTMLVideoElement>('[role="dialog"] video')?.controls).toBe(true);
    await act(async () => rendered.root.unmount());
    roots.splice(roots.indexOf(rendered.root), 1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(release).toHaveBeenCalledExactlyOnceWith("blob-recovery-video");
  });

  it.each(["online", "focus"] as const)("recovers on %s once and ignores availability events while loading or healthy", async event => {
    const next = deferred<string>();
    const loadUrl = vi.fn<((blobId: string) => Promise<string>)>()
      .mockRejectedValueOnce(new Error("Temporary URL failure"))
      .mockImplementation(() => next.promise);
    const rendered = await render(ownerKey => <TimelineArtifactMedia artifact={artifact("video", "video/mp4")} playbackOwnerKey={ownerKey} loadUrl={loadUrl} t={t} />);
    expect(rendered.container.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new Event(event));
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
    });
    expect(loadUrl).toHaveBeenCalledTimes(2);
    await act(async () => window.dispatchEvent(new Event(event)));
    expect(loadUrl).toHaveBeenCalledTimes(2);
    await act(async () => next.resolve("blob:available-again"));
    expect(rendered.container.querySelector("video")?.getAttribute("src")).toBe("blob:available-again");
    await act(async () => window.dispatchEvent(new Event(event)));
    expect(loadUrl).toHaveBeenCalledTimes(2);
  });

  it.each(["owner", "blob"] as const)("ignores a pending retry after its %s changes and releases the retired lease", async change => {
    const retired = deferred<string>();
    const current = deferred<string>();
    const acquire = vi.fn<((blobId: string) => Promise<string>)>()
      .mockRejectedValueOnce(new Error("Temporary URL failure"))
      .mockImplementationOnce(() => retired.promise)
      .mockImplementation(() => current.promise);
    const release = vi.fn();
    const rendered = await render(ownerKey => <CachedMedia ownerKey={change === "owner" ? ownerKey : "session-one"} acquire={acquire} release={release}
      value={artifact(change === "blob" ? ownerKey : "same", "video/mp4")} />);
    await act(async () => rendered.container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
    await rendered.rerender("session-two");
    await act(async () => current.resolve("blob:current-owner"));
    const cover = required(rendered.container.querySelector("video"));
    await act(async () => retired.resolve("blob:retired-owner"));
    expect(rendered.container.querySelector("video")).toBe(cover);
    expect(cover.getAttribute("src")).toBe("blob:current-owner");
    expect(acquire).toHaveBeenCalledTimes(3);
    expect(release).toHaveBeenCalledTimes(change === "owner" ? 1 : 0);
    await act(async () => rendered.root.unmount());
    roots.splice(roots.indexOf(rendered.root), 1);
    expect(release).toHaveBeenCalledTimes(2);
    await act(async () => { window.dispatchEvent(new Event("online")); window.dispatchEvent(new Event("focus")); });
    expect(acquire).toHaveBeenCalledTimes(3);
  });

  it("uses only the hosting window's availability events and retires its failed subscription on unmount", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const ownerDocument = required(frame.contentDocument);
    const ownerWindow = required(ownerDocument.defaultView);
    const loadUrl = vi.fn(async () => { throw new Error("Temporarily unavailable"); });
    const rendered = await render(ownerKey => <TimelineArtifactMedia artifact={artifact("video", "video/mp4")}
      playbackOwnerKey={ownerKey} loadUrl={loadUrl} t={t} />, ownerDocument);
    expect(loadUrl).toHaveBeenCalledOnce();
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(loadUrl).toHaveBeenCalledOnce();
    // Use the owner realm's event object, as a detached window does in production.
    const focus = ownerDocument.createEvent("Event");
    focus.initEvent("focus", false, false);
    await act(async () => ownerWindow.dispatchEvent(focus));
    expect(loadUrl).toHaveBeenCalledTimes(2);
    await act(async () => rendered.root.unmount());
    roots.splice(roots.indexOf(rendered.root), 1);
    await act(async () => ownerWindow.dispatchEvent(focus));
    expect(loadUrl).toHaveBeenCalledTimes(2);
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

function CachedMedia({ ownerKey, acquire, release, consumer = "preview", value = artifact("recovery-video", "video/mp4") }: {
  readonly ownerKey: string;
  readonly acquire: (blobId: string) => Promise<string>;
  readonly release: (blobId: string) => void;
  readonly consumer?: "preview" | "message" | "artifact";
  readonly value?: ArtifactView;
}): React.ReactNode {
  const loadUrl = useTimelineArtifactUrlCache(ownerKey, acquire, release);
  if (consumer === "message") return <MessageAttachment artifact={value} t={t} onArtifactUrl={loadUrl} onArtifactDownload={async () => "dispatched"} />;
  if (consumer === "artifact") return <ArtifactBlock item={artifactItem(value)} icon={<span />} locale="en" t={t} onArtifactUrl={loadUrl} onArtifactDownload={async () => "dispatched"} />;
  return <TimelineArtifactMedia artifact={value} playbackOwnerKey={ownerKey} loadUrl={loadUrl} t={t} />;
}

async function render(view: (ownerKey: string) => React.ReactNode, ownerDocument: Document = document): Promise<{
  readonly container: HTMLDivElement;
  readonly root: Root;
  readonly rerender: (ownerKey: string) => Promise<void>;
}> {
  const container = ownerDocument.createElement("div");
  ownerDocument.body.append(container);
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
    sourceRevealAvailable: false,
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

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void; readonly reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((next, fail) => { resolve = next; reject = fail; });
  return { promise, resolve, reject };
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected mounted media fixture value.");
  return value;
}

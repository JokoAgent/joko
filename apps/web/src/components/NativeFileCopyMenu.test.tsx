// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { OperationApi } from "../model.js";
import { NativeFileActionsContext, NativeFileActionsMenu } from "./NativeFileCopyMenu.js";
import { TimelineArtifactMedia } from "./TimelineArtifactMedia.js";
import type { Translator } from "./types.js";

const t = ((key: string) => key) as Translator;
let root: Root | undefined;
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { if (root !== undefined) await act(async () => root!.unmount()); root = undefined; Reflect.deleteProperty(window, "jokoDesktop"); document.body.replaceChildren(); document.body.className = ""; vi.restoreAllMocks(); });
const capability = (...capabilities: JokoDesktopCapability[]) => installDesktop({ capabilities });
const installDesktop = (desktop: Pick<JokoDesktopApi, "capabilities"> & Partial<JokoDesktopApi>) =>
  Object.defineProperty(window, "jokoDesktop", { configurable: true, value: desktop });
const deferred = () => { let resolve!: (value: JokoDesktopCopyFileResult) => void; const promise = new Promise<JokoDesktopCopyFileResult>((accept) => { resolve = accept; }); return { promise, resolve }; };
const deferredValue = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((accept) => { resolve = accept; }); return { promise, resolve }; };

it("keeps pending synchronous, presents errors for explicit retry, and fences source ABA, pagehide and connection replacement", async () => {
  capability("files.copy"); const first = deferred(); const second = deferred();
  const copy = vi.fn<OperationApi["copyArtifactFile"]>().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise).mockResolvedValue({ status: "copied" });
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  const render = async (ownerKey: string, action = copy) => act(async () => root!.render(<NativeFileActionsMenu actions={{ copyFile: action }} artifactId="artifact" blobId="blob" name="video.mp4" byteSize={2} sourceRevealAvailable={false} ownerKey={ownerKey} t={t} />));
  const button = () => node.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
  await render("a");
  await act(async () => { button().click(); button().click(); });
  expect(copy).toHaveBeenCalledOnce(); expect(button().disabled).toBe(true);
  expect(document.activeElement).toBe(node.querySelector("summary"));
  await render("b"); await render("a");
  expect(copy.mock.calls[0]![3].signal.aborted).toBe(true);
  await act(async () => button().click());
  await act(async () => first.resolve({ status: "unknown" }));
  expect(node.querySelector('[role="alert"]')).toBeNull(); expect(button().disabled).toBe(true);
  await act(async () => second.resolve({ status: "failed", reason: "capacity" }));
  expect(node.querySelector('[role="alert"]')?.textContent).toBe("media.fileCopyCapacity"); expect(button().disabled).toBe(false);
  await act(async () => { window.dispatchEvent(new Event("pagehide")); button().click(); });
  expect(copy).toHaveBeenCalledTimes(2);
  await act(async () => window.dispatchEvent(new Event("pageshow")));
  const replacement = vi.fn<OperationApi["copyArtifactFile"]>().mockResolvedValueOnce({ status: "blocked" }).mockResolvedValue({ status: "copied" });
  await render("a", replacement);
  await act(async () => button().click());
  expect(replacement).toHaveBeenCalledOnce(); expect(node.querySelector('[role="alert"]')?.textContent).toBe("media.fileCopyBlocked");
  await act(async () => button().click());
  expect(replacement).toHaveBeenCalledTimes(2); expect(node.querySelector('[role="status"]')?.textContent).toBe("media.fileCopied");
});

it("exposes the same authorized video action in the player and after decode failure, with nested Escape preserving playback", async () => {
  capability("files.copy"); vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined); vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined); vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  const copy = vi.fn<OperationApi["copyArtifactFile"]>().mockResolvedValue({ status: "unknown" });
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  await act(async () => root!.render(<NativeFileActionsContext.Provider value={{ copyFile: copy }}><TimelineArtifactMedia artifact={{ id: "clip", blobId: "clip-blob", sourceRevealAvailable: false, title: "Clip", kind: "file", fileName: "clip.mp4", mediaType: "video/mp4", byteSize: 2 }} playbackOwnerKey="profile:task" loadUrl={async () => "blob:clip"} t={t} /></NativeFileActionsContext.Provider>));
  await act(async () => node.querySelector<HTMLButtonElement>(".video-preview__open")!.click());
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  const menu = dialog.querySelector<HTMLDetailsElement>("details")!;
  await act(async () => { menu.open = true; menu.querySelector("button")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(menu.open).toBe(false); expect(document.querySelector('[role="dialog"]')).toBe(dialog);
  await act(async () => menu.querySelector("button")!.click());
  expect(copy.mock.calls[0]?.slice(0, 3)).toEqual(["clip-blob", "clip.mp4", 2]);
  expect(dialog.querySelector('[role="alert"]')?.textContent).toBe("media.fileCopyUnknown");
  await act(async () => dialog.querySelector("video")!.dispatchEvent(new Event("error")));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(node.querySelector('[role="menuitem"]')).not.toBeNull();
});

it("opens the exact video artifact through the same mounted menu and keeps unknown distinct from retry", async () => {
  capability("files.open");
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  const open = vi.fn<OperationApi["openArtifactFile"]>().mockResolvedValueOnce({ status: "unknown" }).mockResolvedValue({ status: "opened" });
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  await act(async () => root!.render(<NativeFileActionsContext.Provider value={{ openFile: open }}><TimelineArtifactMedia artifact={{ id: "clip", blobId: "clip-blob", sourceRevealAvailable: false, title: "Clip", kind: "file", fileName: "clip.mp4", mediaType: "video/mp4", byteSize: 2 }} playbackOwnerKey="profile:task" loadUrl={async () => "blob:clip"} t={t} /></NativeFileActionsContext.Provider>));
  await act(async () => node.querySelector<HTMLButtonElement>(".video-preview__open")!.click());
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  const action = dialog.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
  expect(action.textContent).toBe("media.openFile");
  await act(async () => action.click());
  expect(open.mock.calls[0]?.slice(0, 3)).toEqual(["clip-blob", "clip.mp4", 2]);
  expect(dialog.querySelector('[role="alert"]')?.textContent).toBe("media.fileOpenUnknown");
  await act(async () => action.click());
  expect(open).toHaveBeenCalledTimes(2);
  expect(dialog.querySelector('[role="status"]')?.textContent).toBe("media.fileOpened");
});

it("reveals only an advertised canonical source and keeps the source task identity", async () => {
  capability("files.revealSource");
  const reveal = vi.fn<OperationApi["revealArtifactSource"]>()
    .mockResolvedValueOnce({ status: "unavailable" })
    .mockResolvedValue({ status: "revealed" });
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  await act(async () => root!.render(<NativeFileActionsMenu
    actions={{ revealSource: reveal }}
    artifactId="artifact-one"
    blobId="bytes-one"
    name="render.png"
    byteSize={2}
    sourceSessionId="source-task"
    sourceRevealAvailable
    ownerKey="view-one"
    t={t}
  />));
  const action = node.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
  expect(action.textContent).toBe("media.revealSource");
  await act(async () => action.click());
  expect(reveal.mock.calls[0]?.slice(0, 2)).toEqual(["source-task", "artifact-one"]);
  expect(node.querySelector('[role="alert"]')?.textContent).toBe("media.sourceUnavailable");
  await act(async () => action.click());
  expect(node.querySelector('[role="status"]')?.textContent).toBe("media.sourceRevealed");
  await act(async () => root!.render(<NativeFileActionsMenu actions={{ revealSource: reveal }} artifactId="artifact-one" blobId="bytes-one" name="render.png" byteSize={2} sourceSessionId="source-task" sourceRevealAvailable={false} ownerKey="view-one" t={t} />));
  expect(node.querySelector("button")).toBeNull();
});

it("omits the action when the host does not advertise file clipboard support", async () => {
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  await act(async () => root!.render(<NativeFileActionsMenu actions={{ copyFile: vi.fn() }} artifactId="artifact" blobId="blob" name="clip.mp4" byteSize={2} sourceRevealAvailable={false} ownerKey="task" t={t} />));
  expect(node.querySelector("button")).toBeNull();
});

it("lazily lists Windows applications, keeps the default first, and retires an adopted list after a specific open failure", async () => {
  const listing = deferredValue<JokoDesktopListOpenWithAppsResult>();
  const listOpenWithApps = vi.fn<NonNullable<Window["jokoDesktop"]>["listOpenWithApps"]>(() => listing.promise);
  const retireOpenWithApps = vi.fn<NonNullable<Window["jokoDesktop"]>["retireOpenWithApps"]>(async () => undefined);
  installDesktop({
    capabilities: ["files.open", "files.openWith"],
    listOpenWithApps,
    retireOpenWithApps,
    openFileWithApp: vi.fn(),
    cancelFileOpen: vi.fn(async () => undefined)
  });
  const open = vi.fn<OperationApi["openArtifactFile"]>().mockResolvedValue({ status: "opened" });
  const chosen = deferredValue<JokoDesktopOpenFileResult>();
  const openWith = vi.fn<OperationApi["openArtifactFileWithApplication"]>(() => chosen.promise);
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  await act(async () => root!.render(<NativeFileActionsMenu actions={{ openFile: open, openFileWithApplication: openWith }} artifactId="artifact" blobId="blob" name="report.txt" byteSize={2} sourceRevealAvailable={false} ownerKey="task" t={t} />));
  expect(listOpenWithApps).not.toHaveBeenCalled();
  const menu = node.querySelector<HTMLDetailsElement>(".message-action-menu")!;
  const submenu = node.querySelector<HTMLDetailsElement>(".native-file-actions__open-with")!;
  await act(async () => {
    menu.open = true;
    submenu.open = true;
    submenu.dispatchEvent(new Event("toggle"));
  });
  expect(listOpenWithApps).toHaveBeenCalledOnce();
  const listOccurrence = listOpenWithApps.mock.calls[0]![0].listOccurrence;
  expect(listOpenWithApps.mock.calls[0]![0]).toEqual({ listOccurrence, name: "report.txt" });
  await act(async () => listing.resolve({
    status: "listed",
    listOccurrence,
    apps: [
      { appId: "11111111-1111-4111-8111-111111111111", label: "Editor", iconDataUrl: "data:image/png;base64,AA==" },
      { appId: "22222222-2222-4222-8222-222222222222", label: "Viewer" }
    ]
  }));
  const applicationButtons = [...submenu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')];
  expect(applicationButtons.map((button) => button.textContent)).toEqual(["media.openFile", "Editor", "Viewer"]);
  expect(applicationButtons[1]!.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AA==");
  await act(async () => applicationButtons[1]!.click());
  expect(menu.open).toBe(false);
  expect(openWith).toHaveBeenCalledOnce();
  expect(openWith.mock.calls[0]?.slice(0, 3)).toEqual(["blob", "report.txt", 2]);
  expect(openWith.mock.calls[0]?.[3]).toMatchObject({ listOccurrence });
  expect(openWith.mock.calls[0]?.[4]).toMatchObject({ label: "Editor" });
  expect(retireOpenWithApps).not.toHaveBeenCalled();
  await act(async () => chosen.resolve({ status: "failed", reason: "open" }));
  expect(retireOpenWithApps).toHaveBeenCalledExactlyOnceWith(listOccurrence);
  expect(node.querySelector('[role="alert"]')?.textContent).toBe("media.fileOpenFailed");
});

it("soft-falls back to the default item and invalidates late lists on close, a new list, pagehide, and unmount", async () => {
  const first = deferredValue<JokoDesktopListOpenWithAppsResult>();
  const second = deferredValue<JokoDesktopListOpenWithAppsResult>();
  const third = deferredValue<JokoDesktopListOpenWithAppsResult>();
  const listOpenWithApps = vi.fn<NonNullable<Window["jokoDesktop"]>["listOpenWithApps"]>()
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise)
    .mockImplementationOnce(() => third.promise);
  const retireOpenWithApps = vi.fn<NonNullable<Window["jokoDesktop"]>["retireOpenWithApps"]>(async () => undefined);
  installDesktop({
    capabilities: ["files.open", "files.openWith"],
    listOpenWithApps,
    retireOpenWithApps,
    openFileWithApp: vi.fn(),
    cancelFileOpen: vi.fn(async () => undefined)
  });
  const open = vi.fn<OperationApi["openArtifactFile"]>().mockResolvedValue({ status: "opened" });
  const openWith = vi.fn<OperationApi["openArtifactFileWithApplication"]>().mockResolvedValue({ status: "opened" });
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  await act(async () => root!.render(<NativeFileActionsMenu actions={{ openFile: open, openFileWithApplication: openWith }} artifactId="artifact" blobId="blob" name="report.txt" byteSize={2} sourceRevealAvailable={false} ownerKey="task" t={t} />));
  const menu = node.querySelector<HTMLDetailsElement>(".message-action-menu")!;
  const submenu = node.querySelector<HTMLDetailsElement>(".native-file-actions__open-with")!;
  const expand = async () => act(async () => {
    menu.open = true;
    submenu.open = true;
    submenu.dispatchEvent(new Event("toggle"));
  });
  await expand();
  const firstOccurrence = listOpenWithApps.mock.calls[0]![0].listOccurrence;
  await act(async () => {
    menu.open = false;
    menu.dispatchEvent(new Event("toggle"));
  });
  expect(retireOpenWithApps).toHaveBeenCalledWith(firstOccurrence);
  await act(async () => first.resolve({ status: "listed", listOccurrence: firstOccurrence, apps: [{ appId: "11111111-1111-4111-8111-111111111111", label: "Late" }] }));
  expect(node.textContent).not.toContain("Late");

  submenu.open = false;
  await expand();
  const secondOccurrence = listOpenWithApps.mock.calls[1]![0].listOccurrence;
  expect(secondOccurrence).not.toBe(firstOccurrence);
  await act(async () => second.resolve({ status: "failed" }));
  expect([...submenu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')].map((button) => button.textContent)).toEqual(["media.openFile"]);
  expect(node.querySelector('[role="alert"]')).toBeNull();
  await act(async () => {
    menu.open = false;
    menu.dispatchEvent(new Event("toggle"));
  });

  submenu.open = false;
  await expand();
  const thirdOccurrence = listOpenWithApps.mock.calls[2]![0].listOccurrence;
  await act(async () => third.resolve({ status: "listed", listOccurrence: thirdOccurrence, apps: [{ appId: "33333333-3333-4333-8333-333333333333", label: "Current" }] }));
  await act(async () => window.dispatchEvent(new Event("pagehide")));
  expect(retireOpenWithApps).toHaveBeenCalledWith(thirdOccurrence);
  await act(async () => window.dispatchEvent(new Event("pageshow")));
  await act(async () => root!.unmount()); root = undefined;
  expect(retireOpenWithApps.mock.calls.filter(([occurrence]) => occurrence === thirdOccurrence)).toHaveLength(1);
});

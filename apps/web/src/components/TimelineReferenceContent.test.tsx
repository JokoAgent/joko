// @vitest-environment jsdom

import { act, StrictMode } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SentMessageReferenceText, TimelineMarkdownImage, TimelineMarkdownLink } from "./TimelineReferenceContent.js";
import type { TimelineWorkspaceAsset } from "./TimelineReferenceContent.js";
import { SessionPane } from "./SessionPane.js";
import type { AppController, ControllerState } from "../controller.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { emptySnapshot, type ArtifactView, type SessionView, type TimelineItemView, type WorkspaceFilePreviewView } from "../model.js";
import type { Translator } from "./types.js";
import { WorkspaceHtmlExternalUnavailableError } from "../browser-action.js";

vi.mock("./Composer.js", () => ({ Composer: () => null }));
vi.mock("./Timeline.js", async () => {
  const { TimelineMarkdownImage } = await import("./TimelineReferenceContent.js");
  return { Timeline: (props: {
    readonly ownerKey: string;
    readonly sessionId: string;
    readonly items: readonly TimelineItemView[];
    readonly onLoadWorkspaceAsset?: (path: string) => Promise<TimelineWorkspaceAsset>;
    readonly t: Translator;
  }) => <TimelineMarkdownImage src={props.items[0]?.text} actions={{ ownerKey: props.ownerKey, sessionId: props.sessionId, t: props.t, onLoadWorkspaceAsset: props.onLoadWorkspaceAsset }} t={props.t} /> };
});

const roots: Root[] = [];
const t: Translator = (key) => key;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.location.hash = "";
});

afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("timeline reference content", () => {
  it("opens HTML through workspace authority and retains per-click destination overrides", async () => {
    const open = vi.fn();
    const mounted = mount(<SentMessageReferenceText text="[Preview](preview.html)" actions={{ ownerKey: "profile", sessionId: "task", t, onOpenWorkspaceHtml: open }} />);
    const link = mounted.host.querySelector<HTMLAnchorElement>("a")!;
    await act(async () => link.click());
    expect(open).toHaveBeenLastCalledWith("preview.html", { forceExternal: false, action: { ownerDocument: document, signal: expect.any(AbortSignal) } });
    expect(window.location.hash).toBe("");
    act(() => link.dispatchEvent(new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true, cancelable: true })));
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    await act(async () => buttons.find((button) => button.textContent === "timeline.openInSidebarBrowser")!.click());
    expect(open).toHaveBeenLastCalledWith("preview.html", { forceSidebar: true, action: { ownerDocument: document, signal: expect.any(AbortSignal) } });
    open.mockRejectedValueOnce(new WorkspaceHtmlExternalUnavailableError());
    act(() => link.dispatchEvent(new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true, cancelable: true })));
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent === "timeline.openInManagedBrowser")!.click());
    expect(document.querySelector('[role="status"]')?.textContent).toBe("timeline.htmlExternalUnavailable");
  });
  it("keeps single-message links distinct from typed task and file atoms", () => {
    const text = "Open [Message](#/tasks/task-2?message=m-1), @Prior task and @src/main.ts";
    const taskStart = text.indexOf("@Prior task");
    const fileStart = text.indexOf("@src/main.ts");
    const mounted = mount(<SentMessageReferenceText
      text={text}
      inputMentions={[
        { kind: "session", sessionId: "task-3", displayText: "Prior task" },
        { kind: "workspace", workspaceId: "w", relativePath: "src/main.ts", displayText: "main.ts", directory: false }
      ]}
      mentionRanges={[
        { start: taskStart, end: taskStart + "@Prior task".length, mentionIndex: 0 },
        { start: fileStart, end: fileStart + "@src/main.ts".length, mentionIndex: 1 }
      ]}
      actions={{ ownerKey: "profile", sessionId: "task-1", workspaceId: "w", t }}
    />);
    const links = [...mounted.host.querySelectorAll<HTMLAnchorElement>("a")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "#/tasks/task-2?message=m-1",
      "#/tasks/task-3",
      "#/files/task-1?file=src%2Fmain.ts"
    ]);
    expect(links[1]?.textContent).toBe("@Prior task");
    expect(links[2]?.textContent).toBe("@src/main.ts");
    act(() => links[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 })));
    expect(window.location.hash).toBe("#/tasks/task-3");
  });

  it("keeps external sent URLs on the governed browser action", async () => {
    const open = vi.fn();
    const mounted = mount(<SentMessageReferenceText text="https://example.test/docs" actions={{ ownerKey: "profile", sessionId: "task-1", t, onOpenHttpLink: open }} />);
    await act(async () => mounted.host.querySelector("a")?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 })));
    expect(open).toHaveBeenCalledWith("https://example.test/docs", { forceExternal: false, action: { ownerDocument: document, signal: expect.any(AbortSignal) } });
    act(() => mounted.host.querySelector("a")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    expect([...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map((button) => button.textContent)).toContain("timeline.openInDefaultBrowser");
    expect([...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map((button) => button.textContent)).not.toContain("timeline.openInManagedBrowser");
  });

  it("loads a local markdown image through the authenticated workspace asset path and opens the full viewer", async () => {
    const mounted = mount(<TimelineMarkdownImage
      src="images/result.png"
      alt="Result"
      actions={{
        ownerKey: "profile",
        sessionId: "task-1",
        t,
        onLoadWorkspaceAsset: async (path) => ({ path, name: "result.png", url: "blob:result", mediaType: "image/png", release: () => undefined })
      }}
      t={t}
    />);
    await act(async () => { await Promise.resolve(); });
    expect(mounted.host.querySelector<HTMLImageElement>('img[src="blob:result"]')?.alt).toBe("Result");
    act(() => mounted.host.querySelector("button")?.click());
    expect(document.querySelector(".workspace-image-lightbox")).not.toBeNull();
  });

  it("reads the exact Artifact and retires pending or open previews when the source owner changes", async () => {
    const artifact: ArtifactView = { id: "artifact-two", blobId: "content-two", kind: "file", title: "report.txt", fileName: "report.txt", mediaType: "text/plain", byteSize: 3 };
    let resolve!: (value: typeof artifact) => void;
    const read = vi.fn((_sessionId: string, _artifactId: string, _signal: AbortSignal) => new Promise<typeof artifact>((done) => { resolve = done; }));
    const preview = vi.fn((value: typeof artifact) => <span role="dialog">{value.blobId}</span>);
    const node = (ownerKey: string) => <SentMessageReferenceText text="@report.txt @report.txt @report.txt"
      inputMentions={[
        { kind: "workspace", workspaceId: "w", relativePath: "report.txt", displayText: "report.txt", directory: false },
        { kind: "artifact", sourceSessionId: "source-task", artifactId: artifact.id, displayText: "report.txt" }
      ]} mentionRanges={[{ start: 0, end: 11, mentionIndex: 1 }, { start: 12, end: 23, mentionIndex: 0 }]}
      actions={{ ownerKey, sessionId: "task", workspaceId: "w", t, onReadArtifact: read, renderArtifactPreview: preview }} />;
    const mounted = mount(node("first"));
    expect(mounted.host.querySelectorAll("a")).toHaveLength(1);
    expect(mounted.host.querySelector("a")?.getAttribute("href")).toBe("#/files/task?file=report.txt");
    expect(mounted.host.textContent).toBe("@report.txt @report.txt @report.txt");
    const button = () => mounted.host.querySelector<HTMLButtonElement>("button")!;
    await act(async () => { button().click(); button().click(); });
    expect(read).toHaveBeenCalledExactlyOnceWith("source-task", artifact.id, expect.any(AbortSignal));
    expect(preview).not.toHaveBeenCalled();
    const oldSignal = read.mock.calls[0]![2];
    act(() => mounted.root.render(node("second")));
    expect(oldSignal.aborted).toBe(true);
    await act(async () => resolve(artifact));
    expect(mounted.host.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => button().click());
    await act(async () => resolve(artifact));
    expect(mounted.host.querySelector('[role="dialog"]')?.textContent).toBe("content-two");
    act(() => mounted.root.render(node("third")));
    expect(mounted.host.querySelector('[role="dialog"]')).toBeNull();
    read.mockRejectedValueOnce(new Error("Unavailable"));
    await act(async () => button().click());
    expect(button().textContent).toContain("timeline.referenceUnavailable");
    expect(window.location.hash).toBe("");
  });

  it("copies a file's relative location with line and column from a keyboard menu", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const mounted = mount(<SentMessageReferenceText text="[Source](src/main.ts:18:4)" actions={{ ownerKey: "profile", sessionId: "task-1", t }} />);
    const link = mounted.host.querySelector<HTMLAnchorElement>("a")!;
    link.focus();
    act(() => link.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true })));
    const copy = document.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    expect(document.activeElement).toBe(copy);
    await act(async () => copy.click());
    expect(writeText).toHaveBeenCalledWith("src/main.ts:18:4");
    expect(document.querySelector('[role="status"]')?.textContent).toBe("workspace.pathCopied");
    act(() => copy.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(link);
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("owns HTTP and file menus in their source document and retires pending copies across source, owner and page changes", async () => {
    const frame = document.body.appendChild(document.createElement("iframe"));
    const doc = frame.contentDocument!;
    const view = frame.contentWindow!;
    const host = doc.body.appendChild(doc.createElement("div"));
    const root = createRoot(host); roots.push(root);
    const mainClipboard = vi.fn();
    const pending: (() => void)[] = [];
    const writeText = vi.fn(() => new Promise<void>((resolve) => pending.push(resolve)));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: mainClipboard } });
    Object.defineProperty(view.navigator, "clipboard", { configurable: true, value: { writeText } });
    const open = vi.fn(async () => undefined);
    const render = (href = "https://example.test/docs", ownerKey = "profile", sourceKey = "message") => act(() => root.render(
      <TimelineMarkdownLink href={href} actions={{ ownerKey, sessionId: "task-1", sourceKey, t, onOpenHttpLink: open }}>Source</TimelineMarkdownLink>
    ));
    const link = () => host.querySelector<HTMLAnchorElement>("a")!;
    const key = (value: string, composing = false) => act(() => doc.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, isComposing: composing })));
    const menu = () => doc.querySelector('[role="menu"]');
    const show = () => { link().focus(); key("ContextMenu"); };
    const copy = () => act(() => {
      const button = doc.querySelector<HTMLButtonElement>('[role="menuitem"]:last-of-type')!;
      button.click(); button.click();
    });
    render(); show();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(menu()).not.toBeNull();
    key("Escape", true); expect(menu()).not.toBeNull();
    key("End"); expect(doc.activeElement?.textContent).toBe("timeline.copyUrl");
    key("ArrowDown"); expect(doc.activeElement?.textContent).toBe("timeline.openInSidebarBrowser");
    key("Tab"); expect(menu()).toBeNull(); expect(doc.activeElement).toBe(link());
    show(); copy();
    expect(writeText).toHaveBeenCalledExactlyOnceWith("https://example.test/docs");
    expect(doc.querySelector('[role="status"]')?.textContent).toBe("timeline.linkCopying");
    render("https://example.test/docs", "profile", "edited");
    render();
    expect(menu()).toBeNull();
    await act(async () => pending.shift()!());
    expect(doc.querySelector('[role="status"]')).toBeNull();
    render("src/main.ts:18:4"); show(); copy();
    expect(writeText).toHaveBeenLastCalledWith("src/main.ts:18:4");
    render("src/main.ts:18:4", "second");
    await act(async () => pending.shift()!());
    expect(menu()).toBeNull();
    show(); copy();
    act(() => view.dispatchEvent(new Event("pagehide")));
    await act(async () => pending.shift()!());
    expect(doc.querySelector('[role="status"]')).toBeNull();
    act(() => view.dispatchEvent(new Event("pageshow")));
    show();
    const outside = doc.body.appendChild(doc.createElement("button"));
    act(() => outside.focus()); expect(menu()).toBeNull(); expect(doc.activeElement).toBe(outside);
    act(() => link().click());
    expect(view.location.hash).toBe("#/files/task-1?file=src%2Fmain.ts&line=18");
    expect(window.location.hash).toBe("");
    expect(mainClipboard).not.toHaveBeenCalled();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("shows link opening failures and suppresses duplicate and retired opens without changing the destination", async () => {
    let finish!: (error: Error) => void;
    const open = vi.fn(() => new Promise<void>((_resolve, reject) => { finish = reject; }));
    const node = (ownerKey: string) => <SentMessageReferenceText text="https://example.test/docs" actions={{ ownerKey, sessionId: "task-1", t, onOpenHttpLink: open }} />;
    const mounted = mount(node("first"));
    const show = () => act(() => mounted.host.querySelector("a")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    show();
    act(() => {
      const button = document.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
      button.click(); button.click();
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]).toEqual(["https://example.test/docs", { forceSidebar: true, action: { ownerDocument: document, signal: expect.any(AbortSignal) } }]);
    expect(document.querySelector('[role="status"]')?.textContent).toBe("timeline.linkOpening");
    await act(async () => finish(new Error("Unavailable")));
    expect(document.querySelector('[role="status"]')?.textContent).toBe("timeline.linkOpenFailed");
    act(() => document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[1]!.click());
    const action = (open.mock.calls.at(-1) as unknown as [string, { action: { signal: AbortSignal } }])[1].action;
    expect(open).toHaveBeenCalledTimes(2);
    act(() => mounted.root.render(node("second")));
    expect(action.signal.aborted).toBe(true);
    await act(async () => finish(new Error("Late failure")));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.querySelector('[role="status"]')).toBeNull();
  });

  it("releases workspace image leases with their original owner when a profile changes during loading", async () => {
    const releaseFirst = vi.fn();
    const releaseSecond = vi.fn();
    let finishFirst!: (asset: import("./TimelineReferenceContent.js").TimelineWorkspaceAsset) => void;
    const pending = new Promise<import("./TimelineReferenceContent.js").TimelineWorkspaceAsset>((resolve) => { finishFirst = resolve; });
    const render = (ownerKey: string, load: () => Promise<import("./TimelineReferenceContent.js").TimelineWorkspaceAsset>) => <TimelineMarkdownImage src="image.png" actions={{ ownerKey, sessionId: "same-task", t, onLoadWorkspaceAsset: load }} t={t} />;
    const { root } = mount(render("first", () => pending));
    await act(async () => root.render(render("second", async () => ({ path: "image.png", name: "image.png", url: "blob:second", release: releaseSecond }))));
    await act(async () => finishFirst({ path: "image.png", name: "image.png", url: "blob:first", release: releaseFirst }));
    expect(releaseFirst).toHaveBeenCalledTimes(1);
    expect(releaseSecond).not.toHaveBeenCalled();
    expect(document.querySelector("img")?.getAttribute("src")).toBe("blob:second");
    act(() => root.render(null));
    expect(releaseSecond).toHaveBeenCalledTimes(1);
  });

  it("previews complete workspace SVG text through the task owner and revokes each URL once across StrictMode and owner changes", async () => {
    const created: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => { created.push(blob); return `blob:svg-${created.length}`; });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", class extends URL { static override createObjectURL = createObjectURL; static override revokeObjectURL = revokeObjectURL; });
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';
    const preview: WorkspaceFilePreviewView = { path: "diagram.svg", name: "diagram.svg", kind: "text", text: svg, mediaType: "image/svg+xml; charset=utf-8", truncated: false };
    const first = assetController(async () => preview);
    const mounted = await mountAssetPane(first.value, "diagram.svg", true);
    expect(first.read).toHaveBeenCalledWith("workspace", "diagram.svg");
    expect(first.acquire).not.toHaveBeenCalled();
    expect(mounted.host.querySelector("img")?.getAttribute("src")).toBe("blob:svg-2");
    expect(created).toHaveLength(2);
    expect(created[0]?.type).toBe("image/svg+xml");
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(created[0]!);
    });
    expect(text).toBe(svg);
    expect(revokeObjectURL.mock.calls).toEqual([["blob:svg-1"]]);
    await mounted.render({ ...first.value, state: { ...first.value.state } });
    expect(createObjectURL).toHaveBeenCalledTimes(2);

    for (const invalid of [
      { ...preview, mediaType: "text/plain" },
      { ...preview, truncated: true },
      { ...preview, path: "other.svg" },
      { ...preview, path: "notes.txt", name: "notes.txt" }
    ]) {
      const rejected = assetController(async () => invalid);
      await mounted.render(rejected.value, invalid.path === "notes.txt" ? "notes.txt" : "diagram.svg");
      expect(mounted.host.querySelector("img")).toBeNull();
      expect(mounted.host.textContent).toContain("workspace.imageUnavailable");
      expect(rejected.acquire).not.toHaveBeenCalled();
    }
    await mounted.unmount();
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL.mock.calls).toEqual([["blob:svg-1"], ["blob:svg-2"]]);
    expect(first.release).not.toHaveBeenCalled();
  });

  it.each(["read", "acquire"] as const)("retires the real task image loader at its pending %s boundary without borrowing the new gateway", async (phase) => {
    let finishRead!: (preview: WorkspaceFilePreviewView) => void;
    let finishUrl!: (url: string) => void;
    const read = new Promise<WorkspaceFilePreviewView>((resolve) => { finishRead = resolve; });
    const url = new Promise<string>((resolve) => { finishUrl = resolve; });
    const preview: WorkspaceFilePreviewView = { path: "image.png", name: "image.png", kind: "image", blobId: "same-blob", mediaType: "image/png", truncated: false };
    const first = assetController(async () => phase === "read" ? read : preview, () => url);
    const second = assetController(async () => preview, async () => "blob:new-owner");
    const mounted = await mountAssetPane(first.value, "image.png");
    expect(first.read).toHaveBeenCalledTimes(1);
    expect(first.acquire).toHaveBeenCalledTimes(phase === "read" ? 0 : 1);
    await mounted.render(second.value);
    expect(mounted.host.querySelector("img")?.getAttribute("src")).toBe("blob:new-owner");
    await act(async () => { finishRead(preview); finishUrl("blob:old-owner"); });
    expect(first.acquire).toHaveBeenCalledTimes(phase === "read" ? 0 : 1);
    expect(first.release).toHaveBeenCalledTimes(phase === "read" ? 0 : 1);
    expect(second.acquire).toHaveBeenCalledExactlyOnceWith("same-blob");
    expect(second.release).not.toHaveBeenCalled();
    expect(mounted.host.querySelector("img")?.getAttribute("src")).toBe("blob:new-owner");
    await mounted.unmount();
    expect(second.release).toHaveBeenCalledExactlyOnceWith("same-blob");
  });

  it("reports clipboard failure without navigating or exposing an absolute path", async () => {
    const writeText = vi.fn(async () => { throw new Error("unavailable"); });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const mounted = mount(<SentMessageReferenceText text="[Source](src/main.ts#L18)" actions={{ ownerKey: "profile", sessionId: "task-1", t }} />);
    act(() => mounted.host.querySelector("a")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    await act(async () => document.querySelector<HTMLButtonElement>('[role="menuitem"]')?.click());
    expect(writeText).toHaveBeenCalledWith("src/main.ts:18");
    expect(document.querySelector('[role="status"]')?.textContent).toBe("timeline.linkCopyFailed");
    expect(window.location.hash).toBe("");
    Reflect.deleteProperty(navigator, "clipboard");
  });
});

function mount(node: ReactNode): { readonly host: HTMLDivElement; readonly root: Root } {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(node));
  return { host, root };
}

function assetController(read: AppController["readWorkspaceFile"], acquire: AppController["getArtifactUrl"] = async () => "blob:image") {
  const readWorkspaceFile = vi.fn(read);
  const getArtifactUrl = vi.fn(acquire);
  const releaseArtifactUrl = vi.fn<(blobId: string) => void>();
  const state: ControllerState = {
    ready: true, connectionState: "connected", profiles: [], machineCaches: [], machinePresenceByProfile: {},
    discoveredNodes: [], discoveryState: "idle", managedOrchestratorStatus: undefined, automaticConnectionAvailable: false,
    snapshot: emptySnapshot(), route: { kind: "session", sessionId: "session" }, preferences: DEFAULT_UI_PREFERENCES, extensionNotifications: []
  };
  return { read: readWorkspaceFile, acquire: getArtifactUrl, release: releaseArtifactUrl, value: { state, readWorkspaceFile, getArtifactUrl, releaseArtifactUrl } as unknown as AppController };
}

async function mountAssetPane(initial: AppController, initialPath: string, strict = false) {
  const mounted = mount(null);
  const render = async (controller: AppController, path = initialPath) => act(async () => {
    const session: SessionView = { id: "session", backendId: "backend", targetId: "target", name: "Task", state: "idle", pinned: false, archived: false, generation: 1n, fastMode: false, permissionMode: "ask", planMode: false, updatedAt: 1000 };
    const pane = <SessionPane
      controller={controller} session={session}
      backend={{ id: "backend", name: "Backend", version: "1", health: "healthy", capabilities: new Map([["workspace.files", { name: "workspace.files", supported: true, options: [] }]]) }}
      workspace={{ id: "workspace", targetId: "target", name: "Workspace", kind: "userProject", serverPath: "/workspace", trusted: true, dirty: false, entries: [] }}
      models={[]} timeline={[{ id: "image-message", kind: "assistant", sequence: 1n, text: path, createdAt: 1000 }]}
      timelineHasEarlier={false} timelineHistoryLoading={false} onLoadEarlierTimeline={async () => undefined}
      extensionWidgets={[]} extensionStatuses={[]} queue={[]} extraDirectories={[]} resources={[]} commandRefreshSignal={[]}
      remainingInteractions={0} navigationOpen inspectorOpen t={t} runAction={(_key, action) => { void action(); }}
      onOpenNavigation={() => undefined} onOpenInspector={() => undefined} onRename={() => undefined} onArchive={() => undefined} onDelete={() => undefined}
    />;
    mounted.root.render(strict ? <StrictMode>{pane}</StrictMode> : pane);
  });
  await render(initial);
  return { host: mounted.host, render, unmount: async () => {
    await act(async () => mounted.root.unmount());
    roots.splice(roots.indexOf(mounted.root), 1);
  } };
}

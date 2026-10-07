// @vitest-environment jsdom
import { createElement, act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { FileKind, FileRevisionSchema, WorkspaceDescriptorSchema, WorkspaceEntrySchema } from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileFilesBrowser } from "./MobileFilesBrowser";
import { mobileMessage } from "./mobile-messages";
import { emptyMobileFilesState } from "./workspace-files";

const native = vi.hoisted(() => ({ width: 320, layout: undefined as ((event: { nativeEvent: { layout: { width: number } } }) => void) | undefined }));
vi.mock("./MobileFileThumbnail", () => ({ MobileFileThumbnail: ({ children }: { children: ReactNode }) => createElement("span", {}, children) }));
vi.mock("react-native", async () => {
  const React = await import("react");
  const element = (tag: string) => ({ accessibilityLabel, accessibilityRole, accessibilityState, children, onPress, onLongPress, onLayout, disabled, style,
    numberOfLines: _lines, accessibilityElementsHidden: _hidden, importantForAccessibility: _importance, accessibilityLiveRegion: _live, accessibilityViewIsModal: _modal }: any) => {
    if (onLayout) native.layout = onLayout;
    const flattened = Object.assign({}, ...[style].flat(Infinity).filter(Boolean));
    return React.createElement(tag, { "aria-label": accessibilityLabel, role: accessibilityRole, disabled,
      "aria-checked": accessibilityState?.checked, "aria-disabled": accessibilityState?.disabled, "aria-selected": accessibilityState?.selected,
      "data-min-height": flattened.minHeight ?? flattened.height, onClick: onPress, onContextMenu: onLongPress ? (event: Event) => { event.preventDefault(); onLongPress(); } : undefined }, children);
  };
  return { View: element("div"), Text: element("span"), Pressable: element("button"), ScrollView: element("div"),
    Modal: ({ visible, children }: { visible: boolean; children: ReactNode }) => visible ? React.createElement("div", { role: "dialog" }, children) : null,
    FlatList: ({ data, numColumns, renderItem, keyExtractor, ListEmptyComponent }: any) => React.createElement("div", { "data-columns": numColumns },
      ...data.map((item: any) => React.createElement(React.Fragment, { key: keyExtractor(item) }, renderItem({ item }))), data.length ? null : ListEmptyComponent),
    useWindowDimensions: () => ({ width: native.width, height: 800 }), StyleSheet: { create: (value: unknown) => value, absoluteFill: { position: "absolute" } } };
});

let root: Root | undefined; let container: HTMLDivElement;
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; document.body.innerHTML = ""; native.width = 320; native.layout = undefined; });
function fixture() {
  const entries = [create(WorkspaceEntrySchema, { workspaceId: "workspace", relativePath: "src/images/picture10.png", displayName: "picture10.png", mediaType: "image/png", kind: FileKind.REGULAR,
    revision: create(FileRevisionSchema, { opaqueRevision: "ten", byteSize: 200n }) }),
    create(WorkspaceEntrySchema, { workspaceId: "workspace", relativePath: "src/images/picture2.png", displayName: "picture2.png", mediaType: "image/png", kind: FileKind.REGULAR,
      revision: create(FileRevisionSchema, { opaqueRevision: "two", byteSize: 10n }) }),
    create(WorkspaceEntrySchema, { workspaceId: "workspace", relativePath: "src/images/docs", displayName: "docs", kind: FileKind.DIRECTORY })];
  return { ...emptyMobileFilesState(), open: true, status: "ready" as const, authorityKey: "owner", entries, directoryRevision: "directory",
    workspace: create(WorkspaceDescriptorSchema, { workspaceId: "workspace", displayName: "project" }), location: { kind: "workspace" as const, path: "src/images" } };
}
type Props = Parameters<typeof MobileFilesBrowser>[0];
function render(overrides: Partial<Props> = {}): Props {
  if (!root) { container = document.createElement("div"); document.body.append(container); root = createRoot(container); }
  const props: Props = { files: fixture(), preferences: { view: "grid", sort: "name" }, locale: "en", colors: {
    surface: "#fff", ink: "#111", muted: "#666", border: "#ccc", accent: "#fa0", brandBackground: "#fff0dd" }, disabled: false, preferencesDisabled: false,
  onPreferences: vi.fn(), onOpen: vi.fn(), onAdd: vi.fn(), onShare: vi.fn(), onDirectory: vi.fn(), onCopy: vi.fn(), onCopyDirectory: vi.fn(),
  canShare: (source) => source.kind === "workspace-entry" && source.entry.kind === FileKind.REGULAR, ...overrides };
  act(() => root!.render(createElement(MobileFilesBrowser, props))); return props;
}
function button(label: string): HTMLButtonElement { const selector = `button[aria-label=${JSON.stringify(label)}]`; const value = container.querySelector('[role="dialog"]')?.querySelector(selector) ?? container.querySelector(selector); if (!value) throw new Error(`Missing button: ${label}`); return value as HTMLButtonElement; }
function click(label: string): void { act(() => button(label).click()); }

describe("mounted native Files browse controls", () => {
  it("opens current item menus by long press or an accessible button, dispatches scoped actions and retires a replaced source", () => {
    let props = render(); const source = { kind: "workspace-entry", entry: props.files.entries[0] };
    act(() => button("Open image gallery for picture10.png").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("picture10.png");
    click("Copy relative path"); expect(props.onCopy).toHaveBeenCalledWith(source); expect(container.querySelector('[role="dialog"]')).toBeNull();
    click("File options for picture10.png"); click("Open image gallery for picture10.png"); expect(props.onOpen).toHaveBeenCalledWith(source);
    click("File options for picture10.png"); click("Add file picture10.png to composer"); expect(props.onAdd).toHaveBeenCalledWith(source);
    click("File options for picture10.png"); click("Share file picture10.png"); expect(props.onShare).toHaveBeenCalledWith(source);
    click("File options for docs"); expect(container.querySelector('[role="dialog"]')?.textContent).not.toContain("Share file");
    click("Copy relative path"); click("Folder options for images"); click("Copy relative path"); expect(props.onCopyDirectory).toHaveBeenCalledOnce();
    click("File options for picture10.png"); props = render({ ...props, files: { ...props.files, entries: [props.files.entries[1]!, props.files.entries[2]!] } });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    props = render({ ...props, preferences: { view: "list", sort: "name" } }); click("File options for picture2.png");
    props = render({ ...props, files: { ...props.files, status: "loading" } }); expect(container.querySelector('[role="dialog"]')).toBeNull();
    props = render({ ...props, files: { ...props.files, status: "ready" } }); click("File options for picture2.png");
    render({ ...props, files: { ...props.files, authorityKey: "new-owner" } }); expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
  it("renders adaptive grid and list, uses local ordering and dispatches the exact observed open/add/share source", () => {
    let props = render(); expect(container.querySelector("[data-columns]")?.getAttribute("data-columns")).toBe("2");
    expect(container.textContent).toContain("1 folder · 2 files");
    const openLabels = () => Array.from(container.querySelectorAll('button[aria-label^="Open image gallery"]')).map((item) => item.getAttribute("aria-label"));
    expect(openLabels()).toEqual(["Open image gallery for picture2.png", "Open image gallery for picture10.png"]);
    click("Open image gallery for picture10.png"); expect(props.onOpen).toHaveBeenCalledWith({ kind: "workspace-entry", entry: props.files.entries[0] });
    click("Add file picture10.png to composer"); expect(props.onAdd).toHaveBeenCalledWith({ kind: "workspace-entry", entry: props.files.entries[0] });
    click("Share file picture10.png"); expect(props.onShare).toHaveBeenCalledWith({ kind: "workspace-entry", entry: props.files.entries[0] });
    expect(button("Share file docs").disabled).toBe(true);
    for (const label of ["Open image gallery for picture10.png", "Add file picture10.png to composer", "Share file picture10.png"]) expect(Number(button(label).dataset.minHeight)).toBeGreaterThanOrEqual(44);
    act(() => native.layout?.({ nativeEvent: { layout: { width: 1100 } } })); expect(container.querySelector("[data-columns]")?.getAttribute("data-columns")).toBe("6");
    click("Folder options for images"); click("List"); expect(props.onPreferences).toHaveBeenCalledWith({ view: "list", sort: "name" });
    props = render({ ...props, preferences: { view: "list", sort: "size" } }); expect(container.querySelector("[data-columns]")?.getAttribute("data-columns")).toBe("1");
    expect(openLabels()).toEqual(["Open image gallery for picture10.png", "Open image gallery for picture2.png"]);
    click("Folder options for images"); expect(button("Open directory images").disabled).toBe(true); click("Open directory src"); expect(props.onDirectory).toHaveBeenCalledWith("src");
  });
  it("keeps options localized in five languages, handles Generated empty state and forbids actions on disabled sources", () => {
    const props = render({ disabled: true, preferencesDisabled: true });
    click("Open image gallery for picture10.png"); click("Add file picture10.png to composer"); click("Share file picture10.png");
    expect(props.onOpen).not.toHaveBeenCalled(); expect(props.onAdd).not.toHaveBeenCalled(); expect(props.onShare).not.toHaveBeenCalled();
    click("Folder options for images"); expect(button("List").disabled).toBe(true); expect(button("Open directory src").disabled).toBe(true);
    for (const locale of ["en", "zh-CN", "zh-TW", "ja", "ko"] as const) {
      render({ ...props, locale }); expect(container.textContent).toContain(mobileMessage(locale, "files.presentation.options"));
      expect(button(mobileMessage(locale, "files.presentation.grid")).getAttribute("aria-checked")).toBe("true");
      expect(container.querySelector('[role="radiogroup"]')?.getAttribute("aria-label")).toBe(mobileMessage(locale, "files.presentation.view"));
    }
    render({ files: { ...fixture(), authorityKey: "generated-owner", location: { kind: "generated" }, artifacts: [] } });
    expect(container.textContent).toContain("No canonical Generated files are available for this task."); expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});

// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { ExtensionDirectoryPickerEntrySchema, ExtensionDirectoryPickerPageSchema, type ExtensionDirectoryPickerPage } from "@joko/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { MobileExtensionDirectoryPicker, type MobileExtensionDirectoryRequest } from "./MobileExtensionDirectoryPicker";
import type { MobileExtensionDirectoryPickerViewProps } from "./MobileExtensionDirectoryPickerView";

const native = vi.hoisted(() => ({ state: "active", listeners: new Set<(state: string) => void>(), view: undefined as MobileExtensionDirectoryPickerViewProps | undefined }));
vi.mock("react-native", () => ({ AppState: { get currentState() { return native.state; }, addEventListener: (_type: string, listener: (state: string) => void) => {
  native.listeners.add(listener); return { remove: () => native.listeners.delete(listener) };
} } }));
vi.mock("./MobileExtensionDirectoryPickerView", () => ({ MobileExtensionDirectoryPickerView: (props: MobileExtensionDirectoryPickerViewProps) => { native.view = props; return null; } }));
let root: Root | undefined, host: HTMLDivElement | undefined;
afterEach(async () => { if (root) await act(() => root!.unmount()); host?.remove(); root = undefined; native.state = "active"; native.listeners.clear(); native.view = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });
function page(): ExtensionDirectoryPickerPage {
  return create(ExtensionDirectoryPickerPageSchema, { picker: { pickerId: "original-picker", extensionId: `extension_${"a".repeat(32)}`,
    expiresAt: { seconds: BigInt(Math.floor(Date.now() / 1000) + 120) } },
    directory: { entryId: "root", name: "Work", displayPath: "D:\\Work" }, entries: [{ entryId: "child", name: "Project", displayPath: "D:\\Work\\Project" }] });
}
async function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const abort = new AbortController(), initialPage = page(), finish = vi.fn(), browse = vi.fn<MobileExtensionDirectoryRequest["choice"]["browse"]>(async () => initialPage);
  let owned = true;
  const request: MobileExtensionDirectoryRequest = { id: "original-document:directory:1", signal: abort.signal, current: () => owned, finish,
    choice: { name: "Mail", title: "Select an import folder", initialPage, browse } };
  host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  await act(() => root!.render(createElement(MobileExtensionDirectoryPicker, { request, locale: "en",
    colors: { background: "#fff", surface: "#fff", ink: "#111", muted: "#777", border: "#ddd", accent: "#f90", negative: "#b00", brandBackground: "#ffe" } })));
  return { request, abort, finish, browse, initialPage, retire: () => { owned = false; } };
}

it("browses opaque entries, pages one directory and opens an explicitly entered node path before returning only its chosen entry", async () => {
  const active = await mount();
  const child = create(ExtensionDirectoryPickerPageSchema, { ...active.initialPage,
    directory: create(ExtensionDirectoryPickerEntrySchema, { entryId: "child", parentEntryId: "root", name: "Project", displayPath: "D:\\Work\\Project" }),
    entries: [create(ExtensionDirectoryPickerEntrySchema, { entryId: "one", name: "One", displayPath: "D:\\Work\\Project\\One" })], nextPageToken: "page-two" });
  active.browse.mockResolvedValueOnce(child).mockResolvedValueOnce(create(ExtensionDirectoryPickerPageSchema, { ...child,
    entries: [create(ExtensionDirectoryPickerEntrySchema, { entryId: "two", name: "Two", displayPath: "D:\\Work\\Project\\Two" })], nextPageToken: "" }));
  await act(() => native.view!.onBrowse("child")); expect(active.browse).toHaveBeenLastCalledWith({ entryId: "child" });
  expect(native.view!.directory?.parentEntryId).toBe("root"); await act(() => native.view!.onMore());
  expect(active.browse).toHaveBeenLastCalledWith({ entryId: "child", pageToken: "page-two" });
  expect(native.view!.entries.map(entry => entry.entryId)).toEqual(["one", "two"]);
  active.browse.mockResolvedValueOnce(create(ExtensionDirectoryPickerPageSchema, { ...active.initialPage,
    directory: create(ExtensionDirectoryPickerEntrySchema, { entryId: "other-disk", name: "Imports", displayPath: "E:\\Imports" }), entries: [] }));
  await act(() => native.view!.onPath("E:\\Imports")); await act(() => native.view!.onGo());
  expect(active.browse).toHaveBeenLastCalledWith({ directoryPath: "E:\\Imports" });
  await act(() => { native.view!.onChoose(); native.view!.onChoose(); });
  expect(active.finish).toHaveBeenCalledExactlyOnceWith("other-disk");
});

it.each(["background", "abort", "expiry"])("cancels its original choice after %s and discards a late directory response", async reason => {
  if (reason === "expiry") vi.useFakeTimers();
  const active = await mount(); let finish!: (page: ExtensionDirectoryPickerPage) => void;
  active.browse.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(() => native.view!.onBrowse("child"));
  if (reason === "background") await act(() => { native.state = "background"; native.listeners.forEach(listener => listener("background")); native.state = "active"; });
  else if (reason === "abort") await act(() => active.abort.abort());
  else await act(() => vi.advanceTimersByTimeAsync(120_001));
  await act(() => finish(create(ExtensionDirectoryPickerPageSchema, { ...active.initialPage,
    directory: create(ExtensionDirectoryPickerEntrySchema, { entryId: "late", name: "Late", displayPath: "D:\\Late" }) })));
  await act(() => native.view!.onChoose());
  expect(active.finish).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(native.view!.directory?.entryId).not.toBe("late");
});

it("clears a failed or foreign listing, prevents an old-owner choice and retries the exact original read", async () => {
  const active = await mount();
  active.browse.mockResolvedValueOnce(create(ExtensionDirectoryPickerPageSchema, { ...active.initialPage,
    picker: { ...active.initialPage.picker!, pickerId: "other-picker" } }));
  await act(() => native.view!.onBrowse("child"));
  expect(native.view!.error).toBeTruthy(); expect(native.view!.canChoose).toBe(false); expect(native.view!.directory).toBeUndefined();
  active.browse.mockResolvedValueOnce(active.initialPage); await act(() => native.view!.onRetry());
  expect(active.browse).toHaveBeenLastCalledWith({ entryId: "child" });
  active.retire(); await act(() => native.view!.onChoose()); expect(active.finish).not.toHaveBeenCalled();
  await act(() => active.abort.abort()); expect(active.finish).toHaveBeenCalledExactlyOnceWith(undefined);
});

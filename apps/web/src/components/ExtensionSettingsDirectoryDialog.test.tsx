// @vitest-environment jsdom
import { create } from "@bufbuild/protobuf";
import { ExtensionDirectoryPickerPageSchema, type ExtensionSettingsDirectoryChoice } from "@joko/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { Translator } from "./types.js";
import { ExtensionSettingsDirectoryDialog } from "./ExtensionSettingsDirectoryDialog.js";

const roots: Root[] = [];
beforeAll(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.replaceChildren(); });
const page = (selected = false) => create(ExtensionDirectoryPickerPageSchema, {
  picker: { pickerId: "picker", extensionId: "installed", expiresAt: { seconds: BigInt(Math.floor(Date.now() / 1000) + 100), nanos: 0 } },
  ...(selected ? { directory: { entryId: "opaque-selected", name: "Reports", displayPath: "/node/private/reports" } } : {}),
  entries: selected ? [] : [{ entryId: "opaque-selected", name: "Reports", displayPath: "/node/private/reports" }]
});
async function mount(browse: ExtensionSettingsDirectoryChoice["browse"]) {
  const finish = vi.fn(), abort = new AbortController(), host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); roots.push(root);
  await act(async () => root.render(<ExtensionSettingsDirectoryDialog choice={{ name: "Plugin", initialPage: page(), browse }} signal={abort.signal}
    finish={finish} ownerDocument={document} t={((key: string) => key) as Translator} />));
  return { finish, abort };
}
const button = (text: string) => [...document.querySelectorAll("button")].find(value => value.textContent?.includes(text))!;

it("requires opening a real native directory before enabling the explicit selection button", async () => {
  const browse = vi.fn(async () => page(true)), f = await mount(browse);
  expect(button("extensions.directoryPicker.select").disabled).toBe(true);
  await act(async () => button("/node/private/reports").click());
  expect(browse).toHaveBeenCalledWith({ entryId: "opaque-selected" });
  expect(f.finish).not.toHaveBeenCalled();
  await act(async () => button("extensions.directoryPicker.select").click());
  expect(f.finish).toHaveBeenCalledWith("opaque-selected");
});

it("retires a pending browse when the original native owner aborts and rejects its late result", async () => {
  let answer!: (value: ReturnType<typeof page>) => void;
  const browse = vi.fn(() => new Promise<ReturnType<typeof page>>(resolve => { answer = resolve; })), f = await mount(browse);
  await act(async () => button("/node/private/reports").click());
  await act(async () => f.abort.abort());
  expect(f.finish).toHaveBeenCalledWith();
  await act(async () => answer(page(true)));
  expect(button("extensions.directoryPicker.select").disabled).toBe(true);
  expect(f.finish.mock.calls.every(call => call.length === 0)).toBe(true);
});

it("cannot confirm an older directory after the user's next directory navigation failed", async () => {
  const selected = page(true); selected.entries = [{ $typeName: "joko.v1.ExtensionDirectoryPickerEntry", entryId: "next-directory", name: "Next", displayPath: "/node/private/reports/next" }];
  const browse = vi.fn<ExtensionSettingsDirectoryChoice["browse"]>().mockResolvedValueOnce(selected).mockRejectedValueOnce(new Error("Directory retired"));
  const f = await mount(browse);
  await act(async () => button("/node/private/reports").click());
  expect(button("extensions.directoryPicker.select").disabled).toBe(false);
  await act(async () => button("Next").click());
  expect(button("extensions.directoryPicker.select").disabled).toBe(true);
  expect(document.querySelector('[role="alert"]')).not.toBeNull(); expect(f.finish).not.toHaveBeenCalled();
});

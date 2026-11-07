// @vitest-environment jsdom
import { act, createElement, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { ExtensionCardSchema, ExtensionCardServiceGetResponseSchema, ExtensionCardServicePreviewMailResponseSchema, extensionCardFormDeliveryScope, pendingExtensionCardFormDelivery } from "@joko/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MobileExtensionCardApi } from "./mobile-extension-card-api";

const native = vi.hoisted(() => ({ listeners: new Set<(state: string) => void>(), documents: new Map<string, Record<string, any>>(), state: "active" }));
vi.mock("react-native", () => {
  const surface = ({ children }: { children?: ReactNode }) => createElement("div", {}, children);
  return { View: surface, Text: ({ children, accessibilityRole }: { children?: ReactNode; accessibilityRole?: string }) => createElement("span", { role: accessibilityRole }, children),
    ScrollView: surface, ActivityIndicator: () => createElement("span", { role: "progressbar" }),
    Modal: ({ visible, children }: { visible: boolean; children?: ReactNode }) => visible ? surface({ children }) : null,
    Pressable: ({ children, onPress, disabled, accessibilityLabel }: { children?: ReactNode; onPress?(): void; disabled?: boolean; accessibilityLabel?: string }) => createElement("button", { onClick: onPress, disabled, "aria-label": accessibilityLabel }, children),
    TextInput: ({ value, accessibilityLabel, onChangeText, editable }: { value?: string; accessibilityLabel?: string; onChangeText?(value: string): void; editable?: boolean }) => createElement("input", { value, "aria-label": accessibilityLabel, disabled: editable === false, onChange: (event: { target: HTMLInputElement }) => onChangeText?.(event.target.value) }),
    StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }, Alert: { alert: vi.fn() }, Linking: { openURL: vi.fn(async () => {}) },
    AppState: { get currentState() { return native.state; }, addEventListener: (_name: string, listener: (state: string) => void) => { native.listeners.add(listener); return { remove: () => native.listeners.delete(listener) }; } } };
});
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: ({ children }: { children?: ReactNode }) => createElement("div", {}, children) }));
vi.mock("react-native-webview", () => ({ WebView: (props: Record<string, any>) => {
  const key = props.source.html; native.documents.set(key, props); return createElement("div", { "data-webview": key });
} }));
vi.mock("./MobileMediaPlayer", () => ({ MobileMediaPlayer: ({ uri }: { uri: string }) => createElement("div", { "data-audio": uri }) }));
import { MobileExtensionCard, MobileExtensionCardsProvider } from "./MobileExtensionCard";
import { MobileExtensionMailReaderProvider, useMobileMailLink } from "./MobileExtensionMailReader";

const colors = { background: "#fff", surface: "#fafafa", ink: "#111", muted: "#666", border: "#ccc", accent: "#ff9800", negative: "#b00", brandBackground: "#fff4df", dark: false };
const escape = (value: unknown) => JSON.stringify(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
const card = (subject = "Draft", extra = "") => create(ExtensionCardSchema, { cardId: "one", sessionId: "task", extensionName: "Calendar", html: `<div data-joko-form="${escape([{ name: "subject", label: "Subject", value: subject }])}" data-joko-change="save"></div><button data-joko-action="run">Run</button>${extra}`, height: 160 });
let root: Root, element: HTMLDivElement;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); native.state = "active"; element = document.body.appendChild(document.createElement("div")); root = createRoot(element); });
afterEach(async () => { await act(async () => root.unmount()); element.remove(); native.listeners.clear(); native.documents.clear(); });
function apiFixture(value = card()) {
  const owner = {}, api = { formScope: () => extensionCardFormDeliveryScope(owner, "task"), get: vi.fn(async () => create(ExtensionCardServiceGetResponseSchema, { card: value, interactive: true })),
    dispatch: vi.fn(async () => ({ accepted: true })), readMedia: vi.fn(async () => ({ dataUrl: "" })) };
  return api;
}
it("shows the computer callback requirement and never opens a loopback authorization from a phone", async () => {
  const value = card(), api = apiFixture(value);
  api.get.mockResolvedValue(create(ExtensionCardServiceGetResponseSchema, { card: value, interactive: true, hostAuthorization: true }));
  await render(api); expect(element.textContent).toContain("Open Joko Desktop");
  const current = poster(); await message(current.props, current.id, { type: "action", action: "host:connect-account" }); expect(api.dispatch).not.toHaveBeenCalled();
});
it("opens overlapping mail through the chosen native reader and retires its view on backgrounding", async () => {
  const url = "https://mail.example.test/messages/one";
  const previewMail = vi.fn(async (request: { read?: boolean; readerSelectionId?: string }) => create(ExtensionCardServicePreviewMailResponseSchema,
    request.readerSelectionId === "two" ? { supported: true, messageJson: JSON.stringify({ accountId: "one", messageId: "one", from: "Sender two",
      to: "Owner", cc: "", bcc: "", subject: "Second reader's message", date: "Today", bodyText: "Private fixture", bodyHtml: "", attachments: [] }) }
      : request.read ? { supported: true, error: "MAIL_PROVIDER_AMBIGUOUS", readerChoices: [
        { selectionId: "one", displayName: "First reader" }, { selectionId: "two", displayName: "Second reader" }
      ] } : { supported: true }));
  function Link() {
    const open = useMobileMailLink();
    return <button onClick={() => void open?.(url)}>Open mail link</button>;
  }
  const button = (label: string) => Array.from(element.querySelectorAll("button")).find(item => item.textContent === label)!;
  await act(async () => root.render(<MobileExtensionMailReaderProvider ownerKey="mail-owner" sessionId="task"
    bind={() => ({ previewMail }) as unknown as MobileExtensionCardApi} colors={colors} locale="en"><Link /></MobileExtensionMailReaderProvider>));
  await act(async () => button("Open mail link").click());
  expect(element.textContent).toContain("Choose a plugin to read this message");
  expect(previewMail.mock.calls.map(([request]) => request.readerSelectionId)).toEqual([undefined, undefined]);
  await act(async () => button("Second reader").click());
  expect(previewMail).toHaveBeenLastCalledWith({ sessionId: "task", url, read: true, opened: true, readerSelectionId: "two" }, expect.any(Object));
  expect(element.textContent).toContain("Second reader's message");
  await act(async () => { native.state = "background"; for (const listener of native.listeners) listener("background"); });
  expect(element.textContent).toBe("Open mail link");
  expect(previewMail).toHaveBeenCalledTimes(3);
});
async function render(api: ReturnType<typeof apiFixture>, ownerKey = "owner", value = card(), readOnly = false) {
  await act(async () => root.render(<StrictMode><MobileExtensionCardsProvider ownerKey={ownerKey} bind={() => api as unknown as MobileExtensionCardApi}>
    <MobileExtensionCard card={value} colors={colors} locale="en" enabled readOnly={readOnly} />
  </MobileExtensionCardsProvider></StrictMode>));
}
function poster() { const props = [...native.documents.values()].filter(props => props.injectedJavaScript?.includes("var id=" )).at(-1)!; return { props, id: Number(/var id=(\d+)/u.exec(props.injectedJavaScript)![1]) }; }
async function message(props: Record<string, any>, id: number, input: object) { await act(async () => props.onMessage({ nativeEvent: { data: JSON.stringify({ id, ...input }) } })); }
it("fences stale native documents and background actions while preserving the active task's form", async () => {
  const api = apiFixture(); await render(api); const old = poster();
  await message(old.props, old.id, { type: "action", action: "run" }); expect(api.dispatch).toHaveBeenCalledOnce();
  await act(async () => { native.state = "background"; for (const listener of native.listeners) listener("background"); });
  await message(old.props, old.id, { type: "action", action: "run" }); expect(api.dispatch).toHaveBeenCalledOnce(); expect(element.querySelector("[data-webview]")).toBeNull();
  await act(async () => { native.state = "active"; for (const listener of native.listeners) listener("active"); });
  const current = poster(); await message(current.props, current.id + 1, { type: "action", action: "run" }); expect(api.dispatch).toHaveBeenCalledOnce();
  const second = apiFixture(card("New task")); await render(second, "next-owner", card("New task"));
  await message(current.props, current.id, { type: "action", action: "run" }); expect(second.dispatch).not.toHaveBeenCalled(); expect(api.dispatch).toHaveBeenCalledOnce();
  expect(element.querySelector<HTMLInputElement>('input[aria-label="Subject"]')?.value).toBe("New task");
  expect(pendingExtensionCardFormDelivery(api.formScope())).toBeUndefined();
});
it("does not deliver late snapshots or grant shared history an action API", async () => {
  const api = apiFixture(); let finish!: (value: any) => void; api.get.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await render(api); const second = apiFixture(card("Current")); await render(second, "second", card("Current"));
  await act(async () => finish(create(ExtensionCardServiceGetResponseSchema, { card: card("Stale"), interactive: true })));
  expect(element.querySelector<HTMLInputElement>('input[aria-label="Subject"]')?.value).toBe("Current");
  const shared = apiFixture(); await render(shared, "shared", card(), true); expect(shared.get).not.toHaveBeenCalled(); expect(shared.dispatch).not.toHaveBeenCalled();
  expect(element.querySelector<HTMLInputElement>("input")?.disabled).toBe(true); expect(element.textContent).toContain("read-only");
});
it("releases an owned audio lease when its card leaves the foreground", async () => {
  const uri = `joko-media://blobs/${"a".repeat(64)}.wav`, value = card("Audio", `<div data-joko-audio="${uri}"></div>`), api = apiFixture(value), release = vi.fn(async () => {});
  Object.assign(api, { prepareAudio: vi.fn(async () => ({ uri: "file:///owned/audio.wav", instanceId: "audio-one", mediaType: "audio/wav", release })) });
  await render(api, "owner", value); const doc = poster(); await message(doc.props, doc.id, { type: "media", uri });
  expect(element.querySelector("[data-audio]")).not.toBeNull();
  await act(async () => { native.state = "background"; for (const listener of native.listeners) listener("background"); });
  expect(element.querySelector("[data-audio]")).toBeNull(); expect(release).toHaveBeenCalled();
});

// @vitest-environment jsdom
import { act, createElement, useSyncExternalStore, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MobileNewTaskDraftStore } from "./new-task-draft-store";
import { plainTextMobileComposerDraft } from "./mobile-composer-document";
import type { MobileClient } from "./mobile-client";
import type { MobileComposerRichInput } from "./MobileComposerRichInput";

let rich: ComponentProps<typeof MobileComposerRichInput>;
vi.mock("react-native", () => ({
  StyleSheet: { create: (value: unknown) => value }, AppState: { currentState: "active" },
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  ScrollView: ({ children, testID }: { children?: ReactNode; testID?: string }) => createElement("div", { "data-testid": testID }, children),
  Text: ({ children, testID }: { children?: ReactNode; testID?: string }) => createElement("span", { "data-testid": testID }, children),
  Pressable: ({ children, disabled, onPress }: { children?: ReactNode; disabled?: boolean; onPress?: () => void }) => createElement("button", { disabled, onClick: onPress }, children)
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "follow-up-ui" }));
vi.mock("expo-clipboard", () => ({ getStringAsync: async () => "Pasted follow-up" }));
vi.mock("./storage", () => ({ mobileAttachmentFiles: {}, mobileAttachmentCamera: {}, mobilePhotoLibrary: {} }));
vi.mock("./MobileComposerRichInput", () => ({ MobileComposerRichInput: (props: ComponentProps<typeof MobileComposerRichInput>) => {
  rich = props; return createElement("textarea", { "aria-label": props.accessibilityLabel, value: props.draft.text, readOnly: !props.editable, onChange: () => undefined });
} }));
import { MobilePendingNewTaskConversation } from "./MobilePendingNewTaskConversation";

let host: HTMLDivElement, root: Root;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.body.appendChild(document.createElement("div")); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT"); });

it("shows the frozen first message and persists additional input while the create request is still unresolved", async () => {
  const values = new Map<string, string>();
  const store = new MobileNewTaskDraftStore({ getItem: async key => values.get(key) ?? null,
    setItem: async (key, value) => { values.set(key, value); }, removeItem: async key => { values.delete(key); } });
  const identity = { profileId: "profile" };
  await store.beginSubmission(identity, { targetId: "project", name: "Working task", input: plainTextMobileComposerDraft("First message") }, {
    connectionId: "connection", serverId: "server", backendId: "backend", targetRevision: "1", createOperationId: "create-one", model: null });
  await store.openConversation(identity, "create-one");
  const client = { state: { activeProfileId: "profile", busy: true, status: "connected" }, newTaskAttachmentControls: () => undefined, reconcile: vi.fn() } as unknown as MobileClient;
  function Harness() {
    useSyncExternalStore(listener => store.subscribe(listener), () => store.revision(identity));
    return <MobilePendingNewTaskConversation client={client} store={store} identity={identity} draft={store.readSync(identity)!}
      locale="en" colors={{ background: "#fff", surface: "#fff", ink: "#111", muted: "#666", border: "#ccc", accent: "#f80", negative: "#c00", brandBackground: "#ffe" }} onBack={() => undefined} />;
  }
  await act(async () => root.render(<Harness />));
  expect(host.textContent).toContain("First message"); expect(rich.editable).toBe(true);
  act(() => rich.onEdit({ draft: plainTextMobileComposerDraft("Follow-up before creation"), selection: { start: 25, end: 25 } }, rich.draft));
  const send = Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Send")!;
  expect(send.disabled).toBe(false);
  await act(async () => { send.click(); await store.flush(identity); });
  expect(host.textContent).toContain("Follow-up before creation"); expect(rich.draft.text).toBe("");
  expect(store.readSync(identity)).toMatchObject({ submission: { phase: "creating", input: { text: "First message" } },
    conversation: { followUps: [{ operationId: "follow-up-ui", input: { text: "Follow-up before creation" }, state: "queued" }] } });
  expect([...values.values()].join("")).toContain("Follow-up before creation");
  await act(async () => rich.onPasteText({ draft: rich.draft, selection: { start: 0, end: 0 } }));
  expect(rich.draft.text).toBe("Pasted follow-up");
  await act(async () => store.sealConversation(identity, "create-one"));
  expect(rich.editable).toBe(false);
});

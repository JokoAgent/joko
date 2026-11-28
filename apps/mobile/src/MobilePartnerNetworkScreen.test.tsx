// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as contract from "@joko/contracts";
import type { MobilePartnerNetworkApi } from "./mobile-partner-network";
const native = vi.hoisted(() => ({ id: 0, openURL: vi.fn(async () => undefined) }));
vi.mock("expo-crypto", () => ({ randomUUID: () => `operation-${++native.id}` }));
vi.mock("./MobileImageLightbox", () => ({ MobileImageLightbox: () => null }));
vi.mock("./MobileMarkdownMessage", () => ({ MobileMarkdownMessage: ({ text }: { text: string }) => createElement("p", {}, text) }));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: ({ children }: { children?: ReactNode }) => createElement("div", {}, children) }));
vi.mock("react-native", async () => {
  const React = await import("react"); const box = ({ children }: { children?: ReactNode }) => createElement("div", {}, children);
  return { View: box, ScrollView: box, Text: ({ children, accessibilityRole }: { children?: ReactNode; accessibilityRole?: string }) => createElement("span", { role: accessibilityRole }, children),
    ActivityIndicator: () => createElement("span", {}, "Loading"), StyleSheet: { create: (styles: unknown) => styles }, Linking: { openURL: native.openURL }, Alert: { alert: () => undefined },
    Pressable: ({ children, accessibilityRole, accessibilityState, disabled, onPress }: { children?: ReactNode; accessibilityRole?: string; accessibilityState?: { checked?: boolean }; disabled?: boolean; onPress(): void }) => createElement("button", { role: accessibilityRole, "aria-checked": accessibilityState?.checked, disabled, onClick: onPress }, children),
    TextInput: ({ value, onChangeText, onSelectionChange, editable, accessibilityLabel }: { value: string; onChangeText(value: string): void;
      onSelectionChange?(event: { nativeEvent: { selection: { start: number; end: number } } }): void; editable?: boolean; accessibilityLabel?: string }) =>
      createElement("input", { value, disabled: editable === false, "aria-label": accessibilityLabel, onChange: () => {},
        onMouseUp: (event: { currentTarget: HTMLInputElement }) => onSelectionChange?.({ nativeEvent: {
          selection: { start: event.currentTarget.selectionStart!, end: event.currentTarget.selectionEnd! } } }),
        onInput: (event: { currentTarget: { value: string } }) => onChangeText(event.currentTarget.value) }),
    Modal: ({ visible, children }: { visible: boolean; children?: ReactNode }) => visible ? createElement("div", { role: "dialog" }, children) : null,
    FlatList: React.forwardRef(({ data, renderItem, ListEmptyComponent, ListFooterComponent, ListHeaderComponent }: { data?: readonly unknown[]; renderItem(value: { item: unknown }): ReactNode; ListEmptyComponent?: ReactNode; ListFooterComponent?: ReactNode; ListHeaderComponent?: ReactNode }, ref) => { React.useImperativeHandle(ref, () => ({ scrollToEnd() {} }));
      return createElement("div", {}, ListHeaderComponent, data?.length ? data.map((item, index) => createElement(React.Fragment, { key: index }, renderItem({ item }))) : ListEmptyComponent, ListFooterComponent); }) };
});
import { MobilePartnerNetworkScreen } from "./MobilePartnerNetworkScreen";
const roots: Root[] = [];
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); native.openURL.mockClear(); });
afterEach(async () => { await act(async () => { for (const root of roots.splice(0)) root.unmount(); }); document.body.replaceChildren(); });
const colors = { background: "#fff", surface: "#fff", ink: "#111", muted: "#777", border: "#ccc", accent: "#f90", negative: "#c00", brandBackground: "#fff" };
function fixture() {
  const room = create(contract.PartnerNetworkRoomSchema, { id: "room", hostServerId: "authority", hostOrigin: "https://authority.test", name: "Shared room", selfId: "owner", revision: 1n, state: "active", replyMode: "all", speakingMode: "auto",
    members: [{ id: "owner", kind: "human", role: "owner", state: "joined", name: "Owner" }, { id: "partner", kind: "partner", role: "member", state: "joined", ownerId: "owner", name: "Nova", guestAccess: "chat" }] });
  const rows: contract.PartnerNetworkMessage[] = [], disk = new Map<string, string>(), storage = { getItem: (key: string) => disk.get(key) ?? null, setItem: (key: string, value: string) => { disk.set(key, value); } };
  const send = vi.fn(async (request: contract.SendPartnerNetworkRequest) => { const message = create(contract.PartnerNetworkMessageSchema, { id: "accepted", text: request.text, authorId: room.selfId, sequence: 1n }); rows.push(message); return create(contract.SendPartnerNetworkResponseSchema, { message }); });
  const manage = vi.fn(async () => create(contract.ManagePartnerNetworkResponseSchema, { room })), media = vi.fn(async () => create(contract.MediaPartnerNetworkResponseSchema, { downloadUrl: `${room.hostOrigin}/v1/blobs/download/ticket/short-secret` }));
  const api = { ownerKey: "authority:browser:1", listPartnerNetwork: async () => create(contract.ListPartnerNetworkResponseSchema, { rooms: [room] }), getPartnerNetwork: async () => create(contract.GetPartnerNetworkResponseSchema, { snapshot: { room, messages: rows } }), readPartnerNetworkFailures: async () => create(contract.ReadPartnerNetworkFailuresResponseSchema), sendPartnerNetwork: send, managePartnerNetwork: manage, mediaPartnerNetwork: media } as unknown as MobilePartnerNetworkApi;
  return { room, rows, disk, storage, send, manage, media, api };
}
async function mount(f: ReturnType<typeof fixture>, api = f.api) { const container = document.createElement("div"); document.body.append(container); const root = createRoot(container); roots.push(root);
  const setForeground = (foreground: boolean) => act(async () => {
    root.render(<MobilePartnerNetworkScreen api={api} storage={f.storage} colors={colors} locale="en" foreground={foreground} onBack={() => {}} />);
    await pause();
  });
  await setForeground(true); return { root, container, setForeground }; }
async function pause() { await new Promise(resolve => setTimeout(resolve, 10)); }
async function click(label: string, parent: ParentNode = document.body) { const target = Array.from(parent.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === label || button.textContent?.startsWith(label)); expect(target).toBeDefined(); await act(async () => { target!.click(); await pause(); }); }
async function fill(value: string, label = "Message") { const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); await pause(); }); }
it("uses the original native group plan controls for a long talk queue and retains an unknown continue request", async () => {
  const f = fixture(); f.room.singleSpeaker = true;
  const plan = create(contract.PartnerNetworkPlanSchema, { id: "talk", roomId: f.room.id, revision: 1n, kind: "talk", status: "waiting", currentStep: 4, requesterId: f.room.selfId,
    steps: Array.from({ length: 6 }, (_, position) => ({ position, actorId: "partner", status: position < 5 ? "completed" : "pending" })) });
  f.rows.push(create(contract.PartnerNetworkMessageSchema, { id: "queue-card", sequence: 1n, kind: "plan", planId: plan.id }));
  const send = vi.fn(async (_request: Partial<contract.PlanPartnerNetworkRequest>) => { throw new ConnectError("Lost continue", Code.Unavailable); });
  Object.assign(f.api, { getPartnerNetwork: async () => create(contract.GetPartnerNetworkResponseSchema, { snapshot: { room: f.room, messages: f.rows, plans: [plan] } }), planPartnerNetwork: send });
  const view = await mount(f); await click("Shared room"); expect(view.container.textContent).toContain("6 speakers");
  await click("6 speakers"); expect(view.container.textContent).toContain("Collapse");
  await click("Continue"); const original = send.mock.calls[0]![0]; await click("Continue");
  expect(send.mock.calls[1]![0]).toEqual(original); expect(original).toMatchObject({ action: "continue", planId: plan.id, expectedRevision: 1n });
  await click("Group settings"); expect(view.container.textContent).not.toContain("Reply mode"); expect(view.container.textContent).not.toContain("Speaking mode");
});
it("restores an unknown native send after reconnect and explicitly retries its original complete request", async () => {
  const f = fixture(); f.send.mockRejectedValueOnce(new ConnectError("reply lost", Code.Unavailable)); const first = await mount(f); await click("Shared room"); await fill("Keep the same send"); await click("Send");
  expect(f.send).toHaveBeenCalledTimes(1); const original = f.send.mock.calls[0]![0];
  await act(async () => first.root.unmount()); roots.splice(roots.indexOf(first.root), 1); first.container.remove();
  await mount(f, { ...f.api, ownerKey: "authority:browser:2" }); await click("Shared room"); expect(f.send).toHaveBeenCalledTimes(1); expect(document.body.textContent).toContain("Keep the same send");
  await click("Retry"); expect(f.send).toHaveBeenCalledTimes(2); expect(f.send.mock.calls[1]![0]).toEqual(original); expect(f.rows).toHaveLength(1);
});
it("keeps owner settings reachable and hides last-owner leave until transfer or dissolution", async () => {
  const f = fixture(); await mount(f); await click("Shared room"); await click("Group settings");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Invite my companion"); expect(Array.from(document.querySelectorAll("button")).some(button => button.textContent === "Leave group")).toBe(false);
  await fill("Renamed", "Group name"); await click("Save"); expect(f.manage).toHaveBeenCalledWith(expect.objectContaining({ action: "rename", value: "Renamed", roomId: "room", expectedRevision: 1n }), expect.anything());
});
it.each([0, 5])("preserves the remaining external room recipient when deleting the @all at offset %i", async start => {
  const f = fixture();
  f.room.members.push(create(contract.PartnerNetworkActorSchema, { id: "person", kind: "human", role: "member", state: "joined", name: "all" }));
  await mount(f); await click("Shared room"); await fill("@all "); await click("@all");
  const input = document.querySelector<HTMLInputElement>('[aria-label="Message"]')!;
  expect(input.value).toBe("@all @all ");
  await act(async () => { input.setSelectionRange(start, start + 5); input.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); });
  await fill("@all "); await click("Send");
  expect(f.send.mock.calls[0]![0]).toMatchObject({ mentions: start === 0 ? ["person"] : [], mentionAll: start === 5, mentionAllPartners: false });
});
it("uses the same people and companion audiences on native sends and retries", async () => {
  const f = fixture(); f.room.allowMentionAllPartners = true;
  f.send.mockRejectedValueOnce(new ConnectError("reply lost", Code.Unavailable));
  await mount(f); await click("Shared room"); await click("@Everyone"); await click("@All companions"); await click("Send");
  const original = f.send.mock.calls[0]![0];
  expect(original).toMatchObject({ mentionAll: true, mentionAllPartners: true, mentions: [] });
  await click("Retry");
  expect(f.send.mock.calls[1]![0]).toEqual(original);
  await click("Group settings"); await click("Allow mentioning all companions");
  expect(f.manage).toHaveBeenCalledWith(expect.objectContaining({ action: "partner-broadcast", value: "false" }), expect.anything());
});
it.each([false, true])("shows the inactive companion audience switch only when the room supports it (%s)", async supported => {
  const f = fixture(); f.room.supportsMentionAudiences = supported;
  await mount(f); await click("Shared room"); await click("Group settings");
  expect(document.querySelector('[role="dialog"]')?.textContent?.includes("Allow mentioning all companions")).toBe(supported);
  expect(f.manage).not.toHaveBeenCalled();
});
it("keeps a late send in its original room when the user opens a second conversation", async () => {
  const f = fixture();
  const other = create(contract.PartnerNetworkRoomSchema, { ...f.room, id: "second-room", name: "Second room" });
  let finish!: (response: contract.SendPartnerNetworkResponse) => void;
  f.send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await mount(f, { ...f.api, ownerKey: "two-rooms:1",
    listPartnerNetwork: async () => create(contract.ListPartnerNetworkResponseSchema, { rooms: [f.room, other] }),
    getPartnerNetwork: async request => create(contract.GetPartnerNetworkResponseSchema, {
      snapshot: { room: request.roomId === other.id ? other : f.room }
    }) });
  await click("Shared room"); await fill("Same text"); await click("Send");
  expect(f.send.mock.calls[0]?.[0].roomId).toBe(f.room.id);
  await click("Back to group"); await click("Second room"); await fill("Same text");
  await act(async () => { finish(create(contract.SendPartnerNetworkResponseSchema, { message: { id: "first-message" } })); await pause(); });
  expect(document.querySelector<HTMLInputElement>('[aria-label="Message"]')?.value).toBe("Same text");
  expect(document.body.textContent).toContain("Second room");
  expect(document.body.textContent).not.toContain("Shared room");
  expect(f.send).toHaveBeenCalledTimes(1);
});
it("allocates a fresh ID for a new send of the same text after the original was confirmed", async () => {
  const f = fixture();
  let finish!: (response: contract.SendPartnerNetworkResponse) => void;
  f.send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await mount(f, { ...f.api, ownerKey: "confirmed-send:1" }); await click("Shared room"); await fill("Same message"); await click("Send");
  const original = f.send.mock.calls[0]![0];
  await fill("Working on the next message");
  await act(async () => {
    finish(create(contract.SendPartnerNetworkResponseSchema, { message: { id: "original-message" } }));
    await pause();
  });
  expect(document.querySelector<HTMLInputElement>('[aria-label="Message"]')?.value).toBe("Working on the next message");
  await fill("Same message"); await click("Send");
  expect(f.send).toHaveBeenCalledTimes(2);
  expect(f.send.mock.calls[1]![0].operationId).not.toBe(original.operationId);
});
it("keeps a newly typed audience while an identical-looking personal mention is being confirmed", async () => {
  const f = fixture();
  f.room.members.push(create(contract.PartnerNetworkActorSchema, { id: "person", name: "all", kind: "human", state: "joined" }));
  let finish!: (response: contract.SendPartnerNetworkResponse) => void;
  f.send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await mount(f, { ...f.api, ownerKey: "edited-audience:1" }); await click("Shared room"); await click("@all"); await click("Send");
  const original = f.send.mock.calls[0]![0];
  expect(original).toMatchObject({ text: "@all ", mentions: ["person"], mentionAll: false });
  await fill(""); await fill("@all ");
  await act(async () => {
    finish(create(contract.SendPartnerNetworkResponseSchema, { message: { id: "personal-message" } }));
    await pause();
  });
  expect(document.querySelector<HTMLInputElement>('[aria-label="Message"]')?.value).toBe("@all ");
  await click("Send");
  expect(f.send.mock.calls[1]![0]).toMatchObject({ text: "@all ", mentions: [], mentionAll: true });
  expect(f.send.mock.calls[1]![0].operationId).not.toBe(original.operationId);
});
it("opens files using only a current short-lived download URL and never hands a membership bearer to the system", async () => {
  const f = fixture(); f.rows.push(create(contract.PartnerNetworkMessageSchema, { id: "file-message", authorId: "partner", text: "A document", sequence: 1n, attachments: [{ id: "file", name: "report.txt", mediaType: "text/plain", sizeBytes: 12n }] }));
  await mount(f); await click("Shared room"); await click("report.txt"); expect(f.media).toHaveBeenCalledWith(expect.objectContaining({ action: "authorize", mediaId: "file" }), expect.anything());
  expect(native.openURL).toHaveBeenCalledExactlyOnceWith("https://authority.test/v1/blobs/download/ticket/short-secret");
});
it("retires a pending file open when the user leaves the room", async () => {
  const f = fixture();
  f.rows.push(create(contract.PartnerNetworkMessageSchema, { id: "document", sequence: 1n,
    attachments: [{ id: "file", name: "report.txt", mediaType: "text/plain", sizeBytes: 12n }] }));
  let finish!: (response: contract.MediaPartnerNetworkResponse) => void;
  f.media.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await mount(f); await click("Shared room"); await click("report.txt"); await click("Back to group");
  await act(async () => {
    finish(create(contract.MediaPartnerNetworkResponseSchema, { downloadUrl: `${f.room.hostOrigin}/v1/blobs/download/file/ticket` }));
    await pause();
  });
  expect(native.openURL).not.toHaveBeenCalled();
});
it.each(["inactive", "resumed"])("retires a file open across a temporary interruption even if its reply arrives while %s", async when => {
  const f = fixture();
  f.rows.push(create(contract.PartnerNetworkMessageSchema, { id: "document", sequence: 1n,
    attachments: [{ id: "file", name: "report.txt", mediaType: "text/plain", sizeBytes: 12n }] }));
  let release!: (response: contract.MediaPartnerNetworkResponse) => void;
  f.media.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const view = await mount(f); await click("Shared room"); await click("report.txt");
  await view.setForeground(false);
  if (when === "resumed") await view.setForeground(true);
  await act(async () => {
    release(create(contract.MediaPartnerNetworkResponseSchema, { downloadUrl: `${f.room.hostOrigin}/v1/blobs/download/file/old-ticket` }));
    await pause();
  });
  expect(native.openURL).not.toHaveBeenCalled();
  if (when === "inactive") await view.setForeground(true);
  await click("report.txt");
  expect(f.media).toHaveBeenCalledTimes(2);
  expect(native.openURL).toHaveBeenCalledExactlyOnceWith(`${f.room.hostOrigin}/v1/blobs/download/ticket/short-secret`);
});
it("keeps the finished plans for every visible history page on load and foreground refresh", async () => {
  const f = fixture();
  const page = (id: string, sequence: bigint, task: string, hasMore: boolean) => create(contract.GetPartnerNetworkResponseSchema, {
    snapshot: { room: f.room, hasMore, messages: [{ id: `card-${id}`, sequence, kind: "plan", planId: id }],
      plans: [{ id, roomId: f.room.id, revision: 1n, status: "completed", steps: [{ actorId: "partner", task, status: "completed" }] }] }
  });
  const earlier = page("earlier", 1n, "Inspect the old drawing", false), latest = page("latest", 101n, "Check the revised drawing", true);
  const read = vi.fn(async (request: Partial<contract.GetPartnerNetworkRequest>) => request.beforeSequence === 101n ? earlier : latest);
  const view = await mount(f, { ...f.api, getPartnerNetwork: read }); await click("Shared room");
  const expectBoth = () => {
    expect(view.container.textContent).toContain("Check the revised drawing");
    expect(view.container.textContent).toContain("Inspect the old drawing");
  };
  await click("View earlier"); expectBoth();
  read.mockClear();
  await view.setForeground(false); await view.setForeground(true);
  expect(read.mock.calls.map(([request]) => request.beforeSequence)).toEqual([undefined, 101n]); expectBoth();
});
it("displays a slow first room snapshot and resumes polling after it finishes", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const f = fixture();
    const page = create(contract.GetPartnerNetworkResponseSchema, { snapshot: { room: f.room, messages: [
      { id: "original-message", sequence: 1n, text: "Recovered from a slow connection" }
    ] } });
    let release!: (response: contract.GetPartnerNetworkResponse) => void;
    const read = vi.fn(() => new Promise<contract.GetPartnerNetworkResponse>(resolve => { release = resolve; }));
    const view = await mount(f, { ...f.api, getPartnerNetwork: read });
    await click("Shared room");
    const firstReply = release;
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    await act(async () => { firstReply(page); });
    expect(view.container.textContent).toContain("Recovered from a slow connection");
    expect(read).toHaveBeenCalledTimes(1);
    read.mockResolvedValueOnce(page);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(read).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});
it("shows read-only plans, welcome events and localized task cards without exposing plan controls", async () => {
  const f = fixture(), plan = create(contract.PartnerNetworkPlanSchema, { id: "plan", roomId: "room", requesterId: "owner", status: "proposed", steps: [{ position: 0, actorId: "partner", task: "Write the result", status: "pending" }] });
  f.room.selfId = "reader"; f.room.members.push(create(contract.PartnerNetworkActorSchema, { id: "reader", kind: "human", role: "member", state: "joined", name: "Reader" }));
  f.rows.push(create(contract.PartnerNetworkMessageSchema, { id: "plan-card", kind: "plan", planId: plan.id, sequence: 1n }), create(contract.PartnerNetworkMessageSchema, { id: "join", kind: "member-joined", eventActorId: "owner", authorName: "Owner", sequence: 2n }));
  await mount(f, { ...f.api, getPartnerNetwork: async () => create(contract.GetPartnerNetworkResponseSchema, { snapshot: { room: f.room, messages: f.rows, plans: [plan] } }) }); await click("Shared room");
  expect(document.body.textContent).toContain("Write the result"); expect(document.body.textContent).toContain("joined the group");
  expect(Array.from(document.querySelectorAll("button")).some(button => [contract.partnerGroupMessages("en").start, "Create thread", "Share to main conversation"].includes(button.textContent ?? ""))).toBe(false);
});
it("keeps an unsent group draft while leaving the group view and reuses a matching unknown send", async () => {
  const f = fixture(); f.send.mockRejectedValueOnce(new ConnectError("lost", Code.Unavailable)); await mount(f, { ...f.api, ownerKey: "draft-owner:1" }); await click("Shared room"); await fill("Keep this draft"); await click("Back to group"); await click("Shared room");
  expect((document.querySelector('[aria-label="Message"]') as HTMLInputElement).value).toBe("Keep this draft"); await click("Send"); const original = f.send.mock.calls[0]![0];
  await click("Back to group"); await click("Shared room"); await click("Send"); expect(f.send.mock.calls[1]![0]).toEqual(original);
});
it("projects localized failures next to old loaded sources using complete bounded queries", async () => {
  const f = fixture(), query = vi.fn(async (request: Partial<contract.ReadPartnerNetworkFailuresRequest>) => create(contract.ReadPartnerNetworkFailuresResponseSchema, { executions: request.sourceMessageIds?.includes("source-0") ? [{ id: "failure", sourceMessageId: "source-0", actorId: "partner", status: "failed", failureCode: "AUTH_REQUIRED", lease: 1n }] : [] }));
  for (let index = 0; index < 131; index++) f.rows.push(create(contract.PartnerNetworkMessageSchema, { id: `source-${index}`, text: `Old message ${index}`, sequence: BigInt(index + 1) }));
  await mount(f, { ...f.api, readPartnerNetworkFailures: query }); await click("Shared room"); await act(async () => pause());
  expect(query.mock.calls.map(call => call[0].sourceMessageIds?.length)).toEqual([100, 31]); expect(document.body.textContent).toContain("Sign in or update credentials on the companion's home computer");
});

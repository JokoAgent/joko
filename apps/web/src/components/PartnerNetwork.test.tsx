// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as wire from "@joko/contracts";
import type { AppController } from "../controller.js";
import type { PartnerNetworkApi } from "../partner-network-api.js";
import { PartnerNetworkPage, PartnerNetworkSection } from "./PartnerNetwork.js";
import type { Translator } from "./types.js";

vi.mock("./Timeline.js", () => ({ StreamingMarkdown: ({ text }: { text: string }) => <p>{text}</p> }));
const roots: Root[] = [];
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("crypto", webcrypto); localStorage.clear(); });
afterEach(async () => { await act(async () => { for (const root of roots.splice(0)) root.unmount(); }); document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const room = create(wire.PartnerNetworkRoomSchema, { id: "room", name: "Shared room", hostServerId: "authority", hostOrigin: "https://authority.test", revision: 1n, state: "active", selfId: "human", availability: "available", replyMode: "all", speakingMode: "auto",
  members: [{ id: "human", name: "Owner", kind: "human", role: "owner", state: "joined" }, { id: "partner", name: "Nova", kind: "partner", role: "member", state: "joined", ownerId: "human", guestAccess: "chat", accessRevision: 1n }] });
const t = ((key: string) => key) as Translator;
function setup() {
  const rows: wire.PartnerNetworkMessage[] = [];
  const api = { listPartnerNetwork: vi.fn(async () => create(wire.ListPartnerNetworkResponseSchema, { rooms: [room] })),
    getPartnerNetwork: vi.fn(async (_request: Partial<wire.GetPartnerNetworkRequest>) => create(wire.GetPartnerNetworkResponseSchema, { snapshot: { room, messages: rows } })),
    sendPartnerNetwork: vi.fn(async (request: wire.SendPartnerNetworkRequest) => { const message = create(wire.PartnerNetworkMessageSchema, { id: "accepted-once", text: request.text, authorId: "human", authorName: "Owner", sequence: 1n, createdAtMs: 1n }); rows.push(message); return create(wire.SendPartnerNetworkResponseSchema, { message }); }),
    managePartnerNetwork: vi.fn(async (_request: Partial<wire.ManagePartnerNetworkRequest>) => create(wire.ManagePartnerNetworkResponseSchema, { room })),
    getPartnerNetworkOwnerControls: vi.fn(async () => create(wire.GetPartnerNetworkOwnerControlsResponseSchema)),
    readPartnerNetworkFailures: vi.fn(async (_request: Partial<wire.ReadPartnerNetworkFailuresRequest>) => create(wire.ReadPartnerNetworkFailuresResponseSchema)),
    configurePartnerNetworkProject: vi.fn(async () => create(wire.ConfigurePartnerNetworkProjectResponseSchema)),
    invitePartnerNetwork: vi.fn(async (_request: Partial<wire.InvitePartnerNetworkRequest>) => create(wire.InvitePartnerNetworkResponseSchema, { invitation: "joko://conversation/join#retained", link: { id: "invite", roomId: room.id, state: "active", reusable: true, expiresAtMs: 0n } })),
    previewPartnerNetwork: vi.fn(async () => create(wire.PreviewPartnerNetworkResponseSchema, { room, link: { id: "link", roomId: "room" } })),
    joinPartnerNetwork: vi.fn(async (_request: Partial<wire.JoinPartnerNetworkRequest>) => create(wire.JoinPartnerNetworkResponseSchema, { room: { ...room, joinId: "joined" } })) };
  const controller = { partnerNetwork: api as unknown as PartnerNetworkApi, state: { effectiveLocale: "en", activeProfile: { id: crypto.randomUUID(), deviceId: "browser", serverId: "authority" }, connectionGeneration: 1 },
    listPartners: vi.fn(async () => ({ partners: [] })), navigate: vi.fn() } as unknown as AppController;
  return { api, controller, rows };
}
async function mount(node: ReactNode) { const element = document.createElement("div"); document.body.append(element); const root = createRoot(element); roots.push(root); await act(async () => { root.render(node); await settle(); }); return { root, element }; }
async function settle() { await new Promise(resolve => setTimeout(resolve, 15)); }
function button(text: string, parent: ParentNode = document.body) { const value = [...parent.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text || item.getAttribute("aria-label") === text); if (!value) throw new Error(`Missing button ${text}`); return value; }
async function fill(input: HTMLTextAreaElement | HTMLInputElement, value: string) { await act(async () => { const type = input.tagName === "TEXTAREA" ? HTMLTextAreaElement : HTMLInputElement; Object.getOwnPropertyDescriptor(type.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); await settle(); }); }

describe("Shared conversation UI receipts", () => {
  it("keeps the main chat mounted beside a resizable thread and advances only that reader at the visible bottom", async () => {
    const f = setup(), root = create(wire.PartnerNetworkMessageSchema, { id: "root", authorId: "partner", authorName: "Nova", text: "Thread source", sequence: 1n,
      threadPreview: { rootId: "root", replyCount: 2n, authorName: "Other", text: "New reply" } });
    const replies = [2n, 3n].map(sequence => create(wire.PartnerNetworkMessageSchema, { id: `reply-${sequence}`, threadRootId: root.id, text: `Reply ${sequence}`, authorId: "other", authorName: "Other", sequence }));
    let read = 2n, following = false; vi.spyOn(document, "hasFocus").mockReturnValue(true);
    f.api.getPartnerNetwork.mockImplementation(async request => create(wire.GetPartnerNetworkResponseSchema, { snapshot: {
      room: { ...room, singleSpeaker: true }, messages: request.threadRootId ? [root, ...replies] : [root], readerStateSupported: true,
      threadReadSequence: request.threadRootId ? read : 0n, threadFollowing: request.threadRootId ? following : false,
      threads: [{ rootId: root.id, rootText: root.text, replyCount: BigInt(replies.length), readSequence: read, unreadCount: BigInt(replies.filter(reply => reply.sequence > read).length), latestUnreadSequence: replies.at(-1)!.sequence, mentioned: true, following }] } }));
    f.api.managePartnerNetwork.mockImplementation(async request => { if (request.threadRootId === root.id) {
      if (request.action === "mark-read") read = request.throughSequence ?? read;
      if (request.action === "follow-thread") following = request.following ?? false;
    } return create(wire.ManagePartnerNetworkResponseSchema, { room }); });
    const view = await mount(<PartnerNetworkPage controller={f.controller} route="network:host:room" t={t} onOpenNavigation={() => {}} />);
    await fill(view.element.querySelector("textarea")!, "Main stays here"); await act(async () => { button("Create thread", view.element).click(); await settle(); });
    const main = view.element.querySelector(".partner-network-main")!, thread = view.element.querySelector(".partner-network-thread")!, timeline = thread.querySelector<HTMLElement>(".partner-group-timeline")!;
    expect(main.querySelector("textarea")!.value).toBe("Main stays here"); expect(thread.querySelector("textarea")!.value).toBe("");
    expect(thread.textContent).toContain("New replies"); expect(read).toBe(3n);
    const separator = view.element.querySelector<HTMLElement>('[role="separator"][aria-orientation="vertical"]')!;
    await act(async () => { separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); }); expect(separator.getAttribute("aria-valuenow")).toBe("45");
    await act(async () => { button("Follow", thread).click(); await settle(); }); expect(following).toBe(true);
    expect(f.api.managePartnerNetwork.mock.calls.some(([request]) => request.action === "mark-read" && request.threadRootId === root.id && request.throughSequence === 3n)).toBe(true);
    expect(f.api.managePartnerNetwork.mock.calls.some(([request]) => request.action === "follow-thread" && request.threadRootId === root.id && request.following === true && request.throughSequence === 2n)).toBe(true);
    expect(read).toBe(3n);
    Object.defineProperties(timeline, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } }); timeline.scrollTop = 0;
    await act(async () => { timeline.dispatchEvent(new Event("scroll", { bubbles: true })); });
    replies.push(create(wire.PartnerNetworkMessageSchema, { id: "reply-4", threadRootId: root.id, text: "Unread while looking back", authorId: "other", sequence: 4n }));
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await settle(); });
    expect(read).toBe(3n); expect(thread.textContent).toContain("Unread while looking back");
    timeline.scrollTop = 800; await act(async () => { timeline.dispatchEvent(new Event("scroll", { bubbles: true })); await settle(); }); expect(read).toBe(4n);
  });
  it("folds a long talk queue and retries the immutable continue request after a lost receipt", async () => {
    const f = setup(); let revision = 1n;
    const plan = create(wire.PartnerNetworkPlanSchema, { id: "talk", roomId: room.id, requesterId: room.selfId, kind: "talk", status: "waiting", currentStep: 4, revision,
      steps: Array.from({ length: 6 }, (_, position) => ({ position, actorId: "partner", status: position < 5 ? "completed" : "pending" })) });
    const planMessage = create(wire.PartnerNetworkMessageSchema, { id: "card", sequence: 1n, kind: "plan", planId: plan.id });
    f.api.getPartnerNetwork.mockImplementation(async () => create(wire.GetPartnerNetworkResponseSchema, { snapshot: { room: { ...room, singleSpeaker: true }, messages: [planMessage], plans: [{ ...plan, revision }] } }));
    const actPlan = vi.fn(async (_request: Partial<wire.PlanPartnerNetworkRequest>) => { throw new ConnectError("Lost continue receipt", Code.Unavailable); }); Object.assign(f.api, { planPartnerNetwork: actPlan });
    const view = await mount(<PartnerNetworkPage controller={f.controller} route="network:host:room" t={t} onOpenNavigation={() => {}} />);
    expect(view.element.querySelectorAll(".partner-group-plan-card li")).toHaveLength(3);
    await act(async () => { button("6 speakers", view.element).click(); await settle(); }); expect(view.element.querySelectorAll(".partner-group-plan-card li")).toHaveLength(6);
    await act(async () => { button("Continue", view.element).click(); await settle(); }); const original = actPlan.mock.calls[0]![0];
    revision = 2n; await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await settle(); button("Continue", view.element).click(); await settle(); });
    expect(actPlan.mock.calls[1]![0]).toEqual(original); expect(original).toMatchObject({ action: "continue", expectedRevision: 1n, planId: "talk" });
  });
  it("keeps the original send across a lost reply, remount and explicit retry without resending on entry", async () => {
    const f = setup(); f.api.sendPartnerNetwork.mockRejectedValueOnce(new ConnectError("reply lost", Code.Unavailable));
    const page = () => <PartnerNetworkPage controller={f.controller} route="network:host:room" t={t} onOpenNavigation={() => {}} />;
    const first = await mount(page()); await fill(first.element.querySelector("textarea")!, "Retained original message");
    await act(async () => { button("Send", first.element).click(); await settle(); }); expect(f.api.sendPartnerNetwork).toHaveBeenCalledTimes(1);
    const original = f.api.sendPartnerNetwork.mock.calls[0]![0]; await act(async () => { first.root.unmount(); }); roots.splice(roots.indexOf(first.root), 1);
    const resumed = await mount(page()); expect(resumed.element.textContent).toContain("Retained original message"); expect(f.api.sendPartnerNetwork).toHaveBeenCalledTimes(1);
    await act(async () => { button("Retry", resumed.element).click(); await settle(); }); expect(f.api.sendPartnerNetwork).toHaveBeenCalledTimes(2);
    expect(f.api.sendPartnerNetwork.mock.calls[1]![0]).toEqual(original); expect(f.rows).toHaveLength(1); expect(resumed.element.textContent).not.toContain("Not sent");
  });
  it("resumes an unknown join with the same ID after closing the dialog and keeps invitation secrets out of storage", async () => {
    const f = setup(); f.api.joinPartnerNetwork.mockRejectedValueOnce(new ConnectError("reply lost", Code.Unavailable));
    const invitation = "joko://conversation/join#private-invitation-secret", view = await mount(<PartnerNetworkSection controller={f.controller} partners={[]} />);
    const open = async () => { await act(async () => { button("Enter invitation link…", view.element).click(); await settle(); }); const inputs = document.body.querySelectorAll<HTMLInputElement>('[role="dialog"] input'); await fill(inputs[0]!, invitation); await fill(inputs[1]!, "Guest"); };
    await open(); await act(async () => {
      button("Read invitation").click();
      await vi.waitFor(() => expect(f.api.previewPartnerNetwork).toHaveBeenCalledTimes(1));
    });
    await act(async () => {
      button("Accept and join").click();
      // Preparing the original ID hashes and verifies its journal before RPC.
      // A fixed delay does not establish that private asynchronous boundary.
      await vi.waitFor(() => expect(f.api.joinPartnerNetwork).toHaveBeenCalledTimes(1));
    });
    expect(document.querySelector('[role="dialog"] [role="alert"]')).not.toBeNull();
    expect(f.api.joinPartnerNetwork).toHaveBeenCalledTimes(1); const original = f.api.joinPartnerNetwork.mock.calls[0]; expect(JSON.stringify(Object.values(localStorage))).not.toContain("private-invitation-secret");
    const close = document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="Close"]');
    await act(async () => { close!.click(); await settle(); }); await open();
    await act(async () => {
      button("Read invitation").click();
      // Joining is followed by an asynchronous journal confirmation before
      // navigation. A request count alone does not prove that receipt settled.
      await vi.waitFor(() => expect(f.controller.navigate).toHaveBeenCalledWith({ kind: "partners", groupId: "network:joined:room" }));
    });
    expect(f.api.previewPartnerNetwork).toHaveBeenCalledTimes(1); expect(f.api.joinPartnerNetwork).toHaveBeenCalledTimes(2); expect(f.api.joinPartnerNetwork.mock.calls[1]?.[0]).toEqual(original?.[0]);
    expect(f.controller.navigate).toHaveBeenCalledTimes(1);
  });
  it("withdraws history and the composer on an explicit membership rejection", async () => {
    const f = setup(); f.api.getPartnerNetwork.mockRejectedValue(new ConnectError("revoked", Code.PermissionDenied));
    const view = await mount(<PartnerNetworkPage controller={f.controller} route="network:host:room" t={t} onOpenNavigation={() => {}} />);
    expect(view.element.textContent).toContain("You no longer have access"); expect(view.element.querySelector("textarea")!.disabled).toBe(true); expect(f.api.sendPartnerNetwork).not.toHaveBeenCalled();
  });
  it("keeps separate main and thread drafts, quotes and division flags for the current owner across navigation", async () => {
    const f = setup(); f.rows.push(create(wire.PartnerNetworkMessageSchema, { id: "root", text: "Topic source", authorId: "partner", authorName: "Nova", sequence: 1n, createdAtMs: 1n }));
    const page = () => <PartnerNetworkPage controller={f.controller} route="network:host:room" t={t} onOpenNavigation={() => {}} />, first = await mount(page());
    await fill(first.element.querySelector("textarea")!, "Main draft @Nova"); await act(async () => { button("Quote reply", first.element).click(); button(wire.partnerGroupMessages("en").divide, first.element).click(); await settle(); });
    await act(async () => { button("Create thread", first.element).click(); await settle(); }); const thread = first.element.querySelector(".partner-network-thread")!;
    expect(first.element.querySelector(".partner-network-main textarea")!.getAttribute("disabled")).toBeNull(); expect(thread.querySelector("textarea")!.value).toBe("");
    await fill(thread.querySelector("textarea")!, "Thread draft"); await act(async () => { button("Close", thread).click(); await settle(); });
    expect(first.element.querySelector("textarea")!.value).toBe("Main draft @Nova"); expect(first.element.textContent).toContain(wire.partnerGroupMessages("en").divisionTag); expect(first.element.textContent).toContain("Quote reply: Topic source");
    await act(async () => { first.root.unmount(); }); roots.splice(roots.indexOf(first.root), 1); first.element.remove();
    const next = await mount(page()); expect(next.element.querySelector("textarea")!.value).toBe("Main draft @Nova"); expect(f.api.sendPartnerNetwork).not.toHaveBeenCalled();
  });
  it("reuses unknown send IDs when editing the unchanged mention-all and division request", async () => {
    const f = setup(); f.api.sendPartnerNetwork.mockRejectedValueOnce(new ConnectError("lost", Code.Unavailable)); const view = await mount(<PartnerNetworkPage controller={f.controller} route="network:host:room" t={t} onOpenNavigation={() => {}} />);
    await fill(view.element.querySelector("textarea")!, "@Everyone arrange this"); await act(async () => { button(wire.partnerGroupMessages("en").divide, view.element).click(); await settle(); button("Send", view.element).click(); await settle(); });
    const original = f.api.sendPartnerNetwork.mock.calls[0]![0]; expect(original).toMatchObject({ mentionAll: true, forcePlan: true });
    await act(async () => { button("Edit", view.element).click(); await settle(); button("Send", view.element).click(); await settle(); }); expect(f.api.sendPartnerNetwork.mock.calls[1]![0]).toEqual(original);
  });
  it("retains invitations on cancelled or failed revocation and invalidates copy only after acknowledgement", async () => {
    const f = setup(), view = await mount(<PartnerNetworkPage controller={f.controller} route="network:host:room" t={t} onOpenNavigation={() => {}} />);
    await act(async () => { button("Group settings", view.element).click(); await settle(); button("Invite people").click(); await settle(); });
    expect(f.api.invitePartnerNetwork.mock.calls[0]![0]).toMatchObject({ reusable: true, lifetimeMs: 0n });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false); await act(async () => { button("Revoke this link").click(); await settle(); }); expect(f.api.managePartnerNetwork).not.toHaveBeenCalled(); expect(button("Copy").disabled).toBe(false);
    confirm.mockReturnValue(true); f.api.managePartnerNetwork.mockRejectedValueOnce(new ConnectError("lost", Code.Unavailable));
    await act(async () => { button("Revoke this link").click(); await settle(); }); expect(button("Copy").disabled).toBe(false);
    await act(async () => { button("Revoke this link").click(); await settle(); }); expect(f.api.managePartnerNetwork.mock.calls[1]).toEqual(f.api.managePartnerNetwork.mock.calls[0]); expect(button("Copy").disabled).toBe(true); expect(document.body.textContent).toContain("Invitation revoked");
  });
  it("uploads the same ordinary image input from a Thread composer and journals only the uploaded reference", async () => {
    const f = setup(), written: Uint8Array[] = []; f.rows.push(create(wire.PartnerNetworkMessageSchema, { id: "thread-root", text: "Topic", authorId: "partner", authorName: "Nova", sequence: 1n, createdAtMs: 1n }));
    Object.assign(f.api, { mediaPartnerNetwork: vi.fn(async (request: wire.MediaPartnerNetworkRequest) => {
      if (request.action === "begin") return create(wire.MediaPartnerNetworkResponseSchema, { attachment: { id: "media-image", name: request.name, mediaType: request.mediaType, sizeBytes: request.sizeBytes }, offset: 0n });
      written.push(Uint8Array.from(request.data)); return create(wire.MediaPartnerNetworkResponseSchema, { offset: request.offset + BigInt(request.data.length), complete: true }); }) });
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:local-image" }); Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} });
    const view = await mount(<PartnerNetworkPage controller={f.controller} route="network:host:room" t={t} onOpenNavigation={() => {}} />);
    await act(async () => { button("Create thread", view.element).click(); await settle(); }); const thread = view.element.querySelector(".partner-network-thread")!, picker = thread.querySelector<HTMLInputElement>('input[type="file"]')!; expect(picker).toBeTruthy();
    const bytes = new Uint8Array([137, 80, 78, 71]), file = new File([bytes], "annotated.png", { type: "image/png" }); Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer });
    await act(async () => { Object.defineProperty(picker, "files", { configurable: true, value: [file] }); picker.dispatchEvent(new Event("change", { bubbles: true })); await settle(); });
    expect(written).toEqual([bytes]); expect(view.element.querySelector('img[src="blob:local-image"]')).toBeTruthy();
    await act(async () => { button("Send", thread).click(); await settle(); }); expect(f.api.sendPartnerNetwork.mock.calls[0]![0]).toMatchObject({ text: "", threadRootId: "thread-root", attachments: [{ id: "media-image", name: "annotated.png", mediaType: "image/png", sizeBytes: 4n }] });
    expect(JSON.stringify(Object.values(localStorage))).not.toContain("blob:local-image");
  });
  it("reads failures for every loaded old source and removes notices when authority clears them", async () => {
    const f = setup(); for (let index = 0; index < 215; index++) f.rows.push(create(wire.PartnerNetworkMessageSchema, { id: `source-${index}`, text: `Message ${index}`, authorId: "human", sequence: BigInt(index + 1), createdAtMs: 1n }));
    f.api.readPartnerNetworkFailures.mockImplementation(async request => create(wire.ReadPartnerNetworkFailuresResponseSchema, { executions: request.sourceMessageIds?.includes("source-0") ? [{ id: "old-source-failure", sourceMessageId: "source-0", actorId: "partner", lease: 1n, status: "failed", failureCode: "RATE_LIMITED" }] : [] }));
    const view = await mount(<PartnerNetworkPage controller={f.controller} route="network:host:room" t={t} onOpenNavigation={() => {}} />);
    await act(async () => { await settle(); }); expect(f.api.readPartnerNetworkFailures.mock.calls.map(call => call[0].sourceMessageIds?.length)).toEqual([100, 100, 15]);
    expect(view.element.querySelector('[data-rendered-share-message-id="source-0"] [data-network-execution-failure]')?.textContent).toContain("temporarily rate limited");
    expect(view.element.querySelectorAll('[data-rendered-share-message-id]')).toHaveLength(215);
    f.api.readPartnerNetworkFailures.mockImplementation(async () => create(wire.ReadPartnerNetworkFailuresResponseSchema));
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await settle(); }); expect(view.element.querySelector('[data-network-execution-failure]')).toBeNull();
  });
});

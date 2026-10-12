// @vitest-environment jsdom
import { create } from "@bufbuild/protobuf";
import * as wire from "@joko/contracts";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { emptySnapshot, type PartnerProfileView } from "../model.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { PartnerGroupPage, PartnerGroupsSection } from "./PartnerGroups.js";

const m = wire.partnerGroupMessages("en"), t = (key: string) => key;
let root: Root, host: HTMLDivElement;
const observers: IntersectionObserverCallback[] = [];
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear(); observers.length = 0;
  vi.stubGlobal("IntersectionObserver", class { constructor(callback: IntersectionObserverCallback) { observers.push(callback); } observe() {} disconnect() {} });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function fixture(empty = false) {
  let group = create(wire.PartnerGroupSummarySchema, { id: "group-one", name: "Shared project", revision: { value: 1n }, unread: true,
    replyMode: wire.PartnerGroupReplyMode.MENTIONED, speakingMode: wire.PartnerGroupSpeakingMode.AUTO,
    members: ["first", "second"].map(partnerId => ({ partnerId, name: "Alex", status: wire.PartnerGroupMemberStatus.ACTIVE })) });
  let groups = empty ? [] : [group], messages = [4n, 5n].map(sequence => create(wire.PartnerGroupMessageSchema, { id: `message-${sequence}`, sequence, kind: wire.PartnerGroupMessageKind.MESSAGE,
    authorKind: wire.PartnerGroupAuthorKind.PARTNER, authorPartnerId: "first", authorName: "Alex", content: `Reply ${sequence}` }));
  let plans: wire.PartnerGroupPlan[] = [];
  const receipts = new Map<string, wire.PartnerGroupMessage>();
  const api: wire.PartnerGroupApi = { ownerKey: "group-node-one", newRequestId: vi.fn(() => "group-request-original-0001"),
    list: vi.fn(async () => create(wire.ListPartnerGroupsResponseSchema, { revision: { value: 1n }, groups, changeSequence: 1n })),
    get: vi.fn(async (_id, before) => create(wire.GetPartnerGroupResponseSchema, { detail: { group, messages: before === undefined ? messages : [2n, 3n].map(sequence => ({ id: `message-${sequence}`, sequence, content: `Earlier ${sequence}` })),
      plans, hasMoreBefore: before === undefined, canContinue: true } })),
    create: vi.fn(async (_revision, name, ids) => { group = { ...group, name, members: group.members.filter(item => ids.includes(item.partnerId)) }; groups = [group]; throw new Error("Creation response was lost"); }),
    lookup: vi.fn(async () => create(wire.GetPartnerGroupCreationResponseSchema, { group })), retire: vi.fn(),
    send: vi.fn(async (_group, input, requestId) => { const prior = receipts.get(requestId); if (prior) return prior;
      const message = create(wire.PartnerGroupMessageSchema, { id: `sent-${requestId}`, sequence: 6n, content: input.text, mentions: input.mentions, attachments: input.attachments, kind: wire.PartnerGroupMessageKind.MESSAGE, authorKind: wire.PartnerGroupAuthorKind.USER });
      messages.push(message); receipts.set(requestId, message); throw new Error("Send response was lost"); }),
    update: vi.fn(async (_group, patch) => { group = { ...group, name: patch.name ?? group.name }; groups = [group]; return group; }), members: vi.fn(), remove: vi.fn(async () => undefined),
    continue: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), markRead: vi.fn(async () => undefined),
    planAction: vi.fn(async () => undefined), planEdit: vi.fn(async () => undefined), respond: vi.fn(async () => undefined), file: vi.fn(async () => create(wire.BlobRefSchema, { blobId: "handoff-blob", fileName: "result.txt", byteSize: 10n })),
    changes: async function* (_after, signal) { if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); } };
  const partners = group.members.map(member => ({ id: member.partnerId, displayName: member.name, avatar: "orbit", lifecycle: "active" } as PartnerProfileView));
  const controller = { state: { ready: true, connectionState: "connected", connectionGeneration: 1, snapshot: emptySnapshot(), effectiveLocale: "en", preferences: DEFAULT_UI_PREFERENCES,
    activeProfile: { id: "profile-one", serverId: "node-one", deviceId: "device-one", origin: "http://localhost:4318" } },
    partnerGroupApi: vi.fn(() => api), listPartners: vi.fn(async () => ({ partners })), navigate: vi.fn(),
    uploadPartnerGroupFile: vi.fn(async (file: File) => create(wire.BlobRefSchema, { blobId: "uploaded-blob", fileName: file.name, mediaType: file.type, byteSize: BigInt(file.size), sha256Hex: "a".repeat(64) })),
    getArtifactUrl: vi.fn(async () => "blob:group-image"), releaseArtifactUrl: vi.fn(), downloadArtifact: vi.fn(async () => ({ status: "downloaded" })),
    openArtifactFile: vi.fn(async () => ({ status: "unavailable" })) } as unknown as AppController;
  return { api, controller, partners, group, setMessages: (value: wire.PartnerGroupMessage[]) => { messages = value; }, setPlans: (value: wire.PartnerGroupPlan[]) => { plans = value; } };
}
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function button(label: string, parent: ParentNode = host) { const found = [...parent.querySelectorAll<HTMLButtonElement>("button")].find(item => item.getAttribute("aria-label") === label || item.textContent === label); expect(found, label).toBeDefined(); return found!; }
async function input(element: HTMLInputElement | HTMLTextAreaElement, text: string) { await act(async () => { Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(element, text); element.dispatchEvent(new Event("input", { bubbles: true })); }); }
it("keeps a persisted unknown creation in the actual StrictMode dialog until its authenticated receipt is recovered", async () => {
  const f = fixture(true); await act(async () => { root.render(<StrictMode><PartnerGroupsSection controller={f.controller} partners={f.partners} t={t} /></StrictMode>); await settle(); });
  await act(async () => button(m.create).click()); const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  await input(dialog.querySelector("input")!, "Shared project"); expect(button(m.create, dialog).disabled).toBe(true);
  await act(async () => { const members = dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'); members[0]!.click(); members[1]!.click(); });
  await act(async () => { button(m.create, dialog).click(); await settle(); }); expect(f.api.create).toHaveBeenCalledTimes(1); expect(localStorage.length).toBe(1);
  expect(dialog.textContent).toContain(m.pendingCreate); expect(dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(true);
  await act(async () => { button(m.checkCreate, dialog).click(); await settle(); }); expect(f.controller.navigate).toHaveBeenCalledWith({ kind: "partners", groupId: f.group.id }); expect(localStorage.length).toBe(0);
});
it("preserves the picked member and uploaded attachment across a lost send response without duplicate intent", async () => {
  const f = fixture(); await act(async () => { root.render(<PartnerGroupPage controller={f.controller} groupId={f.group.id} t={t} onOpenNavigation={() => undefined} />); await settle(); });
  const editor = host.querySelector("textarea")!; await input(editor, "@"); const choices = host.querySelectorAll<HTMLButtonElement>(".partner-group-mention-picker button");
  await act(async () => choices[2]!.click()); expect(editor.value).toBe("@Alex ");
  const file = new File(["source"], "notes.txt", { type: "text/plain" }), picker = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(picker, "files", { value: [file] }); await act(async () => picker.dispatchEvent(new Event("change", { bubbles: true })));
  await act(async () => { button(m.send).click(); await settle(); }); expect(editor.value).toBe("@Alex ");
  Object.assign(f.controller.state, { connectionState: "reconnecting" });
  await act(async () => { root.render(<PartnerGroupPage controller={f.controller} groupId={f.group.id} t={t} onOpenNavigation={() => undefined} />); await settle(); });
  expect(host.querySelector("textarea")!.value).toBe("@Alex "); expect(button(m.send).disabled).toBe(true);
  vi.mocked(f.controller.partnerGroupApi).mockReturnValue({ ...f.api, ownerKey: "group-node-reconnected" });
  Object.assign(f.controller.state, { connectionState: "connected", connectionGeneration: 2 });
  await act(async () => { root.render(<PartnerGroupPage controller={f.controller} groupId={f.group.id} t={t} onOpenNavigation={() => undefined} />); await settle(); });
  await act(async () => { button(m.send).click(); await settle(); });
  expect(f.controller.uploadPartnerGroupFile).toHaveBeenCalledTimes(1); expect(f.api.send).toHaveBeenCalledTimes(2);
  const send = vi.mocked(f.api.send).mock.calls; expect(send[0]![2]).toBe(send[1]![2]); expect(send[1]![1].mentions).toEqual({ all: false, partnerIds: ["second"] }); expect(send[1]![1].attachments).toHaveLength(1); expect(editor.value).toBe("");
});
it("acknowledges only observed messages and exposes plan retry, reassignment, continuation and authenticated handoff actions", async () => {
  const f = fixture(), plan = create(wire.PartnerGroupPlanSchema, { id: "plan-one", groupId: f.group.id, revision: { value: 2n }, status: wire.PartnerGroupPlanStatus.WAITING, currentStep: 0,
    organizerName: "Alex", steps: [{ position: 0, partnerId: "first", partnerName: "Alex", task: "Create result", status: wire.PartnerGroupStepStatus.FAILED }, { position: 1, partnerId: "second", partnerName: "Alex", task: "Review result", status: wire.PartnerGroupStepStatus.PENDING }] });
  f.setPlans([plan]); f.setMessages([create(wire.PartnerGroupMessageSchema, { id: "plan-message", sequence: 4n, kind: wire.PartnerGroupMessageKind.PLAN, planId: plan.id }),
    create(wire.PartnerGroupMessageSchema, { id: "handoff-message", sequence: 5n, kind: wire.PartnerGroupMessageKind.MESSAGE, authorKind: wire.PartnerGroupAuthorKind.PARTNER, content: "Ready", files: ["result.txt"] })]);
  await act(async () => { root.render(<PartnerGroupPage controller={f.controller} groupId={f.group.id} t={t} onOpenNavigation={() => undefined} />); await settle(); }); expect(f.api.markRead).not.toHaveBeenCalled();
  await act(async () => { observers.at(-1)!([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver); await settle(); }); expect(f.api.markRead).toHaveBeenCalledWith(f.group.id, 5n, expect.any(AbortSignal));
  await act(async () => button(`${m.reassign} 1`).click());
  await act(async () => { document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[1]!.click(); await settle(); }); expect(f.api.planEdit).toHaveBeenCalledWith(f.group.id, expect.objectContaining({ id: plan.id }), 0, wire.PartnerGroupPlanEditAction.REASSIGN, "second", expect.any(AbortSignal));
  await act(async () => { button(m.retry).click(); await settle(); }); expect(f.api.planAction).toHaveBeenCalledWith(f.group.id, expect.objectContaining({ id: plan.id }), wire.PartnerGroupPlanAction.RETRY, expect.any(AbortSignal));
  await act(async () => { button(m.continue).click(); await settle(); }); expect(f.api.continue).toHaveBeenCalledWith(f.group.id, expect.any(AbortSignal));
  await act(async () => { button("result.txt").click(); await settle(); }); expect(f.api.file).toHaveBeenCalledWith(f.group.id, "handoff-message", "result.txt", expect.any(AbortSignal)); expect(f.controller.downloadArtifact).toHaveBeenCalledWith("handoff-blob", "result.txt", expect.any(Object));
});

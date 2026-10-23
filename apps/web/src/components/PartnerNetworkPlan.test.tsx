// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as wire from "@joko/contracts";
import type { PartnerNetworkApi } from "../partner-network-api.js";
import type { AppController } from "../controller.js";
import type { Translator } from "./types.js";
import { PartnerNetworkPage } from "./PartnerNetwork.js";
import { NetworkPlanCard, NetworkPlanFollowUp } from "./PartnerNetworkPlan.js";

vi.mock("./Timeline.js", () => ({ StreamingMarkdown: ({ text }: { text: string }) => <p>{text}</p> }));
const roots: Root[] = [];
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("crypto", webcrypto); localStorage.clear(); });
afterEach(async () => { await act(async () => { for (const root of roots.splice(0)) root.unmount(); }); document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const room = create(wire.PartnerNetworkRoomSchema, { id: "room", name: "Group", selfId: "owner", state: "active", hostServerId: "authority", hostOrigin: "https://authority.test", revision: 1n, availability: "available",
  members: [{ id: "owner", kind: "human", role: "owner", state: "joined", name: "Owner" }, { id: "first", kind: "partner", state: "joined", ownerId: "owner", name: "Writer", guestAccess: "chat" },
    { id: "second", kind: "partner", state: "joined", ownerId: "owner", name: "Reviewer", guestAccess: "chat" }] });
const plan = create(wire.PartnerNetworkPlanSchema, { id: "plan", roomId: room.id, revision: 3n, status: "proposed", organizerId: "first", sourceMessageId: "request", requestText: "Create a report", currentStep: 0,
  steps: [{ position: 0, actorId: "first", task: "Write report", status: "pending" }, { position: 1, actorId: "second", task: "Review report", status: "pending" }] });
async function settle() { await new Promise(resolve => setTimeout(resolve, 20)); }
async function mount(node: ReactNode) { const element = document.createElement("div"); document.body.append(element); const root = createRoot(element); roots.push(root); await act(async () => { root.render(node); await settle(); }); return element; }
function button(element: ParentNode, text: string) { const found = [...element.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === text); if (!found) throw new Error(`Missing ${text}`); return found; }

describe("network work-plan controls", () => {
  it("requires a user start, edits authoritative step identities and pauses before continuing", async () => {
    const action = vi.fn(), view = await mount(<NetworkPlanCard plan={plan} room={room} locale="en" busy={false} action={action} />);
    expect(action).not.toHaveBeenCalled(); expect(view.textContent).toContain("Each step pauses for your review");
    await act(async () => { const select = view.querySelector<HTMLSelectElement>("select")!; select.value = "second"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(action).toHaveBeenLastCalledWith("reassign", plan, 0, "second"); await act(async () => { button(view, "Start").click(); }); expect(action).toHaveBeenLastCalledWith("start", plan);
    const waiting = create(wire.PartnerNetworkPlanSchema, { ...plan, status: "waiting", steps: [{ ...plan.steps[0]!, status: "completed" }, plan.steps[1]!] });
    const followUp = await mount(<NetworkPlanFollowUp plan={waiting} room={room} locale="en" busy={false} action={action} />);
    expect(followUp.textContent).toContain("Reviewer"); await act(async () => { button(followUp, "Continue to next partner").click(); }); expect(action).toHaveBeenLastCalledWith("continue", waiting);
  });

  it("sends explicit arrange mode and @everyone as distinct immutable intent", async () => {
    const rows: wire.PartnerNetworkMessage[] = [], send = vi.fn(async (request: wire.SendPartnerNetworkRequest) => { const message = create(wire.PartnerNetworkMessageSchema, { id: "message", sequence: 1n, createdAtMs: 1n, text: request.text }); rows.push(message); return create(wire.SendPartnerNetworkResponseSchema, { message }); });
    const api = { getPartnerNetwork: vi.fn(async () => create(wire.GetPartnerNetworkResponseSchema, { snapshot: { room, messages: rows } })), sendPartnerNetwork: send,
      managePartnerNetwork: vi.fn(async () => create(wire.ManagePartnerNetworkResponseSchema, { room })), getPartnerNetworkOwnerControls: vi.fn(async () => ({ controls: [] })) } as unknown as PartnerNetworkApi;
    const controller = { partnerNetwork: api, state: { effectiveLocale: "en", activeProfile: { id: "profile", deviceId: "browser", serverId: "authority" }, connectionGeneration: 1 },
      listPartners: vi.fn(async () => ({ partners: [] })), navigate: vi.fn() } as unknown as AppController;
    const view = await mount(<PartnerNetworkPage controller={controller} route="network:host:room" t={((key: string) => key) as Translator} onOpenNavigation={() => {}} />);
    await act(async () => { const input = view.querySelector("textarea")!; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Produce a report"); input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => { button(view, "Arrange work").click(); button(view, "Everyone").click(); });
    await act(async () => { button(view, "Send").click(); await settle(); }); expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toMatchObject({ forcePlan: true, mentionAll: true, mentions: [], text: "Produce a report @Everyone " });
  });
});

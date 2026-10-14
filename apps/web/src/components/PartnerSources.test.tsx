// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { emptySnapshot } from "../model.js";
import { translate } from "../i18n.js";
import type { PartnerSourceView } from "../partner-sources.js";
import { PartnerSources } from "./PartnerSources.js";
let root: Root | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.replaceChildren(); vi.unstubAllGlobals(); });

it("shows same-ID cards grouped by their original node even when the session machine filter excludes both", async () => {
  const openSourcePartner = vi.fn(async () => undefined), refreshPartnerSource = vi.fn(async () => undefined);
  const controller = app([source("node-a"), source("node-b", "offline")], { openSourcePartner, refreshPartnerSource });
  const host = await mount(controller);
  const groups = [...host.querySelectorAll<HTMLElement>("[data-partner-source]")];
  expect(groups).toHaveLength(2); expect(host.querySelectorAll("[data-partner-id='same-partner']")).toHaveLength(2);
  expect(groups[0]?.textContent).toContain("node-a"); expect(groups[1]?.textContent).toContain("Offline");
  await act(async () => { button(groups[0]!, "Open task").click(); await settle(); });
  expect(openSourcePartner).toHaveBeenCalledExactlyOnceWith("node-a", "same-partner", "session");
  expect(button(groups[1]!, "Open task").disabled).toBe(true); expect(button(groups[1]!, "Edit").disabled).toBe(true);
  await act(async () => { button(groups[1]!, "Retry").click(); await settle(); });
  expect(refreshPartnerSource).toHaveBeenCalledExactlyOnceWith("node-b");
});
it("keeps remote archived records out of the live cards and the local archive surface", async () => {
  const live = source("node-a"), controller = app([{ ...live, rows: [...live.rows, { ...live.rows[0]!, id: "archived", lifecycle: "archived" }] }], {});
  const host = await mount(controller);
  expect(host.querySelector("[data-partner-id='archived']")).toBeNull();
  expect(host.querySelector("[data-partner-id='same-partner']")).not.toBeNull();
  await act(async () => { root!.render(<PartnerSources controller={controller} archived t={(key, values) => translate("en", key, values)} />); await settle(); });
  expect(host.querySelector("[data-partner-source]")).toBeNull();
});
it("loads an online image through its own source and opens settings only through fresh source navigation", async () => {
  const row = source("node-b"), image = { sha256: "a".repeat(64), mimeType: "image/png" as const, byteLength: 8 };
  const readSourcePartnerAvatar = vi.fn(async () => "data:image/png;base64,AQ=="), openSourcePartner = vi.fn(async () => { throw new Error("The canonical task changed."); });
  const controller = app([{ ...row, rows: [{ ...row.rows[0]!, avatar: image }] }], { readSourcePartnerAvatar, openSourcePartner });
  const host = await mount(controller);
  expect(readSourcePartnerAvatar).toHaveBeenCalledWith("node-b", "same-partner", 1n, image, expect.any(AbortSignal));
  expect(host.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AQ==");
  await act(async () => { button(host, "Edit").click(); await settle(); });
  expect(openSourcePartner).toHaveBeenCalledWith("node-b", "same-partner", "settings");
  expect(host.querySelector("[role='alert']")?.textContent).toContain("canonical task changed");
});
it.each(["pending", "error"] as const)("opens a %s source row through its original initialization route instead of Task or Profile settings", async initializationState => {
  const row = source("node-b"), openSourcePartner = vi.fn(async () => undefined);
  const controller = app([{ ...row, rows: [{ ...row.rows[0]!, initializationState }] }], { openSourcePartner });
  const host = await mount(controller);
  expect(button(host, "Open task").disabled).toBe(true); expect(button(host, "Edit").disabled).toBe(true);
  await act(async () => { button(host, "Continue initialization").click(); await settle(); });
  expect(openSourcePartner).toHaveBeenCalledExactlyOnceWith("node-b", "same-partner", "preparation");
});
function source(key: string, status: PartnerSourceView["status"] = "online"): PartnerSourceView { return { key, profileId: key, name: key, status, epoch: 1,
  rows: [{ id: "same-partner", revision: 1n, displayName: "Aster", description: "Source Partner", avatar: "orbit", lifecycle: "active", initializationState: "ready", unreadReplyCount: 1 }] }; }
function app(sources: readonly PartnerSourceView[], methods: Record<string, unknown>): AppController { return { state: { ready: true, connectionState: "connected", snapshot: emptySnapshot(), preferences: { ...DEFAULT_UI_PREFERENCES, machineSelection: [] }, partnerSources: sources }, ...methods } as unknown as AppController; }
async function mount(controller: AppController) { const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  await act(async () => { root!.render(<PartnerSources controller={controller} archived={false} t={(key, values) => translate("en", key, values)} />); await settle(); }); return host; }
function button(root: ParentNode, label: string): HTMLButtonElement { const value = [...root.querySelectorAll<HTMLButtonElement>("button")].find(candidate => candidate.textContent?.trim() === label); if (!value) throw new Error("Missing " + label); return value; }
async function settle() { for (let index = 0; index < 10; index += 1) await Promise.resolve(); }

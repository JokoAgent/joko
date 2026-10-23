// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MobilePartnerIdentityApi } from "./mobile-partner-identity";
import type { MobilePartnerDirectoryTransport } from "./mobile-partner-directory";
import type { MobilePartnersColors } from "./MobilePartnersScreen";
vi.mock("expo-crypto", () => ({ randomUUID: () => "test-operation" }));
vi.mock("react-native", () => ({
  ScrollView: ({ children }: { children?: ReactNode }) => createElement("div", {}, children), View: ({ children }: { children?: ReactNode }) => createElement("div", {}, children),
  Text: ({ children, accessibilityRole }: { children?: ReactNode; accessibilityRole?: string }) => createElement("span", { role: accessibilityRole }, children),
  TextInput: ({ accessibilityLabel, value, onChangeText }: { accessibilityLabel?: string; value: string; onChangeText(value: string): void }) => createElement("input", { "aria-label": accessibilityLabel, value, onChange: () => undefined, onInput: (event: { currentTarget: { value: string } }) => onChangeText(event.currentTarget.value) }),
  Pressable: ({ children, accessibilityLabel, disabled, onPress }: { children?: ReactNode; accessibilityLabel: string; disabled?: boolean; onPress(): void }) => createElement("button", { "aria-label": accessibilityLabel, disabled, onClick: onPress }, children),
  StyleSheet: { create: (styles: unknown) => styles }
}));
import { MobilePartnerIdentityScreen } from "./MobilePartnerIdentityScreen";
let root: Root, container: HTMLDivElement;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const colors: MobilePartnersColors = { background: "#fff", surface: "#fff", ink: "#000", muted: "#777", border: "#ddd", accent: "#f90", negative: "#c00", brandBackground: "#fff" };
function fixture() {
  const link = create(contract.PartnerIdentityLinkSchema, { linkId: "link", alias: "Alias", identity: { displayName: "Remote", authorityServerId: "source", partnerId: "partner" } });
  const open = vi.fn(async () => create(contract.OpenPartnerIdentityResponseSchema, { link, intent: { status: "unknown" } }));
  const api = { ownerKey: "home", listPartnerIdentities: vi.fn(async () => create(contract.ListPartnerIdentitiesResponseSchema, { links: [link] })),
    openPartnerIdentity: open, issuePartnerIdentity: vi.fn(async () => create(contract.IssuePartnerIdentityResponseSchema, { invitation: "private-invitation" })) } as unknown as MobilePartnerIdentityApi;
  const directory = { ownerKey: "home", list: async () => ({ partners: [{ partnerId: "partner", revision: 4n, displayName: "Local", lifecycle: "active", canonicalSessionId: "canonical" }] }) } as unknown as MobilePartnerDirectoryTransport;
  return { api, directory, open };
}
async function click(label: string) { const button = Array.from(container.querySelectorAll("button")).find(row => row.getAttribute("aria-label") === label)!; expect(button).toBeDefined(); await act(async () => button.click()); }
it("keeps unknown access recoverable and opens only a confirmed canonical membership", async () => {
  const f = fixture(), onOpen = vi.fn(async () => undefined);
  await act(async () => root.render(<MobilePartnerIdentityScreen api={f.api} colors={colors} locale="en" onBack={() => undefined} onOpen={onOpen} />));
  await click("Open conversation"); expect(onOpen).not.toHaveBeenCalled(); expect(container.querySelector('[role="alert"]')?.textContent).toContain("unconfirmed");
  const joined = create(contract.JoinedTaskShareSchema, { joinId: "joined", status: "active", share: { sessionId: "canonical" } });
  f.open.mockResolvedValueOnce(create(contract.OpenPartnerIdentityResponseSchema, { joined })); await click("Open conversation"); expect(onOpen).toHaveBeenCalledExactlyOnceWith(joined);
});
it("keeps a private issue reply visible after directory refresh and fences a late connection result", async () => {
  const f = fixture(), onOpen = vi.fn(async () => undefined);
  const render = (api: MobilePartnerIdentityApi) => root.render(<MobilePartnerIdentityScreen api={api} directory={f.directory} colors={colors} locale="en" onBack={() => undefined} onOpen={onOpen} />);
  await act(async () => render(f.api)); await click("Issue private access: Local"); expect(container.textContent).toContain("private-invitation");
  expect(f.api.issuePartnerIdentity).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 4n, partnerId: "partner" }), expect.anything());
  let finish!: (value: contract.OpenPartnerIdentityResponse) => void; f.open.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await click("Open conversation"); await act(async () => render({ ...f.api, ownerKey: "new-home" }));
  await act(async () => finish(create(contract.OpenPartnerIdentityResponseSchema, { joined: { joinId: "late", status: "active" } })));
  expect(onOpen).not.toHaveBeenCalled(); expect(container.textContent).not.toContain("private-invitation");
});

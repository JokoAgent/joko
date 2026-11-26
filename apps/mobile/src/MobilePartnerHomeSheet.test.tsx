// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { ListPartnerHomeTargetsResponseSchema, InspectPartnerHomeTargetResponseSchema, MovePartnerHomeResponseSchema, PermissionMode, partnerHomeMessages, type PartnerHomeApi } from "@joko/contracts";
import { expect, it, vi } from "vitest";
vi.mock("react-native", async () => {
  const React = await import("react"), box = ({ children }: { children?: ReactNode }) => React.createElement("div", {}, children);
  return { View: box, Text: box, ScrollView: box, Modal: box, ActivityIndicator: () => null, TextInput: () => null,
    Pressable: ({ children, disabled, onPress }: { children?: ReactNode; disabled?: boolean; onPress(): void }) => React.createElement("button", { disabled, onClick: onPress }, children) };
});
vi.mock("react-native-safe-area-context", async () => { const React = await import("react"); return { SafeAreaView: ({ children }: { children?: ReactNode }) => React.createElement("div", {}, children) }; });
import { MobilePartnerHomeSheet } from "./MobilePartnerHomeSheet";

it.each([false, undefined])("keeps the selected home and input handoff policy %s across a target list refresh", async inputHandoff => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.body.appendChild(document.createElement("div")), root = createRoot(host), text = partnerHomeMessages("en");
  const catalog = create(ListPartnerHomeTargetsResponseSchema, {
    home: { identity: { authorityServerId: "source", partnerId: "partner", generation: 1n }, serviceNode: true, deviceName: "Current" },
    targets: [{ deviceName: "Destination", platform: "macos", available: true, destination: { location: { case: "peer", value: { targetDeviceId: "other", relationId: "relation", routeGeneration: 1n } } } },
      { deviceName: "Second computer", platform: "linux", available: true, destination: { location: { case: "peer", value: { targetDeviceId: "second", relationId: "second-relation", routeGeneration: 1n } } } }]
  });
  const list = vi.fn(async () => catalog);
  const api: PartnerHomeApi = { ownerKey: "owner", list,
    inspect: vi.fn(async () => create(InspectPartnerHomeTargetResponseSchema, { models: [{ displayName: "Native model", route: { backendId: "native", providerId: "provider", modelId: "model" }, permissionModes: [PermissionMode.ASK] }] })),
    move: vi.fn(async () => create(MovePartnerHomeResponseSchema)), status: vi.fn(), retry: vi.fn() };
  const press = async (label: string) => { const button = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(node => node.textContent === label)!; expect(button, label).toBeDefined(); await act(async () => button.click()); };
  try {
    await act(async () => root.render(createElement(MobilePartnerHomeSheet, { api, partnerId: "partner", revision: 2n, inputHandoff, locale: "en", newRequestId: () => "move-request", onClose() {}, onChanged() {},
      colors: { background: "#fff", surface: "#fff", ink: "#111", muted: "#777", border: "#ccc", accent: "#f80", negative: "#c00", brandBackground: "#ffe" } })));
    await press("Destination · macos"); await press("Native model");
    list.mockResolvedValueOnce({ ...catalog, targets: [...catalog.targets].reverse() });
    await press(text.refresh); await press(text.change);
    expect(api.move).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ destination: catalog.targets[0]!.destination,
      capabilities: expect.objectContaining({ inputHandoff: inputHandoff ?? true }) }), expect.any(AbortSignal));
    list.mockResolvedValueOnce({ ...catalog, targets: [catalog.targets[1]!] });
    await press(text.refresh); await press(text.change);
    expect(api.move).toHaveBeenCalledTimes(1);
    expect(api.inspect).toHaveBeenCalledOnce();
    expect(host.textContent).not.toContain("Native model");
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});

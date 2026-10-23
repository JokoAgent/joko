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

it.each([false, undefined])("preserves the captured input handoff policy %s while choosing a new native home", async inputHandoff => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.body.appendChild(document.createElement("div")), root = createRoot(host), text = partnerHomeMessages("en");
  const api: PartnerHomeApi = { ownerKey: "owner", list: vi.fn(async () => create(ListPartnerHomeTargetsResponseSchema, {
    home: { identity: { authorityServerId: "source", partnerId: "partner", generation: 1n }, serviceNode: true, deviceName: "Current" },
    targets: [{ deviceName: "Destination", platform: "macos", available: true, destination: { location: { case: "peer", value: { targetDeviceId: "other", relationId: "relation", routeGeneration: 1n } } } }]
  })), inspect: vi.fn(async () => create(InspectPartnerHomeTargetResponseSchema, { models: [{ displayName: "Native model", route: { backendId: "native", providerId: "provider", modelId: "model" }, permissionModes: [PermissionMode.ASK] }] })),
    move: vi.fn(async () => create(MovePartnerHomeResponseSchema)), status: vi.fn(), retry: vi.fn() };
  const press = async (label: string) => { const button = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(node => node.textContent === label)!; expect(button, label).toBeDefined(); await act(async () => button.click()); };
  try {
    await act(async () => root.render(createElement(MobilePartnerHomeSheet, { api, partnerId: "partner", revision: 2n, inputHandoff, locale: "en", newRequestId: () => "move-request", onClose() {}, onChanged() {},
      colors: { background: "#fff", surface: "#fff", ink: "#111", muted: "#777", border: "#ccc", accent: "#f80", negative: "#c00", brandBackground: "#ffe" } })));
    await press("Destination · macos"); await press("Native model"); await press(text.change);
    expect(api.move).toHaveBeenCalledWith(expect.objectContaining({ capabilities: expect.objectContaining({ inputHandoff: inputHandoff ?? true }) }), expect.any(AbortSignal));
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});

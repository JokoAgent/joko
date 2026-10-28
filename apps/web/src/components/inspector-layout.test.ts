// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCatalogEntryView } from "../model.js";
import { drainInspectorExtensionRequests, inspectorDropEdge, inspectorExtensionIdentity, inspectorLayoutKey, openInspectorExtension, parseInspectorLayout, readInspectorLayout, updateInspectorLayout } from "./inspector-layout.js";

afterEach(() => window.localStorage.clear());
const extensionId = `extension_${"a".repeat(32)}`;
describe("Inspector placement ownership", () => {
  it("keeps remembered placement on its exact pinned node and installed resource generation", () => {
    const owner = JSON.stringify(["profile", "server", "https://node.test", "ed25519:pin"]);
    const extension = { id: extensionId, owner: { kind: "resource", resourceId: "resource", resourceRevision: 2n, discoveredRevision: "sha256:package" } } as ExtensionCatalogEntryView;
    const identity = inspectorExtensionIdentity(extension);
    updateInspectorLayout(owner, value => ({ ...value, plugins: { [identity]: { extensionId, mode: "window", edge: "left", open: true } } }));
    expect(readInspectorLayout(owner).plugins[identity]?.mode).toBe("window");
    expect(readInspectorLayout(owner + ":replacement-pin").plugins).toEqual({});
    expect(inspectorExtensionIdentity({ ...extension, owner: { kind: "resource", resourceId: "resource", resourceRevision: 3n, discoveredRevision: "sha256:package" } })).not.toBe(identity);
  });
  it("updates from fresh storage so another window's close is not overwritten by a group move", () => {
    const owner = "owner", plugin = { extensionId, mode: "sidebar" as const, edge: "bottom" as const, open: false };
    window.localStorage.setItem(inspectorLayoutKey(owner), JSON.stringify({ groups: {}, plugins: { installed: plugin } }));
    const next = updateInspectorLayout(owner, value => ({ ...value, groups: { ...value.groups, taskTab: "left" } }));
    expect(next.plugins.installed?.open).toBe(false);
    expect(readInspectorLayout(owner)).toEqual({ groups: { taskTab: "left" }, plugins: { installed: plugin } });
  });
  it.each([
    '{"groups":{"__proto__":"left"},"plugins":{}}', '{"groups":{"tab":"remote"},"plugins":{}}',
    JSON.stringify({ groups: {}, plugins: { installed: { extensionId, mode: "window", edge: "left", open: true, secret: "extra" } } }),
    JSON.stringify({ groups: {}, plugins: {}, sizes: { right: Infinity } }),
    JSON.stringify({ groups: {}, plugins: {}, sizes: { top: -1 } }),
    JSON.stringify({ groups: {}, plugins: {}, legacyAlias: {} })
  ])("fails closed for malformed current-v1 placement %s", raw => expect(parseInspectorLayout(raw)).toEqual({ groups: {}, plugins: {} }));
  it("chooses all four chat edges without changing the task split tree", () => {
    const bounds = { left: 100, top: 200, width: 600, height: 400 };
    expect(inspectorDropEdge(bounds, 101, 400)).toBe("left"); expect(inspectorDropEdge(bounds, 699, 400)).toBe("right");
    expect(inspectorDropEdge(bounds, 400, 201)).toBe("top"); expect(inspectorDropEdge(bounds, 400, 599)).toBe("bottom");
  });
  it("delivers an early click once after the lazy host loads, only to its original pinned owner", () => {
    const accept = vi.fn(); openInspectorExtension(extensionId, "sidebar", "original-owner");
    drainInspectorExtensionRequests("another-owner", accept); expect(accept).not.toHaveBeenCalled();
    drainInspectorExtensionRequests("original-owner", accept); expect(accept).toHaveBeenCalledExactlyOnceWith(extensionId, "sidebar");
    drainInspectorExtensionRequests("original-owner", accept); expect(accept).toHaveBeenCalledOnce();
  });
});

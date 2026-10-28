import type { ConnectionProfile, ExtensionCatalogEntryView } from "../model.js";

export const INSPECTOR_EDGES = ["left", "right", "top", "bottom"] as const;
export type InspectorEdge = typeof INSPECTOR_EDGES[number];
export type InspectorOpenMode = "page" | "sidebar" | "window";
export interface InspectorPluginPlacement {
  readonly extensionId: string;
  readonly mode: InspectorOpenMode;
  readonly edge: InspectorEdge;
  readonly open: boolean;
}
export interface InspectorLayoutPreferences {
  readonly groups: Readonly<Record<string, InspectorEdge>>;
  readonly plugins: Readonly<Record<string, InspectorPluginPlacement>>;
  readonly sizes?: Readonly<Partial<Record<InspectorEdge, number>>>;
}
const EMPTY: InspectorLayoutPreferences = { groups: {}, plugins: {} };
const LIMIT = 1_000;
const PREFIX = "joko.inspector.layout.v1:";
export const INSPECTOR_EXTENSION_OPEN_EVENT = "joko:inspector-extension-open";
export const INSPECTOR_TAB_DRAG_TYPE = "application/x-joko-inspector-tab";
let requestSequence = 0;
const pendingRequests: { readonly owner: string; readonly id: number; readonly extensionId: string; readonly mode?: InspectorOpenMode | "reset"; readonly expiresAt: number }[] = [];

export function inspectorLayoutOwner(profile: ConnectionProfile | undefined): string | undefined {
  return profile === undefined ? undefined : JSON.stringify([profile.id, profile.serverId, profile.origin, profile.endpointPublicKey]);
}
export function acknowledgeInspectorExtensionRequest(id: unknown): void {
  const index = pendingRequests.findIndex(request => request.id === id); if (index >= 0) pendingRequests.splice(index, 1);
}
export function drainInspectorExtensionRequests(owner: string, accept: (extensionId: string, mode?: InspectorOpenMode | "reset") => void): void {
  for (const request of [...pendingRequests]) {
    if (request.expiresAt < Date.now()) { acknowledgeInspectorExtensionRequest(request.id); continue; }
    if (request.owner !== owner) continue;
    acknowledgeInspectorExtensionRequest(request.id); accept(request.extensionId, request.mode);
  }
}

export function inspectorLayoutKey(owner: string): string { return PREFIX + owner; }
export function inspectorEdge(value: unknown): value is InspectorEdge { return (INSPECTOR_EDGES as readonly unknown[]).includes(value); }
export function inspectorExtensionIdentity(extension: ExtensionCatalogEntryView): string {
  return JSON.stringify([extension.id, extension.owner], (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
}
export function inspectorSessionTabKey(sessionId: string, generation: bigint, tabId: string): string {
  return JSON.stringify([sessionId, generation.toString(), tabId]);
}
export function parseInspectorLayout(raw: string | null): InspectorLayoutPreferences {
  if (raw === null || raw.length > 2 * 1_024 * 1_024) return EMPTY;
  try {
    const value: unknown = JSON.parse(raw);
    if (!record(value) || Object.keys(value).some(key => key !== "groups" && key !== "plugins" && key !== "sizes")
      || !record(value.groups) || !record(value.plugins)
      || Object.keys(value.groups).length > LIMIT || Object.keys(value.plugins).length > LIMIT) return EMPTY;
    const groups: Record<string, InspectorEdge> = {}, plugins: Record<string, InspectorPluginPlacement> = {};
    for (const [key, edge] of Object.entries(value.groups)) {
      if (!safeKey(key) || !inspectorEdge(edge)) return EMPTY;
      Object.defineProperty(groups, key, { value: edge, enumerable: true, configurable: true, writable: true });
    }
    for (const [key, plugin] of Object.entries(value.plugins)) {
      if (!safeKey(key) || !record(plugin) || Object.keys(plugin).sort().join(",") !== "edge,extensionId,mode,open"
        || typeof plugin.extensionId !== "string" || !/^extension_[a-f0-9]{32}$/u.test(plugin.extensionId)
        || !["page", "sidebar", "window"].includes(plugin.mode as string) || !inspectorEdge(plugin.edge)
        || typeof plugin.open !== "boolean") return EMPTY;
      Object.defineProperty(plugins, key, { value: { extensionId: plugin.extensionId, mode: plugin.mode as InspectorOpenMode, edge: plugin.edge, open: plugin.open }, enumerable: true, configurable: true, writable: true });
    }
    const sizes: Partial<Record<InspectorEdge, number>> = {};
    if (value.sizes !== undefined) {
      if (!record(value.sizes) || Object.keys(value.sizes).length > 4) return EMPTY;
      for (const [edge, size] of Object.entries(value.sizes)) {
        if (!inspectorEdge(edge) || typeof size !== "number" || !Number.isFinite(size) || size < 100 || size > 2_048) return EMPTY;
        sizes[edge] = size;
      }
    }
    return { groups, plugins, ...(value.sizes === undefined ? {} : { sizes }) };
  } catch { return EMPTY; }
}
export function readInspectorLayout(owner: string): InspectorLayoutPreferences {
  try { return parseInspectorLayout(window.localStorage.getItem(inspectorLayoutKey(owner))); } catch { return EMPTY; }
}
export function updateInspectorLayout(owner: string, update: (current: InspectorLayoutPreferences) => InspectorLayoutPreferences): InspectorLayoutPreferences {
  const next = update(readInspectorLayout(owner));
  const bounded = { ...next, groups: Object.fromEntries(Object.entries(next.groups).slice(-LIMIT)), plugins: Object.fromEntries(Object.entries(next.plugins).slice(-LIMIT)) };
  try { window.localStorage.setItem(inspectorLayoutKey(owner), JSON.stringify(bounded)); } catch { /* Session placement still works without storage. */ }
  return bounded;
}
export function openInspectorExtension(extensionId: string, mode?: InspectorOpenMode | "reset", owner?: string): void {
  if (!/^extension_[a-f0-9]{32}$/u.test(extensionId)) return;
  const id = ++requestSequence;
  if (owner !== undefined) { pendingRequests.push({ owner, id, extensionId, mode, expiresAt: Date.now() + 5_000 }); if (pendingRequests.length > 8) pendingRequests.shift(); }
  window.dispatchEvent(new CustomEvent(INSPECTOR_EXTENSION_OPEN_EVENT, { detail: { extensionId, mode, owner, id } }));
}
export function inspectorDropEdge(bounds: Pick<DOMRect, "left" | "top" | "width" | "height">, x: number, y: number): InspectorEdge {
  const horizontal = (x - bounds.left) / Math.max(1, bounds.width), vertical = (y - bounds.top) / Math.max(1, bounds.height);
  return Object.entries({ left: horizontal, right: 1 - horizontal, top: vertical, bottom: 1 - vertical })
    .sort((a, b) => a[1] - b[1])[0]![0] as InspectorEdge;
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function safeKey(value: string): boolean { return value.length > 0 && value.length <= 4_096 && !["__proto__", "constructor", "prototype"].includes(value); }

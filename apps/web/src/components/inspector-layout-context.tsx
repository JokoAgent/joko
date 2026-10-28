import { useLayoutEffect, useRef, useSyncExternalStore, type JSX, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface InspectorDockTab {
  readonly key: string;
  readonly owner: string;
  readonly sessionId?: string;
  readonly pluginIdentity?: string;
  readonly label: string;
  readonly kind: string;
  readonly preferred?: boolean;
  readonly node: HTMLElement;
  readonly onActivate: () => void;
  readonly onClose: () => void | Promise<void>;
}
export interface InspectorDockAction { readonly id: string; readonly label: string; readonly disabled?: boolean; readonly run: () => void }

export function moveInspectorMount(parent: HTMLElement, node: HTMLElement): void {
  const move = (parent as HTMLElement & { moveBefore?: (node: HTMLElement, before: Node | null) => void }).moveBefore;
  if (move !== undefined && node.isConnected && parent.isConnected && node.ownerDocument === parent.ownerDocument) {
    try { move.call(parent, node, null); return; } catch { /* Cross-document moves use the guarded fallback. */ }
  }
  parent.append(node);
}

/** Owns UI mounts only. Native tasks, terminals and extension surfaces retain
 * their original controller and lifecycle authority. */
export class InspectorDock {
  readonly tabs = new Map<string, InspectorDockTab>();
  readonly actions = new Map<string, readonly InspectorDockAction[]>();
  readonly sessionOwners = new Map<string, string>();
  readonly preferredByOwner = new Map<string, string>();
  readonly selected = new Map<string, string>();
  readonly windows = new Map<string, string>();
  focusedGroup = "right";
  onTabAdded?: (tab: InspectorDockTab) => void;
  revealTab?: (key: string) => void;
  readonly listeners = new Set<() => void>();
  revision = 0;
  subscribe = (callback: () => void): (() => void) => { this.listeners.add(callback); return () => this.listeners.delete(callback); };
  snapshot = (): number => this.revision;
  changed(): void { this.revision++; for (const callback of [...this.listeners]) callback(); }
  publish(owner: string, tabs: readonly InspectorDockTab[], actions: readonly InspectorDockAction[]): void {
    const previous = [...this.tabs.values()].filter(tab => tab.owner === owner);
    const oldActions = this.actions.get(owner) ?? [];
    const changed = previous.length !== tabs.length || tabs.some((tab, index) => previous[index]?.key !== tab.key || previous[index]?.label !== tab.label)
      || JSON.stringify(oldActions.map(({ id, label, disabled }) => [id, label, disabled])) !== JSON.stringify(actions.map(({ id, label, disabled }) => [id, label, disabled]));
    const keys = new Set(tabs.map(tab => tab.key));
    for (const previousTab of previous) if (!keys.has(previousTab.key)) this.remove(previousTab.key);
    for (const tab of tabs) {
      const added = !this.tabs.has(tab.key);
      this.tabs.set(tab.key, tab);
      if (added) this.onTabAdded?.(tab);
    }
    this.actions.set(owner, actions);
    const preferred = tabs.find(tab => tab.preferred)?.key;
    if (preferred !== undefined && this.preferredByOwner.get(owner) !== preferred) {
      const hadPreferred = this.preferredByOwner.has(owner); this.preferredByOwner.set(owner, preferred);
      if (hadPreferred) queueMicrotask(() => { if (this.tabs.get(preferred)?.owner === owner) this.revealTab?.(preferred); });
    }
    if (changed) this.changed();
  }
  retire(owner: string): void {
    for (const tab of [...this.tabs.values()]) if (tab.owner === owner) this.remove(tab.key);
    this.actions.delete(owner); this.changed();
    this.preferredByOwner.delete(owner);
    for (const [sessionId, candidate] of this.sessionOwners) if (candidate === owner) this.sessionOwners.delete(sessionId);
  }
  private remove(key: string): void { this.tabs.get(key)?.node.remove(); this.tabs.delete(key); this.windows.delete(key); }
}

export function InspectorTabContribution({ dock, owner, sessionId, tabs, actions = [], render }: {
  readonly dock: InspectorDock;
  readonly owner: string;
  readonly sessionId?: string;
  readonly tabs: readonly Omit<InspectorDockTab, "node" | "owner">[];
  readonly actions?: readonly InspectorDockAction[];
  readonly render: (key: string, active: boolean, ownerDocument: Document) => ReactNode;
}): JSX.Element {
  useSyncExternalStore(dock.subscribe, dock.snapshot);
  const mounts = useRef(new Map<string, HTMLElement>());
  for (const tab of tabs) if (!mounts.current.has(tab.key)) {
    const node = document.createElement("div"); node.className = "inspector-dock-mount"; mounts.current.set(tab.key, node);
  }
  useLayoutEffect(() => {
    if (sessionId !== undefined) dock.sessionOwners.set(sessionId, owner);
    dock.publish(owner, tabs.map(tab => ({ ...tab, owner, node: mounts.current.get(tab.key)! })), actions);
    for (const [key, node] of mounts.current) if (!tabs.some(tab => tab.key === key)) { node.remove(); mounts.current.delete(key); }
  });
  useLayoutEffect(() => () => { dock.retire(owner); for (const node of mounts.current.values()) node.remove(); mounts.current.clear(); }, [dock, owner]);
  return <>{tabs.map(tab => {
    const node = mounts.current.get(tab.key)!;
    return createPortal(render(tab.key, !node.hidden && node.isConnected, node.ownerDocument), node, tab.key);
  })}</>;
}

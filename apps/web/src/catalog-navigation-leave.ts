type CatalogLeaveGate = (signal: AbortSignal) => Promise<boolean> | undefined;
const gates = new Set<CatalogLeaveGate>();

/** The mounted catalog editor owns its unsaved draft and discard decision. */
export function registerCatalogNavigationLeave(gate: CatalogLeaveGate): () => void {
  gates.add(gate);
  return () => { gates.delete(gate); };
}

export function requestCatalogNavigationLeave(signal: AbortSignal): Promise<boolean> | undefined {
  if (signal.aborted) return Promise.resolve(false);
  const owners = [...gates];
  if (!owners.length) return undefined;
  return (async () => {
    for (const owner of owners) {
      if (signal.aborted || !gates.has(owner)) return false;
      if (await owner(signal) === false) return false;
    }
    return !signal.aborted;
  })();
}

type PartnerLeaveGate = (signal: AbortSignal) => Promise<boolean> | undefined;
let gate: PartnerLeaveGate | undefined;

/** The mounted original-node editor owns its draft and discard decision. */
export function registerPartnerNavigationLeave(gateOwner: PartnerLeaveGate): () => void {
  gate = gateOwner;
  return () => { if (gate === gateOwner) gate = undefined; };
}
export function requestPartnerNavigationLeave(signal: AbortSignal): Promise<boolean> | undefined {
  if (signal.aborted) return Promise.resolve(false);
  return gate?.(signal);
}

export interface OrderedExtensionState {
  readonly key: string;
  readonly updatedAt: number;
}

/**
 * Extension widgets are insertion ordered upstream. The public service owns a
 * durable update timestamp for each identity, so chronological update order is
 * the stable browser equivalent across events and reconnect snapshots.
 */
export function compareExtensionStateOrder(
  left: OrderedExtensionState,
  right: OrderedExtensionState
): number {
  const timestampOrder = left.updatedAt - right.updatedAt;
  return timestampOrder === 0 ? left.key.localeCompare(right.key) : timestampOrder;
}

/** Keep untrusted footer status on one readable line, matching native UI. */
export function sanitizeExtensionStatusText(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

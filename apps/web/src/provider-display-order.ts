const MAXIMUM_PROVIDER_ORDER_ITEMS = 4_096;
const MAXIMUM_PROVIDER_ID_LENGTH = 4_096;

/**
 * Provider order is an override, not a catalog snapshot. Unknown entries stay
 * persisted so a temporarily unavailable Provider returns to its old slot,
 * while newly observed Providers append in catalog order.
 */
export function normalizeProviderDisplayOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (
      typeof candidate !== "string"
      || candidate.length === 0
      || candidate.length > MAXIMUM_PROVIDER_ID_LENGTH
      || /[\u0000-\u001f\u007f]/u.test(candidate)
      || seen.has(candidate)
    ) continue;
    seen.add(candidate);
    normalized.push(candidate);
    if (normalized.length >= MAXIMUM_PROVIDER_ORDER_ITEMS) break;
  }
  return normalized;
}

export function applyProviderDisplayOrder<T extends { readonly id: string }>(
  providers: readonly T[],
  order: readonly string[]
): T[] {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const included = new Set<string>();
  const result: T[] = [];
  for (const id of order) {
    const provider = byId.get(id);
    if (provider === undefined || included.has(id)) continue;
    included.add(id);
    result.push(provider);
  }
  for (const provider of providers) {
    if (included.has(provider.id)) continue;
    included.add(provider.id);
    result.push(provider);
  }
  return result;
}

/** Replace visible slots without moving temporarily hidden Provider entries. */
export function mergeVisibleProviderDisplayOrder(
  currentOrder: readonly string[],
  reorderedVisibleIds: readonly string[]
): string[] {
  const visible = new Set(reorderedVisibleIds);
  if (visible.size !== reorderedVisibleIds.length) return [...currentOrder];
  const current = new Set(currentOrder);
  if (reorderedVisibleIds.some((id) => !current.has(id))) return [...currentOrder];
  let visibleIndex = 0;
  return currentOrder.map((id) => visible.has(id) ? reorderedVisibleIds[visibleIndex++]! : id);
}

/** Append first-seen Providers, then merge the requested visible ordering. */
export function mergeObservedProviderDisplayOrder(
  currentOrder: readonly string[],
  reorderedVisibleIds: readonly string[]
): string[] {
  const visible = normalizeProviderDisplayOrder(reorderedVisibleIds);
  if (visible.length !== reorderedVisibleIds.length) return [...currentOrder];
  const expanded = [...currentOrder];
  const seen = new Set(currentOrder);
  for (const id of visible) {
    if (seen.has(id)) continue;
    seen.add(id);
    expanded.push(id);
  }
  return mergeVisibleProviderDisplayOrder(expanded, visible);
}

export function moveProviderDisplayOrder(
  visibleProviderIds: readonly string[],
  providerId: string,
  delta: -1 | 1
): string[] {
  const currentIndex = visibleProviderIds.indexOf(providerId);
  const nextIndex = currentIndex + delta;
  if (currentIndex < 0 || nextIndex < 0 || nextIndex >= visibleProviderIds.length) {
    return [...visibleProviderIds];
  }
  const next = [...visibleProviderIds];
  const moved = next.splice(currentIndex, 1)[0];
  if (moved === undefined) return [...visibleProviderIds];
  next.splice(nextIndex, 0, moved);
  return next;
}

const pendingUpdates = new Map<string, Promise<void>>();

export function serializeLocalReceipt(key: string, update: () => Promise<void>): Promise<void> {
  const previous = pendingUpdates.get(key) ?? Promise.resolve();
  const next = previous.then(update, update);
  pendingUpdates.set(key, next);
  return next.finally(() => {
    if (pendingUpdates.get(key) === next) pendingUpdates.delete(key);
  });
}

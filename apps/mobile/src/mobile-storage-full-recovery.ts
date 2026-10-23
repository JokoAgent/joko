export function isMobileStorageFull(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /SQLITE_FULL|database or disk is full/iu.test(message);
}

/** A failed local write may retry once after disposing of message copies; no network action is replayed. */
export function createMobileStorageFullRecovery(write: (key: string, value: string) => Promise<void>,
  reclaim: () => Promise<void>, fullMessage: () => string) {
  let recovery: Promise<void> | undefined;
  return async (key: string, value: string): Promise<void> => {
    try { await write(key, value); return; }
    catch (error) { if (!isMobileStorageFull(error)) throw error; }
    recovery ??= reclaim().catch(() => undefined).finally(() => { recovery = undefined; });
    await recovery;
    try { await write(key, value); }
    catch (error) {
      if (!isMobileStorageFull(error)) throw error;
      throw new Error(fullMessage(), { cause: error });
    }
  };
}

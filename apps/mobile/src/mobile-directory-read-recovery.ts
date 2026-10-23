import { Code, ConnectError } from "@connectrpc/connect";

export const MOBILE_DIRECTORY_STARTUP_TIMEOUT_MS = 10_000;

export function isRecoverableMobileDirectoryRead(error: unknown): boolean {
  if (error instanceof ConnectError) return error.code === Code.Unavailable || error.code === Code.DeadlineExceeded;
  return error instanceof TypeError || error instanceof Error
    && /network|offline|fetch|unreachable|timed?\s*out|timeout/iu.test(error.message);
}

/** A cold or stalled source must release its directory slot without replaying a mutation. */
export function readMobileDirectory<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => { if (timer !== undefined) clearTimeout(timer); signal.removeEventListener("abort", cancel); };
    const fail = (error: unknown): void => { cleanup(); reject(error); };
    const cancel = (): void => fail(signal.reason ?? new Error("The directory read was cancelled."));
    if (signal.aborted) { cancel(); return; }
    timer = setTimeout(() => fail(new Error("The directory read timed out.")), MOBILE_DIRECTORY_STARTUP_TIMEOUT_MS);
    signal.addEventListener("abort", cancel, { once: true });
    void Promise.resolve().then(() => { signal.throwIfAborted(); return read(); })
      .then(value => { cleanup(); resolve(value); }, fail);
  });
}

/** Only failed reads retry, within the same foreground page and exact source identity. */
export function createMobileDirectoryReadRecovery(retry: () => void, current: () => boolean) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let disposed = false;
  const cancel = (): void => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  return {
    failed(error: unknown): void {
      if (disposed || !current() || timer !== undefined || !isRecoverableMobileDirectoryRead(error)) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (!disposed && current()) retry();
      }, Math.min(900 * 2 ** Math.min(attempt++, 6), 30_000));
    },
    succeeded(): void { cancel(); attempt = 0; },
    dispose(): void { disposed = true; cancel(); }
  };
}

import type { MobileAttachmentControls } from "./mobile-attachments";

export const MOBILE_ATTACHMENT_AUTHORITY_RESTORE_TIMEOUT_MS = 30_000;

export function observeMobileAttachmentAuthority(
  previousSurfaceOwnerKey: string | undefined,
  nextSurfaceOwnerKey: string | undefined,
  nativeActivityPending: boolean
): { readonly surfaceOwnerKey: string | undefined; readonly retired: boolean } {
  if (nativeActivityPending && nextSurfaceOwnerKey === undefined) {
    return { surfaceOwnerKey: previousSurfaceOwnerKey, retired: false };
  }
  return {
    surfaceOwnerKey: nextSurfaceOwnerKey,
    retired: previousSurfaceOwnerKey !== nextSurfaceOwnerKey || nextSurfaceOwnerKey === undefined
  };
}

export async function waitForMobileAttachmentAuthority(
  expected: Pick<MobileAttachmentControls, "profileId" | "surfaceOwnerKey">,
  read: () => MobileAttachmentControls | undefined,
  subscribe: (listener: () => void) => () => void,
  options: {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly retired?: () => boolean;
  } = {}
): Promise<MobileAttachmentControls> {
  assertExpectedAuthority(expected);
  const signal = options.signal;
  signal?.throwIfAborted();
  const immediate = readAuthority(read);
  if (immediate) return assertCurrentAuthority(immediate, expected);
  const timeoutMs = options.timeoutMs ?? MOBILE_ATTACHMENT_AUTHORITY_RESTORE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error("The attachment authority restore timeout is invalid.");
  }

  return new Promise<MobileAttachmentControls>((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    let unsubscribeWhenReady = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      signal?.removeEventListener("abort", onAbort);
      if (unsubscribe) unsubscribe();
      else unsubscribeWhenReady = true;
    };
    const resolveOnce = (value: MobileAttachmentControls): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const check = (): void => {
      if (settled) return;
      let current: MobileAttachmentControls | undefined;
      try { current = readAuthority(read); }
      catch (error) { rejectOnce(error); return; }
      if (!current) {
        try {
          if (options.retired?.()) {
            rejectOnce(new Error("Attachment authority retired while the native picker was open."));
          }
        } catch (error) { rejectOnce(error); }
        return;
      }
      try { resolveOnce(assertCurrentAuthority(current, expected)); }
      catch (error) { rejectOnce(error); }
    };
    function onAbort(): void {
      try { signal?.throwIfAborted(); }
      catch (error) { rejectOnce(error); return; }
      rejectOnce(new Error("Attachment preparation was canceled."));
    }

    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => rejectOnce(new Error(
      "The attachment authority did not recover after returning to Joko."
    )), timeoutMs);
    try { unsubscribe = subscribe(check); }
    catch (error) { rejectOnce(error); return; }
    if (unsubscribeWhenReady) unsubscribe();
    check();
  });
}

function assertExpectedAuthority(
  expected: Pick<MobileAttachmentControls, "profileId" | "surfaceOwnerKey">
): void {
  if (!expected || typeof expected.profileId !== "string" || !expected.profileId
    || typeof expected.surfaceOwnerKey !== "string" || !expected.surfaceOwnerKey) {
    throw new Error("The expected attachment authority is invalid.");
  }
}

function readAuthority(read: () => MobileAttachmentControls | undefined): MobileAttachmentControls | undefined {
  const current = read();
  if (current === undefined) return undefined;
  if (!current || typeof current.profileId !== "string" || !current.profileId
    || typeof current.surfaceOwnerKey !== "string" || !current.surfaceOwnerKey) {
    throw new Error("The current attachment authority is invalid.");
  }
  return current;
}

function assertCurrentAuthority(
  current: MobileAttachmentControls,
  expected: Pick<MobileAttachmentControls, "profileId" | "surfaceOwnerKey">
): MobileAttachmentControls {
  if (current.profileId !== expected.profileId || current.surfaceOwnerKey !== expected.surfaceOwnerKey) {
    throw new Error("Attachment authority changed while the native picker was open.");
  }
  return current;
}

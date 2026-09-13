import { useEffect, useState } from "react";

import type { BrowserTakeoverView, BrowserView } from "./model.js";

const MAXIMUM_TIMEOUT_MS = 2_147_483_647;

export function useLiveBrowserTakeover(
  takeover: BrowserTakeoverView | undefined
): BrowserTakeoverView | undefined {
  const expiryIdentity = takeoverExpiryIdentity(takeover);
  const [expiredIdentity, setExpiredIdentity] = useState<string>();

  useEffect(() => {
    if (takeover?.expiresAt === undefined || expiryIdentity === undefined) return;
    const expiresAt = takeover.expiresAt;
    let timer: number | undefined;
    const converge = (): void => {
      const remaining = expiresAt - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) {
        setExpiredIdentity(expiryIdentity);
        return;
      }
      timer = window.setTimeout(converge, Math.min(remaining, MAXIMUM_TIMEOUT_MS));
    };
    converge();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [expiryIdentity, takeover?.expiresAt]);

  if (
    takeover === undefined
    || (expiryIdentity !== undefined && expiryIdentity === expiredIdentity)
    || (takeover.expiresAt !== undefined
      && (!Number.isFinite(takeover.expiresAt) || takeover.expiresAt <= Date.now()))
  ) return undefined;
  return takeover;
}

export function withLiveBrowserTakeover(
  browser: BrowserView,
  takeover: BrowserTakeoverView | undefined
): BrowserView {
  if (browser.takeover === takeover) return browser;
  const { takeover: _expired, ...withoutTakeover } = browser;
  return withoutTakeover;
}

function takeoverExpiryIdentity(takeover: BrowserTakeoverView | undefined): string | undefined {
  if (takeover?.expiresAt === undefined) return undefined;
  return [
    takeover.id,
    takeover.pageId,
    takeover.connectionId,
    takeover.generation.toString(),
    takeover.state,
    takeover.expiresAt
  ].join("\u0000");
}

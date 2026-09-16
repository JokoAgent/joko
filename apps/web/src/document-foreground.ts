import { useEffect, useState } from "react";

/**
 * Tracks whether one concrete renderer Document is allowed to consume passive
 * read state. Visibility alone is insufficient when several application
 * windows show the same durable task; only the focused, shown Document is the
 * foreground reader.
 */
export function useDocumentForeground(ownerDocument?: Document): boolean {
  const [foreground, setForeground] = useState(false);

  useEffect(() => {
    const currentDocument = ownerDocument
      ?? (typeof document === "undefined" ? undefined : document);
    const ownerWindow = currentDocument?.defaultView;
    if (currentDocument === undefined || ownerWindow === null || ownerWindow === undefined) {
      setForeground(false);
      return;
    }

    let shown = true;
    const update = (): void => {
      setForeground(shown
        && currentDocument.visibilityState === "visible"
        && currentDocument.hasFocus());
    };
    const blur = (): void => setForeground(false);
    const pagehide = (): void => {
      shown = false;
      setForeground(false);
    };
    const pageshow = (): void => {
      shown = true;
      update();
    };

    update();
    currentDocument.addEventListener("visibilitychange", update);
    ownerWindow.addEventListener("focus", update);
    ownerWindow.addEventListener("blur", blur);
    ownerWindow.addEventListener("pagehide", pagehide);
    ownerWindow.addEventListener("pageshow", pageshow);
    return () => {
      currentDocument.removeEventListener("visibilitychange", update);
      ownerWindow.removeEventListener("focus", update);
      ownerWindow.removeEventListener("blur", blur);
      ownerWindow.removeEventListener("pagehide", pagehide);
      ownerWindow.removeEventListener("pageshow", pageshow);
    };
  }, [ownerDocument]);

  return foreground;
}

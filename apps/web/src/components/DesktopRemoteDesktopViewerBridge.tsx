import { useEffect } from "react";
import type { AppController } from "../controller.js";
import { desktopRemoteDesktopViewerOwner } from "../remote-desktop-viewer-bridge.js";

export function DesktopRemoteDesktopViewerBridge({ controller }: { readonly controller: AppController }): null {
  const owner = desktopRemoteDesktopViewerOwner(controller.state);
  const key = JSON.stringify(owner);
  useEffect(() => {
    const api = window.jokoDesktop?.remoteDesktopViewer;
    if (owner === undefined || api === undefined) return;
    void api.bind(owner).catch(() => undefined);
    return () => { void api.retire(owner).catch(() => undefined); };
  }, [key]);
  return null;
}

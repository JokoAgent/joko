export function isDesktopRemoteDesktopViewerWindow(location: Pick<Location, "search">): boolean {
  const params = new URLSearchParams(location.search);
  return [...params.keys()].join(",") === "remoteDesktopViewer" && params.get("remoteDesktopViewer") === "1";
}

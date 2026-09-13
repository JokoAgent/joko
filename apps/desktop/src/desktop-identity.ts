export const DESKTOP_APPLICATION_ID = "app.joko.desktop";

export function installWindowsApplicationIdentity(
  platform: NodeJS.Platform,
  setApplicationId: (applicationId: string) => void
): boolean {
  if (platform !== "win32") return false;
  setApplicationId(DESKTOP_APPLICATION_ID);
  return true;
}

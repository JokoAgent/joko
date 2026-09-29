export const MAXIMUM_DESKTOP_NOTIFICATION_TITLE_CHARACTERS = 160;

const DESKTOP_NOTIFICATION_TITLE_PREFIX = "Joko · ";
const DESKTOP_NOTIFICATION_TITLE_ELLIPSIS = "…";
const NATIVE_NOTIFICATION_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/gu;

/** Project user-owned names into the exact bounded native title contract. */
export function projectDesktopNotificationTitle(title: string, fallbackTitle: string): string {
  const subject = sanitizeDesktopNotificationTitle(title).trim()
    || sanitizeDesktopNotificationTitle(fallbackTitle).trim()
    || "Task";
  const projected = `${DESKTOP_NOTIFICATION_TITLE_PREFIX}${subject}`;
  if (projected.length <= MAXIMUM_DESKTOP_NOTIFICATION_TITLE_CHARACTERS) return projected;

  let truncated = projected
    .slice(0, MAXIMUM_DESKTOP_NOTIFICATION_TITLE_CHARACTERS - DESKTOP_NOTIFICATION_TITLE_ELLIPSIS.length)
    .trimEnd();
  // Avoid cutting a UTF-16 surrogate pair at the native boundary.
  if (/[\ud800-\udbff]$/u.test(truncated)) truncated = truncated.slice(0, -1);
  return `${truncated}${DESKTOP_NOTIFICATION_TITLE_ELLIPSIS}`;
}

function sanitizeDesktopNotificationTitle(value: string): string {
  return value.replace(NATIVE_NOTIFICATION_CONTROL_CHARACTERS, " ");
}

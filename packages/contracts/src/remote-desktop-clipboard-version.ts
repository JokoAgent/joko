/** Current-v1 system clipboard version: an OS counter or portable content fingerprint.
 * Treat the value as opaque and compare only for equality. A fingerprint is not an OS CAS.
 */
export function isRemoteDesktopClipboardVersion(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9]{1,128}|[0-9a-f]{64})$/u.test(value);
}

/** Unambiguous client-local key for Provider-scoped opaque Browser page IDs. */
export function browserPageKey(browserId: string, pageId: string): string {
  return `${browserId.length}:${browserId}${pageId}`;
}

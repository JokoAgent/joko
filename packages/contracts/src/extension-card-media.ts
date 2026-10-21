/** Image bytes are fetched through the initiating typed service scope. A hash
 * URI never becomes a global file read or a first-party HTML document. */
export const EXTENSION_CARD_IMAGE_PLACEHOLDER = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
export async function resolveExtensionCardMedia(uris: readonly string[], read: (uri: string) => Promise<string>, signal: AbortSignal,
  cache: Readonly<Record<string, string>> = {}): Promise<Record<string, string>> {
  const result = { ...cache };
  let total = Object.values(result).reduce((size, value) => size + value.length, 0);
  for (const uri of [...new Set(uris)].slice(0, 24)) {
    signal.throwIfAborted();
    if (result[uri] || !/^joko-media:\/\/blobs\/[a-f0-9]{64}\.(png|jpg|jpeg|gif|webp)$/u.test(uri)) continue;
    try {
      const value = await read(uri); signal.throwIfAborted();
      if (value.length > 2 * 1024 * 1024 * 4 / 3 + 128 || !/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]*={0,2}$/u.test(value)) continue;
      if (total + value.length > 8 * 1024 * 1024 * 4 / 3 + 128) break;
      result[uri] = value; total += value.length;
    } catch { signal.throwIfAborted(); }
  }
  return result;
}
export function extensionCardPosterMedia(html: string, media: Readonly<Record<string, string>>): string {
  const images = html.replace(/(<img\b[^>]*?\bsrc=")(joko-media:\/\/blobs\/[a-f0-9]{64}\.(?:png|jpg|jpeg|gif|webp))(")/gu,
    (_match, start: string, uri: string, end: string) => `${start}${media[uri] ?? EXTENSION_CARD_IMAGE_PLACEHOLDER}${end} data-joko-image="${uri}"`);
  return images.replace(/(data-joko-image=")?joko-media:\/\/blobs\/[a-f0-9]{64}\.(?:png|jpg|jpeg|gif|webp)/gu, (uri, marker: string | undefined) => {
    if (marker) return uri;
    const value = media[uri]; return value && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]*={0,2}$/u.test(value) ? value : EXTENSION_CARD_IMAGE_PLACEHOLDER;
  });
}
export function extensionCardAudioUris(html: string): string[] {
  return [...new Set([...html.matchAll(/data-joko-audio="(joko-media:\/\/blobs\/[a-f0-9]{64}\.(?:mp3|wav|m4a))"/gu)].map(match => match[1]!))].slice(0, 16);
}
export function extensionCardInlineImages(images: readonly { cid: string; url: string }[], media: Readonly<Record<string, string>>): { cid: string; url: string }[] {
  return images.map(image => ({ ...image, url: image.url.startsWith("joko-media://") ? media[image.url] ?? EXTENSION_CARD_IMAGE_PLACEHOLDER : image.url }));
}

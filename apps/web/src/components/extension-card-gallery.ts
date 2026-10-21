import type { ExtensionCard } from "@joko/contracts";
export interface ExtensionCardGalleryImage { readonly sessionId: string; readonly cardId: string; readonly uri: string; readonly imageIndex: number }
export function extensionCardGalleryImages(cards: readonly ExtensionCard[]): ExtensionCardGalleryImage[] {
  return cards.flatMap(card => {
    const document = new DOMParser().parseFromString(card.html, "text/html");
    return [...document.querySelectorAll<HTMLImageElement>("img[src]")]
      .filter(image => /^joko-media:\/\/blobs\/[a-f0-9]{64}\.(png|jpg|jpeg|gif|webp)$/u.test(image.getAttribute("src") ?? "")
        && !image.closest("[data-joko-action],[data-joko-link]") && !image.hasAttribute("data-joko-model"))
      .map((image, imageIndex) => ({ sessionId: card.sessionId, cardId: card.cardId, uri: image.getAttribute("src")!, imageIndex }));
  });
}

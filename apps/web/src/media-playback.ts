const playingMedia = new WeakMap<Document, HTMLMediaElement>();

/** Keep audio and video playback exclusive within each app document. */
export function registerExclusiveMediaPlayback(media: HTMLMediaElement | null): (() => void) | undefined {
  if (media === null) return undefined;
  const owner = media.ownerDocument;
  const release = (): void => {
    if (playingMedia.get(owner) === media) playingMedia.delete(owner);
  };
  const play = (): void => {
    const previous = playingMedia.get(owner);
    playingMedia.set(owner, media);
    if (previous !== undefined && previous !== media) previous.pause();
  };
  media.addEventListener("play", play);
  media.addEventListener("pause", release);
  media.addEventListener("ended", release);
  return () => {
    media.removeEventListener("play", play);
    media.removeEventListener("pause", release);
    media.removeEventListener("ended", release);
    if (playingMedia.get(owner) === media) {
      release();
      media.pause();
    }
  };
}

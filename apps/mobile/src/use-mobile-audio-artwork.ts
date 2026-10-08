import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { MobileClient } from "./mobile-client";
import type { MobileFilePreview } from "./workspace-files";
import { mobileAudioMetadataSourceKey } from "./mobile-audio-metadata";

type ArtworkState = { readonly state: "placeholder" | "loading" | "error" }
  | { readonly state: "ready"; readonly uri: string; readonly sourceKey: string };

/** Cover reads have their own lifetime; this hook never releases or keys the audio player. */
export function useMobileAudioArtwork(client: MobileClient, preview: MobileFilePreview | undefined): {
  readonly ownerKey: string | undefined;
  readonly artwork: ArtworkState;
  readonly onDecoded: (sourceKey: string, width: number, height: number) => void;
  readonly onError: (sourceKey: string) => void;
} {
  const audio = preview?.kind === "media" && preview.mediaKind === "audio" ? preview : undefined;
  const ownerKey = audio && client.audioPreviewOwnerKey(audio);
  const cover = audio?.audioMetadata?.kind === "sound_effect" ? undefined : audio?.audioMetadata?.artwork;
  const sourceKey = ownerKey && cover ? JSON.stringify([ownerKey, mobileAudioMetadataSourceKey(audio?.audioMetadata)]) : undefined;
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [resolved, setResolved] = useState<{ readonly key: string; readonly value: ArtworkState }>();
  const currentKey = useRef(sourceKey); currentKey.current = sourceKey;
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => setForeground(state === "active"));
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (!audio || !cover || !sourceKey || !foreground) { setResolved(undefined); return; }
    const controller = new AbortController(); let active = true;
    const current = (): boolean => active && !controller.signal.aborted && currentKey.current === sourceKey;
    setResolved({ key: sourceKey, value: { state: "loading" } });
    const timer = setTimeout(() => {
      if (current()) setResolved({ key: sourceKey, value: { state: "error" } });
      controller.abort();
    }, 20_000);
    void client.readAudioArtwork(audio, controller.signal).then((result) => {
      if (current()) setResolved({ key: sourceKey, value: { state: "ready", uri: result.uri, sourceKey } });
    }, () => {
      if (current()) setResolved({ key: sourceKey, value: { state: "error" } });
    }).finally(() => clearTimeout(timer));
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [audio, client, foreground, sourceKey]);
  const fail = (key: string): void => {
    if (key === currentKey.current && foreground) setResolved({ key, value: { state: "error" } });
  };
  return { ownerKey, artwork: !foreground || !sourceKey ? { state: "placeholder" }
    : resolved?.key === sourceKey ? resolved.value : { state: "loading" },
  onDecoded: (key, width, height) => {
    if (key === currentKey.current && cover && (width !== cover.width || height !== cover.height)) fail(key);
  }, onError: fail };
}

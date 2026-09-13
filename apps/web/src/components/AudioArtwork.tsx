import { Music2 } from "lucide-react";
import { createContext, useContext, useLayoutEffect, useState, type JSX } from "react";
import type { AudioArtifactMetadataView } from "../model.js";

export const AudioArtworkContext = createContext<{
  readonly acquire: (blobId: string) => Promise<string>;
  readonly release: (blobId: string) => void;
} | undefined>(undefined);

/** Owns an independent authenticated lease; cover changes never touch audio. */
export function AudioArtwork({ artwork, ownerKey }: { readonly artwork?: AudioArtifactMetadataView["artwork"]; readonly ownerKey: string }): JSX.Element {
  return <ArtworkSource key={JSON.stringify([ownerKey, artwork?.blobId])} artwork={artwork} />;
}

function ArtworkSource({ artwork }: { readonly artwork: AudioArtifactMetadataView["artwork"] | undefined }): JSX.Element {
  const gateway = useContext(AudioArtworkContext);
  const [node, setNode] = useState<HTMLSpanElement | null>(null);
  const [url, setUrl] = useState<string>();
  const [epoch, setEpoch] = useState(0);
  const [failed, setFailed] = useState(false);
  const ownerDocument = node?.ownerDocument;
  useLayoutEffect(() => { setFailed(false); }, [gateway]);
  useLayoutEffect(() => {
    if (artwork === undefined || gateway === undefined || node === null || ownerDocument === undefined) return;
    let active = true;
    let acquired = false;
    let released = false;
    const ownerWindow = ownerDocument.defaultView;
    const release = (): void => { if (acquired && !released) { released = true; gateway.release(artwork.blobId); } };
    const current = (): boolean => active && node.isConnected && node.ownerDocument === ownerDocument;
    const retire = (): void => { active = false; release(); setUrl(undefined); };
    const restore = (): void => { if (!active && node.isConnected && node.ownerDocument === ownerDocument) { setFailed(false); setEpoch((value) => value + 1); } };
    setUrl(undefined);
    if (!failed) void gateway.acquire(artwork.blobId).then((value) => {
      acquired = true;
      if (!current()) release();
      else setUrl(value);
    }).catch(() => { if (current()) setFailed(true); });
    ownerWindow?.addEventListener("pagehide", retire);
    ownerWindow?.addEventListener("pageshow", restore);
    return () => {
      active = false; release();
      ownerWindow?.removeEventListener("pagehide", retire);
      ownerWindow?.removeEventListener("pageshow", restore);
    };
  }, [artwork?.blobId, epoch, failed, gateway, node, ownerDocument]);
  return <span ref={setNode} className="audio-preview__art" data-artwork-state={failed ? "error" : url === undefined ? "placeholder" : "ready"}>
    {url === undefined ? <Music2 aria-hidden="true" /> : <img src={url} alt={artwork?.alt ?? ""} onError={() => setFailed(true)} />}
  </span>;
}

import { useEffect, useState } from "react";
import { downloadArtifactUrl } from "../artifact-download.js";
import { richLabel, richMediaNetworkUrl, richMediaSource, richString, youtubeVideo, type RichNode } from "@joko/contracts";
import { AudioPreview } from "./AudioPreview.js";
import { VideoPreview } from "./VideoPreview.js";
import { WorkspaceImageLightbox } from "./WorkspaceImageLightbox.js";
import { TimelineMarkdownLink, type TimelineReferenceActions, type TimelineWorkspaceAsset } from "./TimelineReferenceContent.js";

export function RichAnswerMedia({ node, actions }: { readonly node: RichNode; readonly actions: TimelineReferenceActions }) {
  const source = richMediaSource(node);
  const site = node.kind === "video" && source ? youtubeVideo(source) : null;
  if (site) return <VideoSitePreview key={site.embed} site={site} actions={actions} label={richLabel(node, {}) || "YouTube"} />;
  return <OwnedMedia key={JSON.stringify([actions.ownerKey, source, node.kind])} node={node} source={source} actions={actions} />;
}

function OwnedMedia({ node, source, actions }: { readonly node: RichNode; readonly source: string | null; readonly actions: TimelineReferenceActions }) {
  const [asset, setAsset] = useState<TimelineWorkspaceAsset>();
  const [failed, setFailed] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [imageTrigger, setImageTrigger] = useState<HTMLButtonElement | null>(null);
  const network = source ? richMediaNetworkUrl(source) : undefined;
  const name = richLabel(node, {}) || richString(node, "alt") || source || "";
  const { t } = actions;
  useEffect(() => {
    let current = true;
    let acquired: TimelineWorkspaceAsset | undefined;
    const release = () => { acquired?.release(); acquired = undefined; setAsset(undefined); setImageTrigger(null); };
    setFailed(false);
    if (source && !network && actions.onLoadWorkspaceAsset) {
      void actions.onLoadWorkspaceAsset(source).then(value => {
        if (!current) { value.release(); return; }
        if (!value.mediaType?.startsWith(node.kind + "/")) { value.release(); setFailed(true); return; }
        acquired = value; setAsset(value);
      }, () => { if (current) setFailed(true); });
    } else if (!source || !network) setFailed(true);
    const hide = () => { current = false; release(); };
    const show = () => setEpoch(value => value + 1);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    return () => { current = false; acquired?.release(); window.removeEventListener("pagehide", hide); window.removeEventListener("pageshow", show); };
  }, [source, network, node.kind, actions.onLoadWorkspaceAsset, epoch]);
  const url = network ?? asset?.url;
  const ownerKey = JSON.stringify([actions.ownerKey, actions.sessionId, node.id, source]);
  if (failed) return <span role="status">{t("timeline.mediaUnavailable")} {name}</span>;
  if (!url) return <span role="status">{t("timeline.mediaLoading")}</span>;
  if (node.kind === "image") return <>
    <button type="button" className="timeline-workspace-image" aria-label={`${t("workspace.imageOpen")}: ${name}`} onClick={event => setImageTrigger(event.currentTarget)}>
      <img className="rich-answer__image" src={url} alt={name} loading="lazy" referrerPolicy="no-referrer" onError={() => { setImageTrigger(null); setFailed(true); }} />
    </button>
    {imageTrigger && <WorkspaceImageLightbox ownerKey={ownerKey} src={url} name={name} mediaType={asset?.mediaType}
      returnFocus={imageTrigger} onClose={() => setImageTrigger(null)} onImageError={() => { setImageTrigger(null); setFailed(true); }}
      onDownload={context => downloadArtifactUrl(url, name, context)} onSendToChat={actions.onWorkspaceImageToComposer}
      labels={{ close: t("common.close"), copy: t("workspace.imageCopy"), copied: t("workspace.imageCopied"), copyFailed: t("workspace.imageCopyFailed"),
        saveAs: t("workspace.imageSaveAs"), saveFailed: t("workspace.imageSaveFailed"), annotate: t("workspace.imageAnnotate"),
        discardAnnotation: t("workspace.imageDiscardAnnotation"), undoAnnotation: t("workspace.imageUndoAnnotation"),
        sendToChat: t("workspace.imageSendToChat"), sendFailed: t("workspace.imageSendFailed") }} />}
  </>;
  if (node.kind === "audio") return <AudioPreview src={url} ownerKey={ownerKey} name={name}
    labels={{ player: t("timeline.audioPlayer", { name }), loading: t("timeline.mediaLoading"), unavailable: t("timeline.mediaUnavailable"),
      copyDescription: t("media.copyDescription"), copying: t("media.copyingDescription"), copied: t("media.descriptionCopied"), copyFailed: t("media.descriptionCopyFailed") }} />;
  return <VideoPreview src={url} ownerKey={ownerKey} onError={() => setFailed(true)} labels={{ open: t("media.openVideo", { name }),
    player: t("timeline.videoPlayer", { name }), loading: t("timeline.mediaLoading"), unavailable: t("timeline.mediaUnavailable"), close: t("common.close"), playBlocked: t("media.playBlocked") }} />;
}

function VideoSitePreview({ site, label, actions }: {
  readonly site: NonNullable<ReturnType<typeof youtubeVideo>>; readonly label: string; readonly actions: TimelineReferenceActions;
}) {
  const [active, setActive] = useState(false);
  useEffect(() => {
    const release = () => setActive(false);
    const visibility = () => { if (document.visibilityState === "hidden") release(); };
    window.addEventListener("pagehide", release); document.addEventListener("visibilitychange", visibility);
    return () => { window.removeEventListener("pagehide", release); document.removeEventListener("visibilitychange", visibility); };
  }, []);
  return <div className="rich-answer__video-site">
    {active ? <iframe title={label} src={site.embed} allow="encrypted-media; fullscreen; picture-in-picture" allowFullScreen
      referrerPolicy="strict-origin-when-cross-origin" onError={() => setActive(false)} />
      : <button type="button" aria-label={actions.t("media.openVideo", { name: label })} onClick={() => setActive(true)}>
        <img src={site.poster} alt="" loading="lazy" referrerPolicy="no-referrer" /><span>▶ {label}</span></button>}
    <TimelineMarkdownLink href={site.watch} actions={actions}>YouTube ↗</TimelineMarkdownLink>
  </div>;
}

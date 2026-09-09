import { downloadArtifactUrl } from "../artifact-download.js";
import { useEffect, useState, type JSX, type RefObject } from "react";

import { WorkspaceImageLightbox, type WorkspaceImageLightboxLabels } from "./WorkspaceImageLightbox.js";
import {
  WORKSPACE_MARKDOWN_IMAGE_OPEN_EVENT,
  type WorkspaceMarkdownImageOpenDetail
} from "./workspace-markdown-images.js";

export function WorkspaceMarkdownImageHost({
  ownerKey,
  rootRef,
  labels,
  onSendToChat
}: {
  readonly ownerKey: string;
  readonly rootRef: RefObject<HTMLElement | null>;
  readonly labels: WorkspaceImageLightboxLabels;
  readonly onSendToChat?: (file: File) => void | Promise<void>;
}): JSX.Element | null {
  const [opened, setOpen] = useState<{ readonly ownerKey: string; readonly detail: WorkspaceMarkdownImageOpenDetail }>();
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    setOpen(undefined);
    const receive = (event: Event): void => {
      const detail = (event as CustomEvent<WorkspaceMarkdownImageOpenDetail>).detail;
      const elementType = root.ownerDocument.defaultView?.HTMLElement;
      if (typeof detail?.url !== "string" || detail.url === "" || elementType === undefined
        || !(detail.returnFocus instanceof elementType) || !root.isConnected || !detail.returnFocus.isConnected
        || detail.returnFocus.ownerDocument !== root.ownerDocument || !root.contains(detail.returnFocus)
        || event.target !== detail.returnFocus) return;
      event.stopPropagation();
      setOpen({ ownerKey, detail });
    };
    root.addEventListener(WORKSPACE_MARKDOWN_IMAGE_OPEN_EVENT, receive);
    return () => root.removeEventListener(WORKSPACE_MARKDOWN_IMAGE_OPEN_EVENT, receive);
  }, [ownerKey, rootRef]);
  const open = opened?.ownerKey === ownerKey ? opened.detail : undefined;
  if (open === undefined) return null;
  return <WorkspaceImageLightbox
    ownerKey={JSON.stringify([ownerKey, open.url])}
    src={open.url}
    name={open.name}
    mediaType={open.mediaType}
    labels={labels}
    returnFocus={open.returnFocus}
    onClose={() => setOpen(undefined)}
    onDownload={(context) => downloadArtifactUrl(open.url, open.name, context)}
    onSendToChat={onSendToChat}
  />;
}

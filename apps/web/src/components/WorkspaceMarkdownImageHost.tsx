import { useEffect, useState, type JSX } from "react";

import { WorkspaceImageLightbox, type WorkspaceImageLightboxLabels } from "./WorkspaceImageLightbox.js";
import {
  WORKSPACE_MARKDOWN_IMAGE_OPEN_EVENT,
  type WorkspaceMarkdownImageOpenDetail
} from "./workspace-markdown-images.js";

export function WorkspaceMarkdownImageHost({
  labels,
  onSendToChat
}: {
  readonly labels: WorkspaceImageLightboxLabels;
  readonly onSendToChat?: (file: File) => void | Promise<void>;
}): JSX.Element | null {
  const [open, setOpen] = useState<WorkspaceMarkdownImageOpenDetail>();
  useEffect(() => {
    const receive = (event: Event): void => {
      const detail = (event as CustomEvent<WorkspaceMarkdownImageOpenDetail>).detail;
      if (detail?.url === undefined || detail.returnFocus === undefined) return;
      setOpen(detail);
    };
    window.addEventListener(WORKSPACE_MARKDOWN_IMAGE_OPEN_EVENT, receive);
    return () => window.removeEventListener(WORKSPACE_MARKDOWN_IMAGE_OPEN_EVENT, receive);
  }, []);
  if (open === undefined) return null;
  return <WorkspaceImageLightbox
    src={open.url}
    name={open.name}
    mediaType={open.mediaType}
    labels={labels}
    returnFocus={open.returnFocus}
    onClose={() => setOpen(undefined)}
    onDownload={() => downloadWorkspaceMarkdownImage(open.url, open.name)}
    onSendToChat={onSendToChat}
  />;
}

function downloadWorkspaceMarkdownImage(url: string, name: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name || "image";
  anchor.rel = "noopener";
  anchor.click();
}

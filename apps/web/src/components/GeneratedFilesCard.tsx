import { useContext, useState, type JSX } from "react";
import { ChevronDown, ChevronUp, FileText, FolderOpen } from "lucide-react";

import type { OperationApi, TimelineDocumentFileView, TimelineGeneratedFileView } from "../model.js";
import { ArtifactDownloadButton } from "./ArtifactDownloadButton.js";
import { NativeArtifactFileActionsMenu, NativeFileActionsContext } from "./NativeFileCopyMenu.js";
import type { Translator } from "./types.js";
import { formatBytes, IconButton } from "./ui.js";
import "./generated-files.css";

export const MAXIMUM_COLLAPSED_GENERATED_FILES = 6;

export function GeneratedFilesCard({ files = [], documents = [], workspaceId, t, onOpenFile, onDownload, connectionOwner }: {
  readonly files?: readonly TimelineGeneratedFileView[];
  readonly documents?: readonly TimelineDocumentFileView[];
  readonly workspaceId?: string;
  readonly t: Translator;
  readonly onOpenFile?: (relativePath: string) => void;
  readonly onDownload?: OperationApi["downloadArtifact"];
  readonly connectionOwner?: unknown;
}): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const entries = [...documents.map(document => ({ document })), ...files.map(file => ({ file }))];
  if (entries.length === 0) return null;
  const visible = expanded ? entries : entries.slice(0, MAXIMUM_COLLAPSED_GENERATED_FILES);
  const hiddenCount = entries.length - visible.length;
  return (
    <section className="generated-files" aria-label={t("timeline.generatedFiles")}>
      <header className="generated-files__header">
        <span>{t("timeline.generatedFiles")}</span>
        <small>{t("timeline.generatedFilesCount", { count: entries.length })}</small>
      </header>
      <div className="generated-files__chips">
        {visible.map(entry => "document" in entry ? <GeneratedDocumentFile
          key={JSON.stringify([entry.document.workspaceId, entry.document.relativePath])} file={entry.document} t={t} connectionOwner={connectionOwner}
          onDownload={onDownload} onOpenFile={entry.document.workspaceId === workspaceId ? onOpenFile : undefined} /> : (
          <button
            className="generated-file-chip"
            type="button"
            title={entry.file.relativePath}
            aria-label={t("timeline.openGeneratedFile", { name: entry.file.displayName })}
            onClick={() => onOpenFile?.(entry.file.relativePath)}
            key={entry.file.relativePath}
          >
            <FileText aria-hidden="true" />
            <span>{entry.file.displayName}</span>
          </button>
        ))}
        {hiddenCount > 0 && (
          <button
            className="generated-files__toggle"
            type="button"
            aria-label={`${t("timeline.showMore")}: ${t("timeline.generatedFilesCount", { count: hiddenCount })}`}
            onClick={() => setExpanded(true)}
          >
            <span>{t("timeline.generatedFilesCount", { count: hiddenCount })}</span>
            <ChevronDown aria-hidden="true" />
          </button>
        )}
        {expanded && entries.length > MAXIMUM_COLLAPSED_GENERATED_FILES && (
          <button
            className="generated-files__toggle"
            type="button"
            aria-label={t("timeline.showLess")}
            onClick={() => setExpanded(false)}
          >
            <span>{t("timeline.showLess")}</span>
            <ChevronUp aria-hidden="true" />
          </button>
        )}
      </div>
    </section>
  );
}

function GeneratedDocumentFile({ file, t, onOpenFile, onDownload, connectionOwner }: {
  readonly file: TimelineDocumentFileView;
  readonly t: Translator;
  readonly onOpenFile?: (relativePath: string) => void;
  readonly onDownload?: OperationApi["downloadArtifact"];
  readonly connectionOwner: unknown;
}): JSX.Element {
  const nativeActions = useContext(NativeFileActionsContext);
  const { artifact, format, theme, cover, subtitle, count, slide, sheet } = file;
  const ownerKey = JSON.stringify([artifact.sourceSessionId, file.workspaceId, file.relativePath, artifact.blobId]);
  const summary = count !== undefined && format === "pptx" ? t("timeline.documentSlides", { count })
    : count !== undefined && format === "xlsx" ? t("timeline.documentSheets", { count }) : formatBytes(artifact.byteSize);
  const themeLabel = theme === undefined ? undefined : t(`timeline.documentTheme.${theme}`);
  return <article className="generated-document" data-document-format={format} data-document-theme={theme} title={file.relativePath}>
    {sheet !== undefined ? <table className="generated-document__preview" aria-label={artifact.title}>
      {sheet.columns.length > 0 && <thead><tr>{sheet.columns.map((cell, index) => <th scope="col" key={index}>{cell}</th>)}</tr></thead>}
      <tbody>{sheet.rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody>
    </table> : (slide !== undefined || cover === true) && <div className="generated-document__preview generated-document__cover">
      <FileText aria-hidden="true" />
      <span>{slide?.title ?? artifact.title}</span>
      {(slide?.subtitle ?? subtitle) && <small>{slide?.subtitle ?? subtitle}</small>}
    </div>}
    <div className="generated-document__details">
      <div className="generated-document__name">
        <strong>{artifact.title}</strong>
        {artifact.title !== file.displayName && <small>{file.displayName}</small>}
        <small>{[format.toUpperCase(), themeLabel, summary].filter(Boolean).join(" · ")}</small>
      </div>
      {onOpenFile !== undefined && <IconButton label={t("timeline.showGeneratedFileInFiles", { name: file.displayName })}
        onClick={() => onOpenFile(file.relativePath)}><FolderOpen aria-hidden="true" /></IconButton>}
      <NativeArtifactFileActionsMenu actions={nativeActions} artifact={artifact} ownerKey={ownerKey} t={t} />
      {onDownload !== undefined && <ArtifactDownloadButton iconOnly ownerKey={ownerKey} connectionOwner={connectionOwner}
        label={t("timeline.downloadArtifact", { name: artifact.fileName })} errorLabel={t("workspace.downloadUnavailable")}
        action={context => onDownload(artifact.blobId, artifact.fileName, context)} />}
    </div>
  </article>;
}

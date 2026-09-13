import { useState, type JSX } from "react";
import { ChevronDown, ChevronUp, FileText } from "lucide-react";

import type { TimelineGeneratedFileView } from "../model.js";
import type { Translator } from "./types.js";
import "./generated-files.css";

export const MAXIMUM_COLLAPSED_GENERATED_FILES = 6;

export function GeneratedFilesCard({ files, t, onOpenFile }: {
  readonly files: readonly TimelineGeneratedFileView[];
  readonly t: Translator;
  readonly onOpenFile: (relativePath: string) => void;
}): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  if (files.length === 0) return null;
  const visible = expanded ? files : files.slice(0, MAXIMUM_COLLAPSED_GENERATED_FILES);
  const hiddenCount = files.length - visible.length;
  return (
    <section className="generated-files" aria-label={t("timeline.generatedFiles")}>
      <header className="generated-files__header">
        <span>{t("timeline.generatedFiles")}</span>
        <small>{t("timeline.generatedFilesCount", { count: files.length })}</small>
      </header>
      <div className="generated-files__chips">
        {visible.map((file) => (
          <button
            className="generated-file-chip"
            type="button"
            title={file.relativePath}
            aria-label={t("timeline.openGeneratedFile", { name: file.displayName })}
            onClick={() => onOpenFile(file.relativePath)}
            key={file.relativePath}
          >
            <FileText aria-hidden="true" />
            <span>{file.displayName}</span>
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
        {expanded && files.length > MAXIMUM_COLLAPSED_GENERATED_FILES && (
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

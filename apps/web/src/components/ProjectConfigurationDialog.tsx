import { useState, type JSX } from "react";
import type { ProjectConversionCandidate } from "../project-configuration-conversion.js";
import type { Translator } from "./types.js";
import { Button, Modal } from "./ui.js";

export type ProjectConfigurationDecision = "cancel" | "skip" | ReadonlySet<ProjectConversionCandidate["category"]>;

export function ProjectConfigurationDialog({ candidates, ownerDocument, onDecision, t }: {
  readonly candidates: readonly ProjectConversionCandidate[];
  readonly ownerDocument: Document;
  readonly onDecision: (decision: ProjectConfigurationDecision) => void;
  readonly t: Translator;
}): JSX.Element {
  const [selected, setSelected] = useState<SelectCategories>(new Set());
  return <Modal open ownerDocument={ownerDocument} title={t("newTask.projectConversion.title")}
    description={t("newTask.projectConversion.description")} onClose={() => onDecision("cancel")} showClose>
    <ul className="project-configuration-choices">
      {candidates.map(candidate => <li key={candidate.category}>
        <label>
          <input type="checkbox" checked={selected.has(candidate.category)} onChange={event => {
            const next = new Set(selected);
            if (event.target.checked) next.add(candidate.category);
            else next.delete(candidate.category);
            setSelected(next);
          }} />
          {t(`newTask.projectConversion.${candidate.category}`)}
        </label>
        <ul>
          {[...candidate.writes, ...(candidate.copies ?? [])].map(output =>
            <li key={output.path}><code>{output.path}</code></li>)}
        </ul>
      </li>)}
    </ul>
    <div className="modal__actions">
      <Button tone="ghost" onClick={() => onDecision("cancel")}>{t("common.cancel")}</Button>
      <Button onClick={() => onDecision("skip")}>{t("newTask.projectConversion.skip")}</Button>
      <Button tone="primary" disabled={selected.size === 0} onClick={() => onDecision(selected)}>{t("newTask.projectConversion.convert")}</Button>
    </div>
  </Modal>;
}

type SelectCategories = ReadonlySet<ProjectConversionCandidate["category"]>;

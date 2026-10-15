import type { JSX } from "react";
import type { PersonalDevelopmentOperation } from "@joko/contracts";
import type { Translator } from "./types.js";
import { Spinner } from "./ui.js";

export function PersonalDevelopmentProgress({ operation, t }: { readonly operation: PersonalDevelopmentOperation; readonly t: Translator }): JSX.Element {
  const stage = operation.stage;
  const label = stage.startsWith("cloning") || stage.startsWith("fetching") ? "downloadingSource"
    : stage.includes("dependencies") || stage.includes("install") && !stage.startsWith("installing:") ? "dependencies"
      : stage.startsWith("installing:") ? "downloadingTools" : stage.includes("build") || operation.kind === "build" ? "building"
        : operation.kind.includes("source") ? "source" : "environment";
  const percent = operation.percent !== undefined && Number.isFinite(operation.percent) ? Math.max(0, Math.min(100, operation.percent)) : undefined;
  return <div className="personal-development-progress" role="status"><span>{operation.status === "running" && <Spinner />}{t(`personalDevelopment.${label}`)}{percent === undefined ? "" : ` · ${Math.round(percent)}%`}</span>
    {percent !== undefined && <progress max={100} value={percent} aria-label={t(`personalDevelopment.${label}`)} />}
    {operation.dependencyProgress && <small>{t("personalDevelopment.dependencyCounts", { resolved: operation.dependencyProgress.resolved.toString(), reused: operation.dependencyProgress.reused.toString(), downloaded: operation.dependencyProgress.downloaded.toString(), added: operation.dependencyProgress.added.toString() })}</small>}
    {operation.diagnostics.length > 0 && <details><summary>{t("personalDevelopment.diagnostics")}</summary>{operation.diagnostics.map((diagnostic, index) => <p key={index}>{t(diagnostic.code === "PROCESS_UNKNOWN" ? "personalDevelopment.processUnknown" : "personalDevelopment.failed")}{diagnostic.exitCode === undefined ? "" : ` (${diagnostic.exitCode})`}</p>)}</details>}
  </div>;
}

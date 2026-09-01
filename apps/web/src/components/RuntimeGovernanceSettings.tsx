import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";

import type { AppController } from "../controller.js";
import type { AgentResourceSettingsView, AppSnapshot, CollaborationSettingsView, GitSafetySettingsView } from "../model.js";
import type { RunAction, Translator } from "./types.js";
import { Button, Pill, cx, CheckboxControl, SwitchControl } from "./ui.js";

type AgentPreset = "full" | "balanced" | "background";

export function RuntimeGovernanceSettings({ controller, snapshot, runAction, t }: {
  readonly controller: AppController;
  readonly snapshot: AppSnapshot;
  readonly runAction: RunAction;
  readonly t: Translator;
}): JSX.Element {
  const agent = snapshot.settings.agentResource;
  const collaboration = snapshot.settings.collaboration;
  const gitSafety = snapshot.settings.gitSafety;

  return <>
    <CollaborationSettings
      controller={controller}
      settings={collaboration}
      runAction={runAction}
      t={t}
    />
    <AgentResourceSettings
      controller={controller}
      settings={agent}
      runAction={runAction}
      t={t}
    />
    <GitSafetySettings controller={controller} settings={gitSafety} runAction={runAction} t={t} />
  </>;
}

function AgentResourceSettings({ controller, settings, runAction, t }: {
  readonly controller: AppController;
  readonly settings: AgentResourceSettingsView;
  readonly runAction: RunAction;
  readonly t: Translator;
}): JSX.Element {
  const [maxDraft, setMaxDraft] = useState(String(settings.maxConcurrentCommands));
  useEffect(() => setMaxDraft(String(settings.maxConcurrentCommands)), [settings.maxConcurrentCommands]);
  const activePreset = useMemo(() => matchingPreset(settings), [settings]);

  const submitMax = (): void => {
    const normalized = integerDraft(maxDraft, 0, 64);
    if (normalized === undefined || normalized === settings.maxConcurrentCommands) {
      setMaxDraft(String(settings.maxConcurrentCommands));
      return;
    }
    runAction("agent-resource-max-concurrent", () => controller.updateAgentResourceSettings({
      maxConcurrentCommands: normalized
    }));
  };

  return <section className="runtime-governance-section" aria-labelledby="agent-resource-settings-heading">
    <GovernanceHeading
      id="agent-resource-settings-heading"
      title={t("settings.agentResource.title")}
      body={t("settings.agentResource.description")}
      customized={settings.customized}
      onReset={() => runAction("agent-resource-reset", () => controller.updateAgentResourceSettings({ resetAll: true }))}
      t={t}
    />
    <div className="settings-card runtime-governance-card">
      <div className="setting-row">
        <SettingCopy title={t("settings.agentResource.preset")} body={t(`settings.agentResource.presetHints.${activePreset ?? "custom"}`)} />
        <div className="segmented" role="radiogroup" aria-label={t("settings.agentResource.preset")}>
          {(["full", "balanced", "background"] as const).map((preset) => <button
            key={preset}
            type="button"
            role="radio"
            aria-checked={activePreset === preset}
            className={cx("segmented__item", activePreset === preset && "is-active")}
            onClick={() => runAction(`agent-resource-preset-${preset}`, () =>
              controller.updateAgentResourceSettings(agentPreset(preset)))}
          >{t(`settings.agentResource.presets.${preset}`)}</button>)}
        </div>
      </div>
      <label className="setting-row">
        <SettingCopy title={t("settings.agentResource.maxConcurrent")} body={t("settings.agentResource.maxConcurrentHint")} />
        <input
          className="runtime-governance-number"
          type="number"
          min={0}
          max={64}
          value={maxDraft}
          onChange={(event) => setMaxDraft(event.target.value)}
          onBlur={submitMax}
          onKeyDown={(event) => {
            if (event.key === "Escape") setMaxDraft(String(settings.maxConcurrentCommands));
          }}
        />
      </label>
      <div className="setting-row">
        <SettingCopy title={t("settings.agentResource.priority")} body={t("settings.agentResource.priorityHint")} />
        <div className="segmented" role="radiogroup" aria-label={t("settings.agentResource.priority")}>
          {(["normal", "low", "lowest"] as const).map((priority) => <button
            key={priority}
            type="button"
            role="radio"
            aria-checked={settings.processPriority === priority}
            className={cx("segmented__item", settings.processPriority === priority && "is-active")}
            onClick={() => runAction(`agent-resource-priority-${priority}`, () =>
              controller.updateAgentResourceSettings({ processPriority: priority }))}
          >{t(`settings.agentResource.priorityOptions.${priority}`)}</button>)}
        </div>
      </div>
      <div className="setting-row">
        <SettingCopy title={t("settings.agentResource.capThreads")} body={t("settings.agentResource.capThreadsHint")} />
        <SwitchControl
            checked={settings.capToolchainThreads}
            aria-label={t("settings.agentResource.capThreads")}
            onChange={(event) => runAction("agent-resource-cap-threads", () =>
              controller.updateAgentResourceSettings({ capToolchainThreads: event.target.checked }))}
          />
      </div>
    </div>
  </section>;
}

function CollaborationSettings({ controller, settings, runAction, t }: {
  readonly controller: AppController;
  readonly settings: CollaborationSettingsView;
  readonly runAction: RunAction;
  readonly t: Translator;
}): JSX.Element {
  return <section className="runtime-governance-section" aria-labelledby="collaboration-settings-heading">
    <GovernanceHeading
      id="collaboration-settings-heading"
      title={t("settings.collaboration.title")}
      customized={settings.customized}
      onReset={() => runAction("collaboration-reset", () => controller.updateCollaborationSettings({ resetAll: true }))}
      t={t}
    />
    <div className="settings-card runtime-governance-card">
      <BoundedNumberSetting
        title={t("settings.collaboration.workerSoftLimit")}
        body={t("settings.collaboration.workerSoftLimitHint")}
        value={settings.workerSoftLimit}
        minimum={1}
        maximum={settings.workerHardLimit}
        onCommit={(workerSoftLimit) => runAction("collaboration-soft-limit", () =>
          controller.updateCollaborationSettings({ workerSoftLimit }))}
      />
      <BoundedNumberSetting
        title={t("settings.collaboration.workerHardLimit")}
        body={t("settings.collaboration.workerHardLimitHint")}
        value={settings.workerHardLimit}
        minimum={settings.workerSoftLimit}
        maximum={20}
        onCommit={(workerHardLimit) => runAction("collaboration-hard-limit", () =>
          controller.updateCollaborationSettings({ workerHardLimit }))}
      />
      <BoundedNumberSetting
        title={t("settings.collaboration.idleRelease")}
        body={t("settings.collaboration.idleReleaseHint")}
        value={settings.workerIdleReleaseMinutes}
        minimum={0}
        maximum={120}
        onCommit={(workerIdleReleaseMinutes) => runAction("collaboration-idle-release", () =>
          controller.updateCollaborationSettings({ workerIdleReleaseMinutes }))}
      />
    </div>
  </section>;
}

function GitSafetySettings({ controller, settings, runAction, t }: {
  readonly controller: AppController;
  readonly settings: GitSafetySettingsView;
  readonly runAction: RunAction;
  readonly t: Translator;
}): JSX.Element {
  return <section className="runtime-governance-section" aria-labelledby="git-safety-settings-heading">
    <GovernanceHeading
      id="git-safety-settings-heading"
      title={t("settings.gitSafety.title")}
      customized={settings.customized}
      onReset={() => runAction("git-safety-reset", () => controller.updateGitSafetySettings({ resetAll: true }))}
      t={t}
    />
    <div className="settings-card runtime-governance-card">
      <div className="setting-row">
        <SettingCopy title={t("settings.gitSafety.autoSnapshotTitle")} body={t("settings.gitSafety.description")} />
        <SwitchControl
            checked={settings.autoSnapshotEnabled}
            aria-label={t("settings.gitSafety.toggleAria")}
            onChange={(event) => runAction("git-safety-auto-snapshot", () =>
              controller.updateGitSafetySettings({ autoSnapshotEnabled: event.target.checked }))}
          />
      </div>
      <div className="setting-row runtime-governance-status-row">
        <SettingCopy title={t("settings.gitSafety.statusTitle")} body={t("settings.gitSafety.statusBody", {
          sessions: settings.trackedSessions,
          repositories: settings.trackedRepositories,
          pending: settings.pendingTurns
        })} />
        <Button
          tone="ghost"
          disabled={!settings.cleanupAvailable}
          onClick={() => runAction("git-safety-cleanup", () => controller.cleanupGitSafetySavepoints())}
        >{t("settings.gitSafety.cleanup")}</Button>
      </div>
    </div>
  </section>;
}

function GovernanceHeading({ id, title, body, customized, onReset, t }: {
  readonly id: string;
  readonly title: string;
  readonly body?: string;
  readonly customized: boolean;
  readonly onReset: () => void;
  readonly t: Translator;
}): JSX.Element {
  return <header className="runtime-governance-heading">
    <div className="runtime-governance-heading__copy"><h3 id={id}>{title}</h3>{body !== undefined && <p>{body}</p>}</div>
    <div>
      {customized && <Pill>{t("settings.customized")}</Pill>}
      {customized && <Button tone="ghost" onClick={onReset}>{t("settings.restoreDefault")}</Button>}
    </div>
  </header>;
}

function SettingCopy({ title, body }: { readonly title: string; readonly body: string }): JSX.Element {
  return <div><strong>{title}</strong><span>{body}</span></div>;
}

function BoundedNumberSetting({ title, body, value, minimum, maximum, onCommit }: {
  readonly title: string;
  readonly body: string;
  readonly value: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly onCommit: (value: number) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = (): void => {
    const normalized = integerDraft(draft, minimum, maximum);
    if (normalized === undefined || normalized === value) {
      setDraft(String(value));
      return;
    }
    onCommit(normalized);
  };
  return <label className="setting-row">
    <SettingCopy title={title} body={body} />
    <input
      className="runtime-governance-number"
      type="number"
      min={minimum}
      max={maximum}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Escape") setDraft(String(value));
      }}
    />
  </label>;
}

export function agentPreset(preset: AgentPreset): Pick<AgentResourceSettingsView,
  "maxConcurrentCommands" | "processPriority" | "capToolchainThreads"> {
  if (preset === "full") return { maxConcurrentCommands: 0, processPriority: "normal", capToolchainThreads: false };
  if (preset === "background") return { maxConcurrentCommands: 2, processPriority: "lowest", capToolchainThreads: true };
  const parallelism = typeof navigator === "undefined" || !navigator.hardwareConcurrency
    ? 8
    : navigator.hardwareConcurrency;
  return {
    maxConcurrentCommands: Math.min(64, Math.max(2, Math.ceil(parallelism / 2))),
    processPriority: "low",
    capToolchainThreads: true
  };
}

function matchingPreset(settings: AgentResourceSettingsView): AgentPreset | undefined {
  for (const preset of ["full", "balanced", "background"] as const) {
    const candidate = agentPreset(preset);
    if (candidate.maxConcurrentCommands === settings.maxConcurrentCommands
      && candidate.processPriority === settings.processPriority
      && candidate.capToolchainThreads === settings.capToolchainThreads) return preset;
  }
  return undefined;
}

function integerDraft(value: string, minimum: number, maximum: number): number | undefined {
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : undefined;
}

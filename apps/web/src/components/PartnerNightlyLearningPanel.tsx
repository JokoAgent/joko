import { create } from "@bufbuild/protobuf";
import { useEffect, useSyncExternalStore } from "react";
import { NightlyLearningCandidateDecisionSchema, NightlyLearningChangeDecisionSchema, NightlyLearningChangeKind, NightlyLearningFrequency, NightlyLearningScheduleSchema,
  nightlyLearningMessages, routineMessages, routineTime, type PartnerNightlyLearningEditor } from "@joko/contracts";
import { Button, CheckboxControl } from "./ui.js";

export function PartnerNightlyLearningPanel({ editor, online, ownerDocument, locale }: {
  readonly editor: PartnerNightlyLearningEditor;
  readonly online: boolean;
  readonly ownerDocument: Document;
  readonly locale: string;
}) {
  const { value, busy, failed } = useSyncExternalStore(editor.subscribe, editor.snapshot);
  const m = nightlyLearningMessages(locale), states = routineMessages(locale).states;
  useEffect(() => {
    const ownerWindow = ownerDocument.defaultView;
    if (!online || !ownerWindow) { editor.suspend(); return; }
    void editor.refresh();
    const poll = ownerWindow.setInterval(() => { void editor.refresh(); }, 3000);
    return () => { ownerWindow.clearInterval(poll); editor.suspend(); };
  }, [editor, online, ownerDocument]);
  const schedule = value?.schedule;
  const locked = !online || failed || busy || !value?.writable;
  const applying = locked || value?.running;
  const configure = (enabled: boolean, frequency: NightlyLearningFrequency) => void editor.apply({ case: "schedule",
    value: create(NightlyLearningScheduleSchema, { enabled, frequency }) });

  return <section className="partner-capabilities" aria-label={m.title}>
    <h3>{m.title}</h3>
    {failed && <p role="alert">{m.failed}</p>}
    {busy && !value && <p role="status">{routineMessages(locale).busy}</p>}
    {schedule && value && <>
      <div className="toolbar-actions">
        <label className="check-row"><CheckboxControl checked={schedule.enabled} disabled={locked}
          onChange={event => configure(event.target.checked, schedule.frequency)} /><span>{m.automatic}</span></label>
        <select aria-label={m.frequency} value={schedule.frequency} disabled={locked}
          onChange={event => configure(schedule.enabled, Number(event.target.value) as NightlyLearningFrequency)}>
          <option value={NightlyLearningFrequency.DAILY}>{m.daily}</option><option value={NightlyLearningFrequency.WEEKLY}>{m.weekly}</option>
        </select>
        <span>{m.time} ({value.timezone})</span>
        <Button disabled={applying} onClick={() => void editor.run()}>{m.run}</Button>
      </div>
      <p>{m.pending} · {value.pendingConversations}</p>
      {value.running && <p role="status">{m.busy}</p>}
      {!value.memoryEnabled && <p>{m.memoryOff}</p>}
      <details><summary>{m.observations}</summary>
        {value.candidates.length === 0 ? <p>{m.emptyObservations}</p> : <ul className="resource-list">{value.candidates.map(candidate => <li key={candidate.id}>
          <strong>{candidate.title}</strong><p>{candidate.summary}</p>
          <div className="toolbar-actions">
            <Button disabled={applying} onClick={() => void editor.apply({ case: "candidate", value: create(NightlyLearningCandidateDecisionSchema,
              { candidateId: candidate.id, promote: true }) })}>{m.approve}</Button>
            <Button disabled={applying} onClick={() => void editor.apply({ case: "candidate", value: create(NightlyLearningCandidateDecisionSchema,
              { candidateId: candidate.id }) })}>{m.dismiss}</Button>
          </div>
        </li>)}</ul>}
      </details>
      <details><summary>{m.history}</summary>
        {value.history.length === 0 ? <p>{m.emptyHistory}</p> : <ol className="resource-list">{value.history.map(run => <li key={run.id}>
          <strong>{states[run.status] ?? states[0]}</strong>{" · "}{new Date(routineTime(run.startedAt)).toLocaleString(locale)}{" · "}{run.conversationCount}
          {run.changes.length > 0 && <ul>{run.changes.map(change => <li key={change.id}>
            <p>{m.kinds[change.kind]} · {m.actions[change.action]} · {change.title}</p><p>{change.reason}</p>
            <Button disabled={applying || change.kind === NightlyLearningChangeKind.MEMORY && !value.memoryEnabled} onClick={() => void editor.apply({ case: "change",
              value: create(NightlyLearningChangeDecisionSchema, { runId: run.id, changeId: change.id, redo: change.undone }) })}>
              {change.undone ? m.redo : m.undo}
            </Button>
          </li>)}</ul>}
        </li>)}</ol>}
      </details>
    </>}
    {failed && <Button disabled={!online || busy} onClick={() => void editor.refresh()}>{m.refresh}</Button>}
  </section>;
}

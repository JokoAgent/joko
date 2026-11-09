import { backgroundWorkflowDuration, backgroundWorkflowMessages, backgroundWorkflowStateLabel, projectBackgroundWorkflow,
  type BackgroundWorkflowProgress } from "@joko/contracts";
import type { JSX } from "react";

export function BackgroundWorkflowTree({ workflow, taskState, locale }: {
  readonly workflow: BackgroundWorkflowProgress; readonly taskState?: string; readonly locale: string;
}): JSX.Element {
  const t = backgroundWorkflowMessages(locale), model = projectBackgroundWorkflow(workflow, taskState);
  return <section className="background-workflow" aria-label={t.title}>
    <header><h4>{workflow.workflowName || t.title}</h4><span>{backgroundWorkflowStateLabel(model.status, locale)}</span></header>
    <dl className="background-workflow__totals">
      <div><dt>{t.agents}</dt><dd>{model.agentCount.toString()}</dd></div>
      {workflow.totalTokens !== undefined && <div><dt>{t.tokens}</dt><dd>{workflow.totalTokens.toString()}</dd></div>}
      {workflow.totalToolCalls !== undefined && <div><dt>{t.tools}</dt><dd>{workflow.totalToolCalls.toString()}</dd></div>}
      {workflow.durationMs !== undefined && <div><dt>{t.duration}</dt><dd>{backgroundWorkflowDuration(workflow.durationMs)}</dd></div>}
    </dl>
    {model.groups.map((group, index) => <section className="background-workflow__phase" key={index}>
      <h5>{group.title ?? t.other}</h5>{group.detail && <p>{group.detail}</p>}
      <ul>{group.agents.map((agent, ordinal) => <li key={ordinal} data-workflow-state={agent.state}>
        <header><strong>{agent.label}</strong><span>{backgroundWorkflowStateLabel(agent.state, locale)}</span></header>
        <dl>
          {agent.model && <div><dt>{t.model}</dt><dd>{agent.model}</dd></div>}
          {agent.attempt !== undefined && agent.attempt > 1 && <div><dt>{t.attempt}</dt><dd>{agent.attempt}</dd></div>}
          {agent.durationMs !== undefined && <div><dt>{t.duration}</dt><dd>{backgroundWorkflowDuration(agent.durationMs)}</dd></div>}
          {agent.lastToolName && <div><dt>{t.tool}</dt><dd>{agent.lastToolName}{agent.lastToolSummary && <p>{agent.lastToolSummary}</p>}</dd></div>}
          {!agent.lastToolName && agent.lastToolSummary && <div><dt>{t.tool}</dt><dd>{agent.lastToolSummary}</dd></div>}
          {agent.resultPreview && <div><dt>{t.result}</dt><dd>{agent.resultPreview}</dd></div>}
          {(agent.error || ["error", "failed", "stopped", "killed"].includes(agent.state)) && <div className="background-workflow__error"><dt>{t.error}</dt><dd>{agent.error || t.endedEarly}</dd></div>}
        </dl>
      </li>)}</ul>
    </section>)}
    {workflow.logs.length > 0 && <section className="background-workflow__logs"><h5>{t.logs}</h5><ol>{workflow.logs.map((line, index) => <li key={index}>{line}</li>)}</ol></section>}
  </section>;
}

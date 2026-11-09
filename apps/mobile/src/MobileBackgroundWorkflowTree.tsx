import { Text, View } from "react-native";
import { backgroundWorkflowDuration, backgroundWorkflowMessages, backgroundWorkflowStateLabel, projectBackgroundWorkflow,
  type BackgroundWorkflowProgress } from "@joko/contracts";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";

export function MobileBackgroundWorkflowTree({ workflow, taskState, colors, locale }: {
  readonly workflow: BackgroundWorkflowProgress; readonly taskState?: string;
  readonly colors: MobileInteractionSheetColors; readonly locale: string;
}) {
  const t = backgroundWorkflowMessages(locale), model = projectBackgroundWorkflow(workflow, taskState);
  const text = { color: colors.ink, fontSize: 12 }, muted = { color: colors.muted, fontSize: 12 };
  return <View accessibilityLabel={t.title} style={{ gap: 10 }}>
    <Text selectable style={{ ...text, fontWeight: "600" }}>{workflow.workflowName || t.title}</Text>
    <Text style={muted}>{backgroundWorkflowStateLabel(model.status, locale)}</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Text style={muted}>{`${t.agents}: ${model.agentCount}`}</Text>
      {workflow.totalTokens !== undefined && <Text style={muted}>{`${t.tokens}: ${workflow.totalTokens}`}</Text>}
      {workflow.totalToolCalls !== undefined && <Text style={muted}>{`${t.tools}: ${workflow.totalToolCalls}`}</Text>}
      {workflow.durationMs !== undefined && <Text style={muted}>{`${t.duration}: ${backgroundWorkflowDuration(workflow.durationMs)}`}</Text>}
    </View>
    {model.groups.map((group, index) => <View key={index} style={{ gap: 6 }}>
      <Text selectable style={{ ...text, fontWeight: "600" }}>{group.title ?? t.other}</Text>
      {group.detail && <Text selectable style={muted}>{group.detail}</Text>}
      {group.agents.map((agent, ordinal) => <View key={ordinal} style={{ gap: 5, padding: 8, borderWidth: 1, borderColor: colors.border, borderRadius: 8 }}>
        <Text selectable style={text}>{agent.label}</Text><Text style={muted}>{backgroundWorkflowStateLabel(agent.state, locale)}</Text>
        {agent.model && <Text selectable style={muted}>{`${t.model}: ${agent.model}`}</Text>}
        {agent.attempt !== undefined && agent.attempt > 1 && <Text style={muted}>{`${t.attempt}: ${agent.attempt}`}</Text>}
        {agent.durationMs !== undefined && <Text style={muted}>{`${t.duration}: ${backgroundWorkflowDuration(agent.durationMs)}`}</Text>}
        {(agent.lastToolName || agent.lastToolSummary) && <Text selectable style={text}>{`${t.tool}: ${[agent.lastToolName, agent.lastToolSummary].filter(Boolean).join(" · ")}`}</Text>}
        {agent.resultPreview && <Text selectable style={text}>{`${t.result}: ${agent.resultPreview}`}</Text>}
        {(agent.error || ["error", "failed", "stopped", "killed"].includes(agent.state)) && <Text selectable style={{ color: colors.negative, fontSize: 12 }}>{agent.error || t.endedEarly}</Text>}
      </View>)}
    </View>)}
    {workflow.logs.length > 0 && <View style={{ gap: 5 }}><Text style={muted}>{t.logs}</Text>
      {workflow.logs.map((line, index) => <Text key={index} selectable style={text}>{line}</Text>)}
    </View>}
  </View>;
}

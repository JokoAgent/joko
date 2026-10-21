import { useState } from "react";
import { partnerTaskModelMessages } from "@joko/contracts";
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { MobilePartnerPhotoPicker } from "./MobilePartnerPhotoPicker";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import type { MobilePartnerDirectoryProfile, MobilePartnerModelRoute } from "./mobile-partner-directory";
import type { MobilePartnerDraftFields, MobilePartnerProfileDraft } from "./mobile-partner-profile";
import type { MobilePartnersColors } from "./MobilePartnersScreen";

export function MobilePartnerProfileForm({ fields: snapshot, original, draft, disabled, avatarKey, onChange: change, onPreparing, colors, locale }: {
  readonly fields: MobilePartnerDraftFields; readonly original?: MobilePartnerDirectoryProfile; readonly draft: MobilePartnerProfileDraft;
  readonly disabled: boolean; readonly avatarKey: string; readonly onChange: (draft: MobilePartnerProfileDraft) => void;
  readonly onPreparing: (value: boolean) => void; readonly colors: MobilePartnersColors; readonly locale: MobileSupportedLocale;
}) {
  const [modelIndex, setModelIndex] = useState<number>();
  const [choosingTaskModel, setChoosingTaskModel] = useState(false);
  const editable = !disabled; const capabilitiesEditable = editable && !draft.usesDirectoryDefaults;
  const updateRoute = (index: number, route: MobilePartnerModelRoute): void => {
    if (!draft || !capabilitiesEditable) return;
    change({ ...draft, capabilities: { ...draft.capabilities,
      modelChain: draft.capabilities.modelChain.map((candidate, position) => position === index ? route : candidate) } });
  };
  const action = (label: string, onPress: () => void, disabled = false, selected = false) => <Pressable
    accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, selected }}
    disabled={disabled} onPress={onPress} style={[styles.action, { borderColor: colors.border,
      backgroundColor: selected ? colors.brandBackground : colors.surface }, disabled && styles.disabled]}>
    <Text style={[styles.body, { color: colors.ink }]}>{label}</Text>
  </Pressable>;
  const caption = (key: "name" | "avatar" | "description" | "identity" | "models" | "permission" | "effort") => <Text
    style={[styles.label, { color: colors.ink }]}>{mobileMessage(locale, `partnerProfile.${key}`)}</Text>;
  const effective = draft?.usesDirectoryDefaults ? snapshot?.options.defaultCapabilities : draft?.capabilities;
  const modelLabel = (model: MobilePartnerDraftFields["models"][number]): string =>
    `${new Set(snapshot.models.map(candidate => candidate.backendId)).size > 1 ? `${model.backendName ?? model.backendId} · ` : ""}${model.displayName} · ${model.providerName}`;
  const canSelectModel = (model: MobilePartnerDraftFields["models"][number], index?: number): boolean => {
    const axes = snapshot.taskModels?.find(candidate => candidate.backendId === model.backendId && candidate.providerId === model.providerId && candidate.modelId === model.modelId) ?? snapshot;
    return axes.permissionModes.includes(effective?.permissionMode ?? "ask") && (!effective?.planMode || axes.canSetPlanMode)
      && (!(effective?.modelChain.some((route, position) => position !== index && route.backendId === model.backendId)) || axes.canSwitchModel === true);
  };
  const chainAxes = (effective?.modelChain ?? []).map(route => snapshot.taskModels?.find(model =>
    model.backendId === route.backendId && model.providerId === route.providerId && model.modelId === route.modelId) ?? snapshot);
  const permissionModes = (["ask", "acceptEdits", "auto", "bypassPermissions"] as const).filter(mode => chainAxes.every(axes => axes.permissionModes.includes(mode)));
  const canSetPlanMode = chainAxes.every(axes => axes.canSetPlanMode);
  return <>
            {caption("name")}
            <TextInput accessibilityLabel={mobileMessage(locale, "partnerProfile.name")} value={draft.displayName} editable={editable}
              onChangeText={(displayName) => change({ ...draft, displayName })} maxLength={200} autoCorrect={false}
              style={[styles.input, { borderColor: colors.border, color: colors.ink, backgroundColor: colors.surface }]} />
            {caption("avatar")}
            <MobilePartnerPhotoPicker key={avatarKey} value={draft.avatar} presets={snapshot.options.avatarPresets} partner={original}
              colors={colors} locale={locale} disabled={!editable} onPreparing={onPreparing}
              onChange={(avatar) => change({ ...draft, avatar })} />
            {caption("description")}
            <TextInput accessibilityLabel={mobileMessage(locale, "partnerProfile.description")} value={draft.description}
              editable={editable} multiline maxLength={12_000} onChangeText={(description) => change({ ...draft, description })}
              style={[styles.input, { borderColor: colors.border, color: colors.ink, backgroundColor: colors.surface }]} />
            {caption("identity")}
            <TextInput accessibilityLabel={mobileMessage(locale, "partnerProfile.identity")} value={draft.identitySource}
              editable={editable} multiline maxLength={8_000} onChangeText={(identitySource) => change({ ...draft, identitySource })}
              style={[styles.input, styles.identity, { borderColor: colors.border, color: colors.ink, backgroundColor: colors.surface }]} />
            <View style={styles.toggle}>
              <Text style={[styles.body, styles.grow, { color: colors.ink }]}>{mobileMessage(locale, "partnerProfile.defaults")}</Text>
              <Switch accessibilityLabel={mobileMessage(locale, "partnerProfile.defaults")} value={draft.usesDirectoryDefaults}
                disabled={!editable || !snapshot.options.defaultCapabilities && !draft.usesDirectoryDefaults}
                onValueChange={(usesDirectoryDefaults) => change({ ...draft, usesDirectoryDefaults })} />
            </View>
            {caption("models")}
            {effective?.modelChain.map((route, index) => {
              const model = snapshot.models.find((candidate) => candidate.backendId === route.backendId
                && candidate.providerId === route.providerId && candidate.modelId === route.modelId);
              return <View key={index} style={[styles.section, { borderColor: colors.border }]}>
                <Text style={[styles.label, { color: colors.muted }]}>{mobileMessage(locale, "partnerProfile.model", { index: index + 1 })}</Text>
                {action(model ? modelLabel(model) : `${route.modelId} · ${route.providerId}`,
                  () => setModelIndex(modelIndex === index ? undefined : index), !capabilitiesEditable)}
                {modelIndex === index && snapshot.models.map((choice) => {
                  const duplicate = effective.modelChain.some((candidate, position) => position !== index
                    && candidate.backendId === choice.backendId && candidate.providerId === choice.providerId && candidate.modelId === choice.modelId);
                  return <View key={`${choice.backendId}:${choice.key}`}>{action(modelLabel(choice), () => {
                    const effort = choice.efforts.find((candidate) => candidate.default)?.id ?? choice.efforts[0]?.id;
                    updateRoute(index, { backendId: choice.backendId, providerId: choice.providerId, modelId: choice.modelId,
                      fastMode: false, ...(effort === undefined ? {} : { effort }) });
                    setModelIndex(undefined);
                  }, !capabilitiesEditable || duplicate || !canSelectModel(choice, index), choice.backendId === route.backendId && choice.modelId === route.modelId && choice.providerId === route.providerId)}</View>;
                })}
                {caption("effort")}
                <View style={styles.choices}>
                  {(model?.efforts.length ?? 0) === 0 && action(mobileMessage(locale, "partnerProfile.automatic"), () => {
                    const { effort: _effort, ...automatic } = route; updateRoute(index, automatic);
                  }, !capabilitiesEditable, route.effort === undefined)}
                  {model?.efforts.map((effort) => <View key={effort.id}>{action(effort.label,
                    () => updateRoute(index, { ...route, effort: effort.id }), !capabilitiesEditable || !(snapshot.taskModels?.find(candidate => candidate.backendId === route.backendId && candidate.key === model?.key)?.canSetEffort ?? snapshot.canSetEffort), route.effort === effort.id)}</View>)}
                </View>
                <View style={styles.toggle}>
                  <Text style={[styles.body, styles.grow, { color: colors.ink }]}>{mobileMessage(locale, "partnerProfile.fast")}</Text>
                  <Switch accessibilityLabel={`${mobileMessage(locale, "partnerProfile.fast")} ${index + 1}`} value={route.fastMode}
                    disabled={!capabilitiesEditable || (!model?.supportsFastMode || !(snapshot.taskModels?.find(candidate => candidate.backendId === route.backendId && candidate.key === model?.key)?.canSetFastMode ?? snapshot.canSetFastMode)) && !route.fastMode}
                    onValueChange={(fastMode) => updateRoute(index, { ...route, fastMode })} />
                </View>
                {effective.modelChain.length > 1 && action(mobileMessage(locale, "partnerProfile.removeModel", { index: index + 1 }), () => {
                  change({ ...draft, capabilities: { ...draft.capabilities,
                    modelChain: draft.capabilities.modelChain.filter((_candidate, position) => position !== index) } }); setModelIndex(undefined);
                }, !capabilitiesEditable)}
              </View>;
            })}
            {action(mobileMessage(locale, "partnerProfile.addModel"), () => {
              const available = snapshot.models.find((model) => canSelectModel(model) && !draft.capabilities.modelChain.some((route) =>
                route.backendId === model.backendId && route.providerId === model.providerId && route.modelId === model.modelId));
              if (available) {
                const effort = available.efforts.find((candidate) => candidate.default)?.id ?? available.efforts[0]?.id;
                change({ ...draft, capabilities: { ...draft.capabilities, modelChain: [...draft.capabilities.modelChain,
                  { backendId: available.backendId, providerId: available.providerId, modelId: available.modelId,
                    fastMode: false, ...(effort === undefined ? {} : { effort }) }] } });
              }
            }, !capabilitiesEditable || (effective?.modelChain.length ?? 0) >= 5 || !snapshot.models.some((model) => canSelectModel(model) &&
              !draft.capabilities.modelChain.some((route) => route.backendId === model.backendId && route.providerId === model.providerId && route.modelId === model.modelId)))}
            {original !== undefined && <View style={styles.section}>
              <Text style={[styles.label, { color: colors.ink }]}>{partnerTaskModelMessages(locale).title}</Text>
              {(() => {
                const m = partnerTaskModelMessages(locale), taskCapabilities = effective ?? draft.capabilities;
                const route = draft.taskModelOverride ?? taskCapabilities.modelChain[0];
                if (!route) return null;
                const models = (snapshot.taskModels ?? []).filter(model => model.permissionModes.includes(taskCapabilities.permissionMode)
                  && (!taskCapabilities.planMode || model.canSetPlanMode));
                const model = models.find(candidate => candidate.backendId === route.backendId && candidate.providerId === route.providerId && candidate.modelId === route.modelId);
                const select = (taskModelOverride: MobilePartnerModelRoute | undefined) => {
                  if (!editable) return; const { taskModelOverride: _previous, ...rest } = draft;
                  change(taskModelOverride === undefined ? rest : { ...rest, taskModelOverride });
                };
                return <>
                  {action(`${m.choose}: ${model?.displayName ?? `${route.providerId} · ${route.modelId} · ${m.unavailable}`}`,
                    () => setChoosingTaskModel(value => !value), !editable)}
                  {choosingTaskModel && models.map(choice => <View key={`${choice.backendId}:${choice.key}`}>{action(`${m.title}: ${choice.displayName} · ${choice.providerName}`, () => {
                    const effort = choice.efforts.find(candidate => candidate.default)?.id ?? choice.efforts[0]?.id;
                    select({ backendId: choice.backendId, providerId: choice.providerId, modelId: choice.modelId, fastMode: false,
                      ...(effort === undefined ? {} : { effort }) }); setChoosingTaskModel(false);
                  }, !editable, choice.backendId === route.backendId && choice.providerId === route.providerId && choice.modelId === route.modelId)}</View>)}
                  {model !== undefined && model.efforts.length > 0 && <View style={styles.choices}>
                    <Text style={[styles.label, { color: colors.ink }]}>{m.effort}</Text>
                    {model.efforts.map(effort => <View key={effort.id}>{action(`${m.effort}: ${effort.label}`, () => select({ ...route, effort: effort.id }),
                      !editable || !model.canSetEffort, effort.id === route.effort)}</View>)}
                  </View>}
                  {(model?.supportsFastMode || route.fastMode) && <View style={styles.toggle}><Text style={[styles.body, styles.grow, { color: colors.ink }]}>{m.fast}</Text>
                    <Switch accessibilityLabel={m.fast} value={route.fastMode} disabled={!editable || !model?.canSetFastMode || !model.supportsFastMode}
                      onValueChange={fastMode => select({ ...route, fastMode })} /></View>}
                  {draft.taskModelOverride === undefined ? <Text style={[styles.body, { color: colors.ink }]}>{m.inheriting}</Text>
                    : action(m.inherit, () => select(undefined), !editable)}
                  <Text style={[styles.body, { color: colors.ink }]}>{m.help}</Text>
                </>;
              })()}
            </View>}
            {caption("permission")}
            <View style={styles.choices}>
              {(["ask", "acceptEdits", "auto", "bypassPermissions"] as const).map((permissionMode) => <View key={permissionMode}>{action(mobileMessage(locale,
                permissionMode === "ask" ? "partnerProfile.ask" : permissionMode === "acceptEdits" ? "controls.permission.edits" : permissionMode === "auto" ? "partnerProfile.auto" : "controls.permission.full"), () => change({ ...draft,
                  capabilities: { ...draft.capabilities, permissionMode } }), !capabilitiesEditable || !permissionModes.includes(permissionMode),
              effective?.permissionMode === permissionMode)}</View>)}
            </View>
            {effective?.permissionMode === "bypassPermissions" && <Text style={[styles.body, { color: colors.muted }]}>{mobileMessage(locale, "controls.fullAccessBody")}</Text>}
            <View style={styles.toggle}>
              <Text style={[styles.body, styles.grow, { color: colors.ink }]}>{mobileMessage(locale, "partnerProfile.plan")}</Text>
              <Switch accessibilityLabel={mobileMessage(locale, "partnerProfile.plan")} value={effective?.planMode ?? false}
                disabled={!capabilitiesEditable || !canSetPlanMode && !effective?.planMode} onValueChange={(planMode) => change({ ...draft,
                  capabilities: { ...draft.capabilities, planMode } })} />
            </View>
  </>;
}

const styles = StyleSheet.create({
  grow: { flex: 1, minWidth: 0 }, label: { fontSize: 14, lineHeight: 20, fontWeight: "600" }, body: { fontSize: 15, lineHeight: 22 },
  section: { gap: 10, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  action: { minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  input: { minHeight: 44, padding: 12, borderWidth: 1, borderRadius: 12, fontSize: 16, lineHeight: 23 },
  identity: { minHeight: 170, textAlignVertical: "top" }, choices: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  toggle: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44 }, disabled: { opacity: 0.45 }
});

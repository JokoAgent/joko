import { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, Switch, Text, TextInput, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { SERVER_ACCESS_PROVIDERS, serverAccessDefaults, serverAccessFields, serverAccessGuidance, serverAccessIssue, serverAccessText, serverAccessModes, serverAccessProvider, type ServerAccessField } from '@joko/contracts/server-access';
import type { GetServerAccessSettingsResponse, ServerAccessEntry } from '@joko/contracts';
import type { ServerAccessClient } from '@joko/connection-transport/server-access';
import type { MobileSettingsColors } from './MobileSettingsScreen';
import { mobileMessage } from './mobile-messages';
import type { MobileSupportedLocale } from './mobile-locale-preference';

interface Draft { entryId: string; revision: string; provider: string; mode: string; name: string; fields: Record<string, string>; secrets: readonly string[] }
export function MobileServerAccessSettings({ getApi, colors, locale }: { readonly getApi: () => ServerAccessClient; readonly colors: MobileSettingsColors; readonly locale: MobileSupportedLocale }) {
  const api = useRef<ServerAccessClient | undefined>(undefined), alive = useRef(true), lock = useRef(false), request = useRef(''), savedDraft = useRef(false);
  const polling = useRef(false), revision = useRef(0);
  const [settings, setSettings] = useState<GetServerAccessSettingsResponse>(), [error, setError] = useState(''), [busy, setBusy] = useState(false), [pending, setPending] = useState(false);
  const [draft, setDraft] = useState<Draft>(), [catalog, setCatalog] = useState<'connection' | 'media'>(), [provider, setProvider] = useState(''), [advanced, setAdvanced] = useState(false);
  const [confirm, setConfirm] = useState<{ entry: ServerAccessEntry; action: string }>(), [confirmed, setConfirmed] = useState(false);
  const t = (key: string) => serverAccessText(key, key => mobileMessage(locale, key));
  const text = { color: colors.ink, fontSize: 15, lineHeight: 22 }, caption = { color: colors.muted, fontSize: 13, lineHeight: 19 };
  const input = { color: colors.ink, borderColor: colors.border, borderWidth: 1, borderRadius: 12, minHeight: 48, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16 };
  const disabled = busy || pending;
  const button = (label: string, action: () => void, primary = false, blocked = disabled) => <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: blocked }} disabled={blocked} onPress={action}
    style={{ minHeight: 46, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, justifyContent: 'center', backgroundColor: primary ? colors.brandBackground : undefined, opacity: blocked ? 0.55 : 1 }}>
    <Text style={{ ...text, color: colors.accent, fontWeight: primary ? '700' : '600' }}>{label}</Text></Pressable>;
  const refresh = async (id?: string) => {
    const started = revision.current;
    api.current ??= getApi(); const value = await api.current.read(id ?? request.current); if (!alive.current || started !== revision.current) return;
    setSettings(value); if (value.operationIssue) setError(serverAccessIssue(value.operationIssue, t));
    if (value.operationState) {
      const waiting = value.operationState === 'pending'; setPending(waiting);
      if (value.operationState === 'outcome_unknown') setError(t('access.issue.query_original_operation'));
      if (!waiting) { request.current = ''; if (savedDraft.current && value.operationState === 'completed' && !value.operationIssue) { setDraft(undefined); savedDraft.current = false; } }
    }
  };
  const run = async (work: () => Promise<void>, background = false) => {
    if (lock.current || background && polling.current || AppState.currentState !== 'active') return;
    if (background) polling.current = true;
    else { lock.current = true; revision.current++; setBusy(true); setError(''); }
    try { await work(); } catch (failure) { if (alive.current && !background) setError(serverAccessIssue(failure instanceof Error ? failure.message : '', t)); }
    finally { if (background) polling.current = false; else { lock.current = false; if (alive.current) setBusy(false); } }
  };
  useEffect(() => {
    alive.current = true; void run(() => refresh()); const timer = setInterval(() => void run(() => refresh(), true), 3000);
    return () => { alive.current = false; clearInterval(timer); };
  }, []);
  const change = async (entry: ServerAccessEntry, action: string, confirmation = false) => {
    const id = randomUUID(); request.current = id; setPending(true); api.current ??= getApi();
    try { await api.current.change({ requestId: id, entryId: entry.entryId, expectedRevision: entry.revision, action, confirmDisconnection: confirmation, confirmResourceId: confirmation ? entry.resourceId : '' }); if (alive.current) setConfirm(undefined); }
    finally { await refresh(id); }
  };
  const begin = (selected: string, mode: string) => {
    setDraft({ entryId: selected === 'cloudflare' && mode === 'quick' ? 'cloudflare-quick' : `access-${randomUUID()}`, revision: '', provider: selected, mode, name: serverAccessProvider(selected)?.name ?? selected,
      fields: { ...serverAccessDefaults(selected, mode) }, secrets: [] }); setCatalog(undefined); setProvider(''); setAdvanced(false);
  };
  const ask = (entry: ServerAccessEntry, action: string) => { setConfirm({ entry, action }); setConfirmed(false); };
  const field = (definition: ServerAccessField) => {
    if (!draft) return null;
    const label = t(`access.field.${definition.key}`), value = draft.fields[definition.key] ?? '', secret = definition.kind === 'secret', configured = draft.secrets.includes(definition.key);
    const update = (value: string, clear = false) => setDraft(current => {
      if (!current) return current; const fields = { ...current.fields };
      if (!value && secret && configured && !clear) delete fields[definition.key]; else fields[definition.key] = value;
      return { ...current, fields };
    });
    return <View key={definition.key} style={{ gap: 7 }}>
      <Text style={text}>{label}{definition.required ? ` · ${t('access.required')}` : ''}</Text>
      {definition.kind === 'toggle' ? <Switch accessibilityLabel={label} value={value === 'true'} onValueChange={value => update(String(value))} disabled={disabled} />
        : definition.kind === 'choice' ? <View style={{ gap: 4 }}>{definition.choices?.map(choice => <Pressable key={choice} accessibilityRole="radio" accessibilityState={{ selected: value === choice, disabled }} disabled={disabled}
          onPress={() => update(choice)} style={{ minHeight: 46, padding: 12, borderRadius: 10, backgroundColor: value === choice ? colors.brandBackground : undefined }}>
          <Text style={text}>{value === choice ? '✓ ' : ''}{definition.key === 'resourceMode' ? t(`access.resource.${choice}`) : choice}</Text></Pressable>)}</View>
        : <TextInput accessibilityLabel={label} style={[input, definition.kind === 'multiline' || definition.multiline ? { minHeight: 112, textAlignVertical: 'top' } : {}]} value={value} editable={!disabled}
          onChangeText={value => update(value)} autoCapitalize="none" autoCorrect={false} secureTextEntry={secret && !definition.multiline} multiline={definition.kind === 'multiline' || definition.multiline}
          keyboardType={definition.kind === 'number' ? 'number-pad' : 'default'} maxLength={secret || definition.kind === 'multiline' ? 16384 : 4096}
          placeholder={secret && configured ? t('access.secret') : undefined} placeholderTextColor={colors.muted} />}
      {secret && configured && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}><Switch accessibilityLabel={`${t('access.clearSecret')}: ${label}`} value={draft.fields[definition.key] === ''}
        disabled={disabled} onValueChange={clear => update('', clear)} /><Text style={{ ...caption, flex: 1 }}>{t('access.clearSecret')}</Text></View>}
    </View>;
  };
  const entries = settings?.entries ?? [], capability = settings?.capabilities.find(value => value.provider === draft?.provider && value.mode === draft.mode);
  return <View style={{ backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 14, padding: 16, gap: 16 }}>
    <View style={{ gap: 6 }}><Text accessibilityRole="header" style={{ ...text, fontSize: 17, fontWeight: '600' }}>{t('access.title')}</Text><Text style={caption}>{t('access.description')}</Text></View>
    {button(t(pending ? 'access.retry' : 'access.refresh'), () => void run(() => refresh()), false, busy)}
    {!!error && <Text accessibilityRole="alert" style={{ ...text, color: colors.negative }}>{error}</Text>}
    {!settings && <Text accessibilityLiveRegion="polite" style={caption}>{t('access.loading')}</Text>}
    {confirm ? <View style={{ gap: 16 }}><Text accessibilityRole="header" style={text}>{confirm.entry.name} · {t(`access.${confirm.action}`)}</Text>
      <Text style={text}>{t(confirm.action === 'adopt' ? 'access.adoptWarning' : confirm.action === 'accept_source' ? 'access.sourceWarning' : confirm.action.startsWith('resource_') ? 'access.resourceWarning' : confirm.action === 'delete' && !confirm.entry.enabled ? 'access.deleteWarning' : 'access.stopWarning')}</Text>
      {!!confirm.entry.resourceId && <Text selectable style={caption}>{t('access.resourceId')}: {confirm.entry.resourceId}</Text>}
      {['stop', 'delete'].includes(confirm.action) && confirm.entry.enabled && <View style={{ gap: 8 }}><Text style={text}>{t('access.confirmStop')}</Text><Switch accessibilityLabel={t('access.confirmStop')} value={confirmed} onValueChange={setConfirmed} disabled={disabled} /></View>}
      {button(t('access.confirm'), () => void run(() => change(confirm.entry, confirm.action, true)), true, disabled || ['stop', 'delete'].includes(confirm.action) && confirm.entry.enabled && !confirmed)}
      {button(t('access.cancel'), () => setConfirm(undefined))}
    </View> : draft ? <View style={{ gap: 16 }}>
      <Text accessibilityRole="header" style={{ ...text, fontWeight: '600' }}>{serverAccessProvider(draft.provider)?.name} · {serverAccessModes(draft.provider).find(mode => mode.id === draft.mode)?.label}</Text>
      {serverAccessGuidance(draft.provider, draft.mode).map(key => <Text key={key} style={caption}>{t(key)}</Text>)}
      {capability && capability.state !== 'ready' && <Text style={caption}>{t(capability.state === 'missing_tls' ? 'access.tlsHelp' : capability.state === 'external_ice_config' ? 'access.issue.external_ice_config' : 'access.runtimeHelp')}</Text>}
      <View style={{ gap: 7 }}><Text style={text}>{t('access.name')}</Text><TextInput accessibilityLabel={t('access.name')} value={draft.name} maxLength={80} editable={!disabled} style={input} onChangeText={name => setDraft({ ...draft, name })} /></View>
      {serverAccessFields(draft.provider, draft.mode, draft.fields).filter(value => !value.advanced).map(field)}
      {serverAccessFields(draft.provider, draft.mode, draft.fields).some(value => value.advanced) && <>{button(t('access.advanced'), () => setAdvanced(value => !value))}
        {advanced && serverAccessFields(draft.provider, draft.mode, draft.fields).filter(value => value.advanced).map(field)}</>}
      <Text style={caption}>{t('access.secretHelp')}</Text>
      {button(t('access.save'), () => void run(async () => {
        const id = randomUUID(); request.current = id; savedDraft.current = true; setPending(true); api.current ??= getApi();
        try { await api.current.save({ requestId: id, entryId: draft.entryId, expectedRevision: draft.revision, provider: draft.provider, mode: draft.mode, name: draft.name, fields: draft.fields }); }
        finally { await refresh(id); }
      }), true)}
      {button(t('access.cancel'), () => { setDraft(undefined); savedDraft.current = false; })}
    </View> : catalog ? <View style={{ gap: 12 }}><Text accessibilityRole="header" style={text}>{t(provider ? 'access.mode' : 'access.choose')}</Text>
      {provider ? serverAccessModes(provider).filter(mode => (mode.purpose === 'media') === (catalog === 'media')).map(mode => <View key={mode.id}>{button(mode.label, () => begin(provider, mode.id))}
        <Text style={caption}>{t(`access.${settings?.capabilities.find(value => value.provider === provider && value.mode === mode.id)?.state ?? 'missing_runtime'}`)}</Text></View>)
        : SERVER_ACCESS_PROVIDERS.filter(value => serverAccessModes(value.id).some(mode => (mode.purpose === 'media') === (catalog === 'media'))).map(value => <View key={value.id}>{button(value.name, () => {
          const modes = serverAccessModes(value.id).filter(mode => (mode.purpose === 'media') === (catalog === 'media')); if (modes.length === 1) begin(value.id, modes[0]!.id); else setProvider(value.id);
        })}</View>)}
      {button(t('access.back'), () => provider ? setProvider('') : setCatalog(undefined))}
    </View> : (['connection', 'media'] as const).map(purpose => <View key={purpose} style={{ gap: 12, marginTop: purpose === 'media' ? 8 : 0 }}>
      {purpose === 'media' && <><Text accessibilityRole="header" style={{ ...text, fontWeight: '600' }}>{t('access.media')}</Text><Text style={caption}>{t('access.mediaHelp')}</Text></>}
      {entries.filter(entry => (serverAccessModes(entry.provider).find(mode => mode.id === entry.mode)?.purpose === 'media') === (purpose === 'media')).map(entry => <View key={entry.entryId} style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 16, gap: 12 }}>
        <Text style={{ ...text, fontWeight: '600' }}>{entry.name}</Text><Text style={caption}>{serverAccessProvider(entry.provider)?.name} · {t(`access.${entry.source}`)}</Text>
        <Text accessibilityLiveRegion="polite" style={text}>{t(`access.state.${entry.state}`)}</Text>
        {!!entry.publicOrigin && <Text selectable style={caption}>{entry.publicOrigin}</Text>}
        {entry.pendingChanges && <Text style={caption}>{t('access.pending')}</Text>}{!!entry.issue && <Text style={caption}>{serverAccessIssue(entry.issue, t)}</Text>}
        {entry.source === 'deployment' ? button(t('access.adopt'), () => ask(entry, 'adopt')) : <>
          {button(t('access.edit'), () => { setDraft({ entryId: entry.entryId, revision: entry.revision, provider: entry.provider, mode: entry.mode, name: entry.name, fields: { ...entry.fields }, secrets: entry.configuredSecrets }); setAdvanced(false); })}
          {entry.state === 'source_conflict' ? button(t('access.accept_source'), () => ask(entry, 'accept_source')) : entry.state === 'outcome_unknown' ? button(t('access.reconcile'), () => void run(() => change(entry, 'reconcile')), false, busy)
            : entry.state !== 'active' && button(t('access.start'), () => void run(() => change(entry, 'start')), true, disabled || ['starting', 'stopping'].includes(entry.state))}
          {entry.state === 'starting' && button(t('access.cancel'), () => void run(() => change(entry, 'stop', true)), false, busy)}
          {(entry.enabled || entry.state === 'active') && button(t('access.stop'), () => ask(entry, 'stop'))}
          {button(t('access.delete'), () => ask(entry, 'delete'))}
        </>}
        {entry.source === 'gui' && (entry.fields['resourceMode'] === 'managed' || entry.resourceState) && <View style={{ gap: 12 }}><Text style={caption}>{t('access.resourceHelp')}</Text>
          {!!entry.resourceState && <Text style={caption}>{t('access.resourceState')}: {t(`access.resourceState.${entry.resourceState}`)}</Text>}
          {!!entry.resourceId && <Text selectable style={caption}>{t('access.resourceId')}: {entry.resourceId}</Text>}
          {entry.resourceRequiresDns && <Text style={caption}>{t('access.dns')}</Text>}
          {button(t('access.resource_status'), () => void run(() => change(entry, 'resource_status')))}
          {(!entry.resourceState || ['deleted', 'not_created', 'rejected'].includes(entry.resourceState)) && button(t('access.resource_create'), () => ask(entry, 'resource_create'))}
          {entry.resourceNeedsAdoption && button(t('access.resource_adopt'), () => ask(entry, 'resource_adopt'))}
          {!!entry.resourceId && !entry.resourceNeedsAdoption && button(t('access.resource_delete'), () => ask(entry, 'resource_delete'), false, disabled || entry.state === 'active')}
        </View>}
        {purpose === 'connection' && entry.state === 'active' && <Text style={caption}>{t('access.shareHelp')}</Text>}
      </View>)}
      {purpose === 'connection' && entries.length === 0 && <Text style={caption}>{t('access.empty')}</Text>}
      {button(t(purpose === 'media' ? 'access.addMedia' : 'access.add'), () => { setCatalog(purpose); setProvider(''); }, false, disabled || !settings)}
    </View>)}
  </View>;
}

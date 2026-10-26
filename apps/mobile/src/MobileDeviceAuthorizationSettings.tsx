import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Pressable, Text, TextInput, View } from 'react-native';
import Svg, { Rect } from 'react-native-svg';
import qrcode from 'qrcode-generator';
import { randomUUID } from 'expo-crypto';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import * as Clipboard from 'expo-clipboard';
import { authorizationView, formatDeviceInvitation, formatDeviceTarget, type DeviceAuthorizationOwner, type DeviceAuthorizationView, type DeviceInvitation, type DeviceAuthorizationReview } from '@joko/connection-transport/device-authorization';
import type { MobileSettingsColors } from './MobileSettingsScreen';
import { MobileDeviceInvitationScanner } from './MobileDeviceInvitationScanner';

export function MobileDeviceAuthorizationSettings({ getApi, colors, locale, node, route, reviewRequest }: {
  readonly getApi: () => DeviceAuthorizationOwner; readonly colors: MobileSettingsColors; readonly locale: string; readonly node: string;
  readonly route?: { readonly origin: string; readonly transportKind?: string; readonly serverId?: string; readonly endpointPublicKey?: string };
  readonly reviewRequest?: DeviceAuthorizationReview;
}) {
  const api = useRef<DeviceAuthorizationOwner | undefined>(undefined), alive = useRef(true), lock = useRef(false), polling = useRef(false), revision = useRef(0);
  const [invitation, setInvitation] = useState<DeviceInvitation>(), [origin, setOrigin] = useState('');
  const [rows, setRows] = useState<readonly DeviceAuthorizationView[]>([]), [selected, setSelected] = useState<string>();
  const [code, setCode] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [copied, setCopied] = useState(false);
  const seed = useRef<{ invitationId: string; invitationSecret: string; shortCode: string; allowKnock: boolean; entryIds: string[] } | undefined>(undefined);
  const [scope, setScope] = useState<'all' | 'current' | 'selected'>('all'), [allowedIds, setAllowedIds] = useState<string[]>([]), [optionsOpen, setOptionsOpen] = useState(false);
  const [available, setAvailable] = useState<import('@joko/contracts').NodeConnectionEntry[]>([]), directoryLoaded = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const [shareMode, setShareMode] = useState<'qr' | 'code'>('qr');
  const [entrances, setEntrances] = useState<import('@joko/contracts').NodeConnectionEntry[]>([]), [entryId, setEntryId] = useState('direct');
  const [requestLink, setRequestLink] = useState(''), [entranceReady, setEntranceReady] = useState(true), [carrierOpen, setCarrierOpen] = useState(false);
  const [scanningRequest, setScanningRequest] = useState(false);
  useEffect(() => { const subscription = AppState.addEventListener('change', state => { if (state !== 'active') setScanningRequest(false); }); return () => subscription.remove(); }, []);
  const [now, setNow] = useState(Date.now());
  const [detailsOpen, setDetailsOpen] = useState(false), [lookupOpen, setLookupOpen] = useState(false);
  const zh = locale.startsWith('zh');
  const words = zh ? { invited: '等待新设备使用邀请', pending: '等待批准', approved: '已允许，等待新设备完成', claimed: '设备已添加', denied: '请求已拒绝', cancelled: '请求已取消', expired: '请求已过期' }
    : { invited: 'Waiting for the new device', pending: 'Waiting for approval', approved: 'Approved — waiting for the device', claimed: 'Device added', denied: 'Request denied', cancelled: 'Request cancelled', expired: 'Request expired' };
  const refresh = async () => {
    if (reviewRequest && (route?.serverId !== reviewRequest.serverId || route.endpointPublicKey !== reviewRequest.endpointPublicKey)) throw new Error(zh ? '请求属于其他节点，未发送批准。' : 'This request belongs to another node. No approval was sent.');
    api.current ??= getApi(); const started = revision.current, result = await api.current.list();
    if (alive.current && started === revision.current) { setRows(result); setLoaded(true); }
    if (!reviewRequest && !directoryLoaded.current && api.current.entries) {
      const entries = await api.current.entries();
      if (alive.current && started === revision.current) { setAvailable(entries); directoryLoaded.current = true; }
    }
  };
  const run = async (fn: () => Promise<void>, background = false) => {
    if (lock.current || background && polling.current || AppState.currentState !== 'active') return;
    if (background) polling.current = true;
    else { lock.current = true; revision.current++; setBusy(true); setError(''); }
    const started = revision.current;
    try { api.current ??= getApi(); await fn(); }
    catch (failure) { if (alive.current && started === revision.current) setError(failure instanceof Error ? failure.message : (zh ? '请求失败，请重试。' : 'The request failed. Try again.')); }
    finally { if (background) polling.current = false; else { lock.current = false; if (alive.current) setBusy(false); } }
  };
  useEffect(() => {
    alive.current = true; void run(refresh, true);
    const timer = setInterval(() => { setNow(Date.now()); if (AppState.currentState === 'active') void run(refresh, true); }, 3000);
    return () => { alive.current = false; clearInterval(timer); };
  }, []);
  const text = { color: colors.ink, fontSize: 15, lineHeight: 22 };
  const caption = { color: colors.muted, fontSize: 13, lineHeight: 18 };
  const field = { color: colors.ink, borderColor: colors.border, borderWidth: 1, borderRadius: 12, minHeight: 48, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16 };
  const button = (label: string, action: () => void, disabled = busy, primary = false) => <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={action}
    style={{ paddingHorizontal: 16, paddingVertical: 9, minHeight: 46, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: primary ? colors.brandBackground : undefined, opacity: disabled ? 0.55 : 1 }}>
    <Text style={{ color: colors.accent, fontSize: 15, lineHeight: 22, fontWeight: primary ? '700' : '600' }}>{label}</Text></Pressable>;
  const chosen = rows.find(row => reviewRequest ? row.invitationId === reviewRequest.invitationId && row.requestId === reviewRequest.requestId : row.invitationId === selected);
  const invited = rows.find(row => row.invitationId === invitation?.invitationId);
  const shareable = invitation && invitation.expiresAt > now && (invited === undefined || invited.state === 'invited');
  let link: string | undefined;
  if (shareable && entranceReady) { try { link = formatDeviceInvitation({ ...invitation, origin }); } catch { /* Keep secure-address drafts editable. */ } }
  const target = link && invitation ? formatDeviceTarget({ ...invitation, origin }) : undefined;
  const displayedLink = shareMode === 'code' || seed.current?.allowKnock ? target : link;
  const create = async (allowKnock = false) => {
    if (invitation) { seed.current = undefined; setInvitation(undefined); }
    if (seed.current && seed.current.allowKnock !== allowKnock) throw new Error(zh ? '请先重试原邀请。' : 'Retry the original invitation first.');
    const current = available.find(entry => entry.origin === route?.origin && entry.transportKind === (route?.transportKind ?? 'https'));
    const entryIds = scope === 'all' ? [] : scope === 'current' ? current ? [current.entryId] : [] : allowedIds;
    if (!seed.current && scope !== 'all' && (!entryIds.length || entryIds.some(id => !available.some(entry => entry.entryId === id)))) throw new Error(zh ? '请至少选择一种当前已发布的方式。' : 'Select at least one currently published method.');
    seed.current ??= { invitationId: randomUUID(), invitationSecret: bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(32))),
      shortCode: [...globalThis.crypto.getRandomValues(new Uint8Array(8))].map(byte => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[byte % 32]).join(''), allowKnock, entryIds: [...entryIds] };
    const prepared = seed.current;
    const result = await api.current!.create({ invitationId: prepared.invitationId, invitationSecretDigest: bytesToHex(sha256(new TextEncoder().encode(prepared.invitationSecret))),
      invitationCodeDigest: bytesToHex(sha256(new TextEncoder().encode(prepared.shortCode))), allowKnock: prepared.allowKnock, entryIds: prepared.entryIds });
    const value = authorizationView(result.authorization);
    if (alive.current) { setEntrances(result.entries ?? []); setRequestLink('');
      const entry = result.entries?.find(value => !value.requiresServerSetup && value.origin === route?.origin && value.transportKind === (route?.transportKind ?? 'https'))
        ?? result.entries?.find(value => !value.requiresServerSetup);
      setEntryId(entry?.entryId ?? 'direct'); setEntranceReady(!entry || entry.transportKind === 'https');
      setInvitation({ invitationId: prepared.invitationId, invitationSecret: prepared.invitationSecret,
      origin: entry?.origin ?? result.origin, endpointPublicKey: result.endpointPublicKey, serverId: result.serverId, expiresAt: value.expiresAt }); setOrigin(entry?.origin ?? result.origin); setCopied(false); }
    await refresh();
  };
  const selectedEntry = entrances.find(entry => entry.entryId === entryId);
  const prepareInvitation = async () => {
    if (!invitation || !api.current?.invitationEntry) return;
    const result = await api.current.invitationEntry(invitation, entryId, selectedEntry?.requiresClientIdentity ? requestLink.trim() : undefined);
    if (alive.current) { setInvitation(result); setOrigin(result.origin); setEntranceReady(true); setCopied(false); setCarrierOpen(false); }
  };
  const visible = rows.filter(row => (row.requestId || row.state === 'invited' && row.invitationId !== invitation?.invitationId)
    && (!code.trim() || row.userCode.replaceAll('-', '') === code.toUpperCase().replace(/[\s-]/gu, '')));
  if (reviewRequest && !chosen) return <View style={{ padding: 16, gap: 12 }}><Text accessibilityLiveRegion="polite" style={text}>{error || (loaded
    ? (zh ? '此请求已不可用，未发送批准。' : 'This request is unavailable. No approval was sent.') : (zh ? '正在读取请求…' : 'Loading request…'))}</Text>
    {button(zh ? '重试' : 'Retry', () => void run(refresh))}</View>;
  return <View style={{ backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, padding: 16, borderRadius: 14, gap: 12 }}>
    <View style={{ gap: 4 }}><Text accessibilityRole="header" style={{ ...text, fontSize: 16, fontWeight: '600' }}>{zh ? '添加设备' : 'Add a device'}</Text>
      <Text style={caption}>{node}</Text></View>
    {chosen ? <>
      <View style={{ gap: 4 }}><Text accessibilityRole="header" style={{ ...text, fontWeight: '600' }}>{zh ? '允许这台设备连接？' : 'Allow this device to connect?'}</Text>
        <Text style={text}>{chosen.deviceName} · {chosen.platform}</Text>
        <Text style={caption}>{zh ? '设备名称和平台由请求方提供。' : 'Device name and platform are provided by the requesting client.'}</Text></View>
      <View style={{ alignItems: 'center', gap: 8, padding: 16, borderWidth: 1, borderColor: colors.border, borderRadius: 14 }}>
        <Text style={caption}>{zh ? '匹配码' : 'Matching code'}</Text>
        <Text selectable style={{ ...text, fontSize: 30, lineHeight: 38, fontWeight: '600', letterSpacing: 2 }}>{chosen.userCode}</Text>
      </View>
      <Text style={text}>{zh ? '核对另一台设备上的匹配码。这将授予此节点的普通连接权限；项目和设备操作仍按节点策略确认。仅批准你主动发起的请求。' : 'Match the code on the other device. This grants a normal node connection; project and device actions still follow node policy. Only approve a request you initiated.'}</Text>
      <Text accessibilityLiveRegion="polite" style={text}>{words[chosen.state]}</Text>
      {chosen.state === 'pending' && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {button(zh ? '拒绝' : 'Deny', () => void run(async () => { await api.current!.resolve(chosen.invitationId, chosen.requestId, 'denied'); await refresh(); }), busy || chosen.expiresAt <= now)}
        {button(zh ? '允许连接' : 'Allow connection', () => void run(async () => { await api.current!.resolve(chosen.invitationId, chosen.requestId, 'approved'); await refresh(); }), busy || chosen.expiresAt <= now, true)}
      </View>}
      {chosen.state === 'approved' && button(zh ? '取消请求' : 'Cancel request', () => void run(async () => { await api.current!.resolve(chosen.invitationId, chosen.requestId, 'cancelled'); await refresh(); }))}
      {!reviewRequest && button(zh ? '返回请求列表' : 'Back to requests', () => setSelected(undefined))}
    </> : <>
      <Text style={caption}>{zh ? '请在新设备上扫码或私下分享链接。新设备发起请求后，你还需要核对并批准。' : 'Scan on the new device or privately share the link. Review and approve the specific device after it requests access.'}</Text>
      {!shareable && available.length > 0 && <>
        {button(zh ? '允许的接入方式' : 'Allowed connection methods', () => setOptionsOpen(value => !value))}
        {optionsOpen && <View style={{ gap: 12 }}><Text style={caption}>{zh ? '新设备只能从这些方式中选择。分享邀请所用的入口可在创建后另行选择。' : 'The new device can choose only these methods. Choose the sharing entrance separately after creating the invitation.'}</Text>
          {(['all', 'current', 'selected'] as const).map(value => <View key={value}>{button(value === 'all' ? (zh ? '所有已发布方式' : 'All published methods') : value === 'current' ? (zh ? '仅当前方式' : 'Only the current method') : (zh ? '选择允许的方式' : 'Choose methods'), () => setScope(value), busy || !!seed.current, scope === value)}</View>)}
          {scope === 'selected' && available.map(entry => <Pressable key={entry.entryId} accessibilityRole="checkbox" accessibilityLabel={entry.displayName}
            accessibilityState={{ checked: allowedIds.includes(entry.entryId), disabled: busy || !!seed.current || entry.requiresServerSetup }} disabled={busy || !!seed.current || entry.requiresServerSetup}
            onPress={() => setAllowedIds(ids => ids.includes(entry.entryId) ? ids.filter(id => id !== entry.entryId) : [...ids, entry.entryId])} style={{ paddingVertical: 12, minHeight: 46 }}>
            <Text style={text}>{allowedIds.includes(entry.entryId) ? '✓ ' : '○ '}{entry.provider === 'direct' ? (zh ? '直接连接' : 'Direct connection') : entry.displayName}</Text></Pressable>)}
        </View>}
      </>}
      {shareable ? <>
        {(entrances.length > 1 || !entranceReady) && <>
          {button(zh ? '邀请使用的接入方式' : 'Invitation connection method', () => setCarrierOpen(value => !value))}
          {(carrierOpen || !entranceReady) && <View style={{ gap: 12 }}>{entrances.map(entry => <View key={entry.entryId}>
            {button(entry.provider === 'direct' ? (zh ? '直接连接' : 'Direct connection') : entry.displayName,
              () => { setEntryId(entry.entryId); setEntranceReady(false); }, busy || entry.requiresServerSetup, entry.entryId === entryId)}
            {entry.requiresServerSetup && <Text style={caption}>{zh ? '需先在服务端配置中允许此设备。' : 'The server must admit this device in its carrier configuration first.'}</Text>}
          </View>)}
            {!entranceReady && <>{selectedEntry?.requiresClientIdentity && <>
              {button(zh ? '扫描新设备请求' : 'Scan the new device request', () => setScanningRequest(true))}
              <View style={{ gap: 7 }}><Text style={text}>{zh ? '新设备的请求链接' : 'Request link from the new device'}</Text>
                <TextInput style={field} value={requestLink} onChangeText={setRequestLink} maxLength={512} autoCapitalize="none" accessibilityLabel={zh ? '新设备的请求链接' : 'Request link from the new device'} />
                <Text style={caption}>{zh ? '在新设备选择“通过私有入口连接”，再分享它的请求链接。' : 'Choose “Connect through a private entrance” on the new device and share its request link here.'}</Text></View>
            </>}{button(zh ? '准备此邀请' : 'Prepare this invitation', () => void run(prepareInvitation), busy || !!selectedEntry?.requiresClientIdentity && !requestLink.trim(), true)}</>}
          </View>}
        </>}
        {!seed.current?.allowKnock && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {button(zh ? '二维码或链接' : 'QR code or link', () => setShareMode('qr'), busy, shareMode === 'qr')}
          {button(zh ? '邀请授权码' : 'Invitation code', () => setShareMode('code'), busy, shareMode === 'code')}
        </View>}
        {displayedLink && <>{displayedLink.length <= 1800 ? <InvitationQr value={displayedLink} /> : <Text style={text}>{zh ? '此邀请包含较多连接信息，请分享链接。' : 'Share this invitation as a link; it contains too much connection information for a QR code.'}</Text>}
          {shareMode === 'code' && !seed.current?.allowKnock && <Text selectable style={{ ...text, fontSize: 28, lineHeight: 36, textAlign: 'center', letterSpacing: 2 }}>{seed.current?.shortCode.replace(/^(.{4})/u, '$1-')}</Text>}
          {seed.current?.allowKnock && <Text accessibilityLiveRegion="polite" style={text}>{zh ? '等待一台设备敲门；请核对匹配码后再允许连接。' : 'Waiting for one device request. Review its matching code before approving.'}</Text>}
          {button(zh ? '复制邀请链接' : 'Copy invitation link', () => void run(async () => { await Clipboard.setStringAsync(displayedLink); if (alive.current) setCopied(true); }), busy, true)}
          {copied && <Text accessibilityLiveRegion="polite" style={text}>{zh ? '邀请已复制' : 'Invitation copied'}</Text>}
        </>}
        {button(zh ? '邀请链接与连接地址' : 'Link and connection address', () => setDetailsOpen(value => !value))}
        {entranceReady && (detailsOpen || !link) && <View style={{ gap: 12 }}>
          <View style={{ gap: 7 }}><Text style={text}>{zh ? '新设备可达的 HTTPS 地址' : 'HTTPS address reachable from the new device'}</Text>
            <TextInput style={field} value={origin} onChangeText={value => { setOrigin(value); setCopied(false); }} autoCapitalize="none" keyboardType="url" accessibilityLabel={zh ? '新设备可达的 HTTPS 地址' : 'Reachable HTTPS address'} /></View>
          {link && <Text selectable style={text}>{link}</Text>}
        </View>}
        <Text style={caption}>{zh ? '有效期至 ' : 'Expires '}{new Date(invitation.expiresAt).toLocaleTimeString()}</Text>
        {button(zh ? '取消邀请' : 'Cancel invitation', () => void run(async () => {
          const result = await api.current!.resolve(invitation.invitationId, '', 'cancelled');
          if (alive.current && result.state === 'cancelled') { seed.current = undefined; setInvitation(undefined); }
          await refresh();
        }))}
      </> : <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {button(zh ? '创建邀请' : 'Create invitation', () => void run(() => create()), busy, true)}
        {button(zh ? '允许敲门 10 分钟' : 'Allow knocking for 10 minutes', () => void run(() => create(true)), busy)}
      </View>}
      <View style={{ gap: 12, borderTopWidth: 1, borderColor: colors.border, paddingTop: 16 }}>
      <Text accessibilityRole="header" style={{ ...text, fontWeight: '600' }}>{zh ? '设备请求' : 'Device requests'}</Text>
      {rows.some(row => row.requestId) && button(zh ? '按匹配码查找' : 'Find by matching code', () => setLookupOpen(value => !value))}
      {lookupOpen && <TextInput style={field} value={code} onChangeText={setCode} maxLength={16} autoCapitalize="characters" accessibilityLabel={zh ? '按匹配码查找' : 'Find by matching code'} placeholder={zh ? '按匹配码查找' : 'Find by matching code'} placeholderTextColor={colors.muted} />}
      {visible.length === 0 && <Text style={caption}>{zh ? '暂无设备请求' : 'No device requests yet'}</Text>}
      {visible.map(row => <View key={row.invitationId} style={{ gap: 8 }}><Text style={text}>{row.requestId ? `${row.deviceName} · ${row.userCode}` : (zh ? '尚未使用的邀请' : 'Unused invitation')} · {words[row.state]}</Text>
        {!row.requestId && <Text style={text}>{zh ? '有效期至 ' : 'Expires '}{new Date(row.expiresAt).toLocaleTimeString()}</Text>}
        {row.requestId ? button(zh ? '核对请求' : 'Review request', () => setSelected(row.invitationId))
          : button(zh ? '取消邀请' : 'Cancel invitation', () => void run(async () => {
            await api.current!.resolve(row.invitationId, '', 'cancelled'); await refresh();
          }), busy || row.expiresAt <= now)}</View>)}
      </View></>}
    {error !== '' && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{error}</Text>}
    {scanningRequest && <MobileDeviceInvitationScanner locale={locale} mode="request" onClose={() => setScanningRequest(false)} onResult={value => { setRequestLink(value); setScanningRequest(false); }} />}
  </View>;
}
function InvitationQr({ value }: { readonly value: string }) {
  const qr = useMemo(() => { const result = qrcode(0, 'M'); result.addData(value); result.make(); return result; }, [value]);
  const size = qr.getModuleCount();
  return <Svg accessibilityLabel="Joko invitation QR" width="100%" height={240} viewBox={`0 0 ${size + 8} ${size + 8}`}>
    <Rect width={size + 8} height={size + 8} fill="white" />
    {Array.from({ length: size }, (_, y) => Array.from({ length: size }, (_, x) => qr.isDark(y, x) ? <Rect key={`${x}-${y}`} x={x + 4} y={y + 4} width={1} height={1} fill="black" /> : null))}
  </Svg>;
}

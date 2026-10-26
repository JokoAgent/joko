import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { formatTrustedNodeInvitation, type NodePairingInvitation } from '@joko/connection-transport/trust';
import type { MobileClient } from './mobile-client';
import type { MobileSettingsColors } from './MobileSettingsScreen';
import { randomUUID } from 'expo-crypto';

export function MobileDevicePairingInvitation({ client, owner, colors, locale, iroh = false }: {
  readonly client: Pick<MobileClient, 'authorizeNewDevice' | 'cancelDevicePairing'>;
  readonly owner: string;
  readonly colors: MobileSettingsColors;
  readonly locale: string;
  readonly iroh?: boolean;
}) {
  const current = useRef({ owner });
  if (current.current.owner !== owner) current.current = { owner };
  const inFlight = useRef<object | undefined>(undefined);
  const [value, setValue] = useState<NodePairingInvitation>();
  const [recipientOrigin, setRecipientOrigin] = useState('');
  const [recipientEndpointId, setRecipientEndpointId] = useState('');
  const relayRequest = useRef<{ readonly recipientEndpointId: string; readonly requestId: string } | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const zh = locale.startsWith('zh');
  useEffect(() => { inFlight.current = undefined; setValue(undefined); setRecipientOrigin(''); setRecipientEndpointId(''); relayRequest.current = undefined; setError(''); setBusy(false); setExpanded(false); }, [owner]);
  useEffect(() => { if (!value) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [value]);
  const perform = async (cancel: boolean) => {
    if (inFlight.current !== undefined) return;
    const expected = current.current, operation = {}; inFlight.current = operation; setBusy(true); setError('');
    try {
      if (cancel && value) { await client.cancelDevicePairing(value); if (current.current === expected) setValue(undefined); }
      else {
        const recipient = recipientEndpointId.trim();
        if (recipient !== '' && !/^[a-f0-9]{64}$/u.test(recipient)) throw new Error(zh ? '请输入新设备完整的 64 位小写 iroh 公钥。' : 'Enter the new device complete 64-character lowercase iroh public key.');
        if (recipient !== '' && relayRequest.current?.recipientEndpointId !== recipient) relayRequest.current = { recipientEndpointId: recipient, requestId: randomUUID() };
        const result = await client.authorizeNewDevice(recipient === '' ? undefined : { irohRelay: relayRequest.current! });
        if (current.current === expected) { setNow(Date.now()); setRecipientOrigin(result.origin); setValue(result); }
      }
    } catch (failure) { if (current.current === expected) setError(failure instanceof Error ? failure.message : 'Pairing failed.'); }
    finally { if (inFlight.current === operation) { inFlight.current = undefined; if (current.current === expected) setBusy(false); } }
  };
  const active = value !== undefined && value.expiresAt > now;
  let sharedInvitation: string | undefined;
  if (value) { try { sharedInvitation = recipientOrigin === value.origin ? value.trustedInvitation : formatTrustedNodeInvitation({ ...value, origin: recipientOrigin }); } catch { /* Keep invalid address drafts editable. */ } }
  const text = { color: colors.ink, fontSize: 15, lineHeight: 22 };
  const caption = { color: colors.muted, fontSize: 13, lineHeight: 18 };
  const field = { color: colors.ink, borderColor: colors.border, borderWidth: 1, borderRadius: 12, minHeight: 48, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16 };
  const manualLabel = zh ? '手动配置' : 'Manual setup';
  return <View style={{ gap: 8 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={manualLabel} accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)}
      style={{ minHeight: 46, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Text style={[caption, { flex: 1 }]}>{manualLabel}</Text>
      <Text accessibilityElementsHidden importantForAccessibility="no" style={{ color: colors.muted, fontSize: 22, lineHeight: 24 }}>{expanded ? '⌄' : '›'}</Text>
    </Pressable>
    {expanded && <View style={{ padding: 16, gap: 12, backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 14 }}>
    <View style={{ gap: 4 }}>
      <Text style={[text, { fontWeight: '600' }]}>{zh ? '授权新设备' : 'Authorize a new device'}</Text>
      <Text style={caption}>{zh ? '请私下向新设备交付可信邀请与一次性码。取消会使未用码失效；若结果不确定，请在设备列表核对并撤销意外连接。' : 'Privately give the new device this trusted invitation and one-time code. Cancel invalidates the unused code. Check and revoke unexpected connections if the result is uncertain.'}</Text>
    </View>
    {iroh && <View style={{ gap: 7 }}>
      <Text style={text}>{zh ? '新设备 iroh 公钥' : 'New device iroh public key'}</Text>
      <TextInput accessibilityLabel={zh ? '新设备 iroh 公钥' : 'New device iroh public key'} value={recipientEndpointId} onChangeText={setRecipientEndpointId} maxLength={64} autoCapitalize="none" autoCorrect={false} editable={!busy && !active} style={field} />
      <Text style={caption}>{zh ? '付费或受限中继必填。新设备先生成自己的本机 iroh 密钥，再通过可信通道交付公钥；节点只签发该公钥的短期使用租约。免费或开放中继可留空；失败后保留原请求编号重试。' : 'Required for paid or restricted relays. The new device first generates its own local iroh key and shares its public key through a trusted channel. The node issues a short relay-use lease for that key. Leave empty for a free or open relay. Failed attempts retain their original request ID.'}</Text>
    </View>}
    {active && <>
      <View style={{ gap: 7 }}><Text style={text}>{zh ? '新设备可达的节点地址' : 'Address reachable from the new device'}</Text>
        <TextInput accessibilityLabel={zh ? '新设备可达的节点地址' : 'Address reachable from the new device'} value={recipientOrigin} onChangeText={setRecipientOrigin} editable={value.endpointTransport === undefined} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={field} />
        {value.endpointTransport !== undefined && <Text style={caption}>{zh ? '私有 SDK 邀请已包含连接定位信息，请保留已核验的节点地址并交付完整邀请。' : 'This private SDK invitation already contains its connection address. Keep the verified node address and share the complete invitation.'}</Text>}
      </View>
      <TextInput accessibilityLabel={zh ? '可信节点邀请' : 'Trusted node invitation'} editable={false} multiline value={sharedInvitation ?? ''} style={field} />
      <View style={{ gap: 4 }}><Text selectable style={{ color: colors.ink, fontSize: 24, lineHeight: 32 }}>{value.humanCode}</Text>
        <Text style={caption}>{zh ? '有效期至 ' : 'Expires '}{new Date(value.expiresAt).toLocaleTimeString()}</Text></View>
    </>}
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy} onPress={() => void perform(active)} style={{ alignSelf: 'flex-start', alignItems: 'center', justifyContent: 'center', minHeight: 46, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 9, opacity: busy ? 0.55 : 1 }}>
      <Text style={{ color: colors.accent, fontSize: 15, lineHeight: 22, fontWeight: '600' }}>{active ? (zh ? '取消此邀请' : 'Cancel invitation') : (zh ? '授权新设备' : 'Authorize a new device')}</Text>
    </Pressable>
    {error !== '' && <Text accessibilityRole="alert" style={[text, { color: colors.negative }]}>{error}</Text>}
    </View>}
  </View>;
}

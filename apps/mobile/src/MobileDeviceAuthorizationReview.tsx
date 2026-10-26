import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { DeviceAuthorizationReview } from '@joko/connection-transport/device-authorization';
import type { MobileClient, MobileState } from './mobile-client';
import type { MobileSettingsColors } from './MobileSettingsScreen';
import { MobileDeviceAuthorizationSettings } from './MobileDeviceAuthorizationSettings';

export function MobileDeviceAuthorizationReview({ client, state, review, colors, locale, foreground, onClose }: {
  readonly client: MobileClient; readonly state: MobileState; readonly review: DeviceAuthorizationReview;
  readonly colors: MobileSettingsColors; readonly locale: string; readonly foreground: boolean; readonly onClose: () => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const zh = locale.startsWith('zh');
  const profile = state.saved.find(value => value.serverId === review.serverId && value.endpointPublicKey === review.endpointPublicKey);
  const active = foreground && profile && state.activeProfileId === profile.profileId && state.status === 'connected';
  return <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
    <Pressable accessibilityRole="button" onPress={() => { if (busy) client.cancel(); onClose(); }} style={{ minHeight: 46, justifyContent: 'center' }}><Text style={{ color: colors.accent }}>{zh ? '返回' : 'Back'}</Text></Pressable>
    <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: 20, lineHeight: 26, fontWeight: '600' }}>{zh ? '核对设备请求' : 'Review device request'}</Text>
    {active ? <MobileDeviceAuthorizationSettings key={`${profile.profileId}:${profile.origin}:${profile.transportKind}:${review.requestId}`}
      getApi={() => client.deviceAuthorizationOwner()} colors={colors} locale={locale} node={profile.displayName} route={profile} reviewRequest={review} /> : <View style={{ padding: 16, gap: 12, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}>
      <Text style={{ color: colors.ink, fontSize: 15, lineHeight: 22 }}>{profile ? (zh ? '连接已保存的节点后核对请求。' : 'Connect to the saved node to review this request.')
        : (zh ? '请在已获此节点授权的设备上打开该链接。' : 'Open this link on a device already authorized for this node.')}</Text>
      {profile && <Pressable accessibilityRole="button" disabled={busy || !foreground} accessibilityState={{ disabled: busy || !foreground }} onPress={() => {
        setBusy(true); setError(''); void client.connectSaved(profile.profileId).catch(failure => setError(failure instanceof Error ? failure.message : String(failure))).finally(() => setBusy(false));
      }} style={{ minHeight: 46, padding: 12, borderRadius: 12, backgroundColor: colors.brandBackground }}><Text style={{ color: colors.accent }}>{profile.displayName} · {zh ? '连接并核对' : 'Connect to review'}</Text></Pressable>}
      {error !== '' && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{error}</Text>}
    </View>}
  </ScrollView>;
}

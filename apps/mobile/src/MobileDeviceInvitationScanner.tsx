import { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { parseDeviceTarget, parseDeviceTransportRequest } from '@joko/connection-transport/device-authorization';

/** Mounted only after a scan action; the host retires it on background/document change. */
export function MobileDeviceInvitationScanner({ locale, onResult, onClose, mode = 'invitation' }: {
  readonly locale: string; readonly onResult: (link: string) => void; readonly onClose: () => void; readonly mode?: 'invitation' | 'request';
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const requested = useRef(false), captured = useRef(false);
  const [invalid, setInvalid] = useState(false);
  const [permissionError, setPermissionError] = useState(false);
  const zh = locale.startsWith('zh');
  useEffect(() => {
    if (requested.current) return; requested.current = true;
    void requestPermission().catch(() => setPermissionError(true));
  }, [requestPermission]);
  return <Modal animationType="none" onRequestClose={onClose}>
    <View style={{ flex: 1, padding: 24, paddingTop: 60, gap: 20, backgroundColor: '#111' }}>
      <Text accessibilityRole="header" style={{ color: 'white', fontSize: 22 }}>{mode === 'request' ? (zh ? '扫描新设备上的请求' : 'Scan the request on the new device') : (zh ? '扫描已连接设备上的邀请' : 'Scan the invitation on the connected device')}</Text>
      {permission?.granted && !invalid && <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => {
          if (captured.current) return;
          captured.current = true;
          try { if (mode === 'request') parseDeviceTransportRequest(data); else parseDeviceTarget(data); onResult(data); }
          catch { setInvalid(true); }
        }} />}
      {(permissionError || permission && !permission.granted) && <Text accessibilityRole="alert" style={{ color: 'white' }}>{zh ? '无法使用相机。返回后可粘贴邀请链接。' : 'Camera access is unavailable. Go back to paste an invitation link.'}</Text>}
      {invalid && <><Text accessibilityRole="alert" style={{ color: 'white' }}>{zh ? '这不是有效的 Joko 设备邀请。' : 'This is not a valid Joko device invitation.'}</Text>
        <Pressable accessibilityRole="button" onPress={() => { captured.current = false; setInvalid(false); }} style={{ padding: 16 }}><Text style={{ color: 'white' }}>{zh ? '重新扫描' : 'Scan again'}</Text></Pressable></>}
      <Pressable accessibilityRole="button" onPress={onClose} style={{ padding: 16 }}><Text style={{ color: 'white' }}>{zh ? '返回 / 粘贴链接' : 'Back / paste link'}</Text></Pressable>
    </View>
  </Modal>;
}

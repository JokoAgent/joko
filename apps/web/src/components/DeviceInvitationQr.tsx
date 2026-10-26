import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

export function DeviceInvitationQr({ value, label }: { readonly value: string; readonly label: string }) {
  const qr = useMemo(() => { const result = qrcode(0, 'M'); result.addData(value); result.make(); return result; }, [value]);
  const size = qr.getModuleCount();
  return <svg role="img" aria-label={label} className="device-authorization__qr" viewBox={`0 0 ${size + 8} ${size + 8}`} shapeRendering="crispEdges">
    <rect width={size + 8} height={size + 8} fill="white" />
    {Array.from({ length: size }, (_, y) => Array.from({ length: size }, (_, x) => qr.isDark(y, x)
      ? <rect key={`${x}-${y}`} x={x + 4} y={y + 4} width="1" height="1" fill="black" /> : null))}
  </svg>;
}

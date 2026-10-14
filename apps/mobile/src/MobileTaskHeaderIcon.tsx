import Svg, { Path, Rect, Circle } from "react-native-svg";

export function MobileTaskHeaderIcon({ id, color, size = 24 }: { readonly id: string; readonly color: string; readonly size?: number }) {
  return <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    {id === "remote-desktop" ? <><Rect x={2} y={3} width={20} height={14} rx={2} /><Path d="M8 21h8m-4-4v4" /></>
      : id === "files" ? <Path d="M20 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2Z" />
      : id === "back" ? <Path d="m15 18-6-6 6-6" />
      : id === "list" ? <Path d="M4 6h16M4 12h16M4 18h16" />
      : id === "pin" ? <Path d="M12 17v5m-4-12V4l-1-1h10l-1 1v6l3 3v2H5v-2Z" />
      : id === "new" ? <><Path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><Path d="m16 3 5 5-10 10-5 1 1-5Z" /></>
      : <><Circle cx={5} cy={12} r={1} /><Circle cx={12} cy={12} r={1} /><Circle cx={19} cy={12} r={1} /></>}
  </Svg>;
}

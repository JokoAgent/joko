import Svg, { Circle, Path, Rect } from "react-native-svg";

export function MobileGroupIcon({ name, color, size = 16 }: { name: "back" | "settings" | "plus" | "send" | "stop" | "check" | "failed" | "pending" | "file" | "close"; color: string; size?: number }) {
  return <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    {name === "back" && <Path d="m15 18-6-6 6-6" />}
    {name === "plus" && <Path d="M12 5v14M5 12h14" />}
    {name === "close" && <Path d="m6 6 12 12M6 18 18 6" />}
    {name === "send" && <Path d="m22 2-7 20-4-9-9-4 20-7ZM22 2 11 13" />}
    {name === "stop" && <Rect x={6} y={6} width={12} height={12} rx={1} fill={color} />}
    {(name === "check" || name === "failed" || name === "pending") && <Circle cx={12} cy={12} r={9} strokeDasharray={name === "pending" ? "3 3" : undefined} />}
    {name === "check" && <Path d="m8 12 3 3 5-6" />}
    {name === "failed" && <Path d="M12 8v5M12 16h.01" />}
    {name === "file" && <Path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6ZM14 2v6h6M8 13h8M8 17h6" />}
    {name === "settings" && <><Path d="m9.5 2-.5 2.5-2 1.2-2.4-.8-2.4 4.2 1.9 1.7v2.4L2.2 15l2.4 4.2 2.4-.8 2 1.2.5 2.4h5l.5-2.4 2-1.2 2.4.8 2.4-4.2-1.9-1.8v-2.4l1.9-1.7-2.4-4.2-2.4.8-2-1.2-.5-2.5h-5Z" /><Circle cx={12} cy={12} r={3} /></>}
  </Svg>;
}

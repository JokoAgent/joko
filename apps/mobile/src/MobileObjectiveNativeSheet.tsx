import type { MobileObjectiveViewProps } from "./MobileObjectiveView";
export interface MobileObjectiveNativeSheetProps extends MobileObjectiveViewProps {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly onRetry?: () => void;
  readonly loading: boolean;
}
export function MobileObjectiveNativeSheet(_props: MobileObjectiveNativeSheetProps) { return null; }

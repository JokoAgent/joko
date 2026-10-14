import type { MobileCollaborationViewProps } from "./MobileCollaborationView";
export interface MobileCollaborationNativeSheetProps extends MobileCollaborationViewProps {
  readonly visible: boolean;
  readonly dark?: boolean;
  readonly onClose: () => void;
}
export function MobileCollaborationNativeSheet(_props: MobileCollaborationNativeSheetProps) { return null; }

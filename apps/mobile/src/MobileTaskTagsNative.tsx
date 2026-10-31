import type { TaskTagColor } from "@joko/contracts";
import type { MobileTaskTagColors } from "./MobileTaskTags";
import type { MobileSupportedLocale } from "./mobile-locale-preference";

export interface MobileTaskTagNativeForm {
  readonly name: string; readonly color: TaskTagColor; readonly canSave: boolean;
  readonly onName: (value: string) => void; readonly onColor: (value: TaskTagColor) => void;
  readonly onSave: () => void;
}
export interface MobileTaskTagsNativeProps {
  readonly visible: boolean; readonly busy: boolean; readonly error: string;
  readonly adding: boolean; readonly onAdd: () => void; readonly onMove: (from: number, to: number) => void;
  readonly revision: bigint;
  readonly colors: MobileTaskTagColors; readonly locale: MobileSupportedLocale; readonly subtitle?: string;
  readonly items: readonly { readonly id: string; readonly name: string; readonly color: string; readonly attached: boolean;
    readonly onToggle: () => void; readonly onEdit: () => void }[];
  readonly palette: readonly { readonly value: TaskTagColor; readonly name: string; readonly hex: string }[];
  readonly create: MobileTaskTagNativeForm; readonly edit?: MobileTaskTagNativeForm;
  readonly onDelete: () => void; readonly onBack: () => void; readonly onClose: () => void;
}
export const mobileTaskTagsNativeAvailable = false;
export function MobileTaskTagsNative(_props: MobileTaskTagsNativeProps) { return null; }

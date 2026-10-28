import { MobileActionSheet } from "./MobileActionSheet";

export type MobileTaskOptionsSheetProps<Action extends string> = Parameters<typeof MobileActionSheet<Action>>[0];
export function MobileTaskOptionsSheet<Action extends string>(props: MobileTaskOptionsSheetProps<Action>) {
  return <MobileActionSheet {...props} />;
}

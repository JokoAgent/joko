export interface MobileConversationSearchNativeProps {
  readonly visible: boolean; readonly query: string; readonly counter: string; readonly hasHits: boolean;
  readonly title: string; readonly placeholder: string; readonly clearLabel: string; readonly previousLabel: string; readonly nextLabel: string;
  readonly earlier: { readonly visible: boolean; readonly disabled: boolean; readonly label: string };
  readonly failed?: string;
  readonly colors: { readonly surface: string; readonly ink: string; readonly muted: string; readonly negative: string; readonly dark?: boolean };
  readonly onChangeQuery: (value: string) => void; readonly onClose: () => void;
  readonly onMove: (direction: "previous" | "next") => void; readonly onLoadEarlier: () => void;
}

/** The iOS resolver supplies the SwiftUI implementation. Other platforms use
 * the shared sheet's native React Native surface. */
export function MobileConversationSearchNative(_props: MobileConversationSearchNativeProps): null { return null; }

import { createContext, useContext, useLayoutEffect, useRef, type ReactNode } from "react";

export interface MobileNavigationButton {
  readonly id: string;
  readonly label: string;
  readonly symbol: string;
  readonly disabled: boolean;
  readonly expanded?: boolean;
  readonly onPress: () => void;
}
export interface MobileNavigationHeader {
  readonly mode: "horizontal" | "rail" | "hidden";
  readonly ink: string;
  readonly left: ReactNode;
  readonly title: ReactNode;
  readonly right: ReactNode;
  readonly leading: readonly MobileNavigationButton[];
  readonly trailing: readonly MobileNavigationButton[];
}
export interface MobileNavigationHeaderPort {
  readonly native: boolean;
  readonly height: number;
  readonly publish: (owner: symbol, header: MobileNavigationHeader) => void;
  readonly retire: (owner: symbol) => void;
}
export const MobileNavigationHeaderContext = createContext<MobileNavigationHeaderPort>({
  native: false, height: 0, publish() {}, retire() {}
});

/** A presentation slot; task and draft navigation keep their existing owner. */
export function useMobileNavigationHeader(header: MobileNavigationHeader): MobileNavigationHeaderPort {
  const port = useContext(MobileNavigationHeaderContext);
  const owner = useRef(Symbol("task-header"));
  useLayoutEffect(() => {
    if (port.native) port.publish(owner.current, header);
  }, [header, port.native, port.publish]);
  useLayoutEffect(() => () => port.retire(owner.current), [port.retire]);
  return port;
}

import { useMemo } from "react";
import type { CSSProperties, HTMLAttributes, JSX } from "react";

type Props = HTMLAttributes<HTMLElement> & { readonly as: "span" | "li"; readonly startedAt: number };

/** A mounted word owns its delay; appends never rewrite historical styles. */
export function TimelineFadeElement({ as: Element, startedAt, style, ...props }: Props): JSX.Element {
  const delay = useMemo(() => Math.min(0, Math.round(startedAt - performance.now())), [startedAt]);
  return <Element {...props} style={{ ...style, "--wf-delay": `${delay}ms` } as CSSProperties} />;
}

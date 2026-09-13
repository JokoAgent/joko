import { cloneElement, isValidElement, useLayoutEffect, useMemo, useRef } from "react";
import type { ComponentProps, JSX, ReactNode } from "react";
import renderMarkdown from "react-markdown";

type MarkdownOptions = Pick<ComponentProps<typeof renderMarkdown>, "children" | "components" | "rehypePlugins" | "remarkPlugins" | "skipHtml" | "urlTransform">;
interface Block {
  readonly element: ReactNode;
  readonly signature: string | undefined;
}
interface DocumentSnapshot {
  readonly components: MarkdownOptions["components"];
  readonly blocks: readonly Block[];
}

/** Parse the complete document so later definitions can change earlier blocks. */
export function TimelineMarkdownDocument(options: MarkdownOptions): JSX.Element {
  const committed = useRef<DocumentSnapshot | undefined>(undefined);
  const candidate = useMemo(() => {
    // react-markdown's synchronous export has no hooks; it applies its URL and
    // HTML policies before returning the processed document's React elements.
    const document = renderMarkdown(options);
    const children = (document.props as { readonly children?: ReactNode }).children;
    const previous = committed.current !== undefined && committed.current.components === options.components ? committed.current.blocks : undefined;
    const blocks = (Array.isArray(children) ? children : [children]).map((element, index): Block => {
      const node = isValidElement<{ readonly node?: unknown }>(element) ? element.props.node : undefined;
      const signature = node === undefined ? undefined : JSON.stringify(node);
      const old = previous?.[index];
      const reusable = signature !== undefined && signature === old?.signature
        && isValidElement(old.element) && isValidElement(element)
        && element.type === old.element.type && element.key === old.element.key;
      return { element: reusable ? old.element : element, signature };
    });
    return {
      snapshot: { components: options.components, blocks },
      element: cloneElement(document, undefined, ...blocks.map((block) => block.element))
    };
  }, [options.children, options.components, options.rehypePlugins, options.remarkPlugins, options.skipHtml, options.urlTransform]);
  useLayoutEffect(() => { committed.current = candidate.snapshot; }, [candidate]);
  return candidate.element;
}

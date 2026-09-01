import type { JSX } from "react";
import type { TimelineMessageUsageView } from "../model.js";
import { messageUsagePresentation } from "./message-usage.js";
import type { Translator } from "./types.js";
import { Tip } from "./ui.js";

export function MessageUsageMeta({ usage, t }: {
  readonly usage?: TimelineMessageUsageView;
  readonly t: Translator;
}): JSX.Element {
  const presentation = messageUsagePresentation(usage, t);
  if (presentation === undefined) return <></>;
  return <Tip
    text={presentation.tooltipLines.join("\n")}
    className="message-usage-meta"
    focusable
    preformatted
  ><span>{presentation.label}</span></Tip>;
}

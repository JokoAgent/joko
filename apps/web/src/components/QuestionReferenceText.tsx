import { questionWorkspaceReference, splitQuestionReferences } from "@joko/contracts";
import { advanceChatUrlContext, chatUrlEnd, createChatUrlContext } from "../chat-url-boundary.js";
import { TimelineMarkdownLink, type TimelineReferenceActions } from "./TimelineReferenceContent.js";

export function QuestionReferenceText({ text, actions, workspaceRoot }: { readonly text: string; readonly actions: TimelineReferenceActions; readonly workspaceRoot?: string }) {
  return <span className="question-reference-text" onKeyDown={event => {
    if (event.target instanceof event.currentTarget.ownerDocument.defaultView!.Element && event.target.closest("a, button")) event.stopPropagation();
  }} onClick={event => {
    if (event.target instanceof event.currentTarget.ownerDocument.defaultView!.Element && event.target.closest("a, button")) event.stopPropagation();
  }}>{splitQuestionReferences(text, (raw, prefix) => {
    const context = createChatUrlContext(); advanceChatUrlContext(context, prefix);
    return raw.slice(0, chatUrlEnd(raw, context));
  }).map((part, index) => {
    const href = part.href === undefined ? undefined : /^https?:\/\//iu.test(part.href) ? part.href : questionWorkspaceReference(part.href, workspaceRoot);
    return href === undefined ? <span key={index}>{part.text}</span>
      : <TimelineMarkdownLink key={index} href={href} actions={{ ...actions, ownerKey: JSON.stringify([actions.ownerKey, workspaceRoot]), sourceKey: text }}>{part.text}</TimelineMarkdownLink>;
  })}</span>;
}

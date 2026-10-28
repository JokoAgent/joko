import { ArrowLeft, ListTodo, Menu, RefreshCcw, Settings2 } from "lucide-react";
import type { JSX, ReactNode } from "react";

import type { SessionView } from "../model.js";
import { usePartnerConversation } from "./PartnerConversation.js";
import { PartnerAvatar } from "./PartnerAvatar.js";
import { IconButton, Spinner } from "./ui.js";
import type { Translator } from "./types.js";
import { PartnerAutonomyPanel } from "./PartnerAutonomyPanel.js";

export function PartnerConversationHeader({ session, navigationOpen, onOpenNavigation, t, children }: {
  readonly session: SessionView;
  readonly navigationOpen: boolean;
  readonly onOpenNavigation: () => void;
  readonly t: Translator;
  readonly children: ReactNode;
}): JSX.Element {
  const conversation = usePartnerConversation();
  if (conversation === undefined) throw new Error("Partner conversation header requires its view owner.");
  if (conversation.kind === "task" && (conversation.confirmed || !conversation.connected)) return <>{children}</>;
  const { partner, editable, failed, confirmed, openSettings } = conversation;
  const zh = conversation.locale === 'zh-CN';
  return <header className="session-header partner-conversation-header" aria-busy={!confirmed && !failed}>
    <div className="session-header__leading">
      {conversation.returnToMain && <IconButton label={zh ? '返回私聊原消息' : 'Return to the original private message'} onClick={conversation.returnToMain}><ArrowLeft aria-hidden="true" /></IconButton>}
      {!navigationOpen && <IconButton className="mobile-panel-toggle" label={t("a11y.openNavigation")} onClick={onOpenNavigation}><Menu aria-hidden="true" /></IconButton>}
      {partner !== undefined ? <button type="button" className="partner-conversation-identity" onClick={() => openSettings()} disabled={!editable}
        aria-label={t("partners.settingsTitle", { name: partner.displayName })} title={t("partners.settingsTitle", { name: partner.displayName })}
      ><PartnerAvatar preset={partner.avatar} partner={partner} /><span>{partner.displayName}{conversation.topicRoot ? ` · ${session.name}` : ''}</span></button>
        : <span className="partner-conversation-placeholder">{!failed && <Spinner />}{failed ? session.name : t("partners.loading")}</span>}
    </div>
    <div className="session-header__actions">
      {conversation.autonomyApi && partner && <PartnerAutonomyPanel key={conversation.ownerKey} api={conversation.autonomyApi} partnerId={partner.id}
        name={partner.displayName} locale={conversation.locale} engaged={!!conversation.engaged} onOpenTask={conversation.openObservedTask ?? (() => undefined)} />}
      {conversation.toggleReplyQuotes && <button type="button" aria-pressed={conversation.showReplyQuotes} onClick={conversation.toggleReplyQuotes}>{zh ? '显示引用' : 'Show reply quotes'}</button>}
      {conversation.quoteSettingFailed && <span role="alert">{zh ? '显示设置保存失败，请重试。' : 'The display setting could not be saved. Retry.'}</span>}
      {conversation.topicFailed && <span role="alert">{zh ? '打开话题失败，请在原消息上重试。' : 'The topic could not be opened. Retry from the original message.'}</span>}
      {!!conversation.topics?.length && <details><summary>{zh ? '私聊话题' : 'Private topics'}</summary><div>
        {conversation.topics.map(topic => <button key={topic.sessionId} type="button" disabled={!editable} onClick={() => conversation.openTopicSession?.(topic.sessionId)}>{topic.displayName}</button>)}
      </div></details>}
      {conversation.workbenchOpenFailed && <span role="alert" className="partner-conversation-error">{t("workbench.openFailed")}</span>}
      {conversation.workbenchAvailable && <IconButton label={t("workbench.title")} disabled={!editable} onClick={conversation.openWorkbench}><ListTodo aria-hidden="true" /></IconButton>}
      {failed && <span className="partner-conversation-error" role="status">{t("partners.reloadFailed")}</span>}
      {failed && conversation.connected && <IconButton label={t("common.retry")} onClick={conversation.refresh}><RefreshCcw aria-hidden="true" /></IconButton>}
      {partner !== undefined && <IconButton label={t("partners.profileSettings")} onClick={() => openSettings()} disabled={!editable} aria-haspopup="dialog"><Settings2 aria-hidden="true" /></IconButton>}
    </div>
  </header>;
}

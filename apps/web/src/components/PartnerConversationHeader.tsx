import { ListTodo, Menu, RefreshCcw, Settings2 } from "lucide-react";
import type { JSX, ReactNode } from "react";

import type { SessionView } from "../model.js";
import { usePartnerConversation } from "./PartnerConversation.js";
import { PartnerAvatar } from "./PartnerAvatar.js";
import { IconButton, Spinner } from "./ui.js";
import type { Translator } from "./types.js";

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
  return <header className="session-header partner-conversation-header" aria-busy={!confirmed && !failed}>
    <div className="session-header__leading">
      {!navigationOpen && <IconButton className="mobile-panel-toggle" label={t("a11y.openNavigation")} onClick={onOpenNavigation}><Menu aria-hidden="true" /></IconButton>}
      {partner !== undefined ? <button type="button" className="partner-conversation-identity" onClick={() => openSettings()} disabled={!editable}
        aria-label={t("partners.settingsTitle", { name: partner.displayName })} title={t("partners.settingsTitle", { name: partner.displayName })}
      ><PartnerAvatar preset={partner.avatar} partner={partner} /><span>{partner.displayName}</span></button>
        : <span className="partner-conversation-placeholder">{!failed && <Spinner />}{failed ? session.name : t("partners.loading")}</span>}
    </div>
    <div className="session-header__actions">
      {conversation.workbenchOpenFailed && <span role="alert" className="partner-conversation-error">{t("workbench.openFailed")}</span>}
      {conversation.workbenchAvailable && <IconButton label={t("workbench.title")} disabled={!editable} onClick={conversation.openWorkbench}><ListTodo aria-hidden="true" /></IconButton>}
      {failed && <span className="partner-conversation-error" role="status">{t("partners.reloadFailed")}</span>}
      {failed && conversation.connected && <IconButton label={t("common.retry")} onClick={conversation.refresh}><RefreshCcw aria-hidden="true" /></IconButton>}
      {partner !== undefined && <IconButton label={t("partners.profileSettings")} onClick={() => openSettings()} disabled={!editable} aria-haspopup="dialog"><Settings2 aria-hidden="true" /></IconButton>}
    </div>
  </header>;
}

import { Bot, CircleAlert, MessageSquare, Pencil, RefreshCcw } from "lucide-react";
import { useRef, useState, type JSX } from "react";
import type { AppController } from "../controller.js";
import { partnerSourceKey, type PartnerSourceView } from "../partner-sources.js";
import { PartnerAvatar, PartnerAvatarProvider } from "./PartnerAvatar.js";
import type { Translator } from "./types.js";
import { Button, Pill, Spinner } from "./ui.js";

export function PartnerSources({ controller, archived, t }: { readonly controller: AppController; readonly archived: boolean; readonly t: Translator }): JSX.Element {
  const active = controller.state.activeProfile;
  const key = active && partnerSourceKey(active);
  if (archived) return <></>;
  return <>{(controller.state.partnerSources ?? []).filter(source => source.key !== key).map(source =>
    <PartnerSourceSection key={source.key} controller={controller} source={source} t={t} />)}</>;
}

function PartnerSourceSection({ controller, source, t }: { readonly controller: AppController; readonly source: PartnerSourceView; readonly t: Translator }): JSX.Element {
  const owner = `${source.key}:${source.epoch}`;
  const ownerRef = useRef(source.key); ownerRef.current = source.key;
  const [pending, setPending] = useState<string>();
  const [failure, setFailure] = useState<{ readonly owner: string; readonly message: string }>();
  const rows = source.rows.filter(row => row.lifecycle === "active" || row.lifecycle === "paused");
  const open = async (id: string, destination: "session" | "settings" | "preparation"): Promise<void> => {
    if (!controller.openSourcePartner || pending !== undefined) return;
    setPending(id); setFailure(undefined);
    try { await controller.openSourcePartner(source.key, id, destination); }
    catch (error) { if (ownerRef.current === source.key) setFailure({ owner: source.key, message: error instanceof Error ? error.message : t("partners.actionFailed") }); }
    finally { setPending(undefined); }
  };
  return <section className="partner-source" aria-label={t("partners.source.title", { name: source.name })} data-partner-source={source.key}>
    <header className="partner-source__header"><div><h2>{source.name}</h2><Pill tone={source.status === "online" ? "success" : source.status === "loading" ? "neutral" : "warning"}>{t(`partners.source.${source.status}`)}</Pill></div>
      <Button onClick={() => void controller.refreshPartnerSource?.(source.key)} disabled={source.status === "loading" || pending !== undefined}><RefreshCcw aria-hidden="true" />{t("common.retry")}</Button></header>
    {source.status === "loading" && <p className="partner-source__state"><Spinner />{t("partners.loading")}</p>}
    {source.status !== "online" && source.status !== "loading" && <p className="partner-source__state" role={source.status === "readFailed" ? "alert" : undefined}><CircleAlert aria-hidden="true" />{t("partners.source.cached")}</p>}
    {failure?.owner === source.key && <p className="partner-page-error" role="alert">{failure.message}</p>}
    <PartnerAvatarProvider controller={controller} sourceKey={source.key} ownerKey={source.status === "online" ? owner : undefined}>
      <div className="partner-card-grid">{rows.map(row => <article className="partner-card" key={row.id} data-partner-id={row.id}>
        <header><PartnerAvatar preset={row.avatar} partner={row} /><div><h3>{row.displayName}</h3><p>{source.name}</p></div><Pill tone={row.initializationState === "error" ? "danger" : row.lifecycle === "paused" ? "warning" : "neutral"}>{t(`partners.state.${row.initializationState}`)}</Pill></header>
        {(row.latestReplyPreview || row.description) && <p className="partner-card__preview">{row.latestReplyPreview || row.description}</p>}
        {row.unreadReplyCount > 0 && <Pill tone="accent">{t("partners.unreadReplies", { count: row.unreadReplyCount })}</Pill>}
        <footer>{row.initializationState !== "ready" && <Button disabled={source.status !== "online" || pending !== undefined}
          onClick={() => void open(row.id, "preparation")}><RefreshCcw aria-hidden="true" />{pending === row.id ? t("common.working") : t("partners.source.continuePreparation")}</Button>}
          <Button disabled={source.status !== "online" || pending !== undefined || row.initializationState !== "ready" || row.lifecycle !== "active"}
          onClick={() => void open(row.id, "session")}><MessageSquare aria-hidden="true" />{pending === row.id ? t("common.working") : t("partners.openTask")}</Button>
          <Button disabled={source.status !== "online" || pending !== undefined || row.initializationState !== "ready" || row.lifecycle === "archived"}
            onClick={() => void open(row.id, "settings")}><Pencil aria-hidden="true" />{t("common.edit")}</Button></footer>
      </article>)}{rows.length === 0 && source.status !== "loading" && <div className="partner-empty"><Bot aria-hidden="true" /><h3>{t("partners.empty")}</h3><p>{source.status === "online" ? t("partners.source.empty") : t("partners.source.unavailable")}</p></div>}</div>
    </PartnerAvatarProvider>
  </section>;
}

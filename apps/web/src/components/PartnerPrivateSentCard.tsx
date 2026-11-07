import { useEffect, useId, useState, type JSX } from "react";
import { ChevronDown, MessageSquarePlus } from "lucide-react";

import type { PartnerPrivateSentView } from "../model.js";
import type { Translator } from "./types.js";
import { Button } from "./ui.js";

type ReadSentMessage = (receipt: PartnerPrivateSentView, signal: AbortSignal) => Promise<string>;

export function PartnerPrivateSentCard({ receipt, read, openThread, t }: {
  readonly receipt: PartnerPrivateSentView;
  readonly read?: ReadSentMessage;
  readonly openThread: (threadId: string) => void;
  readonly t: Translator;
}): JSX.Element {
  const [expansion, setExpansion] = useState<{ readonly read: ReadSentMessage }>();
  const id = useId();
  const open = read !== undefined && expansion?.read === read;
  return <div className="partner-private-sent">
    <button type="button" className="partner-private-sent__toggle" aria-expanded={open} aria-controls={open ? id : undefined}
      disabled={read === undefined} onClick={() => setExpansion(open || read === undefined ? undefined : { read })}>
      <MessageSquarePlus aria-hidden="true" />{t("partners.privateMessageTo", { name: receipt.recipientDisplayName })}
      <ChevronDown aria-hidden="true" className={open ? "details-chevron is-expanded" : "details-chevron"} />
    </button>
    {open && <SentMessageDetails id={id} receipt={receipt} read={read} openThread={openThread} t={t} />}
  </div>;
}

function SentMessageDetails({ id, receipt, read, openThread, t }: {
  readonly id: string;
  readonly receipt: PartnerPrivateSentView;
  readonly read: ReadSentMessage;
  readonly openThread: (threadId: string) => void;
  readonly t: Translator;
}): JSX.Element {
  const [result, setResult] = useState<{ readonly text: string } | "failed">();
  const [retry, setRetry] = useState(0);
  const { messageId, threadId, recipientPartnerId, recipientDisplayName } = receipt;
  useEffect(() => {
    const abort = new AbortController();
    void read({ messageId, threadId, recipientPartnerId, recipientDisplayName }, abort.signal).then(text => {
      if (!abort.signal.aborted) setResult({ text });
    }).catch(() => { if (!abort.signal.aborted) setResult("failed"); });
    return () => abort.abort();
  }, [read, messageId, threadId, recipientPartnerId, recipientDisplayName, retry]);
  return <div className="partner-private-sent__body" id={id}>
    {result === undefined ? <span role="status">{t("common.loading")}</span> : result === "failed" ? <>
      <span role="alert">{t("partners.privateThreadLoadFailed")}</span>
      <Button tone="ghost" onClick={() => { setResult(undefined); setRetry(value => value + 1); }}>{t("common.retry")}</Button>
    </> : <>
      <p>{result.text}</p>
      <Button tone="ghost" onClick={() => openThread(threadId)}>{t("partners.openPrivateThread")}</Button>
    </>}
  </div>;
}

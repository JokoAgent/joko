import { useEffect, useRef, useState } from "react";
import { hasPublicWorkingSubject } from "@joko/contracts";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type { MobilePartnerDirectoryProfile } from "./mobile-partner-directory";
import type { MobilePartnerWorkingStatus, MobilePartnerWorkingTransport } from "./mobile-partner-working";
import { mobileMessage } from "./mobile-messages";

/** Directory and Composer share the Host's per-turn/per-language caption cache. */
export function useMobilePartnerWorkingCaption(partner: MobilePartnerDirectoryProfile, status: MobilePartnerWorkingStatus | undefined,
  locale: MobileSupportedLocale, transport: MobilePartnerWorkingTransport | undefined): string | undefined {
  const scope = JSON.stringify([transport?.ownerKey, partner.partnerId, partner.revision.toString(), status?.turnKey, status?.phase, locale]);
  const [caption, setCaption] = useState<{ readonly scope: string; readonly text: string }>();
  const ref = useRef(transport); ref.current = transport;
  useEffect(() => {
    if (!transport || !status || !hasPublicWorkingSubject(status.phase)) return;
    const current = transport;
    const controller = new AbortController();
    void current.read(partner, status, locale, controller.signal).then((text) => {
      if (!controller.signal.aborted && ref.current?.ownerKey === current.ownerKey && text?.trim()) setCaption({ scope, text });
    }).catch(() => { /* The current factual label remains available. */ });
    return () => controller.abort();
  }, [scope]);
  return !status ? undefined : caption?.scope === scope ? caption.text : mobileMessage(locale, `partnerWorking.${status.phase}`);
}

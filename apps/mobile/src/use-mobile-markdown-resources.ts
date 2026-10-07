import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { MobileClient } from "./mobile-client";
import type { MobileMarkdownResourceDescriptor } from "./mobile-markdown-resources";
import { subscribeMobileResourcePressure } from "./mobile-resource-pressure";

export type MobileMarkdownResourceClient = Pick<MobileClient, "prepareMarkdownResources" | "assertMarkdownResourcesCurrent"
  | "releaseMarkdownResources" | "markdownResourceOwnerKey" | "subscribe">;

export function useMobileMarkdownResources(input: {
  readonly client?: MobileMarkdownResourceClient;
  readonly messageId?: string;
  readonly text: string;
  readonly ownerKey?: string;
}): MobileMarkdownResourceDescriptor | undefined {
  const { client, messageId, text, ownerKey } = input;
  const [prepared, setPrepared] = useState<{ readonly owner: string; readonly text: string; readonly descriptor: MobileMarkdownResourceDescriptor }>();
  const current = useRef(input); current.current = input;
  useEffect(() => {
    if (!client || !messageId || !ownerKey) { setPrepared(undefined); return; }
    let alive = true;
    let foreground = AppState.currentState === "active";
    let recoveries = 0;
    let awaitingAuthority = false;
    let controller: AbortController | undefined;
    let descriptor: MobileMarkdownResourceDescriptor | undefined;
    const stop = () => {
      controller?.abort(); controller = undefined;
      if (descriptor) client.releaseMarkdownResources(descriptor.leaseId);
      descriptor = undefined;
      if (alive) setPrepared(undefined);
    };
    const start = () => {
      stop();
      if (!alive || !foreground || client.markdownResourceOwnerKey() !== ownerKey || recoveries > 1) return;
      awaitingAuthority = false;
      const request = new AbortController(); controller = request;
      void client.prepareMarkdownResources(messageId, text, request.signal).then((result) => {
        if (!result.references.size) { client.releaseMarkdownResources(result.leaseId); return; }
        if (!alive || !foreground || controller !== request || request.signal.aborted
          || current.current.text !== text || current.current.ownerKey !== ownerKey) {
          client.releaseMarkdownResources(result.leaseId); return;
        }
        try { client.assertMarkdownResourcesCurrent(result.leaseId); }
        catch { client.releaseMarkdownResources(result.leaseId); return; }
        descriptor = result;
        setPrepared({ owner: ownerKey, text, descriptor: result });
      }).catch(() => { if (controller === request) stop(); });
    };
    const subscription = client.subscribe(() => {
      if (client.markdownResourceOwnerKey() !== ownerKey) { awaitingAuthority = true; stop(); return; }
      if (awaitingAuthority) { awaitingAuthority = false; start(); return; }
      if (descriptor) {
        try { client.assertMarkdownResourcesCurrent(descriptor.leaseId); } catch { stop(); }
      }
    });
    const lifecycle = AppState.addEventListener("change", (state) => {
      foreground = state === "active";
      if (foreground) { recoveries = 0; start(); } else stop();
    });
    const pressure = subscribeMobileResourcePressure(() => {
      recoveries += 1; stop();
      if (recoveries <= 1) start();
    });
    start();
    return () => { alive = false; subscription(); lifecycle.remove(); pressure?.remove(); stop(); };
  }, [client, messageId, ownerKey, text]);
  return prepared && prepared.owner === ownerKey && prepared.text === text ? prepared.descriptor : undefined;
}

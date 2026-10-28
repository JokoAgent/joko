import { useEffect, useRef, useState } from "react";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import * as wire from "@joko/contracts";
import type { AppController } from "../controller.js";
import type { PartnerNetworkApi } from "../partner-network-api.js";
import { interactionDecision, mapInteraction } from "../gateway.js";
import { InteractionDialog } from "./InteractionDialog.js";
import type { Translator } from "./types.js";

export function NetworkOwnerControls({ api, target, controller, t }: { api: PartnerNetworkApi; target: { roomId: string; joinId: string; threadRootId?: string }; controller: AppController; t: Translator }) {
  const [controls, setControls] = useState<wire.PartnerNetworkOwnerControl[]>([]), [failed, setFailed] = useState(false);
  const lifetime = useRef(new AbortController()), request = useRef<{ body: string; id: string } | undefined>(undefined);
  const read = async () => { if (lifetime.current.signal.aborted || document.visibilityState === "hidden") return;
    try { const result = await api.getPartnerNetworkOwnerControls(target, { signal: lifetime.current.signal }); if (!lifetime.current.signal.aborted) { setControls(result.controls); setFailed(false); } }
    catch { if (!lifetime.current.signal.aborted) setControls([]); } };
  useEffect(() => { void read(); const timer = setInterval(() => { void read(); }, 2_000); document.addEventListener("visibilitychange", read);
    return () => { lifetime.current.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", read); }; }, []);
  const active = controls.flatMap(control => control.interactions.map(interaction => ({ control, interaction })))[0];
  const send = async (decision: NonNullable<MessageInitShape<typeof wire.InteractionResolutionSchema>["decision"]>) => {
    if (!active) return; const { control, interaction } = active;
    const body = JSON.stringify([control.executionId, control.lease.toString(), interaction.interactionId, interaction.generation.toString(), decision]);
    if (request.current?.body !== body) request.current = { body, id: crypto.randomUUID() }; setFailed(false);
    try { await api.respondPartnerNetworkOwnerInteraction({ ...target, executionId: control.executionId, lease: control.lease,
      interactionId: interaction.interactionId, generation: interaction.generation, resolution: create(wire.InteractionResolutionSchema, { decision }), operationId: request.current.id }, { signal: lifetime.current.signal });
      if (!lifetime.current.signal.aborted) { request.current = undefined; await read(); } }
    catch (error) { if (!lifetime.current.signal.aborted) { setFailed(true); await read(); } throw error; }
  };
  return <>{failed && <p role="alert">{wire.partnerNetworkMessages(controller.state.effectiveLocale).unavailable}</p>}{active && <InteractionDialog controller={controller} interaction={mapInteraction(active.interaction)} remaining={controls.reduce((count, value) => count + value.interactions.length, 0) - 1} inline t={t}
    runAction={(_key, action) => { void action().catch(() => {}); }} onResolve={async draft => send(await interactionDecision(active.interaction, draft))}
    onDismiss={() => send({ case: "dismissal", value: { reason: "" } })} />}</>;
}

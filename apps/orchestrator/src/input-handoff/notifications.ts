import { randomUUID } from "node:crypto";
import type { InputHandoffSnapshot } from "@joko/contracts";
import type { OperationalStore } from "@joko/store";
import type { MobilePushCoordinator } from "../mobile-push.js";

/** Dedicated owner attention. No entered value, purpose, note, field label,
 * picture or QR content enters an event or a push notification. */
export class InputHandoffNotifications {
  readonly #instance = randomUUID();
  readonly #steps = new Map<string, number>();
  #closed = false;
  constructor(readonly options: { readonly store: OperationalStore; readonly push: Pick<MobilePushCoordinator, "notifyInputHandoff">;
    readonly isCurrent: (requestId: string) => boolean }) {
    options.store.cancelInputHandoffPushes({ instanceId: this.#instance, exceptInstance: true });
  }
  publish(_sessionId: string, snapshot: InputHandoffSnapshot | undefined): void {
    if (snapshot?.terminal) {
      this.options.store.cancelInputHandoffPushes({ instanceId: this.#instance, requestId: snapshot.requestId });
      this.#steps.delete(snapshot.requestId);
    }
  }
  notify(sessionId: string, snapshot: InputHandoffSnapshot): void {
    if (this.#closed || snapshot.terminal || snapshot.phase !== "ready" || !this.options.isCurrent(snapshot.requestId)
      || this.#steps.get(snapshot.requestId) === snapshot.stepNumber) return;
    const session = this.options.store.getSession(sessionId).descriptor;
    this.options.store.transaction(() => {
      if (!this.options.isCurrent(snapshot.requestId)) return;
      const event = this.options.store.appendEvent({ id: `input-handoff:${snapshot.requestId}:${snapshot.stepNumber}`, backendId: session.backendId,
        targetId: session.targetId, sessionId, generation: session.binding.generation, traceId: `input-handoff:${snapshot.requestId}`,
        payload: { type: "extension_ui_effect", effect: "notification", notificationKind: "info", text: "Private input is needed. Open the original task to continue." },
        metadata: { namespace: "joko.input_handoff", fields: { requestId: snapshot.requestId, stepNumber: snapshot.stepNumber, instanceId: this.#instance } } });
      this.options.push.notifyInputHandoff({ sessionId, sourceCursor: event.globalCursor });
    });
    this.#steps.set(snapshot.requestId, snapshot.stepNumber);
  }
  close(): void { if (this.#closed) return; this.#closed = true; this.options.store.cancelInputHandoffPushes({ instanceId: this.#instance }); this.#steps.clear(); }
}

import { parseTaskShareInvitation } from "@joko/contracts";

export interface DesktopTaskSharingInvitationDelivery {
  readonly documentOccurrence: string;
  readonly deliveryOccurrence: number;
  readonly invitation: string;
}
/** Private OS handoffs stay in Main memory until the exact Document accepts
 * them. They never become ordinary navigation, diagnostics, or window state. */
export class DesktopTaskSharingInvitationBuffer {
  #pending: { readonly deliveryOccurrence: number; readonly invitation: string } | undefined;
  #document: string | undefined;
  #sequence = 0;
  offer(invitation: string): DesktopTaskSharingInvitationDelivery | undefined {
    parseTaskShareInvitation(invitation);
    if (!Number.isSafeInteger(this.#sequence + 1)) throw new RangeError("The invitation delivery capacity was reached.");
    this.#pending = { deliveryOccurrence: ++this.#sequence, invitation };
    return this.#claim();
  }
  take(documentOccurrence: string): DesktopTaskSharingInvitationDelivery | undefined {
    this.#document = documentOccurrence; return this.#claim();
  }
  acknowledge(documentOccurrence: string, deliveryOccurrence: number): boolean {
    if (documentOccurrence !== this.#document || this.#pending?.deliveryOccurrence !== deliveryOccurrence) return false;
    this.#pending = undefined; return true;
  }
  resetDocument(): void { this.#document = undefined; }
  retirePending(): void { this.#pending = undefined; }
  #claim(): DesktopTaskSharingInvitationDelivery | undefined {
    return this.#document && this.#pending ? { documentOccurrence: this.#document, ...this.#pending } : undefined;
  }
}

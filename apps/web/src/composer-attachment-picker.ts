export type ComposerAttachmentPickerRequirement = "images" | "files" | "either";

export interface ComposerAttachmentPickerAdmission {
  readonly owner: object;
  readonly epoch?: object;
  readonly connected: boolean;
  readonly locked: boolean;
  readonly images: boolean;
  readonly files: boolean;
}

interface ComposerAttachmentPickerAttempt {
  readonly owner: object;
  readonly epoch: object;
  readonly input: HTMLInputElement;
  readonly ownerDocument: Document;
  readonly requirement: ComposerAttachmentPickerRequirement;
  readonly requireConnection: boolean;
}

function admitted(
  state: ComposerAttachmentPickerAdmission,
  requirement: ComposerAttachmentPickerRequirement,
  requireConnection: boolean
): state is ComposerAttachmentPickerAdmission & { readonly epoch: object } {
  return state.epoch !== undefined
    && !state.locked
    && (!requireConnection || state.connected)
    && (requirement === "images" ? state.images : requirement === "files" ? state.files : state.images || state.files);
}

/** Keeps the native chooser result bound to the Composer that opened it. */
export class ComposerAttachmentPicker {
  #attempt: ComposerAttachmentPickerAttempt | undefined;

  open(
    input: HTMLInputElement | null,
    state: ComposerAttachmentPickerAdmission,
    requirement: ComposerAttachmentPickerRequirement = "either",
    requireConnection = false
  ): boolean {
    if (input === null || !input.isConnected || input.ownerDocument.defaultView?.closed === true
      || !admitted(state, requirement, requireConnection)) return false;
    this.#attempt = {
      owner: state.owner,
      epoch: state.epoch,
      input,
      ownerDocument: input.ownerDocument,
      requirement,
      requireConnection
    };
    try {
      input.click();
      return true;
    } catch (error) {
      this.#attempt = undefined;
      throw error;
    }
  }

  consume(
    input: HTMLInputElement,
    files: FileList | readonly File[] | null,
    state: ComposerAttachmentPickerAdmission
  ): readonly File[] {
    const selected = files === null ? [] : [...files];
    const attempt = this.#attempt;
    this.#attempt = undefined;
    input.value = "";
    if (selected.length === 0 || attempt === undefined
      || attempt.input !== input || !input.isConnected
      || attempt.ownerDocument !== input.ownerDocument
      || input.ownerDocument.defaultView?.closed === true
      || attempt.owner !== state.owner || attempt.epoch !== state.epoch
      || !admitted(state, attempt.requirement, attempt.requireConnection)) return [];
    return selected;
  }

  retire(): void {
    this.#attempt = undefined;
  }
}

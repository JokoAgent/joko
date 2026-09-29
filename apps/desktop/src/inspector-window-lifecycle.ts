export interface InspectorWindowLifecycleOwner {
  isDestroyed(): boolean;
  isFocused(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
}

export interface InspectorWindowLifecycleChild {
  isDestroyed(): boolean;
  isFocused(): boolean;
  isMinimized(): boolean;
  restore(): void;
  hide(): void;
  show(): void;
  showInactive(): void;
  moveTop(): void;
  focus(): void;
}

export interface InspectorWindowCloseDecision {
  readonly notifyOwner: boolean;
  readonly returnFocus: boolean;
  readonly reason?: "user" | "child-failure";
}

/**
 * Keeps one detached Inspector bound to the exact application-window
 * occurrence that opened it. Electron currently destroys a non-outliving
 * `window.open` guest with its opener render view; this explicit fence keeps
 * that implementation detail from deciding whether a passive retirement may
 * notify or focus the replacement document.
 */
export class InspectorWindowLifecycle<
  Owner extends InspectorWindowLifecycleOwner,
  Child extends InspectorWindowLifecycleChild
> {
  readonly #owner: Owner;
  readonly #child: Child;
  readonly #isCurrent: (owner: Owner, child: Child) => boolean;
  readonly #retire: (owner: Owner, child: Child) => void;
  #ready = false;
  #closeKind: "open" | "passive" | "user" | "child-failure" = "open";
  #returnFocusRequested = false;

  constructor(options: {
    readonly owner: Owner;
    readonly child: Child;
    readonly isCurrent: (owner: Owner, child: Child) => boolean;
    readonly retire: (owner: Owner, child: Child) => void;
  }) {
    this.#owner = options.owner;
    this.#child = options.child;
    this.#isCurrent = options.isCurrent;
    this.#retire = options.retire;
  }

  owns(owner: Owner, child: Child): boolean {
    return owner === this.#owner && child === this.#child && this.#currentOccurrence();
  }

  markReady(child: Child): boolean {
    if (child !== this.#child || !this.#current()) return false;
    this.#ready = true;
    return true;
  }

  ownerHidden(owner: Owner): void {
    if (owner !== this.#owner || !this.#current() || this.#child.isDestroyed()) return;
    this.#child.hide();
  }

  ownerShown(owner: Owner): void {
    if (owner !== this.#owner || !this.#ready || !this.#current() || this.#child.isDestroyed()) return;
    if (owner.isDestroyed() || !owner.isVisible() || owner.isMinimized()) return;
    this.#child.showInactive();
  }

  ownerRetired(owner: Owner): void {
    if (owner !== this.#owner || !this.#currentOccurrence()) return;
    this.#closeKind = "passive";
    this.#returnFocusRequested = false;
    this.#retire(this.#owner, this.#child);
  }

  markUserClosing(child: Child): boolean {
    if (child !== this.#child || !this.#currentOccurrence()) return false;
    if (this.#closeKind !== "open") return this.#closeKind === "user";
    this.#closeKind = "user";
    this.#returnFocusRequested = this.#ready && !child.isDestroyed() && child.isFocused();
    return true;
  }

  markPassiveClosing(child: Child): boolean {
    if (child !== this.#child || !this.#currentOccurrence()) return false;
    if (this.#closeKind !== "open") return this.#closeKind === "passive";
    this.#closeKind = "passive";
    this.#returnFocusRequested = false;
    return true;
  }

  markChildFailed(child: Child): boolean {
    if (child !== this.#child || !this.#currentOccurrence()) return false;
    if (this.#closeKind !== "open") return this.#closeKind === "child-failure";
    this.#closeKind = "child-failure";
    this.#returnFocusRequested = false;
    return true;
  }

  closeDecision(child: Child): InspectorWindowCloseDecision | undefined {
    if (child !== this.#child || !this.#currentOccurrence()) return undefined;
    const reason = this.#closeKind === "user" || this.#closeKind === "child-failure"
      ? this.#closeKind
      : undefined;
    return {
      notifyOwner: reason !== undefined,
      returnFocus: this.#closeKind === "user" && this.#returnFocusRequested && this.#ownerCanReceiveFocus(),
      ...(reason === undefined ? {} : { reason })
    };
  }

  canReveal(child: Child): boolean {
    return child === this.#child && this.#ready && this.#current() &&
      this.#ownerCanReceiveFocus();
  }

  activate(owner: Owner, child: Child): boolean {
    if (owner !== this.#owner || child !== this.#child || this.#closeKind !== "open" || !this.#ready || !this.#current()) return false;
    if (!this.#ownerCanReceiveFocus() || !owner.isFocused()) return false;
    if (child.isMinimized()) child.restore();
    child.show();
    child.moveTop();
    child.focus();
    return true;
  }

  #current(): boolean {
    return !this.#child.isDestroyed() && this.#currentOccurrence();
  }

  #currentOccurrence(): boolean {
    return this.#isCurrent(this.#owner, this.#child);
  }

  #ownerCanReceiveFocus(): boolean {
    return !this.#owner.isDestroyed() && this.#owner.isVisible() && !this.#owner.isMinimized();
  }
}

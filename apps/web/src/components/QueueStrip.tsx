import type { JSX } from "react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { AlertTriangle, Clock3, GripVertical, Pause, Pencil, Play, X, Zap } from "lucide-react";
import type { AppController } from "../controller.js";
import type { DeliveryMode, QueueControlView, QueueItemTextEditView, QueueItemView } from "../model.js";
import { equalQueueItemTextEdit, queueItemEditProjection, remapQueueItemTextEdit, type QueueItemTextEditTransaction } from "../queue-item-edit.js";
import { randomUuid } from "../web-crypto.js";
import { composerQueueWindow, resolveQueueReorderShortcut } from "./composer-behavior.js";
import type { RunAction, Translator } from "./types.js";
import { Button, IconButton, Pill, cx } from "./ui.js";
import { QueueLockLease } from "./queue-lock-lease.js";
import { QueueInputPreview } from "./QueueInputPreview.js";

interface QueueEditLock {
  readonly queueItemId: string;
  readonly token: string;
  readonly lease: QueueLockLease;
}

export function QueueStrip({ sessionId, items, control, supportedDispositions, controller, runAction, t, expanded, onExpandedChange }: { readonly sessionId: string; readonly items: readonly QueueItemView[]; readonly control?: QueueControlView; readonly supportedDispositions: readonly DeliveryMode[]; readonly controller: AppController; readonly runAction: RunAction; readonly t: Translator; readonly expanded: boolean; readonly onExpandedChange: (expanded: boolean) => void }): JSX.Element {
  const [editingId, setEditingId] = useState<string>();
  const [editingDraft, setEditingDraft] = useState<QueueItemTextEditView>(() => ({
    text: "",
    mentionRanges: [],
    pastedTextRanges: [],
    textSplices: []
  }));
  const [editLockLost, setEditLockLost] = useState(false);
  const [draggingQueueItemId, setDraggingQueueItemId] = useState<string>();
  const [dragTargetQueueItemId, setDragTargetQueueItemId] = useState<string>();
  const [pendingItemIds, setPendingItemIds] = useState<ReadonlySet<string>>(() => new Set());
  const [queueControlPending, setQueueControlPending] = useState(false);
  const queueRootRef = useRef<HTMLDivElement>(null);
  const restoreEditorFocusRef = useRef<{ readonly row: HTMLElement; readonly queueItemId: string } | undefined>(undefined);
  const pendingItemIdsRef = useRef(new Set<string>());
  const queueControlPendingRef = useRef(false);
  const ownerRef = useRef({ active: true });
  const leasesRef = useRef(new Set<QueueLockLease>());
  const editLockRef = useRef<QueueEditLock | undefined>(undefined);
  const editTransactionRef = useRef<QueueItemTextEditTransaction | undefined>(undefined);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const dragLockRef = useRef<{
    readonly token: string;
    readonly promise: Promise<void>;
    readonly lease: QueueLockLease;
    timer?: ReturnType<typeof setTimeout>;
    acquired: boolean;
    dropInProgress: boolean;
    released: boolean;
  } | undefined>(undefined);
  const pointerRef = useRef<{
    readonly id: number; readonly sourceId: string; readonly startY: number; readonly handle: HTMLButtonElement;
    readonly lock: NonNullable<typeof dragLockRef.current>;
    target?: { readonly id: string; readonly placement: "before" | "after" };
  } | undefined>(undefined);
  const queueItemsId = useId();
  const ordered = [...items].sort((left, right) => left.ordinal - right.ordinal || left.createdAt - right.createdAt);
  const latest = useRef({ ordered, runAction });
  latest.current = { ordered, runAction };
  const queueWindow = composerQueueWindow(ordered, expanded);
  const unknown = ordered.some((item) => item.state === "dispatchUnknown");
  const paused = control?.state === "paused";
  const interactionLocked = control?.interactionLocked === true && dragLockRef.current === undefined;
  useLayoutEffect(() => {
    const target = restoreEditorFocusRef.current;
    if (target === undefined || pendingItemIds.has(target.queueItemId) || editingId !== undefined && editingId !== target.queueItemId) return;
    restoreEditorFocusRef.current = undefined;
    if (!target.row.isConnected) return;
    const active = target.row.ownerDocument.activeElement;
    if (active !== target.row.ownerDocument.body && active !== null && !target.row.contains(active)) return;
    const editor = target.row.querySelector<HTMLTextAreaElement>("textarea:not(:disabled)");
    const editButton = target.row.querySelector<HTMLButtonElement>("[data-queue-edit]:not(:disabled)");
    (editor ?? editButton ?? target.row).focus();
  }, [editingId, pendingItemIds]);
  useEffect(() => {
    if (!queueWindow.collapsible && expanded) onExpandedChange(false);
  }, [expanded, onExpandedChange, queueWindow.collapsible]);
  const trackItemAction = (queueItemId: string, key: string, action: () => Promise<void>): Promise<void> | undefined => {
    if (pendingItemIdsRef.current.has(queueItemId)) return undefined;
    pendingItemIdsRef.current.add(queueItemId);
    setPendingItemIds(new Set(pendingItemIdsRef.current));
    const owner = ownerRef.current;
    const promise = Promise.resolve().then(action).finally(() => {
      if (!owner.active || ownerRef.current !== owner) return;
      pendingItemIdsRef.current.delete(queueItemId);
      setPendingItemIds(new Set(pendingItemIdsRef.current));
    });
    runAction(key, () => promise);
    return promise;
  };
  const releaseLease = (lease: QueueLockLease): Promise<void> => lease.release().finally(() => leasesRef.current.delete(lease));
  const releaseEditLock = (lock: QueueEditLock): Promise<void> => {
    if (editLockRef.current?.token === lock.token) editLockRef.current = undefined;
    const promise = releaseLease(lock.lease);
    runAction(`queue-edit-unlock:${lock.queueItemId}`, () => promise);
    return promise;
  };
  const closeEditor = (): void => {
    const lock = editLockRef.current;
    rememberEditorFocus();
    setEditingId(undefined);
    setEditLockLost(false);
    if (lock !== undefined) void releaseEditLock(lock).catch(() => undefined);
  };
  const rememberEditorFocus = (): void => {
    const active = queueRootRef.current?.ownerDocument.activeElement;
    const editor = active?.closest(".queue-strip__editor");
    const row = editor?.closest("article");
    restoreEditorFocusRef.current = editingId !== undefined && row instanceof HTMLElement && queueRootRef.current?.contains(row)
      ? { row, queueItemId: editingId }
      : undefined;
  };
  const beginEdit = (item: QueueItemView): void => {
    if (editLockRef.current?.queueItemId === item.id || pendingItemIdsRef.current.size > 0) return;
    const token = randomUuid();
    const owner = ownerRef.current;
    const previous = editLockRef.current;
    const lease = new QueueLockLease((locked) => controller.setQueueItemEditLock(item.id, token, locked));
    leasesRef.current.add(lease);
    const lock = { queueItemId: item.id, token, lease };
    editLockRef.current = lock;
    setEditingId(undefined);
    setEditLockLost(false);
    const promise = trackItemAction(
      item.id,
      `queue-edit-lock:${item.id}`,
      async () => {
        if (previous !== undefined) {
          await releaseEditLock(previous);
        }
        await lease.acquire();
      }
    );
    if (promise === undefined) return;
    void promise.then(() => {
      if (!owner.active || ownerRef.current !== owner || editLockRef.current !== lock) { void releaseLease(lease).catch(() => undefined); return; }
      setEditingId(item.id);
      editTransactionRef.current = undefined;
      setEditingDraft(queueItemEditProjection(item));
    }).catch(() => {
      if (editLockRef.current === lock) editLockRef.current = undefined;
      void releaseLease(lease).catch(() => undefined);
    });
  };
  const reacquireEditLock = (): void => {
    const lock = editLockRef.current;
    if (lock === undefined || !editLockLost) return;
    const promise = trackItemAction(lock.queueItemId, `queue-edit-lock:${lock.queueItemId}`, async () => {
      await lock.lease.acquire();
      if (editLockRef.current === lock && ownerRef.current.active) setEditLockLost(false);
    });
    void promise?.catch(() => undefined);
  };
  const runWithEditLock = (
    item: QueueItemView,
    key: string,
    action: (lockToken: string) => Promise<void>
  ): void => {
    if (pendingItemIdsRef.current.has(item.id)) return;
    const owner = ownerRef.current;
    const token = randomUuid();
    const lease = new QueueLockLease((locked) => controller.setQueueItemEditLock(item.id, token, locked));
    leasesRef.current.add(lease);
    const promise = trackItemAction(item.id, key, async () => {
      try {
        await lease.acquire();
        if (!owner.active || ownerRef.current !== owner) return;
        await action(token);
      } finally {
        await releaseLease(lease);
      }
    });
    void promise?.catch(() => undefined);
  };
  const beginInteractionLock = (): NonNullable<typeof dragLockRef.current> => {
    if (dragLockRef.current !== undefined && !dragLockRef.current.released) return dragLockRef.current;
    const token = randomUuid();
    const lease = new QueueLockLease((locked) => controller.setQueueInteractionLock(sessionId, token, locked));
    leasesRef.current.add(lease);
    const promise = lease.acquire();
    const lock: NonNullable<typeof dragLockRef.current> = { token, promise, lease, acquired: false, dropInProgress: false, released: false };
    dragLockRef.current = lock;
    runAction(`queue-interaction-lock:${sessionId}`, () => promise);
    const renew = (): void => {
      lock.timer = setTimeout(() => {
        if (lock.released) return;
        const renewal = lease.acquire();
        latest.current.runAction(`queue-interaction-renew:${sessionId}`, () => renewal);
        void renewal.then(() => { if (!lock.released) renew(); }).catch(() => {
          if (dragLockRef.current === lock) { setDraggingQueueItemId(undefined); setDragTargetQueueItemId(undefined); }
          void releaseInteractionLock(lock).catch(() => undefined);
        });
      }, 30_000);
    };
    void promise.then(() => { lock.acquired = true; if (!lock.released) renew(); }).catch(() => {
      if (dragLockRef.current === lock) { setDraggingQueueItemId(undefined); setDragTargetQueueItemId(undefined); }
      void releaseInteractionLock(lock).catch(() => undefined);
    });
    return lock;
  };
  const releaseInteractionLock = async (lock: NonNullable<typeof dragLockRef.current>): Promise<void> => {
    if (lock.released) return;
    lock.released = true;
    clearTimeout(lock.timer);
    if (dragLockRef.current === lock) dragLockRef.current = undefined;
    const pointer = pointerRef.current;
    if (pointer?.lock === lock) {
      pointerRef.current = undefined;
      if (pointer.handle.hasPointerCapture?.(pointer.id)) pointer.handle.releasePointerCapture(pointer.id);
    }
    const promise = releaseLease(lock.lease);
    runAction(`queue-interaction-unlock:${sessionId}`, () => promise);
    await promise;
  };
  const reorderWithInteractionLock = (
    queueItemId: string,
    placement: "first" | "last" | "before" | "after",
    anchorQueueItemId?: string,
    existingLock?: NonNullable<typeof dragLockRef.current>
  ): void => {
    const lock = existingLock ?? beginInteractionLock();
    if (lock.released || lock.dropInProgress) return;
    lock.dropInProgress = true;
    void (async () => {
      try {
        await lock.promise;
        if (lock.released || dragLockRef.current !== lock) return;
        const source = latest.current.ordered.find((item) => item.id === queueItemId);
        const anchor = anchorQueueItemId === undefined ? undefined : latest.current.ordered.find((item) => item.id === anchorQueueItemId);
        if (source === undefined || source.state !== "accepted" || source.editLocked
          || anchorQueueItemId !== undefined && (anchor === undefined || anchor.state !== "accepted")) return;
        const reorder = trackItemAction(
          queueItemId,
          `queue-reorder:${queueItemId}`,
          () => controller.reorderQueueItem(queueItemId, placement, anchorQueueItemId, lock.token)
        );
        if (reorder !== undefined) await reorder;
      } finally {
        await releaseInteractionLock(lock);
      }
    })().catch(() => undefined);
  };
  const finishPointer = (commit: boolean): void => {
    const pointer = pointerRef.current;
    if (pointer === undefined) return;
    pointerRef.current = undefined;
    if (pointer.handle.hasPointerCapture?.(pointer.id)) pointer.handle.releasePointerCapture(pointer.id);
    setDraggingQueueItemId(undefined); setDragTargetQueueItemId(undefined);
    if (commit && pointer.target !== undefined && !pointer.lock.released) {
      reorderWithInteractionLock(pointer.sourceId, pointer.target.placement, pointer.target.id, pointer.lock);
    } else void releaseInteractionLock(pointer.lock).catch(() => undefined);
  };
  useEffect(() => {
    const lock = editLockRef.current;
    if (lock === undefined || editingId !== lock.queueItemId) return;
    const item = ordered.find((candidate) => candidate.id === lock.queueItemId);
    if (item === undefined || item.source !== "user" || item.state !== "accepted") {
      closeEditor();
      return;
    }
  }, [editingId, items]);
  useEffect(() => {
    const lock = editLockRef.current;
    if (lock === undefined || editingId !== lock.queueItemId || editLockLost) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const renew = (): void => { timer = setTimeout(() => {
      const promise = lock.lease.acquire();
      latest.current.runAction(`queue-edit-renew:${lock.queueItemId}`, () => promise);
      void promise.then(() => { if (!stopped) renew(); }).catch(() => {
        if (!stopped && editLockRef.current === lock) setEditLockLost(true);
      });
    }, 30_000); };
    renew();
    return () => { stopped = true; clearTimeout(timer); };
  }, [editingId, editLockLost, controller.setQueueItemEditLock]);
  useEffect(() => {
    const editor = editorRef.current;
    if (editor === null || editingId === undefined) return;
    const captureTransaction = (event: InputEvent): void => {
      editTransactionRef.current = {
        selectionStart: editor.selectionStart,
        selectionEnd: editor.selectionEnd,
        inputType: typeof event.inputType === "string" ? event.inputType : ""
      };
    };
    const consumeTransaction = (): void => {
      const transaction = editTransactionRef.current;
      editTransactionRef.current = undefined;
      const nextText = editor.value;
      setEditingDraft((current) => remapQueueItemTextEdit(current, nextText, transaction));
    };
    editor.addEventListener("beforeinput", captureTransaction);
    editor.addEventListener("input", consumeTransaction);
    return () => {
      editor.removeEventListener("beforeinput", captureTransaction);
      editor.removeEventListener("input", consumeTransaction);
    };
  }, [editingId]);
  useLayoutEffect(() => {
    const owner = { active: true };
    ownerRef.current = owner;
    setEditingId(undefined); setEditLockLost(false);
    setDraggingQueueItemId(undefined); setDragTargetQueueItemId(undefined);
    setQueueControlPending(false); queueControlPendingRef.current = false;
    setPendingItemIds(new Set()); pendingItemIdsRef.current.clear();
    return () => {
      owner.active = false;
      const pointer = pointerRef.current;
      pointerRef.current = undefined;
      if (pointer?.handle.hasPointerCapture?.(pointer.id)) pointer.handle.releasePointerCapture(pointer.id);
      editLockRef.current = undefined;
      const dragLock = dragLockRef.current;
      if (dragLock !== undefined) { dragLock.released = true; clearTimeout(dragLock.timer); }
      dragLockRef.current = undefined;
      for (const lease of leasesRef.current) void releaseLease(lease).catch(() => undefined);
    };
  }, [sessionId, controller.setQueueItemEditLock, controller.setQueueInteractionLock]);
  const steerSupported = supportedDispositions.includes("steer");
  const deliveryUnavailable = supportedDispositions.length === 0;
  return (
    <div ref={queueRootRef} className={cx("queue-strip", unknown && "queue-strip--warning", paused && "queue-strip--paused")} aria-label={t("context.queue")}>
      <div className="queue-strip__title">{unknown ? <AlertTriangle aria-hidden="true" /> : paused ? <Pause aria-hidden="true" /> : <Clock3 aria-hidden="true" />}<strong>{t("composer.queueCount", { count: ordered.length })}</strong>{paused && <Pill tone="warning">{t("queue.paused")}</Pill>}{interactionLocked && <Pill tone="warning">{t("queue.interactionLocked")}</Pill>}<IconButton label={paused ? t("queue.resume") : t("queue.pause")} disabled={queueControlPending} onClick={() => {
        if (queueControlPendingRef.current) return;
        queueControlPendingRef.current = true;
        setQueueControlPending(true);
        const owner = ownerRef.current;
        runAction(paused ? `resume-queue:${sessionId}` : `pause-queue:${sessionId}`, async () => {
          try {
            await (paused ? controller.resumeQueue(sessionId) : controller.pauseQueue(sessionId));
          } finally {
            if (owner.active && ownerRef.current === owner) {
              queueControlPendingRef.current = false;
              setQueueControlPending(false);
            }
          }
        });
      }}>{paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}</IconButton></div>
      <div id={queueItemsId} className={cx("queue-strip__items", expanded && "is-expanded")}>{queueWindow.items.map((item) => {
        const index = ordered.findIndex((candidate) => candidate.id === item.id);
        const mutable = item.state === "accepted";
        const userEditable = mutable && item.source === "user";
        const pending = pendingItemIds.has(item.id);
        const editLocked = item.editLocked && editLockRef.current?.queueItemId !== item.id;
        const lockReason = interactionLocked
          ? t("queue.interactionLockedReason")
          : editLocked
            ? t("queue.editLockedReason")
            : undefined;
        const blocked = pending || lockReason !== undefined;
        const itemDeliveryUnavailable = !supportedDispositions.includes(item.mode);
        const reorder = (placement: "first" | "last" | "before" | "after", anchorQueueItemId?: string): void => {
          if (!blocked) reorderWithInteractionLock(item.id, placement, anchorQueueItemId);
        };
        return (
          <article
            key={item.id}
            data-queue-item-id={item.id}
            className={cx(editingId === item.id && "is-editing", draggingQueueItemId === item.id && "is-dragging", dragTargetQueueItemId === item.id && "is-drag-target")}
            tabIndex={userEditable && steerSupported && editingId !== item.id && !blocked ? 0 : -1}
            aria-keyshortcuts={userEditable && steerSupported ? "Meta+Enter Control+Enter" : undefined}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey
                || event.repeat || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
                || !userEditable || !steerSupported || blocked || editingId === item.id) return;
              event.preventDefault();
              event.stopPropagation();
              runWithEditLock(item, `steer-now:${item.id}`, (lockToken) => controller.steerQueueItemNow(item.id, lockToken));
            }}
            onDragOver={(event) => {
              if (draggingQueueItemId === undefined || draggingQueueItemId === item.id || !mutable || pending) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setDragTargetQueueItemId(item.id);
            }}
            onDragLeave={(event) => {
              if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
              setDragTargetQueueItemId((current) => current === item.id ? undefined : current);
            }}
            onDrop={(event) => {
              event.preventDefault();
              const sourceId = draggingQueueItemId ?? event.dataTransfer.getData("text/x-joko-queue-item");
              const lock = dragLockRef.current;
              setDraggingQueueItemId(undefined);
              setDragTargetQueueItemId(undefined);
              if (sourceId === "" || sourceId === item.id || !mutable || pending || lock === undefined) {
                if (lock !== undefined) void releaseInteractionLock(lock).catch(() => undefined);
                return;
              }
              const source = ordered.find((candidate) => candidate.id === sourceId);
              if (source === undefined || source.state !== "accepted" || source.editLocked || pendingItemIdsRef.current.has(source.id)) {
                void releaseInteractionLock(lock).catch(() => undefined);
                return;
              }
              const rect = event.currentTarget.getBoundingClientRect();
              const placement = event.clientY >= rect.top + rect.height / 2 ? "after" : "before";
              reorderWithInteractionLock(source.id, placement, item.id, lock);
            }}
          >
            <div className="queue-strip__row">
              {mutable && <IconButton
                className="queue-strip__drag-handle"
                style={{ touchAction: "none" }}
                draggable={editingId !== item.id && !blocked}
                disabled={editingId === item.id || blocked}
                disabledReason={lockReason}
                label={`${t("queue.moveUp")} / ${t("queue.moveDown")}`}
                aria-keyshortcuts="ArrowUp ArrowDown Home End"
                onPointerDown={(event) => {
                  if ((event.pointerType !== "touch" && event.pointerType !== "pen") || event.button !== 0 || editingId === item.id || blocked || dragLockRef.current !== undefined) return;
                  event.preventDefault();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  const lock = beginInteractionLock();
                  pointerRef.current = { id: event.pointerId, sourceId: item.id, startY: event.clientY, handle: event.currentTarget, lock };
                  setDraggingQueueItemId(item.id);
                }}
                onPointerMove={(event) => {
                  const pointer = pointerRef.current;
                  if (pointer?.id !== event.pointerId || pointer.lock.released) return;
                  event.preventDefault();
                  if (Math.abs(event.clientY - pointer.startY) < 8) return;
                  const row = event.currentTarget.ownerDocument.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-queue-item-id]");
                  const target = latest.current.ordered.find((candidate) => candidate.id === row?.dataset.queueItemId);
                  if (row === undefined || row === null || !queueRootRef.current?.contains(row) || target === undefined || target.id === pointer.sourceId
                    || target.state !== "accepted" || target.editLocked || pendingItemIdsRef.current.has(target.id)) {
                    pointer.target = undefined; setDragTargetQueueItemId(undefined); return;
                  }
                  const rect = row.getBoundingClientRect();
                  pointer.target = { id: target.id, placement: event.clientY >= rect.top + rect.height / 2 ? "after" : "before" };
                  setDragTargetQueueItemId(target.id);
                }}
                onPointerUp={(event) => { if (pointerRef.current?.id === event.pointerId) { event.preventDefault(); finishPointer(true); } }}
                onPointerCancel={(event) => { if (pointerRef.current?.id === event.pointerId) finishPointer(false); }}
                onLostPointerCapture={(event) => { if (pointerRef.current?.id === event.pointerId) finishPointer(false); }}
                onDragStart={(event) => {
                  if (editingId === item.id || blocked || dragLockRef.current !== undefined) { event.preventDefault(); return; }
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/x-joko-queue-item", item.id);
                  setDraggingQueueItemId(item.id);
                  beginInteractionLock();
                }}
                onDragEnd={() => { const lock = dragLockRef.current; setDraggingQueueItemId(undefined); setDragTargetQueueItemId(undefined); if (lock !== undefined && !lock.dropInProgress) void releaseInteractionLock(lock).catch(() => undefined); }}
                onKeyDown={(event) => {
                  if (event.repeat || event.nativeEvent.isComposing || editingId === item.id || blocked) return;
                  const intent = resolveQueueReorderShortcut(event.key, index, ordered.length);
                  if (intent === null) return;
                  event.preventDefault();
                  event.stopPropagation();
                  if ("anchorIndex" in intent) reorder(intent.placement, ordered[intent.anchorIndex]?.id);
                  else reorder(intent.placement);
                }}
              ><GripVertical aria-hidden="true" /></IconButton>}
              <Pill tone={item.state === "dispatchUnknown" ? "warning" : item.mode === "steer" ? "accent" : "neutral"}>{deliveryLabel(item.mode, t)}</Pill>
              {item.source !== "user" && <Pill tone="neutral">{queueSourceLabel(item.source, t)}</Pill>}
              {editLocked && <Pill tone="warning">{t("queue.editLocked")}</Pill>}
              <QueueInputPreview {...item} t={t} />
              {mutable && editingId !== item.id && <div className="queue-strip__actions">{userEditable && <IconButton data-queue-edit label={t("queue.edit")} disabled={blocked || itemDeliveryUnavailable} disabledReason={lockReason ?? (itemDeliveryUnavailable ? t("queue.deliveryUnavailable") : undefined)} onClick={() => beginEdit(item)}><Pencil aria-hidden="true" /></IconButton>}{userEditable && steerSupported && <IconButton label={t("queue.steerNow")} disabled={blocked} disabledReason={lockReason} onClick={() => runWithEditLock(item, `steer-now:${item.id}`, (lockToken) => controller.steerQueueItemNow(item.id, lockToken))}><Zap aria-hidden="true" /></IconButton>}<IconButton label={t("queue.cancel")} disabled={blocked} disabledReason={lockReason} onClick={() => { const promise = trackItemAction(item.id, `cancel-queue:${item.id}`, () => controller.cancelQueueItem(item.id)); void promise?.catch(() => undefined); }}><X aria-hidden="true" /></IconButton></div>}
            </div>
            {editingId === item.id && <form className="queue-strip__editor" aria-busy={pending || undefined} onSubmit={(event) => { event.preventDefault(); if (editLockLost || itemDeliveryUnavailable || pending || interactionLocked || !queueEditHasContent(item, editingDraft)) return; const lock = editLockRef.current; if (lock?.queueItemId !== item.id) return; if (equalQueueItemTextEdit(editingDraft, queueItemEditProjection(item))) { closeEditor(); return; } rememberEditorFocus(); const promise = trackItemAction(item.id, `edit-queue:${item.id}`, async () => { await controller.editQueueItem(item.id, editingDraft, item.mode, lock.token); if (editLockRef.current === lock) setEditingId(undefined); await releaseEditLock(lock); }); void promise?.catch(() => undefined); }} onKeyDown={(event) => {
              if (event.key === "Escape" && !event.repeat && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && !pending && !interactionLocked) {
                event.preventDefault();
                event.stopPropagation();
                closeEditor();
              }
            }}><textarea ref={editorRef} rows={2} autoFocus value={editingDraft.text} disabled={pending || interactionLocked} onChange={() => undefined} aria-label={t("queue.editText")} onKeyDown={(event) => {
              if (event.repeat || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || pending || interactionLocked) return;
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.form?.requestSubmit();
              }
            }} />{editLockLost && <p role="alert">{t("queue.editLockLost")}</p>}{editLockLost && <Button disabled={pending || interactionLocked} onClick={reacquireEditLock}>{t("queue.reacquireEditLock")}</Button>}<Button disabled={pending} onClick={closeEditor}>{t("common.cancel")}</Button><Button type="submit" tone="primary" disabled={editLockLost || pending || interactionLocked || !queueEditHasContent(item, editingDraft) || itemDeliveryUnavailable}>{t("common.save")}</Button></form>}
          </article>
        );
      })}</div>
      {queueWindow.collapsible && <button className="queue-strip__toggle" type="button" aria-controls={queueItemsId} aria-expanded={expanded} onClick={() => onExpandedChange(!expanded)}>{expanded ? t("queue.showLess") : t("queue.showMore", { count: queueWindow.hiddenCount })}</button>}
      {unknown && <p>{t("error.dispatchUnknown")}</p>}
      {paused && control?.pauseReason !== undefined && <p>{control.pauseReason}</p>}
      {deliveryUnavailable && <p role="status">{t("queue.deliveryUnavailable")}</p>}
    </div>
  );
}

export function deliveryLabel(mode: DeliveryMode, t: Translator): string {
  if (mode === "steer") return t("composer.steer");
  if (mode === "followUp") return t("composer.followUp");
  return t("composer.send");
}

function queueSourceLabel(source: QueueItemView["source"], t: Translator): string {
  if (source === "schedule") return t("queue.sourceAutomation");
  if (source === "retry") return t("queue.sourceRetry");
  if (source === "backend") return t("queue.sourceSystem");
  return t("queue.sourceUser");
}

function queueEditHasContent(item: QueueItemView, edit: QueueItemTextEditView): boolean {
  if (edit.text.trim().length > 0 || (item.attachments?.length ?? 0) > 0) return true;
  const originallyInline = new Set((item.mentionRanges ?? []).map((range) => range.mentionIndex));
  const stillInline = new Set(edit.mentionRanges.map((range) => range.mentionIndex));
  return item.inputMentions?.some((_mention, index) => !originallyInline.has(index) || stillInline.has(index)) ?? false;
}

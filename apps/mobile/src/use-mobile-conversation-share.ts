import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AppState, BackHandler, Keyboard, type GestureResponderEvent, type ViewProps } from "react-native";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { MobileClient } from "./mobile-client";
import { MAXIMUM_MOBILE_CONVERSATION_SHARE_MESSAGES, MobileConversationShareSelection, mobileMessageShareable, type MobileConversationShareSnapshot } from "./mobile-conversation-share";
import type { MobileConversationShareRendererHandle } from "./mobile-conversation-share-export";
import { mobileImageOutput, type MobileImageOutput } from "./mobile-image-output";
import { inspectMobileImageGalleryBytes } from "./mobile-image-gallery";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import type { TimelineRow } from "./timeline";

interface ShareJob {
  readonly controller: AbortController;
  readonly owner: string;
  readonly revision: number;
  leaseId?: string;
  attach?: (handle: MobileConversationShareRendererHandle) => void;
  phase: "preparing" | "dispatching";
}

interface ShareRowTouch {
  readonly owner: string;
  readonly revision: number;
  readonly messageId: string;
  readonly eventId: string;
  readonly x: number;
  readonly y: number;
  readonly startedAt: number;
  moved: boolean;
}

const MAXIMUM_ROW_TAP_MOVEMENT = 8;
const MAXIMUM_ROW_TAP_DURATION_MS = 450;

type ShareRowTouchHandlers = Pick<ViewProps, "onTouchStart" | "onStartShouldSetResponder" | "onResponderGrant" | "onResponderMove"
  | "onResponderRelease" | "onResponderTerminationRequest" | "onResponderTerminate">;

function movedFromRowTouch(touch: ShareRowTouch, event: GestureResponderEvent): boolean {
  const { pageX, pageY, touches } = event.nativeEvent;
  return touches.length > 1 || Math.hypot(pageX - touch.x, pageY - touch.y) > MAXIMUM_ROW_TAP_MOVEMENT;
}

export function useMobileConversationShare(input: {
  readonly client: Pick<MobileClient, "conversationShareOwnerKey" | "prepareConversationShare" | "assertConversationShareCurrent"
    | "revalidateConversationShare" | "releaseConversationShare" | "subscribe">;
  readonly rows: readonly TimelineRow[];
  readonly locale: MobileSupportedLocale;
  readonly onNativeActivityChange: (active: boolean) => void;
  readonly output?: Pick<MobileImageOutput, "perform">;
}) {
  const { client, rows, locale } = input;
  const latest = useRef(input);
  latest.current = input;
  const [selection] = useState(() => new MobileConversationShareSelection());
  const revision = useSyncExternalStore(useCallback((listener) => selection.subscribe(listener), [selection]),
    () => selection.revision, () => selection.revision);
  const ids = useMemo(() => rows.filter(mobileMessageShareable).map((row) => row.id), [rows]);
  const owner = client.conversationShareOwnerKey();
  const [snapshot, setSnapshot] = useState<MobileConversationShareSnapshot>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [screenshotTriggered, setScreenshotTriggered] = useState(false);
  const job = useRef<ShareJob | undefined>(undefined);
  const rowTouch = useRef<ShareRowTouch | undefined>(undefined);
  const mounted = useRef(true);
  const cancelJob = useCallback(() => {
    job.current?.controller.abort();
    if (mounted.current) setSnapshot(undefined);
  }, []);
  const cancel = useCallback(() => {
    rowTouch.current = undefined;
    cancelJob(); selection.exit(); setNotice(""); setScreenshotTriggered(false);
  }, [cancelJob, selection]);
  useEffect(() => {
    selection.reconcile(owner, ids);
    const current = job.current;
    if (current?.phase === "preparing" && (selection.owner !== current.owner || selection.revision !== current.revision)) cancelJob();
  }, [cancelJob, ids, owner, revision, selection]);
  useEffect(() => client.subscribe(() => {
    const current = job.current;
    if (!current || current.phase !== "preparing") return;
    try {
      if (client.conversationShareOwnerKey() !== current.owner) throw new Error("The task changed.");
      if (current.leaseId) client.assertConversationShareCurrent(current.leaseId, current.controller.signal);
    } catch { cancelJob(); }
  }), [cancelJob, client]);
  useEffect(() => {
    const lifecycle = AppState.addEventListener("change", (state) => {
      if (state !== "active" && !(state === "inactive" && job.current?.phase === "dispatching")) cancel();
    });
    return () => { lifecycle.remove(); };
  }, [cancel]);
  useEffect(() => {
    if (!selection.active) return;
    const back = BackHandler.addEventListener("hardwareBackPress", () => { cancel(); return true; });
    return () => back.remove();
  }, [cancel, revision, selection]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; cancelJob(); selection.exit(); };
  }, [cancelJob, selection]);
  const enter = useCallback((id: string) => {
    const currentOwner = client.conversationShareOwnerKey();
    if (!currentOwner || !latest.current.rows.some((row) => row.id === id && mobileMessageShareable(row))) return;
    cancelJob(); setNotice(""); setScreenshotTriggered(false); Keyboard.dismiss(); selection.enter(currentOwner, id);
  }, [cancelJob, client, selection]);
  const enterVisible = useCallback((expectedOwner: string, visibleIds: readonly string[]) => {
    if (job.current || selection.active || client.conversationShareOwnerKey() !== expectedOwner || AppState.currentState !== "active") return;
    const visible = new Set(visibleIds);
    const current = latest.current.rows.filter((row) => mobileMessageShareable(row) && visible.has(row.id)).map((row) => row.id);
    if (current.length === 0) return;
    setNotice(""); setScreenshotTriggered(true); Keyboard.dismiss(); selection.enterMany(expectedOwner, current);
  }, [client, selection]);
  const toggle = useCallback((id: string) => {
    if (busy || !ids.includes(id)) return;
    selection.toggle(id); setNotice("");
  }, [busy, ids, selection]);
  const rowTouchHandlers = (row: TimelineRow): ShareRowTouchHandlers | undefined => {
    if (!selection.active || owner === undefined || selection.owner !== owner || busy || !mobileMessageShareable(row)) return undefined;
    const current = () => mounted.current && AppState.currentState === "active" && job.current === undefined
      && selection.active && selection.owner === owner && client.conversationShareOwnerKey() === owner
      && latest.current.rows.some(item => item.id === row.id && item.eventId === row.eventId && mobileMessageShareable(item));
    return {
      onTouchStart: (event) => {
        const touch = rowTouch.current;
        if (touch?.messageId === row.id && event.nativeEvent.touches.length > 1) touch.moved = true;
      },
      onStartShouldSetResponder: (event) => event.nativeEvent.touches.length === 1 && current(),
      onResponderGrant: (event) => {
        const { pageX, pageY } = event.nativeEvent;
        rowTouch.current = { owner, revision: selection.revision, messageId: row.id, eventId: row.eventId, x: pageX, y: pageY,
          startedAt: Date.now(), moved: false };
      },
      onResponderMove: (event) => {
        const touch = rowTouch.current;
        if (touch?.messageId === row.id && touch.eventId === row.eventId && movedFromRowTouch(touch, event)) touch.moved = true;
      },
      onResponderRelease: (event) => {
        const touch = rowTouch.current;
        rowTouch.current = undefined;
        if (touch?.messageId !== row.id || touch.eventId !== row.eventId || touch.owner !== owner || touch.revision !== selection.revision
          || touch.moved || movedFromRowTouch(touch, event) || !current()) return;
        const duration = Date.now() - touch.startedAt;
        if (duration >= 0 && duration <= MAXIMUM_ROW_TAP_DURATION_MS) toggle(row.id);
      },
      onResponderTerminationRequest: () => true,
      onResponderTerminate: () => { rowTouch.current = undefined; }
    };
  };
  const toggleAll = useCallback(() => {
    if (busy) return;
    const changed = selection.toggleAll(ids);
    setNotice(changed ? "" : mobileMessage(latest.current.locale, "share.selectionCountLimit", { count: MAXIMUM_MOBILE_CONVERSATION_SHARE_MESSAGES }));
  }, [busy, ids, selection]);
  const rendererRef = useCallback((handle: MobileConversationShareRendererHandle | null) => {
    if (handle && job.current?.phase === "preparing" && !job.current.controller.signal.aborted) job.current.attach?.(handle);
  }, []);
  const share = useCallback(async () => {
    const currentOwner = client.conversationShareOwnerKey();
    const selected = selection.selected(ids);
    if (job.current || !currentOwner || selection.owner !== currentOwner || selected.length === 0) return;
    const current: ShareJob = { controller: new AbortController(), owner: currentOwner, revision: selection.revision, phase: "preparing" };
    job.current = current;
    setBusy(true); setNotice("");
    const signal = current.controller.signal;
    const deadline = setTimeout(() => { if (current.phase === "preparing") current.controller.abort(); }, 90_000);
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (job.current !== current || selection.owner !== current.owner || selection.revision !== current.revision
        || client.conversationShareOwnerKey() !== current.owner || AppState.currentState !== "active") {
        throw new Error("The message selection changed.");
      }
      if (current.leaseId) client.assertConversationShareCurrent(current.leaseId, signal);
    };
    try {
      assertCurrent();
      const prepared = await client.prepareConversationShare(selected, signal);
      current.leaseId = prepared.leaseId;
      assertCurrent();
      const handle = await new Promise<MobileConversationShareRendererHandle>((resolve, reject) => {
        const finish = (value?: MobileConversationShareRendererHandle) => {
          clearTimeout(timeout); signal.removeEventListener("abort", abort); current.attach = undefined;
          value ? resolve(value) : reject(new Error("The message image export was cancelled."));
        };
        const abort = () => finish();
        const timeout = setTimeout(abort, 5_000);
        current.attach = finish;
        signal.addEventListener("abort", abort, { once: true });
        setSnapshot(prepared);
      });
      const bytes = await handle.exportPng(signal);
      assertCurrent();
      const decoded = inspectMobileImageGalleryBytes(bytes, "image/png");
      await (latest.current.output ?? mobileImageOutput).perform("share", {
        leaseId: prepared.leaseId, fileName: "Joko-messages.png", mediaType: "image/png", bytes,
        byteSize: bytes.byteLength, sha256Hex: bytesToHex(sha256(bytes)), width: decoded.width, height: decoded.height
      }, undefined, signal, async () => {
        assertCurrent();
        await client.revalidateConversationShare(prepared.leaseId, signal);
        assertCurrent();
        current.phase = "dispatching";
        latest.current.onNativeActivityChange(true);
      });
      if (mounted.current && job.current === current) selection.exit();
    } catch (error) {
      if (mounted.current && job.current === current && !signal.aborted) {
        setNotice(mobileMessage(latest.current.locale, current.phase === "dispatching" ? "share.unknown"
          : error instanceof Error && /too large/u.test(error.message) ? "share.tooLarge" : "share.failed"));
        if (current.phase === "dispatching") selection.exit();
      }
    } finally {
      clearTimeout(deadline);
      if (current.leaseId) client.releaseConversationShare(current.leaseId);
      if (current.phase === "dispatching") latest.current.onNativeActivityChange(false);
      if (job.current === current) {
        job.current = undefined;
        if (mounted.current) { setBusy(false); setSnapshot(undefined); }
      }
    }
  }, [client, ids, selection]);
  const selectedIds = selection.selected(ids);
  return { active: selection.active && selection.owner === owner, busy, notice, snapshot, rendererRef,
    selectedIds, allSelected: ids.length > 0 && selectedIds.length === ids.length,
    enter, enterVisible, screenshotTriggered, toggle, rowTouchHandlers, toggleAll, cancel, share, locale };
}

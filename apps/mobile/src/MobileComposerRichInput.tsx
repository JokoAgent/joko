import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ForwardRefExoticComponent,
  type RefAttributes
} from "react";
import { AppState, Platform, StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent, type WebViewProps } from "react-native-webview";
import {
  mobileComposerDraftsEqual,
  type MobileComposerDraft,
  type MobileComposerEditResult,
  type MobileComposerSelection
} from "./mobile-composer-document";
import {
  mobileComposerRichDocument,
  reconcileMobileComposerRichDocument,
  validateMobileComposerRichSelection,
  type MobileComposerRichDocument
} from "./mobile-composer-rich-document";
import {
  buildMobileComposerRichApplyScript,
  buildMobileComposerRichConfigScript,
  buildMobileComposerRichInputHtml,
  type MobileComposerRichInputTheme,
  type MobileComposerRichRuntimeConfig
} from "./mobile-composer-rich-input-html";
import {
  parseMobileComposerRichWebMessage,
  type MobileComposerCommandPaletteKey,
  type MobileComposerPastedImageMediaType
} from "./mobile-composer-rich-input-protocol";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";

export interface MobileComposerRichInputHandle {
  blur(): void;
  focus(): void;
}

export interface MobileComposerRichPasteRequest {
  readonly draft: MobileComposerDraft;
  readonly selection: MobileComposerSelection;
  readonly text?: string;
}

export interface MobileComposerRichPastedImage {
  readonly base64: string;
  readonly mediaType: MobileComposerPastedImageMediaType;
  readonly name: string;
}

export interface MobileComposerRichImagePasteStartRequest {
  readonly count: number;
  readonly draft: MobileComposerDraft;
}

export interface MobileComposerRichImagePasteRequest extends MobileComposerRichImagePasteStartRequest {
  readonly images: readonly MobileComposerRichPastedImage[];
}

export interface MobileComposerRichInputProps {
  readonly accessibilityHint?: string;
  readonly accessibilityLabel: string;
  readonly bordered?: boolean;
  readonly commandPaletteOpen?: boolean;
  readonly draft: MobileComposerDraft;
  readonly editable: boolean;
  readonly height: number;
  readonly locale: MobileSupportedLocale;
  readonly maxHeight: number;
  readonly onBlur?: () => void;
  readonly onCommandPaletteKey?: (key: MobileComposerCommandPaletteKey) => void;
  readonly onCompositionChange?: (composing: boolean) => void;
  readonly onEdit: (result: MobileComposerEditResult, sourceDraft: MobileComposerDraft) => void;
  readonly onError: (message: string) => void;
  readonly onFocus?: () => void;
  readonly onHeightChange?: (height: number) => void;
  readonly onOpenAtom?: (atomId: string) => void;
  readonly onPasteImages?: (request: MobileComposerRichImagePasteRequest) => void;
  readonly onPasteImagesCancel?: (sourceDraft: MobileComposerDraft) => void;
  readonly onPasteImagesStart?: (request: MobileComposerRichImagePasteStartRequest) => boolean;
  readonly onPasteText: (request: MobileComposerRichPasteRequest) => void;
  readonly onSelectionChange: (selection: MobileComposerSelection, sourceDraft: MobileComposerDraft) => void;
  readonly ownerKey: string;
  readonly placeholder: string;
  readonly selection: MobileComposerSelection;
  readonly theme: MobileComposerRichInputTheme;
}

interface MobileComposerWebViewHandle {
  injectJavaScript(script: string): void;
}

interface AcceptedDocument {
  readonly document: MobileComposerRichDocument;
  readonly documentId: number;
  readonly draft: MobileComposerDraft;
  readonly locale: MobileSupportedLocale;
}

interface SurfaceIdentity {
  readonly instanceId: string;
  readonly key: number;
}

interface PendingImagePaste {
  readonly count: number;
  readonly documentId: number;
  readonly draft: MobileComposerDraft;
  readonly images: Array<MobileComposerRichPastedImage | undefined>;
  readonly requestId: string;
  readonly settled: Set<number>;
  readonly timeout: ReturnType<typeof setTimeout>;
  failed: boolean;
}

const RichInputWebView = WebView as unknown as ForwardRefExoticComponent<
  WebViewProps & RefAttributes<MobileComposerWebViewHandle>
>;
const richInputBaseUrl = "https://joko-composer.invalid";
const heartbeatIntervalMilliseconds = 15_000;
const heartbeatTimeoutMilliseconds = 5_000;
const pastedImageReadTimeoutMilliseconds = 30_000;
let surfaceSequence = 0;

function createSurfaceIdentity(): SurfaceIdentity {
  const key = ++surfaceSequence;
  return { key, instanceId: `joko-composer-${key}` };
}

export const MobileComposerRichInput = forwardRef<MobileComposerRichInputHandle, MobileComposerRichInputProps>(
  function MobileComposerRichInput({
    accessibilityHint,
    accessibilityLabel,
    bordered = false,
    commandPaletteOpen = false,
    draft,
    editable,
    height,
    locale,
    maxHeight,
    onBlur,
    onCommandPaletteKey,
    onCompositionChange,
    onEdit,
    onError,
    onFocus,
    onHeightChange,
    onOpenAtom,
    onPasteImages,
    onPasteImagesCancel,
    onPasteImagesStart,
    onPasteText,
    onSelectionChange,
    ownerKey,
    placeholder,
    selection,
    theme
  }, forwardedRef) {
    const [surface, setSurface] = useState(createSurfaceIdentity);
    const activeInstanceIdRef = useRef(surface.instanceId);
    const webViewRef = useRef<MobileComposerWebViewHandle | null>(null);
    const readyRef = useRef(false);
    const mountedRef = useRef(true);
    const recoveringRef = useRef(false);
    const deferredRecoveryRef = useRef(false);
    const pendingFocusRef = useRef(false);
    const ownerKeyRef = useRef(ownerKey);
    const editableRef = useRef(editable);
    const selectionRef = useRef(selection);
    const callbacksRef = useRef({
      onBlur, onCommandPaletteKey, onCompositionChange, onEdit, onError, onFocus,
      onHeightChange, onOpenAtom, onPasteImages, onPasteImagesCancel, onPasteImagesStart,
      onPasteText, onSelectionChange
    });
    const acceptedRef = useRef<AcceptedDocument>({
      document: mobileComposerRichDocument(draft, locale),
      documentId: 1,
      draft,
      locale
    });
    const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
    const heartbeatTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const pendingHeartbeatRef = useRef<string | undefined>(undefined);
    const heartbeatSequenceRef = useRef(0);
    const recoveryTimesRef = useRef<number[]>([]);
    const pendingImagePasteRef = useRef<PendingImagePaste | undefined>(undefined);

    ownerKeyRef.current = ownerKey;
    editableRef.current = editable;
    selectionRef.current = selection;
    callbacksRef.current = {
      onBlur, onCommandPaletteKey, onCompositionChange, onEdit, onError, onFocus,
      onHeightChange, onOpenAtom, onPasteImages, onPasteImagesCancel, onPasteImagesStart,
      onPasteText, onSelectionChange
    };

    const runtimeConfig = useMemo<MobileComposerRichRuntimeConfig>(() => ({
      accessibilityLabel,
      commandPaletteOpen,
      editable,
      labels: {
        selectedCommand: mobileMessage(locale, "composer.rich.selectedCommand", { command: "{command}" }),
        structuredItem: mobileMessage(locale, "composer.rich.structuredItem"),
        taskMessage: mobileMessage(locale, "composer.rich.taskMessage")
      },
      locale,
      maxHeight: Math.max(44, Math.min(4_096, Math.ceil(maxHeight))),
      placeholder,
      theme
    }), [accessibilityLabel, commandPaletteOpen, editable, locale, maxHeight, placeholder, theme]);

    const initialHtml = useMemo(() => buildMobileComposerRichInputHtml({
      ...runtimeConfig,
      document: acceptedRef.current.document,
      documentId: acceptedRef.current.documentId,
      instanceId: surface.instanceId,
      selection: validateMobileComposerRichSelection(acceptedRef.current.draft, selectionRef.current)
    }), [surface.instanceId]);

    const inject = useCallback((script: string) => {
      webViewRef.current?.injectJavaScript(`try{${script}}catch(_){}true;`);
    }, []);

    const clearHeartbeat = useCallback(() => {
      if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current);
      if (heartbeatTimeoutRef.current) clearTimeout(heartbeatTimeoutRef.current);
      heartbeatIntervalRef.current = undefined;
      heartbeatTimeoutRef.current = undefined;
      pendingHeartbeatRef.current = undefined;
    }, []);

    const cancelPendingImagePaste = useCallback(() => {
      const pending = pendingImagePasteRef.current;
      pendingImagePasteRef.current = undefined;
      if (pending) {
        clearTimeout(pending.timeout);
        callbacksRef.current.onPasteImagesCancel?.(pending.draft);
      }
    }, []);

    const applyAcceptedDocument = useCallback((
      nextDraft: MobileComposerDraft,
      nextSelection: MobileComposerSelection,
      focus = false
    ) => {
      const document = mobileComposerRichDocument(nextDraft, locale);
      const normalizedSelection = validateMobileComposerRichSelection(nextDraft, nextSelection);
      const documentId = acceptedRef.current.documentId + 1;
      acceptedRef.current = { document, documentId, draft: nextDraft, locale };
      selectionRef.current = normalizedSelection;
      if (readyRef.current) inject(buildMobileComposerRichApplyScript({
        document,
        documentId,
        selection: normalizedSelection,
        focus
      }));
      else if (focus) pendingFocusRef.current = true;
    }, [inject, locale]);

    const rebuildSurface = useCallback(() => {
      deferredRecoveryRef.current = false;
      const now = Date.now();
      recoveryTimesRef.current = recoveryTimesRef.current.filter((value) => now - value < 30_000);
      if (recoveryTimesRef.current.length >= 3) return;
      recoveryTimesRef.current.push(now);
      const nextSurface = createSurfaceIdentity();
      activeInstanceIdRef.current = nextSurface.instanceId;
      setSurface(nextSurface);
    }, []);

    const recover = useCallback((message: string) => {
      if (!mountedRef.current || recoveringRef.current) return;
      readyRef.current = false;
      recoveringRef.current = true;
      activeInstanceIdRef.current = "";
      clearHeartbeat();
      cancelPendingImagePaste();
      callbacksRef.current.onCompositionChange?.(false);
      callbacksRef.current.onBlur?.();
      callbacksRef.current.onError(message);
      if (AppState.currentState !== "active") {
        deferredRecoveryRef.current = true;
        return;
      }
      rebuildSurface();
    }, [cancelPendingImagePaste, clearHeartbeat, rebuildSurface]);

    const sendHeartbeat = useCallback(() => {
      if (!readyRef.current || AppState.currentState !== "active" || pendingHeartbeatRef.current) return;
      const id = `ping-${++heartbeatSequenceRef.current}`;
      pendingHeartbeatRef.current = id;
      inject(`window.jokoComposer.ping(${JSON.stringify(id)});`);
      heartbeatTimeoutRef.current = setTimeout(() => {
        if (pendingHeartbeatRef.current !== id) return;
        if (AppState.currentState !== "active") {
          pendingHeartbeatRef.current = undefined;
          return;
        }
        recover(mobileMessage(locale, "composer.rich.unresponsive"));
      }, heartbeatTimeoutMilliseconds);
    }, [inject, locale, recover]);

    const startHeartbeat = useCallback(() => {
      clearHeartbeat();
      heartbeatIntervalRef.current = setInterval(sendHeartbeat, heartbeatIntervalMilliseconds);
    }, [clearHeartbeat, sendHeartbeat]);

    useImperativeHandle(forwardedRef, () => ({
      blur: () => {
        pendingFocusRef.current = false;
        if (readyRef.current) inject("window.jokoComposer.blur();");
      },
      focus: () => {
        if (readyRef.current) inject("window.jokoComposer.focus();");
        else pendingFocusRef.current = true;
      }
    }), [inject]);

    useEffect(() => {
      const current = acceptedRef.current;
      if (mobileComposerDraftsEqual(current.draft, draft) && current.locale === locale) {
        acceptedRef.current = { ...current, draft };
        return;
      }
      cancelPendingImagePaste();
      try {
        applyAcceptedDocument(draft, selectionRef.current);
      } catch {
        callbacksRef.current.onError(mobileMessage(locale, "composer.rich.invalidUpdate"));
      }
    }, [applyAcceptedDocument, cancelPendingImagePaste, draft, locale]);

    useEffect(() => {
      if (readyRef.current) inject(buildMobileComposerRichConfigScript(runtimeConfig));
    }, [inject, runtimeConfig]);

    useEffect(() => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        readyRef.current = false;
        clearHeartbeat();
        cancelPendingImagePaste();
      };
    }, [cancelPendingImagePaste, clearHeartbeat]);

    useEffect(() => {
      const subscription = AppState.addEventListener("change", (nextState) => {
        if (nextState !== "active") {
          clearHeartbeat();
          cancelPendingImagePaste();
          return;
        }
        if (deferredRecoveryRef.current) {
          rebuildSurface();
          return;
        }
        if (readyRef.current) startHeartbeat();
      });
      return () => subscription.remove();
    }, [cancelPendingImagePaste, clearHeartbeat, rebuildSurface, startHeartbeat]);

    const handleMessage = useCallback((event: WebViewMessageEvent) => {
      const message = parseMobileComposerRichWebMessage(event.nativeEvent.data);
      if (!mountedRef.current || !message || message.instanceId !== activeInstanceIdRef.current
        || ownerKeyRef.current !== ownerKey) return;
      if (message.type === "ready") {
        readyRef.current = true;
        recoveringRef.current = false;
        inject(buildMobileComposerRichConfigScript(runtimeConfig));
        applyAcceptedDocument(acceptedRef.current.draft, selectionRef.current, pendingFocusRef.current);
        pendingFocusRef.current = false;
        startHeartbeat();
        return;
      }
      if (message.type === "pong") {
        if (pendingHeartbeatRef.current !== message.id) return;
        pendingHeartbeatRef.current = undefined;
        if (heartbeatTimeoutRef.current) clearTimeout(heartbeatTimeoutRef.current);
        heartbeatTimeoutRef.current = undefined;
        return;
      }
      if (message.type === "height") {
        callbacksRef.current.onHeightChange?.(Math.max(44, Math.min(maxHeight, message.height)));
        return;
      }
      if (message.type === "focus") {
        callbacksRef.current.onFocus?.();
        return;
      }
      if (message.type === "blur") {
        callbacksRef.current.onCompositionChange?.(false);
        callbacksRef.current.onBlur?.();
        return;
      }
      if (message.type === "composition") {
        callbacksRef.current.onCompositionChange?.(message.composing);
        return;
      }
      if (message.type === "paletteKey") {
        callbacksRef.current.onCommandPaletteKey?.(message.key);
        return;
      }
      const current = acceptedRef.current;
      if (message.documentId !== current.documentId) return;
      if (message.type === "selection") {
        try {
          const nextSelection = validateMobileComposerRichSelection(current.draft, message);
          selectionRef.current = nextSelection;
          callbacksRef.current.onSelectionChange(nextSelection, current.draft);
        } catch {
          applyAcceptedDocument(current.draft, selectionRef.current);
        }
        return;
      }
      if (message.type === "paste") {
        if (!editableRef.current || AppState.currentState !== "active") return;
        try {
          const pasteSelection = validateMobileComposerRichSelection(current.draft, message);
          callbacksRef.current.onPasteText({
            draft: current.draft,
            selection: pasteSelection,
            ...(message.text === undefined ? {} : { text: message.text })
          });
        } catch (failure) {
          callbacksRef.current.onError(errorText(failure, locale));
          applyAcceptedDocument(current.draft, selectionRef.current);
        }
        return;
      }
      if (message.type === "pasteImagesStart") {
        if (message.documentId !== current.documentId) return;
        if (!editableRef.current || AppState.currentState !== "active" || pendingImagePasteRef.current) {
          callbacksRef.current.onError(mobileMessage(locale, "composer.rich.finishAttachment"));
          return;
        }
        let accepted = false;
        try {
          accepted = callbacksRef.current.onPasteImages !== undefined
            && callbacksRef.current.onPasteImagesStart?.({ count: message.count, draft: current.draft }) === true;
        } catch (failure) {
          callbacksRef.current.onError(errorText(failure, locale));
          return;
        }
        if (!accepted) {
          callbacksRef.current.onError(mobileMessage(locale, "composer.rich.imagePasteUnavailable"));
          return;
        }
        const timeout = setTimeout(() => {
          const pending = pendingImagePasteRef.current;
          if (!pending || pending.documentId !== message.documentId || pending.requestId !== message.requestId) return;
          cancelPendingImagePaste();
          callbacksRef.current.onError(mobileMessage(locale, "composer.rich.imagePasteTimeout"));
        }, pastedImageReadTimeoutMilliseconds);
        pendingImagePasteRef.current = {
          count: message.count,
          documentId: message.documentId,
          draft: current.draft,
          images: Array.from({ length: message.count }),
          requestId: message.requestId,
          settled: new Set(),
          timeout,
          failed: false
        };
        return;
      }
      if (message.type === "pasteImage" || message.type === "pasteImageFailed") {
        const pending = pendingImagePasteRef.current;
        if (!pending || pending.documentId !== message.documentId || pending.requestId !== message.requestId) return;
        if (message.index >= pending.count || pending.settled.has(message.index)) {
          cancelPendingImagePaste();
          callbacksRef.current.onError(mobileMessage(locale, "composer.rich.imagePasteMalformed"));
          return;
        }
        pending.settled.add(message.index);
        if (message.type === "pasteImage") {
          pending.images[message.index] = {
            base64: message.base64,
            mediaType: message.mediaType,
            name: message.name
          };
        } else {
          pending.failed = true;
        }
        if (pending.settled.size < pending.count) return;
        pendingImagePasteRef.current = undefined;
        clearTimeout(pending.timeout);
        if (pending.failed || pending.images.some((image) => image === undefined)) {
          callbacksRef.current.onPasteImagesCancel?.(pending.draft);
          callbacksRef.current.onError(mobileMessage(locale, "composer.rich.imagePasteFailed"));
          return;
        }
        try {
          callbacksRef.current.onPasteImages?.({
            count: pending.count,
            draft: pending.draft,
            images: pending.images as MobileComposerRichPastedImage[]
          });
        } catch (failure) {
          callbacksRef.current.onPasteImagesCancel?.(pending.draft);
          callbacksRef.current.onError(errorText(failure, locale));
        }
        return;
      }
      if (message.type === "activate") {
        if (!message.occurrenceKey.startsWith("atom:")) return;
        const atomId = message.occurrenceKey.slice("atom:".length);
        if (current.draft.atoms.some((atom) => atom.atomId === atomId)) callbacksRef.current.onOpenAtom?.(atomId);
        return;
      }
      if (message.type !== "change") return;
      if (!editableRef.current || AppState.currentState !== "active") {
        applyAcceptedDocument(current.draft, selectionRef.current);
        return;
      }
      try {
        const result = reconcileMobileComposerRichDocument(current.draft, message.segments, message);
        acceptedRef.current = {
          document: mobileComposerRichDocument(result.draft, locale),
          documentId: current.documentId,
          draft: result.draft,
          locale
        };
        selectionRef.current = result.selection;
        callbacksRef.current.onSelectionChange(result.selection, current.draft);
        callbacksRef.current.onEdit(result, current.draft);
      } catch (failure) {
        callbacksRef.current.onError(mobileMessage(locale, "composer.rich.invalidUpdate"));
        applyAcceptedDocument(current.draft, selectionRef.current);
      }
    }, [applyAcceptedDocument, cancelPendingImagePaste, inject, locale, maxHeight, ownerKey, runtimeConfig, startHeartbeat]);

    return <View style={[
      styles.frame,
      bordered && styles.bordered,
      { backgroundColor: theme.background, borderColor: theme.border, height }
    ]}>
      <RichInputWebView
        accessibilityHint={accessibilityHint}
        accessibilityLabel={accessibilityLabel}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        allowsLinkPreview={false}
        cacheEnabled={false}
        domStorageEnabled={false}
        incognito
        javaScriptCanOpenWindowsAutomatically={false}
        javaScriptEnabled
        key={surface.key}
        keyboardDisplayRequiresUserAction={false}
        hideKeyboardAccessoryView={Platform.OS === "ios" && !Platform.isPad}
        mixedContentMode="never"
        onContentProcessDidTerminate={() => recover(mobileMessage(locale, "composer.rich.reclaimed"))}
        onError={() => recover(mobileMessage(locale, "composer.rich.loadFailed"))}
        onMessage={handleMessage}
        onRenderProcessGone={() => {
          recover(mobileMessage(locale, "composer.rich.processEnded"));
          return true;
        }}
        onShouldStartLoadWithRequest={(request: { readonly url: string }) => request.url === richInputBaseUrl
          || request.url === `${richInputBaseUrl}/` || request.url === "about:blank"}
        originWhitelist={[richInputBaseUrl, "about:blank"]}
        ref={webViewRef}
        scrollEnabled={false}
        setSupportMultipleWindows={false}
        sharedCookiesEnabled={false}
        source={{ html: initialHtml, baseUrl: richInputBaseUrl }}
        containerStyle={styles.webView}
        style={styles.webView}
        textInteractionEnabled
        thirdPartyCookiesEnabled={false}
      />
    </View>;
  }
);

function errorText(error: unknown, locale: MobileSupportedLocale): string {
  return error instanceof Error && error.message ? error.message : mobileMessage(locale, "composer.rich.invalidUpdate");
}

export const mobileComposerRichInputTesting = {
  heartbeatIntervalMilliseconds,
  heartbeatTimeoutMilliseconds,
  richInputBaseUrl
};

const styles = StyleSheet.create({
  bordered: { borderRadius: 12, borderWidth: 1 },
  frame: { flex: 1, minHeight: 44, minWidth: 0, overflow: "hidden" },
  webView: { backgroundColor: "transparent", flex: 1 }
});

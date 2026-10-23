import { useEffect, useRef, useState } from "react";
import { AppState, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { randomUUID } from "expo-crypto";
import * as Clipboard from "expo-clipboard";
import type { MobileClient } from "./mobile-client";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import { MobileComposerRichInput } from "./MobileComposerRichInput";
import { MobileUserMessageContent } from "./MobileUserMessageContent";
import { mobileAttachmentFiles, mobileAttachmentCamera, mobilePhotoLibrary } from "./storage";
import { appendMobileComposerAttachments, removeMobileComposerAttachment, type MobileComposerAttachment } from "./mobile-attachments";
import { mobileCameraCaptureSupported } from "./mobile-attachment-camera";
import { mobilePhotoLibrarySupported } from "./mobile-photo-library";
import { insertMobileStructuredClipboardText, mobileComposerDraftsEqual, type MobileComposerDraft, type MobileComposerSelection } from "./mobile-composer-document";
import { MobileComposerImagePaste } from "./mobile-composer-image-paste";
import type { MobileNewTaskDraft, MobileNewTaskDraftIdentity, MobileNewTaskDraftStore } from "./new-task-draft-store";

/** The original message is immutable; further edits belong to this creation's durable local outbox. */
export function MobilePendingNewTaskConversation({ client, store, identity, draft, colors, locale, onBack, error }: {
  readonly client: MobileClient; readonly store: MobileNewTaskDraftStore; readonly identity: MobileNewTaskDraftIdentity;
  readonly draft: MobileNewTaskDraft; readonly colors: MobileInteractionSheetColors; readonly locale: MobileSupportedLocale;
  readonly onBack: () => void; readonly error?: string;
}) {
  const submission = draft.submission!, conversation = draft.conversation!;
  const [selection, setSelection] = useState<MobileComposerSelection>({ start: conversation.input.text.length, end: conversation.input.text.length });
  const [height, setHeight] = useState(132), [localError, setError] = useState(""), [busy, setBusy] = useState(false);
  const mounted = useRef(true), picker = useRef<AbortController | undefined>(undefined);
  const inputRef = useRef(conversation.input); inputRef.current = conversation.input;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; picker.current?.abort(); void store.flush(identity).catch(() => undefined); }; }, []);
  const current = () => {
    const retained = store.readSync(identity);
    if (client.state.activeProfileId !== identity.profileId || retained?.submission?.createOperationId !== submission.createOperationId
      || retained.submission.connectionId !== submission.connectionId || retained.submission.serverId !== submission.serverId
      || !retained.conversation || retained.conversation.sealed) throw new Error(mobileMessage(locale, "newTask.returnActive"));
    return retained.conversation.input;
  };
  const save = (input: MobileComposerDraft, nextSelection = selection): void => {
    current(); store.saveConversationInput(identity, submission.createOperationId, input);
    inputRef.current = input; setSelection(nextSelection);
  };
  const fail = (cause: unknown) => { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); };
  const controls = client.newTaskAttachmentControls(submission.targetId);
  const editable = !conversation.sealed && !busy && client.state.activeProfileId === identity.profileId;
  const stage = async (load: (signal: AbortSignal) => Promise<readonly MobileComposerAttachment[]>): Promise<void> => {
    if (!controls || busy || !editable) return;
    const controller = new AbortController(); picker.current = controller; setBusy(true); setError("");
    let staged: readonly MobileComposerAttachment[] = [];
    try {
      staged = await load(controller.signal); controller.signal.throwIfAborted();
      const latestControls = client.newTaskAttachmentControls(submission.targetId);
      if (!mounted.current || AppState.currentState !== "active" || latestControls?.surfaceOwnerKey !== controls.surfaceOwnerKey) {
        throw new Error(mobileMessage(locale, "task.error.selectedMediaChanged"));
      }
      const input = current();
      save({ ...input, attachments: appendMobileComposerAttachments(input.attachments, staged, controls.policy) });
      // Ownership transfers before the disk wait. A failed flush must keep referenced bytes.
      staged = []; await store.flush(identity);
    } catch (cause) { fail(cause); }
    finally {
      await Promise.all(staged.map(item => mobileAttachmentFiles.remove(identity.profileId, item).catch(() => undefined)));
      if (picker.current === controller) picker.current = undefined;
      if (mounted.current) setBusy(false);
    }
  };
  const attach = (source: "picker" | "photos" | "camera") => {
    if (!controls) return;
    void stage(signal => source === "camera"
      ? mobileAttachmentCamera.captureAndStage(identity.profileId, current().attachments, controls.policy, randomUUID, signal)
      : source === "photos"
        ? mobilePhotoLibrary.pickSystemAndStage(identity.profileId, current().attachments, controls.policy, randomUUID, signal)
        : mobileAttachmentFiles.pickAndStage(identity.profileId, current().attachments, controls.policy, randomUUID, signal));
  };
  const action = (label: string, onPress: () => void, disabled = false) => <Pressable accessibilityRole="button"
    accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={[styles.button, { borderColor: colors.border, opacity: disabled ? 0.45 : 1 }]}>
    <Text style={{ color: colors.ink }}>{label}</Text>
  </Pressable>;
  const rows = [{ operationId: submission.createOperationId, input: submission.input,
    state: submission.phase === "sending" && submission.firstInputAccepted ? "accepted" : "queued" }, ...conversation.followUps];
  return <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled" testID="newTask.localConversation">
    {action(mobileMessage(locale, "common.tasks"), onBack)}
    <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>{draft.name.trim() || mobileMessage(locale, "newTask.localConversation")}</Text>
    <Text accessibilityLiveRegion="polite" style={{ color: colors.muted }}>{mobileMessage(locale, "newTask.followUpHint")}</Text>
    {rows.map(row => <View key={row.operationId} testID={`newTask.localMessage.${row.operationId}`}
      style={[styles.message, { backgroundColor: colors.brandBackground, borderColor: colors.border }]}>
      <MobileUserMessageContent ownerKey={row.operationId} text={row.input.text} automation={false} selectable locale={locale} colors={colors} />
      {row.input.atoms.map(atom => <Text key={atom.atomId} selectable style={{ color: colors.muted }}>{atom.kind === "route-reference" ? atom.displayText : atom.text}</Text>)}
      {row.input.attachments.map(item => <Text key={item.attachmentId} style={{ color: colors.muted }}>{item.fileName}</Text>)}
      {row.state !== "accepted" && <Text style={[styles.status, { color: colors.muted }]}>{mobileMessage(locale, "newTask.followUpSaved")}</Text>}
    </View>)}
    <Text style={{ color: colors.muted }}>{mobileMessage(locale, "newTask.followUp")}</Text>
    <MobileComposerRichInput draft={conversation.input} ownerKey={`${identity.profileId}:${submission.createOperationId}`}
      accessibilityLabel={mobileMessage(locale, "newTask.followUp")} accessibilityHint={mobileMessage(locale, "newTask.followUpHint")}
      editable={editable} bordered height={height} maxHeight={260} locale={locale} selection={selection}
      placeholder={mobileMessage(locale, "newTask.placeholder")} theme={{ background: colors.surface, border: colors.border,
        chip: colors.brandBackground, focus: colors.accent, placeholder: colors.muted, text: colors.ink, textSecondary: colors.muted }}
      onEdit={(result, source) => { try { if (!mobileComposerDraftsEqual(current(), source)) return; save(result.draft, result.selection); } catch (cause) { fail(cause); } }}
      onSelectionChange={(next, source) => { if (mobileComposerDraftsEqual(inputRef.current, source)) setSelection(next); }}
      onHeightChange={value => setHeight(Math.max(132, Math.min(260, value)))} onError={setError}
      onPasteText={request => { void (async () => {
        if (!editable || !mobileComposerDraftsEqual(current(), request.draft)) return;
        const text = request.text ?? await Clipboard.getStringAsync();
        if (!mounted.current || !mobileComposerDraftsEqual(current(), request.draft)) return;
        const result = insertMobileStructuredClipboardText(request.draft, request.selection, text, randomUUID);
        save(result.draft, result.selection);
      })().catch(fail); }}
      onPasteImagesStart={request => { try {
        return editable && controls?.policy.images === true && request.count <= controls.policy.maximumItems - current().attachments.length;
      } catch { return false; } }}
      onPasteImages={request => {
        if (!controls) return;
        void stage(async signal => {
          if (!mobileComposerDraftsEqual(current(), request.draft)) throw new Error(mobileMessage(locale, "task.error.clipboardAttachmentChanged"));
          return new MobileComposerImagePaste(mobileAttachmentFiles).stage(identity.profileId, current().attachments,
            controls.policy, request.images, randomUUID, signal);
        });
      }} />
    {conversation.input.attachments.map(item => <View key={item.attachmentId} style={styles.tools}>
      <Text style={{ color: colors.ink }}>{item.fileName}</Text>
      {action(mobileMessage(locale, "common.remove"), () => { void (async () => {
        const input = current(); save({ ...input, attachments: removeMobileComposerAttachment(input.attachments, item.attachmentId).attachments });
        await store.flush(identity); await mobileAttachmentFiles.remove(identity.profileId, item);
      })().catch(fail); }, !editable)}
    </View>)}
    <View style={styles.tools}>
      {controls && action(mobileMessage(locale, "composer.attach"), () => attach("picker"), !editable)}
      {controls && mobilePhotoLibrarySupported(controls.policy) && action(mobileMessage(locale, "composer.photos"), () => attach("photos"), !editable)}
      {controls && mobileCameraCaptureSupported(controls.policy) && action(mobileMessage(locale, "composer.takePhoto"), () => attach("camera"), !editable)}
      {action(mobileMessage(locale, "composer.send"), () => { setError(""); void (async () => {
        await store.queueFollowUp(identity, submission.createOperationId, randomUUID(), current());
      })().catch(fail); }, !editable || !conversation.input.text.trim() && !conversation.input.attachments.length)}
    </View>
    {(localError || error) && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{localError || error}</Text>}
    {action(mobileMessage(locale, "newTask.checkRetained"), () => { void client.reconcile().catch(fail); }, client.state.busy || client.state.status !== "connected")}
  </ScrollView>;
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 16, paddingBottom: 40 }, title: { fontSize: 24, fontWeight: "700" },
  message: { alignSelf: "flex-end", padding: 16, borderRadius: 16, borderWidth: 1, gap: 8, maxWidth: "94%" },
  status: { fontSize: 12 }, button: { minHeight: 44, padding: 12, borderWidth: 1, borderRadius: 12, justifyContent: "center" },
  tools: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }
});

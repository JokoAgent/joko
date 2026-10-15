import type { AppController } from "./controller.js";
import type { OrchestratorGateway } from "./gateway.js";
import type { AppSnapshot, ComposerDraft } from "./model.js";
import type { LocalState } from "./local-state.js";
import { taskSourceKey, type SessionAccess, type TaskSource } from "./task-sharing.js";

const taskMethods = new Set([
  "refresh", "send", "abort", "abortRetry", "setModel", "setBackend", "resolveInteraction",
  "editQueueItem", "setQueueItemEditLock", "cancelQueueItem", "steerQueueItemNow",
  "getSessionStatistics", "listBackgroundTasks", "getBackgroundTaskOutput", "listSubagentRuns", "getSubagentRun", "listSubagentTranscript",
  "loadSessionTimelinePage", "loadSessionTimelineAround", "searchSessionMessages",
  "listSessionArtifacts", "getArtifactUrl", "releaseArtifactUrl", "downloadArtifact", "copyArtifactFile",
  "openArtifactFile", "openArtifactFileWithApplication"
]);

export interface TaskSharingController extends AppController { retireTaskSharingInput(): void; }

/** A closed task facade: no property lookup can fall through to the Home controller. */
export function createTaskSharingController(input: {
  readonly home: () => AppController;
  readonly gateway: OrchestratorGateway;
  readonly source: Extract<TaskSource, { readonly kind: "joined" }>;
  readonly snapshot: () => AppSnapshot;
  readonly access: () => SessionAccess;
  readonly current: () => boolean;
  readonly local: LocalState;
}): TaskSharingController {
  const source = input.source, draftProfile = `shared:${taskSourceKey(source)}`;
  const assertCurrent = (): void => { if (!input.current()) throw new Error("The shared task source changed."); };
  const assertSession = (sessionId: string): void => { assertCurrent(); if (sessionId !== source.sessionId) throw new Error("This task is outside the shared source."); };
  const local = input.local;
  const homeVoice = input.home();
  const voices = new Set<string>();
  const functions = new Map<string, unknown>();
  const voiceResult = async <T>(read: () => Promise<T>): Promise<T> => { assertCurrent(); const value = await read(); assertCurrent(); return value; };
  const assertVoice = (id: string): void => { assertCurrent(); if (!voices.has(id)) throw new Error("This recording belongs to another input source."); };
  const methods = {
    retireTaskSharingInput: (): void => { for (const id of voices) { voices.delete(id); void homeVoice.cancelVoiceInput(id).catch(() => undefined); } },
    getVoiceInputCapabilities: (...args: Parameters<AppController["getVoiceInputCapabilities"]>) => voiceResult(() => homeVoice.getVoiceInputCapabilities(...args)),
    getVoiceInputDictionary: (...args: Parameters<AppController["getVoiceInputDictionary"]>) => voiceResult(() => homeVoice.getVoiceInputDictionary(...args)),
    adviseVoiceInputDictionaryEdit: (...args: Parameters<AppController["adviseVoiceInputDictionaryEdit"]>) => voiceResult(() => homeVoice.adviseVoiceInputDictionaryEdit(...args)),
    applyVoiceInputDictionaryLearning: (...args: Parameters<AppController["applyVoiceInputDictionaryLearning"]>) => voiceResult(() => homeVoice.applyVoiceInputDictionaryLearning(...args)),
    startVoiceInput: async (...args: Parameters<AppController["startVoiceInput"]>) => {
      assertCurrent(); const recording = await homeVoice.startVoiceInput(...args); voices.add(recording.id);
      if (!input.current()) { voices.delete(recording.id); void homeVoice.cancelVoiceInput(recording.id).catch(() => undefined); assertCurrent(); }
      return recording;
    },
    appendVoiceAudio: (...args: Parameters<AppController["appendVoiceAudio"]>) => { assertVoice(args[0]); return voiceResult(() => homeVoice.appendVoiceAudio(...args)); },
    stopVoiceInput: (...args: Parameters<AppController["stopVoiceInput"]>) => { assertVoice(args[0]); return voiceResult(() => homeVoice.stopVoiceInput(...args)); },
    getVoiceInputSession: (...args: Parameters<AppController["getVoiceInputSession"]>) => { assertVoice(args[0]); return voiceResult(() => homeVoice.getVoiceInputSession(...args)); },
    cancelVoiceInput: async (...args: Parameters<AppController["cancelVoiceInput"]>) => {
      if (!voices.has(args[0])) throw new Error("This recording belongs to another input source.");
      voices.delete(args[0]); return homeVoice.cancelVoiceInput(...args);
    },
    getPersonalizationPrompt: () => "",
    readDraft: async (sessionId: string) => { assertSession(sessionId); return local.readDraft(source.remoteServerId, draftProfile, sessionId); },
    readDraftSnapshot: async (sessionId: string) => { assertSession(sessionId); return local.readDraftSnapshot(source.remoteServerId, draftProfile, sessionId); },
    saveDraft: async (sessionId: string, draft: ComposerDraft) => { assertSession(sessionId); await local.saveDraft(source.remoteServerId, draftProfile, sessionId, draft); assertCurrent(); },
    saveDraftIfRevision: async (sessionId: string, draft: ComposerDraft, revision: number) => { assertSession(sessionId); const value = await local.saveDraftIfRevision(source.remoteServerId, draftProfile, sessionId, draft, revision); assertCurrent(); return value; },
    refreshProviderModels: () => { assertCurrent(); return input.gateway.refresh(); },
    openHttpLink: (url: string) => { assertCurrent(); return input.home().openHttpLink(url, { forceExternal: true }); },
    navigate: (route: Parameters<AppController["navigate"]>[0]) => {
      assertCurrent();
      if (route.kind !== "session" || route.sessionId !== source.sessionId) throw new Error("This destination is outside the shared task.");
      input.home().navigate({ kind: "sharedTask", profileId: source.homeProfileId, joinId: source.joinId });
    }
  };
  return new Proxy(Object.create(null) as TaskSharingController, {
    get(_target, property: string) {
      if (property === "then") return undefined;
      if (property === "state") { const home = input.home(), snapshot = input.snapshot(); return { ...home.state, snapshot: {
        ...snapshot, settings: { ...snapshot.settings, voiceInput: home.state.snapshot.settings.voiceInput }
      }, taskSource: source,
        sessionAccess: input.access(), route: { kind: "session", sessionId: source.sessionId, profileId: source.homeProfileId } }; }
      if (property === "taskSourceKey") return taskSourceKey(source);
      if (property === "taskSharing" || property === "appDefaultModelUi") return undefined;
      if (Object.hasOwn(methods, property)) return methods[property as keyof typeof methods];
      if (functions.has(property)) return functions.get(property);
      const method = taskMethods.has(property) ? (...args: unknown[]) => {
        assertCurrent();
        const method = input.gateway[property as keyof OrchestratorGateway];
        if (typeof method !== "function") return Promise.reject(new Error("This shared task action is unavailable."));
        return Reflect.apply(method, input.gateway, args);
      } : () => Promise.reject(new Error("This action is unavailable for a shared task."));
      functions.set(property, method); return method;
    }
  });
}

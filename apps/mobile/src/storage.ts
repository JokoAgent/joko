import AsyncStorage from "@react-native-async-storage/async-storage";
import { randomUUID } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { createMobileStorage, type MobilePlainStorageDriver } from "./connection-storage";
import { MobilePartnerCreationReceipts } from "./mobile-partner-creation-receipts";
import { MobilePartnerDeletionReceipts } from "./mobile-partner-deletion";
import { MobilePartnerRestartReceipts } from "./mobile-partner-restart";
import { MobileComposerDraftStore } from "./composer-draft-store";
import { MobileInteractionDraftStore } from "./interaction-draft-store";
import { MobileNewTaskDraftStore } from "./new-task-draft-store";
import { MobileAttachmentFiles } from "./mobile-attachment-files";
import { MobileAttachmentCamera } from "./mobile-attachment-camera";
import { MobilePhotoLibrary } from "./mobile-photo-library";
import { MobileOfflineCache } from "./mobile-offline-cache";
import { MobileVoiceDictionaryReadOnlyCache } from "./mobile-voice-dictionary-readonly-cache";
import { MobileThemePreferenceStore } from "./mobile-theme-preference";
import { MobileReplyQuotePreferences } from './mobile-reply-quote-preferences';
import { MobileDiagnosticsStore } from "./mobile-diagnostics";
import { MobileLocalePreferenceStore } from "./mobile-locale-preference";
import { MobileVoicePreferencesStore } from "./mobile-voice-preferences-store";
import { MobileUpdateDeviceStore } from "./mobile-update-device-store";
import { MobileUpdateController } from "./mobile-update-controller";
import { createMobileUpdateRuntimeEnvironment } from "./mobile-update-runtime";
import { MobilePushDeviceStore } from "./mobile-push-device-store";
import { MobileFilesPreferenceStore } from "./mobile-files-preferences";
import { mobileHistoryDiskStorage } from "./mobile-history-disk-storage";
import { createMobileStorageFullRecovery } from "./mobile-storage-full-recovery";
import { mobileMessage } from "./mobile-messages";

export const mobilePlainStorage: MobilePlainStorageDriver & {
  getAllKeys(): Promise<readonly string[]>; multiRemove(keys: readonly string[]): Promise<void>;
} = {
  getItem: (key: string) => AsyncStorage.getItem(key),
  setItem: createMobileStorageFullRecovery((key, value) => AsyncStorage.setItem(key, value), async () => {
    const keys = (await AsyncStorage.getAllKeys()).filter(key => key.startsWith("joko.mobile.offline-cache.v1."));
    if (keys.length) await AsyncStorage.multiRemove(keys);
  }, (): string => mobileMessage(mobileLocalePreferences.snapshot.effectiveLocale, "storage.full")),
  removeItem: (key: string) => AsyncStorage.removeItem(key),
  getAllKeys: () => AsyncStorage.getAllKeys(),
  multiRemove: (keys: readonly string[]) => AsyncStorage.multiRemove([...keys])
};

export const mobileSecureStorage = {
  isAvailable: () => SecureStore.isAvailableAsync(),
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY
  }),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key)
};

export const mobileComposerDrafts = new MobileComposerDraftStore(mobilePlainStorage);
export const mobilePartnerCreationReceipts = new MobilePartnerCreationReceipts(mobilePlainStorage);
export const mobilePartnerDeletionReceipts = new MobilePartnerDeletionReceipts(mobilePlainStorage);
export const mobilePartnerRestartReceipts = new MobilePartnerRestartReceipts(mobilePlainStorage);
export const mobileInteractionDrafts = new MobileInteractionDraftStore(mobilePlainStorage);
export const mobileNewTaskDrafts = new MobileNewTaskDraftStore(mobilePlainStorage);
export const mobileAttachmentFiles = new MobileAttachmentFiles();
export const mobileAttachmentCamera = new MobileAttachmentCamera(mobileAttachmentFiles);
export const mobilePhotoLibrary = new MobilePhotoLibrary(mobileAttachmentFiles);
export const mobileOfflineCache = new MobileOfflineCache(mobileHistoryDiskStorage, Date.now, randomUUID);
export const mobileReadOnlyDictionaryCache = new MobileVoiceDictionaryReadOnlyCache(mobilePlainStorage);
export const mobileThemePreferences = new MobileThemePreferenceStore(mobilePlainStorage);
export const mobileReplyQuotePreferences = new MobileReplyQuotePreferences(mobilePlainStorage);
export const mobileFilesPreferences = new MobileFilesPreferenceStore(mobilePlainStorage);
export const mobileDiagnostics = new MobileDiagnosticsStore(mobilePlainStorage, undefined, Date.now, randomUUID);
export const mobileLocalePreferences: MobileLocalePreferenceStore = new MobileLocalePreferenceStore(mobilePlainStorage);
export const mobileVoicePreferences = new MobileVoicePreferencesStore(mobilePlainStorage, Date.now, randomUUID);
const mobileUpdateRuntime = createMobileUpdateRuntimeEnvironment();
export const mobileUpdates = new MobileUpdateController({
  ...mobileUpdateRuntime,
  deviceStore: new MobileUpdateDeviceStore(mobilePlainStorage)
});
export const mobilePushDeviceStore = new MobilePushDeviceStore(mobilePlainStorage, mobileSecureStorage);

export const mobileStorage = createMobileStorage(
  mobilePlainStorage,
  mobileSecureStorage
);

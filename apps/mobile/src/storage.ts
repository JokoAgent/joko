import AsyncStorage from "@react-native-async-storage/async-storage";
import { randomUUID } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { createMobileStorage } from "./connection-storage";
import { MobileComposerDraftStore } from "./composer-draft-store";
import { MobileInteractionDraftStore } from "./interaction-draft-store";
import { MobileNewTaskDraftStore } from "./new-task-draft-store";
import { MobileAttachmentFiles } from "./mobile-attachment-files";
import { MobileAttachmentCamera } from "./mobile-attachment-camera";
import { MobilePhotoLibrary } from "./mobile-photo-library";
import { MobileOfflineCache } from "./mobile-offline-cache";
import { MobileThemePreferenceStore } from "./mobile-theme-preference";
import { MobileDiagnosticsStore } from "./mobile-diagnostics";
import { MobileLocalePreferenceStore } from "./mobile-locale-preference";
import { MobileVoiceDictionaryStore } from "./mobile-voice-dictionary-store";
import { MobileUpdateDeviceStore } from "./mobile-update-device-store";
import { MobileUpdateController } from "./mobile-update-controller";
import { createMobileUpdateRuntimeEnvironment } from "./mobile-update-runtime";
import { MobilePushDeviceStore } from "./mobile-push-device-store";

export const mobilePlainStorage = {
  getItem: (key: string) => AsyncStorage.getItem(key),
  setItem: (key: string, value: string) => AsyncStorage.setItem(key, value),
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
export const mobileInteractionDrafts = new MobileInteractionDraftStore(mobilePlainStorage);
export const mobileNewTaskDrafts = new MobileNewTaskDraftStore(mobilePlainStorage);
export const mobileAttachmentFiles = new MobileAttachmentFiles();
export const mobileAttachmentCamera = new MobileAttachmentCamera(mobileAttachmentFiles);
export const mobilePhotoLibrary = new MobilePhotoLibrary(mobileAttachmentFiles);
export const mobileOfflineCache = new MobileOfflineCache(mobilePlainStorage, Date.now, randomUUID);
export const mobileThemePreferences = new MobileThemePreferenceStore(mobilePlainStorage);
export const mobileDiagnostics = new MobileDiagnosticsStore(mobilePlainStorage, undefined, Date.now, randomUUID);
export const mobileLocalePreferences = new MobileLocalePreferenceStore(mobilePlainStorage);
export const mobileVoiceDictionary = new MobileVoiceDictionaryStore(mobilePlainStorage, Date.now, randomUUID);
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

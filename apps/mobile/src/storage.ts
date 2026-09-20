import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { createMobileStorage } from "./connection-storage";
import { MobileComposerDraftStore } from "./composer-draft-store";
import { MobileInteractionDraftStore } from "./interaction-draft-store";
import { MobileNewTaskDraftStore } from "./new-task-draft-store";
import { MobileAttachmentFiles } from "./mobile-attachment-files";

const plainStorage = {
  getItem: (key: string) => AsyncStorage.getItem(key),
  setItem: (key: string, value: string) => AsyncStorage.setItem(key, value),
  removeItem: (key: string) => AsyncStorage.removeItem(key)
};

export const mobileComposerDrafts = new MobileComposerDraftStore(plainStorage);
export const mobileInteractionDrafts = new MobileInteractionDraftStore(plainStorage);
export const mobileNewTaskDrafts = new MobileNewTaskDraftStore(plainStorage);
export const mobileAttachmentFiles = new MobileAttachmentFiles();

export const mobileStorage = createMobileStorage(
  plainStorage,
  {
    isAvailable: () => SecureStore.isAvailableAsync(),
    getItem: (key) => SecureStore.getItemAsync(key),
    setItem: (key, value) => SecureStore.setItemAsync(key, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY
    }),
    removeItem: (key) => SecureStore.deleteItemAsync(key)
  }
);

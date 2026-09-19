import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { createMobileStorage } from "./connection-storage";

export const mobileStorage = createMobileStorage(
  {
    getItem: (key) => AsyncStorage.getItem(key),
    setItem: (key, value) => AsyncStorage.setItem(key, value),
    removeItem: (key) => AsyncStorage.removeItem(key)
  },
  {
    isAvailable: () => SecureStore.isAvailableAsync(),
    getItem: (key) => SecureStore.getItemAsync(key),
    setItem: (key, value) => SecureStore.setItemAsync(key, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY
    }),
    removeItem: (key) => SecureStore.deleteItemAsync(key)
  }
);

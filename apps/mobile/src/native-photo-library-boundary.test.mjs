import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  enforceAndroidSystemPhotoPickerBoundary,
  enforceIosReadOnlyPhotoLibraryBoundary,
  microphoneUsage,
  photoLibraryUsage
} = require("../with-joko-photo-library-boundary.cjs");

describe("native photo-library config boundary", () => {
  it("removes Android legacy storage mode without changing the system-picker app identity", () => {
    const manifest = {
      manifest: {
        application: [{ $: {
          "android:name": ".MainApplication",
          "android:requestLegacyExternalStorage": "true"
        } }]
      }
    };

    expect(enforceAndroidSystemPhotoPickerBoundary(manifest)).toBe(manifest);
    expect(manifest.manifest.application[0].$).toEqual({ "android:name": ".MainApplication" });
  });

  it("keeps iOS photo access read-only and suppresses the automatic limited alert", () => {
    const infoPlist = {
      NSPhotoLibraryUsageDescription: "overwritten",
      NSPhotoLibraryAddUsageDescription: "unwanted save access",
      PHPhotoLibraryPreventAutomaticLimitedAccessAlert: false
    };

    expect(enforceIosReadOnlyPhotoLibraryBoundary(infoPlist)).toBe(infoPlist);
    expect(infoPlist).toEqual({
      NSMicrophoneUsageDescription: microphoneUsage,
      NSPhotoLibraryUsageDescription: photoLibraryUsage,
      PHPhotoLibraryPreventAutomaticLimitedAccessAlert: true
    });
  });

  it("registers the final boundary before Expo media mods and blocks every Android library permission", () => {
    const app = JSON.parse(readFileSync(new URL("../app.json", import.meta.url), "utf8")).expo;
    const boundaryIndex = app.plugins.indexOf("./with-joko-photo-library-boundary.cjs");
    const imagePickerIndex = app.plugins.findIndex((plugin) => Array.isArray(plugin) && plugin[0] === "expo-image-picker");
    const mediaLibraryIndex = app.plugins.findIndex((plugin) => Array.isArray(plugin) && plugin[0] === "expo-media-library");
    expect(boundaryIndex).toBeGreaterThanOrEqual(0);
    expect(boundaryIndex).toBeLessThan(imagePickerIndex);
    expect(boundaryIndex).toBeLessThan(mediaLibraryIndex);
    expect(app.plugins[mediaLibraryIndex][1]).toMatchObject({
      photosPermission: photoLibraryUsage,
      savePhotosPermission: false,
      isAccessMediaLocationEnabled: false,
      preventAutomaticLimitedAccessAlert: true,
      granularPermissions: []
    });
    expect(app.plugins[imagePickerIndex][1]).toMatchObject({
      photosPermission: false,
      microphonePermission: microphoneUsage
    });
    expect(new Set(app.android.blockedPermissions)).toEqual(new Set([
      "android.permission.ACCESS_MEDIA_LOCATION",
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.READ_MEDIA_AUDIO",
      "android.permission.READ_MEDIA_IMAGES",
      "android.permission.READ_MEDIA_VISUAL_USER_SELECTED",
      "android.permission.READ_MEDIA_VIDEO",
      "android.permission.WRITE_EXTERNAL_STORAGE"
    ]));
    expect(app.android.permissions).toEqual(expect.arrayContaining([
      "android.permission.MODIFY_AUDIO_SETTINGS",
      "android.permission.RECORD_AUDIO"
    ]));
    const audioIndex = app.plugins.findIndex((plugin) => Array.isArray(plugin) && plugin[0] === "expo-audio");
    expect(audioIndex).toBeGreaterThanOrEqual(0);
    expect(audioIndex).toBeLessThan(imagePickerIndex);
    expect(app.plugins[audioIndex][1]).toEqual({
      microphonePermission: microphoneUsage,
      recordAudioAndroid: true,
      enableBackgroundPlayback: false,
      enableBackgroundRecording: false
    });
  });
});

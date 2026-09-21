import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  enforceAndroidSystemPhotoPickerBoundary,
  enforceIosPhotoLibraryBoundary,
  microphoneUsage,
  photoLibrarySaveUsage,
  photoLibraryUsage
} = require("../with-joko-photo-library-boundary.cjs");

describe("native photo-library config boundary", () => {
  it("removes Android legacy storage mode and limits save permission to Android 9 and older", () => {
    const manifest = {
      manifest: {
        "uses-permission": [
          { $: { "android:name": "android.permission.INTERNET" } },
          { $: { "android:name": "android.permission.WRITE_EXTERNAL_STORAGE" } }
        ],
        application: [{ $: {
          "android:name": ".MainApplication",
          "android:requestLegacyExternalStorage": "true"
        } }]
      }
    };

    expect(enforceAndroidSystemPhotoPickerBoundary(manifest)).toBe(manifest);
    expect(manifest.manifest.application[0].$).toEqual({ "android:name": ".MainApplication" });
    expect(manifest.manifest["uses-permission"]).toEqual([
      { $: { "android:name": "android.permission.INTERNET" } },
      { $: {
        "android:name": "android.permission.WRITE_EXTERNAL_STORAGE",
        "android:maxSdkVersion": "28"
      } }
    ]);
  });

  it("keeps iOS browsing read-only while granting explicit add-only save access", () => {
    const infoPlist = {
      NSPhotoLibraryUsageDescription: "overwritten",
      NSPhotoLibraryAddUsageDescription: "unwanted save access",
      PHPhotoLibraryPreventAutomaticLimitedAccessAlert: false
    };

    expect(enforceIosPhotoLibraryBoundary(infoPlist)).toBe(infoPlist);
    expect(infoPlist).toEqual({
      NSMicrophoneUsageDescription: microphoneUsage,
      NSPhotoLibraryAddUsageDescription: photoLibrarySaveUsage,
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
      "android.permission.POST_NOTIFICATIONS",
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.READ_MEDIA_AUDIO",
      "android.permission.READ_MEDIA_IMAGES",
      "android.permission.READ_MEDIA_VISUAL_USER_SELECTED",
      "android.permission.READ_MEDIA_VIDEO"
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

  it("keeps Android photo output inside the app cache and verifies exact bytes before publishing", () => {
    const moduleConfig = JSON.parse(readFileSync(
      new URL("../modules/joko-image-output/expo-module.config.json", import.meta.url),
      "utf8"
    ));
    const manifest = readFileSync(
      new URL("../modules/joko-image-output/android/src/main/AndroidManifest.xml", import.meta.url),
      "utf8"
    );
    const source = readFileSync(
      new URL(
        "../modules/joko-image-output/android/src/main/java/app/joko/imageoutput/JokoImageOutputModule.kt",
        import.meta.url
      ),
      "utf8"
    );

    expect(moduleConfig).toEqual({
      platforms: ["android"],
      android: { modules: ["app.joko.imageoutput.JokoImageOutputModule"] }
    });
    expect(manifest).toContain('android.permission.WRITE_EXTERNAL_STORAGE');
    expect(manifest).toContain('android:maxSdkVersion="28"');
    expect(source).toContain('File(context.cacheDir, OUTPUT_DIRECTORY).canonicalFile');
    expect(source).toContain('Build.VERSION_CODES.Q');
    expect(source).toContain('MediaStore.MediaColumns.IS_PENDING');
    expect(source).toContain('sourceDigest.contentEquals(targetDigest)');
    expect(source).toContain('resolver.delete(target, null, null)');
  });
});

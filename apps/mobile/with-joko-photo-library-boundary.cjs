const { withAndroidManifest, withInfoPlist } = require("expo/config-plugins");

const photoLibraryUsage = "Allow Joko to show photos you explicitly choose for a task attachment.";

// Keep this plugin before the Expo media plugins in app.json. Expo composes normal
// mods inside-out, so the first registered boundary is the final manifest/plist pass.

function enforceAndroidSystemPhotoPickerBoundary(manifest) {
  const application = manifest.manifest.application?.[0];
  if (!application?.$) throw new Error("Joko photo-library policy could not find the Android application manifest.");
  delete application.$["android:requestLegacyExternalStorage"];
  return manifest;
}

function enforceIosReadOnlyPhotoLibraryBoundary(infoPlist) {
  infoPlist.NSPhotoLibraryUsageDescription = photoLibraryUsage;
  infoPlist.PHPhotoLibraryPreventAutomaticLimitedAccessAlert = true;
  delete infoPlist.NSPhotoLibraryAddUsageDescription;
  return infoPlist;
}

function withJokoPhotoLibraryBoundary(config) {
  config = withAndroidManifest(config, (modConfig) => {
    modConfig.modResults = enforceAndroidSystemPhotoPickerBoundary(modConfig.modResults);
    return modConfig;
  });
  return withInfoPlist(config, (modConfig) => {
    modConfig.modResults = enforceIosReadOnlyPhotoLibraryBoundary(modConfig.modResults);
    return modConfig;
  });
}

module.exports = withJokoPhotoLibraryBoundary;
module.exports.enforceAndroidSystemPhotoPickerBoundary = enforceAndroidSystemPhotoPickerBoundary;
module.exports.enforceIosReadOnlyPhotoLibraryBoundary = enforceIosReadOnlyPhotoLibraryBoundary;
module.exports.photoLibraryUsage = photoLibraryUsage;

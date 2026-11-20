const { AndroidConfig, withAndroidManifest } = require("expo/config-plugins");

module.exports = function withJokoAndroidPush(config) {
  return withAndroidManifest(config, mod => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
    // Request the native token explicitly after this phone opts in.
    AndroidConfig.Manifest.addMetaDataItemToMainApplication(application, "firebase_messaging_auto_init_enabled", "false");
    AndroidConfig.Manifest.addMetaDataItemToMainApplication(
      application, "com.google.firebase.messaging.default_notification_channel_id", "joko-task-attention");
    return mod;
  });
};

const { withInfoPlist } = require("expo/config-plugins");

// AVKit/WebKit system PiP needs the audio background mode. Voice recording
// and ordinary product audio keep their foreground-only runtime policies.
module.exports = (config) => withInfoPlist(config, (result) => {
  result.modResults.UIBackgroundModes = [
    ...new Set([...(result.modResults.UIBackgroundModes || []), "audio"])
  ];
  return result;
});

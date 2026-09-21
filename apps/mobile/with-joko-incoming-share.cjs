const fs = require("node:fs");
const path = require("node:path");
const { withDangerousMod } = require("expo/config-plugins");

const extensionTargetName = "expo-sharing-extension";

module.exports = function withJokoIncomingShare(config) {
  return withDangerousMod(config, ["ios", async (next) => {
    const projectRoot = next.modRequest.projectRoot;
    const platformProjectRoot = next.modRequest.platformProjectRoot;
    const source = path.join(projectRoot, "native", "ios", "ShareIntoViewController.swift");
    const destination = path.join(platformProjectRoot, extensionTargetName, "ShareIntoViewController.swift");
    if (!fs.existsSync(source)) {
      throw new Error(`Missing Joko incoming-share extension source: ${source}`);
    }
    if (!fs.existsSync(path.dirname(destination))) {
      throw new Error("expo-sharing must generate the iOS share extension before the Joko boundary is applied.");
    }
    fs.copyFileSync(source, destination);
    return next;
  }]);
};

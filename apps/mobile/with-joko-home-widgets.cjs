const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { withXcodeProject, withEntitlementsPlist, withInfoPlist } = require("expo/config-plugins");

const expoRequire = createRequire(require.resolve("expo/package.json"));
const configRequire = createRequire(expoRequire.resolve("@expo/config-plugins/package.json"));
const plistModule = configRequire("@expo/plist");
const plist = plistModule.default ?? plistModule;
const targetName = "JokoHomeWidgets";
const appGroups = "com.apple.security.application-groups";
const sourceFiles = ["JokoHomeWidgets.swift", "JokoHomeSurfaceProjection.swift"];

function withJokoHomeWidgets(config) {
  const bundle = config.ios?.bundleIdentifier;
  if (!bundle) throw new Error("Home widgets require the Joko iOS bundle identity.");
  const group = `group.${bundle}.widgets`;
  const extensionBundle = `${bundle}.home-widgets`;
  const experimental = config.extra?.eas?.build?.experimental ?? {};
  config.extra = { ...config.extra, eas: { ...config.extra?.eas, build: { ...config.extra?.eas?.build,
    experimental: { ...experimental, ios: { ...experimental.ios, appExtensions: [
      ...(experimental.ios?.appExtensions ?? []).filter(extension => extension.targetName !== targetName),
      { targetName, bundleIdentifier: extensionBundle, entitlements: { [appGroups]: [group] } }
    ] } }
  } } };
  config = withInfoPlist(config, next => {
    next.modResults.NSSupportsLiveActivities = true;
    next.modResults.JokoHomeSurfaceGroup = group;
    return next;
  });
  config = withEntitlementsPlist(config, next => {
    next.modResults[appGroups] = [...new Set([...(next.modResults[appGroups] ?? []), group])];
    return next;
  });
  return withXcodeProject(config, next => {
    const { projectRoot, platformProjectRoot } = next.modRequest;
    const destination = path.join(platformProjectRoot, targetName);
    fs.mkdirSync(destination, { recursive: true });
    fs.copyFileSync(path.join(projectRoot, "native", "ios", sourceFiles[0]), path.join(destination, sourceFiles[0]));
    fs.copyFileSync(path.join(projectRoot, "modules", "joko-home-surfaces", "ios", sourceFiles[1]), path.join(destination, sourceFiles[1]));
    fs.writeFileSync(path.join(destination, "Info.plist"), plist.build({
      CFBundleDisplayName: "Joko",
      CFBundleName: "$(PRODUCT_NAME)",
      CFBundleIdentifier: "$(PRODUCT_BUNDLE_IDENTIFIER)",
      CFBundleExecutable: "$(EXECUTABLE_NAME)",
      CFBundlePackageType: "XPC!",
      CFBundleShortVersionString: "$(MARKETING_VERSION)",
      CFBundleVersion: "$(CURRENT_PROJECT_VERSION)",
      JokoHomeSurfaceGroup: group,
      NSExtension: { NSExtensionPointIdentifier: "com.apple.widgetkit-extension" }
    }));
    fs.writeFileSync(path.join(destination, "HomeWidgets.entitlements"), plist.build({ [appGroups]: [group] }));
    const project = next.modResults;
    let native = Object.entries(project.pbxNativeTargetSection()).find(([key, target]) =>
      !key.endsWith("_comment") && target.name?.replaceAll('"', "") === targetName);
    const paths = sourceFiles.map(file => `${targetName}/${file}`);
    if (native === undefined) {
      const added = project.addTarget(targetName, "app_extension", targetName, extensionBundle);
      native = [added.uuid, added.pbxNativeTarget];
      project.addBuildPhase(paths, "PBXSourcesBuildPhase", "Sources", added.uuid);
      project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", added.uuid);
      project.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", added.uuid);
    } else {
      for (const file of paths) {
        if (!project.hasFile(file)) project.addSourceFile(file, { target: native[0] });
      }
    }
    const settings = project.pbxXCBuildConfigurationSection();
    for (const { value } of project.pbxXCConfigurationList()[native[1].buildConfigurationList].buildConfigurations) {
      Object.assign(settings[value].buildSettings, {
        PRODUCT_BUNDLE_IDENTIFIER: `"${extensionBundle}"`,
        INFOPLIST_FILE: `"${targetName}/Info.plist"`,
        CODE_SIGN_ENTITLEMENTS: `"${targetName}/HomeWidgets.entitlements"`,
        SWIFT_VERSION: "5.0",
        IPHONEOS_DEPLOYMENT_TARGET: "17.0",
        TARGETED_DEVICE_FAMILY: '"1,2"',
        APPLICATION_EXTENSION_API_ONLY: "YES",
        SKIP_INSTALL: "YES",
        GENERATE_INFOPLIST_FILE: "NO",
        CURRENT_PROJECT_VERSION: `"${next.ios?.buildNumber ?? "1"}"`,
        MARKETING_VERSION: `"${next.version ?? "1.0"}"`
      });
    }
    return next;
  });
}

module.exports = withJokoHomeWidgets;

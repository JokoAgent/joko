import { ExtensionPackageAction, type ExtensionPackagePreview } from "@joko/contracts";
import type { MobileExtension } from "./mobile-extensions";

export interface MobileExtensionPackagePreview {
  readonly extensionId: string;
  readonly extensionRevision: bigint;
  readonly backendId: string;
  readonly resourceId: string;
  readonly action: "install" | "update" | "replace";
  readonly packageName: string;
  readonly installedVersion?: string;
  readonly availableVersion?: string;
  readonly currentResource?: { readonly resourceId: string; readonly revision: bigint; readonly name: string; readonly source: string };
  readonly sourceReplacement: boolean;
  readonly preservesEnabled: boolean;
  readonly canToggle: boolean;
  readonly content: readonly string[];
  readonly disabledLifecycleScripts: readonly string[];
}

const text = (value: string, maximum = 512): string => {
  if (!value.trim() || value.length > maximum || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw new Error("The Extension package preview contains invalid text.");
  }
  return value;
};

export function projectMobileExtensionPackagePreview(value: ExtensionPackagePreview,
  expected: MobileExtension, backendId: string): MobileExtensionPackagePreview {
  const action = value.action === ExtensionPackageAction.INSTALL ? "install"
    : value.action === ExtensionPackageAction.UPDATE ? "update"
      : value.action === ExtensionPackageAction.REPLACE ? "replace" : undefined;
  const current = value.currentResource;
  if (!action || value.extensionId !== expected.extensionId || value.extensionRevision?.value !== expected.revision
    || value.backendId !== backendId || value.sourceReplacement !== (action === "replace")
    || (action === "install" ? expected.installed || current !== undefined : !expected.installed || current === undefined)
    || current && (expected.owner.kind !== "resource" || current.resourceId !== expected.owner.resourceId
      || current.resourceRevision?.value !== expected.owner.resourceRevision)
    || action === "update" && value.resourceId !== current?.resourceId
    || action === "replace" && value.resourceId === current?.resourceId
    || value.compatibilityDetails.length > 256 || value.runtimeRequirements.length > 64
    || value.warnings.length > 64 || value.disabledLifecycleScripts.length > 128) {
    throw new Error("The Extension package preview no longer matches this installation.");
  }
  return {
    extensionId: value.extensionId, extensionRevision: expected.revision, backendId: text(backendId, 256),
    resourceId: text(value.resourceId, 256), action, packageName: text(value.packageName),
    ...(value.installedVersion === undefined ? {} : { installedVersion: text(value.installedVersion, 160) }),
    ...(value.availableVersion === undefined ? {} : { availableVersion: text(value.availableVersion, 160) }),
    ...(current ? { currentResource: { resourceId: current.resourceId, revision: current.resourceRevision!.value,
      name: text(current.name), source: text(current.sourceDisplay, 2_048) } } : {}),
    sourceReplacement: value.sourceReplacement, preservesEnabled: value.preservesEnabled, canToggle: value.canToggle,
    content: [...value.compatibilityDetails.map(item => text(item.name)),
      ...value.runtimeRequirements.map(item => `${text(item.packageName)} ${text(item.range, 160)}`)],
    disabledLifecycleScripts: value.disabledLifecycleScripts.map(item => text(item, 256))
  };
}

export function assertMobileExtensionPackagePreview(expected: MobileExtension,
  preview: MobileExtensionPackagePreview): void {
  if (preview.extensionId !== expected.extensionId || preview.extensionRevision !== expected.revision
    || (preview.action === "install" ? expected.installed || preview.currentResource !== undefined
      : !expected.installed || expected.owner.kind !== "resource" || !preview.currentResource
        || preview.currentResource.resourceId !== expected.owner.resourceId
        || preview.currentResource.revision !== expected.owner.resourceRevision)
    || preview.sourceReplacement !== (preview.action === "replace")) {
    throw new Error("Refresh the Extension package preview before changing this installation.");
  }
}

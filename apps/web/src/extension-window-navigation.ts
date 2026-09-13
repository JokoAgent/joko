import { appRouteHash } from "./controller.js";

export function validExtensionWindowId(value: unknown): value is string {
  return typeof value === "string" && /^extension_[a-f0-9]{32}$/u.test(value);
}

export function extensionMainViewLink(locationValue: Pick<Location, "href">, extensionId: string): string {
  if (!validExtensionWindowId(extensionId)) throw new TypeError("Extension identity is invalid.");
  const url = new URL(locationValue.href);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = appRouteHash({ kind: "extensionMainView", extensionId });
  return url.href;
}

export function isExtensionApplicationWindow(locationValue: Pick<Location, "search">): boolean {
  const query = new URLSearchParams(locationValue.search);
  return [...query.keys()].sort().join(",") === "bootExtension,extensionWindow"
    && query.get("extensionWindow") === "1"
    && validExtensionWindowId(query.get("bootExtension"));
}

export function openExtensionWindowFallback(locationValue: Pick<Location, "href">, extensionId: string): Window | null {
  return window.open(extensionMainViewLink(locationValue, extensionId), "_blank", "noopener,noreferrer");
}

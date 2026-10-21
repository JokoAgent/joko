import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const group = "239.255.74.75";
const networkInterface = "lo0";
const mode = process.argv[2];
if (process.platform !== "darwin" || !process.env.RUNNER_TEMP || !["configure", "cleanup"].includes(mode)) {
  throw new Error("Use this helper only for an owned macOS CI runner and an explicit configure or cleanup action.");
}
const file = join(process.env.RUNNER_TEMP, "joko-ci-logs", "macos-multicast-route.json");
const save = receipt => writeFileSync(file, JSON.stringify(receipt, null, 2) + "\n");
function command(binary, args) {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024, windowsHide: true });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error("The bounded macOS multicast route command did not complete successfully.");
  }
  return result.stdout;
}
function currentRoute() {
  const output = command("/sbin/route", ["-n", "get", group]);
  const field = key => new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "mu").exec(output)?.[1];
  const route = { destination: field("destination"), interface: field("interface"), flags: field("flags") };
  if (!route.destination || !route.interface || !route.flags) throw new Error("The macOS route observation was incomplete.");
  return route;
}
if (mode === "configure") {
  if (existsSync(file)) throw new Error("This runner already has a multicast route ownership receipt.");
  const receipt = { group, interface: networkInterface, createdByJob: false, passed: false, before: currentRoute() };
  save(receipt);
  try {
    if (receipt.before.interface !== networkInterface) {
      if (receipt.before.destination === group) throw new Error("An existing host route belongs to another network owner.");
      command("/usr/bin/sudo", ["/sbin/route", "-n", "add", "-host", group, "-interface", networkInterface]);
      receipt.createdByJob = true;
      save(receipt);
    }
    receipt.after = currentRoute();
    if (receipt.after.interface !== networkInterface || receipt.createdByJob && receipt.after.destination !== group) {
      throw new Error("The service multicast group did not resolve to the owned loopback route.");
    }
    receipt.passed = true;
  } finally { save(receipt); }
} else if (existsSync(file)) {
  const receipt = JSON.parse(readFileSync(file, "utf8"));
  if (receipt.group !== group || receipt.interface !== networkInterface || typeof receipt.createdByJob !== "boolean") {
    throw new Error("The multicast cleanup receipt does not identify this runner's exact route.");
  }
  if (receipt.createdByJob) {
    const current = currentRoute();
    if (current.destination !== group || current.interface !== networkInterface) {
      throw new Error("The multicast route changed ownership before cleanup.");
    }
    command("/usr/bin/sudo", ["/sbin/route", "-n", "delete", "-host", group, "-interface", networkInterface]);
    receipt.cleanup = { removedOwnedRoute: true, after: currentRoute() };
  } else receipt.cleanup = { removedOwnedRoute: false };
  save(receipt);
}

import { describe, expect, it } from "vitest";
import { messageKeys, translate } from "./i18n.js";

describe("translate", () => {
  it("serves English and Simplified Chinese from the same typed catalog", () => {
    expect(translate("en", "nav.newTask")).toBe("New task");
    expect(translate("zh-CN", "nav.newTask")).toBe("新任务");
    expect(translate("en", "browser.remoteCanvas")).toContain("remote browser screenshot");
    expect(translate("zh-CN", "browser.remoteCanvas")).toContain("远程浏览器截图");
    expect(translate("en", "workspace.insertTable")).toBe("Insert table");
    expect(translate("zh-CN", "workspace.tableDeleteTable")).toBe("删除表格");
    expect(translate("en", "workspace.mermaidEditTitle")).toBe("Edit Mermaid source");
    expect(translate("zh-CN", "workspace.mermaidCopy")).toBe("复制图表");
    expect(translate("en", "workspace.rename")).toBe("Rename");
    expect(translate("zh-CN", "workspace.rename")).toBe("重命名");
  });

  it("keeps every shared Backend surface neutral while retaining Pi-owned feature names", () => {
    const sharedKeys = [
      "session.deleteWarning",
      "session.deleteNative",
      "session.deleteNativeBody",
      "permission.fullHelp",
      "error.dispatchUnknown",
      "a11y.extensionWidgets",
      "session.branchHelp",
      "session.branchLoad",
      "session.newDescription",
      "session.startMode",
      "projects.deleteSessionsBody",
      "scheduler.inputPlaceholder",
      "settings.processUsage.empty"
    ] as const;
    for (const locale of ["en", "zh-CN"] as const) {
      for (const key of sharedKeys) expect(translate(locale, key)).not.toContain("Pi");
    }

    const piOwnedKeys = [
      "tools.resources",
      "settings.pi",
      "tools.subtitle",
      "tools.removeBody",
      "tools.noResources",
      "tools.noDiscoveredResources",
      "settings.compaction.description",
      "settings.piBody",
      "settings.piDefaults",
      "settings.autoCompactionBody",
      "settings.autoRetryBody",
      "settings.addResource",
      "settings.resourceBackendUnavailable",
      "resource.noCompatibleContents"
    ] as const;
    for (const locale of ["en", "zh-CN"] as const) {
      for (const key of piOwnedKeys) expect(translate(locale, key)).toContain("Pi");
    }

    expect(translate("zh-CN", "permission.fullHelp"))
      .toBe("这不是 OS 沙箱。所选后端可使用服务账户读取凭证或修改已授权的额外目录。");
    expect(translate("zh-CN", "settings.resourceBackendUnavailable"))
      .toBe("当前没有 Backend 支持受管 Pi 资源，因此暂时不能添加资源。");
    expect(translate("zh-CN", "settings.toolPolicies.empty"))
      .toBe("此 Joko 节点没有可配置的内置工具供应商。");
    expect(translate("en", "settings.pi")).toBe("Pi resources");
  });

  it("keeps the architecture-facing service name out of every localized UI message", () => {
    for (const locale of ["en", "zh-CN"] as const) {
      for (const key of messageKeys) expect(translate(locale, key)).not.toMatch(/\bOrchestrator\b/u);
    }
    expect(translate("en-XA", "settings.connectionsBody")).not.toContain("Örchëstràtõr");
  });

  it("pseudo-localizes copy without corrupting interpolation placeholders", () => {
    const result = translate("en-XA", "tools.providerCount", { count: 42 });
    expect(result).toMatch(/^［/u);
    expect(result).toMatch(/］$/u);
    expect(result).toContain("42");
    expect(result).not.toContain("{count}");
    expect(result).toContain("õ");
    expect(translate("en-XA", "workspace.tableAddColumnRight")).toMatch(/^［.*··］$/u);
    expect(translate("en-XA", "workspace.mermaidTargetMissing")).toMatch(/^［.*··］$/u);
  });

  it("localizes the beta-channel card and both restart confirmations", () => {
    expect(translate("en", "settings.experimental")).toBe("Experimental");
    expect(translate("en", "settings.betaChannel.restartTitle")).toBe("Restart Joko");
    expect(translate("en", "settings.betaChannel.restartNow")).toBe("Restart now");
    expect(translate("en", "settings.betaChannel.restartLater")).toBe("Later");
    expect(translate("en", "settings.betaChannel.unavailable"))
      .toBe("The beta channel is unavailable — could not reach the beta update server.");
    expect(translate("en", "settings.betaChannel.disabled"))
      .toBe("Beta channel disabled; takes effect after restart");
    expect(translate("zh-CN", "settings.experimental")).toBe("实验功能");
    expect(translate("zh-CN", "settings.betaChannel.restartTitle")).toBe("重启 Joko");
    expect(translate("zh-CN", "settings.betaChannel.restartBusyDescription"))
      .toContain("重启会打断它们");
    expect(translate("en-XA", "settings.betaChannel.restartDescription"))
      .toMatch(/^［.*··］$/u);
  });

  it("localizes startup-update telemetry labels without changing the reported byte values", () => {
    expect(translate("en", "desktop.startupUpdateSpeedAria", { speed: "512.0 KB/s" }))
      .toBe("Download speed 512.0 KB/s");
    expect(translate("zh-CN", "desktop.startupUpdateSpeedAria", { speed: "512.0 KB/s" }))
      .toBe("下载速度 512.0 KB/s");
    expect(translate("en", "desktop.startupUpdateTransferredAria", {
      transferred: "1.0 MB",
      total: "4.0 MB"
    })).toBe("1.0 MB of 4.0 MB downloaded");
    expect(translate("zh-CN", "desktop.startupUpdateTransferredAria", {
      transferred: "1.0 MB",
      total: "4.0 MB"
    })).toBe("已下载 1.0 MB，共 4.0 MB");
  });
});

export function taskActivityMessages(locale: string) {
  return locale === "zh-CN" ? {
    label: (name: string, count: number) => count === 1 ? `${name} 正在查看此节点的任务` : `${count} 台设备正在查看此节点的任务`,
    manage: "管理设备", revoke: "撤销访问", cancel: "取消", collapse: "收起活动设备提示", expand: "展开活动设备提示",
    title: "撤销设备访问？", body: (name: string) => `撤销 ${name} 对此节点的访问并断开其连接。重新访问需要再次配对。`,
    failed: "无法确认设备访问已撤销。请在设备管理中核对后重试。"
  } : {
    label: (name: string, count: number) => count === 1 ? `${name} is viewing tasks on this node` : `${count} devices are viewing tasks on this node`,
    manage: "Manage devices", revoke: "Revoke access", cancel: "Cancel", collapse: "Collapse active device notice", expand: "Expand active device notice",
    title: "Revoke device access?", body: (name: string) => `Revoke ${name}'s access to this node and disconnect its connections. It will need to pair again to reconnect.`,
    failed: "Device revocation could not be confirmed. Check device management before retrying."
  };
}

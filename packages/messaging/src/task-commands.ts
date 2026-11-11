export function isMessagingStopCommand(text: string): boolean {
  const command = text.trim().toLowerCase();
  return command === "!stop" || command === "！stop" || command === "/stop";
}

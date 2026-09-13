export function formatCommand(executable: string, arguments_: readonly string[]): string {
  return [executable, ...arguments_].map((value) => JSON.stringify(value)).join(" ");
}

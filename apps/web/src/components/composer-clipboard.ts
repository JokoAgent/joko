/**
 * Return the file payload carried by a clipboard event without ever reading an
 * operating-system path. Clipboard `items` are preferred because screenshots
 * and images copied from a web page are not consistently exposed through the
 * platform `files` list. Directory entries are deliberately ignored: directory
 * authority must continue to come from Orchestrator's approved extra-directory
 * records, never from renderer clipboard metadata.
 */
export function clipboardAttachmentFiles(source: Pick<DataTransfer, "files" | "items">): readonly File[] {
  const itemFiles: File[] = [];
  const directorySignatures = new Set<string>();
  for (const item of Array.from(source.items)) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file === null) continue;
    if (clipboardItemIsDirectory(item)) {
      directorySignatures.add(fileSignature(file));
      continue;
    }
    itemFiles.push(file);
  }
  return itemFiles.length > 0
    ? itemFiles
    : Array.from(source.files).filter((file) => !directorySignatures.has(fileSignature(file)));
}

function clipboardItemIsDirectory(item: DataTransferItem): boolean {
  try {
    return item.webkitGetAsEntry?.()?.isDirectory === true;
  } catch {
    return false;
  }
}

function fileSignature(file: File): string {
  return `${file.name}\u0000${file.size}\u0000${file.type}\u0000${file.lastModified}`;
}

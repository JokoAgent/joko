/** Produces a small local copy from an already verified, authorized Partner image. */
export async function nativeTaskStatusAvatar(dataUrl: string): Promise<string> {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+=*)$/u.exec(dataUrl);
  if (!match || dataUrl.length > 7_000_000) throw new Error("Invalid task avatar.");
  const decoded = atob(match[2]!);
  const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: match[1] }));
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40_000_000) throw new Error("Invalid task avatar dimensions.");
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 48;
    const context = canvas.getContext("2d"); if (!context) throw new Error("Task avatar preparation unavailable.");
    const edge = Math.min(bitmap.width, bitmap.height);
    context.drawImage(bitmap, (bitmap.width - edge) / 2, (bitmap.height - edge) / 2, edge, edge, 0, 0, 48, 48);
    const result = canvas.toDataURL("image/png");
    if (result.length > 80_000) throw new Error("Task avatar exceeds its bound.");
    return result;
  } finally { bitmap.close(); }
}

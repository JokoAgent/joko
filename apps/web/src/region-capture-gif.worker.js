import { GIFEncoder, applyPalette, quantize } from "gifenc";

let encoder;
let width;
let height;
let frames = 0;
const maximumBytes = 36 * 1024 * 1024;

self.onmessage = ({ data }) => {
  try {
    if (data.type === "start") {
      width = data.width;
      height = data.height;
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 960 * 960) throw new Error();
      encoder = GIFEncoder();
      return;
    }
    if (encoder === undefined) throw new Error();
    if (data.type === "frame") {
      if (!(data.pixels instanceof ArrayBuffer) || data.pixels.byteLength !== width * height * 4) throw new Error();
      const rgba = new Uint8Array(data.pixels);
      const palette = quantize(rgba, 256, { format: "rgb444" });
      const colors = applyPalette(rgba, palette, "rgb444");
      encoder.writeFrame(colors, width, height, { palette, delay: Math.max(100, Math.min(500, data.delay)), repeat: 0 });
      frames++;
      self.postMessage({ type: "frame", nearLimit: encoder.bytesView().byteLength > maximumBytes - width * height * 2 });
      return;
    }
    if (data.type === "finish" && frames > 0) {
      encoder.finish();
      const bytes = encoder.bytes();
      if (bytes.length > maximumBytes) throw new Error();
      self.postMessage({ type: "done", buffer: bytes.buffer }, [bytes.buffer]);
      return;
    }
    throw new Error();
  } catch {
    self.postMessage({ type: "error" });
  }
};

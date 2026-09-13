import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

import { modelViewerAssetsPlugin } from "./model-viewer-assets.js";
import { pdfJsAssetsPlugin } from "./pdfjs-assets.js";

export default defineConfig({
  base: "./",
  plugins: [react(), pdfJsAssetsPlugin(), modelViewerAssetsPlugin()],
  server: {
    strictPort: true
  },
  build: {
    target: "es2022",
    sourcemap: true,
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/packages/contracts/") || id.includes("\\packages\\contracts\\")) return "contracts";
          if (id.includes("/react-dom/") || id.includes("/react/") || id.includes("/scheduler/")) return "react-runtime";
          if (id.includes("/lucide-react/")) return "icons";
          if (id.includes("react-markdown") || id.includes("remark-gfm") || id.includes("/unified/") || id.includes("/micromark") || id.includes("/mdast-") || id.includes("/hast-")) return "markdown";
          if (id.includes("@connectrpc") || id.includes("@bufbuild")) return "connect";
          if (id.includes("@tanstack/react-virtual") || id.includes("@tanstack/virtual-core")) return "virtualization";
          return undefined;
        }
      }
    }
  }
});

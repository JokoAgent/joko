import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

import { modelViewerAssetsPlugin } from "./model-viewer-assets.js";
import { pdfJsAssetsPlugin } from "./pdfjs-assets.js";
import { visualExtensionSurfacePlugin } from "./src/dev/visual-extension-surface-plugin.js";
import { linkspanAssetsPlugin } from './linkspan-assets.js';

export default defineConfig({
  base: "./",
  plugins: [react(), pdfJsAssetsPlugin(), modelViewerAssetsPlugin(), linkspanAssetsPlugin(), visualExtensionSurfacePlugin()],
  server: {
    strictPort: true
  },
  worker: { format: "es" },
  build: {
    target: "es2022",
    manifest: true,
    assetsInlineLimit(filePath) { return filePath.endsWith('.wasm') ? false : undefined; },
    sourcemap: true,
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const path = id.replace(/\\/gu, '/');
          if (path.includes('commonjsHelpers.js') || path.includes('vite/preload-helper.js')) return 'common-runtime';
          if (['core', 'noise', 'http'].some(name => path.includes(`@jokoagent/linkspan-${name}/`))) return 'linkspan-security';
          if (path.includes('@jokoagent/linkspan-iroh-wasm/')) return 'linkspan-iroh-wasm';
          if (path.includes('@jokoagent/linkspan-tailcat-wasm/')) return 'linkspan-tailcat-wasm';
          if (path.includes('@jokoagent/linkspan-iroh/')) return 'linkspan-iroh';
          if (path.includes('@jokoagent/linkspan-tailcat/')) return 'linkspan-tailcat';
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

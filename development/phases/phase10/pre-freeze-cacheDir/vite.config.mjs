import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import signals from "../../../../packages/unplugin-react-fine-grained-signals/dist/vite.js";

const at = (path) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: at("./app/"),
  // Deliberately outside node_modules to exercise Vite's supported custom cacheDir.
  cacheDir: at("./.vite-cache/"),
  plugins: [signals({ mode: "all", transform: "managed" })],
  esbuild: { jsx: "automatic", jsxImportSource: "react-fine-grained-signals" },
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      { find: /^react-fine-grained-signals\/runtime$/, replacement: at("../../../../src/runtime.ts") },
      { find: /^react-fine-grained-signals\/jsx-runtime$/, replacement: at("../../../../src/jsx-runtime.ts") },
      { find: /^react-fine-grained-signals\/jsx-dev-runtime$/, replacement: at("../../../../src/jsx-dev-runtime.ts") },
      { find: /^react-fine-grained-signals$/, replacement: at("../../../../src/index.ts") },
    ],
  },
  optimizeDeps: { include: ["react", "react-dom/client", "alien-signals/system"] },
  server: { host: "127.0.0.1", port: 4189, strictPort: true },
});

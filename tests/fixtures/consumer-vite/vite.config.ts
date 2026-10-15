import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import signals from "unplugin-react-fine-grained-signals/vite";

export default defineConfig({
  plugins: [
    signals({ mode: "auto", transform: "managed" }),
    react({ compiler: true, jsxImportSource: "react-fine-grained-signals" }),
  ],
  build: {
    lib: {
      entry: "src/main.tsx",
      formats: ["es"],
      fileName: "consumer",
    },
    minify: false,
    rollupOptions: {
      external: (id) =>
        id === "react" ||
        id.startsWith("react/") ||
        id === "react-fine-grained-signals" ||
        id.startsWith("react-fine-grained-signals/"),
    },
  },
});

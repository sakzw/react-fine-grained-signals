import { defineConfig } from "vite";
import signals from "unplugin-react-alien-signals/vite";

export default defineConfig({
  plugins: [signals({ mode: "auto" })],
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
        id === "react-alien-signals" ||
        id.startsWith("react-alien-signals/"),
    },
  },
});

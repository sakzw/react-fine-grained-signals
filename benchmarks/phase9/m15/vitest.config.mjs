import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      { find: /^react$/, replacement: new URL("../../../node_modules/react/index.js", import.meta.url).pathname },
      { find: /^react-dom$/, replacement: new URL("../../../node_modules/react-dom/index.js", import.meta.url).pathname },
    ],
  },
  test: {
    include: ["benchmarks/phase9/m15/**/*.test.{jsx,ts,tsx}"],
    environment: "jsdom",
  },
});

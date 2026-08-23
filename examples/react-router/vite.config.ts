import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
// Built artifact, not the plugin's TS source: vite.config.ts is loaded by Vite's
// own config bundler, not the dev-server module graph, so the source-aliasing
// trick below doesn't apply here. Run `pnpm build:transform` first.
import signals from "../../packages/unplugin-react-alien-signals/dist/vite.js";

const exampleRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(exampleRoot, "../..");
const source = (path: string) => resolve(repositoryRoot, path);

export default defineConfig({
  plugins: [
    // "managed" gives an exact try/finally render boundary, which matters more
    // here than in the examples/browser PoC: this app goes through real
    // streaming SSR (renderToPipeableStream) instead of a single synchronous
    // renderToString call.
    signals({ mode: "auto", transform: "managed" }),
    reactRouter(),
  ],
  resolve: {
    dedupe: ["alien-signals", "react", "react-dom"],
    alias: [
      {
        find: /^react-alien-signals\/utils$/,
        replacement: source("src/utils.tsx"),
      },
      {
        find: /^react-alien-signals\/runtime$/,
        replacement: source("src/runtime.ts"),
      },
      {
        find: /^react-alien-signals\/jsx-runtime$/,
        replacement: source("src/jsx-runtime.ts"),
      },
      {
        find: /^react-alien-signals\/jsx-dev-runtime$/,
        replacement: source("src/jsx-dev-runtime.ts"),
      },
      {
        find: /^react-alien-signals$/,
        replacement: source("src/index.ts"),
      },
    ],
  },
});

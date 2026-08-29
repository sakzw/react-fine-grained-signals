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
    // "managed" is the plugin's own default (examples/browser gets the same
    // thing through this same unset `transform` option) -- spelled out here
    // not because this app configures anything differently, but because an
    // exact try/finally boundary matters most exactly where an inexact one
    // would be hardest to notice: this app's SSR streams via
    // renderToPipeableStream, where a component can suspend and resume
    // mid-render, unlike examples/browser's single synchronous
    // renderToString call.
    //
    // ActivityRow.tsx is excluded: it opts into the manual
    // react-alien-signals/runtime boundary directly (see that file) instead
    // of the plugin-managed one, so the plugin must not also wrap it.
    signals({
      mode: "auto",
      transform: "managed",
      exclude: (id) => id.includes("/components/ActivityRow.tsx"),
    }),
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

import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
// @ts-expect-error -- prebuilt JS output, no local type project reference.
import signals from "../../packages/unplugin-react-alien-signals/dist/vite.js";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Client-only production build for the browser example app. This is
// deliberately a reduced scope compared to server.mjs's dev-mode SSR
// pipeline: it exercises the real `vite build` bundler/minifier against the
// same JSX/alias/unplugin config, then `vite preview` serves the static
// output. It intentionally does not attempt full SSR production parity —
// see examples/browser/src/entry-production.tsx.
//
// The entry HTML lives in ./production/index.html (a nested Vite multi-page
// entry, referencing ../src/entry-production.tsx by relative path) rather
// than sitting next to the dev-mode examples/browser/index.html. This keeps
// the build's default `root`-relative index.html at the conventional name
// so `vite preview`'s static file server resolves `/` correctly — an
// output file named e.g. index.production.html would 404 on `/`.
export default defineConfig({
  root: here("./production"),
  base: "/",
  oxc: false,
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react-alien-signals",
  },
  plugins: [signals({ mode: "auto" })],
  resolve: {
    dedupe: ["alien-signals", "react", "react-dom"],
    alias: [
      {
        find: /^react-alien-signals\/runtime$/,
        replacement: here("../../src/runtime.ts"),
      },
      {
        find: /^react-alien-signals\/jsx-runtime$/,
        replacement: here("../../src/jsx-runtime.ts"),
      },
      {
        find: /^react-alien-signals\/jsx-dev-runtime$/,
        replacement: here("../../src/jsx-dev-runtime.ts"),
      },
      {
        find: /^react-alien-signals$/,
        replacement: here("../../src/index.ts"),
      },
    ],
  },
  build: {
    // Absolute so it stays examples/browser/dist regardless of `root`.
    outDir: here("./dist"),
    emptyOutDir: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 4174,
    strictPort: true,
  },
});

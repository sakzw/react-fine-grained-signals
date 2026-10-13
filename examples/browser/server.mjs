import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToString } from "react-dom/server";
import { createServer as createViteServer } from "vite";
import signals from "../../packages/unplugin-react-fine-grained-signals/dist/vite.js";

const browserRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(browserRoot, "../..");
const host = "127.0.0.1";
const port = 4173;

const source = (path) => resolve(repositoryRoot, path);
const reactSsrBridgeId = "\0react-ssr-cjs-bridge";
// Keep React's CommonJS entry in Node's native loader. Vite's SSR runner can
// otherwise evaluate that file as ESM when optional peer dependencies vary.
const reactSsrBridge = {
  name: "react-ssr-cjs-bridge",
  enforce: "pre",
  resolveId(id, _importer, options) {
    return id === "react" && options?.ssr ? reactSsrBridgeId : null;
  },
  load(id) {
    if (id !== reactSsrBridgeId) return null;
    const exports = [
      "Activity",
      "Component",
      "StrictMode",
      "Suspense",
      "memo",
      "startTransition",
      "useEffect",
      "useLayoutEffect",
      "useRef",
      "useState",
    ];
    return [
      'import { createRequire } from "node:module";',
      `const React = createRequire(${JSON.stringify(resolve(browserRoot, "server.mjs"))})("react");`,
      "export default React;",
      ...exports.map((name) => `export const ${name} = React.${name};`),
      "",
    ].join("\n");
  },
};
const vite = await createViteServer({
  // Keep dependency discovery within this browser fixture. Using the monorepo
  // root crawls generated HTML from other projects and can stall the SSR
  // module runner before this server begins listening.
  root: browserRoot,
  appType: "custom",
  // Reserve a module-runner channel separate from other Vite apps on this host.
  server: { middlewareMode: true, hmr: { port: 24679 } },
  oxc: false,
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react-fine-grained-signals",
  },
  plugins: [reactSsrBridge, signals({ mode: "auto" })],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      {
        find: /^react-fine-grained-signals\/runtime$/,
        replacement: source("src/runtime.ts"),
      },
      {
        find: /^react-fine-grained-signals\/jsx-runtime$/,
        replacement: source("src/jsx-runtime.ts"),
      },
      {
        find: /^react-fine-grained-signals\/jsx-dev-runtime$/,
        replacement: source("src/jsx-dev-runtime.ts"),
      },
      {
        find: /^react-fine-grained-signals$/,
        replacement: source("src/index.ts"),
      },
    ],
  },
});

const { createApp } = await vite.ssrLoadModule("/src/entry-server.tsx");

const templatePath = resolve(browserRoot, "index.html");

const server = createHttpServer((request, response) => {
  vite.middlewares(request, response, async () => {
    try {
      const url = request.url ?? "/";
      let template = await readFile(templatePath, "utf8");
      template = await vite.transformIndexHtml(url, template);

      const appHtml = renderToString(createApp());
      const html = template.replace("<!--ssr-outlet-->", appHtml);

      response.statusCode = 200;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(html);
    } catch (error) {
      vite.ssrFixStacktrace(error);
      response.statusCode = 500;
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.end(error instanceof Error ? error.stack : String(error));
    }
  });
});

server.listen(port, host, () => {
  console.log(`Browser PoC listening at http://${host}:${port}`);
});

const close = async () => {
  await vite.close();
  server.close();
};

process.once("SIGINT", close);
process.once("SIGTERM", close);

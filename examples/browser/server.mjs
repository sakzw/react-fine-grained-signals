import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToString } from "react-dom/server";
import { createServer as createViteServer } from "vite";
import signals from "../../packages/unplugin-react-alien-signals/src/vite.ts";

const browserRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(browserRoot, "../..");
const host = "127.0.0.1";
const port = 4173;

const source = (path) => resolve(repositoryRoot, path);
const vite = await createViteServer({
  root: repositoryRoot,
  appType: "custom",
  server: { middlewareMode: true },
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

const { createApp } = await vite.ssrLoadModule("/examples/browser/src/entry-server.tsx");

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
